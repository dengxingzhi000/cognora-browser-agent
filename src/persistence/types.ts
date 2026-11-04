import type { BrowserContextOptions } from 'playwright';

import type { TaskRecord } from '../tasks/task-types.js';

export type StorageDriver = 'postgres' | 'file' | 'memory';

export type StorageStateInput = NonNullable<BrowserContextOptions['storageState']>;

export interface SessionStateKey {
  tenantId: string;
  userId: string;
  taskType: string;
}

export type NoticeKind = 'approve' | 'reject' | 'cancel';

/** 跨实例唤醒通知：由非租约持有者写入，持有者轮询消费。 */
export interface TaskNotice {
  id: number;
  taskId: string;
  kind: NoticeKind;
  payload: Record<string, unknown>;
}

/**
 * 任务持久化接口。
 * 租约能力（claimNext / heartbeat / saveLeased / …）是可选实现：
 * file / memory 驱动保持单实例语义；Postgres 驱动提供 DB 级原子认领与守卫写回。
 */
export interface TaskRepository {
  readonly driver: StorageDriver;
  /** true = 支持多实例租约（启动时不无条件判失败、使用认领与守卫写回）。 */
  readonly supportsLeases?: boolean;
  init(): Promise<void>;
  loadAll(): Promise<TaskRecord[]>;
  /** 全量写回：创建任务（尚无人持有租约）与单实例驱动使用。 */
  save(task: TaskRecord): Promise<void>;
  /** 单一任务读取，多实例下用于装载别的实例创建的任务。 */
  getTask?(taskId: string): Promise<TaskRecord | undefined>;
  /** DB 级原子认领：最多一个实例成功；没有可认领任务时返回 undefined。 */
  claimNext?(ownerId: string, leaseMs: number): Promise<TaskRecord | undefined>;
  /** 守卫写回：租约已失效时抛 LeaseLostError，绝不覆盖他人结果。 */
  saveLeased?(task: TaskRecord, ownerId: string, leaseMs: number): Promise<void>;
  /** 续租；返回 false 表示租约已丢失（调用方必须停止执行）。 */
  heartbeat?(taskId: string, ownerId: string, leaseMs: number): Promise<boolean>;
  /** 释放租约（终态或主动放弃）；保留 lease_owner 便于审计。 */
  releaseLease?(taskId: string, ownerId: string): Promise<void>;
  /** 启动 / 轮询恢复：只回收租约已过期的任务。返回回收条数。 */
  recoverExpiredLeases?(): Promise<number>;
  /** 写入一条跨实例唤醒通知（同任务同类型只会存在一条未消费记录）。 */
  requestWake?(taskId: string, kind: NoticeKind, payload: Record<string, unknown>): Promise<void>;
  /** 消费「持有者 = 自己」的唤醒通知。 */
  consumeWakes?(ownerId: string): Promise<TaskNotice[]>;
  close(): Promise<void>;
}

/** storageState 持久化接口：只存归档，不写日志。 */
export interface SessionStateRepository {
  readonly driver: StorageDriver;
  init(): Promise<void>;
  load(key: SessionStateKey): Promise<StorageStateInput | undefined>;
  save(key: SessionStateKey, state: StorageStateInput): Promise<void>;
  /** 返回不含凭据的引用（文件路径 / pg:... / memory:...） */
  ref(key: SessionStateKey): string;
  close(): Promise<void>;
}

export interface Persistence {
  tasks: TaskRepository;
  sessions: SessionStateRepository;
  driver: StorageDriver;
  close: () => Promise<void>;
}
