import assert from 'node:assert/strict';
import test from 'node:test';

import { createAndWait, createBrowserRuntime, type BrowserTaskBody } from './helpers/browser-runtime.js';

function customSelectSteps(baseUrl: string, pagePath: string, title: string, by: 'role' | 'text') {
  return [
    {
      action: 'goto',
      url: `${baseUrl}${pagePath}`,
      expect: { type: 'text', text: title, exact: false },
    },
    {
      action: 'selectCustom',
      target: { role: 'combobox', name: '商品分类' },
      option: { name: '数码', by },
      expect: { type: 'text', text: '已选择：数码', exact: false },
    },
  ];
}

function assertReadback(task: BrowserTaskBody, stepIndex: number): void {
  const step = task.steps[stepIndex];
  assert.equal(step.status, 'success');
  const readback = step.validations.find((item) => item.kind === 'custom-select-readback');
  assert.ok(readback, `缺少 custom-select-readback：${JSON.stringify(step.validations)}`);
  assert.equal(readback.ok, true);
  assert.match(readback.actual ?? '', /数码/);

  const status = step.validations.find((item) => item.kind === 'text-visible');
  assert.ok(status?.ok, `状态提示未校验通过：${JSON.stringify(step.validations)}`);
}

test('自定义下拉：Radix 与 AntD 两种 DOM 结构', { timeout: 180000 }, async () => {
  const runtime = await createBrowserRuntime();
  try {
    const base = runtime.fixture.url;
    const payload = (actions: unknown[]) => ({
      taskType: 'actions.run',
      tenantId: 'tenant-ui',
      userId: 'u1',
      target: { system: 'fixture', url: base },
      executionMode: 'auto',
      input: { actions },
    });

    const radix = await createAndWait(
      runtime,
      payload(customSelectSteps(base, '/components/custom-select-radix', 'Radix 风格自定义下拉', 'role'))
    );
    assert.equal(radix.status, 'COMPLETED', JSON.stringify(radix.steps));
    assertReadback(radix, 1);

    const antd = await createAndWait(
      runtime,
      payload(customSelectSteps(base, '/components/custom-select-antd', 'AntD 风格自定义下拉', 'text'))
    );
    assert.equal(antd.status, 'COMPLETED', JSON.stringify(antd.steps));
    assertReadback(antd, 1);
  } finally {
    await runtime.shutdown();
  }
});
