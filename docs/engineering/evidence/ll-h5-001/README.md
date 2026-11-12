# LL-H5-001 微信登录与活动邀请回跳 — 浏览器证据（#92）

验证对象：居民 H5 活动页的微信公众号网页授权回跳。分支 `feat/ll-h5-001-wechat-invite-return`，基线 `dev@c13f96c`，证据对应代码 HEAD `23a2628`（父 `0ed58cf`；本目录由后续 `docs(evidence)` 提交加入，未改代码）。`git diff --stat c13f96c..23a2628` = 13 文件 +1821/−45：`apps/api/src/app.ts`（OAuth start/callback 与 `redirectToWeb`）、`apps/api/src/auth/`、`apps/api/test/`、`apps/web/src/{main.tsx,hooks,components/activity,pages}`、`packages/contracts/src/index.ts`（仅 returnTo 段与标记段的纯函数/常量，无新 route、无新错误码）。无 `apps/admin/`、无 `schema.ts` 改动、无新迁移。

## 运行方式（本次证据的实际环境）

- 真实 API：`apps/api` 的 `src/index.ts`（tsx，Node v22.23.3），`NODE_ENV=development`、`AUTH_DEV_ENABLED=true`、伪造 `WECHAT_APP_ID/SECRET/REDIRECT_URI`（只为让 `/auth/methods` 报 `wechat:true`）、`WEB_BASE_URL=http://127.0.0.1:5191/`、独立 SQLite（含 1 场已发布活动）。
- 前端：`vite --base /`（MVP `BrowserRouter` clean-path 形态），`/api` 代理到 4191。
- 浏览器：系统 Chrome 156（`--headless=new`，`--remote-debugging-port=9381`），Node 内置 WebSocket 直连 DevTools Protocol，无第三方依赖；每个场景先 `Network.clearBrowserCookies`，再断言 DOM 文本与 `location`。
- 真实会话：页面内 `GET /api/auth/csrf` + `POST /api/auth/dev/login`（开发登录，非微信授权）后刷新，得到服务端 `/auth/session` 确认的会话。

## 覆盖清单

| # | 场景 | 断言（DOM + URL） | 证据 |
| --- | --- | --- | --- |
| 1 | 无会话浏览器打开 `?activityId=…&invite=…&auth=success` | 文本为「未登录 / 登录后报名三人团 / 微信授权登录」，**不出现**「微信登录成功」；`/api/auth/session` 为 false；`?auth=success` 被首帧清除 | `01-no-session-auth-success.png` |
| 2 | 同一 URL 追加微信授权页会带回的 `#wechat_redirect` | 标记与片段都被清除（`history.replaceState` 重写整条路由） | `02-no-session-wechat-redirect-fragment.png` |
| 3 | `?auth_error=wechat_authorization_failed`（拒绝/超时） | 显示「微信授权未完成（你取消或超时）。可以重新发起登录。」+「重新发起微信登录」；无成功文案；`auth_error` 被清除 | `03-no-session-authorization-failed.png` |
| 4 | 服务端会话已认证时打开 `?auth=success` | 已登录分支显示「微信登录成功。页面不会自动报名，参与仍需你在下方主动确认。」；`auth=success` 被清除 | `04-authenticated-auth-success.png` |
| 5 | 场景 4 后刷新 | 不再出现成功文案（一次性标记不可重放） | `05-authenticated-reload.png` |
| 6 | 登录后是否写参与 | 直接查 SQLite：`activity_participations=0`、`activity_teams=0` | 见下方「断言原始数据」 |

所有断言的布尔结果落在 `round2-results.json`（CDP 脚本输出，`authParamStripped` / `successTextShown` / `fragmentStripped` / `retryShown` / `sessionAuthenticated`）。

## 命令与结果

```
pnpm install --frozen-lockfile     # exit 0
pnpm lint                          # exit 0，17 warnings / 0 errors（与 c13f96c 基线一致）
pnpm typecheck                     # exit 0（contracts / admin / web / api 全 Done）
pnpm build                         # exit 0
pnpm --dir apps/api exec node --import tsx --test test/auth.test.ts              # 3/3
pnpm --dir apps/api exec node --import tsx --test test/security-boundaries.test.ts # 2/2
pnpm --dir apps/api exec node --import tsx --test test/auth-oauth-return.test.ts # 11/11
pnpm --dir apps/api exec node --import tsx --test test/login-marker.test.ts      # 2/2
```

`pnpm check` 整体 202 tests / 194 pass / 8 fail：8 个失败是 dev 基线既有的 Windows-only `EPERM`（`rewards-version-edit*` / `rewards-data` 临时目录清理），与基线 `c13f96c` 逐条同名，不是本卡引入。真实 HTTP 用例覆盖：state 一次性、nonce 绑定、过期、重放、跨域/越权 returnTo 拒绝、未配置公众号凭证、登录不写参与。

## 未验证项与外部依赖

- **真实公众号凭证缺失**：`open.weixin.qq.com` 的真实授权往返未跑；provider 仅在 `fetch` 边界伪造。callback 的 `Location` 尾 `#` 由真实 Hono HTTP 测试（`auth-oauth-return.test.ts`）验证，而非真实微信跳转。
- **Pages HashRouter**（`base=/local-life/`）只做构建 + 单测断言（hash 形态目标仍为 `#/me?…` / `#/community/activity/…`，不追加多余 `#`），未在真实浏览器实测回跳。
- `/ #/` 旧分享链未单独浏览器实测；由 `apps/web/src/main.tsx` 的 `legacyHashRouteToClean` 在 boot 时归一为 clean path，再由同一页面级清理生效。
- 无 iOS 真机、无微信内置浏览器、无线上部署；截图未做人工目视复核（生成本证据的模型无图像输入）。

## 复跑方式

1. 在 worktree 内起 API：`NODE_ENV=development AUTH_DEV_ENABLED=true PORT=4191 DATABASE_PATH=<本地 sqlite> WEB_BASE_URL=http://127.0.0.1:5191/ WECHAT_APP_ID=... WECHAT_APP_SECRET=... node --import tsx apps/api/src/index.ts`（需先 schema 迁移与一场已发布活动）。
2. 起前端：`node node_modules/vite/bin/vite.js --base / --host 127.0.0.1 --port 5191`。
3. `chrome --headless=new --remote-debugging-port=9381 --user-data-dir=<tmp>`，用 CDP 依次执行上表 5 个场景；断言口径与 `round2-results.json` 相同。
