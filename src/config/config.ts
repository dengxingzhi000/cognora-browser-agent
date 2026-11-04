import fs from 'node:fs';
import path from 'node:path';

import { InvalidInputError } from '../core/errors.js';

export type BrowserChannel = 'chromium' | 'chrome' | 'msedge';
export type StorageDriverOption = 'auto' | 'postgres' | 'file' | 'memory';
export type DefaultTarget = 'real' | 'fixture';

export interface ServiceConfig {
  host: string;
  port: number;
  artifactsDir: string;
  storageDriver: StorageDriverOption;
  /** CLI 主流程默认目标：real = 真实商品页；fixture = 离线靶场 */
  defaultTarget: DefaultTarget;
  pgDsn?: string;
  persistenceDir: string;
  allowedHosts: string[];
  browserChannel: BrowserChannel;
  headless: boolean;
  workerConcurrency: number;
  /** 多实例租约时长（毫秒）；到期后其他实例可接管。 */
  taskLeaseMs: number;
  /** 心跳间隔（毫秒），必须小于 taskLeaseMs。 */
  taskHeartbeatMs: number;
  /** dispatcher 轮询间隔（毫秒）：认领、过期回收、审批唤醒。 */
  taskPollMs: number;
  actionTimeoutMs: number;
  expectTimeoutMs: number;
  webUrl: string;
  username: string;
  password?: string;
  tenantId: string;
  tenantCode: string;
  fixturePort: number;
  uploadRoot: string;
  uploadAllowedExtensions: string[];
  uploadMaxBytes: number;
  downloadMaxBytes: number;
  downloadAllowedExtensions: string[];
  logToFile: boolean;
}

export type ConfigOverrides = Partial<ServiceConfig>;

/** 极简 .env 读取（不引入 dotenv）；已存在的进程环境变量优先。 */
function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;

  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[match[1]] === undefined) {
      process.env[match[1]] = value;
    }
  }
}

function envFirst(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function numberFrom(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidInputError(`${name} 必须是正数，当前为「${value}」`, { name, value });
  }
  return parsed;
}

function extensionList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item.startsWith('.') ? item : `.${item}`));
}

function boolFrom(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

export function loadServiceConfig(overrides: ConfigOverrides = {}): ServiceConfig {
  loadDotEnv();

  const channel = (envFirst('BROWSER_CHANNEL', 'SPIKE_BROWSER_CHANNEL') ?? 'chromium').trim();
  if (!['chromium', 'chrome', 'msedge'].includes(channel)) {
    throw new InvalidInputError(
      `浏览器只能是 chromium / chrome / msedge，当前为 ${channel}`,
      { channel }
    );
  }

  const allowedHosts = (envFirst('BROWSER_ALLOWED_HOSTS', 'SPIKE_ALLOWED_HOSTS') ?? 'localhost,127.0.0.1')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (process.env.BROWSER_REMOTE_HOST) allowedHosts.push(process.env.BROWSER_REMOTE_HOST.trim());
  if (process.env.SPIKE_REMOTE_HOST) allowedHosts.push(process.env.SPIKE_REMOTE_HOST.trim());

  const artifactsDir = path.resolve(
    overrides.artifactsDir ?? envFirst('BROWSER_ARTIFACTS_DIR') ?? 'artifacts'
  );

  const storageDriverRaw = (envFirst('BROWSER_STORAGE_DRIVER') ?? 'auto').toLowerCase();
  if (!['auto', 'postgres', 'file', 'memory'].includes(storageDriverRaw)) {
    throw new InvalidInputError(
      'BROWSER_STORAGE_DRIVER 只能是 auto / postgres / file / memory',
      { value: storageDriverRaw }
    );
  }

  const defaults = {
    host: envFirst('BROWSER_API_HOST') ?? '127.0.0.1',
    port: numberFrom(envFirst('BROWSER_API_PORT'), 4320, 'BROWSER_API_PORT'),
    artifactsDir,
    storageDriver: storageDriverRaw as StorageDriverOption,
    defaultTarget: (envFirst('BROWSER_DEFAULT_TARGET') === 'fixture'
      ? 'fixture'
      : 'real') as DefaultTarget,
    pgDsn: envFirst('BROWSER_AGENT_PG_DSN'),
    persistenceDir: path.resolve(
      envFirst('BROWSER_PERSISTENCE_DIR') ?? path.join(artifactsDir, 'persistence')
    ),
    allowedHosts,
    browserChannel: channel as BrowserChannel,
    headless: boolFrom(envFirst('BROWSER_HEADLESS'), true),
    workerConcurrency: numberFrom(
      envFirst('BROWSER_WORKER_CONCURRENCY'),
      2,
      'BROWSER_WORKER_CONCURRENCY'
    ),
    taskLeaseMs: numberFrom(envFirst('BROWSER_TASK_LEASE_MS'), 60000, 'BROWSER_TASK_LEASE_MS'),
    taskHeartbeatMs: numberFrom(
      envFirst('BROWSER_TASK_HEARTBEAT_MS'),
      15000,
      'BROWSER_TASK_HEARTBEAT_MS'
    ),
    taskPollMs: numberFrom(envFirst('BROWSER_TASK_POLL_MS'), 1000, 'BROWSER_TASK_POLL_MS'),
    actionTimeoutMs: numberFrom(
      envFirst('BROWSER_ACTION_TIMEOUT_MS', 'SPIKE_ACTION_TIMEOUT_MS'),
      30000,
      'BROWSER_ACTION_TIMEOUT_MS'
    ),
    expectTimeoutMs: numberFrom(
      envFirst('BROWSER_EXPECT_TIMEOUT_MS', 'SPIKE_EXPECT_TIMEOUT_MS'),
      10000,
      'BROWSER_EXPECT_TIMEOUT_MS'
    ),
    webUrl: (envFirst('BROWSER_WEB_URL', 'SPIKE_WEB_URL') ?? 'http://localhost:3000').replace(/\/$/, ''),
    username: envFirst('BROWSER_USERNAME', 'SPIKE_USERNAME') ?? 'admin',
    password: envFirst('BROWSER_PASSWORD', 'SPIKE_PASSWORD'),
    tenantId:
      envFirst('BROWSER_TENANT_ID', 'SPIKE_TENANT_ID') ?? '019a0aee-0000-7000-8000-000000000002',
    tenantCode: envFirst('BROWSER_TENANT_CODE', 'SPIKE_TENANT_CODE') ?? 'default',
    fixturePort: numberFrom(envFirst('BROWSER_FIXTURE_PORT', 'SPIKE_FIXTURE_PORT'), 4310, 'BROWSER_FIXTURE_PORT'),
    uploadRoot: path.resolve(
      envFirst('BROWSER_UPLOAD_ROOT') ?? path.join(artifactsDir, 'uploads')
    ),
    uploadAllowedExtensions: extensionList(
      envFirst('BROWSER_UPLOAD_ALLOWED_EXTENSIONS'),
      ['.txt', '.csv', '.json', '.png', '.jpg', '.pdf']
    ),
    uploadMaxBytes: numberFrom(
      envFirst('BROWSER_UPLOAD_MAX_BYTES'),
      5 * 1024 * 1024,
      'BROWSER_UPLOAD_MAX_BYTES'
    ),
    downloadMaxBytes: numberFrom(
      envFirst('BROWSER_DOWNLOAD_MAX_BYTES'),
      10 * 1024 * 1024,
      'BROWSER_DOWNLOAD_MAX_BYTES'
    ),
    downloadAllowedExtensions: extensionList(
      envFirst('BROWSER_DOWNLOAD_ALLOWED_EXTENSIONS'),
      ['.txt', '.csv', '.json', '.png', '.jpg', '.pdf', '.zip']
    ),
    logToFile: boolFrom(envFirst('BROWSER_LOG_TO_FILE'), true),
  };

  return { ...defaults, ...overrides };
}

/** 心跳必须明显快于租约到期，否则存活实例会被误回收。 */
export function assertLeaseConfig(config: ServiceConfig): void {
  if (config.taskHeartbeatMs >= config.taskLeaseMs) {
    throw new InvalidInputError(
      `BROWSER_TASK_HEARTBEAT_MS（${config.taskHeartbeatMs}）必须小于 BROWSER_TASK_LEASE_MS（${config.taskLeaseMs}）`,
      { heartbeatMs: config.taskHeartbeatMs, leaseMs: config.taskLeaseMs }
    );
  }
}
