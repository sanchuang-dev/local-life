# 支付领域契约、持久化、居民创建/查询、可信确认与隔离 Mock（PAY-01 #276 / PAY-02 #277 / PAY-03 #278 / PAY-04 #279 / PAY-05 #280 / PAY-07）

> **PAY-01** 建立支付意图、尝试与事件的共享契约和 SQLite 真相源；**PAY-02** 增加居民创建/查询待支付意图的受控 API；**PAY-03** 增加可信渠道证据确认、状态收敛、下游 outbox 与冲突证据队列；**PAY-04** 增加进程内隔离 Mock 驱动，**PAY-05** 完成订单/零元券单 outbox 投影，**PAY-06** 将 `local_order_online_completions` 投影为独立线上实收、接入消费累计与既有发券；**PAY-07** 增加居民 H5 支付状态、零元兑换与居民自有 Mock 演练入口；**PAY-08** 扩展现有管理端本地订单列表/详情，提供只读支付流水、完成事实、线上实收与异常展示。当前仍**没有**真实微信支付商户配置/回调验签（PAY-10/PAY-11）、未鉴权公网 Mock 控制接口、支付对账差异与导出（PAY-09）、真实退款执行。不得据此宣称真实微信在线支付已可用。

## 1. 与既有事实的边界

| 事实 | 现有来源 | 本卡是否改变 |
| --- | --- | --- |
| 居民登记办理意向 | `local_orders`（LL-MVP-010） | 不改；支付单只引用它 |
| 人工业务核验 | `local_orders.status='verified'` / `verifiedAt` | 不改，也不等同于付款 |
| 人工实收凭据 | `ledger_entries.payment_received` | 不改，不与渠道支付混写 |
| 微信/渠道支付成功 | PAY-01 支付意图 `status='paid'`（PAY-03 写入） | 新事实，不等于银行到账或结算 |
| Mock 支付 | `channel='mock'`, `simulated=1` | 永久标记模拟；不能流入正式资金/业绩 |
| 零元券单 | `kind='zero_amount'` | 独立非渠道完成类型，不伪造微信交易；PAY-05 负责后续原子完成 |
| 退款 | 本卡不建表、不开放动作 | 未来独立退款记录引用支付意图，不改支付状态历史 |

支付状态只有 `pending / confirming / paid / closed / failed`。退款、银行到账、订单履约和结算都不是支付状态。PAY-03 只写支付意图证据与状态，不写 `local_orders`、优惠券核销或 `ledger_entries`。

## 2. 表与约束

### `payment_intents`

- 引用本地订单但**不重造订单**：`local_order_id`、`resident_user_id`、`community_id` 通过**复合外键**同时指向 `local_orders(id, resident_user_id, community_id)`，防止用 A 订单搭配 B 居民或 B 社区。
- 金额快照：`gross_amount_cents`、`discount_cents`、`net_payable_cents` 必须是非负安全整数（SQLite `typeof = 'integer'`、上限 `9007199254740991`）且满足 `gross - discount = net`。
- 插入触发器再次校验金额与订单快照完全一致，不能只靠 DTO。
- `merchant_order_no`、`idempotency_key` 全局唯一。
- 部分唯一索引 `payment_intents_one_paid_per_order_uq`：同一业务订单最多一条 `paid` 支付意图。
- 身份与金额列由触发器冻结；状态只允许：
  - `pending → confirming | paid | closed | failed`
  - `confirming → paid | closed | failed`
  - `paid / closed / failed` 为终态，禁止回退。
- `kind='channel'` 必须有 mock/wechat_jsapi 渠道、净应付 > 0，且 mock 必须 `simulated=1`、wechat 必须 `simulated=0`。
- `kind='zero_amount'` 必须无渠道、非模拟、净应付 0、状态为 `paid` 且有 `paid_at`。
- `paid/closed/failed` 必须各自有 `paid_at/closed_at/failed_at`，其余终态时间列必须为空；非 failed 状态禁止失败原因。共享 Zod 校验与 SQLite CHECK 保持同一双向约束。

### `payment_attempts`

- 一个支付意图可多次合法尝试；`(payment_intent_id, attempt_no)`、`idempotency_key` 唯一。
- `provider_transaction_id` 可空但全局唯一。
- 每个意图最多一条 paid attempt（部分唯一索引）。
- paid attempt 必须有 `confirmed_at` 和 `provider_transaction_id`；paid 后渠道交易号/确认时间冻结。
- 状态转换与支付意图相同，终态不可回退；尝试身份列不可变。

### `payment_events`

- 追加式事件：UPDATE/DELETE 由 SQLite 触发器拒绝。
- `dedupe_key` 唯一，用于通知/查单去重。
- `(payment_attempt_id, payment_intent_id)` 复合外键防止事件把 A 意图的 attempt 挂到 B 意图。
- 事件类型限定为创建、尝试创建、状态变更、渠道通知、渠道查单；渠道事件来源必须显式标记。

### `payment_outbox` / `payment_review_exceptions`

- `payment_outbox` 每个 `payment_event_id` 和 `dedupe_key` 唯一；`payment.paid.v1` 仅在支付意图首次进入 `paid` 的同一事务内写入。
- `payment_review_exceptions` 以 `dedupe_key` 唯一保存冲突/迟到/未知渠道证据，不修改已终态支付意图。
- 两张表均拒绝 DELETE，且 outbox 的身份/payload、异常表的原始证据字段不可 UPDATE；outbox 仅允许消费状态/重试字段更新，异常表仅允许 `status/resolved_at` 处理字段更新。异常表不可变地保存商户订单号、渠道、渠道交易号、金额、商户 AppID/商户号、观察时间、来源、去重键、渠道事件引用、失败码/失败信息与错误类型。

## 3. PAY-02 实现约定（已落地）

PAY-02 依赖本卡：

- 用 `createPaymentIntentRequestSchema` 接收 `localOrderId + channel + idempotencyKey`；居民、社区、金额、商户单号、商户上下文由服务端从订单/渠道配置派生，不能由客户端提交。
- 创建支付意图前先读本地订单快照，写入的 gross/discount/net 必须与数据库订单一致，否则触发器拒绝。
- 用 `paymentIntentSchema` / `paymentAttemptSchema` / `paymentEventSchema` 作为响应 DTO，不要在路由层复制字段。
- **PAY-02 只允许居民创建/读取支付单，不开放支付状态修改路由。** PAY-03 的内部可信确认独占 `paid` 写入；客户端 JS 回调或手工请求不能声明成功。
- 渠道交易号写入 attempt，重复回调/查单依赖 `payment_attempts_provider_txn_uq`、`payment_events_dedupe_uq` 与 `payment_intents_one_paid_per_order_uq`。

未来退款卡应新增独立表引用 `payment_intents.id`，不得把 `paid` 改成 `refunded`，也不得改写历史事件。

## 4. PAY-03 可信确认与持久化（已落地）

### 入口与信任边界

| 入口 | 用途 | 鉴权 |
| --- | --- | --- |
| `confirmTrustedPayment(db, evidence, { now? })` | PAY-11 适配器/服务端内部调用 | 进程内可信调用方 |
| `POST /internal/payments/confirm` | 集成测试与 PAY-11 隔离适配器 | `Authorization: Bearer <PAYMENT_INTERNAL_TOKEN>` |
| `POST /payments/intents` / `GET /payments/intents/:id` | 居民创建/读取待支付意图 | 居民会话 + CSRF/Origin（PAY-02） |

- 内部确认路由**不接受**居民会话、Cookie、CSRF token 或客户端回调作为支付成功凭据；缺少 `PAYMENT_INTERNAL_TOKEN` 时返回 `503 payment_internal_not_configured`，token 错误返回 `401 payment_internal_unauthorized`。
- `confirmTrustedPayment` 只接收**已归一化**的证据。渠道签名、证书、微信支付 API v3 解密与查单真实性由 PAY-11 适配器完成；PAY-03 不自行声明“已验签”。
- 证据必须携带：商户订单号、渠道、渠道结果、渠道交易号（paid 必填）、金额分、币种、商户 AppID/商户号、观察时间、来源（notification/query）与去重键。
- 服务端按 `merchant_order_no` 查找既有支付意图，绝不创建第二张支付单；校验 `kind='channel'`、渠道一致、商户上下文一致、金额等于冻结的净应付、币种为 `CNY`，并重新读取本地订单确认居民/社区归属。
- `wechat_jsapi` 证据必须携带真实 `merchantAppId` 与 `merchantId`；共享契约拒绝 null/空值，服务层同时拒绝持久化意图缺少商户身份。Mock 渠道才允许两者为 null，且不能把双重 null 当作“商户匹配”。
- 每个 provider `dedupe_key` 都绑定规范化证据的 SHA-256 指纹；只有指纹完全一致才算同一事件重放。已拒绝的 key 永久不能再声明成功；已接受 key 携带不同证据时拒绝并另存冲突快照，不覆盖原成功事实。
- 金额、商户订单号、商户号、渠道、币种或归属不一致时，不写 `paid`，保存完整异常证据并返回通用冲突错误；不向调用方泄露内部字段。

### 状态与幂等收敛

- **paid**：仅允许 `pending/confirming → paid`。同一 `BEGIN IMMEDIATE` 事务内更新支付意图、写入/更新 paid attempt、追加渠道事件、写入 `payment.paid.v1` outbox。重复提交同一证据返回 `already_confirmed`；通知与查单使用不同去重键但同一渠道交易号时也只产生一条 paid attempt/outbox。
- **pending**：允许 `pending → confirming` 或保持 `confirming`；写入/更新 confirming attempt 与渠道事件，不产生 outbox。
- **failed/closed**：允许 `pending/confirming → failed|closed`；写入终态 attempt、事件与时间戳，不产生 outbox。
- **迟到成功**：支付意图已 `closed`/`failed` 后又收到 paid 证据时，**不回退状态、不写 paid attempt/outbox**，只把渠道证据保存为 `late_success_after_closed` / `late_success_after_failed`。
- **终态冲突**：已 `paid` 后收到 failed/closed，或已终态 attempt 被要求回退，保存 `terminal_conflict` 并拒绝。
- **渠道交易号复用**：同一 `provider_transaction_id` 已属于另一支付意图时保存 `transaction_conflict`，不确认第二张单。
- 重复事件键只有在规范化证据指纹完全一致时才返回原结果；同 key 的不同证据（包括跨支付意图、交易号、金额或商户上下文变化）保存 `transaction_conflict` 快照并拒绝。
- 所有状态写入仍由 SQLite 状态触发器兜底；服务层与数据库两层校验一致。

### Outbox 与下游

- `payment.paid.v1` payload 固定包含 `paymentIntentId`、`localOrderId`、`residentUserId`、`communityId`、`amountCents`、`providerTransactionId`、`simulated`、`paidAt`。
- outbox 行在 paid 事务内以 `dedupe_key = payment.paid:<paymentIntentId>` 写入 `pending`；重复确认不会新增第二行。
- PAY-03 **不消费** outbox，也不完成订单、核销优惠券或投影账本；PAY-05/PAY-06 负责按 payload 消费，并必须用稳定去重键保证重复执行不重复产生业务事实。
- outbox 与异常表持久化，进程重启后仍可读取；PAY-03 不提供投递/重试/管理员 UI。

### 异常证据

`payment_review_exceptions.kind` 包含：

`intent_not_found`、`amount_mismatch`、`merchant_mismatch`、`channel_mismatch`、`ownership_mismatch`、`transaction_conflict`、`late_success_after_closed`、`late_success_after_failed`、`terminal_conflict`、`unknown_evidence`。

异常行按 `(dedupe_key, evidence_fingerprint)` 唯一：同一错误证据重放只保留一条快照；同一 key 携带不同内容时分别留档。已接受事件的原始指纹保存在 `payment_events.evidence_fingerprint`，不同内容的冲突快照允许与原事件共用 provider key，但绝不覆盖原事件。异常行不可变地保存规范化证据快照及 SHA-256 指纹：商户订单号、渠道、渠道交易号、金额、商户 AppID/商户号、`observedAt`、来源、去重键、`providerEventRef`、`failureCode`、`failureMessage`、错误类型和明细；仅允许后续把 `status/resolved_at` 从 `open` 处理为 `reviewed/resolved`。旧版本迁移数据没有指纹时按未知证据处理并 fail-closed。异常与终态支付意图均不删除、不改写；后续 PAY-11 运营查单/处理界面在本卡之后实现。

### 事务与并发证据

- 确认使用 `BEGIN IMMEDIATE` 事务；意图、attempt、event、outbox 在同一事务中提交或全部回滚。
- `payments-confirmation.test.ts` 使用真实 SQLite/Hono 验证成功、重复、通知/查单收敛、金额/商户/订单/终态冲突、迟到成功、outbox 重启恢复，以及“outbox 唯一冲突导致已写意图/attempt 全部回滚”的失败路径。
- 跨连接/跨进程竞争由**两个独立 Node 进程、两个独立 better-sqlite3 连接**验证三组场景：同一证据并发确认收敛为一个 `confirmed`、一个 `already_confirmed`；通知与查单使用不同去重键但同一渠道交易号并发确认，会分别保留两条 provider observation，但只产生一条 paid 状态事实、attempt 与 outbox；不同渠道交易号并发确认同一支付意图只允许一个 `confirmed`，另一请求得到 `payment_confirmation_conflict` 并留下 `transaction_conflict` 异常，仍只有一条 paid attempt/outbox。此证据不再沿用 PAY-02 同实例 `Promise.all` 的弱结论。

## 5. PAY-04 隔离 Mock 驱动（已落地）

- 代码入口：`apps/api/src/payments/mock-channel.ts`。只提供进程内 `createMockPayment` 与 `executeMockPaymentAction`，**不注册公网 HTTP 控制路由**。
- 成功、失败、用户取消、超时、待确认、重复通知、通知+查单、关闭后迟到成功都先归一化为 `PaymentEvidence`，再调用 PAY-03 `confirmTrustedPayment`；没有第二套支付状态机。
- 输入只有支付意图 UUID、action、source 和服务端时间；金额、商户订单号、商户身份、渠道交易号、证据由服务端派生，调用方不能提交。只有成功结果生成带 `MOCK-TXN-` 前缀的交易号；失败/取消/超时/pending 的交易号为 null。首次 observedAt 在 Mock 专用预留表中通过 `BEGIN IMMEDIATE` 原子 insert-or-read；迁移前的事件从既有事件/attempt/异常恢复并补建预留，确保同一 dedupeKey 跨进程始终使用相同证据时间。意图与 outbox 永久 `simulated=true`。
- Mock 驱动要求 `PAYMENT_MOCK_ENABLED=true` 且非 production；production/公开预览配置启用会 fail-closed。公开预览 `mvp` 的实际 installer 固定 `NODE_ENV=production`、`AUTH_DEV_ENABLED=false` 且未设置 Mock 开关；`apps/api/Dockerfile` 也固定 production。
- 复跑命令：`pnpm --filter @sanchuang-dev/local-life-api exec tsx --test test/payments-mock.test.ts`。详细场景、排障和安全边界见 [payments-mock.md](payments-mock.md)。

## 6. PAY-05 在线订单完成、零元券单与券状态衔接（已落地）

### 6.1 两个终态，互不冒充

| 终态 | 含义 | 写入者 | 禁止事项 |
| --- | --- | --- | --- |
| `local_orders.status='verified'` + `verified_by_user_id`/`verified_at` | **人工**业务核验事实 | 运营/管理员核验接口（既有 #109 路径） | 不得用于在线支付；不得伪造 `verifiedAt` 或 `order.verified` |
| `local_orders.status='online_completed'` | **服务端可信在线交易完成** | PAY-05 消费者 / 零元完成路径 | 不写 `verified_*`、不写 `payment_received`、不代表银行到账 |

- 共享契约 `localOrderStatusSchema` 增加 `online_completed`；`LOCAL_ORDER_STATUS_TRANSITIONS` 只允许 `registered/processing/pending_review → online_completed`，且它**不在** `localOrderTransitionStatusSchema` 中，人工改状态接口永远无法把订单推进到该状态。
- `localOrderDetailSchema` 增加 `onlineCompletion`（仅 `online_completed` 存在）与 `onlineConflicts`。`verification` 与 `onlineCompletion` 在 DTO 层互斥：人工核验路径不可能声明线上付款，线上完成也不会出现核验人。
- 旧订单继续沿用人工登记 → 处理 → 核验路径，行为不变；`verified` 仍是人工核验的终态。
- 在线完成的订单不能人工核验、不能再改状态、不能补记人工实收凭据：`ledger` 的人工凭据登记入口仍要求 `status='verified'`，因此 `online_completed` 自然得到 `pending_order_review` + `canRecord=false`，不需要第二套拒绝逻辑。

### 6.2 完成事实与数据库约束

新增两张追加式表（迁移 `0035_online_order_completion.sql`）：

- `local_order_online_completions`：**一单一完成、一支付单一完成**（`local_order_id`、`payment_intent_id`、非空 `provider_transaction_id` 各自唯一）。冻结毛额/券抵扣/实付分，`kind='channel'` 必须有正数实付与渠道交易号；`kind='zero_amount'` 必须 `amount_cents=0`、无渠道交易号、非模拟。表本身拒绝 UPDATE/DELETE。
- 插入触发器要求：订单仍处于可支付状态、金额与订单快照一致、支付单确实是该订单的 `paid` 意图且 kind/金额/模拟标记一致；`local_orders` 侧触发器要求 `status='online_completed'` 必须已存在完成事实，且该状态不可再改。
- `local_order_online_conflicts`：保存“可信支付无法投影到订单”的人工核对记录（`order_not_payable`、`order_already_completed`、`payment_state_invalid`、`coupon_state_invalid`、`late_success`、`manual_online_double_collection`、`consumer_exhausted`），按 `dedupe_key` 唯一、证据不可变、只允许 `status/resolved_at` 处理字段更新。它从不回退支付、不重新占券、不完成订单。后两个 kind 由 R1/R2 返修追加（迁移 `0037_manual_online_boundary.sql`，同样追加式重建表并保留全部历史行/索引/触发器）。

### 6.3 事件消费（唯一可信成功事件）

- 消费对象只有 PAY-03 的 `payment.paid.v1`（`payment_outbox`），不重新实现支付确认。消费方在**同一 `BEGIN IMMEDIATE` 事务**内依次完成：读取并校验 outbox payload → 校验支付意图/paid attempt/渠道交易号/居民/社区/金额快照 → 写完成事实 → 投影订单状态 → 核销绑定的单张消费券 → 追加 `order.online_completed` 时间线 → 写审计 → 把 outbox 标记 `delivered`。
- 任一校验不一致时不完成订单，而是把 outbox 泊为 `failed`（`lastError` 记录原因）并落一条订单级冲突记录；真实渠道证据仍保留在 PAY-03 的 outbox/异常表中，不被静默丢弃。
- 重试耗尽/租约过期泊车（R2）：与 `status='failed'` **同一事务**写入订单级 `consumer_exhausted` 冲突（open，关联 `local_order_id`/`payment_intent_id`/`payment_outbox_id`，`detail` 保存失败原因、时间、渠道交易号与金额）。故障路径因此不再是“钱已到账但订单零次且不可见”，而是可查询、可恢复的显式异常。内部只读查询为 `GET /internal/payments/outbox/failed`。
- 受控恢复（R2）：`POST /internal/payments/outbox/recover`（同一服务端 token）只接受同时存在 open `consumer_exhausted` 的 `failed` 行：条件 UPDATE `failed → pending` 后走与消费者完全相同的幂等投影；业务冲突型 `failed` 不允许借恢复入口重放。任何 consumer 成功 `delivered` 后，对应 open `consumer_exhausted` 置 `resolved`（证据与失败原因因触发器保持不可变）、PAY-06 账本投影重放一次（唯一键保证不重复）。重复恢复/双进程并发恢复仍恰好完成一次；已 `delivered` 的重放是安全 no-op，不再产生第二次完成或第二个异常。
- 重复消费：已 `delivered` 的 outbox 不再被领取；即使人工把同一行重新置为 `pending`，唯一完成事实也会让结果变成 `already_completed`，不会产生第二条完成事件或第二次核销。
- 并发消费：领取（`pending → processing`）在独立事务内以条件 UPDATE 完成，`changes !== 1` 即放弃，因此两个消费者只有一个能投影同一事件。
- 进程中断恢复：每次领取时原子递增 `attempts`，因此领取后崩溃也计入尝试次数；租约过期时，未达上限则重新入队，已达 `PAYMENT_OUTBOX_MAX_ATTEMPTS`（默认 5）则直接泊车，避免崩溃循环绕过上限。
- 暂时性失败（数据库/意外异常）按指数退避重试（1s→2s→4s…上限 60s）；`attempts` 按每次领取计数，正常完成、业务冲突或异常都只计一次，达到 5 次后泊为 `failed` 等待人工。
- 触发入口：`runPaymentOutboxConsumer(db, options)` 与 `POST /internal/payments/outbox/consume`（与 PAY-03 确认入口同一服务端 token；居民会话、Cookie、CSRF 不能替代）。一次调用有批量上限（50），不提供无界 drain。

### 6.4 零元券单（独立完成路径）

- PAY-02 继续拒绝净应付为 0 的支付意图（保护不绕过、不向微信发起零元支付）。全额券抵扣订单改走居民接口 `POST /local-orders/:localOrderId/zero-amount-completion`。
- 服务端在单个事务中重新计算毛额/券抵扣/净应付，要求 `netPayableCents=0`、`couponDiscountCents=totalCents>0`、消费券仍 `reserved` 且绑定本单且属主/面额一致（已释放、已核销、已作废、来源奖励已冲正均拒绝），然后：写 `kind='zero_amount'` 的 `payment_intents` 行（无渠道、非模拟、`paid`、无 attempt）、写完成事实（金额 0、无渠道交易号）、投影 `online_completed`、核销券、写时间线与审计。
- 不创建支付尝试、不产生 `payment.paid.v1`、不写 `ledger_entries`，因而不贡献正数实收或消费累计。
- 重复调用幂等：第二次返回 `created:false`，不重复核销、不新增支付单。非零订单调用返回 `payment_zero_amount_unavailable`。

### 6.5 券占用、释放与迟到支付

- 复用 #212/#213：订单登记时占券；在线支付成功（或零元完成）时核销；`redeemed`/`void` 永不可恢复。
- 人工取消/拒绝订单时，若仍存在 `pending/confirming` 支付意图（渠道可能仍会扣款）或已 `paid` 的意图（钱已到但完成事实尚未投影），`releaseUnpaidOrderCoupon` 返回 `deferred`：订单照常终结，但**不释放**消费券，审计记录 `couponRelease=deferred`。这样不会出现“已付款却把同一张券给了别的订单”。
- 仅当支付渠道给出**可信终态**（PAY-03 `closed`/`failed`）、订单已 `cancelled/rejected`、没有任何 `pending/confirming/paid` 意图，且不存在该订单任何支付单的迟到成功异常时，消费者才会调用既有释放例程，恰好释放一次；已保存的迟到成功证据会继续占住消费券，等待人工处理；`expiresAt` 过期本身永远不是释放证据。
- 迟到真实成功：PAY-03 拒绝 `closed → paid` 并保存 `late_success_after_closed/failed` 异常。若异常先于释放被保存，PAY-05 会阻止返券并投影订单级 `late_success` 冲突；若真实成功在可信关单及返券之后才到达，已释放的券不会自动重新占用，订单保持 `cancelled/rejected`，仍需人工核对/补偿（真实退款策略尚未拍板）。
- 延迟释放批次在应用 `LIMIT` 前排除仍有风险的订单；异常投影批次也排除已有订单级冲突的来源记录，避免旧的阻塞/已处理记录长期占满前 200 个位置。

### 6.6 与 PAY-06 的交接边界

- PAY-05 **不写** `ledger_entries`、不做线上实收/分账/消费累计投影，`projectLocalOrderFacts` 的既有行为（只认 `verified` 人工核验）未修改。
- PAY-06 现在以 `local_order_online_completions`（+ `simulated`）为唯一来源，投影独立 `online_payment` 实收并接入消费累计；零元券单不产生现金实收/消费贡献。PAY-06 不复用人工 `payment_received` 语义，也不把 `online_completed` 当成 `verified`。
- 人工线下收款、既有锁定结算批次与历史账本完全不受影响。

### 6.7 PAY-06 线上实收与消费累计（已落地）

- 唯一上游仍是不可变 `local_order_online_completions`；投影为既有六类中的 `payment_received`，但使用独立 `source_system='online_payment'`、`evidence_kind='channel_payment'`、`source_id=completionId`、`evidence_ref=providerTransactionId`，不冒充人工收款。
- 数据库来源唯一键 `(online_payment, completionId, payment_received)` 是最终幂等边界；重复扫描、重启、双连接/双进程只会得到一条实收。零元 completion 跳过，不写 0 元现金事实。
- 真实与 Mock 都保留明细并驱动同一消费/发券路径；`simulated` 永久标记。正式 overview 仅将人工 + 真实线上计入 `receivedCents`，Mock 单列 `onlineSimulatedReceivedCents`；正式 reconciliation/CSV/结算金额排除 Mock。
- `readContributions()` 统一读取人工净实收和线上 `online_payment` 净实收，零元/券抵扣不贡献现金；发券继续复用 #211 `tryIssueEligibleTeamCoupons`。人工 `recordPayment` 只接受 `verified`，线上订单不能补人工收款；在线 reversal/退款仍 unsupported。
- 迁移 `0036_online_ledger_projection.sql` 重建账本表并保留历史行/索引/触发器；详细设计、迁移和测试见 [payments-ledger-projection.md](payments-ledger-projection.md)。

### 6.8 R1 人工/在线互斥硬边界（返修）

- 判定规则只有一条：**只有“可信终结且确定未付款”的订单才可以走人工核验/人工实收**。具体条件是：该订单所有支付意图均为 `closed`/`failed`，且不存在完成事实、不存在 `online_payment` 账本实收、不存在该订单关联的任何 open 支付审核异常，也不存在 open 的 `late_success`/`consumer_exhausted`/`manual_online_double_collection` 订单级冲突。金额、商户、交易号、终态等 provider evidence 一旦进入待复核，都表示系统尚不能证明“渠道未付款”，人工路径必须 fail-closed。
- `pending`/`confirming` 以及任何未知/非终态一律视为“可能已付”，fail-closed；不把“查不到已付”当成“没付款”。
- 边界实现在 `assertManualPaymentBoundary(tx, orderId)`，被 `verifyOrder`（`decision='verify'`）与 `recordPayment`（带 `orderId` 时）在**各自的 `BEGIN IMMEDIATE` 事务内、紧邻写入处**调用；只加路由校验或 UI 提示不算。拒绝分支 `decision='reject'` 不写核验事实，继续沿用现有“有活跃/已付意图时延迟释放券”的保护。
- 反向竞态：已有人工实收的订单收到可信渠道 `paid` 时，PAY-03 仍保留支付事实与 outbox，PAY-05 消费者不写 completion/第二条实收/重复发券，而是落 open `manual_online_double_collection` 冲突（订单、支付单、渠道交易号、金额均在 `detail` 中）；`verifyOrder` 与 `recordPayment` 的服务层直接调用同样被挡住（稳定 409 `payment_online_completion_conflict`）。
- 并发：两处检查与服务写入共享同一个 SQLite 写事务（`BEGIN IMMEDIATE`），双连接/双进程竞争下人工核验与可信确认只能有一方落地；人工 ledger link ≤1、online completion ≤1，券与发券不重复。
- 专项证据：[`apps/api/test/pay-05-r1-r2-boundary.test.ts`](../../apps/api/test/pay-05-r1-r2-boundary.test.ts)（R1 A–F、R2 A–F，真实 SQLite + 真实 Hono/服务层，含双进程竞争与重启；0036 历史库原地升级到 0037 且重复启动 no-op）。

## 7. 验证

- `packages/contracts/test/payments-contract.test.mjs`：状态机、整数分/负数/浮点/溢出、金额守恒、渠道/模拟/零元、支付意图与尝试的终态时间戳双向一致性、失败原因禁用规则、paid attempt 交易号要求，以及 PAY-03 证据/outbox/异常 DTO。
- `apps/api/test/payments-db.test.ts`：真实 SQLite 新库、历史库升级、金额/归属/唯一性/状态转换/事件追加式/跨意图引用负例，并确认旧订单、Ledger 行与锁定批次不丢失。
- `apps/api/test/payments-http.test.ts`：真实 Hono HTTP + SQLite 的创建/查询、金额派生、幂等、并发、过期/关闭/已付/零元、鉴权/CSRF/Origin、重启恢复和渠道不可用边界。
- `apps/api/test/payments-confirmation.test.ts`：内部 token、证据校验、paid/pending/terminal 收敛、跨表去重、完整异常证据、outbox 事务/重启、同证据/通知查单/不同交易号三组跨进程双连接竞争、不可变证据与失败回滚。
- `apps/api/test/payments-order-completion.test.ts`（22 例）：真实 SQLite + Hono 的在线完成一次、事件重放、双连接并发/租约恢复、崩溃尝试上限、损坏事件泊车、取消时延迟释放券、可信 close/failed 恰好释放一次、过期不释放、迟到成功先于返券时保持占券、迟到成功晚于返券时进入人工核对、返券与异常投影批次公平性、零元券单完成/重复/已释放券拒绝/非零拒绝、已核销与已冲正券拒绝、人工核验旧路径不变、注入故障后的重试/恢复、内部入口鉴权，以及 0033 历史库升级（行保留、`PRAGMA foreign_key_check` 为空、触发器重建、旧支付事件续跑完成）。
- `apps/api/test/payments-mock.test.ts`：真实 Hono + SQLite 的 Mock 发起、成功/失败/取消/超时/待确认、重复通知、通知+查单双进程竞争、重启查询、迟到成功、非法输入与 production/公开预览 fail-closed。
- `apps/api/test/payments-online-ledger.test.ts`：真实/Mock 线上 completion 投影、唯一实收、双进程竞争、outbox/sync 回填、券净额/零元、团队累计与三人券、人工/线上互斥、正式汇总/CSV 排除 Mock、锁后迟到投影、0035→0036 升级与重启恢复。
- `apps/web/test/local-order-payment.test.mjs`：H5 只把 `online_completed` 显示为交易完成，paid 未完成订单显示确认中，失败/关闭/零元领取状态与能力开关文案不互相冒充。
- `apps/api/test/pay-08-admin-payments.test.ts` 与 `packages/contracts/test/payments-admin-contract.test.mjs`：管理端只读支付查询/详情，服务端过滤与真分页、admin/operator/grid/匿名权限正反例、交易号脱敏、Mock 与真实分列、异常（双收/迟到成功/取消后支付/consumer_exhausted/terminal_conflict）只读展示、无银行到账口径。边界详见 [payments-admin.md](payments-admin.md)。

## 8. PAY-02 居民创建 / 查询 API

### 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/payments/intents` | 登录居民为自己的本地订单创建待支付意图 |
| `GET` | `/payments/intents/:paymentIntentId` | 本人读取支付意图与历史尝试 |
| `GET` | `/payments/capabilities` | 只读渠道能力；`mockAvailable` 由服务端配置决定 |
| `POST` | `/payments/intents/:paymentIntentId/mock` | 本人 Mock 演练，要求会话、CSRF/Origin、归属及服务端 Mock 开关 |

没有居民可直接写支付状态的路由。`POST .../mock` 只生成模拟渠道证据并走 PAY-03 可信确认及 PAY-05 consumer；请求体只有 `action/source`，不能提交金额、交易号或 `paid`。`paid` 仍只能由 PAY-03 的内部可信确认产生。

### 创建输入

客户端只能提交：

```json
{ "localOrderId": "...", "channel": "mock", "idempotencyKey": "..." }
```

服务端从 SQLite 读取订单并独立派生：居民 UUID、社区、毛额、优惠、净应付、商户订单号、商户上下文和 `simulated`。严格 DTO 会拒绝任何额外金额/用户/商户字段。

### 订单与渠道边界

- 只允许 `registered / processing / pending_review` 的非终态订单创建支付意图；`verified / cancelled / rejected` 返回 `payment_not_payable`。
- 净应付为 0 返回 `payment_zero_amount_unavailable`；PAY-02 不插入零元 paid 支付单，PAY-05 才负责原子完成。
- `channel=mock` 仅在 `PAYMENT_MOCK_ENABLED=true` 且非 production 时可用（本地契约联调需显式设置；默认关闭）；production 配 true 会启动失败。
- `channel=wechat_jsapi` 在 PAY-02 返回 503 `payment_channel_unavailable`，等待 PAY-10 真实商户配置；不会降级成 Mock。
- 已有 paid 支付意图返回 `payment_already_paid`；已有其他渠道的 pending/confirming 意图返回 `payment_active_intent_conflict`。

### 幂等与前向安全

1. 先按 `idempotencyKey` 查已有支付意图；同一订单/渠道/居民/金额返回 `200` 原记录。
2. 同一幂等键用于不同订单、渠道或归属返回 `409 payment_idempotency_conflict`。
3. 同一订单已有 pending/confirming 意图时，即使客户端换了新幂等键也返回原意图，避免堆叠待支付单。
4. 已过期但仍 pending 的意图仍返回原记录；过期不是渠道未收款的证据，可信查单归 PAY-03。
5. 已 closed/failed 的意图不阻止新幂等键创建新意图。
6. 创建在 `BEGIN IMMEDIATE` 事务中完成；唯一索引兜底并发，回滚时不留下半条意图/事件。

创建时写入 `payment.intent_created` 追加式事件，不创建 paid、attempt 成功、订单完成、优惠券核销或 Ledger 收款事实。当前尝试列表可为空；PAY-03 的渠道确认写入 attempt。

### 商户订单号

`merchantOrderNo` 由服务端生成 `PAY-` + 28 位大写十六进制（总长 32），满足微信 JSAPI `out_trade_no` 的 6–32 字符限制；共享契约同时限制为 6–32 个 `[A-Za-z0-9_-]` 字符。PAY-10 可直接复用该持久化值，不再生成第二套单号。

## 9. 已知限制

- 未接真实微信支付商户 API、回调验签、证书/API v3 解密；PAY-11 才完成真实适配器。
- PAY-04 Mock 是进程内测试/开发驱动；PAY-07 只增加居民会话、CSRF、归属校验后的 Mock 演练路由，不提供未鉴权公网控制面。所有模拟支付永久标记 `simulated=true`，不得被解释为真实微信扣款或银行到账。
- 在线订单完成与消费券核销已由 PAY-05 落地，PAY-06 已增加经营账本线上实收/消费累计投影；居民 H5 已由 PAY-07 提供支付状态、零元兑换与 Mock 演练；管理后台已由 PAY-08 提供只读支付流水/详情与异常定位（不含任何支付写操作）；尚未实现支付对账差异与导出（PAY-09）、真实退款执行（策略未定）。线上订单仍不进入线下结算候选；Mock 不进入正式财务汇总/对账/CSV。
- 消费者由内部 token 入口或运维调度驱动，本仓库尚未内置定时器/常驻 worker；生产部署需要运维侧按 `POST /internal/payments/outbox/consume` 或进程内调用 `runPaymentOutboxConsumer` 安排触发。
- R2 受控恢复同样是内部 token 入口，不是常驻调度：生产仍需监控 `GET /internal/payments/outbox/failed`；只有带 open `consumer_exhausted` 异常的 `failed` 事件可重放，业务冲突不会被恢复接口反复“复活”。任何后续 consumer 成功交付该事件都会自动 resolve 对应 `consumer_exhausted`，失败历史仍保留。
- 长期 `pending/confirming` 的支付意图需要 PAY-11 的可信查单/关单能力收敛；在渠道给出可信终态前，PAY-05 会一直保留其消费券占用（延迟释放），不会按过期时间猜测失败。
- `mock` 支付只用于隔离契约测试；其 outbox 永久带 `simulated=true`，后续消费方不得把它当正式收款。
- 内部 token 是服务端共享密钥，不是微信签名；泄露风险由部署密钥管理承担，未配置时接口保持关闭。

