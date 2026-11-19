# PAY-09 · 支付差异核查与导出

关联：[#284](https://github.com/sanchuang-dev/local-life/issues/284)、PAY-06 #281、PAY-08 #283、PAY-10 #285、PAY-11 #286。仅是开发分支的只读核查功能，**不是微信渠道账单、银行结算或正式资金验收**。

## 事实与查询

- 现有 `payment_intents / payment_attempts / payment_events / payment_review_exceptions`、`local_order_online_completions / local_order_online_conflicts`、`ledger_entry_sources + ledger_entries` 仍是单一事实来源。
- `GET /admin/reconciliation/payments` 返回按支付意图一行的主核查结论（最优先异常），使用 SQL 服务端分类、过滤、总数与分页。一个支付单同时存在多项异常时，表格只显示最高优先级；`GET /admin/reconciliation/payments/:intentId` 同时返回 PAY-08 的订单支付详情，供查看全部事件/冲突。
- `GET /admin/reconciliation/payments.csv` 导出与列表**同一条件、同一 SQL 判定**的完整核查结果；超过 5000 行拒绝，而不是截断成貌似完整的文件。UTF-8 BOM + CRLF + RFC4180 双引号 + Excel 公式注入防护。金额固定为**整数分**，不推算应付分润。
- 过滤：状态（异常、本地一致、待付、全部）、具体原因、来源（Mock / 微信 JSAPI / 零元）、社区、业务日。业务日期按支付意图创建时间及 Asia/Shanghai 日历日计算，两端包含；它**不等同于付款到账日期**。
- 后台权限：只有 admin/operator 可读，operator 使用既有服务端社区分配；显式越权社区查询或导出返回 403，越权详情不泄漏任何跨社区事实。grid_worker 403、匿名 401。
- 列表/详情/CSV 全部为 GET，只读，不新增表、迁移、对账写入或人工修改流水/锁定结算批次的能力。

## 结果语义（必须保留）

- `local_consistent`：当前**内部**支付单、订单完成、线上账本可证明的对应关系一致，不是微信账单匹配，也不是银行结算完成。
- `awaiting_payment`：未超时的支付意图，不能认定异常或已支付。
- `confirmation_timeout / outbound_uncertain`：超时、尚未确认或渠道预下单不确定，须 PAY-11 查单/关单，不得靠后台“修正状态”。
- `paid_not_projected / ledger_missing / amount_mismatch / channel_evidence_missing`：支付、完成、账本、渠道成功尝试的内部记录缺失或不符。
- `provider_exception / duplicate_provider_event / manual_online_conflict / order_state_conflict`：原异常队列、重复来源事件与订单事实冲突，保留人工核查入口。重复渠道事件仅在相同事件类型（通知对通知、查单对查单）且同一渠道引用下判定；同一交易的正常「通知 + 主动查单」不是重复。
- `channelBill = not_connected`、`bankSettlement = unverified`：所有结果恒定如此。微信侧未接入渠道账单时，不得出现“微信账单匹配成功”；Mock 只报告测试事实，不合并进真实收款。零元券单无渠道现金也不计算线上实收。
- 不根据 prepay_id、浏览器回调或未验证日志创建“已付款”事实；PAY-11 和总 PRD #275 承担真实资金端到端验证。

## 运维 / 测试 / 回滚

- 变更只影响只读查询与 Admin 局部 UI：可通过 revert 此 PR 回滚，不触及支付事实或锁定账本。
- 验证入口：`pnpm --filter @sanchuang-dev/local-life-api exec node --import tsx --test test/pay-08-admin-payments.test.ts`（包含 PAY-09 子用例）、`pnpm --filter @sanchuang-dev/local-life-api typecheck`、`pnpm --filter @sanchuang-dev/local-life-admin typecheck`、`pnpm check`。
- 无微信真实商户权限及渠道账单接线：只能验证本地事实及注入的异常，不得宣传真实微信渠道对账、退款或银行入账。
\n## PAY-11 扩展（#286）
- 既有支付意图列表增加 PAY-11 恢复审计的**最近核查结果**投影：未知查单、退款人工复核、关单已发送但未证实、已关单后的异常二次查单均提示 `provider_exception`；最新可信结果恢复正常时不永久把过往暂时性网络故障当成当前异常。
- 详情按原有服务端社区/角色权限读取最近 20 条脱敏恢复摘要（操作、状态、原因、时间），不返回微信原始响应、密文、证书、AppSecret、交易号；列表 CSV 仍保持现有字段和本地金额含义。`wechat_pay_recovery_checks` 属于 PAY-11 只追加审计，不是银行结算或微信账单勾对。
