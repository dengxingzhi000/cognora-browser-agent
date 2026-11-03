/**
 * 对外契约：调用方只能描述「做什么」，执行层负责定位、校验与安全裁决。
 * 定位一律走可访问性语义（role / label），不暴露 CSS 选择器、XPath 或坐标。
 */

export type RoleName =
  | 'textbox'
  | 'combobox'
  | 'button'
  | 'checkbox'
  | 'radio'
  | 'link'
  | 'heading'
  | 'table'
  | 'status'
  | 'searchbox'
  | 'switch'
  | 'tab'
  | 'spinbutton'
  | 'progressbar';

/** iframe 引用：只接受名字 / 标题，内部拼选择器，不接受调用方传原始 CSS。 */
export interface FrameRef {
  name?: string;
  title?: string;
  /** 附加断言：命中的 frame URL 必须包含该片段 */
  urlContains?: string;
}

export type ActionTarget =
  | { role: RoleName; name: string; exact?: boolean; frame?: FrameRef }
  | { by: 'label'; name: string; exact?: boolean; frame?: FrameRef };

/** 动作执行后的状态断言。校验失败必须给出「期望 vs 实际」。 */
export type Expectation =
  | { type: 'status'; text: string; exact?: boolean; frame?: FrameRef }
  | { type: 'text'; text: string; exact?: boolean; frame?: FrameRef }
  | { type: 'url'; pattern: string }
  | { type: 'list'; container: ActionTarget; contains: string }
  | { type: 'cookie'; name: string; present: boolean };

export interface ActionBase {
  /** 人类可读备注，只进报告，不影响执行 */
  note?: string;
  /** 执行后的状态断言，可多条 */
  expect?: Expectation | Expectation[];
}

/**
 * 显式等待：不再用固定 timeout 猜页面状态。
 * - response：等待某个 API 响应完成（可按方法 / 状态码下限过滤）
 * - hidden：等待某个元素（典型是 spinner）消失
 */
export type WaitSpec =
  | {
      type: 'response';
      urlContains: string;
      method?: string;
      /** 默认 400：只接受 < 400 的响应 */
      statusBelow?: number;
      timeoutMs?: number;
    }
  | {
      type: 'hidden';
      target: ActionTarget;
      timeoutMs?: number;
      /** 动作触发后等待 spinner 出现的短窗口；没出现则视为无加载态 */
      appearTimeoutMs?: number;
    };

interface WaitableAction {
  waitFor?: WaitSpec | WaitSpec[];
}

export type ActionIntent = ActionBase & WaitableAction &
  (
    | { action: 'goto'; url: string }
    | { action: 'fill'; target: ActionTarget; value: string }
    | { action: 'select'; target: ActionTarget; value: string }
    | {
        action: 'selectCustom';
        target: ActionTarget;
        option: { name: string; exact?: boolean; by?: 'role' | 'text' };
      }
    | { action: 'click'; target: ActionTarget; approvalRequired?: boolean }
    | { action: 'upload'; target: ActionTarget; files: string[] }
    | { action: 'download'; target: ActionTarget; saveAs?: string }
    | {
        action: 'waitForResponse';
        urlContains: string;
        method?: string;
        statusBelow?: number;
        timeoutMs?: number;
      }
    | { action: 'waitForHidden'; target: ActionTarget; timeoutMs?: number }
    | { action: 'screenshot'; path?: string }
  );

export type ActionName = ActionIntent['action'];

export interface ValidationResult {
  ok: boolean;
  kind: string;
  expected?: string;
  actual?: string;
  detail?: string;
}

export type StepStatus = 'success' | 'failed' | 'blocked';

/** 审批请求：仅记录业务信息，不包含页面脚本。 */
export interface ApprovalRequest {
  stepIndex: number;
  action: string;
  description: string;
  targetName: string;
  requestedAt: string;
  screenshot?: string;
  pageUrl?: string;
  pageTitle?: string;
  pageTextSample?: string;
}

export interface ApprovalDecision {
  decision: 'approved' | 'rejected';
  at: string;
  actor?: string;
}

export interface ApprovalRecord {
  request: ApprovalRequest;
  decision?: ApprovalDecision;
}

export interface StepResult {
  index: number;
  action: string;
  description: string;
  status: StepStatus;
  startedAt: string;
  durationMs: number;
  validations: ValidationResult[];
  /** 动作目标（用于审计与数据库步骤表；goto/screenshot 无 target） */
  target?: ActionTarget;
  screenshot?: string;
  note?: string;
  error?: {
    name: string;
    code?: string;
    message: string;
  };
  /** 被审批闸门拦下时带上，便于 /approve 后续跑 */
  approval?: ApprovalRequest;
}

export interface StepTotals {
  steps: number;
  succeeded: number;
  blocked: number;
  failed: number;
  validations: number;
  validationFailures: number;
}

export interface PreflightResult {
  label: string;
  url: string;
  screenshot?: string;
  httpFailures: Array<{ url: string; status: number }>;
  note: string;
}

/** CLI 一次性运行的汇总结构（服务模式下用 TaskRecord / task summary）。 */
export interface RunResult {
  runId: string;
  scenario: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'passed' | 'failed';
  gateBlocked: boolean;
  target: {
    fixtureUrl: string;
    realProduct?: PreflightResult;
  };
  steps: StepResult[];
  totals: StepTotals;
  policyViolations: string[];
  screenshotsDir: string;
  resultJson: string;
  environment: {
    browserChannel: string;
    headless: boolean;
    approvalMode: 'auto' | 'require_approval';
  };
}

export function computeTotals(steps: StepResult[]): StepTotals {
  const validations = steps.flatMap((step) => step.validations);
  return {
    steps: steps.length,
    succeeded: steps.filter((step) => step.status === 'success').length,
    blocked: steps.filter((step) => step.status === 'blocked').length,
    failed: steps.filter((step) => step.status === 'failed').length,
    validations: validations.length,
    validationFailures: validations.filter((item) => !item.ok).length,
  };
}
