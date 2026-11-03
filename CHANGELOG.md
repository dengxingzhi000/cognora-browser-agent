# Changelog

## 0.2.2 — 2026-11-03

依赖升级与兼容性说明。

### Changed

- `typescript` 5.9.3 → 7.0.2（devDependency）。TypeScript 7 的 `tsc --noEmit` 在本仓库通过；
  `tsx` 仍负责测试运行，ESM 结构未变。
- `@types/node` 范围 `^24.0.0` → `^24.19.2`，锁定在 Node 24.x。registry 最新为 26.6.6，
  但运行时是 Node 24.22.0，26.x 类型可能暴露 Node 24 不存在的 API，因此按住不升。
- 运行时依赖 `fastify@5.12.8`、`pg@8.23.1` 已是 registry 最新，未变更。
- `playwright@1.64.1` 已是 registry 最新；继续使用已安装的 Chromium 1248，未触发浏览器重新下载。
- `@types/pg@8.23.1`、`tsx@4.23.15` 已是最新，未变更。

### Verified

- `npm run typecheck`：0 错误。
- `npm test`（无 DSN）：30 tests / 28 passed / 2 skipped / 0 failed。
- `npm run selftest`：20/20 通过。
- 本机未设置 `BROWSER_AGENT_PG_DSN` 且无 `.env`，Postgres 用例 skip；未伪造数据库结果。

### Known limitations

- 0.2.1 的运行边界不变：进程重启标记 `WORKER_RESTARTED` 不续跑、API 无鉴权、仅 Chromium、
  等待审批不回收会话、未做长稳与多实例验证。

## 0.2.1 — 2026-11-03

发布物对齐：仓库转为公开，README 按参考项目结构重写，tag/Release 指向 CI 全绿提交。

### Changed

- README 按「快速开始 → 能力概览 → 技术栈 → 架构 → 覆盖范围 → 组件/目录 → API →
  持久化 → 安全 → 测试与 CI → 真实验证 → 运维 → 已知限制 → FAQ → 文档 → 贡献」
  重排；只保留本仓库真实存在的命令、数字与限制。
- 明确记录本轮离线实测：`30 tests / 28 passed / 2 skipped / 0 failed`，`typecheck` 0 错误。
- 明确边界：未做长稳、并发压测与多实例验证，不声称「全流程稳定」或「生产可用」。

### Fixed

- `tests/security.test.ts` 的上传路径穿越断言改用 `path.resolve` / `path.join`，
  修复 Linux CI 下把 Windows 反斜杠路径当作合法路径的问题。

### Known limitations

- 进程重启后 `PENDING / RUNNING / WAITING_APPROVAL` 标记 `FAILED(WORKER_RESTARTED)`，不自动续跑。
- 等待审批不回收浏览器会话；API 无鉴权，默认只监听 `127.0.0.1`。
- 仅 Chromium；iframe 仅支持 name/title；写穿持久化最终一致。

## 0.2.0 — 2026-11-03

首个可复用浏览器执行服务交付。

### Added

- **任务 API**：`POST/GET /api/v1/browser/tasks`、任务 steps、approve/reject/cancel；
  Fastify 实现，默认只监听 `127.0.0.1:4320`。
- **状态机**：`PENDING → RUNNING → COMPLETED | FAILED | CANCELLED | WAITING_APPROVAL`；
  `WAITING_APPROVAL → RUNNING` 可从断点继续；非法迁移与重复审批返回 409。
- **审批断点**：敏感动作在 `require_approval` 下保存页面快照/截图/断点索引，
  `/approve` 后只执行断点步骤，已完成步骤不重跑。
- **进程内队列**：并发上限可配；等待审批的任务释放队列槽位但保留浏览器会话。
- **会话隔离**：每个任务独立 `BrowserContext`；storageState 按
  `(tenantId, userId, taskType)` 归档，不同租户/用户不共享 cookie。
- **安全边界**：域名白名单两层校验（导航前 + `context.route`）、动作/role 白名单、
  拒绝脚本/selector/坐标字段、元素唯一性 fail closed、反自动化检测退出。
- **持久化**：Postgres 四张表 `browser_task`、`browser_task_step`、`browser_approval`、
  `browser_session_state`；DSN 从 `BROWSER_AGENT_PG_DSN` 读取。
  无 DSN 或连接失败时回落文件存储；内存实现仅显式配置时使用。
- **观测**：每步动作/耗时/状态/expected-actual/截图、任务级 JSON 汇总、
  带 `taskId` 的 JSONL 结构化日志。
- **批次 2 交互能力**：Radix/AntD 自定义下拉两步选择与回读、iframe `frameLocator`、
  文件上传/下载（类型/大小校验）、`waitForResponse` / spinner 消失的显式等待。
- **真实商品页**：设备绑定 `X-Device-ID` 复测通过；`prod-brand` / `prod-spu` /
  `prod-category` / 详情 200；真实草稿保存 POST 200 且提示「创建成功」；
  上架保存在 `require_approval` 下被审批拦截并截图。

### Security

- 上传文件限制在 `BROWSER_UPLOAD_ROOT` 内；下载校验文件名/扩展名/大小。
- 日志与仓库文件不写入 DSN、密码、token 或 cookie 原始值。
- 任务 API 无鉴权，部署必须放在受控网络或网关之后。

### Known limitations

- 进程重启后 `PENDING / RUNNING / WAITING_APPROVAL` 因浏览器会话丢失标记
  `FAILED`（`WORKER_RESTARTED`），不自动续跑。
- 写穿持久化为最终一致；外部直接用 SQL 查询可能有毫秒级延迟。
- 等待审批期间浏览器会话一直保留，无审批超时 / 会话回收。
- 同 `(tenantId, userId, taskType)` 并发归档为最后完成者覆盖，无锁。
- 仅 Chromium / Chrome 内核；iframe 仅按 name/title 引用；自定义下拉为本地复刻 DOM。
- 真实商品页依赖 `localhost:3000` 前端、VM 上的 scm-auth/scm-product 与稳定
  `X-Device-ID`；条件不满足时 CLI 自动回落 fixture。
