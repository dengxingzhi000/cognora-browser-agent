# v0.2.3 — 稳定性验证与 CI Postgres 真跑

本版本没有新增业务能力，重点是把此前按 skip 报告的 Postgres 用例放进 CI 真实执行，并补充
一次可复现的连续/并发验证。

## 变更

- 新增 `tests/reuse-stability.test.ts`：
  - 连续 10 个同 key 任务复用同一 storageState：**10 COMPLETED / 30 steps / 1 ref**（7.79s）。
  - 4 个租户并发执行：**4 COMPLETED / 12 steps / 4 refs**（2.88s），域名策略违规 0。
- CI 增加一次性 Postgres 17 service（`trust`、无密码、仅 runner 内可达），先执行
  `npm run db:init` 建四张表，再跑 `npm test`。

## 验证

- CI（真实 Postgres）：**32 tests / 32 passed / 0 skipped / 0 failed**。
  - `Postgres 完整链路：创建任务 → 落库 → 审批 → 断点恢复 → 步骤可查` 通过（约 1.47s）。
  - `Postgres 集成检查：DSN 连通性与表结构` 通过（约 40.9ms）。
- 本地（无 DSN）：32 tests / 30 passed / 2 skipped / 0 failed。
- `npm run typecheck`：0 错误；`npm run selftest`：20/20 通过。
- 稳定性用例只在真实 Chromium + fixture 上做短时验证，不代表长时间稳定性。

## 部署 / 使用

1. `npm ci`
2. 持久化（推荐）：设置 `BROWSER_AGENT_PG_DSN` 指向独立库 `db_browser_agent`，执行
   `npm run db:init`。
3. `npm run serve`（默认 `127.0.0.1:4320`）。

接口与状态机不变：`POST/GET /api/v1/browser/tasks`、`approve` / `reject` / `cancel`、
`GET /healthz`；状态 `PENDING → RUNNING → COMPLETED | FAILED | CANCELLED | WAITING_APPROVAL`。

## 已知限制

- 稳定性验证只覆盖短时连续/并发；**小时级长跑、内存增长、多实例归属、同 key 并发写回竞态
  未验证**。
- **VM 库 `db_browser_agent` 的本地复跑因凭据策略未执行**；CI 使用的是每次任务创建的一次性
  service，不是 VM 库。不声称 VM 库已在 0.2.3 复跑通过。
- 进程重启后 `PENDING / RUNNING / WAITING_APPROVAL` 标记 `FAILED(WORKER_RESTARTED)`，不续跑。
- API 无鉴权，默认只监听 `127.0.0.1`；等待审批会保留浏览器会话，没有审批超时 / 会话回收。
- 仅 Chromium；iframe 仅支持 name/title；写穿持久化为最终一致。
- 真实商品页依赖本地 `scm-web`、既有后端与稳定 `X-Device-ID`。

## 提交

- `8c66bf7` test: verify consecutive and concurrent storageState reuse
- `1c832ab` ci: run Postgres tests against an ephemeral service
