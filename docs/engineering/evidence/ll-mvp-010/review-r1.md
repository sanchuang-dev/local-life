# LL-MVP-010 · R1 服务端代码审查（t6）

> 审查者：`recon-archaeologist`（只读审查；**未修改任何业务代码**，本文件是唯一写入的产物）
> 时间：2026-11-06（Asia/Shanghai）
> 被审查对象：提交 `007f433` `feat(api): local product catalogue and resident order registration (R1)`（12 文件 / +9569 行）
> 分支：`feat/ll-mvp-010-local-catalog-orders`；基线 `origin/dev@ae8441a`
> **结论：verdict = pass**。Issue #109 Scope R1 的服务端要求（按 `recon.md §2.1` 展开为 R1-1..R1-10）逐条成立；6 项抽查（权限矩阵、事实分离、幂等+快照、迁移、误用、测试真实性）全部实跑复核。**0 条阻断 / 0 条中级**；6 条低级（low）发现，均可留到后续小改，不构成本提交的返修条件。

---

## 0. 审查范围与方法

### 0.1 范围

| 项 | 内容 |
| --- | --- |
| 在范围 | `007f433` 的全部 12 个文件（contracts / schema / 0009 迁移与快照 / `apps/api/src/local/**` / `app.ts` 挂载 / 新增测试） |
| 不在范围 | R2 前端（`ac4c385`，由 t7 审查）；`pnpm check` 全局绿（t10 已在干净 worktree 复核 lint/typecheck/build）；浏览器交互（t5） |
| 只读约束 | 遵守：`git status` 相对 `007f433` 仅新增本证据目录；审查期临时脚本已删除（见 §11） |

**为什么以 `007f433` 为准但可以在 HEAD 上跑测试**：`git diff 007f433 HEAD -- apps/api packages/contracts` **输出为空**，即 R2 提交（`ac4c385`）没有触碰任何 R1 服务端文件；因此当前工作区里跑出的 17/17 就是 `007f433` 的行为。

### 0.2 实际执行的命令与退出码

| # | 命令 | 工作区 | 退出码 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | `node --import tsx --test test/local-catalog-orders.test.ts` | `mvp-010/apps/api` | **0** | `tests 17 / suites 0 / pass 17 / fail 0 / skipped 0`，6.73 s（两次运行均 17/17） |
| 2 | `node --import tsx --test test/*.test.ts`（全量，等价于 `pnpm --filter @sanchuang-dev/local-life-api test`） | `mvp-010/apps/api` | **1** | `tests 240 / pass 232 / fail 8 / skipped 0`，17.05 s；8 例全为基线 Windows `EPERM`（1 例 `rewards-data.test.ts` + 7 例 `rewards-version-edit.test.ts`），17 例 local 全绿（见 §7.3） |
| 3 | `git diff --stat 007f433 HEAD -- apps/api packages/contracts` | `mvp-010` | **0** | 空输出 = R1 服务端未被 R2 改动 |
| 4 | 迁移/schema 一致性脚本（62 项检查，见 §5.3） | `mvp-010` | **0** | `checks: 62, failed: 0` |
| 5 | 契约语义探针（严格性 / 状态机可达性 / detail 不变量，见 §3.2） | `mvp-010` | **0** | 全部为 `true`，无不可达状态 |
| 6 | 权限矩阵探针（真 `/auth/login` staff 会话 + 真 `/auth/dev/login` 居民会话，逐路由读状态码，见 §2） | `mvp-010/apps/api` | **0** | 11 条路由判定全部符合预期；staff 会话 `POST /local-orders` → 403 |

未执行 `pnpm check`（任务明确不要求；t10 已在 detached `007f433` worktree 复核过 lint 20 warnings/0 errors、四包 typecheck 全绿）。

---

## 1. 逐条验收判定（Issue #109 · Scope R1）

> 编号沿用团队权威分解 `recon.md §2.1`（R1-1..R1-10）。Issue 原文的 R1 条目较粗（约 5 条），本卡把它展开为这 10 条可核验项，**不删不并**，逐条给判定。

| # | R1 要求（recon §2.1 原文要点） | 判定 | 关键证据（文件:行） | 覆盖测试 |
| --- | --- | --- | --- | --- |
| R1-1 | contracts 提供全部 schema/路由/错误码/类型，客户端不各写 DTO | **通过** | 25 个 `*Local*Schema`（`index.ts:1215-1577`）、`LOCAL_CATALOG_ROUTES:1181` / `LOCAL_ORDER_ROUTES:1191`、3 个新错误码 `:68/74/80`；`apps/api/src/local/**` 零硬编码路径、零自定义响应形状 | 全 17 例都以契约 schema `parse` 响应（如 `:431`、`:467`、`:513`） |
| R1-2 | drizzle schema + `0009` 迁移；空库与旧库升级均通过；含外键/唯一（幂等键）/索引 | **通过** | `schema.ts:1297/1340/1413` 三表；`0009_local_catalog_orders.sql` 120 行；`meta/0009_snapshot.json` + journal idx=9；快照链 62/62（§5.3） | `:1289`（表/索引/触发器/FK + 裸 SQL 校验）、`:1423`（旧库原地升级） |
| R1-3 | 路由覆盖：商品创建/编辑/上下架；居民登记；代录；居民查询；员工查询与状态处理；运营核验；事件/审计查询 | **通过** | **19 个 handler / 15 个路径常量**：商品 7（`routes.ts:114/126/138/152/169/181/200`）、居民 3（`order-routes.ts:139/153/171`）、员工 4（`:185/199/217/229`）、后台 5（`:250/264/276/295/314`）；`app.ts:975/983` 注册 | `:411`（全链路）、`:509-525`（事件序列）、`:779`（逐路由匿名 401） |
| R1-4 | 会话、CSRF + trusted Origin、三角色边界、网格员授权社区、跨社区隔离 | **通过** | `validCsrf` `app.ts:146-156`；`requireStaff`/`requireAdminSide`/`requireResident`/`assertCommunityAccess`/`scopeCommunityIds`（§2 矩阵）；`/staff/*` 不使用 `requireAdminSide` 一刀切 | `:779`（匿名×9+CSRF+恶意 Origin）、`:838`（角色）、`:884`（跨社区）、`:931-935`（反枚举 404） |
| R1-5 | 价格与归属以服务端为准；忽略客户端价格；快照冻结；事后调价不影响旧单 | **通过** | 请求 schema **无**价格字段（`index.ts:1491/1508`）；快照 `orders.ts:459-463`；改价不回写 `:450-473` | `:1001`（**7 类注入全 400**：`priceCents/unitPriceCents/totalCents/communityId/residentUserId/status/recordSource`）、`:1038-1058`（改价 → 旧单 500 分不变、新单 900 分） |
| R1-6 | 下架拒新登记；非法数量/金额被拒；同幂等键只出一单；并发下唯一约束生效 | **通过** | `orders.ts:442-444`（下架 409）、契约 `quantity 1..99`、唯一索引 `schema.ts:1382` + 重放 `:422-440` + 并发败者 `:499-522` | `:961`、`:1064`、`:567`、`:600`（真双进程 + `BEGIN IMMEDIATE`） |
| R1-7 | 状态机 6 态有显式迁移表；`verified` 仅表示人工核验；重复核验明确拒绝 | **通过** | `LOCAL_ORDER_STATUS_TRANSITIONS`（`index.ts:1348-1358`，实测 6 态全可达、0 死状态）+ 服务端二次校验 `orders.ts:701` + `:693` 专用 409 | `:1064`（跳级 409）、`:1103`（终态不可再动）、`:1142`（重复核验 409） |
| R1-8 | 事件追加式写入，带 actor/时间/原因，稳定 `source type + source id` | **通过** | `local_order_events`（`schema.ts:1413-1444`）+ `LOCAL_ORDER_EVENT_SOURCE_TYPE='local_order'`（`index.ts:1374`）+ 两条 `RAISE(ABORT)` 触发器（`0009:111-120`）+ `insertOrderEvent` `orders.ts:296-326` | `:1289`（触发器裸 SQL 拒绝 UPDATE/DELETE）、`:522-525`（每事件 sourceType/sourceId）、`:1181`（reason 进时间线） |
| R1-9 | 测试覆盖：正向 + 重复/无会话/越权/跨社区/下架/价格篡改/取消/并发/重启 | **通过** | 17 个顶层 `test()`、188 处断言、0 skip/only；覆盖 9 类场景各有专例 | §7 全节 |
| R1-10 | lint/typecheck/测试实跑；8 例 EPERM 需干净基线对照，不得声称已修 | **通过（本卡只核测试侧）** | 单跑 17/17 exit 0；全量 240 其中 8 例失败，与 `baseline-eprem.md` 逐例同名；`baseline-eprem.md` 已写明"不得声称已修复" | §7.3 |

**判定口径**：要求"存在且服务端强制执行"，不以"页面能点"为准（页面属 R2/t5）。

**与"5 条服务端要求"的映射**（t6 合同按 5 条表述，`recon.md §2.1` 按 10 条落细；两者是同一批要求的粗/细粒度，不是两套标准）：

| 粗粒度（t6 合同） | 覆盖的细项 |
| --- | --- |
| ① contracts 契约（schema/路由/错误码） | R1-1 |
| ② 模型与迁移（schema + 0009） | R1-2 |
| ③ Hono API 覆盖（商品/登记/代录/查询/流转/核验/事件） | R1-3、R1-7、R1-8 |
| ④ 鉴权与隔离（会话/CSRF/Origin/角色/跨社区） | R1-4 |
| ⑤ 价格快照/幂等/下架/并发 + 可验证性 | R1-5、R1-6、R1-9、R1-10 |

**注意**：R1-10 的 lint/typecheck 部分由 t10 在 detached `007f433` worktree 里跑过（4 包 typecheck 全绿、lint 0 error / 20 warning，与基线同）；本卡未重跑 `pnpm check`（任务明确不要求），故该半项为**采信 t10 记录**，非本卡实测。

---

## 2. 权限矩阵（**本卡实测**）

探针：`createApp` + 真实 `:memory:` 迁移库 + 真实 `/auth/login`（staff）与 `/auth/dev/login`（居民）会话，逐路由发请求读回真实状态码。实测输出：

```
resident login: 200 | grid login: 200 | admin login: 200
resident GET /local-orders          -> 200 total=0
resident GET /staff/local-orders    -> 401 unauthorized
resident GET /admin/local-orders    -> 401 unauthorized
grid     GET /local-orders          -> 200 total=0
grid     GET /staff/local-orders    -> 200 total=0
grid     GET /admin/local-orders    -> 403 forbidden
grid     GET /admin/catalog/products-> 403 forbidden
admin    GET /admin/local-orders    -> 200 total=0
admin    GET /admin/catalog/products-> 200 total=0
anon     GET /local-orders          -> 401 unauthorized
anon     GET /catalog/products      -> 200 total=0
```

| 角色 | 公开目录 `GET /catalog/products*` | 居民面 `/local-orders*` | 员工面 `/staff/local-orders*` | 后台目录 `/admin/catalog/*` | 后台订单/核验 `/admin/local-orders*` |
| --- | --- | --- | --- | --- | --- |
| 匿名 | **200**（有意公开，recon §4.1） | 401 | 401 | 401 | 401 |
| 居民（无 staff） | 200 | **200（只看自己）** | 401 | 401 | 401 |
| `grid_worker` | 200 | **200 但恒为空页**（见 O5） | **200（仅授权社区）** | **403** | **403** |
| `operator` | 200 | 200 但恒为空页 | 200（仅授权社区） | 200 | 200（含核验） |
| `admin` | 200 | 200 但恒为空页 | 200（全社区） | 200 | 200 |

**staff 会话打居民下单接口的实测结果**（真实在架商品）：

```
admin POST /local-orders -> 403 forbidden  "居民不属于该社区，无法登记该商品"
```

即 staff 会话**无法**借居民接口下单（`assertResidentOfCommunity` 拦住），只是 `GET` 会返回自己的空列表。详见 O5。

- 守卫实现：`local/routes.ts:65-112`、`local/order-routes.ts:74-117`。其中 **CSRF/Origin 是真正共享的同一实现**（`app.ts:146-156` `validCsrf` → `trustedOrigin` + double-submit + `hashToken` 比对会话）；`requireStaff`/`requireAdminSide`/`requireParam` 则按仓库既定风格在各路由模块内自持（`crm/routes.ts:75/83/98` 同形），**不是第二套鉴权**。
- 社区隔离：`shared.ts:100-109` `assertCommunityAccess` 越权 403；列表用 `scopeCommunityIds`（`:91`）先裁剪再查询，不是查完过滤。
- 反枚举：另一居民的订单返回 **404**（`orders.ts:609` 注释与实现），跨社区员工返回 **403**——两种语义刻意区分。测试 `:931-935`、`:1632-1636`。
- 写操作全部过 `requireCsrf`（double-submit + `trustedOrigins`），读不需要；`POST /admin/local-orders/:id/verify` 也是 CSRF 保护的 POST。
- 代录额外两条硬条件（`orders.ts:392-404`）：目标账户必须存在（否则 404，"no ghost order"），且必须已属于该商品社区；代录人必须被分配到该社区。测试 `:1269-1279`、`:942-951`。

---

## 3. 事实分离（重点：`verified` ≠ 已付款/已开通）

### 3.1 三层一致性

| 层 | 事实 |
| --- | --- |
| 契约 | `localOrderStatusSchema`（`index.ts:1332-1339`）6 态；迁移表 `:1348-1358`；`localOrderTransitionStatusSchema:1361` 显式排除 `verified` |
| 磁盘 | `local_orders_status_check`（`schema.ts:1396-1399` / `0009:81`）；**表里根本没有 payment / paid_at / activated_at / 成交 任一列**（`grep 'paid\|payment\|activated\|settled\|amount'` 在 0009 里只命中 1 行注释 `:22`） |
| 响应 | `localOrderDetailSchema`（`index.ts:1450-1483`）只有 `verification{verifiedBy,verifiedAt,note}` + `statusNote` + `events`；`superRefine` 双向约束：`verified` 必须有 verification，非 `verified` 不许有 |
| 审计 | `local_order.verified` / `local_order.rejected`，`metadata` 只有 `{fromStatus,toStatus,decision}`（`orders.ts:832-839`），无金额、无凭证 |

### 3.2 状态机可达性（脚本实测，非目测）

```
registered   -> [processing, cancelled, rejected]
processing   -> [pending_review, cancelled, rejected]
pending_review-> [verified, rejected]
verified/cancelled/rejected -> []
reachable from registered = 全部 6 态；unreachable = (none)
```

- 无**死状态**、无不可达状态、无"只能进不能出"的中间态被误设为终态。
- `localOrderDetailSchema` 的四组不变量实测：`verified` 缺 verification → 拒绝；`registered` 带 verification → 拒绝；`verification.note` 长度 1 → 拒绝；正常 `verified` → 通过。
- 语义对照：`verified` 只能由 `POST /admin/local-orders/:id/verify` 产生，且 `verifyOrder` 同事务写 `verified_by_user_id` / `verified_at` / `verification_note`；`updateOrderStatus` 遇到已验证订单直接 409 `order_already_verified`，**使"两次成功"无法被读成两笔成交**。

### 3.3 审计覆盖

8 个事件名，**6 个 `insertAudit` 调用点**（`products.ts:256/303/354`、`orders.ts:483/737/832`）全部在写事务内（失败即回滚，不会出现"改了但没审计"）：

| 动作 | 事件 | 行 |
| --- | --- | --- |
| 建商品 | `local_catalog.product.created` | `products.ts:256` |
| 改商品 | `local_catalog.product.updated`（`fields` 只记字段名，不记值） | `:303` |
| 上下架 | `local_catalog.product.shelf_changed` | `:354` |
| 居民登记 | `local_order.registered` | `orders.ts:483` |
| 代录 | `local_order.created_on_behalf` | 同上 |
| 状态流转 | `local_order.status_changed` / `local_order.rejected` | `:737` |
| 核验/驳回 | `local_order.verified` / `local_order.rejected` | `:832` |

`actorUserId` 一律取会话（`actorOf`），**从不取 body**。测试 `:528-549` 断言审计事件集合精确等于上述 6 条，且不含 `crm.` / `crmeb.` 前缀——这一条很关键：它把"本地订单不得混进广电/外部商城审计"变成了可执行断言。

---

## 4. 幂等与价格快照

| 机制 | 实现 | 复核 |
| --- | --- | --- |
| 唯一约束 | `local_orders_idempotency_uq (community_id, resident_user_id, idempotency_key)`（`schema.ts:1382-1386` / `0009:85`） | 从 0009 快照读出确为 3 列 + `isUnique: true` |
| 重放 | 先查后返 `{created:false, order}` 200（`orders.ts:422-440`）；内容不同 → 409 `order_idempotency_conflict`（`:430`） | `:567`；`matchesIntent` 比对 product/quantity/note/sourceActivity（`:341-348`） |
| 并发 | 输家被 UNIQUE 拦住后**再查一次赢家并返回它**（`:499-522`），而不是 500 | `:600-773` 用 `BEGIN IMMEDIATE` 故意制造写锁争用 + 两个真子进程，断言"1 行 / 恰好 1 个 created=true / 另一个是同一 id 的干净重放" |
| 事务 | 插入 + 事件 + 审计同一 `db.transaction` | `:449-498` |
| 价格快照 | `productName/unitPriceCents/quantity/totalCents` 全部服务端读商品行计算（`:459-463`）；`total=unit*qty` 另有 DB CHECK（`0009:80`）与契约 `superRefine`（`index.ts:1399-1407`）双保险 | `:1013-1033`（7 类注入字段全 400）、`:1040-1058`（改价后旧单快照不变） |
| 下架 | 只拒**新**登记（409 `product_off_shelf`，`:442-444`），历史订单与快照不动；公开详情对下架商品返回 404（`products.ts:149-157`） | `:961`，`:986` |
| 严格请求体 | 居民/代录/核验/上下架/改商品全为 `strictObject`；居民 body 含 `residentUserId`、代录 body 缺 `residentUserId` 均解析失败 | 探针实测 5/5 为 `true` |

**幂等键作用域是 `(社区, 居民, key)`**——同一居民在两个社区用同一个 key 会各出一单。这与 schema 注释（`schema.ts:1334-1335`）、0009 头注释（`0009:17-19`）以及 recon 的既定契约一致，属**有意设计**（跨社区互不阻塞，客户端每次提交生成新 UUID），不是缺陷；见 §9-O2。

---

## 5. schema 与 0009 迁移

### 5.1 表独立性（禁止事项的实证）

| 禁止 | 实测 |
| --- | --- |
| 不得复用 `crmServiceOrders` 广电语义 | `apps/api/src/local/**` 未 import 任何 `crm*` 表；`grep 'crm\|Crm'` 在 `local/` 下命中 6 处，**全部是注释**（`products.ts:115/153`、`routes.ts:52`、`shared.ts:31/114/135`），代码 0 引用。`local_orders` 的 `recordSource ∈ {resident, staff_on_behalf}`、状态名 `pending_review/verified` 与广电 `confirmed`（已成交）刻意不同 |
| 不得复用 `crmebOrders` / `crmebIdentities` | 同上：0 引用。`local_products` 完全自有，不是 CRM 镜像 |
| 不得写死 fixture 商品 | `local/` 下无 `seed/fixture/示例商品` 字样；商品只能经 `POST /admin/catalog/products` 创建且**初始为 `off_shelf`**（`products.ts:250`），公开目录不会凭空出现商品（`:411` 断言上架前 total=0） |
| 不得引入测试登录后门 | `/auth/dev/login`（`app.ts:513-552`）在基线 `ae8441a` 就存在，且 `NODE_ENV=production` 直接 404 + `config.ts:103` 在 production 拒绝 `AUTH_DEV_ENABLED=true`。R1 **未新增**任何登录/绕过路径（`git show 007f433 -- apps/api/src/app.ts` 只加了两个 `register*Routes` 调用） |

### 5.2 磁盘约束

| 对象 | 内容 |
| --- | --- |
| `local_orders` FK | 7 条：community→communities(restrict)、product→local_products(restrict)、resident→users(restrict)、created_by/attributed→staff_accounts(set null)、source_activity→activities(restrict)、verified_by→users(set null) |
| `local_orders` CHECK | quantity 1..99、`total = unit*qty`、status 6 值、record_source 2 值 |
| `local_orders` 索引 | 1 unique（幂等）+ 4 普通（community_status / resident_created / product / created_by_staff） |
| `local_order_events` | FK order(restrict)/actor_user(set null)/actor_staff(set null)；CHECK `source_type='local_order'` + 5 个 event 值；2 索引；**BEFORE UPDATE/DELETE 触发器 `RAISE(ABORT,'... rows are immutable')`**（`0009:111-120`），与既有 `crm_*_events` / `crmeb_order_events` 同一做法 |
| `local_products` | FK community(restrict)/created_by(set null)；CHECK price≥0、status 2 值；2 索引 |

`products.community_id` 与 `orders.community_id` 之间**没有复合外键**（订单社区 ≠ 商品社区在磁盘层不受约束），但 API 一律用 `product.communityId`（`orders.ts:453`），裸 SQL 才能造出这种行——见 §9-O1（与 t10 的 O2 同源）。

### 5.3 快照链条与漂移（62 项脚本检查，0 失败）

| 检查 | 结果 |
| --- | --- |
| `_journal.json` 条目 | 10 条，idx 0..9，最后一条 `idx=9 / tag=0009_local_catalog_orders` |
| `0009_snapshot.prevId` | `11ecf682-aff2-4181-8171-7b710c81ed71` = `0008_snapshot.id`（**MATCH**） |
| 表数 | 0008: 35 → 0009: 38，新增恰为 `local_products/local_orders/local_order_events` |
| 既有 35 表漂移 | **0 张**（逐表 JSON 全等比较） |
| 快照列 ↔ SQL 列 | 3 张新表的每一列都能在 0009 里找到同名 DDL |
| 快照 CHECK ↔ SQL | `local_orders` 4 条、`local_order_events` 2 条全部对齐 |
| 快照 FK ↔ SQL | 7+3 条 on_delete 语义一致（restrict / set null） |
| 快照索引 ↔ SQL | `local_orders` 1 unique + 4 普通、`local_products` 2、`local_order_events` 2，全部对齐 |

### 5.4 升级路径

- 空库全量迁移：`createDatabase(':memory:', migrationsFolder)` 在 **15 处**（13 个用例经 `localWorld()`→`testContext()` `:353/124`，2 处直接调 `testContext()`）反复建库——0009 在空库可执行。另有 1 处 `:1290` 直接建空库验磁盘约束。
- **已存在库原地升级**：`:1423-1518` 把 0000..0008 复制到暂存目录并截断 `_journal.json`（`:1433-1442`，断言原 journal 恰 10 条 `:1431`）建出"真旧库" → 断言 `local_*` 表数 0（`:1450-1455`）→ 插旧社区/旧居民（`:1456-1463`）→ 用完整 migrations 重开同一文件库（`:1468`）→ 断言旧行仍在、`local_*` 表数变 3（`:1483`）、随后跑通真实 HTTP（建商品→上架→登记→total 2400 `:1511`）。这是**真迁移**，不是 mock；且 `withTempDir` 的 cleanup 用 `try/catch` 吞掉 Windows `EPERM`（`:397-403`），不会把绿测试变红。
- 没有回滚语句，但 drizzle better-sqlite3 migrator 每个文件在事务中执行，失败即停在 0008——0009 头注释（`:27-28`）已说明。
- 迁移文件**不可重跑**（无 `IF NOT EXISTS`）：与 0000-0008 中 8/9 个文件一致（仅 0007 因 `DROP TRIGGER` 需要而含 1 处），属仓库既有约定，不是缺陷；靠 `__drizzle_migrations` 记录保证只跑一次。

---

## 6. 契约是否单一真相源

| 检查 | 结果 |
| --- | --- |
| 路由常量 | `LOCAL_CATALOG_ROUTES`（`index.ts:1181-1189`）5 条 + `LOCAL_ORDER_ROUTES`（`:1191-1209`）10 条；`apps/api/src/local/*.ts` **代码里无任何硬编码本地路径**（全部 `app.get(LOCAL_ORDER_ROUTES.myOrders, ...)` 形式），`grep` 只在 `order-routes.ts:53-56` 命中 3 行**注释**里的路径示例 |
| 请求/响应 schema | **25 个 `*Local*Schema` 导出**（`index.ts:1215-1577`）全部在 contracts，`apps/api/src/local/**` 不自定义任何响应形状；服务端出参一律 `schema.parse(...)`（`products.ts:141/201`；`orders.ts:218/234/275/436/516/523/580/627/674`，共 9 处），**出参也过 zod**，不是只信入参 |
| 错误码 | `product_off_shelf` / `order_already_verified` / `order_idempotency_conflict`（`index.ts:68/74/80`）进 `API_ERROR_CODES`，服务端与 R2 客户端共用 |
| 客户端复用（R2 已落地的旁证） | `apps/web/src/services/localOrders.ts:44/65/82/101/119/147`、`apps/admin/src/services/localOrders.ts:45/65/91/109/121` 全部用同一批常量 |
| 是否有第二真相源 | 无。服务层只在 `createProduct` 内**再 parse 一次**请求（`products.ts:235`，注释说明防直调漂移），是加强而非复制 |

---

## 7. 测试真实性

### 7.1 结构

- 文件：`apps/api/test/local-catalog-orders.test.ts`，1646 行，**17 个顶层 `test()`**（无 `describe`），**188 处 `assert`**。
- **0 处 `.only` / `.skip` / `todo` / `assert.ok(true)` 占位**（`grep` 复核）。

### 7.2 不是空壳的证据

| 用例 | 真实性证据 |
| --- | --- |
| 端到端 `:411` | 真 `createApp` + 真 Hono `app.request` + 真 SQLite 迁移；断言快照深等、事件序列深等、审计事件集合深等 |
| 并发 `:600` | `spawn` 两个**真实子进程**（`process.execPath --import tsx`），父进程 `BEGIN IMMEDIATE` 卡住写锁 600 ms 制造"必输"的竞态，再 `COMMIT`；断言 1 行、恰好 1 个 `created:true`、另一个是同一 id 的重放 |
| 迁移 `:1289` | 直查 `sqlite_master` 取 table/index/trigger；再用**裸 SQL** 触发 `CHECK`/`UNIQUE`/触发器，断言报错文本含 `CHECK constraint failed` / `UNIQUE constraint failed` / `immutable` |
| 升级 `:1423` | 真截断 journal 造旧库（`:1433-1442`）→ 真原地升级（`:1468`）→ 真 HTTP 跑通 |
| 重启 `:1524` | 关连接重开同一文件库，断言订单/快照/事件/审计仍在且行数不增 |
| 反注入 `:1001` | 逐个字段注入 `priceCents/unitPriceCents/totalCents/communityId/residentUserId/status/recordSource`（7 个，`:1013-1033`）全部 400；再改商品价，旧单快照不变 |

### 7.3 复跑结果

- 本卡单跑：**17/17 pass，exit 0**（重复两次结果一致）。
- 全量套件：`tests 240 / pass 232 / fail 8 / skipped 0 / todo 0`，exit 1。8 例全为基线 Windows `EPERM`，分布与 `baseline-eprem.md §3` 逐例一致：**1 例在 `test/rewards-data.test.ts`**（`rmSync` @ `:342`）、**7 例在 `test/rewards-version-edit.test.ts`**（`cleanup` @ `:161` 未先 `sqlite.close()`）。为排除"计数巧合"，我单独跑了这两个文件：`tests 15 / pass 7 / fail 8`，失败名集合与全量运行完全相同。**这 8 例不得读作 R1 引入，也不得声称已修复**；本卡没有改测试去掩盖它们。

### 7.4 弱点（不阻断）

1. `:1174-1175` 用 `JSON.stringify(order).includes('paid')` 断言"没有付款概念"——字符串级检查偏弱（`"unpaid"` 也会命中，且若字段叫 `settled` 就漏）。补强项已在 `:505-506`（`'paid' in verified === false`）与契约本身无该字段，实际风险很低。
2. 分页/筛选参数（`pageSize`、`page`、`category`、`keyword` 除 `%25` 转义外）覆盖薄：`grep` 计数 `pageSize=0`、`page==0`、`category==0`。属覆盖面缺口，不是错误。
3. 网格员"能否处理他人订单"未断言（本地订单是按**社区**授权，不按 owner，见 §9-O3）。

---

## 8. 与 t10 `verification-api.md` 的对照

t10 的结论是 pass、阻断项 0、3 条可选改进。本卡**逐条复核其现状**（不背书、自己重查）：

| t10 项 | 现状 | 本卡判定 |
| --- | --- | --- |
| O1：`verified` 行若 `verified_at` 为 NULL，`toDetail`（`orders.ts:271-288`，`verification` 三元组在 `:277-284`）给 `verification:null`，触发 `localOrderDetailSchema` superRefine（`index.ts:1467-1482`）抛 ZodError → `app.ts:1024-1034` 兜成 **500**，而同一条记录在列表接口是 200 | **未修复**：0009 只有 4 条 CHECK（`0009:79-82`），没有 `status<>'verified' OR verified_at IS NOT NULL` | **接受，不阻断**。可达性：API 不可达（`verifyOrder` 同事务写三字段 `:790-806`；`updateOrderStatus` 对 verified 直接 409 `:693`）。需要裸 SQL 或未来迁移事故。已在 §9-F2 给出「加 CHECK 或改 `toDetail` 抛 409」二选一，建议 PR 前顺手做，否则记入 0010 |
| O2：`local_orders.community_id` 与商品社区无复合外键 | **未修复** | **接受，不阻断**。API 一律取 `product.communityId` |
| O3：居民无自助取消入口（`cancelled` 只能由员工触发） | **未修复，且是范围裁剪**：`/local-orders` 只有 GET/POST | **接受，不阻断**，但需产品确认。R1 契约与 R2 只读页面（`MyOrderDetailPage.tsx:161` 注释）两边一致，说明是有意为之；我在 §9-O4 把它记为待确认项而非缺陷 |
| 声称的 129 项独立端到端 + 14 项真进程 | 我**未复用**其脚本与断言；只用仓库自带 17 例与自己的 62 项迁移脚本独立复核 | 其结论与本卡一致的部分我采信；不一致处以上文实测为准 |

**明确不背书的部分**：t10 的 129 项里对 R2 页面、CRMEB 回归、性能、Linux CI 的表述不在本卡范围，我不引用其为 R1 的通过依据。

---

## 9. 发现项（全部 low，非阻断）

> `verdict=pass` 的依据是「无阻断、无中高级问题」。以下 **6 条**建议在 t8 整合或后续小改中处理，不需要为它们重开 R1；F2、F6 是其中最容易顺手做掉的两条。

| id | 级别 | 文件:行 | 问题 | 期望修复 |
| --- | --- | --- | --- | --- |
| F1 | low | `apps/api/src/local/orders.ts:848-851`（`orderCommunity`）、`apps/api/src/local/shared.ts:51-53`（`isoOrNull`）、`shared.ts:116-125`（`applyCommunityScope`） | 三个导出**全仓 0 处引用**（`orderCommunity` 的注释还写着"Exposed for the routes' 404-vs-403 decisions"，但路由从未调用；`applyCommunityScope` 的语义被 `listAdminProducts`/`listStaffOrders` 各自内联实现替代）。死代码会让后来者以为存在某条未使用的权限通道 | 删除三个导出；若确实想复用 `applyCommunityScope`，则改 `products.ts:164-176`、`orders.ts:623-635` 用它，别留两套 |
| F2 | low | `apps/api/db/migrations/0009_local_catalog_orders.sql:79-82` | 缺 `CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND verification_note IS NOT NULL))`，使 t10-O1 的「detail 500 / list 200」自相矛盾在磁盘层可造 | 二选一：① 加这条 CHECK（3 行 DDL）+ 在 `test:1289` 后补一条裸 SQL 拒绝用例；② 或按 t10-O1' 在 `orders.ts:271-290` 对「verified 但缺 verifiedAt」抛 `LocalError(409, conflict, ...)`，避免 500。**别两处都不做** |
| F3 | low | `apps/api/src/local/orders.ts:282` | `note: row.verificationNote ?? '人工核验'`——当列为 NULL 时**凭空造一条运营从未写过的备注**。当前 API 不可达（`verifyOrder` 必写），但它把一个数据异常伪装成合法事实，与"verified 是可追溯的人工事实"这一核心语义相冲突 | 改成 `verification.note` 允许 `null`（契约放宽为 `z.string().min(2).max(500).nullable()`），或对 NULL 走 F2 的异常分支返回 409 |
| F4 | low | `apps/api/src/db/schema.ts:1366-1369` + `apps/api/src/local/orders.ts:466` | `attributed_staff_id` 永远被赋成 `created_by_staff_id`（`:466`），两列一事实；而契约同时暴露 `createdByStaff` 与 `attributedStaff`（`index.ts:1418/1420`），R2 工作台据此显示"归属网格员"（`WorkbenchLocalOrderDetailPage.tsx:149-150`）——但居民自登记单两者皆 null，运营可能误读为"尚未归属" | 二选一：删掉 `attributedStaff` 或让它承载真实归属（如网格员首次处理时写入）；否则在契约注释里写明"本地订单的代录人即归属人，居民自助单无归属" |
| F5 | low | `apps/api/test/local-catalog-orders.test.ts:1174-1175` | 用 JSON 字符串包含判断"没有付款概念"，偏弱（`unpaid`/`settled` 均漏） | 改为断言 `Object.keys(verified)` 与 `localOrderDetailSchema.keyof().options` 的差集，或直接断言 `'paid' in verified === false && 'settled' in verified === false` |
| F6 | low | `apps/api/test/local-catalog-orders.test.ts:1103` | 用例标题是「**a resident may cancel**, and a cancelled order is final」，但正文第一步恰恰断言居民 `PATCH /staff/local-orders/:id/status` → **401**（`:1111-1115`），随后是**网格员**代取消（`:1117-1119`，备注「居民来电取消」）。标题与断言相反，会让 reviewing/PR 读者误以为居民自助取消已实现（与 O4 的范围裁剪相冲突） | 改名，例如 `a staff member can cancel on the resident's behalf and a cancelled order is final`；若产品确认要居民自助取消，则按 t10-O3 另开路由 |

### 观察项（不是缺陷，记录以免后续误判）

- **O1**：订单社区与商品社区无磁盘级绑定（同 t10-O2），API 不可达。
- **O2**：幂等键作用域 `(community, resident, key)`——同居民跨社区同 key 会各出一单。与契约/0009 注释一致，属有意（跨社区互不阻塞）；R2 客户端每次登记生成新 UUID，实际不会触发。
- **O3**：网格员可按"授权社区"处理**同社区内任意**订单（包括其他网格员代录的）。这与 CRM 的 `assertOrderAccess`（`crm/service.ts:298-311`，网格员只能动自己名下）**不同**，但符合 R1/R2 契约"网格员工作台仅处理授权社区订单"的措辞，是有意差异，不是回退。
- **O4**：居民自助取消缺失（同 t10-O3），需产品确认；R1 契约、R2 页面、t10 报告三者一致地按"员工代取消"实现。
- **O5（实测补充）**：`/local-orders` 只判"有会话"，不判"会话属于居民"。实测 staff 会话 `GET /local-orders` → **200 + 自己的空列表**（不是 401/403），只有 `POST` 会被 `assertResidentOfCommunity` 拦成 403（`orders.ts:407`）。**无数据泄露、无越权**（列表硬绑 `residentUserId = actor.userId`，staff 自己的 userId 下永远没有订单），但提示文案 `'请先登录居民账户'`（`order-routes.ts:77`）只在**无**会话时出现，对 staff 会话不适用——现象与文案不一致，属体验瑕疵，不是安全缺陷。

---

## 10. 与既有约定的偏差（可接受）

| 偏差 | 说明 | 判定 |
| --- | --- | --- |
| 服务层拆成 5 个文件（`shared/products/orders/routes/order-routes`）而非 `crm/service.ts` 单文件 | R1 有 1917 行服务代码（`order-routes 325 + orders 853 + products 364 + routes 220 + shared 155`），拆分后 `orders.ts` 853 行仍偏大，但职责清晰（shared 只放错误/并发/审计原语） | 可接受 |
| 新增 `/staff/local-orders*` 面 | `/admin/*` 按仓库既有约定对 `grid_worker` 一律 403，而网格员必须能处理授权社区订单；故用三个前缀三种守卫 | 可接受，且已在路由注释（`order-routes.ts:49-60`）说明 |
| `LocalError` 而非扩展 `CrmError` | 仓库里已有 8 个同构域错误类（`ActivityError`/`PhoneOtpError`/`CrmError`/`CrmebClientError`/`CrmebDomainError`/`ParticipationError`/`RewardError`/`ConfigError`），R1 只是再加第 9 个 | 可接受，**不是**第二套栈 |
| 守卫 helper 在 `routes.ts`/`order-routes.ts` 各写一份 | `crm/routes.ts` 同样自持 6 个 helper，是仓库既定风格 | 可接受 |
| lint 20 warnings 不变 | R1 未新增 warning（t10 复核）；本卡未跑 `pnpm check`，不重复背书 | — |

---

## 11. 结论

**verdict = pass**（status → completed）。

- Issue #109 R1 的服务端要求（按 `recon.md §2.1` 展开为 R1-1..R1-10）逐条成立，口径是"服务端强制 + 有真实测试"。
- 6 项抽查：权限矩阵 ✓、事实分离 ✓、幂等与价格快照 ✓、迁移与 schema 一致（62/62）✓、禁止事项 4 条 ✓、测试真实性 ✓。
- 0 阻断 / 0 中级；**6 条 low 发现**（F1-F6）建议后续处理，其中 F2 只需 3 行 DDL、F6 只是改个用例标题，若 t8 整合方便可顺手带上。
- 与 t10 的对照：O1/O2 未修复，本卡**明确接受**并给出可达性论证；O3 需产品确认。t10 的 pass 结论我不整体背书，仅采信与本卡实测重合的部分。
- 唯一"未由本卡实测"的验收半项是 R1-10 的 lint/typecheck（采信 t10 的 detached-worktree 记录），已在 §1 脚注标明。

### 本卡没有验证的东西（不得读作通过）

1. **浏览器/H5/管理台交互**：不在本卡范围（R2 由 t7、视觉由 t5）。本文所有"通过"都只到 HTTP + SQLite + 磁盘约束层。
2. **Linux/CI**：所有命令都在本机 Windows 跑；8 例 EPERM 在 Linux 上是否出现未验证。
3. **性能/压力**：`keyword` 走 `LIKE %...%` 无索引（`orders.ts:645-650`、`products.ts:124-132`），大目录/大订单量未测。
4. **Issue #109 原文**：本机无 `gh`，验收面来自 t3/t4/t5 契约与 `recon.md`；若原文另有条款（尤其居民自助取消），需补验。
5. **安全专项**：未做速率限制、XSS/SQL 注入模糊测试；只验证了设计内控制（CSRF double-submit、Origin 白名单、strict body、社区裁剪、404 反枚举）。

### 现场清理

审查期临时脚本（`.tmp-contract-probe.mjs`、`.tmp-migration-audit.mjs`、`.tmp-review-temp/` 等）已删除；`git status` 相对 `007f433` 仅本证据目录。未修改任何业务文件。
