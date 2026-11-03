import fs from 'node:fs';
import path from 'node:path';

import type { TaskSession } from './session-manager.js';

/**
 * storageState 归档：按 (tenantId, userId, taskType) 分目录保存。
 * userId 缺省为 default，因此不传 userId 时归档粒度就是 (tenantId, taskType)。
 * 不同租户 / 不同用户永远不会命中同一个文件；也不使用共享 userDataDir。
 */
export class ProfileManager {
  constructor(private readonly baseDir: string) {}

  keyPath(tenantId: string, userId: string, taskType: string): string {
    return path.join(
      this.baseDir,
      sanitizeSegment(tenantId, 'tenant'),
      sanitizeSegment(userId, 'user'),
      `${sanitizeSegment(taskType, 'task')}.json`
    );
  }

  load(tenantId: string, userId: string, taskType: string): string | undefined {
    const file = this.keyPath(tenantId, userId, taskType);
    return fs.existsSync(file) ? file : undefined;
  }

  async save(
    session: TaskSession,
    tenantId: string,
    userId: string,
    taskType: string
  ): Promise<string> {
    const file = this.keyPath(tenantId, userId, taskType);
    await session.saveStorageState(file);
    return file;
  }
}

function sanitizeSegment(value: string, fallback: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 80);
  return safe || fallback;
}
