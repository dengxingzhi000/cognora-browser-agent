import type {
  SessionStateKey,
  SessionStateRepository,
  StorageStateInput,
} from '../persistence/types.js';
import type { TaskSession } from './session-manager.js';

/**
 * 服务模式下的 storageState 管理器：归档落到 repository（Postgres / 文件 / 内存）。
 * 归档键 (tenantId, userId, taskType)，userId 缺省 default。
 * 不记录/打印 cookie 内容，只返回不含凭据的引用。
 */
export class SessionStateManager {
  constructor(private readonly repository: SessionStateRepository) {}

  key(tenantId: string, userId: string, taskType: string): SessionStateKey {
    return { tenantId, userId, taskType };
  }

  async load(
    tenantId: string,
    userId: string,
    taskType: string
  ): Promise<StorageStateInput | undefined> {
    return this.repository.load(this.key(tenantId, userId, taskType));
  }

  async save(
    session: TaskSession,
    tenantId: string,
    userId: string,
    taskType: string
  ): Promise<string> {
    const key = this.key(tenantId, userId, taskType);
    const state = await session.context.storageState();
    await this.repository.save(key, state);
    return this.repository.ref(key);
  }

  describe(): string {
    return this.repository.driver;
  }
}
