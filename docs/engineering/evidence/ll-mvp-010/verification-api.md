# LL-MVP-010 · R1 服务端独立验证（t10）

> 执行者：`verifier`（独立验证；**未修改任何业务代码**，本文件是唯一写入的产物）
> 时间：2026-11-06（Asia/Shanghai）
> 被验证对象：提交 `007f433` `feat(api): local product catalogue and resident order registration (R1)`
> 分支：`feat/ll-mvp-010-local-catalog-orders`（未 push / 未合并 / Issue 未关闭 / 未部署）
> **结论：verdict = pass**。契约列出的 6 条验收全部实跑通过；2 条**非阻断**的纵深防御观察（仅能用裸 SQL 触发，API 无法达成），1 条需要产品确认的范围问题（居民自助取消）。

---

## 0. 怎么复核（四条仓库命令 + 四个一次性脚本）

```powershell
$node='C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm='C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
# 干净 R1 worktree（detached 007f433，git status 空）：
cd E:\tomz\local-life-wt\r1-verify
& $node $pnpm lint ; & $node $pnpm typecheck ; & $node $pnpm build
& $node $pnpm --filter @sanchuang-dev/local-life-api test

# 独立端到端（真实 Hono app + 真实文件 SQLite，129 项）
cd apps\api ; & $node --import tsx ..\..\.evidence\r1-verify.mts

# 真进程重启 / 真 TCP（14 项）
cd apps\api ; & $node --import tsx ..\..\.evidence\r1-process-restart.mts

# §5 里两条观察的取证脚本（各自打印 GAP/OK 或 HTTP 状态，不做断言）
cd apps\api ; & $node --import tsx ..\..\.evidence\r1-gap-probes.mts
cd apps\api ; & $node --import tsx ..\..\.evidence\r1-corrupt-row-probe.mts
```

四个脚本都在 `.evidence/`（已 `git/info/exclude`，**不进仓库**）。主脚本不 import 仓库自带的 `apps/api/test/local-catalog-orders.test.ts`，也不复用其断言，因此那份测试写错也不会掩盖服务层缺陷。

---

## 1. 命令与退出码

| # | 命令 | 工作区 | 退出码 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm lint` | `r1-verify`（`007f433` 干净） | **0** | `Found 20 warnings and 0 errors`（204→210 files） |
| 2 | `pnpm typecheck` | `r1-verify` | **0** | contracts / api / admin / web 四包全 `Done` |
| 3 | `pnpm --filter @sanchuang-dev/local-life-api test` | `r1-verify` | **1** | `tests 240 / pass 232 / fail 8`（**8 例为基线 EPERM，见 §4**） |
| 4 | `node --import tsx --test test/local-catalog-orders.test.ts` | `r1-verify` | **0** | `tests 17 / pass 17 / fail 0`（R1 自带测试单跑全绿） |
| 5 | `node --import tsx ../../.evidence/r1-verify.mts` | `apps/api` | **0** | `129 passed, 0 failed` |
| 6 | `node --import tsx ../../.evidence/r1-process-restart.mts` | `apps/api` | **0** | `14 passed, 0 failed` |
| 7 | `pnpm lint` | `baseline-eprem`（`origin/dev@ae8441a`） | **0** | `Found 20 warnings and 0 errors` |
| 8 | `pnpm db:generate` | `r1-verify` | **0** | `No schema changes, nothing to migrate`（schema 与 0009 一致） |
| 9 | `pnpm build` | `r1-verify` | **0** | contracts / api / admin / web 四包全 `Done`（web 798 kB chunk 体积告警为既有警告） |

日志：`.evidence/t10-lint-r1worktree.log`、`t10-typecheck.log`、`t10-api-test-r1worktree.log`、
`t10-local-suite-only.log`、`t10-r1-verify.log`、`t10-r1-process-restart.log`、`t10-lint-baseline.log`、`t10-build-r1worktree.log`。

**为什么另建 `r1-verify` worktree**：`mvp-010` 工作区里已有 R2 的未提交改动（`apps/admin/**`、`apps/web/**` 多个新文件）。为了让「R1 是否引入回归」有干净对照，我在 detached `007f433` 的独立 worktree 里跑上表 1/2/3/4/8/9。同一台机器、同一份 lockfile、同一 Node。

lint 警告对照：基线 20 条 / R1 20 条，**R1 未新增任何警告**（`packages/contracts/src/index.ts:1378` 的 `no-useless-escape` 在基线上已存在，R1 加代码后行号移到 `:1808`）。
（`mvp-010` 主工作区 lint 是 23 warnings，多出的 3 条来自 R2 未提交文件，与 R1 提交无关。）

---

## 2. 验收对照表（逐条，全部实跑）

| # | 契约验收项 | 判定 | 证据（脚本编号 = 结果 JSON 里的 name 前缀） |
| --- | --- | --- | --- |
| A | 真实 Hono app + 真实文件 SQLite 跑通正向链路：创建商品 → 上架 → 居民登记 → 查询 → 工作人员处理 → 运营核验 | **通过** | A1–A19 + P1–P5；`r1-verify-results.json` 的 A 组 19 项；真实进程组 `r1-process-restart-results.json` P3–P5 |
| B1 | 重复幂等提交只出一单 | **通过** | B1（201→200 `created:false`，同 id，1 行）、B2（同键异内容 → 409 `order_idempotency_conflict`，仍 1 行）、H3（商品下架后重放仍返回原单）、E9/E10（重启后重放同 id 且不增行）、F3/F4（**5 个独立 OS 进程**抢同一键 → 恰好 1 行） |
| B2 | 无会话 401 | **通过** | B3：12 条本地路由（居民 3 + 网格 3 + 后台目录 2 + 后台订单 3 + 核验 1）全部 `401 unauthorized`；B4：只有 `/catalog/products*` 公开可读（设计如此） |
| B3 | 越权 403 | **通过** | B5/B6/B7（无 CSRF / 非法 Origin → 403）、B8（grid_worker 建+列目录 403）、B9（operator 可管目录）、B32/B33（网格员核验 403、居民会话核验 401）、B44（隔壁社区运营核验本社区 403）、K4/K5（并发核验 loser 409 `order_already_verified`） |
| B4 | 网格员跨社区 403 | **通过** | B10（读他社区订单 403）、B11、B12（列表按社区裁剪：grid/operator 看不到他社区，admin 能看到）、B13（显式 `?communityId=` 越界 403 而非空页）、B14（迁移他社区订单 403）、B17/B18/B19（代录越界/幽灵居民） |
| B5 | 商品下架拒绝 | **通过** | B20（新登记 409 `product_off_shelf`）、B21（公开详情 404）、B22（既有订单快照不变）、B23（可再上架） |
| B6 | 价格篡改被忽略且快照不变 | **通过** | B24（`priceCents`/`unitPriceCents`/`totalCents`/`communityId`/`residentUserId`/`status`/`recordSource` 七个注入字段全部 **400**，strict 拒绝而非静默丢弃）、B25（服务端价 500×1）、B26（改价 900 后旧单快照仍 500/旧名）、B27（新单用新价 900）、G4（裸 SQL 改商品也不动快照） |
| B7 | 取消 | **通过** | B28（居民不能驱动 staff 状态机，401）、B29（staff 取消成功且 `cancelled` 为终态，再迁移 409）、B30（取消原因进时间线 `statusNote`） |
| B8 | 重复核验 | **通过** | B31（非 `pending_review` 核验 409）、B34（二次核验 409 `order_already_verified`）、B35（已核验订单不能被状态接口回退，同样 `order_already_verified`）、K4–K6（并发核验只产生 1 条 `order.verified` 事件） |
| B9 | 并发 | **通过** | F1（10 路并发同键 → 1 创建 9 重放、1 行、1 id）、F2（5 路不同键 → 5 单）、F3/F4（5 个真进程竞争，屏障同步）、K1–K3（同一乐观 token 并发改状态 → 1×200 + 1×409，且只追加 1 条事件）、K7/K8（并发上下架 → 1×200 + 1×409，无撕裂写） |
| B10 | 文件库重启后数据仍在 | **通过** | E1–E10（同进程 close→reopen：快照/时间线/核验记录/审计/会话 cookie/idempotency 全部存活）、**P1–P14（真进程重启）**：`apps/api/src/index.ts` 起真服务 → TCP 调用 → 杀掉 → 第二个进程对同一文件 → 数据与幂等仍正确 |
| C | 对照 `origin/dev` 干净 worktree 证明 8 例 rewards EPERM 是基线环境问题，且不声称已修复 | **通过** | 见 §4 |
| D | lint / typecheck / build / apps/api 测试实跑并给出退出码 | **通过** | 见 §1（lint 0 / typecheck 0 / build 0 / 测试 1，测试的 1 为 8 例基线 EPERM） |
| E | 产出本文件 + 可执行返修清单 | **通过** | 本文件；返修清单见 §6（均为非阻断） |
| F | verdict 与证据一致 | **通过** | 无必修问题 → `pass`；2 条观察与 1 条范围问题写在 §5/§6，明确标注「非阻断」 |

机器可读结果：`docs/engineering/evidence/ll-mvp-010/r1-verify-results.json`（129 项，分组 A19/B44/H10/I5/J5/K8/C15/D7/E10/F5/G1）、`r1-process-restart-results.json`（14 项）。

---

## 3. 除契约清单外，额外验证到的点

| 组 | 覆盖 | 关键结论 |
| --- | --- | --- |
| C1–C15 | 磁盘层不变量 | 39 张表；`local_orders_idempotency_uq` 等索引齐全；两条 `local_order_events` 触发器存在；裸 SQL 插入 `total≠unit×qty` / qty 0 / qty 100 / 非法 status / 非法 record_source / 重复幂等键 **全部被 CHECK / UNIQUE 拒绝**；删除有订单的商品被 FK RESTRICT 拒绝；事件表 UPDATE/DELETE 被触发器拒绝；`source_type='crm_order'` 被 CHECK 拒绝 |
| D1–D7 | 0009 就地升级 | journal 恰 10 条；0000–0008 库无 `local_*` 表、已有 5 张 `crm_*`；升级后旧行（社区/居民/运营/归属）保留、三张本地表出现、**升级后立即可经真实 HTTP 建品下单**（1200×2=2400） |
| H1–H10 | 边界 | 非 UUID 订单/商品 id → 404（非 500）；`pageSize` 超上限 → 400；公开目录即使 `?status=off_shelf` 也不泄漏下架品，而后台仍能列出下架品（工作台不会「丢商品」）；未知路由仍返回标准错误信封；状态接口无法直接造 `verified`（400）；居民无法把 `status` 塞进登记体（400） |
| I1–I5 | 活动归属与分页 | 跨社区活动作为归属 → 400；不存在的活动 → 404；同社区活动被冻结在订单上；居民状态过滤不越界；分页信封 `total` 稳定 |
| J1–J5 | LIKE 转义 | 字面 `%`、`_` 被正确转义（`A_B` 不会误匹配 `AXB`）；分类过滤；后台关键字搜索限定社区；订单关键字匹配**冻结的商品名快照**而非当前商品名 |
| K1–K8 | 乐观锁竞争 | 见上表 B9 |
| P1–P14 | 真进程 + 真网络 | 真 `src/index.ts` 启动、CSRF double-submit 登录、建品上架、下单、处理、核验，**杀进程后第二个进程**读到同一订单/快照/核验记录/时间线，幂等键在新进程上重放为同单；`db:generate` 复核 schema 与迁移无漂移 |

> 说明：Windows 上 `child.kill('SIGTERM')` 表现为 TerminateProcess（`code:null signal:'SIGTERM'`），
> 无法远程验证 `process.on('SIGTERM')` 里的优雅关闭分支。P6/P13 如实记录这一点，没有伪称「优雅退出已验证」。
> 由于是硬终止，P7 起的「第二个进程读到一致数据」反而更能说明 SQLite 文件本身没有半写状态。

---

## 4. 8 例 rewards EPERM：基线对照证据（未修复，不声称修复）

| 运行 | tests | pass | fail |
| --- | --- | --- | --- |
| 干净基线 `origin/dev@ae8441a`（`E:\tomz\local-life-wt\baseline-eprem`） | 223 | 215 | **8** |
| R1 干净 worktree（`E:\tomz\local-life-wt\r1-verify` @ `007f433`） | 240 | 232 | **8** |

失败用例名集合**完全一致**（`identicalFailureSet=true`，`onlyInFirst=[]`，`onlyInSecond=[]`），
全部为 `Error: EPERM, Permission denied: ...\Temp\ll-version-edit-* | ll-0006-plan-*`，`syscall:'rm'`：
根因是 `apps/api/test/rewards-data.test.ts:342` 与 `apps/api/test/rewards-version-edit.test.ts:161` 在 `sqlite.close()` 之前就 `rmSync` 临时目录（Windows 文件句柄未释放）。
新增的 17 个 R1 用例全部通过（240−223=17）。**未修改任何测试来「修复」它，也不声称已修复。**

完整对照见 [`baseline-eprem.md`](./baseline-eprem.md)。

---

## 5. 非阻断观察（仅裸 SQL 可达，API 无法达成）

这三条是我在读代码时怀疑、并用探针脚本实际验证出来的，**不影响本任务的通过判定**，但值得记录成后续卡片。

### O1（低）`status='verified'` 与核验字段之间没有磁盘约束

- 现象：裸 SQL 可以插入 `status='verified'` 而 `verified_at / verified_by_user_id / verification_note` 全为 NULL（`0009_local_catalog_orders.sql:79-82` 只有 quantity/total/status/record_source 四条 CHECK）。取证：`.evidence/t10-gap-probes.log` 的 `G3`。
- 后果（已实测）：这样的行被 `GET /admin/local-orders` 列出（200，`status: verified`），但 `GET /admin/local-orders/:id` 返回 **500 `internal_error`**——因为 `localOrderDetailSchema` 的 `superRefine`（`packages/contracts/src/index.ts:1467-1482`）要求「verified 必须有 verification」，而 `toDetail`（`apps/api/src/local/orders.ts:271-290`）在 `verifiedAt` 为 NULL 时给 `verification: null`，`parse` 抛 ZodError，被 `app.ts:1024` 的 `onError` 兜成 500。取证：`.evidence/t10-corrupt-row-probe.log`（`DETAIL status: 500` / `LIST status: 200`）。
- 可达性：**API 无法产生**（核验只有 `verifyOrder` 一条路径且同事务写 verified_at/note；契约强制 `verified` 只能经核验进入）。需要裸 SQL 或未来的数据迁移事故。
- 建议（不阻断）：给 `local_orders` 补一条 CHECK，例如 `status <> 'verified' OR (verified_at IS NOT NULL AND verification_note IS NOT NULL)`；或在 `toDetail` 里对「verified 但缺字段」返回 409/数据异常码而不是抛 ZodError，避免 500 与列表 200 的不一致。

### O2（低）`local_orders.community_id` 与 `local_products.community_id` 之间没有复合外键

- 现象：`local_orders.community_id` 只 FK 到 `communities`（`:72`），没有任何约束阻止「订单的社区 ≠ 商品的社区」。裸 SQL 可把订单改到另一个社区（已实测可行，`.evidence/t10-gap-probes.log` 的 `G5`）。
- 可达性：**API 无法产生**（`registerOrder` 一律用 `product.communityId`，见 `apps/api/src/local/orders.ts:453`）。
- 建议（不阻断）：若要磁盘级保证，可加 `FOREIGN KEY (product_id, community_id) REFERENCES local_products(id, community_id)`（需给 `local_products` 加对应唯一键）或加触发器。

### O3（范围，需产品确认，非缺陷）居民没有自助取消入口

- R1 的契约里 `LOCAL_ORDER_STATUS_TRANSITIONS.registered = ['processing','cancelled','rejected']`，但 `cancelled` 只能由 `/staff|/admin/local-orders/:id/status` 触发；`/local-orders` 只有 `GET/POST`，没有 PATCH。
- 因此「居民自己取消」在 R1 里**不存在**，只能由工作人员代操作。R2 的在做页面也据此做成只读（`apps/web/src/pages/MyOrderDetailPage.tsx:161` 注释「the contract has no resident cancel or edit route」），两边一致，说明这是有意的范围裁剪而非遗漏。
- 本任务把「取消」按「staff 取消 + 终态不可回退」验证并通过（B28–B30）。**若 Issue #109 要求居民能自行取消**，这是 R1 的范围缺口而不是缺陷——需要产品确认后另行补 `/local-orders/:id/cancel` 或允许居民 PATCH 自己的 `registered → cancelled`。本机无 `gh`，无法核对 Issue 原文，故只能标为待确认。

---

## 6. 返修清单

**阻断项：无。** 因此 verdict = pass。

以下为可选改进（若采纳，请按「文件 + 行号 + 期望」执行；它们都不属于本卡阻塞条件）：

| 编号 | 文件:行 | 期望 | 级别 |
| --- | --- | --- | --- |
| O1 | `apps/api/db/migrations/0009_local_catalog_orders.sql:79-82` | 增加 `CONSTRAINT local_orders_verified_check CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND verification_note IS NOT NULL))`，并补一条 `apps/api/test/local-catalog-orders.test.ts` 里裸 SQL 拒绝的用例（可仿照 `:1378-1389` 的写法） | 低 |
| O1' | 或 `apps/api/src/local/orders.ts:271-290` | 若不想再改迁移：`toDetail` 在 `status==='verified' && !verifiedAt` 时抛 `LocalError(409, conflict, '订单核验数据异常，请联系运营')`，避免 500 与列表 200 自相矛盾 | 低 |
| O2 | `apps/api/db/migrations/0009_local_catalog_orders.sql:72` | 增加 `(product_id, community_id)` 复合外键或在 `products` 表上加 `UNIQUE(id, community_id)` 后引用 | 低 |
| O3 | 契约与路由 | 若 Issue #109 要求居民自助取消：新增 `LOCAL_ORDER_ROUTES.myOrderCancel = '/local-orders/:localOrderId/cancel'`，只允许 `resident_user_id = session.userId` 且 `registered → cancelled`，写 `order.status_changed` 事件与 `local_order.cancelled` 审计；否则在文档中显式记录「居民取消由工作人员代操作」 | 待确认 |

---

## 7. 验证盲区（必须明确写出，不得读作通过）

1. **浏览器/H5/管理台交互不在本卡范围**（已推迟到 t5 轻量档）。R1 的所有结论都来自 HTTP 层与 SQLite，**不能**推出「页面可用」。
2. **CI（Linux）未复核**：lint / typecheck / 测试 / EPERM 对照全部只在本机 Windows 跑过；Linux 上 8 例 EPERM 是否出现**未验证**。
3. **进程内 + 真进程两种重启都只覆盖单机单文件**：没有测多进程同时写同一文件的 WAL 争用、没有测超过 `busy_timeout=5000` 的长时间锁、没有断电/强制 kill -9 后的 WAL 恢复。P6/P13 是 Windows TerminateProcess，**优雅关闭分支未被验证**。
4. **并发规模有限**：HTTP 并发 10 路、进程并发 5 路、乐观锁竞争 2 路。更高并发、更长压力、内存/句柄泄漏均未测。
5. **CRMEB / 微信 / 短信等既有域未回归**：只跑了仓库既有测试套件（8 例基线失败除外），没有对既有 domain 做额外的手工端到端。
6. **无性能测试**：未测大目录（>100 商品）、大订单量（>1 万）下的列表/搜索耗时；`keyword` 走 `LIKE %...%` 无索引。
7. **无安全专项**：未做速率限制、XSS/SQL 注入的模糊测试；只验证了 CSRF double-submit、Origin 白名单、strict body、权限与社区裁剪这些设计内控制。
8. **契约层假设**：本卡的验收面来自 t3/t5 契约与 `recon.md`，**Issue #109 原文不可得**（本机无 `gh`），若原文另有条款（尤其 O3 的居民取消），需另行补验。

---

## 8. 证据清单与现场清理

提交进仓库的（本目录）：

| 文件 | 内容 |
| --- | --- |
| `verification-api.md` | 本报告 |
| `r1-verify-results.json` | 129 项独立端到端结果（含每项 name / ok / detail） |
| `r1-process-restart-results.json` | 14 项真进程重启结果 |
| `baseline-eprem.md` | 8 例 EPERM 的基线对照（t9 产出，本卡复用并复核） |

留在 `.evidence/`（已排除，**不进仓库**）：`r1-verify.mts`、`r1-process-restart.mts`、`r1-gap-probes.mts`、`r1-corrupt-row-probe.mts` 及全部 `t10-*.log`。
`r1-verify.mts` / `r1-process-restart.mts` 每次运行都以 `close → rmSync` 顺序清理临时库，末项（G1 / P14 / C15 / D7 / F5）专门断言「没有 EPERM」。

现场清理：早期两次进程探针失败时留下的 `%TEMP%\ll-r1-proc-AUmE2Z`、`%TEMP%\ll-r1-proc-ViJO8P`（各含一个 `proc.sqlite` + WAL）已在本次收尾时删除；当前 `%TEMP%` 下无 `ll-r1-*` 残留。

**不属于我的改动**（提请注意，不代为处理）：`mvp-010` 工作区里除了 R2 的正式改动，还有两个未跟踪的调试脚本 `apps/api/dbcheck.cjs`、`apps/api/src/scripts/seed-local-verification.ts`。它们不是 R1/R2 交付物的一部分，提交前应删除或明确其用途，避免混入 PR。
