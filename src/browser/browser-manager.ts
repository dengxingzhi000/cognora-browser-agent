import { chromium, type Browser, type BrowserContext } from 'playwright';

import type { BrowserChannel, ServiceConfig } from '../config/config.js';
import type { StorageStateInput } from '../persistence/types.js';

/**
 * 浏览器生命周期：服务进程复用一个 Browser，每个任务单独 newContext。
 * 不使用 launchPersistentContext —— userDataDir 共享是会话串味的根源。
 */
export class BrowserManager {
  private browser?: Browser;
  private launching?: Promise<Browser>;

  constructor(
    private readonly config: Pick<ServiceConfig, 'headless' | 'browserChannel'>
  ) {}

  async launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (!this.launching) {
      this.launching = chromium
        .launch({
          headless: this.config.headless,
          channel: this.config.browserChannel as BrowserChannel,
        })
        .then((browser) => {
          this.browser = browser;
          return browser;
        })
        .finally(() => {
          this.launching = undefined;
        });
    }
    return this.launching;
  }

  /** 只读计数，供长跑 / 泄漏观测使用：Browser 实例数与未关闭的 Context 数。 */
  stats(): { browsers: number; contexts: number } {
    return {
      browsers: this.browser ? 1 : 0,
      contexts: this.browser ? this.browser.contexts().length : 0,
    };
  }

  async newContext(options: { storageState?: StorageStateInput } = {}): Promise<BrowserContext> {
    const browser = await this.launch();
    return browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
      ...(options.storageState ? { storageState: options.storageState } : {}),
    });
  }

  async shutdown(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await browser.close().catch(() => undefined);
  }
}
