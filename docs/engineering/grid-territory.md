# 网格员片区经营模型

> 本轮只建立「一个网格员对应一个逻辑社区（片区）」的经营归属与权限约束，不改变订单核验后的业绩生成规则，不引入地图围栏、多人分佣或自动转移。

## 1. 产品规则与权威数据源

| 规则 | 实现 |
| --- | --- |
| 社区是可独立拆分的逻辑经营片区，不必对应真实行政社区 | 沿用 `communities`，管理员可创建多个逻辑片区 |
| 一个网格员同一时间最多经营一个片区 | `staff_community_assignments` 的部分唯一索引 `staff_community_grid_staff_uq` |
| 一个片区同一时间最多一个经营网格员 | 同一表的部分唯一索引 `staff_community_grid_territory_uq` |
| 片区允许暂时没有网格员 | 不要求每个社区都有 `grid_territory` 行 |
| 运营员仍可管理多个社区 | `operator_scope` 行，不受上述唯一索引约束 |
| 平台管理员保持全局权限 | 管理员不依赖该表获得范围 |
| 历史社区、居民、订单、流水不随离职转移 | 解除或更换只改动当前经营关系行；历史事实表不级联删除 |

`staff_community_assignments` 仍是唯一权威来源，新增列：

- `assignment_kind`：`operator_scope`（运营员多社区授权）或 `grid_territory`（网格员唯一片区）。
- 主键仍是 `(staff_account_id, community_id)`。
- 网格员的两条部分唯一索引由 SQLite 强制执行，不依赖 UI 或单个接口。

角色目前没有编辑 API，因此 `assignment_kind` 不会通过受支持路径与角色漂移。若未来开放角色变更，必须同时重算两类行，并重新跑本文的预检。

## 2. 迁移与历史冲突

迁移：`apps/api/db/migrations/0030_grid_territory.sql`。

迁移会：

1. 用当前不可变角色回填 `assignment_kind`：`grid_worker` → `grid_territory`，其余 → `operator_scope`。
2. 在重建表前用临时触发器检查冲突；发现冲突直接中止，不选择「保留谁」、不删除任何行。
3. 重建表、恢复外键与社区索引，并创建两条部分唯一索引。

预检命令（只读）：

```bash
pnpm --filter @sanchuang-dev/local-life-api db:grid-territory:preflight
# 可指定数据库
DATABASE_PATH=/path/to/local-life.sqlite pnpm --filter @sanchuang-dev/local-life-api db:grid-territory:preflight
```

发现冲突时的处理方案：

- **一名网格员关联多个片区**：由管理员确认其唯一经营片区，在其余片区的「经营负责人」中解除；不要删除社区、居民或订单。若业务确实需要多人覆盖一个住宅区，拆分新的逻辑片区后分别分配。
- **一个片区关联多名网格员**：由管理员确认唯一负责人，其余人员解除；需要并行经营时创建新的逻辑片区。
- 全部冲突清除后重新运行预检，确认 `GRID_TERRITORY_PREFLIGHT=PASS`，再启动 API 执行迁移。

迁移失败会阻止 API 启动，这是预期行为：宁可阻塞，也不静默改写历史经营关系。

## 3. API 与界面

| 操作 | 接口 | 说明 |
| --- | --- | --- |
| 分配运营员 / 初次分配网格员 | `POST /admin/communities/:communityId/staff` | 仅管理员 + CSRF；网格员受一对一约束 |
| 原子更换片区负责人 | `PUT /admin/communities/:communityId/grid-worker` | 请求带 `expectedStaffAccountId`；并发修改返回 409，不做静默覆盖 |
| 解除社区人员 | `DELETE /admin/communities/:communityId/staff/:staffAccountId` | 仅删除当前关系并写审计；历史数据不变 |
| 创建账号 | `POST /admin/staff` | 网格员必须且只能提交一个 `communityIds` |

后台「社区管理」分列展示「经营网格员」与「运营员授权」，分别提供经营负责人抽屉和运营员授权抽屉。更换负责人会二次确认并提示旧负责人立即失去该片区访问权限。

权限在每次服务端请求读取关系表，因此解除后旧人员的下一次请求即被拒绝；新负责人的下一次请求即获得授权。会话中的社区列表在 `/auth/session` 重新读取。

## 4. 审计事件

- `staff.community_assigned`：新增关系，metadata 含 `communityId`、`assignmentKind`。
- `staff.community_unassigned`：解除关系，metadata 含 `communityId`、`assignmentKind`。
- `staff.grid_territory_reassigned`：原子更换负责人，metadata 含 `communityId`、`previousStaffAccountId`。

审计只记录关系变化，不改写订单归属、居民绑定或流水。

## 5. 验证

- `apps/api/test/grid-territory.test.ts`：真实 SQLite + Hono HTTP，覆盖一对一正反例、运营员多社区、管理员操作、解除/更换后的权限变化、并发分配、历史居民/订单/归属保留。
- `apps/admin/src/pages/CommunitiesPage.test.tsx`：经营负责人分配、更换、解除、运营员单独解除授权。
- `apps/admin/src/pages/StaffAccessPage.test.tsx`：网格员创建时的单片区表单约束。
