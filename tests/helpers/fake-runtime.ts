import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { createApiApp } from '../../apps/api/server.js';
import { TaskQueue } from '../../apps/worker/task-queue.js';
import type { ServiceConfig } from '../../src/config/config.js';
import { loadServiceConfig } from '../../src/config/config.js';
import { createSilentLogger } from '../../src/observability/logger.js';
import { TaskArtifacts } from '../../src/observability/run-records.js';
import { createPersistence } from '../../src/persistence/factory.js';
import { DomainPolicy } from '../../src/security/domain-policy.js';
import { TaskStore } from '../../src/tasks/task-store.js';
import { TaskService } from '../../src/tasks/task-service.js';
import { createDefaultWorkflowRegistry } from '../../src/workflows/registry.js';
import { FakeExecutionFactory } from './fake-execution.js';

export interface FakeRuntime {
  app: FastifyInstance;
  service: TaskService;
  store: TaskStore;
  queue: TaskQueue;
  config: ServiceConfig;
  artifactsDir: string;
}

export async function createFakeRuntime(
  options: { concurrency?: number } = {}
): Promise<FakeRuntime> {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-test-'));
  const config = loadServiceConfig({
    artifactsDir,
    allowedHosts: ['localhost', '127.0.0.1'],
    headless: true,
    workerConcurrency: options.concurrency ?? 2,
    actionTimeoutMs: 5000,
    expectTimeoutMs: 3000,
    logToFile: false,
    storageDriver: 'file',
  });

  const logger = createSilentLogger();
  const domainPolicy = new DomainPolicy(config.allowedHosts);
  const artifacts = new TaskArtifacts(config.artifactsDir);
  const persistence = await createPersistence(
    { driver: 'file', persistenceDir: config.persistenceDir },
    logger
  );
  const store = new TaskStore(persistence.tasks, logger);
  await store.init();
  await store.flush();
  const workflows = createDefaultWorkflowRegistry();

  const queue = new TaskQueue(config.workerConcurrency, logger, () => undefined);

  const service = new TaskService({
    config,
    store,
    queue,
    executionFactory: new FakeExecutionFactory(),
    workflows,
    domainPolicy,
    artifacts,
    logger,
  });

  const app = createApiApp({ service, workflows, logger });
  return { app, service, store, queue, config, artifactsDir };
}

export function taskPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    taskType: 'actions.run',
    tenantId: 'tenant-a',
    userId: 'user-1',
    target: { system: 'fixture', url: 'http://127.0.0.1:4310' },
    input: {
      actions: [
        { action: 'goto', url: 'http://127.0.0.1:4310/session' },
        { action: 'fill', target: { role: 'textbox', name: '备注' }, value: 'hello' },
        { action: 'click', target: { role: 'button', name: '提交审核' } },
      ],
    },
    executionMode: 'auto',
  };

  return {
    ...base,
    ...overrides,
    input: {
      ...base.input,
      ...((overrides.input as Record<string, unknown> | undefined) ?? {}),
    },
    target: {
      ...base.target,
      ...((overrides.target as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

export async function waitForTaskStatus(
  runtime: FakeRuntime,
  taskId: string,
  statuses: string[],
  timeoutMs = 3000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};

  while (Date.now() < deadline) {
    const response = await runtime.app.inject({
      method: 'GET',
      url: `/api/v1/browser/tasks/${taskId}`,
    });
    last = response.json() as Record<string, unknown>;
    if (statuses.includes(String(last.status))) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `任务 ${taskId} 未在 ${timeoutMs}ms 内进入 ${statuses.join('/')}，最后状态=${String(last.status)}`
  );
}
