# LL-MVP-007 · CRMEB 真实接口调研与 Adapter 契约建议

> 对应 [Issue #63](https://github.com/sanchuang-dev/local-life/issues/63)。本文只做**只读代码调研**：调查对象为 `sanchuang-dev/shop_crmeb`，结论用于约束 local-life 侧最小 Adapter 与共享契约，**不代表已完成真实联调、真实支付或生产验收**。

## 0. 结论摘要

### 0.1 一句话结论

CRMEB-KY v6.0.0 可以作为「商品展示 + 居民跳转购买 + 订单只读回流」的外部商城，但**不能**作为平台的下单/支付/身份中心：

- **可安全依赖**：outapi 的商品/分类只读接口、订单/售后只读接口、`access_token` 认证、按接口白名单授权；居民 H5 商品详情深链（**前提是部署层已配置 SPA 回退**，见 §7.5）。
- **可选择性依赖**：配置式订单推送（需 Redis + 队列 worker；无签名、事件不全）；outapi 建号/查号（以手机号为键，能力有限）。
- **明确不可依赖**：平台侧创建订单、游客下单、库存/售罄判断、通用来源归因字段、全量状态变更通知、OAuth/SSO/签名身份断言、签名 webhook、支付回调转发。

### 0.2 对 Captain 线索的复验结论（含一处纠正）

| Captain 线索 | 复验结论 | 证据 |
| --- | --- | --- |
| CRMEB v6.0.0（ThinkPHP6） | **确认**。`CRMEB-KY v6.0.0` / `version_code=600`；`topthink/framework v6.1.2` | `crmeb/.version:1-6`、`crmeb/composer.lock:4618-4620` |
| `crmeb/app/outapi` 是服务端 OpenAPI，`POST outapi/access_token` 用 appid/appsecret 换 JWT | **确认**。响应字段是 `access_token` / `exp_time` / `auth_info`，不是 OAuth2 的 `expires_in` | `crmeb/app/outapi/route/route.php:16-23`、`crmeb/app/services/out/OutAccountServices.php:52-73` |
| 中间件按 `system_route` 的 `app_name=outapi` 做逐接口授权 | **确认**。`OutAccount.rules` 存 `system_route.id` 逗号串；每次请求按 method+path 比对，不匹配抛 `您暂时没有访问权限` | `crmeb/app/services/out/OutInterfaceServices.php:33-52`、`crmeb/app/services/out/OutAccountServices.php:96-98` |
| 居民端 `/api/v1` 需商城用户 token（微信/手机号登录） | **确认**。`/api/**` 的会员组统一挂 `AuthTokenMiddleware(true)`；下单接口在该组内 | `crmeb/app/api/route/v1.php:121-122,213-235,376` |
| 支付回调仅 CRMEB 内部 notify | **基本确认**（不只微信）：`/api/pay/notify/{wechat,v3wechat,alipay,routine,allin*}` 都是 CRMEB 自己的渠道回调，`notify_url` 指向 CRMEB；没有转发给第三方的配置 | `crmeb/app/api/controller/v1/PayController.php:33-60`、`crmeb/crmeb/services/app/WechatService.php:92` |
| **「未发现面向第三方的订单推送 webhook」** | **需纠正**：存在**配置式订单推送**（`OutAccount.push_*` + `OutPushListener` + `OutPushJob` + `out_push`）。但它不是标准签名 webhook：无 HMAC/时间戳/nonce，事件类型靠「每个事件一个 URL」区分，payload 是订单/售后详情 JSON，且依赖 Redis 队列 worker。详见 §6 | `crmeb/app/listener/out/OutPushListener.php:22-68`、`crmeb/app/jobs/OutPushJob.php:31-158`、`crmeb/app/common.php:1230-1249`、`crmeb/public/install/crmeb.sql:27554-27576` |

### 0.3 证据分级约定

- **【代码证实】**：仓库源码/安装 SQL 直接可见，行号可复核。
- **【代码推断】**：由代码路径、ThinkPHP/框架行为推导，未在真实实例验证。
- **【未知】**：仓库内无证据，或必须由部署方/真实接口返回确认。

本次调研环境**无 PHP/MySQL/Redis/Docker**（本机 `command -v php|mysql|redis-server|docker` 全部 NOT_FOUND），因此所有结论均为静态代码证据，**没有发起过任何真实 HTTP 请求**。

---

## 1. 调查基线与方法

- 调查对象：`sanchuang-dev/shop_crmeb`，`HEAD=da8d3b93`（提交说明 `update v6.0.0`），本地只读克隆在 `/tmp/shop_crmeb_probe`（`git status` 干净，未修改、未提交）。
- 主要阅读范围：`crmeb/app/outapi`、`crmeb/app/api`、`crmeb/app/services`、`crmeb/app/dao`、`crmeb/app/model`、`crmeb/config`、`crmeb/public/install`、`template/uni-app`、`help/dev-docs`、`help/docker`。
- 未检视：`crmeb/public/static`、`crmeb/public/pages` 下的编译产物（体积大、无源码信息）。
- 引用路径均相对于 `shop_crmeb` 仓库根，`crmeb/...` 前缀即其子目录。

---

## 2. 版本与部署要求

### 2.1 版本

| 项 | 值 | 证据 |
| --- | --- | --- |
| 产品 | CRMEB-KY | `crmeb/.version:1` |
| 版本 | v6.0.0，`version_code=600` | `crmeb/.version:1-2` |
| 发行渠道 | `platform=GITHUB` | `crmeb/.version:3` |
| 框架 | ThinkPHP `v6.1.2` | `crmeb/composer.lock:4618-4620` |
| JWT 库 | `firebase/php-jwt v5.0.0`（HS256） | `crmeb/composer.lock:1227-1229`、`crmeb/crmeb/utils/JwtAuth.php:54,79` |
| 队列 | `topthink/think-queue`（Redis 驱动） | `crmeb/config/queue.php:15-40` |
| 雪花 ID | `godruoyi/php-snowflake 1.0.9` | `crmeb/composer.lock:1279-1281` |

### 2.2 运行时硬门槛

- PHP **7.1.0 ≤ version < 8.0.0**，否则入口直接 `exit`：`crmeb/public/index.php:15-20`；安装器同样检查：`crmeb/public/install/index.php:21-26`。
- 若 `public/install/` 存在且无 `public/install.lock`，入口会跳转安装向导：`crmeb/public/index.php:25-27`。
- 依赖 `vendor/autoload.php` 与 ThinkPHP HTTP 应用：`crmeb/public/index.php:29-40`。
- 安装器会生成 `.env`，其中 `APP_KEY = crmeb` 为**固定值**（不是随机密钥）：`crmeb/public/install/.env:1`、`crmeb/public/install/index.php:378-407`。

### 2.3 依赖组件（官方帮助文档）

| 组件 | 要求 | 证据 |
| --- | --- | --- |
| PHP | 7.1 / 7.4；需 fileinfo、redis、json、mbstring、openssl、pdo、mysqlnd、curl、zip、gd 等扩展 | `help/dev-docs/phpapi/系统安装流程文档.md:8-70,420-480` |
| MySQL | 5.7 / 8.0 | 同上 |
| Redis | 可选 3.0 / 7.0；**但队列默认 Redis**，订单推送/异步任务依赖它 | `crmeb/config/cache.php:18`、`crmeb/config/queue.php:15-22`、`help/dev-docs/phpapi/系统队列任务文档说明.md:6-40` |
| Nginx | 1.18，站点根指向 `public` | `help/dev-docs/phpapi/系统安装流程文档.md:420-480` |
| 进程 | 需常驻 `php think queue:work` 队列消费者；另有 `workerman`/`timer` 命令 | `crmeb/config/queue.php:15-40`、`crmeb/config/console.php:26-32`、`help/dev-docs/phpapi/系统队列任务文档说明.md:282-300` |

### 2.4 站点与路由

- 多应用模式：`auto_multi_app=true`，应用名即 URL 第一段（`/outapi/...`、`/api/...`、`/adminapi/...`）：`crmeb/config/app.php:35-47`。
- 后台前端编译产物在 `public/admin`，入口 `/admin`；后台路由前缀配置为 `admin`：`crmeb/config/app.php:60-61`、`crmeb/public/admin/index.html:1`。
- H5 编译产物入口为 `public/index.html`，静态资源在 `/static`、`/pages/*/static`：`crmeb/public/index.html:1`。
- **H5 是 history 路由**（`mode: history`、`base: ""`）：`template/uni-app/manifest.json:219-245`。
- 仓库自带 Nginx/Apache 规则**只把不存在的路径 rewrite 到 `index.php`**，没有 `index.html` 回退：`crmeb/public/nginx.htaccess:1-6`、`crmeb/public/.htaccess:1-8`、`help/docker/nginx/vhost.conf:10-15`。
  - **【代码推断】** 直接访问 `/pages/goods_details/index?id=1` 这类 H5 深链，会被 rewrite 到 ThinkPHP 而非 SPA，返回 404/路由错误。
  - **【未知】** 具体商户是否在部署层额外加了 `location /pages { try_files $uri /index.html; }`。若没有，居民端无法从平台深链到 CRMEB 商品详情。这是**上线前必须实测的阻塞项**。
  - **【未知】** 根路径 `/` 返回 H5 还是 ThinkPHP，取决于 Nginx `index` 指令顺序（仓库 Docker 配置是 `index index.php index.html`，PHP 优先）。H5 首页与 API 共用 `public` 根目录，部署时必须确认 `/` 能打开 SPA。

### 2.5 安装流程要点

- 上传代码 → 站点根指向 `public` → 浏览器访问 `/install` → 环境检测 → 填 MySQL/Redis → 导入 `public/install/crmeb.sql` → 生成 `.env` 与 `install.lock`：`crmeb/public/install/index.php:1-60,378-407`、`crmeb/README.md`。
- 默认后台路径 `/admin`；`site_url` 会在安装时写入，后续支付回调、微信授权、二维码都依赖它：`crmeb/public/install/crmeb.sql:33712`（`site_url`）、`crmeb/crmeb/services/app/WechatService.php:92`。
- 需给 `runtime/`、`public/uploads/` 写权限（安装/上传/缓存）：`crmeb/public/install/index.php` 环境检测段、`crmeb/README.md`。

---

## 3. 认证：outapi `access_token`

### 3.1 端点与请求

| 项 | 值 | 证据 |
| --- | --- | --- |
| 基础路径 | `/outapi` | `crmeb/config/app.php:38-47`、`crmeb/app/outapi/route/route.php:16-23` |
| 获取 token | `POST /outapi/access_token` | `crmeb/app/outapi/route/route.php:18` |
| 请求体 | `appid`（4-30 位字母数字）、`appsecret`（必填） | `crmeb/app/outapi/controller/Login.php:48-59`、`crmeb/app/outapi/validate/LoginValidate.php:19-26` |
| 刷新 | `POST /outapi/refresh_token`，body `access_token` | `crmeb/app/outapi/controller/Login.php:65-72` |
| 响应包络 | `{status:200,msg:"操作成功",data:{access_token,exp_time,auth_info}}` | `crmeb/crmeb/utils/Json.php:38-57`、`crmeb/app/services/out/OutAccountServices.php:68-72` |
| token 类型 | JWT HS256，`jti={id,type}`，`type=out` | `crmeb/crmeb/utils/JwtAuth.php:41-57`、`crmeb/app/services/out/OutAccountServices.php:220-223` |
| 有效期 | `exp = strtotime('+ 30day')`；缓存 TTL `exp-iat+60` | `crmeb/crmeb/utils/JwtAuth.php:41-57,75-82,92-101` |
| 请求头 | `Authori-zation: <jwt>`；也接受 `Authori-zation: Bearer <jwt>`（实现是 `ltrim($header, 'Bearer')` 字符集裁剪，不是严格前缀，JWT 以 `eyJ` 开头所以实际可用） | `crmeb/app/outapi/middleware/AuthTokenMiddleware.php:39-52` |
| 服务端可撤销 | 是。token 必须存在于 Cache（key=`md5(token)`，tag=`out`）；刷新会删除旧 key | `crmeb/app/services/out/OutAccountServices.php:207-235,147-171` |
| 账号禁用 | `status=2` 拒绝；登录时 `status=0` 拒绝 | `crmeb/app/services/out/OutAccountServices.php:61-63,190-195` |

> 响应字段不是 OAuth 的 `expires_in`/`token_type`。`exp_time` 是**绝对 Unix 时间戳**（`JwtAuth` 里的 `exp`）。
> 刷新语义是「删旧发新」：`refresh()` 先 `delete($md5Token)` 再 `createToken`，旧 token 立即失效；刷新响应只有 `access_token` / `exp_time`，没有 `auth_info`（`crmeb/app/services/out/OutAccountServices.php:147-172`）。

### 3.2 请求处理链与逐接口授权

`AuthTokenMiddleware` 做三件事：取 header → `parseToken` 校验缓存/JWT → 写入 `outId`/`outInfo` 宏；随后 `OutInterfaceServices::verifyAuth` 按规则表鉴权。

- 取 header 与剥 `Bearer`：`crmeb/app/outapi/middleware/AuthTokenMiddleware.php:39-52`。
- 解析 token：缓存存在性 → JWT 解析 → `type=out` → 验签/过期：`crmeb/app/services/out/OutAccountServices.php:207-235`。
- 规则比对：`OutAccount.rules`（逗号串）→ 查 `system_route` 中 `id in rules AND app_name='outapi'` 的 `method,path`；当前请求的 `rule` 与 `method` 必须命中；`<x>` 会归一化为 `{x}`：`crmeb/app/services/out/OutInterfaceServices.php:33-52`。
- 不命中：`AuthException('您暂时没有访问权限')`：同上 `:49-51`。
- 异常包络：HTTP 仍为 200，`status=400/自定义 code`、`msg` 为错误信息：`crmeb/app/outapi/OutApiExceptionHandle.php:78-94`、`crmeb/crmeb/utils/Json.php:59-67`。

**注意**：`rules` 为空或未勾选对应接口时，**不是「默认全开」而是「全部拒绝」**（`in` 空串匹配不到任何路由）。这是最常见的「token 拿到了但 403」原因。

### 3.3 权限配置表（outapi `system_route` 种子）

Adapter 需要的最小集合如下（安装 SQL 内置，后台勾选时按名称选择）：

| 用途 | `system_route.id` | method | path | 证据 |
| --- | --- | --- | --- | --- |
| 换 token | 804 | POST | `access_token` | `crmeb/public/install/crmeb.sql:50050`（`eb_system_route` id=804） |
| 刷新 token | 805 | POST | `refresh_token` | `crmeb/public/install/crmeb.sql:50050`（id=805） |
| 分类列表 | 806 | GET | `category/list` | `crmeb/public/install/crmeb.sql:50050`（id=806） |
| 分类详情 | 807 | GET | `category/<id>` | `crmeb/public/install/crmeb.sql:50050`（id=807） |
| 商品列表 | 812 | GET | `product/list` | `crmeb/public/install/crmeb.sql:50050`（id=812） |
| 商品详情 | 815 | GET | `product/<id>` | `crmeb/public/install/crmeb.sql:50050`（id=815） |
| 订单列表 | 818 | GET | `order/list` | `crmeb/public/install/crmeb.sql:50050`（id=818） |
| 订单详情 | 819 | GET | `order/<order_id>` | `crmeb/public/install/crmeb.sql:50050`（id=819） |
| 售后列表 | 829 | GET | `refund/list` | `crmeb/public/install/crmeb.sql:50050`（id=829） |
| 售后详情 | 832 | GET | `refund/<order_id>` | `crmeb/public/install/crmeb.sql:50050`（id=832） |
| 用户列表（手机号查 uid） | 840 | GET | `user/list` | `crmeb/public/install/crmeb.sql:50050`（id=840） |
| 新增用户 | 841 | POST | `user` | `crmeb/public/install/crmeb.sql:50050`（id=841） |
| 修改用户 | 842 | PUT | `user/<uid>` | `crmeb/public/install/crmeb.sql:50050`（id=842） |
| 用户详情 | 1696 | GET | `user/info/<uid>` | `crmeb/public/install/crmeb.sql:50050`（id=1696） |

分类目录种子（后台「对外接口」树）：`公共接口/商品分类/商品/订单/售后/优惠券/用户`，`app_name=outapi`、cate id 85-91：`crmeb/public/install/crmeb.sql:51367-51373`。

### 3.4 后台如何创建账号与授权

1. 登录后台 `/admin`。
2. 菜单：**设置 → 对外接口 → 账号管理**（菜单 path `/setting/system_out_account/index`，父菜单 `对外接口` path `/setting/other_out_config`）：`crmeb/public/install/crmeb.sql:48891-48892`（`eb_system_menus` id=1064/1066）。
3. 新增账号：填 `appid`、`appsecret`、描述，并在接口树勾选上表接口：`crmeb/app/adminapi/controller/v1/setting/SystemOutAccount.php:84-102`。
4. 服务端行为：`appsecret` 明文另存 `apppwd`，同时 `password_hash` 存 `appsecret`；`rules` 数组 `implode(',')`：同上 `:94-97`。
5. 推送配置在同一页的「设置推送接口」：`push_open`、`push_account`、`push_password`、`push_token_url`、四个事件 URL、`user_update_push`：`crmeb/app/adminapi/controller/v1/setting/SystemOutAccount.php:139-154`。
6. 账号表结构：`crmeb/public/install/crmeb.sql:27554-27576`。

### 3.5 认证安全评估

| 风险 | 说明 | 证据 |
| --- | --- | --- |
| 密钥明文留存 | `apppwd` 明文存库；后台可回显/测试 | `crmeb/public/install/crmeb.sql:27558`、`crmeb/app/adminapi/controller/v1/setting/SystemOutAccount.php:94` |
| JWT 密钥固定 | 安装模板 `APP_KEY=crmeb`，全站默认一致 | `crmeb/public/install/.env:1` |
| 但 token 伪造被缓存兜底 | 验签前先要求 `md5(token)` 在缓存中存在，单靠知道密钥伪造 token 不能通过 | `crmeb/app/services/out/OutAccountServices.php:213-226` |
| Bearer 前缀处理粗糙 | 用 `ltrim($header, 'Bearer')` 按字符集裁剪，不是严格前缀匹配；若 token/头格式异常可能误伤 | `crmeb/app/outapi/middleware/AuthTokenMiddleware.php:39` |
| 权限是「路由白名单」而非数据权限 | outapi 账号可见**全店**订单/用户，不能按平台来源隔离 | `crmeb/app/services/order/OutStoreOrderServices.php:61-76` |

**给 Adapter 的要求**：`appsecret` 只放服务端环境变量/密钥管理；对下不发 token；对 CRMEB 的调用统一走 Adapter，不把 outapi 暴露给浏览器。

---

## 4. 商品与分类接口

### 4.1 商品列表 `GET /outapi/product/list`

请求参数（源码实际读取）：

| 参数 | 类型/默认 | 语义 | 证据 |
| --- | --- | --- | --- |
| `cate_id` | int/string | 分类过滤；顶级分类→`cid`，子分类→`sid` | `crmeb/app/outapi/controller/StoreProduct.php:36-60` |
| `store_name` | string | 关键词；实际模糊匹配 `keyword/store_name/store_info/id/bar_code` | `crmeb/app/model/product/product/StoreProduct.php:152-168` |
| `type` | int，默认 1 | 1=上架（`is_show=1 AND is_del=0`）；2=下架；3=非会员；4=零库存；5=低库存；6=已删除；7=非虚拟 | `crmeb/app/model/product/product/StoreProduct.php:312-348` |
| `is_live` | int，默认 0 | `is_live=1` 时**排除**已绑定直播商品（`live_goods` 中 `audit_status<>3`） | `crmeb/app/dao/product/product/StoreProductDao.php:154-157` |
| `is_new` | int | 新品 | `crmeb/app/model/product/product/StoreProduct.php:175-178` |
| `is_virtual` | int，默认 -1 | 0=实体商品 | `crmeb/app/model/product/product/StoreProduct.php:269-274` |
| `is_presale` | int，默认 -1 | ≥0 时过滤 `presale` | `crmeb/app/model/product/product/StoreProduct.php:281-286` |
| `page` / `limit` | int | 分页；`limit` 最大 100，`limit=0` 或 `page=0` 表示不分页 | `crmeb/config/database.php:82-91`、`crmeb/app/services/BaseServices.php:59-72`、`crmeb/app/dao/product/product/StoreProductDao.php:125-191` |

强制条件与排序：

- 控制器强制 `is_del=0`：`crmeb/app/outapi/controller/StoreProduct.php:36-60`。
- **没有强制 `is_show=1`**；只有传 `type=1` 时才加上架条件。默认 `type=1`，但调用方若显式传其他值会看到下架商品。
- 默认排序 `sort desc, id desc`：`crmeb/app/dao/product/product/StoreProductDao.php:125-191`。
- 分页只在 `page && limit` 时生效；`limit` 的声明上限 100：`crmeb/config/database.php:82-91`、`crmeb/app/services/BaseServices.php:59-72`。

返回字段（`searchList` 选择 + 关联 `description`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | int | 商品主键 |
| `image` | string | 主图 URL（相对/绝对取决于上传配置） |
| `slider_image` | array | 轮播图；Model getter 做 `json_decode` |
| `store_name` | string | 商品名 |
| `store_info` | string | 卖点/短描述 |
| `keyword` | string | 关键词 |
| `bar_code` | string | 条码 |
| `cate_id` | int[] | 分类 id 数组（字符串按逗号拆分后 `intval`） |
| `cate_name` | string | 分类名（逗号拼接，附加字段） |
| `price` | string | 售价，**单位元，两位小数字符串**（MySQL decimal） |
| `ot_price` | string | 划线价 |
| `vip_price` | string | 会员价 |
| `is_vip` | int | 是否会员商品 |
| `postage` | string | 邮费 |
| `unit_name` | string | 单位 |
| `sort` | int | 排序 |
| `is_show` | int | 上架状态（**客户端必须自行过滤**） |
| `cost` | string | 成本价 |
| `spec_type` | int | 0=单规格，1=多规格 |
| `spu` | string | SPU |
| `freight` | int | 运费模板 id |
| `description` | string | 商品详情 HTML（列表也带，因 `with(['description'])`） |

证据：`crmeb/app/services/product/product/OutStoreProductServices.php:358-382`、`crmeb/app/model/product/product/StoreProduct.php:98-101`、`crmeb/app/services/product/product/OutStoreProductServices.php:370-379`。

**关键缺口**：列表**没有 `stock` 字段**，无法判断是否有货。

### 4.2 商品详情 `GET /outapi/product/<id>`

- 入参是**数字商品 id**（不是 UUID/order_id），路径参数：`crmeb/app/outapi/controller/StoreProduct.php:82-85`。
- 字段比列表多：`is_limit`、`limit_type`、`limit_num`、`give_integral`、`cate_name`、`description`、`attrs`、`items`：`crmeb/app/services/product/product/OutStoreProductServices.php:252-350`。
- 有规格（`spec_type=1`）时返回 `attrs`（SKU 列表）与 `items`（规格维度）；**每个 SKU 都 `unset(stock)`**：`crmeb/app/services/product/product/OutStoreProductServices.php:310-331`。
- 无规格时 `items=[]`，`attrs` 只有一项默认值（价格/图片/条码/重量等），同样**无 stock**：同上 `:332-349`。
- **没有 `is_del` / `is_show` 校验**：`dao->get($id)` 只按主键查；下架/软删商品仍可读：`crmeb/app/dao/BaseDao.php:184-194`、`crmeb/app/services/product/product/OutStoreProductServices.php:262-269`。
- **副作用**：若商品没有规格结果记录，详情接口会**写库补默认规格并改 `spec_type=0`**。即「GET 详情」可能产生写操作：`crmeb/app/services/product/product/OutStoreProductServices.php:284-309`。
- 返回 `cate_id` 会转成 int 数组、`cate_name` 逗号串：同上 `:271-278`。

**价格单位**：所有金额字段均为 MySQL `decimal(12,2)`，PDO 返回**字符串**，单位元；Model 无 `$type` 金额转换。订单商品行还会 `sprintf("%.2f")` 兜底：`crmeb/app/services/order/OutStoreOrderServices.php:271-283`。

### 4.3 分类列表 `GET /outapi/category/list`

- 控制器强制 `pid=-2`（表示不限层级），并读取 `is_show`：`crmeb/app/outapi/controller/StoreCategory.php:41-63`。
- DAO 里 **`is_show=1` 硬编码**，`pid=-2` 不按 pid 过滤；`name` 过滤只看 `name`，不看 `cate_name`：`crmeb/app/dao/product/product/StoreCategoryDao.php:200-219`。
- Service 结果被 `CacheService::remember('CATEGORY_LIST', ..., 86400)` 缓存 **24 小时**，且**命中缓存时忽略查询条件**：`crmeb/app/services/product/product/StoreCategoryServices.php:350-355`。
- 分类详情 `GET /outapi/category/<id>` 返回 `id,cate_name,pid,pic,big_pic,sort,is_show`：`crmeb/app/outapi/controller/StoreCategory.php:114-118`。
- **【代码推断】** 后台改分类后，最长 24 小时内外接口仍返回旧数据；Adapter 需接受该延迟或本地缓存同样 TTL。

### 4.4 商品侧最小可依赖契约

Adapter 只需以下规范化字段（其余原样透传或丢弃）：

```
id, name, summary, images[], priceCents, originalPriceCents,
categoryIds[], categoryNames, isOnShelf, specType, detailHtml,
skus[{skuKey, priceCents, image, specText}]   // 无库存
```

- `priceCents = round(Number(price) * 100)`，避免浮点。
- `isOnShelf` 取 `is_show===1`，并且**详情也要再判一次**（详情不校验）。
- 不提供「库存/可售」；H5 的「立即购买」只能作为跳转，不能承诺有货。

---

## 5. 订单与售后接口

### 5.1 订单列表 `GET /outapi/order/list`

控制器读取的参数：

| 参数 | 语义 | 证据 |
| --- | --- | --- |
| `status` | 订单状态过滤；内部改名 `order_status` | `crmeb/app/outapi/controller/StoreOrder.php:41-57`、`crmeb/app/services/order/OutStoreOrderServices.php:61-67` |
| `paid` | 0/1；非数字转为 -1（等于不过滤） | 同上 `:65-67` |
| `pay_type` | 支付方式，支持 `weixin/yue/offline/alipay/...` 或 1-4 | `crmeb/app/dao/order/StoreOrderDao.php:150-180`、`crmeb/app/services/pay/PayServices.php:26-55` |
| `real_name` | **模糊搜索**：匹配 `order_id/real_name/user_phone`，并关联用户昵称/uid/phone、商品名 | `crmeb/app/dao/order/StoreOrderDao.php:50,181-205` |
| `is_del` | 用户删除标记；不传则不过滤 | `crmeb/app/dao/order/StoreOrderDao.php:49-56` |
| `data` | 时间范围；映射到内部 `time`，按 `add_time` 过滤 | `crmeb/app/outapi/controller/StoreOrder.php:41-57`、`crmeb/app/Request.php:58-86` |
| `type` | 活动类型过滤：1=普通单（无拼团/秒杀/砍价/预售）、2=拼团、3=秒杀、4=砍价、5=预售、6=有佣金；空值不过滤 | `crmeb/app/dao/order/StoreOrderDao.php:127-149` |
| `field_key` | 与 `real_name` 同传时，按指定字段精确匹配；不传则走上面的模糊搜索 | `crmeb/app/dao/order/StoreOrderDao.php:51-52,165-168` |
| `order` | 控制器读取，但 `getOutOrderList` 不读 `$where['order']`，**无效果**（固定 `add_time DESC,id DESC`） | `crmeb/app/outapi/controller/StoreOrder.php:41-57`、`crmeb/app/dao/order/StoreOrderDao.php:901-906` |
| `page` / `limit` | 分页，同商品；`limit` 最大 100 | `crmeb/app/services/BaseServices.php:59-72` |

强制条件：

- `is_system_del=0`（排除后台删除）。
- `pid=0`（只返回主订单，**拆单子订单不可见**）。
- 证据：`crmeb/app/outapi/controller/StoreOrder.php:41-57`。

`status` 的真实语义（**注意与表注释不一致**）：

`getOrderList` 把 `status` 改成 `order_status` 后，DAO 的第一个 `status` 分支（支持 -1/-2/-3/9 等）**被跳过**，只走 `order_status` 分支，因此只有 5 个值生效：

| 入参 `status` | 实际条件 | 语义 |
| --- | --- | --- |
| `0` | `status=0 AND refund_status=0 AND is_del=0` | 未发货（含未支付，**未排除 `is_cancel`**） |
| `1` | `paid=1 AND status=1 AND refund_status IN (0,3) AND is_del=0`（若额外传 `shipping_type` 还会限 `shipping_type=1`） | 已发货/待收货 |
| `2` | `paid=1 AND status=2 AND refund_status IN (0,3) AND is_del=0` | 已收货/待评价 |
| `3` | `paid=1 AND status=3 AND refund_status IN (0,3) AND is_del=0` | 交易完成 |
| `-2` | `paid=1 AND status=-2 AND is_del=0` | 已退款 |
| 其他（-1、4、5、6、9…） | 不进入任何分支 | **等于不按状态过滤** |

证据：`crmeb/app/dao/order/StoreOrderDao.php:47-126`（尤其 `:107-126`）。

返回结构：`{list:[...], count:int}`：`crmeb/app/services/order/OutStoreOrderServices.php:61-76`。

列表行字段（`getOrderList` 选择 + `tidyOrderList` 追加）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | int | 订单主键（建议作为业务主键） |
| `pid` | int | 拆单父订单；列表恒为 0 |
| `order_id` | string | 订单号（`cp` 前缀 + 雪花） |
| `trade_no` | string | 第三方支付流水号 |
| `uid` | int | 商城用户 id |
| `freight_price` | string | 运费 |
| `real_name` / `user_phone` / `user_address` | string | 收货信息（**个人数据**） |
| `total_num` | int | 商品总件数 |
| `total_price` | string | 商品总价（含会员优惠修正） |
| `total_postage` | string | 邮费 |
| `pay_price` | string | 实付 |
| `coupon_price` / `deduction_price` | string | 优惠券/积分抵扣 |
| `paid` | int | 0/1 |
| `pay_time` | int | 支付时间戳（未支付为 0） |
| `pay_type` | string | `weixin/yue/offline/alipay/friend/allinpay/bank` |
| `pay_type_name` | string | 中文名，附加 |
| `add_time` | int | 下单时间戳 |
| `shipping_type` | int | 1=快递，2=自提/核销；**列表里被 unset** |
| `status` | int | 订单状态，见下 |
| `refund_status` | int | **列表里被 unset** |
| `delivery_name/code/id` | string | 物流信息 |
| `items[]` | array | `cart_id, store_name, suk, image, price(string), cart_num, surplus_num, refund_num` |

证据：`crmeb/app/services/order/OutStoreOrderServices.php:69-75,83-98,271-283`。

**列表缺口**：没有 `status_name`、没有 `refund_status`、没有 `refund_type`、没有 `update_time`。因此列表无法单独判断「退款中/已退款/部分退款」。

### 5.2 订单详情 `GET /outapi/order/<order_id>`

- 路径参数是**订单号字符串**（`order_id`），不是数字主键：`crmeb/app/outapi/controller/StoreOrder.php:228-232`、`crmeb/app/services/order/OutStoreOrderServices.php:106-120`。
- 主键关系：`eb_store_order.id` 是自增主键，`eb_store_order.order_id` 是业务单号（`cp` + 雪花）；售后单 `eb_store_order_refund` 有**自己的** `order_id`，通过 `store_order_id` 指向订单主键。三者不能混用。证据：`crmeb/public/install/crmeb.sql:28423-28503,28620-28646`、`crmeb/app/services/order/StoreOrderCreateServices.php:64-96,244`。
- 返回字段：`id,pid,order_id,trade_no,uid,freight_price,real_name,user_phone,user_address,total_num,total_price,total_postage,pay_price,coupon_price,deduction_price,paid,pay_time,pay_type,add_time,shipping_type,status,refund_status,delivery_name,delivery_code,delivery_id,refund_type,delivery_type,pink_id,use_integral,back_integral`，再附加 `invoice`、`items`、`vip_true_price`、`pay_type_name`、`status_name`：`crmeb/app/services/order/OutStoreOrderServices.php:106-135,143-262`。
- **`refund_type` 在返回前被 unset**：`crmeb/app/services/order/OutStoreOrderServices.php:261`。因此订单详情只能看到 `refund_status`，看不到「仅退款/退货退款/拒绝」。
- `status_name` 的真实分支（按顺序）：
  1. `paid=0` → `未支付`；`pay_type=offline` → `线下付款,未支付`；
  2. `status=4 或 1` → `待收货`（**先于退款判断**，所以已发货订单即使退款中也会显示待收货）；
  3. `refund_status=1` 且 `refund_type ∈ {0,1,2,4,5}` → `申请退款中`；
  4. `refund_status=2` 或 `refund_type=6` → `已退款`；
  5. `refund_status=3` → `部分退款（子订单）`；
  6. `refund_status=4` → `子订单全部申请退款中`；
  7. `status=0` → 拼团中/未发货/待核销；
  8. `status=2` → `待评价`；`status=3` → `交易完成`；其他 → `未知状态`。
  证据：`crmeb/app/services/order/OutStoreOrderServices.php:218-260`。
- `status_name` 是中文文案，**不能当稳定枚举**；Adapter 必须自己按 `paid/status/refund_status` 归一化。

### 5.3 状态与退款字段语义

#### `paid`

| 值 | 含义 | 证据 |
| --- | --- | --- |
| 0 | 未支付 | `crmeb/app/services/order/OutStoreOrderServices.php:219-224` |
| 1 | 已支付 | 同上；`crmeb/app/dao/order/StoreOrderDao.php:64-91` |

#### `status`（实际业务值）

| 值 | 含义 | 证据 |
| --- | --- | --- |
| 0 | 未发货（含待核销/拼团中） | `crmeb/app/services/order/OutStoreOrderServices.php:237-252`、`crmeb/app/dao/order/StoreOrderDao.php:109-110` |
| 1 | 已发货/待收货 | `crmeb/app/services/order/OutStoreOrderServices.php:225-226` |
| 2 | 已收货/待评价 | 同上 `:253-254` |
| 3 | 交易完成 | 同上 `:255-256` |
| 4 | 部分发货 | `crmeb/app/dao/order/StoreOrderDao.php:69-71` |
| -2 | 已退款/退货成功 | `crmeb/app/services/order/StoreOrderRefundServices.php:246-257` |
| -1 | 历史「申请退款」值；当前主流程用 `refund_status=1` + `refund_type` 表达，outapi 状态过滤不支持 -1 | `crmeb/public/install/crmeb.sql:28423-28503`（`status` 注释）、`crmeb/app/dao/order/StoreOrderDao.php:107-126` |

#### `refund_status`

| 值 | 含义 | 证据 |
| --- | --- | --- |
| 0 | 未退款 | `crmeb/public/install/crmeb.sql`（字段注释） |
| 1 | 退款申请中 | `crmeb/app/services/order/StoreOrderServices.php:294-331` |
| 2 | 已退款 | 同上 |
| 3 | 部分退款（子订单） | `crmeb/app/services/order/StoreOrderRefundServices.php:885-887`、`crmeb/app/services/order/OutStoreOrderServices.php:233-234` |
| 4 | 子订单全部申请退款中 | 同上 `:236` |

#### `refund_type`

| 值 | 含义 | 证据 |
| --- | --- | --- |
| 0 | 仅作为**筛选参数**表示「全部」；退款单本身不存 0 | `crmeb/app/services/order/StoreOrderServices.php:2305-2313`、`crmeb/app/dao/order/StoreOrderRefundDao.php:39-48` |
| 1 | 仅退款 | 同上 `:2307` |
| 2 | 退货退款 | 同上 `:2308` |
| 3 | 拒绝退款 | 同上 `:2309`、`crmeb/app/services/order/StoreOrderRefundServices.php:716` |
| 4 | 商品待退货 | 同上 `:2310` |
| 5 | 退货待收货 | 同上 `:2311` |
| 6 | 已退款 | 同上 `:2312`、`crmeb/app/services/order/StoreOrderRefundServices.php:246-257` |

> 注意：订单详情不返回 `refund_type`；售后接口才返回。

#### `pay_type`

| 值 | 含义 |
| --- | --- |
| `weixin` | 微信支付 |
| `yue` | 余额支付 |
| `offline` | 线下支付 |
| `alipay` | 支付宝 |
| `friend` | 好友代付 |
| `allinpay` | 通联支付 |
| `bank` | 银行转账 |

证据：`crmeb/app/services/pay/PayServices.php:26-55`。数据库为 `varchar(32)`：`crmeb/public/install/crmeb.sql`（`eb_store_order.pay_type`）。后台过滤同时接受数字 1-4（映射到 weixin/yue/offline/alipay）：`crmeb/app/dao/order/StoreOrderDao.php:150-180`。

#### 取消/删除/拆单

| 字段 | 含义 | 证据 |
| --- | --- | --- |
| `is_cancel=1` | 用户取消**未支付**订单；**只改标记，不改 `status`**（仍为 0），且 `paid=0` | `crmeb/app/services/order/StoreOrderServices.php:1967-2006` |
| `is_del=1` | 用户删除订单（仅未支付/已退款/已完成可删） | `crmeb/app/services/order/StoreOrderServices.php:1933-1955` |
| `is_system_del=1` | 后台删除；outapi 强制排除 | `crmeb/app/outapi/controller/StoreOrder.php:41-57` |
| `pid>0` | 拆单子订单；outapi 列表强制 `pid=0` | 同上 |

**结论**：`status=0` 的列表会混入「已取消未支付」订单（`order_status=0` 分支未排除 `is_cancel`），Adapter 必须自己按 `paid=0` + `is_cancel`（若可取得）或 `pay_time=0` 识别；但 outapi **列表/详情都不返回 `is_cancel`**，只能靠「`paid=0` 且长期未支付」推断。这是订单状态可信度的一个硬缺口。

### 5.4 售后列表 `GET /outapi/refund/list`

| 参数 | 语义 | 证据 |
| --- | --- | --- |
| `order_id` | 售后单号/原订单号模糊匹配；也会按 `store_order_id` 反查原订单号 | `crmeb/app/dao/order/StoreOrderRefundDao.php:49-54` |
| `time` | 按 `add_time` 时间范围；格式示例 `2022/06/01-2022/06/29` | `crmeb/app/outapi/controller/RefundOrder.php:43-53`、`crmeb/crmeb/traits/ModelTrait.php:27-82` |
| `refund_type` | 默认 0 → `refund_type>0`（全部售后）；指定值精确过滤 | `crmeb/app/dao/order/StoreOrderRefundDao.php:39-48` |
| `page` / `limit` | 分页；`limit` 最大 100 | `crmeb/app/services/order/OutStoreOrderRefundServices.php:50-64` |

强制 `is_cancel=0`（排除用户取消的售后单）：`crmeb/app/outapi/controller/RefundOrder.php:50`。排序 `id DESC`：`crmeb/app/dao/order/StoreOrderRefundDao.php:99-104`。

返回字段：`id, store_order_id, uid, order_id, refund_type, refund_num, refund_price→pay_price, refunded_price, refund_phone, refund_express, refund_express_name, refund_explain, refund_img, refund_reason, refuse_reason, remark, refunded_time, items, add_time`：`crmeb/app/services/order/OutStoreOrderRefundServices.php:50-64`。

### 5.5 售后详情 `GET /outapi/refund/<order_id>`

- 入参是**售后单号**（`eb_store_order_refund.order_id`），不是原订单号：`crmeb/app/outapi/controller/RefundOrder.php:103-108`、`crmeb/app/services/order/OutStoreOrderRefundServices.php:93-106`。
- 返回 `store_order_id`（原订单主键）、`order_id`（售后单号）、`refund_type`、`refund_price`、`refunded_price`、`refunded_time`、`is_cancel`、`is_del`、`items`、`refund_type_name`、`pay_type_name` 等：同上 `:95-139`。
- `refund_type_name` 映射：1/2/4/5 → 申请退款中；3 → 拒绝退款；其他 → 已退款：同上 `:128-136`。
- **已知缺陷**：字段列表没有 `pay_type`，但 `:137` 读取 `$refund['pay_type']`，导致 `pay_type_name` 恒为「其他方式」（PHP 7.4 下为 notice）：同上 `:95-98,137`。
- **文档漂移**：安装 SQL 内置的接口示例里售后详情含 `pay_type/paid/store_order_sn`（`crmeb/public/install/crmeb.sql:27657` 的 `refund/<order_id>` 响应模板），与当前代码不一致，不能按后台接口文档写 DTO。

### 5.6 增量同步能力（关键限制）

| 能力 | 是否有 | 证据 |
| --- | --- | --- |
| 按 `add_time` 过滤 | 有（`data`/`time`） | `crmeb/app/outapi/controller/StoreOrder.php:41-57`、`crmeb/app/services/order/OutStoreOrderServices.php:61-76` |
| 按 `update_time` 过滤 | **无**（订单表无该字段/无搜索器；`StoreOrder` 模型 `updateTime=false`） | `crmeb/app/model/order/StoreOrder.php:56-60`、`crmeb/app/dao/order/StoreOrderDao.php:47-56` |
| 按 id 游标 | **无** `id > X` 参数 | 同上 |
| 按状态变更时间 | **无** | 同上 |
| 订单列表带退款字段 | **无**（被 unset） | `crmeb/app/services/order/OutStoreOrderServices.php:83-98` |
| 售后列表可增量 | 有 `time`（`add_time`）与 `refunded_time` 字段 | `crmeb/app/dao/order/StoreOrderRefundDao.php:99-104`、`crmeb/app/services/order/OutStoreOrderRefundServices.php:53-54` |
| 推送 | 有，但只有 4 类订单/售后事件（加用户变动）且无签名 | 见 §6 |

**`data`/`time` 的正确格式**：必须用**不含连字符的日期**，以 `-` 分隔起止，例如 `2022/07/12 00:00:00-2022/08/17 00:00:00`。实现是 `explode('-', $value)`，若用 ISO `2022-07-12` 会被错误切分：`crmeb/crmeb/traits/ModelTrait.php:62-77`、安装 SQL 中的示例 `/order/list?...&data=2022/07/12 00:00:00-2022/08/17 00:00:00`。

### 5.7 去重键建议

| 对象 | 主键 | 幂等键 | 说明 |
| --- | --- | --- | --- |
| 订单 | `id`（int，自增） | `order_id`（string） | 雪花 `order_id` 在 file cache 降级时会用 6 位随机数替换尾部，**有碰撞风险**；`id` 是唯一可靠主键 |
| 售后 | `eb_store_order_refund.id` | 售后 `order_id` | 售后单号是独立生成的，不能与订单号混用 |
| 状态事件 | — | `order:{order_id}:{paid}:{status}:{refund_status}` | 只在四元组变化时落事件 |
| 退款事件 | — | `refund:{refund_order_id}:{refund_type}` | 配合 `store_order_id` 关联原订单 |

证据：`crmeb/app/services/order/StoreOrderCreateServices.php:64-96`（雪花 + file cache 降级）、`crmeb/public/install/crmeb.sql:28423-28503,28620-28646`（订单/售后表结构）、`crmeb/app/services/order/StoreOrderRefundServices.php:955-1069`（售后单号独立生成）。

---

## 6. 订单回流：推送与轮询

### 6.1 存在的推送机制（对 Captain 线索的纠正）

CRMEB 在「对外接口账号」里内置了**按事件配置 URL 的订单推送**，不是通用 webhook：

1. 后台给 OutAccount 打开 `push_open=1`，填 `push_account/push_password/push_token_url` 和 4 个订单/售后事件 URL（另有 `user_update_push`）：`crmeb/public/install/crmeb.sql:27566-27574`、`crmeb/app/adminapi/controller/v1/setting/SystemOutAccount.php:139-154`。
2. 业务事件触发 `OutPushListener`：监听 `order_create_push`、`order_pay_push`、`refund_create_push`、`refund_cancel_push`、`user_update_push`；监听器已在 `app/event.php` 注册：`crmeb/app/listener/out/OutPushListener.php:22-68`、`crmeb/app/event.php:40`。
3. 监听器取所有 `is_del=0 AND status=1` 且 `push_open=1` 的账号，按事件 dispatch `OutPushJob` 的 `orderCreate/paySuccess/refundCreate/refundCancel/userUpdate`：`crmeb/app/listener/out/OutPushListener.php:22-43`。
4. 推送前先向第三方 `push_token_url` 发 `POST JSON {push_account,push_password}`，要求返回 `{code:0, token, time}`；token 缓存在 `pushToken{id}`，之后每个推送 URL **字符串直接拼接** `?pushToken=<token>`（若原 URL 自带 query，会拼出非法 URL）：`crmeb/app/listener/out/OutPushListener.php:51-68`、`crmeb/app/services/order/OutStoreOrderServices.php:436-452`。
5. 实际发送 `out_push()`：`POST` JSON，`Content-Type: application/json`，**只有响应 `{code:0}` 才算成功**：`crmeb/app/common.php:1230-1249`。
6. 失败重试：`OutPushJob` 在 `step=0,1,2` 各发一次，间隔 5s/10s/15s；`step>2` 放弃并记 error 日志：`crmeb/app/jobs/OutPushJob.php:31-50,59-78`。
7. **异步依赖**：dispatch 走 `think-queue`，默认驱动 `redis`，必须有 `php think queue:work` 常驻；否则任务只进队列不发送：`crmeb/config/queue.php:15-40`、`crmeb/config/console.php:26-32`。

### 6.2 推送的能力边界

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 事件覆盖 | 仅：订单创建、支付成功、售后创建、售后取消、用户余额/积分变动 | `crmeb/app/listener/out/OutPushListener.php:22-68` |
| 发货/收货/完成/取消 | **无推送** | 同上（无对应事件分支） |
| payload | 订单/售后**详情 JSON**（`getInfo`），无 `event` 字段、无时间戳、无签名 | `crmeb/app/services/order/OutStoreOrderServices.php:436-452`、`crmeb/app/jobs/OutPushJob.php:31-158` |
| 鉴权 | 仅 URL query `pushToken`（由 Adapter 自己签发）；无 HMAC/mTLS | `crmeb/app/listener/out/OutPushListener.php:44-68` |
| 重放保护 | 无 nonce/时间戳；Adapter 必须自行幂等 | 同上 |
| 顺序 | 队列异步，**不保证顺序** | `crmeb/config/queue.php:15-40` |
| 多账号 | 每个 `push_open=1` 的账号都会推一遍 | `crmeb/app/listener/out/OutPushListener.php:22-43` |

### 6.3 支付回调不能给第三方用

- 支付渠道 notify 固定打到 CRMEB：`/api/pay/notify/wechat`、`/v3wechat`、`/alipay`、`/routine`、`/allin*`：`crmeb/app/api/controller/v1/PayController.php:33-60`。
- 微信 `notify_url` 由 `site_url` 拼出：`crmeb/crmeb/services/app/WechatService.php:92`、`crmeb/crmeb/services/pay/storage/V3WechatPay.php:68`。
- **【代码证实】** 没有「把支付回调转发给第三方」的配置。
- 因此支付结果的唯一可信来源是 CRMEB 自己的订单状态（推送或轮询），Adapter **不能**自行接收微信支付回调来判定 CRMEB 订单已支付。

### 6.4 推荐的轮询方案（不依赖推送）

**目标**：在不改 CRMEB、不加插件的前提下，得到可去重、可追溯的订单状态镜像。

1. **新单扫描**：`GET /outapi/order/list?page=1&limit=100`（不传 status），按 `add_time DESC` 翻页，直到 `add_time < watermark - 10min`；落库 `id/order_id/uid/paid/status/pay_type/add_time/pay_time/pay_price/items`。
2. **活跃单刷新**：对本地的「未终态」订单集合（`paid=1 AND status IN (0,1,2)` 或 `refund_status!=0`）逐单 `GET /outapi/order/<order_id>`，读取 `refund_status` 和 `status_name`；每轮限流（如 5 QPS），按 `id` 游标分批。
3. **退款扫描**：`GET /outapi/refund/list?refund_type=0&page=1&limit=100`（等价 `refund_type>0`），按 `id DESC` 翻页；落库 `id/order_id/store_order_id/refund_type/refunded_price/refunded_time/add_time`。售后单 `add_time` 可用于 `time` 过滤，但**不要**依赖 `time` 做精确增量（见 5.6 格式陷阱）。
4. **对账**：每日用 `order/list?status=-2`、`refund/list` 与本地镜像全量比对；用 `count` 校验漏页。
5. **频率**：建议 30-60s；单次不超过 100 条/页；失败指数退避；不要在高峰期 `limit=0`（会全表）。

**可依赖的字段**：`id`、`order_id`、`uid`、`paid`、`status`、`pay_type`、`pay_time`、`add_time`、`pay_price`、`items`、售后 `refund_type/refunded_price/refunded_time`。

**不可依赖的字段**：`status_name`（文案）、列表里的 `refund_status`（不存在）、`update_time`（不存在）、`is_cancel`（不存在）。

### 6.5 推送与轮询的组合建议

- **推送只作为「触发信号」**：收到 `order_pay_push` 后，Adapter 回调 `order/<order_id>` 拉权威详情，再做状态归一化；不要直接信 payload 的金额/状态。
- **轮询作为兜底与对账**：即使推送开启，也必须保留轮询（发货/收货/完成/取消没有推送）。
- **推送接收端必须幂等**：同一订单可能因重试/多账号重复推送；按 `order_id + event + 状态四元组` 去重。
- **推送 token 端点**：Adapter 需实现 `POST {push_token_url}`，校验 `push_account/push_password`（常量时间比较），返回 `{code:0, token:<随机>, time:<TTL 秒>}`；token 只用于查询参数，不能当唯一鉴权（建议再校验来源 IP/网段，若 CRMEB 与 Adapter 同 VPC）。

---

## 7. 居民购买入口（uni-app H5）

### 7.1 可深链的页面

H5 为 history 模式、`base=""`，路由路径即 `/pages/...`：`template/uni-app/manifest.json:219-245`。

| 入口 | URL | 参数 | 证据 |
| --- | --- | --- | --- |
| 商品详情 | `/pages/goods_details/index?id=<crmeb_product_id>` | `id` 商品数字 id；可追加 `&spread=<uid>` | `template/uni-app/pages/goods_details/index.vue:441-494,618,1454` |
| 商品列表 | `/pages/goods/goods_list/index` | 分类等 | `template/uni-app/pages.json:145-340` |
| 搜索 | `/pages/goods/goods_search/index` | 关键词 | 同上 |
| 购物车 | `/pages/order_addcart/order_addcart`（tab 页） | — | `template/uni-app/pages.json:32` |
| 确认订单 | `/pages/goods/order_confirm/index?new=1&cartId=<cartId>` 或 `?order_id=<order_id>` | 必须先有服务端购物车/订单 | `template/uni-app/pages/goods/order_confirm/index.vue:503-550`、`template/uni-app/pages/goods_details/index.vue:1273-1280` |
| 收银台 | `/pages/goods/cashier/index?order_id=<order_id>&from_type=order` | 订单号 | `template/uni-app/pages/goods/order_confirm/index.vue:1154`、`template/uni-app/pages/goods/cashier/index.vue:135-139` |
| 支付结果 | `/pages/goods/order_pay_status/index?order_id=...` | 订单号 | `template/uni-app/pages/goods/cashier/index.vue:152-176` |
| 订单列表 | `/pages/goods/order_list/index` | — | `template/uni-app/pages.json:145-340` |
| 登录 | `/pages/users/login/index` | `back_url` | `template/uni-app/pages.json:985-997`、`template/uni-app/libs/login.js:47-85` |
| 公众号登录 | `/pages/users/wechat_login/index` | `code/state` | `template/uni-app/pages.json:517-521`、`template/uni-app/pages/users/wechat_login/index.vue:189-196` |

> 平台 H5 能安全深链的只有**商品详情/列表/搜索**。`order_confirm` 需要 `cartId` 或 `order_id`，而这两个值只能由 CRMEB 登录态在服务端创建，平台无法预先生成；因此**平台不能深链到「确认订单」或「支付」**。

### 7.2 登录方式与游客下单

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 手机号+验证码登录 | 支持；未注册手机号会**自动注册**（默认密码 `123456`），再签发 `api` token | `crmeb/app/services/user/LoginServices.php:325-352` |
| 账号+密码登录 | 支持；但**默认密码 `md5('123456')` 被拒绝**，必须改密或走验证码 | `crmeb/app/services/user/LoginServices.php:53-78` |
| 公众号 OAuth 登录 | 支持；有 `v2/wechat/auth_login` 端点与 `/pages/users/wechat_login/index` 页面；需要公众号 AppID/Secret/授权域名。**【未知】** H5 代码调用的 `v2/wechat/auth` 未在路由表中直接定位到，需真机确认 | `template/uni-app/libs/wechat.js:222-243`、`crmeb/app/api/route/v2.php:32-35`、`template/uni-app/pages.json:517-521` |
| 游客下单 | **不支持**。`order_confirm` 无登录会 `toLogin()`；下单 API 在鉴权组内 | `template/uni-app/pages/goods/order_confirm/index.vue:503-550`、`crmeb/app/api/route/v1.php:213-235,376` |
| 未登录加购/收藏 | 不支持，会跳登录 | `template/uni-app/pages/goods_details/index.vue:1211-1219,1333-1340` |
| 购买流程 | 详情 → 加购/立即购买 → `cart/add` → `order_confirm?new=1&cartId=` → `order/create/:key` → `cashier` → 支付 → `order_pay_status` | `template/uni-app/pages/goods_details/index.vue:1228-1297`、`crmeb/app/api/route/v1.php:206,216-218,229` |

**含义**：平台居民必须先在 CRMEB H5 完成登录（手机号验证码或公众号授权），才能下单。平台不能「免登录代下单」。

### 7.3 `spread` 参数的真实含义（不是来源标记）

- `?spread=<uid>` 被 `App.vue` 在 `onShow` 捕获并缓存：`template/uni-app/App.vue:61-99,128-130`。
- `main.js` 在 H5 启动时 `parseQuery` 取 `spread` 缓存：`template/uni-app/main.js:43-68`。
- 登录/注册时把 `spread` 提交，绑定分销关系：`template/uni-app/utils/index.js:20-54`、`template/uni-app/pages/users/login/index.vue:417-530`。
- 服务端把它写进 `spread_uid`（上级分销员），并影响佣金：`crmeb/app/services/user/LoginServices.php:53-78`、`crmeb/public/install/crmeb.sql:28423-28503`（`eb_store_order.spread_uid/spread_two_uid`）。
- **结论**：`spread` 是**CRMEB 分销员 uid**，不是平台活动/渠道/来源 ID。把它当来源标记会：① 需要平台用户都绑定到某个「平台专用分销员」；② 默认绑定策略下已绑定其他分销员的用户不会被改写（若后台改为临时/可换绑则可能被覆盖，取决于 `store_brokerage_binding_status`）；③ 产生佣金/分销合规影响。**不建议**作为来源归因。

### 7.4 微信与支付配置要求

| 配置 | 用途 | 证据 |
| --- | --- | --- |
| 公众号 `AppID/AppSecret` | 公众号 OAuth、JSAPI 支付授权 | `crmeb/public/install/crmeb.sql:33715-33720`（`wechat_appid/wechat_appsecret`） |
| 微信支付商户号 `pay_weixin_mchid` | 统一下单 | `crmeb/public/install/crmeb.sql:33724` |
| 支付密钥 `pay_weixin_key` | v2 签名 | `crmeb/public/install/crmeb.sql:33727` |
| API 证书 `pay_weixin_client_cert/key` | 退款/企业付款 | `crmeb/public/install/crmeb.sql:33725-33726` |
| `pay_wechat_type` | 0=v2，1=v3 | `crmeb/public/install/crmeb.sql:33888` |
| `pay_weixin_open` | 开启微信支付通道 | `crmeb/public/install/crmeb.sql:33728` |
| `site_url` | 支付回调、OAuth 回调、二维码的域名基准 | `crmeb/public/install/crmeb.sql:33712`、`crmeb/crmeb/services/app/WechatService.php:92` |
| 公众号后台「JS 接口安全域名 / 网页授权域名」 | H5 支付与 OAuth 必需 | **【未知】** 仓库外配置，必须在商户后台核对 |

- H5 在微信内会走公众号 OAuth；非微信浏览器只能手机号登录：`template/uni-app/libs/login.js:47-85`。
- H5 支付依赖 JSAPI（需要 openid）；未配置公众号/支付时，居民只能浏览，不能完成支付：`crmeb/app/api/controller/v1/PayController.php:33-60`、`crmeb/crmeb/services/app/WechatService.php:92`。

### 7.5 深链部署要求（阻塞项）

- 仓库自带 rewrite 只到 `index.php`，没有 SPA 回退：`crmeb/public/nginx.htaccess:1-6`、`help/docker/nginx/vhost.conf:10-15`。
- **【代码推断】** 生产 Nginx 必须额外加：
  - `location /pages/ { try_files $uri $uri/ /index.html; }`
  - 以及 `/static/` 正常静态托管。
- **【未知】** 若商户未配置，平台深链 `https://mall.example.com/pages/goods_details/index?id=1` 会 404；这是上线前必须用真实域名验证的第一项。同时确认根路径 `/` 打开的是 H5 而不是 ThinkPHP（`index` 顺序）。

---

## 8. 身份能力：建号、绑定、SSO

### 8.1 outapi 用户接口能力

| 能力 | 接口 | 关键约束 | 证据 |
| --- | --- | --- | --- |
| 用户列表/按手机号查 | `GET /outapi/user/list?field_key=phone&nickname=<phone>` | `field_key ∈ {nickname,phone,uid}`；phone 为模糊 `like`；返回 `uid/phone/...` | `crmeb/app/outapi/controller/User.php:39-47`、`crmeb/app/dao/user/UserWechatuserDao.php:316-330`、`crmeb/app/services/user/OutUserServices.php:45-84` |
| 用户详情 | `GET /outapi/user/info/<uid>` | 返回 `uid/real_name/nickname/avatar/phone/now_money/.../spread_uid/spread_time/user_type` | `crmeb/app/outapi/controller/User.php:130-135`、`crmeb/app/services/user/OutUserServices.php:94-109` |
| 新增用户 | `POST /outapi/user` | **必填 `real_name` + `phone`**；手机号唯一（`is_del=0`）；密码 md5 存储，不传则默认 `md5(123456)`；`user_type=h5` | `crmeb/app/services/user/OutUserServices.php:120-176` |
| 修改用户 | `PUT /outapi/user/<uid>` | 同上字段；可改密码/等级/状态/推广资格 | `crmeb/app/outapi/controller/User.php:79-94` |
| 赠送余额/积分 | `PUT /outapi/user/give_balance/:uid`、`PUT /outapi/user/give_point/:uid` | 运营能力，非身份 | `crmeb/app/outapi/route/route.php:89-90`、`crmeb/app/outapi/controller/User.php:146-195` |

> 响应嵌套：`user/info/<uid>` 返回 `data.data`（控制器 `compact('data')`），`user/list` 返回 `data.list/data.count`；DTO 解析时不要只取一层。证据：`crmeb/app/outapi/controller/User.php:39-47,130-135`。

**局限**：

- 建号只返回 `uid`，**不签发登录 token**；用户仍需在 H5 登录。
- 默认密码 `123456` 会被密码登录拒绝（`LoginServices:53-78`），必须让用户走短信验证码或重置密码。
- 没有「按 openid 查 uid」的接口；`user/info` 不含 openid/unionid。平台若用微信身份，只能靠手机号或平台侧自行记录映射。
- 手机号是唯一键，但 `user/list` 是模糊匹配，可能返回多条，需要精确二次过滤。

### 8.2 `remote_register`：可免登录，但**不可信**

- 端点：`GET /api/remote_register?remote_token=<base64>`（无需登录）：`crmeb/app/api/route/v1.php:20-65`、`crmeb/app/api/controller/v1/LoginController.php:549-556`。
- 实现：`JWT::jsonDecode(JWT::urlsafeB64Decode($out_token))`，**不验签**；按 JWT 里的 `uid` 查找/创建用户（`account=phone` 或 `out_<uid>`，`pwd=md5('123456')`），然后签发 API token：`crmeb/app/services/user/LoginServices.php:503-548`。
- 管理端配置 `get_remote_login_url` 作为登录后的跳转地址：`crmeb/public/install/crmeb.sql:33941`。
- **安全结论**：任何能访问该端点的人都可以伪造任意 `uid` 的登录 token。**Adapter 不得把该 token 的生成能力暴露给浏览器/公网**；若必须用，只能由 Adapter 服务端在受信网络内生成短期 token，并立即消费，且需要 CRMEB 侧额外网络隔离。**MVP 建议禁用。**

### 8.3 无 OAuth/SSO/OIDC/签名断言

- 未发现向第三方签发「身份断言」的接口；`access_token` 是**应用级**凭据，不是用户级。
- 用户级 token 只能由 CRMEB 的登录流程签发（手机号/微信）：`crmeb/app/services/user/LoginServices.php:53-78,325-352`。
- 因此平台 UUID → CRMEB uid 的映射必须由 Adapter 维护，不能反向依赖 CRMEB 的会话。

### 8.4 建议的身份映射设计

```
platform users.id (UUID) 1—1 crmeb_identity_links.crmeb_uid (int)
                                 ├─ phone_hash / phone_last4（展示与排重）
                                 ├─ link_method: outapi_create | phone_match | manual
                                 └─ linked_at / verified_at
```

- **优先**：平台已有手机号 → `GET user/list?field_key=phone&nickname=<phone>` 检索（接口是 `like`，必须再在结果里做精确比较）→ 绑定。
- **新建**：`POST user` 建号（phone 唯一）→ 记录 uid；用户首次进入 CRMEB H5 用短信验证码登录（或引导重置密码）。
- **禁止**：把 `remote_register` 链接暴露给居民；把 CRMEB 用户 token 存到平台浏览器；用 openid 直接当平台用户 ID。
- **冲突**：同一手机号在 CRMEB 已存在但属于他人 → 不自动合并，走人工核验；平台侧保留 `conflict` 状态。

### 8.5 `spread` / 分销字段

- `spread_uid`、`spread_two_uid` 是 CRMEB 分销上下级；绑定发生在登录/注册：`crmeb/app/services/user/LoginServices.php:53-78`、`crmeb/public/install/crmeb.sql`（`eb_store_order` 字段）。
- `user/info` 返回 `spread_uid/spread_time/spread_name`：`crmeb/app/services/user/OutUserServices.php:94-109`。
- **不是来源字段**；不能用来做平台订单归属。若要归因，只能在平台侧用「跳转链接 + 时间窗 + 已绑定 uid」做弱关联，并明确标注为推断。

---

## 9. 环境可达性与上线配置清单

### 9.1 本机环境（调查时）

```
php: NOT_FOUND
mysql: NOT_FOUND
redis-server: NOT_FOUND
docker: NOT_FOUND
```

因此**无法启动 CRMEB 实例**，本调研没有运行时证据；所有接口行为均来自源码。Adapter 的真实联调必须在具备以下条件的环境进行：

- PHP 7.4 + 扩展（fileinfo/redis/mbstring/openssl/pdo_mysql/curl/gd/zip）
- MySQL 5.7/8.0
- Redis（队列必需）
- Nginx（站点根 `public`，含 SPA 回退）
- `php think queue:work` 常驻（若启用推送）
- 公网 HTTPS 域名（微信 OAuth/支付要求）

### 9.2 CRMEB 侧配置清单

| 配置 | 值/操作 | 证据 |
| --- | --- | --- |
| 安装 | 访问 `/install`，导入 `crmeb.sql`，生成 `.env`/`install.lock` | `crmeb/public/install/index.php:1-60` |
| `site_url` | 真实 HTTPS 域名 | `crmeb/public/install/crmeb.sql:33712` |
| 公众号 | AppID/AppSecret、网页授权域名、JS 安全域名 | `crmeb/public/install/crmeb.sql:33715-33720`（`wechat_*`） |
| 微信支付 | 商户号、API key、证书、v2/v3 选择 | `crmeb/public/install/crmeb.sql:33724-33728,33888`（`pay_weixin_*`、`pay_wechat_type`） |
| 对外接口账号 | 新建 appid/appsecret，勾选 §3.3 接口 | `crmeb/app/adminapi/route/setting.php:305-332` |
| 推送（可选） | `push_open`、`push_account/password`、`push_token_url`、4 个订单/售后事件 URL（另有 `user_update_push`） | `crmeb/public/install/crmeb.sql:27566-27574` |
| 队列 | `php think queue:work --queue CRMEB<queue_name>`（队列名见 `.env`） | `crmeb/config/queue.php:15-40`、`crmeb/public/install/.env:1` |
| 定时任务 | 自动取消未支付订单等依赖 `workerman`/`timer` | `crmeb/config/console.php:26-32`、`help/dev-docs/phpapi/系统队列任务文档说明.md:282-300` |

### 9.3 平台侧 Adapter 需要的凭据

- `CRMEB_BASE_URL`（如 `https://mall.example.com`）
- `CRMEB_OUTAPI_APPID` / `CRMEB_OUTAPI_APPSECRET`
- `CRMEB_PUSH_TOKEN_SECRET`（Adapter 自己签发 pushToken 用）
- 可选：`CRMEB_PUSH_ACCOUNT/PASSWORD`（与后台推送配置一致）
- 所有密钥只进服务端环境变量/密钥管理，不进前端、不进日志。

---

## 10. 明确的不可支持项与阻塞

| # | 不可支持/阻塞 | 原因 | 证据 |
| --- | --- | --- | --- |
| 1 | 平台侧创建 CRMEB 订单 | outapi 只读订单；下单在 `/api` 用户鉴权组，必须有商城 token 和购物车 | `crmeb/app/outapi/route/route.php`（无 order POST）、`crmeb/app/api/route/v1.php:213-235,376` |
| 2 | 游客下单 | `order_confirm` 强制登录；下单 API 需鉴权 | `template/uni-app/pages/goods/order_confirm/index.vue:503-550` |
| 3 | 库存/售罄判断 | 商品列表无 `stock`；详情 SKU 也 unset `stock` | `crmeb/app/services/product/product/OutStoreProductServices.php:328,336-348` |
| 4 | 通用来源归因 | 订单无 source/channel 字段；`spread` 是分销 uid，不是来源 | `crmeb/public/install/crmeb.sql:28423-28503`（`eb_store_order` 列清单无 source/channel）、`template/uni-app/App.vue:61-99` |
| 5 | 全量状态变更推送 | 推送只有创建/支付/售后创建/售后取消；无发货/收货/完成/取消 | `crmeb/app/listener/out/OutPushListener.php:22-68` |
| 6 | 签名 webhook | 无 HMAC/时间戳/nonce；仅 query token | `crmeb/app/common.php:1230-1249`、`crmeb/app/listener/out/OutPushListener.php:44-68` |
| 7 | 支付回调转发 | notify 只到 CRMEB 内部 | `crmeb/app/api/controller/v1/PayController.php:33-60` |
| 8 | SSO/OIDC/用户级签名断言 | 无此能力 | 全仓检索未发现（`crmeb/app/outapi` 仅应用级 token） |
| 9 | 按 `update_time` 增量 | 表/模型无该字段 | `crmeb/app/model/order/StoreOrder.php:56-60` |
| 10 | 订单列表看退款状态 | `tidyOrderList` unset `refund_status` | `crmeb/app/services/order/OutStoreOrderServices.php:95` |
| 11 | 拆单子订单可见 | outapi 强制 `pid=0` | `crmeb/app/outapi/controller/StoreOrder.php:41-57` |
| 12 | 已取消未支付订单精确识别 | 列表/详情不返回 `is_cancel` | `crmeb/app/services/order/StoreOrderServices.php:1967-2006` |
| 13 | H5 深链开箱即用 | 仓库 rewrite 无 SPA 回退，需部署层补 | `crmeb/public/nginx.htaccess:1-6` |
| 14 | 本地实测 | 无 PHP/MySQL/Redis/Docker | 本次环境检查（§9.1） |

---

## 11. Adapter 可安全依赖的最小契约（建议）

> 原则：Adapter 是**唯一**接触 CRMEB 的服务；对 H5/Admin 只暴露平台契约；所有 CRMEB 字段在边界处归一化；不把 CRMEB 的原始状态文案/金额字符串直接透传。

### 11.1 平台侧最小接口

| 方法/路径 | 用途 | 依赖 CRMEB |
| --- | --- | --- |
| `GET /integrations/crmeb/products?page&limit&categoryId&keyword` | 商品列表（仅上架） | `product/list` + 本地 `is_show` 过滤 |
| `GET /integrations/crmeb/products/:id` | 商品详情 | `product/<id>`，再校验 `is_show` |
| `GET /integrations/crmeb/categories` | 分类树 | `category/list` |
| `GET /integrations/crmeb/health` | 连通性/权限自检 | `category/list` 轻量探测 |
| `POST /integrations/crmeb/identity/resolve` | 手机号→uid 绑定/建号（仅服务端） | `user/list`、`user` |
| `GET /integrations/crmeb/orders?cursor&limit` | 平台订单镜像查询（不直连） | 本地镜像 |
| `POST /webhooks/crmeb/token` | 给 CRMEB 发 pushToken | 自建 |
| `POST /webhooks/crmeb/push?pushToken=` | 接收 CRMEB 推送 | 自建 |

> 这些路径是**建议契约**，落地时以 Issue #63 的实现卡与 `packages/contracts` 为准；本文不写实现代码。

### 11.2 归一化 DTO（建议字段）

**Product**

```
id: string            // 平台侧可用 crmeb:<id> 或映射表 id
crmebProductId: number
name: string
summary: string
images: string[]
priceCents: number
originalPriceCents: number | null
categoryIds: number[]
categoryNames: string[]
onShelf: boolean
specType: 0 | 1
detailHtml: string
skus: { key: string; priceCents: number; image: string; specText: string }[]
stockKnown: false     // 显式声明库存未知
```

**OrderMirror**

```
crmebOrderId: number        // eb_store_order.id，主键
orderNo: string             // eb_store_order.order_id
crmebUid: number
platformUserId: string | null
paid: boolean
status: 'unpaid'|'unshipped'|'shipped'|'received'|'completed'|'refunded'|'unknown'
refundStatus: 0|1|2|3|4|null
refundType: 1|2|3|4|5|6|null
payType: 'weixin'|'yue'|'offline'|'alipay'|'friend'|'allinpay'|'bank'|'unknown'
payAmountCents: number
createdAt: string           // ISO，由 add_time 转换
paidAt: string | null
items: { name: string; sku: string; image: string; priceCents: number; quantity: number }[]
source: 'crmeb_poll'|'crmeb_push'
syncedAt: string
```

**RefundMirror**

```
crmebRefundId: number
refundNo: string            // eb_store_order_refund.order_id
crmebOrderId: number        // store_order_id
refundType: 1|2|3|4|5|6
refundAmountCents: number
refundedAmountCents: number
refundedAt: string | null
createdAt: string
```

### 11.3 状态归一化规则（Adapter 必须实现）

| 优先级 | CRMEB 条件 | 平台状态 |
| --- | --- | --- |
| 1 | `refund_status=2` 或 `refund_type=6` 或 `status=-2` | `refunded` |
| 2 | `refund_status ∈ {3,4}` | `partial_refund` |
| 3 | `refund_status=1` 或 `refund_type ∈ {1,2,4,5}` | `refunding` |
| 4 | `paid=0` 且超时/取消（无法精确取 `is_cancel`，按超时策略） | `cancelled`（标注推断） |
| 5 | `paid=0` 且未取消 | `unpaid` |
| 6 | `paid=1` 且 `status=0`（含待核销） | `unshipped` |
| 7 | `paid=1` 且 `status=1` 或 `4` | `shipped` |
| 8 | `paid=1` 且 `status=2` | `received` |
| 9 | `paid=1` 且 `status=3` | `completed` |
| 10 | 其他 | `unknown` |

**注意**：`status_name` 的前置分支会让 `status=1/4` 显示「待收货」而掩盖退款中，所以归一化必须以 `refund_status` 优先，不能信文案。

### 11.4 同步、幂等与归属

- **身份**：`crmeb_identity_links(platform_user_id UNIQUE, crmeb_uid UNIQUE, phone_hash, method, linked_at)`；绑定前必须 `user/list?field_key=phone` 精确比对，冲突不合并。
- **商品映射**：`crmeb_product_links(platform_product_id, crmeb_product_id)`；H5 跳转 URL 只由 Adapter 生成。
- **订单镜像**：`crmeb_orders(crmeb_order_id PK, order_no UNIQUE, ...)`；`crmeb_order_events(dedupe_key UNIQUE, payload_hash, received_at)`。
- **去重键**：订单首选 `id`（备用 `order_id`）；售后 `refund_no`；事件 `order:{order_id}:{paid}:{status}:{refund_status}`。
- **来源归属**：平台侧记录「本次跳转的 `platform_user_id` + `crmeb_uid` + 时间窗 + 商品/活动 ID」，订单回流后按 `crmeb_uid + 时间窗 + 商品` 做**弱关联**，并在 UI 标注「推断归属」；不要声称 CRMEB 提供了来源字段。
- **失败处理**：outapi `status!=200` 时按 `msg` 分类（token 失效/无权限/参数错误/不存在）；403 时告警「后台未勾选接口」；429/5xx 退避重试。
- **可观测性**：记录每次调用的 method/path/耗时/状态码（不记录 token、appsecret、手机号全量）。

### 11.5 明确不要做的事

- 不要把 outapi `access_token` 下发给浏览器。
- 不要把 `remote_register` 链接给居民。
- 不要用 `spread` 当渠道/活动 ID。
- 不要把 `status_name` 当枚举。
- 不要依赖 `limit=0`（全表）或高频全量扫描。
- 不要在没有 `is_show` 二次校验的情况下展示商品。

---

## 12. 风险清单

| 风险 | 等级 | 说明 | 缓解 |
| --- | --- | --- | --- |
| H5 深链 404 | **高** | 仓库 rewrite 无 SPA 回退 | 部署层加 `try_files ... /index.html`，上线前真实域名验证 |
| 无库存字段 | **高** | 无法判断售罄，购买入口可能落空 | UI 标注「库存以商城为准」；不承诺可售 |
| 订单状态不完整 | **高** | 列表无 refund_status；详情无 refund_type；无 is_cancel | 详情+售后双拉；状态归一化；人工对账 |
| 推送依赖队列 | **中** | 无 `queue:work` 则推送不发出 | 监控队列；轮询兜底 |
| 推送无签名 | **中** | 仅 query token；可重放 | 幂等键；来源 IP 限制；短 TTL；不信任 payload 金额 |
| 身份映射靠手机号 | **中** | 模糊匹配、可能重号；默认密码不可登录 | 精确二次比对；短信登录引导；冲突人工 |
| 权限漏勾 | **中** | 403 且错误文案笼统 | 启动自检 health；日志告警 |
| 商品下架仍可读 | **中** | 详情不校验 `is_show/is_del` | Adapter 二次校验 |
| 分类缓存 24h | **低** | 改分类不即时 | 接受延迟/本地同 TTL |
| `order_id` 碰撞 | **低** | file cache 降级用随机尾号 | 用 `id` 做主键 |
| 凭据泄露 | **高** | `apppwd` 明文、`APP_KEY=crmeb` | 密钥管理；最小权限；轮换 appsecret |
| 真实环境未验证 | **高** | 本机无 PHP/MySQL/Redis/Docker | 联调环境必须真机验证后再宣称可用 |

---

## 13. 未知项（必须真机/后台确认）

1. 生产 Nginx 是否为 H5 配了 `index.html` 回退；`/pages/*` 深链是否 200。
2. 公众号「网页授权域名」「JS 接口安全域名」是否已配置，H5 支付能否拉起。
3. 微信支付 v2/v3 实际启用哪套、证书是否上传、退款是否可用。
4. outapi 真实返回的 `slider_image` 是数组还是 JSON 字符串（模型 getter 应为数组，需实测）。
5. `decimal` 字段在真实 PHP/PDO 下是否始终为字符串（本调研按 MySQL 驱动行为推断）。
6. 真实订单的 `status` 是否会出现 -1；`refund_status=3/4` 的触发频率。
7. 队列 worker 的部署方式（supervisor/systemd）与重试死信处理。
8. `site_url` 与后台域名是否一致；反向代理是否改写 `Host`/`X-Forwarded-Proto`。
9. CRMEB 版本升级（`version_code` 变化）是否改变 outapi 字段/权限 id。
10. 商户是否允许第三方只读订单（涉及个人信息与合规）。
11. 根路径 `/` 与 `/pages/*` 的实际 Nginx 行为（H5 首页 vs ThinkPHP；SPA 回退）。

---

## 14. 证据索引（按主题）

| 主题 | 关键文件:行 |
| --- | --- |
| 版本 | `crmeb/.version:1-6`、`crmeb/composer.lock:4618-4620` |
| PHP 门槛 | `crmeb/public/index.php:15-20`、`crmeb/public/install/index.php:21-26` |
| 安装/环境 | `crmeb/public/install/index.php:1-60,378-407`、`crmeb/public/install/.env:1`、`help/dev-docs/phpapi/系统安装流程文档.md:8-70,420-480` |
| outapi 路由 | `crmeb/app/outapi/route/route.php:16-60` |
| token 中间件 | `crmeb/app/outapi/middleware/AuthTokenMiddleware.php:39-52` |
| token 服务 | `crmeb/app/services/out/OutAccountServices.php:52-73,147-171,207-235` |
| JWT | `crmeb/crmeb/utils/JwtAuth.php:41-57,75-82,92-101` |
| 接口授权 | `crmeb/app/services/out/OutInterfaceServices.php:33-52` |
| 后台账号 | `crmeb/app/adminapi/controller/v1/setting/SystemOutAccount.php:84-154`、`crmeb/app/adminapi/route/setting.php:305-332` |
| 账号表 | `crmeb/public/install/crmeb.sql:27554-27576` |
| 权限种子 | `crmeb/public/install/crmeb.sql:50050`（`eb_system_route` id 804-843、1696；`eb_system_route_cate` 85-91 见 `:51367-51373`） |
| 商品列表 | `crmeb/app/outapi/controller/StoreProduct.php:36-60`、`crmeb/app/services/product/product/OutStoreProductServices.php:358-382`、`crmeb/app/dao/product/product/StoreProductDao.php:125-191` |
| 商品详情 | `crmeb/app/services/product/product/OutStoreProductServices.php:252-350`、`crmeb/app/dao/BaseDao.php:184-194` |
| 商品搜索器 | `crmeb/app/model/product/product/StoreProduct.php:98-101,152-168,269-286,312-348` |
| 分类 | `crmeb/app/outapi/controller/StoreCategory.php:41-63`、`crmeb/app/services/product/product/StoreCategoryServices.php:350-355`、`crmeb/app/dao/product/product/StoreCategoryDao.php:200-219` |
| 订单列表 | `crmeb/app/outapi/controller/StoreOrder.php:41-57`、`crmeb/app/services/order/OutStoreOrderServices.php:61-98`、`crmeb/app/dao/order/StoreOrderDao.php:47-126` |
| 订单详情 | `crmeb/app/services/order/OutStoreOrderServices.php:106-262` |
| 订单状态 | `crmeb/app/dao/order/StoreOrderDao.php:107-126`、`crmeb/app/services/order/StoreOrderServices.php:1967-2006,2305-2313`、`crmeb/app/services/order/StoreOrderRefundServices.php:246-257,716,885-887` |
| 售后 | `crmeb/app/outapi/controller/RefundOrder.php:43-108`、`crmeb/app/services/order/OutStoreOrderRefundServices.php:50-140`、`crmeb/app/dao/order/StoreOrderRefundDao.php:34-104` |
| 时间过滤 | `crmeb/crmeb/traits/ModelTrait.php:27-82`、`crmeb/app/Request.php:58-86` |
| 推送 | `crmeb/app/listener/out/OutPushListener.php:22-68`、`crmeb/app/jobs/OutPushJob.php:31-158`、`crmeb/app/common.php:1230-1249`、`crmeb/app/services/order/OutStoreOrderServices.php:436-452` |
| 队列 | `crmeb/config/queue.php:15-40`、`crmeb/config/console.php:26-32`、`help/dev-docs/phpapi/系统队列任务文档说明.md:6-40,282-300` |
| 支付回调 | `crmeb/app/api/controller/v1/PayController.php:33-60`、`crmeb/crmeb/services/app/WechatService.php:92` |
| 用户接口 | `crmeb/app/outapi/controller/User.php:39-135`、`crmeb/app/services/user/OutUserServices.php:45-176`、`crmeb/app/dao/user/UserWechatuserDao.php:316-330` |
| 登录 | `crmeb/app/services/user/LoginServices.php:53-78,325-352,503-548`、`crmeb/app/api/controller/v1/LoginController.php:549-556` |
| H5 路由 | `template/uni-app/manifest.json:219-245`、`template/uni-app/pages.json:145-340,517-521,985-997` |
| 购买流程 | `template/uni-app/pages/goods_details/index.vue:1228-1297,1333-1340`、`template/uni-app/pages/goods/order_confirm/index.vue:503-550,1154` |
| 登录跳转 | `template/uni-app/libs/login.js:47-85`、`template/uni-app/pages/users/login/index.vue:417-530,603-610` |
| `spread` | `template/uni-app/App.vue:61-99,128-130`、`template/uni-app/main.js:43-68`、`template/uni-app/utils/index.js:20-54` |
| 重写规则 | `crmeb/public/nginx.htaccess:1-6`、`crmeb/public/.htaccess:1-8`、`help/docker/nginx/vhost.conf:10-15` |
| 订单/退款表 | `crmeb/public/install/crmeb.sql:28423-28503,28620-28646` |

---

## 15. 对下游实现的硬约束（摘要）

1. **默认只读**：Adapter 不允许调用 outapi 的写接口（`product` POST/PUT、`order/*` PUT、`refund/*` PUT、`user` POST/PUT）作为业务链路；唯一例外是 §8 的身份建号/绑定，必须单独评审并留审计。
2. **不改 shop_crmeb**：所有适配在 local-life 侧；CRMEB 仅通过 outapi 与 H5 链接交互。
3. **不碰真实支付**：平台不代收、不转发支付回调、不落支付凭证。
4. **身份主键**：平台 `users.id` 是唯一主键；`crmeb_uid` 只是外部映射。
5. **来源归属**：只能做「弱关联」，UI/对账必须标注推断，不能宣称 CRMEB 提供了来源字段。
6. **可信回流**：推送仅作触发；订单/退款状态以轮询详情为准；所有事件幂等。
7. **上线门槛**：H5 深链、公众号/支付配置、队列 worker、真实订单联调四项全部通过，才可把「真实商品入口」标为可用。
