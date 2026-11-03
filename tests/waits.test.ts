import assert from 'node:assert/strict';
import test from 'node:test';

import { createAndWait, createBrowserRuntime, type BrowserRuntime } from './helpers/browser-runtime.js';

function runtimePayload(runtime: BrowserRuntime, actions: unknown[]) {
  return {
    taskType: 'actions.run',
    tenantId: 'tenant-waits',
    userId: 'u1',
    target: { system: 'fixture', url: runtime.fixture.url },
    executionMode: 'auto',
    input: { actions },
  };
}

test('显式等待：spinner 消失 + API 响应完成，替代固定 timeout', { timeout: 180000 }, async () => {
  const runtime = await createBrowserRuntime();
  try {
    const base = runtime.fixture.url;

    const task = await createAndWait(
      runtime,
      runtimePayload(runtime, [
        {
          action: 'goto',
          url: `${base}/components/waits`,
          expect: { type: 'text', text: '显式等待', exact: false },
        },
        {
          action: 'waitForHidden',
          target: { role: 'progressbar', name: '加载中' },
          timeoutMs: 5000,
        },
        {
          action: 'click',
          target: { role: 'button', name: '触发同步' },
          waitFor: {
            type: 'response',
            urlContains: '/api/slow',
            method: 'GET',
            statusBelow: 400,
            timeoutMs: 5000,
          },
          expect: { type: 'status', text: '同步完成', exact: false },
        },
      ])
    );

    assert.equal(task.status, 'COMPLETED', JSON.stringify(task.steps));

    const hidden = task.steps[1].validations.find((item) => item.kind === 'wait-hidden');
    assert.ok(hidden?.ok, JSON.stringify(task.steps[1].validations));
    assert.ok(
      task.steps[1].durationMs >= 500,
      `waitForHidden 应真实等待 spinner 消失，实际耗时 ${task.steps[1].durationMs}ms`
    );

    const response = task.steps[2].validations.find((item) => item.kind === 'wait-response');
    assert.ok(response?.ok, JSON.stringify(task.steps[2].validations));
    assert.match(response.actual ?? '', /200/);
    assert.match(response.actual ?? '', /\/api\/slow/);

    const status = task.steps[2].validations.find((item) => item.kind === 'status-message');
    assert.equal(status?.ok, true);
  } finally {
    await runtime.shutdown();
  }
});

test('显式等待超时：spinner 不消失时给出等待目标、已等时长与页面状态', { timeout: 180000 }, async () => {
  const runtime = await createBrowserRuntime();
  try {
    const base = runtime.fixture.url;
    const task = await createAndWait(
      runtime,
      runtimePayload(runtime, [
        {
          action: 'goto',
          url: `${base}/components/waits-stuck`,
          expect: { type: 'text', text: '不会消失的 spinner', exact: false },
        },
        {
          action: 'waitForHidden',
          target: { role: 'progressbar', name: '加载中' },
          timeoutMs: 700,
        },
      ])
    );

    assert.equal(task.status, 'FAILED');
    assert.equal(task.steps[1].error?.code, 'WAIT_TIMEOUT');
    assert.match(task.steps[1].error?.message ?? '', /显式等待超时/);
    assert.match(task.steps[1].error?.message ?? '', /700/);
    assert.match(task.steps[1].error?.message ?? '', /url=/);
  } finally {
    await runtime.shutdown();
  }
});

test('显式等待超时：API 响应等待同样返回可读失败原因', { timeout: 180000 }, async () => {
  const runtime = await createBrowserRuntime();
  try {
    const base = runtime.fixture.url;
    const task = await createAndWait(
      runtime,
      runtimePayload(runtime, [
        {
          action: 'goto',
          url: `${base}/components/waits`,
          expect: { type: 'text', text: '显式等待', exact: false },
        },
        {
          action: 'waitForResponse',
          urlContains: '/api/never',
          timeoutMs: 700,
        },
      ])
    );

    assert.equal(task.status, 'FAILED');
    assert.equal(task.steps[1].error?.code, 'WAIT_TIMEOUT');
    assert.match(task.steps[1].error?.message ?? '', /\/api\/never/);
    assert.match(task.steps[1].error?.message ?? '', /最后页面状态/);
  } finally {
    await runtime.shutdown();
  }
});
