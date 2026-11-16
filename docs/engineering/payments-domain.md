# 支付领域契约与持久化（PAY-01 / Issue #276）

> **本卡只建立支付意图、尝试与事件的共享契约和 SQLite 真相源。** 没有支付下单/查询路由、没有 WeChat/Mock 渠道、没有 H5/管理台 UI、没有订单交易完成、没有账本投影、没有退款执行。不得据此宣称在线支付已可用。

## 1. 与既有事实的边界

| 事实 | 现有来源 | 本卡是否改变 |
| --- | --- | --- |
| 居民登记办理意向 | `local_orders`（LL-MVP-010） | 不改；支付单只引用它 |
| 人工业务核验 | `local_orders.status='verified'` / `verifiedAt` | 不改，也不等同于付款 |
| 人工实收凭据 | `ledger_entries.payment_received` | 不改，不与渠道支付混写 |
| 微信/渠道支付成功 | PAY-01 支付意图 `status='paid'`（后续 PAY-03 产生） | 新事实，不等于银行到账或结算 |
| Mock 支付 | `channel='mock'`, `simulated=1` | 永久标记模拟；不能流入正式资金/业绩 |
| 零元券单 | `kind='zero_amount'` | 独立非渠道完成类型，不伪造微信交易 |
| 退款 | 本卡不建表、不开放动作 | 未来独立退款记录引用支付意图，不改支付状态历史 |

支付状态只有 `pending / confirming / paid / closed / failed`。退款、银行到账、订单履约和结算都不是支付状态。

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
- `paid/closed/failed` 必须各自有 `paid_at/closed_at/failed_at`；失败原因只在 failed 状态存在。

### `payment_attempts`

- 一个支付意图可多次合法尝试；`(payment_intent_id, attempt_no)`、`idempotency_key` 唯一。
- `provider_transaction_id` 可空但全局唯一。
- 每个意图最多一条 paid attempt（部分唯一索引）。
- paid attempt 必须有 `confirmed_at` 和 `provider_transaction_id`；paid 后渠道交易号/确认时间冻结。
- 状态转换与支付意图相同，终态不可回退；尝试身份列不可变。

### `payment_events`

- 追加式事件：UPDATE/DELETE 由 SQLite 触发器拒绝。
- `dedupe_key` 唯一，为 PAY-03 的通知/查单去重预留。
- `(payment_attempt_id, payment_intent_id)` 复合外键防止事件把 A 意图的 attempt 挂到 B 意图。
- 事件类型限定为创建、尝试创建、状态变更、渠道通知、渠道查单；渠道事件来源必须显式标记。

## 3. PAY-02 交接约定

PAY-02 可以依赖本卡：

- 用 `createPaymentIntentRequestSchema` 接收 `localOrderId + channel + idempotencyKey`；居民、社区、金额、商户单号、商户上下文由服务端从订单/渠道配置派生，不能由客户端提交。
- 创建支付意图前先读本地订单快照，写入的 gross/discount/net 必须与数据库订单一致，否则触发器拒绝。
- 用 `paymentIntentSchema` / `paymentAttemptSchema` / `paymentEventSchema` 作为响应 DTO，不要在路由层复制字段。
- 用 `PAYMENT_STATUS_TRANSITIONS` / `canTransitionPaymentStatus` 做服务层判断；数据库触发器仍是最终边界。
- 渠道交易号写入 attempt，重复回调/查单依赖 `payment_attempts_provider_txn_uq`、`payment_events_dedupe_uq` 与 `payment_intents_one_paid_per_order_uq`。

未来退款卡应新增独立表引用 `payment_intents.id`，不得把 `paid` 改成 `refunded`，也不得改写历史事件。

## 4. 验证

- `packages/contracts/test/payments-contract.test.mjs`：状态机、整数分/负数/浮点/溢出、金额守恒、渠道/模拟/零元、paid attempt 时间与交易号。
- `apps/api/test/payments-db.test.ts`：真实 SQLite 新库、历史库升级、金额/归属/唯一性/状态转换/事件追加式/跨意图引用负例，并确认旧订单、Ledger 行与锁定批次不丢失。
