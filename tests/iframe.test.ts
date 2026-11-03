import assert from 'node:assert/strict';
import test from 'node:test';

import { createAndWait, createBrowserRuntime } from './helpers/browser-runtime.js';

test('iframe：frameLocator 作用域内的定位、点击与状态校验', { timeout: 180000 }, async () => {
  const runtime = await createBrowserRuntime();
  try {
    const base = runtime.fixture.url;

    const task = await createAndWait(runtime, {
      taskType: 'actions.run',
      tenantId: 'tenant-iframe',
      userId: 'u1',
      target: { system: 'fixture', url: base },
      executionMode: 'auto',
      input: {
        actions: [
          {
            action: 'goto',
            url: `${base}/components/iframe-host`,
            expect: { type: 'text', text: 'iframe 宿主页', exact: false },
          },
          {
            action: 'fill',
            target: { by: 'label', name: '收货人', frame: { name: 'checkout' } },
            value: '张三',
          },
          {
            action: 'click',
            target: { role: 'button', name: '保存收货人', frame: { title: '结算表单' } },
            expect: {
              type: 'status',
              text: '收货人已保存：张三',
              frame: { name: 'checkout' },
            },
          },
        ],
      },
    });

    assert.equal(task.status, 'COMPLETED', JSON.stringify(task.steps));
    assert.equal(task.steps.length, 3);
    assert.equal(task.steps[1].status, 'success');
    assert.equal(task.steps[1].validations[0].kind, 'value-readback');
    assert.equal(task.steps[1].validations[0].actual, '张三');
    assert.equal(task.steps[2].status, 'success');
    assert.equal(task.steps[2].validations[0].kind, 'status-message');
    assert.equal(task.steps[2].validations[0].ok, true);
  } finally {
    await runtime.shutdown();
  }
});
