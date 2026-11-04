# LL-MVP-005 · 网格员轻量 CRM 契约、数据模型与迁移

> 对应 [Issue #61](https://github.com/sanchuang-dev/local-life/issues/61)。本文冻结共享契约、Drizzle 数据模型、状态机与权限边界，是 API（T2）、网格员 H5（T3）与运营后台（T4）的唯一真相源。本文描述的是本卡实现的工程边界，不代表广电开通接口、佣金或生产环境已验收。

## 1. 范围与不变量

- 客户线索、跟进与下次联系、广电手机卡/电视业务受理单、状态机、运营人工核验有效成交、完整审计，全部归属**一个社区**。
- 共享契约只存在一处：`packages/contracts/src/index.ts` 的 CRM 段；API 与客户端不得复制 DTO。
- 数据表只追加：不改既有 `activities` / 活动规则 / 参与 / 三人团（#60）相关表；CRM 表由迁移 `0003`（承接三人团 0002） 新增。
- **没有广电开通/激活接口**。`confirmed` 的唯一含义是“运营人工核验后的有效成交”，不是“已开通”“已激活”。契约与数据库都没有 `activated` / `activationStatus` / `activatedAt` 一类字段。
- 不实现自动佣金、分账、对账、居民名单导入、线索自动去重或复杂 CRM 自动化。
- 所有写接口（创建之外）使用 `expectedUpdatedAt` 乐观并发，冲突返回 `409 conflict`。
- 审计不记录手机号、密码、Cookie、OAuth code/token、openid 或完整证件信息。

## 2. 冻结契约（`packages/contracts/src/index.ts`）

### 2.1 路由与 HTTP 方法

`CRM_ROUTES` 为绝对路径常量；GET/POST 共用列表路径，创建走 POST。

| 常量 | 路径 | 方法 | 说明 |
| --- | --- | --- | --- |
| `leadList` | `/crm/leads` | GET / POST | 网格员线索列表 / 创建线索 |
| `leadDetail` | `/crm/leads/:leadId` | GET | 线索详情（含完整联系电话） |
| `leadStatus` | `/crm/leads/:leadId/status` | PATCH | 人工状态流转（contacting / invalid） |
| `leadTransfer` | `/crm/leads/:leadId/transfer` | POST | 转交归属（保留原归属历史） |
| `leadFollowUps` | `/crm/leads/:leadId/follow-ups` | GET / POST | 跟进列表 / 新增跟进 |
| `leadAudit` | `/crm/leads/:leadId/audit` | GET | 线索事件时间线 |
| `orderList` | `/crm/orders` | GET / POST | 业务单列表 / 创建受理单 |
| `orderDetail` | `/crm/orders/:orderId` | GET | 业务单详情（含事件时间线） |
| `orderStatus` | `/crm/orders/:orderId/status` | PATCH | 处理中 / 待核验 / 失败 / 取消 |
| `orderAudit` | `/crm/orders/:orderId/audit` | GET | 业务单事件时间线 |
| `adminLeadList` | `/admin/crm/leads` | GET | 后台线索列表（服务端分页/过滤） |
| `adminLeadDetail` | `/admin/crm/leads/:leadId` | GET | 后台线索详情 |
| `adminLeadAudit` | `/admin/crm/leads/:leadId/audit` | GET | 后台线索时间线 |
| `adminOrderList` | `/admin/crm/orders` | GET | 后台业务单列表（服务端分页/过滤） |
| `adminOrderDetail` | `/admin/crm/orders/:orderId` | GET | 后台业务单详情 |
| `adminOrderAudit` | `/admin/crm/orders/:orderId/audit` | GET | 后台业务单时间线 |
| `adminOrderReview` | `/admin/crm/orders/:orderId/review` | POST | 运营人工核验：`confirm` / `reject` |
| `adminFilterOptions` | `/admin/crm/filter-options` | GET | 社区、员工与枚举筛选项（服务端按权限裁剪） |

响应约定：

- `POST /crm/leads` → `201 crmLeadDetailSchema`；`PATCH status` / `POST transfer` → `crmLeadDetailSchema`。
- `POST /crm/orders` → `201 crmOrderDetailSchema`；`PATCH order status` / `POST adminOrderReview` → `crmOrderDetailSchema`。
- `POST follow-ups` → `201 createCrmFollowUpResponseSchema = { followUp, lead }`，返回刷新后的 `lead.updatedAt`，避免客户端二次拉取。
- 列表响应统一 `{ items, total, page, pageSize }`；事件时间线统一 `{ items }`，按 `createdAt` 升序。
- 错误统一既有 `{ error: { code, message, requestId? } }`；越权 `403`、不存在 `404`、并发/唯一冲突 `409`、参数错误 `400`。

### 2.2 枚举与状态机常量

- `crmLeadSourceTypeSchema`：`activity` / `grid_promotion` / `walk_in` / `resident_referral`。
- `crmLeadStatusSchema`：`new` / `contacting` / `converted` / `invalid`；`crmLeadManualStatusSchema` 仅 `contacting` / `invalid`。
- `crmBusinessTypeSchema`：`gd_mobile`（广电手机卡）/ `gd_tv`（电视业务）。
- `crmServiceOrderStatusSchema`：`submitted`（已提交受理）/ `processing`（处理中）/ `pending_verification`（待核验）/ `confirmed`（有效成交）/ `failed`（失败）/ `cancelled`（取消）。
- `crmOrderTransitionStatusSchema`：网格员/运营可发起的 `processing` / `pending_verification` / `failed` / `cancelled`；`confirmed` 只能由 `crmOrderReviewRequestSchema` 的 `confirm` 产生。
- `crmActivationSourceSchema = z.literal('manual_verification')`；常量 `CRM_ACTIVATION_SOURCE = 'manual_verification'`。
- `CRM_LEAD_STATUS_TRANSITIONS`、`CRM_ORDER_STATUS_TRANSITIONS` 冻结允许的流转；服务端仍是唯一权威，客户端只用于 UI 可用性。
- 事件枚举：`crmLeadEventTypeSchema`（`lead.created` / `lead.status_changed` / `lead.transferred` / `lead.follow_up_added`）、`crmOrderEventTypeSchema`（`order.created` / `order.status_changed` / `order.reviewed`）。

### 2.3 关键 DTO

- 线索：`crmLeadSummarySchema`（列表，手机号脱敏为 `contactPhoneMasked`）、`crmLeadDetailSchema`（含完整 `contactPhone`、`residentUserId`、`createdByStaff`）、`createCrmLeadRequestSchema`、`updateCrmLeadStatusRequestSchema`、`transferCrmLeadRequestSchema`、`crmFollowUpSchema`、`createCrmFollowUpRequestSchema`、`crmLeadEventSchema`。
- 业务单：`crmOrderSummarySchema`（含 `confirmedBy` / `confirmedAt` / 归属与来源快照引用）、`crmOrderDetailSchema`（含 `confirmation`、`failureReason`、`activationSource`、`events`）、`createCrmServiceOrderRequestSchema`、`updateCrmOrderStatusRequestSchema`、`crmOrderReviewRequestSchema`、`crmOrderEventSchema`。
- 列表查询：`crmLeadListQuerySchema`（`page` / `pageSize` / `communityId` / `staffId` / `status` / `sourceType` / `keyword`）、`crmOrderListQuerySchema`（`page` / `pageSize` / `communityId` / `staffId` / `businessType` / `status` / `keyword`）。
- 筛选：`adminCrmFilterOptionsResponseSchema`。
- **没有 `sort` 参数**。v1 固定排序：线索 `nextContactAt ASC NULLS LAST, updatedAt DESC`；业务单 `updatedAt DESC`；事件/跟进 `createdAt ASC`。可配置排序留待后续卡片。
- 创建线索/业务单不带 `expectedUpdatedAt`（尚无既有版本）；它们分别由业务校验与 `(communityId, orderNo)` 唯一约束防重。所有更新、状态流转、转交、跟进新增、审核均必须携带 `expectedUpdatedAt`。

语义约束已写进 zod：`activity` 来源必须带 `sourceActivityId`；只有 `grid_promotion` 可带 `promotionStaffId`（服务端缺省为当前归属）；`confirmed` 订单必须 `activationSource = manual_verification` 且有 `confirmation`，非 `confirmed` 订单的 `activationSource` 必须为 `null`。

## 3. 数据模型（`apps/api/src/db/schema.ts`，迁移 `0003`（承接三人团 0002））

### 3.1 `crm_leads`

| 字段 | 理由 |
| --- | --- |
| `id` | UUID 主键，平台统一 ID。 |
| `community_id` → `communities` restrict | 线索归属社区；跨社区不可见。 |
| `owner_staff_id` → `staff_accounts` restrict | 当前归属网格员；转交只改这一列。 |
| `resident_user_id` → `users` set null | 可选关联平台居民 UUID；不以手机号/openid 代替主键。 |
| `contact_name` / `contact_phone` | 最小必要联系信息；手机号走服务端权限与脱敏。 |
| `source_type` | 冻结来源类型；创建后不可改。 |
| `source_activity_id` → `activities` restrict | 活动来源快照；仅 `activity` 来源使用；被引用的活动不可删除，避免来源归属丢失。 |
| `promotion_staff_id` → `staff_accounts` set null | 推广网格员快照；仅 `grid_promotion` 来源使用。 |
| `created_by_staff_id` → `staff_accounts` restrict | 创建者；与当前归属分开，转交不改。 |
| `status` | `new` / `contacting` / `converted` / `invalid`。 |
| `next_contact_at` / `last_contacted_at` | 下次联系提醒与最近跟进时间。 |
| `created_at` / `updated_at` | 乐观并发令牌；每次写操作单调递增。 |

索引：`(community_id, owner_staff_id, status)`、`next_contact_at`、`source_activity_id`、`promotion_staff_id`。

### 3.2 `crm_lead_events`（追加式）

字段：`id`、`lead_id`、`actor_user_id`、`event`、`from_status` / `to_status`、`from_owner_staff_id` / `to_owner_staff_id`、`note`、`created_at`。索引 `(lead_id, created_at)`。迁移中增加 `BEFORE UPDATE` / `BEFORE DELETE` 触发器 `RAISE(ABORT)`，参照 `activity_rule_versions`，应用即使有 bug 也不能改写/删除历史。`actor_user_id` 允许为空以承载系统事件（如订单确认导致的线索转成交）。

### 3.3 `crm_follow_ups`（追加式）

字段：`id`、`lead_id`、`staff_id`、`content`、`next_contact_at`、`created_at`。索引 `(lead_id, created_at)`、`(staff_id, created_at)`；同样有 `UPDATE` / `DELETE` ABORT 触发器。新增跟进时同步更新线索的 `last_contacted_at`、`next_contact_at` 与 `updated_at`。

### 3.4 `crm_service_orders`

| 字段 | 理由 |
| --- | --- |
| `id` / `community_id` / `lead_id` | 一个社区内的一条线索对应一张受理单。 |
| `order_no` + 唯一索引 `(community_id, order_no)` | 广电受理单号同社区唯一，防止重复录入。 |
| `business_type` | `gd_mobile` / `gd_tv`。 |
| `status` | 受理单状态机；不含“已开通”。 |
| `customer_name` / `contact_phone` | 创建时快照，避免后续线索资料变化影响历史单据。 |
| `evidence_ref` | 脱敏凭据引用文本（如“工单截图 2026-11-04 #3”），不存证件照/密码。 |
| `notes` | 备注。 |
| `created_by_staff_id` | 创建人。 |
| `attributed_staff_id` | **创建时冻结的有效成交归属**；线索后续转交不得改动。 |
| `source_activity_id` / `promotion_staff_id` | 创建时从线索冻结的来源快照；`source_activity_id` 使用 `ON DELETE restrict`，来源活动不可被删除。 |
| `confirmed_by_user_id` / `confirmed_at` / `confirmation_note` | 运营人工核验信息，仅 `confirmed` 时有值。 |
| `failure_reason` | 失败/驳回原因。 |
| `created_at` / `updated_at` | 乐观并发令牌。 |

索引：唯一 `(community_id, order_no)`、`(community_id, status)`、`lead_id`、`attributed_staff_id`、`business_type`。

### 3.5 `crm_order_events`（追加式）

字段：`id`、`order_id`、`actor_user_id`、`event`、`from_status` / `to_status`、`note`、`created_at`；索引 `(order_id, created_at)`；`UPDATE` / `DELETE` ABORT 触发器。业务单详情和 `/audit` 都返回同一份事件。

订单状态流转、审核与事件写入必须在同一 SQLite 事务中完成；确认审核还要在同一事务内把线索置为 `converted`。

## 4. 状态机

### 4.1 线索

| 当前 | 允许动作 | 目标 | 说明 |
| --- | --- | --- | --- |
| `new` | 网格员/运营/管理员 | `contacting` / `invalid` | 人工流转。 |
| `contacting` | 网格员/运营/管理员 | `invalid` | 人工流转。 |
| `contacting` | 服务端（订单确认） | `converted` | **只能**由业务单 `confirm` 事务触发。 |
| `new` | 服务端（订单确认） | `contacting` → `converted` | 同一事务内先写 `new→contacting`（note“系统随订单人工核验进入跟进”），再写 `contacting→converted`；两次条件更新与事件，禁止单跳。 |
| `invalid` | 服务端（订单确认） | — | 返回 409；必须由负责人先恢复为 `contacting`，系统不会自动复活无效线索。 |
| `invalid` | 网格员/运营/管理员 | `contacting` | 重新激活跟进。 |
| `converted` | — | — | 终态。 |

禁止：`converted` 人工设置；`new` 直接 `converted`；任何状态回退到 `new`。

### 4.2 业务受理单

| 当前 | 允许动作/角色 | 目标 | 说明 |
| --- | --- | --- | --- |
| `submitted` | 网格员（owner）/运营/管理员 | `processing` / `cancelled` | 已提交受理，等待处理。 |
| `processing` | 同上 | `pending_verification` / `failed` / `cancelled` | 处理中，准备送运营核验。 |
| `pending_verification` | 同上 | `failed` / `cancelled` | 也可由运营审核 `reject` 直接置 `failed`。 |
| `pending_verification` | **仅运营/管理员审核 `confirm`** | `confirmed` | 人工核验有效成交，写 `confirmedByUserId` / `confirmedAt` / `confirmationNote` / `activationSource=manual_verification`，并触发线索 `converted`。 |
| `confirmed` / `failed` / `cancelled` | — | — | 终态，不允许回退或重开。 |

禁止：网格员调用审核接口；`submitted` 直接 `confirmed`；`failed`/`cancelled` 再流转；任何“已开通/已激活”状态或文案；把 `processing` 描述成开通中。

并发规则：

1. 读到的 `updatedAt` 必须回传为 `expectedUpdatedAt`；不一致返回 `409`，提示刷新。
2. 更新后的 `updatedAt` 取 `max(now, previous + 1ms)`，保证同毫秒内也能产生新版本。
3. 审核确认/驳回、状态流转、转交、跟进写入均在同一事务内更新主记录 + 追加事件。
4. 重复审核、陈旧审核、跨社区审核返回 `409` / `403`；同一订单的并发 `confirm` 只有一个成功。
5. 唯一冲突（同社区受理单号重复）映射为 `409`，不泄漏底层 SQL。

## 5. 三类来源分离与成交归属

线索来源分成三条互斥的数据路径，避免“一个自由文本字段”导致的归属争议：

1. **活动来源（`activity`）**：必须带 `sourceActivityId`，指向已存在且同社区的活动。活动页面/H5 进入时由服务端会话或活动上下文确定，客户端不能伪造他社区活动。
2. **推广来源（`grid_promotion`）**：记录 `promotionStaffId`（缺省为当前归属），推广人与当前归属分开，转交后推广人不变。
3. **到访/居民转介（`walk_in` / `resident_referral`）**：不写活动、推广人快照，只记录当前归属与创建人。

成交归属规则：

- 线索的 `sourceType`、`sourceActivityId`、`promotionStaffId` 在创建时冻结；转交只改变 `ownerStaffId`。
- 创建业务单时，`attributedStaffId = 创建时的 lead.ownerStaffId`，并复制 `sourceActivityId` / `promotionStaffId`。这三个字段此后不可改；线索再转交也不重新归属历史订单。
- `confirmed` 只表示运营人工核验有效成交；`activationSource` 恒为 `manual_verification`。
- 本卡不做佣金/分账，不做订单金额；这些快照只为后续结算卡提供稳定输入。

## 6. 转交保留原归属

- 转交请求必须带 `expectedUpdatedAt`、`toOwnerStaffId` 与 `reason`；目标员工必须是同一社区、状态为 active 的 `operator` / `grid_worker`。`admin` 仅作为操作者，不能成为线索 owner、推广人或转交目标。
- 转交在同一事务中：更新 `crm_leads.owner_staff_id` 与 `updated_at`，追加 `lead.transferred` 事件，记录 `fromOwnerStaffId` / `toOwnerStaffId` / `reason`。
- 创建人 `createdByStaffId`、来源活动、推广人不变；已创建业务单的 `attributedStaffId` 不变。
- 网格员只能转交自己名下线索，且目标必须是同社区网格员/运营；管理员与运营可在社区范围内转交任意线索。管理员创建线索时必须显式指定该社区的一名 active 运营/网格员为归属，不能把线索归给 admin。
- 没有删除线索/业务单接口；历史事件与跟进不可改写。

## 7. 权限矩阵

所有权限在服务端依据 `staff_accounts` + `staff_community_assignments` 判定；前端隐藏按钮不算授权。`admin` 不受社区限制；`operator` / `grid_worker` 只能访问被分配社区。

| 能力 | admin | operator | grid_worker |
| --- | --- | --- | --- |
| 查看线索列表/详情 | 全社区 | 分配社区全部 | 分配社区内**本人 owner** 的线索 |
| 创建线索 | 任意社区（须显式指定该社区 active 运营/网格员） | 分配社区 | 分配社区，归属本人 |
| 修改线索状态 | 任意社区 | 分配社区全部 | 仅本人 owner |
| 转交线索 | 任意社区 | 分配社区全部 | 仅本人 owner，目标同社区 |
| 查看/新增跟进 | 任意社区 | 分配社区全部 | 仅本人 owner |
| 查看线索时间线 | 任意社区 | 分配社区全部 | 仅本人 owner |
| 查看业务单列表/详情 | 全社区 | 分配社区全部 | 分配社区内本人创建/归属的单据 |
| 创建业务单 | 任意社区 | 分配社区 | 仅本人 owner 线索 |
| 业务单状态流转（非 confirm） | 任意社区 | 分配社区全部 | 分配社区内本人创建/归属单据 |
| 运营人工核验（confirm/reject） | ✅ | ✅（分配社区） | ❌ 403 |
| 事件时间线 | ✅ | ✅（分配社区） | 仅可见范围内的单据/线索 |
| 筛选项 | 全部社区/员工 | 分配社区/员工 | 分配社区/本人 |

网格员列表默认只看本人；显式传他人 `staffId` 返回 `403`，不静默忽略。跨社区 `communityId`、跨社区详情/审核一律 `403`。

## 8. 敏感信息最小化与审计红线

- 手机号只存在于 `crm_leads.contact_phone` 与 `crm_service_orders.contact_phone` 快照；列表响应只返回 `contactPhoneMasked`（如 `138****0000`），完整号码只在有权限的详情响应出现。
- 审计事件只记录事件名、状态前后值、归属前后值、原因/备注与操作者用户 ID；**不得**写入手机号、密码、Session/Cookie、CSRF、OAuth code/token、openid、证件号。
- `evidenceRef` 是脱敏引用文本，最长 200 字符；禁止存证件照片、银行卡、广电账号密码或完整证件号。
- 日志（`logEvent`）不输出请求体、手机号或凭证；错误信息不回显敏感字段。
- 跟进正文与备注属于业务内容，仍不得粘贴凭证/密码；代码不做自动扫描，但评审与负例测试覆盖。
- 审计表 `audit_logs` 继续记录关键操作（创建、转交、状态流转、审核）；CRM 自身事件表提供按线索/订单的时间线。应用层不提供审计/事件修改或删除接口，CRM 事件表另由 SQLite trigger 拒绝 UPDATE/DELETE。

## 9. 与 #60 并行和迁移编号协调

- 本卡基线：`origin/dev@1d4f000`；`apps/api/db/migrations/` 只有 `0000` / `0001`。
- 2026-11-04 核对：`origin/dev` 与并行 worktree `ll-mvp-004`（Issue #60）均未占用 `0002`。Captain 已确认 **`0002` 由 #61 / ll-mvp-005 占用**，迁移文件为 `apps/api/db/migrations/0003_crm_core.sql`（journal idx=2）。
- 本 PR 只追加 CRM 表与索引/触发器，不修改 `0000` / `0001`，不修改既有活动表与 #60 的活动参与/三人团相关表；contracts 只追加 CRM 段，不改 #60 段。
- 若 #60 在集成时先合并并占用了 `0002`，由 Captain 在集成本 PR 时把本迁移整体顺延为 `0003`：重命名 SQL 文件、同步 `meta/_journal.json` 的 tag/idx 与 `meta/0003_snapshot.json`，保持 SQL 语义不变，并重跑“全新库 + 既有 0000/0001/0002 库”升级测试。本卡不预先占用 `0003`，避免空号。
- 合并顺序由 Captain 决定；两个 PR 不得共用 worktree。

## 10. 明确未实现边界

- **无广电开通接口**：不调用任何真实广电/运营商 API，不返回开通结果；“已提交受理”“处理中”“待核验”“有效成交（人工核验）”是仅有的真实语义。任何界面不得把 `submitted` 显示成“已开通/已激活”。
- **无自动佣金/分账/对账**：`attributedStaffId` 等快照只供后续卡片使用；本卡不计算金额、不生成结算单、不与商城/支付系统交互。
- **不导入未授权居民名单**：线索只能由有权限的员工手工创建；不支持 CSV/批量导入。
- **无自动线索合并/去重**：同一居民重复创建由人工判断；只做参数校验与必要索引。
- **无文件上传**：`evidenceRef` 只是脱敏文本引用，不保存图片/PDF。
- **无删除/归档接口**：线索、跟单、事件、业务单均只能追加或状态流转，不做物理删除。
- **无短信/外呼集成**：H5 只展示联系电话，由网格员自行拨号；不发送短信、不记录通话内容。
- **本卡不含 H5/后台页面实现**（T3/T4）与端到端浏览器验收（T5）；本文只冻结契约、模型、迁移与权限语义。

## 11. 迁移验证记录

迁移 `0003_crm_core.sql` 除 drizzle-kit 生成的表/索引外，手工补充了 6 个追加式触发器（lead events、follow-ups、order events 各一组 UPDATE/DELETE ABORT）。

已执行并跟过的命令：

```bash
pnpm --filter @sanchuang-dev/local-life-contracts build
pnpm --filter @sanchuang-dev/local-life-api typecheck
cd apps/api && pnpm db:generate          # 基于最新 0002 快照生成 0003 增量与 meta/0003_snapshot.json
```

迁移升级验证（临时脚本，验证后已删除）：

- 全新空库执行 `0000 → 0001 → 0002`：5 张 CRM 表与 6 个触发器存在。
- 已执行 `0000/0001` 且含社区/用户/活动数据的既有库就地升级：既有数据保留，新增 5 张 CRM 表。
- 触发器实测：对 `crm_lead_events` 的 UPDATE/DELETE 均被 `RAISE(ABORT)` 拒绝；同社区重复 `order_no` 触发 UNIQUE 冲突。
- 来源活动快照使用 `ON DELETE restrict`：被线索/业务单引用的 `activities` 行无法删除，实测触发 FOREIGN KEY 拒绝。
- 另取主工作区真实开发库副本（升级前无 CRM 表、2 个 users）执行同一迁移：5 张 CRM 表创建成功，原有 users 保留。
- 再次执行 `pnpm db:generate` 返回 `No schema changes, nothing to migrate`，确认 schema 与 `0002` 快照一致。
- API 既有测试：`pnpm --filter @sanchuang-dev/local-life-api test` 19/19 通过；`oxlint` 对修改文件 0 warning / 0 error。

T2 API 实现补齐后的验证（2026-11-04，`crm-api`）：

```bash
pnpm --filter @sanchuang-dev/local-life-contracts build && pnpm --filter @sanchuang-dev/local-life-api test
pnpm --filter @sanchuang-dev/local-life-api typecheck
pnpm --filter @sanchuang-dev/local-life-api build
pnpm exec oxlint apps/api/src/crm apps/api/src/app.ts apps/api/test/crm.test.ts
```

- API 测试 29/29 通过（既有 19 + `apps/api/test/crm.test.ts` 10 项）；新增用例覆盖未登录 401、缺 CSRF/不可信 Origin 403、审核写 CSRF 负例、社区与本人范围、客户端伪造归属/审核人、真实文件 SQLite 关闭重开、转交与归属冻结、状态机/重复单号/并发审核、服务端过滤分页、追加式事件与敏感字段、0000/0001 → 0002 升级。
- typecheck、build 均通过；oxlint 对 T2 文件 0 warning / 0 error。
- 以上为 Hono 路由级集成测试（真实中间件、真实 SQLite、真实事务）；真实 TCP HTTP 与浏览器全链路证据由 T5 独立验证归档。

T7 修复复核（2026-11-04）：

- `reviewOrder` 对 `new` 线索在同一事务内写 `new→contacting`、`contacting→converted` 两次条件更新与两条事件/审计；`invalid` 线索返回 409 且订单保持 `pending_verification`；`contacting` 单跳、`converted` 幂等。
- 分页用例改为对 `nextContactAt` 排序的期望 ID 切片真实比较，并保留 page1/page2 不重叠断言。
- 审核 CSRF 负例改用 operator + pending 订单，缺 `x-csrf-token` 返回 403，带 CSRF 对照请求成功。
- 补充外社区 operator/grid 读取业务单详情与 audit 的 403 负例；`assertStaffAssignable` 明确拒绝 admin 作为归属/推广/转交目标，测试覆盖转交 admin 返回 400。
- 删除两处恒真弱断言，改为对 `createdByStaff` 等真实业务字段的断言。


## 12. 给 API / 客户端实现的契约要点（T2/T3/T4）

1. 只从 `@sanchuang-dev/local-life-contracts` 导入枚举、路由与 DTO；不要在应用内复制字符串数组或 schema。
2. 所有列表查询由服务端分页/过滤；不要在前端拉全量再过滤；排序固定，不传 `sort`。
3. 写接口统一校验 CSRF（`ll_csrf` + `x-csrf-token`）与服务端角色/社区范围；错误走统一 envelope。
4. `expectedUpdatedAt` 用详情响应里的 ISO `updatedAt`；收到 `409` 必须提示刷新，不自动重放。
5. 审核确认只能走 `POST /admin/crm/orders/:orderId/review` 且 `decision=confirm`；客户端不得自行把 `pending_verification` 渲染成 `confirmed`。
6. 列表手机号只用 `contactPhoneMasked`；详情才能显示完整号码；时间线/审计不显示手机号。
7. 事件时间线未知事件名按原字符串展示，不要因新增事件而崩溃。
8. 网格员 H5 不提供审核入口；运营后台不提供“开通”按钮，只提供“人工核验确认/驳回”。
