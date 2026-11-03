# browser-agent-spike

Playwright + 结构化动作意图的**浏览器执行服务**。任务 API 负责排队、状态机、审批断点与会话归档；
执行层只接受「结构化意图」，不接受任何模型生成的脚本、CSS 选择器或坐标。

> 名称里的 spike 是历史遗留。当前代码已经是可复用的服务骨架，不再是单次验证脚本。

## 完成情况

| 批次 | 状态 | `npm test` | `npm run typecheck` |
|---|---|---|---|
| 批次 1：服务骨架 / 任务生命周期 / 审批断点 | 完成 | 21 passed | 通过 |
| 批次 2：自定义下拉 / iframe / 上传下载 / 显式等待 / 断点恢复 | 完成 | 28 passed（累计） | 通过 |
| 数据库接入：Postgres 持久化 + 文件回落 | 完成 | 30（离线 28 passed / 2 skipped；有 DSN 30 passed） | 通过 |

`npm test` 实测：离线无 DSN 时 `tests 30 / pass 28 / fail 0 / skipped 2`（两个 Postgres 测试 skip），
有 `BROWSER_AGENT_PG_DSN` 时 `tests 30 / pass 30 / fail 0 / skipped 0`。真实浏览器任务约 8 个。

### 批次 2 逐项验证

| 项 | 状态 | 覆盖测试 |
|---|---|---|
| Radix / AntD 自定义下拉（两步策略 + 回读） | 完成 | `tests/custom-select.test.ts`（1） |
| iframe（`frameLocator` + frame 作用域校验） | 完成 | `tests/iframe.test.ts`（1） |
| 文件上传 / 下载（存在、类型、大小、落盘） | 完成 | `tests/upload-download.test.ts`（2） |
| 显式等待（waitForResponse / spinner 消失 / 超时可读） | 完成 | `tests/waits.test.ts`（3） |
| 审批后从断点恢复（批准 / 驳回 / 重复批准 409） | 完成 | `tests/approval.test.ts`（1）+ `tests/api.test.ts`（2） |
| Agent 接入契约（只收结构化意图，拒绝脚本注入） | 完成 | `tests/security.test.ts`（3 条注入/域名用例） |

## 快速开始

```powershell
cd D:\ProgramProject\browser-agent-spike
npm install
npm test
npm run typecheck

# 建库建表（需要环境变量 BROWSER_AGENT_PG_DSN，且 DSN 必须指向 db_browser_agent）
$env:BROWSER_AGENT_PG_DSN="postgresql://<user>:<password>@192.168.0.121:5432/db_browser_agent"
npm run db:init

# 启动服务（API + 进程内 worker）
npm run serve
# GET http://127.0.0.1:4320/healthz
```

浏览器：本机已有 Chromium。若下载失败，可设 `BROWSER_CHANNEL=chrome` 或 `msedge`。

### 创建一个任务

```powershell
$body = @{
  taskType = 'product.create'
  tenantId = 'tenant-a'
  userId   = 'u1'
  target   = @{ system = 'fixture'; url = 'http://127.0.0.1:4310' }
  input    = @{ name = '演示商品'; brand = 'apple'; price = '199.00'; stock = '120' }
  executionMode = 'require_approval'
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4320/api/v1/browser/tasks' `
  -ContentType 'application/json' -Body $body
```

`product.create` 的第一步要求目标页有 `access_token` cookie，因此需要用同一 `(tenantId, userId, taskType)`
先跑一次 `real.login`，或直接用 `actions.run` 操作靶场页面。

## API 契约

所有端点在 `/api/v1/browser` 下。

| 方法 | 路径 | 说明 | 成功 |
|---|---|---|---|
| POST | `/tasks` | 创建任务 | `201` |
| GET | `/tasks/{id}` | 任务状态、结果、步骤、审批、会话摘要 | `200` |
| GET | `/tasks/{id}/steps` | 每步动作、耗时、状态、校验 expected/actual、截图 | `200` |
| POST | `/tasks/{id}/approve` | 批准并**从断点继续** | `200` |
| POST | `/tasks/{id}/reject` | 驳回，按 `CANCELLED` 处理 | `200` |
| POST | `/tasks/{id}/cancel` | 取消非终态任务 | `200` |
| GET | `/tools` | 动作白名单 | `200` |
| GET | `/workflows` | 内置 taskType | `200` |
| GET | `/healthz` | 存活探针 | `200` |

### 创建请求

```json
{
  "taskType": "product.create",
  "tenantId": "tenant-a",
  "userId": "u1",
  "target": { "system": "fixture", "url": "http://127.0.0.1:4310" },
  "input": {
    "name": "演示商品",
    "brand": "apple",
    "price": "199.00",
    "stock": "120",
    "description": "可选"
  },
  "executionMode": "require_approval"
}
```

- `userId` 可选，缺省为 `default`。
- `executionMode` 只能是 `auto` / `require_approval`，缺省 `auto`。
- `input.actions` 是 `actions.run` 的动作数组；每个动作仍逐条过动作白名单与域名策略。

创建成功返回：

```json
{ "taskId": "task-<uuid>", "status": "PENDING", "taskType": "product.create", "executionMode": "require_approval" }
```

`GET /tasks/{id}` 返回任务记录 + `totals`。`GET /tasks/{id}/steps` 返回：

```json
{
  "taskId": "task-...",
  "status": "COMPLETED",
  "steps": [{
    "index": 1,
    "action": "goto",
    "description": "goto http://...",
    "status": "success",
    "startedAt": "2026-11-03T...",
    "durationMs": 123,
    "validations": [{ "ok": true, "kind": "url", "expected": "...", "actual": "..." }],
    "screenshot": ".../01-goto-....png"
  }],
  "approvals": [{ "request": { "stepIndex": 3, "targetName": "提交审核" }, "decision": { "decision": "approved" } }],
  "pendingApproval": { "stepIndex": 3, "targetName": "提交审核" },
  "policyViolations": []
}
```

### 状态机

```text
PENDING ──► RUNNING ──► COMPLETED
   │          │   ├──► FAILED
   │          │   ├──► CANCELLED
   │          │   └──► WAITING_APPROVAL ──► RUNNING ──► COMPLETED | FAILED
   └──► CANCELLED                         └──► CANCELLED（reject / cancel）
```

- `approve` 只允许 `WAITING_APPROVAL`；批准后转 `RUNNING`，worker 从断点继续。
- `reject` 只允许 `WAITING_APPROVAL`；转 `CANCELLED`，`error.code = APPROVAL_REJECTED`。
- `cancel` 允许 `PENDING / RUNNING / WAITING_APPROVAL`；终态再取消返回 409。
- 所有非法迁移返回 `409 INVALID_TASK_TRANSITION`；重复 approve/reject 同样是 409。
- `WAITING_APPROVAL` 不能直接 `COMPLETED` / `FAILED`（单测覆盖）。

### 错误码

| HTTP | code | 场景 |
|---|---|---|
| 400 | `INVALID_INPUT` | 请求体、taskType、executionMode、URL 格式不合法 |
| 403 | `DOMAIN_NOT_ALLOWED` | 目标域名 / goto / iframe 不在白名单 |
| 403 | `ACTION_NOT_ALLOWED` | 动作、role、frame 或意图字段不在白名单（含脚本注入） |
| 404 | `TASK_NOT_FOUND` | 任务不存在 |
| 409 | `INVALID_TASK_TRANSITION` | 非法状态迁移 / 重复审批 |
| 500 | `INTERNAL_ERROR` | 未预期异常 |

运行期步骤错误记录在任务结果里（不再映射 HTTP）：
`ELEMENT_NOT_FOUND`、`AMBIGUOUS_TARGET`、`VALIDATION_FAILED`、`WAIT_TIMEOUT`、`UPLOAD_REJECTED`、
`DOWNLOAD_REJECTED`、`WAITING_APPROVAL`、`ANTI_AUTOMATION_DETECTED`、`ACTION_TIMEOUT`、
`TASK_CANCELLED`、`APPROVAL_REJECTED`。

## 内置 taskType

| taskType | 说明 |
|---|---|
| `product.create` | 商品表单 → 保存草稿（等 `/api/drafts` POST）→ 校验提示与列表 → 提交发布（敏感） |
| `fixture.product.create` | 与 `product.create` 相同，明确标记为离线靶场回归 |
| `real.login` | 真实 SPA 登录，成功后归档 storageState；需要 `BROWSER_PASSWORD` |
| `blocker.check` | 进入 `data-captcha` 页面，验证反自动化检测立即停止 |
| `actions.run` | 回放调用方提供的结构化动作数组（仍逐条校验） |

> CLI `npm run spike` 主流程默认走真实商品页探针（`BROWSER_DEFAULT_TARGET=real`）；
> API 任务仍按调用方给的 `target.url` 与 taskType 执行。

## 工程结构

```text
apps/
  api/server.ts                 # Fastify API + 错误码映射
  api/main.ts                   # API + 进程内 worker 组合启动
  worker/task-queue.ts          # 进程内队列，并发上限可配
  worker/browser-task-execution.ts
src/
  browser/                      # browser-manager / session-manager / profile-manager
  automation/                   # navigator / locator / form-handler / advanced-actions / action-runner
  observation/                  # page-snapshot / screenshot / state-validator
  workflows/                    # product-create / real-login / blocker / actions.run
  tools/registry.ts             # 动作白名单唯一来源
  security/                     # domain-policy / action-policy / approval
  persistence/                   # Postgres / 文件 / 内存仓库 + 存储接口
  observability/                # JSON lines 日志 + 任务 summary
  config/config.ts
  tasks/                        # 状态机 / 持久化任务 store / 任务服务
  fixtures/fixture-server.ts    # 本地靶场服务
  index.ts, selftest.ts          # 兼容 CLI
scripts/db/
  schema.sql                    # 四张 browser_* 表
  create-database.sql           # 独立库 db_browser_agent
  init.ts                       # npm run db:init：建库 + 建表
fixture/                        # 靶场 HTML（表单、会话、审批、UI 组件、iframe、上传下载、等待）
tests/                          # node:test + Fastify.inject + 真实 Chromium + Postgres
```

> 根级旧 spike 文件已在迁移完成后删除；当前入口为 `src/index.ts` → `src/cli/spike-runner.ts`。

## 执行与观测

- 每个任务独立 `BrowserContext`；服务进程复用一个 `Browser`。
- 任务进入 `WAITING_APPROVAL` 时 worker 释放队列槽位，但**保留浏览器会话**等待审批。
- 每步都记录：动作、耗时、状态、校验 expected/actual、截图路径。
- 结构化日志为 JSON Lines：`artifacts/logs/service.jsonl`，每条带 `taskId`（适用时）。
- 产物：

```text
artifacts/
├── tasks/<taskId>/task.json          # 任务级汇总快照（排查用）
├── tasks/<taskId>/screenshots/       # 每步截图 + 审批拦截截图
├── tasks/<taskId>/downloads/         # 下载落盘
├── persistence/                      # 文件回落时的任务 / storageState 归档
└── logs/service.jsonl
```

**任务状态持久化到 Postgres（`db_browser_agent`）；无 DSN 或连不上时回落文件存储。**
进程重启时会从存储加载已完成任务；`PENDING / RUNNING / WAITING_APPROVAL` 因浏览器会话已丢失，
会被标记为 `FAILED`，`error.code = WORKER_RESTARTED`（不会假装能恢复断点）。

`task.json` 只是排查快照，启动时以 Postgres / 文件仓库为准。

## 数据库接入

### 连通性与建库建表

- Postgres：`192.168.0.121:5432`，凭据只从环境变量 `BROWSER_AGENT_PG_DSN` 读取，不写进源码 / 测试 / 日志。
- 独立库：`db_browser_agent`。`scripts/db/init.ts` 会校验 DSN 的库名，指向其他库直接拒绝，绝不触碰
  `db_agent` 或业务库。
- 建表：`scripts/db/schema.sql`；`npm run db:init` 幂等执行（库不存在则建库，再建四张表）。

真实执行结果：

```text
npm run db:init
{
  "host": "192.168.0.121",
  "port": "5432",
  "database": "db_browser_agent",
  "createdDatabase": true,
  "tables": [
    "browser_approval",
    "browser_session_state",
    "browser_task",
    "browser_task_step"
  ]
}
```

### 表结构

| 表 | 关键列 |
|---|---|
| `browser_task` | `task_id` PK、`tenant_id`、`user_id`、`task_type`、`status`、`target_system`、`target_url`、`input` jsonb、`execution_mode`、`created_at`、`updated_at`、`started_at`、`finished_at`、`result` jsonb、`error` jsonb、`session_summary` jsonb、`pending_approval` jsonb、`cancel_requested` |
| `browser_task_step` | `(task_id, step_index)` PK、`action`、`target` jsonb、`status`、`expected` jsonb、`actual` jsonb、`validations` jsonb、`duration_ms`、`screenshot_path`、`started_at`、`error`、`approval` |
| `browser_approval` | `id` PK、`task_id`、`step_index`（断点）、`action`、`decision`（`pending/approved/rejected`）、`approver`、`requested_at`、`decided_at`、页面快照字段 |
| `browser_session_state` | `(tenant_id, user_id, task_type)` PK、`storage_state` jsonb、`updated_at` |

`browser_session_state` 在 `(tenantId, taskType)` 基础上增加 `user_id`，用于同租户不同用户的隔离；
不传 `userId` 时使用 `default`。cookie 内容只存于该表 / 文件回落目录，日志只记录 cookie 名，不记录值。

### 存储层接口

```ts
interface TaskRepository {
  driver: 'postgres' | 'file' | 'memory';
  init(): Promise<void>;
  loadAll(): Promise<TaskRecord[]>;
  save(task: TaskRecord): Promise<void>;
  close(): Promise<void>;
}

interface SessionStateRepository {
  driver: 'postgres' | 'file' | 'memory';
  init(): Promise<void>;
  load(key): Promise<StorageState | undefined>;
  save(key, state): Promise<void>;
  ref(key): string;
  close(): Promise<void>;
}
```

实现：

- `PostgresTaskRepository` / `PostgresSessionStateRepository`：任务 / 步骤 / 审批 / storageState 共用连接池；jsonb 参数显式 `JSON.stringify`。
- `FileTaskRepository` / `FileSessionStateRepository`：无 DSN 或连不上时回落。
- `MemoryTaskRepository` / `MemorySessionStateRepository`：显式 `BROWSER_STORAGE_DRIVER=memory` 时使用。
- `ResilientTaskRepository`：Postgres 运行期写失败时补写文件，并记录 `storage.postgres_write_failed_fallback_file`。

`TaskStore` 是内存缓存 + 串行写穿：内存立即可读，写队列串行落库；API 响应前等待写入追尾。
外部直接用 SQL 查询时按最终一致读取（见集成测试的轮询）。

### 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `BROWSER_STORAGE_DRIVER` | `auto` | `auto / postgres / file / memory` |
| `BROWSER_AGENT_PG_DSN` | 无 | Postgres DSN，必须指向 `db_browser_agent`；只从环境读取 |
| `BROWSER_PERSISTENCE_DIR` | `artifacts/persistence` | 文件回落的存储目录 |

### 真实验证

已真实执行（非模拟）：

```text
# 1) 建库建表
BROWSER_AGENT_PG_DSN=... npm run db:init
→ createdDatabase=true；四张 browser_* 表存在

# 2) Postgres 完整链路（真实 Chromium + 真实 Postgres）
BROWSER_AGENT_PG_DSN=... node --import tsx --test tests/postgres.flow.test.ts
→ 1 pass
   browser_task: WAITING_APPROVAL
   browser_task_step: 3 行，第 3 步 blocked，target/expected/actual/screenshot 均有值
   browser_approval: decision=pending，step_index=3
   approve 后：browser_task=COMPLETED，browser_approval=approved（approver=db-reviewer），
              第 3 步 success，browser_session_state 有 1 行
```

- 该完整链路测试在 `db_browser_agent` 内创建 **临时 schema** 运行，结束后 `DROP SCHEMA`；
  不写 `public` 表、不碰 `db_agent`。
- 无 DSN 时该测试与只读连通性测试都会 skip，`npm test` 仍 28 passed / 0 fail。
- 连接失败（无 DSN / 网络不可达 / 建表失败）：启动日志
  `storage.postgres_unavailable_fallback_file`，自动回落文件存储，服务照常启动；任务仍可执行。
  这是「可降级」而不是「假装持久化」——文件回落目录会在 README 和执行日志里明确标注。

## 安全边界

1. **域名白名单双保险**
   - 创建任务、`goto` 前 `assertAllowed`；
   - 每个动作前检查当前页与所有 iframe URL；
   - `BrowserContext.route('**/*')` 拦截非白名单请求并 `abort`；
   - 被拦截 URL 记入 `sessionSummary.policyViolations` / 任务 `policyViolations`。
2. **动作白名单**
   - 只允许 `goto / fill / select / selectCustom / click / upload / download / waitForResponse / waitForHidden / screenshot`；
   - role 也在白名单内；
   - 递归扫描禁止字段：`script / evaluate / expression / pageFunction / code / selector / xpath / x / y`；
   - 不接受 CSS 选择器、XPath、坐标。
3. **元素唯一性**
   - 0 个匹配 → `ELEMENT_NOT_FOUND`；多个可见匹配 → `AMBIGUOUS_TARGET`，fail closed。
4. **审批闸门**
   - 按钮名命中 `提交|发布|确认下单|审核|支付|付款|转账|confirm|submit|approve|publish|pay|checkout`
     或意图显式 `approvalRequired: true`；
   - `require_approval` 模式下先落盘页面快照，再停在 `WAITING_APPROVAL`；
   - `auto` 模式直接执行。
5. **文件动作**
   - 上传文件必须位于 `BROWSER_UPLOAD_ROOT` 内；上传前校验存在、是文件、扩展名、大小上限；
   - 下载文件名禁止路径穿越；落盘后校验扩展名与大小，并记录实际文件名。
6. **反自动化**
   - 检测 reCAPTCHA / hCaptcha / Cloudflare / `[data-captcha]` 等结构，立即截图并停止，不尝试绕过。
7. **API 无鉴权**
   - 默认只监听 `127.0.0.1`；部署时必须放在受控网络或网关之后。

## 会话隔离与复用

`storageState` 归档路径为 `sessions/<tenantId>/<userId>/<taskType>.json`。
不传 `userId` 时使用 `default`，即归档粒度为 `(tenantId, taskType)`；传入 `userId` 时额外按用户隔离，
避免同租户不同用户共享 cookie。

验证在 `tests/isolation.test.ts`，使用真实 Chromium：

- 租户 alpha 与租户 beta **并发**跑同一 `taskType`，两个任务首先访问 `/session`，都看到「无 cookie」；
- alpha 设置 `alpha`，beta 设置 `beta`，两者互不可见；
- 同租户同用户的新任务不重新登录，直接读到 `alpha`（storageState 复用）；
- 同租户不同用户的新任务读到「无 cookie」（用户隔离）；
- 两个租户的 `storageStateRef` 必须不同。

## 批次 2 实现要点

### 自定义 combobox（Radix / AntD）

`selectCustom` 是两步策略：

1. 按 role / label 点击 combobox 触发器；
2. 在弹出层选择：
   - `option.by = "role"`：`getByRole('option')`，可见且唯一才点击（Radix）；
   - `option.by = "text"`：在固定框架弹出层清单内按文本匹配
     （`.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option`、
     `[role=listbox] [role=option]`）。
3. 回读触发器文本（AntD 回退到 `.ant-select-selection-item`），与期望选项文本比对。

`fixture/custom-select-radix.html` 与 `fixture/custom-select-antd.html` 复刻两种 DOM；
测试覆盖两个真实任务。

### iframe

- `target.frame` 只接受 `name` / `title`（可选 `urlContains` 断言），内部拼受控选择器，
  不接受调用方传原始 CSS；
- 定位与唯一性检查都在 `frameLocator` 作用域内；
- 每个动作前检查所有 frame URL 是否在白名单内；
- `expect` 也支持 `frame`，可在 iframe 内断言 `role=status` / 文本 / 列表。

### 上传 / 下载

- 上传：`assertUploadPathWithin` → 存在性 / 类型 / 大小 → `setInputFiles` → 回读 `input.files`；
- 下载：`waitForEvent('download')` → 落盘到 `tasks/<taskId>/downloads` → 扩展名 / 大小校验，
  记录 `suggestedFilename` 与实际保存名。

### 显式等待

- `click` / 其他动作可带 `waitFor`：
  - `{ type: "response", urlContains, method?, statusBelow?, timeoutMs? }`
  - `{ type: "hidden", target, timeoutMs? }`
- 也可单独使用 `waitForResponse` / `waitForHidden` 动作。
- 超时错误 `WAIT_TIMEOUT` 包含：等待目标、已等时长、最后页面 URL 与 title。
- `tests/waits.test.ts` 覆盖 spinner 消失、API 200、spinner 超时、API 超时。

### 审批恢复

- 执行器持有 `cursor` 与浏览器会话；
- 敏感动作被拦截时记录 blocked 步骤并返回 `waiting_approval`；
- `/approve` 后 `run({ grantedStepIndex })` 只对断点步骤放行，后续动作继续；
- 断点步骤的结果按 `index` 覆盖（blocked → success），不会重复记录；
- `tests/approval.test.ts` 通过 `/api/counter` 计数证明「保存草稿」只执行一次，前序步骤 `startedAt` 不变。

## Agent 接入契约

只接收：

```ts
interface CreateTaskRequest {
  taskType: string;
  tenantId: string;
  userId?: string;
  target: { system: string; url: string };
  input: Record<string, unknown>;   // 仅结构化数据；不允许脚本
  executionMode: 'auto' | 'require_approval';
}
```

逐层校验：

1. **域名**：`target.url`、所有 `goto`、当前页、所有 iframe 必须通过白名单；网络层再拦一次。
2. **动作类型**：动作名 / role / frame 引用 / `waitFor` 形状必须在工具注册表允许范围内。
3. **意图结构**：递归拒绝 `script / evaluate / selector / xpath / 坐标` 等字段；
   文件路径、下载名做穿越校验。
4. **元素唯一性**：可见且唯一，否则 fail closed。
5. **审批**：敏感动作在 `require_approval` 下停在断点，人工/API 批准后才执行。

测试 `tests/security.test.ts` 覆盖：
`{ "action": "script" }`、`{ "action": "evaluate" }`、带 `selector` 的 click、
带 `x/y` 的 fill、未知 role、frame 引号注入、外部 goto、外部 target。

## 测试明细

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `tests/task-state.test.ts` | 4 | 合法 / 非法迁移、终态、WAITING 不能直接完成 |
| `tests/api.test.ts` | 8 | 创建/查询/steps、审批恢复、重复 409、reject、cancel、400/403/404、真实 HTTP、并发配置 |
| `tests/security.test.ts` | 7 | 域名、脚本注入、frame 注入、计划校验、文件路径、API 403 |
| `tests/isolation.test.ts` | 1 | 两种租户并发隔离 + storageState 复用 + 用户隔离 |
| `tests/approval.test.ts` | 1 | 真实浏览器断点续跑、截图、409 |
| `tests/custom-select.test.ts` | 1 | Radix + AntD 两种 DOM |
| `tests/iframe.test.ts` | 1 | frameLocator 定位 / 点击 / 状态断言 |
| `tests/upload-download.test.ts` | 2 | 上传下载正例、扩展名与大小拒绝 |
| `tests/waits.test.ts` | 3 | spinner / API 等待、两种超时 |
| `tests/postgres.integration.test.ts` | 1 | DSN 连通性 + 四张表结构（无 DSN skip，只读） |
| `tests/postgres.flow.test.ts` | 1 | 临时 schema 内完整落库 / 审批 / 断点恢复链路（无 DSN skip） |

有 `BROWSER_AGENT_PG_DSN` 时 30 项全部执行；无 DSN 时最后两项 skip，其余 28 项全绿。

运行方式：

```powershell
npm test          # node:test，文件串行执行，避免并行浏览器互相干扰
npm run typecheck
```

## CLI（兼容旧入口）

```powershell
npm run spike:blocker        # 不需要密码；已验证 PASSED
npm run spike                # 真实登录 + 真实页探针 + 靶场流程；需要 BROWSER_PASSWORD
npm run spike:real-product   # 仅真实登录 + 商品页探针
npm run spike -- --actions=examples/actions.json
npm run spike -- --headed / --approve
npm run selftest             # 20 项纯逻辑断言
```

## 真实商品页探活结论

2026-11-03 复测（前端由本地 `scm-web` dev server 启动）：

- 根因是**设备绑定**：登录时后端把 `X-Device-ID`（缺省为 `SHA256(User-Agent + IP)`）写入 token 的
  `deviceId` claim，后续请求必须携带同一值，否则 `Device mismatch` → 401。带上同一 device id 后：
  - `prod-brand` → **200**，`total=6`；
  - `prod-spu` → **200**，`total=9`；
  - `prod-category` → **200**，`total=3`；
  - `prod-spu/{id}` 详情 → **200**。
- 真实商品新建页 `/zh-CN/product/create` 可打开；结构化动作真实执行：
  - 9 步全部成功：`goto` → 填写名称/编码 → 自定义下拉选分类/品牌/状态（回读逐字一致）→ 填售价/描述 → 保存；
  - 保存接口 `POST /scm-product/api/v1/prod-spu` **200**，页面提示「创建成功」；
  - 草稿通过 API 回查确认存在（`status=0`），验证后已按商品编码删除，商品总数回到 9；
  - 上架保存尝试在 `require_approval` 下 **BLOCKED**，截图
    `artifacts/screenshots/20261103-122623/approval-blocked-09-保存.png`；未产生真实商品。
- 默认 CLI 主流程已切到真实商品页（`BROWSER_DEFAULT_TARGET=real`），默认只做填写 + 上架保存尝试，
  由审批闸门拦截，不产生业务数据；`BROWSER_DEFAULT_TARGET=fixture` 或真实页不可用时回落离线靶场。
  `fixture/` 保留为离线回归。
- 真实登录/测试数据只在浏览器进程内使用测试凭据；本仓库文件、日志、测试输出均不包含密码、
  token 或 cookie 原始值。

## 已知限制

- **重启恢复边界**：已完成任务从 Postgres / 文件恢复；`PENDING / RUNNING / WAITING_APPROVAL`
  因浏览器会话丢失会被标记 `FAILED`，`error.code = WORKER_RESTARTED`，不自动续跑。
- **写穿最终一致**：内存先更新、串行落库；API 返回前等待追尾，但外部直接用 SQL 查询可能有毫秒级延迟，
  集成测试用轮询确认。
- **等待审批占用浏览器会话**：等待任务不占队列槽位，但会话一直保留；没有审批超时 / 会话回收。
- **同 key 并发归档竞态**：同 `(tenantId, userId, taskType)` 并发任务各自独立 context，
  但 storageState 保存是「最后完成者覆盖」，没有加锁。
- **API 无鉴权**：依赖网络隔离，不能直接暴露公网。
- **取消是步骤间生效**：正在执行的 Playwright 动作不会被强制中断。
- **无失败重试 / 自愈定位**：失败即 `FAILED`，没有候选定位器。
- **iframe 仅按 name / title 引用**：不支持调用方传任意选择器，也不支持嵌套 frame 的路径表达。
- **自定义下拉只覆盖固定框架弹出层**：Radix / AntD 为本地复刻 DOM，未对真实组件库版本矩阵验证。
- **文件校验只看扩展名 / 大小**：上传不做内容扫描；下载不做 MIME / 内容嗅探。
- **仅 Chromium / Chrome 内核**：未验证 Firefox / WebKit。
- **真实商品页依赖运行环境**：需要 `localhost:3000` 前端、VM 上的 scm-auth/scm-product 与统一
  `X-Device-ID`；条件不满足时 CLI 主流程会自动回落 `fixture`。

## 下一步

1. 保持真实商品页回归（`npm run spike` 默认 real），定期确认 `X-Device-ID` 与租户头一致；
   真实页不可用时用 `BROWSER_DEFAULT_TARGET=fixture` 跑离线靶场。
2. 为服务侧任务补一个稳定的 `deviceId` 会话配置，避免直接调用商品 API 时再次触发 `Device mismatch`。
3. 接入 Agent 时只传结构化意图 + 白名单 + 审批策略；禁止把模型生成的脚本直接交给执行层。
4. 为 Postgres 增加归档 / 清理策略（历史任务、storageState 过期）与连接池监控；多实例部署时评估
   等待审批任务的会话归属。
5. 增加审批超时、等待会话回收、同 key 归档锁与失败重试。
