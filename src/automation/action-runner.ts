import type { Page, Response } from 'playwright';

import {
  AntiAutomationDetectedError,
  AppError,
  ValidationError,
  WaitTimeoutError,
  WaitingApprovalError,
  ActionNotAllowedError,
} from '../core/errors.js';
import type { ActionIntent, Expectation, StepResult, ValidationResult, WaitSpec } from '../core/types.js';
import type { Logger } from '../observability/logger.js';
import { captureScreenshot, captureScreenshotAs, resolveScreenshotPath } from '../observation/screenshot.js';
import { StateValidator } from '../observation/state-validator.js';
import type { DomainPolicy } from '../security/domain-policy.js';
import { isSensitiveActionName, ApprovalGate } from '../security/approval.js';
import { normalizeWaits, validateActionIntent } from '../security/action-policy.js';
import { AdvancedActions } from './advanced-actions.js';
import { FormHandler } from './form-handler.js';
import { resolveRoot, type UiRoot } from './locator.js';
import { Navigator } from './navigator.js';

/** 结构性反自动化标记；只做检测与退出，绝不尝试绕过。 */
const ANTI_AUTOMATION_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '[data-captcha]',
  '#captcha',
  '.captcha',
  '[class*="captcha"]',
];

export interface ActionRunnerOptions {
  actionTimeoutMs: number;
  expectTimeoutMs: number;
  screenshotsDir: string;
  executionMode: 'auto' | 'require_approval';
  taskId: string;
  uploadRoot: string;
  uploadAllowedExtensions: string[];
  uploadMaxBytes: number;
  downloadMaxBytes: number;
  downloadAllowedExtensions: string[];
  downloadsDir: string;
}

export interface RunActionOptions {
  /** /approve 之后只对断点步骤放行一次 */
  approvalGranted?: boolean;
}

export class ActionRunner {
  private readonly validator: StateValidator;
  private readonly gate: ApprovalGate;
  private readonly navigator: Navigator;
  private readonly forms: FormHandler;
  private readonly advanced: AdvancedActions;
  private readonly log: Logger;

  constructor(
    private readonly page: Page,
    policy: DomainPolicy,
    private readonly options: ActionRunnerOptions,
    logger: Logger
  ) {
    this.validator = new StateValidator(page, options.expectTimeoutMs);
    this.gate = new ApprovalGate(page, {
      mode: options.executionMode,
      screenshotsDir: options.screenshotsDir,
    });
    this.navigator = new Navigator(page, policy, options.actionTimeoutMs);
    this.forms = new FormHandler(page, options.actionTimeoutMs);
    this.advanced = new AdvancedActions(page, {
      actionTimeoutMs: options.actionTimeoutMs,
      uploadRoot: options.uploadRoot,
      uploadAllowedExtensions: options.uploadAllowedExtensions,
      uploadMaxBytes: options.uploadMaxBytes,
      downloadMaxBytes: options.downloadMaxBytes,
      downloadAllowedExtensions: options.downloadAllowedExtensions,
      downloadsDir: options.downloadsDir,
    });
    this.log = logger.child({ taskId: options.taskId });
  }

  async run(
    rawIntent: ActionIntent,
    index: number,
    runOptions: RunActionOptions = {}
  ): Promise<StepResult> {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const description = describe(rawIntent);
    const validations: ValidationResult[] = [];
    let screenshot: string | undefined;
    let status: StepResult['status'] = 'success';
    let error: StepResult['error'];
    let approval: StepResult['approval'];

    try {
      const intent = validateActionIntent(rawIntent);
      this.navigator.assertPageAllowedBeforeAction();
      await this.assertNoAntiAutomation(index);

      const root = await this.resolveActionRoot(intent);
      const armed = armWaits(this.page, root, intent.waitFor, this.options.actionTimeoutMs);

      switch (intent.action) {
        case 'goto': {
          await this.navigator.goto(intent.url);
          await this.assertNoAntiAutomation(index);
          break;
        }
        case 'fill': {
          await this.forms.fill(root, intent.target, intent.value, description);
          validations.push(
            redactValidation(
              intent.target.name,
              await this.validator.checkInputValue(root, intent.target, intent.value)
            )
          );
          break;
        }
        case 'select': {
          await this.forms.select(root, intent.target, intent.value, description);
          validations.push(await this.validator.checkSelected(root, intent.target, intent.value));
          break;
        }
        case 'click': {
          await this.forms.resolve(root, intent.target, description);
          if (
            !runOptions.approvalGranted &&
            isSensitiveActionName(intent.target.name, intent.approvalRequired)
          ) {
            await this.gate.enforce(intent.target.name, index, intent.approvalRequired);
          }
          await this.forms.click(root, intent.target, description);
          break;
        }
        case 'selectCustom': {
          await this.advanced.selectCustom(root, intent.target, intent.option, description);
          validations.push(
            await this.validator.checkCustomSelect(root, intent.target, intent.option.name)
          );
          break;
        }
        case 'upload': {
          validations.push(
            await this.advanced.upload(root, intent.target, intent.files, description)
          );
          break;
        }
        case 'download': {
          validations.push(
            await this.advanced.download(root, intent.target, intent.saveAs, description)
          );
          break;
        }
        case 'waitForResponse': {
          const spec: WaitSpec = {
            type: 'response',
            urlContains: intent.urlContains,
            ...(intent.method ? { method: intent.method } : {}),
            ...(intent.statusBelow !== undefined ? { statusBelow: intent.statusBelow } : {}),
            ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {}),
          };
          const armed = armWaits(
            this.page,
            root,
            spec,
            intent.timeoutMs ?? this.options.actionTimeoutMs
          );
          validations.push(await awaitWait(armed[0], this.page));
          break;
        }
        case 'waitForHidden': {
          const spec: WaitSpec = {
            type: 'hidden',
            target: intent.target,
            ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {}),
            appearTimeoutMs: 0,
          };
          const armed = armWaits(
            this.page,
            root,
            spec,
            intent.timeoutMs ?? this.options.actionTimeoutMs
          );
          validations.push(await awaitWait(armed[0], this.page));
          break;
        }
        case 'screenshot': {
          screenshot = await this.captureExplicit(intent.path, index, description);
          break;
        }
      }

      for (const wait of armed) {
        const validation = await awaitWait(wait, this.page);
        validations.push(validation);
      }

      for (const expectation of asArray(intent.expect)) {
        validations.push(await this.validator.run(expectation, root));
      }

      const failures = validations.filter((item) => !item.ok);
      if (failures.length > 0) {
        throw new ValidationError(
          `状态校验失败（${failures.length} 项）：${failures
            .map((item) => `${item.kind} 期望「${item.expected ?? ''}」实际「${item.actual ?? ''}」`)
            .join('；')}`,
          { validations: failures }
        );
      }
    } catch (caught) {
      const err = caught as Error & { code?: string; details?: Record<string, unknown> };

      if (err instanceof WaitingApprovalError) {
        status = 'blocked';
        const details = err.details;
        screenshot = details.screenshotPath as string | undefined;
        approval = {
          stepIndex: Number(details.stepIndex ?? index),
          action: rawIntent.action,
          description,
          targetName: String(details.targetName ?? ''),
          requestedAt: new Date().toISOString(),
          screenshot,
          pageUrl: String(details.pageUrl ?? this.page.url()),
          ...(details.pageTitle ? { pageTitle: String(details.pageTitle) } : {}),
          ...(details.pageTextSample ? { pageTextSample: String(details.pageTextSample) } : {}),
        };
      } else {
        status = 'failed';
      }

      if (err instanceof AntiAutomationDetectedError) {
        screenshot = err.details.screenshotPath as string | undefined;
      }

      error = {
        name: err.name,
        code: err.code ?? (err.name === 'TimeoutError' ? 'ACTION_TIMEOUT' : undefined),
        message:
          status === 'failed'
            ? `${err.message}（当前页面：url=${this.page.url()}）`
            : err.message,
      };

      this.log.warn('step.error', {
        stepIndex: index,
        action: rawIntent.action,
        code: error.code,
        message: error.message,
      });
    }

    if (!screenshot) {
      const suffix = status === 'success' ? '' : status === 'blocked' ? '-BLOCKED' : '-FAILED';
      screenshot = await captureScreenshot(
        this.page,
        this.options.screenshotsDir,
        index,
        description,
        suffix
      );
    }

    return {
      index,
      action: rawIntent.action,
      description,
      status,
      startedAt,
      durationMs: Date.now() - startedMs,
      validations,
      ...('target' in rawIntent && rawIntent.target ? { target: rawIntent.target } : {}),
      screenshot,
      ...(rawIntent.note ? { note: rawIntent.note } : {}),
      ...(error ? { error } : {}),
      ...(approval ? { approval } : {}),
    };
  }

  private async resolveActionRoot(intent: ActionIntent): Promise<UiRoot> {
    if ('target' in intent && intent.target.frame) {
      return resolveRoot(this.page, intent.target.frame, this.options.actionTimeoutMs);
    }
    return this.page;
  }

  private async assertNoAntiAutomation(index: number): Promise<void> {
    for (const selector of ANTI_AUTOMATION_SELECTORS) {
      const locator = this.page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;

      const visible = await locator.first().isVisible().catch(() => false);
      if (!visible) continue;

      const screenshotPath = await captureScreenshot(
        this.page,
        this.options.screenshotsDir,
        index,
        'anti-automation-detected',
        '-BLOCKED'
      );
      throw new AntiAutomationDetectedError(
        `检测到验证码/反自动化元素（${selector}），按策略立即停止，不尝试绕过。截图：${screenshotPath ?? '(截图失败)'}`,
        { selector, screenshotPath }
      );
    }
  }

  private async captureExplicit(
    requested: string | undefined,
    index: number,
    description: string
  ): Promise<string | undefined> {
    if (!requested) {
      return captureScreenshot(this.page, this.options.screenshotsDir, index, description);
    }

    const filePath = resolveScreenshotPath(this.options.screenshotsDir, requested);
    return captureScreenshotAs(this.page, filePath);
  }
}

interface ArmedWait {
  spec: WaitSpec;
  startedMs: number;
  promise: Promise<WaitProbe>;
}

interface WaitProbe {
  ok: boolean;
  expected: string;
  actual: string;
  detail: string;
  error?: string;
}

function armWaits(
  page: Page,
  root: UiRoot,
  waitFor: WaitSpec | WaitSpec[] | undefined,
  defaultTimeoutMs: number
): ArmedWait[] {
  return normalizeWaits(waitFor).map((rawSpec) => {
    const spec = rawSpec as WaitSpec;
    const timeoutMs = spec.timeoutMs ?? defaultTimeoutMs;

    if (spec.type === 'response') {
      const predicate = (response: Response): boolean => {
        if (!response.url().includes(spec.urlContains)) return false;
        if (spec.method && response.request().method().toUpperCase() !== spec.method) return false;
        return true;
      };

      const promise = page
        .waitForResponse(predicate, { timeout: timeoutMs })
        .then((response): WaitProbe => {
          const status = response.status();
          const threshold = spec.statusBelow ?? 400;
          return {
            ok: status < threshold,
            expected: `${spec.method ?? 'ANY'} URL 包含「${spec.urlContains}」且状态码 < ${threshold}`,
            actual: `${response.request().method()} ${status} ${response.url()}`,
            detail: 'page.waitForResponse',
          };
        })
        .catch(
          (error: Error): WaitProbe => ({
            ok: false,
            expected: `${spec.method ?? 'ANY'} URL 包含「${spec.urlContains}」`,
            actual: `等待超时（${timeoutMs}ms）：${error.message}`,
            detail: 'page.waitForResponse',
            error: error.message,
          })
        );

      return { spec, startedMs: Date.now(), promise };
    }

    const target = spec.target;
    const locator =
      'role' in target
        ? root.getByRole(target.role, { name: target.name, exact: target.exact ?? true })
        : root.getByLabel(target.name, { exact: target.exact ?? true });
    const appearTimeoutMs = spec.appearTimeoutMs ?? 500;
    const promise = waitForHidden(locator, timeoutMs, appearTimeoutMs);

    return { spec, startedMs: Date.now(), promise };
  });
}

async function waitForHidden(
  locator: ReturnType<UiRoot['getByRole']>,
  timeoutMs: number,
  appearTimeoutMs: number
): Promise<WaitProbe> {
  const deadline = Date.now() + timeoutMs;
  const appearDeadline = Math.min(deadline, Date.now() + appearTimeoutMs);
  let everVisible = false;

  while (Date.now() < deadline) {
    const visible = await locator.first().isVisible().catch(() => false);
    if (visible) {
      everVisible = true;
    } else if (everVisible || Date.now() > appearDeadline) {
      return {
        ok: true,
        expected: `元素在 ${timeoutMs}ms 内不可见`,
        actual: everVisible ? '已消失' : '未出现（视为无加载态）',
        detail: '轮询 isVisible',
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return {
    ok: false,
    expected: `元素在 ${timeoutMs}ms 内不可见`,
    actual: everVisible ? '仍在显示' : '未观测到出现',
    detail: '轮询 isVisible',
    error: 'spinner 未在超时时间内消失',
  };
}

async function awaitWait(wait: ArmedWait, page: Page): Promise<ValidationResult> {
  const probe = await wait.promise;
  const elapsedMs = Date.now() - wait.startedMs;

  if (probe.error) {
    const title = await page.title().catch(() => '');
    throw new WaitTimeoutError(
      `显式等待超时（${elapsedMs}ms）：期望 ${probe.expected}；最后页面状态：url=${page.url()}，title=${title || '(空)'}`,
      { expected: probe.expected, actual: probe.actual, elapsedMs, pageUrl: page.url(), pageTitle: title }
    );
  }

  return {
    ok: probe.ok,
    kind: wait.spec.type === 'response' ? 'wait-response' : 'wait-hidden',
    expected: probe.expected,
    actual: `${probe.actual}（${elapsedMs}ms）`,
    detail: probe.detail,
  };
}

function asArray(expectation: Expectation | Expectation[] | undefined): Expectation[] {
  if (!expectation) return [];
  return Array.isArray(expectation) ? expectation : [expectation];
}

const SENSITIVE_FIELD_PATTERN = /密码|口令|验证码|password|passwd|secret|token/i;

/** 密码类字段只进报告、不落文件名/JSON：值一律替换为 ***。 */
function redactValue(fieldName: string, value: string): string {
  return SENSITIVE_FIELD_PATTERN.test(fieldName) ? '***' : truncate(value);
}

function redactValidation(fieldName: string, result: ValidationResult): ValidationResult {
  if (!SENSITIVE_FIELD_PATTERN.test(fieldName)) return result;
  return {
    ...result,
    expected: '***（密码类字段已脱敏）',
    actual: result.ok ? '***（回读与期望一致）' : '***（回读与期望不一致）',
  };
}

function describe(intent: ActionIntent): string {
  switch (intent.action) {
    case 'goto':
      return `goto ${intent.url}`;
    case 'fill':
      return `fill ${intent.target.name}=${redactValue(intent.target.name, intent.value)}`;
    case 'select':
      return `select ${intent.target.name}=${intent.value}`;
    case 'selectCustom':
      return `selectCustom ${intent.target.name} → ${intent.option.name}`;
    case 'click':
      return `click ${intent.target.name}`;
    case 'upload':
      return `upload ${intent.target.name}=${intent.files.map((file) => file.split(/[\\/]/).pop()).join(',')}`;
    case 'download':
      return `download ${intent.target.name}${intent.saveAs ? ` as ${intent.saveAs}` : ''}`;
    case 'waitForResponse':
      return `waitForResponse ${intent.method ?? 'ANY'} ${intent.urlContains}`;
    case 'waitForHidden':
      return `waitForHidden ${intent.target.name}`;
    case 'screenshot':
      return `screenshot ${intent.path ?? '(auto)'}`;
  }
}

function truncate(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ');
  return singleLine.length > 32 ? `${singleLine.slice(0, 32)}…` : singleLine;
}

export function assertActionAllowed(value: unknown): ActionIntent {
  try {
    return validateActionIntent(value);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new ActionNotAllowedError(String(error), { action: 'validate' });
  }
}
