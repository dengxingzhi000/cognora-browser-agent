import { randomUUID } from 'node:crypto';

import {
  AppError,
  InvalidInputError,
  InvalidTaskTransitionError,
} from '../core/errors.js';
import type { ServiceConfig } from '../config/config.js';
import type { StepResult } from '../core/types.js';
import { computeTotals } from '../core/types.js';
import type { Logger } from '../observability/logger.js';
import type { TaskArtifacts } from '../observability/run-records.js';
import { validatePlan } from '../security/action-policy.js';
import type { DomainPolicy } from '../security/domain-policy.js';
import type { TaskQueue } from '../../apps/worker/task-queue.js';
import type { WorkflowRegistry } from '../workflows/index.js';
import { assertTransition, allowedNextStatuses } from './task-state.js';
import { TaskStore } from './task-store.js';
import type {
  CreateTaskRequest,
  ExecutionFactory,
  ExecutionMode,
  ExecutionOutcome,
  TaskExecution,
  TaskRecord,
  TaskStatus,
  TaskView,
} from './task-types.js';

export interface TaskServiceDeps {
  config: ServiceConfig;
  store: TaskStore;
  queue: TaskQueue;
  executionFactory: ExecutionFactory;
  workflows: WorkflowRegistry;
  domainPolicy: DomainPolicy;
  artifacts: TaskArtifacts;
  logger: Logger;
}

export interface TaskStepsView {
  taskId: string;
  status: TaskStatus;
  steps: StepResult[];
  approvals: TaskRecord['approvals'];
  pendingApproval?: TaskRecord['pendingApproval'];
  policyViolations: string[];
}

/**
 * 任务生命周期编排：状态机 + 队列 + 审批断点。
 * 状态只存在内存；artifacts 下的 task.json 是快照，不是可恢复的持久化存储。
 */
export class TaskService {
  private readonly executions = new Map<string, TaskExecution>();

  constructor(private readonly deps: TaskServiceDeps) {}

  create(body: unknown): TaskRecord {
    const request = validateCreateTaskRequest(body);
    this.deps.domainPolicy.assertAllowed(request.target.url, '任务目标');

    const plan = this.deps.workflows.build(request.taskType, {
      config: this.deps.config,
      target: request.target,
      tenantId: request.tenantId,
      userId: request.userId ?? 'default',
      taskType: request.taskType,
      input: request.input,
    });
    const steps = validatePlan(plan.steps, this.deps.domainPolicy);

    const now = new Date().toISOString();
    const task: TaskRecord = {
      taskId: `task-${randomUUID()}`,
      taskType: request.taskType,
      tenantId: request.tenantId,
      userId: request.userId ?? 'default',
      target: request.target,
      input: request.input,
      executionMode: request.executionMode,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      steps: [],
      policyViolations: [],
      approvals: [],
      cancelRequested: false,
    };

    this.deps.store.create(task);
    task.summaryPath = this.deps.artifacts.writeTaskSummary(task);
    this.deps.logger.child({ taskId: task.taskId }).info('task.created', {
      taskType: task.taskType,
      tenantId: task.tenantId,
      userId: task.userId,
      executionMode: task.executionMode,
      steps: steps.length,
    });

    this.deps.queue.enqueue({
      label: task.taskId,
      run: () => this.executeTask(task.taskId, 'start'),
    });

    return task;
  }

  get(taskId: string): TaskRecord {
    return this.deps.store.getOrThrow(taskId);
  }

  view(taskId: string): TaskView {
    const task = this.get(taskId);
    return { ...task, totals: computeTotals(task.steps) };
  }

  steps(taskId: string): TaskStepsView {
    const task = this.get(taskId);
    return {
      taskId,
      status: task.status,
      steps: task.steps,
      approvals: task.approvals,
      ...(task.pendingApproval ? { pendingApproval: task.pendingApproval } : {}),
      policyViolations: task.policyViolations,
    };
  }

  approve(taskId: string, body: unknown): TaskRecord {
    const task = this.get(taskId);
    const actor = optionalActor(body);

    assertWorkflowStatus(taskId, task.status, 'WAITING_APPROVAL');
    assertTransition(taskId, task.status, 'RUNNING');

    const now = new Date().toISOString();
    const approvals = markDecision(task.approvals, 'approved', now, actor);

    const updated = this.deps.store.transition(taskId, 'RUNNING', {
      approvals,
      cancelRequested: false,
    });
    this.touch(updated);
    this.deps.logger.child({ taskId }).info('task.approved', {
      stepIndex: updated.pendingApproval?.stepIndex,
      actor,
    });

    this.deps.queue.enqueue({
      label: `${taskId}:resume`,
      run: () => this.executeTask(taskId, 'resume'),
    });

    return updated;
  }

  reject(taskId: string, body: unknown): TaskRecord {
    const task = this.get(taskId);
    const actor = optionalActor(body);

    assertWorkflowStatus(taskId, task.status, 'WAITING_APPROVAL');
    assertTransition(taskId, task.status, 'CANCELLED');

    const now = new Date().toISOString();
    const updated = this.deps.store.transition(taskId, 'CANCELLED', {
      finishedAt: now,
      approvals: markDecision(task.approvals, 'rejected', now, actor),
      error: {
        name: 'ApprovalRejected',
        code: 'APPROVAL_REJECTED',
        message: `审批被驳回（步骤 ${task.pendingApproval?.stepIndex ?? '未知'}）`,
        ...(task.pendingApproval ? { stepIndex: task.pendingApproval.stepIndex } : {}),
      },
    });
    this.touch(updated);
    this.deps.logger.child({ taskId }).warn('task.rejected', {
      stepIndex: task.pendingApproval?.stepIndex,
      actor,
    });
    void this.closeExecution(taskId);
    return updated;
  }

  cancel(taskId: string): TaskRecord {
    const task = this.get(taskId);
    assertTransition(taskId, task.status, 'CANCELLED');

    const now = new Date().toISOString();
    const updated = this.deps.store.transition(taskId, 'CANCELLED', {
      finishedAt: now,
      cancelRequested: true,
      error: {
        name: 'TaskCancelled',
        code: 'TASK_CANCELLED',
        message: '调用方取消任务',
      },
    });
    this.touch(updated);
    this.deps.logger.child({ taskId }).info('task.cancelled', { from: task.status });
    void this.closeExecution(taskId);
    return updated;
  }

  get allowedTransitions(): Record<TaskStatus, TaskStatus[]> {
    const statuses: TaskStatus[] = [
      'PENDING',
      'RUNNING',
      'WAITING_APPROVAL',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
    ];
    return statuses.reduce(
      (acc, status) => ({ ...acc, [status]: allowedNextStatuses(status) }),
      {} as Record<TaskStatus, TaskStatus[]>
    );
  }

  async shutdown(): Promise<void> {
    for (const taskId of [...this.executions.keys()]) {
      await this.closeExecution(taskId);
    }
    await this.deps.executionFactory.shutdown?.();
    await this.deps.store.close();
  }

  /** 等待任务 / 步骤写入持久化存储；API 在返回前调用。 */
  async flush(): Promise<void> {
    await this.deps.store.flush();
  }

  private async executeTask(taskId: string, mode: 'start' | 'resume'): Promise<void> {
    let task = this.deps.store.get(taskId);
    if (!task) return;

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) return;

    if (mode === 'start') {
      if (task.status !== 'PENDING') return;
      task = this.deps.store.transition(taskId, 'RUNNING', {
        startedAt: new Date().toISOString(),
      });
      this.touch(task);
    }

    const log = this.deps.logger.child({ taskId });
    let execution = this.executions.get(taskId);

    try {
      if (!execution) {
        execution = await this.deps.executionFactory.create(task, {
          onStep: (step) => this.recordStep(taskId, step),
          isCancelRequested: () => Boolean(this.deps.store.get(taskId)?.cancelRequested),
        });
        this.executions.set(taskId, execution);
      }

      const grantedStepIndex =
        mode === 'resume' ? this.deps.store.get(taskId)?.pendingApproval?.stepIndex : undefined;

      log.info('task.execution_started', { mode, grantedStepIndex });
      const outcome = await execution.run(
        grantedStepIndex === undefined ? {} : { grantedStepIndex }
      );
      await this.applyOutcome(taskId, outcome);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('task.execution_crashed', { message: err.message, code: (err as AppError).code });
      await this.failTask(taskId, {
        name: err.name,
        code: (err as AppError).code ?? 'EXECUTION_CRASHED',
        message: err.message,
      });
    }
  }

  private async applyOutcome(taskId: string, outcome: ExecutionOutcome): Promise<void> {
    const task = this.deps.store.get(taskId);
    if (!task) return;

    if (task.status === 'CANCELLED') {
      await this.closeExecution(taskId);
      return;
    }

    switch (outcome.status) {
      case 'completed': {
        const now = new Date().toISOString();
        const updated = this.deps.store.transition(taskId, 'COMPLETED', {
          finishedAt: now,
          pendingApproval: undefined,
          ...(outcome.sessionSummary
            ? {
                sessionSummary: outcome.sessionSummary,
                policyViolations: outcome.sessionSummary.policyViolations,
              }
            : {}),
        });
        this.touch(updated);
        this.deps.logger.child({ taskId }).info('task.completed', {
          steps: updated.steps.length,
        });
        await this.closeExecution(taskId);
        break;
      }
      case 'failed': {
        await this.failTask(taskId, outcome.error, outcome.sessionSummary);
        break;
      }
      case 'waiting_approval': {
        const approvals = [
          ...task.approvals,
          { request: outcome.approval },
        ];
        const updated = this.deps.store.transition(taskId, 'WAITING_APPROVAL', {
          pendingApproval: outcome.approval,
          approvals,
          ...(outcome.sessionSummary
            ? {
                sessionSummary: outcome.sessionSummary,
                policyViolations: outcome.sessionSummary.policyViolations,
              }
            : {}),
        });
        this.touch(updated);
        this.deps.logger.child({ taskId }).info('task.waiting_approval', {
          stepIndex: outcome.approval.stepIndex,
          targetName: outcome.approval.targetName,
        });
        break;
      }
      case 'cancelled': {
        const now = new Date().toISOString();
        const updated = this.deps.store.transition(taskId, 'CANCELLED', {
          finishedAt: now,
          ...(outcome.sessionSummary
            ? {
                sessionSummary: outcome.sessionSummary,
                policyViolations: outcome.sessionSummary.policyViolations,
              }
            : {}),
          error: {
            name: 'TaskCancelled',
            code: 'TASK_CANCELLED',
            message: '执行层在步骤之间收到取消信号',
          },
        });
        this.touch(updated);
        this.deps.logger.child({ taskId }).info('task.cancelled', { source: 'execution' });
        await this.closeExecution(taskId);
        break;
      }
    }
  }

  private async failTask(
    taskId: string,
    error: NonNullable<TaskRecord['error']>,
    sessionSummary?: TaskRecord['sessionSummary']
  ): Promise<void> {
    const task = this.deps.store.get(taskId);
    if (!task) return;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
      await this.closeExecution(taskId);
      return;
    }

    const now = new Date().toISOString();
    const updated = this.deps.store.transition(taskId, 'FAILED', {
      finishedAt: now,
      error,
      pendingApproval: undefined,
      ...(sessionSummary
        ? {
            sessionSummary,
            policyViolations: sessionSummary.policyViolations,
          }
        : {}),
    });
    this.touch(updated);
    this.deps.logger.child({ taskId }).error('task.failed', {
      code: error.code,
      message: error.message,
      stepIndex: error.stepIndex,
    });
    await this.closeExecution(taskId);
  }

  private recordStep(taskId: string, step: StepResult): void {
    const task = this.deps.store.get(taskId);
    if (!task) return;

    const index = task.steps.findIndex((item) => item.index === step.index);
    const steps =
      index >= 0
        ? task.steps.map((item) => (item.index === step.index ? step : item))
        : [...task.steps, step];

    const updated = this.deps.store.update(taskId, { steps });
    const summaryPath = this.deps.artifacts.writeTaskSummary(updated);
    this.deps.store.update(taskId, { summaryPath });

    this.deps.logger.child({ taskId }).info('step.recorded', {
      stepIndex: step.index,
      action: step.action,
      status: step.status,
      durationMs: step.durationMs,
      validations: step.validations.length,
      validationFailures: step.validations.filter((item) => !item.ok).length,
      screenshot: step.screenshot,
    });
  }

  private touch(task: TaskRecord): void {
    const summaryPath = this.deps.artifacts.writeTaskSummary(task);
    this.deps.store.update(task.taskId, { summaryPath });
  }

  private async closeExecution(taskId: string): Promise<void> {
    const execution = this.executions.get(taskId);
    if (!execution) return;
    this.executions.delete(taskId);
    await execution.close().catch(() => undefined);
  }
}

function assertWorkflowStatus(
  taskId: string,
  actual: TaskStatus,
  expected: TaskStatus
): void {
  if (actual !== expected) {
    throw new InvalidTaskTransitionError(
      taskId,
      actual,
      expected,
      `只有 ${expected} 状态可调用该审批操作`
    );
  }
}

function optionalActor(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidInputError('请求体必须是对象', { body });
  }
  const actor = (body as Record<string, unknown>).actor;
  if (actor === undefined) return undefined;
  if (typeof actor !== 'string' || actor.length > 120) {
    throw new InvalidInputError('actor 必须是不超过 120 字符的字符串', { actor });
  }
  return actor;
}

function markDecision(
  approvals: TaskRecord['approvals'],
  decision: 'approved' | 'rejected',
  at: string,
  actor?: string
): TaskRecord['approvals'] {
  const reversed = [...approvals].reverse();
  const target = reversed.find((item) => item.decision === undefined);
  if (!target) return approvals;

  return approvals.map((item) =>
    item === target
      ? { ...item, decision: { decision, at, ...(actor ? { actor } : {}) } }
      : item
  );
}

export function validateCreateTaskRequest(body: unknown): CreateTaskRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidInputError('请求体必须是 JSON 对象', { body });
  }

  const raw = body as Record<string, unknown>;
  const taskType = requireField(raw.taskType, 'taskType', 80);
  const tenantId = requireField(raw.tenantId, 'tenantId', 128);
  const userId = raw.userId === undefined ? undefined : requireField(raw.userId, 'userId', 128);

  if (!raw.target || typeof raw.target !== 'object' || Array.isArray(raw.target)) {
    throw new InvalidInputError('target 必须是对象', { target: raw.target });
  }
  const target = raw.target as Record<string, unknown>;
  const system = requireField(target.system, 'target.system', 80);
  const url = requireField(target.url, 'target.url', 2048);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidInputError('target.url 不是合法 URL', { url });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidInputError('target.url 只接受 http/https', { url });
  }

  const input =
    raw.input === undefined
      ? {}
      : raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input)
        ? (raw.input as Record<string, unknown>)
        : undefined;
  if (!input) throw new InvalidInputError('input 必须是对象', { input: raw.input });

  const executionMode = raw.executionMode ?? 'auto';
  if (executionMode !== 'auto' && executionMode !== 'require_approval') {
    throw new InvalidInputError('executionMode 只能是 auto / require_approval', { executionMode });
  }

  return {
    taskType,
    tenantId,
    ...(userId ? { userId } : {}),
    target: { system, url },
    input,
    executionMode: executionMode as ExecutionMode,
  };
}

function requireField(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidInputError(`${field} 必须是非空字符串`, { field });
  }
  if (value.length > maxLength) {
    throw new InvalidInputError(`${field} 超过长度上限 ${maxLength}`, { field });
  }
  return value.trim();
}
