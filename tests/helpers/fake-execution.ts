import { isSensitiveActionName } from '../../src/security/approval.js';
import type {
  ExecutionHooks,
  ExecutionOutcome,
  TaskExecution,
  TaskRecord,
} from '../../src/tasks/task-types.js';
import type { ActionIntent } from '../../src/core/types.js';
import type { StepResult } from '../../src/core/types.js';

const delay = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * 测试用执行器：不启动浏览器，只按 actions.run 的动作条数模拟状态流转。
 * 用来验证 API / 状态机 / 审批契约；真实浏览器行为由 Playwright 测试覆盖。
 */
export class FakeExecutionFactory {
  async create(task: TaskRecord, hooks: ExecutionHooks): Promise<TaskExecution> {
    return new FakeExecution(task, hooks);
  }
}

class FakeExecution implements TaskExecution {
  private cursor = 0;
  private cancelled = false;
  private closed = false;

  constructor(
    private readonly task: TaskRecord,
    private readonly hooks: ExecutionHooks
  ) {}

  async run(options: { grantedStepIndex?: number } = {}): Promise<ExecutionOutcome> {
    if (this.closed || this.cancelled) return { status: 'cancelled' };

    const actions = this.task.input.actions as ActionIntent[];
    const holdMs = Number(this.task.input.holdMs ?? 0);
    const failAtStep = Number(this.task.input.failAtStep ?? 0);

    while (this.cursor < actions.length) {
      if (this.cancelled || this.hooks.isCancelRequested()) {
        return { status: 'cancelled' };
      }

      const index = this.cursor;
      await delay(holdMs);

      if (failAtStep === index + 1) {
        const step = this.makeStep(index + 1, actions[index], 'failed', {
          name: 'ValidationError',
          code: 'VALIDATION_FAILED',
          message: '模拟校验失败',
        });
        this.hooks.onStep(step);
        return {
          status: 'failed',
          error: {
            name: 'ValidationError',
            code: 'VALIDATION_FAILED',
            message: '模拟校验失败',
            stepIndex: index + 1,
          },
        };
      }

      const action = actions[index];
      const targetName =
        'target' in action && action.target && 'name' in action.target
          ? String(action.target.name)
          : '';
      const requiresApproval =
        this.task.executionMode === 'require_approval' &&
        action.action === 'click' &&
        isSensitiveActionName(targetName, action.approvalRequired);

      if (requiresApproval && options.grantedStepIndex !== index + 1) {
        const step = this.makeStep(index + 1, action, 'blocked', {
          name: 'WaitingApprovalError',
          code: 'WAITING_APPROVAL',
          message: `敏感动作「${targetName}」等待审批`,
        });
        step.approval = {
          stepIndex: index + 1,
          action: action.action,
          description: step.description,
          targetName,
          requestedAt: new Date().toISOString(),
          screenshot: `/tmp/fake-approval-${index + 1}.png`,
          pageUrl: 'http://127.0.0.1:4310/approval-demo',
        };
        this.hooks.onStep(step);
        return {
          status: 'waiting_approval',
          approval: step.approval,
          sessionSummary: {
            cookieNames: ['fake_cookie'],
            policyViolations: [],
          },
        };
      }

      this.hooks.onStep(this.makeStep(index + 1, action, 'success'));
      this.cursor += 1;
    }

    return {
      status: 'completed',
      sessionSummary: {
        cookieNames: ['fake_cookie'],
        storageStateRef: '/tmp/fake-storage-state.json',
        policyViolations: [],
      },
    };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private makeStep(
    index: number,
    action: ActionIntent,
    status: StepResult['status'],
    error?: StepResult['error']
  ): StepResult {
    return {
      index,
      action: action.action,
      description: `${action.action} #${index}`,
      status,
      startedAt: new Date().toISOString(),
      durationMs: 1,
      validations: [
        {
          ok: status === 'success',
          kind: 'fake-check',
          expected: 'step 成功',
          actual: status,
        },
      ],
      screenshot: `/tmp/fake-step-${index}.png`,
      ...(error ? { error } : {}),
    };
  }
}
