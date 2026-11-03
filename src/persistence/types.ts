import type { BrowserContextOptions } from 'playwright';

import type { TaskRecord } from '../tasks/task-types.js';

export type StorageDriver = 'postgres' | 'file' | 'memory';

export type StorageStateInput = NonNullable<BrowserContextOptions['storageState']>;

export interface SessionStateKey {
  tenantId: string;
  userId: string;
  taskType: string;
}

/** 任务持久化接口：任务、步骤、审批都从这里落库 / 落盘。 */
export interface TaskRepository {
  readonly driver: StorageDriver;
  init(): Promise<void>;
  loadAll(): Promise<TaskRecord[]>;
  save(task: TaskRecord): Promise<void>;
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
