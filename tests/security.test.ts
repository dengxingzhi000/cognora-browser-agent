import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { ActionNotAllowedError, DomainNotAllowedError } from '../src/core/errors.js';
import {
  assertSafeDownloadName,
  assertUploadPathWithin,
  validateActionIntent,
  validatePlan,
} from '../src/security/action-policy.js';
import { DomainPolicy } from '../src/security/domain-policy.js';
import { createFakeRuntime, taskPayload } from './helpers/fake-runtime.js';

test('域名策略：精确 host、子域、非法协议与伪装后缀', () => {
  const policy = new DomainPolicy(['localhost', '127.0.0.1']);

  assert.equal(policy.isAllowed('http://localhost:3000/zh-CN/product/create'), true);
  assert.equal(policy.isAllowed('http://127.0.0.1:4310/product-form'), true);
  assert.equal(policy.isAllowed('http://app.localhost:3000/'), true);
  assert.equal(policy.isAllowed('https://example.com/'), false);
  assert.equal(policy.isAllowed('https://localhost.evil.com/'), false);
  assert.equal(policy.isAllowed('file:///C:/Windows/win.ini'), false);
  assert.equal(policy.isAllowed('javascript:alert(1)'), false);
  assert.equal(policy.isAllowed('not a url'), false);

  assert.throws(
    () => policy.assertAllowed('https://example.com/checkout', '测试导航'),
    (error: unknown) => error instanceof DomainNotAllowedError && error.code === 'DOMAIN_NOT_ALLOWED'
  );
});

test('结构化意图：拒绝脚本、evaluate、原始选择器与未知 role', () => {
  const injections: unknown[] = [
    { action: 'script', code: 'await page.click("#x")' },
    { action: 'evaluate', expression: 'document.cookie' },
    { action: 'click', target: { role: 'button', name: '提交' }, selector: '#submit' },
    { action: 'fill', target: { role: 'textbox', name: 'x' }, value: 'v', x: 12, y: 30 },
    { action: 'click', target: { role: 'css', name: '提交' } },
    { action: 'click', target: { by: 'label', name: '提交' }, script: 'alert(1)' },
  ];

  for (const intent of injections) {
    assert.throws(
      () => validateActionIntent(intent),
      (error: unknown) =>
        error instanceof ActionNotAllowedError && error.code === 'ACTION_NOT_ALLOWED',
      JSON.stringify(intent)
    );
  }
});

test('结构化意图：frame 引用只接受 name/title，拒绝引号注入', () => {
  assert.throws(
    () =>
      validateActionIntent({
        action: 'fill',
        target: { role: 'textbox', name: '收货人', frame: { name: 'x"]' } },
        value: '张三',
      }),
    (error: unknown) => error instanceof ActionNotAllowedError
  );

  const valid = validateActionIntent({
    action: 'fill',
    target: { role: 'textbox', name: '收货人', frame: { name: 'checkout' } },
    value: '张三',
  });
  assert.equal(valid.action, 'fill');
});

test('计划校验：外部 goto 在创建计划时即被域名策略拒绝', () => {
  const policy = new DomainPolicy(['localhost', '127.0.0.1']);
  assert.throws(
    () => validatePlan([{ action: 'goto', url: 'https://example.com/' }], policy),
    (error: unknown) => error instanceof DomainNotAllowedError
  );
});

test('文件路径策略：下载名禁止穿越、上传必须位于配置根目录', () => {
  assert.doesNotThrow(() => assertSafeDownloadName('report.csv'));
  assert.throws(() => assertSafeDownloadName('../evil.csv'), ActionNotAllowedError);
  assert.throws(() => assertSafeDownloadName('sub/report.csv'), ActionNotAllowedError);

  const root = path.resolve('upload-root');
  assert.match(assertUploadPathWithin(root, 'a.txt'), /a\.txt$/);
  assert.throws(
    () => assertUploadPathWithin(root, path.join('..', '..', 'Windows', 'win.ini')),
    ActionNotAllowedError
  );
});

test('API：注入脚本类动作在工作流构建阶段返回 403', async () => {
  const runtime = await createFakeRuntime();
  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/browser/tasks',
      payload: taskPayload({
        input: {
          actions: [{ action: 'script', code: 'await page.click("#submit")' }],
        },
      }),
    });

    assert.equal(response.statusCode, 403, response.body);
    const body = response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'ACTION_NOT_ALLOWED');
  } finally {
    await runtime.app.close();
    await runtime.service.shutdown();
  }
});

test('API：外部域名 goto 返回 403，不会创建任务', async () => {
  const runtime = await createFakeRuntime();
  try {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/browser/tasks',
      payload: taskPayload({
        input: {
          actions: [{ action: 'goto', url: 'https://example.com/' }],
        },
      }),
    });

    assert.equal(response.statusCode, 403, response.body);
    const body = response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'DOMAIN_NOT_ALLOWED');
    assert.equal(runtime.store.size(), 0, '被策略拒绝的请求不应落任务');
  } finally {
    await runtime.app.close();
    await runtime.service.shutdown();
  }
});
