import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { createApiApp } from '../../apps/api/server.js';
import { BrowserTaskExecutionFactory } from '../../apps/worker/browser-task-execution.js';
import { TaskQueue } from '../../apps/worker/task-queue.js';
import { BrowserManager } from '../../src/browser/browser-manager.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import { SessionStateManager } from '../../src/browser/session-state-manager.js';
import { loadServiceConfig, type ServiceConfig } from '../../src/config/config.js';
import { startFixtureServer, type FixtureServer } from '../../src/fixtures/fixture-server.js';
import { createSilentLogger, createLogger } from '../../src/observability/logger.js';
import { TaskArtifacts } from '../../src/observability/run-records.js';
import { createPersistence } from '../../src/persistence/factory.js';
import type { Persistence } from '../../src/persistence/types.js';
import { DomainPolicy } from '../../src/security/domain-policy.js';
import { TaskStore } from '../../src/tasks/task-store.js';
import { TaskService } from '../../src/tasks/task-service.js';
import { createDefaultWorkflowRegistry } from '../../src/workflows/registry.js';

export interface BrowserRuntime {
  app: FastifyInstance;
  service: TaskService;
  store: TaskStore;
  persistence: Persistence;
  fixture: FixtureServer;
  config: ServiceConfig;
  artifactsDir: string;
  shutdown: () => Promise<void>;
}

export async function createBrowserRuntime(
  options: { storageDriver?: 'file' | 'postgres'; pgDsn?: string; debug?: boolean } = {}
): Promise<BrowserRuntime> {
  const fixture = await startFixtureServer(0);
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-e2e-'));
  const config = loadServiceConfig({
    artifactsDir,
    allowedHosts: ['127.0.0.1', 'localhost'],
    headless: true,
    workerConcurrency: 2,
    actionTimeoutMs: 8000,
    expectTimeoutMs: 5000,
    logToFile: false,
    storageDriver: options.storageDriver ?? 'file',
    ...(options.pgDsn ? { pgDsn: options.pgDsn } : {}),
  });

  const logger = options.debug
    ? createLogger({ artifactsDir, logToFile: false })
    : createSilentLogger();
  const domainPolicy = new DomainPolicy(config.allowedHosts);
  const artifacts = new TaskArtifacts(config.artifactsDir);
  const persistence = await createPersistence(
    {
      driver: options.storageDriver ?? 'file',
      ...(options.pgDsn ? { dsn: options.pgDsn } : {}),
      persistenceDir: config.persistenceDir,
    },
    logger
  );
  const store = new TaskStore(persistence.tasks, logger);
  await store.init();
  await store.flush();
  const profiles = new SessionStateManager(persistence.sessions);
  const browser = new BrowserManager(config);
  const sessions = new SessionManager(browser, domainPolicy, logger);
  const workflows = createDefaultWorkflowRegistry();
  const queue = new TaskQueue(config.workerConcurrency, logger, () => undefined);

  const executionFactory = new BrowserTaskExecutionFactory({
    config,
    domainPolicy,
    workflows,
    sessions,
    profiles,
    artifacts,
    logger,
  });

  const service = new TaskService({
    config,
    store,
    queue,
    executionFactory,
    workflows,
    domainPolicy,
    artifacts,
    logger,
  });

  const app = createApiApp({ service, workflows, logger });

  return {
    app,
    service,
    store,
    persistence,
    fixture,
    config,
    artifactsDir,
    shutdown: async () => {
      await app.close();
      await service.shutdown();
      await sessions.shutdown();
      await persistence.close();
      await fixture.close();
      fs.rmSync(artifactsDir, { recursive: true, force: true });
    },
  };
}

export interface BrowserTaskBody {
  taskId: string;
  status: string;
  steps: Array<{
    index: number;
    action: string;
    status: string;
    startedAt: string;
    durationMs: number;
    validations: Array<{
      ok: boolean;
      kind: string;
      expected?: string;
      actual?: string;
      detail?: string;
    }>;
    screenshot?: string;
    error?: { code?: string; message: string };
    approval?: { stepIndex: number };
  }>;
  approvals: Array<{
    request: { stepIndex: number; targetName: string };
    decision?: { decision: string; actor?: string };
  }>;
  pendingApproval?: { stepIndex: number; targetName: string; screenshot?: string };
  sessionSummary?: { cookieNames: string[]; storageStateRef?: string; policyViolations: string[] };
  error?: { code?: string; message: string };
}

export async function createAndWait(
  runtime: BrowserRuntime,
  payload: Record<string, unknown>,
  options: { statuses?: string[]; timeoutMs?: number } = {}
): Promise<BrowserTaskBody> {
  const response = await runtime.app.inject({
    method: 'POST',
    url: '/api/v1/browser/tasks',
    payload,
  });
  if (response.statusCode !== 201) {
    throw new Error(`创建任务失败：${response.statusCode} ${response.body}`);
  }
  const created = response.json() as { taskId: string };

  return waitForTask(runtime, created.taskId, options);
}

export async function waitForTask(
  runtime: BrowserRuntime,
  taskId: string,
  options: { statuses?: string[]; timeoutMs?: number } = {}
): Promise<BrowserTaskBody> {
  const statuses = options.statuses ?? ['COMPLETED', 'FAILED', 'CANCELLED'];
  const deadline = Date.now() + (options.timeoutMs ?? 60000);
  let last: BrowserTaskBody | undefined;

  while (Date.now() < deadline) {
    const current = await runtime.app.inject({
      method: 'GET',
      url: `/api/v1/browser/tasks/${taskId}`,
    });
    last = current.json() as BrowserTaskBody;
    if (statuses.includes(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `任务 ${taskId} 未在超时内进入 ${statuses.join('/')}，最后状态=${last?.status ?? '未知'}`
  );
}

export function sessionSetActions(baseUrl: string, value: string): unknown[] {
  return [
    {
      action: 'goto',
      url: `${baseUrl}/session`,
      expect: { type: 'text', text: 'cookie值：无', exact: false },
      note: '首次访问必须看到干净上下文',
    },
    {
      action: 'goto',
      url: `${baseUrl}/session/set?name=tenant_cookie&value=${value}`,
      expect: { type: 'text', text: '已设置', exact: false },
    },
    {
      action: 'goto',
      url: `${baseUrl}/session`,
      expect: { type: 'text', text: `cookie值：${value}`, exact: false },
    },
  ];
}

export function sessionProbeActions(baseUrl: string, expected: string): unknown[] {
  return [
    {
      action: 'goto',
      url: `${baseUrl}/session`,
      expect: { type: 'text', text: `cookie值：${expected}`, exact: false },
    },
  ];
}
