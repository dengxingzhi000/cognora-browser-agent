import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { LeaseLostError, TaskNotFoundError } from '../core/errors.js';
import type { Logger } from '../observability/logger.js';
import type { TaskRepository, StorageDriver } from '../persistence/types.js';
import type { TaskNotice } from '../persistence/types.js';
import { isTerminal } from './task-state.js';
import { assertTransition } from './task-state.js';
import type { TaskRecord, TaskStatus } from './task-types.js';

export interface TaskStoreOptions {
  /** 多实例模式下的实例自述身份；未设置则保持单实例语义。 */
  ownerId?: string;
  /** 租约时长（毫秒），守卫写回与心跳共用。 */
  leaseMs?: number;
}

/**
 * 运行时任务缓存 + 写穿持久化。
 * 每次变更先更新内存（API 可立即读到），再串行写 repository；
 * flush() 等待所有写入完成，API 在响应前调用，确保「查询状态」读到的就是已落库状态。
 *
 * 多实例（Postgres）模式下：
 * - 启动只回收「租约已过期」的任务，不再无条件把在跑 / 待审批任务判失败；
 * - 本实例持有的任务用守卫写回（lease_owner + 未过期），0 行即弃写并标记租约丢失；
 * - 其他实例的任务按需从 DB 刷新，不写入。
 */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly owned = new Set<string>();
  private readonly leaseLost = new Set<string>();
  private writeTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly instanceId: string;

  constructor(
    private readonly repository: TaskRepository,
    private readonly logger: Logger,
    private readonly options: TaskStoreOptions = {}
  ) {
    this.instanceId =
      options.ownerId ?? `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }

  get driver(): StorageDriver {
    return this.repository.driver;
  }

  get supportsLeases(): boolean {
    return Boolean(this.repository.supportsLeases);
  }

  get ownerId(): string {
    return this.instanceId;
  }

  get leaseMs(): number {
    return this.options.leaseMs ?? 60_000;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.repository.init();

    if (this.supportsLeases) {
      // 关键修复：只回收租约已过期的任务；存活实例的 WAITING / RUNNING 任务原样保留。
      const reclaimed = await this.repository.recoverExpiredLeases?.();
      const loaded = await this.repository.loadAll();
      for (const task of loaded) {
        this.tasks.set(task.taskId, task);
      }
      this.initialized = true;
      this.logger.info('storage.tasks_loaded', {
        driver: this.repository.driver,
        tasks: loaded.length,
        reclaimedExpiredLeases: reclaimed ?? 0,
      });
      return;
    }

    const loaded = await this.repository.loadAll();
    const now = new Date().toISOString();

    for (const task of loaded) {
      if (!isTerminal(task.status)) {
        const recovered: TaskRecord = {
          ...task,
          status: 'FAILED',
          updatedAt: now,
          finishedAt: now,
          pendingApproval: undefined,
          cancelRequested: true,
          error: {
            name: 'WorkerRestarted',
            code: 'WORKER_RESTARTED',
            message: '进程重启，浏览器会话与断点已丢失；任务按失败处理',
          },
        };
        this.tasks.set(task.taskId, recovered);
        this.scheduleSave(recovered);
        this.logger.warn('storage.recovered_inflight_task', {
          taskId: task.taskId,
          previousStatus: task.status,
        });
      } else {
        this.tasks.set(task.taskId, task);
      }
    }

    this.initialized = true;
    this.logger.info('storage.tasks_loaded', {
      driver: this.repository.driver,
      tasks: loaded.length,
    });
  }

  create(task: TaskRecord): TaskRecord {
    this.tasks.set(task.taskId, task);
    if (!this.supportsLeases) this.owned.add(task.taskId);
    this.scheduleSave(task);
    return task;
  }

  /** 认领成功后把 DB 行接管到本地，并标记为「本实例持有」。 */
  adopt(task: TaskRecord): TaskRecord {
    this.tasks.set(task.taskId, task);
    this.owned.add(task.taskId);
    this.leaseLost.delete(task.taskId);
    return task;
  }

  /** 覆盖本地缓存但不取得所有权（用于读取其他实例的任务）。 */
  observe(task: TaskRecord): TaskRecord {
    this.tasks.set(task.taskId, task);
    return task;
  }

  owns(taskId: string): boolean {
    return this.owned.has(taskId);
  }

  isLeaseLost(taskId: string): boolean {
    return this.leaseLost.has(taskId);
  }

  markLeaseLost(taskId: string): void {
    this.owned.delete(taskId);
    this.leaseLost.add(taskId);
  }

  release(taskId: string): void {
    this.owned.delete(taskId);
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  getOrThrow(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return task;
  }

  /** 本地没有时从 DB 装载（多实例下任务可能由其他实例创建）。 */
  async load(taskId: string): Promise<TaskRecord | undefined> {
    const local = this.tasks.get(taskId);
    if (local) return local;
    const remote = await this.repository.getTask?.(taskId);
    if (!remote) return undefined;
    // 读取期间任务可能已被本实例认领：此时必须以本地（含租约）状态为准，不能被陈旧读覆盖。
    if (this.owned.has(taskId)) return this.tasks.get(taskId);
    return this.observe(remote);
  }

  /** DB 级原子认领；成功即接管到本地并标记所有权。 */
  async claim(ownerId: string): Promise<TaskRecord | undefined> {
    const claimed = await this.repository.claimNext?.(ownerId, this.leaseMs);
    if (!claimed) return undefined;
    return this.adopt(claimed);
  }

  async recoverExpired(): Promise<number> {
    return (await this.repository.recoverExpiredLeases?.()) ?? 0;
  }

  async heartbeat(taskId: string, ownerId: string, leaseMs: number): Promise<boolean> {
    return (await this.repository.heartbeat?.(taskId, ownerId, leaseMs)) ?? false;
  }

  async requestWake(
    taskId: string,
    kind: 'approve' | 'reject' | 'cancel',
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.repository.requestWake?.(taskId, kind, payload);
  }

  async consumeWakes(ownerId: string): Promise<TaskNotice[]> {
    return (await this.repository.consumeWakes?.(ownerId)) ?? [];
  }

  /** 从 DB 刷新非本地持有任务的最新状态。 */
  async refresh(taskId: string): Promise<TaskRecord | undefined> {
    if (this.owned.has(taskId)) return this.tasks.get(taskId);
    const remote = await this.repository.getTask?.(taskId);
    if (!remote) return undefined;
    // 查询期间被本实例认领时，丢弃这次陈旧读。
    if (this.owned.has(taskId)) return this.tasks.get(taskId);
    return this.observe(remote);
  }

  update(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
    this.assertWritable(taskId);
    const current = this.getOrThrow(taskId);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.tasks.set(taskId, next);
    this.scheduleSave(next);
    return next;
  }

  transition(taskId: string, to: TaskStatus, patch: Partial<TaskRecord> = {}): TaskRecord {
    const current = this.getOrThrow(taskId);
    assertTransition(taskId, current.status, to);
    return this.update(taskId, { ...patch, status: to });
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  size(): number {
    return this.tasks.size;
  }

  /** 等待所有待写入完成；写失败由 repository/包装层兜底并记录，不抛出。 */
  async flush(): Promise<void> {
    // 追到队列稳定：await 期间可能又有步骤 / 状态迁移入队。
    for (;;) {
      const tail = this.writeTail;
      await tail;
      if (tail === this.writeTail) return;
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.repository.close();
  }

  private assertWritable(taskId: string): void {
    if (this.leaseLost.has(taskId)) {
      throw new LeaseLostError(taskId, this.ownerId);
    }
  }

  private scheduleSave(task: TaskRecord): void {
    const snapshot = structuredClone(task);
    const owner = this.owned.has(task.taskId) ? this.ownerId : undefined;
    this.writeTail = this.writeTail
      .then(async () => {
        if (owner && this.repository.saveLeased) {
          await this.repository.saveLeased(snapshot, owner, this.leaseMs);
        } else {
          await this.repository.save(snapshot);
        }
        if (isTerminal(snapshot.status)) this.owned.delete(snapshot.taskId);
      })
      .catch((error: unknown) => {
        if (error instanceof LeaseLostError) {
          this.markLeaseLost(snapshot.taskId);
          this.logger.warn('storage.lease_lost_write_rejected', {
            taskId: snapshot.taskId,
            ownerId: owner,
            status: snapshot.status,
          });
          return;
        }
        this.logger.error('storage.task_save_failed', {
          taskId: snapshot.taskId,
          driver: this.repository.driver,
          message: (error as Error).message,
        });
      });
  }
}
