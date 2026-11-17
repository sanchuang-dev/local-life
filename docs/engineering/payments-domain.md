# 支付领域契约、持久化、居民创建/查询与可信确认（PAY-01 #276 / PAY-02 #277 / PAY-03 #278）

> **PAY-01** 建立支付意图、尝试与事件的共享契约和 SQLite 真相源；**PAY-02** 增加居民创建/查询待支付意图的受控 API；**PAY-03** 增加可信渠道证据确认、状态收敛、下游 outbox 与冲突证据队列。当前仍**没有**真实微信支付商户配置/回调验签（PAY-10/PAY-11）、Mock 网关执行（PAY-04）、订单交易完成、优惠券核销、账本投影或退款执行（PAY-05/PAY-06）。不得据此宣称在线支付已可用。

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
- 两张表均拒绝 DELETE，且 outbox 的身份/payload、异常表的原始证据字段不可 UPDATE；outbox 仅允许消费状态/重试字段更新，异常表仅允许 `status/resolved_at` 处理字段更新。异常表保留原始商户订单号、渠道交易号、金额、来源与错误类型。

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
- 金额、商户订单号、商户号、渠道、币种或归属不一致时，不写 `paid`，保存异常证据并返回通用冲突错误；不向调用方泄露内部字段。

### 状态与幂等收敛

- **paid**：仅允许 `pending/confirming → paid`。同一 `BEGIN IMMEDIATE` 事务内更新支付意图、写入/更新 paid attempt、追加渠道事件、写入 `payment.paid.v1` outbox。重复提交同一证据返回 `already_confirmed`；通知与查单使用不同去重键但同一渠道交易号时也只产生一条 paid attempt/outbox。
- **pending**：允许 `pending → confirming` 或保持 `confirming`；写入/更新 confirming attempt 与渠道事件，不产生 outbox。
- **failed/closed**：允许 `pending/confirming → failed|closed`；写入终态 attempt、事件与时间戳，不产生 outbox。
- **迟到成功**：支付意图已 `closed`/`failed` 后又收到 paid 证据时，**不回退状态、不写 paid attempt/outbox**，只把渠道证据保存为 `late_success_after_closed` / `late_success_after_failed`。
- **终态冲突**：已 `paid` 后收到 failed/closed，或已终态 attempt 被要求回退，保存 `terminal_conflict` 并拒绝。
- **渠道交易号复用**：同一 `provider_transaction_id` 已属于另一支付意图时保存 `transaction_conflict`，不确认第二张单。
- 重复事件键优先返回原结果；重复事件键属于另一支付意图时保存 `transaction_conflict`。
- 所有状态写入仍由 SQLite 状态触发器兜底；服务层与数据库两层校验一致。

### Outbox 与下游

- `payment.paid.v1` payload 固定包含 `paymentIntentId`、`localOrderId`、`residentUserId`、`communityId`、`amountCents`、`providerTransactionId`、`simulated`、`paidAt`。
- outbox 行在 paid 事务内以 `dedupe_key = payment.paid:<paymentIntentId>` 写入 `pending`；重复确认不会新增第二行。
- PAY-03 **不消费** outbox，也不完成订单、核销优惠券或投影账本；PAY-05/PAY-06 负责按 payload 消费，并必须用稳定去重键保证重复执行不重复产生业务事实。
- outbox 与异常表持久化，进程重启后仍可读取；PAY-03 不提供投递/重试/管理员 UI。

### 异常证据

`payment_review_exceptions.kind` 包含：

`intent_not_found`、`amount_mismatch`、`merchant_mismatch`、`channel_mismatch`、`ownership_mismatch`、`transaction_conflict`、`late_success_after_closed`、`late_success_after_failed`、`terminal_conflict`、`unknown_evidence`。

同一证据 `dedupe_key` 只保存一条异常。异常与终态支付意图均不删除、不改写；后续 PAY-11 运营查单/处理界面在本卡之后实现。

### 事务与并发证据

- 确认使用 `BEGIN IMMEDIATE` 事务；意图、attempt、event、outbox 在同一事务中提交或全部回滚。
- `payments-confirmation.test.ts` 使用真实 SQLite/Hono 验证成功、重复、通知/查单收敛、金额/商户/订单/终态冲突、迟到成功、outbox 重启恢复，以及“outbox 唯一冲突导致已写意图/attempt 全部回滚”的失败路径。
- 跨连接/跨进程竞争由**两个独立 Node 进程、两个独立 better-sqlite3 连接**验证三组场景：同一证据并发确认收敛为一个 `confirmed`、一个 `already_confirmed`；通知与查单使用不同去重键但同一渠道交易号并发确认，同样只收敛为一条 paid attempt/事件/outbox；不同渠道交易号并发确认同一支付意图只允许一个 `confirmed`，另一请求得到 `payment_confirmation_conflict` 并留下 `transaction_conflict` 异常，仍只有一条 paid attempt/outbox。此证据不再沿用 PAY-02 同实例 `Promise.all` 的弱结论。

## 5. 验证

- `packages/contracts/test/payments-contract.test.mjs`：状态机、整数分/负数/浮点/溢出、金额守恒、渠道/模拟/零元、支付意图与尝试的终态时间戳双向一致性、失败原因禁用规则、paid attempt 交易号要求，以及 PAY-03 证据/outbox/异常 DTO。
- `apps/api/test/payments-db.test.ts`：真实 SQLite 新库、历史库升级、金额/归属/唯一性/状态转换/事件追加式/跨意图引用负例，并确认旧订单、Ledger 行与锁定批次不丢失。
- `apps/api/test/payments-http.test.ts`：真实 Hono HTTP + SQLite 的创建/查询、金额派生、幂等、并发、过期/关闭/已付/零元、鉴权/CSRF/Origin、重启恢复和渠道不可用边界。
- `apps/api/test/payments-confirmation.test.ts`：内部 token、证据校验、paid/pending/terminal 收敛、异常留存、outbox 事务/重启、同证据/通知查单/不同交易号三组跨进程双连接竞争、不可变证据与失败回滚。

## 6. PAY-02 居民创建 / 查询 API

### 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/payments/intents` | 登录居民为自己的本地订单创建待支付意图 |
| `GET` | `/payments/intents/:paymentIntentId` | 本人读取支付意图与历史尝试 |

没有居民可调用的支付状态写入路由。`paid` 只能由 PAY-03 的内部可信确认产生。

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

## 7. 已知限制

- 未接真实微信支付商户 API、回调验签、证书/API v3 解密；PAY-11 才完成真实适配器。
- 未实现 Mock 网关执行/自动完成；PAY-04 负责。
- 未实现订单完成、优惠券核销、账本收款投影、结算、退款或管理员支付运维 UI；PAY-05/PAY-06 负责。
- `mock` 支付只用于隔离契约测试；其 outbox 永久带 `simulated=true`，后续消费方不得把它当正式收款。
- 内部 token 是服务端共享密钥，不是微信签名；泄露风险由部署密钥管理承担，未配置时接口保持关闭。
