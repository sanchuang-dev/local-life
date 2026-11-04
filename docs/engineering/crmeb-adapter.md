# LL-MVP-007 · CRMEB 服务端 Adapter

> 对应 [Issue #63](https://github.com/sanchuang-dev/local-life/issues/63)。本文记录 local-life 侧**最小、真实可用**的 CRMEB Adapter：配置、契约、路由、身份映射、来源归因、订单幂等回流、隔离联调方式与当前阻塞项。
>
> 上游事实依据：[crmeb-integration.md](./crmeb-integration.md)（只读调研 `sanchuang-dev/shop_crmeb` v6.0.0 源码）。本文不重复调研证据，只描述 Adapter 如何受其约束。**本实现不修改 `shop_crmeb`，不接真实资金，不代表已完成真实联调。**

## 1. 边界与现状

| 项 | 状态 |
| --- | --- |
| 商品列表/详情（outapi 只读） | 已实现，上游不可用时显式报错 |
| 居民购买跳转（CRMEB H5 深链） | 已实现，需居民登录；活动来源可选：带活动时校验已发布+同社区，自然购买无活动归属 |
| 平台 UUID ↔ CRMEB uid 映射 | 已实现，仅管理员人工核实 + 审计 |
| 来源归因（活动/网格员 claim） | 已实现，服务端解析；自然购买 `activityId=null`；`confirmed` 永不由浏览器写入 |
| 订单回流 | 已实现，**拉取式**：`order/list` 发现 + `order/<order_id>` 详情 + `refund/list` 售后扫描 |
| CRMEB 配置式推送（`push_*` / `out_push`） | **不实现**，见 §7 |
| 创建订单 / 支付 / 退款 / SSO / remote_register | **不实现，禁止依赖**，见 §9 |
| 真实 CRMEB 实例 / outapi 密钥 / 微信授权 | **当前无**，因此无法声称真实联调通过 |

目录：

```
packages/contracts/src/crmeb.ts        # 所有 DTO、上游响应 schema、路由常量、错误码
apps/api/src/crmeb/client.ts           # outapi 客户端：token 缓存/提前刷新/401 单次重取/超时
apps/api/src/crmeb/products.ts         # 商品归一化（金额分、图片、上架过滤）
apps/api/src/crmeb/identity.ts         # UUID↔crmeb_uid 绑定与居民侧状态
apps/api/src/crmeb/attribution.ts      # 购买跳转与 claim 记录
apps/api/src/crmeb/orders.ts           # 订单/售后拉取同步、状态映射、幂等与审计
apps/api/src/crmeb/routes.ts           # 公开/管理路由与权限
apps/api/src/crmeb/{audit,money,errors}.ts
apps/api/db/migrations/0002_opposite_echo.sql
apps/api/test/crmeb-*.test.ts          # node:test + 本机 HTTP SIMULATED CRMEB
```

## 2. 配置

启动时由 `loadConfig`（zod）校验；**非法值让进程失败**，不允许静默回退成看似健康的默认值。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CRMEB_BASE_URL` | 配置组必填 | CRMEB 站点根，如 `https://mall.example.com`；`http(s)` |
| `CRMEB_OUTAPI_APPID` | 配置组必填 | 后台「对外接口」账号 appid，4–30 位字母数字 |
| `CRMEB_OUTAPI_APPSECRET` | 配置组必填 | 仅服务端使用，永不返回浏览器、永不写日志 |
| `CRMEB_H5_BASE_URL` | 否 | H5 站点根；缺省时回退到 `CRMEB_BASE_URL` |
| `CRMEB_TIMEOUT_MS` | 否 | outapi 请求/取 token 超时，默认 10000，100–30000 |

规则：

- `CRMEB_BASE_URL`、`CRMEB_OUTAPI_APPID`、`CRMEB_OUTAPI_APPSECRET` **全有或全无**；只配一部分属于部署错误，启动失败。`CRMEB_H5_BASE_URL` 可选，但单独出现同样视为无效配置。
- 全无时进程正常启动，`GET /healthz` 仍 `200 ok`；所有 CRMEB 业务端点返回 `503 { error: { code: "not_configured" } }`，**绝不返回模拟商品、模拟订单或成功跳转**。
- `GET /integrations/crmeb/status` 返回 `{ configured, status, h5EntryConfigured, orderReconciliation: "outapi_pull", pushWebhook: false, detail }`，不暴露 base URL、appid、secret 或 token。

## 3. 共享契约（先契约后 API）

所有新增 DTO 位于 `packages/contracts/src/crmeb.ts` 并由 `index.ts` 导出；API 校验**上游响应**和**自身响应**都使用同一份 zod schema，不复制类型。要点：

- **金额一律整数分**（`priceCents` / `payAmountCents` / `refundAmountCents`）。CRMEB 返回 decimal 字符串（元），由 `money.ts` 按十进制数字解析：
  - `"12.30"` → `1230`，`"12"` → `1200`，`"0.30"` → `30`；
  - `"12.345"`、`"1e3"`、`"-1"`、`"abc"`、`null` → `null`（上层显式拒绝），**禁止 `Number()`/`parseFloat()`**。
- **商品**：`crmebProductId` 数字 + `id: "crmeb:<id>"`；`stockKnown: false` 恒为字面量（CRMEB outapi 不返回库存，不伪造）；`images` 中的相对路径按 CRMEB 站点根解析为绝对 URL（官方来源）。
- **订单状态**是平台自建枚举：`unpaid | unshipped | shipped | received | completed | refunding | partial_refund | refunded | unknown`。没有 `cancelled`：outapi 无 `is_cancel`/`update_time`，取消未支付单与未支付单不可区分，只能落 `unpaid` 且不计成交；不解析 `status_name` 文案。
- **归因状态**：`claimed`（服务端在活动社区内解析到在职网格员）/ `unconfirmed`（无活动、未知、越界、无 code、非网格员）/ `confirmed`（预留给未来受审计核实路径；购买跳转端点**没有任何写入口**）。
- **请求 schema 用 `strictObject`**：`gridWorkerId`、`confirmed`、`claimState`、`crmebUid` 等额外字段一律 400，不会被忽略后照常成功。

新增错误码：`crmeb_upstream_error`、`crmeb_timeout`、`crmeb_contract_mismatch`、`crmeb_sync_in_progress`；错误仍为统一 `{ error: { code, message, requestId? } }`。

## 4. outapi 客户端

`CrmebOutapiClient`（`apps/api/src/crmeb/client.ts`）：

- `POST /outapi/access_token` 用 appid/appsecret 换 JWT；缓存 `access_token` + `exp_time`（Unix 秒）。
- **提前刷新**：距 `exp_time` 不足 60 秒即刷新；已有 token 时优先 `POST /outapi/refresh_token`，refresh 路由未授权/失败则回退 `access_token`。
- **401 单次重取**：任一次调用返回 401（HTTP 401 或包络 `status=401`）→ 丢弃缓存、重新取 token、**只重试一次**；再次 401 抛 `unauthorized`（映射 503，不向浏览器暴露上游细节）。
- **超时**：`AbortSignal.timeout(CRMEB_TIMEOUT_MS)`；网络错误/超时分别映射 `crmeb_timeout` / `crmeb_upstream_error`。
- **契约校验**：包络 + 业务数据都用 zod 校验；字段漂移抛 `crmeb_contract_mismatch`，不透传未知结构。
- **安全**：token 只放 `Authori-zation` 请求头；日志只记录 method/path/状态/耗时；token、secret 不写日志、不进 URL、不回浏览器。
- `fetcher` 与 `now` 可注入，便于测试；生产使用全局 `fetch`。

## 5. 路由

### 公开

| 方法与路径 | 说明 | 未配置时 |
| --- | --- | --- |
| `GET /integrations/crmeb/status` | 适配器状态（不含密钥） | 200 `configured:false` |
| `GET /integrations/crmeb/products?page&limit&categoryId&keyword` | 商品列表；`page 1..1000`、`limit 1..100`；透传 `cate_id`/`store_name`/`type=1`；本地再按 `is_show===1` 过滤；`source:"crmeb_outapi"` + `fetchedAt` | 503 |
| `GET /integrations/crmeb/products/:crmebProductId` | 商品详情；**再判 `is_show`**（CRMEB 详情不校验上架/删除），下架返回 404；SKU 不含 stock | 503 |
| `POST /integrations/crmeb/purchase-link` | 需居民会话 + CSRF；`activityId` 可选（自然购买），见 §6 | 503 |
| `GET /integrations/crmeb/identity/me` | 当前居民绑定状态 `{linked:false}` / `{linked:true, identity}`；不返回管理员备注 | 可用 |

### 管理

| 方法与路径 | 权限 |
| --- | --- |
| `POST /admin/integrations/crmeb/identities` | staff 会话 + CSRF + `admin`，写审计 |
| `POST /admin/integrations/crmeb/orders/sync` | staff 会话 + CSRF + `admin`（全店同步仅管理员；`operator`/`grid_worker` 403） |
| `POST /admin/integrations/crmeb/identities/:platformUserId/revoke` | staff 会话 + CSRF + `admin`，写审计；撤销后可显式重绑 |

上游错误映射：无权限 → 503 `crmeb_upstream_error`（提示检查「对外接口」勾选）；超时 → 503 `crmeb_timeout`；响应漂移 → 503 `crmeb_contract_mismatch`；商品不存在/下架 → 404；未知路由仍走统一 404。

## 6. 身份映射与来源归因

### 6.1 `crmeb_identities`

| 列 | 约束 |
| --- | --- |
| `platform_user_id` | 唯一，FK `users.id` |
| `crmeb_uid` | 唯一（正整数） |
| `status` | `active` / `revoked` |
| `verification_method` | 仅 `manual_verified` |
| `verification_note` | 管理员备注，居民不可见 |
| `created_by_user_id` / `verified_at` / `created_at` / `updated_at` | 审计 |

- 绑定只允许平台侧管理员提交；普通居民没有写端点，浏览器无法写 uid。
- 重复绑定平台用户或重复 uid → 409，不静默合并。
- 审计事件 `crmeb.identity.bound`（metadata 仅 `crmebUid` + `verificationMethod`，不含手机号/备注）。
- **撤销/重绑**：管理员可撤销映射（`status=revoked`、`updated_at`、审计 `crmeb.identity.revoked`），行保留不删除；撤销后可用同一 `POST /identities` 显式重绑（更新为 `active`、写 `crmeb.identity.rebound`，记录新旧 uid）。重绑不会静默合并：`active` 行仍 409，uid 冲突仍 409。
- 居民 `GET /identity/me` 只返回 `linked` 与 `status`/`verificationMethod`/`verifiedAt`，**不回显 `crmebUid`**；撤销后返回 `{linked:false}`。
- **限制**：CRMEB 没有可验证的用户级身份断言；`/api/remote_register` **不验签、可伪造任意 uid**，Adapter 禁止调用。因此当前不存在自动绑定/SSO，只有人工核实，`verification_method` 也只允许这一种。

### 6.2 `crmeb_click_attributions`

- 字段：`click_id`（唯一）、居民 `user_id`、`activity_id`（可空）、`crmeb_product_id`、`claimed_staff_id`（可空）、`claim_state`、`referral_code_hash`、`created_at`。
- **两类购买路径**：
  - **活动购买**（传 `activityId`）：服务端校验活动必须 `published` 且属于居民所在社区（`resident_community_assignments`）；否则 404/403。此时才解析 `referralCode` 的社区归属。
  - **自然购买**（不传 `activityId`，如「惠生活」商品详情）：`activity_id` 写 NULL，`claim_state=unconfirmed`，`claimed_staff_id=null`；不查询活动、不要求社区归属，也不阻断购买。
- `referralCode` 是平台网格员（staff account）的**推荐码**，仅在活动存在时由服务端解析为 staff，并要求其 `status=active`、`role=grid_worker` 且分配到活动社区 → 才写 `claimed` 与 `claimed_staff_id`；未知码、非网格员、跨社区 → `unconfirmed`，只保留 `referral_code_hash`，`claimed_staff_id` 置 NULL（DB CHECK 保证非空 ⇒ `claimed`，响应也不回显），**不阻断购买**。
- **无活动时 `referralCode` 不能升级归属**：只记录 `referral_code_hash`，`claim_state` 保持 `unconfirmed`、`claimed_staff_id` 保持 `null`，购买照常返回 201。
- 客户端只能提交可选 `activityId`、`crmebProductId`、可选 `referralCode`；`gridWorkerId`/`confirmed`/`crmebUid` 等字段由严格 schema 直接 400。
- 返回真实 H5 链接：`{CRMEB_H5_BASE_URL}/pages/goods_details/index?id=<crmebProductId>`；**不附加 `spread`**（它是分销员 uid，不是来源字段）。响应附三条限制提示（库存以商城为准、需商城登录、深链依赖 SPA 回退）。
- 该端点**不预检商品是否存在/上架**：平台商品列表已做上架过滤，链接最终由 CRMEB 商品详情页裁决（下架/不存在时展示商城页面）；这样购买跳转不因一次额外 outapi 调用而失败，库存与可售状态仍完全以商城为准。
- 购买跳转不会调用 outapi 创建订单、不会代登录、不会代支付。

## 7. 订单回流：唯一的可信路径是拉取

**不实现 CRMEB 配置式推送**，理由（证据 §6）：

- 无 HMAC/时间戳/nonce，仅 URL query `pushToken`，无法验证来源与完整性；
- 事件仅 `order_create/order_pay/refund_create/refund_cancel/user_update`，发货/收货/完成/取消没有推送；
- 依赖 Redis + `queue:work` 常驻和 CRMEB 后台逐事件配置，失败重试约 3 次；
- 不能把「收到推送」当作订单状态真相。

因此 `POST /admin/integrations/crmeb/orders/sync` 按以下顺序执行：

1. `GET /outapi/order/list`（`page`、`limit`，可选 `sinceAddTime` → CRMEB `YYYY/MM/DD HH:mm:ss-YYYY/MM/DD HH:mm:ss` 窗口，UTC）发现订单；
2. 对每个订单调用 `GET /outapi/order/<order_id>`，**详情是 `status`/`refund_status` 的权威来源**（列表 `unset refund_status`，也无 `is_cancel`/`update_time`）；
3. `GET /outapi/refund/list` **强制**分页扫描售后（`refund_type=0` 即 >0，`page`/`limit`，默认 100/页，单次最多 100 页 = 10000 条），按 `store_order_id` 关联订单；游标写入 run；
4. 若售后扫描未从第 1 页完成、达到单次上限或出现无法解析的售后行，本次 run 记 `refund_scan_incomplete`，并把本次处理过的订单 `valid_transaction` 置 false，**绝不把未完成退款对账的订单算作有效成交**；
5. 写入镜像、追加事件、更新审计。

### 7.1 状态映射（白名单）

| 条件（优先级从上到下） | 平台状态 | 计有效成交 |
| --- | --- | --- |
| `refund_status=2` 或 `status=-2` | `refunded` | 否 |
| `refund_status=3/4` | `partial_refund` | 否 |
| `refund_status=1` 或 `status=-1` | `refunding` | 否 |
| `paid=0` | `unpaid` | 否（含取消未支付） |
| `paid=1, status=0` | `unshipped` | 是 |
| `paid=1, status=1/4` | `shipped` | 是 |
| `paid=1, status=2` | `received` | 是 |
| `paid=1, status=3` | `completed` | 是 |
| 其他整数 | `unknown` | 否（不猜测） |

补充：**任何 `refund_type>0` 的售后记录都会把该订单排除出有效成交**（保守策略，包含「拒绝退款」；对账阶段可再评审）。`refund_type` 本身不在订单详情返回，因此订单状态仍以详情为准，售后只做排除与审计。

### 7.2 幂等、事件与审计

- `crmeb_orders`：**稳定键是 CRMEB 数字 id `(channel, external_order_id)` 唯一**；`order_id` 只是展示/关联号，仅建普通索引。同步先按数字 id 查找，再按 `order_id` 比对：同一 `order_id` 换数字 id、或同一数字 id 换 `order_id` 时抛 `contract_mismatch` 并记入 run 错误，保留旧行不覆盖；重复同步走 upsert 对比，不重复记账。
- `crmeb_refunds`：`(channel, external_refund_no)` 与 `(channel, external_refund_id)` 唯一。
- `crmeb_order_events`：append-only，`unique(order_id, event_key)` 去重；`event_key` 为状态元组（`order:<paid>:<status>:<refund_status>`）或售后事件（`refund:<refund_no>:<refund_type>`）；SQLite 触发器禁止 UPDATE/DELETE。
- `crmeb_sync_runs`：每次运行记录真实触发者（`actor_user_id`）、真实角色（`actor_role`，当前仅 admin）、窗口（scope 含 refundPage/refundLimit/refundScan=mandatory/actorRole）、订单/售后游标、条数、有效成交数、追加事件数、错误摘要、起止时间。同步仅 admin 可触发；列表级失败会把 run 标 `failed` 并返回 5xx；单条失败进入错误列表、run 标 `failed` 但其余条目仍写入，可重试。
- 进程内并发守卫：重叠同步返回 409 `crmeb_sync_in_progress`；数据库唯一键兜底跨进程/重放。**多实例部署时该守卫只保证单进程**，需要数据库级锁或调度器时另行实现。
- 未知值不猜测：无法解析的金额/状态/售后结构按单条失败记录，不写入错误业务值。

## 8. 隔离联调（无真实实例时）

当前仓库内测试使用 `apps/api/test/crmeb-simulated-server.ts`：一个**仅测试内启动**的本机 HTTP 服务，显式模拟 CRMEB 的证据形状（HTTP 200 包络、`access_token/exp_time`、`{list,count}`、详情含 `refund_status`、售后单）。它**不是生产 mock**，不会在任何运行时路由中被启用。

```bash
pnpm install --frozen-lockfile
pnpm --filter @sanchuang-dev/local-life-contracts build
pnpm --filter @sanchuang-dev/local-life-api test   # 含 crmeb-client/products/identity-attribution/orders
pnpm check
```

具备真实 CRMEB 后的最小联调步骤：

1. 准备 CRMEB v6.0.0（PHP 7.1–7.4、MySQL、Redis、Nginx SPA 回退、`/install` 完成）。
2. 后台「设置 → 对外接口 → 账号管理」新建账号并勾选：`access_token`、`product/list`、`product/<id>`、分类（如需）、`order/list`、`order/<order_id>`、`refund/list`；未勾选会得到“没有访问权限”。
3. 配置 `CRMEB_BASE_URL`、`CRMEB_OUTAPI_APPID`、`CRMEB_OUTAPI_APPSECRET`、`CRMEB_H5_BASE_URL`，启动 API。
4. `GET /integrations/crmeb/status` 应为 `ready`；`GET /integrations/crmeb/products` 应返回真实商品，`source=crmeb_outapi`。
5. 用真实居民账号 POST 购买跳转，确认返回链接可直接打开商品详情（验证部署层 `try_files` 深链回退）。
6. 商城产生测试订单后，由管理员触发一次订单同步，核对 `crmeb_sync_runs` 与 `crmeb_orders`；再重复一次确认 `created=0 / unchanged=N / eventsAppended=0`。
7. 发起一笔售后，确认订单被排除有效成交，且事件表新增 `refund:*`。

## 9. 明确不支持 / 阻塞项

- **无真实 CRMEB 实例、outapi 密钥、公众号/微信支付授权**：本仓库只完成代码与隔离测试，未做真实 HTTP 联调，不能宣称「真实商品入口已验收」。
- H5 深链依赖 CRMEB 部署层的 SPA 回退（仓库默认 Nginx 规则没有），未实测。
- 不提供库存/售罄判断（outapi 不返回库存）、不展示 `status_name`、无法区分取消与未支付、无法读取订单 `refund_type`。
- **超大售后历史不在单次完整对账范围内**：单次最多 100 页 × 100 条；超过 10000 条的周期需人工分页排查，当前不会跨 run 自动合并为一轮，也不会因此把订单算作有效成交。
- 售后对账按 run 分页扫描，单次最多 10000 条；达到上限或从非第 1 页开始时，本次 run 报 `refund_scan_incomplete`、不认定有效成交，游标记录 `nextPage` 供人工排查。当前**不自动跨 run 合并为一轮完整对账**，超过单次上限的历史售后属于已知限制，不代表平台已做全量历史退款对账。
- 不实现推送接收端、不签发 `push_token_url`、不实现任何签名 webhook。
- 不调用任何 outapi 写接口；不调用 `/api/remote_register`；不实现 SSO/OIDC；不创建订单、不代登录、不代支付、不转发支付回调。
- 来源归因是**弱关联**：`referralCode` 是公开码，拿到本社区网格员码的人可以伪造 claim；因此只写 `claimed`，对账/奖励不得当作已确认归属。越界/无效码只落 hash，不落 `claimed_staff_id`。

## 10. 风险清单

| 风险 | 处理 |
| --- | --- |
| 上游契约漂移（字段改名/嵌套变化） | zod 校验 → 503 `crmeb_contract_mismatch`，不透传脏数据 |
| outapi 逐接口授权漏勾 | 403 → 503 并提示检查对外接口权限 |
| token 泄漏 | 仅服务端内存缓存；日志/响应/URL 均不含 token、secret |
| 重复/并发同步 | 唯一键 upsert + append-only 去重键 + 进程内守卫 + 运行审计 |
| 金额精度 | 十进制字符串解析为整数分，异常值显式失败 |
| 订单状态证据不足 | 白名单映射，未知落 `unknown` 且不计成交；售后记录保守排除 |
| 退款对账不完整 | 强制分页扫描 + run 游标；未完成第 1 页→末尾的 run 把订单置非有效成交并报 `refund_scan_incomplete` |
| 订单号/数字 id 漂移 | 稳定键为数字 id；冲突抛 `contract_mismatch`、保留旧行并记 run 错误 |
| 归因伪造/污染 | claim 与 confirmed 分离，浏览器不能写 confirmed；越界降级；自然购买不挂活动、无活动 referral 不升级 |
| 多实例并发 | 当前仅单进程守卫；多实例需外部分布式锁/调度 |
| 时区 | `data` 窗口按 UTC 生成；CRMEB 部署时区不同会影响窗口边界，联调需确认 |
| 分页/全量 | 订单单次仅拉一页（默认 50，最大 100），历史对账需按页/窗口重复触发；售后最多 100×100 条/run，游标（含 refundPage/nextPage）记录在 sync run |

## 11. 测试覆盖（`node:test`）

- `crmeb-client.test.ts`：decimal 金额（含 0.1+0.2 陷阱、非法值）、配置全有/全无与非法值启动失败、token 缓存、提前刷新、401 单次重取、重复 401 终止、契约漂移、超时。
- `crmeb-products.test.ts`：未配置 `not_configured` + healthz 仍 ok、列表归一化/分页/图片/单位/上架过滤、非法分页拦截、详情二次上架校验、不泄露 stock、上游 403/契约漂移显式错误。
- `crmeb-identity-attribution.test.ts`：绑定端点未认证/非管理员/无 CSRF/伪造 extra 字段拒绝、唯一约束冲突、审计写入、居民 `/me` 只返回 linked/status/method/verifiedAt（无 crmebUid）、撤销+重绑审计、越界/无效码不回显 staff id（DB CHECK 约束兜底）；购买需登录/CSRF；无活动自然购买 201（`activityId=null`、`unconfirmed`、无 staff、真实 H5 链接），无活动+合法网格员码仍 `unconfirmed`/无 staff 仅 hash，非法活动 404、跨社区 403、带活动合法码 `claimed`；伪造 `gridWorkerId`/`confirmed`/`crmebUid` 400；未配置 503。
- `crmeb-orders.test.ts`：状态白名单、拉取幂等（重复同步 created=0/events=0）、退款/未支付/未知排除、售后扫描排除、refund/list 150 条分页+游标持久化、未完成退款扫描禁止有效成交、订单号/数字 id 冲突保留旧行、`includeRefunds` 不再接受（400）、事件 append-only 触发器、同步审计（trigger/actorRole/actorUserId）、admin-only 权限/CSRF、未配置 503、列表失败留审计可重试、单条失败不掩盖其余、并发 409、身份映射参与订单归属。

## 12. 与调研文档的差异说明

- 调研 §4.4 建议的 `round(Number(price) * 100)` **未采用**：实现改为十进制字符串解析（见 §3），避免浮点丢分。
- 订单列表不含 `refund_status`（证据已注明），因此同步必须**逐单取详情**并额外扫描 `refund/list`；不能只靠列表判断退款。
- `status=-1` 在证据中是历史「申请退款中」，实现归入 `refunding`；`refund_type=3`（拒绝退款）按本卡决策仍不计有效成交，属保守处理。
