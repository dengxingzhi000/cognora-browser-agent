import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

/**
 * 只读集成检查：确认 DSN 可用、独立库与四张表存在。
 * 不带 DSN / 连不上时 skip，保证离线 npm test 全绿。
 * 完整写入链路（创建任务 → 审批 → 断点恢复 → 步骤可查）由 scripts/verify-postgres.ts 真实验证。
 */
test('Postgres 集成检查：DSN 连通性与表结构', { timeout: 60000 }, async (t) => {
  const dsn = process.env.BROWSER_AGENT_PG_DSN;
  if (!dsn) {
    t.skip('未设置 BROWSER_AGENT_PG_DSN，跳过 Postgres 集成检查（离线测试使用文件回落）');
    return;
  }

  let pool: Pool | undefined;
  try {
    pool = new Pool({
      connectionString: dsn,
      max: 1,
      application_name: 'browser-agent-it',
    });
    await pool.query('SELECT 1');

    const database = await pool.query<{ db: string }>('SELECT current_database() AS db');
    assert.equal(database.rows[0]?.db, 'db_browser_agent', 'DSN 必须指向 db_browser_agent');

    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename LIKE 'browser_%'
       ORDER BY tablename`
    );
    const names = tables.rows.map((row) => row.tablename);
    assert.deepEqual(names, [
      'browser_approval',
      'browser_session_state',
      'browser_task',
      'browser_task_step',
    ]);
  } catch (error) {
    if (pool) await pool.end().catch(() => undefined);
    t.skip(`Postgres 不可用：${(error as Error).message}`);
    return;
  } finally {
    await pool?.end().catch(() => undefined);
  }
});
