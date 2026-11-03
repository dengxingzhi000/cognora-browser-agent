import { DomainNotAllowedError } from '../core/errors.js';

/**
 * 域名白名单：导航、iframe 与所有网络请求都必须先过这一层。
 * 只认 http/https；白名单按 host 精确匹配，顺带允许其子域（例如 app.localhost）。
 */
export class DomainPolicy {
  private readonly allowedHosts: string[];

  constructor(allowedHosts: string[]) {
    this.allowedHosts = allowedHosts.map((host) => host.toLowerCase());
  }

  isAllowed(rawUrl: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    return this.allowedHosts.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`)
    );
  }

  assertAllowed(rawUrl: string, context: string): void {
    if (this.isAllowed(rawUrl)) return;

    let host = '(无法解析)';
    try {
      host = new URL(rawUrl).hostname;
    } catch {
      /* 保留默认值 */
    }

    throw new DomainNotAllowedError(
      `域名策略拒绝${context}：${rawUrl}（host=${host} 不在白名单 ${this.allowedHosts.join(', ')}）`,
      { url: rawUrl, host, allowedHosts: this.allowedHosts, context }
    );
  }

  describe(): string {
    return this.allowedHosts.join(', ');
  }
}
