# LL-MVP-006 真实签到 / 团队奖励 / 库存预算 / 一次性核销 · R1 独立复核（第 2 轮）

- 任务：`t5` 独立复核（R1，attempt 2）；Issue [#62](https://github.com/sanchuang-dev/local-life/issues/62)
- 分支：`feat/ll-mvp-006-checkin-rewards`，HEAD `7095b84`（基线 `dev@7095b845c3a47a6d08d2ad663b10bcffe51e1194`）
- 复核人：`r1-review`（未参与实现；本轮只读代码，只写本文件；未修改 `apps/**`、`packages/**`、测试、迁移或 `pnpm-lock.yaml`）
- 复核时间：2026-11-04（Asia/Shanghai）；Node `v22.23.2`、pnpm `10.19.0`
- 结论：**pass** —— 第 1 轮提出的 F1/F2/F3 三个缺陷均已用真实 HTTP + 真实 SQLite 独立复现为"已修复"，
  三处被改动的既有断言经逐条判断均为**必要更新**而非"为绿放宽"，四条低风险项已闭环。
  另有 3 条**非阻塞**低风险观察（§8），不构成本卡合并障碍。

> **证据强度分级（本轮起显式标注，便于维护者判断可信度）**
>
> | 标记 | 含义 |
> | --- | --- |
> | **【亲手跑】** | 本轮在本机终端实际执行的命令与真实输出（门禁、真实 HTTP、真实 SQLite、直接 SQL），输出已摘录在正文 |
> | **【读码】** | 只做源码/迁移/测试的静态阅读与 `grep` 交叉验证，**未执行** |
> | **【第 1 轮实测】** | 第 1 轮已亲手跑过、本轮未重复执行的部分（本轮做了回归抽查，见 §9.1） |
>
> 本卡的判定不依赖施工者的口头声明：第 1 轮我给出的 3 个缺陷，本轮**全部重新构造场景复现一遍**，
> 并且都验证到"库存/预算/授予/凭据行数"这一层，而不是只看状态码。

---

## 1. 门禁重跑【亲手跑】

在只写了本文件的工作区重新执行，未复用任何缓存结果：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @sanchuang-dev/local-life-api test` | **163/163 pass, 0 fail, exit 0**（`duration_ms` 9652.5） |
| `pnpm typecheck` | **exit 0**；`packages/contracts` / `apps/api` / `apps/admin` / `apps/web` 全部 `Done` |

```text
1..163
# tests 163
# suites 0
# pass 163
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9652.512
TEST_EXIT=0

packages/contracts typecheck: Done
apps/admin typecheck: Done
apps/web typecheck: Done
apps/api typecheck: Done
TC_EXIT=0
```

规模（`wc -l`，全部真实 SQLite + 真实迁移，无 Mock、无 stub）：`rewards.test.ts` 1653、
`rewards-http.test.ts` 1592、`rewards-concurrency.test.ts` 811、`rewards-data.test.ts` 704、
`rewards-version-edit.test.ts` 627、`activities-reward-plan.test.ts` 458、
`activities-reward-plan-frozen.test.ts` 527；实现 `apps/api/src/rewards/service.ts` 2868 行；
迁移 `apps/api/db/migrations/0006_wakeful_wallow.sql` 573 行（6 张表 / 32 个触发器 / `DELETE FROM` 0 处）。

测试数由第 1 轮的 157 增至 163：新增 F1/F2/F3 的 HTTP 级回归用例
（`rewards-http.test.ts:1357 / 1407 / 1450 / 1493 / 1526 / 1570`）。

**门禁绿本身不是结论**——第 1 轮的 3 个缺陷全部在 157/157 全绿时存在。下面的判断只引用第 3–7 节自己跑出来的输出。

---

## 2. 复核方法

1. 用 `/tmp/harness.mts` 在**仓库外**搭建真实 Hono app + 真实 SQLite（真实执行 `0001`–`0006` 迁移），
   通过真实 HTTP 请求（含 CSRF double-submit、Origin 校验、会话 Cookie）驱动，无 stub、不伪造时钟。
2. 判定"是否真的没有付钱"时一律**直接查 SQL**（`activity_prize_stocks` / `activity_reward_grants` /
   `activity_reward_codes` / `activity_reward_events` / `audit_logs`）：
   状态码只能说明"这次调用被拒"，只有库存行/授予行/凭据行的实际行数才能说明"没有占用预算"。
3. 时间场景用真实 `sleep` 越过 `endsAt`，**不伪造 `now`**，以覆盖"`status` 仍是 `published` 但窗口已过"的边界。
4. 对每条"被改动的既有断言"，先看旧断言在旧实现下是否**真的描述了一个正确行为**，
   再看新断言是否**仍能失败**（换回旧实现是否会变红），避免把"删掉断言"当成"修复"。

本轮新增/重跑探针：`/tmp/p2-f1.mts`、`/tmp/p2-any.mts`、`/tmp/p2-f2.mts`、`/tmp/p2-f3.mts`、
`/tmp/p2-window.mts`、`/tmp/p2-resume.mts`、`/tmp/p2-ttl.mts`、`/tmp/p2-ttl2.mts`、`/tmp/p2-exp2.mts`、
`/tmp/p2-strand.mts`、`/tmp/p2-immut.mts`、`/tmp/p2-audit2.mts`、`/tmp/p2-iso.mts`、`/tmp/p2-draft2.mts`、
`/tmp/p2-null.mts`、`/tmp/p2-edge.mts`；回归重跑第 1 轮的 `/tmp/probe-auth.mts`。

---

## 3. F1 复核：受领人绑定后不可被他人轮换 —— 已修复【亲手跑】

**第 1 轮缺陷**：`claimTeamReward` 找到既有授予后直接调用 `issueForExistingGrant`，不校验调用者是否为受领人；
任一队员再领一次就会**换发新码并把受领人的旧码置 `superseded`**，等于"谁最后调用谁拿到奖品"。

**修复**：新增 `assertGrantRecipient()`（`service.ts:1988`），在既有受领分支的最前面调用
（`service.ts:1824`，位于 `issueForExistingGrant` 之前）。受领人为 `null` 时放行、等于本人放行、
其余返回 403 `forbidden` + reason `not_recipient`。

### 3.1 `claimRecipient = 'leader'`

```text
leader claim                   200  created=true   recipient=self
leader re-claim（受领人本人）   200  created=false  新码不同（幂等换发，未被误判 403）
member2 claim                  403  forbidden / not_recipient
member3 claim                  403  forbidden / not_recipient
grants=1   codesActive=1   claimedQuantity=1   committedBudgetCents=5000
```

三点结论：
- **不是"一律 403"**：受领人自己再领仍是 200 `created=false` 并换发新码（旧码置 `superseded`）——
  这正是第 1 轮担心会被修过头的地方，实测**幂等语义保住了**；
- 非受领人拿到的是 403 且 reason 明确（`not_recipient`），不是笼统的 `forbidden`；
- 授予行恒为 1，库存只占 1 份，没有因多次拒绝/换发而重复扣减。

对应单测仍守同一语义：`rewards.test.ts:603`（只有队长可领，member2 → 403 `not_recipient`，授予 1 行、
库存按 `prizeQuantityPerTeam` 计）、`rewards.test.ts:699`（受领人再领 → `created=false`，
码分布恰好 `active 1 / superseded 1`，旧码核销被拒）。

### 3.2 `claimRecipient = 'any_member'`（本轮重点攻击的边界）

F1 如果修成"只允许 `recipientRole='leader'` 的人领"，`any_member` 会被一起打死。实测：

```text
member2 先领                  200  created=true   recipientRole=member  recipient=member2   ← 模式语义保住
leader 再领                   403  forbidden / not_recipient
member3 再领                  403  forbidden / not_recipient
member2（受领人）再领          200  created=false  新码
  新码 → POST /rewards/redeem 200
  旧码 → POST /rewards/redeem 404  redemption_code_invalid（已 superseded）
```

即 `any_member` 的正确语义（**第一个领取者成为受领人**）与"受领人此后唯一且不可轮换"同时成立。
`recipientUserId` 在授予时固定写入 `input.userId`（`service.ts:1914`），此后只被比较、不被改写。

---

## 4. F2 复核：已核销后不再签发无法兑付的死码 —— 已修复【亲手跑】

**第 1 轮缺陷**：`grant.status='redeemed'` 时 `issueForExistingGrant` 仍签发新的 `active` 码，
而 `redeemCredential` 只会对它回 409；同时后台总览把这枚码算作"在途有效码"（`codesActive` +1），
于是"已核销且仍有 1 枚有效码"同时成立。

**修复两处**：`issueForExistingGrant` 对 `redeemed` 直接抛 409 `reward_already_redeemed`（`service.ts:2010`）；
`codesActive` 改为只统计 `code.status='active'` **且** `grant.status='granted'`（`service.ts:2820`）。

```text
claim                      200
redeem                     200
受领人 re-claim             409  reward_already_redeemed / reward_already_redeemed
其他队员 re-claim           403  forbidden
counts                     codesActive=0   codesRedeemed=1        ← 永不"既在途又已核销"
grant credential meta      status=redeemed   maskedCode=******RMR1
居民 GET /rewards/credential 200  status=redeemed
团队奖励态                  eligible=false  claimableByMe=false  grantStatus=redeemed
```

`redeem` 之后再 `claim` 一律失败，且**没有任何新码落库**（该授予在 `activity_reward_codes` 的行数始终为 1）。
单测同样变强：`rewards-version-edit.test.ts:366` 除状态码外，还断言 1 枚授予、`claimed_quantity=1`、
**该授予的码行数与之前完全相同**（拒绝时不得再签发）——这条断言在旧实现下必然变红。

---

## 5. F3 复核：签到 / 领取 / 核销共用同一生命周期判定 —— 已修复【亲手跑】

**第 1 轮缺陷**：`claimTeamReward` 只拦 `draft`、`redeemCredential` 完全无门禁，
于是"签到面已关、领奖/核销还开着"：达标后暂停仍能 `claim 200` 扣库存，领取后暂停仍能 `redeem 200`。

**修复**：抽出 `lifecycleBlockReason(activity, now)`（`service.ts:969`）作为唯一真相源，
四处在同一顺序上调用：`checkinBlockReason:993`、`buildTeamRewardState:1666`、
`claimTeamReward:1780`、`redeemCredential:2291`。
判定顺序：`draft → activity_not_published`；`ended → activity_ended`；非 `published → activity_not_published`；
`now >= endsAt → activity_ended`；否则放行。

### 5.1 单一真相源【读码 + grep 交叉验证，并由 5.2 的行为实测佐证】

`service.ts` 中只有 `:973 / :974 / :978 / :979` 四处出现 `status`/`endsAt` 生命周期比较，
且全部位于 `lifecycleBlockReason` 函数体内；`grep -n "lifecycleBlockReason("` 命中恰好
`:969`（定义）+ `:993 / :1666 / :1780 / :2291`（四个调用点）。
不存在第二份 `if (status === 'draft')` 之类的分叉判定。

### 5.2 四个时间场景（真实 HTTP + 直接查库）

| 场景 | 居民态 | 写请求 | 库存 / 预算 / 授予 / 凭据 |
| --- | --- | --- | --- |
| (A) 达标 → 暂停 | `eligible=false, claimableByMe=false, reason=activity_not_published` | claim **409 `reward_unavailable`** | `stock rows []`，grants 0，codes 0 → **一分钱没占** |
| (B) 领取 → 暂停 → 核销 | 凭据仍 `active` | redeem **409 `reward_unavailable`** | 暂停前后 `claimed 1 / committed 5000` 完全不变，codes 1→1 |
| (C) 达标 → 结束 | `reason=activity_ended` | claim **409** | `stock rows []`，grants 0 |
| (D) `published` 但 `endsAt` 已过（`status` 字段仍 `published`） | `reason=activity_ended` | claim **409** | `stock rows []`，grants 0 |

(D) 是本轮特别点名、也最容易漏的边界：把活动 `endsAt` 设在 3 秒后，**真实 sleep 4 秒**越过后再请求。
此时 `activities.status` 仍是 `published`（没有后台任务把它扫成 `ended`），仅凭 `now >= endsAt` 就必须关门。
实测领奖 409、库存 0 行；同一时刻签到面 `GET /activities/:id/checkin` 也报 `unavailableReason: activity_ended`
——两张面同一个结论，没有"签到已关但奖励还开着"的裂缝，与 #59 参与面
`participation/service.ts` 的 `lifecycleBlock`（`published` + 过 `endsAt` → `activity_ended`）语义一致。

### 5.3 暂停不是死路：`resume` 后一切恢复

暂停被设计成"临时关闭"，必须验证可恢复，否则 F3 的修复等于把奖励永久锁死：

```text
pause → claim             409
resume                    200
claim after resume        200  created=true  quantity=1
counts                    grantsGranted=1  codesActive=1
stock                     claimed=1  committed=5000
redeem after resume       200
ended 之后再 resume       409（终态不可逆）
```

说明门禁是"按当前状态实时判定"，不是"一旦暂停就把授予作废"。

### 5.4 窗口规则没有被生命周期门禁吞掉（"活动进行中但窗口已关"）

```text
活动仍在进行，签到窗口已关（window closes 早于 endsAt）：
  POST /checkin  409 reward_unavailable  "签到已结束"
  GET  /checkin  available=false  unavailableReason=checkin_window_closed
  GET  /rewards  unavailableReason=team_incomplete（该居民未入团，另有更靠前的原因）
```

`checkin_window_closed` 仍可达，且与"活动已结束"是两个不同 reason。
这正是 `rewards.test.ts:308` 那个 fixture 改动的原因（见 §6.3）。

### 5.5 生命周期与凭据 TTL 的判定顺序

`redeemCredential` 的分支顺序：未知码 404 → `redeemed` 409 → `expired` 稳定 400 →
`superseded`/`revoked` 404 → **生命周期 409** → TTL 兜底过期 → 条件 UPDATE。

```text
码已过 TTL（活动仍在进行）   #1 400 redemption_code_expired / #2 400 redemption_code_expired（稳定，不漂移）
活动已结束 + active 码       #1 409 reward_unavailable "活动已结束，无法核销奖励" / #2 同一结果
```

重复调用结果完全一致，没有"第一次 409、第二次变 404"的抖动。
顺带证明 `expires_at` 不可被直接改写（`activity_reward_codes_identity_immutable` 触发器 ABORT），
即"过期"只能由服务端按 `now` 判定，不能靠改库绕过。

---

## 6. 三处被改动的既有断言：逐条独立裁决【读码 + 亲手跑佐证】

判断标准：旧断言在旧实现下是否**真的描述了一个正确行为**？
若不是 → 改动属必要更新；若旧断言本身正确、却被削弱成更弱的断言 → 记为"为绿放宽"缺陷。

### 6.1 `rewards.test.ts:654` any_member "首个领取者成为受领人" 200 → 403：**必要更新**

- 旧断言要求"任一队员再领仍 200"，而旧实现里那个 200 会**换发新码并把先领者的码置 `superseded`**
  —— 这正是 F1 缺陷本身。断言 200 等于把缺陷写成规格，必须改。
- 新断言仍强：member3 → 403 `not_recipient`、`recipient_user_id` 保持不变、授予数恒为 1；
  并且 `any_member` 的真实语义（第一个领取者成为受领人）由 §3.2 的真实 HTTP 场景独立证明没有丢。
- 反向检查：摘掉 `assertGrantRecipient` 后新断言立即变红（会收到 200），说明它仍可失败，不是空断言。

### 6.2 `rewards-version-edit.test.ts:366` "已核销的授予仍然阻止第二份奖品" 200 → 409：**必要更新且变强**

- 旧断言只要求"不能再发第二份奖品"，但旧实现给的是 200 + 一枚永远无法兑付的 `active` 码，
  属于"看起来成功、实际是死码"。200 不是可接受行为，改 409 是纠正而非放宽。
- 新断言同时钉住：409、`API_ERROR_CODES.rewardAlreadyRedeemed`、reason `reward_already_redeemed`、
  授予数 1、`claimed_quantity` 1、**该授予的码行数不变**（拒绝时不得偷偷签发）。比旧断言更严。

### 6.3 `rewards.test.ts:130` fixture `WINDOW_CLOSED → "签到窗先关、活动后结束"`：**必要更新，且不是删覆盖**

- 旧 fixture 的 `checkinWindow.closesAt` 恰好等于活动 `endsAt`。在新生命周期门禁下，
  "窗口关闭的那一瞬"活动本身也已结束，`checkin_window_closed` 会被 `activity_ended` 永久挡在前面，
  成为**不可达分支**——留着只会得到一个恒不触发的断言。
- 新 fixture：窗口 `2026-11-20` 关闭、活动 `2026-11-30` 结束、`now=2026-11-25`，
  把"窗口规则"与"生命周期规则"拆开，让 `checkin_window_closed` 重新可达（§5.4 用真实 HTTP 独立确认可达）。
- 覆盖未减少：同一用例仍保留 `checkin_window_not_open`（`now=2026-10-01`）与 `not_a_team_member` 断言，
  并新增说明性注释讲清为什么必须这样摆时间。

**没有任何一条改动属于"为了让测试变绿而削弱断言"。** 两处是旧断言"把缺陷写成规格"，
一处是旧断言"已不可达"；其中两处新断言比旧断言更严。

### 6.4 顺带核查 `crmeb-orders.test.ts` 的 `entries.filter((entry) => entry.idx <= 4)`【读码】

不属于奖励范围，但它是本卡新增迁移的连带改动，我逐行看了 diff：原写法 `!tag.startsWith('0005_')`
在新增 `0006` 之后会把 `0006` 一起漏给"pre-0005 的旧库"，导致 drizzle 记录更新的 `when` 从而跳过 `0005`。
改成按 `idx <= 4` 分阶段是**正确修法**，不是放宽，注释也写清了原因。

---

## 7. 四条低风险项：全部闭环【亲手跑 + 读码】

| 项 | 第 1 轮状态 | 本轮核实 |
| --- | --- | --- |
| `service.ts:855` 死过滤（`memberUserIds.includes` 无效条件） | 遗留 | **已删除**，原处换成解释性注释；`grep -n "memberUserIds.includes"` 只命中注释，无代码残留 |
| `checkinBlockedError` 把 `activity_ended` 映射成 `activity_not_published` | 遗留（客户端只能字符串匹配） | **已改为独立 code** `activity_ended`（`service.ts:1206`）；实测过期活动 `POST /checkin` 返回"活动已结束，无法签到" |
| `rewards-fulfillment.md` 写"88/88" | 过期 | **已更新为 163/163**（`:222`），并新增生命周期段落（`:197`）说明 `lifecycleBlockReason()` 是唯一真相源及判定顺序 |
| `apps/api/apply-probe.mjs`（施工期临时脚本） | 遗留 | **已删除**：`ls` 报 `No such file or directory`，`git status` 中不再出现 |

文档侧另确认它没有把"未做"写成"已做"：`rewards-fulfillment.md:190` 明确写"不改发布/暂停/结束的状态机本身；
但奖励面必须与签到面同一生命周期判定"——与实现一致（状态机仍只有 `publish/pause/resume/end` 四个动作，
奖励面只读它）。`git status --porcelain` 显示除本文件外工作区与门禁运行时一致
（19 modified + 24 untracked，无多余改动）。

---

## 8. 非阻塞低风险观察（3 条，均 low，不构成本卡合并障碍）

以下三条是"为了把 F1/F2/F3 打穿"过程中顺带发现的。它们**不是缺陷回归**，
不会造成多发奖、错发奖或账实不符，故不改变 pass 结论；建议后续卡加固。

### O1（low）`recipient_user_id` 未纳入"身份不可变"触发器【亲手跑】

`0006` 的 `activity_reward_grants_identity_immutable`（`:335`）冻结了
`activity_id / rule_version_id / team_id / prize_name / quantity / unit_cost_cents / total_cost_cents /
recipient_role / granted_at / created_at`，**唯独没有 `recipient_user_id`**。直接 SQL 实测：

```text
update activity_reward_grants set quantity = 9              → blocked（触发器 ABORT）
update activity_reward_grants set recipient_user_id = NULL  → ALLOWED
update activity_reward_grants set recipient_user_id = 另一队员 → ALLOWED
```

把受领人改成 `NULL` 后，`assertGrantRecipient`（`:1989`）对 `null` 直接放行，
于是任一队员都能再领并换发新码——F1 的边界在"库被改过"的前提下会重新打开；
同时契约层 `leader grant must name its recipient` 会让后续 claim 变成 500 `internal_error`（实测）。

**可达性：任何 HTTP 路径都无法产生 `recipient_user_id = NULL`。**
授予插入固定写 `input.userId`（`:1914`），此后没有任何 `UPDATE ... set recipientUserId`。
因此这是"最后一道防线"的缺口，不是可利用漏洞。
建议把 `recipient_user_id` 加进 identity-immutable 触发器列清单（或在 CHECK 里禁止置空），
把"受领人稳定"从应用层约束升级为数据库约束。

### O2（low）`draft` 活动的**写**路径仍报"未配置奖励计划"，与**读**路径的 `activity_not_published` 不一致【亲手跑】

`checkinBlockReason`（`:991`）的注释明确写"生命周期优先：草稿根本没有冻结规则版本，
报'未配置计划'会误述正常的未发布状态"，读路径也确实如此（实测 `GET /checkin` → `activity_not_published`）。
但 `recordCheckin` 在 `:1048` 先调用 `requirePlan()` 再走到 `checkinBlockReason`，于是写路径实测：

```text
草稿（有 rewardPlan）POST /checkin → 409 reward_unavailable，"该活动未配置奖励计划，正式奖励入口不可用"
                                    而 GET /checkin 的 unavailableReason = activity_not_published
```

状态码一致（客户端无法区分），但**文案与读路径自相矛盾**，且与调用点注释表达的意图相反。
影响有限：草稿活动的签到按钮本就 `available=false` 被禁用，用户很难触发。
建议把 `recordCheckin` 的 `requirePlan` 挪到生命周期判定之后，与 `checkinBlockReason` 的注释对齐。

### O3（low）活动 `ended` 后，未核销的授予仍显示为"在途有效码"【亲手跑】

`ended` 是终态（`end` 只能从 `published/paused` 进入，`ended → resume` 实测 409），
但已领取未核销的授予仍保持 `granted`、凭据仍是 `active`：

```text
claim（进行中）→ end → 总览 counts: grantsGranted=1  codesActive=1  codesRedeemed=0
POST /rewards/redeem      409 reward_unavailable "活动已结束，无法核销奖励"
居民 GET 凭据             200 status=active expiresAt=…；居民卡片 bucket=claimable"待现场核销"
人工处置 POST .../revoke  200，库存与预算释放回 claimed=0 committed=0
```

`codesActive` 的口径（`code.status='active' && grant.status='granted'`）在 F2 修复后是诚实的，
但活动结束后它会把一枚**永远无法兑付**的码统计成"在途"，居民侧也仍显示"待现场核销"。
不涉及多发奖（库存仍被正确占用，只能靠人工撤销释放），属语义/展示瑕疵。
建议三选一：`codesActive` 不再计入终态活动的码；或让居民凭据投影感知生命周期
（例如展示"活动已结束，请联系工作人员"）；或在文档里明确"活动结束后需人工撤销未核销授予"的运营动作。

---

## 9. 其余范围的回归复核

### 9.1 鉴权与越权【第 1 轮实测；本轮重跑 `/tmp/probe-auth.mts` 回归通过】

```text
未登录 GET /activities/:id/rewards                401
B 社区 operator 读 A 社区 overview/checkins/verify 403（越权审计 4 行 reward.access_denied 落在 audit_logs）
居民请求伪造 userId 字段                            400（严格 body schema，身份只取会话）
伪造/不存在核销码                                   404 redemption_code_invalid
首次核销 200 / 重复核销 409 reward_already_redeemed
缺 CSRF token 的写请求                              403
不可信 Origin 的写请求                              403
```

本轮补充的隔离验证【亲手跑】：

```text
同队另一名队员 GET /rewards/credential → 200，但只有状态与掩码，响应中不含任何明文码
非队员居民 GET /rewards/credential     → 404 not_found
居民直接 GET /admin/activities/:id/rewards → 401
```

`getMyCredential`（`:2142`）只用会话 `userId` + 本人团队定位授予，不接受任何外部传入身份；
明文码只在签发那一刻返回一次，之后既不可从 `code_hash` 还原，也不出现在任何读接口/审计/事件里（见 9.3）。

### 9.2 并发与一致性【第 1 轮实测；本轮读码确认实现未变】

四条真实双连接竞态用例仍在：库存最后一份（`rewards-concurrency.test.ts:272`）、预算最后一格（`:388`）、
同一码并发核销（`:495`）、规则编辑后同队并发领取（`:586`）。
机制仍是 `BEGIN IMMEDIATE` + `UPDATE ... WHERE 计数 + delta <= cap` + `changes() === 1`
（核销侧是 `WHERE status='active'`），并以 `(activity_id, rule_version_id, team_id)` 部分唯一索引兜底，
不依赖应用层"先查再写"；落败一方读回既有授予后 `created=false`，因此并发不会产生第二份授予。

迁移 `0006` 追加在 `_journal.json` 的 `idx: 6`，`0000`–`0005` 未改动；
`rewards-data.test.ts:587` 用真实 pre-0006 库验证"原地升级、不回填、旧数据保留"。
本轮 `grep -c` 实测：`CREATE TRIGGER` 32、`CREATE TABLE` 6、`DELETE FROM` 0，与文档 §4 的 13 条不变量对得上。

### 9.3 审计与撤销【亲手跑】

```text
activity_reward_events  rows=8   plaintextHits=0
activity_reward_codes   rows=2   plaintextHits=0   （列：code_hash / code_suffix，无明文列）
audit_logs              rows=15  plaintextHits=0
activity_reward_grants  rows=1   plaintextHits=0
事件种类：checkin.verified×3, credential.issued×2, credential.superseded×1, grant.created×1, grant.redeemed×1

UPDATE activity_reward_events                              → blocked
DELETE events / codes / grants / checkins / stocks         → 全部 blocked
撤销后行数不变（events 8 / codes 2 / grants 1 / checkins 3）
```

`plaintextHits` 的样本是同一轮真实签发过的两枚明文码（一枚被 superseded、一枚被核销），
在四张表里逐字搜索命中 0 —— 审计与事件只写哈希与后 4 位。

撤销/争议的追加式语义也复核过：已核销授予走 `dispute → reverse`
（直接 `revoke` 实测 409 `reward_already_redeemed`，不存在"核销后又撤销"的非法态）；
未核销授予 `revoke` 200 并把 `claimed/committed` 释放回 0；活动结束后仍可
`open dispute`（200）、`revoke grant`（200）、`revoke checkin`（200），
即运营的事后纠正不被生命周期门禁误伤——门禁只关"发钱"，不关"改账"。

### 9.4 业务规则【读码 + 第 1 轮实测】

- **数量与受领人只从冻结快照读**：`loadFrozenPlan` 只读 `activity_rule_versions.snapshot_json`，
  经 `activities.current_rule_version_id`；`requirePlan` 无计划直接 409 `reward_unavailable`，不回落可变列。
- **默认不是"一人一份"**：`quantity = prizeQuantityPerTeam`，且有 `(activity, rule_version, team)` 唯一约束；
  §3 实测一个 3 人团队恰好 1 份。
- **没签到就没有奖励**：`loadTeamContext.checkinsValid` 只计 `status='valid' AND verifiedAt IS NOT NULL`，
  自签到未核验不计入（`rewards.test.ts:552` 与 HTTP 用例共同覆盖）。
- **前端没有把演示抽奖接成真实发奖**【读码】：
  `SilverNeighborhoodCampaignPage.tsx:571 / :1020 / :1074` 明确写"今日抽奖、压轴大奖、里程碑与热力榜
  仍为前端演示，不产生真实记录"，`:391` 注释"Fixed, inspectable front-end demonstration, not a real prize draw"；
  `MyRewardsPage.tsx:79` 只展示"已发布活动中真实获得的奖励"，并显式说明抽奖不在其中。
  奖励钱包与进度全部走 `ACTIVITY_ROUTES` / `REWARD_ROUTES` 真实接口，没有任何抽奖结果写入
  发放/库存/凭据的代码路径。
  领取按钮的启用也由服务端事实驱动（`RewardProgressCard.tsx:405`：`eligible && !grant`，`disabled=!claimableByMe`），
  不靠前端猜。
- **前端文案与新可达 reason 对齐**【读码】：`rewardLabels.ts:48 / :66`、`useRewardProgress.ts:58`
  原本因后端从不返回 `activity_ended` 而成为死文案，现已被真实触发；三处文案分别是
  "活动已结束，签到入口已关闭。""活动已结束，奖励暂不可领取。"，与后端语义一致，无残留误导文案。

---

## 10. 结论

**pass。**

- 第 1 轮提出的 3 个缺陷（F1 受领人可被轮换、F2 已核销后签发死码、F3 暂停/结束后仍可领取与核销）
  **全部用我自己构造的真实 HTTP + 真实 SQLite 场景复现为已修复**，
  且都验证到"库存/预算/授予/凭据行数"这一层，而非只看状态码；
- 修复没有修过头：`any_member` 的"首个领取者即受领人"仍成立，受领人自己的重复领取仍是幂等 200，
  暂停后 `resume` 仍能正常领取与核销；
- 三处被改动的既有断言逐条判定为**必要更新**（两处在旧实现下是把缺陷写成规格，一处在旧门禁下已不可达），
  其中两处新断言比旧断言更严；
- 四条低风险遗留项全部闭环（死过滤删除、`activity_ended` 错误码、文档 163/163 + 生命周期章节、临时脚本删除）；
- 门禁由我本轮亲手重跑：API 测试 **163/163 exit 0**、`pnpm typecheck` 全 workspace **exit 0**。

§8 的 3 条 low 观察（`recipient_user_id` 未进不可变触发器、草稿写路径文案与读路径不一致、
活动结束后未核销码仍计为在途）不涉及多发/错发/账实不符，不阻塞本卡合并；
其中 O1 与 O2 是"一行改动即可对齐"的加固项，建议单独开卡跟踪。
