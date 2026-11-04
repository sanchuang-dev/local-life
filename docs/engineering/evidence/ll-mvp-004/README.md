# LL-MVP-004 居民参与与三人团 · 独立验收证据（T6 R1 / T10 R2）

- 任务：t6（首轮验证，FAIL）→ t9（修复）→ **t10（本轮复验，PASS）**
- Issue：[#60 [LL-MVP-004] 居民参与与三人团](https://github.com/sanchuang-dev/local-life/issues/60)
- 仓库/工作区：`/Users/tao/Desktop/workspace/new-local-life/ll-mvp-004`
- 分支：`feat/ll-mvp-004-real-teams`；基线：`origin/dev@1d4f000`
- 验收人：browser-verifier（未修改业务实现文件）
- 本轮验收时间：2026-11-04（Asia/Shanghai）
- **最终结论：PASS**。首轮唯一缺陷 VERIFY-01 已由 t9 修复，本轮用**全新 SQLite + 全新活动 + 全新账户**完整复跑：真实 HTTP **40/40**、真实 Chrome **40/40**、进程重启持久化 **4/4**、SQLite 不变量全通过；暂停活动 H5 实测显示“活动已暂停，暂不可参与。”，不再误报“活动尚未发布”。

---

## 0. 结论摘要（R2）

| 项目 | 结果 |
| --- | --- |
| 真实 HTTP 断言 | **40/40 PASS**（`http-checks-r2.json`，0 失败） |
| 真实 Chrome 断言 | **40/40 PASS**（`browser-run-r2.json`，0 失败） |
| 进程重启后持久化 | **4/4 PASS**（`restart-persistence-r2.json`） |
| 真实 SQLite 不变量 | PASS（`db-inspection-r2.json`：16 表、16 users、6 teams，无团 >3 席，locked 团均 3 席） |
| 暂停文案缺陷复验 | PASS（`browser-run-r2.json` br-38；`paused-page-r2.json`：页头 paused=true、卡片 paused=true、未发布=false） |
| `contracts build` / `api test` / `api typecheck` | 全部 exit 0（测试 33/33） |
| 业务实现文件修改 | 0（本轮仅新增/更新本证据目录；t9 的 H5 修复为上游产物） |

本轮与首轮完全隔离：新数据库 `/tmp/ll-mvp-004-verify/verify-r2.sqlite`、新管理员 bootstrap、新活动与新居民账户，未复用首轮任何团队/参与记录。首轮证据与缺陷记录仍保留在 `browser/` 与不带 `-r2` 后缀的旧 JSON（见 §8.4），便于对照。

---

## 1. 验收对象与环境

| 项目 | 实测值 |
| --- | --- |
| 操作系统 | macOS 26.6（Build 25G72） |
| Node / pnpm | v22.23.2 / 10.19.0 |
| 浏览器 | 本机 **Google Chrome 156.0.8078.80**（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，headless） |
| 浏览器驱动 | puppeteer-core **24.43.1**（仓库外 `/tmp/ll-mvp-004-verify`） |
| API | 真实 Hono 进程 `http://127.0.0.1:4080`（`tsx src/index.ts`） |
| H5 | 真实 Vite dev server `http://localhost:5173/local-life/`，`/api/*` 同源代理到 4080 |
| 数据库 | 真实 SQLite `/tmp/ll-mvp-004-verify/verify-r2.sqlite`（WAL，16 张表，0000–0002 迁移） |
| 登录开关 | `NODE_ENV=development`、`AUTH_DEV_ENABLED=true`；生产配置禁止 |

### 1.1 端口、数据库与启动方式

- 端口：API **4080**、H5 **5173**；启动前确认空闲。
- DB：`/tmp/ll-mvp-004-verify/verify-r2.sqlite`（仓库外；工作区与共享 worktree 内均无数据库文件）。
- 迁移：`env NODE_ENV=development DATABASE_PATH=/tmp/ll-mvp-004-verify/verify-r2.sqlite pnpm --filter @sanchuang-dev/local-life-api db:prepare` → exit 0，输出“SQLite 已迁移：…（16 个表）”；API 重启时再次迁移同一文件。
- H5 代理：`GET http://localhost:5173/api/healthz` → 200；API 直连 `GET /healthz` → 200。真实代理，不是 mock。

### 1.2 管理员与居民账号创建方式

**管理员**：真实 `pnpm --filter @sanchuang-dev/local-life-api bootstrap-admin`，在 `/usr/bin/expect` pty 中输入登录名/显示名/密码，创建 `verify.admin`（role=admin、status=active）。未直写 `staff_accounts`，无默认密码。临时脚本 `/tmp/ll-mvp-004-verify/scripts/bootstrap-admin-r2.expect` 在仓库外，密码不写入仓库与本文档。

**HTTP 居民**：每个身份独立 Cookie Jar；`GET /auth/csrf` 取真实 token，`POST /auth/dev/login` 创建真实用户与会话。A 为 `e5ea1b35-fd8b-4633-8e9a-d0e1dd4b9876`（居民A），B/C/D/E/L/抢席1–4 的 ID 见 `http-checks-r2.json.setup.accounts`，两两不同。

**Chrome 居民（隔离上下文）**：

| 身份 | displayName | userId | 登录方式 |
| --- | --- | --- | --- |
| A | 本地测试居民（按钮写死） | `a0ada6c2-5cfd-4cb3-a753-84ddd2a27825` | 页面“开发测试登录”按钮 |
| B | 居民B | `950b72c7-750c-4d66-89cb-33b6bd4c2875` | 上下文内真实 dev login |
| C | 居民C | `d74d81e9-f932-49e5-8a4a-d1968c3cd478` | 同上 |
| D | 居民D | `9d669fc7-d523-42dd-8e1f-5dbd883314dc` | 同上 |
| E | 居民E | `17724144-f2e5-4d8f-8211-89a707264960` | 同上 |

> H5 登录按钮固定显示名，故 A 为“本地测试居民”；B/C/D/E 用同一真实 dev-login 端点设置可区分显示名。五者 userId 两两不同，各自 Cookie 隔离，不是同一用户复用。生产环境该端点关闭。

### 1.3 活动创建方式（真实管理员 API）

管理员经真实 `POST /auth/login` 后，通过真实 `POST /admin/activities` 创建活动，并用真实 `publish|pause|end` 走生命周期；无直接 UPDATE 伪造状态。

HTTP R2 活动（`http-checks-r2.json.setup`）：

| 活动 | ID | 状态 | 用途 |
| --- | --- | --- | --- |
| 主活动 | `db78d9ed-1a26-4115-9c77-d57f2d7a50f7` | published | A/B/C 3/3 |
| 跨活动 | `a5ebc177-c757-4d04-b2c2-bab37fb90b0b` | published | A 再组队、跨活动邀请码 |
| 并发 | `792b24bc-67f1-4e50-9909-5c5d4fa4e145` | published | 4 并发抢最后 2 席 |
| 暂停 | `cd26158a-87b3-43af-a538-6f0d47fffaed` | paused | 409 activity_unavailable |
| 结束 | `61dd48dd-dea5-4230-8940-33feff074342` | ended | 409 activity_unavailable |
| 过期 | `63433639-3cb2-4073-b849-33eb6a34f6dc` | published，endsAt 已过 | 409 activity_unavailable |
| 草稿 | `899f55c8-063f-46fe-9c6c-d40d37f5ea36` | draft | 404 not_found |

浏览器 R2 活动（`browser-setup-r2.json`）：主活动 `11e64e7c-1e7f-4466-bc3d-dafd31772227`（published）、暂停 `e36e75f7-7752-4598-b2fb-eb84282f2dd7`（paused，pause 200）、结束 `5a6948d4-d830-4bec-b2f9-4976168fcdf3`（ended，end 200）。

### 1.4 真实性声明

- 无 mock、内存假数据、假截图、跳过鉴权；业务写入均来自真实 HTTP（页面交互或脚本真实 fetch）。
- 分享 URL 来自页面真实 `shareUrl`（真实 activityId + API 返回的 inviteCode）；二维码为 `QRCodeSVG` 真实渲染后 jsQR 独立解码。
- 数据库仅由 API/真实命令写入；`db-inspect.mjs` 以 `readonly: true` 打开核对。
- 本轮未修改业务实现文件；`git status` 相对本轮开工仅新增本证据目录内容。

---

## 2. 本轮实际命令与退出码

机器可读记录见 [`commands-run-r2.json`](./commands-run-r2.json)。

| # | 命令 | 退出码 | 关键结果 |
| --- | --- | --- | --- |
| 1 | `pnpm --filter @sanchuang-dev/local-life-contracts build` | 0 | `tsc -p tsconfig.json` 通过 |
| 2 | `pnpm --filter @sanchuang-dev/local-life-api test` | 0 | **33/33** 通过，0 fail |
| 3 | `pnpm --filter @sanchuang-dev/local-life-api typecheck` | 0 | `tsc --noEmit`（src + test）通过 |
| 4 | `rm -f verify-r2.sqlite*` + `env … DATABASE_PATH=… db:prepare` | 0 | 全新 SQLite，16 张表 |
| 5 | `expect -f /tmp/…/bootstrap-admin-r2.expect /tmp/…/verify-r2.sqlite` | 0 | 真实创建 `verify.admin` |
| 6 | API 启动（4080，R2 DB） | 运行中 | `/healthz` → 200 |
| 7 | H5 启动（5173，代理 4080） | 运行中 | `/local-life/` → 200；`/api/healthz` → 200 |
| 8 | `node http-verify.mjs`（R2 OUT/DB） | 0 | **40/40** HTTP 断言通过 |
| 9 | `node browser-setup.mjs`（R2 HTTP/OUT） | 0 | 3 个浏览器活动真实创建/发布/暂停/结束 |
| 10 | `node browser-verify.cjs`（R2 setup/out/shots） | 0 | Chrome **40/40** 通过，19 张截图 |
| 11 | `node paused-text.cjs`（R2 setup/out） | 0 | 页头与卡片均显示 paused，无“未发布” |
| 12 | `node db-inspect.mjs`（R2 DB/OUT） | 0 | SQLite 不变量 PASS |
| 13 | 停止 API → 重启同 DB → `node restart-recheck.mjs` | 0 | **4/4** 持久化断言通过 |
| 14 | `sips -g pixelWidth -g pixelHeight browser-r2/*.png` | 0 | 375→750×1624、320→640×1136 |
| 15 | `git status --porcelain=v1` | 0 | 仅本证据目录新增；业务文件未动 |

> `A_COOKIE` 只在重启检查的进程环境内出现，取自一次真实 dev login 的 Cookie；`http-checks-r2.json` 不保存 Cookie/CSRF。首轮 JSON 中曾存在的会话字段已移除。

---

## 3. 真实 HTTP 验收（40/40）

真实 API + 真实 SQLite；独立 Cookie Jar、真实 CSRF、`Origin: http://localhost:5173`；管理员同样真实登录。逐条状态码/响应体（含 `requestId`）见 [`http-checks-r2.json`](./http-checks-r2.json)。

状态码分布：200×24、400×4、401×2、403×2、404×4、409×4；**无 5xx**。

| ID | 检查 | 期望 | 实测 | 结果 |
| --- | --- | --- | --- | --- |
| http-01 | A 未参与时读取活动参与状态 | 200 + participation null + joinable true | 200 | PASS |
| http-02 | A 自行确认参与，成为团长占第 1 席 | 200 created=true leader seat1 1/3 open | 200 | PASS |
| http-03 | B 用 A 的邀请码确认，进入第 2 席并冻结邀请归属 | 200 created=true seat2 invite 2/3 | 200 | PASS |
| http-04 | C 用 A 的邀请码确认，3/3 成团并锁定 | 200 created=true seat3 locked 3/3 inviteCode null | 200 | PASS |
| http-05 | 第四人 D 持邀请码确认被 409 team_full 拒绝 | 409 team_full | 409 (team_full) | PASS |
| http-06 | D 被拒后在本活动没有参与记录 | 200 participation null | 200 | PASS |
| http-07 | 第四人被拒后主活动团仍为 3 席 | 200 locked 3/3 | 200 | PASS |
| http-08 | A 重复确认幂等：created=false、同团同席、人数不增 | 200 created=false same team 3/3 | 200 | PASS |
| http-09 | B 已加入后重复 confirm 幂等且不换团 | 200 created=false same team seat2 | 200 | PASS |
| http-10 | 未登录读取参与状态返回 401 | 401 unauthorized | 401 (unauthorized) | PASS |
| http-11 | 未登录确认参与返回 401 | 401 unauthorized | 401 (unauthorized) | PASS |
| http-12 | 已登录但缺少 CSRF 头返回 403 | 403 forbidden | 403 (forbidden) | PASS |
| http-13 | CSRF 正确但 Origin 不可信返回 403 | 403 forbidden | 403 (forbidden) | PASS |
| http-14 | 伪造 userId 字段被严格 schema 拒绝（400） | 400 invalid_request | 400 (invalid_request) | PASS |
| http-15 | 伪造 userId 未给 D 产生任何归属 | 200 participation null | 200 | PASS |
| http-16 | 同时伪造 userId 与邀请码仍按 strict schema 400，不落库 | 400 invalid_request | 400 (invalid_request) | PASS |
| http-17 | 无效邀请码返回 400 invite_invalid 且零归属 | 400 invite_invalid | 400 (invite_invalid) | PASS |
| http-18 | 无效邀请码未给 E 写入参与记录 | 200 participation null | 200 | PASS |
| http-19 | 跨活动使用他场邀请码返回 400 invite_invalid | 400 invite_invalid | 400 (invite_invalid) | PASS |
| http-20 | 跨活动邀请码未在目标活动落入归属 | 200 participation null | 200 | PASS |
| http-21 | 草稿活动读取参与状态返回 404 | 404 not_found | 404 (not_found) | PASS |
| http-22 | 草稿活动确认参与返回 404 且零写入 | 404 not_found | 404 (not_found) | PASS |
| http-23 | 不存在活动读取参与状态返回 404 | 404 not_found | 404 (not_found) | PASS |
| http-24 | 不存在活动确认参与返回 404 | 404 not_found | 404 (not_found) | PASS |
| http-25 | 暂停活动状态：joinable=false、unavailableReason=activity_not_published | 200 paused not joinable | 200 | PASS |
| http-26 | 暂停活动确认参与返回 409 activity_unavailable | 409 activity_unavailable | 409 (activity_unavailable) | PASS |
| http-27 | 结束活动状态：joinable=false、unavailableReason=activity_ended | 200 ended not joinable | 200 | PASS |
| http-28 | 结束活动确认参与返回 409 activity_unavailable | 409 activity_unavailable | 409 (activity_unavailable) | PASS |
| http-29 | 已过 endsAt 的已发布活动不可参与（409 前置状态） | 200 published joinable=false reason activity_ended | 200 | PASS |
| http-30 | 已过期活动确认参与返回 409 activity_unavailable | 409 activity_unavailable | 409 (activity_unavailable) | PASS |
| http-31 | A 在另一场已发布活动重新组队成功 | 200 created=true new team seat1 | 200 | PASS |
| http-32 | A 跨活动组队后主活动团籍不变 | 200 primary team id unchanged 3/3 | 200 | PASS |
| http-33 | A 在第二场活动的团独立存在（1/3 open） | 200 secondary team 1/3 open | 200 | PASS |
| http-34 | E 在同一活动另建独立三人团并取得邀请码 | 200 created=true 1/3 open | 200 | PASS |
| http-35 | B 已加入后使用另一团队的邀请码不改变归属与团队 | 200 created=false same team seat2 inviteSource invite | 200 | PASS |
| http-36 | E 的团没有被 B 加入（仍 1/3） | 200 1/3 open | 200 | PASS |
| http-37 | 并发活动团长 L 建团 1/3 | 200 created=true 1/3 | 200 | PASS |
| http-38 | 4 个并发确认恰好 2 个成功、2 个 409 team_full | [200,200,409,409] | 200 | PASS |
| http-39 | 并发成功的两人落在第 2、3 席且同团 | [2,3] same team | 200 | PASS |
| http-40 | 并发后团队恒为 3 席且已锁定 | 200 locked 3/3 | 200 | PASS |

关键断言：

- `http-04`：C 加入后 `status=locked`、`seatsFilled=3`、`inviteCode=null`、席位 `[1,2,3]`；A 的团 `2baa21eb-ef4a-4fb5-9e3e-70df9be7f782`。
- `http-05`–`07`：D 第四人 409 `team_full`，D 参与记录仍 `null`，团队仍 3/3。
- `http-08`/`09`：A、B 重复 confirm 均 `created=false`，同团同席，人数不增。
- `http-14`–`16`：`{userId}` 与 `{inviteCode,userId}` 均 400 `invalid_request`，D 无归属。
- `http-19`/`20`：跨活动邀请码 400 `invite_invalid`，目标活动零归属。
- `http-25`–`30`：paused、ended、已过 endsAt 均 409 `activity_unavailable`；draft/不存在 404。
- `http-31`–`33`：A 第二场活动新建独立团，主活动团籍不变。
- `http-34`–`36`：E 同场另建团给码；B 用该码 confirm 仍 `created=false`，团队/席位/邀请人不变。
- `http-38`/`39`：4 并发结果恰 `[200,200,409,409]`，成功席位 `[2,3]` 同团。
- `http-40`：并发后团恒 3 席且 locked；DB 无第 4 席。

> “B 用 C 的邀请码”在语义上不可构造：C 已加入 A 的团，同一活动一人只能有一个有效团籍，C 不会再有邀请码。验收改用同场另一独立团队的真实邀请码（HTTP=E，Chrome=D）验证“已加入后打开另一邀请链接归属不变”。

---

## 4. 真实 Chrome 验收（40/40）

- 本机 Google Chrome `156.0.8078.80`，headless；puppeteer-core 24.43.1；非 jsdom。
- A/B/C/D/E 各自 `browser.createBrowserContext()`；B 打开另一邀请链接时在 B 自己的新标签页（同 Cookie、fresh document）。
- 视口 `375×812 @2x`、`320×568 @2x`；逐页记录 `scrollWidth <= clientWidth`。
- `/api` 响应 104 条（200×103、409×1），无 5xx。

链路：A 未登录门禁 → 页面按钮登录 → 确认 → 1/3 → 分享弹层 → 复制/转发/二维码 → B 深链登录确认 → 2/3 → C 确认 → 3/3 locked → A 刷新/重进 → D 满团失败 → D 另建团并给出另一邀请链接 → B 新标签打开该链接归属不变 → 暂停/结束活动真实反馈。

| ID | 断言 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| br-01 | A 未登录打开活动页看到登录门禁 | PASS | {"authenticated":false} |
| br-02 | 375 登录门禁页无横向溢出 | PASS | {"documentScrollWidth":375,"documentClientWidth":375,"bodyScrollWidth":375,"innerWidth":375} |
| br-03 | A 通过页面“开发测试登录”按钮完成真实登录 | PASS | {"clicked":true,"text":"开发测试登录"} |
| br-04 | A 登录后自动重读活动状态并显示可参与表单 | PASS | {"userId":"a0ada6c2-5cfd-4cb3-a753-84ddd2a27825","displayName":"本地测试居民"} |
| br-05 | A 点击确认参与提交真实 confirm 请求 | PASS | {"clicked":true,"text":"确认参与本活动"} |
| br-06 | A 成团 1/3，团长占第 1 席，服务端写入成功 | PASS | {"teamId":"3967c08a-87b0-464a-a33c-4f2a6ec53d7c","seats":1} |
| br-07 | 375 1/3 团队卡无横向溢出 | PASS | {"documentScrollWidth":375,"documentClientWidth":375,"bodyScrollWidth":375,"innerWidth":375} |
| br-08 | A 从团队卡真实邀请入口打开分享弹层 | PASS | {"clicked":true,"text":"邀请 2 位街坊加入三人团"} |
| br-09 | 375 分享弹层无横向溢出 | PASS | {"documentScrollWidth":375,"documentClientWidth":375,"bodyScrollWidth":375,"innerWidth":375} |
| br-10 | A 点击“复制链接” | PASS | {"clicked":true,"text":"复制链接"} |
| br-11 | 分享 URL 来自真实页面且包含 activityId 与 invite | PASS | {"shareUrl":"http://localhost:5173/local-life/#/community/activity/silver-neighborhood?activityId=11e64e7c-1e7f-4466-bc3… |
| br-12 | navigator.share 收到的 URL 与复制链接一致 | PASS | {"sharedUrl":"http://localhost:5173/local-life/#/community/activity/silver-neighborhood?activityId=11e64e7c-1e7f-4466-bc… |
| br-13 | 二维码解码内容与分享 URL 完全一致（含 activityId + invite） | PASS | {"decoded":"http://localhost:5173/local-life/#/community/activity/silver-neighborhood?activityId=11e64e7c-1e7f-4466-bc3d… |
| br-14 | 320 分享弹层无横向溢出 | PASS | {"documentScrollWidth":320,"documentClientWidth":320,"bodyScrollWidth":320,"innerWidth":320} |
| br-15 | 320 1/3 团队卡无横向溢出 | PASS | {"documentScrollWidth":320,"documentClientWidth":320,"bodyScrollWidth":320,"innerWidth":320} |
| br-16 | B 在独立上下文打开 A 的真实分享链接，先看到登录门禁 | PASS |  |
| br-17 | B 登录后深链 invite 参数保留且未自动报名 | PASS | {"participation":null} |
| br-18 | B 点击确认接受邀请 | PASS | {"clicked":true,"text":"确认接受邀请并参与"} |
| br-19 | B 成为第 2 席、邀请归属 A、同团 2/3 | PASS | {"teamId":"3967c08a-87b0-464a-a33c-4f2a6ec53d7c","seat":2,"inviter":"本地测试居民"} |
| br-20 | C 点击确认接受邀请 | PASS | {"clicked":true,"text":"确认接受邀请并参与"} |
| br-21 | C 成为第 3 席，三人团 3/3 锁定且不再暴露邀请码 | PASS | {"status":"locked","seats":3,"inviteCode":null} |
| br-22 | A/B/C 是三个不同的真实用户账户 | PASS | {"A":"a0ada6c2-5cfd-4cb3-a753-84ddd2a27825","B":"950b72c7-750c-4d66-89cb-33b6bd4c2875","C":"d74d81e9-f932-49e5-8a4a-d196… |
| br-23 | A 刷新后读取到同一团队 3/3 locked | PASS | {"teamId":"3967c08a-87b0-464a-a33c-4f2a6ec53d7c"} |
| br-24 | A 刷新前仍是自己确认后的 1/3，刷新后同一团队变为 3/3 locked | PASS | {"before":"我的三人团\n真实业务\n进行中\n1 / 3\n还差 2 位街坊\n\n你是本团团长。席位与成员来自服务端实时状态，刷新或换设备后保持一致。\n\n参与成功，已加入三人团。\n","after":"我的三人团\n真实… |
| br-25 | 320 3/3 locked 团队卡无横向溢出 | PASS | {"documentScrollWidth":320,"documentClientWidth":320,"bodyScrollWidth":320,"innerWidth":320} |
| br-26 | A 离开页面后重新进入深链，团队与 3/3 状态持久一致 | PASS | {"teamId":"3967c08a-87b0-464a-a33c-4f2a6ec53d7c"} |
| br-27 | A 重进后团队卡展示 3 个真实成员/本人 | PASS | 我的三人团 真实业务 已成团 3 / 3 已成团  你是本团团长。席位与成员来自服务端实时状态，刷新或换设备后保持一致。  我  我  团长 · 本人  居  居民B  成员  居  居民C  成员  已成团，本场不再接受新成员；邀请入口已… |
| br-28 | D 点击确认接受邀请 | PASS | {"clicked":true,"text":"确认接受邀请并参与"} |
| br-29 | 第四人 D 看到明确的“团队已满”错误反馈且未入团 | PASS | {"feedbackVisible":true,"participation":null} |
| br-30 | 320 团队已满反馈无横向溢出 | PASS | {"documentScrollWidth":320,"documentClientWidth":320,"bodyScrollWidth":320,"innerWidth":320} |
| br-31 | D 在未持邀请时自行参与，另建一个三人团 | PASS | {"clicked":true,"text":"确认参与本活动"} |
| br-32 | D 的独立团为 1/3，与 A 的团不同 | PASS | {"dTeamId":"52d2736f-bc1a-4682-a0a6-680141620e86","aTeamId":"3967c08a-87b0-464a-a33c-4f2a6ec53d7c"} |
| br-33 | D 打开自己的分享弹层 | PASS | {"clicked":true,"text":"邀请 2 位街坊加入三人团"} |
| br-34 | D 的分享 URL 是同一活动下另一条真实邀请链接 | PASS | {"dShareUrl":"http://localhost:5173/local-life/#/community/activity/silver-neighborhood?activityId=11e64e7c-1e7f-4466-bc… |
| br-35 | B 已加入后打开另一条邀请链接，团队与归属不变 | PASS | {"teamId":"3967c08a-87b0-464a-a33c-4f2a6ec53d7c","seat":2,"autoConfirmPosts":0} |
| br-36 | B 打开另一邀请链接后团队卡仍显示 A 的 3/3 团队 | PASS | 我的三人团 真实业务 已成团 3 / 3 已成团  你是本团成员 · 由 本地测试居民 邀请加入。席位与成员来自服务端实时状态，刷新或换设备后保持一致。  本  本地测试居民  团长  我  我  成员 · 本人  居  居民C  成员  … |
| br-37 | 暂停活动 H5 显示不可参与的真实状态 | PASS | {"activityStatus":"paused","joinable":false} |
| br-38 | 暂停活动按钮禁用且文案为“活动已暂停，暂不可参与。” | PASS | {"cardText":"我的三人团\n真实业务\n暂不可参与\n参与本活动，组成三人团\n\n三人团固定 3 个不同居民账户，发起人占一席，另邀两位街坊。只有你主动确认参与，服务端才会写入记录。\n\n确认参与本活动\n\n活动已暂停，暂… |
| br-39 | 结束活动 H5 显示“活动已结束，暂不可参与” | PASS | {"activityStatus":"ended"} |
| br-40 | 320 登录门禁页无横向溢出 | PASS | {"documentScrollWidth":320,"documentClientWidth":320,"bodyScrollWidth":320,"innerWidth":320} |

### 4.1 分享 URL 与二维码（R2 真实页面）

A 在 1/3 状态打开真实分享弹层：

- 页面“复制链接”传入 `navigator.clipboard.writeText` 的 URL：
  `http://localhost:5173/local-life/#/community/activity/silver-neighborhood?activityId=11e64e7c-1e7f-4466-bc3d-dafd31772227&invite=9d131fe610153aef1049987451579683`
- `navigator.share` 捕获的 URL：完全相同。
- `QRCodeSVG` 元素截图（296×296）经 jsQR 独立解码：完全相同；含 activityId 与 32 位小写 hex invite。
- D 的真实分享入口产生同活动另一条邀请：
  `…?activityId=11e64e7c-1e7f-4466-bc3d-dafd31772227&invite=ac4fa78cb0b9b06d60c593265421e3c4`

> headless Chrome 的 OS 剪贴板拒绝 `writeText`（`NotAllowedError`）。验收脚本保留页面原 `handleCopyLink` 逻辑，仅包一层 `navigator.clipboard.writeText` 记录页面**实际传入的字符串**并让 UI 成功；`br-11` 记录 `clipboardPlatform: headless-denied:NotAllowedError`。`navigator.share` 在 headless 无目标，同样以 stub 捕获页面入参。两者均非手工拼造，二维码解码提供独立第二来源。

### 4.2 截图（R2，19 张）

| 截图 | 视口 | 内容 |
| --- | --- | --- |
| [`375-login-gate.png`](./browser-r2/375-login-gate.png) | 375×812 | 未登录登录门禁 |
| [`320-login-gate.png`](./browser-r2/320-login-gate.png) | 320×568 | 320 登录门禁 |
| [`375-team-nonmember.png`](./browser-r2/375-team-nonmember.png) | 375×812 | 登录后未参与、可参与 |
| [`375-team-nonmember-invite-D.png`](./browser-r2/375-team-nonmember-invite-D.png) | 375×812 | D 持邀请未参与 |
| [`375-team-1of3.png`](./browser-r2/375-team-1of3.png) | 375×812 | A 团长 1/3 |
| [`320-team-1of3.png`](./browser-r2/320-team-1of3.png) | 320×568 | 320 的 1/3 |
| [`375-team-2of3.png`](./browser-r2/375-team-2of3.png) | 375×812 | B 加入后 2/3 |
| [`375-team-3of3-C.png`](./browser-r2/375-team-3of3-C.png) | 375×812 | C 加入后 3/3 locked |
| [`375-team-locked-A.png`](./browser-r2/375-team-locked-A.png) | 375×812 | A 刷新后 3/3 locked |
| [`320-team-locked-A.png`](./browser-r2/320-team-locked-A.png) | 320×568 | 320 的 3/3 locked |
| [`375-team-locked-reenter.png`](./browser-r2/375-team-locked-reenter.png) | 375×812 | 离开后重进同团 |
| [`375-team-locked-B-after-other-link.png`](./browser-r2/375-team-locked-B-after-other-link.png) | 375×812 | B 打开另一邀请后归属不变 |
| [`375-share-sheet.png`](./browser-r2/375-share-sheet.png) | 375×812 | 分享弹层（URL/二维码/转发/复制） |
| [`320-share-sheet.png`](./browser-r2/320-share-sheet.png) | 320×568 | 320 分享弹层 |
| [`375-share-qr.png`](./browser-r2/375-share-qr.png) | 296×296 | jsQR 解码的二维码原图 |
| [`375-team-full-D.png`](./browser-r2/375-team-full-D.png) | 375×812 | 第四人满团反馈 |
| [`320-team-full-D.png`](./browser-r2/320-team-full-D.png) | 320×568 | 320 满团反馈 |
| [`375-paused.png`](./browser-r2/375-paused.png) | 375×812 | 暂停（已修复文案） |
| [`375-ended.png`](./browser-r2/375-ended.png) | 375×812 | 结束活动反馈 |

### 4.3 横向溢出

所有截图点均为 `documentScrollWidth <= documentClientWidth`（375/375、320/320，body 同）：
375 登录门禁、1/3、分享弹层；320 登录门禁、1/3、3/3 locked、满团、分享弹层。全部 0 溢出。

---

## 5. 持久化与真实 SQLite 不变量（R2）

**进程重启**（`restart-persistence-r2.json`）：HTTP 验收后停止 API，用同一 `verify-r2.sqlite` 重启，复用 HTTP A 的数据库会话：

| 检查 | 期望 | 实测 | 结果 |
| --- | --- | --- | --- |
| 重启后 API 可读 | 200 | 200 | PASS |
| A 会话仍有效 | 有参与 | 有 | PASS |
| 团队 ID 不变 | `2baa21eb-ef4a-4fb5-9e3e-70df9be7f782` | 相同 | PASS |
| 仍 locked 3/3 | locked/3 | locked/3 | PASS |

**SQLite 只读核对**（`db-inspection-r2.json`，浏览器验收后）：

- 16 张表；`users=16`、`communities=1`、`activities=10`、`activity_teams=6`、`activity_participations=12`、`activity_invitations=6`、`audit_logs=51`、`sessions=17`。
- 无团超过 3 席；所有 locked 团恰 3 席；主活动与并发活动均有 `locked_at`；主活动席位 `[1,2,3]`；审计 metadata 无 32 位邀请码。

---

## 6. 首轮缺陷与修复复验（VERIFY-01，已关闭）

首轮 t6 失败原因：`apps/web/src/components/activity/ParticipationTeamCard.tsx:54` 的 `unavailableText()` 先判断 `unavailableReason==='activity_not_published'`，而 API 对 paused 活动返回该 reason，导致 `activityStatus==='paused'` 分支不可达；页面显示“活动尚未发布，暂不可参与。”，与页头“活动已暂停，等待恢复通知”矛盾（首轮证据：[`browser/375-paused.png`](./browser/375-paused.png)、`browser-run.json` br-37/38）。

t9 修复：先按 `activityStatus` 判断 paused/ended，再按 reason 判断未发布/结束（代码见工作区未提交文件）。本轮独立复验：

- `browser-run-r2.json` br-38 断言参与卡包含“活动已暂停，暂不可参与。”、不含“活动尚未发布”，且按钮 disabled —— **PASS**。
- `paused-page-r2.json`：`headerHasPaused=true`、`cardSaysPaused=true`、`cardSaysNotPublished=false`。
- 截图 [`browser-r2/375-paused.png`](./browser-r2/375-paused.png) 为修复后状态；首轮旧图保留在 `browser/375-paused.png` 供对照。
- 未发现新的 blocker/high/medium 缺陷。

---

## 7. 未覆盖 / 限制（明确记录）

1. **微信 OAuth 未配置**：无公众号 AppID/AppSecret/回调域名，未做真实微信授权与深链保留；使用仓库显式 dev login（仅 development）。
2. **OS 剪贴板/系统分享**：headless 拒绝剪贴板，`navigator.share` 无目标；通过捕获页面真实入参 + jsQR 独立解码取证；未用物理手机扫码。
3. **“C 的邀请码”不可构造**：C 已入团后同活动不能有第二团籍；改用同场另一真实团队邀请码（HTTP=E，Chrome=D），语义一致。
4. **并发仅 HTTP 层**：4 并发在真实 API/SQLite 验证；浏览器按顺序 B/C 加入。
5. **浏览器覆盖 paused/ended**；“endsAt 已过”的过期场景由 HTTP 409 覆盖，未单独截图。
6. **管理台 UI 未操作**：活动创建/发布/暂停/结束走真实管理员 HTTP API（任务允许后台 API）。
7. **物理设备/线上域名**：本机真实 Chrome + 375/320 视口，未用两台物理手机；线上域名未配置。
8. **同标签页 hash-only 改变 invite**：React 不自动重读参与状态；真实打开链接是新 tab/webview，本轮用 B 的新标签页验证；页面提供刷新按钮。仅观察，不计缺陷。

---

## 8. 证据文件与复现（R2）

### 8.1 R2 文件

| 文件 | 内容 |
| --- | --- |
| [`README.md`](./README.md) | 本报告 |
| [`http-checks-r2.json`](./http-checks-r2.json) | 40 条真实 HTTP 状态码/响应/requestId、账号与活动 setup |
| [`browser-run-r2.json`](./browser-run-r2.json) | 40 条 Chrome 断言、19 张截图索引、104 条 `/api` 网络记录 |
| [`browser-setup-r2.json`](./browser-setup-r2.json) | R2 浏览器活动 ID/状态 |
| [`restart-persistence-r2.json`](./restart-persistence-r2.json) | 重启后 4 条持久化断言 |
| [`db-inspection-r2.json`](./db-inspection-r2.json) | R2 SQLite 表/行数/不变量 |
| [`paused-page-r2.json`](./paused-page-r2.json) | 暂停页页头/卡片文本判定 |
| [`commands-run-r2.json`](./commands-run-r2.json) | 本轮命令/退出码 |
| [`browser-r2/`](./browser-r2/) | 19 张 R2 真实 Chrome 截图（375/320/二维码） |

### 8.2 仓库外临时脚本（未提交）

`/tmp/ll-mvp-004-verify/scripts/`：`bootstrap-admin-r2.expect`、`http-verify.mjs`、`db-inspect.mjs`、`restart-recheck.mjs`、`browser-setup.mjs`、`browser-verify.cjs`、`paused-text.cjs`。依赖 `puppeteer-core@24.43.1`、`jsqr@1.4.0`、`pngjs@7.0.0` 位于仓库外。

### 8.3 复现顺序

```bash
cd /Users/tao/Desktop/workspace/new-local-life/ll-mvp-004
pnpm --filter @sanchuang-dev/local-life-contracts build
pnpm --filter @sanchuang-dev/local-life-api test
pnpm --filter @sanchuang-dev/local-life-api typecheck

env NODE_ENV=development DATABASE_PATH=/tmp/ll-mvp-004-verify/verify-r2.sqlite \
  pnpm --filter @sanchuang-dev/local-life-api db:prepare
expect -f /tmp/ll-mvp-004-verify/scripts/bootstrap-admin-r2.expect /tmp/ll-mvp-004-verify/verify-r2.sqlite

# 终端 A：API
env NODE_ENV=development HOST=127.0.0.1 PORT=4080 \
  DATABASE_PATH=/tmp/ll-mvp-004-verify/verify-r2.sqlite AUTH_DEV_ENABLED=true \
  TRUSTED_ORIGINS='http://localhost:5173,http://127.0.0.1:5173' \
  WEB_BASE_URL='http://localhost:5173/local-life/' SESSION_TTL_HOURS=168 \
  pnpm --filter @sanchuang-dev/local-life-api exec tsx src/index.ts

# 终端 B：H5
env LOCAL_LIFE_API_PORT=4080 LOCAL_LIFE_WEB_PORT=5173 \
  pnpm --filter @sanchuang-dev/local-life-web dev

# 终端 C：验收
OUT=docs/engineering/evidence/ll-mvp-004/http-checks-r2.json \
  DB_PATH=/tmp/ll-mvp-004-verify/verify-r2.sqlite \
  node /tmp/ll-mvp-004-verify/scripts/http-verify.mjs
HTTP_FILE=docs/engineering/evidence/ll-mvp-004/http-checks-r2.json \
  OUT_FILE=docs/engineering/evidence/ll-mvp-004/browser-setup-r2.json \
  node /tmp/ll-mvp-004-verify/scripts/browser-setup.mjs
SETUP_FILE=docs/engineering/evidence/ll-mvp-004/browser-setup-r2.json \
  OUT_FILE=docs/engineering/evidence/ll-mvp-004/browser-run-r2.json \
  SHOTS_DIR=docs/engineering/evidence/ll-mvp-004/browser-r2 SHOT_DIRNAME=browser-r2 \
  node /tmp/ll-mvp-004-verify/scripts/browser-verify.cjs
SETUP_FILE=…/browser-setup-r2.json OUT_FILE=…/paused-page-r2.json \
  node /tmp/ll-mvp-004-verify/scripts/paused-text.cjs
DB_PATH=/tmp/ll-mvp-004-verify/verify-r2.sqlite \
  HTTP_FILE=…/http-checks-r2.json OUT_FILE=…/db-inspection-r2.json \
  node /tmp/ll-mvp-004-verify/scripts/db-inspect.mjs

# 重启 API 后（A_COOKIE 取自真实 dev login 的 Set-Cookie；证据不保存凭据）
A_COOKIE='<真实会话 Cookie 值>' \
  HTTP_FILE=…/http-checks-r2.json OUT_FILE=…/restart-persistence-r2.json \
  DB_PATH=/tmp/ll-mvp-004-verify/verify-r2.sqlite \
  node /tmp/ll-mvp-004-verify/scripts/restart-recheck.mjs
```

### 8.4 首轮（R1）证据存档

首轮判定 FAIL 的证据原样保留，便于审计对照：

- `http-checks.json`（R1 40/40）、`browser-run.json`（R1 40/40）、`browser-setup.json`、`restart-persistence.json`（R1 4/4）、`db-inspection.json`（R1）、`browser/`（R1 19 张，含修复前 `375-paused.png`）、`commands-run.json`（R1）。

---

## 9. 声明

- 本轮未修改任何业务实现文件；t9 的 `ParticipationTeamCard.tsx` 修复是上游产物，验收人只读检查。
- 本报告只记录实际执行的命令与断言；未执行项在 §7 明确列出。
- 所有 R2 截图来自真实 Chrome 会话，未使用设计稿、占位图或合成截图。
