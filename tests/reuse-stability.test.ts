import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAndWait,
  createBrowserRuntime,
  sessionSetActions,
  type BrowserTaskBody,
} from './helpers/browser-runtime.js';

/**
 * 可复现的连续 / 并发稳定性验证：
 * - 连续 N 个任务命中同一 storageState 归档，逐轮校验「上一轮写入的 cookie」；
 * - 4 个不同租户并发执行，第一跳都必须看到干净上下文，归档互不覆盖。
 */

function textActual(task: BrowserTaskBody, stepIndex: number): string {
  const validation = task.steps[stepIndex]?.validations.find((item) => item.kind === 'text-visible');
  return validation?.actual ?? '';
}

function payload(tenantId: string, userId: string, base: string, actions: unknown[]) {
  return {
    taskType: 'actions.run',
    tenantId,
    userId,
    target: { system: 'fixture', url: base },
    input: { actions },
    executionMode: 'auto',
  };
}

/** previous 为 undefined 时要求干净上下文；否则要求复用上一任务写入的 cookie。 */
function sequenceActions(base: string, previous: string | undefined, next: string): unknown[] {
  return [
    {
      action: 'goto',
      url: `${base}/session`,
      expect: { type: 'text', text: `cookie值：${previous ?? '无'}`, exact: false },
      note: previous ? '复用上一任务归档' : '首次访问必须是干净上下文',
    },
    {
      action: 'goto',
      url: `${base}/session/set?name=tenant_cookie&value=${next}`,
      expect: { type: 'text', text: '已设置', exact: false },
    },
    {
      action: 'goto',
      url: `${base}/session`,
      expect: { type: 'text', text: `cookie值：${next}`, exact: false },
    },
  ];
}

test(
  '连续 10 个任务复用同一 storageState，每轮读回上一轮 cookie',
  { timeout: 300000 },
  async () => {
    const rounds = 10;
    const runtime = await createBrowserRuntime();
    try {
      const base = runtime.fixture.url;
      const refs = new Set<string>();
      let steps = 0;

      for (let index = 0; index < rounds; index += 1) {
        const previous = index === 0 ? undefined : `run-${index - 1}`;
        const current = `run-${index}`;
        const task = await createAndWait(
          runtime,
          payload('tenant-seq', 'u1', base, sequenceActions(base, previous, current))
        );

        assert.equal(task.status, 'COMPLETED', JSON.stringify(task.steps));
        assert.match(textActual(task, 0), new RegExp(`cookie值：${previous ?? '无'}`));
        assert.match(textActual(task, 2), new RegExp(`cookie值：${current}`));
        assert.ok(task.sessionSummary?.cookieNames.includes('tenant_cookie'));
        assert.equal(task.sessionSummary?.policyViolations.length, 0);
        assert.ok(task.sessionSummary?.storageStateRef, '每轮都应归档 storageState');
        refs.add(task.sessionSummary.storageStateRef);
        steps += task.steps.length;
      }

      assert.equal(refs.size, 1, '连续任务必须命中同一个 storageState 归档');

      console.log(
        `reuse-stability: rounds=${rounds} steps=${steps} completed=${rounds} refs=${refs.size}`
      );
    } finally {
      await runtime.shutdown();
    }
  }
);

test(
  '4 个租户并发执行：首跳均为干净上下文，storageState 与 cookie 互不污染',
  { timeout: 300000 },
  async () => {
    const tenants = ['tenant-c1', 'tenant-c2', 'tenant-c3', 'tenant-c4'];
    const runtime = await createBrowserRuntime();
    try {
      const base = runtime.fixture.url;
      const tasks = await Promise.all(
        tenants.map((tenantId, index) =>
          createAndWait(
            runtime,
            payload(tenantId, 'u1', base, sessionSetActions(base, `value-${index}`))
          )
        )
      );

      const refs = new Set<string>();
      tasks.forEach((task, index) => {
        assert.equal(task.status, 'COMPLETED', JSON.stringify(task.steps));
        assert.match(textActual(task, 0), /cookie值：无/);
        assert.match(textActual(task, 2), new RegExp(`cookie值：value-${index}`));
        assert.equal(task.sessionSummary?.policyViolations.length, 0);
        assert.ok(task.sessionSummary?.storageStateRef);
        refs.add(task.sessionSummary.storageStateRef);
      });

      assert.equal(refs.size, tenants.length, '不同租户必须各自归档');
      const steps = tasks.reduce((total, task) => total + task.steps.length, 0);

      console.log(
        `reuse-stability: concurrent=${tenants.length} steps=${steps} completed=${tasks.length} refs=${refs.size}`
      );
    } finally {
      await runtime.shutdown();
    }
  }
);
