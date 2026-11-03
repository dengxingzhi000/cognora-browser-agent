import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient } from 'pg';

import type { Logger } from '../observability/logger.js';
import type { ApprovalRecord, StepResult } from '../core/types.js';
import { computeTotals } from '../core/types.js';
import type { TaskRecord, TaskStatus } from '../tasks/task-types.js';
import type {
  SessionStateKey,
  SessionStateRepository,
  StorageStateInput,
  TaskRepository,
} from './types.js';

interface TaskRow {
  task_id: string;
  tenant_id: string;
  user_id: string;
  task_type: string;
  status: TaskStatus;
  target_system: string;
  target_url: string;
  input: Record<string, unknown>;
  execution_mode: 'auto' | 'require_approval';
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  result: { policyViolations?: string[] } | null;
  error: TaskRecord['error'] | null;
  session_summary: TaskRecord['sessionSummary'] | null;
  pending_approval: TaskRecord['pendingApproval'] | null;
  cancel_requested: boolean;
}

interface StepRow {
  task_id: string;
  step_index: number;
  action: string;
  target: StepResult['target'] | null;
  description: string;
  status: StepResult['status'];
  validations: StepResult['validations'];
  duration_ms: number;
  screenshot_path: string | null;
  started_at: Date | string | null;
  error: StepResult['error'] | null;
  approval: StepResult['approval'] | null;
}

interface ApprovalRow {
  task_id: string;
  step_index: number;
  action: string;
  decision: 'pending' | 'approved' | 'rejected';
  approver: string | null;
  requested_at: Date | string;
  decided_at: Date | string | null;
  target_name: string;
  description: string | null;
  screenshot_path: string | null;
  page_url: string | null;
  page_title: string | null;
  page_text_sample: string | null;
}

const SCHEMA_PATH = fileURLToPath(new URL('../../scripts/db/schema.sql', import.meta.url));

function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** jsonb 参数必须显式字符串化：pg 会把 JS 数组序列化成 Postgres 数组字面量，导致 json 解析失败。 */
function json(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/** 共享连接池；任务仓库与 storageState 仓库共用，关闭时只关一次。 */
export class PostgresConnection {
  private pool?: Pool;
  private closed = false;
  private initialized = false;

  constructor(private readonly dsn: string) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    this.pool = new Pool({
      connectionString: this.dsn,
      max: 5,
      application_name: 'browser-agent',
    });

    try {
      await this.pool.query('SELECT 1');
      await this.pool.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
      this.initialized = true;
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  describe(): string {
    try {
      const url = new URL(this.dsn);
      return `${url.hostname}:${url.port || '5432'}/${url.pathname.replace(/^\//, '')}`;
    } catch {
      return '(无法解析 DSN)';
    }
  }

  requirePool(): Pool {
    if (!this.pool) throw new Error('Postgres 未连接');
    return this.pool;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pool = this.pool;
    this.pool = undefined;
    if (pool) await pool.end().catch(() => undefined);
  }
}

/**
 * Postgres 任务仓库：browser_task / browser_task_step / browser_approval。
 * DSN 只从环境变量进入；日志不打印 DSN / cookie。
 */
export class PostgresTaskRepository implements TaskRepository {
  readonly driver = 'postgres' as const;

  constructor(
    private readonly connection: PostgresConnection,
    private readonly logger: Logger
  ) {}

  async init(): Promise<void> {
    await this.connection.init();
  }

  async loadAll(): Promise<TaskRecord[]> {
    const pool = this.connection.requirePool();
    const taskRows = await pool.query<TaskRow>('SELECT * FROM browser_task ORDER BY created_at');
    const stepRows = await pool.query<StepRow>(
      'SELECT * FROM browser_task_step ORDER BY task_id, step_index'
    );
    const approvalRows = await pool.query<ApprovalRow>(
      'SELECT * FROM browser_approval ORDER BY task_id, id'
    );

    const stepsByTask = new Map<string, StepResult[]>();
    for (const row of stepRows.rows) {
      const list = stepsByTask.get(row.task_id) ?? [];
      list.push({
        index: row.step_index,
        action: row.action,
        description: row.description,
        status: row.status,
        startedAt: iso(row.started_at) ?? '',
        durationMs: row.duration_ms,
        validations: row.validations ?? [],
        ...(row.target ? { target: row.target } : {}),
        ...(row.screenshot_path ? { screenshot: row.screenshot_path } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(row.approval ? { approval: row.approval } : {}),
      });
      stepsByTask.set(row.task_id, list);
    }

    const approvalsByTask = new Map<string, ApprovalRecord[]>();
    for (const row of approvalRows.rows) {
      const list = approvalsByTask.get(row.task_id) ?? [];
      list.push({
        request: {
          stepIndex: row.step_index,
          action: row.action,
          description: row.description ?? '',
          targetName: row.target_name,
          requestedAt: iso(row.requested_at) ?? '',
          ...(row.screenshot_path ? { screenshot: row.screenshot_path } : {}),
          ...(row.page_url ? { pageUrl: row.page_url } : {}),
          ...(row.page_title ? { pageTitle: row.page_title } : {}),
          ...(row.page_text_sample ? { pageTextSample: row.page_text_sample } : {}),
        },
        ...(row.decision === 'pending'
          ? {}
          : {
              decision: {
                decision: row.decision,
                at: iso(row.decided_at) ?? '',
                ...(row.approver ? { actor: row.approver } : {}),
              },
            }),
      });
      approvalsByTask.set(row.task_id, list);
    }

    this.logger.info('storage.postgres_loaded', { tasks: taskRows.rowCount ?? 0 });

    return taskRows.rows.map((row) => ({
      taskId: row.task_id,
      taskType: row.task_type,
      tenantId: row.tenant_id,
      userId: row.user_id,
      target: { system: row.target_system, url: row.target_url },
      input: row.input ?? {},
      executionMode: row.execution_mode,
      status: row.status,
      createdAt: iso(row.created_at) ?? '',
      updatedAt: iso(row.updated_at) ?? '',
      ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
      ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
      steps: stepsByTask.get(row.task_id) ?? [],
      policyViolations: row.result?.policyViolations ?? [],
      approvals: approvalsByTask.get(row.task_id) ?? [],
      ...(row.error ? { error: row.error } : {}),
      ...(row.session_summary ? { sessionSummary: row.session_summary } : {}),
      ...(row.pending_approval ? { pendingApproval: row.pending_approval } : {}),
      cancelRequested: row.cancel_requested,
    }));
  }

  async save(task: TaskRecord): Promise<void> {
    const pool = this.connection.requirePool();
    const db: PoolClient = await pool.connect();

    try {
      await db.query('BEGIN');
      await db.query(
        `INSERT INTO browser_task (
          task_id, tenant_id, user_id, task_type, status, target_system, target_url,
          input, execution_mode, created_at, updated_at, started_at, finished_at,
          result, error, session_summary, pending_approval, cancel_requested
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
        )
        ON CONFLICT (task_id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          user_id = EXCLUDED.user_id,
          task_type = EXCLUDED.task_type,
          status = EXCLUDED.status,
          target_system = EXCLUDED.target_system,
          target_url = EXCLUDED.target_url,
          input = EXCLUDED.input,
          execution_mode = EXCLUDED.execution_mode,
          updated_at = EXCLUDED.updated_at,
          started_at = EXCLUDED.started_at,
          finished_at = EXCLUDED.finished_at,
          result = EXCLUDED.result,
          error = EXCLUDED.error,
          session_summary = EXCLUDED.session_summary,
          pending_approval = EXCLUDED.pending_approval,
          cancel_requested = EXCLUDED.cancel_requested`,
        [
          task.taskId,
          task.tenantId,
          task.userId,
          task.taskType,
          task.status,
          task.target.system,
          task.target.url,
          json(task.input),
          task.executionMode,
          task.createdAt,
          task.updatedAt,
          task.startedAt ?? null,
          task.finishedAt ?? null,
          json({ totals: computeTotals(task.steps), policyViolations: task.policyViolations }),
          json(task.error),
          json(task.sessionSummary),
          json(task.pendingApproval),
          task.cancelRequested,
        ]
      );

      await db.query('DELETE FROM browser_task_step WHERE task_id = $1', [task.taskId]);
      for (const step of task.steps) {
        await db.query(
          `INSERT INTO browser_task_step (
            task_id, step_index, action, target, description, status, expected, actual,
            validations, duration_ms, screenshot_path, started_at, error, approval
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            task.taskId,
            step.index,
            step.action,
            json(step.target),
            step.description,
            step.status,
            json(step.validations.map((item) => item.expected ?? '')),
            json(step.validations.map((item) => item.actual ?? '')),
            json(step.validations),
            step.durationMs,
            step.screenshot ?? null,
            step.startedAt || null,
            json(step.error),
            json(step.approval),
          ]
        );
      }

      await db.query('DELETE FROM browser_approval WHERE task_id = $1', [task.taskId]);
      for (const approval of task.approvals) {
        await db.query(
          `INSERT INTO browser_approval (
            task_id, step_index, action, decision, approver, requested_at, decided_at,
            target_name, description, screenshot_path, page_url, page_title, page_text_sample
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            task.taskId,
            approval.request.stepIndex,
            approval.request.action,
            approval.decision?.decision ?? 'pending',
            approval.decision?.actor ?? null,
            approval.request.requestedAt,
            approval.decision?.at ?? null,
            approval.request.targetName,
            approval.request.description,
            approval.request.screenshot ?? null,
            approval.request.pageUrl ?? null,
            approval.request.pageTitle ?? null,
            approval.request.pageTextSample ?? null,
          ]
        );
      }

      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

/** Postgres storageState 归档：browser_session_state。 */
export class PostgresSessionStateRepository implements SessionStateRepository {
  readonly driver = 'postgres' as const;

  constructor(private readonly connection: PostgresConnection) {}

  async init(): Promise<void> {
    await this.connection.init();
  }

  async load(key: SessionStateKey): Promise<StorageStateInput | undefined> {
    const pool = this.connection.requirePool();
    const result = await pool.query<{ storage_state: StorageStateInput }>(
      `SELECT storage_state FROM browser_session_state
       WHERE tenant_id = $1 AND user_id = $2 AND task_type = $3`,
      [key.tenantId, key.userId, key.taskType]
    );
    return result.rows[0]?.storage_state;
  }

  async save(key: SessionStateKey, state: StorageStateInput): Promise<void> {
    const pool = this.connection.requirePool();
    await pool.query(
      `INSERT INTO browser_session_state (tenant_id, user_id, task_type, storage_state, updated_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, user_id, task_type) DO UPDATE SET
         storage_state = EXCLUDED.storage_state,
         updated_at = EXCLUDED.updated_at`,
      [key.tenantId, key.userId, key.taskType, json(state), new Date().toISOString()]
    );
  }

  ref(key: SessionStateKey): string {
    return `pg:${key.tenantId}/${key.userId}/${key.taskType}`;
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

export function createPostgresRepositories(dsn: string, logger: Logger): {
  connection: PostgresConnection;
  tasks: PostgresTaskRepository;
  sessions: PostgresSessionStateRepository;
} {
  const connection = new PostgresConnection(dsn);
  return {
    connection,
    tasks: new PostgresTaskRepository(connection, logger),
    sessions: new PostgresSessionStateRepository(connection),
  };
}
