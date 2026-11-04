import { LeaseLostError } from '../core/errors.js';
import type { Logger } from '../observability/logger.js';
import {
  FileSessionStateRepository,
  FileTaskRepository,
  MemorySessionStateRepository,
  MemoryTaskRepository,
} from './file-repository.js';
import {
  createPostgresRepositories,
  type PostgresConnection,
} from './postgres-repository.js';
import type {
  NoticeKind,
  Persistence,
  SessionStateKey,
  SessionStateRepository,
  StorageStateInput,
  StorageDriver,
  TaskNotice,
  TaskRepository,
} from './types.js';
import type { TaskRecord } from '../tasks/task-types.js';

export interface PersistenceOptions {
  driver: 'auto' | StorageDriver;
  dsn?: string;
  persistenceDir: string;
}

/** Postgres 写失败时补写文件；读时优先 Postgres，缺失再回落文件。租约丢失绝不回落。 */
class ResilientTaskRepository implements TaskRepository {
  constructor(
    private readonly primary: TaskRepository,
    private readonly fallback: TaskRepository,
    private readonly logger: Logger
  ) {}

  get driver(): StorageDriver {
    return this.primary.driver;
  }

  get supportsLeases(): boolean {
    return Boolean(this.primary.supportsLeases);
  }

  init(): Promise<void> {
    return this.primary.init();
  }

  async loadAll(): Promise<TaskRecord[]> {
    let primaryTasks: TaskRecord[] = [];
    try {
      primaryTasks = await this.primary.loadAll();
    } catch (error) {
      this.logger.error('storage.postgres_read_failed', { message: (error as Error).message });
    }

    const fallbackTasks = await this.fallback.loadAll().catch(() => []);
    const merged = new Map<string, TaskRecord>();
    for (const task of fallbackTasks) merged.set(task.taskId, task);
    for (const task of primaryTasks) merged.set(task.taskId, task);
    return [...merged.values()];
  }

  getTask(taskId: string): Promise<TaskRecord | undefined> {
    return this.primary.getTask?.(taskId) ?? Promise.resolve(undefined);
  }

  claimNext(ownerId: string, leaseMs: number): Promise<TaskRecord | undefined> {
    return this.primary.claimNext?.(ownerId, leaseMs) ?? Promise.resolve(undefined);
  }

  saveLeased(task: TaskRecord, ownerId: string, leaseMs: number): Promise<void> {
    return this.primary.saveLeased?.(task, ownerId, leaseMs) ?? this.primary.save(task);
  }

  heartbeat(taskId: string, ownerId: string, leaseMs: number): Promise<boolean> {
    return this.primary.heartbeat?.(taskId, ownerId, leaseMs) ?? Promise.resolve(false);
  }

  releaseLease(taskId: string, ownerId: string): Promise<void> {
    return this.primary.releaseLease?.(taskId, ownerId) ?? Promise.resolve();
  }

  recoverExpiredLeases(): Promise<number> {
    return this.primary.recoverExpiredLeases?.() ?? Promise.resolve(0);
  }

  requestWake(
    taskId: string,
    kind: NoticeKind,
    payload: Record<string, unknown>
  ): Promise<void> {
    return this.primary.requestWake?.(taskId, kind, payload) ?? Promise.resolve();
  }

  consumeWakes(ownerId: string): Promise<TaskNotice[]> {
    return this.primary.consumeWakes?.(ownerId) ?? Promise.resolve([]);
  }

  async save(task: TaskRecord): Promise<void> {
    try {
      await this.primary.save(task);
    } catch (error) {
      // 租约丢失是控制流信号，不是存储故障：回落到文件会掩盖「写入被拒」的事实。
      if (error instanceof LeaseLostError) throw error;
      this.logger.warn('storage.postgres_write_failed_fallback_file', {
        taskId: task.taskId,
        message: (error as Error).message,
      });
      await this.fallback.save(task);
    }
  }

  async close(): Promise<void> {
    await this.primary.close().catch(() => undefined);
    await this.fallback.close().catch(() => undefined);
  }
}

class ResilientSessionStateRepository implements SessionStateRepository {
  constructor(
    private readonly primary: SessionStateRepository,
    private readonly fallback: SessionStateRepository,
    private readonly logger: Logger
  ) {}

  get driver(): StorageDriver {
    return this.primary.driver;
  }

  init(): Promise<void> {
    return this.primary.init();
  }

  async load(key: SessionStateKey): Promise<StorageStateInput | undefined> {
    try {
      const state = await this.primary.load(key);
      if (state) return state;
    } catch (error) {
      this.logger.warn('storage.session_read_failed_fallback_file', {
        message: (error as Error).message,
      });
    }
    return this.fallback.load(key);
  }

  async save(key: SessionStateKey, state: StorageStateInput): Promise<void> {
    try {
      await this.primary.save(key, state);
    } catch (error) {
      this.logger.warn('storage.session_write_failed_fallback_file', {
        message: (error as Error).message,
      });
      await this.fallback.save(key, state);
    }
  }

  ref(key: SessionStateKey): string {
    return this.primary.ref(key);
  }

  async close(): Promise<void> {
    await this.primary.close().catch(() => undefined);
    await this.fallback.close().catch(() => undefined);
  }
}

/**
 * 选择持久化实现：
 * - auto：有 DSN 且连得上 → Postgres；否则文件
 * - postgres：连不上也回落文件（不阻断服务）
 * - file / memory：显式选择
 */
export async function createPersistence(
  options: PersistenceOptions,
  logger: Logger
): Promise<Persistence> {
  if (options.driver === 'memory') {
    logger.info('storage.selected', { driver: 'memory' });
    return {
      tasks: new MemoryTaskRepository(),
      sessions: new MemorySessionStateRepository(),
      driver: 'memory',
      close: async () => undefined,
    };
  }

  if (options.driver === 'file' || (options.driver === 'auto' && !options.dsn)) {
    logger.info('storage.selected', {
      driver: 'file',
      reason: options.driver === 'auto' ? '未配置 BROWSER_AGENT_PG_DSN' : '显式文件存储',
    });
    const tasks = new FileTaskRepository(options.persistenceDir, logger);
    const sessions = new FileSessionStateRepository(options.persistenceDir);
    await tasks.init();
    await sessions.init();
    return {
      tasks,
      sessions,
      driver: 'file',
      close: async () => {
        await tasks.close();
        await sessions.close();
      },
    };
  }

  if (!options.dsn) {
    logger.warn('storage.postgres_unconfigured_fallback_file', {
      driver: options.driver,
    });
    return createFilePersistence(options.persistenceDir, logger);
  }

  let connection: PostgresConnection | undefined;
  try {
    const pg = createPostgresRepositories(options.dsn, logger);
    connection = pg.connection;
    await pg.tasks.init();

    const fallbackTasks = new FileTaskRepository(options.persistenceDir, logger);
    const fallbackSessions = new FileSessionStateRepository(options.persistenceDir);
    await fallbackTasks.init();
    await fallbackSessions.init();

    logger.info('storage.selected', {
      driver: 'postgres',
      target: pg.connection.describe(),
    });

    const tasks = new ResilientTaskRepository(pg.tasks, fallbackTasks, logger);
    const sessions = new ResilientSessionStateRepository(pg.sessions, fallbackSessions, logger);

    return {
      tasks,
      sessions,
      driver: 'postgres',
      close: async () => {
        await tasks.close();
        await sessions.close();
        await connection?.close();
      },
    };
  } catch (error) {
    await connection?.close();
    logger.warn('storage.postgres_unavailable_fallback_file', {
      message: (error as Error).message,
    });
    return createFilePersistence(options.persistenceDir, logger);
  }
}

async function createFilePersistence(
  persistenceDir: string,
  logger: Logger
): Promise<Persistence> {
  const tasks = new FileTaskRepository(persistenceDir, logger);
  const sessions = new FileSessionStateRepository(persistenceDir);
  await tasks.init();
  await sessions.init();
  return {
    tasks,
    sessions,
    driver: 'file',
    close: async () => {
      await tasks.close();
      await sessions.close();
    },
  };
}
