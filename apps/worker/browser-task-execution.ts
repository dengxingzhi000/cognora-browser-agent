import type { ServiceConfig } from '../../src/config/config.js';
import type { ActionIntent, ApprovalRequest, StepResult } from '../../src/core/types.js';
import { ActionNotAllowedError, AppError } from '../../src/core/errors.js';
import type { Logger } from '../../src/observability/logger.js';
import type { TaskArtifacts } from '../../src/observability/run-records.js';
import type { SessionStateManager } from '../../src/browser/session-state-manager.js';
import type { SessionManager, TaskSession } from '../../src/browser/session-manager.js';
import { ActionRunner } from '../../src/automation/action-runner.js';
import { validatePlan } from '../../src/security/action-policy.js';
import type { DomainPolicy } from '../../src/security/domain-policy.js';
import type {
  ExecutionFactory,
  ExecutionHooks,
  ExecutionOutcome,
  TaskExecution,
  TaskRecord,
  TaskSessionSummary,
  WorkflowPlan,
} from '../../src/tasks/task-types.js';
import type { WorkflowRegistry } from '../../src/workflows/index.js';

export interface BrowserExecutorDeps {
  config: ServiceConfig;
  domainPolicy: DomainPolicy;
  workflows: WorkflowRegistry;
  sessions: SessionManager;
  profiles: SessionStateManager;
  artifacts: TaskArtifacts;
  logger: Logger;
}

/**
 * 浏览器任务执行器：同一任务可多次 run()。
 * 第一次跑到敏感动作 → 返回 waiting_approval 并保留 session；
 * /approve 后再次 run({ grantedStepIndex }) 从断点继续，已完成步骤不重跑。
 */
export class BrowserTaskExecution implements TaskExecution {
  private session?: TaskSession;
  private runner?: ActionRunner;
  private cursor = 0;
  private cancelRequested = false;
  private running = false;
  private closed = false;

  constructor(
    private readonly task: TaskRecord,
    private readonly plan: WorkflowPlan,
    private readonly deps: BrowserExecutorDeps,
    private readonly hooks: ExecutionHooks
  ) {}

  async run(options: { grantedStepIndex?: number } = {}): Promise<ExecutionOutcome> {
    if (this.closed) return { status: 'cancelled' };

    const log = this.deps.logger.child({ taskId: this.task.taskId });
    this.running = true;

    try {
      if (!this.session) {
        this.deps.artifacts.ensureTaskDirs(this.task.taskId);
        const storageState = await this.deps.profiles.load(
          this.task.tenantId,
          this.task.userId,
          this.task.taskType
        );

        this.session = await this.deps.sessions.open({
          taskId: this.task.taskId,
          ...(storageState ? { storageState } : {}),
        });
        this.runner = new ActionRunner(
          this.session.page,
          this.deps.domainPolicy,
          {
            actionTimeoutMs: this.deps.config.actionTimeoutMs,
            expectTimeoutMs: this.deps.config.expectTimeoutMs,
            screenshotsDir: this.deps.artifacts.screenshotsDir(this.task.taskId),
            downloadsDir: this.deps.artifacts.downloadsDir(this.task.taskId),
            executionMode: this.task.executionMode,
            taskId: this.task.taskId,
            uploadRoot: this.deps.config.uploadRoot,
            uploadAllowedExtensions: this.deps.config.uploadAllowedExtensions,
            uploadMaxBytes: this.deps.config.uploadMaxBytes,
            downloadMaxBytes: this.deps.config.downloadMaxBytes,
            downloadAllowedExtensions: this.deps.config.downloadAllowedExtensions,
          },
          this.deps.logger
        );

        log.info('session.opened', {
          storageStateReused: Boolean(storageState),
          sessionStateDriver: this.deps.profiles.describe(),
        });
      }

      if (!this.runner) throw new Error('浏览器会话未初始化');

      while (this.cursor < this.plan.steps.length) {
        if (this.cancelRequested || this.hooks.isCancelRequested()) {
          return await this.finishCancelled();
        }

        const index = this.cursor;
        const intent = this.plan.steps[index];
        const granted = options.grantedStepIndex === index + 1;

        log.info('step.started', { stepIndex: index + 1, action: intent.action });
        const step = await this.runner.run(intent, index + 1, {
          ...(granted ? { approvalGranted: true } : {}),
        });
        this.hooks.onStep(step);

        if (step.status === 'blocked') {
          if (!step.approval) {
            throw new AppError('审批拦截缺少审批信息', 'APPROVAL_STATE_INVALID', 500, { step });
          }
          log.info('step.waiting_approval', {
            stepIndex: index + 1,
            targetName: step.approval.targetName,
          });
          return {
            status: 'waiting_approval',
            approval: step.approval,
            sessionSummary: await this.summarizeSession(),
          };
        }

        if (step.status === 'failed') {
          const error = {
            name: step.error?.name ?? 'StepFailed',
            code: step.error?.code ?? 'STEP_FAILED',
            message: step.error?.message ?? `第 ${index + 1} 步失败`,
            stepIndex: index + 1,
          };
          const summary = await this.summarizeSession();
          log.error('step.failed', { stepIndex: index + 1, code: error.code, message: error.message });
          await this.closeSession();
          return { status: 'failed', error, sessionSummary: summary };
        }

        this.cursor += 1;
        log.info('step.succeeded', { stepIndex: index + 1, durationMs: step.durationMs });
      }

      const storageStateRef = await this.deps.profiles.save(
        this.session,
        this.task.tenantId,
        this.task.userId,
        this.task.taskType
      );
      const summary = await this.summarizeSession(storageStateRef);
      log.info('task.execution_completed', {
        steps: this.plan.steps.length,
        storageStateRef,
      });
      await this.closeSession();
      return { status: 'completed', sessionSummary: summary };
    } finally {
      this.running = false;
    }
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    // 等待审批时没有正在执行的 run()，可以直接释放浏览器会话。
    if (!this.running) await this.closeSession();
  }

  async close(): Promise<void> {
    this.cancelRequested = true;
    await this.closeSession();
  }

  private async summarizeSession(storageStateRef?: string): Promise<TaskSessionSummary> {
    const session = this.session;
    const cookieNames = session ? await session.cookieNames() : [];
    return {
      cookieNames,
      ...(storageStateRef ? { storageStateRef } : {}),
      policyViolations: session ? [...session.violations] : [],
    };
  }

  private async finishCancelled(): Promise<ExecutionOutcome> {
    const summary = await this.summarizeSession();
    await this.closeSession();
    return { status: 'cancelled', sessionSummary: summary };
  }

  private async closeSession(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const session = this.session;
    this.session = undefined;
    this.runner = undefined;
    if (session) await session.close();
  }
}

export class BrowserTaskExecutionFactory implements ExecutionFactory {
  constructor(private readonly deps: BrowserExecutorDeps) {}

  async create(task: TaskRecord, hooks: ExecutionHooks): Promise<TaskExecution> {
    let plan: WorkflowPlan;
    try {
      plan = this.deps.workflows.build(task.taskType, {
        config: this.deps.config,
        target: task.target,
        tenantId: task.tenantId,
        userId: task.userId,
        taskType: task.taskType,
        input: task.input,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new ActionNotAllowedError(`构建流程失败：${(error as Error).message}`, {
        taskType: task.taskType,
      });
    }

    // 执行前再校验一次：防止绕过 API 直接改内存 / 未来接入其他入口时漏检。
    const steps: ActionIntent[] = validatePlan(plan.steps, this.deps.domainPolicy);

    return new BrowserTaskExecution(task, { ...plan, steps }, this.deps, hooks);
  }
}

export function approvalOf(step: StepResult): ApprovalRequest | undefined {
  return step.approval;
}
