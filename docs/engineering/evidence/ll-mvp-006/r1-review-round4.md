# LL-MVP-006 · R1 独立复核（第 4 轮）：B1 / B2 修复与 0007 迁移验收

- 任务：`t18` 独立复核（R1，attempt 1，attempt_id `e436c818-cfbe-482c-998f-ece1a9e3a008`）；Issue [#62](https://github.com/sanchuang-dev/local-life/issues/62)
- 分支：`feat/ll-mvp-006-checkin-rewards`；复核对象：t17 对 B1 / B2 的修复 + 迁移 `0007_dispute_dismissed_restores_grant.sql`
- 复核人：`r1-review`（未参与实现；本轮**只写本文件**，未修改 `apps/**`、`packages/**`、测试或迁移）
- 复核时间：2026-11-05（Asia/Shanghai）；Node `v22.23.2`、pnpm `10.19.0`
- **范围**：按任务契约严格收窄到 B1 / B2 / 0007，不重跑全量验收（R2 的 91 项与全量门禁另行覆盖）

## 0. 裁决：**pass**

B1 与 B2 的修复都是**真修复**，不是把断言改绿。0007 迁移的五个关键点（替换非叠加、存量救回、不误伤、顺序正确、双库可升）**全部实测通过**，
且我用**变异测试**验证了 B1 的回归测试确实能抓住原缺陷（见 §2.5）。

**但必须同时记录两项新发现**（均非本卡阻塞，见 §5、§6）：

- **§5 部署顺序窗口期**：t17 的应用代码 + 仍停留在 0006 的数据库 → `dismissed` 返回 **500**。
  这是「代码先于迁移上线」的窗口期，不是数据缺陷，但 PR 说明必须写明迁移须先于代码生效。
- **§6 驳回不可撤回**：`dismissed` 之后若发现裁错了，**没有任何补救路径**（四路径全 409）。
  这不是 t17 引入的（`open_first` 触发器来自 0006），但 t17 让「驳回」变成一个有后果的终态动作，放大了它的业务含义。

两项都建议在 PR 说明中如实披露，而不是当作缺陷要求返工。

## 1. 门禁（亲手跑）

```text
pnpm --filter @sanchuang-dev/local-life-api test   → 189/189 pass, 0 fail, duration_ms 10684.23, exit 0
pnpm check                                         → EXIT=0
  ├─ oxlint                                        → 0 error
  ├─ typecheck                                     → contracts / api / admin / web 全 Done
  ├─ api node:test                                 → 189 pass, 0 fail
  ├─ local-dev                                     → 7 pass, 0 fail
  ├─ admin vitest                                  → 10 files, 91 tests passed
  └─ 四个包 build                                  → 全 Done
```

测试数从上轮复核的 **179** 增至 **189**（+10），新增全部落在 B1 / B2 / 0007 相关用例上。
**与第 3 轮的对照意义**：上一轮 179 全绿而 B1 存活；这一轮 B1 的漏洞被一条**断言 HTTP 状态码**的测试补上了，
所以 189 绿背后的覆盖度是真实的（§2.5 用变异测试证明了这一点）。

## 2. B1：ZodError 穿透 → 已修复

### 2.1 三条入口一致性（真实 HTTP，不是 service 层断言）

用真实 `@hono/node-server` 套接字发起 PATCH：

```text
活动创建时 endsAt = 2026-11-14 | 冻结计划 closesAt = 2026-11-13（创建时合法）
PATCH 把 endsAt 缩到 2026-11-06（早于 11-13），构成"继承计划越界"

PATH1 管理台表单形状（含 rewardPlan 键） -> 400  invalid_request  "活动信息不正确"
PATH2 省略 rewardPlan 键（契约允许）     -> 400  invalid_request  "checkinWindow.closesAt must not be later than endsAt"
PATH3 service 层直调 updateActivity      -> ActivityError（status=400, code=invalid_request）
```

**三条入口全部 400，且 `error.code === 'invalid_request'`。** 与第 3 轮对照：

| 入口 | 第 3 轮 | 第 4 轮 |
| --- | --- | --- |
| PATH1 管理台形状 | 400 | 400（未退化） |
| PATH2 省略键 | **500 空 body** | **400 invalid_request** ✅ |
| PATH3 service 直调 | 抛 `ZodError`（非 `ActivityError`） | 抛 `ActivityError(400)` ✅ |

### 2.2 被拒后无部分写入

```text
行未变: endsAt 仍 = 2026-11-14 | plan closesAt 仍 = 2026-11-13 | ruleVersion 未递增
```

三次被拒的 PATCH 都没有落库，活动行与冻结计划原样保留。

### 2.3 界内编辑仍成功且继承计划保留

```text
PATCH 省略 rewardPlan 键、只改 location -> 200 | 返回体中 rewardPlan.prizeName = 粮油礼包
```

继承语义没有被这次修复误伤。

### 2.4 修复方式：正是第 3 轮建议的方案 A

`packages/contracts/src/index.ts` 新增 `findCheckinWindowIssues()`——**返回 issues 数组，永不 throw**；
`assertCheckinWindowInsideActivity()` 改为把 issues 交给 `ctx.addIssue`。
`apps/api/src/activities/service.ts:249-254` 的继承分支改为：

```ts
const issues = findCheckinWindowIssues(merged)
if (issues.length > 0) {
  throw new ActivityError(400, API_ERROR_CODES.invalidRequest, issues[0]!.message)
}
```

**关键点：不再依赖 `instanceof Error` 的跨模块行为。** 异常不再逃出 service 层，
自然走 `failWithActivityError` → `fail()`，与 `create` 路径的错误码和文案完全一致。
根因（zod 模块实例差异导致 `ZodError instanceof Error === false`）**不必深挖也已修复**，
这是方案 A 相对"给路由打补丁"的优势。

### 2.5 变异测试：确认回归测试真的抓得住

这是本轮我认为最该做的一步——**光看测试通过不算数，要看测试能不能抓住缺陷**。

我把修复临时改回第 3 轮的写法（`throw new z.ZodError(...)`），再跑 B1 的回归测试：

```text
变异后：not ok 24 - an edit that omits rewardPlan and shrinks the activity is refused with 400
        # pass 24 / # fail 1
还原后：# pass 25 / # fail 0      （md5 与备份一致：3f9fc2fc7c36afde753c6875ec91b174）
```

**结论：该测试确实钉住了 B1，不是断言放宽后的假绿。** 变异已完全还原，`rewards-http.test.ts` 复跑 25/25。

### 2.6 测试的断言口径符合第 3 轮提出的标准

`apps/api/test/rewards-http.test.ts:1795-1859` 的 `t17 / B1` 用例注释明确写了「assert the HTTP status explicitly
because the original gap was exactly that no test ever mapped this rule to a status」，
并同时断言：`400` + `error.code === 'invalid_request'` + `message` 含 `checkinWindow` + **两次 GET 确认无部分写入**。
这正是我在第 3 轮总结的判据（缺陷表现是"错误码不对"时，service 层 `assert.throws` 天然抓不到）。

> 注：`rewards-http.test.ts:1729` 与 `:1766` 那两条 400 用例是 t13 的**创建**路径测试，不覆盖 B1 的**继承分支**。
> B1 的真正回归测试是 `:1806` / `:1861` 两条。两者不可混淆。

## 3. B2：驳回争议后奖励卡死 → 已修复

完整链路（真实 HTTP + 直接 SQL 对账）：

```text
claim -> 200 created=true，grant.status=granted
redeem -> 200，grant.status=redeemed
open dispute -> 200，grant.status=disputed，stock.redeemedQuantity=1 vs counts.grantsRedeemed=0
dismissed -> 200
  ├─ grant.status = redeemed                              ✅（第 3 轮是永久 disputed）
  ├─ redeemed_at / redeemed_by_staff_id 均保留             ✅（只恢复标志，不伪造核销）
  ├─ stock.redeemedQuantity=1 === counts.grantsRedeemed=1  ✅（永久差 1 已消除）
  ├─ 旧券再核销 -> 409 reward_already_redeemed             ✅
  └─ 争议桶 grantsDisputed=0，grantsRedeemed=1             ✅
```

### 3.1 `reversed` 路径行为未变

为防止"修 B2 破坏撤销语义"，单独构造 `opened → reversed`：

```text
redeem -> redeemed；opened -> disputed；reversed -> 200，status=reversed
counts: grantsReversed=1, grantsRedeemed=0
stock.redeemedQuantity=1（保持单调，与 t2 的既有设计一致）
reversed 后再驳回 -> 400；reversed 后再撤销 -> 400（状态机拒绝，未变）
```

**与改前一致**：`redeemed_quantity` 单调不减是既有设计（撤销不回收已核销计数），本轮未改变这一点。

### 3.2 账目恒等式（混合场景）

两个团队分别走 `dismissed` 与 `reversed`：

```text
counts = grantsRedeemed=1, grantsReversed=1, grantsDisputed=0
stock.redeemedQuantity = 2
恒等式: 2 === 1 + 1 -> true      ✅
```

即 `redeemedQuantity === grantsRedeemed + grantsReversed` 在混合终态下成立，
运营收尾时两个数字**可以互相解释**，不再出现无法结账的差额。

### 3.3 `dispute_already_resolved`（409）的裁定：**合理，但它是真实业务限制**

施工队把原来穿透的裸 `SqliteError` 前置为结构化 409。我确认：

**是新行为**——第 3 轮实测驳回后再开争议得到的是 500/异常；现在是 `409 dispute_already_resolved` + 中文提示「该奖励的争议已裁定，不能再发起新的争议」。

**为什么会这样**：`activity_reward_disputes_open_first` 触发器（**由 0006 引入，不是 t17**）规定
`opened` 只能出现一次且必须是线程第一条。t17 把 grant 从 `disputed` 恢复到 `redeemed` 之后，
`grant.status !== 'redeemed'` 这道旧守卫不再能提前拒绝，于是**唯一性触发器变成可达路径**，
施工队因此补了 `selectDisputeThreadExists()` 做前置判断，把 SQLite abort 转成结构化 409。

**这不是掩盖，是把隐式约束显式化**。但我必须指出它暴露的**业务限制是真的**：

> **一条授予只能有一次争议线程；驳回之后，即使发现新证据，居民和运营都无法再起争议。**

实测驳回后的四条补救路径：

```text
重开争议 -> 409 "该奖励的争议已裁定，不能再发起新的争议"
直接反转 -> 409 "没有进行中的争议可以裁定"
再次驳回 -> 400 invalid_request
撤销授予 -> 409 "已核销的奖励只能通过争议流程冲正，不能直接作废"
```

也就是说 `dismissed` 是**不可撤回**的终态。而「撤销授予」的提示语
（`rewards/service.ts:2537`「已核销的奖励只能通过争议流程冲正」）在此场景下指向一条**已关闭**的流程。

**我的裁定**：这属于**产品语义问题，不是本卡缺陷**，理由有二——

1. 约束源自 0006 的触发器设计（本卡的一部分，但已在 t1/t2 阶段确立并被接受），t17 没有新增限制，只是让已有口径对用户可见且不崩。
2. t17 之前这个场景更糟：不是"不能重开"，而是**500 且 grant 永久卡死**。现在至少状态正确、账目对得上、错误可读。

**但要求写进 PR 说明**（不要求在本卡改代码）：
「争议线程一次性：驳回即终态，不可重新发起。若运营驳回后发现裁错，当前系统**没有**补救入口，
只能由维护者介入改库（且需临时移除触发器）。后续卡应评估：是否允许驳回后重开（如限制次数或需管理员角色）。」

## 4. 0007 迁移：五个关键点全部通过

### 4.1 迁移在做什么（读码）

`0007_dispute_dismissed_restores_grant.sql` 两步，顺序有意：

1. `DROP TRIGGER` + `CREATE TRIGGER` 重建 `activity_reward_grants_status_transition`，新增 `disputed → redeemed` 边；
2. 回填 `UPDATE`，把「最新争议为 `dismissed`」的存量 `disputed` 行恢复为 `redeemed`。

注释明确写出「Step 2 之所以在后，是因为回填 UPDATE 必须跑在新触发器之后，否则旧触发器会驳回这条修复语句」。
这正是我第 3 轮点名要求验证的顺序。

### 4.2 替换而非叠加

```text
升级后 trigger 定义数 = 1                    ✅
新定义含 'disputed' ... 'redeemed' = true    ✅
升级前（0006）含该边 = false                 ✅（确认不是旧定义残留）
```

### 4.3 存量卡死行能被救回（真实旧库，不是隔离表）

构造方式：先建一个**只应用到 0006** 的迁移目录，用**真实应用代码**跑完整链路产生卡死行
（`opened → dismissed` 在 0006 下返回 500 且 grant 停在 `disputed`，这正是线上存量脏行的来源），
再用 SQL 补造另外三种形态，最后对**同一个数据库文件**执行真实 `migrate` 升到 0007：

```text
A  latest = dismissed        -> redeemed   ✅（存量卡死行被救回）
B  latest = opened           -> disputed   ✅（仍开着的争议不误伤）
C  dismissed 但不是最新       -> disputed   ✅（天真 EXISTS(dismissed) 写法会在这里出错）
D  无线程                    -> disputed   ✅
E  redeemed 对照             -> redeemed   ✅（普通已核销行未受影响）
```

**C 的构造说明（重要，供后续复核参考）**：`open_first` 触发器禁止第二条 `opened`，
因此"dismissed 之后又出现 opened"在真实数据里**不可达**。我用 `[opened, dismissed, reversed]`
构造"最新一条不是 dismissed"，并为此**临时移除该触发器**（事后恢复）。
0007 的回填用 `ORDER BY created_at DESC, rowid DESC LIMIT 1` 与 `selectOpenDisputeId` 的排序完全一致，
所以谓词在语义上与服务层对齐——这一点我用 C 验证了：**只看 `EXISTS(dismissed)` 的写法会把 C 误改成 redeemed，而 0007 没有。**

### 4.4 两条路径都能升，integrity_check 通过

```text
旧库（已应用 0006）升级后：
  integrity_check   = ok          ✅
  foreign_key_check = []          ✅
  trigger 定义数     = 1
全新库直接到 0007：
  integrity_check   = ok          ✅
  trigger 定义数     = 1
  已应用迁移数       = 8
```

### 4.5 迁移自带回滚说明

文件头部「Rollback」段写明：回填**不能自动反向**（原始 `disputed` 标记无法从 grant 行恢复，需查争议线程），
并给出 `DROP TRIGGER` + 重放 0006 定义的步骤。这是一个诚实的限制说明，不是缺陷。

## 5. 【新发现 · 非阻塞】部署顺序窗口期：代码先于迁移会 500

**结论：不是数据缺陷，但 PR 说明必须写明「先迁移，后生效」。**

t17 的服务代码会写 `status='redeemed'`（`disputed → redeemed`），但**如果数据库还停在 0006**，
旧触发器会拒绝这条 UPDATE。实测（隔离库停在 0006 + t17 应用代码）：

```text
dismissed -> 500 internal_error "Internal server error"
grant.status = disputed （未脏写，事务回滚）
```

**与 B1 的区别**：这里是 `SqliteError` 被 `mapRewardConstraint` 之外的路径漏出，返回标准 500 错误体
（**不是** B1 那种空 body、无 onError）。它只在「代码已部署、迁移尚未执行」的窗口期存在。

**风险评估**：本仓库的启动流程是 `createDatabase()` 内部先 `migrate()` 再返回 db
（`apps/api/src/db/client.ts:37-42`），即**迁移在应用可用之前完成**，正常部署顺序下窗口期为零。
所以这是**运维约束**而非代码缺陷。

**要求**：PR 说明写明「0007 必须先于 t17 代码生效；本仓库启动时自动迁移已保证此顺序，
若手工部署需先跑迁移」。

## 6. 【新发现 · 非阻塞】驳回是不可撤回的终态

见 §3.3 第二段的完整实测。要点：

- `dismissed` 后：重开 409、反转 409、再次驳回 400、撤销 409 —— **四条补救路径全部不可用**；
- 而「撤销授予」的提示语把用户指向「争议流程冲正」，该流程此时已关闭，形成**死循环式提示**；
- **根因是 0006 的 `open_first` 触发器（本卡早期设计），不是 t17 引入**；t17 只是把它从不崩的 500 变成可读的 409。

判为**需在 PR 说明披露的产品限制**，不要求本卡返工。建议后续卡评估是否允许驳回后重开。

## 7. 三项遗留裁定

### 7.1 `apps/admin/src/services/rewards.ts` 的 `redeemCredentialCode`：**删除**

一句话理由：0 消费者、doc comment「the same one-time redemption the field worker uses」与事实不符
（管理台版缺 `rewardRedeemRequestSchema.parse()`，比 `apps/web` 在用的版本更弱），留着只会误导下一个人。

> 复核确认：管理台该导出仍 **0 消费者**；`apps/web/src/services/rewards.ts:304` 的同名实现被
> `WorkbenchVerifyPage.tsx:40,209` 真实使用，两者不是同一个函数。

### 7.2 `checkinCountsForReward` / `checkin_not_verified`：**任务前提有误，两者结论不同**

**必须更正一处事实**：`checkin_not_verified` **不是「从不作为 HTTP code 发出」的零消费死符号**。
实测它在 `apps/web/src/components/activity/rewardLabels.ts:70` **有真实消费方**：

```ts
checkin_not_verified: '签到尚未现场核验，核验通过后才计入团队进度。',
```

它确实**不作为顶层 `error.code`** 出现——它是 409 里的 `reason`（`rewards/service.ts:1301`，
「已作废的签到不能核验」），理由文案由前端按下表映射。**这正是它存在的目的**，属正常设计。

- `checkin_not_verified`：**保留**。它是 409 的 `reason` 且有前端文案映射，删掉会让前端失去可读提示。
- `checkinCountsForReward`：**删除**。全仓零消费者（仅 `src` 定义 + `dist` 声明），
  且它的语义（签到是否计入奖励）在服务层已有等价实现，导出无收益。

### 7.3 R2 的 Finding E（创建路径错误不点名字段）：**附议，另开卡**

一句话理由：这属**错误消息质量**（`message="活动信息不正确"` 不点名字段），
不影响鉴权、一致性、库存与审计，与 B1/B2 不在同一严重度量级；塞进本卡会扩大 PR 范围并拖慢收卡。
建议另开卡统一治理「写路径校验错误的消息精度」，把创建与编辑两条路径一起对齐，而不是只补一处。

## 8. 本轮未做的事（边界声明）

- **未重跑 R2 的 91 项端到端验收**（任务明确定为范围外，由 R2 单独覆盖）。
- **未做浏览器验证**（B1/B2 均为服务端缺陷；本轮的 UI 相关结论——如按钮可见性——来自读码）。
- **未验证 0006 之前的更早历史库**升级（0007 只依赖 0006 的表与触发器，且 `dev` 上不存在 0006，
  故真实升级起点只能是 0006 或全新库，两者均已覆盖）。
- **变异测试只做了 B1**（B2 由 t17 自带的 4 条测试 + 本轮的迁移逐情形实测覆盖；
  B2 的变异成本高且风险大，未做）。
- 本轮**未改任何仓库代码、测试、迁移、契约**，唯一写入是本文件。
