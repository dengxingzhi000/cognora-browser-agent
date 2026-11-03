-- browser-agent 独立库表结构。只用于 db_browser_agent，不触碰 db_agent 或业务库。
-- 由 scripts/db/init.ts 自动执行；也可手工 psql -f scripts/db/schema.sql。

CREATE TABLE IF NOT EXISTS browser_task (
  task_id            text PRIMARY KEY,
  tenant_id          text NOT NULL,
  user_id            text NOT NULL DEFAULT 'default',
  task_type          text NOT NULL,
  status             text NOT NULL CHECK (
    status IN ('PENDING', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED')
  ),
  target_system      text NOT NULL,
  target_url         text NOT NULL,
  input              jsonb NOT NULL DEFAULT '{}'::jsonb,
  execution_mode     text NOT NULL CHECK (execution_mode IN ('auto', 'require_approval')),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  started_at         timestamptz,
  finished_at        timestamptz,
  result             jsonb,
  error              jsonb,
  session_summary    jsonb,
  pending_approval   jsonb,
  cancel_requested   boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_browser_task_tenant_status
  ON browser_task (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_browser_task_type
  ON browser_task (task_type, created_at DESC);

CREATE TABLE IF NOT EXISTS browser_task_step (
  task_id          text NOT NULL REFERENCES browser_task (task_id) ON DELETE CASCADE,
  step_index       integer NOT NULL,
  action           text NOT NULL,
  target           jsonb,
  description      text NOT NULL,
  status           text NOT NULL CHECK (status IN ('success', 'failed', 'blocked')),
  expected         jsonb,
  actual           jsonb,
  validations      jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms      integer NOT NULL DEFAULT 0,
  screenshot_path  text,
  started_at       timestamptz,
  error            jsonb,
  approval         jsonb,
  PRIMARY KEY (task_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_browser_task_step_task
  ON browser_task_step (task_id, step_index);

CREATE TABLE IF NOT EXISTS browser_approval (
  id                bigserial PRIMARY KEY,
  task_id           text NOT NULL REFERENCES browser_task (task_id) ON DELETE CASCADE,
  step_index        integer NOT NULL,
  action            text NOT NULL DEFAULT '',
  decision          text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected')),
  approver          text,
  requested_at      timestamptz NOT NULL,
  decided_at        timestamptz,
  target_name       text NOT NULL,
  description       text,
  screenshot_path   text,
  page_url          text,
  page_title        text,
  page_text_sample  text
);

CREATE INDEX IF NOT EXISTS idx_browser_approval_task
  ON browser_approval (task_id, id);

CREATE TABLE IF NOT EXISTS browser_session_state (
  tenant_id      text NOT NULL,
  user_id        text NOT NULL DEFAULT 'default',
  task_type      text NOT NULL,
  storage_state  jsonb NOT NULL,
  updated_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id, task_type)
);
