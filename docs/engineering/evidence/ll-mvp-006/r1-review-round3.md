# LL-MVP-006 · R1 独立复核（第 3 轮）：运营手册 §8 五项已知边界的逐项裁决

- 任务：`t14` 独立复核（R1，attempt 1）；Issue [#62](https://github.com/sanchuang-dev/local-life/issues/62)
- 分支：`feat/ll-mvp-006-checkin-rewards`，HEAD `7095b84`（基线 `dev@7095b845c3a47a6d08d2ad663b10bcffe51e1194`）
- 复核人：`r1-review`（未参与实现；本轮**只写本文件**，未修改 `apps/**`、`packages/**`、测试、迁移或 `pnpm-lock.yaml`）
- 复核时间：2026-11-04/05（Asia/Shanghai）；Node `v22.23.2`、pnpm `10.19.0`
- 复核对象：`docs/engineering/evidence/ll-mvp-006/operator-guide.md` §8 登记的 6 条差异（任务契约说 5 项；
  §8.6 与本轮裁决无关，未在裁决范围内，仅在第 7 节附带一句说明）

## 0. 结论速览

| 项 | 手册原文定性 | 本轮独立裁决 | 阻塞？ |
| --- | --- | --- | --- |
| §8.1 活动级 `prizeQuantityCap` / `budgetCapCents` 不参与发奖 | 「影响：中等」 | **可保留的合理边界**（但表单文案有误导，建议非阻塞改进） | 否 |
| §8.2 `checkinWindow` 与活动起止不交叉校验 | 「影响：中」 | **必须修 —— 已修，方向正确**；但修复引入 **1 个新缺陷**（§4.5 / B1：契约允许的「省略 rewardPlan 键」PATCH 在 Hono 层**直接 reject、连 Response 都没有**，经 `@hono/node-server` 兜底后浏览器看到空 body 500） | **是**（B1） |
| §8.3 `dismissed` 后授予停在 `disputed` | 「影响：低」 | **必须修**：不是展示问题，是该笔奖励永久失去所有处置手段 | **是** |
| §8.4 管理台没有核销入口（`redeemCredentialCode` 0 消费者） | 「影响：低」 | **可保留**（但该导出是死代码，建议删除而非保留） | 否 |
| §8.5 两个不可达枚举值 | 「影响：极低」 | **可保留**（两个值性质不同，需分开处理；`grant.expired` 删除属破坏性变更） | 否 |

> **与手册的分歧（请维护者注意）**：手册把 §8.3 判为「影响：低 · 数据不脏」，
> 本轮实测认为该定性**低估**了后果：驳回争议后该笔奖励**没有任何可达的后续处置**
> （撤销 / 重开争议 / 反转 / 重新核销 / 团队重领全部 409），且库存账与管理台计数**永久差 1**。
> 详见 §3。

### 可复用方法一：如何判断一个字段是不是「对用户的承诺」

§8.1 的裁决不是靠读手册，而是靠一条可复用的判定流程。维护者以后遇到「这个字段没生效算不算缺陷」时可直接套用：

1. **先枚举该字段可能出站的每一个响应体**，不靠印象。本卡中与奖励相关的出站面只有四类：
   公开详情 `GET /activities/public/:id`、公开列表、居民奖励状态 `GET /activities/:id/rewards`、
   居民凭据 `GET /activities/:id/rewards/credential`。
2. **对每类响应体做键枚举**（不是看 schema 名字，而是 `JSON.stringify(Object.keys(body))`），
   逐字段断言 `contains = true/false`。
3. **对客户端再做一次全仓 `grep`**，确认没有任何界面把该字段渲染出来。
4. 判定规则：
   - **字段出现在任一居民可见面 → 它就是对居民的承诺**，与实现不一致即为「必须修」；
   - **字段只出现在运营面 → 属运营侧语义冗余**，是「可保留」的合理边界（但仍应加文案提示）。
5. 同时必须确认该字段是否**在改动前就存在**（`git show <baseline>:<file>`），
   以区分「本卡把原本生效的东西改坏了」和「一直都是内部冗余」——这两者责任完全不同。

产出：`prizeQuantityCap` / `budgetCapCents` / `totalPrizeQuantity` 在四类公开面上**全部 `false`**，
`apps/web` 全仓 `grep` **零命中**，且两字段自 `dev@7095b84` 就存在 → 判**可保留**。
（若采用「看手册怎么说」或「看 admin schema 有就以为公开面也有」，会得出相反且错误的结论。）

### 可复用方法二：绿灯数 ≠ 覆盖度

本卡最有价值的工程教训，也是 B1 得以漏到第三轮的原因：

- **179/179 全绿的同时，B1 依然存在。** 测试数从 163 涨到 179（+16），B1 一个都没碰到。
- 原因不是测试写得差，而是**断言层次错了**：所有相关测试都在 service 层断言「抛了个错」，
  没有一条断言**这个错最终映射成哪个 HTTP 状态码**。
- 由此得到的判据：**当一个缺陷的表现是「错误码/错误体不对」时，service 层的 `assert.throws`
  天然抓不到它**——必须在 HTTP 层（最好是真实套接字层）断言 `status` 与 `error.code`。
- 这条也解释了为什么「门禁绿」不能替代本报告：门禁验的是既有断言的回归，
  验不了「从未被断言过的维度」。第四轮复核将强制以 HTTP 状态码为断言口径。

### 证据强度分级

| 标记 | 含义 |
| --- | --- |
| **【亲手跑】** | 本轮在本机实际执行的命令与真实输出（真实 HTTP、真实 SQLite、直接 SQL、真实 `@hono/node-server` 进程） |
| **【读码】** | 只做源码 / 迁移 / 契约的静态阅读与 `grep` 交叉验证，**未执行** |

本轮的裁决**不采用手册的描述作为事实依据**：手册每一节的现象都用独立探针重新构造并复现了一遍，
并且都验证到「库存行 / 授予行 / 凭据行」这一层，而不是只看状态码。
凡涉及**可达性**（运营在界面上能否点到、契约允许的调用方能否发出）的判断，
我都单独用真实生产入口（`@hono/node-server` 的 `serve()`）复验，并在正文标明「UI 可达 / 仅契约可达」。
凡与手册描述不一致的地方，以本轮实测为准并显式标注。

### 探针清单（全部在 `/tmp`，未进入仓库）

| 探针 | 用途 |
| --- | --- |
| `/tmp/p3-cap.mts` | §8.1：活动级 cap 与计划 cap 并存时的实际发放 |
| `/tmp/p3-blocker.mts` | §8.1 反向：计划 cap 是否真的兜住（第 4 个团队被拒） |
| `/tmp/p3-dispute.mts`、`/tmp/p3-dispute2.mts` | §8.3：驳回争议后的全部可达路径 |
| `/tmp/p3-legacy2.mts`、`/tmp/p3-legacy3.mts` | §8.2：历史越界快照的读写可达性 |
| `/tmp/p3-t13.mts`、`/tmp/p3-inherit.mts`、`/tmp/p3-narrow.mts` | §8.2：写路径校验矩阵与继承分支 |
| `/tmp/p3-prestart.mts`、`/tmp/p3-hatch.mts`、`/tmp/p3-pub.mts` | §8.2：越界窗口的实际可利用性与修复逃生口 |
| `/tmp/p3-live.mts`、`/tmp/p3-prod.mts`、`/tmp/p3-form500.mts`、`/tmp/p3-reach.mts` | §8.2-D：真实生产入口下的错误映射与三条路径可达性对照 |
| `/tmp/p3-ttl.mts` | §8.5：凭据过期后授予状态的真实取值 |

---

## 1. 门禁重跑【亲手跑】

在**只新增本文件**的工作区执行，未复用任何缓存结果：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @sanchuang-dev/local-life-api test` | **179/179 pass, 0 fail, exit 0**（`duration_ms` 11371.7） |
| `pnpm typecheck` | **exit 0**；`packages/contracts` / `apps/api` / `apps/admin` / `apps/web` 全部 `Done` |

```text
1..179
# tests 179
# suites 0
# pass 179
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11371.685542
```

测试数从第 2 轮复核时的 **163** 增至 **179**（+16），全部来自 t13 新增的窗口交叉校验用例与历史快照兼容用例。
本轮的 179/179 是在 t13 的改动**已在工作树中**的状态下取得的。

**门禁绿不等于本轮通过**：下面 §8.2-D 的 500 缺陷在 179/179 全绿的情况下依然存在——
现有测试没有任何一条以「省略 `rewardPlan` 键的 PATCH」去触发继承分支的越界判定。

---

## 2. §8.1 活动级 `prizeQuantityCap` / `budgetCapCents` 不参与发奖

### 2.1 裁决

**可保留的合理边界。** 它不构成「对居民的错误承诺」，因为这两个字段**从不出现在任何居民可见面上**。
但它确实构成「对运营的语义冗余」，且表单文案让运营以为它生效——这一点建议非阻塞改进。

### 2.2 事实（决定性的那一条）【亲手跑】

构造：活动级 `prizeQuantityCap = 1`、`budgetCapCents = 20000`；
冻结计划 `totalPrizeQuantity = 3`、`budgetCapCents = 15000`；
三个团队依次达标并领奖。

```text
活动行:  activities.prizeQuantityCap = 1        activities.budgetCapCents = 20000
冻结计划: rewardPlan.totalPrizeQuantity = 3     rewardPlan.budgetCapCents = 15000

三个团队:  200 created=true qty=1  ×3
grants issued = 3, distinct teams = 3
stock       = { total: 3, claimed: 3, committed: 15000, budgetCap: 15000 }
overview    = grantsTotal: 3, codesActive: 3
```

**发出 3 份，不是 1 份**——手册描述的现象属实。库存行的 `budgetCap` 取的是 **15000（计划值）**，
不是 20000（活动值），证明两个字段彼此独立、只有计划驱动履约。

### 2.3 公开面是否暴露这两个字段 —— 直接回答队长的问题【亲手跑】

这是本项裁决的关键，不采用手册说法，直接枚举真实 HTTP 响应体的键：

```text
public detail keys = community, description, endsAt, id, location, publicRules,
                     publishedAt, ruleVersion, startsAt, status, summary, title, updatedAt
public payload contains prizeQuantityCap = false
public payload contains budgetCapCents   = false
public payload contains totalPrizeQuantity = false
```

- 公开详情：**否**
- 公开列表：**否**
- 居民奖励状态（`GET /activities/:id/rewards`）：**否**（三个字段全为 `false`）
- 居民凭据（`GET /activities/:id/rewards/credential`）：**否**（键里没有任何 cap）

代码侧交叉验证【读码】：

- `packages/contracts/src/index.ts:332` `publicActivitySummarySchema` 只有
  id/title/summary/community/location/startsAt/endsAt/status/ruleVersion/updatedAt；
- `:347` `publicActivityDetailSchema` 只追加 description/publicRules/publishedAt；
- `apps/web` 全仓 `grep prizeQuantityCap|budgetCapCents|totalPrizeQuantity` → **0 命中**；
- 居民端只渲染 `publicRules` 的四段自由文本
  （`SilverNeighborhoodCampaignPage.tsx:1047-1050`）。

而这两个字段**确实**出现在运营面上（`adminActivitySummarySchema:363` 起、活动详情面板
「预算上限」「奖品数量上限」、活动表单同名输入框）。

### 2.4 为什么这判「可保留」而不是「必须修」

队长给的判据是：**公开面暴露 → 对居民的错误承诺 → 必须修；不暴露 → 运营侧语义冗余 → 可保留。**

代码事实落在第二种：

1. 居民在任何界面上都看不到「奖品上限 1 份」这类数字。居民看到的「奖品领取」是运营自己写的
   自由文本（`publicRules.prizeClaim`），系统不会替运营生成任何数字承诺。
2. 因此不存在「承诺 1 份却发 3 份」的对外不一致——系统对外**根本没有承诺过 1 份**。
3. 这两个字段自 `dev` 基线就存在（`git show 7095b84:packages/contracts/src/index.ts:164-165`），
   本卡只是把真实履约搬到了 `rewardPlan` 上，没有把原本生效的东西改成不生效。

### 2.5 但这条边界确实有代价（非阻塞建议）

它会让运营在同一个表单里填两个「奖品数量上限」，而只有第二个生效：

- 活动级：`ActivitiesPage.tsx:1497-1532`「预算上限（元）」「奖品数量上限」，**无提示**
- 计划级：`ActivitiesPage.tsx:560` 起「单件成本」「每团奖品数量」「奖品总库存（份）」「奖励预算上限（元）」

运营侧的真实后果是：填了活动级 1、计划级 3，系统发 3 份，运营以为超发了。**这是运营误判风险，不是资金/库存风险**。

**建议（非阻塞，不要求本卡修）**：给活动级两个字段加一句 `extra` 说明，例如
「此字段不计入奖励履约；实际发奖上限见下方『奖励计划』」。
这属于 `apps/admin` 文案，且不属于 t12/t13 的文件范围，建议单独立项或由维护者决定。

---

## 3. §8.3 `dismissed` 后授予停在 `disputed` —— 必须修（阻塞）

### 3.1 裁决

**必须在本卡修复的缺陷。** 手册判「影响：低 · 数据不脏，只是状态标记不归位」——**该定性不成立**。

它不是展示问题。驳回争议后，该笔奖励进入一个**没有任何可达后续处置的死状态**，
同时把「库存已核销」与「授予已核销」两个账面永久拉开 1 的差额，且管理台与居民端对同一笔奖励给出**互相矛盾**的结论。

### 3.2 复现【亲手跑】

路径：团队达标 → 领奖 → 现场核销 → 开争议 → **驳回（`dismissed`）**。

```text
A. dismiss status = 200
B. after dismiss, revoke          -> 409 reward_already_redeemed
B. after dismiss, reopen dispute  -> 409 conflict
B. after dismiss, reverse now     -> 409 conflict
B. after dismiss, redeem again    -> 409 reward_already_redeemed
B. after dismiss, team re-claim   -> 409 reward_unavailable
C. resident grant.status = disputed   openDisputeId = null
D. resident bucket inputs: disputed? = true
E. admin row: openDispute = false     grant.status = disputed
F. stock redeemedQuantity = 1   redeemedBudgetCents = 5000
G. overview counts: grantsRedeemed = 0  grantsDisputed = 1  grantsTotal = 1
H. DRIFT: stock.redeemedQuantity - counts.grantsRedeemed = 1
I. db row: status = disputed  redeemedAt set = true  revokedAt = null
J. reversed path (对照组): status = 200  grant.status = reversed  counts.grantsReversed = 1
```

### 3.3 UI 可达性：这条不是「只要有人手工调 API 才会遇到」【读码】

「驳回争议」按钮位于 `row.openDispute ?` 分支内（`ActivityCheckinPage.tsx:941-947`），
**争议打开时运营在管理台能直接看到并点击**——不是隐藏入口、不是只走 API。
点下去就进入第 3.2 节的死状态，且界面上不会再出现任何补救按钮。
这是 B2 与 B1 在可达性上的关键区别：**B2 是运营日常点得到的，B1 不是。**

### 3.4 三条独立的缺陷理由

**(1) 永久失去所有处置手段——五条路全是 409。**
`0006` 的状态机只允许 `redeemed → disputed`、`disputed → reversed`（迁移 `0006:340-350`）。
一旦线程以 `dismissed` 收尾、`grant.status` 仍是 `disputed`，而 `selectOpenDisputeId()`
（`rewards/service.ts:635-643`）只在**最后一条记录是 `opened`** 时才返回非空——于是：

- `revokeGrant` 拒绝 `redeemed|disputed|reversed` → 409 `reward_already_redeemed`
- 重开争议要求 `status === 'redeemed'` → 409
- 裁定 `reversed` 要求 `status === 'disputed' && openDisputeId !== null` → `openDisputeId` 为 null → 409
- 重新核销要求 `grant.status === 'granted'` → 409
- 团队重领有 `(activity_id, rule_version_id, team_id)` 部分唯一索引 + `reward_unavailable` → 409

**结论：这笔奖励从此不能再被任何一条代码路径改动。** 如果驳回是误操作（运营点错了），
真实世界里唯一的修复手段是**直接改数据库**——而 32 个触发器里有 3 个明确禁止改状态。

**(2) 账面对不上，且差额是永久的。**
`stock.redeemedQuantity = 1` 而 `counts.grantsRedeemed = 0`（授予行落在 `disputed` 桶）。
`counts` 是按 `grant.status` 分桶的（`service.ts:2874-2876`），所以：
库存说「已核销 1 份」，授予说「已核销 0 份、争议 1 份」。这个差额不会随时间消除。
无论维护者认为「争议中」该算已核销还是不算，**两个数不一致本身就是缺陷**——
活动收尾对账时运营无法判断到底该按哪个数结账。

**(3) 管理台与居民端互相矛盾。**
- 管理台：`openDispute = false`（`selectOpenDisputeId` 返回 null），列表里不显示「存在未结争议」标签，
  且**不再渲染任何操作按钮**（`ActivityCheckinPage.tsx:921` 的 `row.openDispute ?` 分支不成立，
  `:958` 的开争议按钮要求 `status === 'redeemed'` 也不成立）。
  即：运营看到一条「争议中」的奖励，**没有任何可点的按钮**。
- 居民端：`rewardBucketOf()` 命中 `grant.status === 'disputed'`（`rewardLabels.ts:142` 附近），
  桶为 `disputed`，文案恒定为「该笔奖励存在争议，已暂停核销，请到活动现场联系工作人员。」
  （`rewardLabels.ts:167` 附近）——而争议**已经被驳回了**，工作人员那边看过之后没有任何手段能处理。

居民被永久指引去找一个**没有工具可用的**工作人员。这是明确的居民体验缺陷。

### 3.5 修复方向

不需要新迁移也能修，且两种方向都可接受，**但必须选一个**：

- **方向 A（推荐，最小改动，无迁移）**：`dismissed` 裁定在写线程行的同时，把
  `grant.status` 从 `disputed` 改回 `redeemed`。这需要 `0006` 状态机新增 `disputed → redeemed` 边，
  属**新迁移**——与手册「改状态机需新迁移」的判断一致，但那不是「超出本卡范围」的理由，
  而是本卡应当补的迁移。
- **方向 B（无迁移）**：保留 `disputed` 标记，但让 `dismissed` 之后所有处置路径**仍然可达**：
  `revokeGrant` / 开争议 / 裁定 的守卫不只看 `status`，还要看「线程最后一条是否为终态」，
  并让 `rewardBucketOf` 在 `openDisputeId === null` 时把桶降级为 `redeemed`。
  这条改动面更大，且会让「争议中」标签含义变模糊。

**无论选哪个方向，都必须补一条测试**：驳回争议 → 断言该授予仍可被至少一条路径处置
（或断言它已回到 `redeemed` 且计入 `grantsRedeemed`），并且 `stock.redeemedQuantity === counts.grantsRedeemed`。

### 3.6 附带：这是全卡唯一一处「同一份礼品可能被重复发出」之外的第二类资金不可对账

队长要求「任何导致『居民被承诺了不存在的奖励』或『同一份礼品被重复发出』的项都要直接点出」。
§8.3 **不属于这两类**（它不会多发，也不会少发，实物只有一份且已核销），
但它属于**第三类**：账目永久不可对账 + 运营无补救。我按阻塞项报，理由是「代码里已声明的已知限制
被写成了文档规避，而实际后果是运营没有工具可用」——这正是本轮被要求不要替施工队找台阶的地方。

---

## 4. §8.2 `checkinWindow` 与活动起止不交叉校验

### 4.1 裁决

**必须修 —— t13 已经修了，方向正确。** 但 t13 的修复**引入了 1 个新的、阻塞级缺陷**（§4.5），
必须在收卡前修掉。历史快照兼容性这一条（队长最担心的地方）**经实测确认没有问题**（§4.4）。

### 4.2 这个漏洞真实可利用（不是理论风险）【亲手跑】

活动 `startsAt` 在 **3 天后**，冻结计划的签到窗口**覆盖当下**（即手册 §8.2 的现象）：

```text
activity startsAt  = 2026-11-07T18:16:32.818Z  (in 3 days)
frozen plan window = 2026-11-04T17:16:32.818Z -> 2026-11-04T19:16:32.818Z  (covers NOW)
public detail status = published

checkin before activity start -> 200
checkin before activity start -> 200
checkin before activity start -> 200
CLAIM  BEFORE ACTIVITY START -> 200  created = true  code = issued
REDEEM BEFORE ACTIVITY START -> 200  true
```

活动还没开始，三个居民签到成功、团队达标、领到一份 `重阳糕礼盒`、并且**当场核销成功**。
根因是 `lifecycleBlockReason()`（`rewards/service.ts:969-981`）只拦 draft / paused / ended，
**不拦「已发布但还没开始」**。SQL 层的 `activity_checkins_window_guard`（`0006:310-325`）
只校验签到时刻落在**冻结窗口**内，而窗口本身没被校验过是否落在活动内——闭环是假的。

### 4.3 t13 的校验是否真生效【亲手跑】

写路径矩阵（全部走真实 HTTP `POST /admin/activities`）：

```text
1 window entirely BEFORE activity  -> 400 invalid_request
2 window entirely AFTER activity   -> 400 invalid_request
3 opens 1s before startsAt         -> 400 invalid_request
4 closes 1s after endsAt           -> 400 invalid_request
5 window EXACTLY = activity bounds -> 201      （边界正确放行）
6 window strictly inside           -> 201
7 no reward plan (null)            -> 201      （无计划不受影响）
8 no rewardPlan key at all         -> 201
```

契约层的读写分离也已落实（`packages/contracts/src/index.ts`）：

```text
read  schema accepts out-of-bounds = true    (activityKeyRulesSchema:176)
write schema accepts out-of-bounds = false   (activityKeyRulesWriteSchema:269)
read  schema accepts missing key   = true
write schema accepts missing key   = true
read  schema accepts explicit null = true
```

设计是对的：**拒绝坏的「新输入」和拒绝读「旧的行」是两件事**。
`assertCheckinWindowInsideActivity()`（`:213`）被导出为独立函数，
写路径（`createActivityRequestSchema:282`、`updateActivityRequestSchema:294`）用它，
读路径（`listActivityRuleVersions:836`、`parsePlanFromSnapshot:209`）用宽版 schema。

### 4.4 历史快照兼容性 —— 直接回答队长的担心【亲手跑】

队长担心：「`0000–0005` 时代 `snapshot_json` 没有 `rewardPlan` 键；如果校验要求有窗口，
已发布的旧活动会被读成 500。」

**实测：不成立，兼容性是安全的。** 两条独立证据：

**(a) 无 `rewardPlan` 键的快照照常解析。**
`rewardPlan` 在 `activityKeyRulesSchema` 上是 `.nullable().optional()`，
`safeParse` 对「键缺失」和「显式 null」都返回 true（见 §4.3 第 7、8 行）。

**(b) 故意构造「越界窗口」的历史快照，打穿所有读写面。**
先确认 `activity_rule_versions` 的不可变触发器确实在工作（这本身是好事）：

```text
SqliteError: activity_rule_versions rows are immutable
```

临时移除 `activity_rule_versions_no_update` 触发器后写入越界快照，然后遍历所有出入口：

```text
0. legacy snapshot in place; window is entirely before the activity
  resident GET  /activities/:id/rewards            -> 200
  resident GET  /activities/:id/checkin            -> 200
  resident GET  /activities/:id/rewards/credential -> 404 not_found
  resident POST /activities/:id/checkin            -> 200
  resident POST /activities/:id/rewards/claim      -> 200
  admin    GET  /admin/activities/:id/rewards       -> 200
  admin    GET  /admin/activities/:id/rule-versions -> 200
  public   GET  /activities/public/:id              -> 200
  admin    POST pause                              -> 200
```

**没有任何一个 500。** 并且越界行仍然**可被修复**：

```text
A. seeded legacy out-of-bounds draft, admin GET -> 200, plan present = true
B. EDIT dates only on legacy OOB row            -> 200   （新 startsAt 生效）
C. REPAIR with in-bounds plan                   -> 200   （可修）
D. INTRODUCE OOB window on repaired row          -> 400   （修好后再越界仍被拒）
```

**结论：队长担心的方向问题不存在。** t13 用「读宽写严」拆分解决了它，
并且新增的 3 条测试把这个拆分钉住了（`activities-reward-plan.test.ts:704-850`，
含「历史行仍可读」「越界行可被运营修复」「读 schema 仍然宽容」）。

> 补充一条更根本的事实【读码】：`rewardPlan` 字段、`rewards.ts` 契约与 `0006` 迁移
> **在本卡之前都不存在**（`git cat-file -e origin/dev:packages/contracts/src/rewards.ts` → 不存在；
> `git show 7095b84:packages/contracts/src/index.ts | grep -c rewardPlan` → **0**）。
> 因此 `dev` 上不存在任何「带 rewardPlan 的历史快照」。
> 本项的兼容性风险**只可能**产生于本卡自己的部署过程中（同一分支的早期 commit 先上线），
> 而实测证明即使那种情况也不会 500，且可修。

**但「可保留」的结论到此为止——下面这个新缺陷必须修。**

### 4.5 【阻塞 · t13 引入】继承分支的越界判定把 ZodError 抛出到错误映射之外 → 真实 HTTP 500

> **可达性先说清（实测，不夸大）**：这个 500 **只能由「`keyRules` 里省略 `rewardPlan` 键」的 PATCH 触发**。
> 管理台表单在计划已存在时始终回填该键，所以 **UI 当前点不出来**（实测 PATH1 = 400）。
> 详见下面「触发条件」。

#### 现象【亲手跑】

```text
A. created 201 | activity endsAt 2026-11-14 | plan closesAt 2026-11-13
B. DATES-ONLY narrowing edit -> {"status":500,"text":"","full":""}
C. server still alive? -> {"status":200, ...}     （进程没崩，但请求得到空 body 500）
D. row intact (no partial write) -> endsAt = 2026-11-14
```

#### 三层入口的精确表现（同一根因，三种现象——不要只看一层）

| 层 | 调用方式 | 实测结果 |
| --- | --- | --- |
| L1 测试助手 | `app.request()` | **Promise reject**（`ctor = ZodError`，`instanceof Error = false`），无 Response |
| L2 直接调用 | `app.fetch(Request)` | **throw**，无 Response |
| L3 生产入口 | `@hono/node-server` `serve({fetch})` | **HTTP 500**，`statusText = "Internal Server Error"`，**body 长度 0** |
| 对照 | 裸 `node:http` 包 `app.fetch` | HTTP 599（我自己的桩），证明兜底来自 node-server 而非 Hono |

**根因链条**：Hono 的 `#handleError`（`hono-base.js:252-255`）是
`if (err instanceof Error) return this.errorHandler(err, c); throw err;`。
因为抛出的 `ZodError` **`instanceof Error === false`**，Hono 拒绝调用我们的 `onError`
（已用探针确认 `onErrorRan = false`），把错误继续抛出。
在 L1/L2 没有外层兜底，表现为 reject/throw；在 L3 被
`@hono/node-server@2.1.5` 的 `handleFetchError`（`dist/index.mjs:864`）
兜成 `new Response(null, { status: 500 })`。

> **口径说明（重要）**：本报告以 **L3 生产入口**为准，因为那是运维和浏览器实际看到的现象
> ——**空 body HTTP 500**。L1/L2 的「连响应都没有」是同一根因在缺少兜底时的表现，
> 它更接近本质（说明 Hono 的 `onError` 契约已被绕过），但**不是生产表现**。
> 两层都是真问题，此处并列写出，避免维护者按任一层误判严重度。
> 顺带一条工程提醒：**用 `app.request()` 得到的异常形状不能直接当作生产表现**，
> 涉及错误映射的结论应在真实套接字层复验。

#### 触发条件（三条路径的差异，实测划清）

同一个业务规则在三条入口上给出**两种结果**，这是本项最需要施工队注意的地方：

```text
PATH1 管理台表单形状（rewardPlan 键始终存在） -> 400   ✅ 符合预期
PATH2 keyRules 里省略 rewardPlan 键           -> 500   ❌ body 长度 0
PATH3 service 层直调 updateActivity           -> ZodError（非 ActivityError）
```

**只有 PATH2 是 500，PATH1 是好的 400。** 原因是管理台表单在计划已存在时**总会**回填并发送
`rewardPlan` 对象（`ActivitiesPage.tsx:319-325` 的 `rewardPlanFromForm`：开关开 → 发对象；
开关关且有 baseline → 发 `null`；只有「开关关且无 baseline」才省略键，而此时
`storedPlan === null`，守卫直接 return，不会抛）。所以：

- **管理台 UI 用户当前点不出这个 500**——这是好消息，B1 的严重度应据此下调（见下文「影响」）。
- 但**契约明确允许省略这个键**：`withEffectiveRewardPlan()` 的 doc comment
  （`activities/service.ts:205-217`）把「键缺失 → 继承已存计划」写成**受支持的公开语义**，
  `rewardPlan` 在 `activityKeyRulesWriteSchema` 上是 `.optional()`。
  任何按契约调用该 API 的客户端（脚本、未来的第三方、测试、`curl`）都会踩到 500。

PATH2 的触发步骤：

1. 活动 `endsAt = 11-14`，计划 `checkinWindow.closesAt = 11-13`（创建时合法）
2. `PATCH` 只改结束时间到 `11-06`（早于 `11-13`），**`keyRules` 里不带 `rewardPlan` 键**
3. 请求进入 `updateActivity` → `withEffectiveRewardPlan()`（`activities/service.ts:218`）
   的「键缺失 → 继承已存计划」分支
4. 合并后 `wasOutOfBounds` 为 false（原存计划在**原**活动范围内是合法的），
   于是执行 `assertCheckinWindowInsideActivity(merged)`（`:244`）
5. 该校验**无 `ctx` 时直接 `throw new z.ZodError(...)`**（`contracts/src/index.ts:241-245`）
6. PATCH 路由的 `failWithActivityError`（`activities/routes.ts:89-93`）只映射 `ActivityError`，
   **其他错误 `throw error`** 继续上抛
7. `onError`（`app.ts:902`）**没有被调用**，最终返回空 body 500

#### 为什么是 500 而不是 400（真实根因，比表面严重）

```text
!! THROWN OUT OF app.fetch | ctor = ZodError | instanceof Error = false | name = ZodError
```

`instanceof Error === false`。Hono 的 `#handleError`（`hono-base.js:252-255`）是：

```js
#handleError(err, c) {
    if (err instanceof Error) return this.errorHandler(err, c);
    throw err;
}
```

因为 `instanceof Error` 为 false，Hono **拒绝**调用我们的 `onError`，把错误再次抛出
（探针实测 `onErrorRan = false`），再由 `@hono/node-server` 兜底成空 body 500（详见上面三层对照表）。
（注：单独 require 同一份 zod 时 `instanceof Error` 为 true；这里为 false 说明抛出点与
`Error` 绑定来自不同模块实例 / 不同 realm。根因未深挖——**修复方向不依赖它**：
方案 A 不让异常逃出 service 层，从根上绕开 `instanceof` 判定。）

#### 为什么现有 179 条测试没抓到

测试全部走 `app.request()` 或 service 层直调，且创建路径的 `activityKeyRulesWriteSchema.parse`
发生在 `createActivity` 顶部（`activities/service.ts:548`），已被 `onError` 之外的上层兜住；
而**继承分支的 `throw` 只在这一个组合下出现**：
「活动已存在 + PATCH 只改日期 + 已存计划在原范围内合法 + 改后越界」。
没有任何一条测试构造过这个组合。

#### 影响

- 触发者看到的是**空白 body + 500**，不是「签到窗口超出活动时间」这句可操作的中文提示；
  服务端**没有日志**（`onError` 未执行），排障时连线索都没有。
- 与 `create` 和 PATH1 不一致：后两者返回 **400 + 可读提示**。
  **同一个业务规则在三条入口上给出两种结果。**
- **管理台 UI 当前点不出来**（PATH1 = 400），所以这不是运营日常会撞到的故障——
  严重度因此**不到「居民/资金受损」级别**。
- **不产生脏数据**（实测 `D. row intact`），也**不产生超发**。
- 但它是「契约允许 + 服务层必抛 + 路由不映射」的组合：任何按契约省略 `rewardPlan` 键的调用方
  都会拿到 500 空 body。判为**阻塞**，理由是修复代价极小（见下）、而错误契约一旦发出就难收回。

#### 严重度校准（我主动下调，避免夸大）

初稿我把这条写成「运营会看到空白页 500」。实测后**修正**：管理台表单始终回填 `rewardPlan`，
PATH1 返回正确的 400。因此本条的真实性质是**API 契约缺陷**（省略可选键 → 500），
而不是**运营界面缺陷**。维持阻塞评级，但依据是「契约允许的合法请求未得到 4xx」，
而不是「运营日常操作会崩」。

#### 修复方向

最小改动，任选其一：

- **A（推荐）**：`assertCheckinWindowInsideActivity()` 在 `ctx` 缺省时不要 `throw`，
  而是返回 issues 数组；`activities/service.ts:244` 拿到 issues 后抛 `ActivityError(400, invalidRequest, ...)`。
  这样与 `create` 路径的错误码和文案完全一致，也不依赖 `instanceof Error` 的跨实例行为。
- **B**：`activities/routes.ts:89-93` 的 `failWithActivityError` 补一条
  `if (error instanceof ZodError) return fail(c, 400, invalidRequest, ...)`。
  但这只是给这一条路由打补丁，其他调用点（若将来有）仍会漏。

**必须补的测试**：构造「已存在活动 + 只改日期 + 不含 rewardPlan 键 + 改后越界」，
断言 **HTTP 400 且 `error.code === 'invalid_request'`**，并且行未被修改。
现有测试全在 service 层断言「抛了」，没有断言**映射到哪个 HTTP 状态**，这正是漏网原因。

#### 附：继承分支那个「逃生口」是合理的，不是缺陷

`withEffectiveRewardPlan` 对已越界的旧行跳过校验（`activities/service.ts:236-245`），
理由是「否则运营永远修不了这行」。我实测确认它**只**对已越界的行放宽：

```text
B. EDIT dates only on legacy OOB row   -> 200   （逃生口，必要）
D. INTRODUCE OOB window on repaired row -> 400   （修好后再越界仍被拒）
```

**不构成新增越界行的通道**，判为正确的设计取舍。但请把逃生口的判定也纳入上面那条测试的覆盖。

---

## 5. §8.4 管理台没有核销入口（`redeemCredentialCode` 0 消费者）

### 5.1 裁决

**可保留**（现场核销走 H5 工作台是设计选择，不是缺陷）。
但那个导出是**死代码**，建议**删除**而不是「保留备用」。

### 5.2 事实【读码 + 亲手 grep】

各导出的消费者数（排除定义文件本身）：

```text
getRewardOverview    consumers=2
listActivityCheckins consumers=2
verifyCheckin        consumers=2
revokeCheckin        consumers=2
revokeRewardGrant    consumers=2
appendGrantDispute   consumers=2
redeemCredentialCode consumers=0      ← 唯一 0 消费者的导出
```

`apps/web/src/services/rewards.ts:304` 有一份**同名但独立**的实现，
被 `WorkbenchVerifyPage.tsx:40,209` 真实使用。两份不是同一个函数：

- 管理台版（`apps/admin/src/services/rewards.ts:195-207`）直接把 `{ code, note }` 当 body，
  **没有**用 `rewardRedeemRequestSchema.parse()`；
- H5 版（`apps/web/src/services/rewards.ts:304` 起）先 `rewardRedeemRequestSchema.parse()` 再发。

即管理台这份不仅是死代码，还**比在用版本更弱**（少了入参校验）。

### 5.3 为什么判「可保留」

- 现场核销用手机是**产品设计**（网格员在活动现场），不是缺失。
- 「坐办公室的工作人员想用电脑核销」是**真实但不阻塞**的体验缺口，属功能增强，不是缺陷。
- 因此**不要求本卡补管理台核销页面**。

### 5.4 但建议删除这个导出（非阻塞）

理由不是「未使用」，而是**它会误导下一个人**：

- 它的 doc comment 写着「the same one-time redemption the field worker uses」——
  这句话是**不准确的**（见 5.2，行为不同），会让维护者以为两处等价。
- 无测试覆盖（`apps/admin/src/services/rewards.ts` 没有对应测试文件）。
- 删除会连带清掉两个只被它使用的 import（`rewardRedeemResponseSchema`、`RewardRedeemResponse`），
  `pnpm typecheck` 已确认无其他引用。

**如果维护者希望保留**，至少把它改成复用 H5 版的行为（走 `rewardRedeemRequestSchema.parse()`），
并修正 doc comment。二者皆可，但**当前状态（错误注释 + 弱实现 + 零使用）是三者的最差组合**。

---

## 6. §8.5 两个不可达枚举值

### 6.1 裁决

**可保留。** 但两个值的性质不同，必须分开对待，不能一起判。

### 6.2 `rewardEventKindSchema` 的 `grant.expired` —— 保留

**事实【亲手跑 + 读码】**：

- 契约允许（`packages/contracts/src/rewards.ts:686`），
- 实际追加的 kind 全集（`grep` 全部 `appendRewardEvent` 调用点）：

```text
checkin.revoked, checkin.verified, credential.issued, credential.superseded,
dispute.opened, dispute.dismissed, dispute.reversed, grant.created,
grant.redeemed, grant.revoked
```

`grant.expired` **不含在内**，从未被写入。

**为什么保留**：

1. 事件是**纯服务端内部**的追加式审计账，**不经任何 HTTP 响应出站**：
   `adminActivityRewardOverviewSchema`（`rewards.ts:811-836`）里只有 `grants`，没有 `events`；
   全仓 `grep` 未发现任何返回事件列表的 schema 或路由。
2. 因此**没有任何客户端会为它写一个永远不可达的分支**——不存在「到处 `if (kind === 'grant.expired')`」的问题。
3. 删除它会导致 `0006` 迁移里 `activity_reward_events.kind` 的 CHECK 白名单
   （`0006` / `schema.ts:1122`）与契约不一致，需要新迁移，收益为零。

### 6.3 `activity_reward_grants.status = 'expired'` —— 保留（但需明确语义）

**事实【亲手跑】**：

- CHECK 允许（`schema.ts:902`）、状态机允许 `granted → expired`（`0006:340-350`）、
  客户端**确实在为它写分支**；
- 唯一写 `status: 'expired'` 的地方是 `rewards/service.ts:2363-2367`，写的是
  **`activity_reward_codes`**（凭据表），**不是 grants**（手册这一点是对的）。

客户端分支（真实存在，不是假设）：

```text
apps/web/src/components/activity/rewardLabels.ts:142   grant.status === 'expired' → 'void'
apps/web/src/components/activity/rewardLabels.ts:167   '该笔奖励已超过有效期。'
apps/admin/src/pages/ActivityCheckinPage.tsx:62        STATUS_META.expired = '已过期'
apps/admin/src/pages/ActivityCheckinPage.tsx:882       abnormalGrants 过滤器含 'expired'
apps/admin/src/pages/ActivityCheckinPage.tsx:805       （这是 credentialStatus，属另一枚举，不是本条）
```

**所以「客户端写了永远不可达的分支」在 grants 这一侧是成立的。** 这一点手册漏了。

**那为什么仍判「可保留」而不是「必须修」？** 因为实测确认 **凭据过期不会把 grant 变成 expired**：

```text
A. claimed; credential expiresAt = 2026-11-04T19:14:01.801Z
B. fast-forwarded TTL past 1h
C. redeem after TTL -> 400  redemption_code_expired
D. db: grant.status = granted   code.status = expired
E. resident reward: grant.status = granted   credential.status = expired
G. re-claim after TTL expiry -> 200  created = false  newCodeDiffers = true
H. codes now: active,expired
I. resident after reissue: grant = granted  credential = active
J. overview codesActive = 1  codesRedeemed = 0  grantsGranted = 1
```

凭据过期后：grant 保持 `granted`、居民看到「凭据已过期」、**团队重新领奖会自动重签一个新码**
（旧码 `superseded`/`expired`，新码 `active`）。这是一条**设计合理且可达的恢复路径**。

因此 `grant.status = 'expired'` 确实不可达，但**不会掩盖任何真实状态**：
真实状态是 `granted` + `credential.expired`，居民端文案由 `credentials.status` 那个分支
（`rewardLabels.ts:169`、`:204`）负责，是**能命中**的。

**保留的理由**：

1. 它是同一族枚举里的「预留终态」，语义清晰，且与 `codes` 的 `expired` 对称；
2. 删除它 = 改 `rewardGrantStatusSchema` 联合类型 + 改 `schema.ts` CHECK + 新迁移
   + 清掉 5 处客户端分支，属**破坏性变更**，收益仅是「少两个值」；
3. 它不会让任何居民看到错误承诺，也不影响账目。

**但必须在文档里写清（本轮建议）**：`grant.status` 永远不会是 `expired`；
「奖励已过期」这一事实**由 `credential.status` 表达**，而不是 `grant.status`。
客户端那 4 处 `grant.status === 'expired'` 是防御性死分支，可以保留，但不应被当作权威语义。

> 若维护者更倾向「消除误导」，正确做法是**单独立项**：新增迁移删枚举 + 清理客户端分支 + 补
> `credential.expired` 的显式状态展示。不建议在本卡内做。

---

## 7. 关于 §8.6（不在裁决范围，一句话说明）

手册还登记了 §8.6「没有过期清理任务，`codesActive` 会在过期后虚高」。
任务契约给的是「5 项」，§8.6 不在裁决范围，本轮**未对其作裁决**。
仅记录一条本轮实测的补充事实：码在**下次核销尝试**时才被置为 `expired`（§6.3 的 `D`），
未尝试则一直是 `active`——与手册描述一致，且**不会导致超发**（真核销时仍被 400 拦住）。

---

## 8. 阻塞项汇总（收卡前必须处理）

| # | 项 | 严重度 | 要求 |
| --- | --- | --- | --- |
| **B1** | §8.2-D：继承分支越界校验把 `ZodError` 抛出错误映射之外。**契约允许**的「省略 `rewardPlan` 键」PATCH 在真实生产入口返回**空 body HTTP 500**、无日志、无标准错误体，而 `create` 与带键 PATCH 均返回 400。管理台表单始终回填该键，故 UI 点不出来，性质是 API 契约缺陷而非运营界面缺陷 | **blocker** | 改为返回 `ActivityError(400, invalid_request)`（不要依赖 `instanceof Error` 兜底）；补一条**断言 HTTP 400 + `error.code`** 的测试（现有 179 条全在 service 层断言「抛了」，抓不到 HTTP 状态） |
| **B2** | §8.3：驳回争议后 grant 永久停在 `disputed`，五条处置路径全部 409，`stock.redeemedQuantity` 与 `counts.grantsRedeemed` 永久差 1，管理台无按钮而居民被指引去找工作人员 | **blocker** | 补迁移新增 `disputed → redeemed` 边让 `dismissed` 归位（方向 A），或让终态线程后处置路径仍可达（方向 B）；补「驳回后仍可处置 / 两数相等」的测试 |

两项都**不会**导致「同一份礼品被重复发出」或「居民被承诺了不存在的奖励」，但都是运营可感知、
的缺陷，因此按阻塞项报。B1 另有独立理由：它让一个**契约明确允许**的合法请求返回 5xx（而非 4xx），
修复代价极小但错误契约一旦发出就难收回；B2 则是运营侧**无按钮可用**、且账面永久不可对账。

## 9. 可保留项汇总（经独立裁决后有意保留，供维护者在 PR 说明中引用）

| 项 | 保留理由（一句话） | 附带建议（非阻塞） |
| --- | --- | --- |
| §8.1 活动级 cap 不参与发奖 | 公开面**可证不暴露**这两个字段（公开详情/列表/居民奖励状态/凭据全部 `false`），不存在对居民的承诺，仅运营侧语义冗余 | 表单加一句 `extra` 说明；`apps/admin` 文案，建议单独立项 |
| §8.2 t13 的读宽写严拆分 | 越界历史快照在**全部 9 个出入口**均 200，且越界行**仍可被运营修复**；`dev` 上不存在带 `rewardPlan` 的历史快照 | 无（B1 修完即可） |
| §8.2 继承分支对已越界行放宽 | 实测只对**已经越界**的行放行；修好后再越界仍被 400 拒绝，不构成新增越界行的通道 | 纳入 B1 的测试覆盖 |
| §8.4 管理台无核销入口 | 现场核销走 H5 是设计选择；「办公室核销」是功能增强不是缺陷 | **删除** `redeemCredentialCode`（死代码 + 注释不准确 + 实现更弱），或改为复用 H5 版 |
| §8.5 `grant.expired` 事件 kind | 事件是服务端内部审计账，**不经 HTTP 出站**，无客户端会为它写分支 | 无 |
| §8.5 `grant.status = 'expired'` | 凭据过期后 grant 保持 `granted` 且**可重签新码**（实测 200 且新码不同），真实状态不丢；删除属破坏性变更 | 文档写明「奖励过期由 `credential.status` 表达」；客户端 4 处死分支可留 |

---

## 10. 本轮未做的事（边界声明）

- **未修改任何仓库代码、测试、迁移、契约**。本轮唯一写入是这份文件。
  B1 / B2 的修复尚未由我实施——我是复核人，按契约不得为自己的实现盖章。
- **未做浏览器验证**。本轮全部结论基于真实 HTTP（`app.fetch` 与真实 `@hono/node-server` 进程）
  与真实 SQLite（含直接 SQL 和触发器行为观察），未启动 Vite 页面。
  §3.3(3) 关于「管理台不渲染按钮」的结论来自读码（`ActivityCheckinPage.tsx:921`、`:958`），
  未在浏览器里点一遍。
- **未验证部署态**。空 body 500 的复现使用本机 `@hono/node-server` `serve()`，与
  `apps/api/src/index.ts:34` 的入口一致，但未在容器/反向代理链路下复验。
  （反代是否把空 body 500 转成别的形态不影响结论：源头已返回 500。）
- `checkinWindow.opensAt` 的 `instanceof Error === false` 根因（zod 模块实例差异）**未深挖**；
  本轮只确认结果（500 / 无日志 / 无标准错误体）与修复方向（不要依赖 `instanceof Error` 兜底）。
