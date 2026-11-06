# LL-MVP-010 · 仓库事实勘察（recon）

> 勘察人：`recon-archaeologist`（只读，未修改任何业务文件）
> 时间：2026-11-06（Asia/Shanghai）
> 工作区：`E:\tomz\local-life-wt\mvp-010`；分支 `feat/ll-mvp-010-local-catalog-orders`；基线 `origin/dev@ae8441a`
> 本文只记录**当前代码事实**与可施工建议。凡与 Issue 描述不一致处，一律以实际代码为准，并在 §5 单列。
> 应用方式：R1（`t3`）与 R2（`t4`）实现者把本文当作统一命名与复用清单；验证者（`t5`）把本文当作「已有能力」基线。

---

## 0. 一页结论（先读）

1. **本地商品目录 + 本地订单是全新领域，仓库里 0 处已有实现。** 全仓检索 `local_catalog` / `localOrder` / `local_order` / `本地商品` 均无命中；`packages/contracts` 里所有 `product*` 符号都属于 CRMEB 镜像（`crmebProductSummarySchema` 等），**不可复用为本地商品 DTO**。
2. **可复用的底座非常完整**：契约优先（zod + 路由常量 + 统一错误信封）、Drizzle/SQLite 迁移链（0000–0008）、`CrmError`/`requireStaff`/`validCsrf`/`bodySchemaError`/`insertAudit` 的服务-路由模式、`DataPanel`/`AppShell`/`Drawer`、H5 的 `PageHeader`/`AppShell`/`WorkbenchUi`/`useStaffSession`，都有可直接照抄的样板。**新增代码应当"接骨头"而不是"重新造骨架"。**
3. **两个必须先解决的冲突**：
   - `CRM_ROUTES.orderList = '/crm/orders'` 已经属于**广电手机卡/电视受理单**（`crm_service_orders`，`businessType: gd_mobile|gd_tv`，`confirmed = manual_verification`）。本地订单**绝不能**复用这条路径、这张表、这套状态机，否则语义彻底混淆。
   - 管理台导航 `/products`（商品管理）与 `/orders`（订单管理）目前是 `status: 'planned'` 的占位页；R2 必须把它们翻成 `ready` 并接真实页面，否则真实页面会被 `PLANNED_PAGES` 的 `PlaceholderPage` 抢先匹配。
4. **迁移下一个编号是 `0009`，但只写 `.sql` 不会生效**：`migrate()` 由 `meta/_journal.json` 驱动，必须同时补 `meta/0009_snapshot.json` 与 journal 条目（先例：`0003_crm_core`、`0007_...` 都是手工命名的）。
5. **H5 详情路由存在分流冲突**：`/life/product/:productId` 现在是「纯数字 → CRMEB 详情；非数字 → 积分演示商品」。本地商品 id 是 UUID，会被吸进积分演示分支。必须为本地商品开**独立路径**。
6. **测试基建可直接照抄**：`apps/api/test/crm.test.ts` 提供了建库/迁移/HTTP/CSRF/登录/文件库重启的完整样板；管理台用 `src/test/render-admin.tsx` + `stubApi` 前缀表；**H5 完全没有测试框架**（`apps/web/package.json` 无 `test` 脚本，0 个测试文件），R2 的 H5 侧只能靠 typecheck + 真实 Chrome 证据。

---

## 1. 现有实体与可复用能力

### 1.1 `packages/contracts`（单一契约源）

包名 `@sanchuang-dev/local-life-contracts`，zod `4.6.7`，`tsc` 编译到 `dist`（`apps/*` 通过 workspace 依赖引用 `dist`，**改契约后必须先 build**）。

| 位置 | 事实 |
| --- | --- |
| `src/index.ts:6-14` | `API_ROUTES`（health / authMethods / authCsrf / authSession / authLogin / authLogout / authWechatStart） |
| `src/index.ts:16` | `SERVICE_NAME = 'local-life-api'` |
| `src/index.ts:18-64` | `API_ERROR_CODES`（**33 个码**：`not_found`/`internal_error`/`invalid_request`/`unauthorized`/`forbidden`/`conflict`/`rate_limited`/`not_configured`/`activity_unavailable`/`team_full`/`invite_invalid`/`crmeb_upstream_error`/`crmeb_timeout`/`crmeb_contract_mismatch`/`crmeb_sync_in_progress`/`reward_*`/`checkin_*`/`redemption_*`/`prize_stock_exhausted`/`budget_exceeded`/`reward_plan_locked`/`phone_*`/`otp_*`/`sms_delivery_failed`） |
| `src/index.ts:66` | `type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]` |
| `src/index.ts:68-70` | 本地 `isoTimestamp` 正则（`YYYY-MM-DDTHH:mm:ss.sssZ`）；`rewards.ts:19-21` 有一份同形私有副本 |
| `src/index.ts:84-92` | `apiErrorSchema` = `{ error: { code, message, requestId? } }`；**所有失败响应都必须长这样** |
| `src/index.ts:94-95` | `staffRoleSchema = z.enum(['admin','operator','grid_worker'])` |
| `src/index.ts:123-133` | `authCommunitySchema {id,name}`、`authStaffSchema {id,username,role,communities}` |
| `src/index.ts:135-145` | `authSessionResponseSchema`（`discriminatedUnion('authenticated')`） |
| `src/index.ts:305-316` | `ACTIVITY_ROUTES`（`/activities`、`/admin/activities`、`/activities/:activityId` …） |
| `src/index.ts:540` | `publicActivityListResponseSchema` |
| `src/index.ts:649-670` | `CRM_ROUTES`（含 `/crm/orders`、`/admin/crm/orders`、`/admin/crm/orders/:orderId/review`、`/admin/crm/filter-options`） |
| `src/index.ts:677-732` | CRM 枚举：来源 `activity`/`grid_promotion`/`walk_in`/`resident_referral`、线索 `new`/`contacting`/`converted`/`invalid`、业务类型 `gd_mobile`/`gd_tv`、受理单状态 `submitted`/`processing`/`pending_verification`/`confirmed`/`failed`/`cancelled`、`CRM_ACTIVATION_SOURCE='manual_verification'` |
| `src/index.ts:739-756` | `CRM_LEAD_STATUS_TRANSITIONS` / `CRM_ORDER_STATUS_TRANSITIONS`（冻结状态机，服务端唯一权威） |
| `src/index.ts:759-772` | 事件枚举 `crmLeadEventTypeSchema` / `crmOrderEventTypeSchema`（`order.created`/`order.status_changed`/`order.reviewed`） |
| `src/index.ts:775-796` | `crmContactPhoneSchema`、`crmStaffRefSchema`、`crmActivityRefSchema`、`crmUserRefSchema` |
| `src/index.ts:800-824` | `crmLeadSummarySchema` / `crmLeadDetailSchema`（列表只给 `contactPhoneMasked`，详情才给全号） |
| `src/index.ts:944` | `crmLeadListQuerySchema`（page/pageSize/communityId/staffId/status/sourceType/keyword） |
| `src/index.ts:965-1010` | `crmOrderSummarySchema` / `crmOrderEventSchema` / `crmOrderDetailSchema`（`superRefine`：`confirmed` ⇔ `activationSource==='manual_verification'` 且必须有 confirmation） |
| `src/index.ts:1052-1094` | `createCrmServiceOrderRequestSchema` / `updateCrmOrderStatusRequestSchema`（`failed` 必须有 `failureReason`）/ `crmOrderReviewRequestSchema`（`decision`: `confirm`/`reject`，`note` 2-500） |
| `src/index.ts:1096-1118` | `crmOrderListQuerySchema` / `crmOrderListResponseSchema` / `crmOrderEventListResponseSchema`（列表统一 `{items,total,page,pageSize}`，时间线统一 `{items}`） |
| `src/index.ts:1122-1147` | `adminCrmLeadListResponseSchema` / `adminCrmOrderListResponseSchema` / `crmStaffOptionSchema` / `adminCrmFilterOptionsResponseSchema` |
| `src/index.ts:1159-1162` | `PARTICIPATION_ROUTES`（GET/POST 共用同一路径） |
| `src/index.ts:1324-1339` | `activityParticipationConfirmRequestSchema`（`z.strictObject`：只收 `inviteCode`，伪造 `userId` 直接解析失败）/ `...ConfirmResponseSchema {created, state}` |
| `src/index.ts:1341-1342` | `export * from './crmeb.js'`、`export * from './rewards.js'` |
| `src/index.ts:1357-1362` | `PHONE_AUTH_ROUTES` |
| `src/index.ts:1365-1399` | `MAINLAND_MOBILE_PATTERN`、`normalizeMainlandPhone`、`maskMainlandPhone`、`mainlandPhoneSchema` |
| `src/crmeb.ts:23-32` | `CRMEB_ROUTES`（`/integrations/crmeb/*`、`/admin/integrations/crmeb/*`） |
| `src/crmeb.ts:42-50` | `crmebAdapterStatusSchema`（**不含** baseUrl/appid/appsecret） |
| `src/crmeb.ts:197-232` | `crmebProductSummarySchema` / `...DetailSchema` / `...ListResponseSchema`（金额 `priceCents` 整数分） |
| `src/crmeb.ts:467` | `CRMEB_PURCHASE_WARNINGS` |
| `src/rewards.ts:27-52` | `REWARD_ROUTES` |
| `src/rewards.ts:66-885` | 奖励计划/签到/凭据/争议全部 schema（大量 `z.strictObject`） |

**可复用约定（必须照做）**：
- 每个路由字符串都来自 `*_ROUTES` 常量，API 与三个客户端都不得硬编码路径。
- 每个响应在 `c.json()` 之前用共享 schema `.parse()`，服务端 bug 会变成 500 而不是泄漏非法 payload。
- 请求体用 `z.strictObject`（新代码推荐）或 `superRefine` 表达跨字段规则；未知字段解析失败，不做静默丢弃。
- 金额一律**整数分**（`priceCents` / `*Cents`），任何浮点都会破坏既有约定。

### 1.2 `apps/api/src/db/schema.ts`（35 张表）

`sqliteTable(...)` 共 35 处。表清单（含本卡相关行号）：

| 分组 | 表 | 行 |
| --- | --- | --- |
| 身份 | `communities` | 35 |
| | `users` | 41 |
| | `wechat_identities` | 48 |
| | `staff_accounts` | 64 |
| | `staff_community_assignments` | 79 |
| | `resident_community_assignments` | 96 |
| | `sessions` | 109 |
| | `oauth_states` | 128 |
| | `rate_limits` | 145 |
| | `audit_logs` | 152（表名在 153，索引 163/164） |
| 手机号 | `resident_phone_identities`(186)、`phone_verification_codes`、`phone_otp_request_counters` | 186 |
| 活动 | `activities`(288)、`activity_rule_versions`(336)、`activity_teams`(554)、`activity_invitations`(590)、`activity_participations`(625) | 288 / 336 / 554 |
| CRM（广电） | `crm_leads`(366)、`crm_lead_events`(414)、`crm_follow_ups`(445)、`crm_service_orders`(473，表名 474，唯一键 512，状态索引 516)、`crm_order_events`(524，表名 525，索引 541) | 366 / 414 / 445 / 473 / 524 |
| CRMEB 镜像 | `crmeb_identities`(671，表名 672)、`crmeb_orders`(704，表名 705)、`crmeb_order_events`(751)、`crmeb_refunds`、`crmeb_click_attributions`、`crmeb_sync_runs` | 671 / 704 |
| 奖励 | `activity_checkins`(896)、`activity_reward_grants`(967)、`activity_reward_codes`(1061)、`activity_prize_stocks`(1145)、`activity_reward_events`(1201)、`activity_reward_disputes`(1248) | 896 / 967 |

**本卡必须模仿的表结构要点**：
- `communities.id` 是 text 主键；所有业务表用 `community_id` + `references(() => communities.id, { onDelete: 'restrict' })`（见 `activities:292`、`crm_service_orders:477`）。
- 时间列统一 `integer('...', { mode: 'timestamp_ms' }).notNull()`，JS 侧拿到 `Date`。
- 索引命名 = `表名_字段_idx`，唯一索引 = `表名_字段_uq`（如 `crm_service_orders_community_order_no_uq:512`、`activity_teams_activity_leader_uq:569`）。
- `audit_logs(id, actor_user_id, event, target_id, metadata json-text, created_at)` + `audit_logs_created_idx` / `audit_logs_target_idx`（152-166）。审计是**独立于业务事件表**的第二条痕迹。
- 追加式表（`crm_order_events:524`、`crmeb_order_events:751`）**只有 `index(order_id, created_at)`，没有 `updated_at`**；不可变性由迁移里的 SQLite 触发器保证，不在 Drizzle 层。
- `crmeb_orders`（704）语义是**外部镜像**：`channel` 固定 `'crmeb'`、`external_order_id` / `external_order_no` 必填、`raw_status` / `raw_hash` 必填、`valid_transaction` 由拉取计算。**本地订单塞进这张表会在逻辑上直接说谎**。
- `crmeb_identities`（671）是 `platform_user_id ↔ crmeb_uid` 的绑定表，与本地订单无任何关系。

### 1.3 `apps/api/db/migrations`（0000–0008，现状）

| 文件 | 表 / 索引 / 触发器（脚本实跑计数） | 内容 |
| --- | --- | --- |
| `0000_freezing_micromax.sql` | 10 / 12 / 0 | `audit_logs, communities, oauth_states, rate_limits, resident_community_assignments, sessions, staff_accounts, staff_community_assignments, users, wechat_identities` |
| `0001_oval_mulholland_black.sql` | 2 / 6 / 2 | `activities`、`activity_rule_versions`；触发器 `activity_rule_versions_no_update`/`_no_delete` |
| `0002_nosy_white_queen.sql` | 3 / 9 / 10 | `activity_invitations, activity_participations, activity_teams`；含 `activity_teams_status_transition`、`activity_participations_team_consistency` 等 |
| `0003_crm_core.sql` | 5 / 13 / 6 | `crm_leads, crm_lead_events, crm_follow_ups, crm_service_orders, crm_order_events`；6 个 `*_no_update`/`*_no_delete` |
| `0004_polite_black_bird.sql` | 6 / 20 / 2 | `crmeb_*` 6 张表；`crmeb_order_events_no_update`/`_no_delete` |
| `0005_opposite_gunslinger.sql` | 0 / 2 / 2 | 无新表；`crmeb_order_events` 原地加 `sequence`、回填、换唯一键（`crmeb_order_events_order_sequence_uq`）、触发器重建 + `_sequence_guard` |
| `0006_wakeful_wallow.sql` | 6 / 20 / 32 | `activity_checkins, activity_prize_stocks, activity_reward_codes, activity_reward_disputes, activity_reward_events, activity_reward_grants`；32 个触发器（状态机 + write-once + 冻结计划守卫） |
| `0007_dispute_dismissed_restores_grant.sql` | 0 / 0 / 1 | 无新表；重写 `activity_reward_grants_status_transition` + 数据修复（仅 2 个 statement-breakpoint） |
| `0008_motionless_chat.sql` | 3 / 4 / 0 | `phone_otp_request_counters, phone_verification_codes, resident_phone_identities` |

> 参照量级：本卡 `0009` 若加 3 表 + 8 索引 + 2 触发器，`statement-breakpoint` 约 13 个，与 `0003`（23）/`0008`（6）之间，属正常规模。

配套元数据（全部实跑核对）：
- `meta/0000_snapshot.json` … `meta/0008_snapshot.json` 齐全，表数 10→12→15→20→26→26→32→32→**35**；`0005`/`0007` 两条"无新表"迁移直接复制上一版快照，只换 `id`/`prevId`（`0006` 与 `0007` 字节数同为 133436）。
- 快照链（`prevId` 必须指向上一版 `id`）：`0008.id = 11ecf682-aff2-4181-8171-7b710c81ed71`，其 `prevId = 7ceb0a92-9678-4158-b9b3-879bbac8d6ae`（= `0007.id`）。**`meta/0009_snapshot.json` 的 `prevId` 必须写 `11ecf682-…`。**
- `meta/_journal.json`：`{"version":"7","dialect":"sqlite","entries":[{idx,version:"6",when:<epoch ms>,tag:"000X_...",breakpoints:true} × 9]}`，当前 idx `0..8`，最后一条 `{"idx":8,"version":"6","when":1793873021636,"tag":"0008_motionless_chat","breakpoints":true}`。
- 迁移在应用启动时自动执行：`src/db/client.ts:28` `migrate(db, { migrationsFolder: resolve(migrationsFolder) })`，`apps/api/src/index.ts:21` 用 `new URL('../db/migrations', import.meta.url)` 定位。
- `drizzle.config.ts`：`schema './src/db/schema.ts'`、`out './db/migrations'`、`dialect 'sqlite'`、`url process.env.DATABASE_PATH ?? '../../.data/local-life.sqlite'`；`apps/api` 有 `db:generate` = `drizzle-kit generate`。
- 迁移文件格式（照抄 `0003_crm_core.sql`，drizzle 输出用**反引号**、列名以 Tab 缩进）：`CREATE TABLE \`x\` (...)` → `--> statement-breakpoint` → `CREATE [UNIQUE] INDEX \`x\`` → `--> statement-breakpoint` → `CREATE TRIGGER \`x_no_update\` BEFORE UPDATE ON \`x\` BEGIN SELECT RAISE(ABORT, 'x rows are immutable'); END;`。
- 大迁移允许带**完整的中文/英文注释块与回滚说明**（`0007` 就是范例），评审会读。

### 1.4 `apps/api/src/crm` —— 服务/路由模式（本卡第一样板）

`routes.ts`（436 行）：
- `CrmRouteDeps { db, config, fail, validCsrf, bodySchemaError }` `:40-51`；由 `createApp` 注入（`app.ts:957-963`），**不自己实现鉴权**。
- `failWithCrmError(c, error)` `:68-73`：`instanceof CrmError` → `fail(c, status, code, message)`，否则 `throw`（落到 `onError` 变 500）。
- `requireStaff` `:75-81`：无 `session.staff` → `401 unauthorized '请先登录管理后台'`。
- `requireAdminSide` `:83-90`：`role === 'grid_worker'` → `403 forbidden '网格员无权访问后台 CRM'`。
- `actorOf(guard)` `:92-96` → `CrmActor { userId, staffId, role }`（服务端解析出的身份，不信任客户端）。
- `requireParam(c, 'leadId'|'orderId')` `:98-104`：uuid 校验失败 → `404`（**不是 400**，避免探测）。
- `requireCsrf` `:106-111`：`validCsrf(c, config, guard.session)` 失败 → `403 'CSRF 校验失败'`。
- `queryObject(c)` `:115-121`：丢弃空字符串查询值，`?status=` 等价于不过滤。
- 每个 handler 形如：guard → csrf → 参数 → body → `try { c.json(service(db, actor, ...)) } catch { failWithCrmError }`（`createLead` `:145-160` 是最小完整例子）。

`service.ts`（1596 行）：
- `CrmActor` `:82-86`；`CrmError(status: 400|403|404|409, code, message)` `:92-102`。
- `iso()` `:230`、`isoOrNull()` `:234`。
- `maskContactPhone()` `:239-246`（列表脱敏，详情给全号）。
- `assertExpectedUpdatedAt(actual, expected)` `:248-252` → 不等即 `409 '数据已被其他操作更新，请刷新后重试'`。
- `nextUpdatedAt(previous, now)` `:255-257` = `max(now, previous+1ms)`，**乐观令牌必然前进**。
- `mapConstraintError(error)` `:259-265`：`/UNIQUE constraint failed|constraint failed/` → `409 conflict`，其余重抛。
- `escapedLike()` `:267-269` + `LIKE ... ESCAPE '\\'` `:1251-1252`（关键词注入防护）。
- `assignedCommunityIds(db, staffId)` `:271-278`、`assertCommunityAccess` `:280-285`、`assertLeadAccess` `:287-296`、`assertOrderAccess` `:298-311`（社区 → 归属两级判定）。
- `insertAudit(tx, actorUserId, event, targetId, createdAt, metadata?)` `:592-610`；`insertLeadEvent` `:612-640`；`insertOrderEvent` `:642-666`（事件与审计成对写入，同一事务）。
- `listOrders` `:1197-1273` 是**列表 + 权限裁剪 + 过滤 + 分页**的完整样板（grid worker 空社区直接返回空页，不报错）。
- `createOrder` `:1290-1350`：取父实体 → 授权 → 事务内 `insert order` + `insert event` + `insertAudit` → `mapConstraintError` → 返回 `detailById`。
- `updateOrderStatus` `:1352-1408`：状态机校验 → 必填原因 → `expectedUpdatedAt` → 事务内**条件 UPDATE**（`eq(id)` + `eq(status, 旧)` + `eq(updatedAt, 旧)`）→ `changes !== 1` 抛 409 → 写事件 + 审计。
- `reviewOrder` `:1410-1490`：`grid_worker` 先 403；只允许 `pending_verification`；`confirm/reject` 两分支；同一事务内推进线索状态。

**这套"服务层抛 `XxxError`、路由层翻译、事务内事件+审计、条件 UPDATE 防并发"就是本卡必须复刻的形状。**

### 1.5 CRMEB adapter 边界（不可跨越）

- `apps/api/src/crmeb/routes.ts`：`requireConfigured` `:101` 未配置 → `503 not_configured`；商品列表 `:131`、详情 `:151`、购买跳转 `:166`（必须居民会话 + CSRF）、`identityMe :195`、`adminIdentityBind :207`（admin-only）、`adminIdentityRevoke :238`。
- `apps/api/src/crmeb/products.ts:114` `onShelf = Number(raw.is_show) === 1`；`:155` 列表过滤 `onShelf`；`:180` 详情 `!onShelf` 直接 404。**"下架商品拒绝访问"已有先例**，本地目录应保持同样语义。
- `apps/api/src/crmeb/errors.ts`：`CrmebDomainError` + `toCrmebHttpFailure`。
- 边界结论：**本地商品/本地订单完全不经过 adapter**，也不得因 adapter `not_configured` 而不可用。反过来，adapter 也不得读取本地订单表。

### 1.6 身份 / 会话 / CSRF / Origin

- `apps/api/src/http.ts:5-17` `AuthSession { sessionId, userId, displayName, csrfHash, expiresAt, staff {id,username,role,status}|null }`；`:28` `HttpErrorStatus = 400|401|403|404|409|429|500|503`。
- `apps/api/src/app.ts`：cookie 名 `ll_session` `:72`、`ll_csrf` `:73`（`ll_csrf` 非 httpOnly，供 double-submit）；`trustedOrigin` `:133-142`（无 Origin 头视为同源信任，有则必须命中 `config.trustedOrigins`）；`validCsrf` `:144-154`（Origin + cookie/header 恒时比较 + `hashToken(header) === session.csrfHash`）；`createSession` `:156-179`；`readAuthSession` `:181`；中间件在 `:367-383` 给每个请求设 `requestId` 与 `authSession`。
- `recordAudit(db, actorUserId, event, targetId, metadata?)` `:254-271`。
- **审计事件命名约定（实跑清单）**：`audit_logs.event` 共 42 个、只有七个前缀 —— `activity.*`（7：created/updated/published/paused/resumed/ended/rule_version.created）、`auth.logout`（1）、`crm.*`（8）、`crmeb.*`（9）、`participation.created`（1）、`phone.*`（7）、`reward.*`（9）。新代码建议 `local_catalog.product.created`/`updated`/`shelf_changed` 与 `local_order.registered`/`created_on_behalf`/`status_changed`/`verified`/`rejected`；**不要复用 `crm.order.*`**（会被 `/customers` 的审计视图混读）。
- `bodySchemaError(value, schema)` `:345-351`：`safeParse` 失败返回 `null`，路由统一翻 `400 invalidRequest`。
- **`/auth/dev/login` `:513-550`**：仅当 `config.nodeEnv !== 'production' && config.authDevEnabled` 才存在（否则 `404`），仍要求 CSRF，body 只有 `displayName` + 可选 `communityId`，且**只建 `staff: null` 的居民会话**。这是既有测试造居民会话的唯一合法途径，**不得改造为后门，也不得放宽 `AUTH_DEV_ENABLED` 的生产禁令**（`config.ts:103-108` 在 production 下直接抛配置错误，`health.test.ts:42-45` 有断言）。
- 角色边界现状：`/admin/*` 与 `/admin/crm/*` 对 `grid_worker` 一律 403（`crm/routes.ts:83-90`、`activities/routes.ts:150-152`）。`/crm/*` 与 `/staff` 类路径对三角色开放，按 `staff_community_assignments` 裁剪。
- 居民社区归属：`resident_community_assignments`（`schema.ts:96-107`）是 `(user_id, community_id)` 复合主键（`user_id`/`community_id` 均 `onDelete: 'cascade'`，`resident_community_community_idx`），**一个居民可属多个社区**。
- **`GET /crm/residents?communityId=`（`app.ts:909-947`）可直接复用做"工作人员代录时选居民"**：它只要求 `session.staff`（`grid_worker` 也能用，不走 `requireAdminSide`），非 admin 必须先命中 `staff_community_assignments` 否则 `403`，admin 则校验社区存在（否则 `404`），返回 `{ items: [{id, displayName, createdAt}] }`（**上限 `limit(100)`，无分页**）。网格员代录居民正好落在它已有的权限语义里，**不需要新造一个"查居民"接口**。

### 1.7 管理台复用点（`apps/admin`）

- 入口：`src/App.tsx:18-87`（先 `fetchSession()`，无 session 渲染 `LoginPage`，有则 `AdminAuthProvider` + `useRoutes(routes)`）。
- 路由表：`src/app/routes.tsx:15` `PLANNED_PAGES = NAV_PAGES.filter(p => p.status === 'planned')`，`:39-48` 把这些统一渲染成 `PlaceholderPage`（真实路由写在 `:31-38`）。**新增真实页必须同时改 `navigation.ts` 的 `status`，否则真实路由与占位路由二选一（顺序在前者胜）。**
- 导航模型：`src/app/shell/navigation.ts` —— `commerce` 组 `:87-107`，`/products`（`:93`，`status:'planned'` `:96`，`planned:['商品同步与上下架','身份关联','订单来源回流']` `:97`）、`/orders`（`:100`，`status:'planned'` `:103`，`planned:['订单列表与筛选','来源与归属','售后状态']` `:104`）。`filterNavigation` `:207`、`isPageVisible` `:228-230`（`roles` 缺失 = 全角色可见）。
- 外壳：`src/app/shell/AppShell.tsx`（工作页签条 + <768px 抽屉导航 + `<Outlet/>`）；`src/layouts/AdminLayout.tsx` 只有一行 `<AppShell/>`；`src/components/PageHeader.tsx:24-40`（`title/description/status/extra/subnav`）。
- 数据面板：`src/shared/components/DataPanel.tsx` —— `PanelQuery<Filters,SortKey>` `:47-52`、`PanelData<Row>` `:55-60`、`PanelFilter` `:74-89`（`text|select|status|numberRange|dateRange`）、`PanelColumn` `:92-99`（`key/sortKey/hideable`）、`PanelAction` `:101-107`、`DataPanelProps` `:109-137`（`id/label/rowKey/query/onQueryChange/initialFilters/data/filters/inlineFilterLimit/columns/onRefresh/renderCard/rowActions/toolbarExtra/emptyText/errorTitle/pageSizeOptions/pagination`）、组件 `:178-201`。列偏好持久化在 `localStorage['ll:data-panel-prefs']`（`shared/lib/data-panel-prefs.ts`），**`id` 必须稳定且唯一**（现有：`component-preview`）。
- 传输层样板：`src/services/crm.ts` —— `CrmApiError(status,code,message)` `:35-45`、`parsePayload` `:60-69`（解析失败 → `CrmApiError(200,'invalid_response',…)`）、`requestJson` `:78-111`（`credentials:'include'`、`x-csrf-token`、**所有路径自己补 `/api` 前缀**）、`pathWithId` `:113-115`。
- 页面样板：`src/pages/CrmPage.tsx`（`grid_worker` → `Result` 403 且**零 API 调用** `:210-230`；`DataPanel` 两处 `:567`/`:1047`；`Drawer`+`Descriptions` 详情 `:606`/`:1090`；审核 409 → 刷新列表 + 重载详情 `:979-1030`）。
- 主题：`src/app/theme.ts`（primary `#116d63`、success `#138b79`、bg `#f5f7f7`、`borderRadius 6`、`Layout.headerHeight 52`）——**新页面只准用 token，不写死颜色**。

### 1.8 H5 复用点（`apps/web`）

- 路由：`src/App.tsx:34-77`；`<AppShell>` 包三层出口；`/life`(56)、`/life/product/:productId`(58)、`/me`(62)、`/workbench`(63-72)。
- 三入口导航：`src/components/shell/navigation.ts:20-24`（活动 `/`、惠生活 `/life`、我的 `/me`）；`BottomTabBar.tsx:9-44`（高亮完全由路由推导）。**本卡不得新增第四个 tab。**
- 惠生活：`src/pages/LifePage.tsx`（`:30-33` DemoNote 目前只声明"优惠购接 CRMEB、不代下单不代支付"；`:45-47` 挂 `ShopDealsSection`）；`src/components/life/ShopDealsSection.tsx:15-117`（五态：loading / not_configured / error / empty / ready，**任何分支都回落到"不展示假商品"**；`:13` 明确"不回落 `mocks/life.ts`"，`:83` empty 文案"不会用演示商品填充"）；`ShopProductCard.tsx:13-58`；`ShopProductDetail.tsx`（购买跳转唯一合法路径；失败文案 `describePurchaseFailure:64`）。
- 商品数据：`src/hooks/useShopProducts.ts` —— `API_PREFIX='/api'` `:17`、`PAGE_SIZE=100` `:18`、`readStatus` `:55-94`（先读 `/integrations/crmeb/status`，未配置就**不请求商品**）、`useShopProducts` `:111-191`（AbortController + `active` 双保险）、`useShopProduct` `:208+`。**这套"状态机 + AbortController + 不做 mock 回落"应被本地目录 hook 复制。**
- 我的：`src/pages/MePage.tsx`（350 行）—— 登录块、手机号绑定卡、统计三宫格（`:253-277`）、"我的奖励"入口 `:280-298`、网格员工作台/工作人员入口 `:300-341`、末尾 `DemoNote` `:343-346`（**原文明确写"订单…尚未接入真实服务"** → R2 必须改这段文案）。"我的订单"入口建议插在 `:298` 之后、`:300` 之前（与"我的奖励"同形）。
- 传输层样板：`src/services/rewards.ts` —— `RewardApiError(message,status,code,requestId)` `:46-58`、`rewardApiPath` `:75-82`（替换 `:activityId|:checkinId|:grantId`，缺参抛错）、`requestReward` `:91-127`（`credentials:'include'` + `cache:'no-store'` + 非 GET 强制 `x-csrf-token`，缺 token 直接抛 401，**不发请求**）。
- 通用读状态：`src/hooks/useAsyncResource.ts:18-63`（key 变化才 loading，手动 reload 保留旧数据）。
- 错误信封：`src/hooks/apiError.ts:8-38`（`CrmApiError` + `apiErrorFromResponse`）。
- 展示工具：`src/components/life/shop.ts`（`formatPriceCents` `:9-12`、`categoryLabel`、`primaryCategory`、`plainTextFromHtml` `:41-58`——**HTML 只取纯文本，禁止 `dangerouslySetInnerHTML`**）。
- 页面骨架：`src/components/PageHeader.tsx`（`backTo/backLabel/icon/title/subtitle`）、`PendingNotice`、`DemoNote`（`tone: info|warn`）。

### 1.9 工作台复用点（H5 `/workbench`）

- `src/pages/workbench/WorkbenchLayout.tsx:9-16`：`useStaffSessionController()` → `StaffSessionProvider` → `<Outlet/>`。- `src/hooks/useStaffSession.tsx`（177 行）：`StaffSessionContext:36`、`useStaffSessionController():58`（`login/logout/refresh`）、`useStaffSession():173`，**只接受 staff 会话**，必须在 provider 内使用。
- `src/hooks/useCrmApi.ts:67-198`（`request` `:70`）：统一加 `/api` 前缀、GET 不要求 csrf、非 GET 必须 `session.csrfToken`（否则抛 `CrmApiError` 401）、响应按共享 schema 解析。方法清单见文件内 `return {...}`。
- `src/components/crm/StaffGate.tsx`：`StaffGate`（loading/error/未登录跳 `/workbench`）、`StaffIdentityCard`。
- `src/components/crm/WorkbenchUi.tsx`：`CrmBadge`（`mint|amber|rose|slate|teal`）、`PageSection`、`LoadingBlock`、`ErrorBlock`、`EmptyBlock`、`Field`、`InfoRow`、`StatusNotice`、`TextLink`、`inputClassName` `:212`、`primaryButtonClassName` `:215`、`secondaryButtonClassName` `:218`。
- `src/components/crm/crmLabels.ts`：`leadSourceLabels:12`、`leadStatusLabels:26`、`businessTypeLabels:33`、`orderStatusLabels:38`、`orderStatusDescriptions:47`、`staffRoleLabels:63`、`*Options` `:69-84`。**本地订单标签应新建 `localOrderLabels`，不得往这里塞第二套语义。**
- `src/pages/workbench/WorkbenchOrdersPage.tsx`（309 行）：`useCrmApi` + `StaffGate` + `FilterChipRow` + `OrderCard` → `/workbench/orders/:id`（`PAGE_SIZE = 20` 在 `:31`）。**本地订单页应复制这个结构（列表 + 卡片 + 详情路由），但使用独立 hook 与独立标签表。**
- `src/components/crm/FilterChips.tsx`：`FilterChipRow`。
- 已知坑：`WorkbenchVerifyPage.tsx` 因为 `/admin/activities` 对网格员 403，只能读公开活动列表 —— **本地订单的工作台接口必须对 `grid_worker` 开放并按社区裁剪，否则会重复这个坑。**

---

## 2. #109 R1 / R2 验收点 → 「已有能力 / 需新增」

> 说明：Issue #109 原文在本机不可得（无 `gh`，见 §5.1）。下表按 captain 下发的 `t3`/`t4` 验收条目逐条展开，等同 Issue 验收面。

### 2.1 R1（`t3`）：契约 + 模型/迁移 + Hono API + 测试

| # | 验收点 | 已有能力（可复用） | 需新增 |
| --- | --- | --- | --- |
| R1-1 | contracts 提供全部 schema/路由/错误码/共享类型，客户端不各写 DTO | `index.ts` 的常量+`z.strictObject`+`superRefine` 范式；`API_ERROR_CODES` 扩展机制；`apiErrorSchema` | 新段落 `LOCAL_CATALOG_ROUTES` / `LOCAL_ORDER_ROUTES`、`localProduct*` / `localOrder*` 全套 schema、`LOCAL_ORDER_STATUS_TRANSITIONS`、事件枚举、2–3 个新错误码 |
| R1-2 | drizzle schema + `0009` 迁移；空库初始化与旧库升级均通过；含外键/唯一（幂等键）/索引 | `client.ts:28` 自动迁移；`0003` 迁移格式；`crm.test.ts:2014-2094` 的"旧库升级"测试范式 | `local_products` / `local_orders` / `local_order_events` 三表 + 索引 + `local_order_events` 触发器 + `0009_local_catalog_orders.sql` + `meta/0009_snapshot.json` + journal idx=9 |
| R1-3 | 路由覆盖：商品创建/编辑/上下架；居民登记；工作人员代录；居民本人查询；工作人员查询与状态处理；运营核验；事件/审计查询 | `registerCrmRoutes` 注册范式；`crm/routes.ts` 的 guard/csrf/param/body 四段式；`/crm/residents` 选居民 | `apps/api/src/catalog/{routes,service}.ts`（或 `local-orders/`），并在 `app.ts` 注册；商品 5 条 + 居民 2 条 + staff 5 条 + 核验/事件 |
| R1-4 | 会话、CSRF double-submit + trusted Origin、三角色边界、网格员授权社区、跨社区隔离 | `validCsrf` `app.ts:144`；`requireStaff` `crm/routes.ts:75`；`assignedCommunityIds` `crm/service.ts:271`；`assertCommunityAccess` `:280`；`staff_community_assignments` | 本地订单/商品的社区判定函数（商品社区 = 订单社区；网格员只能看授权社区）；`grid_worker` 对"核验"必须 403；staff 表面不得沿用 `requireAdminSide` 一刀切 |
| R1-5 | 价格与归属以服务端为准；忽略客户端价格；快照商品名/单价/数量/登记金额；事后调价不影响旧单 | 整数分约定；`crmServiceOrders` 的"创建时冻结归属"思路（`schema.ts:465-472` 注释：归属与来源在创建时冻结，后续转移线索不得移动该单） | `product_name` / `unit_price_cents` / `quantity` / `total_cents` 快照列；请求 schema **不含**任何价格字段；服务端从 `local_products` 读价并计算总额 |
| R1-6 | 下架商品拒绝新登记；非法数量/金额被拒；相同幂等键只出一单；并发下唯一约束生效 | `crmeb/products.ts:180` 的"下架即 404"先例；`mapConstraintError` `:259`；`rewards`/`participation` 的"重放返回既有行"先例（`participation/service.ts:493-495`） | `409 product_off_shelf`；`quantity` 上下限；唯一索引 `(community_id, resident_user_id, idempotency_key)`；重放返回既有订单且 `created:false`（或 200 同体） |
| R1-7 | 状态机 `registered/processing/pending_review/verified/cancelled/rejected` 有显式迁移表；`verified` 仅表示运营人工核验；重复核验幂等或明确拒绝 | `CRM_ORDER_STATUS_TRANSITIONS` `:746`；`updateOrderStatus` `:1352` 的条件 UPDATE；`reviewOrder` `:1410` | `LOCAL_ORDER_STATUS_TRANSITIONS`（契约）+ 服务端二次校验 + 触发 409 `order_already_verified`（明确拒绝，可测） |
| R1-8 | 事件追加式写入，带 actor/时间/原因，具备稳定 `source type + source id` 供 #64 消费 | `crm_order_events`（`schema.ts:524`，索引 `crm_order_events_order_created_idx:541`）结构；`insertOrderEvent` `crm/service.ts:642-666`；`0003_crm_core.sql` 的 `RAISE(ABORT, 'crm_order_events rows are immutable')` 触发器 | `local_order_events` 表（`event/from_status/to_status/note/actor_user_id/created_at` + `source_type`/`source_id`）+ 两条 append-only 触发器 |
| R1-9 | 测试覆盖：正向链路 + 重复提交/无会话/越权/跨社区/下架/价格篡改/取消/并发/文件库重启持久化 | `crm.test.ts:41-209` 工具函数；`:748-864` 重启；`rewards-concurrency.test.ts` 真多进程 | `apps/api/test/local-catalog-orders.test.ts`（+ 可选 `local-orders-concurrency.test.ts`） |
| R1-10 | lint / typecheck / api 测试实跑通过；8 个 rewards EPERM 失败需用干净基线对照 | 已知基线（`rewards-version-edit.test.ts`/`rewards-data.test.ts` 的 Windows `rmSync` EPERM） | 在提交说明/证据里写"改动前基线同样 8 例失败"的对照，不得声称自己修好了 |

### 2.2 R2（`t4`）：H5 + 管理台 + 工作台

| # | 验收点 | 已有能力（可复用） | 需新增 |
| --- | --- | --- | --- |
| R2-1 | H5「惠生活」读本地商品 API，展示真实上架目录与详情；未配置/空/加载/错误四态如实；不出现假商品 | `useShopProducts.ts` 的五态机与 AbortController；`ShopDealsSection.tsx` 的分支渲染；`ShopStateCard`、`formatPriceCents`、`ShopProductImage` | `useLocalCatalog` hook；`LocalCatalogSection`；`LocalProductCard`；本地商品详情页/组件（**独立路径**，见 §5.8） |
| R2-2 | 已登录居民可登记；未登录明确提示且不能提交；文案为「登记订单 / 提交办理意向」，不出现支付成功/已成交 | `useResidentAuth`（`session` + `login`）；`ShopProductDetail.tsx:69-75` 的 401 分支文案；`usePendingNotice` | 登记表单（数量 + 备注）+ 幂等键生成（`crypto.randomUUID()`）+ 成功态只显示"已登记/待处理"；文案审查清单（禁词：支付成功、已付款、已成交、已开通） |
| R2-3 | 「我的」提供本人订单列表、状态、详情与刷新，数据来自真实 API | `MePage` 的入口卡样式（`:280-298`）；`useAsyncResource`；`FilterChipRow`；`PageHeader` | `/me/orders` 列表页 + 详情页；`services/localOrders.ts`；`useMyLocalOrders`；`MePage` 新增入口 + 改 `DemoNote`（`:343-346`） |
| R2-4 | 管理台商品管理：创建/编辑/上架/下架，复用 AppShell/DataPanel/Drawer 与 Token | `DataPanel` 全套 props；`CrmPage.tsx` 的 DataPanel+Drawer 组合；`adminTheme`；`PageHeader` | `Apps/admin/src/pages/ProductsPage.tsx`；`services/localCatalog.ts`；`navigation.ts` 把 `/products` 翻 `ready`；`routes.tsx` 加真实路由 |
| R2-5 | 管理台订单查询：按权限与社区筛选、处理状态、运营人工核验；UI 不把已核验渲染成已付款/已开通 | `CrmPage.tsx` 的 filter-options 拉取 + 列表 + Drawer 详情 + 审核 409 处理（`:979-1030`）；`DataPanel` 的 `status`/`select`/`dateRange` 过滤器 | `Apps/admin/src/pages/OrdersPage.tsx`；`services/localOrders.ts`（admin 侧）；`localOrderLabels`（文案必须写"已核验（人工）"并显式注明"不代表已付款/已开通"） |
| R2-6 | 网格员在工作台只能看/处理授权社区订单；越权得到明确 403 | `StaffGate`、`useStaffSession`、`useCrmApi` 的 request 包装、`WorkbenchOrdersPage` 结构、`ErrorBlock` | `/workbench/local-orders` 列表 + 详情页；`useLocalOrdersApi`（或扩展 `useCrmApi`）；403 状态渲染；工作台首页加入口 |
| R2-7 | 三入口 AppShell、BrowserRouter / Pages HashRouter、活动深链、既有页面不回归 | `main.tsx:26-34` 的双 Router 分支；`navigation.ts` 的 `activePrimaryTab`；`RESIDENT_RETURN_TO_PREFIXES`（`index.ts:176-184`，含 `/life`、`/me`） | 无需改动路由基座；只需保证新路径落在 `/life/**`、`/me/**`、`/workbench/**` 前缀内 |
| R2-8 | 真实 Chrome 320 / 375 / 桌面截图；检查溢出、触控、加载与空态 | `docs/engineering/evidence/ll-ui-007/browser-verify.mjs`（Node 内建 CDP 驱动真实 Chrome，无 playwright） | 新证据脚本（建议复制该文件改名）+ 截图落 `docs/engineering/evidence/ll-mvp-010/` |
| R2-9 | lint / typecheck / admin vitest / build 实跑通过 | root `pnpm lint` / `typecheck` / `test` / `build`；`apps/admin` 有 vitest 与 14 个测试文件 | 新增 admin 页面的 vitest（`renderPage` + `stubApi` 前缀表）；H5 无测试框架，只能 typecheck + Chrome |

### 2.3 禁止事项（红线，逐条可判）

| 禁止 | 事实依据 | 后果 |
| --- | --- | --- |
| **不得复用 `crmServiceOrders` / `crm_order_events` 的广电语义** | `schema.ts:465-521` 注释与字段：`businessType` 只有 `gd_mobile`/`gd_tv`、`orderNo` 是承运商受理号、`confirmed = 运营人工核验的有效成交`、`CRM_ACTIVATION_SOURCE='manual_verification'`；前端标签 `crmLabels.ts:33,38` | 会把「居民买菜登记」污染成「广电开卡成交」，`/customers` 客户与业务单页面立刻串味 |
| **不得复用 `crmebOrders` / `crmebIdentities` / `crmeb_order_events` 存本地订单** | `schema.ts:698-738`：外部镜像，`channel='crmeb'`、`external_order_id` NOT NULL、`raw_status`/`raw_hash` 必填、`valid_transaction` 由 outapi 拉取计算；`crmeb-adapter.md §7` 明确"唯一可信路径是拉取" | 会伪造不存在的上游订单，破坏对账与 `valid_transaction` 语义 |
| **不得写死 fixture 商品** | `ShopDealsSection.tsx:78-113` 明确"不会用演示商品填充"；`PlaceholderPage.tsx:11-14` 明确"没有 sample table / fake count"；`mocks/life.ts` 只服务已声明为演示的积分页 | R2-1 直接失败；也会让"空态/未配置态"验收失去意义 |
| **不得引入测试登录后门** | `app.ts:513-519` `/auth/dev/login` 由 `nodeEnv !== 'production' && authDevEnabled` 双重门控；`config.ts:103-108` 在 production 下直接拒绝 `AUTH_DEV_ENABLED=true`；`health.test.ts:42-45` 有断言；`ci.yml:81` 校验 `developmentResidentLogin:false` | 安全边界验收失败，且 CI 的 `MVP_API_REAL_HTTP_AND_AUTH_NEGATIVES` 会红 |
| 附带红线：**不得用 `confirmed` 作为本地订单终态名** | 与广电"有效成交"同名不同义 | 代码评审与验证者会按 R1-7 判失败 |
| 附带红线：**不得让本地目录依赖 CRMEB 配置** | `crmeb/routes.ts:101` 未配置时 503 | 会把"本地商品"变成"必须配 CRMEB 才能用" |
| 附带红线：**不得把价格从客户端传入** | R1-5；`createCrmServiceOrderRequestSchema` 也没有价格字段可参照 | 价格篡改验收失败 |

---

## 3. 测试基建：可直接照抄的最小片段（含真实文件与行号）

### 3.1 API 测试骨架 —— 建库 + 迁移 + HTTP + CSRF + 登录

来源：`apps/api/test/crm.test.ts`（2095 行，最完整的样板）。

```ts
// apps/api/test/crm.test.ts:1-56 的导入、常量与类型（照抄，换文件名）
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import { /* 需要的契约类型 */ } from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import { auditLogs, communities, staffAccounts, users } from '../src/db/schema.js'
import { hashPassword } from '../src/auth/security.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url)) // :41
const ADMIN_PASSWORD = 'Admin-Password-123!'                                        // :42
type App = ReturnType<typeof createApp>                                             // :47

interface Session { cookies: string; csrfToken: string }                            // :49

interface ErrorEnvelope { error: { code: string; message: string } }               // :54
```

```ts
// cookie / CSRF / 登录：crm.test.ts:58-122（逐字照抄，只改 origin 端口即可）
function cookiePairs(response: Response): string[] {                     // :58
  const value = response.headers.get('set-cookie') ?? ''
  return value
    .split(/,(?=[^;,]+=)/)
    .map((part) => part.split(';', 1)[0]?.trim() ?? '')
    .filter(Boolean)
}

function cookiePair(response: Response, name: string): string {          // :66
  const pair = cookiePairs(response).find((value) => value.startsWith(`${name}=`))
  assert.ok(pair, `expected ${name} cookie`)
  return pair
}

async function csrf(app: App) {                                          // :72
  const response = await app.request('/auth/csrf')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { csrfToken: string }
  return { token: body.csrfToken, cookie: cookiePair(response, 'll_csrf') }
}

function cookieHeader(...pairs: string[]) {                              // :79
  return pairs.join('; ')
}

function writeHeaders(cookie: string, token: string) {                   // :83
  return {
    'content-type': 'application/json',
    cookie,
    'x-csrf-token': token,
    origin: 'http://localhost:5174',
  }
}

async function login(app: App, username: string, password: string) {      // :92
  const csrfState = await csrf(app)
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: writeHeaders(csrfState.cookie, csrfState.token),
    body: JSON.stringify({ username, password }),
  })
  return {
    response,
    csrfToken: response.ok
      ? ((await response.clone().json()) as { csrfToken: string }).csrfToken
      : null,
  }
}

async function staffSession(app: App, username: string, password: string): Promise<Session> { // :107
  const result = await login(app, username, password)
  assert.equal(result.response.status, 200, `${username} should be able to log in`)
  assert.ok(result.csrfToken)
  return {
    cookies: cookieHeader(
      cookiePair(result.response, 'll_session'),
      cookiePair(result.response, 'll_csrf'),
    ),
    csrfToken: result.csrfToken,
  }
}
```

```ts
// 通用 HTTP 调用：crm.test.ts:124-151（GET 默认不要求 CSRF，写请求默认要求）
interface ApiOptions { session?: Session; body?: unknown; csrf?: boolean; origin?: string } // :124

function api(app: App, method: string, path: string, options: ApiOptions = {}) { // :131
  const { session, body, csrf: withCsrf = method !== 'GET', origin } = options
  const headers: Record<string, string> = {}
  if (session) headers.cookie = session.cookies
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (session && withCsrf) {
    headers['x-csrf-token'] = session.csrfToken
    headers.origin = origin ?? 'http://localhost:5174'
  } else if (origin) {
    headers.origin = origin
  }
  return app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function errorEnvelope(response: Response): Promise<ErrorEnvelope> { // :149
  return (await response.json()) as ErrorEnvelope
}
```

```ts
// 内存库上下文 + 造管理员（绕开 HTTP，直接 drizzle 插入）：crm.test.ts:153-180
function testContext() {                                                  // :153
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const app = createApp({ db, config, logRequests: false })
  return { app, db, sqlite }
}

async function createAdmin(db: AppDatabase) {                             // :160
  const now = new Date()
  const userId = randomUUID()
  const staffId = randomUUID()
  db.insert(users)
    .values({ id: userId, displayName: '系统管理员', createdAt: now, updatedAt: now })
    .run()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId,
      username: 'admin',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { userId, staffId }
}
```

```ts
// 通过真实 HTTP 造社区 / 造网格员：crm.test.ts:182-210
async function createCommunity(app: App, admin: Session, name: string): Promise<string> { // :182
  const response = await api(app, 'POST', '/admin/communities', {
    session: admin,
    body: { name },
  })
  assert.equal(response.status, 201, 'community creation must succeed')
  return ((await response.json()) as { id: string }).id
}

interface StaffInput {                                                    // :191
  username: string
  displayName: string
  password: string
  role: 'operator' | 'grid_worker'
  communityIds: string[]
}

async function createStaffAccount(app: App, admin: Session, input: StaffInput): Promise<string> { // :199
  const response = await api(app, 'POST', '/admin/staff', { session: admin, body: input })
  assert.equal(response.status, 201, `creating staff ${input.username} must succeed`)
  return ((await response.json()) as { id: string }).id
}
```

**居民会话**（本地订单必需）：`apps/api/test/participation-http.test.ts:78-102` 的 `residentSession()` 用 `/auth/dev/login` 建真实居民会话（`AUTH_DEV_ENABLED: 'true'` + `NODE_ENV: 'test'`），返回 `{ cookies, csrfToken, userId }`；同文件 `:112-126` 是面向居民的 `api()`（`origin` 默认 `http://localhost:5173`，可传 `origin: null` 测 Origin 拒绝）。**这是既有合法做法，不需要也不允许新增登录后门。**

### 3.2 文件库重启持久化（R1-9 必测）

来源：`apps/api/test/crm.test.ts:393-399`（`withTempDir`）与 `:748-864`（重启断言）。

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function withTempDir(prefix: string) {                                   // :393-399
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// :749-757 建文件库 + 第一次 app
const temp = withTempDir('ll-local-orders-persist-')
const databasePath = join(temp.dir, 'local.sqlite')
const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
const first = createDatabase(databasePath, migrationsFolder)
const app = createApp({ db: first.db, config, logRequests: false })
// …用同一 session 写入订单、事件、审计

// :836-857 「像进程重启一样」先关连接，再用同一路径重开并重新断言
first.sqlite.close()
const second = createDatabase(databasePath, migrationsFolder)
try {
  const restarted = createApp({ db: second.db, config, logRequests: false })
  // …用同一个 session cookie 重新 GET，断言订单/快照/事件仍在
} finally {
  second.sqlite.close()
}
temp.cleanup()
```

> Windows 注意：`temp.cleanup()` 里的 `rmSync` 偶发 `EPERM`（SQLite WAL 句柄未释放），这就是既有 8 例失败的原因。**新测试务必在 `cleanup()` 前 `sqlite.close()`，并接受 `try/catch` 包裹的清理**。

### 3.3 并发（R1-6/R1-9「并发提交下唯一约束生效」）

两条可选路线：

1. **轻量（推荐先用）**：同一 `:memory:`/文件库上串行 `Promise` 不构成并发；正确做法是**两次独立事务争抢同一唯一键**——直接调服务函数两次并断言第二次走"重放返回既有单"分支，或用 `sqlite.prepare('BEGIN IMMEDIATE')` 持锁后触发第二次写入。
2. **重量（真并发，已有样板）**：`apps/api/test/rewards-concurrency.test.ts`
   - `createRaceWorld` `:228-270`：`mkdtempSync` + 文件库 + 造活动；
   - `claimChildSource` `:104-157`：把子进程脚本作为字符串写出，子进程自己 `createDatabase` 并等 stdin 的 `go`；
   - `spawnRaceChild` `:159-211`：`spawn(process.execPath, ['--import','tsx', script, ...args])`；
   - `:309-344`：`symlinkSync(apiRoot/node_modules → tempDir/node_modules)`、父进程 `BEGIN IMMEDIATE` 持写锁 → 两个子进程都 `attempting` → `COMMIT`；
   - `:355-366`：用"最慢一次调用 ≥300ms"证明真的阻塞过，再断言"恰好一个成功"。

   > 该模式在 Windows 上依赖 `symlinkSync`（需开发者模式/管理员）；若不可用，退化为路线 1 并在证据里说明。

### 3.4 迁移断言（新迁移必测）

模板：`apps/api/test/participation.test.ts:639-707`（表/索引/触发器/外键 `on_delete=RESTRICT` 四连断言）+ `crm.test.ts:2014-2094`（旧库升级）。

```ts
const tableNames = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all().map((row) => (row as { name: string }).name)                    // participation.test.ts:644
const indexNames = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
  .all().map((row) => (row as { name: string }).name)                    // :659
const triggerNames = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
  .all().map((row) => (row as { name: string }).name)                    // :673
const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{ on_delete: string }> // :697
```

旧库升级：`crm.test.ts:2017-2052` 的做法是**把已有迁移复制到临时目录并截断 `_journal.json` 的 `entries`**（`entries.slice(0, 2)`），先建"旧库"，再用完整 `migrationsFolder` 打开同一文件断言新表出现。**`0009` 必须做同样的"0000–0008 旧库 → 0009 升级"测试。**

### 3.5 管理台 vitest

- 配置：`apps/admin/vitest.config.ts`（`environment:'jsdom'`、`globals:true`、`setupFiles:['./src/test/setup.ts']`、`testTimeout/hookTimeout:120_000`、`maxWorkers:2`、`css:false`）。
- 全局桩：`src/test/setup.ts:9-51`（`matchMedia`/`ResizeObserver`/`scrollTo` + `afterEach` 的 `cleanup()` 与 storage 清理）。
- 渲染辅助：`src/test/render-admin.tsx`
  - `renderAdmin(initialPath='/')` `:12-30`：`createMemoryRouter(routes, {initialEntries:[initialPath]})` + `AdminAuthProvider` 假管理员（`role:'admin'`，`communities: []`，`csrfToken:'test-only-csrf'`）+ antd `ConfigProvider zhCN` + `adminTheme`；
  - `HEALTH_PAYLOAD` `:32-38`、`mockHealthFetch()` `:41-52`（**只桩 `/api/healthz`，其它 URL 直接抛错**）、`setViewportWidth(width)` `:55-61`。
- 页面级脚手架：`src/pages/CrmPage.test.tsx`
  - `json(body, status=200)` `:227`；
  - `stubApi(routes: ReadonlyArray<readonly [prefix, Handler]>)` `:242-253`：按前缀匹配、记录 `calls`、未知 URL 抛 `unexpected fetch`；
  - `renderPage(session, initialPath)` `:259-275`：自己 `createMemoryRouter([{path:'/customers', element:<CrmPage/>}])`；
  - `firstLabel(text)` `:278-282`（高级筛选弹窗让 label 重复，取第一个）；
  - `ADMIN_SESSION/OPERATOR_SESSION/GRID_SESSION` `:200-225`、`beforeEach` 设 `innerWidth=1024` `:292`、`afterEach` `vi.unstubAllGlobals()` `:300`。
- 现有 14 个测试文件清单（含 `AppShell.test.tsx`、`navigation.test.ts`、`DataPanel.test.tsx`、`App.auth.test.tsx` 等）；新增 `ProductsPage.test.tsx` / `OrdersPage.test.tsx` 应照 `CrmPage.test.tsx` 的 `renderPage` 模式（不要用 `renderAdmin`，因为需要自定义 session 角色）。
- `navigation.test.ts` 现有断言：`filterNavigation('订单管')` → `['订单管理']` `:19-23`；`filterNavigation('商品与订单')` → 两个标签 `:27-31`；`activeMenuKey('/orders') === '/orders'` `:130`。**把 `/products`、`/orders` 翻成 `ready` 不会破坏这些断言**，但建议补两条"`status==='ready'` 且 `planned` 为空"的断言。

### 3.6 H5 是否有测试？—— **没有**

- `apps/web/package.json` scripts 只有 `dev / build / build:mvp / build:prod-preview / typecheck / preview`，**无 `test`**；`devDependencies` 无 vitest / testing-library / jsdom。
- `apps/web/src` 下 `.test.*` / `.spec.*` 文件数 = **0**。
- 根 `pnpm test` 是 `pnpm -r --workspace-concurrency=1 --if-present test && node --test scripts/local-dev.test.mjs`，`--if-present` 意味着 web 被静默跳过。
- 结论：R2 的 H5 侧质量门只有 `pnpm --filter @sanchuang-dev/local-life-web typecheck` + `build` + **真实 Chrome CDP 证据**。给 web 引入 vitest 属于新增工具链，超出 `t4` 的 `inScope`（`apps/web/src`），**不要在本卡引入**。

### 3.7 真实 Chrome 证据脚本（无 playwright）

- 浏览器：`C:\Program Files\Google\Chrome\Application\chrome.exe`（`--headless=new` + CDP，Node 内建 `fetch`/`WebSocket`；`browser-verify.mjs:27` 的 `CHROME` 常量就是这条默认路径，可用 `CHROME_PATH` 覆盖）。
- 可直接复制的样板：`docs/engineering/evidence/ll-ui-007/browser-verify.mjs`
  - `Cdp` 类：`connect` `:161-168`、`send` `:175-181`、`eval` `:183-196`、`waitFor` `:198-224`、`screenshot` `:226-230`、`setViewport` `:232-242`；
  - 端口冲突规避：`DEBUG_PORT = 9400 + (pid % 400)` `:31`；
  - 每轮唯一命名（可重复跑同一持久库）：`RUN_TAG` `:36`；
  - API 造数与登录：`apiLogin` `:67`、`apiGet` `:90`、`apiWrite` `:97`；
  - 断言聚合：`check(name, ok, detail)` `:47-51` + `browser-results.json`。
- 320/375/桌面三档：`setViewport(320,568)` / `(375,812)` / `(1440,900)`，并断言 `document.scrollingElement.scrollWidth === window.innerWidth`（`ll-mvp-007/verification.md §5` 的既有做法）。

---

## 4. 必须新建的符号命名建议（统一使用）

> 目标：R1 与 R2 并行开发时不会撞名、不会与 CRM/CRMEB 混淆。

### 4.1 `packages/contracts/src/index.ts` 新增符号

**路由常量（两个常量对象，避免语义混装）**

```ts
export const LOCAL_CATALOG_ROUTES = {
  // 公开（居民 H5，无需登录即可读上架目录）
  products: '/catalog/products',
  productDetail: '/catalog/products/:productId',
  // 后台（admin / operator）
  adminProducts: '/admin/catalog/products',
  adminProductDetail: '/admin/catalog/products/:productId',
  adminProductShelf: '/admin/catalog/products/:productId/shelf',
} as const

export const LOCAL_ORDER_ROUTES = {
  // 居民（会话身份，strict body）
  myOrders: '/local-orders',
  myOrderDetail: '/local-orders/:localOrderId',
  // 工作人员 H5 工作台（三角色，按社区裁剪；代录也走这里）
  staffOrders: '/staff/local-orders',
  staffOrderDetail: '/staff/local-orders/:localOrderId',
  staffOrderStatus: '/staff/local-orders/:localOrderId/status',
  // 后台（admin / operator）
  adminOrders: '/admin/local-orders',
  adminOrderDetail: '/admin/local-orders/:localOrderId',
  adminOrderStatus: '/admin/local-orders/:localOrderId/status',
  adminOrderVerify: '/admin/local-orders/:localOrderId/verify',
  adminOrderEvents: '/admin/local-orders/:localOrderId/events',
} as const
```

> 为什么 `/staff/local-orders` 与 `/admin/local-orders` 并存：既有 `/admin/*` 对 `grid_worker` 一律 403（`crm/routes.ts:83-90`），而 R2-6 要求网格员在工作台**能处理**授权社区订单。两条前缀共用同一个 service 函数，只是**守卫不同**（`requireStaff` vs `requireAdminSide`），实现成本约 30 行，换来"不破坏既有 `/admin/*` 语义"。
> 若实现者坚持单一前缀，必须满足：`/admin/local-orders` 的 list/detail/status 对 `grid_worker` 开放并强制社区裁剪，`verify` 对 `grid_worker` 403；并且要在 `docs/engineering/ll-mvp-010-*.md` 里写明为何绕过 `requireAdminSide` 惯例。

**Schema（建议按此顺序追加在 `index.ts` 的 CRM 段之后）**

| 符号 | 形状要点 |
| --- | --- |
| `localProductStatusSchema` | `z.enum(['on_shelf','off_shelf'])` |
| `localProductSummarySchema` | `{ id, community: authCommunitySchema, name, summary: string\|null, priceCents: int≥0, imageUrl: string\|null, category: string\|null, status, createdAt, updatedAt }` |
| `localProductDetailSchema` | `summary.extend({ description: string\|null })` |
| `localProductListResponseSchema` | `{ items, total, page, pageSize }`（与 CRM 一致） |
| `createLocalProductRequestSchema` | `z.strictObject({ communityId, name, summary?, description?, priceCents, imageUrl?, category? })` |
| `updateLocalProductRequestSchema` | `z.strictObject({ expectedUpdatedAt, name?, summary?, description?, priceCents?, imageUrl?, category? })` |
| `localProductShelfRequestSchema` | `z.strictObject({ expectedUpdatedAt, status: localProductStatusSchema })`（上/下架同一接口，幂等） |
| `localOrderStatusSchema` | `z.enum(['registered','processing','pending_review','verified','cancelled','rejected'])` |
| `LOCAL_ORDER_STATUS_TRANSITIONS` | `registered→[processing,cancelled,rejected]`、`processing→[pending_review,cancelled,rejected]`、`pending_review→[verified,rejected]`、其余 `[]` |
| `localOrderTransitionStatusSchema` | `z.enum(['processing','pending_review','cancelled','rejected'])`（`verified` 只能由核验接口产生） |
| `localOrderEventTypeSchema` | `z.enum(['order.registered','order.created_on_behalf','order.status_changed','order.verified','order.cancelled'])` |
| `localOrderSnapshotSchema` | `{ productId, productName, unitPriceCents, quantity, totalCents }`（冻结快照） |
| `localOrderSummarySchema` | `{ id, community, resident: crmUserRefSchema, snapshot, status, registeredBy: 'resident'\|'staff', staff: crmStaffRefSchema\|null, createdAt, updatedAt }` |
| `localOrderEventSchema` | `{ id, event, fromStatus, toStatus, note: string\|null, actor: crmUserRefSchema\|null, sourceType: 'local_order', sourceId: string, createdAt }` |
| `localOrderDetailSchema` | `summary.extend({ note: string\|null, verifiedBy: crmUserRefSchema\|null, verifiedAt, verificationNote, events: z.array(localOrderEventSchema) })` |
| `createLocalOrderRequestSchema` | `z.strictObject({ productId: uuid, quantity: int 1..99, note?: ≤200, idempotencyKey: uuid })` — **不含任何价格/社区字段** |
| `createLocalOrderOnBehalfRequestSchema` | `z.strictObject({ residentUserId: uuid, productId: uuid, quantity, note?, idempotencyKey: uuid })` |
| `updateLocalOrderStatusRequestSchema` | `z.strictObject({ expectedUpdatedAt, status: localOrderTransitionStatusSchema, note?: ≤500 })` + `superRefine`：`rejected` 必须给 `note` |
| `localOrderReviewRequestSchema` | `z.strictObject({ expectedUpdatedAt, decision: z.enum(['verify','reject']), note: min2 max500 })` + `superRefine`：`verify` 时 `note` ≥2 |
| `localOrderListQuerySchema` / `localOrderListResponseSchema` | 与 `crmOrderListQuerySchema` 同形（page/pageSize/communityId/status/keyword [+ productId]） |
| `localOrderEventListResponseSchema` | `{ items }` |
| `localOrderRegisterResponseSchema` | `{ created: boolean, order: localOrderDetailSchema }`（幂等重放可判） |
| `localOrderShelfResponseSchema` | 直接复用 `localProductDetailSchema` |

**新增错误码（追加到 `API_ERROR_CODES`，不改既有键）**

```ts
  /** 本地商品已下架：拒绝新登记，但既有订单不受影响。 */
  productOffShelf: 'product_off_shelf',
  /** 运营重复核验：明确拒绝而不是静默成功，避免"两次成交"的错觉。 */
  orderAlreadyVerified: 'order_already_verified',
  /** 幂等键命中了不同商品/数量：同一键不能改内容，返回冲突而不是覆写。 */
  orderIdempotencyConflict: 'order_idempotency_conflict',
```

### 4.2 `apps/api/src/db/schema.ts` 表名 / 索引名建议

```ts
// 表
local_products
local_orders
local_order_events

// 索引
local_products_community_status_idx   (community_id, status)
local_products_community_updated_idx  (community_id, updated_at)
local_orders_idempotency_uq           UNIQUE (community_id, resident_user_id, idempotency_key)
local_orders_community_status_idx     (community_id, status)
local_orders_resident_created_idx     (resident_user_id, created_at)
local_orders_product_idx              (product_id)
local_orders_created_by_staff_idx     (created_by_staff_id)
local_order_events_order_created_idx  (order_id, created_at)

// 触发器（写在迁移里，不写在 drizzle schema）
local_order_events_no_update
local_order_events_no_delete
```

字段建议（`local_orders`）：`id, community_id, product_id, resident_user_id, idempotency_key, status, product_name, unit_price_cents, quantity, total_cents, note, created_by_staff_id(nullable,自登记为 null), attributed_staff_id(nullable), verified_by_user_id(nullable), verified_at(nullable), verification_note(nullable), created_at, updated_at`。
`local_order_events`：`id, order_id, actor_user_id(nullable), event, from_status, to_status, note, source_type('local_order', NOT NULL), source_id(= order_id, NOT NULL), created_at`。`source_type`/`source_id` 是 **#64 消费契约**，不要留给读者自己 join 猜。

**外键策略**：`community_id` → `restrict`；`product_id` → `restrict`（**不要 `cascade`**，删商品不能删历史订单）；`resident_user_id` → `restrict`；`created_by_staff_id` / `attributed_staff_id` / `verified_by_user_id` / `actor_user_id` → `set null`（与 `crm_service_orders.confirmed_by_user_id:502`、`crm_order_events.actor_user_id:531` 一致）。

### 4.3 migration：`0009`

| 建议 | 值 |
| --- | --- |
| SQL 文件 | `apps/api/db/migrations/0009_local_catalog_orders.sql` |
| 快照 | `apps/api/db/migrations/meta/0009_snapshot.json`（新的 `id` UUID，`prevId` = `0008_snapshot.json` 的 `id` `11ecf682-aff2-4181-8171-7b710c81ed71`） |
| journal | `meta/_journal.json` 追加 `{ "idx": 9, "version": "6", "when": <epoch ms>, "tag": "0009_local_catalog_orders", "breakpoints": true }` |
| 内容顺序 | `CREATE TABLE` ×3 → `statement-breakpoint` → `CREATE INDEX` → `statement-breakpoint` → `CREATE TRIGGER ... RAISE(ABORT)` ×2，全部用 `--> statement-breakpoint` 分隔 |
| 校验 | `pnpm --filter @sanchuang-dev/local-life-api db:generate` 应当报"无变更"（否则 schema 与 SQL 不一致）；或 `drizzle-kit check` |
| 升级测试 | 复刻 `crm.test.ts:2014-2094`：截断 journal 到 idx 0..8 建"旧库"→ 完整目录重开 → 断言 3 张新表存在、旧数据仍在、可正常下单 |

> 提醒：`meta/0009_snapshot.json` 不是可选装饰。`drizzle-orm/better-sqlite3/migrator` 只读 `_journal.json` 里的 `tag` 去执行 `.sql`，但**后续 `db:generate` 依赖快照链**；缺快照会让下一次迁移生成出重建表的破坏性 SQL。历史先例证明这是手工维护的（`0003`、`0007`）。

### 4.4 前端文件与标识建议

| 位置 | 文件 | 说明 |
| --- | --- | --- |
| `apps/api/src/local-orders/` | `routes.ts` / `service.ts` | 与 `crm/`、`participation/` 同构；`LocalOrderError(status, code, message)` |
| `apps/api/src/app.ts` | 追加 `registerLocalCatalogRoutes(app, deps)` / `registerLocalOrderRoutes(app, deps)`（放在 `registerCrmRoutes` 之后，`:957` 附近） | 复用 `fail`/`validCsrf`/`bodySchemaError` |
| `apps/admin/src/services/` | `localCatalog.ts`、`localOrders.ts` | 复制 `services/crm.ts` 的 `requestJson` + `parsePayload` + `CrmApiError` 形状（各自导出 `LocalCatalogApiError`/`LocalOrderApiError`，或抽公共 `services/request.ts` 后复用） |
| `apps/admin/src/pages/` | `ProductsPage.tsx`、`OrdersPage.tsx` | DataPanel `id`: `local-products` / `local-orders` |
| `apps/admin/src/app/shell/navigation.ts` | `/products` → `status:'ready'`、`planned:[]`、`roles:['admin','operator']`；`/orders` 同 | 描述文案要写"本地商品/居民订单"，不要写"商城订单/成交" |
| `apps/admin/src/app/routes.tsx` | 增加 `{ path:'products', element:<ProductsPage/> }`、`{ path:'orders', element:<OrdersPage/> }` | 加在 `:30` 附近、`...PLANNED_PAGES` **之前** |
| `apps/web/src/services/` | `localCatalog.ts`、`localOrders.ts` | 复制 `services/rewards.ts` 的 `requestX` 形状（`/api` 前缀 + csrf + schema 解析） |
| `apps/web/src/hooks/` | `useLocalCatalog.ts`、`useMyLocalOrders.ts`、`useStaffLocalOrders.ts` | 复制 `useShopProducts.ts` 的状态机 + AbortController；工作台侧基于 `useStaffSession` |
| `apps/web/src/components/life/` | `LocalCatalogSection.tsx`、`LocalProductCard.tsx`、`LocalProductDetail.tsx` | 与 `ShopDealsSection` 并列（**不是替换**，CRMEB 只读路径保留） |
| `apps/web/src/components/local/` | `localLabels.ts` | `localOrderStatusLabels` / `localOrderStatusDescriptions`（不得塞进 `crmLabels.ts`） |
| `apps/web/src/pages/` | `MyOrdersPage.tsx`、`MyOrderDetailPage.tsx` | 路由 `/me/orders`、`/me/orders/:localOrderId` |
| `apps/web/src/pages/workbench/` | `WorkbenchLocalOrdersPage.tsx`、`WorkbenchLocalOrderDetailPage.tsx` | 路由 `/workbench/local-orders`、`/workbench/local-orders/:localOrderId` |
| `apps/web/src/App.tsx` | 追加上述 4 条路由 | 全部落在 `/me/**`、`/life/**`、`/workbench/**` 内，保证 AppShell 高亮正确（`components/shell/navigation.ts:42-47`） |

**H5 本地商品详情路径（重要）**：现有 `/life/product/:productId` 用 `/^\d+$/` 分流（`pages/ProductPage.tsx:158-166`）。本地商品 id 是 UUID，会掉进"积分演示商品"分支。建议新开 **`/life/local-products/:productId`**（或 `/life/local/:localProductId`），并在 `ShopProductCard`/详情里区分来源；**不要**改数字正则分支，以免破坏既有 CRMEB 深链。

---

## 5. 与 Issue 契约的冲突 / 以实际代码为准的偏差

### 5.1 Issue #109 原文无法取得

- 本机**没有 `gh` CLI**（`gh : 无法将"gh"项识别为…`），也无法从 worktree 读到 Issue 正文。
- 因此本文 §2 的"验收点"以 captain 下发的 `t3`/`t4`/`t5` 任务契约（`t3` 10 条、`t4` 9 条、`t5` 6 条）为准。若 Issue 原文另有条目（例如具体字段名、具体状态名），**以实现者的最终契约文档 + 本文 §4 的命名建议为准，并在 PR 描述里列差**。

### 5.2 路由命名冲突（以实际代码为准）

- `CRM_ROUTES.orderList = '/crm/orders'`（`index.ts:657`）与 `adminOrderList = '/admin/crm/orders'`（`:665`）**已被广电受理单占用**。本地订单必须走 `/local-orders`、`/staff/local-orders`、`/admin/local-orders`，不得复用 `/crm/orders`，也不得把 `/crm/orders` 改成多态（会让 `crm.test.ts` 的 20+ 断言与 `useCrmApi` 全面失效）。
- 管理台**页面路由** `/orders`（`navigation.ts:100`）与 API 路径 `/crm/orders` 是两件不同的事：页面 key `/orders` 可以继续用，但页面内必须调用 `/api/admin/local-orders` 或 `/api/staff/local-orders`。
- 结论：**契约里出现 `/orders` 裸路径的话，一律改名为 `/local-orders`。**

### 5.3 迁移编号与元数据（以实际代码为准）

- 下一个编号确实是 **`0009`**（journal 现有 idx 0–8）。
- 但"只加 `.sql`"在本仓库**不生效也不安全**：必须同时生成 `meta/0009_snapshot.json` 并追加 journal 条目（见 §4.3）。仓库没有"自动生成 0009"的先例，`0003`/`0007` 都是手工命名的。
- `0005`/`0007` 证明"无新表的迁移"也合法，但 `0009` 是**有新表**的迁移，不能靠复制 `0008` 快照蒙过 `drizzle-kit check`。

### 5.4 网格员权限语义偏差

- 现状：`/admin/*` 与 `/admin/crm/*` 对 `grid_worker` **一律 403**（`crm/routes.ts:83-90`、`activities/routes.ts:150-152`）。
- 若 Issue 写"网格员在管理台处理订单"，与现状直接冲突。本文建议的解法是新增 `/staff/local-orders*`（三角色、社区裁剪），后台仍用 `/admin/local-orders*`。**这正是 R2-6 唯一自洽的落地方式。**
- 另注意：网格员在 `/crm/*` 的既有语义是"只能看本人名下"（`crm/service.ts:1204-1223`：`createdByStaffId OR attributedStaffId`）。R2-6 要求的是"授权社区"，**范围更宽**，不要照抄 `listOrders` 的 `or(...)` 条件。

### 5.5 状态命名刻意与 CRM 不同（避免语义泄漏）

| 本地订单 | 广电受理单（禁止复用） | 理由 |
| --- | --- | --- |
| `registered` | `submitted` | 居民"登记"，不是向运营商"提交受理" |
| `pending_review` | `pending_verification` | 人工核验，不是运营商开通前核验 |
| `verified` | `confirmed` | **`verified` 只表示运营人工核验过，不代表已付款/已开通** |
| `rejected` | `failed` | 拒绝办理意向，不是业务失败 |

如果 Issue 原文用了 `confirmed`，**必须改名**，否则违反 R1-7/R2-5 的"UI 不把已核验渲染为已付款/已开通"，也会让 `crmServiceOrders` 的 `superRefine`（`index.ts:1003-1043`）语义串台。

### 5.6 居民与社区的归属规则需要显式决策

- `resident_community_assignments`（`schema.ts:96-107`）是 `(user_id, community_id)` 复合主键，**一个居民可属多个社区**，也**可以一个都不属**（例如 `/auth/dev/login` 不传 `communityId`，`app.ts:535-539`）。
- 建议规则（写进实现文档与测试）：
  1. 商品属于某社区；居民登记时，**订单社区 = 商品社区**（客户端不传社区）。
  2. 若居民不属于该社区 → `403 forbidden`（用 `resident_community_assignments` 判定）；这同时满足"跨社区隔离"。
  3. 工作人员代录时，目标居民必须属于"操作者的授权社区 ∩ 商品的社区"，否则 `403`；选居民可复用 `/crm/residents?communityId=`（`app.ts:909-947`，注意它 `limit(100)` 且无分页、无关键词过滤——社区人数超过 100 时 UI 需要提示或让实现者另加 `keyword`）。
  4. `admin` 跨社区可见，但仍不得把 A 社区居民的代录写进 B 社区商品单。
- 若 Issue 期望"任何登录居民都能登记任何社区商品"，则与 R1-4"跨社区隔离"冲突——**以 R1-4 为准**。

### 5.7 管理台导航仍把商品/订单标成"待建设"

- `navigation.ts:93-105` 两个页面都是 `status:'planned'`；`routes.tsx:15,39-48` 会把所有 planned 页面渲染成 `PlaceholderPage`。
- 因此 R2 若只加 `routes.tsx` 的真实路由而忘了改 `status`，会出现：真实页面被 `PLANNED_PAGES` 覆盖（或反之），Chrome 证据里看到的仍是"该模块尚未实现"。
- **必须成对修改**：`navigation.ts` 的 `status/planned/roles` + `routes.tsx` 的真实 `element`。

### 5.8 H5 已有 CRMEB 只读路径，不能删也不能被冒充

- `LifePage` 的"优惠购"段（`ShopDealsSection`）读 CRMEB；`/life/product/:数字id` 是 CRMEB 详情；`/life/product/:非数字` 是积分演示。
- 本地目录是**并列新增**，不是替换。R2-1 的"不出现假商品"同时约束两侧：CRMEB 未配置时不能拿本地商品顶替，本地为空时也不能拿 CRMEB 商品顶替。
- 本地商品详情必须新开路径（§4.4），否则 UUID 会被 `ProductPage.tsx:161` 的 `/^\d+$/` 判成演示商品。

### 5.9 已知环境偏差（不得当成自己修好的）

- `pnpm check` 的 lint/typecheck 在基线上**是绿的**。
- 但 `apps/api` 的 `node --test` 在 Windows 上有 **8 例失败**，全部在 `rewards-version-edit.test.ts` / `rewards-data.test.ts`，根因是测试收尾 `rmSync` 临时目录 `EPERM`（SQLite 文件句柄未释放），与业务无关。`crm.test.ts:393-399` 的 `withTempDir().cleanup()` 是同一模式，**新测试要主动避坑**（cleanup 前 `sqlite.close()`）。
- 交付时必须给出"改动前/改动后同样 8 例"的对照证据，禁止声称已修复。

### 5.10 验证工具边界

- 真实 Chrome 在 `C:\Program Files\Google\Chrome\Application\chrome.exe`；**没有 playwright/puppeteer**。浏览器证据必须用 Node 内建 CDP（照抄 `ll-ui-007/browser-verify.mjs`）。
- H5 无测试框架（§3.6），R2 的 H5 侧不能声称"有单测覆盖"。
- `docs/engineering/evidence/ll-mvp-010/` 目录由本卡创建；本文件是其中的 `recon.md`，`verification.md` 由 `t5` 产出。**证据目录是 git 跟踪的**（`git ls-files docs/engineering/evidence` 有 352 个文件），截图可以正常提交。

---

## 附录 A：本次勘察的核对命令（可复现）

```powershell
# A1 表清单（应为 35 张；本条已实跑）
node -e "const fs=require('fs');const s=fs.readFileSync('apps/api/src/db/schema.ts','utf8');const re=/sqliteTable\(\s*'([a-z_]+)'/g;let m,o=[];while((m=re.exec(s)))o.push(m[1]);console.log(o.length,o.join(','))"

# A2 每个迁移建了什么表/索引/触发器（不解析 SQL 也能数，用于核对 0009）
Select-String -Path apps/api/db/migrations/*.sql -Pattern 'CREATE TABLE `(\w+)`|CREATE (UNIQUE )?INDEX `(\w+)`|CREATE TRIGGER `(\w+)`' -AllMatches

# A3 journal 现状（应为 version 7 / dialect sqlite / idx 0..8 共 9 条；本条已实跑）
node -e "const j=require('./apps/api/db/migrations/meta/_journal.json');console.log(j.version,j.dialect,j.entries.length,j.entries.map(e=>e.idx+':'+e.tag).join(' '))"

# A4 本地领域是否已有实现（用 node 递归，避免 PowerShell 通配符漏掉嵌套目录；本条已实跑，结果应为 0）
node -e "const fs=require('fs'),p=require('path');const hit=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory()){if(!/node_modules|dist/.test(f))walk(f)}else if(/\.(ts|tsx)$/.test(f)){const s=fs.readFileSync(f,'utf8');if(/localOrder|local_order|\/catalog|本地商品/.test(s))hit.push(f)}}};['packages/contracts/src','apps/api/src','apps/admin/src','apps/web/src'].forEach(walk);console.log(hit.length,hit.join(','))"

# A5 审计/日志事件名前缀全清单（本条已实跑；除审计事件外也会捞到 logEvent 前缀，
#    审计事件前缀只有 activity/auth/crm/crmeb/participation/phone/reward 七种）
node -e "const fs=require('fs'),p=require('path');const set=new Set();const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())walk(f);else if(f.endsWith('.ts')){for(const m of fs.readFileSync(f,'utf8').matchAll(/'([a-z]+)\.[a-z_.]+'/g))set.add(m[1])}}};walk('apps/api/src');console.log([...set].sort().join(','))"
```

> Windows 控制台把中文打成乱码时**不要相信 PowerShell 输出的中文**，用 `read` 工具或 `node -e` 读文件。

## 附录 B：给实现者的最短启动清单

**R1（`t3`）**
1. `packages/contracts/src/index.ts` 追加 §4.1 全部符号 → `pnpm --filter @sanchuang-dev/local-life-contracts build`。
2. `apps/api/src/db/schema.ts` 追加 §4.2 三张表 → `pnpm --filter @sanchuang-dev/local-life-api db:generate` 生成 SQL/快照 → 手工改名为 `0009_local_catalog_orders` → 补触发器 → 修 `meta/_journal.json`。
3. `apps/api/src/local-orders/{service,routes}.ts` + `app.ts` 注册。
4. `apps/api/test/local-catalog-orders.test.ts`（照 §3.1/§3.2/§3.4）。

**R2（`t4`）**
1. `apps/admin/src/services/{localCatalog,localOrders}.ts`（照 `services/crm.ts`）。
2. `ProductsPage.tsx` / `OrdersPage.tsx`（DataPanel `local-products` / `local-orders`）+ `navigation.ts` 翻 `ready` + `routes.tsx` 真实路由。
3. `apps/web/src/services/*` + hooks + `LocalCatalogSection`/`LocalProductDetail` + `/me/orders` + `/workbench/local-orders`。
4. 文案审查：禁词 `支付成功 / 已付款 / 已成交 / 已开通`；必现词 `登记订单 / 提交办理意向 / 人工核验`。
5. Chrome 320/375/1440 证据（照 `ll-ui-007/browser-verify.mjs`）。
