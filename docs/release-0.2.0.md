# v0.2.0 — 浏览器执行服务

## 部署 / 使用

1. `npm ci`
2. 持久化（推荐）：设置 `BROWSER_AGENT_PG_DSN` 指向独立库 `db_browser_agent`，执行
   `npm run db:init`（幂等建库 + 四张表）。
   - `BROWSER_STORAGE_DRIVER=auto`：有 DSN 且连得上用 Postgres，否则文件回落。
   - `BROWSER_STORAGE_DRIVER=postgres`：优先 Postgres，连接失败仍回落文件。
   - `BROWSER_STORAGE_DRIVER=file` / `memory`：显式选择文件 / 内存。
3. `npm run serve`（默认 `127.0.0.1:4320`）。
4. CLI：`npm run spike` 默认真实商品页探针；真实页不可用时自动回落 `fixture`。
   `BROWSER_DEFAULT_TARGET=fixture` 可强制离线靶场。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/browser/tasks` | 创建任务 |
| GET | `/api/v1/browser/tasks/{id}` | 状态 / 结果 / 会话摘要 |
| GET | `/api/v1/browser/tasks/{id}/steps` | 步骤、校验、截图、审批 |
| POST | `/api/v1/browser/tasks/{id}/approve` | 批准并从断点继续 |
| POST | `/api/v1/browser/tasks/{id}/reject` | 驳回（CANCELLED） |
| POST | `/api/v1/browser/tasks/{id}/cancel` | 取消 |
| GET | `/api/v1/browser/tools` | 动作白名单 |
| GET | `/api/v1/browser/workflows` | 内置 taskType |

状态：`PENDING → RUNNING → COMPLETED | FAILED | CANCELLED | WAITING_APPROVAL`；
`WAITING_APPROVAL → RUNNING → COMPLETED | FAILED`；非法迁移 / 重复审批返回 409。

## 已验证

- `npm test`（无 DSN）：30 tests，28 passed，2 skipped（Postgres 用例），0 failed。
- `npm test`（有 DSN）：30 tests，30 passed；Postgres 完整链路在临时 schema 内验证后删除。
- `npm run typecheck`：通过。
- 真实商品页：`prod-brand` 200（total 6）、`prod-spu` 200（total 9）、`prod-category`
  200（total 3）、详情 200；真实草稿保存 POST 200 + 提示「创建成功」；
  上架保存在 `require_approval` 下 BLOCKED 并截图。

## 已知限制

- 进程重启：`PENDING / RUNNING / WAITING_APPROVAL` 标记 `FAILED(WORKER_RESTARTED)`，不自动续跑。
- API 无鉴权，默认只监听 `127.0.0.1`；生产需网关/网络隔离。
- 仅 Chromium / Chrome 内核；等待审批会长期保留浏览器会话。
- 真实商品页依赖本地 `scm-web`、VM 后端与稳定 `X-Device-ID`；未做长时间稳定性验证。
- 持久化为最终一致；同 key 并发 storageState 最后写入者覆盖。

## 提交

按服务骨架、浏览器/自动化、观测、安全、持久化、文档、测试、CI 分批提交。
