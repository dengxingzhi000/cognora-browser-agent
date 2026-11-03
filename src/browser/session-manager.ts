import fs from 'node:fs';
import path from 'node:path';

import type { BrowserContext, Page } from 'playwright';

import type { DomainPolicy } from '../security/domain-policy.js';
import type { Logger } from '../observability/logger.js';
import type { StorageStateInput } from '../persistence/types.js';
import type { BrowserManager } from './browser-manager.js';

/**
 * 单个任务的浏览器会话：独立 BrowserContext + 独立 Page。
 * storageState 只决定「初始 cookie」，不共享 profile 目录。
 */
export class TaskSession {
  private closed = false;

  constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly violations: string[] = []
  ) {}

  async cookieNames(): Promise<string[]> {
    try {
      const cookies = await this.context.cookies();
      return [...new Set(cookies.map((cookie) => cookie.name))].sort();
    } catch {
      return [];
    }
  }

  async saveStorageState(filePath: string): Promise<void> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await this.context.storageState({ path: filePath });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
  }
}

export class SessionManager {
  constructor(
    private readonly browser: BrowserManager,
    private readonly domainPolicy: DomainPolicy,
    private readonly logger: Logger
  ) {}

  async open(options: {
    taskId: string;
    /** 旧参数：文件路径（CLI 使用） */
    storageStatePath?: string;
    /** 新参数：Postgres / 文件 / 内存仓库返回的 storageState 对象 */
    storageState?: StorageStateInput;
  }): Promise<TaskSession> {
    const log = this.logger.child({ taskId: options.taskId });
    const state = options.storageState ?? options.storageStatePath;
    const context = await this.browser.newContext({
      ...(state ? { storageState: state } : {}),
    });

    let violations = 0;
    const violationList: string[] = [];
    await context.route('**/*', async (route) => {
      const url = route.request().url();

      if (
        this.domainPolicy.isAllowed(url) ||
        url.startsWith('data:') ||
        url.startsWith('blob:') ||
        url.startsWith('about:')
      ) {
        await route.continue();
        return;
      }

      violations += 1;
      if (violationList.length < 200) violationList.push(url);
      log.warn('domain.blocked', { url, count: violations });
      await route.abort('blockedbyclient');
    });

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(30000);

    return new TaskSession(context, page, violationList);
  }

  async shutdown(): Promise<void> {
    await this.browser.shutdown();
  }
}
