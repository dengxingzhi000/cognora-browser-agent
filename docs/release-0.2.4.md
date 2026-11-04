# Release 0.2.4 — 长跑与多实例实测

发布日期：2026-11-04

本版没有新增业务能力，只补齐 README「已知限制」里两条可验证项，并给出真实数字。结论：

- **长跑稳定性**：100 轮同 key 任务，未观察到浏览器、Context 或连接池泄漏；RSS 预热后进入平台期。
- **多实例归属**：**当前架构不支持**，实测证据见下；不伪装通过。

## 验证环境

- 本地一次性 Postgres **17.6**（`trust`、`127.0.0.1:55432`）+ 真实 Chromium + 仓库内 fixture。
- 每条用例使用独立临时 schema，结束后 `DROP SCHEMA`；不使用、也不写入 VM 库
  `db_browser_agent`，仓库内无任何凭据。
- CI 使用一次性 Postgres 17 service，流程见 `.github/workflows/ci.yml`。

## 长跑（`tests/longrun-stability.test.ts`）

同 `(tenantId, userId, taskType)` 连续 100 轮，每轮 3 步并读回上一轮写入的 cookie。

| 指标 | 实测 |
|---|---|
| 轮次 / 完成 / 失败 | 100 / 100 / 0 |
| 总耗时 | 64.9s（100 轮先到，未跑满 60 分钟） |
| 每轮耗时 | P50 634ms，P95 762ms；300 steps |
| storageState ref | 1（未重建归档） |
| RSS（每轮强制 GC 后） | 首 164.4MB → 末 176.4MB，峰值 178.1MB；稳态 51–100 轮斜率 ≈0.016MB/轮 |
| Browser / Context | Browser 恒为 1；每轮结束 Context 为 0 |
| Postgres 连接 | 恒为 2（池上限 5） |

结论：**未观察到泄漏**。说明两点边界：

1. 不强制 GC 的观测中峰值曾达 359MB（V8 堆未回收），因此泄漏判断以强制 GC 后的存活内存为准；
2. 只覆盖 100 轮 / 约 1.1 分钟，**没有** 60 分钟以上的小时级门禁，也没有真实商品页长跑。

CI（Linux，run `41756365225`）用同一用例复跑：100/100 COMPLETED、61.8s、300 steps、1 ref；
RSS 首 196.9MB → 末 208.0MB、峰值 208.1MB、稳态斜率 ≈0.04MB/轮；Browser 1 / Context 0 /
连接 2。两次独立运行结论一致。

## 多实例（`tests/multi-instance.test.ts`）

2 个独立进程（各自 API + worker + Browser）共享同一 Postgres，同一张 `browser_task` 表。

| 检查 | 实测 |
|---|---|
| 重复执行 | A 连建 3 个任务全部 COMPLETED；B 查询这 3 个任务全部 404，未轮询、未执行 |
| storageState 归属 | 同 key 跨实例命中同一 ref；不同 tenant 各自 ref，不串 |
| 同 key 并发归档 | 仍是「最后完成者覆盖」，未加锁（既有已知限制） |
| 重启 B（A 有 WAITING 任务） | B 启动把 A 的 `WAITING_APPROVAL` 改成 `FAILED(WORKER_RESTARTED)`；A 内存仍为 WAITING；approve 打到 B 返回 409 `INVALID_TASK_TRANSITION`；打到 A 后完成，库里最终覆盖为 COMPLETED |
| 重启 A（有 WAITING 任务） | 标记 `FAILED(WORKER_RESTARTED)`；重启前后步骤数均为 3，3 秒后仍 FAILED；没有双跑，也没有续跑 |

结论：**多实例归属不支持**。原因是任务只在收到创建请求的进程内执行（进程内队列），
启动恢复会把整表非终态任务打失败，写回是无版本校验的 upsert。

要支持多实例，至少需要：

1. 数据库级认领：`SELECT … FOR UPDATE SKIP LOCKED` 或条件 `UPDATE … RETURNING`；
2. `lease_owner / lease_expires_at / heartbeat_at` 列与心跳续租；
3. 启动恢复只回收过期租约，不再整表失败；
4. 带租约 / 版本的写回，拒绝非持有者写入；
5. approve / cancel 跨实例路由或共享唤醒通道（当前只有进程内队列）。

## 清理

- 长跑：删除 100 行 `browser_task` + 1 行 `browser_session_state`，测试租户剩余 0 行。
- 多实例：临时 schema 删除前 9 tasks / 27 steps / 2 approvals / 5 session states；
  `DROP SCHEMA CASCADE` 后四表均为 0；公共库四张表清理后为 0 行。

## 本次覆盖 / 未覆盖

**覆盖**

- 同 key 连续 100 轮：完成率、步骤数、归档复用、RSS 稳态、Browser/Context 计数、连接池上限。
- 2 进程共享 Postgres：不重复执行、storageState 不串、重启后的标记与写回行为。
- CI：`npm test`（35 tests，含 2 条 Postgres）+ 100 轮长跑 + 2 进程多实例，均为真实执行。

**未覆盖**

- 60 分钟以上的小时级长跑；真实商品页长跑；高并发 / 压测吞吐。
- 多实例的「支持」本身（当前不支持）；租约、心跳、跨实例审批路由均未实现。
- 同 key 并发写回竞态（仍是最后写入者覆盖）。
- VM 库 `db_browser_agent` 的本地复跑（凭据策略限制），CI 用的是 runner 内一次性 service。

## 升级

无破坏性变更。`package.json` 版本号 `0.2.3 → 0.2.4`；新增两个 npm 脚本：

```powershell
BROWSER_AGENT_PG_DSN=... BROWSER_AGENT_LONGRUN=1 npm run test:longrun
BROWSER_AGENT_PG_DSN=... BROWSER_AGENT_MULTI_INSTANCE=1 npm run test:multi
```
