import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import {
  createAndWait,
  createBrowserRuntime,
  type BrowserTaskBody,
} from './helpers/browser-runtime.js';

/**
 * 小时级长跑的可执行子集：同 key 连续任务，取「60 分钟 / 100 轮」先到者。
 * 每轮记录耗时、步骤数、storageState ref、进程 RSS、Browser/Context 数、Postgres 连接数；
 * 断言不泄漏（Context 归零、Browser 实例不增长、连接数不超过池上限、失败轮次为 0）。
 *
 * 默认不参与 npm test：设置 BROWSER_AGENT_LONGRUN=1 才执行，轮数用
 * BROWSER_AGENT_LONGRUN_ROUNDS 覆盖（默认 100）。
 */

interface RoundMetrics {
  round: number;
  durationMs: number;
  steps: number;
  refs: number;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  browsers: number;
  contexts: number;
  pgConnections: number | null;
}

function textActual(task: BrowserTaskBody, stepIndex: number): string {
  const validation = task.steps[stepIndex]?.validations.find((item) => item.kind === 'text-visible');
  return validation?.actual ?? '';
}

function sequenceActions(baseUrl: string, previous: string | undefined, next: string): unknown[] {
  return [
    {
      action: 'goto',
      url: `${baseUrl}/session`,
      expect: { type: 'text', text: `cookie值：${previous ?? '无'}`, exact: false },
      note: previous ? '复用上一任务归档' : '首次访问必须是干净上下文',
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

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

/** 最小二乘斜率（单位：字节/轮）。 */
function slopePerRound(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((total, value) => total + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (index - meanX) * (values[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function waitForContextsToClose(
  runtime: Awaited<ReturnType<typeof createBrowserRuntime>>,
  timeoutMs = 3000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let contexts = runtime.browser.stats().contexts;
  while (contexts > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    contexts = runtime.browser.stats().contexts;
  }
  return contexts;
}

test(
  '同 key 连续任务长跑：100 轮度量（RSS / 浏览器 / 连接池 / storageState 不泄漏）',
  { timeout: 3_600_000 },
  async (t) => {
    if (process.env.BROWSER_AGENT_LONGRUN !== '1') {
      t.skip('未设置 BROWSER_AGENT_LONGRUN=1，跳过长跑度量（默认 npm test 不跑小时级用例）');
      return;
    }

    const rounds = Number(process.env.BROWSER_AGENT_LONGRUN_ROUNDS ?? 100);
    const dsn = process.env.BROWSER_AGENT_PG_DSN;
    const tenantId = `longrun-${Date.now()}`;
    const userId = 'u1';

    const admin = dsn
      ? new Pool({
          connectionString: dsn,
          max: 1,
          application_name: 'browser-agent-metrics',
        })
      : undefined;

    const runtime = await createBrowserRuntime({
      storageDriver: dsn ? 'postgres' : 'file',
      ...(dsn ? { pgDsn: dsn } : {}),
    });

    if (admin) {
      await admin.query('SELECT 1');
      assert.equal(runtime.store.driver, 'postgres', '设置 DSN 时长跑必须真实落到 Postgres');
    }

    const metrics: RoundMetrics[] = [];
    let failures = 0;
    let stepTotal = 0;
    const refs = new Set<string>();
    let maxContexts = 0;
    let maxBrowsers = 0;
    let maxPgConnections = 0;
    let pgQueryErrors = 0;

    const startedAt = Date.now();

    try {
      const base = runtime.fixture.url;

      for (let round = 0; round < rounds; round += 1) {
        const previous = round === 0 ? undefined : `run-${round - 1}`;
        const current = `run-${round}`;
        const roundStartedAt = performance.now();
        const task = await createAndWait(
          runtime,
          {
            taskType: 'actions.run',
            tenantId,
            userId,
            target: { system: 'fixture', url: base },
            input: { actions: sequenceActions(base, previous, current) },
            executionMode: 'auto',
          },
          { timeoutMs: 120000 }
        );
        const durationMs = Math.round(performance.now() - roundStartedAt);

        if (task.status !== 'COMPLETED') failures += 1;
        assert.equal(task.status, 'COMPLETED', `第 ${round + 1} 轮失败：${JSON.stringify(task.error)}`);
        assert.equal(task.steps.length, 3, `第 ${round + 1} 轮步骤数异常`);
        assert.match(textActual(task, 0), new RegExp(`cookie值：${previous ?? '无'}`));
        assert.match(textActual(task, 2), new RegExp(`cookie值：${current}`));
        assert.equal(task.sessionSummary?.policyViolations.length, 0);
        assert.ok(task.sessionSummary?.storageStateRef, `第 ${round + 1} 轮缺少 storageStateRef`);
        refs.add(task.sessionSummary.storageStateRef);
        stepTotal += task.steps.length;

        const settledContexts = await waitForContextsToClose(runtime);
        const stats = runtime.browser.stats();
        // 每轮先强制 GC，再读 RSS：区分「V8 堆尚未回收」与「真实存活对象增长」。
        (globalThis as { gc?: () => void }).gc?.();
        const usage = process.memoryUsage();
        maxContexts = Math.max(maxContexts, settledContexts);
        maxBrowsers = Math.max(maxBrowsers, stats.browsers);
        assert.equal(
          settledContexts,
          0,
          `第 ${round + 1} 轮结束后仍有 ${settledContexts} 个 BrowserContext 未关闭`
        );
        assert.equal(stats.browsers, 1, '服务进程应始终复用一个 Browser 实例');

        let pgConnections: number | null = null;
        if (admin) {
          try {
            const row = await admin.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM pg_stat_activity
               WHERE datname = current_database() AND application_name = 'browser-agent'`
            );
            pgConnections = row.rows[0]?.count ?? 0;
            maxPgConnections = Math.max(maxPgConnections, pgConnections);
          } catch {
            pgQueryErrors += 1;
          }
        }

        metrics.push({
          round: round + 1,
          durationMs,
          steps: task.steps.length,
          refs: refs.size,
          rssBytes: usage.rss,
          heapUsedBytes: usage.heapUsed,
          externalBytes: usage.external,
          browsers: stats.browsers,
          contexts: settledContexts,
          pgConnections,
        });

        if ((round + 1) % 10 === 0) {
          const window = metrics.slice(-10);
          const avgDuration =
            window.reduce((total, item) => total + item.durationMs, 0) / window.length;
          console.log(
            `longrun: round=${round + 1}/${rounds} avg=${avgDuration.toFixed(0)}ms ` +
              `rss=${mb(metrics[metrics.length - 1].rssBytes)} ` +
              `browsers=${stats.browsers} contexts=${settledContexts} ` +
              `pg=${pgConnections ?? 'n/a'} refs=${refs.size}`
          );
        }
      }

      const totalMs = Date.now() - startedAt;
      const rssValues = metrics.map((item) => item.rssBytes);
      // 前一半用于浏览器 / JIT / 堆扩张预热；泄漏判断只看后半段的稳态。
      const warmup = Math.max(10, Math.floor(rounds / 2));
      const steadyRss = rssValues.slice(warmup);
      const slope = slopePerRound(steadyRss);
      const firstRss = rssValues[0];
      const lastRss = rssValues[rssValues.length - 1];
      const peakRss = Math.max(...rssValues);
      const lastTenAvg = rssValues.slice(-10).reduce((total, value) => total + value, 0) / Math.min(10, rssValues.length);
      const durations = metrics.map((item) => item.durationMs);

      const summary = {
        rounds,
        completed: rounds - failures,
        failed: failures,
        steps: stepTotal,
        storageStateRefs: refs.size,
        totalMs,
        durationP50Ms: percentile(durations, 0.5),
        durationP95Ms: percentile(durations, 0.95),
        rssFirstBytes: firstRss,
        rssLastBytes: lastRss,
        rssPeakBytes: peakRss,
        rssSlopeBytesPerRound: Math.round(slope),
        rssSteadyWindow: `${warmup + 1}-${rounds}`,
        rssLastTenAvgBytes: Math.round(lastTenAvg),
        maxBrowsers,
        maxContexts,
        maxPgConnections,
        pgQueryErrors,
        driver: runtime.store.driver,
        tenantId,
      };

      const reportsDir = path.resolve('artifacts/reports');
      fs.mkdirSync(reportsDir, { recursive: true });
      const reportPath = path.join(reportsDir, `longrun-${Date.now()}.json`);
      fs.writeFileSync(reportPath, JSON.stringify({ summary, metrics }, null, 2));

      const curve = [];
      for (let start = 0; start < metrics.length; start += 10) {
        const window = metrics.slice(start, start + 10);
        curve.push({
          rounds: `${window[0].round}-${window[window.length - 1].round}`,
          avgDurationMs: Math.round(
            window.reduce((total, item) => total + item.durationMs, 0) / window.length
          ),
          rssMB: Number((window.reduce((total, item) => total + item.rssBytes, 0) / window.length / (1024 * 1024)).toFixed(1)),
          pgConnections: window[window.length - 1].pgConnections,
        });
      }

      console.log(
        `longrun-summary: ${JSON.stringify({ ...summary, report: reportPath, curve })}`
      );

      assert.equal(failures, 0, `存在 ${failures} 个失败轮次`);
      assert.equal(refs.size, 1, '同 key 连续任务必须命中同一个 storageState 归档');
      assert.equal(stepTotal, rounds * 3, '每轮应为 3 步');
      assert.equal(maxContexts, 0, '运行期间 BrowserContext 必须全部关闭');
      assert.equal(maxBrowsers, 1, '长跑期间 Browser 实例数必须恒为 1');
      assert.ok(
        maxPgConnections <= 5,
        `Postgres 连接数不得超过连接池上限 5，实际 ${maxPgConnections}`
      );
      assert.equal(pgQueryErrors, 0, '连接数观测查询不得失败');
      assert.ok(
        slope <= 512 * 1024,
        `RSS 稳态斜率应小于 0.5MB/轮，实际 ${mb(slope)}/轮`
      );
      assert.ok(
        lastRss <= firstRss + 96 * 1024 * 1024,
        `末轮 RSS 相对首轮增长超过 96MB：${mb(firstRss)} → ${mb(lastRss)}`
      );

      const minutes = totalMs / 60000;
      if (minutes >= 60) {
        console.log(`longrun-coverage: 达到 60 分钟（${minutes.toFixed(1)}min，${rounds} 轮）`);
      } else {
        console.log(
          `longrun-coverage: 先到 100+ 轮约束（${rounds} 轮 / ${minutes.toFixed(1)}min，未满 60 分钟）`
        );
      }
    } finally {
      await runtime.shutdown().catch(() => undefined);

      let deletedTasks = 0;
      let deletedStates = 0;
      let remainingTasks = -1;
      let remainingStates = -1;
      if (admin) {
        const deleted = await admin.query(
          'DELETE FROM browser_task WHERE tenant_id = $1 RETURNING task_id',
          [tenantId]
        );
        deletedTasks = deleted.rowCount ?? 0;
        const states = await admin.query(
          'DELETE FROM browser_session_state WHERE tenant_id = $1 RETURNING tenant_id',
          [tenantId]
        );
        deletedStates = states.rowCount ?? 0;
        remainingTasks = (
          await admin.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM browser_task WHERE tenant_id = $1',
            [tenantId]
          )
        ).rows[0].count;
        remainingStates = (
          await admin.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM browser_session_state WHERE tenant_id = $1',
            [tenantId]
          )
        ).rows[0].count;
        if (deletedTasks > 0) {
          await admin.query('DELETE FROM browser_task_step WHERE task_id NOT IN (SELECT task_id FROM browser_task)');
          await admin.query('DELETE FROM browser_approval WHERE task_id NOT IN (SELECT task_id FROM browser_task)');
        }
      }
      if (admin) await admin.end().catch(() => undefined);

      console.log(
        `longrun-cleanup: deletedTasks=${deletedTasks} deletedStates=${deletedStates} ` +
          `remainingTasks=${remainingTasks} remainingStates=${remainingStates}`
      );
    }
  }
);
