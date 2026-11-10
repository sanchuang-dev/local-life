# LL-LOT-001 · 真实「今日抽奖」奖品池

> 对应 [Issue #173](https://github.com/sanchuang-dev/local-life/issues/173)，交付基线 `dev`。
> 本文只描述本期**已交付**的内容：共享契约、独立 Drizzle 表与迁移 `0015`、活动级抽奖配置 API、
> 管理台「今日抽奖」配置入口，以及受校验的居民只读奖品池。**不包含**随机开奖、中奖结果、
> 兑换凭据或居民抽奖按钮。

## 1. 边界与关系

- 与三人团履约（`activity_prize_stocks`、`activity_reward_grants`、`activity_reward_codes`）
  **完全独立**：不复用、不修改其库存、发奖或核销口径。相关语义仍见
  [`rewards-fulfillment.md`](rewards-fulfillment.md)。
- 奖品池引用真实 `local_products` 商品，但保存**配置时快照**（名称 / 图片 / 成本）。
  商品目录后续改名、改价或上下架都不会回写奖品行。
- 「商品目录是否上架」与「奖品是否可兑现」是两个维度：商品下架后，已配置的奖品仍保留自己的
  `enabled` / `remaining_quantity`；后台会同时展示商品当前上下架状态，避免把二者混为一谈。
- 商品售价只作为配置时的**成本快照**记录，不是实时价格承诺。

## 2. 数据模型（迁移 `0015`）

### `activity_draw_pools` — 活动级每日规则

| 列 | 说明 |
| --- | --- |
| `activity_id` | 唯一；一场活动一行 |
| `community_id` | 与活动社区一致，触发器校验 |
| `enabled` | 默认 `0`（未启用） |
| `daily_draw_limit_per_resident` | 每位居民每日次数，1..100；由后续 #LOT-002 执行 |
| `no_prize_weight` | 明确「无中奖」权重，0..1,000,000 |
| `created_by_user_id` / `updated_by_user_id` | 操作者 |
| `created_at` / `updated_at` | 乐观并发令牌 |

### `activity_draw_prizes` — 独立奖品库存

| 列 | 说明 |
| --- | --- |
| `pool_id` / `activity_id` / `community_id` | 归属校验，触发器要求与活动、商品同社区 |
| `product_id` | 真实商品；`(activity_id, product_id)` 唯一 |
| `product_name` / `product_image_url` / `cost_cents` | 配置时快照 |
| `total_quantity` | 奖品总量，1..100,000 |
| `drawn_quantity` | 已抽取数量；本期不写入，由 #LOT-002 递增 |
| `remaining_quantity` | **CHECK** `drawn + remaining = total` |
| `weight` | 非负整数权重，0..1,000,000 |
| `enabled` | 奖品投放开关 |

### `activity_draw_events` — 追加式配置审计

记录 `draw_pool.created|updated|enabled|disabled` 与
`draw_prize.created|updated|enabled|disabled`。`UPDATE` / `DELETE` 被触发器拒绝。

## 3. 数据库不变量

1. 抽奖池与奖品只能属于活动所在社区；奖品商品必须同社区。
2. `remaining_quantity >= 0` 且 `drawn_quantity + remaining_quantity = total_quantity`。
3. 一旦 `drawn_quantity > 0`，奖品快照（名称 / 图片 / 成本）不可修改。关闭奖品的「投放」
   只停止后续抽取，不会追回或改写已经授予的中奖快照（后续 #LOT-002 在抽取时保存中奖快照）。
4. `drawn_quantity` 只能增加，不能回退；调整总量时剩余量按差值变化，**不会重新补回已抽取库存**。
5. 抽奖池与奖品行不可删除；配置历史以 `activity_draw_events` 追加保存。
6. 抽奖池 / 奖品身份列（活动、社区、商品、池）更新时不可改写。

## 4. HTTP 契约

共享契约位于 `packages/contracts/src/draw.ts`，路由常量 `ACTIVITY_DRAW_ROUTES`。

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `GET /activities/public/:activityId/draw-pool` | 公开 | 只返回可用奖品或明确的不可用原因，不返回权重 / 成本 |
| `GET /admin/activities/:activityId/draw-pool` | 管理员 / 运营员，社区范围内 | 后台奖品池全量视图；未配置时返回 `configured:false` |
| `POST /admin/activities/:activityId/draw-pool` | 同上 + CSRF | 创建或更新每日规则；`expectedUpdatedAt=null` 仅用于创建 |
| `POST /admin/activities/:activityId/draw-prizes` | 同上 + CSRF | 从同社区真实商品添加奖品 |
| `PATCH /admin/activities/:activityId/draw-prizes/:prizeId` | 同上 + CSRF | 调整总量 / 权重 / 投放开关 |

服务端拒绝：

- 未登录（401）、网格员（403）、跨社区读写（403）；
- 缺少 CSRF 或不可信 Origin（403）；
- 商品不存在（404）、商品与活动不同社区（400）、重复商品（409）；
- 数量 / 权重负值、越界、总量小于已抽取数量（400）；
- 启用时没有任何「已启用 + 有剩余库存 + 权重大于 0」的真实奖品（`draw_pool_not_ready`）；
- 未保存基础配置就添加奖品（`draw_pool_not_configured`）；
- 已结束活动的配置写入（`activity_unavailable`）。

`GET /activities/public/.../draw-pool` 只有在活动已发布、在起止时间内、抽奖池已启用且存在
可抽奖品时才返回 `available: true`。其余情况返回 `available: false` 与以下原因之一：
`activity_not_published`、`activity_ended`、`draw_pool_not_configured`、`draw_pool_disabled`、
`no_prize_available`。不可用响应**不携带奖品行**。

## 5. 管理台入口

活动列表的「今日抽奖」操作打开 `DrawPoolDrawer`：

- 选择活动所属社区的真实商品，填写总量与概率权重；
- 查看每个奖品的总量 / 已抽 / 剩余、快照成本、商品当前上下架状态；
- 开关奖品投放、调整库存与权重、保存每日次数与无中奖权重；
- 「一键关闭抽奖」立即让居民查询返回 `draw_pool_disabled`；
- 活动结束后整个抽屉只读。

默认状态为未配置、未启用、无奖品预填。没有真实商品 / 库存时居民端不会被展示为可抽奖。

## 6. 本卡不做

- 不执行随机开奖，不生成中奖结果或兑换码；
- 不开放居民抽奖 `POST`，不恢复 `mocks/silverLuckyPrizes.ts` 原型 UI；
- 不接微信支付、商城库存，不改三人团奖励库存与已发布奖励快照；
- 不预置任何具体奖品、价格、权重、库存或用户来源。

后续 #LOT-002 可在本表的 `drawn_quantity` / `remaining_quantity` 与 `daily_draw_limit_per_resident`
之上实现真实抽取；#LOT-003 可基于 `activity_draw_events` 与奖品快照实现履约管理。
