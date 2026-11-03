import fs from 'node:fs';
import path from 'node:path';

import type { Page, Response } from 'playwright';

import { BrowserManager } from '../browser/browser-manager.js';
import { SessionManager, type TaskSession } from '../browser/session-manager.js';
import { loadServiceConfig, type ServiceConfig } from '../config/config.js';
import type { ActionIntent, PreflightResult, RunResult, StepResult } from '../core/types.js';
import { computeTotals } from '../core/types.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/fixture-server.js';
import { ActionRunner } from '../automation/action-runner.js';
import { createSilentLogger } from '../observability/logger.js';
import { DomainPolicy } from '../security/domain-policy.js';
import { buildRealLoginPlan, createDefaultWorkflowRegistry } from '../workflows/registry.js';
import { buildRealProductProbePlan } from '../workflows/real-product.js';

export interface SpikeOptions {
  headed?: boolean;
  approve?: boolean;
  scenario: string;
  actionsFile?: string;
  /** 复用已登录 storageState（真实页复测用，避免重复登录） */
  storageStatePath?: string;
}

export function loadSpikeConfig(options: SpikeOptions): ServiceConfig {
  return loadServiceConfig({
    headless: !options.headed,
    artifactsDir: path.resolve(process.cwd(), 'artifacts'),
  });
}

export function createRunId(): string {
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('');
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join('');
  return `${date}-${time}`;
}

interface RunContext {
  config: ServiceConfig;
  policy: DomainPolicy;
  sessions: SessionManager;
  runId: string;
  screenshotsDir: string;
  collected: StepResult[];
  violations: string[];
  approvalMode: 'auto' | 'require_approval';
  onInfo?: (message: string) => void;
  onStep?: (step: StepResult) => void;
}

function createContext(config: ServiceConfig, runId: string, options: SpikeOptions): RunContext {
  const screenshotsDir = path.resolve(config.artifactsDir, 'screenshots', runId);
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const policy = new DomainPolicy(config.allowedHosts);
  const logger = createSilentLogger();
  const browser = new BrowserManager(config);
  const sessions = new SessionManager(browser, policy, logger);

  return {
    config,
    policy,
    sessions,
    runId,
    screenshotsDir,
    collected: [],
    violations: [],
    approvalMode: options.approve ? 'auto' : 'require_approval',
    onInfo: (message) => console.log(`   · ${message}`),
    onStep: printStep,
  };
}

async function openSession(context: RunContext, storageStatePath?: string): Promise<TaskSession> {
  return context.sessions.open({
    taskId: context.runId,
    ...(storageStatePath ? { storageStatePath } : {}),
  });
}

async function closeSession(context: RunContext, session: TaskSession): Promise<void> {
  context.violations.push(...session.violations);
  await session.close();
}

async function runIntents(
  context: RunContext,
  session: TaskSession,
  intents: ActionIntent[]
): Promise<'completed' | 'blocked' | 'failed'> {
  const runner = new ActionRunner(
    session.page,
    context.policy,
    {
      actionTimeoutMs: context.config.actionTimeoutMs,
      expectTimeoutMs: context.config.expectTimeoutMs,
      screenshotsDir: context.screenshotsDir,
      downloadsDir: path.resolve(context.config.artifactsDir, 'downloads', context.runId),
      executionMode: context.approvalMode,
      taskId: context.runId,
      uploadRoot: context.config.uploadRoot,
      uploadAllowedExtensions: context.config.uploadAllowedExtensions,
      uploadMaxBytes: context.config.uploadMaxBytes,
      downloadMaxBytes: context.config.downloadMaxBytes,
      downloadAllowedExtensions: context.config.downloadAllowedExtensions,
    },
    createSilentLogger()
  );

  for (const intent of intents) {
    const step = await runner.run(intent, context.collected.length + 1);
    context.collected.push(step);
    context.onStep?.(step);
    if (step.status === 'failed') return 'failed';
    if (step.status === 'blocked') return 'blocked';
  }
  return 'completed';
}

function recordInternalFailure(context: RunContext, error: Error): void {
  if (context.collected.some((step) => step.status === 'failed')) return;
  context.collected.push({
    index: context.collected.length + 1,
    action: 'internal',
    description: '执行层内部错误',
    status: 'failed',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    validations: [],
    error: { name: error.name, message: error.message },
  });
}

function writeResult(
  context: RunContext,
  scenario: string,
  startedAt: number,
  fixtureUrl: string,
  realProduct?: PreflightResult,
  statusOverride?: 'passed' | 'failed'
): RunResult {
  const finishedAt = Date.now();
  const resultJson = path.resolve(context.config.artifactsDir, 'runs', `${context.runId}.json`);
  const failed = context.collected.some((step) => step.status === 'failed');
  const gateBlocked = context.collected.some((step) => step.status === 'blocked');

  const result: RunResult = {
    runId: context.runId,
    scenario,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    status: statusOverride ?? (failed ? 'failed' : 'passed'),
    gateBlocked,
    target: { fixtureUrl, ...(realProduct ? { realProduct } : {}) },
    steps: context.collected,
    totals: computeTotals(context.collected),
    policyViolations: context.violations,
    screenshotsDir: context.screenshotsDir,
    resultJson,
    environment: {
      browserChannel: context.config.browserChannel,
      headless: context.config.headless,
      approvalMode: context.approvalMode,
    },
  };

  fs.mkdirSync(path.dirname(resultJson), { recursive: true });
  fs.writeFileSync(resultJson, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

async function probeRealProduct(
  page: Page,
  config: ServiceConfig,
  screenshotsDir: string,
  onInfo?: (message: string) => void
): Promise<PreflightResult> {
  const httpFailures: Array<{ url: string; status: number }> = [];
  const targetUrl = `${config.webUrl}/zh-CN/product/create`;

  const listener = (response: Response): void => {
    const url = response.url();
    const status = response.status();
    if (status >= 500 && url.includes('/scm-product/')) {
      httpFailures.push({ url, status });
    }
  };

  page.on('response', listener);
  let note = '';
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: config.actionTimeoutMs });
    await page.waitForTimeout(2500);
    note = httpFailures.length
      ? `页面可渲染；${httpFailures.length} 个商品接口返回 5xx，分类/品牌下拉为空`
      : '页面可渲染；未观察到商品接口 5xx';
  } catch (error) {
    note = `页面加载失败：${(error as Error).message}`;
  }

  const screenshot = path.join(screenshotsDir, 'real-product-page.png');
  try {
    await page.screenshot({ path: screenshot, fullPage: true });
  } catch {
    /* 页面已崩溃时截图失败不阻塞流程 */
  }

  page.off('response', listener);
  onInfo?.(`真实商品页探针：${note}`);

  return {
    label: '真实 scm-web 商品新建页',
    url: targetUrl,
    screenshot,
    httpFailures,
    note,
  };
}

function productSample(): {
  name: string;
  brand: string;
  price: string;
  stock: string;
  description: string;
} {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');

  return {
    name: `Spike 测试商品 ${stamp}`,
    brand: 'apple',
    price: '199.00',
    stock: '120',
    description: '结构化动作执行层验证样品：填写后逐字回读比对。',
  };
}

/** 主验收：真实登录 → storageState 复用 → 真实商品页探针 → 本地靶场完整流程。 */
export async function runMainScenario(
  config: ServiceConfig,
  options: SpikeOptions
): Promise<RunResult> {
  if (!config.password) {
    throw new Error(
      '缺少登录密码。请设置 BROWSER_PASSWORD / SPIKE_PASSWORD，或在项目根目录创建 .env（参考 .env.example）。'
    );
  }

  const startedAt = Date.now();
  const runId = createRunId();
  const context = createContext(config, runId, options);
  const workflows = createDefaultWorkflowRegistry();
  let fixture: FixtureServer | undefined;
  let realProduct: PreflightResult | undefined;
  let fixtureUrl = 'http://localhost:0';

  try {
    fixture = await startFixtureServer(0);
    fixtureUrl = `http://localhost:${fixture.port}`;
    context.onInfo?.(`本地靶场已启动：${fixtureUrl}`);

    const loginSession = await openSession(context);
    context.onInfo?.('打开浏览器（隔离 context，不共享 userDataDir）');

    const loginPlan = buildRealLoginPlan(config.webUrl, config.username, config.password);
    const loginOutcome = await runIntents(context, loginSession, loginPlan);
    if (loginOutcome !== 'completed') throw new Error('真实登录流程未通过');

    const cookies = await loginSession.context.cookies(config.webUrl);
    if (!cookies.some((cookie) => cookie.name === 'access_token')) {
      throw new Error('登录后 context 中没有 access_token cookie，无法复用登录态');
    }

    const storageState = path.resolve(config.artifactsDir, 'storage-state.json');
    await loginSession.saveStorageState(storageState);
    context.onInfo?.(`已保存 storageState：${storageState}`);
    await closeSession(context, loginSession);

    const reuseSession = await openSession(context, storageState);
    context.onInfo?.('已用 storageState 打开新 context（未复用 userDataDir）');

    realProduct = await probeRealProduct(reuseSession.page, config, context.screenshotsDir, context.onInfo);

    const useRealTarget =
      config.defaultTarget === 'real' &&
      realProduct !== undefined &&
      !realProduct.note.startsWith('页面加载失败');

    if (useRealTarget) {
      if (options.approve) {
        throw new Error('真实页面默认探针禁止 --approve，避免真实上架产生业务数据');
      }
      const stamp = createRunId();
      const realPlan = buildRealProductProbePlan(config.webUrl, {
        name: `Spike 真实商品 ${stamp}`,
        code: `PRD-SPIKE-${stamp}`,
        category: '手机数码',
        brand: 'Apple',
        price: '199.00',
        description: 'browser-agent 真实页默认探针：填写、回读、审批拦截',
      });
      const realOutcome = await runIntents(context, reuseSession, realPlan);
      await closeSession(context, reuseSession);
      if (realOutcome === 'failed') throw new Error('真实商品页流程未通过');
    } else {
      context.onInfo?.('真实商品页不可用，回落到 fixture 离线靶场');
      const plan = workflows.build('fixture.product.create', {
        config,
        target: { system: 'fixture', url: fixtureUrl },
        tenantId: config.tenantId,
        userId: 'default',
        taskType: 'fixture.product.create',
        input: productSample(),
      });

      const fixtureOutcome = await runIntents(context, reuseSession, plan.steps);
      await closeSession(context, reuseSession);
      if (fixtureOutcome === 'failed') throw new Error('本地靶场流程未通过');
    }
  } catch (error) {
    recordInternalFailure(context, error as Error);
    context.onInfo?.(`流程中止：${(error as Error).message}`);
  } finally {
    await context.sessions.shutdown();
    await fixture?.close().catch(() => undefined);
  }

  return writeResult(context, 'main', startedAt, fixtureUrl, realProduct);
}

/** 反自动化守卫自检。 */
export async function runBlockerScenario(config: ServiceConfig, options: SpikeOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const runId = createRunId();
  const context = createContext(config, runId, options);
  const workflows = createDefaultWorkflowRegistry();
  let fixture: FixtureServer | undefined;
  let fixtureUrl = 'http://localhost:0';

  try {
    fixture = await startFixtureServer(0);
    fixtureUrl = `http://localhost:${fixture.port}`;
    const session = await openSession(context);
    const plan = workflows.build('blocker.check', {
      config,
      target: { system: 'fixture', url: fixtureUrl },
      tenantId: config.tenantId,
      userId: 'default',
      taskType: 'blocker.check',
      input: {},
    });
    await runIntents(context, session, plan.steps);
    await closeSession(context, session);
  } finally {
    await context.sessions.shutdown();
    await fixture?.close().catch(() => undefined);
  }

  const detected = context.collected.some(
    (step) => step.error?.code === 'ANTI_AUTOMATION_DETECTED'
  );
  return writeResult(context, 'blocker', startedAt, fixtureUrl, undefined, detected ? 'passed' : 'failed');
}

/** 只做真实登录 + 商品页探针，用于后端恢复后复测。 */
export async function runRealProductScenario(config: ServiceConfig, options: SpikeOptions): Promise<RunResult> {
  if (!config.password) {
    throw new Error('缺少登录密码。请设置 BROWSER_PASSWORD / SPIKE_PASSWORD。');
  }

  const startedAt = Date.now();
  const runId = createRunId();
  const context = createContext(config, runId, options);
  let realProduct: PreflightResult | undefined;

  try {
    const session = await openSession(context);
    const loginPlan = buildRealLoginPlan(config.webUrl, config.username, config.password);
    const outcome = await runIntents(context, session, loginPlan);
    if (outcome !== 'completed') throw new Error('真实登录流程未通过');

    const storageState = path.resolve(config.artifactsDir, 'storage-state.json');
    await session.saveStorageState(storageState);
    context.onInfo?.(`已保存 storageState：${storageState}`);

    realProduct = await probeRealProduct(session.page, config, context.screenshotsDir, context.onInfo);
    await closeSession(context, session);
  } catch (error) {
    context.onInfo?.(`流程中止：${(error as Error).message}`);
  } finally {
    await context.sessions.shutdown();
  }

  return writeResult(context, 'real-product', startedAt, 'http://localhost:0', realProduct);
}

/** 回放调用方提供的结构化动作序列。 */
export async function runActionsFile(
  config: ServiceConfig,
  options: SpikeOptions
): Promise<RunResult> {
  if (!options.actionsFile) throw new Error('缺少 --actions 文件路径');

  const startedAt = Date.now();
  const runId = createRunId();
  const context = createContext(config, runId, options);
  let fixture: FixtureServer | undefined;
  let fixtureUrl = 'http://localhost:0';

  const parsed = JSON.parse(fs.readFileSync(path.resolve(options.actionsFile), 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('动作序列 JSON 必须是数组');

  try {
    fixture = await startFixtureServer(0);
    fixtureUrl = `http://localhost:${fixture.port}`;
    const storageState = options.storageStatePath
      ? path.resolve(options.storageStatePath)
      : path.resolve(config.artifactsDir, 'storage-state.json');
    const session = await openSession(context, fs.existsSync(storageState) ? storageState : undefined);
    await runIntents(context, session, parsed as ActionIntent[]);
    await closeSession(context, session);
  } catch (error) {
    context.onInfo?.(`流程中止：${(error as Error).message}`);
  } finally {
    await context.sessions.shutdown();
    await fixture?.close().catch(() => undefined);
  }

  return writeResult(context, 'actions-file', startedAt, fixtureUrl);
}

export function printStep(step: StepResult): void {
  const marker = step.status === 'success' ? 'OK' : step.status === 'blocked' ? 'BLOCKED' : 'FAILED';
  console.log(
    `[${String(step.index).padStart(2, '0')}] ${step.description}  → ${marker}  ${step.durationMs}ms`
  );

  for (const validation of step.validations) {
    console.log(
      `     ${validation.ok ? '✓' : '✗'} ${validation.kind}：期望「${validation.expected ?? ''}」/ 实际「${validation.actual ?? ''}」`
    );
  }

  if (step.error) {
    console.log(`     ! ${step.error.code ?? step.error.name}: ${step.error.message}`);
  }
}

export function printSummary(result: RunResult): void {
  console.log('');
  console.log('=== 汇总 ===');
  console.log(`场景: ${result.scenario}`);
  console.log(`总耗时: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(
    `步骤: ${result.totals.steps}（成功 ${result.totals.succeeded}，审批拦截 ${result.totals.blocked}，失败 ${result.totals.failed}）`
  );
  console.log(`校验: ${result.totals.validations} 项，失败 ${result.totals.validationFailures}`);
  console.log(`整体: ${result.status === 'passed' ? 'PASSED' : 'FAILED'}`);
  console.log(`截图目录: ${result.screenshotsDir}`);
  console.log(`结果 JSON: ${result.resultJson}`);
}
