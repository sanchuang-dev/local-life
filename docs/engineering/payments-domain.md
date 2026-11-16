# 支付领域契约、持久化与居民创建/查询（PAY-01 #276 / PAY-02 #277）

> **PAY-01** 建立支付意图、尝试与事件的共享契约和 SQLite 真相源；**PAY-02** 增加居民创建/查询待支付意图的受控 API。仍然没有渠道下单/确认、`paid` 写入、Mock 网关执行、微信支付回调、H5/管理台支付 UI、订单交易完成、账本投影或退款执行。不得据此宣称在线支付已可用。

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
- `paid/closed/failed` 必须各自有 `paid_at/closed_at/failed_at`，其余终态时间列必须为空；非 failed 状态禁止失败原因。共享 Zod 校验与 SQLite CHECK 保持同一双向约束。

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

## 3. PAY-02 实现约定（已落地）

PAY-02 依赖本卡：

- 用 `createPaymentIntentRequestSchema` 接收 `localOrderId + channel + idempotencyKey`；居民、社区、金额、商户单号、商户上下文由服务端从订单/渠道配置派生，不能由客户端提交。
- 创建支付意图前先读本地订单快照，写入的 gross/discount/net 必须与数据库订单一致，否则触发器拒绝。
- 用 `paymentIntentSchema` / `paymentAttemptSchema` / `paymentEventSchema` 作为响应 DTO，不要在路由层复制字段。
- 用 `PAYMENT_STATUS_TRANSITIONS` / `canTransitionPaymentStatus` 做服务层判断；数据库触发器仍是最终边界。
- **PAY-02 只允许居民创建/读取支付单，不开放支付状态修改路由。** 不提供客户端可直接提交 `paid/closed/failed` 的更新 DTO；PAY-03 的可信服务端确认独占状态写入，不能用客户端 JS 回调或手工请求声明成功。
- 渠道交易号写入 attempt，重复回调/查单依赖 `payment_attempts_provider_txn_uq`、`payment_events_dedupe_uq` 与 `payment_intents_one_paid_per_order_uq`。

未来退款卡应新增独立表引用 `payment_intents.id`，不得把 `paid` 改成 `refunded`，也不得改写历史事件。

## 4. 验证

- `packages/contracts/test/payments-contract.test.mjs`：状态机、整数分/负数/浮点/溢出、金额守恒、渠道/模拟/零元、支付意图与尝试的终态时间戳双向一致性、失败原因禁用规则，以及 paid attempt 交易号要求。
- `apps/api/test/payments-db.test.ts`：真实 SQLite 新库、历史库升级、金额/归属/唯一性/状态转换/事件追加式/跨意图引用负例，并确认旧订单、Ledger 行与锁定批次不丢失。
- `apps/api/test/payments-http.test.ts`：真实 Hono HTTP + SQLite 的创建/查询、金额派生、幂等、并发、过期/关闭/已付/零元、鉴权/CSRF/Origin、重启恢复和渠道不可用边界。

## 5. PAY-02 居民创建 / 查询 API

### 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/payments/intents` | 登录居民为自己的本地订单创建待支付意图 |
| `GET` | `/payments/intents/:paymentIntentId` | 本人读取支付意图与历史尝试 |

没有居民可调用的支付状态写入路由。`paid` 只能由 PAY-03 的可信服务产生。

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

创建时写入 `payment.intent_created` 追加式事件，不创建 paid、attempt 成功、订单完成、优惠券核销或 Ledger 收款事实。当前尝试列表可为空；PAY-03/PAY-04 渠道调用后写入 attempt。

### PAY-03 复用边界

- 用 `paymentIntents.id` 与 `idempotencyKey` 定位同一意图，不重建支付单。
- 通过 `payment_attempts` 记录渠道请求/通知，依赖 `provider_transaction_id` 唯一索引和 paid attempt 部分唯一索引去重。
- 通过 `payment_events.dedupe_key` 去重通知/查单，通过状态触发器收敛 `paid`。
- 创建 API 不会调用渠道；PAY-03 必须独立验证渠道事实后才能把意图推进到 paid。

### 并发验证边界（PAY-02）

`payments-http.test.ts` 的 `Promise.all` 用例运行在同一个同步 SQLite/Hono 实例上，证明的是重复调用、active 意图复用与幂等收敛，**不能单独证明跨连接/跨进程的 SQLite 写锁竞争**。实现方向仍是 `BEGIN IMMEDIATE` 事务 + 唯一索引；跨进程双连接竞争验证留给后续资金链路加固或 PAY-03/PAY-06 的并发验收，不在本卡证据中冒充已验证。

### 商户订单号

`merchantOrderNo` 由服务端生成 `PAY-` + 28 位大写十六进制（总长 32），满足微信 JSAPI `out_trade_no` 的 6–32 字符限制；共享契约同时限制为 6–32 个 `[A-Za-z0-9_-]` 字符。PAY-10 可直接复用该持久化值，不再生成第二套单号。
