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
| `resident_community_assignments` | **历史**登录归属事实，`(user_id, community_id)` 联合主键 | 只追加，本卡不删不改 |
| `resident_community_bindings` | **新增**常驻社区确认事实（`status` 区分 `candidate` / `confirmed` / `pending_review`） | 只在首次确认时从候选/空转为 `confirmed` |
| `audit_logs` | 确认与候选的审计证据 | 只追加 |

关键约束（数据库层，不依赖应用判断）：

- `resident_community_bindings` 上以 `user_id` 为主键，因此一个账号在事实上不可能存在两行。
- 另有部分唯一索引 `WHERE status = 'confirmed'`，即使将来加入历史候选行，也只有一个 `confirmed` 能存在。
- `confirmed_at`、`source`、`confirmed_from_candidate` 记录确认时间与来源，供审计追查。

## 3. 迁移在既有数据上的行为（保守策略）

迁移只做两件事：

1. 建表/建索引（幂等 DDL）；
2. **不做任何**从 `resident_community_assignments` 到 `resident_community_bindings` 的批量转换。

因此迁移后：

| 历史状态 | 迁移后表现 |
| --- | --- |
| 0 条历史归属 | `unbound`，需要本人首次确认 |
| 1 条历史归属 | `unbound` + 该社区作为**只读候选**提示，仍须本人确认；不会自动 `confirmed` |
| 2+ 条历史归属 | `pending_review`（待人工核查），**不随机选最早/最新一条**，不写入 `confirmed` |

风险点与对策：

| 风险 | 对策 |
| --- | --- |
| 旧表被误加唯一约束导致多归属数据丢失 | 本卡**不修改**旧表结构，只在新建表上强制唯一 |
| 迁移失败需要回滚 | 迁移只创建新对象；回滚 = 删除新表/索引，旧数据行数不变 |
| 历史订单/报名/奖励/对账依赖旧归属 | 不删除、不重写任何既有事实行；新守卫只约束**新写入** |
| 多归属账号在上线时被随机归属 | 直接标 `pending_review`，前端显示「历史归属待核查」，写操作按未确认处理 |
| 线上库被本卡误操作 | 本卡不连接线上库；预检工具强制 `readOnly` |

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

- 本卡未连接任何线上数据库，也未执行任何线上数据清理。
- 真实微信网页授权凭证不存在，OAuth 只做代码级与本地 fake fetch 边界验证。
- 320/375 宽浏览器验收由具备浏览器能力的执行者补测；缺失时在 PR 中明示。
