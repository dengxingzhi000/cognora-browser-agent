import type {
  ActionIntent,
  ApprovalRecord,
  ApprovalRequest,
  StepResult,
} from '../core/types.js';

export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type ExecutionMode = 'auto' | 'require_approval';

export interface TaskTarget {
  system: string;
  url: string;
}

export interface CreateTaskRequest {
  taskType: string;
  tenantId: string;
  userId?: string;
  target: TaskTarget;
  input: Record<string, unknown>;
  executionMode: ExecutionMode;
}

export interface TaskSessionSummary {
  cookieNames: string[];
  /** 不含凭据的归档引用（Postgres 为 pg:tenant/user/taskType，文件为路径） */
  storageStateRef?: string;
  policyViolations: string[];
}

export interface TaskError {
  name: string;
  code?: string;
  message: string;
  stepIndex?: number;
}

export interface TaskRecord {
  taskId: string;
  taskType: string;
  tenantId: string;
  userId: string;
  target: TaskTarget;
  input: Record<string, unknown>;
  executionMode: ExecutionMode;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  steps: StepResult[];
  policyViolations: string[];
  approvals: ApprovalRecord[];
  pendingApproval?: ApprovalRequest;
  sessionSummary?: TaskSessionSummary;
  error?: TaskError;
  cancelRequested: boolean;
  /** 任务级汇总 JSON 的落盘路径（仅排查用，进程重启不会回放） */
  summaryPath?: string;
}

export interface TaskView extends Omit<TaskRecord, 'input'> {
  input: Record<string, unknown>;
  totals: {
    steps: number;
    succeeded: number;
    blocked: number;
    failed: number;
    validations: number;
    validationFailures: number;
  };
}

export type ExecutionOutcome =
  | { status: 'completed'; sessionSummary?: TaskSessionSummary }
  | { status: 'failed'; error: TaskError; sessionSummary?: TaskSessionSummary }
  | { status: 'waiting_approval'; approval: ApprovalRequest; sessionSummary?: TaskSessionSummary }
  | { status: 'cancelled'; sessionSummary?: TaskSessionSummary };

export interface ExecutionHooks {
  onStep: (step: StepResult) => void;
  isCancelRequested: () => boolean;
}

export interface TaskExecution {
  run(options?: { grantedStepIndex?: number }): Promise<ExecutionOutcome>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface ExecutionFactory {
  create(task: TaskRecord, hooks: ExecutionHooks): Promise<TaskExecution>;
  shutdown?: () => Promise<void>;
}

export interface WorkflowPlan {
  description: string;
  steps: ActionIntent[];
}

export interface BrowserTaskPlan {
  task: TaskRecord;
  plan: WorkflowPlan;
}
