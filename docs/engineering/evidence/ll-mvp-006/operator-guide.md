# LL-MVP-006 奖励履约 · 运营操作手册与已知边界

- 任务：`t12`；Issue [#62](https://github.com/sanchuang-dev/local-life/issues/62)
- 分支：`feat/ll-mvp-006-checkin-rewards`，基线 `dev@7095b845c3a47a6d08d2ad663b10bcffe51e1194`
- 读者：运营、社区负责人、维护者。**不需要读代码即可判断"这个功能能不能真发一份小礼品"。**
- 编写时间：2026-11-05（Asia/Shanghai）；Node `v22.23.2`、pnpm `10.19.0`
- 门禁：`pnpm check` **exit 0**；API 测试 **189/189 pass, 0 fail**

> **本文的证据纪律**
>
> 本文不写"应该"或"建议"。每条约束都标注它由什么强制：
>
> | 标记 | 含义 | 能否绕过 |
> | --- | --- | --- |
> | **【库】** | 迁移 `0006` 的 CHECK / UNIQUE / 触发器 | **不能**。绕过服务层直接写 SQL 也会被拒 |
> | **【服务】** | `apps/api/src/rewards/service.ts` 的判定 | 只有改代码才能绕过；有对应测试 |
> | **【测试】** | 具体用例名，可 `node --import tsx --test` 单跑 | — |
>
> 编写方式：本文的每条行为都用**真实 SQLite + 真实服务函数**跑过一遍确认，而不是读代码推测。
> 凡是我实测结果与设计文档 `docs/engineering/rewards-fulfillment.md` 不一致的地方，**以实现为准并显式标注 §8《差异与已知缺陷》**。

---

## 0. 一句话结论

**能发。** 一条完整链路是：运营配活动（含奖励计划）→ 发布（计划冻结）→ 3 位居民成团 → 3 次现场核验签到 →
团长/任一成员领奖（服务端生成 10 位码，明文只出现这一次）→ 现场工作人员扫/输码核销 → 台账与追加式审计同时落账。

**奖品数量与预算只认奖励计划（`rewardPlan`）里的字段，不认活动表上的 `prizeQuantityCap` / `budgetCapCents`。**
这是最容易配错的一点，见 §2.1 与 §8.1。

---

## 1. 一次真实发奖的完整操作步骤

### 1.1 配置活动（草稿阶段，管理台 `/activities`）

1. **新建活动**，填标题、社区、起止时间、地点、`budgetCapCents`、`prizeQuantityCap`、四条公开规则文案。
2. **打开"奖励计划"开关**，填 8 个字段（含义与约束见 §2）。
3. **保存**。此时活动是 `draft`，奖励计划还没冻结，**可以随意改**。
4. **发布**。发布动作会把当前全部关键规则写成一版 `activity_rule_versions` 快照，
   奖励计划随之**冻结**（§3 列出的东西从此不能再改）。

> **必须在发布前把奖励计划填好。** 发布后再想加奖励计划，本实现直接拒绝。
> 我实测：`rewardPlan` 缺失的活动**可以发布成功**（状态变 `published`），但之后：
> - 居民端签到面板：`available=false`，`unavailableReason=reward_plan_not_configured`，`checkinWindow=null`
> - 居民端奖励面板：`planConfigured=false`，`reward=null`，`eligible=false`，同一 reason
> - 工作人员手工补签到：`409 reward_unavailable`
> - 领奖：`409 reward_unavailable`
> - 管理台总览：`planConfigured=false`，`stock=null`，`grantsTotal=0`
>
> 也就是说**不会崩，但整条奖励链路对这场活动是关闭的**。管理台会显示"冻结快照里没有 rewardPlan，
> 因此签到、达标、领奖与核销的正式入口都不可用"。**唯一的补救是结束这场活动、重新建一场。**

### 1.2 居民成团（H5 `/community/activity/:activityId`）

- 第 1 位居民确认参与 → 成为**团长，占 1 号席位**，拿到邀请码（32 位小写十六进制，实际由分享链接携带）。
- 第 2、3 位居民凭邀请码加入 → 占 2、3 号席位。
- 第 3 位入座**同一事务内**团队变 `locked`，邀请码立即从接口消失（防止第 4 人）。

**【库】** 席位硬约束（迁移 `0002`，非本卡但决定成败）：
- `unique(activity_id, user_id)` —— 一人一场活动只能参与一次
- `unique(activity_id, leader_user_id)` —— 一场活动只能有一个团长
- `unique(team_id, seat_no)` + `seat_no BETWEEN 1 AND 3` —— 最多 3 席
- 团队锁死后**不可解锁、不可删除**

> ⚠️ **没有退团/踢人/换团。** 服务层 `participation` 只导出 `confirmParticipation` / `getParticipationState` /
> `findParticipationActivity` 三个函数，没有 leave/kick/transfer。**凑错人只能整场活动作废重来。**

### 1.3 居民现场签到（H5 `/community/activity/:activityId`）

- 居民在**签到窗口内**点"签到"→ 写入 `activity_checkins`，`status='valid'`，`verified_at=NULL`。
- **自报签到不计入达标。** 只有 `status='valid'` **且** `verified_at IS NOT NULL` 才算。
- 重复提交**不会**产生第二行（`recordCheckin` 先查已有 valid 行，有则原样返回 `created=false`）。

**【库】** `CREATE UNIQUE INDEX activity_checkins_activity_user_valid_uq ON activity_checkins (activity_id, user_id) WHERE status='valid'`
—— **一场活动一位居民最多一条有效签到，没有日期维度。**

> 这直接回答了 PR #40 的"同一场签到还是跨天"：**一场活动就是一次签到，跨天累计在本实现里不存在。**
> 见 §4.2。

### 1.4 工作人员核验（H5 工作台 `/workbench/verify` 或管理台 `/activities/checkin`）

- **核验**：`POST /admin/activities/:id/checkins/:checkinId/verify` → 写 `verified_at` + `verified_by_staff_id`。
  核验是**一次性**的（`0006` 触发器 `activity_checkins_verify_write_once`）；重复调用返回原行不改。
- **作废**：`POST .../revoke`，**必须填 2–200 字理由**（`activityCheckinRevokeRequestSchema`）。
  作废不是幂等的：已作废的再作废返回 `409`，第一条理由才是权威。

**【库】** 核验与作废印记都是全空或全非空（`activity_checkins_verification_check` / `_revocation_check`），
且 `activity_id`/`user_id`/`team_id`/`seat_no`/`checked_in_at` 的 UPDATE 被触发器直接 `ABORT`。

### 1.5 达标判定（自动，无需操作）

团队同时满足两条才 `eligible=true`：

**【服务】** `SEATS_REQUIRED = 3`、`CHECKINS_REQUIRED = 3`（`service.ts:102-103`），
且**所有**前置门禁为空：奖励计划已配置 → 活动生命周期正常 → 席位满 → 有效签到满 → 尚无授予 → 库存与预算够。

居民端拿到的 `unavailableReason` 就是**第一个**不满足的门禁，顺序固定（`service.ts:1687-1705`）：

| 顺序 | `unavailableReason` | 居民看到 |
| --- | --- | --- |
| 1 | `reward_plan_not_configured` | 本活动暂未配置正式奖励计划，奖励入口未开放 |
| 2 | `activity_not_published` / `activity_ended` | 活动尚未发布 / 已结束 |
| 3 | `team_incomplete` | 团队还未满 3 人 |
| 4 | `checkin_incomplete` | 团队有效签到不足 3 条 |
| 5 | `stock_exhausted` | 奖品库存已发放完 |
| 6 | `budget_exhausted` | 活动奖励预算已用完 |

> **`eligible` 与 `unavailableReason===null` 严格等价。** 这是契约 `teamRewardStateSchema.superRefine`
> 的硬要求，R2 曾在此抓到一次 500（库存耗尽时二者自相矛盾）——现已收敛为单一变量 `redemption`，
> `eligible` 从其派生。回归用例：`an exhausted prize pool closes the claim surface instead of throwing`。

### 1.6 谁去哪里领奖（H5 `/me/rewards`）

- `claimRecipient='leader'` → **只有团长**能领；其他成员调领奖返回 `403 not_recipient`
  （"该奖励仅团队发起人可领取"）。
- `claimRecipient='any_member'` → **任一在座成员**都能领，但**先领的那个成为受领人并永久绑定**。
  之后其他成员再调 → `403 not_recipient`（"该奖励已由团队其他成员领取，凭据只发给受领人本人"）。

**【服务】** `assertGrantRecipient`（`service.ts:2049`）。这条是 R1 抓到的 F1：
早期实现允许任何成员重复领取，而每次领取都会把前一张码 `superseded` ——
**队友可以抢走受领人的码，并让受领人手里的纸作废。**

领奖成功后接口返回 `code`（10 位 Crockford base32，去除易混字符 `I/L/O/U`）。
**这是明文唯一一次出现的地方。**

**【库】** `activity_reward_codes` 只存 `code_hash`（SHA-256，64 位小写十六进制，有 CHECK 校验格式）
与 `code_suffix`（末 4 位，供现场核对）。**库被拖走也拿不到可用码。**

### 1.7 现场核销

- 入口：**H5 工作台 `/workbench/verify` 的"核销凭据码"页签**（`WorkbenchVerifyPage`）。
  网格员输入 10 位码即可，**不需要先选活动**——码自己带出活动与社区。
- 权限：任何后台身份（`admin` / `operator` / `grid_worker`）都能核销，
  但 `operator`/`grid_worker` **必须被分配了该活动的社区**，否则 `403 forbidden`（且写入 `reward.access_denied` 审计）。

> ⚠️ **管理台 `/activities/checkin` 没有核销输入框。** 该页只做核验/作废/争议/作废授予。
> `apps/admin/src/services/rewards.ts` 导出了 `redeemCredentialCode`，但**没有任何页面调用它**。
> 现场核销目前**只能从 H5 工作台做**。见 §8.4。

**核销结果分类**（`redeemCredential`，失败分类是刻意显式的，便于现场判断）：

| 情况 | 返回 | 现场该怎么做 |
| --- | --- | --- |
| 码正确、活动正常、未核销、未过期 | `200` | 发礼品 |
| 码已被核销 | `409 reward_already_redeemed` | 查看记录，**不要重复发** |
| 码已过期 | `400 redemption_code_expired`（同时把该码**持久**标记 `expired`） | 让居民回 H5 重新领一次码（见 §5.3） |
| 码属于别的社区 | `403 forbidden` | 找对应社区的人核销 |
| 码被换发过（旧码） | `404 redemption_code_invalid`（"核销码已失效，请使用最新凭据"） | 用最新那张 |
| 码被作废 / 不存在 / 格式错 | `404`（**统一同一个码**，不泄漏该码是否存在过） | 核对纸质凭据 |
| 活动已暂停/已结束 | `409 reward_unavailable` | 见 §5.4 |

> **活动已结束 + 码已过期时，返回的是 `409 reward_unavailable` 而不是 `400 code_expired`。**
> 生命周期判定在 TTL 之前（`service.ts:2352` 的 gate 在过期检查之上）。这是刻意的：
> 工作人员需要知道"活动关了"，而不是误以为居民拿了个坏码。

### 1.8 核销后台账、预算、审计各怎么变

一次成功的核销，在**同一个 `BEGIN IMMEDIATE` 事务**里写四件事：

| 对象 | 变化 |
| --- | --- |
| `activity_reward_codes.status` | `active` → `redeemed`，写 `redeemed_at` + `redeemed_by_staff_id` |
| `activity_reward_grants.status` | `granted` → `redeemed`，写 `redeemed_at` + `redeemed_by_staff_id` |
| `activity_prize_stocks.redeemed_quantity` | `+grant.quantity` |
| `activity_prize_stocks.redeemed_budget_cents` | `+grant.total_cost_cents` |
| `activity_reward_events` | 追加一行 `grant.redeemed`（含 `sequence`，每活动单调递增） |
| `audit_logs` | 追加一行 `reward.grant.redeemed` |

**注意区分"占用"与"实耗"**：

- **领取（claim）** 时：`claimed_quantity` **+1**、`committed_budget_cents` **+单价**。
  这是**占位**——奖品还没出门，但名额和钱已经不能给别人了。
- **核销（redeem）** 时：只有 `redeemed_*` 两个实耗计数增加，`claimed_*` **不动**。
- 所以管理台看到的 `库存：已承诺 X · 已核销 Y`，`X` 恒 `>= Y`。
  **`X` 才是"还剩多少可发"的分母**（`available_quantity = total - claimed`）。

**【库】** `activity_prize_stocks` 有 CHECK 硬绑这三条恒等式：
`available_quantity = total_quantity - claimed_quantity`、`committed = claimed × unit_cost`、
`redeemed_quantity <= claimed_quantity`。**台账算错一行都存不进去。**

**【库】** 六张新表的追加式约束（32 个触发器，25 条 CHECK，6 个唯一索引）：
`activity_reward_events` / `activity_reward_disputes` 的 UPDATE 与 DELETE 被触发器直接 `ABORT`；
`activity_reward_grants` 与 `activity_reward_codes` 的 DELETE 也被 `ABORT`。
**审计是追加的，任何"删掉不利记录"的操作在数据库层就不可能。**
回归用例：`the append-only tables reject updates and deletes from the service layer`。

---

## 2. 奖励计划各字段：取值含义与硬约束

配置界面在管理台 `/activities` 的"奖励计划"区。**以下约束全部来自 `activityRewardPlanSchema`（`packages/contracts/src/rewards.ts:66`），
前端在提交前用同一份 schema 校验，服务端再校验一次。**

| 字段（界面） | 契约字段 | 约束 | 运营含义 |
| --- | --- | --- | --- |
| 奖品名称 | `prizeName` | 去空白 1–60 字 | **重要**：是台账主键的一半，见 §3 |
| 单件成本（元） | `prizeUnitCostCents` | 整数 1 – 10,000,000 分 | 每份礼品的钱 |
| 每团奖品数量 | `prizeQuantityPerTeam` | 整数 1 – 100，默认 1 | 一个团拿几份 |
| 奖品总库存 | `totalPrizeQuantity` | 整数 1 – 100,000 | **整场活动**的奖品份数 |
| 奖励预算上限 | `budgetCapCents` | 整数 1 – 100,000,000 分 | **整场活动**的钱上限 |
| 领取人 | `claimRecipient` | `leader` 或 `any_member` | 见 §4.1 |
| 签到窗口 | `checkinWindow` | `opensAt` < `closesAt` | 见 §2.3 |
| 核销有效期（小时） | `redemptionValidHours` | 整数 1 – **720**（30 天上限） | 从发码时刻起算 |

**两条跨字段硬校验（发布前就会被拒）：**

- `totalPrizeQuantity >= prizeQuantityPerTeam` —— 库存至少要够一个团。
- `budgetCapCents >= prizeUnitCostCents × prizeQuantityPerTeam` —— 预算至少要够一个团。
  否则"第一个达标的团永远撞预算不足"，所以在配置阶段就拦掉。

### 2.1 `budgetCapCents` 与 `prizeQuantityCap` 的关系 —— **它们没关系**

这是本卡最重要的一条运营结论，我实测确认过：

| 字段 | 谁在读 | 是否影响发奖 |
| --- | --- | --- |
| 活动表 `activities.prizeQuantityCap` | 只被活动 CRUD 读写、管理台展示 | **完全不参与** |
| 活动表 `activities.budgetCapCents` | 同上 | **完全不参与** |
| 计划 `rewardPlan.totalPrizeQuantity` | `redemptionAvailable` / 台账行 `total_quantity` | **是唯一依据** |
| 计划 `rewardPlan.budgetCapCents` | 同上 | **是唯一依据** |

**【服务】** `apps/api/src/rewards/service.ts` 中 `activity.prizeQuantityCap` 与 `activity.budgetCapCents`
出现次数 **0**。台账行在首次领取时按 `frozen.plan.*` 物化（`service.ts:790, 793`）。

**实测证据**（真实 SQLite，构造 `prizeQuantityCap=1` + `budgetCapCents=5000`，
但 `rewardPlan.totalPrizeQuantity=3` + `rewardPlan.budgetCapCents=15000`）：

```text
T. activity.prizeQuantityCap = 1, plan.totalPrizeQuantity = 3
U. grants actually issued = 3 | stock.totalQuantity = 3
V. activity.budgetCapCents = 5000, plan.budgetCapCents = 15000 -> stock.budgetCapCents = 15000
```

三个团各领到一份，台账上限用的是**计划**的 15000，不是活动的 5000。

> **运营动作**：把活动表单上的 `prizeQuantityCap` / `budgetCapCents` 当成**给居民看的公示文案数字**，
> 它们不拦任何事。真正管住奖品的是奖励计划里的两个同名字段。**两处填不一致不会报错，只会让公示与事实不符。**
> 这是本实现的一个设计遗留，见 §8.1。

### 2.2 库存与预算耗尽的判定公式

**【服务】** `redemptionAvailable`（`service.ts:901`），**唯一真相源**：

```ts
if (claimed + perTeam > total)                return 'stock_exhausted'   // 915 行
if (committed + perTeam * unitCost > cap)     return 'budget_exhausted'  // 916 行
return null
```

其中 `claimed`/`total`/`committed`/`cap`/`unitCost` **优先取台账行自己的值**，
台账行不存在时才回落到冻结计划的默认值。理由写在代码注释里：台账行保留它开张时的单价
（`committed = claimed × unit_cost` 的 CHECK 依赖它），若改用新单价预测，
重新定价后的计划会"预测预算耗尽"而实际领取却成功。

**"刚好够"不会误判。** 回归用例：`exactly enough stock for one more team stays eligible`
——两份库存、一队已领、剩一份：`eligible=true`、`unavailableReason=null`、`claimableByMe=true`，且真的领得成功。

**同一断言也用在写路径。** `assertRedemptionAvailable`（`service.ts:2018`）在条件 UPDATE 之前调同一个函数，
所以"读到的原因"与"领取时被拒的原因"永远一致。

**【库】** 真正的强制仍是那条条件 UPDATE：
`WHERE claimed + n <= total AND committed + n*unit_cost <= cap` 且 `changes() === 1`。
预测不等于强制——预测可能过时（并发），UPDATE 不会。

### 2.3 `checkinWindow` 与活动起止时间的关系 —— **必须落在活动之内**

- `checkinWindow.opensAt < closesAt` 是硬校验。
- **`checkinWindow` 必须落在 `[startsAt, endsAt]` 之内**（t13 加入，两端闭区间）。
  越界会在保存时被拒，错误信息指出是 `opensAt` 还是 `closesAt` 越界。见 §8.2。

> **为什么这条必须加**：`lifecycleBlockReason` 只拦 draft / paused / 已结束，
> **不拦"已发布但还没开始"**。加这条之前我实测过：把签到窗口设成 `11-01 ~ 11-10`、
> 活动起止设成 `11-20 ~ 11-30`（窗口**完全早于**活动开始），活动能**发布成功**，
> 居民在 `11-02` 签到**成功**、领奖也**成功**——真实发出一份还没到现场的礼品。
> 修复后这种配置在保存阶段就被拒绝。

实际生效的门禁有两条，各自独立：

1. **活动生命周期**：`published` 且 `now < endsAt` 才放行；
   `draft`/`paused` → `activity_not_published`，`ended` 或已过 `endsAt` → `activity_ended`。
2. **签到窗口**：`now` 必须在 `[opensAt, closesAt]` 内。

> **运营动作**：正常填写即可——窗口越界现在会被系统拦下，不需要你额外小心。
>
> **另一个坑**：如果 `checkinWindow.closesAt` 晚于 `endsAt`，窗口关闭这条分支永远走不到——
> 活动一过 `endsAt` 就返回 `activity_ended`。设计文档 `rewards-fulfillment.md` §6 记的 #59 正是这个修复（签到与领奖必须共用同一套生命周期判定）。
> 现在这种配置也会被 t13 的校验直接拒绝。

### 2.4 `redemptionValidHours`

- 发码时刻 + N 小时 = `expires_at`。**【库】** `CHECK(expires_at > issued_at)`。
- 上限 720 小时（30 天）——**一场 3 天的活动配不出"3 个月有效"的券。**
- 过期后码被持久标记 `expired`（不是删除），见 §5.3。

---

## 3. 发布后不能再改的东西

**【服务】** `assertRewardPlanUnchanged`（`activities/service.ts:255`），
`REWARD_PLAN_FROZEN_STATUSES = {published, paused}`。判定发生在**任何写库动作之前**，且用**原始请求体**判断。

| 能改吗 | 项目 |
| --- | --- |
| ❌ **不能** | 奖励计划的**任何**字段（奖品名、单价、每团份数、总库存、预算、领取人、签到窗口、核销时长、备注） |
| ✅ 能改 | 活动标题、摘要、地点、起止时间、`budgetCapCents`、`prizeQuantityCap`、四条公开规则文案 |

**为什么奖励计划一点都不能动**（代码注释原文的理由，我确认属实）：
奖品台账的主键是 `(activity_id, prize_name)`。**改奖品名不只是改标签**——
下一次领取会按新名字开一条**全新台账行**（`claimed=0`、`total` 取新计划值），
等于**静默重置整场活动的名额与预算**，顺便把奖品换掉。冻结是唯一能堵住这条路的方式。

❌ 尝试修改返回 `409 reward_plan_locked`（"奖励计划发布后不可修改，如需调整请结束活动后新建"）。

**三态语义（`withEffectiveRewardPlan`，`activities/service.ts:206`）：**

| 请求体 | 含义 |
| --- | --- |
| **没有** `rewardPlan` 键 | 继承现有计划（普通编辑的形态，不会误清空） |
| `rewardPlan: null` | 显式清空 |
| `rewardPlan: {...}` | 替换（发布后会被上面那条拒掉） |

回归用例：`apps/api/test/rewards-version-edit.test.ts`（7 条）、
`apps/api/test/activities-reward-plan.test.ts`（三态与冻结）。

> **运营动作**：奖品数量/预算/签到时间窗**必须在发布前想清楚**。
> 发布后想加量，本实现没有"追加额度"的能力——**只能结束活动、建新活动**。
> 已发的奖品与原活动的审计链会完整保留，不会被新活动污染。

---

## 4. 必须在活动开始前确定、发布后不可更改的运营决策

逐条对照 PR #40 的未定项。

### 4.1 团队奖励给谁：队长还是任一成员

**本实现两个都支持，由 `claimRecipient` 选择，且发布后不可改。**

| 取值 | 谁可以"成为"受领人 | 成为之后 |
| --- | --- | --- |
| `leader` | **仅团长**（1 号席位） | 团长独占 |
| `any_member` | **任一在座成员** | **先领者永久绑定**，其余成员 403 |

**为什么 `any_member` 要绑定先领者**（R1 抓到的 F1）：若允许后来者再领，
`issueForExistingGrant` 会把已有 `active` 码 `superseded` 并重发一张新码——
**队友可以抢走奖品，同时让受领人手里的纸当场作废**。所以：

> `any_member` 决定的是"谁**可以成为**受领人"，不决定"谁**可以轮换**已绑定的受领人"。
> —— `service.ts:1853` 附近的注释原文

回归用例：`any_member binds the first claimant and never hands out a second prize`；
HTTP 层 `F1: a non-recipient cannot rotate the recipient credential after a grant exists`。

**运营想改**：只能发布前在奖励计划里选。发布后 → §3。

### 4.2 同一场签到还是跨天累计

**本实现是"一场活动一次签到"，没有跨天概念。**

**【库】** 部分唯一索引 `(activity_id, user_id) WHERE status='valid'`。
一个人一场活动最多一条有效签到。客服删除这条行会撞触发器（`no_delete`）。

**运营含义**：
- 想做"连续 3 天打卡"？**本实现做不到。** 需要改数据模型（加 `checkin_date` 并改唯一索引），
  不是配置能解决的。
- 想核验"人真的到了"？靠**工作人员现场核验**，不靠时间戳。
- 签到被作废后，该居民**可以重新签到一次**（`status='revoked'` 的行不占用唯一索引）。
  实测：作废后 `available=true`、`existing checkin=null`、再次签到 `created=true`。

回归用例：`check-in is idempotent: a resubmission adds no row and no team member`。

### 4.3 团队发起人是否占席位

**占。团长就是 1 号席位。**

**【服务】** 建团时 `seatNo: 1`（`participation/service.ts:650`）。
签到时 `seat_no` 与会话人绑定，字段插入后**被触发器锁定不可改**。

**运营含义**：3 人团 = 团长 + 2 位被邀请者。团长自己也要签到、也要核验，
**"团长拉两个人来自己不用到场"在本实现里拿不到奖。**

### 4.4 其余已定但值得知道的决策

| 决策 | 本实现的选择 | 依据 |
| --- | --- | --- |
| 奖励单位 | **按团**，不是按人。3 人团拿 `prizeQuantityPerTeam` 份 | 契约注释"一场活动 3 人成团得 1 份礼品是唯一支持形态" |
| 一人能否加入多个团 | ❌ 不能。`unique(activity_id, user_id)` | 迁移 `0002` |
| 一个团能否重复领奖 | ❌ 不能。`unique(activity_id, team_id) WHERE status<>'revoked'` | 迁移 `0006` |
| 一场活动能发几种奖品 | **1 种**（计划只有一个 `prizeName`） | 计划 schema 是单对象 |
| 撤销签到后已发的奖怎么办 | **自动进争议**，不自动收回 | §5.2 |
| 核销后能反悔吗 | 只能"争议 → 冲正"，**台账实耗不回滚** | §5.2 |

---

## 5. 已知边界与不支持的场景

### 5.1 攒不够三人怎么办

- 团队停在 2/3 或 1/3：`seatsFilled=2`，`unavailableReason='team_incomplete'`，领奖 `409`。
- 席位满 3 但签到只有 2 条：`unavailableReason='checkin_incomplete'`，领奖 `409`。
- **人员凑不齐时唯一的操作**：结束这场活动，让原班人马去新活动重新组队。
  **没有退团、没有换人、没有解散。**

> 实测：3 人开局、只签到 2 人 → `team_incomplete`；补满 3 席但只签 2 人 → `checkin_incomplete`；
> 第 3 人签到后 → `eligible=true, claimableByMe=true`。

### 5.2 签到被撤销后，居民看到什么

**分两种情况，行为完全不同：**

**(a) 还没领奖 → 奖励直接作废，名额退回**

**【服务】** `applyRevocationConsequence`（`service.ts:1461`）：团队签到跌破 3 条时，
未核销的授予被置 `revoked`，同时台账回滚（`claimed_quantity -= 份数`、`committed -= 金额`），
活跃码置 `revoked`。实测：**旧码 `404`、名额退回、团队可重新领、新码可用。**

**(b) 已经核销 → 自动进争议，台账不回滚**

`grant.status` `redeemed` → `disputed`，并**自动插入一条 `opened` 争议记录**
（理由：`签到撤销后团队不再达标，已核销奖励进入争议`）。

> **奖品已经出门了，系统无法"收回"，只能标记待处理。** 台账的 `redeemed_*` 计数**不减**
> ——这是刻意的：已发生的兑付是事实，不能用一条撤销把它抹掉。

**居民端看到什么**：
- `requirement.checkinsValid` 从 3 变 2
- `eligible=false`、`unavailableReason='checkin_incomplete'`
- `grant.status` 显示为**争议中**
- 凭据区仍显示那张已核销码的尾号（历史事实）

**运营动作**：必须在管理台走 §5.4 的争议流程裁定。

### 5.3 活动结束但还有人没核销

按严重程度分三层：

| 情形 | 结果 |
| --- | --- |
| 活动 `ended` 或过了 `endsAt`，居民还有 `active` 码 | **码不能用了**：核销返回 `409 reward_unavailable`。`claimed` 占位**永远不释放**（因为领取是合法的，只是没来兑） |
| 活动还在 `published`，但居民的码 TTL 过了 | 核销返回 `400 code_expired`，码被标记 `expired`；**居民可以回 H5 重新领一张新码**（`created=false`，但发的是新码），新码可用 |
| 活动已经结束，码也过期了 | 优先返回 `409 reward_unavailable`（生命周期优先）。**此时无解**，只能作废授予释放名额 |

> **实测**：`BB. re-claim (activity published) -> created = false | new code works = true`
> ——只要活动还开着，过期不是死局，让居民重新点一次领奖即可。
>
> **运营动作**：**活动结束前把没核销的人催一遍。** 结束之后系统不会替你做任何补救，
> 名额也不会自动释放。真有剩余礼品，只能作废对应授予（§5.6）后另作安排。

### 5.4 奖品损坏 / 错发怎么处理（争议 → 冲正的真实路径）

**核销过的授予不能直接作废**：`revokeGrant` 对 `redeemed`/`disputed`/`reversed` 一律返回
`409 grant_already_redeemed`（"已核销的奖励只能通过争议流程冲正，不能直接作废"）。

真实操作路径（管理台 `/activities/checkin` → 「核销记录」页签）：

1. 找到该条授予 → 点**「发起争议」** → 填 2–500 字理由 → 提交 `decision='opened'`。
   - `grant.status`: `redeemed` → `disputed`
   - 【库】`activity_reward_disputes_open_first` 触发器保证**一条授予只可能有一个 `opened`**，
     而且**必须是第一条**。线程不能乱序。
2. 线下核实（补发、换货、认定无责……）。
3. 点**「冲正」**（`reversed`）或**「驳回」**（`dismissed`）→ 再填理由。
   - `reversed` → `grant.status` 变 `reversed`
   - `dismissed` → **`grant.status` 恢复为 `redeemed`**，线程关闭

> ✅ **t17 已修复**：`dismissed` 现在会把授予恢复成 `redeemed`。
> 修复前它停在 `disputed` 不动，导致五条处置路径全部 409、`redeemed_quantity`
> 与 `grantsRedeemed` 永久差 1、居民端永远显示"争议中"。
> 现在驳回的含义与运营的直觉一致：**"这份奖品发得没问题"，系统也这么记。**
>
> ⚠️ **但一条授予只能发起一次争议**（`activity_reward_disputes_open_first`）。
> 驳回后授予虽然回到 `redeemed`，**不能再对同一条授予发起第二次争议**——
> 线程是一次性的。若确实需要再处理，走线下补发并记在活动备注里。

**台账**：冲正**不会**回滚 `redeemed_quantity` / `redeemed_budget_cents`。
实测断言：`the reversal keeps the redeemed counters and the redemption stamp intact`
——`redeemed_quantity` 仍为 1，`redeemed_at` 仍在。
**理由**：冲正是一条新事实，不是对旧事实的删除。

### 5.5 跨社区领奖支持吗

**不支持，而且是双重隔离。**

| 层 | 行为 | 实测 |
| --- | --- | --- |
| 工作人员跨社区核销 | `403 forbidden`，并写 `reward.access_denied` 审计 | `H. cross-community redeem -> 403 forbidden` |
| 工作人员跨社区查看活动 | 同上（`requireStaffActivityScope` 先把关，服务层再兜一次） | 回归用例 `a staff actor outside the activity community is refused and the denial is audited` |
| 居民跨社区参与活动 | **可以参与**（这是既有 #60 的行为，本卡未改） | `DA. community-2 resident joined community-1 activity: team = open` |

> **最后一行是既有边界，不是本卡引入的。** `participation` 服务里 `communityId` 出现次数 **0**
> ——居民参与不校验社区归属。奖励链路也不校验。
> **运营含义**：靠"社区归属"防不住外社区居民来领奖；要限制就用活动本身的可见性/邀请码管理。
> 奖品台账与核销权限仍严格按活动所属社区隔离。

### 5.6 作废一条未核销的授予（主动释放名额）

走 `POST /admin/activities/:id/rewards/grants/:grantId/revoke`（管理台「核销记录」页签的作废按钮），
理由 2–500 字。效果（实测）：

```text
I. before revoke: claimed = 1 committed = 5000 codesActive = 1
J. grant revoked -> status = revoked
K. after revoke: claimed = 0 committed = 0 codesActive = 0
L. after revoke resident sees: eligible = true reason = null grant = undefined
M. re-claim after revoke created = true    ← 名额退回，可以重新领
N. OLD code after revoke -> 404 redemption_code_invalid
O. NEW code redeems = true
```

**这才是"奖品不够了想把名额让给别人"的正确手段**（且只能用于未核销的授予）。

### 5.7 其他明确不支持

| 场景 | 现状 |
| --- | --- |
| 退团 / 换团 / 踢人 / 解散 | ❌ 完全不存在 |
| 追加奖品库存/预算 | ❌ 发布后计划冻结，无"追加额度"接口 |
| 一场活动多种奖品 | ❌ 计划只有一个 `prizeName` |
| 跨天累计签到 | ❌ 一场活动一条有效签到 |
| 部分核销（一次核销一半） | ❌ 按授予整体核销 |
| 码的补发（不重新领取） | ❌ 只能通过"重新领奖"换发，旧码作废 |
| 定时扫描过期码 | ❌ **没有任何后台任务**。过期码是在**下次核销尝试时**才被标记 |

---

## 6. 并发安全（用运营能听懂的话）

### 6.1 两个工作人员同时给同一张券核销

**只会成功一次，另一台手机收到明确的"已被核销"。**

保证方式不是"先查再写"（那种做法在并发下会双发），而是一条**带条件的 UPDATE**：
`UPDATE ... SET status='redeemed' WHERE id=? AND status='active'`，数据库返回"影响了 1 行"才算成功。
两台手机同时到，只有一台能拿到这 1 行，另一台拿到 0 行 → 报 `409 reward_already_redeemed`。

**实测**（`apps/api/test/rewards-concurrency.test.ts`，用独立子进程开真实双连接）：
`two connections racing to redeem the same code redeem it exactly once`。

> **运营动作**：另一台手机报"已被核销"，说明**同事刚刚已经发过了**。
> 去看核销记录里的工作人员名字，不要重复发。

### 6.2 两个居民同时抢最后一份

**只会有一个领到，另一个收到"库存已发完"。**

同样是条件 UPDATE：`WHERE claimed + n <= total AND committed + n*cost <= cap`。
两个团同时抢最后一份，只有一个能更新成功（1 行），另一个 0 行 → `409 stock_exhausted`。
钱也一样：`two connections racing for the last budget slot produce exactly one grant`。

**实测三条并发用例**（都是真实双进程 + 真实 SQLite 文件）：
- 抢最后一份库存 → 恰好一个授予
- 抢最后一份预算 → 恰好一个授予
- 抢同一张券核销 → 恰好一次核销

**外加一条**：`two connections racing for the same team prize after a rule edit produce exactly one grant`
——活动改了一版规则后，同一个团重复抢，仍然只有一份奖品（因为授予查找是**按活动**而不是按规则版本）。

> **运营动作**：看到"库存已发完"就是真发完了，不是系统抖动。刷新一下再看总览。

### 6.3 数据库层面的兜底

即使服务层有 bug，也发不出第二份：

**【库】** `unique(activity_id, team_id) WHERE status<>'revoked'` —— 一个团只能有一条非作废授予。
两个事务同时插入，第二个撞唯一索引直接失败。

**【库】** `unique(grant_id) WHERE status='active'` —— 一份授予只能有一张活跃码。
换发时旧码先 `superseded` 再插新码，同一事务内完成。

---

## 7. 本卡明确没有做的

以下**全部未实现**，不应被理解为"配一下就有"：

| 不做的事 | 说明 |
| --- | --- |
| **线上奖品采购 / 供应商对接** | 没有任何采购单、供应商、物流、签收单据。系统只知道"发了 N 份、花了多少钱"，不知道怎么把货买回来 |
| **财务对账（#64）** | 台账里的 `committed` / `redeemed` 是**运营口径的占用与实耗**，不是会计凭证。没有科目、没有期间结转、没有与支付流水核对 |
| **商城订单联动（#63）** | 奖品与商城订单/商品/SKU **完全无关**。不扣商城库存、不生成订单、不发核销通知 |
| **微信模板消息通知** | 领奖、核销、争议、码过期**都不发任何通知**。居民必须自己回到 `/me/rewards` 查看状态。运营催核销只能靠人或微信群 |
| 优惠券/电子卡密 | 只发 10 位码，不做第三方券码兑换 |
| 报表导出 | 管理台只有页面展示，**没有 Excel/CSV 导出** |
| 部分核销、批量核销 | 一次一张券 |
| 奖品替代/换货记录 | 争议理由里可以写文字，但没有结构化的"换成什么"字段 |

---

## 8. 差异与已知缺陷（如实登记）

以下是编写本文过程中**实测发现**的实现与预期不一致之处。
按"以实现为准"原则记录，不粉饰。

### 8.1 活动表的 `prizeQuantityCap` / `budgetCapCents` 不影响发奖

- **现象**：运营在活动表单填的"奖品数量上限"和"预算上限"**不参与任何履约判定**。
  真正生效的是奖励计划里的同名字段。
- **实测**：活动 `prizeQuantityCap=1` + 计划 `totalPrizeQuantity=3` → 发出 3 份。
- **影响**：中等。公示数字与实际容量可能不符，且系统不会提示。
- **本卡处理**：**未改**（超出 t12 文件范围，属活动 schema 语义，需维护者决定是"合并字段"还是"在表单里提示"）。
- **运营规避**：**两处填一样的数**，并把奖励计划当真。

### 8.2 `checkinWindow` 与活动起止时间不交叉校验 —— **已在 t13 修复**

- **原现象**：签到窗口可以完全落在活动起止之外，发布时无告警。
  更关键的是 `lifecycleBlockReason` 只拦 draft / paused / 已结束，**不拦"已发布但还没开始"**，
  所以窗口配到活动开始之前，居民能在活动还没开始时签到、达标、领奖、核销。
- **原实测**：窗口 `11-01~11-10`、活动 `11-20~11-30` → 发布成功、11-02 签到成功、领奖成功。

**修复后的规则（现在会拒绝）**

`checkinWindow` 必须落在 `[startsAt, endsAt]` 之内，两端都是闭区间（等于边界合法）：

| 配置 | 现在的结果 |
| --- | --- |
| 窗口完全在活动之前 | **拒绝**，`checkinWindow.opensAt must not be earlier than startsAt` |
| 窗口完全在活动之后 | **拒绝**，`checkinWindow.closesAt must not be later than endsAt` |
| `opensAt` 比 `startsAt` 早 1 秒 | **拒绝**（边界精确到毫秒） |
| `closesAt` 比 `endsAt` 晚 1 秒 | **拒绝** |
| 窗口恰好等于活动起止 | **通过** |
| 窗口在活动之内 | **通过** |
| 活动没有奖励计划（`rewardPlan` 缺失或 `null`） | **不受影响**，照常创建与发布 |

- **对运营的意义**：**签到窗口填错会被当场拦下，配不出"活动开始前就能领奖"的活动了。**
  错误信息会指出是 `opensAt` 越界还是 `closesAt` 越界，直接改那个字段即可。
- **实现位置**：`packages/contracts/src/index.ts` 的 `activityKeyRulesWriteSchema`
  （与 `assertCheckinWindowInsideActivity`），在**创建**与**编辑**两条写路径上生效。
- **一个刻意的设计选择（值得维护者知道）**：这条交叉校验**没有**加进
  `activityKeyRulesSchema`，而是独立成"写路径 schema"。原因是 `activityKeyRulesSchema`
  同时是**已存数据的解析器**——每一个 `activity_rule_versions.snapshot_json`
  的读取都要走它。若把校验折叠进去，**修复前已经发布的活动会集体读不出来**
  （规则版本列表、居民签到状态、管理台奖励总览全部 500），而且运营连修都修不了
  （编辑动作会先解析存量计划再报错）。所以：**新输入严格拒绝、存量数据照常可读、错的行可以改回来。**
  三种情形都有测试锁定，见下。
- **新增测试**（13 条，全绿）：
  - `apps/api/test/activities-reward-plan.test.ts`：8 条窗口边界（前/后/早 1 秒/晚 1 秒/相等/之内/
    编辑越界被拒/无计划不受影响）+ 3 条历史兼容（存量行可读、可修复、读写 schema 分工不被推翻）
  - `apps/api/test/rewards-http.test.ts`：2 条真实 HTTP（越界 → **400** 且不留残行；之内 → 201）
- **变异验证**：把校验关掉 → 6 条测试转红；把校验折叠回读路径 → 3 条兼容性测试转红。
- **未做（按队长要求留给维护者决策）**：`lifecycleBlockReason` **没有**增加"未到开始时间"这一态。
  那会改变已发布活动的可达性语义，属产品决策。当前实现下，一旦窗口被约束在活动之内，
  "活动开始前不能签到"由**窗口本身**保证，不需要改生命周期判定。

### 8.3 `dismissed` 后授予停在 `disputed` —— **已在 t17 修复**

- **原现象**：争议线程驳回后，线程 `open=false`，但 `grant.status` 仍是 `disputed`。
- **原定性（已推翻）**：本条曾登记为"低影响已知边界"。**R1 第三轮实测证明这个定性是错的**，
  已升级为阻塞缺陷并在 t17 修复：

  | 后果 | 实测 |
  | --- | --- |
  | 五条处置路径全部失效 | `revoke` / `reopen` / `reverse` / `redeem` / `re-claim` 全部 **409** |
  | 两个账面永久差 1 | `stock.redeemedQuantity=1` 而 `counts.grantsRedeemed=0`，收尾对账无从结账 |
  | 管理台无按钮可点 | `openDispute=false`，界面不渲染任何处置动作 |
  | 居民被指向无解的路径 | 恒显"存在争议，请到现场联系工作人员"，而工作人员**没有工具可用** |

  **一个没有过错的居民被永久挂在争议态**——这不是"数据不脏"，是真实的业务事实错误。

- **修复方式**：新增迁移 `0007_dispute_dismissed_restores_grant.sql`，做两件事：
  1. `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` **替换**（不是叠加）状态机触发器，
     增加 `disputed → redeemed` 一条边——让**新**的驳回不再卡死；
  2. 一条 `UPDATE` **回填修复存量**：把「当前 `disputed` 且**最新一条**争议记录是 `dismissed`」
     的授予恢复为 `redeemed`。**光加边救不了已经卡死的行**，因为没有任何代码会回头处理它们。
     判定按 `ORDER BY created_at DESC, rowid DESC LIMIT 1` 取最新一条，与服务层
     `selectOpenDisputeId` 的口径一致，所以"驳回后又重开过"的行会正确留在 `disputed`。
  服务层在 `dismissed` 时同样把授予恢复为 `redeemed` 并追加 `dispute.dismissed` 事件。
  **不改 `0006`**：已应用的库不会重读它，且 Drizzle 迁移器不比较 SQL 文本，改 0006 会静默不生效。
- **现在的一致状态**：驳回后 `grant.status === 'redeemed'`，`redeemed_quantity === grantsRedeemed`。
  `redeemed_at` / `redeemed_by_staff_id` 原样保留——**恢复的是标记，不是重新核销**。
- **未变**：冲正（`reversed`）路径语义完全不变，`redeemed` 计数仍不回退。
- **仍存在的边界**：一条授予只能发起一次争议，驳回后不可重开线程（见 §5.4 步骤 3 的说明）。

### 8.4 管理台没有核销入口

- **现象**：`apps/admin/src/services/rewards.ts` 导出了 `redeemCredentialCode`，
  但**没有任何管理台页面调用它**（实测消费者数 0）。现场核销只能从 H5 工作台 `/workbench/verify` 做。
- **影响**：低（H5 工作台是设计上的主要入口，网格员本来就用手机），
  但"坐办公室的工作人员想用电脑核销"目前做不到。
- **本卡处理**：**未改**（`apps/admin` 不在 t12 文件范围）。
- **运营规避**：现场核销统一走 H5 工作台。

### 8.5 两个枚举值永不可达

- `activity_reward_grants.status` 的 `expired`：CHECK 允许，但**没有任何代码写它**
  （唯一写 `status:'expired'` 的地方是 `activity_reward_codes`，不是 grants）。
- `rewardEventKindSchema` 的 `grant.expired`：契约允许，但**从未被追加**
  （实测 `kind: 'grant.expired'` 出现次数 0）。
- **影响**：极低。不影响任何行为，只是契约里多了两个空壳值。
- **本卡处理**：**未改**（删契约枚举会破坏向后兼容，需单独立项）。

### 8.6 没有过期清理任务，`codesActive` 会在过期后虚高

- **现象**：过期码只在**下次核销尝试时**才被标记 `expired`。没有 cron / 定时扫描
  （`apps/api/src` 里 `setInterval` / `cron(` 出现次数 **0**；仅有的两处定时器在
  `apps/web` 的活动页倒计时，与奖励无关）。
- **实测**：码 TTL 2 小时，3 天后**从未有人尝试核销** →
  数据库里 `status` 仍是 `active`，管理台 `codesActive = 1`、`codesRedeemed = 0`。
- **影响**：低但会误导读数。**不会导致超发**——真核销时仍会被拦（`400 code_expired`），
  只是"在途凭据数"这个指标在活动结束后会偏大。
- **本卡处理**：**未改**（定时任务是部署层能力，本卡明确不做部署）。
- **运营规避**：活动收尾对账时用"**已核销**"数，不要用"在途码"数。

### 8.7 驳回争议后不可重开：**需披露的产品限制**（R1 第四轮裁定，不返工）

- **现象**：驳回（`dismissed`）后授予已正确回到 `redeemed`，但**四条补救路径全不可用**：

  | 想做的事 | 结果 |
  | --- | --- |
  | 重新发起争议 | **409** `dispute_already_resolved` |
  | 反转（`reversed`） | **409** `dispute_not_open` |
  | 再次驳回 | **400** `dispute_not_open` |
  | 撤销授予 | **409** `reward_already_redeemed` |

- **根因**：数据层触发器 `activity_reward_disputes_open_first` 规定**一条授予只允许一个 `opened`**。
  争议线程**一次性、不可重开**。这是**数据不变量，不是 bug**。
- **额外的体验问题**：「撤销授予」被拒时的提示语把用户指向"走争议流程"，
  而此时该流程**已经关闭** —— 提示语指向一条走不通的路。
- **定性**：R1 第四轮判为**需披露的产品限制，不要求本卡返工**。
  建议后续卡评估「驳回后允许重开」（需放宽触发器，属数据模型变更，不该塞进收尾卡）。
- **运营实际做法**：**驳回后不要再尝试系统内操作**。若仍需处理，走线下补发并把结论
  记在活动备注里，以线下台账为准。

### 8.8 【部署】迁移 `0007` 须先于 t17 代码生效

- **现象**：若先发 t17 代码、库仍停在 `0006`，则「驳回争议」返回
  **500 `internal_error`**——**带标准错误体**（不是 B1 那种空 body 500），
  且 grant **不会被脏写**（事务回滚，仍是 `disputed`）。
- **原因**：服务层要写 `disputed → redeemed`，`0006` 触发器没有这条边，`RAISE(ABORT)` 拦下，
  而该错误消息不在 `mapRewardConstraint` 的识别范围内，于是冒泡为 500。
- **窗口期实际为零**：`createDatabase()` 内部**先执行迁移、再返回 `db`**，
  进程拿到可用库句柄之前 `0007` 已应用完毕。只有「新旧实例并行 + 共享库」的滚动发布
  才需要人工先跑迁移。
- **结论**：**`0007_dispute_dismissed_restores_grant` 须先于 t17 代码生效。**

---

## 9. 附：验证与追溯

### 9.1 门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @sanchuang-dev/local-life-api test` | **189/189 pass, 0 fail** |
| `pnpm typecheck` | **exit 0**（contracts / api / admin / web） |
| `pnpm check` | **exit 0**（oxlint 17 warnings / 0 errors + typecheck + 全部测试 + 构建） |

### 9.2 测试分布（奖励相关）

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `apps/api/test/rewards.test.ts` | 36 | 签到、达标、领奖、库存预算、核销、过期、争议、台账恒等式、追加式拒绝 |
| `apps/api/test/rewards-http.test.ts` | 25 | 真实 HTTP 全链路、权限 403、状态码、F1/F2/F3 回归、t13 窗口越界 400 |
| `apps/api/test/rewards-version-edit.test.ts` | 7 | 三态 `rewardPlan`、发布后冻结、规则版本漂移 |
| `apps/api/test/rewards-data.test.ts` | 8 | 迁移 `0006` 的触发器逐条拒绝、CHECK 逐个验证 |
| `apps/api/test/rewards-concurrency.test.ts` | 4 | 真实双进程并发：库存/预算/同一张券/规则改版后 |
| `apps/api/test/activities-reward-plan.test.ts` | 16 | 三态 `rewardPlan`、t13 窗口边界 8 条、历史行可读/可修复 3 条 |

### 9.3 关键代码锚点

| 主题 | 位置 |
| --- | --- |
| 生命周期唯一判定 | `apps/api/src/rewards/service.ts:986` `lifecycleBlockReason` |
| 可用性唯一判定 | `apps/api/src/rewards/service.ts:901` `redemptionAvailable` |
| 写路径复用同一判定 | `apps/api/src/rewards/service.ts:2018` `assertRedemptionAvailable` |
| 受领人绑定 | `apps/api/src/rewards/service.ts:2049` `assertGrantRecipient` |
| 无计划即关闭 | `apps/api/src/rewards/service.ts:240` `requirePlan` |
| 计划冻结 | `apps/api/src/activities/service.ts:255` `assertRewardPlanUnchanged` |
| 计划三态 | `apps/api/src/activities/service.ts:216` `withEffectiveRewardPlan` |
| 契约（计划字段约束） | `packages/contracts/src/rewards.ts:66` `activityRewardPlanSchema` |
| 契约（奖励状态不变量） | `packages/contracts/src/rewards.ts:335` `teamRewardStateSchema.superRefine` |
| 迁移 `0006` | `apps/api/db/migrations/0006_wakeful_wallow.sql`（573 行、6 表、32 触发器、25 CHECK、6 唯一索引、30 条 RAISE 文案） |

### 9.4 怎么自己复现本文的结论

本文所有"实测"数字都来自**真实 SQLite（跑真实迁移）+ 真实服务函数**，
不是 mock。最小复现方法：

```bash
cd apps/api
node --import tsx --test test/rewards.test.ts          # 32 条，含库存/预算耗尽与边界
node --import tsx --test test/rewards-http.test.ts     # 21 条，真实 Hono + 真实 HTTP
node --import tsx --test test/rewards-concurrency.test.ts  # 4 条，真实双进程
```

---

**结论重申**：这条链路能发一份真礼品，且发不出第二份，也发不出一份"活动还没开始就领走"的礼品。
运营需要记住的三件事是——**(1) 奖品数量/预算看奖励计划，不看活动表单；
(2) 发布后奖励计划一个字都不能改，所以发布前定死；
(3) 活动结束前把没核销的码催完，结束后系统不给补救。**

已知边界中 **§8.2（签到窗口越界）与 §8.3（驳回后授予卡死）均已修复并加了测试**；
§8.1 / §8.4 / §8.5 / §8.6 保留为已知边界，它们都不会产生错误的业务事实。

**新增两节（收卡前由 R1 第四轮要求披露，非阻塞）**：
- §8.7 **驳回后不可重开**——数据层不变量导致的产品限制，四条补救路径全不可用；
  运营遇到时走线下补发，不要在系统内反复尝试。
- §8.8 **部署顺序**——迁移 `0007` 须先于 t17 代码生效；正常单进程部署窗口期为零。
