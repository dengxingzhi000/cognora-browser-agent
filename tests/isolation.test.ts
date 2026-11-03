import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAndWait,
  createBrowserRuntime,
  sessionProbeActions,
  sessionSetActions,
  type BrowserTaskBody,
} from './helpers/browser-runtime.js';

function textActual(task: BrowserTaskBody, stepIndex: number): string {
  const validation = task.steps[stepIndex]?.validations.find((item) => item.kind === 'text-visible');
  return validation?.actual ?? '';
}

test(
  '会话隔离：不同租户并发任务 cookie 互不污染；同租户同用户复用归档，不同用户不复用',
  { timeout: 180000 },
  async () => {
    const runtime = await createBrowserRuntime();
    try {
      const base = runtime.fixture.url;

      const payload = (tenantId: string, userId: string, actions: unknown[]) => ({
        taskType: 'actions.run',
        tenantId,
        userId,
        target: { system: 'fixture', url: base },
        input: { actions },
        executionMode: 'auto',
      });

      // A / B 同时执行：不同租户，各自先访问 /session 都必须看到「无 cookie」。
      const [alphaTask, betaTask] = await Promise.all([
        createAndWait(runtime, payload('tenant-alpha', 'u1', sessionSetActions(base, 'alpha'))),
        createAndWait(runtime, payload('tenant-beta', 'u1', sessionSetActions(base, 'beta'))),
      ]);

      assert.equal(alphaTask.status, 'COMPLETED', JSON.stringify(alphaTask.steps));
      assert.equal(betaTask.status, 'COMPLETED', JSON.stringify(betaTask.steps));
      assert.match(textActual(alphaTask, 0), /cookie值：无/);
      assert.match(textActual(betaTask, 0), /cookie值：无/);
      assert.match(textActual(alphaTask, 2), /cookie值：alpha/);
      assert.match(textActual(betaTask, 2), /cookie值：beta/);

      assert.ok(alphaTask.sessionSummary?.cookieNames.includes('tenant_cookie'));
      assert.ok(betaTask.sessionSummary?.cookieNames.includes('tenant_cookie'));
      assert.notEqual(
        alphaTask.sessionSummary?.storageStateRef,
        betaTask.sessionSummary?.storageStateRef,
        '不同租户的 storageState 必须分开归档'
      );

      // C：同租户同用户，仅做探针；不重新设置 cookie，必须从 storageState 读到 alpha。
      const alphaReuse = await createAndWait(
        runtime,
        payload('tenant-alpha', 'u1', sessionProbeActions(base, 'alpha'))
      );
      assert.equal(alphaReuse.status, 'COMPLETED', JSON.stringify(alphaReuse.steps));
      assert.match(textActual(alphaReuse, 0), /cookie值：alpha/);
      assert.equal(
        alphaReuse.sessionSummary?.storageStateRef,
        alphaTask.sessionSummary?.storageStateRef,
        '同租户同用户应命中同一个归档文件'
      );

      // D：同租户不同用户，不能读到 u1 的 cookie。
      const alphaOtherUser = await createAndWait(
        runtime,
        payload('tenant-alpha', 'u2', sessionProbeActions(base, '无'))
      );
      assert.equal(alphaOtherUser.status, 'COMPLETED', JSON.stringify(alphaOtherUser.steps));
      assert.match(textActual(alphaOtherUser, 0), /cookie值：无/);
      assert.ok(
        !alphaOtherUser.sessionSummary?.storageStateRef ||
          alphaOtherUser.sessionSummary.storageStateRef !== alphaTask.sessionSummary?.storageStateRef
      );
      assert.ok(
        !alphaOtherUser.sessionSummary?.cookieNames.includes('tenant_cookie'),
        '不同用户不得继承 u1 的 cookie'
      );

      // 全程没有跨域请求，域名守卫计数应为 0。
      for (const task of [alphaTask, betaTask, alphaReuse, alphaOtherUser]) {
        assert.equal(task.sessionSummary?.policyViolations.length, 0);
      }
    } finally {
      await runtime.shutdown();
    }
  }
);
