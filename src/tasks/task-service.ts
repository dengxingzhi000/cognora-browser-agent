import { randomUUID } from 'node:crypto';

import {
  AppError,
  InvalidInputError,
  InvalidTaskTransitionError,
  LeaseLostError,
  TaskNotFoundError,
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
import type { TaskNotice } from '../persistence/types.js';
import { assertTransition, allowedNextStatuses } from './task-state.js';
import { TaskStore } from './task-store.js';
import type {
  ApprovalQueueResult,
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
  /** 实例身份；多实例下必须与 TaskStore 的 ownerId 一致。 */
  ownerId?: string;
}

export interface TaskStepsView {
  taskId: string;
  status: TaskStatus;
  steps: StepResult[];
  approvals: TaskRecord['approvals'];
  pendingApproval?: TaskRecord['pendingApproval'];
  policyViolations: string[];
}

export type ApprovalResult = TaskRecord | ApprovalQueueResult;

/**
 * 任务生命周期编排：状态机 + 队列 + 审批断点。
 * 单实例驱动（file / memory）沿用进程内队列；
 * Postgres 多实例模式下由 dispatcher 轮询认领，心跳续租，跨实例审批走通知表。
 */
export class TaskService {
  private readonly executions = new Map<string, TaskExecution>();
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  private readonly active = new Set<string>();
  private readonly ownerId: string;
  private dispatcher?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;

  constructor(private readonly deps: TaskServiceDeps) {
    this.ownerId = deps.ownerId ?? deps.store.ownerId;
    if (deps.store.supportsLeases && deps.store.leaseMs !== deps.config.taskLeaseMs) {
      throw new AppError(
        `TaskStore 租约时长（${deps.store.leaseMs}ms）与配置（${deps.config.taskLeaseMs}ms）不一致`,
        'LEASE_CONFIG_MISMATCH',
        500
      );
    }
  }

  /** 实例身份（多实例下写入 lease_owner）。 */
  get instanceId(): string {
    return this.ownerId;
  }

  async create(body: unknown): Promise<TaskRecord> {
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

    // 租约模式：先把 PENDING 行落库再开始认领，避免「创建写回」晚于认领覆盖 RUNNING 状态。
    if (this.deps.store.supportsLeases) {
      await this.deps.store.flush();
      this.startDispatcher();
    } else {
      this.deps.queue.enqueue({
        label: task.taskId,
        run: () => this.executeTask(task.taskId, 'start'),
      });
    }

    return task;
  }

  get(taskId: string): TaskRecord {
    return this.deps.store.getOrThrow(taskId);
  }

  /** 读取任务：本地没有时从 DB 装载；非持有任务每次都刷新，避免读到别的实例的旧状态。 */
  async loadTask(taskId: string): Promise<TaskRecord> {
    const local = this.deps.store.get(taskId);
    if (local && (this.deps.store.owns(taskId) || !this.deps.store.supportsLeases)) {
      return local;
    }
    const task = await this.deps.store.refresh(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return task;
  }

  view(taskId: string): TaskView {
    const task = this.get(taskId);
    return { ...task, totals: computeTotals(task.steps) };
  }

  async viewAsync(taskId: string): Promise<TaskView> {
    const task = await this.loadTask(taskId);
    return { ...task, totals: computeTotals(task.steps) };
  }

  steps(taskId: string): TaskStepsView {
    const task = this.get(taskId);
    return this.stepsOf(task);
  }

  async stepsAsync(taskId: string): Promise<TaskStepsView> {
    return this.stepsOf(await this.loadTask(taskId));
  }

  /**
   * 审批：持有实例本地迁移 RUNNING 并续跑；
   * 非持有实例把请求写入通知表并返回 202 语义（approval: queued + owner），由持有者轮询消费。
   */
  async approve(taskId: string, body: unknown): Promise<ApprovalResult> {
    const task = await this.loadTask(taskId);
    const actor = optionalActor(body);

    assertWorkflowStatus(taskId, task.status, 'WAITING_APPROVAL');

    if (this.deps.store.supportsLeases && !this.deps.store.owns(taskId)) {
      if (!task.leaseOwner) {
        throw new AppError(
          `任务 ${taskId} 处于等待审批但没有租约持有者，无法唤醒`,
          'APPROVAL_OWNER_MISSING',
          409,
          { taskId }
        );
      }
      await this.deps.store.requestWake(taskId, 'approve', {
        ...(actor ? { actor } : {}),
        requestedBy: this.ownerId,
      });
      this.deps.logger.child({ taskId }).info('task.approval_queued', {
        owner: task.leaseOwner,
        requestedBy: this.ownerId,
      });
      return { taskId, status: task.status, approval: 'queued', owner: task.leaseOwner };
    }

    assertTransition(taskId, task.status, 'RUNNING');
    this.approveLocally(task, actor);
    return this.deps.store.getOrThrow(taskId);
  }

  async reject(taskId: string, body: unknown): Promise<ApprovalResult> {
    const task = await this.loadTask(taskId);
    const actor = optionalActor(body);
    assertWorkflowStatus(taskId, task.status, 'WAITING_APPROVAL');

    if (this.deps.store.supportsLeases && !this.deps.store.owns(taskId)) {
      if (!task.leaseOwner) {
        throw new AppError(
          `任务 ${taskId} 处于等待审批但没有租约持有者，无法唤醒`,
          'APPROVAL_OWNER_MISSING',
          409,
          { taskId }
        );
      }
      await this.deps.store.requestWake(taskId, 'reject', {
        ...(actor ? { actor } : {}),
        requestedBy: this.ownerId,
      });
      return { taskId, status: task.status, approval: 'queued', owner: task.leaseOwner };
    }

    assertTransition(taskId, task.status, 'CANCELLED');
    this.rejectLocally(task, actor);
    return this.deps.store.getOrThrow(taskId);
  }

  async cancel(taskId: string): Promise<ApprovalResult> {
    const task = await this.loadTask(taskId);

    if (this.deps.store.supportsLeases && !this.deps.store.owns(taskId)) {
      if (!task.leaseOwner) {
        throw new AppError(
          `任务 ${taskId} 没有租约持有者，无法唤醒`,
          'APPROVAL_OWNER_MISSING',
          409,
          { taskId }
        );
      }
      await this.deps.store.requestWake(taskId, 'cancel', { requestedBy: this.ownerId });
      return {
        taskId,
        status: task.status,
        approval: 'queued',
        owner: task.leaseOwner,
      };
    }

    assertTransition(taskId, task.status, 'CANCELLED');
    this.cancelLocally(task);
    return this.deps.store.getOrThrow(taskId);
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

  /** 启动多实例 dispatcher（仅租约驱动）：认领 + 心跳 + 过期回收 + 审批唤醒。 */
  startDispatcher(): void {
    if (!this.deps.store.supportsLeases || this.dispatcher) return;
    const interval = this.deps.config.taskPollMs;
    this.dispatcher = setInterval(() => void this.tick(), interval);
    this.dispatcher.unref?.();
    void this.tick();
    this.deps.logger.info('dispatcher.started', {
      ownerId: this.ownerId,
      intervalMs: interval,
      leaseMs: this.deps.config.taskLeaseMs,
      heartbeatMs: this.deps.config.taskHeartbeatMs,
    });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.dispatcher) {
      clearInterval(this.dispatcher);
      this.dispatcher = undefined;
    }
    for (const timer of this.heartbeats.values()) clearInterval(timer);
    this.heartbeats.clear();
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

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      // 过期回收：RUNNING → PENDING；过期 WAITING → FAILED（持有进程已消失）。
      await this.deps.store.recoverExpired?.();
      await this.consumeWakes();

      if (this.stopped) return;
      while (this.active.size < this.deps.config.workerConcurrency) {
        const claimed = await this.deps.store.claim(this.ownerId);
        if (!claimed) break;
        this.active.add(claimed.taskId);
        this.startHeartbeat(claimed.taskId);
        this.deps.logger.child({ taskId: claimed.taskId }).info('task.claimed', {
          owner: this.ownerId,
          leaseExpiresAt: claimed.leaseExpiresAt,
        });
        this.deps.queue.enqueue({
          label: claimed.taskId,
          run: () => this.executeTask(claimed.taskId, 'claimed'),
        });
      }
    } catch (error) {
      this.deps.logger.error('dispatcher.tick_failed', {
        message: (error as Error).message,
      });
    } finally {
      this.ticking = false;
    }
  }

  private async consumeWakes(): Promise<void> {
    const notices = (await this.deps.store.consumeWakes(this.ownerId)) ?? [];
    for (const notice of notices) {
      await this.applyWake(notice).catch((error: unknown) => {
        this.deps.logger.error('task.wake_failed', {
          taskId: notice.taskId,
          kind: notice.kind,
          message: (error as Error).message,
        });
      });
    }
  }

  private async applyWake(notice: TaskNotice): Promise<void> {
    const task = this.deps.store.get(notice.taskId);
    if (!task || !this.deps.store.owns(notice.taskId)) return;
    if (task.status !== 'WAITING_APPROVAL') return;

    const actor = typeof notice.payload.actor === 'string' ? notice.payload.actor : undefined;
    const log = this.deps.logger.child({ taskId: notice.taskId });

    if (notice.kind === 'approve') {
      assertTransition(notice.taskId, task.status, 'RUNNING');
      this.approveLocally(task, actor);
      log.info('task.approval_applied_from_remote', { actor });
      return;
    }

    if (notice.kind === 'reject') {
      assertTransition(notice.taskId, task.status, 'CANCELLED');
      this.rejectLocally(task, actor);
      log.warn('task.rejection_applied_from_remote', { actor });
      return;
    }

    this.cancelLocally(task);
    log.info('task.cancel_applied_from_remote');
  }

  private approveLocally(task: TaskRecord, actor?: string): void {
    const now = new Date().toISOString();
    const updated = this.deps.store.transition(task.taskId, 'RUNNING', {
      approvals: markDecision(task.approvals, 'approved', now, actor),
      cancelRequested: false,
    });
    this.touch(updated);
    this.deps.logger.child({ taskId: task.taskId }).info('task.approved', {
      stepIndex: updated.pendingApproval?.stepIndex,
      actor,
    });

    this.deps.queue.enqueue({
      label: `${task.taskId}:resume`,
      run: () => this.executeTask(task.taskId, 'resume'),
    });
  }

  private rejectLocally(task: TaskRecord, actor?: string): void {
    const now = new Date().toISOString();
    const updated = this.deps.store.transition(task.taskId, 'CANCELLED', {
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
    this.stopHeartbeat(task.taskId);
    this.active.delete(task.taskId);
    this.deps.logger.child({ taskId: task.taskId }).warn('task.rejected', {
      stepIndex: task.pendingApproval?.stepIndex,
      actor,
    });
    void this.closeExecution(task.taskId);
  }

  private cancelLocally(task: TaskRecord): void {
    const now = new Date().toISOString();
    const updated = this.deps.store.transition(task.taskId, 'CANCELLED', {
      finishedAt: now,
      cancelRequested: true,
      error: {
        name: 'TaskCancelled',
        code: 'TASK_CANCELLED',
        message: '调用方取消任务',
      },
    });
    this.touch(updated);
    this.stopHeartbeat(task.taskId);
    this.active.delete(task.taskId);
    this.deps.logger.child({ taskId: task.taskId }).info('task.cancelled', { from: task.status });
    void this.closeExecution(task.taskId);
  }

  private async executeTask(
    taskId: string,
    mode: 'start' | 'resume' | 'claimed'
  ): Promise<void> {
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
      if (error instanceof LeaseLostError || this.deps.store.isLeaseLost(taskId)) {
        log.warn('task.execution_abandoned_lease_lost');
        this.stopHeartbeat(taskId);
        this.active.delete(taskId);
        await this.closeExecution(taskId);
        return;
      }
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

    try {
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
          this.finishLease(taskId);
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
          const approvals = [...task.approvals, { request: outcome.approval }];
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
          this.finishLease(taskId);
          this.deps.logger.child({ taskId }).info('task.cancelled', { source: 'execution' });
          await this.closeExecution(taskId);
          break;
        }
      }
    } catch (error) {
      if (error instanceof LeaseLostError || this.deps.store.isLeaseLost(taskId)) {
        this.deps.logger.child({ taskId }).warn('task.outcome_dropped_lease_lost', {
          outcome: outcome.status,
        });
        this.stopHeartbeat(taskId);
        this.active.delete(taskId);
        await this.closeExecution(taskId);
        return;
      }
      throw error;
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
    if (this.deps.store.isLeaseLost(taskId)) {
      this.deps.logger.child({ taskId }).warn('task.fail_dropped_lease_lost', {
        code: error.code,
      });
      this.stopHeartbeat(taskId);
      this.active.delete(taskId);
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
    this.finishLease(taskId);
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
    if (this.deps.store.isLeaseLost(taskId)) return;

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

  private stepsOf(task: TaskRecord): TaskStepsView {
    return {
      taskId: task.taskId,
      status: task.status,
      steps: task.steps,
      approvals: task.approvals,
      ...(task.pendingApproval ? { pendingApproval: task.pendingApproval } : {}),
      policyViolations: task.policyViolations,
    };
  }

  private startHeartbeat(taskId: string): void {
    if (!this.deps.store.supportsLeases) return;
    if (this.heartbeats.has(taskId)) return;

    const timer = setInterval(() => {
      void this.heartbeatOnce(taskId);
    }, this.deps.config.taskHeartbeatMs);
    timer.unref?.();
    this.heartbeats.set(taskId, timer);
  }

  private async heartbeatOnce(taskId: string): Promise<void> {
    if (this.deps.store.isLeaseLost(taskId)) {
      this.stopHeartbeat(taskId);
      return;
    }
    try {
      const ok = await this.deps.store.heartbeat(
        taskId,
        this.ownerId,
        this.deps.config.taskLeaseMs
      );
      if (ok) return;

      // 0 行 = 租约已被别的实例接管：立即停止执行，且不再写回任何结果。
      this.deps.store.markLeaseLost(taskId);
      this.stopHeartbeat(taskId);
      this.active.delete(taskId);
      this.deps.logger.child({ taskId }).warn('task.lease_lost', {
        ownerId: this.ownerId,
      });
      await this.closeExecution(taskId);
    } catch (error) {
      this.deps.logger.child({ taskId }).warn('task.heartbeat_failed', {
        message: (error as Error).message,
      });
    }
  }

  private stopHeartbeat(taskId: string): void {
    const timer = this.heartbeats.get(taskId);
    if (!timer) return;
    clearInterval(timer);
    this.heartbeats.delete(taskId);
  }

  private finishLease(taskId: string): void {
    this.stopHeartbeat(taskId);
    this.active.delete(taskId);
    this.deps.store.release(taskId);
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
