# Changelog

## 0.2.4 — 2026-11-04

长跑稳定性与多实例归属的真实执行结果（一条通过、一条如实判定不支持）。

### Added

- 新增 `tests/longrun-stability.test.ts`：同 key 连续 100 轮，每轮记录耗时、步骤数、
  storageState ref、RSS、Browser/Context 数、Postgres 连接数；`BROWSER_AGENT_LONGRUN=1` 启用。
  实测 **100/100 COMPLETED，0 失败，64.9s，300 steps，1 ref**；RSS 首 164.4MB → 末 176.4MB、
  峰值 178.1MB（每轮强制 GC），稳态 51–100 轮斜率 ≈0.016MB/轮；Browser 恒为 1、Context 归零、
  Postgres 连接恒为 2（池上限 5）。
- 新增 `tests/multi-instance.test.ts`：2 个独立进程共享同一 Postgres，验证重复执行、
  storageState 归属与重启行为；`BROWSER_AGENT_MULTI_INSTANCE=1` 启用。
- 收纳此前 Unreleased 的 `tests/fixture-delay.test.ts`：锁定 fixture `/api/slow` 对超长 `ms`
  的 5000ms 上限（CodeQL `js/resource-exhaustion` 误报判定的证据，告警已 dismiss）。

### Changed

- CI 在 `npm test` 之后增加两个独立步骤：100 轮长跑与 2 进程多实例实验（均使用一次性
  Postgres 17 service）。

### Verified

- 长跑：**未观察到 Browser / Context / 连接池泄漏**；RSS 预热后进入平台期。仅覆盖 100 轮
  （约 1.1 分钟），未跑满 60 分钟，未在真实商品页复跑。
- 多实例：**不支持**。任务只在创建它的进程内执行，另一方不轮询（3 个 A 任务在 B 全部 404）；
  同 key 跨实例命中同一归档、不同 tenant 不串；但任一实例启动会把整表非终态任务标记
  `FAILED(WORKER_RESTARTED)`（实测 B 重启打失败 A 的 WAITING 任务，A 之后又覆盖为 COMPLETED），
  approve 打到非持有实例返回 409，重启自身则不续跑、不双跑。
- 需要补齐才能支持多实例：DB 认领（`FOR UPDATE SKIP LOCKED` / 条件 `UPDATE … RETURNING`）、
  `lease_owner / lease_expires_at / heartbeat_at` 与心跳、只回收过期租约的启动恢复、带租约/版本
  的写回、跨实例审批唤醒通道。
- 清理：长跑数据删除 100 tasks + 1 session state；多实例临时 schema 删除前
  9 tasks / 27 steps / 2 approvals / 5 session states，`DROP SCHEMA` 后四表均为 0；
  公共库四表清理后为 0 行。

### Known limitations

- 长跑只有 100 轮 / 约 1.1 分钟；无 60 分钟以上的 CI 门禁，无真实页长跑。
- 多实例共享 Postgres 仍不支持（无行锁 / 租约 / 版本写回）。
- 同 key 并发归档仍为最后写入者覆盖，没有加锁。
- VM 库 `db_browser_agent` 的本地复跑因凭据策略未执行；本次真实 Postgres 是本地临时实例
  （17.6，`127.0.0.1:55432`，trust），CI 用的是一次性 service，两者都不是 VM 库。

## 0.2.3 — 2026-11-03

短时连续/并发稳定性验证，以及 CI 中 Postgres 用例真实执行。

### Added

- 新增 `tests/reuse-stability.test.ts`：连续 10 个同 key 任务复用同一 storageState
  （**10 COMPLETED / 30 steps / 1 ref**，7.79s）；4 个租户并发执行互不污染
  （**4 COMPLETED / 12 steps / 4 refs**，2.88s），域名策略违规 0。
- 该验证只覆盖短时连续/并发，不替代长时间稳定性与多实例验证。

### Changed

- CI 增加一次性 Postgres 17 service（`trust`、无密码、仅 runner 内可达），先 `npm run db:init`
  再跑 `npm test`；两条 Postgres 用例从 skip 变为每次真实执行。

### Verified

- `npm test`（CI，真实 Postgres）：**32 tests / 32 passed / 0 skipped / 0 failed**。
- `npm test`（本地无 DSN）：32 tests / 30 passed / 2 skipped / 0 failed。
- `npm run typecheck`：0 错误；`npm run selftest`：20/20 通过。

### Known limitations

- 仅证明短时连续/并发；小时级长跑、内存增长、多实例归属、同 key 并发写回竞态未验证。
- VM 库 `db_browser_agent` 的本地复跑因凭据策略未执行；CI 用的是一次性 service，不是 VM 库。

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
