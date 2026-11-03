import { InvalidTaskTransitionError } from '../core/errors.js';
import type { TaskStatus } from './task-types.js';

/**
 * 任务状态机：
 * PENDING → RUNNING → COMPLETED | FAILED | CANCELLED | WAITING_APPROVAL
 * WAITING_APPROVAL → RUNNING → COMPLETED | FAILED（或 CANCELLED，用于 reject/cancel）
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_APPROVAL'],
  WAITING_APPROVAL: ['RUNNING', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(taskId: string, from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTaskTransitionError(taskId, from, to);
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function allowedNextStatuses(status: TaskStatus): TaskStatus[] {
  return [...TRANSITIONS[status]];
}
