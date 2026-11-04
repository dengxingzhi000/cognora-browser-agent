import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Pool } from 'pg';

import { startFixtureServer, type FixtureServer } from '../src/fixtures/fixture-server.js';

/**
 * 多实例归属实验：2 个独立进程共享同一个 Postgres（同 browser_task 表）。
 *
 * 当前架构只有进程内队列，没有行锁 / 租约 / 心跳，因此本用例固定「现状」而不是宣称支持：
 * 1. 任务只在创建它的进程内执行，另一实例不轮询、不重复执行（GET 404）；
 * 2. 同 key 跨实例共享同一个 storageState 归档，不同 key 不串；
 * 3. 任一实例启动时会把「整张表的非终态任务」标记为 FAILED(WORKER_RESTARTED)，
 *    因此重启一方会把另一方在跑的任务打失败；写回没有版本 / 租约校验，最后写入者覆盖；
 * 4. approve 只路由到收到 HTTP 请求的实例，另一实例返回 404。
 *
 * 需要 BROWSER_AGENT_PG_DSN 且 BROWSER_AGENT_MULTI_INSTANCE=1 才执行。
 */

const instanceScript = 'apps/api/main.ts';
const repoRoot = process.cwd();

interface Instance {
  name: string;
  port: number;
  child: ChildProcess;
  logs: string[];
}

interface TaskView {
  taskId: string;
  status: string;
  steps: Array<{ index: number; action: string; status: string }>;
  error?: { code?: string };
  sessionSummary?: { storageStateRef?: string; policyViolations: string[] };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('无法获取空闲端口')));
      }
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '未开始';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await sleep(300);
  }
  throw new Error(`实例端口 ${port} 未在 ${timeoutMs}ms 内就绪：${lastError}`);
}

function spawnInstance(
  name: string,
  port: number,
  env: Record<string, string>
): Instance {
  const child = spawn(process.execPath, ['--import', 'tsx', instanceScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BROWSER_API_HOST: '127.0.0.1',
      BROWSER_API_PORT: String(port),
      BROWSER_STORAGE_DRIVER: 'postgres',
      BROWSER_ALLOWED_HOSTS: '127.0.0.1',
      BROWSER_HEADLESS: 'true',
      BROWSER_WORKER_CONCURRENCY: '2',
      BROWSER_ACTION_TIMEOUT_MS: '8000',
      BROWSER_EXPECT_TIMEOUT_MS: '5000',
      BROWSER_LOG_TO_FILE: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const instance: Instance = { name, port, child, logs: [] };
  const collect = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    instance.logs.push(text);
    if (instance.logs.length > 400) instance.logs.shift();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return instance;
}

async function stopInstance(instance: Instance): Promise<void> {
  if (instance.child.exitCode !== null || instance.child.killed) return;
  const exited = new Promise<void>((resolve) => instance.child.once('exit', () => resolve()));
  instance.child.kill('SIGINT');
  await Promise.race([exited, sleep(8000)]);
  if (instance.child.exitCode === null) {
    if (process.platform === 'win32' && instance.child.pid) {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(instance.child.pid), '/T', '/F'], () => resolve());
      });
    } else {
      instance.child.kill('SIGKILL');
    }
    await Promise.race([exited, sleep(5000)]);
  }
}

function api(instance: Instance, suffix: string): string {
  return `http://127.0.0.1:${instance.port}/api/v1/browser${suffix}`;
}

async function createTask(
  instance: Instance,
  body: Record<string, unknown>
): Promise<string> {
  const response = await fetch(api(instance, '/tasks'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== 201) {
    throw new Error(`实例 ${instance.name} 创建任务失败：${response.status} ${text}`);
  }
  return (JSON.parse(text) as { taskId: string }).taskId;
}

async function getTask(instance: Instance, taskId: string): Promise<TaskView | undefined> {
  const response = await fetch(api(instance, `/tasks/${taskId}`));
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`查询任务失败：${response.status}`);
  return (await response.json()) as TaskView;
}

async function waitForTask(
  instance: Instance,
  taskId: string,
  statuses: string[],
  timeoutMs = 60000
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskView | undefined;
  while (Date.now() < deadline) {
    last = await getTask(instance, taskId);
    if (last && statuses.includes(last.status)) return last;
    await sleep(100);
  }
  throw new Error(
    `实例 ${instance.name} 的任务 ${taskId} 未在超时内进入 ${statuses.join('/')}，最后=${last?.status}`
  );
}

function sequence(baseUrl: string, previous: string | undefined, next: string): unknown[] {
  return [
    {
      action: 'goto',
      url: `${baseUrl}/session`,
      expect: { type: 'text', text: `cookie值：${previous ?? '无'}`, exact: false },
    },
    {
      action: 'goto',
      url: `${baseUrl}/session/set?name=tenant_cookie&value=${next}`,
      expect: { type: 'text', text: '已设置', exact: false },
    },
    {
      action: 'goto',
      url: `${baseUrl}/session`,
      expect: { type: 'text', text: `cookie值：${next}`, exact: false },
    },
  ];
}

function body(
  baseUrl: string,
  tenantId: string,
  userId: string,
  actions: unknown[],
  executionMode: 'auto' | 'require_approval' = 'auto'
): Record<string, unknown> {
  return {
    taskType: 'actions.run',
    tenantId,
    userId,
    target: { system: 'fixture', url: baseUrl },
    input: { actions },
    executionMode,
  };
}

async function dbStatus(
  pool: Pool,
  schema: string,
  taskId: string,
  timeoutMs = 10000
): Promise<{ status: string; errorCode?: string } | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await pool.query<{ status: string; error: { code?: string } | null }>(
      `SELECT status, error FROM "${schema}".browser_task WHERE task_id = $1`,
      [taskId]
    );
    if (row.rowCount === 0) return undefined;
    const current = row.rows[0];
    if (current.status === 'COMPLETED' || current.status === 'FAILED' || current.status === 'CANCELLED') {
      return { status: current.status, ...(current.error?.code ? { errorCode: current.error.code } : {}) };
    }
    await sleep(100);
  }
  const row = await pool.query<{ status: string; error: { code?: string } | null }>(
    `SELECT status, error FROM "${schema}".browser_task WHERE task_id = $1`,
    [taskId]
  );
  if (row.rowCount === 0) return undefined;
  return { status: row.rows[0].status, ...(row.rows[0].error?.code ? { errorCode: row.rows[0].error.code } : {}) };
}

async function dbCount(
  pool: Pool,
  schema: string,
  taskId: string
): Promise<number> {
  const row = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM "${schema}".browser_task_step WHERE task_id = $1`,
    [taskId]
  );
  return row.rows[0]?.count ?? 0;
}

test(
  '多实例归属：2 进程共享 Postgres（重复执行 / storageState / 重启归属）',
  { timeout: 900000 },
  async (t) => {
    if (process.env.BROWSER_AGENT_MULTI_INSTANCE !== '1') {
      t.skip('未设置 BROWSER_AGENT_MULTI_INSTANCE=1，跳过多实例实验');
      return;
    }

    const dsn = process.env.BROWSER_AGENT_PG_DSN;
    if (!dsn) {
      t.skip('未设置 BROWSER_AGENT_PG_DSN，多实例实验需要共享 Postgres');
      return;
    }

    const schema = `mi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const schemaDsn = new URL(dsn);
    schemaDsn.searchParams.set('options', `-c search_path="${schema}"`);
    const admin = new Pool({ connectionString: dsn, max: 2, application_name: 'browser-agent-mi-admin' });

    const schemaSql = fs.readFileSync(
      new URL('../scripts/db/schema.sql', import.meta.url),
      'utf8'
    );

    let fixture: FixtureServer | undefined;
    const running: Instance[] = [];
    const evidence: Record<string, unknown> = {};

    fs.mkdirSync(path.join(repoRoot, 'artifacts'), { recursive: true });
    const artifactsRoot = fs.mkdtempSync(path.join(repoRoot, 'artifacts', 'mi-'));
    const instanceEnv = (name: string): Record<string, string> => ({
      BROWSER_AGENT_PG_DSN: schemaDsn.toString(),
      BROWSER_ARTIFACTS_DIR: path.join(artifactsRoot, name),
      BROWSER_PERSISTENCE_DIR: path.join(artifactsRoot, name, 'persistence'),
    });

    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const setup = await admin.connect();
      try {
        await setup.query(`SET search_path TO "${schema}"`);
        await setup.query(schemaSql);
      } finally {
        setup.release();
      }

      fixture = await startFixtureServer(0);
      const baseUrl = fixture.url;

      const portA = await freePort();
      const portB = await freePort();
      const instanceA = spawnInstance('A', portA, instanceEnv('A'));
      const instanceB = spawnInstance('B', portB, instanceEnv('B'));
      running.push(instanceA, instanceB);
      await Promise.all([waitForHealth(portA), waitForHealth(portB)]);

      // 1) 同 key 跨实例复用；不同 key 各自独立
      const sharedTenant = `mi-shared-${Date.now()}`;
      const taskA1 = await createTask(instanceA, body(baseUrl, sharedTenant, 'u1', sequence(baseUrl, undefined, 'from-a')));
      const doneA1 = await waitForTask(instanceA, taskA1, ['COMPLETED']);
      const taskB1 = await createTask(instanceB, body(baseUrl, sharedTenant, 'u1', sequence(baseUrl, 'from-a', 'from-b')));
      const doneB1 = await waitForTask(instanceB, taskB1, ['COMPLETED']);
      const taskA2 = await createTask(instanceA, body(baseUrl, sharedTenant, 'u1', sequence(baseUrl, 'from-b', 'from-a2')));
      const doneA2 = await waitForTask(instanceA, taskA2, ['COMPLETED']);
      const otherTenant = `mi-other-${Date.now()}`;
      const taskB2 = await createTask(instanceB, body(baseUrl, otherTenant, 'u1', sequence(baseUrl, undefined, 'other')));
      const doneB2 = await waitForTask(instanceB, taskB2, ['COMPLETED']);

      const sharedRefs = new Set(
        [doneA1, doneB1, doneA2].map((task) => task.sessionSummary?.storageStateRef)
      );
      assert.equal(sharedRefs.size, 1, '同 key 的跨实例任务必须命中同一个归档引用');
      assert.equal(doneB2.sessionSummary?.storageStateRef, `pg:${otherTenant}/u1/actions.run`);
      assert.notEqual(doneB2.sessionSummary?.storageStateRef, doneA1.sessionSummary?.storageStateRef);
      evidence.sameKeyRef = [...sharedRefs][0];
      evidence.otherKeyRef = doneB2.sessionSummary?.storageStateRef;

      // 2) 重复执行：任务只在创建它的实例内执行，另一实例不认识该任务
      const rapidIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        // 用不同 tenant 避免同 key 并发归档「最后写入者覆盖」这一已知限制干扰本实验。
        rapidIds.push(
          await createTask(
            instanceA,
            body(baseUrl, `mi-rapid-${index}-${Date.now()}`, 'u1', sequence(baseUrl, undefined, `rapid-${index}`))
          )
        );
      }
      const rapid = await Promise.all(
        rapidIds.map((taskId) => waitForTask(instanceA, taskId, ['COMPLETED']))
      );
      const notVisibleInB: string[] = [];
      for (const taskId of rapidIds) {
        if (!(await getTask(instanceB, taskId))) notVisibleInB.push(taskId);
        assert.equal(await dbCount(admin, schema, taskId), 3, `任务 ${taskId} 应只有一组 3 条步骤`);
      }
      assert.equal(notVisibleInB.length, rapidIds.length, '实例 B 不应看到实例 A 后创建的任务');
      evidence.rapidTaskIds = rapidIds;
      evidence.rapidCompleted = rapid.filter((task) => task.status === 'COMPLETED').length;
      evidence.rapidUnseenByB = notVisibleInB.length;

      // 3) 重启 B：B 启动时把 A 在审批等待的任务整行改成 FAILED(WORKER_RESTARTED)
      const approvalTask = await createTask(
        instanceA,
        body(
          baseUrl,
          sharedTenant,
          'u1',
          [
            { action: 'goto', url: `${baseUrl}/approval-demo`, expect: { type: 'text', text: '审批恢复演示', exact: false } },
            {
              action: 'click',
              target: { role: 'button', name: '保存草稿' },
              waitFor: { type: 'response', urlContains: '/api/counter', method: 'POST', statusBelow: 400 },
              expect: { type: 'status', text: '已保存草稿' },
            },
            { action: 'click', target: { role: 'button', name: '提交审核' }, expect: { type: 'status', text: '已提交审核' } },
          ],
          'require_approval'
        )
      );
      const waiting = await waitForTask(instanceA, approvalTask, ['WAITING_APPROVAL']);
      assert.equal(waiting.status, 'WAITING_APPROVAL');
      await sleep(500);
      const waitingInDb = await dbStatus(admin, schema, approvalTask);
      assert.equal(waitingInDb?.status, 'WAITING_APPROVAL');

      await stopInstance(instanceB);
      const instanceB2 = spawnInstance('B2', portB, instanceEnv('B2'));
      running.push(instanceB2);
      await waitForHealth(portB);

      const afterBRestart = await dbStatus(admin, schema, approvalTask);
      assert.equal(afterBRestart?.status, 'FAILED', 'B2 启动应把整表非终态任务标记为失败');
      assert.equal(afterBRestart?.errorCode, 'WORKER_RESTARTED');
      const stillWaitingInA = await getTask(instanceA, approvalTask);
      assert.equal(stillWaitingInA?.status, 'WAITING_APPROVAL', 'A 的内存状态不会因 B 重启而改变');

      const approveOnB = await fetch(api(instanceB2, `/tasks/${approvalTask}/approve`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'mi-reviewer' }),
      });
      const approveOnBBody = (await approveOnB.json()) as { error?: { code?: string } };
      assert.equal(approveOnB.status, 409, 'B2 只把该任务当成 FAILED，无法执行审批');
      assert.equal(approveOnBBody.error?.code, 'INVALID_TASK_TRANSITION');

      const approveOnA = await fetch(api(instanceA, `/tasks/${approvalTask}/approve`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'mi-reviewer' }),
      });
      assert.equal(approveOnA.status, 200, await approveOnA.text());
      await waitForTask(instanceA, approvalTask, ['COMPLETED']);
      const afterApprove = await dbStatus(admin, schema, approvalTask);
      assert.equal(afterApprove?.status, 'COMPLETED', 'A 的写入会覆盖 B 启动时写入的 FAILED（最后写入者胜）');

      evidence.crossInstanceStartup = {
        dbAfterBRestart: afterBRestart,
        inMemoryStill: stillWaitingInA?.status,
        approveOnB: approveOnB.status,
        finalDb: afterApprove,
      };

      // 4) 重启 A：未完成任务只被标记 FAILED，不会双跑
      const restartTask = await createTask(
        instanceA,
        body(
          baseUrl,
          sharedTenant,
          'u1',
          [
            { action: 'goto', url: `${baseUrl}/approval-demo`, expect: { type: 'text', text: '审批恢复演示', exact: false } },
            {
              action: 'click',
              target: { role: 'button', name: '保存草稿' },
              waitFor: { type: 'response', urlContains: '/api/counter', method: 'POST', statusBelow: 400 },
              expect: { type: 'status', text: '已保存草稿' },
            },
            { action: 'click', target: { role: 'button', name: '提交审核' }, expect: { type: 'status', text: '已提交审核' } },
          ],
          'require_approval'
        )
      );
      await waitForTask(instanceA, restartTask, ['WAITING_APPROVAL']);
      await sleep(500);
      const stepsBeforeRestart = await dbCount(admin, schema, restartTask);
      await stopInstance(instanceA);

      const instanceA2 = spawnInstance('A2', portA, instanceEnv('A2'));
      running.push(instanceA2);
      await waitForHealth(portA);

      const afterARestart = await dbStatus(admin, schema, restartTask);
      assert.equal(afterARestart?.status, 'FAILED');
      assert.equal(afterARestart?.errorCode, 'WORKER_RESTARTED');
      await sleep(3000);
      const stillFailed = await dbStatus(admin, schema, restartTask);
      assert.equal(stillFailed?.status, 'FAILED', '重启后不得自动续跑未完成任务');
      assert.equal(await dbCount(admin, schema, restartTask), stepsBeforeRestart, '重启后不得产生重复步骤');

      evidence.restartOwnInstance = {
        stepsBeforeRestart,
        stepsAfterRestart: await dbCount(admin, schema, restartTask),
        dbStatus: stillFailed,
      };

      const recoveredLog = instanceA2.logs.join('');
      assert.ok(
        recoveredLog.includes('storage.recovered_inflight_task'),
        '重启实例应记录 recovered_inflight_task 日志'
      );

      console.log(`multi-instance-evidence: ${JSON.stringify(evidence)}`);
    } finally {
      for (const instance of running) await stopInstance(instance).catch(() => undefined);
      if (fixture) await fixture.close().catch(() => undefined);

      let counts: Record<string, number> = {};
      if (await admin.query('SELECT 1').then(() => true).catch(() => false)) {
        for (const table of ['browser_task', 'browser_task_step', 'browser_approval', 'browser_session_state']) {
          const row = await admin.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM "${schema}".${table}`
          );
          counts[table] = row.rows[0]?.count ?? 0;
        }
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        const after = await admin.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM information_schema.schemata WHERE schema_name = $1`,
          [schema]
        );
        counts.afterDropSchemaExists = after.rows[0]?.count ?? 0;
      }
      await admin.end().catch(() => undefined);
      fs.rmSync(artifactsRoot, { recursive: true, force: true });

      console.log(
        `multi-instance-cleanup: rowsBeforeDrop=${JSON.stringify(counts)} schemaAfterDrop=${counts.afterDropSchemaExists ?? 'n/a'}`
      );
    }
  }
);
