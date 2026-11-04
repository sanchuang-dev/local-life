# LL-MVP-007 · 独立验证报告（CRMEB Adapter + 居民 H5 商品入口）

> 验证人：verifier（R2，独立于实现者）
> 时间：2026-11-04 12:53–13:12（Asia/Shanghai）
> 工作区：`/Users/tao/Desktop/workspace/new-local-life/ll-mvp-007`，分支 `feat/ll-mvp-007-crmeb-adapter`，工作树 HEAD `1d4f000` + Issue #63 未提交变更
> 本报告只写入 `docs/engineering/evidence/ll-mvp-007/`；未修改 `apps/**`、`packages/**`、`shop_crmeb`，临时服务与脚本全部在 `/tmp/ll007/`。

## 0. 结论（先读）

**已验证通过的部分：代码契约、真实 Node API 的 HTTP 行为、真实 Chrome 浏览器中的居民 H5 入口，全部在本机隔离环境完成。**

- 未配置 CRMEB 时：`/integrations/crmeb/status` 返回 `configured=false / not_configured`，商品/详情/购买跳转返回 **HTTP 503 `error.code=not_configured`**；H5 只读状态、不请求商品、不展示任何商品或成功文案。
- 指向隔离的 **SIMULATED CRMEB（测试专用 mock，非真实商城）** 时：商品列表/详情返回契约数据；非法响应被 503 `crmeb_contract_mismatch` 拒绝；token 被 401 后自动重取并重试一次；超时在 1.51s 返回 503 `crmeb_timeout`，不会悬挂。
- 真实 Chrome headless 在 **375×812 与 320×568** 覆盖 loading / empty / error / not_configured / ready 五态、列表、详情、深链、返回、未登录购买提示、登录后自然购买与活动购买跳转、跨社区 403、无效活动 404；所有场景 `document.scrollingElement.scrollWidth === innerWidth`，商品图片 `naturalWidth=240`。
- 订单回流负例：管理端重复同步两次，第二次 `created=0 / unchanged=4 / eventsAppended=0`；退款、售后、未支付订单 `valid_transaction=0`，只有一笔正常已支付订单计为有效成交；事件表 append-only 触发器与归因 CHECK 约束均生效。
- 未认证/越权、客户端伪造来源字段（`gridWorkerId`、`confirmed`、`claimState`、`crmebUid`）全部被拒绝，未产生归因记录。

**明确未验证 / 阻塞：本机没有真实 CRMEB 实例（无 PHP/MySQL/Redis/Docker）、没有真实 outapi 凭证、没有公众号授权与支付商户号。** 因此：

- **不得把本报告解读为“真实 CRMEB 商城联调通过”或“真实商品入口已验收”。**
- 隔离 mock 的响应形状按 [`docs/engineering/crmeb-integration.md`](../../crmeb-integration.md) 的真实源码调研结论编写，但它本身是 invented data，日志与商品名均带 `SIMULATED` 标记。
- 真实 token 生命周期、真实订单数据、真实图片域名、CRMEB H5 的 SPA 深链回退、微信登录/支付、配置式推送均未在本机验证。

## 1. 环境与边界

| 项 | 值 |
| --- | --- |
| Node / pnpm | v22.23.2 / 10.19.0 |
| Chrome | Google Chrome 156.0.8078.80（`--headless=new` + CDP） |
| API | 真实 `apps/api`，SQLite `/tmp/ll007/*.sqlite`，`PORT=4080` |
| H5 | Vite dev server `http://localhost:5173/local-life/`（`WEB_PORT=5173`，`/api` 代理到 4080） |
| CRMEB | **无真实实例**；隔离 mock `http://127.0.0.1:4099`，测试账号 `simapp1234/simsecret`（仅本地） |
| 数据库隔离 | `/tmp/ll007/unconfigured2.sqlite`、`/tmp/ll007/configured.sqlite`；不写仓库 `.data` |

API 启动方式（真实进程，非内存注入）：

```bash
# 未配置 CRMEB
env NODE_ENV=development HOST=127.0.0.1 PORT=4080 \
  DATABASE_PATH=/tmp/ll007/unconfigured2.sqlite AUTH_DEV_ENABLED=true \
  WEB_BASE_URL=http://localhost:5173/local-life/ \
  TRUSTED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 \
  node --import tsx src/index.ts        # cwd=apps/api

# 指向隔离 SIMULATED CRMEB
env NODE_ENV=development HOST=127.0.0.1 PORT=4080 \
  DATABASE_PATH=/tmp/ll007/configured.sqlite AUTH_DEV_ENABLED=true \
  WEB_BASE_URL=http://localhost:5173/local-life/ \
  TRUSTED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 \
  CRMEB_BASE_URL=http://127.0.0.1:4099 \
  CRMEB_OUTAPI_APPID=simapp1234 CRMEB_OUTAPI_APPSECRET=simsecret \
  CRMEB_H5_BASE_URL=http://127.0.0.1:4099 CRMEB_TIMEOUT_MS=1500 \
  node --import tsx src/index.ts        # cwd=apps/api
```

H5：`env LOCAL_LIFE_API_PORT=4080 LOCAL_LIFE_WEB_PORT=5173 pnpm --filter @sanchuang-dev/local-life-web dev`。

> 任务描述中的 `/shop/*` 是旧称。当前契约 `CRMEB_ROUTES` 的实际路由是 `/integrations/crmeb/*` 与 `/admin/integrations/crmeb/*`，仓库中不存在 `/shop/*` 路由。下文对实际注册路由逐条取证。

代码快照（验证时工作树，`sha256sum` 摘要）：

```
97bbc8a4… packages/contracts/src/crmeb.ts
9fc30ba7… apps/api/src/crmeb/orders.ts
198baa5f… apps/api/src/crmeb/routes.ts
f7f684d0… apps/api/src/crmeb/attribution.ts
40b55cc0… apps/api/db/migrations/0002_opposite_echo.sql
ceaa4204… apps/web/src/components/life/ShopProductCard.tsx
e0fdf74d… apps/web/src/components/life/ShopProductDetail.tsx
80e5193a… apps/web/src/hooks/useShopProducts.ts
0e1dedf7… apps/web/src/pages/LifePage.tsx
```

> 并发说明：验证期间另一位成员在 13:03–13:05 更新了 `schema.ts`/`contracts`/`crmeb/*` 并重新生成迁移为 `0002_opposite_echo.sql`。本报告的所有 HTTP、SQLite 与浏览器证据均在重建数据库、重启 API 后针对**该最终快照**重跑（13:09–13:11）。旧的本地 DB 因迁移 journal `when` 变化会重复执行 0002 而启动失败，属于未提交迁移被重新生成后的本地环境现象，见 §8.3。

## 2. 未配置 CRMEB：真实 HTTP 与 H5

### 2.1 curl（真实 API 4080）

| 请求 | 结果 |
| --- | --- |
| `GET /healthz` | **200** `{"status":"ok",...}`（未配置不影响健康检查） |
| `GET /integrations/crmeb/status` | **200** `{"configured":false,"status":"not_configured","h5EntryConfigured":false,...}` |
| `GET /integrations/crmeb/products?page=1&limit=20` | **503** `{"error":{"code":"not_configured",...}}` |
| `GET /integrations/crmeb/products/12` | **503** `not_configured` |
| `POST /integrations/crmeb/purchase-link`（无会话） | **401** `unauthorized`（先认证、后配置，符合预期） |
| 同上，已登录居民 | **503** `not_configured` |
| `GET /integrations/crmeb/identity/me`（居民） | **200** `{"linked":false}`（身份查询不依赖商城配置） |
| 经 Vite 代理 `GET /api/integrations/crmeb/status` | **200** `not_configured`（同源代理路径正确） |
| 经 Vite 代理 `GET /api/integrations/crmeb/products` | **503** `not_configured` |

原始输出（节选）：

```text
### 2. GET /integrations/crmeb/status (no CRMEB config)
{"configured":false,"status":"not_configured","h5EntryConfigured":false,
 "orderReconciliation":"outapi_pull","pushWebhook":false,
 "detail":"未配置 CRMEB_BASE_URL、CRMEB_OUTAPI_APPID、CRMEB_OUTAPI_APPSECRET；不会返回任何模拟商品或订单"}
HTTP 200

### 3. GET /integrations/crmeb/products (no config)
{"error":{"code":"not_configured","message":"CRMEB 商城未配置，真实商品、购买跳转与订单同步均不可用",...}}
HTTP 503

### 9b. POST /api/integrations/crmeb/purchase-link as logged-in resident (no CRMEB config)
{"error":{"code":"not_configured","message":"CRMEB 商城未配置，真实商品、购买跳转与订单同步均不可用",...}}
HTTP 503
```

> 早期一条 CSRF 403 是登录后 token 轮换导致的测试脚本旧 token，不是产品缺陷；使用登录响应返回的新 CSRF 后得到上表 9b 的 503。

### 2.2 未配置 H5（Chrome headless，真实渲染）

| 场景 | 视口 | 截图 | DOM 断言 |
| --- | --- | --- | --- |
| 优惠购列表 | 375×812 | [01-unconfigured-life-375.png](./01-unconfigured-life-375.png) | 「优惠购尚未接入商城」；`productTiles=0`；**只请求 `status`，从不请求 `products`** |
| 优惠购列表 | 320×568 | [02-unconfigured-life-320.png](./02-unconfigured-life-320.png) | 同上；`scrollWidth=320` |
| 商品详情 | 375×812 | [03-unconfigured-detail-375.png](./03-unconfigured-detail-375.png) | 「商城未配置」；无购买按钮；只请求 `status`/`session`/`auth methods` |
| 商品详情 | 320×568 | [04-unconfigured-detail-320.png](./04-unconfigured-detail-320.png) | 同上；`scrollWidth=320` |

机器可读证据：[unconfigured-browser.json](./unconfigured-browser.json) 记录每个场景的 `apiRequests`、`productTiles`、`scrollWidth`、完整 `innerText`。关键摘录：

```json
"unconfigured-list-375": {
  "apiRequests": [
    {"method":"GET","url":"/api/integrations/crmeb/status"},
    {"method":"GET","url":"/api/integrations/crmeb/status"}
  ],
  "productTiles": 0,
  "scrollWidth": 375
}
```

> 两次 `status` 来自 Vite dev + React StrictMode 的双重 effect；生产构建不会重复。重点是**没有任何 `products` 请求，也没有商品节点**。

## 3. 隔离 SIMULATED CRMEB（明确非真实商城）

- 脚本：`/tmp/ll007/mock-crmeb.mjs`（测试专用，不进入仓库）；每条日志前缀 `[SIMULATED CRMEB]`；商品名、图片、页面均带 `SIMULATED` 字样。
- 监听 `127.0.0.1:4099`，只实现 outapi 读取路径与一个 mock H5 页面；没有 PHP/MySQL/Redis，不接触 `shop_crmeb`。
- 响应形状严格按 `docs/engineering/crmeb-integration.md`：

```text
-- envelope
{"status":200,"msg":"ok","data":{...}}
-- token
{"status":200,"msg":"ok","data":{"access_token":"simulated.jwt...","exp_time":<unix 秒>,"auth_info":{...}}}
-- product/list row keys
["attrs","cate_id","cate_name","description","id","image","is_show","ot_price",
 "price","slider_image","spec_type","store_info","store_name"]     # price 均为 string
-- order/list row keys（无 refund_status/refund_type/status_name/is_cancel/update_time）
["add_time","id","items","order_id","paid","pay_price","pay_time","pay_type","status","total_price","uid"]
-- order detail（有 refund_status）
{"id":9002,"order_id":"SIM-ORDER-9002","paid":1,"status":2,"refund_status":2,"pay_price":"8.00"}
-- refund/list
{"id":8001,"store_order_id":9002,"order_id":"SIM-REFUND-8001","refund_type":1,
 "refund_price":"8.00","refunded_price":"8.00",...}
```

mock 的日志同时证明 token 重取（见 §4）。**再次强调：以上是模拟数据，不是真实商城返回。**

## 4. 商品读取与客户端韧性（真实 API → 模拟 CRMEB）

完整请求/响应见 `/tmp/ll007/configured-curl.txt`（验证后临时保留于 /tmp）。

| # | 场景 | HTTP | 结果 |
| --- | --- | --- | --- |
| A | `/status`（已配置） | 200 | `configured=true,status=ready,h5EntryConfigured=true` |
| B | 商品列表 | 200 | 返回 2 个上架商品；mock 原始 `count=3` 中含 1 个 `is_show=0` 商品，被 adapter 过滤；`source=crmeb_outapi`、金额 `priceCents=1230/800`、`stockKnown=false` |
| C | 商品详情 101 | 200 | 金额、分类、SKU、`detailHtml`、图片绝对 URL 正确；`skus[].priceCents=1230/1500` |
| D | 下架商品详情 103 | 404 | `not_found`「已下架或不可售」 |
| E | 上游不存在 404 | 404 | `not_found` |
| F | 非法金额详情 105（`"abc"`） | 503 | `crmeb_contract_mismatch`「price 不是合法 decimal 金额」 |
| G | 非法列表响应（缺 price） | 503 | `crmeb_contract_mismatch`「list.0.price」 |
| H | 合法空目录 | 200 | `items:[] total:0`（H5 empty 态依赖此响应） |
| I | token 失效一次 | 200 | adapter 收到 401 → 重新 `access_token` → 只重试一次成功 |
| J | 上游 5s 延迟、客户端 1500ms 超时 | 503 | `crmeb_timeout`，实测 `total_time=1.510230s`，**不悬挂** |

token 重取的 mock 日志：

```text
[GET /outapi/product/list] tokenKnown=true
[SIMULATED CRMEB] {"note":"SIMULATED 401 to force token re-acquisition"}
[POST /outapi/access_token]
[GET /outapi/product/list] tokenSuffix=989052 tokenKnown=true   # 新 token，重试成功
```

## 5. H5 五态与真实浏览器流程（Chrome headless 375/320）

所有截图位于本目录；机器可读证据：[browser-configured.json](./browser-configured.json)（含每个场景完整 `innerText`、`apiRequests`、`postData`、图片 `naturalWidth`、`scrollWidth`、新窗口 URL）。所有场景：

```text
document.scrollingElement.scrollWidth === innerWidth   # 375 或 320，无横向溢出
```

### 5.1 五态

| 状态 | 视口 | 截图 | 渲染证据 |
| --- | --- | --- | --- |
| **loading** | 375×812 | [07-loading-life-375.png](./07-loading-life-375.png) | 延迟 product/list 后真实渲染「正在读取 CRMEB 商城商品…」骨架 |
| **empty** | 375×812 | [08-empty-life-375.png](./08-empty-life-375.png) | 「商城暂无可购商品」+「不会用演示商品填充，也不会模拟下单」 |
| **error** | 375×812 | [09-error-life-375.png](./09-error-life-375.png) | 「商品加载失败」、`crmeb_contract_mismatch`、`list.0.price`、可重试 |
| **not_configured** | 375/320 | [01](./01-unconfigured-life-375.png)–[04](./04-unconfigured-detail-320.png) | 见 §2.2；0 商品、无成功文案 |
| **ready** | 375×812 | [05-ready-life-375.png](./05-ready-life-375.png) | 两张商品卡、价格 ¥12.30/¥8.00；图片 `naturalWidth=240`、`complete=true` |
| **ready** | 320×568 | [06-ready-life-320.png](./06-ready-life-320.png) | 两列布局不溢出，`scrollWidth=320` |

### 5.2 列表 / 详情 / 深链 / 返回

| 场景 | 截图 | 结果 |
| --- | --- | --- |
| 详情（未登录）375 | [10-ready-detail-375-logged-out.png](./10-ready-detail-375-logged-out.png) | 真实详情、图片、SKU；「购买需先登录居民账户」；无购买按钮；**无 purchase-link 请求** |
| 详情（未登录）320 | [11-ready-detail-320-logged-out.png](./11-ready-detail-320-logged-out.png) | 同上，`scrollWidth=320` |
| 活动深链列表 | [12-activity-deeplink-life-375.png](./12-activity-deeplink-life-375.png) | `#/life?tab=deals&activityId=…` 默认打开优惠购，展示「来源活动：验证活动A（SIMULATED 来源）」「已发布」 |
| 深链进入详情 | [13-activity-deeplink-detail-375.png](./13-activity-deeplink-detail-375.png) | URL 保留 `activityId`；「活动来源：深链携带，提交前核验」 |
| 返回 | [14-return-to-list-375.png](./14-return-to-list-375.png) | 点击「返回惠生活」回到 `#/life?tab=deals&activityId=…`，来源提示与列表均保留 |

### 5.3 购买入口与真实跳转（目标是 mock H5 URL）

| 场景 | 截图 | 请求/跳转证据 |
| --- | --- | --- |
| 登录后自然购买 | [15](./15-logged-in-detail-375.png) / [16](./16-natural-purchase-375.png) | 请求体 **`{"crmebProductId":101}`**；新窗口真实打开 `http://127.0.0.1:4099/pages/goods_details/index?id=101`；claim `activityId=null`、`unconfirmed`、`claimedStaffId=null` |
| 活动购买（本社区 + 网格员码） | [17](./17-activity-purchase-ready-375.png) / [18](./18-activity-purchase-375.png) | 请求体 **`{"activityId":"07a983d4-…","crmebProductId":101,"referralCode":"9f615b32-…"}`**；新窗口指向同一 mock H5 URL；claim `claimed`（文档明确 claim≠confirmed） |
| 跨社区活动 | [19](./19-cross-community-detail-375.png) / [20](./20-cross-community-403-375.png) | 点击购买发送 POST 后被服务端 **403**「该活动不属于你所在的社区」；未创建归因记录；无新窗口 |
| 无效活动 | [21](./21-invalid-activity-404-375.png) | 活动来源不可用「活动不存在」，购买按钮不渲染，仅提供「重新核验来源 / 忽略活动来源」；未发出 purchase-link |

请求体中**没有** `gridWorkerId`、`confirmed`、`claimState`、`crmebUid` 等浏览器可自填的归属字段；字段清单由共享 strict schema 限定。

数据库中的浏览器购买归因（真实 SQLite）：

```text
activity_id                          product  claim_state   claimed_staff_id                      hash_len
(空)                                 101      unconfirmed   (空)                                  (空)      # 自然购买
07a983d4-…                           101      claimed       9f615b32-…                            64        # 活动 + 网格员码
```

## 6. 订单回流负例（真实 API + SQLite）

### 6.1 重复同步与权限

- 未登录：**401**；普通居民会话（无 staff）：**401**；网格员：**403**「只有管理员可以触发订单同步」；运营员：**403**；管理员：**200**。
- 管理员连续同步两次（同一 mock 窗口）：

```text
#1: orders {scanned:4, created:4, unchanged:0, failed:0}
    refunds {scanned:2, created:2, unchanged:0, unmatched:0}
    validTransactions:1, eventsAppended:6
#2: orders {scanned:4, created:0, unchanged:4, failed:0}
    refunds {scanned:2, created:0, unchanged:2, unmatched:0}
    validTransactions:1, eventsAppended:0
```

SQLite 复核（第二次同步后计数未增加）：

```text
orders=4, order_events=6, refunds=2, sync_runs=2
```

### 6.2 退款 / 售后 / 未支付不计有效成交

| 外部单号 | paid | raw_status | refund_status | 平台 status | valid_transaction | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| SIM-ORDER-9001 | 1 | 0 | 0 | unshipped | **1** | 唯一有效成交 |
| SIM-ORDER-9002 | 1 | 2 | 2 | refunded | **0** | 已退款 |
| SIM-ORDER-9003 | 0 | 0 | 0 | unpaid | **0** | 未支付（outapi 无法区分取消，按证据文档落 unpaid） |
| SIM-ORDER-9004 | 1 | 3 | 0 | completed | **0** | 存在售后单 `refund_type=2`，保守排除 |

售后单镜像与事件去重键：

```text
refunds: 8001/9002 refund_type=1 800分；8002/9004 refund_type=2 1990分
events:  9001 order:1:0:0
         9002 order:1:2:2 | refund:SIM-REFUND-8001:1
         9003 order:0:0:0
         9004 order:1:3:0 | refund:SIM-REFUND-8002:2
```

### 6.3 审计事件不可篡改

```text
UPDATE crmeb_order_events ... -> Error: crmeb_order_events rows are append-only (19)
DELETE FROM crmeb_order_events ... -> Error: crmeb_order_events rows are append-only (19)
-- mutation blocked 后 event 数仍为 6
```

归因表 CHECK 约束（防止 `unconfirmed` 行携带 staff 归属）：

```text
INSERT ... claim_state='unconfirmed', claimed_staff_id=<grid staff>
-> Error: CHECK constraint failed: crmeb_click_attributions_staff_claim_check (19)
```

## 7. 归因与权限负例

| 场景 | 结果 |
| --- | --- |
| 未登录 POST purchase-link | **401**，不写归因 |
| `gridWorkerId` / `confirmed` / `claimState` / `crmebUid` 自填 | 4 种 payload 全部 **400**；无归因行（strictObject） |
| 无活动自然购买 | **201**，`activityId=null`、`unconfirmed`、`claimedStaffId=null` |
| 无活动 + 合法网格员码 | **201**，仍 `unconfirmed`、`claimedStaffId=null`，仅保存 64 位 hash（无活动即无社区作用域） |
| 本社区活动 + 同社区在职网格员码 | **201**，`claimState=claimed`、`claimedStaffId` 有值 |
| 本社区活动、无码 | **201**，`activityId` 有值但 `unconfirmed` |
| 跨社区活动 | **403**，不写归因 |
| 不存在/未发布活动 | **404**，不写归因 |
| 活动创建（普通居民） | **401** 无管理后台会话 |
| 身份绑定：无会话 / 居民 | **401**；运营员 **403**；管理员 **201** |
| 身份绑定重复（同居民 / 同 uid） | **409** + **409** |
| 居民 `GET identity/me` | **200**，只返回 `crmebUid/status/verificationMethod/verifiedAt`，不泄露管理员 note 或平台 UUID |

## 8. 发现、风险与未验证项

### 8.1 已观察到的低风险行为（不阻塞验收，建议记录）

1. **列表 `total` 与展示条数不一致**：mock 上游 `count=3` 含 1 个下架商品，adapter 过滤后 `items=2` 但仍透传 `total=3`，H5 显示「共 3 件」。这是对上游 `count` 的忠实透传，但分页/文案可能让居民误以为有 3 件可买。建议后续明确 `total` 语义（上游总数 vs 可售数）。
2. **H5 文案**：页面头部写「优惠购接入真实 CRMEB 商品」，在指向 mock 时也显示「真实商城商品」；本次 mock 数据在商品名/图片/详情中均带 `SIMULATED`，截图不会冒充真实商城。但若未来接入测试环境，建议 UI 对非生产上游有额外标识。
3. **开发态重复请求**：Vite dev + React StrictMode 导致 `status` 等 effect 请求各出现两次；生产构建不重复。未发现重复下单或重复归因。

### 8.2 阻塞：真实环境未具备（不得宣称真实联调通过）

- 无真实 CRMEB v6.0.0 实例（本机无 PHP/MySQL/Redis/Docker），无法验证真实 outapi 网关、真实 `Authori-zation` token 生命周期、真实 `refresh_token` 行为。
- 无 outapi appid/appsecret，无法验证 「对外接口」逐接口白名单与真实错误码。
- 无微信公众号 AppID/AppSecret/回调域名，居民 H5 仅用 `AUTH_DEV_ENABLED=true` 的开发登录；真实微信网页授权未验证。
- 无微信支付商户号，购买只到「跳转 CRMEB H5」为止；真实下单/支付/退款未验证。
- CRMEB H5 深链的部署层 SPA 回退（`try_files`）未实测；当前 mock 页面直接返回 200，不能证明真实 CRMEB Nginx 配置可用。
- 真实商品图片、真实订单数据、配置式推送（`push_*`）未验证；本实现按设计不接收推送，只做拉取。
- 未验证真实并发同步（只做了顺序重复同步）；代码内 `syncRunning` 互斥未在真实并发请求下压测。

### 8.3 环境提示：迁移重新生成会让旧本地 DB 启动失败

验证中途，另一位成员把未提交的 `0002_*.sql` 重新生成为 `0002_opposite_echo.sql`，`_journal.json` 的 `when` 变化，导致用旧迁移创建的本地 DB 在下次启动时重复执行 0002 并报 `table crmeb_click_attributions already exists`。**这不是已提交态的缺陷**：PR 中只会有一份 0002，全新 DB 正常。建议：迁移文件冻结后不要再次 `db:generate`；已有本地 DB 用 `pnpm db:local:setup` 重建或删除 `.data/*.sqlite`。

## 9. 复现步骤

```bash
# 0) 构建共享契约
pnpm --filter @sanchuang-dev/local-life-contracts build

# 1) 未配置 API + H5
(cd apps/api && env NODE_ENV=development HOST=127.0.0.1 PORT=4080 \
  DATABASE_PATH=/tmp/ll007/unconfigured2.sqlite AUTH_DEV_ENABLED=true \
  WEB_BASE_URL=http://localhost:5173/local-life/ \
  TRUSTED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 \
  node --import tsx src/index.ts) &
env LOCAL_LIFE_API_PORT=4080 LOCAL_LIFE_WEB_PORT=5173 \
  pnpm --filter @sanchuang-dev/local-life-web dev &
curl -sS -i http://127.0.0.1:4080/integrations/crmeb/status
curl -sS -i http://127.0.0.1:4080/integrations/crmeb/products
# Chrome CDP 截图：/tmp/ll007/capture-unconfigured2.mjs

# 2) 隔离 SIMULATED CRMEB（测试专用）
node /tmp/ll007/mock-crmeb.mjs &        # 127.0.0.1:4099，日志带 [SIMULATED CRMEB]
# 3) 配置版 API + 隔离 SQLite + 测试 staff/社区/活动
(cd apps/api && node --import tsx /tmp/ll007/seed.mjs)
#    启动命令见 §1；然后运行 /tmp/ll007/configured-curl.txt 的 curl 序列
# 4) 真实浏览器五态/深链/购买（Chrome headless + CDP）
node /tmp/ll007/capture-configured2.mjs
# 5) 管理端/归因/同步负例
bash /tmp/ll007/http-scenarios.sh
# 6) SQLite 计数与约束
sqlite3 /tmp/ll007/configured.sqlite \
  "SELECT external_order_no,status,valid_transaction FROM crmeb_orders;"
```

> `/tmp/ll007/*.mjs`、`*.sh` 是本次验证的临时辅助脚本，**故意不提交进仓库**；本文与 JSON 保留其输出与断言。API/H5/mock 进程在验证结束后已停止，仓库工作树只增加本目录证据。

## 10. 证据文件清单

| 文件 | 说明 |
| --- | --- |
| `01`–`04-*.png` | 未配置 CRMEB：列表/详情 × 375/320 |
| `05`–`11-*.png` | ready 列表（375/320）、loading、empty、error、未登录详情（375/320） |
| `12`–`14-*.png` | 活动深链列表、深链详情、返回列表 |
| `15`–`18-*.png` | 登录后详情、自然购买结果、活动购买准备/结果（均指向 mock H5） |
| `19`–`21-*.png` | 跨社区 403、无效活动 404 |
| `unconfigured-browser.json` | 未配置浏览器 DOM/请求/宽度机器证据 |
| `browser-configured.json` | 已配置浏览器全场景 DOM/请求体/新窗口/图片证据 |
| `verification.md` | 本报告 |

---

# 11. post-t8 聚焦复验（最终代码快照）

> **本节是 t8 修复后的补充证据，不重写 §0–§10 的历史结论。**
> §0–§10 对应 t4 快照（t8 修复前，13:09–13:11）；t8 修改了退款扫描、退款分页、订单稳定键、身份撤销与同步权限，因此订单/退款/权限及 H5 购买回归以本节为准。

## 11.1 快照与范围

- 时间：2026-11-04 13:23–13:27（Asia/Shanghai）
- 工作树：`feat/ll-mvp-007-crmeb-adapter`，HEAD `1d4f000` + Issue #63 未提交变更；t8 修复已落盘（13:14–13:15）
- 代码摘要（验证时实际文件）：

```text
2c2cd71b… apps/api/src/crmeb/orders.ts
4e1b49cf… apps/api/src/crmeb/routes.ts
542a0cbe… apps/api/src/crmeb/identity.ts
fcf62fdd… apps/api/src/crmeb/audit.ts
60037fab… apps/api/src/db/schema.ts
97bbc8a4… packages/contracts/src/crmeb.ts
40b55cc0… apps/api/db/migrations/0002_opposite_echo.sql
```

- 环境：Node v22.23.2、pnpm 10.19.0、Chrome 156.0.8078.80；**无真实 CRMEB/PHP/MySQL/Redis**。
- 数据：全新 `/tmp/ll007/t8.sqlite`（从当前 `0002_opposite_echo.sql` 迁移创建，未复用旧 DB）；隔离 mock 为 `/tmp/ll007/mock-crmeb-t8.mjs`，日志前缀 `[SIMULATED CRMEB]`。
- 本节的 mock 仍是 invented data；**未连接真实商城，不能据此宣称真实联调通过**。

## 11.2 复验结论（逐条）

| # | 复验项 | 结论 |
| --- | --- | --- |
| 1 | `includeRefunds` 开关不可用；退款扫描强制 | **通过**：`includeRefunds=false/true` 均 400；成功运行 `scope.refundScan="mandatory"` |
| 2 | 退款分页：目标退款在第 2 页仍排除订单 | **通过**：150 条退款、`pagesScanned=2`、`complete=true`、`validTransactions=0`；目标退款行已落库 |
| 3 | 重复/并发同步不重复记账 | **通过**：顺序第二次 `created=0/events=0`；并发一个 409、一个 200，行数/事件数不变；append-only 与 CHECK 生效 |
| 4 | 订单稳定键冲突不覆盖、留错误、留旧行 | **通过**：同 `order_id` 数字 id 9001→19001 时 `failed=1`、`contract_mismatch`，旧行 9001 保留，无 19001 行 |
| 5 | 身份撤销/重绑与 operator 权限 | **通过**：401/403 负例；admin 撤销 200、居民 `linked:false`；重绑 201、`linked:true` 且无 crmebUid；审计记录真实 admin actor |
| 6 | H5 回归（未配置 503、自然/活动购买、跨社区 403） | **通过**：真实 Chrome 375×812 截图 8 张，全部无横向溢出；自然/活动购买真实打开 mock H5；跨社区 UI 403；未配置 H5 0 商品且只请求 status |
| 7 | `pnpm install --frozen-lockfile` / `pnpm check` | **通过**：install exit 0；check exit 0（web 61/61、API 53/53、scripts 7/7） |

## 11.3 退款扫描不可关闭（SEC-01）

`crmebOrderSyncRequestSchema` 已删除 `includeRefunds`，`strictObject` 会把该字段直接判为非法；一次正常同步的 scope 明确记录 `refundScan: "mandatory"`。

```bash
curl -sS -b t8-admin.jar -w '\nHTTP %{http_code}\n' \
  -X POST http://localhost:5173/api/admin/integrations/crmeb/orders/sync \
  -H 'content-type: application/json' -H 'origin: http://localhost:5173' \
  -H "x-csrf-token: $ADMIN_CSRF" --data '{"includeRefunds":false}'
```

```text
{"error":{"code":"invalid_request","message":"同步参数不正确",...}}
HTTP 400
```

`{"includeRefunds":true}` 与 `{"page":1,"limit":50,"includeRefunds":false}` 同样 **400**。首次正常同步响应（节选）：

```json
{"status":"succeeded",
 "scope":{"page":1,"limit":50,"refundPage":1,"refundLimit":100,
          "refundScan":"mandatory","actorRole":"admin"},
 "orders":{"scanned":4,"created":4,"failed":0},
 "refunds":{"scanned":2,"created":2,"unmatched":0},
 "validTransactions":1,"eventsAppended":6}
```

同步完成后 SQLite 只有 `SIM-ORDER-9001` 为有效成交；已退款 9002、未支付 9003、售后 9004 均为 0（同 §6.2，结果未回归）。

## 11.4 退款分页与游标（SEC-02）

mock `refunds_paged` 模式：订单列表只返回 `SIM-ORDER-9010`（paid=1、status=0、refund_status=0），`refund/list` 返回 **150 条**；第 1 页（limit=100）全是与本地订单无关的 filler，**属于 9010 的退款 `SIM-REFUND-9010`（id=7101）位于第 2 页第一行**。如果只扫第一页，就会漏掉它。

```bash
printf '%s\n' '{"mode":"refunds_paged"}' > /tmp/ll007/mock-mode.json
curl ... -X POST .../orders/sync --data '{"page":1,"limit":50,"refundLimit":100}'
```

响应（关键字段）：

```json
{"status":"succeeded",
 "orders":{"scanned":1,"created":1,"failed":0},
 "refunds":{"scanned":150,"created":150,"unmatched":149},
 "validTransactions":0,"eventsAppended":2,
 "cursor":{"refunds":{"page":2,"pageSize":100,"pagesScanned":2,
                      "nextPage":null,"hasMore":false,"complete":true}},
 "errors":[]}
```

SQLite 证明目标退款确实落库并把订单排除：

```text
external_refund_no  external_refund_id  external_order_id  refund_type
SIM-REFUND-9010     7101                9010               1

external_order_no  valid_transaction  event_key
SIM-ORDER-9010     0                  order:1:0:0
SIM-ORDER-9010     0                  refund:SIM-REFUND-9010:1
```

补充负例：从 `refundPage=2` 开始扫描时，即使第 2 页能读到目标退款，也因“未从第 1 页完整完成”返回：

```json
{"status":"failed","refunds":{"scanned":50,"unmatched":49},
 "validTransactions":0,
 "cursor":{"refunds":{"complete":false,"pagesScanned":1}},
 "errors":[{"scope":"refund","code":"refund_scan_incomplete",
            "message":"售后扫描未从第 1 页完整完成，本次不认定任何有效成交"}]}
```

> 这验证了游标/完整性语义：不完整扫描不会把订单误计为有效成交。本机只造了 150 条模拟退款；真实 CRMEB 的 `refund/list` 排序、`count` 与时间窗未验证。

## 11.5 重复与并发同步（SEC-02/幂等）

顺序同步两次：

```text
#1: orders {scanned:4, created:4, unchanged:0, failed:0}
    refunds {scanned:2, created:2}, validTransactions:1, eventsAppended:6
#2: orders {scanned:4, created:0, unchanged:4, failed:0}
    refunds {scanned:2, created:0, unchanged:2}, validTransactions:1, eventsAppended:0
```

并发（mock `slow_refund` 延迟 1.2s，两个 admin 同步同时发出）：

```text
A HTTP 409 {"error":{"code":"crmeb_sync_in_progress",
                     "message":"已有 CRMEB 订单同步正在运行，请稍后重试"}}
B HTTP 200 {"status":"succeeded", "eventsAppended":0, ...}
```

并发后 SQLite 计数仍为 `orders=5, events=8, refunds=152`（本轮新增 9010 后），没有重复订单/事件；`crmeb_sync_runs` 只新增 1 行。审计事件触发器与归因 CHECK 仍生效：

```text
UPDATE crmeb_order_events ... -> Error: crmeb_order_events rows are append-only (19)
DELETE FROM crmeb_order_events ... -> Error: crmeb_order_events rows are append-only (19)
-- event 数仍为 8
INSERT ... claim_state='unconfirmed', claimed_staff_id=<grid>
-> Error: CHECK constraint failed: crmeb_click_attributions_staff_claim_check (19)
```

## 11.6 订单稳定键冲突（SEC-03）

先正常同步（9001 已存在），再让 mock 返回同 `order_id` 但数字 `id=19001`：

```text
status: failed
orders: {scanned:1, created:0, updated:0, unchanged:0, failed:1}
errors: [{"scope":"order","externalOrderNo":"SIM-ORDER-9001",
          "code":"contract_mismatch",
          "message":"CRMEB order_id SIM-ORDER-9001 的数字 id 由 9001 变为 19001，保留旧行"}]
```

SQLite：

```text
SIM-ORDER-9001 | external_order_id=9001 | valid_transaction=1   # 旧行保留
rows_with_19001 = 0                                           # 未静默插入/覆盖
```

该运行 `actor_role=admin`、`actor_user_id=<verify-admin user id>`、`trigger=admin_manual`，错误写入 `crmeb_sync_runs.errors_json`。

## 11.7 身份撤销/重绑与 operator 权限（SEC-04/05）

| 请求 | 结果 |
| --- | --- |
| 未认证 bind / revoke | **401** |
| 居民 bind / revoke | **401**（无 staff 会话） |
| operator bind / revoke | **403**（仅 admin） |
| admin bind uid=1001 | **201 active** |
| 重复 active bind | **409** |
| 居民 `/identity/me`（active） | **200** `{"linked":true,"identity":{"status":"active","verificationMethod":"manual_verified","verifiedAt":...}}`，**无 crmebUid** |
| admin revoke | **200** `status:"revoked"` |
| 居民 `/identity/me`（revoked） | **200** `{"linked":false}` |
| admin 用新 uid=1002 重绑 | **201 active** |
| 居民 `/identity/me`（rebound） | **200** `linked:true`，仍无 crmebUid |

审计（真实触发者，非客户端自填）：

```text
crmeb.identity.bound    actor=verify-admin user 目标=居民UUID metadata={"crmebUid":"1001",...}
crmeb.identity.revoked  actor=verify-admin user 目标=居民UUID metadata={"previousCrmebUid":"1001"}
crmeb.identity.rebound  actor=verify-admin user 目标=居民UUID metadata={"previousCrmebUid":"1001","crmebUid":"1002",...}
```

同步权限：无会话/居民 **401**；grid_worker/operator **403**“只有管理员可以触发订单同步”；admin **200**。`crmeb_sync_runs.actor_role` 恒为 `admin`，`actor_user_id` 为真实 admin 用户 UUID。

## 11.8 H5 与 purchase-link 回归（post-t8）

真实 Chrome headless（375×812）重新捕获，截图与 JSON：

| 场景 | 截图 | 结果 |
| --- | --- | --- |
| ready 列表 | [post-t8-01-ready-list-375.png](./post-t8-01-ready-list-375.png) | 2 个 SIMULATED 商品、图片 naturalWidth=240、`scrollWidth=375` |
| 登录后自然详情 | [post-t8-02-natural-detail-375.png](./post-t8-02-natural-detail-375.png) | 「已登录居民账户」、购买按钮可见 |
| 自然购买结果 | [post-t8-03-natural-purchase-375.png](./post-t8-03-natural-purchase-375.png) | POST body **`{"crmebProductId":101}`**；新窗口 `http://127.0.0.1:4099/pages/goods_details/index?id=101` |
| 活动详情 | [post-t8-04-activity-detail-375.png](./post-t8-04-activity-detail-375.png) | 活动 A、深链、网格员码 |
| 活动购买结果 | [post-t8-05-activity-purchase-375.png](./post-t8-05-activity-purchase-375.png) | POST body 含 `activityId` + `referralCode`；新窗口同一 mock H5 URL；claim `claimed` |
| 跨社区详情 | [post-t8-06-cross-community-ready-375.png](./post-t8-06-cross-community-ready-375.png) | 活动 B 深链可用 |
| 跨社区购买拒绝 | [post-t8-07-cross-community-403-375.png](./post-t8-07-cross-community-403-375.png) | POST 后 UI「无法提交购买来源 / forbidden」，**无新窗口**，不写归因 |
| 未配置列表 | [post-t8-08-unconfigured-list-375.png](./post-t8-08-unconfigured-list-375.png) | 「优惠购尚未接入商城」、0 商品、只请求 `status`；API `products` **503 not_configured** |

机器证据：[post-t8-browser.json](./post-t8-browser.json)、[post-t8-unconfigured-browser.json](./post-t8-unconfigured-browser.json)。SQLite 归因表共 4 行（curl 自然购买+活动购买各 1、浏览器自然购买+活动购买各 1）；跨社区 403 未新增归因行。7 个已配置场景全部：

```text
document.scrollingElement.scrollWidth === innerWidth === 375
```

未配置 API 的 curl：

```text
GET /integrations/crmeb/status -> 200 configured=false/not_configured
GET /integrations/crmeb/products -> 503 {"error":{"code":"not_configured",...}}
```

> 本节只复跑 375 宽度；320 宽度的完整 t8 前证据见 §5（H5 文件在 t8 中未修改）。新增截图同样只使用 SIMULATED 数据。

## 11.9 构建与测试（post-t8）

```text
pnpm install --frozen-lockfile -> exit 0 (Done in 554ms)
pnpm check -> exit 0
  oxlint: 0 errors
  typecheck: contracts/admin/api/web 全部 Done
  web tests: 8 files / 61 tests passed
  API tests: 53 passed, 0 failed
  scripts tests: 7 passed, 0 failed
  build: contracts/api/web/admin 全部 Done
```

完整日志：`/tmp/ll007/t8-install.log`、`/tmp/ll007/t8-check.log`（临时文件，未提交）。

## 11.10 仍不可验证 / 阻塞（未因 t8 改变）

- **无真实 CRMEB 实例**：无 PHP/MySQL/Redis/Docker，无法验证真实 outapi token 生命周期、真实 `refund/list` 分页排序/时间窗、真实订单与售后数据。
- **无 outapi appid/appsecret**：无法验证真实“对外接口”白名单与真实错误码。
- **无微信公众号授权**：H5 使用 `AUTH_DEV_ENABLED=true` 开发登录；真实微信网页授权未验证。
- **无支付商户号**：购买止于跳转 CRMEB H5，真实下单/支付/退款未验证。
- **CRMEB H5 SPA 回退未实测**：mock 页面直接 200，不能证明真实 Nginx `try_files`。
- 退款分页只造了 150 条模拟数据；未验证 >10000 条/周期的跨 run 合并（文档已声明不承诺全量历史）。
- 并发只验证单进程 `syncRunning` 互斥；未做多实例/多进程并发压测。
- 本节所有结论均为“**修复后隔离复验通过**”，**不是真实商城联调通过**。


---

## 12. rebase 到最新 dev 后的迁移编号说明（追加，不改动上文证据）

上文（§0–§11）的证据是在 `feat/ll-mvp-007-crmeb-adapter` 基于 `origin/dev@1d4f000` 的工作树上采集的，当时 CRMEB 迁移编号为 `0002_opposite_echo.sql`。

集成阶段分支 rebase 到 `origin/dev`（含 #60 `0002_nosy_white_queen`、#61 `0003_crm_core`）后，CRMEB 迁移按 Drizzle 顺序重新生成为 **`0004_polite_black_bird.sql`**（DDL 与 append-only 触发器等价），因此上文出现的“0002”仅指迁移编号，不是当前文件名。功能、HTTP 契约、H5 行为与负例结论不受编号变化影响；rebase 后已重新执行 `pnpm install --frozen-lockfile` 与 `pnpm check`（API 77/77、web 61/61、scripts 7/7、全量构建通过），并在全新 SQLite 上验证迁移可应用。真实 CRMEB 实例/凭证/微信/支付仍未具备，阻塞结论不变。
