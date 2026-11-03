import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import { createFakeRuntime, taskPayload, waitForTaskStatus, type FakeRuntime } from './helpers/fake-runtime.js';

interface TaskBody {
  taskId: string;
  status: string;
  executionMode: string;
  steps: Array<{
    index: number;
    status: string;
    action: string;
    durationMs: number;
    startedAt: string;
    validations: Array<{ ok: boolean; expected?: string; actual?: string }>;
    screenshot?: string;
    error?: { code?: string };
    approval?: { stepIndex: number };
  }>;
  approvals: Array<{ request: { stepIndex: number }; decision?: { decision: string } }>;
  pendingApproval?: { stepIndex: number; targetName: string; screenshot?: string };
  sessionSummary?: { cookieNames: string[]; storageStateRef?: string };
  error?: { code?: string };
  summaryPath?: string;
}

async function createTask(
  runtime: FakeRuntime,
  payload: Record<string, unknown>
): Promise<{ taskId: string; status: string }> {
  const response = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/browser/tasks',
    payload,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as { taskId: string; status: string };
}

async function getTask(runtime: FakeRuntime, taskId: string): Promise<TaskBody> {
  const response = await runtime.app.inject({
    method: 'GET',
    url: `/api/v1/browser/tasks/${taskId}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as TaskBody;
}

async function shutdown(runtime: FakeRuntime): Promise<void> {
  await runtime.app.close();
  await runtime.service.shutdown();
}

test('POST/GET/steps：创建任务并跑到完成，步骤含耗时、校验与截图', async () => {
  const runtime = await createFakeRuntime();
  try {
    const created = await createTask(runtime, taskPayload());
    assert.equal(created.status, 'PENDING');

    const completed = await waitForTaskStatus(runtime, created.taskId, ['COMPLETED']);
    assert.equal(completed.status, 'COMPLETED');

    const task = await getTask(runtime, created.taskId);
    assert.equal(task.steps.length, 3);
    assert.equal(task.steps[0].status, 'success');
    assert.equal(task.steps[0].validations[0].expected, 'step 成功');
    assert.equal(task.steps[0].validations[0].actual, 'success');
    assert.ok(task.steps[0].durationMs >= 0);
    assert.ok(task.steps[0].startedAt);
    assert.ok(task.steps[0].screenshot);
    assert.ok(task.summaryPath && task.summaryPath.endsWith('task.json'));

    const steps = await runtime.app.inject({
      method: 'GET',
      url: `/api/v1/browser/tasks/${created.taskId}/steps`,
    });
    assert.equal(steps.statusCode, 200);
    const stepsBody = steps.json() as { taskId: string; status: string; steps: unknown[] };
    assert.equal(stepsBody.taskId, created.taskId);
    assert.equal(stepsBody.status, 'COMPLETED');
    assert.equal(stepsBody.steps.length, 3);
  } finally {
    await shutdown(runtime);
  }
});

test('require_approval：停在 WAITING_APPROVAL，approve 后从断点继续到完成', async () => {
  const runtime = await createFakeRuntime();
  try {
    const created = await createTask(
      runtime,
      taskPayload({ executionMode: 'require_approval' })
    );

    await waitForTaskStatus(runtime, created.taskId, ['WAITING_APPROVAL']);
    const waiting = await getTask(runtime, created.taskId);
    assert.equal(waiting.status, 'WAITING_APPROVAL');
    assert.equal(waiting.pendingApproval?.stepIndex, 3);
    assert.equal(waiting.steps.length, 3);
    assert.equal(waiting.steps[2].status, 'blocked');
    assert.equal(waiting.approvals.length, 1);

    const stepsBefore = waiting.steps.map((step) => step.startedAt);

    const approved = await runtime.app.inject({
      method: 'POST',
      url: `/api/v1/browser/tasks/${created.taskId}/approve`,
      payload: { actor: 'reviewer' },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal((approved.json() as { status: string }).status, 'RUNNING');

    await waitForTaskStatus(runtime, created.taskId, ['COMPLETED']);
    const done = await getTask(runtime, created.taskId);
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.steps.length, 3);
    assert.equal(done.steps[2].status, 'success');
    assert.deepEqual(
      done.steps.slice(0, 2).map((step) => step.startedAt),
      stepsBefore.slice(0, 2),
      '已完成的前序步骤不能重跑（startedAt 必须保持不变）'
    );
    assert.equal(done.approvals.length, 1);
    assert.equal(done.approvals[0].decision?.decision, 'approved');
  } finally {
    await shutdown(runtime);
  }
});

test('重复 approve 与非审批态操作返回 409', async () => {
  const runtime = await createFakeRuntime();
  try {
    const created = await createTask(
      runtime,
      taskPayload({ executionMode: 'require_approval' })
    );
    await waitForTaskStatus(runtime, created.taskId, ['WAITING_APPROVAL']);

    const first = await runtime.app.inject({
      method: 'POST',
      url: `/api/v1/browser/tasks/${created.taskId}/approve`,
      payload: {},
    });
    assert.equal(first.statusCode, 200);

    const second = await runtime.app.inject({
      method: 'POST',
      url: `/api/v1/browser/tasks/${created.taskId}/approve`,
      payload: {},
    });
    assert.equal(second.statusCode, 409, second.body);
    assert.equal(
      (second.json() as { error: { code: string } }).error.code,
      'INVALID_TASK_TRANSITION'
    );

    await waitForTaskStatus(runtime, created.taskId, ['COMPLETED']);
    const third = await runtime.app.inject({
      method: 'POST',
      url: `/api/v1/browser/tasks/${created.taskId}/approve`,
      payload: {},
    });
    assert.equal(third.statusCode, 409);
  } finally {
    await shutdown(runtime);
  }
});

test('reject：任务按 CANCELLED 处理并记录驳回原因，之后 approve/reject 均 409', async () => {
  const runtime = await createFakeRuntime();
  try {
    const created = await createTask(
      runtime,
      taskPayload({ executionMode: 'require_approval' })
    );
    await waitForTaskStatus(runtime, created.taskId, ['WAITING_APPROVAL']);

    const rejected = await runtime.app.inject({
      method: 'POST',
      url: `/api/v1/browser/tasks/${created.taskId}/reject`,
      payload: { actor: 'reviewer' },
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal((rejected.json() as { status: string }).status, 'CANCELLED');

    const task = await getTask(runtime, created.taskId);
    assert.equal(task.status, 'CANCELLED');
    assert.equal(task.error?.code, 'APPROVAL_REJECTED');
    assert.equal(task.approvals[0].decision?.decision, 'rejected');

    for (const action of ['approve', 'reject']) {
      const response = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/browser/tasks/${created.taskId}/${action}`,
        payload: {},
      });
      assert.equal(response.statusCode, 409, `${action} 应返回 409：${response.body}`);
    }
  } finally {
    await shutdown(runtime);
  }
});

test('cancel：WAITING_APPROVAL 与 PENDING 都可取消，重复取消 409', async () => {
  const runtime = await createFakeRuntime({ concurrency: 1 });
  try {
    const running = await createTask(
      runtime,
      taskPayload({ input: { holdMs: 250 } })
    );

    const pending = await createTask(runtime, taskPayload());
    assert.equal(pending.status, 'PENDING');

    const cancelPending = await runtime.app.inject({
      method: 'POST',
      url: `/api/v1/browser/tasks/${pending.taskId}/cancel`,
      payload: {},
    });
    assert.equal(cancelPending.statusCode, 200, cancelPending.body);
    assert.equal((cancelPending.json() as { status: string }).status, 'CANCELLED');

    await waitForTaskStatus(runtime, running.taskId, ['COMPLETED']);
    const cancelledTask = await getTask(runtime, pending.taskId);
    assert.equal(cancelledTask.status, 'CANCELLED');
    assert.equal(cancelledTask.steps.length, 0, '取消发生在执行前，不应产生步骤');

    const cancelAgain = await runtime.app.inject({
      method: 'POST',
      url: `/api/v1/browser/tasks/${pending.taskId}/cancel`,
      payload: {},
    });
    assert.equal(cancelAgain.statusCode, 409);

    const waiting = await createTask(
      runtime,
      taskPayload({ executionMode: 'require_approval' })
    );
    await waitForTaskStatus(runtime, waiting.taskId, ['WAITING_APPROVAL']);
    const cancelWaiting = await runtime.app.inject({
      method: 'POST',
      url: `/api/v1/browser/tasks/${waiting.taskId}/cancel`,
      payload: {},
    });
    assert.equal(cancelWaiting.statusCode, 200, cancelWaiting.body);
    assert.equal((cancelWaiting.json() as { status: string }).status, 'CANCELLED');
  } finally {
    await shutdown(runtime);
  }
});

test('入参校验与 404：400 / 403 / 404 错误码', async () => {
  const runtime = await createFakeRuntime();
  try {
    const missingTaskType = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/browser/tasks',
      payload: { tenantId: 't', target: { system: 's', url: 'http://127.0.0.1:4310/' }, input: {} },
    });
    assert.equal(missingTaskType.statusCode, 400);
    assert.equal(
      (missingTaskType.json() as { error: { code: string } }).error.code,
      'INVALID_INPUT'
    );

    const badMode = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/browser/tasks',
      payload: taskPayload({ executionMode: 'always_yes' }),
    });
    assert.equal(badMode.statusCode, 400);

    const unknownType = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/browser/tasks',
      payload: taskPayload({ taskType: 'unknown.type' }),
    });
    assert.equal(unknownType.statusCode, 400);

    const externalTarget = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/browser/tasks',
      payload: taskPayload({ target: { system: 'x', url: 'https://example.com/' } }),
    });
    assert.equal(externalTarget.statusCode, 403);
    assert.equal(
      (externalTarget.json() as { error: { code: string } }).error.code,
      'DOMAIN_NOT_ALLOWED'
    );

    const unknownTask = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/browser/tasks/task-does-not-exist',
    });
    assert.equal(unknownTask.statusCode, 404);
    assert.equal(
      (unknownTask.json() as { error: { code: string } }).error.code,
      'TASK_NOT_FOUND'
    );

    const unknownSteps = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/browser/tasks/task-does-not-exist/steps',
    });
    assert.equal(unknownSteps.statusCode, 404);

    const approveMissing = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/browser/tasks/task-does-not-exist/approve',
      payload: {},
    });
    assert.equal(approveMissing.statusCode, 404);
  } finally {
    await shutdown(runtime);
  }
});

test('真实 HTTP 监听：监听端口后可用 fetch 创建与查询任务', async () => {
  const runtime = await createFakeRuntime();
  try {
    await runtime.app.listen({ port: 0, host: '127.0.0.1' });
    const address = runtime.app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/api/v1/browser/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskPayload()),
    });
    assert.equal(response.status, 201);
    const created = (await response.json()) as { taskId: string; status: string };

    const fetched = await fetch(`${base}/api/v1/browser/tasks/${created.taskId}`);
    assert.equal(fetched.status, 200);
    const body = (await fetched.json()) as TaskBody;
    assert.equal(body.taskId, created.taskId);
  } finally {
    await shutdown(runtime);
  }
});

test('队列并发上限来自配置', async () => {
  const runtime = await createFakeRuntime({ concurrency: 1 });
  try {
    assert.equal(runtime.queue.stats.maxConcurrency, 1);
    assert.equal(runtime.queue.stats.running, 0);
    assert.equal(runtime.queue.stats.queued, 0);
  } finally {
    await shutdown(runtime);
  }
});
