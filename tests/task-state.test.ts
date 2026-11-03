import assert from 'node:assert/strict';
import test from 'node:test';

import { InvalidTaskTransitionError } from '../src/core/errors.js';
import {
  allowedNextStatuses,
  assertTransition,
  canTransition,
  isTerminal,
} from '../src/tasks/task-state.js';
import type { TaskStatus } from '../src/tasks/task-types.js';

const LEGAL: Array<[TaskStatus, TaskStatus]> = [
  ['PENDING', 'RUNNING'],
  ['PENDING', 'CANCELLED'],
  ['RUNNING', 'COMPLETED'],
  ['RUNNING', 'FAILED'],
  ['RUNNING', 'CANCELLED'],
  ['RUNNING', 'WAITING_APPROVAL'],
  ['WAITING_APPROVAL', 'RUNNING'],
  ['WAITING_APPROVAL', 'CANCELLED'],
];

const STATUSES: TaskStatus[] = [
  'PENDING',
  'RUNNING',
  'WAITING_APPROVAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

test('合法状态迁移全部允许', () => {
  for (const [from, to] of LEGAL) {
    assert.equal(canTransition(from, to), true, `${from} -> ${to} 应允许`);
    assert.doesNotThrow(() => assertTransition('task-1', from, to));
  }
});

test('非法状态迁移全部拒绝并抛 INVALID_TASK_TRANSITION', () => {
  let illegalCount = 0;

  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const legal = LEGAL.some(([expectedFrom, expectedTo]) => {
        return expectedFrom === from && expectedTo === to;
      });
      if (legal) continue;

      illegalCount += 1;
      assert.equal(canTransition(from, to), false, `${from} -> ${to} 应拒绝`);
      assert.throws(
        () => assertTransition('task-1', from, to),
        (error: unknown) =>
          error instanceof InvalidTaskTransitionError &&
          error.code === 'INVALID_TASK_TRANSITION' &&
          error.statusCode === 409
      );
    }
  }

  assert.equal(illegalCount, STATUSES.length * STATUSES.length - LEGAL.length);
});

test('终态没有下一步，且不会被当作可执行状态', () => {
  for (const status of ['COMPLETED', 'FAILED', 'CANCELLED'] as TaskStatus[]) {
    assert.equal(isTerminal(status), true);
    assert.deepEqual(allowedNextStatuses(status), []);
  }

  assert.equal(isTerminal('PENDING'), false);
  assert.equal(isTerminal('RUNNING'), false);
  assert.equal(isTerminal('WAITING_APPROVAL'), false);
});

test('WAITING_APPROVAL 不能直接完成或失败，必须先回到 RUNNING', () => {
  assert.equal(canTransition('WAITING_APPROVAL', 'COMPLETED'), false);
  assert.equal(canTransition('WAITING_APPROVAL', 'FAILED'), false);
  assert.equal(canTransition('WAITING_APPROVAL', 'RUNNING'), true);
});
