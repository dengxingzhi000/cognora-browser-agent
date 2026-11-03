import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Pool } from 'pg';

import { createAndWait, createBrowserRuntime, waitForTask } from './helpers/browser-runtime.js';

/**
 * 完整持久化链路验证，但使用 db_browser_agent 内的临时 schema 隔离：
 * - 不写 public 表，不触碰 db_agent / 业务库；
 * - schema 名只含小写字母 / 数字 / 下划线，由本测试生成；
 * - 结束后只 DROP 本次生成的 schema（带重试，等待连接回收）；
 * - 无 DSN / 连不上时 skip。
 */
function waitForDbStatus(
  pool: Pool,
  schema: string,
  taskId: string,
  expected: string,
  timeoutMs = 10000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'UNKNOWN';

  return (async () => {
    while (Date.now() < deadline) {
      const row = await pool.query<{ status: string }>(
        `SELECT status FROM "${schema}".browser_task WHERE task_id = $1`,
        [taskId]
      );
      if (row.rowCount === 0) {
        last = 'MISSING';
      } else {
        last = row.rows[0].status;
        if (last === expected) return last;
      }
      await sleep(100);
    }
    throw new Error(`任务 ${taskId} 未在 ${timeoutMs}ms 内以 ${expected} 落库，最后=${last}`);
  })();
}

test(
  'Postgres 完整链路：创建任务 → 落库 → 审批 → 断点恢复 → 步骤可查',
  { timeout: 240000 },
  async (t) => {
    const dsn = process.env.BROWSER_AGENT_PG_DSN;
    if (!dsn) {
      t.skip('未设置 BROWSER_AGENT_PG_DSN，跳过 Postgres 完整链路测试（离线测试使用文件回落）');
      return;
    }

    let baseUrl: URL;
    try {
      baseUrl = new URL(dsn);
    } catch {
      t.skip('BROWSER_AGENT_PG_DSN 不是合法 URL');
      return;
    }

    const database = decodeURIComponent(baseUrl.pathname.replace(/^\//, ''));
    if (database !== 'db_browser_agent') {
      throw new Error(`DSN 必须指向 db_browser_agent，当前为「${database}」`);
    }

    const admin = new Pool({
      connectionString: dsn,
      max: 1,
      application_name: 'browser-agent-it-admin',
    });

    try {
      await admin.query('SELECT 1');
    } catch (error) {
      await admin.end().catch(() => undefined);
      t.skip(`Postgres 不可用：${(error as Error).message}`);
      return;
    }

    const schema = `browser_agent_it_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let runtime: Awaited<ReturnType<typeof createBrowserRuntime>> | undefined;

    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const schemaDsn = new URL(dsn);
      schemaDsn.searchParams.set('options', `-c search_path="${schema}"`);

      runtime = await createBrowserRuntime({
        storageDriver: 'postgres',
        pgDsn: schemaDsn.toString(),
      });
      assert.equal(runtime.store.driver, 'postgres');
      assert.equal(runtime.persistence.driver, 'postgres');

      const tenantId = `db-it-${Date.now()}`;
      const userId = 'db-reviewer-user';
      const base = runtime.fixture.url;
      const payload = {
        taskType: 'actions.run',
        tenantId,
        userId,
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
      const taskId = waiting.taskId;

      // 写穿持久化是异步队列；外部消费者按最终一致读取，轮询确认落库状态。
      const persistedStatus = await waitForDbStatus(admin, schema, taskId, 'WAITING_APPROVAL');
      assert.equal(persistedStatus, 'WAITING_APPROVAL');

      const stepRows = await admin.query<{
        step_index: number;
        status: string;
        target: unknown;
        expected: unknown;
        actual: unknown;
        screenshot_path: string | null;
      }>(
        `SELECT step_index, status, target, expected, actual, screenshot_path
         FROM "${schema}".browser_task_step WHERE task_id = $1 ORDER BY step_index`,
        [taskId]
      );
      assert.equal(stepRows.rowCount, 3);
      assert.equal(stepRows.rows[2].status, 'blocked');
      assert.ok(stepRows.rows[2].target);
      assert.ok(stepRows.rows[2].expected);
      assert.ok(stepRows.rows[2].actual);
      assert.ok(stepRows.rows[2].screenshot_path);

      const approvalRows = await admin.query<{
        decision: string;
        step_index: number;
        approver: string | null;
      }>(
        `SELECT decision, step_index, approver
         FROM "${schema}".browser_approval WHERE task_id = $1`,
        [taskId]
      );
      assert.equal(approvalRows.rowCount, 1);
      assert.equal(approvalRows.rows[0].decision, 'pending');
      assert.equal(approvalRows.rows[0].step_index, 3);

      const approved = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/browser/tasks/${taskId}/approve`,
        payload: { actor: 'db-reviewer' },
      });
      assert.equal(approved.statusCode, 200, approved.body);

      const done = await waitForTask(runtime, taskId, { statuses: ['COMPLETED'] });
      assert.equal(done.status, 'COMPLETED');

      const finalStatus = await waitForDbStatus(admin, schema, taskId, 'COMPLETED');
      assert.equal(finalStatus, 'COMPLETED');

      const finalApproval = await admin.query<{ decision: string; approver: string | null }>(
        `SELECT decision, approver FROM "${schema}".browser_approval WHERE task_id = $1`,
        [taskId]
      );
      assert.equal(finalApproval.rows[0].decision, 'approved');
      assert.equal(finalApproval.rows[0].approver, 'db-reviewer');

      const finalSteps = await admin.query<{ step_index: number; status: string }>(
        `SELECT step_index, status FROM "${schema}".browser_task_step
         WHERE task_id = $1 ORDER BY step_index`,
        [taskId]
      );
      assert.equal(finalSteps.rowCount, 3);
      assert.equal(finalSteps.rows[2].status, 'success');

      const sessionRows = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "${schema}".browser_session_state
         WHERE tenant_id = $1 AND user_id = $2 AND task_type = $3`,
        [tenantId, userId, 'actions.run']
      );
      assert.equal(sessionRows.rows[0].count, '1');
    } finally {
      if (runtime) await runtime.shutdown().catch(() => undefined);

      let dropped = false;
      for (let attempt = 0; attempt < 5 && !dropped; attempt += 1) {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          dropped = true;
        } catch {
          await sleep(200);
        }
      }

      await admin.end().catch(() => undefined);
      if (!dropped) throw new Error(`临时 schema ${schema} 清理失败，请人工检查`);
    }
  }
);
