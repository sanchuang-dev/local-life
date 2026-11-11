# LL-IDENTITY-001 (#171) · 常驻社区唯一绑定：迁移风险与历史归属预检

> 对应 [Issue #171](https://github.com/sanchuang-dev/local-life/issues/171)。本文只描述**当前代码与迁移的真实行为**、**历史数据的只读预检方法**和**必须人工裁决的条件**。它不代表任何线上数据库已被检查或清理。

## 1. 产品规则（不可绕过的边界）

1. 一个平台居民账号最多只有一个**本人显式确认**的常驻社区。
2. 浏览自由：定位、搜索、切换社区、查看其他社区公开活动/商品只改变浏览上下文（`localStorage` + 客户端状态），**不写任何归属**。
3. 绑定只能由本人首次主动确认建立，确认后居民端与管理台都**不提供**自助改绑/解绑入口。
4. 登录（微信 OAuth、开发登录）只认证身份，**不再自动写入常驻绑定**。活动上下文最多产生一次「绑定候选」，仍需本人确认。
5. 历史 `resident_community_assignments` 行**不构成确认证据**：它们是旧登录流程写的，没有本人同意。
6. 常驻绑定与网格员推广归因、业绩、收款、分账是**不同领域**，绑定不自动产生任何业绩权利。

## 2. 数据模型

| 表 | 语义 | 是否可变 |
| --- | --- | --- |
| `users` | 平台账号主键（UUID） | 既有 |
| `communities` | 社区与服务点 | 既有 |
| `resident_community_assignments` | **历史**登录归属事实，`(user_id, community_id)` 联合主键 | 只追加，本卡不删不改，也不加任何约束 |
| `resident_community_bindings` | **新增**常驻社区确认事实，`id` 为主键，`status` 当前只允许 `'confirmed'` | 只在本人首次确认时插入一行 |
| `resident_community_binding_candidates` | **新增**服务端派生的一次性「绑定候选」，`user_id` 为主键 | 登录时可写、确认时删除、7 天后读不到 |
| `audit_logs` | 确认与候选的审计证据 | 只追加 |

关键约束（数据库层，不依赖应用判断，见 `apps/api/db/migrations/0018_smiling_stardust.sql`）：

- `resident_community_bindings_user_confirmed_uq`：对 `(user_id)` 的**部分唯一索引**，条件 `WHERE status = 'confirmed'`；
- `resident_community_bindings_status_check`：`status` 目前只允许 `'confirmed'`，因此上面那条部分索引实际覆盖全表，任何第二条 confirmed 都不可能存在；
- `resident_community_bindings_source_check`：`source IN ('resident_h5_confirmed','admin_compliance_correction')`；本卡只有前者被任何代码写入，后者是未来合规改绑的预留值，**没有任何 API 或 UI 使用它**；
- `resident_community_bindings_evidence_check`：`evidence_ref` 非空，指向同一事务写入的 `audit_logs.id`（脱敏引用，不含凭证）；
- `resident_community_bindings_community_id_..._restrict`：社区被引用时禁止删除（`ON DELETE RESTRICT`）；
- `resident_community_candidates_expiry_check`：`expires_at > suggested_at`，候选过期后所有读取都忽略它。

状态机 `unbound / confirmed / pending_review / conflict` **全部按需派生计算，不存可变标记**：

| 状态 | 派生条件 |
| --- | --- |
| `unbound` | 无 confirmed 绑定，且历史归属 ≤ 1 |
| `confirmed` | 恰有一条 confirmed 绑定，且没有任何与之矛盾的历史归属 |
| `conflict` | 已有 confirmed 绑定 A，但历史归属指向另一个社区 B（**只读信号**，A 不变，确认 B 一律 409） |
| `pending_review` | 无绑定且历史归属 ≥ 2，**任何人**（含居民本人、管理员）都不能自助确认 |

## 3. 迁移在既有数据上的行为（保守策略）

迁移只做两件事：

1. 建两张新表与索引（`0018_smiling_stardust.sql`）；
2. **不做任何**从 `resident_community_assignments` 到 `resident_community_bindings` 的批量转换、不复制、不删除、不改列。

因此迁移后：

| 历史状态 | 迁移后表现 |
| --- | --- |
| 0 条历史归属 | `unbound`，需要本人首次确认 |
| 1 条历史归属 | `unbound` + 该社区作为**只读候选**（`legacy_single_assignment_candidate`）提示，仍须本人确认；不会自动 `confirmed` |
| 2+ 条历史归属 | `pending_review`（待人工核查），**不随机选最早/最新一条**，不写入 `confirmed` |

风险点与对策：

| 风险 | 对策 |
| --- | --- |
| 旧表被误加唯一约束导致多归属数据丢失 | 本卡**不修改**旧表结构，只在新建表上强制唯一 |
| 迁移失败需要回滚 | 迁移只创建新对象；回滚 = 删除新表/索引，旧数据行数不变（完整回滚语句写在迁移文件头注释） |
| 历史订单/报名/奖励/对账依赖旧归属 | 不删除、不重写任何既有事实行；新守卫只约束**新写入** |
| 多归属账号在上线时被随机归属 | 直接标 `pending_review`，前端显示「历史归属待核查」，写操作按未确认处理 |
| 线上库被本卡误操作 | 本卡不连接线上库；预检工具强制 `readOnly`，并由测试证明 SQLite 拒绝写 |

## 4. 历史归属只读预检方法

工具：`scripts/resident-binding-preflight.mjs`（`pnpm db:resident-binding:preflight <sqlite 路径>`）。

安全设计：

- 使用 `node:sqlite` 的 `readOnly: true` 打开数据库；**SQLite 自身**拒绝任何写语句，工具内也全部是 `SELECT`。
- 默认只输出聚合计数，**不输出**用户 UUID、手机号、openid、昵称等个人标识；`--user-ids` 是本机操作员显式选择后才输出 UUID。
- 数据库路径不存在、或不是 local-life 数据库（无 `users` 表）时直接失败退出，不会把「文件打不开」误报成「0 条归属」。
- 需要写操作的场景（真实数据修复）不在本工具范围内，必须走独立审批的运维流程。

输出内容：

1. `users` 总数与 0 / 1 / 2+ 条历史归属的数量分布；
2. 旧归属完整性：重复 `(user_id, community_id)`、指向不存在社区/用户的孤儿行、`created_at` 缺失/为 0/未来时间、是否存在来源列；
3. 是否已存在 `resident_community_bindings`，以及其中 `confirmed` 的行数与「一个账号多行 confirmed」的异常计数；
4. 业务事实影响面：`local_orders`、`activity_participations`、`activity_draw_attempts`、`activity_reward_grants`、`crm_leads`、`ledger_entries` 的总行数，以及挂在 2+ 归属账号上的行数；
5. 每个社区的历史关联人数（用于判断是否有社区会因为历史数据被低估）。

预检执行示例（本地或恢复副本，绝不指向线上库）：

```bash
# 只读、只出聚合数字
pnpm db:resident-binding:preflight .data/local-life-dev.sqlite

# 本机人工核查时需要平台 UUID
pnpm db:resident-binding:preflight .data/local-life-dev.sqlite --user-ids

# 机器可读，便于归档
pnpm db:resident-binding:preflight .data/local-life-dev.sqlite --json
```

工具自身的行为由 `scripts/resident-binding-preflight.test.mjs` 覆盖（0/1/多归属计数、聚合输出不泄漏 UUID、只读句柄拒绝 DELETE、缺失/错误库直接失败）。

### 4.1 只读性是「物理」的，不是承诺

为了不把「我们保证只读」写成一句口头承诺，仓库里另有三个脚本，把这件事变成可复现的证据：

| 文件 | 作用 |
| --- | --- |
| `scripts/resident-binding-evidence-fixture.mjs`（`pnpm db:resident-binding:fixture <路径>`） | 用**真实迁移链**（`apps/api/db/migrations/*.sql` 全部 19 个）建一个真实 SQLite，再插入 0 / 1 / 2+ 三种历史归属账号，以及挂在多归属账号上的一条 `local_orders` 和一条 `ledger_entries` |
| `scripts/resident-binding-readonly-proof.mjs` | 用**与预检完全相同**的 `{ readOnly: true }` 句柄，依次尝试 INSERT / UPDATE / DELETE / 插入绑定，四个写操作必须全部被 SQLite 拒绝 |
| `scripts/resident-binding-readonly-proof.test.mjs` | 5 个 `node:test`：① 四个写全部被拒（`attempt to write a readonly database`）；② 跑一次预检后文件**逐字节不变**且所有表行数不变；③ 路径不存在时失败退出而不是报「0 条」；④ fixture 确实包含 0/1/2+ 三个桶与 #171 新表；⑤ **可写句柄**（模拟误操作脚本）直插第二条 confirmed 会被部分唯一索引拒绝，`status` 非 `confirmed` 会被 CHECK 拒绝，且迁移文件中不存在 `ALTER TABLE resident_community_assignments` |

本机实测输出（`E:\tomz\_preflight_evidence.sqlite`，由上面的 fixture 生成）：

```
0 legacy relations:       1
1 legacy relation:        1
2+ legacy relations:      1
assignment rows:          3
confirmation provenance:  ABSENT (expected: legacy rows are unconfirmed)

Permanent binding table:
  resident_community_bindings: present, by status {}
  confirmed users with >1 row: 0

Business facts that touch a resident (rows for 2+ legacy relation accounts):
  local_orders: 1 rows, 1 on multi-relation accounts
  ledger_entries: 1 rows

Decision inputs:
  accounts needing first confirmation: 2
  accounts needing manual review:      1
  automatic conversion allowed:        false
  verdict:                             ready_for_manual_review
```

只读实证：

```
allWritesRefused: true
INSERT resident_community_assignments -> ERR_SQLITE_ERROR attempt to write a readonly database
UPDATE resident_community_assignments -> ERR_SQLITE_ERROR attempt to write a readonly database
DELETE FROM resident_community_assignments -> ERR_SQLITE_ERROR attempt to write a readonly database
INSERT resident_community_bindings     -> ERR_SQLITE_ERROR attempt to write a readonly database
```

## 4.2 社区专属写操作的守卫（本卡改动）

「浏览自由、绑定唯一」落地时，真正的风险点是**写入口**：旧代码把历史归属表（含 #123 登录自动写入的行）当作写权限。本卡把四个社区专属写入口统一改为「本人已确认常驻社区」判定，全部调用同一个守卫 `assertResidentOfConfirmedCommunity`（`apps/api/src/resident-community/service.ts`）：

| 写入口 | 位置 | 守卫后的行为 |
| --- | --- | --- |
| 活动参与/组团/邀请归因 | `apps/api/src/participation/service.ts` 的 `confirmParticipation` | 无绑定 → 403 先确认；已绑 A 参与 B → 403 且 message 含 A 的名称；已有参与记录直接返回，不受影响 |
| 本地订单（自助 + 员工代录） | `apps/api/src/local/orders.ts` 的 `assertResidentOfCommunity` | 同上；员工代录同样按「被代录居民」的确认绑定判定 |
| 今日抽奖 | `apps/api/src/draw/engine.ts` 的 `enterDraw` / `getMyDrawState` | 写：守卫拒绝；读：返回 `not_assigned` 而不是抛错 |
| 活动范围 CRMEB 购买链接与推荐归因 | `apps/api/src/crmeb/attribution.ts` | 同上；无活动上下文的自然购买不受影响 |

统一拒绝语义（`ResidentCommunityError`，由各路由映射为标准 `{ error: { code, message, requestId } }`）：

- `403 resident_community_not_bound`：「请先在『我的』中确认常驻社区，再进行本操作」
- `403 resident_community_conflict`：「你的常驻社区是「A」，不能在该社区操作」
- `404 resident_community_not_found`：社区不存在

登录侧同卡收口：

- `POST /auth/dev/login` 不再接受 `communityId`（`z.strictObject`，传了就是 400），也不再写历史归属；
- 微信 OAuth callback 删除了 `resident_community_assignments` 的自动插入，改为最多写一条**服务端派生**的候选（社区来自 `oauth_states.community_id`，即 `start` 从活动行推导的值，绝不来自请求；已确认的居民不写候选）；
- `GET /crm/residents` 不再以历史归属表为主表，改为按社区派生 `communityRelationSource`（`confirmed_binding` / `historical_assignment`），历史归属**不会**被显示成已确认。

## 5. 必须人工裁决的条件

出现下列任一情况时，**不得**上线该迁移结论，必须先由维护者人工核查：

1. 预检显示 `2+ legacy relations > 0`：需要逐个人工确认其真实常驻社区，本卡只把账号标为 `pending_review`，不做选择。
2. 旧归属存在重复 `(user_id, community_id)`、孤儿社区/孤儿用户行、`created_at` 缺失或倒挂：说明历史写入本身异常，需要先解释来源。
3. 多归属账号上存在 `local_orders` / `activity_participations` / 奖励 / `ledger_entries` / CRM 线索：这些既有事实不得因绑定迁移被改写，需要确认业务方接受「历史事实保留旧社区、新写入按确认社区」的口径。
4. 需要纠正已确认绑定（法律合规、录入错误、身份纠纷）：只能走受控、独立审批、可审计的运维路径；本卡**不提供**自助改绑 API，也不提供管理员随手改绑入口。

## 6. 上线前检查清单

1. `pnpm install --frozen-lockfile`
2. `pnpm check`
3. 在一个**恢复副本**上执行迁移，并运行预检对比迁移前后的 `users` 数、旧归属行数、业务事实行数（均必须不变）
4. 若预检出现第 5 节任一条件，先产出人工核查清单，再决定是否继续
5. 部署前确认 `resident_community_bindings` 为 0 行（全新）或全部为人工裁决后的 `confirmed` 行

## 7. 未覆盖 / 未验证

- 本卡未连接任何线上数据库，也未执行任何线上数据清理、迁移或修复。所有数字都来自本机用真实迁移链构造的 fixture。
- 真实微信网页授权凭证不存在，OAuth 只做代码级与本地 fake fetch 边界验证（`apps/api/test/wechat-oauth-runtime.test.ts`、`activity-login-network.test.ts`）；真实公众号回调未跑。
- 并发唯一性由 SQLite 串行化 + 部分唯一索引保证，测试是同进程双请求，**没有**多进程真实竞争用例。
- 320/375 宽浏览器验收由具备浏览器能力的执行者补测；缺失时在 PR 中明示。
- `admin_compliance_correction` 来源只是数据库预留值，本卡**没有**任何 API 或后台 UI 能写它。
