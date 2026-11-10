# LL-MVP-006 · 真实签到、团队奖励资格、奖品库存与一次性核销凭据

> 对应 [Issue #62](https://github.com/sanchuang-dev/local-life/issues/62)。
> 本文描述本期**已经交付的完整履约链**：共享契约、Drizzle schema、迁移 `0006`、活动奖励计划写入链、
> 服务层（`rewards/service.ts`）、HTTP 路由（`rewards/routes.ts`）、居民 H5/管理台接线，
> 以及刻在 SQLite 上的不变量。
>
> 上游关系：[#59](https://github.com/sanchuang-dev/local-life/issues/59) 活动发布、
> [#60](https://github.com/sanchuang-dev/local-life/issues/60) 三人团、[#61](https://github.com/sanchuang-dev/local-life/issues/61) 网格员 CRM 均已合入 `dev`；
> 本文只依赖它们的事实表，不修改其语义。对账（#64）、商城、支付与部署不在本期范围。

> **本文的维护状态（t16 审计后）**
>
> 本文初稿写于 t1~t2，只有数据基座。此后经过六轮结构性修改，**初稿的边界声明与部分不变量已经失效**。
> 2026-11-05 做过一次「设计文档 ↔ 运营手册 ↔ 实现」三方核对，按**实现为准**逐项改正，
> 过程与证据见 [`evidence/ll-mvp-006/design-vs-impl-audit.md`](evidence/ll-mvp-006/design-vs-impl-audit.md)。
>
> | 轮次 | 改了什么 | 影响本文哪几节 |
> | --- | --- | --- |
> | t7 | 普通编辑不再静默清空已发布活动的冻结计划（三态 `rewardPlan`） | §2.1 |
> | t8 | 唯一键从「规则版本级」改成「活动级」 | §2、§3、§4（不变量 5、11） |
> | t9 | 发布后禁止改动奖励计划（`reward_plan_locked`） | §2.3、§8 |
> | t10 | 非受领人轮换凭据、核销后死码、暂停/结束后仍可领取核销 | §6 |
> | t11 | `eligible` 收敛为与 `unavailableReason` 同源 | §2.1 |
> | t13 | 签到窗口必须落在活动起止之内（写路径校验） | §2.2 |
>
> 运营视角的操作步骤与已知边界见 [`evidence/ll-mvp-006/operator-guide.md`](evidence/ll-mvp-006/operator-guide.md)；
> 本文是**实现视角**，两者对同一事实的表述必须一致。

## 1. 边界

已交付（本卡）：

- 共享契约 `packages/contracts/src/rewards.ts`：`REWARD_ROUTES`、签到/奖励/凭据/核销/争议的
  请求与响应 schema（全部 `z.strictObject` 或带 `superRefine` 的显式不变量）；
- `API_ERROR_CODES` 追加 9 个错误码（见 §8）；
- `activityRewardPlanSchema` 并嵌入 `activityKeyRulesSchema.rewardPlan`，
  另有独立写路径 schema `activityKeyRulesWriteSchema`（见 §2.2）；
- Drizzle schema 六张表：`activity_checkins`、`activity_reward_grants`、`activity_reward_codes`、
  `activity_prize_stocks`、`activity_reward_events`、`activity_reward_disputes`；
- 迁移 `0006`：建表 + 唯一索引 + 部分唯一索引 + CHECK 约束 + 32 个触发器；
- 活动奖励计划写入链：`activities.reward_plan_json` 列 + `createActivity`/`updateActivity`/`currentKeyRules`
  三处读写，使 `rewardPlan` 真正进入发布时冻结的规则快照；
- 服务层 `apps/api/src/rewards/service.ts`（2929 行）：签到、核验、作废、达标判定、领奖、
  签发凭据、核销、换发、争议与冲正、台账与事件追加；
- HTTP 路由 `apps/api/src/rewards/routes.ts`（491 行）：`registerRewardRoutes` 注册 `REWARD_ROUTES`
  全部 12 条路由，含社区与角色核对、CSRF、受领人鉴权；
- 居民 H5（签到进度、我的奖励与凭据）与管理台（奖励计划表单、现场核验核销）接线；
- 测试 99 条（奖励相关，分布见 §9），含真实双进程并发与旧库升级。

不在本卡：

- 部署、商城、支付、与 #64 的对账；
- 微信模板消息与消息推送；
- 采购/供应商侧流程。

## 2. 业务边界：一场活动 / 一类礼品 / 一次核销

三条边界是本期的产品前提，写进 schema 而不是只写在文档里：

1. **一场活动一类礼品**：一份冻结的 `rewardPlan` 只有 `prizeName` / `prizeUnitCostCents` 两个价格字段，
   没有"奖品列表"。`activity_prize_stocks` 的唯一键是 **`(activity_id, prize_name)`**（t8 起为活动级），
   一项活动只能有一种奖品的一条库存。
2. **一次核销**：一份奖励授予对应至多一个 `active` 凭据（部分唯一索引），一个凭据只能被核销一次
   （状态机触发器只允许 `active → redeemed` 这一条兑付路径）。重复核销在数据层不可能发生。

   真正的并发强制不在触发器，而在**条件 UPDATE 的 `changes()` 计数**：核销语句带
   `WHERE status = 'active'`，执行后断言 `changes() === 1`；两个并发核销只有一方能拿到 1，
   另一方拿到 0 并被判为已核销。这样"检查"与"写入"是**同一条 SQL**，中间没有竞态窗口。
3. **奖励资格只认冻结快照**：达标判定只读 `activity_rule_versions.snapshot_json.rewardPlan` 与
   有效签到行，**不读 `activities` 表的可变列**。

> **唯一键为什么是活动级而不是规则版本级（t8 修复）**
>
> 初稿把唯一键设为 `(activity_id, rule_version_id, prize_name)` 与
> `(activity_id, rule_version_id, team_id)`。这是错的：规则版本会随每次编辑递增，
> 一旦版本号参与唯一键，**同一场活动每改一版规则就能再发一份奖、再开一条库存行**，
> 库存额度与预算按版本分裂，活动级的真实承诺量失去意义。
>
> 现行定义（`0006:90`、`0006:236`）：
>
> ```sql
> CREATE UNIQUE INDEX `activity_prize_stocks_activity_prize_uq`
>   ON `activity_prize_stocks` (`activity_id`,`prize_name`);
> CREATE UNIQUE INDEX `activity_reward_grants_activity_team_uq`
>   ON `activity_reward_grants` (`activity_id`,`team_id`)
>   WHERE `activity_reward_grants`.`status` <> 'revoked';
> ```
>
> 授予索引是**部分索引**：`revoked` 行不占位，所以作废一份未兑付的授予后，
> 该团可以重新达标拿奖；但**同一活动同一团不可能同时存在两份未作废授予**。
> `rule_version_id` 仍保留在表上（记录"当时按哪一版规则发的"），只是不再参与唯一性。

### 2.1 可用性判定：`eligible` 与 `unavailableReason` 单一真相源（t11）

契约 `teamRewardStateSchema.superRefine` 硬性要求 **`eligible === (unavailableReason === null)`**。
两个字段若各自计算，迟早会互相矛盾——t11 之前就是这样：奖品池或预算耗尽时
`eligible` 仍为 `true` 而 `unavailableReason` 已给出耗尽原因，契约校验失败，
居民奖励状态接口直接 **500**。

现行实现（`service.ts:1687-1705`）把 `eligible` **从 reason 派生**，不再独立计算：

```ts
const redemption = frozen === null ? null : redemptionAvailable(frozen, stock)
let unavailableReason = null
if (frozen === null)            unavailableReason = 'reward_plan_not_configured'
else if (lifecycle !== null)    unavailableReason = lifecycle
else if (!seatsSatisfied)       unavailableReason = 'team_incomplete'
else if (!checkinsSatisfied)    unavailableReason = 'checkin_incomplete'
else if (alreadyGranted)        unavailableReason = null
else                            unavailableReason = redemption
const eligible = frozen !== null && lifecycle === null && seatsSatisfied &&
                 checkinsSatisfied && !alreadyGranted && redemption === null
```

**reason 的优先级是固定的**，同一个团队只会看到"最靠前的那一个"阻塞原因：

| 顺序 | 条件 | `unavailableReason` |
| --- | --- | --- |
| 1 | 快照无 `rewardPlan` | `reward_plan_not_configured` |
| 2 | 生命周期不允许（draft / paused / 已结束） | `activity_not_published` / `activity_ended` |
| 3 | 团队不满 3 席 | `team_incomplete` |
| 4 | 已核验签到不足 3 条 | `checkin_incomplete` |
| 5 | 已经领过（含已核销） | `null`（不是"不可用"，是"已完成"） |
| 6 | 库存池或预算耗尽 | `stock_exhausted` / `budget_exhausted` |
| — | 以上都不成立 | `null`，`eligible = true` |

> 第 5 行是刻意的：**已经领过不算"不可用"**，否则同一份奖励会在"已领取"和"不可用"
> 两种语义间摇摆。前端据 `grant` 字段单独渲染"已领取"。

### 2.2 签到窗口必须落在活动起止之内（t13）

`checkinWindow` 与 `activities.startsAt` / `endsAt` 之间**必须有交叉校验**，否则可以配出
"活动 11-20 开始、签到窗口 11-01~11-10"这种活动——发布成功，居民在活动开始前就能签到、
达标、领奖、核销。`lifecycleBlockReason` 只拦 draft / paused / 已结束，
**不拦"已发布但还没开始"**，所以这条只能由窗口自身保证。

**规则**：`checkinWindow ⊆ [startsAt, endsAt]`，两端闭区间（等于边界合法）。
违反时创建与编辑都被拒绝，错误信息指出是 `opensAt` 还是 `closesAt` 越界。

**实现位置（重要）**：校验在**写路径** `activityKeyRulesWriteSchema`
（`packages/contracts/src/index.ts`）上，由共享函数 `assertCheckinWindowInsideActivity` 施加，
服务于 `createActivityRequestSchema` 与 `updateActivityRequestSchema`。
**读路径** `activityKeyRulesSchema` **保持宽松**。

> **为什么分层，而不是把校验直接加进 `activityKeyRulesSchema`**
>
> `activityKeyRulesSchema` 同时是**已存快照的解析器**——每条
> `activity_rule_versions.snapshot_json` 的读取都要走它。若把交叉校验折叠进去，
> 修复前已经发布的活动会集体读不出来。实测（详见审计报告 §6.2）：
> `listActivityRuleVersions`、`getCheckinState`、`getAdminRewardOverview` 三处抛 `ZodError`，
> **且 `updateActivity` 也抛错——运营连把错的行改回来都做不到**。
>
> 分层后：新输入严格拒绝、存量数据照常可读、越界的行可以修复。三种情形都有测试锁定。

编辑时若请求体**省略** `rewardPlan` 键（继承存量计划），系统只拒绝"合并后**新产生**越界"的改动；
**存量已越界的行仍可编辑**，这是让运营能修回来的必要条件。

### 2.3 发布后奖励计划冻结（t9）

活动进入 `published` 或 `paused` 后，**奖励计划一个字都不能改**。
`REWARD_PLAN_FROZEN_STATUSES = {published, paused}`，判定由 `assertRewardPlanUnchanged`
（`activities/service.ts:274`）在**任何写库动作之前**、对**原始请求体**执行，
错误码 `reward_plan_locked`。

> **为什么必须冻结**：库存台账以 `(activity_id, prize_name)` 为键。改奖品名会**开出一条全新的库存行**，
> 于是活动级数量与预算的账目被静默重置——看上去"还能再发一轮"。冻结把这条路堵死。
>
> 冻结不等于不能编辑活动：标题、描述、地点等字段照常可改，改的只是 `rewardPlan` 子树。

### 2.4 快照未配置奖励 ⇒ 正式奖励入口不可用

`activityKeyRulesSchema.rewardPlan` 是 `nullable().optional()`：

- `optional`：`0000–0005` 时期冻结的规则快照没有这个键，必须继续可解析且字节不变；
- `nullable`：运营显式清空计划时写 `null`。

消费端统一归一化为 `snapshot.rewardPlan ?? null`。**当它为 `null`/`undefined` 时，签到、达标查询、
领奖与核销必须返回 `reward_unavailable`，禁止回退去读 `activities` 表的可变列**（含本次新增的
`reward_plan_json`）。理由：活动配置只有在发布时被冻结才算数，读可变列等于让运营事后改配置追溯生效。
`adminActivityRewardOverviewSchema.planSource` 因此只有 `rule_version_snapshot` / `none` 两个值，
没有"读活动列"这个来源。

**三态语义（t7）**：`updateActivity` 用 `withEffectiveRewardPlan(incoming, current)` 严格区分：

| 请求体里的 `rewardPlan` | 含义 |
| --- | --- |
| 键不存在 | **继承**已存计划（从 `current.rewardPlanJson` 解析） |
| 键存在且为 `null` | **显式清空** |
| 键存在且有值 | **覆盖**（仅限 draft；已发布/暂停会被 §2.3 拒绝） |

t7 之前只有"键存在"与"键不存在"两态，普通编辑（例如只改标题）会把已发布活动的冻结计划
**静默清空**，此后所有奖励入口返回 `reward_unavailable`。

## 3. 数据模型

### `activity_checkins` — 真实签到

| 列 | 说明 |
| --- | --- |
| `id` | UUID 主键 |
| `activity_id` / `user_id` | `restrict` FK；签到人身份 |
| `team_id` / `seat_no` | 可空 `restrict` FK → `activity_teams`；签到时的团籍，`seat_no` 1..3 |
| `status` | `valid` \| `revoked` |
| `checked_in_at` | 真实签到时刻（毫秒） |
| `verified_at` / `verified_by_staff_id` | 现场核验印记；全空或全非空 |
| `revoked_at` / `revoked_by_staff_id` / `revoke_reason` | 作废印记；撤销时三者必填 |

只有 `status='valid'` **且** `verified_at IS NOT NULL` 的签到计入达标。
自报签到单独存在时永远无法解锁奖品。

> **实现口径**：服务层的判定条件是 SQL 里的 ``sql`${activityCheckins.verifiedAt} IS NOT NULL` ``
> （`service.ts:868`）。契约 `packages/contracts/src/rewards.ts` 导出的
> `checkinCountsForReward()` 表达同一语义，但**目前没有任何调用方**（零消费导出），
> 不要误以为它是判定入口。

### `activity_reward_grants` — 团队奖励授予

| 列 | 说明 |
| --- | --- |
| `activity_id` / `team_id` | `restrict` FK；二者组成**活动级**唯一键（部分索引，排除 `revoked`） |
| `rule_version_id` | `restrict` FK；记录按哪一版规则发放，**不参与唯一性** |
| `prize_name` / `quantity` / `unit_cost_cents` / `total_cost_cents` | 授予时从冻结快照复制的价格与数量 |
| `status` | `granted` → `redeemed` \| `revoked` \| `expired`；`redeemed` → `disputed` → `reversed` |
| `recipient_role` / `recipient_user_id` | `leader` \| `member`，由 `claimRecipient` 决定谁可领 |
| `granted_at` / `redeemed_at` / `redeemed_by_staff_id` | 授予与一次性兑付印记 |
| `revoked_at` / `revoked_by_staff_id` / `revoke_reason` | 未兑付作废印记 |

### `activity_reward_codes` — 一次性核销凭据

| 列 | 说明 |
| --- | --- |
| `grant_id` / `activity_id` / `team_id` | `restrict` FK；凭据必须与其授予同活动同团 |
| `code_hash` | **只存 sha256 十六进制**（64 位小写），明文只在签发响应出现一次 |
| `code_suffix` | 末 4 位 Crockford base32，供人工核对纸券 |
| `status` | `active` → `redeemed` \| `superseded` \| `expired` \| `revoked` |
| `issued_at` / `expires_at` | TTL 来自冻结计划的 `redemptionValidHours` |
| `redeemed_at` / `redeemed_by_staff_id` | 核销印记 |
| `superseded_at` / `revoked_at` | 换发与作废印记 |

### `activity_prize_stocks` — 库存与预算台账

| 列 | 说明 |
| --- | --- |
| `activity_id` / `prize_name` | **活动级**唯一键；一行 = 一场活动的一种奖品 |
| `rule_version_id` | `restrict` FK；记录库存行由哪一版快照建立，**不参与唯一性** |
| `unit_cost_cents` / `total_quantity` / `budget_cap_cents` | 从冻结快照复制，写入后不可改 |
| `claimed_quantity` | 已承诺占用（含已核销） |
| `redeemed_quantity` | 已实际核销 |
| `committed_budget_cents` | `= claimed_quantity * unit_cost_cents` |
| `redeemed_budget_cents` | `= redeemed_quantity * unit_cost_cents` |

三条 CHECK 恒等式（`0006`，任何一条不成立即 `ABORT`）：

```sql
-- quantity_check
claimed_quantity >= 0
  AND redeemed_quantity >= 0
  AND claimed_quantity <= total_quantity
  AND redeemed_quantity <= claimed_quantity
-- budget_check
  AND committed_budget_cents = claimed_quantity  * unit_cost_cents
  AND redeemed_budget_cents  = redeemed_quantity * unit_cost_cents
  AND committed_budget_cents <= budget_cap_cents
-- unit_cost_check
unit_cost_cents > 0 AND total_quantity > 0 AND budget_cap_cents > 0
```

预算列不是独立维护的计数器，而是**由数量推导**的：写错数量时预算列自动矛盾，
UPDATE 会被 `budget_check` 拒绝。这让"台账可对账"成为数据库保证，而非应用层自觉。

### `activity_reward_events` — 追加式流水

`(activity_id, sequence)` 唯一，`sequence > 0`；`kind` 为 11 个受约束事件名；`UPDATE`/`DELETE` 一律 `ABORT`。

### `activity_reward_disputes` — 追加式争议线程

`opened` 打头，至多一条终局 `reversed` / `dismissed`；没有任何改写路径。

## 4. 不变量

刻在数据库里的（迁移 `0006` 实测全部生效，见 §7）：

1. **有效签到唯一**：`UNIQUE(activity_id, user_id) WHERE status='valid'`。
   同一人对同一活动最多一条有效签到；撤销后可重新签到，历史行保留。
2. **签到只在冻结窗口内**：`activity_checkins_window_guard` 要求活动为 `published`、
   快照有 `rewardPlan`、`checked_in_at` 落在 `checkinWindow` 内；窗口来自快照而非活动列。

   > **已知精度事实（不是毫秒精确边界）**：SQLite 的 `strftime('%s', iso8601)` 只到秒且**向下取整**，
   > 守卫因此写成 `checked_in_at >= strftime('%s', opensAt)*1000` 与
   > `checked_in_at < (strftime('%s', closesAt)+1)*1000`，即"截止秒的末尾"。
   > 当 `closesAt` 带毫秒分量时，实际放行的最晚时刻比字面边界**最多宽松不到 1 秒**；
   > 反之 `opensAt` 的毫秒分量会被向下取整，最多**提前不到 1 秒**放行。
   > 这是 SQLite 内建函数的能力边界，不是本迁移的疏漏：若要毫秒精确，需在服务层用
   > 整型毫秒列或 `substr`/`julianday` 自行解析，本期不引入该复杂度。
   > 具体到本卡：契约 `isoTimestamp` 允许毫秒，但运营配置的窗口边界通常落在整秒上，
   > 此时守卫是精确的。
3. **签到不可删除、身份不可改**：`activity_id`/`user_id`/`team_id`/`seat_no`/`checked_in_at`
   为 immutable；`DELETE` 直接 `ABORT`；`status` 只能 `valid → revoked`。
4. **核验与撤销都是写一次**：`verified_at` 只能由空变为非空；撤销印记只能在
   `valid → revoked` 的那次更新里写入。
5. **一队一份奖励（活动级）**：`UNIQUE(activity_id, team_id) WHERE status <> 'revoked'`。
   并发达标时后到者在索引上失败，不需要应用层判重。
   用**部分索引**排除 `revoked` 是刻意的：作废一份未兑付授予后该团可以重新达标，
   但同一活动同一团不可能同时存在两份未作废授予。`rule_version_id` 不参与唯一性——
   否则活动每改一版规则就能再发一份奖（t8 修复）。
6. **授予价格永久冻结**：`activity_reward_grants_frozen_plan_guard` 要求
   `prize_name` / `unit_cost_cents` / `quantity` 等于该 `rule_version_id` 快照里的
   `prizeName` / `prizeUnitCostCents` / `prizeQuantityPerTeam`；且 `rule_version` 必须属于同一活动、
   `team` 必须属于同一活动。授予后价格列不可 UPDATE。
7. **授权状态机单向**：`granted → redeemed|revoked|expired`、`redeemed → disputed`、`disputed → reversed`；
   其余转换被触发器拒绝。
8. **核销恰好一次**：`activity_reward_grants` 与 `activity_reward_codes` 的核销印记都是 write-once；
   凭据只允许 `active → redeemed` 兑付，重复核销被拒绝。
9. **凭据只存哈希**：`code_hash` 必须是 64 位小写 hex；每份授予至多一个 `active` 凭据
   （部分唯一索引），换发只能把旧码置 `superseded`，不能删除或覆盖。
10. **库存与预算可对账**：`claimed <= total`、`redeemed <= claimed`、
    `committed = claimed*unit <= budget_cap`、`redeemed = redeemed_qty*unit`；
    库存行的单价/总量/预算上限来自快照，写入后不可改。
11. **库存行也是活动级唯一**：`UNIQUE(activity_id, prize_name)`。改奖品名等于换一种奖品，
    需要新的库存行；但同一活动同一奖品名永远只有一条台账行，额度不会被版本递增重置（t8 修复）。
12. **已核销不因反转而回退**：`activity_prize_stocks_redeemed_monotonic` 拒绝让
    `redeemed_quantity` / `redeemed_budget_cents` 变小。已兑付转争议或冲正时，
    **不得**把 `redeemed` 减回去；冲正只由 `activity_reward_disputes` 与 `activity_reward_events`
    的追加行表达。这样台账与审计永不打架。
13. **未兑付作废可释放占用**：撤销一份 `granted`/`expired` 的授予时，
    `claimed_quantity` / `committed_budget_cents` 可以下调（只要不跌破 `redeemed`），
    从而把库存与预算还给池子。
14. **流水与争议只追加**：两张表的 `UPDATE`/`DELETE` 全部 `ABORT`；事件 `sequence` 正数且活动内唯一；
    争议必须先 `opened`、终局后不可再追加。

## 5. 状态机

下列每一条边都由 `0006` 的 `*_status_transition` 触发器强制，写成触发器允许的集合，不是示意图。

```text
签到     (无) → valid ──verify──> valid+verified ──revoke──> revoked
                    └─────────────────revoke──────────────────┘

         行级终态：revoked 行不能再变回 valid。
         业务层：作废后居民可以【重新签到】，产生一条全新的 valid 行
         （唯一索引是部分索引 WHERE status='valid'，revoked 行不占位）。

授予     (无) → granted ──redeem──> redeemed ──dispute──> disputed ──reverse──> reversed
                  ├──revoke──> revoked          （仅未兑付）

         触发器允许的完整集合：
           granted  → redeemed | revoked | expired
           redeemed → disputed
           disputed → reversed | redeemed      （redeemed 由 t17/0007 新增）
         注意：expired 是【不可达状态】——契约与 CHECK 允许，但没有任何代码写它，
         也【没有】expired → revoked 这条边（初稿画了，实现没有）。

凭据     (无) → active ──redeem──> redeemed
                  ├──supersede──> superseded
                  ├──expire────> expired
                  └──revoke────> revoked

争议     (无) → opened ──reverse──> reversed
                     └──dismiss──> dismissed
```

`disputed` 是本设计里"已兑付但存在争议"的唯一表达：`redeemed_at` 保留不动，
争议事实写在追加表里，库存 `redeemed` 计数同样不回退。

> **`disputed → redeemed`：t17 新增（迁移 `0007`）**
>
> 争议线程驳回（`dismissed`）意味着"这份奖品发得没问题"，授予必须回到 `redeemed`。
> `0006` 的状态机没有这条边，于是驳回后授予永久停在 `disputed`：五条处置路径全部 409，
> `stock.redeemed_quantity` 与 `counts.grantsRedeemed` 永久差 1，居民端恒显"争议中"
> 却无任何工具可解。
>
> 迁移 `0007_dispute_dismissed_restores_grant.sql` 做两件事，缺一不可：
>
> 1. `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` **替换**（不是 `CREATE IF NOT EXISTS` 叠加）
>    `activity_reward_grants_status_transition`，只加 `disputed → redeemed` 一条边，
>    其余边原样保留；
> 2. 一条 `UPDATE` **回填存量**：把「`status='disputed'` 且**最新一条**争议记录为 `dismissed`」
>    的授予恢复为 `redeemed`。**只加边救不了已卡死的行**——没有代码会回头遍历它们。
>    取最新一条用 `ORDER BY created_at DESC, rowid DESC LIMIT 1`，与 `selectOpenDisputeId`
>    口径一致，因此"驳回后又重开"的行正确地留在 `disputed`。
>
> **不改 `0006`**：已应用的库不会重读它，且 Drizzle 迁移器不比较 SQL 文本，改 0006 会静默不生效。
>
> 顺序是强制的：回填 `UPDATE` 必须在触发器替换**之后**，否则旧触发器会把这条修复语句本身驳回。
>
> 恢复的是**状态标记**，不是重新核销：`redeemed_at` / `redeemed_by_staff_id` 原样保留，
> `redeemed` 计数不回退。冲正（`reversed`）路径语义完全不变。

## 6. 与 #59 / #60 / #61 的关系

| 上游 | 本文如何依赖它 | 本文不做什么 |
| --- | --- | --- |
| #59 活动发布 | 借用 `activity_rule_versions` 的冻结快照作为奖励配置唯一真相源；本期只新增 `activities.reward_plan_json` 一列承载草稿态计划 | 不改发布/暂停/结束的状态机本身；但奖励面**必须与签到面同一生命周期判定**（见下） |
| #60 三人团 | 借 `activity_teams` / `activity_participations` 判定"3 席"；`team_id` 作为授予唯一键的一部分 | 不新增退团/解散/换团，不复制席位事实到奖励表 |
| #61 网格员 CRM | 无耦合：奖励表不含任何网格员、销售人、佣金字段 | 不做销售归因与提成，不读 CRM 表 |

奖励资格 = 团队 3 席 + 该团成员的 3 条**已核验**签到 + 冻结快照里的 `rewardPlan` 存在。
三者缺一，`teamRewardState.eligible` 为 `false` 并由 `unavailableReason` 说明原因。

**生命周期门禁（签到 / 领取 / 核销共用同一判定）**：`lifecycleBlockReason()` 是唯一真相源，
`checkinBlockReason`、`buildTeamRewardState`、`claimTeamReward`、`redeemCredential` 全部调用它，
不允许各自再写一份 `if`。判定顺序：
`draft → activity_not_published`；`ended → activity_ended`；`paused → activity_not_published`；
`published` 但已过 `endsAt → activity_ended`；否则放行。

这修掉了一处真实缺陷：此前 `claimTeamReward` 只拦 `draft`、`redeemCredential` 完全无门禁，
导致"签到面已关、领奖与核销仍开着"——达标后暂停仍能 `claim 200` 扣库存，领取后暂停仍能 `redeem 200`。

## 7. 迁移 `0006` 与验证证据

`0006_wakeful_wallow.sql` 由 `drizzle-kit generate` 生成建表/索引 DDL，再手写追加约束层；
对象命名稳定，因此再次 `drizzle-kit generate` 输出 `No schema changes`（幂等）。

本卡实际执行并通过的验证：

```bash
pnpm --filter @sanchuang-dev/local-life-contracts build
pnpm typecheck
pnpm --filter @sanchuang-dev/local-life-api test
```

- 契约构建通过；
- 全工作区 `typecheck`（contracts / api / admin / web）通过；
- 全工作区 `pnpm check`（oxlint + typecheck + API 测试 + 全量构建）**exit 0**；
- API 测试 **189/189 通过**（其中奖励相关 107 条，分布见 §9），既有 `activities.test.ts` 的
  `deepEqual(v1.snapshot, frozenRulesV1)`（"必须字节一致"）继续成立——因为
  `rewardPlan` 是 `optional`，无计划的规则快照不新增 `rewardPlan: null` 键。

新增 `apps/api/test/rewards-data.test.ts`（6 个用例，真实 SQLite + 真实迁移，无 Mock）：

1. **奖励计划进入冻结快照**：无计划 → 列 `NULL` 且发布出的快照键集合恰为 #62 之前的六个键；
   有计划 → 发布快照 `rewardPlan` 与写入值 `deepEqual`；随后改写活动可变列，
   快照仍保持原值（证明履约读快照、不读活动列）。
2. **0006 硬约束逐条生效**：窗口守卫拒绝窗口外签到；同一居民第二条有效签到被部分唯一索引拒绝；
   快照外定价的库存行/授予行被触发器拒绝；冻结单价与总价不可 UPDATE；
   `claimed > total`、`committed > cap` 被 CHECK 拒绝；台账行不可 DELETE；
   授予 `granted → disputed` 非法；流水 UPDATE/DELETE 被拒。
3. **凭据**：非 hex 哈希、小写后缀、TTL 倒挂、同一授予第二条 `active` 凭据全部被拒；
   核销后二次核销被拒；凭据不可 DELETE。
4. **已兑付转争议再冲正**：`redeemed_at` / `redeemed_by_staff_id` 保留不动；
   `redeemed_quantity` 回退被 `redeemed_monotonic` 拒绝；争议以追加行表达。
5. **未兑付作废**：缺印记的作废被 CHECK 拒绝；带印记作废后可将
   `claimed`/`committed` 释放回 0（台账允许，且不跌破 `redeemed`）。
6. **旧库就地升级**：截取 `0000–0005` 造出"没有 `reward_plan_json` 列"的真实旧库，
   升级后该列为 `NULL`（不回填），活动/社区数据保留，六张新表与全部 `restrict` 外键就位。

修复的相邻缺陷：`apps/api/test/crmeb-orders.test.ts` 的"迁移 0005 就地升级旧事件表"
用例原本用 `entries.filter(tag !== '0005_*')` 伪造 0005 之前的库；新增 `0006` 后，
该过滤会把 0006 一起装进"旧库"，drizzle 记录下更新的 `when` 后便跳过 0005，
导致 `no such column: sequence`。改为按 `idx <= 4` 截取后恢复通过；未改动任何断言语义。

## 8. 错误码

`API_ERROR_CODES` 追加（值与键同名风格一致）：

| code | 场景 |
| --- | --- |
| `reward_unavailable` | 快照无 `rewardPlan`、活动不可用，或资格条件不满足 |
| `checkin_duplicate` | 同一活动已有有效签到 |
| `checkin_not_verified` | 签到未核验，不能计入达标 |
| `reward_already_redeemed` | 该授予/凭据已核销，不能再次核销 |
| `redemption_code_invalid` | 凭据不存在或哈希不匹配 |
| `redemption_code_expired` | 凭据已过期（含 `redemptionValidHours` 到期） |
| `prize_stock_exhausted` | 库存池已无可用份额 |
| `budget_exceeded` | 预算上限不足以再承诺一份奖品 |
| `reward_plan_locked` | 已发布/暂停的活动试图改动奖励计划（t9，见 §2.3） |

> **上表 9 个码中，8 个会作为 HTTP `error.code` 发出，1 个不会。**
>
> 已逐一核对 emit 点：`reward_unavailable` 33 处、`reward_already_redeemed` 10、
> `redemption_code_invalid` 10、`redemption_code_expired` 5、
> `prize_stock_exhausted` 5、`budget_exceeded` 5、`reward_plan_locked` 2、`checkin_duplicate` 1。
>
> **例外是 `checkin_not_verified`**：它在 `API_ERROR_CODES` 里有定义，
> 但**从不作为 HTTP `error.code` 发出**（emit 次数 0）。它只作为 `RewardError.reason`
> ——即 409 `conflict` 响应里的细分原因——出现在"已作废的签到不能核验"（`service.ts:1290`）。
> 契约里的 `code` 与 `reason` 是两层概念，不要拿 `checkin_not_verified` 去比对 `error.code`。

## 9. 当前验证状态

2026-11-05 实测（`pnpm check`）：

| 门禁 | 结果 |
| --- | --- |
| `pnpm --filter @sanchuang-dev/local-life-api test` | **189/189 pass, 0 fail** |
| `pnpm check` | **EXIT=0**（oxlint 17 warnings / 0 errors + typecheck + 全量测试 + 构建） |
| `pnpm typecheck` | **exit 0**（contracts / api / admin / web） |
| admin vitest | 91 passed |

奖励相关测试 107 条：

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `apps/api/test/rewards.test.ts` | 36 | 签到、达标、领奖、库存预算、核销、过期、争议、台账恒等式、追加式拒绝 |
| `apps/api/test/rewards-http.test.ts` | 25 | 真实 HTTP 全链路、权限 403、状态码、负例、t13 窗口越界、t17 继承计划越界 400 |
| `apps/api/test/rewards-version-edit.test.ts` | 7 | 三态 `rewardPlan`、发布后冻结（t9）、规则版本漂移 |
| `apps/api/test/rewards-data.test.ts` | 8 | 迁移 `0006` 触发器逐条拒绝、CHECK 逐个验证、旧库升级 |
| `apps/api/test/rewards-concurrency.test.ts` | 4 | 真实双进程并发：库存/预算/同一张券/规则改版后 |
| `apps/api/test/activities-reward-plan.test.ts` | 16 | 三态 `rewardPlan`、t13 窗口边界、历史行可读/可修复 |
| `apps/api/test/activities-reward-plan-frozen.test.ts` | 11 | 发布后冻结、快照与活动列的隔离 |

## 10. 已知限制与后续

- 签到目前只支持"一场活动一次有效签到"，不做多日连续签到；作废后可重新签到（见 §5）；
- 只支持一类奖品；多奖品需要扩展 `rewardPlan` 为列表并调整库存唯一键，属后续卡。
  独立于本履约链的「今日抽奖」多奖品池见
  [`activity-draw-pool.md`](activity-draw-pool.md)，它不复用 `activity_prize_stocks`，
  也不改变本文件任何发放 / 核销口径；
- 凭据 TTL 只按 `redemptionValidHours` 计算，不提供续期：过期只能重新签发（旧码置 `superseded`）；
- `grant.expired` 与 `rewardEventKind.grant.expired` 是**不可达枚举值**，见 §5；
- 一条授予只能发起一次争议（`activity_reward_disputes_open_first`），驳回后不可重开线程；
  `dismissed` 现在会把授予恢复为 `redeemed`（t17 / 迁移 `0007`），见 §5；
- 活动表 `prizeQuantityCap` / `budgetCapCents` 不参与发奖，真正生效的是冻结计划里的
  `totalPrizeQuantity` / `budgetCapCents`，见运营手册 §8.1。

**已知边界的完整清单**在运营手册
[`evidence/ll-mvp-006/operator-guide.md`](evidence/ll-mvp-006/operator-guide.md) §8；
本文只登记与实现语义直接相关的部分。三方核对过程见
[`evidence/ll-mvp-006/design-vs-impl-audit.md`](evidence/ll-mvp-006/design-vs-impl-audit.md)。
