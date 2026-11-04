# LL-MVP-004 · 居民参与与三人团实现说明

> 对应 [Issue #60](https://github.com/sanchuang-dev/local-life/issues/60)。本文描述本期已经交付的参与/三人团链路：T2 数据层与事务服务、T3 居民 HTTP 路由、T4 居民 H5 真实三人团与分享。签到、消费、抽奖、榜单与大奖结算仍属演示范围，不在本期实现内。

## 1. 边界

已交付：

- SQLite + Drizzle 持久化：`activity_teams`、`activity_participations`、`activity_invitations`；
- 迁移 `0002`：建表、唯一索引、CHECK 约束、触发器；
- 事务服务 `apps/api/src/participation/service.ts`：`getParticipationState` / `confirmParticipation`；
- 真实 SQLite 测试：`apps/api/test/participation.test.ts`（含两个独立进程/连接的抢席并发证明）；
- 居民 HTTP 路由 `apps/api/src/participation/routes.ts`：`GET` / `POST /activities/:activityId/participation`
  （与共享契约 `PARTICIPATION_ROUTES` 一致），居民身份只来自服务端会话，写请求要求 CSRF
  double-submit，请求/响应均用共享 schema 校验；
- 居民 H5：真实的当前团、席位、邀请/分享、加入反馈，以及 `activityId + invite` 深链接
  （`apps/web/src/components/activity/share.ts`、`hooks/useActivityParticipation.ts`）。

仍为演示范围或后续卡（本文不声称已可用）：

- 签到核验、消费达标、抽奖、榜单、大奖/奖品发放与结算；
- 团队奖归属与分佣规则；
- 退出、解散、换团、补位、管理员仲裁（首版明确不提供，见 §9）。

## 2. 数据模型

三次迁移之后的相关表（列名与真实 schema 一致）：

### `activity_teams`

| 列 | 说明 |
| --- | --- |
| `id` | UUID 主键 |
| `activity_id` | FK → `activities.id`，`ON DELETE restrict` |
| `leader_user_id` | FK → `users.id`，`ON DELETE restrict`，发起人即第 1 席持有者 |
| `status` | `open` \| `locked` |
| `created_at` / `locked_at` | 建团时间；`locked_at` 仅在锁团时写入一次 |

约束：`UNIQUE(activity_id, leader_user_id)`（同一活动一人只能发起一个团）、
`CHECK(status IN ('open','locked'))`、
`CHECK((status='locked' AND locked_at IS NOT NULL) OR (status='open' AND locked_at IS NULL))`。

### `activity_invitations`

| 列 | 说明 |
| --- | --- |
| `id` | UUID 主键 |
| `code` | 32 位小写 hex，`UNIQUE`；由服务端 `randomBytes(16)` 生成 |
| `activity_id` | FK → `activities.id`，`restrict` |
| `team_id` | FK → `activity_teams.id`，`restrict`；`UNIQUE(team_id)` 保证一队一码 |
| `inviter_user_id` | FK → `users.id`，`restrict`；建团时等于团长 |
| `created_at` | 发码时间 |

约束：`CHECK(length(code)=32 AND code NOT GLOB '*[^0-9a-f]*')`。

### `activity_participations`

| 列 | 说明 |
| --- | --- |
| `id` | UUID 主键 |
| `activity_id` / `team_id` / `user_id` | 全部 `restrict` FK；`UNIQUE(activity_id, user_id)` 是"同一活动一人一个有效团籍"的最终保证 |
| `seat_no` | 1..3；`UNIQUE(team_id, seat_no)`，`CHECK(seat_no BETWEEN 1 AND 3)` |
| `role` | `leader`（第 1 席）\| `member`（第 2、3 席） |
| `invite_source` | `self`（自己发起）\| `invite`（接受邀请加入） |
| `invitation_id` | 可空 FK → `activity_invitations.id`；`invite` 时必填，`self` 时必为 `NULL` |
| `joined_at` | 首次确认时间，即归属冻结时间 |

约束 `activity_participations_role_source_check` 把"第 1 席是团长自报、第 2/3 席是邀请加入"写成数据事实：

```text
(role='leader' AND seat_no=1 AND invite_source='self' AND invitation_id IS NULL)
OR (role='member' AND seat_no BETWEEN 2 AND 3 AND invite_source='invite' AND invitation_id IS NOT NULL)
```

索引：`activity_participations_user_idx(user_id)` 供"某居民跨活动的参与记录"查询使用；
`activity_teams_activity_idx`、`activity_invitations_activity_idx` 供活动维度读取。

## 3. 不变量

1. 同一活动同一居民至多一条参与记录（`UNIQUE(activity_id, user_id)`）；不同活动可重新组队。
2. 一个团永久最多 3 席（`CHECK(seat_no BETWEEN 1 AND 3)` + `UNIQUE(team_id, seat_no)`）。
3. 第 1 席永远是团长，第 2、3 席永远是接受邀请的成员；第 4 席在数据层无法写入。
4. 3/3 时同一事务把团队置为 `locked` 并写 `locked_at`；`locked` 团队不再返回邀请码。
5. 归属字段（`activity_id`、`team_id`、`user_id`、`seat_no`、`invite_source`、`invitation_id`）写入后不可 UPDATE；参与、团队、邀请均不可 DELETE。
6. 团队 `status` 只能 `open → locked`；不可解冻，`locked_at` 不可清空或改写。
7. 参与记录的 `activity_id`/`team_id` 必须与团队自身一致，`invitation_id` 必须属于同一活动同一团队（触发器校验）。

## 4. 活动可参与条件

服务与路由的分工：`draft` 与"不存在"在对外表现上都是 404，但服务内部可区分
`ParticipationError.reason`：`activity_draft` / `activity_not_found`；路由直接把
`ParticipationError` 的 `status` 与 `code` 翻译成 `{ error: { code, message, requestId } }`。

| 活动状态 | 时间 | 可参与 |
| --- | --- | --- |
| `draft` | — | 否；服务抛 404 `activity_draft`，路由决定 404 |
| `published` | `now <= ends_at` | 是（发布后、开始前允许预报名） |
| `published` | `now > ends_at` | 否，`activity_ended` |
| `paused` | — | 否，`activity_not_published` |
| `ended` | — | 否，`activity_ended` |

`getParticipationState` 返回共享契约的 `activityParticipationStateSchema`：

- `activityStatus` 是公开状态（`published`/`paused`/`ended`），与库内状态一致；
- `joinable` 表示"该居民现在能否新确认参与"：活动在可参与窗口内且该居民尚无参与记录时为 `true`；
- `unavailableReason` 只描述活动生命周期阻塞（`activity_not_published` / `activity_ended`），
  不表达团满或已参与；这两种情况是 `joinable=false` + `unavailableReason=null`。

## 5. 确认参与的事务顺序

`confirmParticipation` 在**一个** `db.transaction(..., { behavior: 'immediate' })` 内完成全部读写：

1. 读取活动：不存在 → 404 `activity_not_found`；`draft` → 404 `activity_draft`；
2. 活动不在可参与窗口 → `activity_unavailable`，此时尚未写入任何行；
3. 该居民已有参与记录 → 幂等返回 `created=false` 与当前 state，不换团、不覆盖归属；
4. 请求体带 `inviteCode`（分享链接参数名是 `invite`）→ 解析邀请码；无效、格式不符或跨活动 → `invite_invalid`；
   团队已 `locked` 或已有 3 席 → `team_full`；否则写入下一空闲席位（`member`），
   冻结 `invitation_id` 与 `invite_source='invite'`；
5. 不带 `inviteCode` → 建团（`open`）、发一队一码、写第 1 席（`leader`、`self`）；
6. 本次写入使席位数达到 3 → 同一事务内 `UPDATE ... SET status='locked', locked_at=? WHERE status='open'`，
   影响行数必须为 1，否则回滚。

`BEGIN IMMEDIATE` 在执行第一条读之前就取得 SQLite 写锁，因此不存在
"两个请求都读到还有空位、随后都插入"的 check-then-insert 窗口；后到者要么等待锁，
要么在拿到锁后读到已 `locked` 的团队并得到 `team_full`。唯一索引与触发器是最后防线，
即使有人绕过服务直接写库也无法造出第 4 席或第二个团籍。

失败路径全部通过事务回滚，不会留下"半条记录"（团队、邀请、参与、审计一起提交或一起回滚）。

## 6. 审计

写入 `audit_logs`，`target_id` 为 `activityId`（与活动域读取一致），`actor_user_id` 为发起该动作的居民：

| event | 触发 | metadata 键 |
| --- | --- | --- |
| `participation.created` | 新建参与（团长或受邀成员） | `teamId`、`seatNo`、`role`、`inviteSource` |
| `team.locked` | 第 3 席写入的同一事务 | `teamId`、`seatsFilled` |

metadata 只含 ID 与枚举/席位数字，**不记录邀请码、OpenID、session token、密码或任何凭证**。

## 7. 分享参数与归属语义

- 活动分享链接固定为 H5 路由 `#/community/activity/silver-neighborhood?activityId=...&invite=...`：
  - `activityId` 必填，决定活动上下文（缺失时 H5 不加载任何团状态）；
  - `invite` 可选，32 位小写 hex 邀请码，只在确认参与时用于解析邀请归属；格式不符的
    `invite` 会被 H5 识别为无效参数并提示，不会转发给 API。
- API 请求体字段名是 `inviteCode`（共享契约 `activityParticipationConfirmRequestSchema`，
  `z.strictObject`），与 URL 参数名 `invite` 不同；两者不会混写。
- 只是打开链接、复制链接或扫码浏览不算参与，也不写任何归属；
- 居民首次"确认参与"时冻结归属；之后打开其他团的链接或再次 confirm 都不会改写。
- 邀请归属属于**团队**（`inviter_user_id` 为团长），不是多级邀请树：
  系统不记录"谁邀请了谁"的链式关系用于分佣。

### 7.1 已知限制：微信 OAuth 会丢失分享深链

本期微信登录回调固定跳回 `/#/me?auth=success`（`redirectToWeb`），不会带回原页面的
`activityId` / `invite` 参数。因此"未登录居民打开分享链接 → 微信登录 → 回到活动页并保留
邀请归属"这条路径目前**受限**：登录后需要重新打开分享链接，邀请归属才可能被记录。

这是待处理项，不是已修复项：微信 AppID/AppSecret、授权回调域名等真实配置尚未具备，
该路径也暂未实测；后续需在 OAuth state 中携带并校验回跳上下文后再更新本文。

## 8. 邀请归因与网格员销售归因分离

两套事实记录互不读写：

- 本卡的三张表只表达"居民参与了哪个活动的哪个团、由哪个邀请码进入"；
- 网格员/社区销售归属来自后台账户与社区分配（`staff_accounts`、`staff_community_assignments`）
  以及后续销售/订单域，本 schema 不含任何 `grid_worker_id`、销售人、佣金或提成字段；
- `activityParticipationState` DTO 中也没有销售归属字段，客户端不能据此计算提成；
- 邀请归因归因于团长本人，不因团长是网格员而转成销售业绩，反之亦然。
  两个归因域如需联合报表，必须由后续卡定义显式、可审计的映射，不能靠本表字段互读。

## 9. 首版不提供的能力

按 Issue #60 的 2026-11-04 首场试点规则，首版**不提供**：

- 主动退出、解散团队、换团、被移出或补位；
- 自动补位到已 `locked` 的团；
- 多级邀请树或按邀请关系分佣；
- 活动规则未冻结的奖励/签到/消费结算逻辑。

如遇欺诈或误操作，保留审计记录，由管理员特殊处理（后续另卡定义），
不把未定义的仲裁规则硬编码成平台永久限制。

## 10. 错误码映射

服务抛 `ParticipationError`，路由已按下列映射翻译为共享错误信封：

| reason | code | 建议 HTTP | 含义 |
| --- | --- | --- | --- |
| `activity_not_found` | `not_found` | 404 | 活动不存在 |
| `activity_draft` | `not_found` | 404 | 活动未发布，居民不可见 |
| `activity_unavailable` | `activity_unavailable` | 409 | 活动暂停/结束/已过 `ends_at` |
| `invite_invalid` | `invite_invalid` | 400 | 邀请码无效、格式不符或不属于本活动 |
| `team_full` | `team_full` | 409 | 团队已满 3 人 |
| `concurrent_conflict` | `conflict` | 409 | 唯一约束兜底命中的并发冲突，可安全重试 |

## 11. 验证证据

T2 数据层的验证命令：

```bash
pnpm --filter @sanchuang-dev/local-life-contracts build
pnpm --filter @sanchuang-dev/local-life-api test
pnpm --filter @sanchuang-dev/local-life-api typecheck
rm -f /tmp/ll-mvp-004-migrate.sqlite && \
  DATABASE_PATH=/tmp/ll-mvp-004-migrate.sqlite pnpm --filter @sanchuang-dev/local-life-api db:prepare
```

`apps/api/test/participation.test.ts` 使用真实 SQLite（better-sqlite3 + Drizzle，无内存 Mock）覆盖：

- A/B/C 依次 3/3，第 3 席与 `locked` 同事务提交，`locked_at` 落库；
- 第四人得到 `team_full`，库中永远只有 3 席；
- 重复 confirm 幂等（`created=false`）、不换团、不新增行；
- B 用 A 的邀请码确认后再用 C 的邀请码确认，归属与席位不变；
- 同一居民跨活动可再组队，同活动第二个团籍被 `UNIQUE(activity_id,user_id)` 拒绝；
- 无效、格式不符、跨活动邀请码均 `invite_invalid` 且不产生半条记录；
- `paused`、`ended`、已过 `ends_at` 的活动拒绝参与，状态读取仍然真实；
- `draft` 与不存在分别返回可区分的 404 reason；
- 空库迁移成功，三张表、唯一索引、全部 `restrict` 外键与 10 个触发器存在；
- 触发器拒绝归属 UPDATE、三类 DELETE、解冻与清空 `locked_at`、第 4 席与跨活动混写；
- **两个独立进程各自建立 better-sqlite3 连接、同时抢同一个团的最后一席**：先由父进程持有
  写锁让两个连接都排队，释放后恰好一个成功（第 3 席 + `locked`），另一个 `team_full`，
  席位保持 3，`team.locked` 审计只写一次。

T3 路由与 T4 H5 的真实 HTTP/浏览器证据由对应任务记录在
`docs/engineering/evidence/ll-mvp-004/`；本次文档更正没有重跑或复核这些验证，因此不在此处
转述其结论。
