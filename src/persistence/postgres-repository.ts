import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient } from 'pg';

import type { Logger } from '../observability/logger.js';
import type { ApprovalRecord, StepResult } from '../core/types.js';
import { computeTotals } from '../core/types.js';
import { LeaseLostError } from '../core/errors.js';
import type { TaskRecord, TaskStatus } from '../tasks/task-types.js';
import type {
  NoticeKind,
  SessionStateKey,
  SessionStateRepository,
  StorageStateInput,
  TaskNotice,
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
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  heartbeat_at: Date | string | null;
  version: string | number | null;
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

interface NoticeRow {
  id: string | number;
  task_id: string;
  kind: NoticeKind;
  payload: Record<string, unknown> | null;
}

const SCHEMA_PATH = fileURLToPath(new URL('../../scripts/db/schema.sql', import.meta.url));

const LEASE_TERMINAL = `('COMPLETED','FAILED','CANCELLED')`;

function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** jsonb 参数必须显式字符串化：pg 会把 JS 数组序列化成 Postgres 数组字面量，导致 json 解析失败。 */
function json(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function mapSteps(rows: StepRow[]): Map<string, StepResult[]> {
  const stepsByTask = new Map<string, StepResult[]>();
  for (const row of rows) {
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
  return stepsByTask;
}

function mapApprovals(rows: ApprovalRow[]): Map<string, ApprovalRecord[]> {
  const approvalsByTask = new Map<string, ApprovalRecord[]>();
  for (const row of rows) {
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
  return approvalsByTask;
}

function mapTask(
  row: TaskRow,
  stepsByTask: Map<string, StepResult[]>,
  approvalsByTask: Map<string, ApprovalRecord[]>
): TaskRecord {
  return {
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
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    version: Number(row.version ?? 0),
  };
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
      max: 8,
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
 *
 * 多实例语义：
 * - claimNext 用 UPDATE ... WHERE (无租约或已过期) ... RETURNING，单语句原子认领；
 * - saveLeased 带 lease_owner + 未过期的条件，0 行 = 租约丢失（抛 LeaseLostError）；
 * - 租约过期才允许接管，存活实例的心跳会把 lease_expires_at 往后推。
 */
export class PostgresTaskRepository implements TaskRepository {
  readonly driver = 'postgres' as const;
  readonly supportsLeases = true;

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

    const stepsByTask = mapSteps(stepRows.rows);
    const approvalsByTask = mapApprovals(approvalRows.rows);

    this.logger.info('storage.postgres_loaded', { tasks: taskRows.rowCount ?? 0 });

    return taskRows.rows.map((row) => mapTask(row, stepsByTask, approvalsByTask));
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    const pool = this.connection.requirePool();
    const taskRows = await pool.query<TaskRow>(
      'SELECT * FROM browser_task WHERE task_id = $1',
      [taskId]
    );
    const row = taskRows.rows[0];
    if (!row) return undefined;

    const [stepRows, approvalRows] = await Promise.all([
      pool.query<StepRow>(
        'SELECT * FROM browser_task_step WHERE task_id = $1 ORDER BY step_index',
        [taskId]
      ),
      pool.query<ApprovalRow>(
        'SELECT * FROM browser_approval WHERE task_id = $1 ORDER BY id',
        [taskId]
      ),
    ]);

    return mapTask(row, mapSteps(stepRows.rows), mapApprovals(approvalRows.rows));
  }

  /**
   * 原子认领：只有 PENDING（无人持有）或 RUNNING 且租约已过期的任务可被取走。
   * 子查询用 FOR UPDATE SKIP LOCKED，两个实例并发时只有一个能更新到该行。
   */
  async claimNext(ownerId: string, leaseMs: number): Promise<TaskRecord | undefined> {
    const pool = this.connection.requirePool();
    const result = await pool.query<TaskRow>(
      `UPDATE browser_task
          SET status = 'RUNNING',
              lease_owner = $1,
              lease_expires_at = now() + ($2::bigint || ' milliseconds')::interval,
              heartbeat_at = now(),
              started_at = COALESCE(started_at, now()),
              updated_at = now(),
              version = version + 1
        WHERE task_id = (
          SELECT task_id
            FROM browser_task
           WHERE (status = 'PENDING' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
              OR (status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *`,
      [ownerId, leaseMs]
    );

    const row = result.rows[0];
    if (!row) return undefined;

    const claimed = await this.getTask(row.task_id);
    if (!claimed) return undefined;

    this.logger.info('storage.task_claimed', {
      taskId: row.task_id,
      ownerId,
      leaseMs,
      version: claimed.version,
    });
    return claimed;
  }

  async heartbeat(taskId: string, ownerId: string, leaseMs: number): Promise<boolean> {
    const pool = this.connection.requirePool();
    const result = await pool.query(
      `UPDATE browser_task
          SET heartbeat_at = now(),
              lease_expires_at = now() + ($3::bigint || ' milliseconds')::interval
        WHERE task_id = $1
          AND lease_owner = $2
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > now()`,
      [taskId, ownerId, leaseMs]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async releaseLease(taskId: string, ownerId: string): Promise<void> {
    const pool = this.connection.requirePool();
    await pool.query(
      `UPDATE browser_task
          SET lease_expires_at = NULL,
              heartbeat_at = NULL,
              updated_at = now()
        WHERE task_id = $1 AND lease_owner = $2`,
      [taskId, ownerId]
    );
  }

  /**
   * 只回收「租约已过期」的任务：
   * - 过期 RUNNING → PENDING（可被任意实例重新认领，至少一次语义）；
   * - 过期 WAITING_APPROVAL → FAILED(WORKER_RESTARTED)（持有进程已消失，浏览器会话不可恢复）。
   * 存活实例的任务租约被心跳持续续期，不会被这里误伤。
   */
  async recoverExpiredLeases(): Promise<number> {
    const pool = this.connection.requirePool();

    const running = await pool.query(
      `UPDATE browser_task
          SET status = 'PENDING',
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              started_at = NULL,
              updated_at = now(),
              version = version + 1
        WHERE status = 'RUNNING'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
        RETURNING task_id`,
      []
    );

    const waiting = await pool.query(
      `UPDATE browser_task
          SET status = 'FAILED',
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              finished_at = now(),
              updated_at = now(),
              version = version + 1,
              pending_approval = NULL,
              error = jsonb_build_object(
                'name', 'WorkerRestarted',
                'code', 'WORKER_RESTARTED',
                'message', '租约过期，审批等待的浏览器会话已不可恢复；任务按失败处理'
              )
        WHERE status = 'WAITING_APPROVAL'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
        RETURNING task_id`,
      []
    );

    const reclaimed = (running.rowCount ?? 0) + (waiting.rowCount ?? 0);
    if (reclaimed > 0) {
      this.logger.warn('storage.expired_leases_reclaimed', {
        requeued: running.rowCount ?? 0,
        failedWaiting: waiting.rowCount ?? 0,
      });
    }
    return reclaimed;
  }

  async requestWake(
    taskId: string,
    kind: NoticeKind,
    payload: Record<string, unknown>
  ): Promise<void> {
    const pool = this.connection.requirePool();
    await pool.query(
      `INSERT INTO browser_task_notification (task_id, kind, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (task_id, kind) WHERE consumed_at IS NULL DO NOTHING`,
      [taskId, kind, json(payload)]
    );
  }

  async consumeWakes(ownerId: string): Promise<TaskNotice[]> {
    const pool = this.connection.requirePool();
    const result = await pool.query<NoticeRow>(
      `WITH claimed AS (
         UPDATE browser_task_notification n
            SET consumed_at = now(), consumed_by = $1
          WHERE n.id IN (
            SELECT n2.id
              FROM browser_task_notification n2
              JOIN browser_task t ON t.task_id = n2.task_id
             WHERE n2.consumed_at IS NULL
               AND t.lease_owner = $1
             ORDER BY n2.created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 20
          )
          RETURNING n.id, n.task_id, n.kind, n.payload
       )
       SELECT * FROM claimed`,
      [ownerId]
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      taskId: row.task_id,
      kind: row.kind,
      payload: row.payload ?? {},
    }));
  }

  async save(task: TaskRecord): Promise<void> {
    await this.writeTask(task);
  }

  async saveLeased(task: TaskRecord, ownerId: string, leaseMs: number): Promise<void> {
    await this.writeTask(task, { ownerId, leaseMs });
  }

  /** 全量写回（任务 + 步骤 + 审批）。带 guard 时 0 行即抛 LeaseLostError。 */
  private async writeTask(
    task: TaskRecord,
    guard?: { ownerId: string; leaseMs: number }
  ): Promise<void> {
    const pool = this.connection.requirePool();
    const db: PoolClient = await pool.connect();

    const leaseSet = guard
      ? `lease_owner = $19,
         lease_expires_at = CASE WHEN $5 IN ${LEASE_TERMINAL}
                          THEN NULL
                          ELSE now() + ($20::bigint || ' milliseconds')::interval END,
         heartbeat_at = now(),`
      : '';
    // 终态行不再续租，但允许持有者补写（例如随后写入 summaryPath）；认领者不同则仍拒绝。
    const guardClause = guard
      ? `AND browser_task.lease_owner = $19
         AND (
           browser_task.lease_expires_at > now()
           OR browser_task.status IN ${LEASE_TERMINAL}
         )`
      : '';

    const values: unknown[] = [
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
      guard?.ownerId ?? null,
    ];
    // $20（leaseMs）只有守卫分支引用；无守卫时传 20 个参数会被 pg 拒绝。
    if (guard) values.push(guard.leaseMs);

    try {
      await db.query('BEGIN');
      const result = await db.query(
        `INSERT INTO browser_task (
          task_id, tenant_id, user_id, task_type, status, target_system, target_url,
          input, execution_mode, created_at, updated_at, started_at, finished_at,
          result, error, session_summary, pending_approval, cancel_requested,
          lease_owner, lease_expires_at, heartbeat_at, version
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          $19,NULL,NULL,1
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
          cancel_requested = EXCLUDED.cancel_requested,
          ${leaseSet}
          version = browser_task.version + 1
        WHERE true ${guardClause}`,
        values
      );

      if (guard && (result.rowCount ?? 0) === 0) {
        const probe = await db.query<{
          status: string;
          lease_owner: string | null;
          lease_expires_at: Date | null;
          version: string;
        }>(
          'SELECT status, lease_owner, lease_expires_at, version FROM browser_task WHERE task_id = $1',
          [task.taskId]
        );
        this.logger.warn('storage.lease_guard_rejected', {
          taskId: task.taskId,
          ownerId: guard.ownerId,
          writeStatus: task.status,
          dbStatus: probe.rows[0]?.status,
          dbOwner: probe.rows[0]?.lease_owner,
          leaseExpiresAt: iso(probe.rows[0]?.lease_expires_at),
          dbVersion: probe.rows[0]?.version,
        });
        throw new LeaseLostError(task.taskId, guard.ownerId);
      }

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
