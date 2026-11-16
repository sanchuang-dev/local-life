# 居民自主下单 → 片区网格员核验 → 社区有效业绩

> 第三批业务闭环。片区归属与唯一约束沿用 [grid-territory.md](grid-territory.md)，本卡只增加核验权限与核验后的社区业绩投影。

## 1. 链路

1. 居民在 H5「惠生活」自主登记订单；社区来自服务端商品，`createdByStaffId` 为空是正常情况。
2. 订单进入 `processing → pending_review` 后，当前片区网格员（或运营员/管理员）通过 H5 工作台电话核实。
3. `POST /staff/local-orders/:localOrderId/verify` 使用既有 `localOrderVerifyRequestSchema`、状态机、CSRF、可信 Origin 和 `expectedUpdatedAt` 乐观并发。
4. 核验通过在同一 SQLite 事务中：
   - 更新订单为 `verified`，记录 `verifiedByUserId`、`verifiedAt`、`verificationNote`；
   - 追加 `order_registered` 与 `order_verified` 两条 Ledger 事实（已存在则跳过）；
   - 写入订单事件与审计。
5. 总览/流水立即从 Ledger 读取到该社区的有效订单数量与金额，无需逐笔人工“同步来源事实”。

核验只表示订单事实有效，不代表收款、运营商办理成功、可结算或三人团消费入账。不会生成 `payment_received`、佣金或奖励。

## 2. 核验权限

| 角色 | 核验权限 |
| --- | --- |
| `admin` | 全部社区 |
| `operator` | `staff_community_assignments.operator_scope` 授权的社区 |
| `grid_worker` | 仅当前 `assignment_kind = 'grid_territory'` 的片区，且账户 `active` |
| 居民 | 无 |

服务端在每次核验写入时重新查询当前经营关系，不信任会话里可能过期的社区列表，也不接受客户端传入的网格员 ID。调岗、停用或解除片区后，旧人员对旧片区订单的核验返回 403。

后台 `/admin/local-orders/:id/verify` 仍只接受管理员与运营员；网格员走 `/staff/local-orders/:id/verify`，不开放整个 `/admin/*`。

## 3. 社区有效业绩与个人归属

- Ledger 事实的 `communityId` 来自订单原始社区，不随负责人变化。
- 两类事实分开：`order_registered`（登记金额）与 `order_verified`（已核验业绩），总览不跨类相加。
- 本卡仍把本地订单事实记为 `attributionState = pending`：社区有效业绩按 `communityId` 统计，个人归属只是历史核查维度，不是社区统计的前置条件。
- 核验人只进入订单 `verifiedByUserId`、事件和审计，不回填为历史订单归属，也不改写 Ledger 的归属字段。
- 去重键仍是 `(source_system, source_id, fact_kind)`；同一订单最多一条 `order_verified`。重复/并发核验由状态条件更新拒绝，后到者 409。
- 显式 `POST /admin/ledger/sync` 保留：用于历史回填、CRM/奖励来源和运营核对；已自动投影的订单会被计为 `skipped`。

## 4. 居民联系资料

`LocalOrderDetail` 新增 `residentContact { phone, address }`，只在订单详情返回：

- 电话来自 `resident_phone_identities` 的已验证号码；
- 地址来自 `resident_profiles.contact_address`；
- 缺失时返回 `null`，H5 显示「居民未提供联系电话」，不编造；
- 订单列表不返回电话。

## 5. H5 工作台

- `/workbench/local-orders`：保留状态/社区筛选，新增「待核验」快捷筛选。
- `/workbench/local-orders/:id`：展示订单、居民联系资料、核验表单（备注必填、核验通过/拒绝核验）和完整时间线。
- 网格员在 `pending_review` 只看到「拒绝核验」这一核验拒绝入口，不再同时显示普通「标记未通过」，避免两个语义重复的按钮。
- 运营员/管理员原有后台核验页面不变。

## 6. 历史兼容

- 已存在的 `verified` 订单不会被重写核验人；负责人更换只改当前经营关系。
- 历史 Ledger 事实不批量改写；新核验事务只追加缺失事实。
- 社区累计有效业绩不因交接重置；换人后新订单由新负责人核验。
- 片区暂时无网格员时，订单仍属于社区，运营员/管理员可继续核验。

## 7. 验证

- `apps/api/test/local-catalog-orders.test.ts`：真实 SQLite + Hono HTTP 覆盖居民自助下单、A/B 社区隔离、网格员核验、并发/重复核验、自动 Ledger 投影、运营员/管理员核验、负责人更换、无负责人场景与历史核验人保留。
- `apps/web/test/local-order-verification-ui.test.mjs`：H5 核验入口、联系方式缺失文案、待核验快捷筛选和 scoped service 的源码级契约测试。仓库 `apps/web` 没有 DOM 组件测试环境，交互视觉验收仍需浏览器/真机。
