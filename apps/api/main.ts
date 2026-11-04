import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { BrowserManager } from '../../src/browser/browser-manager.js';
import { SessionManager } from '../../src/browser/session-manager.js';
import { SessionStateManager } from '../../src/browser/session-state-manager.js';
import { loadServiceConfig, assertLeaseConfig } from '../../src/config/config.js';
import { createLogger } from '../../src/observability/logger.js';
import { TaskArtifacts } from '../../src/observability/run-records.js';
import { createPersistence } from '../../src/persistence/factory.js';
import { DomainPolicy } from '../../src/security/domain-policy.js';
import { TaskStore } from '../../src/tasks/task-store.js';
import { TaskService } from '../../src/tasks/task-service.js';
import { createDefaultWorkflowRegistry } from '../../src/workflows/registry.js';
import { BrowserTaskExecutionFactory } from '../worker/browser-task-execution.js';
import { TaskQueue } from '../worker/task-queue.js';
import { createApiApp } from './server.js';

export interface BrowserService {
  service: TaskService;
  shutdown: () => Promise<void>;
}

/** API 与 worker 在同一进程内组合；任务状态不持久化。 */
export async function startBrowserService(): Promise<BrowserService> {
  const config = loadServiceConfig();
  assertLeaseConfig(config);
  const ownerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const logger = createLogger({ artifactsDir: config.artifactsDir, logToFile: config.logToFile });
  const domainPolicy = new DomainPolicy(config.allowedHosts);
  const artifacts = new TaskArtifacts(config.artifactsDir);
  const persistence = await createPersistence(
    {
      driver: config.storageDriver,
      ...(config.pgDsn ? { dsn: config.pgDsn } : {}),
      persistenceDir: config.persistenceDir,
    },
    logger
  );
  const store = new TaskStore(persistence.tasks, logger, {
    ownerId,
    leaseMs: config.taskLeaseMs,
  });
  await store.init();
  await store.flush();
  const profiles = new SessionStateManager(persistence.sessions);
  const browser = new BrowserManager(config);
  const sessions = new SessionManager(browser, domainPolicy, logger);
  const workflows = createDefaultWorkflowRegistry();

  const queue = new TaskQueue(config.workerConcurrency, logger, (job, error) => {
    logger.error('queue.job_error', { job: job.label, message: error.message });
  });

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
    ownerId,
  });

  const app = createApiApp({ service, workflows, logger });

  logger.info('service.starting', {
    port: config.port,
    host: config.host,
    ownerId,
    workerConcurrency: config.workerConcurrency,
    taskLeaseMs: config.taskLeaseMs,
    taskHeartbeatMs: config.taskHeartbeatMs,
    taskPollMs: config.taskPollMs,
    allowedHosts: domainPolicy.describe(),
    artifactsDir: config.artifactsDir,
    storageDriver: store.driver,
    sessionStateDriver: profiles.describe(),
  });

  await app.listen({ port: config.port, host: config.host });
  logger.info('service.listening', { url: `http://${config.host}:${config.port}` });

  // 只有租约驱动（Postgres）才启动跨实例 dispatcher；file/memory 保持进程内队列。
  service.startDispatcher();

  const shutdown = async (): Promise<void> => {
    logger.info('service.stopping');
    await app.close();
    await service.shutdown();
    await sessions.shutdown();
    await persistence.close();
  };

  return { service, shutdown };
}

const isEntrypoint = process.argv[1]?.replace(/\\/g, '/').endsWith('apps/api/main.ts');
if (isEntrypoint) {
  startBrowserService()
    .then((instance) => {
      const stop = async (): Promise<void> => {
        await instance.shutdown();
        process.exit(0);
      };
      process.once('SIGINT', () => void stop());
      process.once('SIGTERM', () => void stop());
    })
    .catch((error) => {
      console.error(`[api] 启动失败：${(error as Error).message}`);
      process.exit(1);
    });
}
