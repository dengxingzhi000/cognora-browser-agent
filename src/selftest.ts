import assert from 'node:assert/strict';

import { isSensitiveActionName } from './security/approval.js';
import { DomainPolicy } from './security/domain-policy.js';
import { DomainNotAllowedError } from './core/errors.js';
import { sanitizeForFilename } from './observation/screenshot.js';
import { matchesSelectExpected } from './observation/state-validator.js';

/** 不需要浏览器的纯逻辑自检：域名策略、审批判定、select 回读规则、文件名清洗。 */

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
  (error: unknown) =>
    error instanceof DomainNotAllowedError && error.code === 'DOMAIN_NOT_ALLOWED'
);

assert.equal(isSensitiveActionName('提交发布'), true);
assert.equal(isSensitiveActionName('确认提交'), true);
assert.equal(isSensitiveActionName('Submit Order'), true);
assert.equal(isSensitiveActionName('提交审核'), true);
assert.equal(isSensitiveActionName('保存草稿'), false);
assert.equal(isSensitiveActionName('保存', true), true);

assert.equal(matchesSelectExpected('apple', 'apple', '苹果'), true);
assert.equal(matchesSelectExpected('苹果', 'apple', '苹果'), true);
assert.equal(matchesSelectExpected('apple ', 'apple', '苹果'), false);

assert.equal(sanitizeForFilename('提交/发布: 商品'), '提交-发布-商品');
assert.equal(sanitizeForFilename('click 保存草稿'), 'click-保存草稿');

console.log('selftest: 20 项纯逻辑断言全部通过');
