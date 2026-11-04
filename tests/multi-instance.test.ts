import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Pool } from 'pg';

import { startFixtureServer, type FixtureServer } from '../src/fixtures/fixture-server.js';
import { Logger } from '../src/observability/logger.js';
import {
  PostgresConnection,
  PostgresTaskRepository,
} from '../src/persistence/postgres-repository.js';
import type { StepResult } from '../src/core/types.js';
import type { TaskRecord } from '../src/tasks/task-types.js';

/**
 * 多实例租约验证（一次性 schema + 真实 Postgres，不允许 skip 通过）。
 *
 * 1) 回归：非持有实例重启时，持有实例的 WAITING_APPROVAL 任务不得被改成 FAILED（且 DB 不产生任何写入）；
 * 2) DB 级原子认领：两个连接并发取同一任务，恰好一个成功；
 * 3) 租约过期后另一实例接管，原实例守卫写回 0 行 → LeaseLostError，最终状态一致；
 * 4) 心跳跨过一个租约周期仍不被抢；
 * 5) approve 打到非持有实例：返回 202 {approval:'queued'}，持有者消费通知后完成，最终状态唯一；
 * 6) 长跑回归在 tests/longrun-stability.test.ts（CI 缩短为 30 轮，见 docs/release-0.3.0.md）。
 *
 * 需要 BROWSER_AGENT_PG_DSN 且 BROWSER_AGENT_MULTI_INSTANCE=1。
 */

const instanceScript = 'apps/api/main.ts';
const repoRoot = process.cwd();
const silentLogger = new Logger({}, undefined, false);

interface Instance {
  name: string;
  port: number;
  ownerId: string;
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

async function waitForHealth(port: number, timeoutMs = 60000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '未开始';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        const body = (await response.json()) as { ownerId?: string };
        return body.ownerId ?? '(unknown-owner)';
      }
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
      BROWSER_TASK_LEASE_MS: '3000',
      BROWSER_TASK_HEARTBEAT_MS: '700',
      BROWSER_TASK_POLL_MS: '300',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const instance: Instance = { name, port, ownerId: '', child, logs: [] };
  const collect = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    instance.logs.push(text);
    if (instance.logs.length > 400) instance.logs.shift();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return instance;
}

async function startInstance(
  name: string,
  port: number,
  env: Record<string, string>
): Promise<Instance> {
  const instance = spawnInstance(name, port, env);
  instance.ownerId = await waitForHealth(port);
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

async function createTask(instance: Instance, body: Record<string, unknown>): Promise<string> {
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
    await sleep(150);
  }
  throw new Error(
    `实例 ${instance.name} 的任务 ${taskId} 未在超时内进入 ${statuses.join('/')}，最后=${last?.status}`
  );
}

function body(
  baseUrl: string,
  tenantId: string,
  actions: unknown[],
  executionMode: 'auto' | 'require_approval' = 'auto'
): Record<string, unknown> {
  return {
    taskType: 'actions.run',
    tenantId,
    userId: 'u1',
    target: { system: 'fixture', url: baseUrl },
    input: { actions },
    executionMode,
  };
}

interface DbTask {
  status: string;
  lease_owner: string | null;
  version: string | number;
  error: { code?: string } | null;
}

async function readDbTask(pool: Pool, schema: string, taskId: string): Promise<DbTask | undefined> {
  const row = await pool.query<DbTask>(
    `SELECT status, lease_owner, version, error FROM "${schema}".browser_task WHERE task_id = $1`,
    [taskId]
  );
  return row.rows[0];
}

async function waitForDbStatus(
  pool: Pool,
  schema: string,
  taskId: string,
  statuses: string[],
  timeoutMs = 60000
): Promise<DbTask> {
  const deadline = Date.now() + timeoutMs;
  let last: DbTask | undefined;
  while (Date.now() < deadline) {
    last = await readDbTask(pool, schema, taskId);
    if (last && statuses.includes(last.status)) return last;
    await sleep(120);
  }
  throw new Error(`任务 ${taskId} 未在超时内进入 ${statuses.join('/')}，最后=${last?.status}`);
}

async function dbStepStats(
  pool: Pool,
  schema: string,
  taskId: string
): Promise<{ rows: number; distinct: number }> {
  const row = await pool.query<{ rows: number; distinct: number }>(
    `SELECT count(*)::int AS rows, count(DISTINCT step_index)::int AS distinct
       FROM "${schema}".browser_task_step WHERE task_id = $1`,
    [taskId]
  );
  return row.rows[0] ?? { rows: 0, distinct: 0 };
}

function newRepoTask(taskId: string, tenantId: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    taskId,
    taskType: 'actions.run',
    tenantId,
    userId: 'u1',
    target: { system: 'fixture', url: 'http://127.0.0.1:4310' },
    input: { actions: [] },
    executionMode: 'auto',
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    steps: [],
    policyViolations: [],
    approvals: [],
    cancelRequested: false,
  };
}

function completedStep(index: number): StepResult {
  return {
    index,
    action: 'goto',
    description: `测试步骤 ${index}`,
    status: 'success',
    startedAt: new Date().toISOString(),
    durationMs: 1,
    validations: [{ ok: true, kind: 'repo-check', expected: 'ok', actual: 'ok' }],
  };
}

test(
  '多实例租约：原子认领 / 过期接管 / 心跳 / 重启不误杀 / 跨实例审批',
  { timeout: 900000 },
  async (t) => {
    if (process.env.BROWSER_AGENT_MULTI_INSTANCE !== '1') {
      t.skip('未设置 BROWSER_AGENT_MULTI_INSTANCE=1，跳过多实例租约测试');
      return;
    }

    const dsn = process.env.BROWSER_AGENT_PG_DSN;
    if (!dsn) {
      t.skip('未设置 BROWSER_AGENT_PG_DSN，多实例租约测试需要共享 Postgres');
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
    const connections: PostgresConnection[] = [];
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

      // ---------- 2) DB 级原子认领：两个独立连接并发，恰好一个成功 ----------
      const repoAConnection = new PostgresConnection(schemaDsn.toString());
      const repoBConnection = new PostgresConnection(schemaDsn.toString());
      connections.push(repoAConnection, repoBConnection);
      const repoA = new PostgresTaskRepository(repoAConnection, silentLogger);
      const repoB = new PostgresTaskRepository(repoBConnection, silentLogger);
      await repoA.init();
      await repoB.init();

      const claimTaskId = `task-claim-${Date.now()}`;
      await repoA.save(newRepoTask(claimTaskId, 'mi-claim'));
      const [claimA, claimB] = await Promise.all([
        repoA.claimNext('owner-A', 30000),
        repoB.claimNext('owner-B', 30000),
      ]);
      const winners = [claimA, claimB].filter((item): item is TaskRecord => Boolean(item));
      assert.equal(winners.length, 1, '并发认领必须恰好一个成功');
      const claimRow = await readDbTask(admin, schema, claimTaskId);
      assert.equal(claimRow?.status, 'RUNNING');
      assert.equal(claimRow?.lease_owner, winners[0].leaseOwner);
      assert.equal(claimA?.leaseOwner ?? claimB?.leaseOwner, claimRow?.lease_owner);
      evidence.atomicClaim = {
        winners: winners.length,
        winnerOwner: claimRow?.lease_owner,
        version: Number(claimRow?.version),
      };

      // 清理：认领成功者直接完成，避免干扰后续用例。
      const claimOwner = claimRow?.lease_owner ?? '';
      const claimRepo = claimOwner === 'owner-A' ? repoA : repoB;
      await claimRepo.saveLeased(
        { ...winners[0], status: 'COMPLETED', steps: [completedStep(1)] },
        claimOwner,
        30000
      );

      // ---------- 3) 租约过期 → 另一实例接管；原实例写回被拒（0 行） ----------
      const takeoverTaskId = `task-takeover-${Date.now()}`;
      await repoA.save(newRepoTask(takeoverTaskId, 'mi-takeover'));
      const ownedByA = await repoA.claimNext('owner-A', 60000);
      assert.ok(ownedByA, 'A 应认领成功');

      await admin.query(
        `UPDATE "${schema}".browser_task
            SET lease_expires_at = now() - interval '1 second'
          WHERE task_id = $1`,
        [takeoverTaskId]
      );

      const ownedByB = await repoB.claimNext('owner-B', 60000);
      assert.ok(ownedByB, '租约过期后 B 应能接管');
      assert.equal((await readDbTask(admin, schema, takeoverTaskId))?.lease_owner, 'owner-B');

      await assert.rejects(
        repoA.saveLeased(
          { ...ownedByA, status: 'COMPLETED', steps: [completedStep(1)] },
          'owner-A',
          60000
        ),
        (error: unknown) => (error as { code?: string }).code === 'LEASE_LOST',
        '原实例写回必须命中 0 行并抛 LEASE_LOST'
      );

      await repoB.saveLeased(
        { ...ownedByB, status: 'COMPLETED', steps: [completedStep(1), completedStep(2)] },
        'owner-B',
        60000
      );
      const takeoverRow = await readDbTask(admin, schema, takeoverTaskId);
      const takeoverSteps = await dbStepStats(admin, schema, takeoverTaskId);
      assert.equal(takeoverRow?.status, 'COMPLETED', '最终状态必须是接管者的 COMPLETED');
      assert.equal(takeoverRow?.lease_owner, 'owner-B');
      assert.equal(takeoverSteps.distinct, 2, '不得出现重复步骤');
      assert.equal(takeoverSteps.rows, 2);
      evidence.takeover = {
        finalStatus: takeoverRow?.status,
        owner: takeoverRow?.lease_owner,
        steps: takeoverSteps,
        staleWriteRejected: true,
      };

      // ---------- 4) 心跳跨过一个租约周期仍不被抢 ----------
      const heartbeatTaskId = `task-heartbeat-${Date.now()}`;
      await repoA.save(newRepoTask(heartbeatTaskId, 'mi-heartbeat'));
      const leaseMs = 600;
      const claimed = await repoA.claimNext('owner-A', leaseMs);
      assert.ok(claimed, 'A 应认领成功');

      const heartbeatStart = Date.now();
      let beats = 0;
      for (let index = 0; index < 10; index += 1) {
        await sleep(200);
        assert.equal(
          await repoA.heartbeat(heartbeatTaskId, 'owner-A', leaseMs),
          true,
          `第 ${index + 1} 次心跳应成功续租`
        );
        beats += 1;
        assert.equal(
          await repoB.claimNext('owner-B', leaseMs),
          undefined,
          '心跳存活期间 B 不得抢走任务'
        );
      }
      const elapsed = Date.now() - heartbeatStart;
      assert.ok(elapsed > leaseMs, `心跳时长 ${elapsed}ms 必须超过一个租约周期 ${leaseMs}ms`);
      const heartbeatRow = await readDbTask(admin, schema, heartbeatTaskId);
      assert.equal(heartbeatRow?.lease_owner, 'owner-A', '续租后持有者仍是 A');
      evidence.heartbeat = { leaseMs, beats, elapsedMs: elapsed, owner: heartbeatRow?.lease_owner };

      await repoA.saveLeased(
        { ...claimed, status: 'COMPLETED', steps: [completedStep(1)] },
        'owner-A',
        leaseMs
      );

      // ---------- 1) + 5) 进程级：非持有实例重启不误杀 WAITING；approve 跨实例唤醒 ----------
      fixture = await startFixtureServer(0);
      const baseUrl = fixture.url;
      const portA = await freePort();
      const instanceA = await startInstance('A', portA, instanceEnv('A'));
      running.push(instanceA);

      const approvalTask = await createTask(
        instanceA,
        body(
          baseUrl,
          `mi-approval-${Date.now()}`,
          [
            {
              action: 'goto',
              url: `${baseUrl}/approval-demo`,
              expect: { type: 'text', text: '审批恢复演示', exact: false },
            },
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
      const beforeRestart = await waitForDbStatus(admin, schema, approvalTask, ['WAITING_APPROVAL']);
      assert.equal(beforeRestart.lease_owner, instanceA.ownerId, 'A 应持有该任务');
      const versionBeforeRestart = Number(beforeRestart.version);

      // 先启动 B（非持有实例）再重启它，模拟「B 重启时 A 有 WAITING_APPROVAL」。
      const portB = await freePort();
      const instanceB = await startInstance('B', portB, instanceEnv('B'));
      running.push(instanceB);
      await stopInstance(instanceB);
      const instanceB2 = await startInstance('B2', portB, instanceEnv('B2'));
      running.push(instanceB2);

      await sleep(2500);
      const afterRestart = await readDbTask(admin, schema, approvalTask);
      assert.equal(afterRestart?.status, 'WAITING_APPROVAL', 'B2 重启不得把 A 的 WAITING 任务改成 FAILED');
      assert.equal(afterRestart?.error, null, 'B2 重启不得写入 WORKER_RESTARTED');
      assert.equal(Number(afterRestart?.version), versionBeforeRestart, 'B2 启动不应产生任何写回（版本不变）');
      assert.equal(afterRestart?.lease_owner, instanceA.ownerId);
      const stillWaiting = await getTask(instanceA, approvalTask);
      assert.equal(stillWaiting?.status, 'WAITING_APPROVAL', 'A 的本地状态不受影响');
      evidence.restartSafety = {
        statusAfterRestart: afterRestart?.status,
        errorAfterRestart: afterRestart?.error,
        versionBeforeRestart,
        versionAfterRestart: Number(afterRestart?.version),
        restartedInstance: instanceB2.ownerId,
        ownerInstance: instanceA.ownerId,
      };

      const approveOnB = await fetch(api(instanceB2, `/tasks/${approvalTask}/approve`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'mi-reviewer' }),
      });
      assert.equal(approveOnB.status, 202, `非持有实例 approve 应返回 202，实际 ${approveOnB.status}`);
      const approveBody = (await approveOnB.json()) as {
        approval?: string;
        owner?: string;
        status?: string;
      };
      assert.equal(approveBody.approval, 'queued');
      assert.equal(approveBody.owner, instanceA.ownerId, '202 响应必须返回真实持有者');

      const completed = await waitForDbStatus(admin, schema, approvalTask, ['COMPLETED'], 90000);
      assert.equal(completed.status, 'COMPLETED');
      assert.equal(completed.lease_owner, instanceA.ownerId, '完成后仍记录持有者，便于审计');
      const finalTask = await waitForTask(instanceA, approvalTask, ['COMPLETED']);
      assert.equal(finalTask.status, 'COMPLETED');
      const stepStats = await dbStepStats(admin, schema, approvalTask);
      assert.equal(stepStats.distinct, 3, '应恰好 3 个唯一步骤（审批步骤不重复）');
      assert.equal(stepStats.rows, 3);
      const approvalRows = await admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "${schema}".browser_approval WHERE task_id = $1`,
        [approvalTask]
      );
      assert.equal(approvalRows.rows[0]?.count, 1, '审批记录只应有一条，且不被重复覆盖');

      const secondApprove = await fetch(api(instanceB2, `/tasks/${approvalTask}/approve`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'mi-reviewer' }),
      });
      assert.equal(secondApprove.status, 409, '任务已是终态，重复审批必须被拒绝');
      const secondBody = (await secondApprove.json()) as { error?: { code?: string } };
      assert.equal(secondBody.error?.code, 'INVALID_TASK_TRANSITION');

      evidence.crossInstanceApproval = {
        approveOnNonOwner: approveOnB.status,
        approveBody,
        finalStatus: completed.status,
        finalOwner: completed.lease_owner,
        steps: stepStats,
        approvals: approvalRows.rows[0]?.count,
        duplicateApprove: secondApprove.status,
      };

      // 顺带验证跨实例读：B 能读到 A 持有并完成的任务（从 DB 装载）。
      const viewOnB = await getTask(instanceB2, approvalTask);
      assert.equal(viewOnB?.status, 'COMPLETED');

      console.log(`multi-instance-evidence: ${JSON.stringify(evidence)}`);
    } finally {
      for (const instance of running) await stopInstance(instance).catch(() => undefined);
      if (fixture) await fixture.close().catch(() => undefined);
      for (const connection of connections) await connection.close().catch(() => undefined);

      let counts: Record<string, number> = {};
      if (await admin.query('SELECT 1').then(() => true).catch(() => false)) {
        for (const table of [
          'browser_task',
          'browser_task_step',
          'browser_approval',
          'browser_session_state',
          'browser_task_notification',
        ]) {
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
