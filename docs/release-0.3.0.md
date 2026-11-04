# Release 0.3.0 — 多实例租约

发布日期：2026-11-04
上一版本：`v0.2.4`

## 这个版本解决什么

0.2.4 的多实例实测暴露了两个问题：

1. **误杀存活任务**：任一进程启动都会把整表非终态任务写成 `FAILED(WORKER_RESTARTED)`，
   包括另一个进程正在执行 / 正在等待审批的任务。
2. **无版本写回**：任务是全量 upsert，最后写入者胜；旧实例可以覆盖新持有者的结果。

0.3.0 把「归属」下沉到数据库：认领、租约、心跳、守卫写回、跨实例审批唤醒。核心回归是
**重启不再误杀存活任务**。

## 语义

### 状态与租约

| 状态 | 租约 | 说明 |
|---|---|---|
| `PENDING` | 无 | 可被任意实例认领 |
| `RUNNING` | 有，心跳续期 | 只有 `lease_owner` 能写回 |
| `WAITING_APPROVAL` | 有，心跳续期 | 持有者保留浏览器会话等待审批 |
| `COMPLETED` / `FAILED` / `CANCELLED` | 释放（`lease_expires_at = NULL`） | 终态，不再被认领 |

- 租约默认 **60s**（`BROWSER_TASK_LEASE_MS`），心跳默认 **15s**（`BROWSER_TASK_HEARTBEAT_MS`）；
  启动时校验心跳必须小于租约。
- 认领是单条 `UPDATE … WHERE (status='PENDING' 且无租约) OR (status='RUNNING' 且租约过期)
  … RETURNING`，子查询带 `FOR UPDATE SKIP LOCKED`；两个实例并发只有一个能更新到该行。
- 认领成功即 `version + 1`；写回也 `version + 1`，便于排查「谁最后写了什么」。

### 启动恢复

- **只回收租约已过期的任务**。过期 `RUNNING` → `PENDING`（等待重新认领，从头执行）；
  过期 `WAITING_APPROVAL` → `FAILED(WORKER_RESTARTED)`（持有进程已消失，浏览器会话不可恢复）。
- 存活实例的任务由心跳持续续租，**不会**因为别的实例启动被改写。
- **重启后仍不自动续跑**：执行游标与浏览器会话在内存里，已丢失。变化在于「不再误杀」，
  而不是「能续跑」。

### 守卫写回

写回条件：

```sql
WHERE task_id = $1
  AND lease_owner = $2
  AND (lease_expires_at > now() OR status IN ('COMPLETED','FAILED','CANCELLED'))
```

0 行 → 抛 `LEASE_LOST`，本次结果丢弃；`ResilientTaskRepository` 不会把它回落成文件写入。
终态行允许持有者补写（例如随后的 `summaryPath`），但其他实例仍无法覆盖。

### 跨实例审批

- 非持有实例收到 `approve` / `reject` / `cancel`：写一行 `browser_task_notification`
  （同任务同类型仅一条未消费），返回 **202**：

  ```json
  { "taskId": "...", "status": "WAITING_APPROVAL", "approval": "queued", "owner": "host:pid:xxx" }
  ```

- 持有者 dispatcher 轮询 `consumeWakes`（`FOR UPDATE SKIP LOCKED`），消费后在本地迁移到
  `RUNNING` 并用自己的会话续跑；不需要重建浏览器。
- 持有者已崩溃时，唤醒通知会一直排队；租约过期后任务被判 `FAILED(WORKER_RESTARTED)`，
  之后 approve 返回 **409**（明确的终态语义），不会出现「返回 409 但库里被人覆盖」。

## 验证（全部真跑，无 skip 通过）

环境：本地一次性 Postgres 17.6（`trust`，`127.0.0.1:55432`，独立临时 schema）+ 真实 Chromium + fixture。

| # | 场景 | 实测 |
|---|---|---|
| 1 | B 重启时 A 有 `WAITING_APPROVAL` | DB 仍 `WAITING_APPROVAL`，`error = null`，版本号 **10 → 10**（0 写入）；A 本地状态不变 |
| 2 | 双实例并发认领同一任务 | 两个独立连接并发，**恰好 1 个成功**；`lease_owner` 与胜者一致 |
| 3 | 租约过期接管 + 原实例写回 | B 接管成功；A 写回命中 **0 行** → `LEASE_LOST`；最终唯一 `COMPLETED`（B 持有），步骤 2/2 无重复 |
| 4 | 心跳跨过一个租约周期 | 租约 600ms，心跳 10 次 / 2130ms，B 每次认领均为空，持有者始终 A |
| 5 | approve 打到非持有实例 | B 返回 **202** `{approval:'queued', owner:A}`；A 完成后 `COMPLETED`，步骤 3/3 唯一，审批记录 1 条；再次 approve 409 |
| 6 | 长跑回归（缩短为 30 轮） | 30/30 完成，0 失败，90 steps，1 storageState ref，RSS 184.2→189.5MB（峰值 192.2MB），Browser 1 / Context 0 / PG 峰值 4 |

清理：长跑删除 30 行任务 + 1 行 storageState；多实例 schema `DROP` 前 4 tasks / 7 steps /
1 approval / 1 session state / 1 notification，删除后 schema 不存在。

## 这一版没有覆盖什么

- **小时级长跑**：只跑 30 轮 / 31.1s（为控 CI 时长从 100 轮缩短，断言未放宽）。
- **真实商品页长跑**：仍依赖本地前端 + 既有 SCM 环境，未纳入 CI 门禁。
- **续跑而非重跑**：过期 `RUNNING` 被接管后从头执行，是「至少一次」，不是断点续跑。
- **幂等 / 副作用去重**：没有实现；被接管任务可能重复执行已完成的步骤。
- **审批超时 / 会话回收**：`WAITING_APPROVAL` 会一直保留会话；只有租约过期（持有者崩溃）才回收。
- **同 key storageState 并发归档**：仍为最后完成者覆盖，没有加锁。
- **firefox / WebKit**：未验证。

## 升级与回滚

- 数据库：`npm run db:init` 会在已有表上幂等补列（`lease_owner / lease_expires_at /
  heartbeat_at / version`）并创建 `browser_task_notification`；无需手工迁移。
- 回滚到 0.2.x：新增列与通知表可以保留，旧代码不读写它们；旧版本启动仍会整表失败，
  建议回滚前先停止全部实例。
- 多实例部署：所有实例必须指向同一个库，并配置相同的租约 / 心跳参数；心跳必须显著小于租约
  （默认 15s / 60s）。
