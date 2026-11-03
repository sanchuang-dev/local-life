# LL-MVP-003 活动运营后台 · QA 独立验收证据

- 任务：t6 QA 独立验收（#59 LL-MVP-003 真实活动运营后台）
- 分支：`feat/ll-mvp-003-activity-operations`（基线 `dev@59729c9`）
- 验收人：qa（独立于实现者；未修改任何业务实现文件）
- 验收时间：2026-11-04（Asia/Shanghai）

本目录只存放 QA 证据：真实 HTTP 负例结果、真实 Chrome 截图与运行记录、README。测试代码在仓库内 `apps/api/test/activities.test.ts`、`apps/admin/src/pages/ActivitiesPage.test.tsx`、`apps/admin/src/app/shell/navigation.test.ts`；临时验收脚本按任务要求放在仓库外 `D:\ll-scratch-003`、`D:\ll-evidence-tools-003`，不提交。

---

## 1. 环境与版本

| 项目 | 实测值 |
| --- | --- |
| 操作系统 | Windows（本机开发机） |
| Node | **v24.9.0**（`node -v`） |
| pnpm | **10.19.0**（`pnpm -v`） |
| CI 运行时 | **Node 22**（GitHub Actions 矩阵；本证据未在本机切换 Node 22 复跑，差异见「已知问题」） |
| 浏览器 | **Google Chrome 156.0.8078.79**（`C:\Program Files\Google\Chrome\Application\chrome.exe`，真实 Chrome，非 jsdom） |
| 浏览器驱动 | puppeteer-core 24.43.1（仓库外 `D:\ll-evidence-tools-003`） |
| 数据库 | SQLite 文件 `apps/api/.data` 之外的 `.data/local-life-dev.sqlite`（gitignored，真实文件，非 `:memory:`） |
| 依赖安装 | `pnpm install --frozen-lockfile` 退出码 0（lockfile 未变；better-sqlite3 预编译二进制可用） |

隔离说明：

- 本机 5173 端口被其他进程占用（共享工作机上的另一个 Vite），本验收使用独立端口 **API 4081 / H5 5273 / Admin 5274**，通过仓库外环境文件 `D:\ll-scratch-003\qa-dev.env` 提供真实 API 配置；Vite 的 `/api` 同源代理与 `TRUSTED_ORIGINS` 仍走真实配置，不是 Mock/假鉴权。
- 管理员账号 `qa.activity.admin` 由仓库外脚本 `D:\ll-scratch-003\seed-admin.mjs` 使用仓库真实 `hashPassword`（scrypt，与业务一致）写入真实 SQLite，再经真实 `POST /api/auth/login` 登录；没有后门、固定会话或跳过认证。
- 未使用 `D:\local-life-mvp`，未修改全局环境变量。

---

## 2. 命令与结果（真实执行）

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile` | 0 | `Lockfile is up to date` / `Already up to date` |
| 2 | `pnpm check` | 0 | oxlint `Found 9 warnings and 0 errors.`（5 条为基线既有告警；4 条为 t11 从 `ActivitiesPage.tsx` 导出上海墙钟时间 helper 供测试使用触发的 `react-refresh/only-export-components`（仅影响 React fast-refresh 提示，非运行时缺陷、非门禁 error））；typecheck 全通过；admin vitest `Test Files 8 passed (8)` / `Tests 61 passed (61)`；API `ℹ tests 19 ℹ pass 19 ℹ fail 0`；local-dev `ℹ tests 7 ℹ pass 7 ℹ fail 0`；contracts/api/web/admin build 全部 `Done` |
| 3 | `pnpm --filter @sanchuang-dev/local-life-api db:prepare` | 0 | 真实 SQLite 迁移 13 张表 |
| 4 | `node --import tsx D:\ll-scratch-003\seed-admin.mjs`（cwd `apps/api`） | 0 | 真实 `hashPassword` 播种管理员 |
| 5 | 真实栈启动（API 4081 / H5 5273 / Admin 5274） | — | `GET /healthz` → 200；`http://localhost:5274/` → 200；`http://localhost:5273/local-life/` → 200 |
| 6 | `node D:\ll-scratch-003\qa-http-negative2.mjs` | 0 | **37/37 真实 HTTP 断言通过**，结果写入 `http-negative-checks.json` |
| 7 | `node D:\ll-evidence-tools-003\qa-003\run.mjs` | 0 | **23/23 真实 Chrome 断言通过**，31 条 `/api` 响应记录，写入 `browser-run.json` |

### 2.1 测试可移植性修复（与 #59 业务无关，必须单独标注）

基线 `pnpm check` 在 Windows 上失败于 `scripts/local-dev.test.mjs:27`：断言写死 POSIX 后缀 `/.data/local-life-dev.sqlite`，而 `join()` 在 Windows 产出反斜杠。修复方式为**只归一化路径分隔符后比较**，断言强度不变（仍要求数据库位于 `<workspace>/.data/`，且 env 模板、`assertLocalConfig` 断言原样保留）；未删除、未跳过、未弱化该测试：

```js
assert.ok(prepared.dbPath.replaceAll('\\', '/').endsWith('/.data/local-life-dev.sqlite'))
```

修复后 `local-dev` 7 个测试全通过（见 `pnpm check` 输出）。

---

## 3. 自动化测试覆盖

### 3.1 API/DB：`apps/api/test/activities.test.ts`（新增，10 个测试，全通过）

| 测试 | 覆盖的验收点 |
| --- | --- |
| activity data persists across a real file reopen and the public detail is byte-identical | 临时文件 SQLite（非 `:memory:`）关闭连接后重新 `createDatabase/createApp`，公共详情逐字节一致；会话仍有效 |
| a pre-activity database upgrades in place and keeps existing community rows | 既有 0000 库可用 0001 迁移就地升级，历史社区行保留，可创建活动 |
| lifecycle state machine locks illegal transitions and hides drafts from the public API | draft 公共详情 404、列表隐藏；publish/pause/resume/end 合法流转；全部非法流转 409；ended 不可编辑/发布 |
| publish freezes v1 and published rule changes append v2 without rewriting history | publish 生成 v1；关键规则变更生成 v2；v1 快照深度相等不变；仅标题变化/同规则不生成新版本 |
| stale optimistic tokens return 409 and repeated rule changes never duplicate a version | 过期 `expectedUpdatedAt` → 409；`Promise.all` 并发状态 `[200,409]`；版本号 `[3,2,1]` 唯一；重复 INSERT 触发 `UNIQUE constraint failed` |
| authentication, CSRF, grid-worker lockout and cross-community scope are enforced | 未认证 401；无 CSRF 403；grid_worker 全部 403；operator 仅本社区可读写、跨社区 403；admin 跨社区 201；公共接口免登录 200 |
| public payloads never leak budgets, caps, creator identity or audit data | 公共列表/详情精确 key 集合；`budgetCapCents`/`prizeQuantityCap`/`createdByUserId`/`currentRuleVersionId`/`audit`/`metadata`/预算数值全部不出现；草稿 404 |
| every lifecycle write is auditable, tracked by target and free of budget figures | create/update/publish/pause/resume/end/rule_version.created 均落审计；`target_id` 范围正确；metadata 仅 status/version，无预算数值；`?limit=2`、`limit=0` → 400 |
| admin list filters and paginates on the server | 关键词/社区/状态筛选与分页由服务端返回；非法状态 400 |
| activities are never hard-deleted by the domain and the trigger protects snapshots on disk | 无 DELETE 路由（404）；真实 SQL `UPDATE`/`DELETE activity_rule_versions` 被 SQLite 触发器以 `/immutable/` 拒绝；publish 只写 1 条版本行 |

### 3.2 Admin：`apps/admin/src/pages/ActivitiesPage.test.tsx`（新增，11 个测试，全通过）

其中 7 条为 t6 原始验收用例（未修改断言）；t11 修复 round 2 追加 4 条回归用例：详情加载中关闭→新建无残留 spinner（deferred detail + 迟到 resolve）、提交/回填按 Asia/Shanghai 墙钟（含 `TZ=America/New_York` 下运行 11/11）、`Timeline` 无 `items.children` 弃用告警。既有 7 条断言未被修改（t12 独立审查确认）。

覆盖：真实列表行/状态/规则版本 + 服务端分页参数；真实 403 错误态（不伪造空成功）；operator 社区范围与默认社区；grid_worker 锁定页且零请求；发布二次确认文案 + 真实 CSRF 头 + `expectedUpdatedAt` 请求体 + 列表刷新；规则版本只读（无编辑/删除）；审计时间线（事件/操作者/元数据）。

`apps/admin/src/app/shell/navigation.test.ts`（新增 `activity console navigation` 用例组）：`/activities` 为 ready、`/activities/checkin` 仍 planned、roles 为 `admin/operator`、grid_worker 不可见、`filterNavigation` 不泄漏入口。整文件 13 tests 通过。

---

## 4. 真实 HTTP 负例（37/37 通过）

对真实运行中的 API（`http://127.0.0.1:4081`，真实 Hono + SQLite + 真实会话 Cookie/CSRF）发真实请求；Origin 为真实管理台 `http://localhost:5274`。完整响应片段见 [`http-negative-checks.json`](./http-negative-checks.json)（`totalChecks: 37, failures: 0`）。

| 检查 | 期望 | 实测 | 响应片段/备注 |
| --- | --- | --- | --- |
| operator creates activity in assigned community | 201 | 201 |  |
| operator publishes activity in assigned community | 200 | 200 |  |
| operator creates a second draft in assigned community | 201 | 201 |  |
| admin creates a draft in the other community | 201 | 201 |  |
| unauthenticated GET /admin/activities | 401 | 401 | `unauthorized` |
| unauthenticated POST /admin/activities | 401 | 401 | `unauthorized` |
| unauthenticated PATCH /admin/activities/:id | 401 | 401 | `unauthorized` |
| authenticated create without CSRF header | 403 | 403 | `forbidden` |
| valid CSRF with untrusted Origin | 403 | 403 | `forbidden` |
| grid_worker GET /admin/activities | 403 | 403 | `forbidden` |
| grid_worker GET /admin/activities/:id | 403 | 403 | `forbidden` |
| grid_worker POST /admin/activities | 403 | 403 | `forbidden` |
| grid_worker POST pause | 403 | 403 | `forbidden` |
| grid_worker GET audit | 403 | 403 | `forbidden` |
| grid_worker GET rule-versions | 403 | 403 | `forbidden` |
| operator list contains no other community | 200 | 200 | 2 rows，全部属于本社区 |
| operator filters by foreign community -> zero rows | 200 | 200 | `total=0` |
| operator reads other community activity | 403 | 403 | `forbidden` |
| operator patches other community activity | 403 | 403 | `forbidden` |
| operator publishes other community activity | 403 | 403 | `forbidden` |
| operator creates in other community | 403 | 403 | `forbidden` |
| admin reads other community activity | 200 | 200 | `QA 越权社区` |
| operator updates published activity with fresh token | 200 | 200 |  |
| stale expectedUpdatedAt replay | 409 | 409 | `conflict` |
| anonymous GET /activities/public | 200 | 200 | 1 items（仅已发布） |
| anonymous GET public detail of published activity | 200 | 200 |  |
| anonymous GET public detail of draft | 404 | 404 | `not_found` |
| anonymous GET public detail of draft in B | 404 | 404 | `not_found` |
| public list hides internal fields | 200 | 200 | `none leaked` |
| public detail hides internal fields | 200 | 200 | `none leaked` |
| public list excludes drafts | 200 | 200 |  |
| public detail key set | 200 | 200 | `community,description,endsAt,id,location,…`（无 audit/metadata） |
| operator reads rule versions | 200 | 200 | `v1` |
| PATCH rule-versions is not routed | 404 | 404 | 无更新版本能力 |
| operator reads audit trail | 200 | 200 | `activity.updated,activity.rule_version.created,…` |
| audit metadata has no budget value | 200 | 200 | `[{"status":"published"},{"version":"1"}]…` |
| DELETE /admin/activities/:id is not routed | 404 | 404 | 无硬删除能力 |

---

## 5. 真实 Chrome 全链路（23/23 通过）

- 活动标题：`QA 浏览器验收·银龄欢乐季 1709`（后缀为运行时刻，保证唯一）
- 活动 ID：`94dbbadd-9116-4e5f-a185-76a31f0d47d9`
- H5 深链：`http://localhost:5273/local-life/#/community/activity/silver-neighborhood?activityId=94dbbadd-9116-4e5f-a185-76a31f0d47d9`
- 真实数据：社区「QA 验收社区」、地点「QA 验收社区党群服务中心」、时间 2026-12-01 10:00–18:00（Asia/Shanghai）、预算 ¥7777.77、奖品上限 66、4 项公开规则；发布后把「签到 / 参与方式」改为「现场签到并领取 QA 浏览器验收参与卡」生成 v2。

操作链与断言（逐步真实点击/键盘输入，非脚本注入状态）：

1. 管理员经真实 `POST /api/auth/login`（真实 CSRF）登录，进入 `/#/activities`，列表渲染真实行。
2. 新建活动 Drawer：真实日期范围控件输入并提交，创建 `POST /api/admin/activities` → **201**；列表行显示「草稿 / 未冻结」。
3. 点击行内「发布」→ 二次确认弹窗显示「发布后规则将冻结为 v1，居民端将读取该活动。」→ `POST …/publish` → **200**；列表行显示「已发布 / v1」。
4. 编辑已发布活动并修改关键规则 → 二次确认「保存将生成新规则版本 v2」→ `PATCH …/activities/:id` → **200**，响应 `ruleVersion=2`；列表显示 v2。
5. 规则版本 Drawer：v2 卡显示新签到规则，**v1 卡仍可查看且保留旧文案「现场签到领取参与卡」**（快照未被覆盖）。
6. 审计 Drawer：显示创建活动草稿 / 发布活动 / 生成规则版本等事件，操作者为「QA 验收管理员」，metadata 为 `{"version":"2"}` 等，无预算数值。
7. H5 375×812 打开深链：标题、社区、地点、`规则第 2 版` 与「活动即将开始」均来自同一已发布活动；打开「活动规则」sheet：`第 2 版` + 新签到规则，旧 v1 文案不再出现。
8. 管理台「暂停」→ `POST …/pause` **200** → H5 真实刷新后显示「活动已暂停」+「活动已暂停，等待恢复通知」。
9. 「恢复」→ **200** → H5 刷新后回到「活动即将开始」。
10. 「结束」→ **200** → H5 刷新后显示「活动已结束」+「本期活动已结束」。
11. 连续两次刷新 H5，正文（去除倒计时数字）完全一致；重新进入深链仍是同一已结束活动（刷新/重进一致性）。
12. 320 宽（640×1400 @2x）复测：无横向溢出（`overflow=0px`），活动规则 sheet 正常打开。
13. 管理台缩到 375 宽仍能渲染列表（响应式 sanity，管理台本身面向桌面）。

关键请求真实状态码（`browser-run.json.network`，31 条，全部 2xx）：

| 请求 | 状态码 | 次数 |
| --- | --- | --- |
| `GET /api/auth/session` | 200 | 4 |
| `GET /api/auth/csrf` | 200 | 1 |
| `POST /api/auth/login` | 200 | 1 |
| `GET /api/admin/communities` | 200 | 2 |
| `GET /api/admin/activities` | 200 | 8 |
| `POST /api/admin/activities` | **201** | 1 |
| `GET /api/admin/activities/:id` | 200 | 1 |
| `PATCH /api/admin/activities/:id` | 200 | 1 |
| `POST /api/admin/activities/:id/publish` | 200 | 1 |
| `POST /api/admin/activities/:id/pause` | 200 | 1 |
| `POST /api/admin/activities/:id/resume` | 200 | 1 |
| `POST /api/admin/activities/:id/end` | 200 | 1 |
| `GET /api/admin/activities/:id/rule-versions` | 200 | 1 |
| `GET /api/admin/activities/:id/audit` | 200 | 1 |
| `GET /api/activities/public/:id` | 200 | 6（每次 H5 刷新/重进都重新读取） |

页面异常：`pageErrors: 0`。t6 运行时（t11 修复前）控制台有 3 条 Ant Design 开发期告警：`Spin tip` ×2 与 `Timeline items.children` ×1；t11 修掉 `Timeline` 用法后，真实 Chrome 复跑已无 `items.children` 告警（见 §5.1），仅剩 `Spin tip` 弃用提示。

---

### 5.1 t11 修复后的真实 Chrome 复核（11/11 通过）

t6 证据覆盖原始实现（创建→发布→v2→H5→暂停/恢复/结束→刷新一致→版本/审计）；t11 修复 round 2 改动了管理台编辑器的 loading 竞态、时区显示与 `Timeline` 用法，因此集成前单独用真实 Chrome 156 复跑修复后的关键路径。运行记录：[`t11-browser-run.json`](./t11-browser-run.json)；截图：`browser/t11-01-create-after-close.png`、`t11-02-edit-asia-shanghai.png`、`t11-03-audit-timeline.png`。

复跑条件：真实 Chrome 156.0.8078.79、真实管理台 5274、真实 API 4081 + 真实 SQLite；用 CDP 网络拦截把活动详情 GET 延迟 1800ms，确保「加载中关闭」是真实竞态而不是快请求；浏览器时区通过 `page.emulateTimezone('America/New_York')` 强制设为纽约，验证界面仍按上海墙钟显示。

| 检查 | 结果 |
| --- | --- |
| 编辑详情期间出现真实 loading（延迟请求） | 通过 |
| 加载中关闭 Drawer 后立即点「新建活动」，表单可用 | 通过（标题 `新建活动草稿`，标题输入框存在） |
| 迟到的详情响应返回后，新建 Drawer 不再出现 spinner | 通过（3.6s 轮询无 spinner） |
| 时间字段标签显示 `Asia/Shanghai，UTC+08:00` | 通过 |
| 浏览器 TZ=America/New_York 时，picker 仍显示上海墙钟 `2026-10-05 10:00` / `18:00` | 通过 |
| 审计 Drawer 渲染真实 Timeline（4 个事件） | 通过 |
| 控制台无 `Timeline items.children` 弃用告警 | 通过 |
| 页面无 `pageerror` | 通过（0） |
| 两次真实详情 GET 均 200 | 通过 |

t11 修复前的 t6 截图/记录保持原样，不作为 t11 行为的验证；t11 的 jsdom 回归（含 `TZ=America/New_York` 全文件 11/11）与本次真实 Chrome 复核共同覆盖修复后行为。

---

## 6. 截图清单（`browser/`）

| 文件 | 视口 | 内容 |
| --- | --- | --- |
| `01-admin-login.png` | 1440×900 | 管理台真实登录页（未认证） |
| `02-admin-list.png` | 1440×900 | 登录后的活动列表（真实数据） |
| `03-admin-created-draft.png` | 1440×900 | 新建活动保存成功，列表出现「草稿 / 未冻结」行 |
| `04-admin-publish-confirm.png` | 1440×900 | 发布二次确认（「发布后规则将冻结为 v1…」） |
| `05-admin-published-v1.png` | 1440×900 | 发布成功，行为「已发布 / v1」 |
| `06-admin-rule-version-confirm.png` | 1440×900 | 修改已发布规则的「生成 v2 并保存」确认 |
| `07-admin-v2.png` | 1440×900 | 保存成功，列表规则版本变为 v2 |
| `08-admin-rule-versions.png` | 1440×900 | 规则版本 Drawer：v2 与只读 v1 快照 |
| `09-admin-audit.png` | 1440×900 | 操作审计 Drawer（事件/操作者/metadata） |
| `10-h5-upcoming-375.png` | 750×1624（375×812 @2x） | H5 深链：真实标题/社区/地点/时间、`规则第 2 版`、活动即将开始 |
| `12-h5-rules-375.png` | 750×1624 | H5 活动规则 sheet：第 2 版 + 新签到规则 |
| `13-h5-paused-375.png` | 750×1624 | H5 刷新后：活动已暂停 |
| `14-h5-resumed-375.png` | 750×1624 | H5 刷新后：恢复为活动即将开始 |
| `15-h5-ended-375.png` | 750×1624 | H5 刷新后：活动已结束 / 本期活动已结束 |
| `16-h5-ended-320.png` | 640×1400（320×700 @2x） | 320 宽已结束态，无横向溢出 |
| `17-h5-rules-320.png` | 640×1400 | 320 宽活动规则 sheet |
| `18-admin-list-375.png` | 750×1624 | 管理台 375 宽响应式 sanity |
| `t11-01-create-after-close.png` | 1440×900 | t11 复核：加载中关闭编辑后新建 Drawer 可用、无残留 spinner |
| `t11-02-edit-asia-shanghai.png` | 1440×900 | t11 复核：编辑表单时间按 Asia/Shanghai（UTC+08:00）显示，浏览器时区为纽约 |
| `t11-03-audit-timeline.png` | 1440×900 | t11 复核：审计 Timeline 正常渲染，console 无 `items.children` 告警 |

`01`–`18` 为 t6 在原始实现上的证据；`t11-*` 为 t11 修复后的真实 Chrome 复核证据（§5.1）。两组均为真实 Chrome 无头模式渲染、真实 API 数据；未使用假 API、Mock 数据或 jsdom 截图。

---

## 7. 已知问题与限制

1. **Node 版本差异**：本机实测 Node **v24.9.0** / pnpm **10.19.0**，CI 为 **Node 22**。本证据未在本机切换 Node 22 复跑，CI 结果由流水线独立给出；两者 Node 大版本不同属于环境差异，不是 #59 代码缺陷。
2. **`pnpm dev:local` 在 Windows + Node 24 下无法启动**（基线工具问题，与 #59 无关）：`node scripts/local-dev.mjs setup` 写入 `.env.local` 后报 `spawnSync pnpm.cmd EINVAL`（Node 对 `.cmd` 直接 spawn 的限制）。本验收改用等价的真实进程启动（`pnpm --filter … dev` + 仓库外 env 文件），仍是真实 API/H5/Admin，不是 Mock。
3. **端口占用**：共享开发机上 5173 已被其他进程占用，本验收使用 4081/5273/5274 隔离端口；不修改仓库内任何共享端口定义，也不影响默认端口行为。
4. **视口为桌面 Chrome 模拟**：375×812 与 320×700 为 Chrome 设备模拟（@2x），不是真机、也不是微信 WebView；未验证微信内置浏览器差异与真机安全区。
5. **Ant Design 开发期告警（非阻塞）**：`Timeline items.children` 已由 t11 修复，并经真实 Chrome 复核无该告警（§5.1）；`Spin` 的 `tip` 仍为弃用提示（t6 记录 3 条告警中的 2 条），仅控制台提示，`pageErrors: 0`，建议后续改用 `description`。
6. **oxlint 9 warnings / 0 errors**：5 条为基线既有告警；4 条为 t11 从 `ActivitiesPage.tsx` 导出上海墙钟时间 helper（`shanghaiFieldsToIso`/`isoToShanghai`/`keyRulesFromForm`/`toFormValues`）供测试使用引发的 `react-refresh/only-export-components`；只影响 fast-refresh 提示，不改变 lint 门禁 0 error 的结论。
7. **构建体积告警**：admin 单 chunk 约 1.46 MB、web 约 580 kB（Vite 500 kB 阈值），非本次验收门禁项。
8. **证据脚本为仓库外临时脚本**：`D:\ll-scratch-003\seed-admin.mjs`、`qa-http-negative2.mjs`、`D:\ll-evidence-tools-003\qa-003\run.mjs` 均不提交；它们只负责驱动真实接口/浏览器并落盘证据。
9. **管理台 375 宽仅为 sanity**：管理台是桌面运营工具，移动端优先要求针对 H5；本项只确认窄屏不崩坏，不作为移动端验收结论。

---

## 8. 边界声明

- 未创建 PR、未合并/关闭 Issue、未部署。
- 未修改业务实现文件（`apps/api/src`、`apps/api/db`、`packages/contracts/src`、`apps/admin/src` 非测试源、`apps/web/src`）；改动仅限测试文件、`scripts/local-dev.test.mjs` 的跨平台断言修复与本证据目录。
- 未使用 `D:\local-life-mvp`；未用 Mock/假 API 冒充真实；所有状态码、截图、审计与规则版本均来自真实 SQLite + 真实 HTTP + 真实 Chrome。
