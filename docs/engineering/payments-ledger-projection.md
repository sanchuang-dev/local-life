# PAY-06 线上实收账务投影、消费累计与发券（#281）

> **能力边界**：本卡只消费 PAY-05 的不可变 `local_order_online_completions`。它不判断支付是否成功、不重新解析微信回调、不读 `local_orders.status` 猜金额，也不把线上渠道实收伪装成人工 `payment_received`。Mock/真实都走同一投影与奖励代码路径，但 `simulated` 永久区分，Mock 永不进入正式财务汇总、对账批次、CSV 或结算金额。

## 1. 唯一上游事实

```
local_order_online_completions
  id / local_order_id / payment_intent_id
  kind ('channel' | 'zero_amount')
  simulated
  gross_amount_cents / discount_cents / amount_cents
  provider_transaction_id / completed_at
```

- `amount_cents = gross_amount_cents - discount_cents`，由 PAY-05 冻结；PAY-06 不重新算商品价格。
- `kind='zero_amount'`（amount=0）没有现金事实，投影直接跳过；不写 0 元 `payment_received`，消费累计为 0。
- `simulated=true` 的完成事实仍可投影、查询、驱动同一消费/发券测试路径，但正式财务口径必须排除。

## 2. 账本投影

`projectOnlineCompletionsToLedger`（`apps/api/src/ledger/service.ts`）按 completion 扫描：

- `fact_kind = payment_received`（保留六类事实，不新增第七类）；
- `source_system = online_payment`（不是 `manual`）；
- `simulated` 从 completion 原样复制；
- `source_id = completion.id`（稳定去重键）；
- `source_display_no = local_order_id`，`evidence_kind = channel_payment`，`evidence_ref = provider_transaction_id`；
- `occurred_at = completed_at`，`recordedByUserId/StaffId = null`；
- 归属保持 `pending/source_missing`，不伪造人工经办人。

数据库唯一键：

```
ledger_entry_sources (source_system, source_id, fact_kind)
= ('online_payment', <completionId>, 'payment_received')
```

这是最终幂等兜底。重复扫描、重启恢复、双连接/双进程竞争最多命中已有行；零元 completion 不产生行。

投影入口：

1. PAY-05 outbox consumer 完成一个订单后，在消费循环末尾调用投影（处理新完成与历史积压）。
2. `POST /admin/ledger/sync` 的显式来源同步也调用投影，支持历史回填；响应新增 `sources.onlineCompletion`。
3. 测试/维护者可调用导出的 `projectOnlineCompletionsToLedger`。

每次投影在 `BEGIN IMMEDIATE` 事务内写入账本；如果订单有团队来源，则在同一事务调用既有 `tryIssueEligibleTeamCoupons`。因此“实收事实 + 发券”要么一起成功，要么一起回滚。

## 3. 消费累计与发券

`readContributions()` 保持一套奖励算法，只换上游：

- 人工：`verified` 订单 + `ledger_payment_order_links` + manual `payment_received`，扣除全额冲正；
- 线上：`online_completed` 订单 + `local_order_online_completions` + `online_payment` 的 `payment_received`，金额必须等于 completion `amount_cents`；
- 只有入团后创建、归属固定、实际净实付 > 0 的订单贡献；
- 券抵扣不计现金；零元贡献 0；
- 同一 completion 的唯一账本来源确保只累计一次。

`tryIssueEligibleTeamCoupons` 仍是唯一发券入口；同团同档 `coupon_team_grants` 唯一约束、三人券和预算检查不复制。重放投影不会重复累计或重复发券。

## 4. 真实 / 模拟 / 人工口径

| 口径 | `source_system` | `simulated` | 记账/汇总 |
| --- | --- | --- | --- |
| 人工实收 | `manual` | false | 正式实收；必须有 staff + 人工凭据 |
| 真实线上实收 | `online_payment` | false | 正式实收；必须来自 completion + 渠道流水 |
| 模拟线上实收 | `online_payment` | true | 明细可查、可驱动消费/发券测试；正式汇总/对账/CSV/结算排除 |

`LedgerEntry.simulated` 是明细字段；`ledgerOverview.payment` 分列：

- `receivedCents` = 人工 + 真实线上（正式口径）；
- `manualReceivedCents`；
- `onlineRealReceivedCents`；
- `onlineSimulatedReceivedCents`（不并入 `receivedCents`）。

正式 reconciliation 的成员查询固定 `simulated = 0`；Mock 不进入批次金额/CSV。管理员仍可用 ledger list 的 `simulated=true` 过滤查看模拟流水。Mock 明细保留 `simulated=true`，不能用于财务/银行到账/对外社区业绩。

## 5. 人工/线上互斥与退款边界

- 人工收款入口仍只接受 `status='verified'`；`online_completed` 不能补人工 `payment_received`。
- 线上账本来源不写 `ledger_payment_order_links`，人工 link 触发器仍只接受 verified + manual。
- 本卡没有在线 reversal/退款事实。`reversePayment` 明确拒绝非 `manual` 来源，不能拿人工冲正伪造微信退款；未来退款需独立事件和扩展位置。

## 6. 迁移与验证

- 迁移 `0036_online_ledger_projection.sql` 重建 `ledger_entries` / `ledger_entry_sources`（SQLite 不能原地改 CHECK），复制全部历史行，新增 `simulated`、`online_payment`、`channel_payment` 及人工/线上分规则；旧索引/触发器全部重建，已锁批次/结算/奖励不改写。
- `apps/api/test/payments-online-ledger.test.ts`：真实/Mock 投影、唯一实收、双进程竞争、outbox consumer、券净额、零元、团队累计/发券、人工/线上互斥、正式汇总/CSV 排除 Mock、锁后迟到投影、0035→0036 升级。
- 复跑：`pnpm --filter @sanchuang-dev/local-life-api exec tsx --test test/payments-online-ledger.test.ts`。

## 7. 未实现 / 已知限制

- 不实现真实退款、部分退款、渠道退款事件；线上 reversal 仍 unsupported。
- 不实现 H5/Admin 支付 UI；PAY-07/PAY-08 负责。
- 不把线上付款等同机构结算或银行到账；线下 settlement candidate 仍只走人工 verified + manual receipt。
- 投影采用有界扫描（默认 200），大量历史积压由后续 sync/consumer 批次继续处理。
