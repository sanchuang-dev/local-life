# LL-MVP-005 网格员轻量 CRM · QA 独立端到端验收证据

- 任务：t5 独立验证（Issue #61 LL-MVP-005 网格员轻量 CRM）
- 分支：`feat/ll-mvp-005-grid-crm`（基线 `origin/dev@1d4f000`）
- 验收人：`verifier`（独立于实现者；未修改 `apps/**`、`packages/**`、`scripts/**`、测试或 `pnpm-lock.yaml`）
- 验收时间：2026-11-04（Asia/Shanghai）
- 结论：**PASS**；未发现 blocker/high 安全问题或业务状态机缺陷。已知残余风险见 §10。

本目录只存放 QA 证据：真实 HTTP 负例原始 JSON、真实 Chrome 截图与运行记录、SQLite 查询结果、构建/测试日志与复现说明。所有临时脚本均在仓库外 `/tmp/ll-mvp-005-qa/` 与 `/tmp/ll-browser/`，不提交、不写入仓库依赖或 lockfile。

---

## 1. 环境、隔离与真实栈

| 项目 | 实测值 |
| --- | --- |
| 操作系统 | macOS（本机开发机） |
| Node | `v22.23.2` |
| pnpm | `10.19.0` |
| 浏览器 | **Google Chrome 156.0.8078.80**（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，真实 Chrome，非 jsdom） |
| 浏览器驱动 | puppeteer-core **25.16.0**（仓库外 `/tmp/ll-browser/node_modules`） |
| 数据库 | SQLite **文件库** `/tmp/ll-mvp-005-qa/db/t5-e2e.sqlite`（非 `:memory:`；服务启动真实执行迁移） |
| API | 真实 Hono 进程，`http://127.0.0.1:4094`；`GET /healthz` → 200 |
| H5 | Vite dev，`http://localhost:5273/local-life/` → 200；HashRouter |
| Admin | Vite dev，`http://localhost:5274/` → 200；HashRouter |
| 代理 | 两端 `/api` 均真实代理到 4094（`curl http://localhost:5274/api/healthz` → 200） |
| 隔离 | 4094/5273/5274 为本轮独立端口；4081 被本机既有进程占用，未使用、未终止 |

启动命令（均在仓库根执行，环境变量来自仓库外终端；未创建/修改 `.env.local`）：

```bash
# API（真实文件库 + 真实可信 Origin）
cd apps/api
NODE_ENV=test HOST=127.0.0.1 PORT=4094 \
DATABASE_PATH=/tmp/ll-mvp-005-qa/db/t5-e2e.sqlite \
TRUSTED_ORIGINS='http://localhost:5273,http://127.0.0.1:5273,http://localhost:5274,http://127.0.0.1:5274' \
WEB_BASE_URL='http://localhost:5273/local-life/' AUTH_DEV_ENABLED=true \
node --import tsx src/index.ts

# H5 / Admin（真实 Vite，LOCAL_LIFE_* 由 scripts/local-ports.mjs 读取）
LOCAL_LIFE_API_PORT=4094 LOCAL_LIFE_WEB_PORT=5273 LOCAL_LIFE_ADMIN_PORT=5274 \
  pnpm --filter @sanchuang-dev/local-life-web dev
LOCAL_LIFE_API_PORT=4094 LOCAL_LIFE_WEB_PORT=5273 LOCAL_LIFE_ADMIN_PORT=5274 \
  pnpm --filter @sanchuang-dev/local-life-admin dev
```

---

## 2. 账号创建：真实登录，无后门

1. **管理员引导**：仓库外脚本 `/tmp/ll-mvp-005-qa/seed-admin.mjs` 直接调用仓库真实 `hashPassword`（scrypt，与业务一致）写入真实 SQLite，账号 `qa.admin`；密码通过环境变量 `QA_ADMIN_PASSWORD` 提供，**未写入仓库**。
2. **社区与员工**：`t5-fixtures.mjs` 使用管理员真实登录后的会话，调用真实 `POST /admin/communities`、`POST /admin/staff` 创建：
   - 社区：`QA浏览器社区-evidence`
   - 运营员：`qa.t5.operator.op.evidence`
   - 网格员：`qa.t5.grid_worker.grid.evidence`
3. 两个员工账号均在脚本中通过真实 `POST /api/auth/login` + CSRF 流程验证登录成功（`authenticated=true`），浏览器中也再次真实登录；没有任何固定会话、Mock 身份或跳过认证的分支。
4. 会话 Cookie 为真实 `ll_session`，写请求由应用自身完成 CSRF double-submit；浏览器自动化没有绕过前端鉴权，也没有直接改库伪造审核。

复现顺序：

```bash
# 1) 空库 + 管理员
QA_DB_PATH=/tmp/ll-mvp-005-qa/db/t5-e2e.sqlite \
QA_ADMIN_USER=qa.admin QA_ADMIN_PASSWORD='<本地临时密码>' \
node --import tsx /tmp/ll-mvp-005-qa/seed-admin.mjs

# 2) 启动 API/H5/Admin（见 §1）

# 3) 真实后台 API 创建社区/运营员/网格员并验证登录
API_BASE=http://127.0.0.1:4094 ORIGIN=http://localhost:5274 \
QA_ADMIN_USER=qa.admin QA_ADMIN_PASSWORD='<本地临时密码>' \
node /tmp/ll-mvp-005-qa/t5-fixtures.mjs
```

---

## 3. 安装、类型检查、测试与构建

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile` | **0** | `Lockfile is up to date`、`Already up to date`、`Done in 942ms`；仅提示忽略 `better-sqlite3` build script（预编译二进制可用）；`pnpm-lock.yaml` 未变 |
| 2 | `pnpm check`（第一次） | **1** | admin `ActivitiesPage.test.tsx` 的既有用例 `publishes only after the confirmation dialog ...` 在全量并行下超时：`Unable to find an element with the text: 已发布`；`Tests 1 failed / 74 passed`，耗时 257s。见 `pnpm-check-first-run.log` |
| 3 | `pnpm --filter @sanchuang-dev/local-life-admin exec vitest run src/pages/ActivitiesPage.test.tsx` | **0** | 同文件单跑 **11/11 passed**，耗时 143s；说明第 2 步是慢环境下的偶发超时，不是 #61 代码失败。见 `activities-page-single-rerun.log` |
| 4 | `pnpm check`（第二次，全量） | **0** | oxlint `Found 12 warnings and 0 errors`；typecheck 全通过；admin **75/75**；API **29/29**；local-dev **7/7**；contracts/api/web/admin 构建全部 `Done`。见 `pnpm-check-second-run.log` |
| 5 | `git diff --stat -- apps packages scripts pnpm-lock.yaml` | — | 仅显示团队实现改动；本轮 QA 未写入这些路径（证据目录为新增） |

> 说明：第一次 `pnpm check` 的失败是**既有 ActivitiesPage 用例在并行全量运行中的偶发超时**（同一代码单跑 11/11 通过，第二次全量 75/75 通过）。本证据如实保留两次运行，不把第一次失败隐藏或改写成通过；#61 的最终门禁以第二次全量退出码 0 为准，残余不稳定性列入 §10。

### 3.1 自动化覆盖摘要

- `apps/api/test/crm.test.ts`：10 个测试；`pnpm check` 中 API 套件 **29/29**。覆盖文件库重启持久化、迁移、状态机、并发、CSRF、跨社区、隐私脱敏、审计。
- `apps/admin/src/pages/CrmPage.test.tsx` 及既有 admin 测试：**75/75**（含真实 403 错误态、审核二次确认、筛选参数）。
- `scripts/local-dev.test.mjs`：**7/7**（端口/配置契约）。

---

## 4. 真实 HTTP 负例与状态机（共 122 项断言，全部通过）

### 4.1 完整业务/权限流：`http-negative-flow.json`（49/49）

对真实 API `http://127.0.0.1:4094`、真实 Cookie/CSRF、`Origin: http://localhost:5274` 发请求。关键断言：

| 类别 | 检查 | 期望 | 实测 |
| --- | --- | --- | --- |
| 未登录 | `GET /crm/leads`、`/crm/orders`、`/admin/crm/leads` | 401 | **401** |
| 未登录写 | `POST /crm/leads` | 401 | **401** |
| 居民会话 | 居民登录后 `GET /crm/leads` | 401 | **401** |
| 角色隔离 | 网格员 `GET /admin/crm/leads`、`filter-options` | 403 | **403** |
| CSRF | 网格员写请求不带 `x-csrf-token` | 403 | **403** |
| Origin | 网格员写请求使用不可信 Origin | 403 | **403** |
| 跨社区读 | 网格员 A2/B 读取 A1 线索 | 403 | **403** |
| 跨社区写 | 网格员 B 在 A 社区建线索 | 403 | **403** |
| 跨社区运营 | 运营员按其他社区筛选 | 403 | **403** |
| 重复单号 | 同社区重复 `orderNo` | **409** | **409** |
| 并发 | 两个 confirm 同时提交 | 一个 200、一个 409 | **[200, 409]** |
| 非法流转 | `submitted → pending_verification`（跳步） | **409** | **409** |
| 非法流转 | Grid 直接提交 `status=confirmed` | 400 | **400** |
| 非法流转 | `confirmed → cancelled`、重复审核 | 409 | **409** |
| 并发复核 | 并发后订单事件仅 1 条 `order.reviewed` | 1 | **1** |
| 审核语义 | confirmed 携带 `activationSource=manual_verification` + confirmation，且无开通/激活字段 | 是 | **是** |
| 审计/隐私 | 订单审计不含手机号/凭据；列表手机号脱敏 | 是 | **是** |
| 持久化 | 文件库重启后线索/订单/审核仍可读 | 是 | 见 §5 |

完整原始结果：[`http-negative-flow.json`](./http-negative-flow.json)（`passed:49, failed:0`）。

### 4.2 第二轮边界：`http-negative-round2.json`（68/68）

重点：

- **F1 两跳成交**：`new → contacting → converted`，不存在 `new → converted` 直跳；`invalid` 线索审核确认返回 **409** 且订单回滚；恢复 `contacting` 后可再确认；重复 confirm 幂等且不产生额外跳转。
- **F2 服务端分页**：page1/page2 的 ID 不重复，排序稳定。
- **F3 CSRF**：运营员审核不带 CSRF → **403**；带真实 CSRF → 200。
- **F4 跨社区订单/审计**：运营员与网格员读取其他社区订单/审计均 **403**。
- **F5 转移目标**：把线索转移给 `admin` 目标 → **400**（不得把 admin 当该社区运营员/网格员）。
- **隐私**：列表手机号 `138****2222`；线索/订单审计不含完整手机号或凭证。

完整原始结果：[`http-negative-round2.json`](./http-negative-round2.json)（`passed:68, failed:0`）。

### 4.3 并发：`http-concurrency.log`（5/5）

真实 `Promise.all` 并发请求：

| 检查 | 实测 |
| --- | --- |
| confirm vs confirm | `[200, 409]` |
| 并发后 `order.reviewed` 事件数 | **1** |
| 成交线索路径 | `new → contacting → converted` 两跳 |
| confirm vs reject | `[200, 409]`，最终状态 `confirmed` |
| 混合并发后审核事件数 | **1** |

原始输出：[`http-concurrency.log`](./http-concurrency.log)。

### 4.4 API 重启持久化：`http-restart-persistence.json`

同一 SQLite 文件关闭真实 API 进程后重启（4094），重新真实登录并读取：

- 12 条线索、8 张订单仍存在；
- 7 张 `confirmed` 订单均返回 `activationSource: "manual_verification"`；
- 订单详情带真实 `confirmation` 审核人。

原始 JSON：[`http-restart-persistence.json`](./http-restart-persistence.json)。后续浏览器又新增 4 张确认订单，故最终库统计见 §5。

---

## 5. 数据库不变量与审计（真实 SQLite 查询）

在最终库 `/tmp/ll-mvp-005-qa/db/t5-e2e.sqlite` 上直接执行只读 SQL（不写库）：

[`http-db-invariants.json`](./http-db-invariants.json)：

| 指标 | 值 | 说明 |
| --- | --- | --- |
| `new_to_converted_events` | **0** | 不存在 `new → converted` 非法单跳 |
| `confirmed_orders` | **11** | 7 张来自 HTTP 验证 + 4 张来自两轮浏览器验证 |
| `review_events` | **11** | 每张 confirmed 恰好 1 条 `order.reviewed` |
| `confirmed_audits` | **11** | 每张 confirmed 恰好 1 条 `crm.order.confirmed` 审计 |
| `leads` / `orders` | 17 / 12 | 含负例/重复尝试产生的线索与订单 |

浏览器当前轮订单的 DB 复核：

- [`browser-orders-db.json`](./browser-orders-db.json)：`BROWSER-375-EVIDENCE-1793765509186`（`gd_mobile`）与 `BROWSER-320-EVIDENCE-1793765509186`（`gd_tv`）均为 `confirmed`，有 `confirmed_by_user_id`、`confirmed_at`、真实核验备注。
- [`browser-review-events.json`](./browser-review-events.json)：每张订单仅 1 条 `pending_verification → confirmed` 的 `order.reviewed`。
- 线索事件严格为 `lead.created → lead.follow_up_added → new→contacting → contacting→converted`，见 [`browser-lead-events-db.json`](./browser-lead-events-db.json)。
- 订单审计事件见 [`browser-order-audit-db.json`](./browser-order-audit-db.json)；`metadata` 仅含状态、决策、leadId/communityId 等，不含手机号/密码/Cookie。

> 两次浏览器执行留下了旧批次 `BROWSER-*-EVIDENCE` 订单（同样经真实复核为 confirmed），所以 DB 统计为 11 而非当前截图的 2；这属于重复运行证据，不是直改库或伪造数据。当前轮的截图、`browser-run.json` 与时间戳订单一一对应。

---

## 6. 真实浏览器全链路（Chrome，375×812 与 320）

脚本：`/tmp/ll-browser/t5-browser.mjs`（仓库外；puppeteer-core + 系统 Chrome，headless）。

### 6.1 流程

每个宽度独立浏览器上下文（独立 Cookie），全部通过页面真实操作完成：

**网格员 H5**
1. 打开 `/local-life/#/workbench`，在真实登录表单输入网格员账号/密码，点击“登录工作台”。
2. 进入“我的线索”，点击“登记线索”，填写居民称呼/电话/来源/下次联系时间，提交。
3. 线索详情填写“跟进内容”与下次联系时间，保存，等待服务端返回“跟进已记录”。
4. 点击“为该线索创建广电业务受理单”，分别创建 **广电手机卡（375）** 与 **广电电视（320）**，填写真实业务单号/客户/脱敏凭据引用。
5. 依次执行“提交处理中” → “提交运营核验”，到达“待运营核验”；页面不应出现“有效成交”或“已开通/已激活”。

**运营员后台**
6. 打开 `http://localhost:5274/#/customers`，真实登录运营员账号。
7. 切换到“业务受理单”，用本宽度订单号筛选，点击“审核”。
8. 填写核验备注，点击“确认有效成交”，在二次确认框点击“确认提交核验”，等待真实 `POST /api/admin/crm/orders/:id/review` 返回。
9. 刷新后台并重新筛选，确认仍为“有效成交（人工核验）”。

**刷新持久化**
10. 重新打开 H5 订单详情并刷新，确认显示“有效成交（人工核验）”，且仍标注人工核验语义。

### 6.2 结果

- **30/30 浏览器断言通过**；`browser-run.json`：`totalAssertions: 30, failures: 0, screenshots: 22`（不含补充的 2 张登录页截图）。
- 375：15 条断言，45 条 `/api` 响应；320：15 条断言，46 条 `/api` 响应。
- 所有记录的 API 响应状态仅为 **200/201**；页面 `pageErrors: 0`、真实传输失败 `requestFailures: 0`。
- 每次上下文导航出现 15 条 `net::ERR_ABORTED`，已单独记录在 `abortedRequests`：这是 React `AbortController` 在路由切换/卸载时取消上一页请求的正常清理，不是接口失败；对应请求在切换前均已成功返回（状态 200/201）。
- 两档均断言 `document.documentElement.scrollWidth <= innerWidth + 1`（375/320 均为精确相等，无横向溢出）。
- 两档 H5 页面与后台审核页均断言不含 `已开通`、`已激活`、`activationStatus`、`activatedAt`。
- 订单确认只通过运营员审核 UI + 真实 `POST .../review` 完成；H5 只提供 `提交处理中`/`提交运营核验` 等允许动作，不提供“确认成交”按钮。

关键 API（浏览器记录）：

```text
POST /api/auth/login                         200
POST /api/crm/leads                          201
POST /api/crm/leads/:id/follow-ups           201
POST /api/crm/orders                         201
PATCH /api/crm/orders/:id/status             200  (submitted→processing→pending_verification)
POST /api/admin/crm/orders/:id/review        200  (operator confirm, manual verification)
GET /api/admin/crm/orders?...                200
```

当前轮订单/线索：

| 宽度 | 业务 | 订单号 | 线索 ID | 订单 ID |
| --- | --- | --- | --- | --- |
| 375 | 广电手机卡 | `BROWSER-375-EVIDENCE-1793765509186` | `5264bff7-0517-4295-8546-889f185c6bda` | `2e54a8af-663f-4404-a3b1-f7d81c6cb338` |
| 320 | 广电电视 | `BROWSER-320-EVIDENCE-1793765509186` | `eb2a032c-f4b1-437f-a7df-4cb1f759054c` | `10d30a06-88fe-4783-9866-e30351061a53` |

原始记录：[`browser-run.json`](./browser-run.json)、[`browser-run.log`](./browser-run.log)。

---

## 7. 截图索引

目录：[`screenshots/`](./screenshots/)。所有截图均为真实 Chrome 页面，JPEG（quality 72），完整页面。

| 文件 | 内容 |
| --- | --- |
| `375-00-workbench-login.jpg` | 375 宽真实网格员登录页 |
| `375-01-workbench-leads.jpg` | 登录后“我的线索”空态/入口，无横向溢出 |
| `375-02-lead-form.jpg` | 登记线索表单（居民称呼/电话/来源/下次联系） |
| `375-03-lead-detail-followed.jpg` | 线索详情，跟进保存成功 |
| `375-04-order-form.jpg` | 广电手机卡受理单表单 |
| `375-05-order-submitted.jpg` | 受理单创建后“已提交受理” |
| `375-06-order-pending.jpg` | 提交处理中→待运营核验 |
| `375-07-admin-review-drawer.jpg` | 运营员后台待核验订单 Drawer + 核验备注 |
| `375-08-admin-review-confirm.jpg` | 人工核验二次确认框 |
| `375-09-admin-confirmed.jpg` | 审核后“有效成交（人工核验）” |
| `375-10-admin-confirmed-after-refresh.jpg` | 后台刷新并重新筛选后仍为 confirmed |
| `375-11-h5-confirmed-after-refresh.jpg` | H5 刷新后仍为“有效成交（人工核验）” |
| `320-00-workbench-login.jpg` | 320 宽真实网格员登录页 |
| `320-01-workbench-leads.jpg` | 320 宽登录后工作台，无横向溢出 |
| `320-02-lead-form.jpg` | 320 宽登记线索 |
| `320-03-lead-detail-followed.jpg` | 320 宽跟进保存 |
| `320-04-order-form.jpg` | 320 宽广电电视受理单 |
| `320-05-order-submitted.jpg` | 320 宽受理单已提交 |
| `320-06-order-pending.jpg` | 320 宽待运营核验 |
| `320-07-admin-review-drawer.jpg` | 320 宽运营审核 Drawer |
| `320-08-admin-review-confirm.jpg` | 320 宽二次确认 |
| `320-09-admin-confirmed.jpg` | 320 宽有效成交（人工核验） |
| `320-10-admin-confirmed-after-refresh.jpg` | 320 宽后台刷新后持久 |
| `320-11-h5-confirmed-after-refresh.jpg` | 320 宽 H5 刷新后持久 |

登录页补充截图来源：[`login-screens.json`](./login-screens.json)。

---

## 8. 验收点对照

| 验收要求 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` 与 `pnpm check` | install 0；check 第二次全量 0（第一次既有 ActivitiesPage 偶发失败，单跑 11/11 与第二次全量均通过） | `pnpm-install.log`、`pnpm-check-first-run.log`、`activities-page-single-rerun.log`、`pnpm-check-second-run.log` |
| 真实文件 SQLite + 真实 API + 真实员工登录，无后门 | 文件库 4094；管理员经真实 `hashPassword` 播种；运营员/网格员经真实后台 API 创建并真实登录 | §1、§2；API 日志与 fixtures 输出 |
| 未登录 401 | 多个 `/crm`、`/admin/crm` 端点 | `http-negative-flow.json` |
| 跨社区 403 | 线索/订单/审计/筛选/创建 | flow + round2 |
| 重复业务单号 409 | 同社区重复 `orderNo` | flow |
| 并发审核只成功一次 | `[200,409]`，单条 review 事件 | `http-concurrency.log`、flow |
| 非法状态流转 409 | 跳步、confirmed→cancelled、重复审核 | flow + round2 |
| CSRF 403 | 网格员写、运营员审核无 CSRF | flow + round2 |
| 刷新后持久化 | API 重启 + 浏览器刷新 | `http-restart-persistence.json`、浏览器 10/11 截图 |
| 网格员 H5 375/320：登录→线索→跟进→受理单→待核验 | 两档真实页面操作全部通过 | `browser-run.json`、截图 00–06 |
| 运营后台：登录→筛选→审核→确认 | 两档真实页面操作全部通过 | `browser-run.json`、截图 07–10 |
| 只能“人工核验有效成交”，不得写成“已开通” | 页面/接口均无开通/激活文案；confirmed 仅由 review 产生 | 浏览器断言、flow、round2、DB 不变量 |
| 证据可复现、无 Mock/假数据/直接改库伪造 | 原始 JSON/日志/截图、真实账号与真实 HTTP；DB 仅只读查询 | 本目录全部文件 |

---

## 9. 反作弊与边界声明

- 没有使用 Mock 成功、假列表、固定会话或直接改库伪造成交；所有 confirmed 均由真实运营员 UI 操作 → 真实审核 API → 事务写入。
- 没有使用运营商开通接口，也没有把业务验证成“已开通/已激活”；页面语义严格为“有效成交（人工核验）”，这是本任务的明确边界。
- 没有绕过真实登录：每个浏览器上下文都走登录表单；HTTP 负例从真实登录会话发起。
- 没有修改 `apps/**`、`packages/**`、`scripts/**`、测试或 `pnpm-lock.yaml`；QA 脚本均在仓库外，证据仅写入本目录。
- 运行时使用独立端口与独立测试账号；未终止本机既有 4081 进程。

---

## 10. 残余风险与未覆盖项

1. **`pnpm check` 首次全量偶发失败**：既有 `ActivitiesPage.test.tsx` 在并行全量、慢环境下超时；同文件单跑 11/11、第二次全量 75/75。该问题与 #61 无关，但仍是门禁不稳定风险，建议后续单独治理测试超时/并行资源，而不是在本卡内修改无关测试。
2. **未验证真实运营商开通**：没有广电开通接口/凭证，本任务只验证“人工核验有效成交”，不能声称运营商业务已开通。
3. **Vite dev 代理 ≠ 生产反向代理**：本轮验证通过本地 Vite `/api` 同源代理；生产需由反向代理保证 Cookie 同源，属于部署事项，不在本卡代码验收内。
4. **浏览器 headless**：真实 Chrome 但为 headless 模式；未覆盖真实手机触摸手势/软键盘，仅覆盖 375/320 视口与点击/表单。
5. **重复运行数据**：同一测试库保留了两轮浏览器订单与负例数据；当前轮截图/`browser-run.json` 与时间戳订单对应，旧批次仅作为重复执行记录。
6. **测试账号密码**：仅存在于本轮本地环境变量/仓库外脚本，未写入仓库；复现时需自行设置强密码。

---

## 11. 证据文件清单

| 文件 | 说明 |
| --- | --- |
| `pnpm-install.log` | frozen lockfile 安装原始输出 |
| `pnpm-check-first-run.log` | 第一次全量检查（退出码 1，ActivitiesPage 偶发超时） |
| `activities-page-single-rerun.log` | 该测试文件单跑 11/11 |
| `pnpm-check-second-run.log` | 第二次全量检查（退出码 0，75/29/7 全通过 + 构建） |
| `http-negative-flow.json` | 49 项完整 HTTP 权限/状态机/并发断言 |
| `http-negative-round2.json` | 68 项边界/分页/CSRF/跨社区/隐私断言 |
| `http-concurrency.log` | 5 项真实并发审核断言 |
| `http-restart-persistence.json` | API 重启后文件库数据与 manual_verification |
| `http-db-invariants.json` | 最终库不变量（0 条非法直跳；confirmed=review=audit=11） |
| `browser-orders-db.json` | 当前轮浏览器订单 DB 记录（confirmed/审核人/备注） |
| `browser-review-events.json` | 当前轮浏览器订单 review 事件 |
| `browser-lead-events-db.json` | 当前轮浏览器线索事件（两跳成交 + 跟进） |
| `browser-order-audit-db.json` | 当前轮浏览器订单审计事件（创建/状态/确认） |
| `browser-run.json` | 30/30 浏览器断言、91 条 API 响应记录（375:45 / 320:46）、22 张截图路径 |
| `browser-run.log` | 浏览器运行原始控制台输出 |
| `login-screens.json` | 补充的 375/320 登录页截图记录 |
| `screenshots/` | 24 张真实 Chrome 截图（含 2 张登录页） |
