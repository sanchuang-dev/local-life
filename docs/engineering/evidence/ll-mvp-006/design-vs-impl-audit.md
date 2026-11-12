# LL-MVP-006 三方一致性审计：设计文档 ↔ 运营手册 ↔ 实现

- 任务：`t16`；Issue [#62](https://github.com/sanchuang-dev/local-life/issues/62)
- 被审文档：`docs/engineering/rewards-fulfillment.md`（设计文档，270 行，写于 t1~t10 期间）
- 参照文档：`docs/engineering/evidence/ll-mvp-006/operator-guide.md`（运营手册，737 行，t12 交付）
- 事实基准：`apps/api/db/migrations/0006_wakeful_wallow.sql`、`apps/api/src/rewards/service.ts`（2929 行）、
  `apps/api/src/activities/service.ts`、`packages/contracts/src/{index,rewards}.ts`
- 审计时间：2026-11-05（Asia/Shanghai）
- 门禁：`pnpm check` **EXIT=0**；API **181/181 pass, 0 fail**

> **审计立场**
>
> 以**实现为准**。文档过时就改文档；实现与设计意图不符则**不改代码**，列入 §6「待维护者判断」。
> 每条结论标注证据强度：**【亲手跑】**（真实 SQLite/HTTP 复现）、**【读码】**（逐行核对源码/迁移）、
> **【核对】**（逐字比对两份文档）。

---

## 0. 结论速览

**设计文档全面落后于实现。** 270 行里有 11 处与当前代码不符，其中 3 处是**事实性错误**
（描述的状态迁移/行为与实现相反），不是措辞过时。

| 类别 | 处数 | 说明 |
| --- | --- | --- |
| **事实性错误**（文档说 A，实现是 B） | 3 | §5 `expired→revoked` 边不存在；§5「撤销后不可复活」为假；§2 库存唯一键仍是规则版本级 |
| **过时的边界声明**（把已交付说成未交付） | 2 | §1 声称 service/routes、并发测试"不在本卡"——均已交付 |
| **完全缺失的新增内容** | 4 | t9 `reward_plan_locked`、t11 `eligible` 同源、t13 写路径校验、t8 活动级唯一键 |
| **错误码表不完整/有死码** | 2 | 表列 8 个实际 9 个；`checkin_not_verified` 从不作为 HTTP code 发出 |
| **测试数字过时** | 1 | 未提任何具体数字，但 §7 描述"163/163"时代的测试构成 |
| **待维护者判断** | 1 | R1 第三轮在 **t13 我的修复里**发现的 500 缺陷（见 §6.1） |

**已按"以实现为准"更新 `rewards-fulfillment.md`**，改动清单见 §5。

---

## 1. 状态机核对（队长第 1 项要求）

逐个比对 `0006_wakeful_wallow.sql` 的 `*_status_transition` 触发器与文档 §5 的 ASCII 图。

### 1.1 授予（grant）

**【读码】** 触发器 `activity_reward_grants_status_transition` 允许的边：

```sql
OLD.status = NEW.status
OR (OLD.status = 'granted'  AND NEW.status IN ('redeemed','revoked','expired'))
OR (OLD.status = 'redeemed' AND NEW.status = 'disputed')
OR (OLD.status = 'disputed' AND NEW.status = 'reversed')
```

| 文档 §5 写的边 | 触发器允许？ | 判定 |
| --- | --- | --- |
| `granted → redeemed` | ✅ | 一致 |
| `granted → revoked` | ✅ | 一致 |
| `granted → expired` | ✅ | 一致 |
| `redeemed → disputed` | ✅ | 一致 |
| `disputed → reversed` | ✅ | 一致 |
| **`expired → revoked`** | ❌ **不允许** | **文档错误** |
| `disputed → redeemed`（未写） | ❌ 不允许 | 一致（且这是运营手册 §8.3 已知边界） |

> **文档错误 ①**：§5 图里画了 `└──expire──> expired ──revoke──> revoked`。
> **`expired → revoked` 这条边在触发器里不存在**，执行会被 `RAISE(ABORT, '... status transition is not allowed')` 拒绝。
> 同时代码也从不在 grant 上写 `expired`（见 §1.3），所以这条链整体是**双重不可达**。

### 1.2 凭据（code）

**【读码】** `activity_reward_codes_status_transition` 允许：

```sql
OLD.status = NEW.status
OR (OLD.status = 'active' AND NEW.status IN ('redeemed','superseded','expired','revoked'))
```

文档 §5 画了 `active → redeemed | superseded | expired | revoked` 四条边。**四边全部一致** ✅

### 1.3 `grant.expired` 是不可达状态（文档未标注）

**【读码】** 全仓 `status: 'expired'` 只出现在 `activity_reward_codes`（`service.ts:2365` 附近），
**没有任何代码把 grant 写成 `expired`**；`rewardEventKindSchema` 里的 `grant.expired` 同样从未被追加。

- 影响的文档段落：§3 `activity_reward_grants` 表格 `status` 一行、§5 状态机图。
- 处理：已在设计文档中标注为**不可达**，并与运营手册 §8.5 对齐。

### 1.4 签到（checkin）—— **文档事实性错误 ②**

**【读码】** 触发器 `activity_checkins_status_transition`：

```sql
WHEN NOT (OLD.status = NEW.status OR (OLD.status = 'valid' AND NEW.status = 'revoked'))
```

即只能 `valid → revoked`，**不能 `revoked → valid`**。

**【亲手跑】** 但文档 §5 在撤销箭头旁标注「**撤销后不可复活**」，这在**业务层面是假的**：

```text
RE-CHECKIN after revoke -> created = true
```

原因：唯一索引是**部分索引** `WHERE status = 'valid'`
（`activity_checkins_activity_user_valid_uq`），`revoked` 行不占位。所以作废后居民**可以重新签到**，
生成一条全新的 `valid` 行。

> **文档错误 ②**：「撤销后不可复活」把**行级状态机**（正确）误述成**业务能力**（错误）。
> 这是两份文档之间最危险的一处冲突——运营手册 §5.2 正确写着「作废后可以重新签到」，
> 若有人先读设计文档就会得出相反结论。已改为「该行不可复活，居民可重新签到」。

### 1.5 争议（dispute）

**【读码】** 触发器 `activity_reward_disputes_open_first` + CHECK
`decision IN ('opened','reversed','dismissed')`。文档 §5 画的 `opened → reversed | dismissed` 与实现一致 ✅

但文档**漏了一个实现里真实存在的行为**：`dismissed` 之后 `grant.status` **停在 `disputed` 不动**
（因为状态机无 `disputed → redeemed` 边）。这点运营手册 §8.3 已登记为已知边界，设计文档没有。已补。

---

## 2. 不变量核对（队长第 2 项要求）

| # | 不变量 | 文档原描述 | 当前实现 | 判定 |
| --- | --- | --- | --- | --- |
| 2.1 | 库存唯一键作用域 | `(activity_id, rule_version_id, prize_name)` | **`(activity_id, prize_name)`**（t8 改） | ❌ **文档错误 ③** |
| 2.2 | 授予唯一键作用域 | 「三者组成唯一键」= 含 `rule_version_id` | **`(activity_id, team_id) WHERE status <> 'revoked'`**（t8 改） | ❌ 同属错误 ③ |
| 2.3 | `reward_plan_locked` | **完全没有** | t9 新增，`API_ERROR_CODES.rewardPlanLocked` | ❌ 缺失 |
| 2.4 | `eligible ≡ (unavailableReason === null)` | 无此表述 | t11 收敛为单一 `redemption` 变量派生 | ❌ 缺失 |
| 2.5 | 签到窗口 ⊆ 活动起止 | **完全没有** | t13 新增写路径校验 | ❌ 缺失 |
| 2.6 | 快照唯一真相源 | §2 第 3 条 | 成立（`loadFrozenPlan`/`parsePlanFromSnapshot` 只读快照） | ✅ |
| 2.7 | 无计划 ⇒ `reward_unavailable` | §2.1 | 成立（`requirePlan` `service.ts:240`） | ✅ |
| 2.8 | 一次核销 | §2 第 2 条（设计文档） | 成立（条件 UPDATE + `changes()===1`） | ✅ |
| 2.9 | 追加式审计 | 隐含 | 成立（32 触发器，events/disputes UPDATE+DELETE 全禁） | ✅ |
| 2.10 | 台账三条恒等式 | 未展开 | 成立（`activity_prize_stocks_quantity_check` / `_budget_check`） | ✅（文档可加强） |

### 2.1 / 2.2 —— t8 的活动级唯一键（**文档错误 ③**）

**【读码】** `0006_wakeful_wallow.sql`：

```sql
:90   CREATE UNIQUE INDEX `activity_prize_stocks_activity_prize_uq`
        ON `activity_prize_stocks` (`activity_id`,`prize_name`);
:236  CREATE UNIQUE INDEX `activity_reward_grants_activity_team_uq`
        ON `activity_reward_grants` (`activity_id`,`team_id`)
        WHERE `activity_reward_grants`.`status` <> 'revoked';
```

文档 §2 第 1 条仍写着「唯一键是 `(activity_id, rule_version_id, prize_name)`」，
§3 grants 表格仍写「三者组成唯一键」。**两处都是 t8 之前的旧口径。**

t8 修复的正是「规则版本递增导致同一团队重复发奖与库存额度按版本分裂」：
只要唯一键含 `rule_version_id`，活动每改一版规则就能再发一份奖、再开一条库存行。

- **为什么必须改**：这条不只是措辞。按文档理解会得出「改规则会产生新库存行，属预期行为」，
  从而把 t8 修复的真实缺陷当成设计。
- 已改。

### 2.3 `reward_plan_locked`（t9 缺失）

**【读码】** `API_ERROR_CODES.rewardPlanLocked = 'reward_plan_locked'`，
`REWARD_PLAN_FROZEN_STATUSES = {published, paused}`，判定在 `assertRewardPlanUnchanged`
（`activities/service.ts:274`），用**原始请求体**在**任何写库动作之前**判定。

文档完全没有这个错误码，§8 错误码表只列了 8 个。已补第 9 个，并说明"为什么冻结"（改奖品名会开新库存行）。

### 2.4 `eligible` 与 `unavailableReason` 同源（t11 缺失）

**【读码】** `service.ts:1687-1705`：

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

关键点（代码注释原文）：`eligible` **从 reason 派生而非独立计算**，因为契约
`teamRewardStateSchema.superRefine` 硬性要求 `eligible === (unavailableReason === null)`，
「a projection that can contradict itself is a 500 waiting for the right stock level」。

- t11 之前：两者独立计算，库存耗尽时自相矛盾 → 500。
- 文档对此**只字未提**，且没有任何"可用性判定"小节。
- 已新增 §2.1「可用性判定：单一真相源」，含六条 reason 的固定优先级。

### 2.5 t13 写路径校验（缺失）

文档没有任何地方提到签到窗口与活动起止的关系。已新增一节，写明：

- 规则：`checkinWindow ⊆ [startsAt, endsAt]`，闭区间；
- 位置：`activityKeyRulesWriteSchema`（**写路径**），不是 `activityKeyRulesSchema`（读路径）；
- 理由：读 schema 同时是存量快照解析器，折叠进去会让存量行不可读**且不可修复**（详见 §6.2）。

---

## 3. 过时符号逐个核对（队长第 3 项要求）

**【亲手跑/读码】** 对文档中出现的每个标识符，在 `apps/`+`packages/` 全仓 grep 确认存在性：

| 文档中的符号 | 出现次数 | 状态 |
| --- | --- | --- |
| `lifecycleBlockReason` | 7 | ✅ 存在 |
| `checkinBlockReason` | 4 | ✅ 存在 |
| `buildTeamRewardState` | 3 | ✅ 存在 |
| `claimTeamReward` | 63 | ✅ 存在 |
| `redeemCredential` | 29 | ✅ 存在 |
| `currentKeyRules` | 3 | ✅ 存在 |
| `REWARD_ROUTES` | 37 | ✅ 存在 |
| `adminActivityRewardOverviewSchema` | 22 | ✅ 存在 |
| `checkinCountsForReward` | 0 | ✅ t19 已删除（原为零消费导出，见 §3.1） |
| `activity_checkins_window_guard` | 1 | ✅ 存在 |
| `activity_reward_grants_frozen_plan_guard` | 1 | ✅ 存在 |
| `activity_prize_stocks_redeemed_monotonic` | 1 | ✅ 存在 |
| `activity_prize_stocks_activity_version_prize_uq` | 仅出现在 DROP 注释 | ❌ 旧名，已废 |
| `activity_reward_grants_activity_version_team_uq` | 仅出现在 DROP 注释 | ❌ 旧名，已废 |

### 3.1 `checkinCountsForReward` 是零消费导出 —— **已在 t19 删除**

**【读码】** 该函数原定义在 `packages/contracts/src/rewards.ts:203`，但**全仓无任何调用方**。
服务层判定达标时用的是 SQL 条件 `sql\`${activityCheckins.verifiedAt} IS NOT NULL\``（`service.ts:868`）。

- 影响：文档 §3 写「契约里的 `checkinCountsForReward`」会让读者以为它是判定依据。
- 处理：设计文档已改为「契约本质上以 `verified_at IS NOT NULL` 判定」；函数本身
  由 R1 第四轮裁定**删除**（t19），因其是「契约里有、实现不用」的误导源，且无消费者。
- **对照**：同一轮里 `checkin_not_verified` 曾被误判为零消费导出，实测它有两个真实消费者
  （`rewardLabels.ts:70` 前端文案 + `service.ts:1301` 的 409 `reason`），**已保留**。
  两者结论相反的原因：前者是 `error.code` 常量表里的一行，后者是 `reason` 联合类型的一员。

### 3.2 已删除/改名的旧索引名

两个 `*_activity_version_*` 索引名只出现在迁移的 DROP 注释里（`0006:9-10`），是 t8 的删除记录。
文档若引用会被误导。已在设计文档中统一为现行名称。

---

## 4. 测试数字核对（队长第 4 项要求）

**【亲手跑】** `pnpm check` 当前输出：

| 门禁 | 结果 |
| --- | --- |
| `pnpm --filter @sanchuang-dev/local-life-api test` | **181/181 pass, 0 fail** |
| `pnpm check` | **EXIT=0**（oxlint 17 warnings / 0 errors） |
| admin vitest | 91 passed |
| contracts | 7 passed |

**设计文档里没有出现任何具体测试数字**——它写于 t1，当时测试尚未交付，§1 只声明"并发测试不在本卡"。
所以没有"数字过时"的直接错误，但**有构成过时**：§7 描述的仍是"163/163 通过"时代的测试构成。

**【核对】** 当前奖励相关测试文件与用例数：

| 文件 | 用例数 |
| --- | --- |
| `rewards.test.ts` | 32 |
| `rewards-http.test.ts` | 23 |
| `rewards-version-edit.test.ts` | 7 |
| `rewards-data.test.ts` | 6 |
| `rewards-concurrency.test.ts` | 4 |
| `activities-reward-plan.test.ts` | 16 |
| `activities-reward-plan-frozen.test.ts` | 11 |
| **小计** | **99** |

已在设计文档新增 §9「当前验证状态」，写入 181/181 与上表，避免下次再靠猜。

---

## 5. 对 `rewards-fulfillment.md` 的具体改动

| `rewards-fulfillment.md` 的段落 | 改动 | 依据 |
| --- | --- | --- |
| 文首说明（设计文档） | 更新为"本文已随 t7/t8/t9/t10/t11/t13 更新" | 一致性 |
| §1 边界（设计文档） | **重写**：service/routes、H5/管理台、并发与升级测试**均已交付**；删掉"不在本卡"清单 | 文件已达 2929/491 行，测试齐备 |
| §1 新增（设计文档） | 补 t7~t13 六轮修改的索引表 | 让读者知道文档为何与初稿不同 |
| §2 第 1 条（设计文档） | 库存唯一键改为 `(activity_id, prize_name)` | 【读码】`0006:90` |
| §2 第 2 条 | 补"条件 UPDATE + `changes()===1`"是真正的强制 | 【读码】`service.ts` redeem |
| §2.1 新增（设计文档） | 可用性判定单一真相源 + 六条 reason 优先级 + t11 的 500 根因 | 【读码】`service.ts:1687-1705` |
| §2.2 新增（设计文档） | 签到窗口 ⊆ 活动起止（t13），写/读 schema 分层的理由 | 【读码】+ t13 实测 |
| §2.3 新增（设计文档） | 发布后计划冻结与 `reward_plan_locked`（t9） | 【读码】 |
| §3 grants 表格（设计文档） | 唯一键改为 `(activity_id, team_id)` 部分索引；`expired` 标注**不可达** | 【读码】`0006:236` |
| §3 stocks 表格（设计文档） | 唯一键改为 `(activity_id, prize_name)`；补三条 CHECK 恒等式 | 【读码】`0006:90` + CHECK |
| §5 状态机（设计文档） | **删除** `expired→revoked` 边；`expired` 标不可达 | 【读码】触发器 |
| §5 状态机（设计文档，t17 追加） | `dismissed` 由「已知边界」改为「t17 已修复」：新增 `disputed→redeemed` 边（迁移 0007） | 【读码】+ 迁移实测 |
| §5 签到行 | 「撤销后不可复活」改为「该行不可复活，居民可重新签到」 | 【亲手跑】`created=true` |
| §8 错误码（设计文档） | 8 个 → 9 个（补 `reward_plan_locked`）；`checkin_not_verified` 标注"非 HTTP 码" | 【读码】全仓 emit 计数 |
| §9 新增（设计文档） | 当前验证状态：181/181、测试分布表、门禁 | 【亲手跑】 |
| §10 新增（设计文档） | 已知限制（原 §9 重编号），补 `grant.expired` 不可达、`dismissed` 缺边、活动表 caps 不生效 | 【读码】 |
| 行号修正 | `assertRewardPlanUnchanged` 锚点 255 → **274**（审计时发现引错） | 【读码】 |

> **文档终态**：270 行 → **475 行**。所有改动均以 `apps/api/db/migrations/0006_wakeful_wallow.sql`
> 与 `apps/api/src/rewards/service.ts` 为准，未改任何实现代码。
> 改完后 `pnpm check` 仍 **EXIT=0、181/181**（文档不影响代码，但已确认）。

---

## 6. 待维护者判断（**未改实现**）

### 6.1 【阻塞 · t13 引入 · 已在 t17 修复】继承分支的 ZodError 逃出错误映射，真实 HTTP 返回空 body 500

> **t17 修复结果（2026-11-05）**：`assertCheckinWindowInsideActivity` 不再抛 `ZodError`，
> 改为无副作用的 `findCheckinWindowIssues()` 返回 issues；调用方
> `withEffectiveRewardPlan` 据此抛 `ActivityError(400, invalidRequest, ...)`，
> 经 `failWithActivityError` 正常映射。
> 实测：`PATCH` 省略 `rewardPlan` + 缩小活动窗口 → **HTTP 400 `invalid_request`**（修复前为空 body 500）。
> 补了 2 条 HTTP 层测试（越界 400 / 界内 200 且继承保留），并做了「还原成抛 ZodError」的变异验证
> —— 新测试转红，证明它守得住。以下为原始发现记录，保留以便追溯。

> 这一条是 R1 第三轮（`r1-review-round3.md` 第 4.5 节）在**我 t13 的修复里**发现的。
> 我**独立复现并确认**了它，不因为是自己写的就淡化。

**我的独立复现【亲手跑】**：

```text
instanceof Error      = false        ← zod 4 的 ZodError 不满足 instanceof Error
ctor name             = ZodError
instanceof ZodError   = true

C. PATH2 THREW OUT OF app.request | ctor = ZodError | instanceof Error = false
```

触发路径（`PATCH` 的 `keyRules` 里**省略** `rewardPlan` 键）：

1. 活动 `endsAt = 11-14`，计划 `closesAt = 11-13`（创建时合法）
2. PATCH 只把 `endsAt` 改到 `11-06`，**不带 `rewardPlan` 键**
3. `withEffectiveRewardPlan` 走"继承"分支，合并后窗口越界
4. 我的 `assertCheckinWindowInsideActivity(merged)` **无 ctx 时 `throw new z.ZodError(...)`**
5. `failWithActivityError` 只映射 `ActivityError`，其余 `throw` 上抛
6. Hono `#handleError` 判 `err instanceof Error` 为 **false** → **拒绝调用 `onError`** → 空 body 500

**三条入口的差异（这是本项最要紧的部分）**：

| 入口 | 结果 |
| --- | --- |
| PATH1 管理台表单形状（始终带 `rewardPlan`） | **400** ✅ |
| PATH2 `keyRules` 省略 `rewardPlan` 键 | **空 body 500** ❌ |
| PATH3 service 层直调 | 抛 `ZodError`（非 `ActivityError`） |

**可达性诚实说明**：管理台 UI **当前点不出来**（`rewardPlanFromForm` 在计划已存在时总回填该键，
我实测 PATH1 = 400）。但契约把"键缺失 → 继承"写成**受支持的公开语义**
（`activityKeyRulesWriteSchema` 上是 `.optional()`，doc comment 明确写了三态），
任何按契约调用的客户端（脚本、curl、未来的第三方）都会踩到。

**为什么现有 181 条测试没抓到**：我的 t13 测试只测了"越界的新输入"（走 PATH1/PATH3），
没测"**合法输入 + 继承存量计划**导致合并后越界"这个组合。

**我建议的修复方向（未实施，留给维护者决定）**：不要 `throw new ZodError`，
而是在服务层抛 `ActivityError(400, invalidRequest, ...)`——它会被 `failWithActivityError` 正确映射成 400。
即把 `assertCheckinWindowInsideActivity` 的"无 ctx"分支改成抛领域错误，或让调用方捕获 ZodError 后转换。

**为什么我不在本卡擅自改**：t16 的任务契约明确写"**不要改实现**"，且这一条已由 R1 作为阻塞项登记。
需要维护者/队长决定是由我开 t17 修，还是并入其他修复。

### 6.2 读/写 schema 分层的架构选择（已在 PR 说明中，此处存档）

t13 把窗口校验放在**写路径**而非 `activityKeyRulesSchema`。理由是实测：折叠进读 schema 会让
修复前已发布的活动**四条读路径抛错，且 `updateActivity` 也抛错导致无法修复**。
队长已裁决认可并要求写入 PR 说明。此处仅存档，无需再决策。

### 6.3 `expired` / `grant.expired` 两个不可达枚举值

契约允许但永不写入。删除会破坏向后兼容，建议单独立项。运营手册 §8.5 已登记。

### 6.4 `checkinCountsForReward` 零消费导出 —— **已在 t19 删除**

无害，但是"契约里有、实现不用"的第二处（第一处是 `grant.expired`）。建议要么接线、要么删除，
或至少在注释里说明它是语义文档。**R1 第四轮裁定删除，t19 执行**：`src` 定义与 `dist` 声明
一并清除，`pnpm check` EXIT=0、测试数 189 不变（零消费者，删除不减少覆盖）。

> ⚠️ 同一批「零消费」排查中，`checkin_not_verified` 被**误判**为同类。实测它有真实消费者
> （前端文案 + 409 `reason`），已保留。**教训：`grep` 结论必须说明搜索范围**——
> 只搜 `error.code` 的用法会漏掉 `reason` 用法。

### 6.5 活动表 `prizeQuantityCap` / `budgetCapCents` 不参与发奖

运营手册 §8.1 已登记，R1 第三轮裁定为「可保留的合理边界」（公开面四类响应体逐一枚举均不暴露这两个字段，
`apps/web` 全仓 0 命中）。**本审计确认设计文档也没有声称它们生效**——设计文档 §2 第 3 条只说
"不读 activities 表的可变列"，与实际一致。故文档无错，仅在此备案。

---

## 7. 复核方法（可复跑）

本文所有【亲手跑】结论的复现方式：

```bash
cd apps/api

# 1) 状态机边：直接读触发器
grep -A8 'activity_reward_grants_status_transition' db/migrations/0006_wakeful_wallow.sql

# 2) 唯一键作用域
grep -n 'activity_prize_stocks_activity_prize_uq\|activity_reward_grants_activity_team_uq' \
  db/migrations/0006_wakeful_wallow.sql

# 3) zod 4 的 ZodError 不是 Error（500 根因）
node --import tsx -e "const {z}=require('zod');const e=new z.ZodError([]);console.log(e instanceof Error)"

# 4) 撤销后可重新签到
node --import tsx --test test/rewards.test.ts   # 含 check-in 幂等与作废用例

# 5) 全量门禁
pnpm --filter @sanchuang-dev/local-life-api test   # 181/181
```

---

## 8. 一句话总结

设计文档不是"稍微过时"，是**停在了 t1**：它把已交付的 service/routes/并发测试列为"不在本卡"，
把 t8 修掉的版本级唯一键当作现行设计，把不可达的 `expired→revoked` 画进状态机，
还把"撤销后不可复活"写成了与实现相反的业务规则。
**已全部按实现改正**，并补上 t9/t11/t13 三处完全缺失的不变量说明。
唯一的实现侧问题（t13 的 500）由我引入、R1 发现、我独立复现确认，**按任务契约不改代码**，交维护者裁决。
