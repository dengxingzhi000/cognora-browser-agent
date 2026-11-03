import assert from 'node:assert/strict';
import test from 'node:test';

import { startFixtureServer } from '../src/fixtures/fixture-server.js';

/**
 * CodeQL js/resource-exhaustion 指向 fixture 的 /api/slow 计时器。
 * 该端点只用于本地测试/CLI，且实现里已把 ms 夹紧到 0..5000；这里用超长输入锁定上限。
 */
test('fixture /api/slow 对超长 ms 硬限制在 5000ms', { timeout: 15000 }, async () => {
  const fixture = await startFixtureServer(0);
  try {
    const started = Date.now();
    const response = await fetch(`${fixture.url}/api/slow?ms=999999999`);
    const body = (await response.json()) as { ok: boolean; delayedMs: number };
    const elapsed = Date.now() - started;

    assert.equal(response.status, 200);
    assert.equal(body.delayedMs, 5000);
    assert.ok(elapsed >= 4900, `响应过早：elapsed=${elapsed}`);
    assert.ok(elapsed < 8000, `响应超出上限：elapsed=${elapsed}`);
  } finally {
    await fixture.close();
  }
});
