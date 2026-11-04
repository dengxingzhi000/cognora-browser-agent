/**
 * 执行层 / API 错误统一带 code 与 HTTP 状态码，便于上层结构化处理。
 * 只有计划构建与任务状态迁移会直接映射为 HTTP 错误；
 * 运行期步骤错误记录在任务结果里。
 */

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class InvalidInputError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'INVALID_INPUT', 400, details);
  }
}

export class DomainNotAllowedError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'DOMAIN_NOT_ALLOWED', 403, details);
  }
}

export class ActionNotAllowedError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'ACTION_NOT_ALLOWED', 403, details);
  }
}

export class TaskNotFoundError extends AppError {
  constructor(taskId: string) {
    super(`任务 ${taskId} 不存在`, 'TASK_NOT_FOUND', 404, { taskId });
  }
}

export class InvalidTaskTransitionError extends AppError {
  constructor(taskId: string, from: string, to: string, reason?: string) {
    super(
      `任务 ${taskId} 不允许从 ${from} 迁移到 ${to}${reason ? `（${reason}）` : ''}`,
      'INVALID_TASK_TRANSITION',
      409,
      { taskId, from, to, reason }
    );
  }
}

/** 守卫写回命中 0 行：租约已被别的实例接管，本实例不得覆盖其结果。 */
export class LeaseLostError extends AppError {
  constructor(taskId: string, ownerId?: string) {
    super(
      `任务 ${taskId} 的租约已失效${ownerId ? `（持有者 ${ownerId}）` : ''}，本次写回被拒绝`,
      'LEASE_LOST',
      409,
      { taskId, ...(ownerId ? { ownerId } : {}) }
    );
  }
}

export class ElementNotFoundError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'ELEMENT_NOT_FOUND', 422, details);
  }
}

export class AmbiguousTargetError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'AMBIGUOUS_TARGET', 422, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'VALIDATION_FAILED', 422, details);
  }
}

export class WaitTimeoutError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'WAIT_TIMEOUT', 422, details);
  }
}

export class UploadRejectedError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'UPLOAD_REJECTED', 422, details);
  }
}

export class DownloadRejectedError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'DOWNLOAD_REJECTED', 422, details);
  }
}

/** approval-gate 的拦截信号：不是失败，而是把控制权交回人或 API。 */
export class WaitingApprovalError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'WAITING_APPROVAL', 409, details);
  }
}

/** 检测到验证码 / 反自动化提示：立即停止，不尝试绕过。 */
export class AntiAutomationDetectedError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'ANTI_AUTOMATION_DETECTED', 422, details);
  }
}
