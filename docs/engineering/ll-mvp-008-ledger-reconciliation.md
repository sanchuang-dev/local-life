# LL-MVP-008 · 统一经营流水、记账与对账契约、数据模型与迁移

> **2026-11-07 合流说明（现行实现）**：微信后台工程先合入 `dev`，其迁移为 `0010_many_whirlwind.sql`；本卡账本迁移已按 Drizzle 当前 schema 重新生成并顺延为 **`0011_ledger_facts.sql`**，保留原账本不可变约束触发器。真实 API 现已注册来源事实同步及对账路由；来源同步由运营人员显式通过 `POST /admin/ledger/sync`（CSRF + 社区权限）触发，不是自动实时同步。以下历史 R3a-1 段落中提到的 `0010_ledger_facts`、未注册端点、未开发 UI 等只对应当时的阶段基线，不能作为现行代码或部署验收结论。合并后发布/浏览器联合验收仍由 #65 单独处理。

> 对应 [Issue #64](https://github.com/sanchuang-dev/local-life/issues/64)。本文冻结共享契约、Drizzle 数据模型、四层事实口径、归属口径、追加式不可变语义、批次锁语义与权限边界，是后续实现卡的唯一真相源。**本文只描述 R3a-1（契约基座 + 迁移 0010 + schema + 只读路由骨架）已经落地的代码事实，不代表事实摄取、对账、导出、结算或生产环境已验收。**
>
> **基线声明**：文中所有「已注册 / 未实现 / 未接入」的判断，基准都是 R3a-1 交付时的代码（分支 `feat/ll-mvp-008-ledger`，`origin/dev@12c34b3` + 本卡 t1 改动）。同一 worktree 上并行落地的其它卡片会继续往 `apps/api/src/ledger/` 加服务与路由；届时以代码为准，本文负责冻结的是**口径与边界**，不是某个端点在某一天是否已存在。

## 1. 边界与定位

- 「统一经营流水」是**只记录事实**的账：它把既有三张事实表（`local_orders`、`crm_service_orders`、`activity_reward_grants`）与人工录入的事实，投影成一张追加式的 `ledger_entries`，再按批次做人工对账。它**不是**第二套订单系统，不拥有、不改写任何来源业务表。
- 数据来源只有既有事实表 + 人工录入：本地订单（#109）、已核验广电 CRM（#61）、奖励履约（#62）。契约在文件头就写死了这条边界（`packages/contracts/src/ledger.ts:3-30`）。
- **四层事实口径绝不合并**：订单登记金额、已核验有效业绩、人工收款与冲正、奖励成本与冲正是四种不同的钱。把它们压成一个「成交额」正是本卡要禁止的事情（`packages/contracts/src/ledger.ts:8-11`）。
- **没有结算规则就没有应付金额**：`settlementAmountStatus` 在无规则时只能是 `pending_rule`，禁止生成虚假应付 / 分账金额（`packages/contracts/src/ledger.ts:23-24`，`apps/api/src/ledger/shared.ts:41-43`）。
- **金额一律整数分**：所有 `*Cents` 字段都是整数，不接受浮点（`packages/contracts/src/ledger.ts:22`）。
- 明确不做：CRMEB 实时接入、在线支付、自动分账、自动佣金、第二套订单系统。
- 时间口径统一 `Asia/Shanghai`（UTC+08:00，无夏令时）。业务日 `YYYY-MM-DD` 的双端都是**闭区间**，服务端按 `[当日 00:00+08:00, 次日 00:00+08:00)` 的半开区间落库比较（`packages/contracts/src/ledger.ts:93-99`，`apps/api/src/ledger/shared.ts:71-114`）。
- 数据库只落在 `apps/api` 内；迁移 `0010` 只追加四张新表，不改 `0000`–`0009` 的任何表结构与数据。

## 2. 四层事实口径表

六个事实类型定义在 `ledgerFactKindSchema`（`packages/contracts/src/ledger.ts:111-118`），报表固定顺序在 `LEDGER_FACT_KINDS`（`:123-130`）。四层口径与六个类型的对应关系：

| 口径层 | `fact_kind` | 含义 | 金额语义 | 禁止的误用 |
| --- | --- | --- | --- | --- |
| ① 订单登记金额 | `order_registered` | 本地订单被登记这件事 | `local_orders.total_cents` 快照 | 不得称为「实收」「已付款」 |
| ② 已核验有效业绩 | `order_verified` | 运营人工核验过的事实 | 本地订单取 `total_cents`；CRM 订单取 **0** | 不得当成付款；CRM 不贡献金额 |
| ③ 实收与冲正 | `payment_received` / `payment_reversed` | 人工记录的真实收款，及其冲正 | 人工录入的正整数分 | 不得把冲正当负号静默抵消 |
| ④ 奖励成本与冲正 | `reward_cost` / `reward_reversed` | 奖励履约的实际成本，及其冲正 | `activity_reward_grants.total_cost_cents` | 不得当成营收或佣金 |

口径落到响应字段上（`ledgerOverviewSchema`，`packages/contracts/src/ledger.ts:433-537`）：

- `buckets` 必须**恰好**包含六个 `fact_kind`，且顺序与 `LEDGER_FACT_KINDS` 一致（`:464-474`）。缺桶、多桶、乱序都是 schema 校验失败，不是「渲染时兜底」。
- `totals.entryCount` / `totals.grossAmountCents` 必须等于六个桶之和（`:476-494`）——聚合层算错会当场被自己的契约拒绝。
- `payment.receivedCents` / `payment.reversedCents`、`reward.costCents` / `reward.reversedCents` 必须分别镜像对应桶（`:515-536`），**实收与冲正永远分列**，不存在一个「净实收」字段。
- `amountStatus` 是**聚合层**的结算状态，本 MVP 恒为 `pending_rule`（`:429-431`，实现见 `apps/api/src/ledger/shared.ts:380` 与 `emptyLedgerOverview` 的 `:248`）。
- 「待归属」是独立口径：`attributed` 与 `pendingAttribution` 的笔数与金额之和必须等于 `totals`（`:495-514`）。也就是说**没有归属的钱不会从报表里消失**，只会被单独列出来。

金额恒非负：`amount_cents >= 0` 由 CHECK 硬拦（`apps/api/src/db/schema.ts:1638`，迁移 `apps/api/db/migrations/0010_ledger_facts.sql:67`）。冲正是一条**独立的正数行**，靠 `counter_entry_id` 指回被冲正的那条，而不是把原行改成负数——这样「改过的数字」不可能悄悄从账上蒸发。

## 3. 来源映射表

来源系统枚举 `ledgerSourceSystemSchema`（`packages/contracts/src/ledger.ts:137-142`）与「哪种来源可以产出哪种事实」的映射 `LEDGER_FACT_KIND_SOURCES`（`:151-161`）在契约层冻结，并在数据库层用 CHECK 再拦一次（`ledger_entries_source_kind_check`，`apps/api/src/db/schema.ts:1611-1619` / 迁移 `:51-57`）。

| `fact_kind` | 允许的 `source_system` | 金额来源列 | 归属来源列 | 凭据语义 |
| --- | --- | --- | --- | --- |
| `order_registered` | `local_order` | `local_orders.total_cents` | `local_orders.attributed_staff_id`（可空） | 不移动钱，`evidence_kind = 'none'` 可接受 |
| `order_verified` | `local_order`、`crm_service_order` | 本地订单 `total_cents` / CRM **无金额列，恒 0** | `local_orders.attributed_staff_id` / `crm_service_orders.attributed_staff_id`（后者非空） | 语义上是 `order_verification` / `crm_confirmation`；**DB 未强制具体取值** |
| `payment_received` | `manual` | 人工录入 | 人工指定的归属事实 | **DB 强制**：`evidence_ref` 非空 + `recorded_by_staff_id` 非空 + `evidence_kind <> 'none'` |
| `payment_reversed` | `manual` | 人工录入（正数） | 同左 | 同上 |
| `reward_cost` | `activity_reward_grant` | `activity_reward_grants.total_cost_cents` | 来源表**没有** `attributed_staff_id` 列（只有 `team_id`）→ 只能 `pending` | 语义上是 `reward_grant`；**DB 未强制具体取值** |
| `reward_reversed` | `activity_reward_grant` | 人工录入（正数） | 同上 | 同上 |

「凭据语义」一列区分了两件事，必须说清：**只有 `payment_*` 的凭据要求是数据库硬约束**（`ledger_entries_payment_evidence_check`）。`order_verified` / `reward_cost` 的凭据种类目前只是契约注释里的意向，DB 只校验 `evidence_kind` 属于六种枚举值（`ledger_entries_evidence_kind_check`，`apps/api/src/db/schema.ts:1643-1647`）；真正强制它的是后续摄取的实现，本卡没有该代码。

关键事实（都在 DDL 与注释里可查）：

- `crm_service_orders` **没有任何金额列**（列清单见 `apps/api/src/db/schema.ts:488-536`），所以它只能贡献「笔数」与「归属」，永远不能作为金额来源。契约在 `packages/contracts/src/ledger.ts:15-18` 明确写了这一点。
- `local_orders.status = 'verified'` 是**人工事实核验**，不是付款（`apps/api/src/db/schema.ts:1347-1349` 注释与列清单 `:1350-1390`，其中确实没有 `paid` / `payment` 一类列）。
- `activity_reward_grants.total_cost_cents` 是唯一可直接 SUM 的成本列，且由 CHECK `total_cost_cents = quantity * unit_cost_cents` 保证（`apps/api/src/db/schema.ts:1036-1039`）。
- 「没有凭据不得计入实收」不只是服务层规则，是 DB CHECK：`payment_*` 行必须同时满足 `evidence_ref IS NOT NULL`、`recorded_by_staff_id IS NOT NULL`、`evidence_kind <> 'none'`（`ledger_entries_payment_evidence_check`，`apps/api/src/db/schema.ts:1649-1655` / 迁移 `:71-74`）。
- 幂等键独立成表：`(source_system, source_id, fact_kind)` UNIQUE（`ledger_entry_sources_dedupe_uq`，`apps/api/src/db/schema.ts:1690-1694` / 迁移 `:102`）。重复通知、重放导入、并发消费者最多撞到既有行，绝不产生第二条（也绝不产生第二次 SUM）。

脱敏约定（`evidence_ref` 这一列唯一的敏感信息通道）：

- `ledgerEvidenceSchema.ref` 是 `z.string().trim().min(1).max(200).nullable()`（`packages/contracts/src/ledger.ts:283-286`）：**脱敏引用文本**，不是文件、不是凭证原件。
- 只允许写「收据编号 / 转账流水号后四位 / 核验截图编号」这类可人工复核但不含原始敏感信息的引用；禁止存证件照片、银行卡号、广电账号密码或完整证件号（同 `docs/engineering/ll-mvp-005-crm.md:211` 的既有红线）。
- DB 只硬拦「非空 + 非 `none`」，长度与脱敏靠契约 zod 与服务层校验，不会由数据库自动裁掉敏感内容——写接口的实现者必须自己守住这条线。

> 上述映射是**契约与数据库层已冻结的规则**。把三张来源表真正写进 `ledger_entries` 的摄取服务属于后续卡，当前代码里没有该路径（见 §9）。

## 4. 归属口径

归属用 `ledgerAttributionSchema` 表达（`packages/contracts/src/ledger.ts:205-249`），落库为三列：`attributed_staff_id`、`attribution_state`、`attribution_basis`（`apps/api/src/db/schema.ts:1561-1566`）。

- `state = 'attributed'`（有明确归属）：必须带 `staff_id`，且 `basis ∈ {explicit_attribution, confirmed_fact}`。
- `state = 'pending'`（待归属）：**不得**带任何 `staff_id`，且 `basis ∈ {no_explicit_attribution, source_missing}`。
- 两组取值互斥由 zod `superRefine`（`:214-248`）与 DB CHECK `ledger_entries_attribution_check`（`apps/api/src/db/schema.ts:1629-1637` / 迁移 `:61-66`）双重保证。`LEDGER_ATTRIBUTED_BASES`（`:200-203`）是「算作有归属」的唯一白名单。
- **订单创建人 / 记录人不是业绩归属**。契约在 `:19-21` 写明：只有来源事实上显式存在的 `attributedStaffId`（或经确认的归属事实）才能产生 `attributed`，其余一律 `pending`。所以「订单是网格员代下的」永远不会自动变成「这一单算网格员的业绩」。
- 记录人与归属人在 schema 上是**两组不同的列**：`recorded_by_user_id` / `recorded_by_staff_id` 是「谁经手了这条事实」，`attributed_staff_id` 是「这条钱算谁的」。给 `payment_*` 行强制要求 `recorded_by_staff_id`，恰恰因为它必须能追到经手人（`:1576-1579` 注释与 `:1649-1655` CHECK），这与归属是两件事。
- 归属的 `communityId` 在 DTO 中直接取事实行的 `community_id`（`apps/api/src/ledger/shared.ts:189-194`）：一笔钱只能属于一个社区，社区本身是必填列（`apps/api/src/db/schema.ts:1554-1556`）。
- 列表按归属过滤时只匹配 `attributed_staff_id`，**从不匹配记录人**（`apps/api/src/ledger/shared.ts:298-301` 与 `packages/contracts/src/ledger.ts:597-598`）。
- 归属冲突（`attribution_conflict`）作为异常类型存在（`packages/contracts/src/ledger.ts:631-637`），但**不会**改写事实行：异常只是对事实的观察，事实本身不可变（见 §5）。

## 5. 不可变性与批次派生

`ledger_entries` 的行是事实，一旦写入就不可能 UPDATE / DELETE。这不是服务层自律，是迁移 `0010` 里手写的 SQLite 触发器（`apps/api/db/migrations/0010_ledger_facts.sql:164-235`，共 10 个）：

| 触发器 | 目标表 | 语义 |
| --- | --- | --- |
| `ledger_entries_no_update` / `ledger_entries_no_delete` | `ledger_entries` | 事实行完全不可修改、不可删除 |
| `ledger_entries_counter_entry_scope` | `ledger_entries` (INSERT) | 冲正必须指向**同社区、不同类型、真实存在**的正向行（`payment_reversed → payment_received`，`reward_reversed → reward_cost`） |
| `ledger_entry_sources_no_update` / `ledger_entry_sources_no_delete` | `ledger_entry_sources` | 幂等键永不改变，重放只能撞到既有行 |
| `ledger_anomalies_no_delete` | `ledger_anomalies` | 异常是历史，可被标记解决（UPDATE），不可删除 |
| `reconciliation_batches_identity_immutable` | `reconciliation_batches` | `id` / `batch_no` / `period_from` / `period_to` / `created_at` 建批时冻结 |
| `reconciliation_batches_status_transition` | `reconciliation_batches` | 只允许 `open → locked`，其它任何状态变更都 ABORT |
| `reconciliation_batches_locked_immutable` | `reconciliation_batches` | 已锁定批次整行不可再改 |
| `reconciliation_batches_no_delete` | `reconciliation_batches` | 批次是追加式历史，不可删除 |

这套触发器的直接后果，也是本卡最重要的一条设计结论（写在迁移注释 `:146-162` 里）：

> 因为事实行不可 UPDATE，**对账成员关系不可能靠事后给 `batch_id` 打戳来建立**；成员关系只能由批次期间（`period_from`..`period_to`）+ 社区范围**派生**。

而读侧 DTO 目前是按 `batch_id` + 批次状态推导 `reconciliationState`（`apps/api/src/ledger/shared.ts:162-176`）：

- `batch_id` 为 `NULL`（或批次不存在）→ `unreconciled`
- 所属批次 `status = 'open'` → `batched`
- 所属批次 `status = 'locked'` → `reconciled`

契约对这两者的关系也做了硬校验：`batch_id` 非空 **当且仅当** `reconciliationState !== 'unreconciled'`（`packages/contracts/src/ledger.ts:401-407`）。也就是说「有批次号却说自己没入批」或「没批次号却说自己已对账」都会被自身契约拒绝。

**当前的真实状态（不得夸大的部分）**：没有任何写入路径会把事实加入批次，也没有任何查询按期间派生成员关系。因此今天所有真实数据的 `batch_id` 都是 `NULL`、`reconciliationState` 都是 `unreconciled`。批次卡必须在「插入时即带 `batch_id`」与「按期间派生成员」之间**择一实现并补齐读侧**，二者不能同时假装成立（见 §9 限制 L1）。

## 6. 批次锁语义

`reconciliation_batches` 是全局期次对账批次（13 列，`apps/api/src/db/schema.ts:1470-1523` / 迁移 `:104-137`）。锁定语义由四层共同保证：

1. **一个期间最多一个 `open` 批次**：部分唯一索引 `reconciliation_batches_open_period_uq ON (period_from, period_to) WHERE status = 'open'`（`apps/api/src/db/schema.ts:1496-1498` / 迁移 `:135`）。已锁定的批次被排除在索引之外，所以历史仍可读、同一期间仍能再开新批次。
2. **单行道状态机**：`reconciliation_batches_status_transition` 只放行 `open → locked`（迁移 `:217-222`），配 `reconciliation_batches_status_check` CHECK（`apps/api/src/db/schema.ts:1501`）。
3. **锁定时一并冻结金额与笔数**：`entry_count` / `total_cents` 由锁定的同一条语句写入，之后 `reconciliation_batches_locked_immutable` 让整行不可再改（迁移 `:225-230`）。`reconciliation_batches_lock_check` 保证 `locked` 行必须有 `locked_at` + `locked_by_user_id`，而 `open` 行必须三者皆空（`apps/api/src/db/schema.ts:1512-1521`）；DTO 层 `reconciliationBatchSchema.superRefine` 做同一件事（`packages/contracts/src/ledger.ts:699-724`），所以 RPC 也无法返回一个「半锁定」的批次。
4. **期间与编号格式**：`batch_no` 唯一（`reconciliation_batches_no_uq`）；`period_from` / `period_to` 必须匹配 `YYYY-MM-DD` 且 `to >= from`（`reconciliation_batches_period_check`，GLOB 校验）；`entry_count >= 0 AND total_cents >= 0`（`reconciliation_batches_counts_check`）。

**`total_cents` 是批次的「记录金额合计」，不是应付金额**（`packages/contracts/src/ledger.ts:675-681` 与 `apps/api/src/db/schema.ts:1462-1468` 注释）。因为没有结算规则，一个批次永远不能产出分账数字。

并发语义要说清楚，不能吹成分布式锁：

- 应用层写事务统一用 Drizzle 的 `{ behavior: 'immediate' }`（`BEGIN IMMEDIATE`），在第一次读之前就拿到 SQLite 写锁。同仓既有实现见 `apps/api/src/participation/service.ts:461-511`（`confirmParticipation`）与 `apps/api/src/rewards/service.ts:1174`。
- 注意：**R3a-1 交付时 ledger 没有任何写事务**（只读骨架，见 §9），本卡不预置写事务模板；批次/记账卡落地时必须沿用上面这套 `immediate` 约定，而不是另发明一把锁。核对方式：`grep "behavior: 'immediate'" apps/api/src/ledger`。
- 连接级 PRAGMA 为 `foreign_keys = ON`、`journal_mode = WAL`、`busy_timeout = 5000`（`apps/api/src/db/client.ts:22-26`）。
- 所以这是**单机单文件上的单写者语义**：多进程抢同一文件靠写锁 + `busy_timeout` 排队，`busy_timeout` 到点就报错而不是伪装成功。它不是分布式锁，也**未覆盖**多主机、超过 5s 的长锁、断电/强制 kill 后的 WAL 恢复（与 `docs/engineering/evidence/ll-mvp-010/verification-api.md` 已披露的边界一致）。

## 7. 迁移记录

| 项 | 值 |
| --- | --- |
| 文件 | `apps/api/db/migrations/0010_ledger_facts.sql`（235 行） |
| journal 位置 | `apps/api/db/migrations/meta/_journal.json` 第 11 条，`idx = 10`，`tag = "0010_ledger_facts"` |
| 快照 | `apps/api/db/migrations/meta/0010_snapshot.json` |
| 基线 | 分支 `feat/ll-mvp-008-ledger`，起点 `origin/dev@12c34b3`（含 `0009_local_catalog_orders`） |
| 新增表 | 4：`ledger_entries`（21 列）、`ledger_entry_sources`（6 列）、`ledger_anomalies`（8 列）、`reconciliation_batches`（13 列） |
| 新增索引 | 14 个（3 个唯一，其中 `reconciliation_batches_open_period_uq` 为部分索引） |
| 新增 CHECK | 20 个（`ledger_entries` 12、`reconciliation_batches` 4、`ledger_anomalies` 2、`ledger_entry_sources` 2） |
| 新增外键 | 12 个（`ledger_entries` 7、`ledger_anomalies` 2、`reconciliation_batches` 2、`ledger_entry_sources` 1） |
| 新增触发器 | 10 个（见 §5 表格） |
| 表结构来源 | 第 1–137 行由 `drizzle-kit generate` 依据 `apps/api/src/db/schema.ts` 生成 |
| 手写部分 | 第 138–235 行：注释块 + 10 个触发器。触发器全部使用稳定对象名，因此后续 `drizzle-kit generate` 仍为 no-op，测试也能按名字断言 |

外键删除策略（决定了「历史事实能否被删」）：

- `ledger_entries.community_id → communities`、`product_id → local_products`、`batch_id → reconciliation_batches`、`counter_entry_id → ledger_entries`、以及 `ledger_entry_sources.entry_id` / `ledger_anomalies.entry_id → ledger_entries` 全部 `ON DELETE RESTRICT`：被账引用的事实不可删。
- `recorded_by_user_id` / `recorded_by_staff_id` / `attributed_staff_id` / `locked_by_user_id` / `locked_by_staff_id` 声明为 `ON DELETE SET NULL`，意图是「账号可停用/清理，但事实行本身保留」。

**实测结论（与本卡设计意图有一处必须说清的偏差）**：`SET NULL` 在事实行上实际**不会发生**。SQLite 实现外键动作的方式是对子行做一次 UPDATE，而 `ledger_entries_no_update` / `reconciliation_batches_locked_immutable` 会把这句内部 UPDATE 一起 ABORT：

| 操作 | 实测结果 |
| --- | --- |
| 删除被 `ledger_entries.recorded_by_user_id` / `recorded_by_staff_id` / `attributed_staff_id` 引用的账号 | `SQLITE_CONSTRAINT_TRIGGER: ledger_entries rows are immutable` |
| 删除被**已锁定**批次的 `locked_by_user_id` / `locked_by_staff_id` 引用的账号 | `SQLITE_CONSTRAINT_TRIGGER: reconciliation_batches rows are immutable once locked` |
| 删除**未被任何流水/批次引用**的员工账号 | 成功（没有子行需要 UPDATE） |
| 删除被 `community_id` 引用的社区 | `FOREIGN KEY constraint failed`（RESTRICT） |
| `UPDATE ledger_entries SET amount_cents = 9999` | `ledger_entries rows are immutable` |
| `DELETE FROM ledger_entries` | `ledger_entries rows are immutable` |
| 把已锁批次改回 `open`、或改 `batch_no` | `reconciliation_batches rows are immutable once locked` |

也就是说：**被账引用过的活跃账号实际上删不掉**，这与「归属被删必须显式处理，不能静默降级」的效果一致，但机制是触发器而不是 `SET NULL` + `attribution_check`。停用员工应走 `staff_accounts.status = 'disabled'`（`apps/api/src/db/schema.ts:87`），而不是删除行。这是本卡实测发现、后续卡不得假设「删账号会自动把归属置空」的事实。

已执行并跟过的命令（2026-11-07，worktree `feat/ll-mvp-008-ledger`）：

```bash
pnpm --filter @sanchuang-dev/local-life-contracts build      # 通过
pnpm --filter @sanchuang-dev/local-life-api typecheck        # 通过（src + test 两套 tsconfig）
pnpm --filter @sanchuang-dev/local-life-api db:generate      # t1 首次生成 0010 增量与 meta/0010_snapshot.json
pnpm --filter @sanchuang-dev/local-life-api db:generate      # 复跑：`No schema changes, nothing to migrate`（schema 与 0010 快照一致）
node --import tsx --test test/local-catalog-orders.test.ts   # 17/17 通过
```

上面的外键与不可变表格里每一行都是**实测**，不是读代码推断：用一个临时 `tsx` 脚本对 `:memory:` 库跑完整迁移目录（`createDatabase(':memory:', './db/migrations')`），用裸 SQL 做违规写入并记录真实报错文本，脚本验证后已删除。这样得到的结论与「只看 DDL 猜」有两处不同（`SET NULL` 实际被触发器拦成 ABORT；只有 `community_id` 这类 RESTRICT 才走外键报错），本文按实测写。

升级验证（已有测试，`apps/api/test/local-catalog-orders.test.ts:1425-1551`，用例名「a pre-0010 database upgrades in place, keeps its rows and becomes usable」）：

- 先断言 `_journal.json` 恰好 11 条，再只 staging `0000`–`0009` 建一个**升级前**数据库：确认已有 3 张 `local_*` 表、0 张 `ledger_*` 表、无 `reconciliation_batches`。
- 写入社区与用户数据后关闭连接，再用完整迁移目录重新打开：既有行保留、3 张 `local_*` 表未被触碰、4 张新表全部出现。
- 升级后的库立刻可用：真实 Hono app 走完「建社区员工 → 上架商品 → 居民登记订单」，然后 `GET /admin/ledger/overview` 返回 200 且能被 `ledgerOverviewSchema.parse` 解析，`totals.entryCount = 0`、`amountStatus = 'pending_rule'`。

全量测试的既有缺陷（**不是本卡引入**，如实记录）：`pnpm --dir apps/api test` 存在 8 个 `EBUSY` / `EPERM: resource busy or locked, unlink '...world.sqlite'` 失败，分布在 `test/rewards-version-edit.test.ts`（7）与 `test/activities-reward-plan-frozen.test.ts`（1）。把工作区 `git stash -u` 回退到基线后**同样复现**同样的 8 个失败（两边都是 240 项 = 232 通过 / 8 失败），因此是 Windows 上既有临时目录清理缺陷，与本卡改动无关。

## 8. 权限矩阵

路由常量集中在 `LEDGER_ROUTES`（`packages/contracts/src/ledger.ts:72-91`）。**R3a-1 交付时只注册了 7 个 GET 路由**，全部是只读骨架（`apps/api/src/ledger/routes.ts:181-233`）；`adminBatchDetail` / `adminBatchLock` 两个常量已冻结但未注册，写接口故意不存在（`apps/api/src/ledger/routes.ts:235-237`：未实现的写必须 404，绝不假装成功）。下表的「能力」一列描述的是**本卡交付时的真实可达性**，不是终态设计。

> 权限口径本身（谁能看哪些社区、`grid_worker` 在 `/admin/*` 上必须 403、未登录必须 401）是**冻结的**，后续卡新增端点必须照此实现；「未注册 → 404」只是 R3a-1 的临时事实，不是永久约定。

| 能力 | admin | operator | grid_worker |
| --- | --- | --- | --- |
| `GET /staff/ledger/overview` | ✅ 全社区 | ✅ 分配社区 | ✅ 分配社区 |
| `GET /staff/ledger/entries` | ✅ 全社区 | ✅ 分配社区 | ✅ 分配社区 |
| `GET /staff/ledger/anomalies` | ✅ 全社区 | ✅ 分配社区 | ✅ 分配社区 |
| `GET /admin/ledger/overview` | ✅ 全社区 | ✅ 分配社区 | ❌ 403 |
| `GET /admin/ledger/entries` | ✅ 全社区 | ✅ 分配社区 | ❌ 403 |
| `GET /admin/ledger/anomalies` | ✅ 全社区 | ✅ 分配社区 | ❌ 403 |
| `GET /admin/reconciliation/batches` | ✅ | ✅ | ❌ 403 |
| `GET /admin/reconciliation/batches/:batchId` | ❌ 未注册 → 404 | ❌ 404 | ❌ 404 |
| `POST /admin/reconciliation/batches`（建批） | ❌ 未注册 → 404 | ❌ 404 | ❌ 404 |
| `POST /admin/reconciliation/batches/:batchId/lock`（锁定） | ❌ 未注册 → 404 | ❌ 404 | ❌ 404 |

判定规则与实现位置：

- 未登录 / 无 staff 身份 → `401 unauthorized`（`apps/api/src/ledger/routes.ts:78-84`）。所有权限在服务端依据 `staff_accounts` + `staff_community_assignments` 判定，**前端隐藏按钮不算授权**。
- `admin` 不受社区限制（`scopeCommunityIds` 返回 `null`，`apps/api/src/local/shared.ts:91-98`）；`operator` / `grid_worker` 只能读被分配社区（`apps/api/src/ledger/shared.ts:124-130` 复用 `applyCommunityScope`）。
- `/admin/*` 拒绝 `grid_worker`（403，`apps/api/src/ledger/routes.ts:86-98`），与 `/admin/local-orders` 的既有约定一致。存在 `/staff/ledger/*` 的唯一理由就是网格员需要看自己社区的流水（`packages/contracts/src/ledger.ts:66-71`）。
- 调用者一个社区都没有时不报错、不泄露，直接返回**结构完整的空报表**（`apps/api/src/ledger/shared.ts:239-263, 320, 444-446, 482`）。
- 跨社区 `communityId` 显式传参 → `403`，**不是**静默返回空页（`assertCommunityAccess`，`apps/api/src/ledger/shared.ts:291-297`）。overview 与 entries 的查询对象都是 `strictObject`，未知/不支持的参数一律 `400`（`packages/contracts/src/ledger.ts:553-577, 590-608`；路由 `apps/api/src/ledger/routes.ts:129-132, 155-159, 196-199`）。两个 anomalies 端点**没有**查询参数约定（只返回未解决异常，上限 200 条），因此多余参数不会被解析，也不会被当成筛选条件。
- 所有响应在 `c.json` 之前先 `schema.safeParse`；失败是抛出内部错误而不是返回半个形状（`apps/api/src/ledger/routes.ts:114-121`）。
- 对账期次是全局的（一个运营主体一份对账单），因此批次列表**不做社区裁剪**，只做后台侧鉴权（`apps/api/src/ledger/routes.ts:221-233` 注释，`apps/api/src/ledger/shared.ts:517-548`）。
- 会话、CSRF double-submit + 可信 Origin、错误 envelope 全部来自 `createApp`，本模块不实现第二套鉴权（`apps/api/src/ledger/routes.ts:63-64`；注册点 `apps/api/src/app.ts:992-1001`）。
- 新增错误码 5 个，全部是**拒绝语义**（`packages/contracts/src/index.ts:85-89`）：`ledger_batch_locked`、`ledger_entry_immutable`、`ledger_payment_evidence_required`、`ledger_attribution_unresolved`、`ledger_source_duplicate`。

## 9. 明确未实现清单与已知限制

### 9.1 明确的未实现清单（本文不声称可用）

以下每一条都以 R3a-1 的代码为基准（`git show`/`grep` 可核对）。后续卡落地其中任一项后，应更新本节并在同一 PR 内补上对应验证证据，而不是让「未实现」这个状态继续留在文档里：

- **事实摄取**：把 `local_orders` / `crm_service_orders` / `activity_reward_grants` 写成 `ledger_entries` 的服务在 R3a-1 里一行都没有（`apps/api/src/ledger/` 只有 `routes.ts` 与 `shared.ts`，两者都是只读）。
- **人工记账写接口**：`payment_received` / `payment_reversed` / `reward_reversed` 的录入与冲正接口不存在；契约、CHECK 与错误码已就位，路由未注册。
- **归属确认接口**：把 `pending`（待归属）改成 `attributed` 的接口不存在——而且它不可能通过 UPDATE 实现（事实行不可变），必须走「新增一条带明确归属的事实」或由批次卡另行设计，本卡不做假设。
- **异常接口**：`POST` 标记异常、`PATCH` 解决异常都不存在；`GET /admin/ledger/anomalies` 只能读，且只返回未解决的（`resolvedAt IS NULL`），上限 200 条（`apps/api/src/ledger/shared.ts:474-515`）。
- **批次接口**：建批、锁定、批次详情三个端点全部未注册（404）。批次列表上限 100 条（`apps/api/src/ledger/shared.ts:527`）。
- **CSV 导出**：不存在。中文 Excel 可读、脱敏的导出属于后续卡。
- **管理台页面**：业绩看板、对账结算页、导航入口、CSV 下载通道都还没有；本卡只交付 API 与契约。
- **结算 / 佣金 / 分账计算**：不存在，也不会存在——`settlementAmountStatus` 恒为 `pending_rule`，没有任何「应付金额」字段。
- **CRMEB 实时接入、在线支付、自动分账、第二套订单系统**：明确不做。

### 9.2 已知限制与必须在后续卡解决的点

- **L1（批次成员关系语义未闭合）**：迁移注释（`0010_ledger_facts.sql:146-162`）声明成员关系由批次期间**派生**，而读侧 DTO（`apps/api/src/ledger/shared.ts:162-176`）按 `batch_id` **推导**。因为事实行不可更新、且当前无任何写入路径，二者尚未冲突（所有真实行 `batch_id = NULL`，`reconciliationState = 'unreconciled'`）。批次卡必须择一实现并统一读侧，否则会出现「批次统计了 100 笔、流水列表却全显示未对账」的自相矛盾。
- **L2（锁后补录会与已锁期间重叠）**：事实行不可变 + 期间派生意味着，在批次锁定之后补录的同期间事实不可能被补进已锁批次，却可能与已锁期间重叠。这不是 bug，而是「锁定即冻结」的必然后果；对账卡必须**显式**决定这类事实如何呈现（拒绝补录 / 归入下一期 / 标记异常），不能让它们静默出现在报表里。
- **L3（并发只覆盖单机单文件）**：`BEGIN IMMEDIATE` + 部分唯一索引 + 触发器保证同一期间不会出现两个 `open` 批次，但这依赖单写者 SQLite 部署。多主机并发、超过 `busy_timeout = 5000ms` 的长锁、断电/`kill -9` 后的 WAL 恢复都**未验证**。
- **L4（时间精度）**：业务日边界按 `Asia/Shanghai` 固定 `+08:00` 换算（中国无夏令时，`packages/contracts/src/ledger.ts:93-99`），不查时区库。跨时区或未来若出现夏令时地区，这个假设必须重审。
- **L5（列表排序固定）**：流水按 `occurredAt DESC, createdAt DESC, id DESC` 固定排序（`apps/api/src/ledger/shared.ts:460`），**没有 `sort` 参数**；可配置排序留待后续卡。分页 `pageSize` 上限 100，默认 20（`packages/contracts/src/ledger.ts:555-556`）。
- **L6（报表只覆盖已写入的事实）**：`asOf` 是计算瞬间（`packages/contracts/src/ledger.ts:435-436`），不是页面时间戳；在摄取服务落地之前，报表恒为空报表，这会被误读成「没有流水」，因此任何界面都必须同时显示「事实摄取未实现」的真实状态。
- **L7（全量测试的既有 EBUSY 失败）**：见 §7 末段，属于 Windows 临时目录清理缺陷，非本卡引入，但会让 `pnpm test` 在本地不是全绿，验收时必须区分。

## 10. 给后续实现卡的契约要点

1. 只从 `@sanchuang-dev/local-life-contracts` 导入枚举、路由常量与 DTO；不要在 `apps/api` 里复制字符串数组或重写 schema（`packages/contracts/src/ledger.ts` 是唯一真相源，`packages/contracts/src/index.ts:1782` 已 `export * from './ledger.js'`）。
2. 写事实必须走「插入 + `ledger_entry_sources` 去重」两件套：`(source_system, source_id, fact_kind)` 撞唯一键时应当映射为 `ledger_source_duplicate`，而不是把异常包装成 500（错误码已冻结，`packages/contracts/src/index.ts:85-89`）。
3. 不要试图 UPDATE `ledger_entries`：DB 会 ABORT。修正只能新增一条 `*_reversed` 事实并填 `counter_entry_id`；归属变更同理，只能新增带明确归属的事实。
4. 写事务用 `{ behavior: 'immediate' }`，与 `apps/api/src/participation/service.ts:461-511` 一致；不要把 `busy_timeout` 的错误吞成成功。
5. 批次相关写入必须先解决 §9.2 的 L1/L2（成员关系派生 vs `batch_id` 打戳、锁后补录如何呈现），再动读侧 DTO；`reconciliationState` 的推导逻辑目前只有一处（`apps/api/src/ledger/shared.ts:162-176`），改的时候必须同步契约里的 `superRefine`（`packages/contracts/src/ledger.ts:401-407`）。
6. 概览与列表必须共用同一套 scope/filter 条件（`scopeAndFilterConditions`，`apps/api/src/ledger/shared.ts:276-303`）。若给列表新增筛选项而概览不接受，同一屏的 KPI 与明细就会互相矛盾——这正是 `ledgerOverviewQuerySchema` 被设计成 `strictObject` 的原因。
7. 每个响应都要在 `c.json` 之前 `schema.parse`（照抄 `apps/api/src/ledger/routes.ts:114-121` 的 `respond()`）；不要为了「多返回一点」破坏 `strictObject`。
8. **不得**在任何界面把 `order_registered` 渲染成「实收」、把 `order_verified` 渲染成「已付款」、把 `pending_rule` 渲染成数字、或把 `total_cents` 渲染成「应付/分账」。没有结算规则就没有应付金额。
9. 新增任何带敏感信息的字段（凭据原文、证件号、银行卡）之前先读 §3 的脱敏约定：`evidence_ref` 最长 200 字符且只是脱敏引用文本，不保存图片/PDF、不保存完整账号。
