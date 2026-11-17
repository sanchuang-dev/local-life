# 隔离 Mock 支付渠道（PAY-04 #279）

> **能力边界**：本卡只提供 **进程内测试/开发驱动**，不注册公网 HTTP 控制路由，不生成真实微信交易号，不完成订单、核销优惠券、写人工收款或经营账本。所有 Mock 结果都进入 PAY-03 `confirmTrustedPayment`，与正式渠道共用同一支付状态机。Mock 绿灯不代表微信支付或真实资金可用。

## 1. 入口

代码：`apps/api/src/payments/mock-channel.ts`

| 函数 | 用途 |
| --- | --- |
| `createMockPayment(db, config, actor, { localOrderId, idempotencyKey }, { now? })` | 通过 PAY-02 创建 `channel='mock'` 的待支付意图 |
| `executeMockPaymentAction(db, config, { paymentIntentId, action, source }, { now? })` | 生成模拟渠道结果并交给 PAY-03 确认 |

没有 `/mock` 支付控制路由。`POST /internal/payments/confirm` 仍只接受 PAY-03 的服务端 Bearer token，不能用居民会话、Cookie、CSRF 或前端 JS 回调替代。

`action`：

| action | 模拟结果 |
| --- | --- |
| `succeed` | `providerStatus=paid`，PAY-03 收敛为 `paid` |
| `fail` | `providerStatus=failed`，失败码 `MOCK_PAYMENT_FAILED` |
| `cancel` | `providerStatus=failed`，失败码 `MOCK_USER_CANCELLED` |
| `timeout` | `providerStatus=closed`，必须在支付单 `expiresAt` 之后调用 |
| `pending` | `providerStatus=pending`，PAY-03 收敛为 `confirming` |

`source`：

- `notification`：模拟服务端收到渠道通知。
- `query`：模拟服务端主动查单。

## 2. 安全与隔离

- Mock 驱动要求 `PAYMENT_MOCK_ENABLED=true` 且 `NODE_ENV !== production`；`loadConfig` 在 production + true 时直接启动失败，驱动自身再次 fail-closed。
- Mock 意图由 PAY-02 固定写入 `channel='mock'`、`simulated=true`；驱动拒绝任何非 Mock/非模拟支付单，不会借 Mock 驱动真实微信意图。
- 驱动输入只有支付意图 UUID、action 和 source；金额、商户订单号、商户身份、渠道交易号、渠道证据都由服务端派生，客户端没有对应 HTTP 入口。
- 渠道交易号只在成功时固定为 `MOCK-TXN-<paymentIntentId>`；失败/取消/超时/pending 不生成交易号。去重键和处理时间由模拟事件稳定派生，能明确识别为模拟数据。
- `payment.paid.v1` outbox payload 永久携带 `simulated=true`；PAY-04 不写 `local_orders`、优惠券、`ledger_entries` 或人工 `payment_received`。
- `timeout` 未到 `expiresAt` 时拒绝，不能提前伪造关闭。
- 关闭/失败后的 `succeed` 只让 PAY-03 保存 `late_success_after_closed` / `late_success_after_failed` 异常，不会把终态改回 `paid`，也不会产生 paid attempt/outbox。
- `succeed / fail / cancel / pending` 首次使用调用方的模拟时钟 `now` 作为 `observedAt`；`timeout` 使用 `expiresAt`。重复事件先从 `payment_events`、terminal attempt 或异常快照恢复首次时间，不重新取 `now`，因此 evidence fingerprint 和 PAY-03 幂等边界保持稳定。
- `providerTransactionId` 只在 `succeed` 时生成 `MOCK-TXN-<intentId>`；`fail / cancel / timeout / pending` 均为 null，pending 阶段不会提前占用交易号。

### 并发首次生成边界

现有持久化事件、attempt 和异常快照能可靠覆盖“首次结果已落库后的重复通知/查单”。两个独立进程**同时首次**生成同一 `dedupeKey` 且传入不同 `now` 时，双方都读不到事件，可能以不同 observedAt 进入 PAY-03；PAY-03 会把后到者按证据指纹冲突处理。

本卡没有为这个首次竞争偷偷新增支付状态机或表。若维护者要求彻底消除该窗口，最小方案是增加只用于 Mock 的 `(dedupe_key PK, observed_at)` 预留表，在调用 `confirmTrustedPayment` 前用 `BEGIN IMMEDIATE` 做 insert-or-read；这会新增迁移，需单独批准，不在本次 P2 返修范围内。

## 3. 部署配置核验

| 环境 | 实际配置/证据 | Mock 状态 |
| --- | --- | --- |
| 本地开发 | `PAYMENT_MOCK_ENABLED` 默认 `false`；本地需要显式设为 `true` | 默认关闭，显式开启 |
| production / Docker | `apps/api/Dockerfile` 固定 `NODE_ENV=production` | 配置加载拒绝 `PAYMENT_MOCK_ENABLED=true` |
| 公开预览 `mvp` | 固定 proto-infra installer 写入 `NODE_ENV=production`、`AUTH_DEV_ENABLED=false`，未设置 Mock 开关；见 `docs/engineering/mvp-online-preview.md` | 默认关闭，不依赖 `NODE_ENV !== production` 以外的放行 |
| CI | API 镜像以 `NODE_ENV=production` 运行，CI 不启用 Mock 控制面 | 无公网 Mock 控制入口 |

公开预览和正式环境不是靠页面隐藏来保护，而是启动配置 fail-closed 且没有 Mock HTTP 路由。

## 4. 复跑与排障

本地演练时，将 `apps/api/.env.local` 的 `PAYMENT_MOCK_ENABLED` 从 `false` 改为 `true` 后运行 `pnpm dev:local`；默认保持关闭。

从隔离工作区复跑完整场景：

```bash
pnpm --filter @sanchuang-dev/local-life-api exec tsx --test test/payments-mock.test.ts
```

测试覆盖：

- 成功、失败、用户取消、超时、待确认，以及 pending → success/fail/cancel。
- 立即成功/取消的终态时间、延迟十分钟成功、重复通知复用首次 observedAt、timeout 复用 expiresAt。
- 失败/取消/超时/pending 的 attempt 交易号为 null；pending → success 才生成 `MOCK-TXN-<intentId>`；成功 outbox 保留正确交易号。
- 重复通知幂等；通知 + 查单双进程双 SQLite 连接竞争。
- 关闭后的迟到成功只进入异常。
- 进程重启后仍可查询 `paid` 和 pending outbox。
- 内部输入篡改、未授权 HTTP、production/公开预览配置拒绝。
- Mock 成功不写订单完成、优惠券或人工账本。

排障：

1. 先确认 `PAYMENT_MOCK_ENABLED=true` 且不是 production；生产错误是预期的 fail-closed。
2. 查询 `payment_intents`、`payment_attempts`、`payment_events`、`payment_outbox`、`payment_review_exceptions` 的同一 `payment_intent_id`。
3. `timeout` 返回“尚未到期”时，传入 `{ now: expiresAt + ... }`，不要绕过服务端时间。
4. 迟到成功返回 `payment_confirmation_conflict` 时，检查异常表并等待 PAY-11 查单/人工复核；不要手工改状态。
5. 任何 Mock 数据只用于模拟业务演练；不能用其证明微信支付、银行到账或正式业绩。
