import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  createAndWait,
  createBrowserRuntime,
  waitForTask,
} from './helpers/browser-runtime.js';

test(
  '审批恢复：敏感动作停在 WAITING_APPROVAL，approve 后只执行断点步骤',
  { timeout: 180000 },
  async () => {
    const runtime = await createBrowserRuntime();
    try {
      const base = runtime.fixture.url;
      const payload = {
        taskType: 'actions.run',
        tenantId: 'tenant-approval',
        userId: 'u1',
        target: { system: 'fixture', url: base },
        executionMode: 'require_approval',
        input: {
          actions: [
            {
              action: 'goto',
              url: `${base}/approval-demo`,
              expect: { type: 'text', text: '审批恢复演示', exact: false },
            },
            {
              action: 'click',
              target: { role: 'button', name: '保存草稿' },
              waitFor: {
                type: 'response',
                urlContains: '/api/counter',
                method: 'POST',
                statusBelow: 400,
              },
              expect: { type: 'status', text: '已保存草稿' },
            },
            {
              action: 'click',
              target: { role: 'button', name: '提交审核' },
              expect: { type: 'status', text: '已提交审核' },
            },
          ],
        },
      };

      const waiting = await createAndWait(runtime, payload, {
        statuses: ['WAITING_APPROVAL'],
      });
      assert.equal(waiting.status, 'WAITING_APPROVAL');
      assert.equal(waiting.pendingApproval?.stepIndex, 3);
      assert.equal(waiting.steps.length, 3);
      assert.equal(waiting.steps[2].status, 'blocked');
      assert.equal(waiting.steps[2].error?.code, 'WAITING_APPROVAL');
      assert.equal(runtime.fixture.counter(), 1, '保存草稿只应执行一次');

      const approvalScreenshot = waiting.steps[2].screenshot;
      assert.ok(approvalScreenshot, '审批拦截必须落盘截图');
      assert.equal(fs.existsSync(approvalScreenshot), true, approvalScreenshot);

      const stepsBefore = waiting.steps.map((step) => step.startedAt);

      const approved = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/browser/tasks/${waiting.taskId}/approve`,
        payload: { actor: 'reviewer' },
      });
      assert.equal(approved.statusCode, 200, approved.body);

      const done = await waitForTask(runtime, waiting.taskId, { statuses: ['COMPLETED'] });
      assert.equal(done.status, 'COMPLETED');
      assert.equal(done.steps.length, 3, '断点续跑不应重复记录步骤');
      assert.equal(done.steps[2].status, 'success');
      assert.deepEqual(
        done.steps.slice(0, 2).map((step) => step.startedAt),
        stepsBefore.slice(0, 2),
        '前两步不能重跑（startedAt 必须保持不变）'
      );
      assert.equal(runtime.fixture.counter(), 1, '保存草稿不能因 approve 重跑');
      assert.equal(done.approvals.length, 1);
      assert.equal(done.approvals[0].decision?.decision, 'approved');
      assert.equal(done.approvals[0].decision?.actor, 'reviewer');

      const duplicate = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/browser/tasks/${waiting.taskId}/approve`,
        payload: {},
      });
      assert.equal(duplicate.statusCode, 409, duplicate.body);
      assert.equal(
        (duplicate.json() as { error: { code: string } }).error.code,
        'INVALID_TASK_TRANSITION'
      );

      const rejectAfterDone = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/browser/tasks/${waiting.taskId}/reject`,
        payload: {},
      });
      assert.equal(rejectAfterDone.statusCode, 409, rejectAfterDone.body);
    } finally {
      await runtime.shutdown();
    }
  }
);
