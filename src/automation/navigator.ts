import type { Page } from 'playwright';

import type { DomainPolicy } from '../security/domain-policy.js';

/**
 * 导航守卫：导航前检查目标 URL，导航后再检查落地页与所有 frame URL。
 * 网络层还有 context.route 拦截（双保险）。
 */
export class Navigator {
  constructor(
    private readonly page: Page,
    private readonly policy: DomainPolicy,
    private readonly timeoutMs: number
  ) {}

  async goto(url: string): Promise<void> {
    this.policy.assertAllowed(url, '导航');
    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: this.timeoutMs,
    });
    this.assertCurrentPageAllowed();
    this.assertFramesAllowed();
  }

  assertCurrentPageAllowed(): void {
    const currentUrl = this.page.url();
    if (!currentUrl || currentUrl === 'about:blank' || currentUrl.startsWith('about:')) return;
    this.policy.assertAllowed(currentUrl, '当前页面');
  }

  assertFramesAllowed(): void {
    for (const frame of this.page.frames()) {
      const url = frame.url();
      if (!url || url === 'about:blank' || url.startsWith('about:')) continue;
      this.policy.assertAllowed(url, 'iframe');
    }
  }

  /** 每个动作执行前都确认「当前页面」仍在白名单内，而不是只在 goto 时检查。 */
  assertPageAllowedBeforeAction(): void {
    this.assertCurrentPageAllowed();
    this.assertFramesAllowed();
  }
}
