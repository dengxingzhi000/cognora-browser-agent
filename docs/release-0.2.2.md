# v0.2.2 — 浏览器执行服务

依赖升级与兼容性说明。

## 升级表

| 包 | 类型 | 升级前 | 升级后 | registry 最新 | 约束 / 处理 |
|---|---|---|---|---|---|
| `fastify` | dependencies | 5.12.8 | 5.12.8 | 5.12.8 | 已是最新，无变更 |
| `pg` | dependencies | 8.23.1 | 8.23.1 | 8.23.1 | 已是最新，无变更 |
| `@types/node` | devDependencies | 24.19.2 | 24.19.2 | 26.6.6 | **按住**：运行时为 Node 24.22.0，保留 24.x 最新；`@types/pg` 只要求 `*`，无版本上限 |
| `@types/pg` | devDependencies | 8.23.1 | 8.23.1 | 8.23.1 | 已是最新，无变更 |
| `playwright` | devDependencies | 1.64.1 | 1.64.1 | 1.64.1 | 已是最新；继续使用已装 Chromium 1248，未重新下载浏览器 |
| `tsx` | devDependencies | 4.23.15 | 4.23.15 | 4.23.15 | 已是最新，无变更 |
| `typescript` | devDependencies | 5.9.3 | 7.0.2 | 7.0.2 | 升级到最新；`tsc --noEmit` 已通过 |

## 兼容性说明

- **TypeScript 7.0.2**：本仓库为 ESM（`"type": "module"`），`tsconfig` 保持 `module: ESNext` /
  `moduleResolution: Bundler`；`npm run typecheck` 0 错误。测试与 selftest 仍由 `tsx` 运行，
  `tsx@4.23.15` 没有对 TypeScript 的 peer 版本约束，未出现 ESM/CJS 混用问题。
- **`@types/node` 按住 24.x**：升级到 26.6.6 虽能通过本地 `tsc`，但类型面向 Node 26，
  运行时仍是 Node 24.22.0，可能让代码编译通过却调用 Node 24 不存在的 API。选择
  `@types/node@24.19.2`（24.x 最新），并把 `package.json` 范围收到 `^24.19.2`。
- **Playwright 不动**：`playwright@1.64.1` 已是 registry 最新，已装 Chromium revision 1248
  （`chrome.exe` 实际版本 `156.0.8078.4`）。本项目使用 `channel: 'chromium'`，未触发浏览器下载，
  也没有“升级后未验证浏览器”的情况。
- **运行时依赖**：`fastify@5.12.8`、`pg@8.23.1` 已是当前最新，本轮没有为了版本号而改动。

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
| GET | `/healthz` | 存活探针 |

状态：`PENDING → RUNNING → COMPLETED | FAILED | CANCELLED | WAITING_APPROVAL`；
`WAITING_APPROVAL → RUNNING → COMPLETED | FAILED`；非法迁移 / 重复审批返回 409。

## 已验证

- `npm run typecheck`：0 错误。
- `npm test`（无 DSN）：30 tests / 28 passed / 2 skipped / 0 failed。
- `npm run selftest`：20/20 通过。
- `npm outdated`（升级后）：只剩 `@types/node` 26.6.6，属于主动按住的 major。
- **Postgres 未在本轮执行**：本机未设置 `BROWSER_AGENT_PG_DSN`，且没有 `.env`；两条 Postgres
  用例按 skip 报告。未连接、未创建 schema、未写库，因此不声称本轮数据库复跑通过。
  0.2.1 已验证的 `db_browser_agent` 四表链路保持不变。

## 已知限制

- 进程重启：`PENDING / RUNNING / WAITING_APPROVAL` 标记 `FAILED(WORKER_RESTARTED)`，不自动续跑。
- API 无鉴权，默认只监听 `127.0.0.1`；部署需网关/网络隔离。
- 仅 Chromium / Chrome 内核；iframe 仅支持 name/title。
- 等待审批会长期保留浏览器会话，没有审批超时 / 会话回收。
- 写穿持久化为最终一致；同 key 并发 storageState 最后写入者覆盖。
- 真实商品页依赖本地 `scm-web`、既有后端与稳定 `X-Device-ID`。
- 未做长时间稳定性、并发压测与多实例验证，不构成「生产可用」结论。

## 提交

- `chore(deps): upgrade TypeScript to 7.0.2 and keep @types/node on Node 24`
- `chore(release): publish 0.2.2 with dependency upgrade notes`
