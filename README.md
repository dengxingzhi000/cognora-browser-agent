<div align="center">

# browser-agent-spike

### 面向 Agent 的结构化浏览器执行服务

**任务 API、状态机、审批断点、会话隔离与 Postgres 持久化。
执行层只接受结构化意图，不接受脚本、CSS 选择器或坐标。**

[![Build](https://img.shields.io/github/actions/workflow/status/dengxingzhi000/cognora-browser-agent/ci.yml?branch=master&style=flat-square&logo=github&label=build)](https://github.com/dengxingzhi000/cognora-browser-agent/actions)
[![Node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white&style=flat-square)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0.2-3178C6?logo=typescript&logoColor=white&style=flat-square)](https://www.typescriptlang.org/)
[![Playwright](https://img.shields.io/badge/Playwright-Chromium-2EAD33?logo=playwright&logoColor=white&style=flat-square)](https://playwright.dev/)
[![Persistence](https://img.shields.io/badge/persistence-postgres%20%7C%20file%20%7C%20memory-4169E1?style=flat-square)](./scripts/db/schema.sql)
[![Version](https://img.shields.io/badge/version-0.2.4-blue?style=flat-square)](https://github.com/dengxingzhi000/cognora-browser-agent/releases/tag/v0.2.4)

[快速开始](#快速开始) · [能力概览](#能力概览) · [技术栈](#技术栈) · [架构](#架构) · [覆盖范围](#覆盖范围) · [API](#api-契约) · [持久化](#持久化) · [安全](#安全边界) · [测试](#测试与-ci) · [限制](#已知限制)

<code>npm ci && npm test && npm run typecheck</code>

</div>

> [!IMPORTANT]
> 这是一个已验证核心链路的服务骨架，**不是生产可用系统**。任务 API 没有鉴权，默认只监听
> `127.0.0.1:4320`；进程重启不会自动续跑；已做 100 轮连续长跑（同 key，未观察到泄漏），
> 但**多实例共享 Postgres 仍不支持**：没有行锁 / 租约，任一方启动都会把整表非终态任务标记
> 失败。部署前必须放在受控网络或网关之后，并补齐鉴权、审批超时、会话回收与多实例归属。

---

名称里的 `spike` 是历史遗留。这个仓库最初是一次性的 Playwright 验证脚本，现在已经拆成
API、worker、执行层、安全策略、持久化与观测分层，并由 35 条测试覆盖。执行器不接受模型生成的
脚本，只接受 `goto / fill / select / selectCustom / click / upload / download / waitForResponse /
waitForHidden / screenshot` 这类结构化动作；定位只使用 role、label、text 等语义方式。

## 快速开始

### 前置条件

- **Node.js 24**
- **npm**
- **Chromium**：`npx playwright install chromium`（本仓库只验证 Chromium / Chrome 内核）
- **Postgres（可选）**：不配置 DSN 时自动回落文件存储，离线测试仍可运行

### 1. 安装

```powershell
git clone https://github.com/dengxingzhi000/cognora-browser-agent.git
cd cognora-browser-agent
npm ci
```

### 2. 本地验证

```powershell
npm test          # 离线：35 tests / 31 passed / 4 skipped / 0 failed
npm run typecheck # tsc --noEmit，0 错误
```

两条 Postgres 测试与长跑 / 多实例用例在未设置 `BROWSER_AGENT_PG_DSN` / 未开启开关时按 skip
报告，不会连接共享数据库。长跑与多实例在 CI 中是独立步骤真实执行。

### 3. 持久化（可选）

```powershell
$env:BROWSER_AGENT_PG_DSN = "postgresql://<user>:<password>@<host>:<port>/db_browser_agent"
npm run db:init
```

`db:init` 幂等：库不存在则建库，再建四张 `browser_*` 表。DSN 必须指向独立库
`db_browser_agent`，指向其他库会被拒绝；DSN、密码、token、cookie 不写入仓库或日志。

### 4. 启动服务

```powershell
npm run serve
# GET http://127.0.0.1:4320/healthz
```

API 与 worker 在同一进程内运行；默认并发 2，可用 `BROWSER_WORKER_CONCURRENCY` 覆盖。
任务状态写入 Postgres 或文件回落后，API 才返回。

### 5. CLI 冒烟

```powershell
npm run spike:blocker        # 不需要登录密码；验证反自动化检测会立即停止
npm run spike                # 真实商品页探针；需要 BROWSER_PASSWORD 与可访问的前端
npm run spike:real-product   # 只跑真实登录 + 商品页探针
```

`npm run spike` 默认目标为真实商品页（`BROWSER_DEFAULT_TARGET=real`）；真实页不可用时
自动回落离线靶场。设 `BROWSER_DEFAULT_TARGET=fixture` 可强制离线回归。

### 环境变量

所有变量都有本地默认值，按需覆盖。`.env` 已被忽略，不要提交。

| 变量 | 默认 | 说明 |
|---|---|---|
| `BROWSER_API_HOST` / `BROWSER_API_PORT` | `127.0.0.1` / `4320` | API 监听地址；默认不暴露公网 |
| `BROWSER_WORKER_CONCURRENCY` | `2` | 进程内 worker 并发上限 |
| `BROWSER_STORAGE_DRIVER` | `auto` | `auto` / `postgres` / `file` / `memory`；`auto` 优先 Postgres，失败回落文件 |
| `BROWSER_AGENT_PG_DSN` | 无 | Postgres DSN；必须指向 `db_browser_agent` |
| `BROWSER_PERSISTENCE_DIR` | `artifacts/persistence` | 文件回落的存储目录 |
| `BROWSER_CHANNEL` | `chromium` | `chromium` / `chrome` / `msedge`；CI 只验证 Chromium |
| `BROWSER_HEADLESS` | `true` | 是否无头运行 |
| `BROWSER_DEFAULT_TARGET` | `real` | CLI 主流程目标：`real` / `fixture` |
| `BROWSER_ALLOWED_HOSTS` | `localhost,127.0.0.1` | 域名白名单，逗号分隔 |
| `BROWSER_UPLOAD_ROOT` | `artifacts/uploads` | 上传文件必须位于该目录 |
| `BROWSER_DOWNLOAD_MAX_BYTES` | `10485760` | 单文件下载大小上限 |
| `BROWSER_PASSWORD` | 无 | 真实登录密码；只从进程环境读取 |

## 能力概览

| 能力 | 实现 |
|---|---|
| **任务 API** | `POST /tasks`、`GET /tasks/{id}`、`GET /tasks/{id}/steps`、`approve` / `reject` / `cancel`；Fastify，默认 `127.0.0.1:4320` |
| **状态机** | `PENDING → RUNNING → COMPLETED / FAILED / CANCELLED / WAITING_APPROVAL`；非法迁移与重复审批返回 409 |
| **审批断点** | 敏感动作在 `require_approval` 下保存快照/截图/断点索引；批准后只执行断点步骤，前序步骤不重跑 |
| **会话隔离** | 每个任务独立 `BrowserContext`；storageState 按 `(tenantId, userId, taskType)` 归档，不共享 cookie |
| **持久化** | 四张 `browser_*` 表；Postgres / 文件 / 内存三种实现；无 DSN 或连不上时回落文件 |
| **域名白名单** | 创建任务、导航前、每个动作前与 iframe 逐层校验；`context.route` 再拦一次网络请求 |
| **动作白名单** | 只允许结构化动作与合法 role；拒绝脚本、`evaluate`、selector、XPath、坐标与注入字段 |
| **交互能力** | Radix/AntD 自定义下拉两步选择与回读、iframe `frameLocator`、上传/下载校验、显式等待 |
| **可观测性** | 每步记录动作、耗时、状态、expected/actual、截图；任务汇总 JSON + 带 `taskId` 的 JSONL 日志 |
| **CI** | GitHub Actions：Node 24、`npm ci`、Chromium、`typecheck`、`test`；最小 `contents: read` 权限与 `concurrency` |

## 技术栈

| 层 | 组件 |
|---|---|
| **运行时** | Node.js 24、TypeScript 7.0.2、ESM、`tsx` |
| **API** | Fastify 5 |
| **浏览器** | Playwright 1.x，Chromium（`channel: chromium`） |
| **持久化** | PostgreSQL（`pg` Pool）+ 文件 / 内存实现 |
| **测试** | Node.js 内置 `node:test`、Fastify `inject`、真实 Chromium、真实 Postgres（可选） |
| **CI** | GitHub Actions，Node 24，`npm ci`，`npx playwright install --with-deps chromium` |

## 架构

```text
┌──────────────┐
│ Agent / 调用方 │
└──────┬───────┘
       │ 结构化 JSON（无脚本）
┌──────▼──────────────────────────────────────────────┐
│ Fastify API  /api/v1/browser                         │
│ POST/GET tasks · steps · approve · reject · cancel   │
└──────┬──────────────────────────────────────────────┘
       │
┌──────▼──────────────┐      ┌────────────────────────┐
│ TaskService         │─────►│ TaskStore（写穿缓存）    │
│ 状态机 / 审批生命周期 │      │ Postgres / 文件 / 内存   │
└──────┬──────────────┘      └────────────────────────┘
       │
┌──────▼──────────────┐
│ TaskQueue（进程内）   │  并发上限可配；等待审批释放槽位
└──────┬──────────────┘
       │
┌──────▼──────────────────────────────────────────────┐
│ Worker：每任务独立 BrowserContext                     │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Session     │  │ Automation   │  │ Observation │ │
│  │ storageState│  │ 结构化意图执行 │  │ 步骤/截图   │ │
│  └─────────────┘  └──────┬───────┘  └─────────────┘ │
│                          │                          │
│                   ┌──────▼───────┐                  │
│                   │ Security     │                  │
│                   │ 域名/动作/审批│                  │
│                   └──────────────┘                  │
└──────────────────────────────────────────────────────┘
```

- 一个服务进程复用一个 `Browser`，每个任务一个 `BrowserContext`。
- `TaskStore` 是内存缓存 + 串行写穿：内存立即可读，写队列落库；API 返回前等待写入追尾。
- 等待审批的任务不占队列槽位，但浏览器会话一直保留。
- 观测产物落在 `artifacts/tasks/<taskId>/` 与 `artifacts/logs/service.jsonl`。

## 覆盖范围

| 场景 | 实现与约束 |
|---|---|
| 任务生命周期 | 创建、排队、执行、完成、失败、取消；所有非法迁移 409 |
| 人工审批 | 敏感按钮或 `approvalRequired: true` 停在 `WAITING_APPROVAL`；批准/驳回/取消都有独立端点 |
| 多租户/多用户隔离 | 同租户不同用户不复用 cookie；不同租户并发任务互不污染 |
| 持久化 | 任务、步骤、审批、storageState 四表落库；文件回落保证无 DSN 也能启动 |
| 安全执行 | 域名白名单双层拦截、动作白名单、元素唯一性 fail closed、反自动化检测 |
| UI 交互 | 自定义 combobox、iframe、文件上传/下载、API 响应等待、spinner 消失等待 |
| 观测 | 每步证据与截图、任务汇总、结构化日志、策略违规记录 |
| 真实页面 | 已验证草稿保存与审批拦截；未做真实页面长跑或多实例验证 |

## 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| API server | `apps/api/server.ts` | Fastify 路由与错误码映射 |
| 组合启动 | `apps/api/main.ts` | API + worker + 持久化 + 浏览器生命周期 |
| 任务队列 | `apps/worker/task-queue.ts` | 进程内队列，并发上限可配 |
| 任务执行 | `apps/worker/browser-task-execution.ts` | 执行工作流、审批断点恢复 |
| 任务域 | `src/tasks/` | 状态机、持久化 TaskStore、TaskService |
| 浏览器 | `src/browser/` | BrowserManager、SessionManager、storageState 归档 |
| 自动化 | `src/automation/` | 导航、语义定位、表单、自定义下拉、上传下载、等待 |
| 安全 | `src/security/` | 域名策略、动作策略、审批判定 |
| 持久化 | `src/persistence/` | 仓储接口、Postgres / 文件 / 内存实现、回落包装 |
| 观测 | `src/observation/`、`src/observability/` | 页面快照、截图、校验、任务汇总与 JSONL 日志 |
| 工作流 | `src/workflows/` | 内置 taskType 与真实商品页探针 |
| 动作注册表 | `src/tools/registry.ts` | 动作/role 白名单唯一来源 |
| 靶场 | `src/fixtures/`、`fixture/` | 本地 HTML 与 API，供离线回归 |
| CLI | `src/cli/spike-runner.ts` | 兼容旧入口的登录/探针/动作回放 |
| 建库 | `scripts/db/` | `schema.sql`、独立库 SQL、`npm run db:init` |

### 目录结构

```text
browser-agent-spike/
├── apps/
│   ├── api/                    # Fastify server + 组合启动
│   └── worker/                 # 进程内队列 + 任务执行
├── src/
│   ├── automation/             # 结构化动作、定位、表单、上传下载、等待
│   ├── browser/                # Browser / Context / storageState 管理
│   ├── cli/                    # 兼容旧入口的 CLI
│   ├── config/                 # 环境变量与 ServiceConfig
│   ├── core/                   # 错误类型与共享类型
│   ├── fixtures/               # 离线靶场 HTTP 服务
│   ├── observation/            # 快照、截图、expected/actual 校验
│   ├── observability/          # JSONL 日志、任务汇总产物
│   ├── persistence/            # 仓储接口、Postgres/文件/内存、回落
│   ├── security/               # 域名/动作白名单、审批判定
│   ├── tasks/                  # 状态机、TaskStore、TaskService
│   ├── tools/                  # 动作白名单注册表
│   ├── workflows/              # 内置 taskType 与真实商品页探针
│   ├── index.ts                # CLI 入口
│   └── selftest.ts             # 纯逻辑自检
├── scripts/db/                 # 建库建表 SQL 与初始化脚本
├── fixture/                    # 靶场 HTML（表单、审批、组件、iframe、上传下载、等待）
├── tests/                      # node:test + Fastify inject + 真实 Chromium + Postgres
├── docs/                       # 发布说明
├── examples/                   # actions.run 示例
├── .github/                    # CI、PR/issue 模板、dependabot
├── .env.example
├── CHANGELOG.md
├── package.json
└── README.md
```

## API 契约

所有业务端点在 `/api/v1/browser` 下；`/healthz` 在根路径。

| 方法 | 路径 | 说明 | 成功 |
|---|---|---|---|
| POST | `/api/v1/browser/tasks` | 创建任务 | `201` |
| GET | `/api/v1/browser/tasks/{id}` | 任务状态、结果、步骤、审批、会话摘要 | `200` |
| GET | `/api/v1/browser/tasks/{id}/steps` | 每步动作、耗时、状态、expected/actual、截图 | `200` |
| POST | `/api/v1/browser/tasks/{id}/approve` | 批准并从断点继续 | `200` |
| POST | `/api/v1/browser/tasks/{id}/reject` | 驳回，按 `CANCELLED` 处理 | `200` |
| POST | `/api/v1/browser/tasks/{id}/cancel` | 取消非终态任务 | `200` |
| GET | `/api/v1/browser/tools` | 动作白名单 | `200` |
| GET | `/api/v1/browser/workflows` | 内置 taskType | `200` |
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
- `input.actions` 用于 `actions.run`；每个动作仍逐条过动作白名单与域名策略。
- `target.url` 必须是可达且在 `BROWSER_ALLOWED_HOSTS` 内的页面。

成功返回：

```json
{
  "taskId": "task-<uuid>",
  "status": "PENDING",
  "taskType": "product.create",
  "executionMode": "require_approval"
}
```

`GET /tasks/{id}/steps` 返回步骤、审批与策略违规：

```json
{
  "taskId": "task-...",
  "status": "COMPLETED",
  "steps": [{
    "index": 1,
    "action": "goto",
    "description": "goto http://127.0.0.1:4310/",
    "status": "success",
    "durationMs": 123,
    "validations": [{ "ok": true, "kind": "url", "expected": "...", "actual": "..." }],
    "screenshot": "artifacts/tasks/task-.../screenshots/01-goto-....png"
  }],
  "approvals": [{
    "request": { "stepIndex": 3, "targetName": "提交审核" },
    "decision": { "decision": "approved" }
  }],
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
- `WAITING_APPROVAL` 不能直接 `COMPLETED` / `FAILED`。

### 错误码

| HTTP | code | 场景 |
|---|---|---|
| 400 | `INVALID_INPUT` | 请求体、taskType、executionMode、URL 格式不合法 |
| 403 | `DOMAIN_NOT_ALLOWED` | 目标域名 / goto / iframe 不在白名单 |
| 403 | `ACTION_NOT_ALLOWED` | 动作、role、frame 或意图字段不在白名单（含脚本注入） |
| 404 | `TASK_NOT_FOUND` | 任务不存在 |
| 409 | `INVALID_TASK_TRANSITION` | 非法状态迁移 / 重复审批 |
| 500 | `INTERNAL_ERROR` | 未预期异常 |

运行期步骤错误记录在任务结果里：`ELEMENT_NOT_FOUND`、`AMBIGUOUS_TARGET`、
`VALIDATION_FAILED`、`WAIT_TIMEOUT`、`UPLOAD_REJECTED`、`DOWNLOAD_REJECTED`、
`WAITING_APPROVAL`、`ANTI_AUTOMATION_DETECTED`、`ACTION_TIMEOUT`、`TASK_CANCELLED`、
`APPROVAL_REJECTED`。

## 持久化

### 独立库与建表

- DSN 只从 `BROWSER_AGENT_PG_DSN` 读取，不写进源码、测试、日志或文档。
- 独立库 `db_browser_agent`；`npm run db:init` 会校验 DSN 的库名，指向其他库直接拒绝。
- 建表脚本：`scripts/db/schema.sql`；四张表：

| 表 | 关键列 |
|---|---|
| `browser_task` | `task_id` PK、`tenant_id`、`user_id`、`task_type`、`status`、`target_system`、`target_url`、`input` jsonb、`execution_mode`、`created_at`、`updated_at`、`started_at`、`finished_at`、`result` jsonb、`error` jsonb、`session_summary` jsonb、`pending_approval` jsonb、`cancel_requested` |
| `browser_task_step` | `(task_id, step_index)` PK、`action`、`target` jsonb、`status`、`expected` jsonb、`actual` jsonb、`validations` jsonb、`duration_ms`、`screenshot_path`、`started_at`、`error`、`approval` |
| `browser_approval` | `id` PK、`task_id`、`step_index`（断点）、`action`、`decision`（`pending/approved/rejected`）、`approver`、`requested_at`、`decided_at`、页面快照字段 |
| `browser_session_state` | `(tenant_id, user_id, task_type)` PK、`storage_state` jsonb、`updated_at` |

`browser_session_state` 在 `(tenantId, taskType)` 基础上增加 `user_id`；不传 `userId` 时使用
`default`。cookie 内容只存于该表或文件回落目录，日志只记录 cookie 名，不记录值。

### 三种存储实现

`BROWSER_STORAGE_DRIVER` 的默认值是 `auto`，实际实现有三种：

| 值 | 行为 |
|---|---|
| `postgres` | 优先 Postgres；连接失败仍回落文件 |
| `file` | 显式使用 `BROWSER_PERSISTENCE_DIR` |
| `memory` | 仅进程内保存，重启丢失；只用于显式配置 |

`auto` 是选择策略：有 DSN 且连得上用 Postgres，否则文件。另有
`ResilientTaskRepository` 在 Postgres 运行期写失败时补写文件，并记录
`storage.postgres_write_failed_fallback_file`。

### 写穿与重启边界

`TaskStore` 是内存缓存 + 串行写穿：内存立即可读，写队列串行落库；API 响应前等待写入追尾。
外部直接用 SQL 查询时按最终一致读取。

进程重启会从 Postgres / 文件加载任务；`PENDING / RUNNING / WAITING_APPROVAL` 因浏览器会话
已丢失会被标记为 `FAILED`，`error.code = WORKER_RESTARTED`，**不会假装能恢复断点**。

### 真实验证

此前已真实执行（非模拟）：

```text
npm run db:init
→ createdDatabase=true；browser_task / browser_task_step /
  browser_approval / browser_session_state 四表存在

Postgres 完整链路（真实 Chromium + 真实 Postgres）
→ 1 pass
  创建任务后 browser_task = WAITING_APPROVAL
  browser_task_step = 3 行，第 3 步 blocked，target/expected/actual/screenshot 均有值
  browser_approval = pending，step_index = 3
  approve 后 browser_task = COMPLETED，approval = approved，
  第 3 步 success，browser_session_state 有 1 行
```

该完整链路测试在 `db_browser_agent` 内创建临时 schema 运行，结束后 `DROP SCHEMA`；
不写 `public` 表、不碰其他库。无 DSN 时该测试与只读连通性测试都 skip。

## 安全边界

1. **域名白名单双保险**
   - 创建任务、`goto` 前 `assertAllowed`；
   - 每个动作前检查当前页与所有 iframe URL；
   - `BrowserContext.route('**/*')` 拦截非白名单请求并 `abort`；
   - 被拦截 URL 记入 `sessionSummary.policyViolations` / 任务 `policyViolations`。
2. **动作白名单**
   - 只允许 `goto / fill / select / selectCustom / click / upload / download /
     waitForResponse / waitForHidden / screenshot`；
   - role 也在白名单内；
   - 递归扫描禁止字段：`script / evaluate / expression / pageFunction / code / selector /
     xpath / x / y`；
   - 不接受 CSS 选择器、XPath、坐标。
3. **元素唯一性**
   - 0 个匹配 → `ELEMENT_NOT_FOUND`；多个可见匹配 → `AMBIGUOUS_TARGET`，fail closed。
4. **审批闸门**
   - 按钮名命中 `提交|发布|确认下单|审核|支付|付款|转账|confirm|submit|approve|publish|pay|checkout`
     或意图显式 `approvalRequired: true`；
   - `require_approval` 下先落盘页面快照，再停在 `WAITING_APPROVAL`；
   - `auto` 模式直接执行。
5. **文件动作**
   - 上传文件必须位于 `BROWSER_UPLOAD_ROOT` 内；上传前校验存在、是文件、扩展名、大小上限；
   - 下载文件名禁止路径穿越；落盘后校验扩展名与大小，并记录实际文件名。
6. **反自动化**
   - 检测 reCAPTCHA / hCaptcha / Cloudflare / `[data-captcha]` 等结构，立即截图并停止，
     不尝试绕过。
7. **API 无鉴权**
   - 默认只监听 `127.0.0.1`；部署时必须放在受控网络或网关之后。

## 测试与 CI

```powershell
npm test
npm run typecheck
```

本轮离线实测：

```text
tests 35
pass 31
fail 0
skipped 4   # 2 条 Postgres 用例 + 长跑 / 多实例（未设置 DSN 或未开启开关）
```

`npm run typecheck`（`tsc --noEmit`）0 错误。CI 每次启动一次性 Postgres 17 service 并先执行
`npm run db:init`，两条 Postgres 用例真实执行；随后是两个独立步骤：
`BROWSER_AGENT_LONGRUN=1 npm run test:longrun`（100 轮）与
`BROWSER_AGENT_MULTI_INSTANCE=1 npm run test:multi`（2 进程）。本地无 DSN 时这些用例按 skip 报告。

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `tests/task-state.test.ts` | 4 | 合法/非法迁移、终态、WAITING 不能直接完成 |
| `tests/api.test.ts` | 8 | 创建/查询/steps、审批恢复、重复 409、reject、cancel、400/403/404、真实 HTTP、并发配置 |
| `tests/security.test.ts` | 7 | 域名、脚本注入、frame 注入、计划校验、文件路径、API 403 |
| `tests/isolation.test.ts` | 1 | 两种租户并发隔离 + storageState 复用 + 用户隔离 |
| `tests/reuse-stability.test.ts` | 2 | 连续 10 任务复用 storageState；4 租户并发互不污染 |
| `tests/fixture-delay.test.ts` | 1 | `/api/slow` 超长 `ms` 被限制在 5000ms |
| `tests/approval.test.ts` | 1 | 真实浏览器断点续跑、截图、409 |
| `tests/custom-select.test.ts` | 1 | Radix + AntD 两种 DOM |
| `tests/iframe.test.ts` | 1 | frameLocator 定位/点击/状态断言 |
| `tests/upload-download.test.ts` | 2 | 上传下载正例、扩展名与大小拒绝 |
| `tests/waits.test.ts` | 3 | spinner / API 等待、两种超时 |
| `tests/postgres.integration.test.ts` | 1 | DSN 连通性 + 四张表结构（无 DSN skip，只读） |
| `tests/postgres.flow.test.ts` | 1 | 临时 schema 内完整落库/审批/断点恢复链路（无 DSN skip） |
| `tests/longrun-stability.test.ts` | 1 | 100 轮同 key 长跑度量：RSS / Browser / Context / Postgres 连接数（`BROWSER_AGENT_LONGRUN=1`） |
| `tests/multi-instance.test.ts` | 1 | 2 进程共享 Postgres：重复执行、storageState 归属、重启行为（`BROWSER_AGENT_MULTI_INSTANCE=1`） |

GitHub Actions（`.github/workflows/ci.yml`）：

- Node 24、`npm ci`、`npx playwright install --with-deps chromium`、`npm run typecheck`、`npm test`；
  之后独立执行 100 轮长跑与 2 进程多实例实验；
- `permissions: contents: read`，`concurrency: ci-${{ github.ref }}`；
- Postgres 17 service 仅存在于 runner，`trust` 认证、无密码，先 `npm run db:init` 建四张表；
  `BROWSER_AGENT_PG_DSN` 指向 `127.0.0.1/db_browser_agent`，不连接共享数据库，不写凭据进仓库；
- 当前 master 的 CI 状态见顶部 Build badge。

### 连续 / 并发稳定性（一次性验证）

2026-11-03 用 `tests/reuse-stability.test.ts` 在真实 Chromium + fixture 上实测：

- 连续 10 个同 key 任务：**10 COMPLETED / 30 steps / 1 storageState ref**；每轮首跳都读回
  上一任务写入的 cookie，归档未被重建。
- 4 个不同租户并发：**4 COMPLETED / 12 steps / 4 storageState refs**；首跳均为「无 cookie」，
  各自只读到自己的值，域名策略违规 0。
- 两组用例合计约 11.6s。该结果只代表短时连续/并发。

### 长跑与多实例（真实执行，0.2.4）

2026-11-04，在本地一次性 Postgres 17.6（`trust`、`127.0.0.1:55432`）+ 真实 Chromium + fixture
上执行；每条用例使用独立临时 schema，结束后 `DROP SCHEMA`。

**长跑（`tests/longrun-stability.test.ts`，100 轮同 key）**

| 指标 | 结果 |
|---|---|
| 轮次 / 完成 / 失败 | 100 / 100 / **0** |
| 总耗时 | **64.9s**（100 轮先到，未跑满 60 分钟） |
| 每轮耗时 | P50 **634ms**，P95 **762ms**，3 steps/轮，共 300 steps |
| storageState ref | **1**（`pg:longrun-.../u1/actions.run`，每轮读回上一轮 cookie） |
| RSS（每轮强制 GC 后） | 首 **164.4MB** → 末 **176.4MB**，峰值 **178.1MB**；稳态（51–100 轮）斜率 **≈0.016MB/轮** |
| 浏览器实例 / Context | Browser 恒为 **1**；每轮结束 Context **0**（无泄漏） |
| Postgres 连接 | 全程 **2**（池上限 5，未耗尽） |

结论：**未观察到浏览器、Context 或连接池泄漏，RSS 在预热后进入平台期**。注意未强制 GC 的观测
中峰值曾达 359MB（V8 堆未回收），因此泄漏判断以「强制 GC 后的存活内存」为准；该结果仍只覆盖
100 轮 / 约 1.1 分钟，不等于小时级稳定性。

CI（Linux，run `41756365225`）同用例复跑：**100/100 COMPLETED，61.8s，300 steps，1 ref**；
RSS 首 **196.9MB** → 末 **208.0MB**、峰值 **208.1MB**、稳态斜率 **≈0.04MB/轮**；
Browser 1 / Context 0 / 连接 2。两次运行都没有泄漏迹象。

**多实例（`tests/multi-instance.test.ts`，2 个独立进程 + 共享 Postgres）**

| 检查 | 实测 |
|---|---|
| 重复执行 | A 上连建 3 个任务：3 COMPLETED；B 查询这 3 个任务全部 404，未执行、未轮询 |
| storageState 归属 | 同 `(tenant,user,type)` 跨实例命中同一 ref；不同 tenant 各自 ref，不串 |
| 同 key 并发归档 | 仍为「最后完成者覆盖」，未加锁（既有已知限制） |
| 重启 B（A 有 WAITING 任务） | B 启动把 A 的 `WAITING_APPROVAL` 在库里改成 `FAILED(WORKER_RESTARTED)`；A 内存仍为 WAITING；approve 打到 B 返回 409 `INVALID_TASK_TRANSITION`；打到 A 后完成，库里最终又被覆盖为 COMPLETED |
| 重启 A（有 WAITING 任务） | 任务被标记 `FAILED(WORKER_RESTARTED)`；重启前后步骤数均为 3，3 秒后仍为 FAILED，**没有双跑也没有续跑** |

结论：**当前架构不支持多实例归属**。任务只在收到创建请求的进程内执行，另一方不会接管；
启动恢复会把整表非终态任务打成失败；写回是无版本校验的 upsert（最后写入者胜）。要支持多实例
至少需要：(1) 数据库级认领 `SELECT … FOR UPDATE SKIP LOCKED` 或条件 `UPDATE … RETURNING`；
(2) `lease_owner / lease_expires_at / heartbeat_at` 列与心跳续租；(3) 启动恢复只回收过期租约，
不再整表失败；(4) 带租约 / 版本的写回，拒绝非持有者写入；(5) approve / cancel 跨实例路由或共享
唤醒通道（当前只有进程内队列）。

**清理**：长跑删除 100 行任务 + 1 行 storageState；多实例临时 schema 删除前为
9 tasks / 27 steps / 2 approvals / 5 session states，`DROP SCHEMA` 后为 **0 / 0 / 0 / 0**；
公共库四张表在清理后仍为 **0 行**。

## 真实商品页验证

2026-11-03 的一轮复测（前端由本地 `scm-web` dev server 启动，后端为既有 SCM 环境）：

- 401 根因是**设备绑定**：登录时后端把 `X-Device-ID`（缺省为 `SHA256(User-Agent + IP)`）
  写入 token 的 `deviceId` claim，后续请求必须携带同一值。带上同一 device id 与租户头后：
  - `prod-brand` → **200**，`total=6`；
  - `prod-spu` → **200**，`total=9`；
  - `prod-category` → **200**，`total=3`；
  - `prod-spu/{id}` 详情 → **200**。
- 真实商品新建页 `/zh-CN/product/create`：结构化动作 9 步全部成功，自定义下拉回读逐字一致；
  保存接口 `POST /scm-product/api/v1/prod-spu` **200**，页面提示「创建成功」；
  草稿通过 API 回查确认存在（`status=0`），验证后按商品编码删除，商品总数回到 9。
- 上架保存尝试在 `require_approval` 下 **BLOCKED**，截图
  `artifacts/screenshots/20261103-122623/approval-blocked-09-保存.png`；未产生真实商品。
- 默认 CLI 主流程已切到真实商品页（`BROWSER_DEFAULT_TARGET=real`），默认只做填写 + 上架保存
  尝试，由审批闸门拦截；真实页不可用时回落 `fixture`。
- 测试凭据只在浏览器进程内使用；仓库文件、日志、测试输出均不包含密码、token 或 cookie 原始值。

**边界**：以上只证明草稿保存与审批闸门在该环境可用；未在真实商品页做长跑或多实例验证，
不能据此声称「真实页面全流程稳定」或「生产可用」。

## 运维

| 操作 | 方式 |
|---|---|
| 健康检查 | `GET /healthz` → `{ "ok": true }` |
| 启动 | `npm run serve`；API 与 worker 同进程 |
| 停止 | `SIGINT` / `SIGTERM` 触发优雅关闭：HTTP → worker → 浏览器 → 持久化 |
| 日志 | `artifacts/logs/service.jsonl`，JSON Lines，带 `taskId` |
| 任务产物 | `artifacts/tasks/<taskId>/task.json`、`screenshots/`、`downloads/` |
| 存储降级 | 启动日志 `storage.postgres_unavailable_fallback_file`；文件目录见 `BROWSER_PERSISTENCE_DIR` |
| 数据库 | `npm run db:init`；四张表见 `scripts/db/schema.sql` |

当前没有多实例部署方案：队列、审批恢复与浏览器会话都在单进程内。等待审批的任务会一直保留
浏览器会话，没有审批超时或会话回收。

## 已知限制

- **重启恢复边界**：`PENDING / RUNNING / WAITING_APPROVAL` 因浏览器会话丢失标记
  `FAILED`（`WORKER_RESTARTED`），不自动续跑。
- **等待审批不回收会话**：不占队列槽位，但浏览器会话一直保留；没有审批超时。
- **API 无鉴权**：只监听 `127.0.0.1`，不能直接暴露公网。
- **仅 Chromium**：未验证 Firefox / WebKit。
- **iframe 仅支持 name / title**：不接受任意选择器，也不支持嵌套 frame 路径表达。
- **写穿最终一致**：外部直接用 SQL 查询可能有毫秒级延迟。
- **同 key 并发归档竞态**：同 `(tenantId, userId, taskType)` 并发任务各自独立 context，
  storageState 保存是「最后完成者覆盖」，没有加锁。
- **取消是步骤间生效**：正在执行的 Playwright 动作不会被强制中断。
- **无失败重试 / 自愈定位**：失败即 `FAILED`，没有候选定位器。
- **自定义下拉只覆盖固定框架弹出层**：Radix / AntD 为本地复刻 DOM，未验证真实组件库版本矩阵。
- **文件校验只看扩展名 / 大小**：上传不做内容扫描；下载不做 MIME / 内容嗅探。
- **真实商品页依赖运行环境**：需要 `localhost:3000` 前端、既有 scm-auth/scm-product 与稳定
  `X-Device-ID`；条件不满足时 CLI 自动回落 `fixture`。
- **多实例归属不支持**：任务只在收到创建请求的进程内执行；任一实例启动都会把整表非终态任务
  标记 `FAILED`；写回无版本 / 租约校验。实测证据与所需机制见「长跑与多实例」一节。
- **长跑只覆盖 100 轮 / 约 1.1 分钟**：未设置 60 分钟以上的小时级门禁，未做真实商品页长跑；
  RSS 结论基于「每轮强制 GC 后的存活内存」。
- **无审批超时 / 归档清理**：等待审批的浏览器会话一直保留；storageState 归档没有 TTL。

## FAQ

<details>
<summary><strong>为什么 API 没有鉴权？</strong></summary>

当前定位是受控环境内的执行服务，默认只绑定 `127.0.0.1`。对外部署必须放到网关或受控网络后，
由调用方补齐认证与授权；仓库内没有实现 token/租户级鉴权。

</details>

<details>
<summary><strong>进程重启后为什么不能继续等待审批的任务？</strong></summary>

审批断点依赖进程内的浏览器会话、页面快照与执行游标。进程重启后这些运行时状态已丢失，
因此只把非终态任务标记为 `FAILED(WORKER_RESTARTED)`，不假装能恢复；已完成任务仍从
Postgres / 文件加载。

</details>

<details>
<summary><strong>为什么不支持脚本、CSS 选择器或坐标？</strong></summary>

执行层是给 Agent 用的：只接受结构化意图，定位使用 role / label / text 等语义方式，元素必须
可见且唯一。脚本、`evaluate`、selector、XPath、坐标会被递归扫描拒绝，避免模型输出直接变成
任意代码执行。

</details>

<details>
<summary><strong>没有 Postgres 能不能跑？</strong></summary>

可以。`BROWSER_STORAGE_DRIVER=auto` 在无 DSN 或连接失败时回落文件；显式 `file` / `memory`
也可用。文件回落不是「假装持久化」，目录与降级日志会明确标注。

</details>

## 文档

- [CHANGELOG.md](./CHANGELOG.md) — 版本变更与已知限制
- [docs/release-0.2.4.md](./docs/release-0.2.4.md) — 当前版本：长跑与多实例实测、边界与部署
- [docs/release-0.2.3.md](./docs/release-0.2.3.md) — 上一版本（CI Postgres service 与 10 轮稳定性用例）
- [docs/release-0.2.2.md](./docs/release-0.2.2.md) — 依赖升级
- [.env.example](./.env.example) — 所有环境变量与默认值
- [scripts/db/schema.sql](./scripts/db/schema.sql) — 四张 `browser_*` 表
- [.github/workflows/ci.yml](./.github/workflows/ci.yml) — CI 流程
- [v0.2.4 Release](https://github.com/dengxingzhi000/cognora-browser-agent/releases/tag/v0.2.4)

## 贡献

- Bug / 功能建议请用 `.github/ISSUE_TEMPLATE/` 下的模板开 issue。
- PR 请遵循 `.github/PULL_REQUEST_TEMPLATE.md`；CI 会执行 `npm ci`、`npm run typecheck`、
  `npm test`，并额外跑 100 轮长跑与 2 进程多实例实验。无 DSN 时相关用例 skip 属于预期行为。
- 不要提交 DSN、密码、token、cookie 或 `.env`。真实页面测试凭据只通过进程环境变量传入。
