import { TaskNotFoundError } from '../core/errors.js';
import type { Logger } from '../observability/logger.js';
import type { TaskRepository, StorageDriver } from '../persistence/types.js';
import { isTerminal } from './task-state.js';
import { assertTransition } from './task-state.js';
import type { TaskRecord, TaskStatus } from './task-types.js';

/**
 * 运行时任务缓存 + 写穿持久化。
 * 每次变更先更新内存（API 可立即读到），再串行写 repository；
 * flush() 等待所有写入完成，API 在响应前调用，确保「查询状态」读到的就是已落库状态。
 */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private writeTail: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly repository: TaskRepository,
    private readonly logger: Logger
  ) {}

  get driver(): StorageDriver {
    return this.repository.driver;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.repository.init();

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
    this.scheduleSave(task);
    return task;
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  getOrThrow(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return task;
  }

  update(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
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

  private scheduleSave(task: TaskRecord): void {
    const snapshot = structuredClone(task);
    this.writeTail = this.writeTail
      .then(() => this.repository.save(snapshot))
      .catch((error: unknown) => {
        this.logger.error('storage.task_save_failed', {
          taskId: task.taskId,
          driver: this.repository.driver,
          message: (error as Error).message,
        });
      });
  }
}
