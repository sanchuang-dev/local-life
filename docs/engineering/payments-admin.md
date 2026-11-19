# PAY-08 后台支付流水查询与订单详情支付 section（#283）

> **能力边界**：本卡只做**只读**后台支付查询。它复用现有 `GET /admin/local-orders` 列表与 `GET /admin/local-orders/:id` 详情，把既有的支付/完成/账本事实投影成订单详情里的支付 section；**不新增写接口、不新增迁移、不新增第二套支付状态/流水/订单-支付关系**。渠道支付已确认 ≠ 企业银行结算到账，界面与 DTO 都不允许把前者写成「已到账/已结算」。

## 1. 真相源

| 展示层 | 唯一事实来源 | 本卡行为 |
| --- | --- | --- |
| 商品金额 / 券抵扣 / 净应付 | `local_orders` 冻结快照（`total_cents`、`coupon_discount_cents`） | 只读，不重算 |
| 人工核验 | `local_orders.status='verified'` + `verified_by_user_id` / `verified_at` / `verification_note` | 只读；不代表付款 |
| 人工线下实收 | `ledger_entries`（`source_system='manual'`、`fact_kind='payment_received'`）经 `ledger_payment_order_links` 关联订单 | 只读；不含冲正改写 |
| 在线支付单 / 尝试 / 事件 | `payment_intents` / `payment_attempts` / `payment_events` | 只读；状态词表不变 |
| 在线交易完成 | `local_order_online_completions` | 只读；一单一完成 |
| 线上实收 | `ledger_entries` + `ledger_entry_sources`（`source_system='online_payment'`，`source_id=completion.id`） | 只读；真实/模拟分别合计 |
| 支付渠道证据异常 | `payment_review_exceptions`（PAY-03 closed vocabulary） | 只读；不返回自由文本 `detail` |
| 订单级在线冲突 | `local_order_online_conflicts`（PAY-05 kind 词表） | 只读；不自动恢复 |

没有任何字段来自客户端，也没有新增表或派生写入。`apps/api/src/local/admin-payment-read.ts` 只查询上表；`listAdminOrders` 的支付过滤是 SQLite `EXISTS` 子查询。

## 2. 接口

### 列表 `GET /admin/local-orders`

在既有查询参数（`page`、`pageSize`、`communityId`、`status`、`productId`、`residentUserId`、`keyword`）之上新增（共享契约 `adminLocalOrderListQuerySchema`）：

| 参数 | 语义 |
| --- | --- |
| `orderId` | 本地订单 UUID 精确匹配 |
| `merchantOrderNo` | 支付单商户订单号精确匹配（6–32 位渠道安全字符） |
| `providerTransactionId` | 渠道交易号精确匹配（匹配 `payment_attempts`、`local_order_online_completions` 或 `payment_review_exceptions`，后者覆盖只存在于异常表的迟到/金额/商户/渠道/终态冲突交易号） |
| `paymentStatus` | `pending/confirming/paid/closed/failed`，订单存在该状态的支付单即命中 |
| `paymentChannel` | `mock` / `wechat_jsapi` |
| `paymentMode` | `simulated`：存在 `simulated=1` 支付单；`real`：存在 `simulated=0` 且带渠道的支付单 |
| `createdFrom` / `createdTo` | `local_orders.created_at` 的闭区间（ISO-8601 UTC，前端把本地日历日换算为 UTC 瞬间） |

- `page` / `pageSize` / `total` 全部由服务端 SQLite 真分页 + `COUNT(*)` 得出；排序沿用现有 `updated_at DESC, created_at DESC`。
- **只拥有支付意图的订单才会命中 `paymentMode`**：老人工订单既不是 `simulated` 也不是 `real`，不会被两项过滤器虚构。
- 响应仍是共享 `localOrderListResponseSchema`，列表项已带最新支付单摘要（`payment`），前端「支付」列直接展示，不在浏览器二次过滤。

### 详情 `GET /admin/local-orders/:id`

在既有 `localOrderDetailSchema` 之上追加 `paymentSection`（`adminLocalOrderDetailSchema`）：

```text
paymentSection
  amounts           商品金额 / 券抵扣 / 净应付（冻结快照）
  manual            verified / verifiedAt / verifiedBy / note + 人工收款凭据（含冲正标记）
  online
    intents[]       支付单 + 尝试 + 事件（交易号脱敏）
    completion      PAY-05 完成事实（交易号脱敏；kind=channel/zero_amount）
    ledgerReceipts  online_payment 实收明细（simulated 原样保留）
    conflicts[]     PAY-05 订单级冲突（closed vocabulary）
    reviewExceptions[] PAY-03 渠道证据异常（closed vocabulary，交易号脱敏）
  receiptTotals     manual / onlineReal / onlineSimulated 三段展示合计
  bankSettlement    契约字面量 { status: 'unverified' }
```

同一 section 也会附加到管理端写响应（`PATCH /admin/local-orders/:id/status`、`POST /admin/local-orders/:id/verify`），避免操作后支付事实短暂消失。`/staff/*` 与居民接口的响应形状不变。

## 3. 权限边界

- `/admin/*` 仍由既有守卫执行：匿名 **401**，`grid_worker` **403**。
- `admin` 全社区；`operator` 仅 `staff_community_assignments` 授权社区（列表按社区裁剪，显式传其他社区 `communityId` 返回 **403**，跨社区详情返回 **403**）。
- 权限在服务端判定：前端网格员锁定页只是提示，直接请求仍 403。
- 详情复用 `getStaffOrder` 的社区断言，支付 section 不扩大任何可见范围；列表 / 详情都不会因为支付过滤而返回其他社区的行。

## 4. 字段最小化与脱敏

- `providerTransactionId` 一律返回 `****` + 最多后 4 位（`adminMaskedProviderTransactionIdSchema`）；支付尝试、完成事实、异常、线上账本证据、以及基座 `onlineCompletion.providerTransactionId` 在管理端响应里都经过同一掩码。
- 不投影 `merchant_app_id` / `merchant_id` 等商户身份字段；更不存在商户私钥/证书字段可泄漏。
- `payment_review_exceptions.detail` 与 `local_order_online_conflicts.detail` 可能内嵌渠道交易号，管理端 DTO 不返回自由文本，只返回 closed `kind/status` 与结构化金额/掩码交易号。

## 5. 口径

- **Mock 永久标记**：`simulated=true` 的支付单、完成事实与账本实收均显示「模拟支付/测试」；`receiptTotals.onlineSimulatedReceivedCents` 单列，不并入 `onlineRealReceivedCents`，也不是企业实收。
- **零元券单**：`kind='zero_amount'` 是唯一合法的 `channel=null` 支付单。详情与列表都按 `channel === null` 显示「零元券单（无渠道）/零元券单已完成（无现金）」，不出现「真实渠道」或把 `paid` 写成「渠道支付已确认」，也不展示渠道交易号；零元完成不产生 `online_payment` 实收，合计为 0。
- **渠道已确认 ≠ 银行到账**：支付状态 `paid` 显示为「渠道支付已确认」；详情明确「银行结算：未核实」，DTO 的 `bankSettlement.status` 是字面量 `unverified`，客户端无法显示「已到账/已结算」。
- **人工与在线分层**：人工核验/线下凭据、在线支付单、完成事实、线上账本实收各自成层，不存在一个混用的「已付款」字段。
- **老人工订单**：没有支付单时 `online.intents=[]`、`completion=null`，仍展示人工核验与线下凭据，并明确「未发起在线支付」。
- **异常只读**：展示 PAY-03 审核异常与 PAY-05 订单冲突（含 `late_success*`、`manual_online_double_collection`、`consumer_exhausted`、`payment_state_invalid`、`order_not_payable`、`terminal_conflict` 等现有 kind），不提供「自动处理 / 一键修复 / 重新对账」按钮。

## 6. 前端

- `apps/admin/src/components/OrderPaymentSection.tsx` 嵌入既有订单详情 Drawer，不新增一级导航。
- `OrdersPage` 继续复用 `DataPanel`；新增「支付」列与支付状态/模式/商户订单号/渠道交易号/登记日期筛选，其中后三项在「高级检索」。
- 样式仅追加 `local-console.css` 中的分层区块，颜色取 antd 主题 token，不引入第二套视觉系统。

## 7. 验证

- `packages/contracts/test/payments-admin-contract.test.mjs`：查询默认值/全部过滤器/非法值、详情 section 形状、父 schema refine 继承、拒绝原始交易号与商户私钥类额外字段、`bankSettlement` 只允许 `unverified`、合计非负。
- `apps/api/test/pay-08-admin-payments.test.ts`：真实 Hono + SQLite。覆盖 Mock 支付确认→完成→线上实收、人工核验+线下凭据、人工/在线双收、关单后迟到成功、订单取消后仍收到支付、`consumer_exhausted` 冲突、真实渠道 pending 支付单；服务端过滤/真分页、admin/operator/grid/匿名正反例、脱敏与无银行到账字样、管理端写响应附 section、无新增支付表。
- `apps/admin/src/pages/OrdersPage.test.tsx`：Mock/人工/异常三类详情渲染、脱敏、无自动处理按钮、支付状态筛选真正进入服务端查询。
- 复跑：

```bash
pnpm --filter @sanchuang-dev/local-life-contracts test
pnpm --filter @sanchuang-dev/local-life-api exec node --import tsx --test test/pay-08-admin-payments.test.ts
pnpm --filter @sanchuang-dev/local-life-admin test
```

## 8. 未实现 / 已知限制

- 真实微信支付、回调验签、退款、银行结算/对账导出均不在本卡；`PAY-09` 才做对账差异与导出。退款事实尚未在合同中定义，因此界面不展示「退款中/已退款」等占位状态（Issue #283 提到的退款占位需另立合同）。
- 历史人工凭据若未通过 `ledger_payment_order_links` 关联到本单，详情只显示「暂无人工收款凭据」并提示到经营账本按凭据号核对，不做金额/时间猜测匹配。
- 没有常驻查单/恢复按钮：异常只可定位，受控恢复仍走 PAY-03/PAY-05 的内部 token 接口或 PAY-11 运维流程。
- `paymentMode=real` 只能命中已经存在的真实渠道支付单；PAY-10 未落地前，PAY-02 仍拒绝创建 `wechat_jsapi` 支付单，本卡不伪造真实渠道事实。
- 未做浏览器真机视觉验收；以类型检查、组件测试与构建为本次证据，维护者按需再验关键交互。

## 9. 回滚

- 代码回滚：删除/还原本卡单一提交（`feat/pay-08` 上的 PAY-08 commit）即可；没有迁移、没有 schema 变更、没有回填数据，回滚不涉及数据修复。
- 本卡只新增只读查询与展示，回滚后既有 `/admin/local-orders` 恢复原 DTO；已存在的支付/完成/账本事实不受影响。
