import type { Page } from 'playwright';

import { WaitingApprovalError } from '../core/errors.js';
import { capturePageSnapshot } from '../observation/page-snapshot.js';
import { sanitizeForFilename } from '../observation/screenshot.js';

/** 最终提交 / 支付类动作的判定：宁可多拦，不可漏拦。 */
const SENSITIVE_ACTION_PATTERN =
  /提交|发布|确认下单|审核|支付|付款|转账|confirm|submit|approve|publish|pay|checkout/i;

export function isSensitiveActionName(name: string, explicitlyMarked?: boolean): boolean {
  return explicitlyMarked === true || SENSITIVE_ACTION_PATTERN.test(name);
}

/**
 * 审批闸门：在 require_approval 模式下拦住敏感动作，先落盘页面快照，再抛
 * WaitingApprovalError。执行层捕获后把任务停在 WAITING_APPROVAL，保留浏览器
 * 会话，等待 /approve 从断点续跑——不是终止任务。
 */
export class ApprovalGate {
  constructor(
    private readonly page: Page,
    private readonly options: {
      mode: 'auto' | 'require_approval';
      screenshotsDir: string;
    }
  ) {}

  async enforce(targetName: string, index: number, explicitlyMarked?: boolean): Promise<void> {
    if (!isSensitiveActionName(targetName, explicitlyMarked)) return;
    if (this.options.mode === 'auto') return;

    const label = `approval-blocked-${String(index).padStart(2, '0')}-${sanitizeForFilename(targetName)}`;
    const snapshot = await capturePageSnapshot(this.page, this.options.screenshotsDir, label);

    throw new WaitingApprovalError(
      `敏感动作「${targetName}」被审批闸门拦截：任务停在 WAITING_APPROVAL，等待 /approve 后从该步骤继续。页面：${snapshot.url}`,
      {
        targetName,
        stepIndex: index,
        screenshotPath: snapshot.screenshotPath,
        pageUrl: snapshot.url,
        pageTitle: snapshot.title,
        pageTextSample: snapshot.textSample,
      }
    );
  }
}
