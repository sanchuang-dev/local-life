# 隔离 Mock 支付渠道（PAY-04 #279）

> **能力边界**：本卡只提供 **进程内测试/开发驱动**，不注册未鉴权的公网控制路由，不生成真实微信交易号，不直接完成订单、核销优惠券、写人工收款或经营账本。所有 Mock 结果都进入 PAY-03 `confirmTrustedPayment`，与正式渠道共用同一支付状态机；成功事件再由 PAY-05 outbox consumer 完成订单。Mock 绿灯不代表微信支付或真实资金可用。

## 1. 入口

代码：`apps/api/src/payments/mock-channel.ts`

| 函数 | 用途 |
| --- | --- |
| `createMockPayment(db, config, actor, { localOrderId, idempotencyKey }, { now? })` | 通过 PAY-02 创建 `channel='mock'` 的待支付意图 |
| `executeMockPaymentAction(db, config, { paymentIntentId, action, source }, { now? })` | 生成模拟渠道结果并交给 PAY-03 确认 |
| `executeOwnedMockPaymentAction(db, config, actor, input, { now? })` | 在居民会话下先校验支付意图归属，再调用上表驱动 |

居民 H5 测试控制入口：

- `GET /payments/capabilities`：只读能力标志；`mockAvailable` 仅由服务端配置与运行环境决定。
- `POST /payments/intents/:paymentIntentId/mock`：要求真实居民会话、CSRF/Origin、支付意图归属，并且服务端 `PAYMENT_MOCK_ENABLED=true`；输入只有 `action`/`source`。它不是未鉴权的公网控制面，也不能提交金额、商户、交易号或证据。
- `POST /internal/payments/confirm` 仍只接受 PAY-03 的服务端 Bearer token，不能用居民会话、Cookie、CSRF 或前端 JS 回调替代。
- Mock 成功只触发既有 PAY-05 outbox consumer；页面在 refresh 后读取订单事实，不在客户端写 `paid` 或完成状态。

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
- 驱动输入只有支付意图 UUID、action 和 source；金额、商户订单号、商户身份、渠道交易号、渠道证据都由服务端派生。居民 H5 能调用 Mock 路由，但必须同时满足会话、CSRF、归属和“服务端已声明 Mock 可用”四个条件。
- 渠道交易号只在成功时固定为 `MOCK-TXN-<paymentIntentId>`；失败/取消/超时/pending 不生成交易号。去重键和处理时间由模拟事件稳定派生，能明确识别为模拟数据。
- `payment.paid.v1` outbox payload 永久携带 `simulated=true`；PAY-04 不写 `local_orders`、优惠券、`ledger_entries` 或人工 `payment_received`。
- `timeout` 未到 `expiresAt` 时拒绝，不能提前伪造关闭。
- 关闭/失败后的 `succeed` 只让 PAY-03 保存 `late_success_after_closed` / `late_success_after_failed` 异常，不会把终态改回 `paid`，也不会产生 paid attempt/outbox。
- `succeed / fail / cancel / pending` 首次使用调用方的模拟时钟 `now` 作为 `observedAt`；`timeout` 使用 `expiresAt`。首次时间在 Mock 专用预留表中通过 `BEGIN IMMEDIATE` 原子 insert-or-read，跨进程重放始终复用同一时间；迁移前的事件从既有事件/attempt/异常快照恢复并补建预留。
- `providerTransactionId` 只在 `succeed` 时生成 `MOCK-TXN-<intentId>`；`fail / cancel / timeout / pending` 均为 null，pending 阶段不会提前占用交易号。

### 并发首次生成与兼容迁移

- 每个 Mock 事件在进入 PAY-03 前，先写入 `mock_payment_event_reservations`，以 `dedupe_key` 为主键保存首次 `observed_at`。
- 预留采用 SQLite `BEGIN IMMEDIATE` 事务执行 insert-or-read；两个独立进程即使传入不同 `now`，也只能使用先提交的同一时间，避免 evidence fingerprint 冲突。
- 预留表不关联 `payment_events` 外键：即使 PAY-03 后续拒绝或进程中断，首次时间仍被保留，重试不会重新取时钟。数据库触发器禁止修改或删除预留。
- 迁移前已经存在的事件不会批量伪造预留时间；首次重放时优先从既有 `payment_events.createdAt`、timeout terminal attempt 的 `closedAt` 或 `payment_review_exceptions.observedAt` 恢复，再原子写入预留表，保持旧 evidence fingerprint 不变。
- 该表仅服务于隔离 Mock，不改变 PAY-03 的支付状态机、共享合同或真实支付链路。

## 3. 部署配置核验

| 环境 | 实际配置/证据 | Mock 状态 |
| --- | --- | --- |
| 本地开发 | `PAYMENT_MOCK_ENABLED` 默认 `false`；本地需要显式设为 `true` | 默认关闭，显式开启 |
| production / Docker | `apps/api/Dockerfile` 固定 `NODE_ENV=production` | 配置加载拒绝 `PAYMENT_MOCK_ENABLED=true` |
| 公开预览 `mvp` | 固定 proto-infra installer 写入 `NODE_ENV=production`、`AUTH_DEV_ENABLED=false`，未设置 Mock 开关；见 `docs/engineering/mvp-online-preview.md` | 默认关闭，不依赖 `NODE_ENV !== production` 以外的放行 |
| CI | API 镜像以 `NODE_ENV=production` 运行，CI 不启用 Mock | 路由存在但 `assertMockChannelEnabled` fail closed |

公开预览和正式环境不是靠页面隐藏来保护：`mockAvailable` 为 false，且居民 Mock 路由在驱动入口再次 fail closed，不会生成模拟事件。

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
- 重复通知幂等；通知 + 查单双进程双 SQLite 连接竞争；相同 dedupeKey、不同模拟时钟的双进程首次竞争收敛为同一 observedAt。
- 关闭后的迟到成功只进入异常。
- 进程重启后仍可查询 `paid` 和 pending outbox。
- 内部输入篡改、未授权 HTTP、production/公开预览配置拒绝。
- Mock 成功不写订单完成、优惠券或人工账本。

排障：

1. 先确认 `PAYMENT_MOCK_ENABLED=true` 且不是 production；生产错误是预期的 fail-closed。
2. 查询 `payment_intents`、`payment_attempts`、`payment_events`、`payment_outbox`、`payment_review_exceptions`，并按事件 `dedupe_key` 检查 `mock_payment_event_reservations`。
3. `timeout` 返回“尚未到期”时，传入 `{ now: expiresAt + ... }`，不要绕过服务端时间。
4. 迟到成功返回 `payment_confirmation_conflict` 时，检查异常表并等待 PAY-11 查单/人工复核；不要手工改状态。
5. 任何 Mock 数据只用于模拟业务演练；不能用其证明微信支付、银行到账或正式业绩。
