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
  cancel_requested   boolean NOT NULL DEFAULT false,
  -- 多实例租约：lease_owner 是实例自述身份；lease_expires_at 到期后其他实例可接管。
  lease_owner        text,
  lease_expires_at   timestamptz,
  heartbeat_at       timestamptz,
  -- 单调版本号：每次认领 / 写回 +1，便于排查「谁最后写了什么」。
  version            bigint NOT NULL DEFAULT 0
);

-- 兼容已有库：CREATE TABLE IF NOT EXISTS 不会补列，这里显式补齐。
ALTER TABLE browser_task ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE browser_task ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE browser_task ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE browser_task ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_browser_task_tenant_status
  ON browser_task (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_browser_task_type
  ON browser_task (task_type, created_at DESC);

-- 认领用部分索引：只覆盖「可被认领」的行（PENDING 或租约已过期），减少扫描面。
CREATE INDEX IF NOT EXISTS idx_browser_task_claimable
  ON browser_task (created_at)
  WHERE status = 'PENDING' OR lease_expires_at IS NOT NULL;

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

-- 跨实例审批唤醒：非租约持有者收到 approve 后写一行，持有者轮询消费。
-- 每个任务的同类通知只保留一条未消费行（partial unique index），重复点击不会堆积。
CREATE TABLE IF NOT EXISTS browser_task_notification (
  id             bigserial PRIMARY KEY,
  task_id        text NOT NULL REFERENCES browser_task (task_id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('approve', 'reject', 'cancel')),
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  consumed_at    timestamptz,
  consumed_by    text
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_task_notification_pending
  ON browser_task_notification (task_id, kind)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_browser_task_notification_open
  ON browser_task_notification (created_at)
  WHERE consumed_at IS NULL;
