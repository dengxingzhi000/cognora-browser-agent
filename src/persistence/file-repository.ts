import fs from 'node:fs';
import path from 'node:path';

import type { Logger } from '../observability/logger.js';
import type { TaskRecord } from '../tasks/task-types.js';
import type {
  SessionStateKey,
  SessionStateRepository,
  StorageStateInput,
  TaskRepository,
} from './types.js';

function sanitizeSegment(value: string, fallback: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 80);
  return safe || fallback;
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, filePath);
}

/** 文件持久化：无 DSN / 连不上 Postgres 时的回落实现。 */
export class FileTaskRepository implements TaskRepository {
  readonly driver = 'file' as const;
  private readonly dir: string;

  constructor(persistenceDir: string, private readonly logger: Logger) {
    this.dir = path.join(persistenceDir, 'tasks');
  }

  async init(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  async loadAll(): Promise<TaskRecord[]> {
    if (!fs.existsSync(this.dir)) return [];
    const tasks: TaskRecord[] = [];

    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')) as TaskRecord;
        if (parsed?.taskId) tasks.push(parsed);
      } catch (error) {
        this.logger.warn('storage.file_corrupt', {
          file,
          message: (error as Error).message,
        });
      }
    }

    return tasks;
  }

  async save(task: TaskRecord): Promise<void> {
    writeAtomic(
      path.join(this.dir, `${sanitizeSegment(task.taskId, 'task')}.json`),
      JSON.stringify(task, null, 2)
    );
  }

  async close(): Promise<void> {
    /* 文件实现无连接可关 */
  }
}

export class FileSessionStateRepository implements SessionStateRepository {
  readonly driver = 'file' as const;
  private readonly dir: string;

  constructor(persistenceDir: string) {
    this.dir = path.join(persistenceDir, 'sessions');
  }

  async init(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private filePath(key: SessionStateKey): string {
    return path.join(
      this.dir,
      sanitizeSegment(key.tenantId, 'tenant'),
      sanitizeSegment(key.userId, 'user'),
      `${sanitizeSegment(key.taskType, 'task')}.json`
    );
  }

  async load(key: SessionStateKey): Promise<StorageStateInput | undefined> {
    const file = this.filePath(key);
    if (!fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as StorageStateInput;
    } catch {
      return undefined;
    }
  }

  async save(key: SessionStateKey, state: StorageStateInput): Promise<void> {
    writeAtomic(this.filePath(key), JSON.stringify(state));
  }

  ref(key: SessionStateKey): string {
    return this.filePath(key);
  }

  async close(): Promise<void> {
    /* 文件实现无连接可关 */
  }
}

/** 纯内存实现：进程重启即丢，仅用于显式配置或测试。 */
export class MemoryTaskRepository implements TaskRepository {
  readonly driver = 'memory' as const;
  private tasks: TaskRecord[] = [];

  async init(): Promise<void> {}
  async loadAll(): Promise<TaskRecord[]> {
    return this.tasks;
  }
  async save(task: TaskRecord): Promise<void> {
    this.tasks = this.tasks.filter((item) => item.taskId !== task.taskId);
    this.tasks.push(task);
  }
  async close(): Promise<void> {}
}

export class MemorySessionStateRepository implements SessionStateRepository {
  readonly driver = 'memory' as const;
  private readonly states = new Map<string, StorageStateInput>();

  async init(): Promise<void> {}

  private mapKey(key: SessionStateKey): string {
    return `${key.tenantId}\u0000${key.userId}\u0000${key.taskType}`;
  }

  async load(key: SessionStateKey): Promise<StorageStateInput | undefined> {
    return this.states.get(this.mapKey(key));
  }

  async save(key: SessionStateKey, state: StorageStateInput): Promise<void> {
    this.states.set(this.mapKey(key), state);
  }

  ref(key: SessionStateKey): string {
    return `memory:${key.tenantId}/${key.userId}/${key.taskType}`;
  }

  async close(): Promise<void> {}
}
