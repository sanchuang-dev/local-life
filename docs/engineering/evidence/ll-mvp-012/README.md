# LL-MVP-012 / Issue #123 活动微信登录自动建立居民社区归属

> 分支：`feat/ll-mvp-012-activity-community-assignment`　基线：`dev@b15229e845acb7a16e1c84f0ae014657cbf12294`
> 范围：活动 H5 微信网页授权的社区归属推导（`GET /auth/wechat/start`、回调、`resident_community_assignments`）
> 执行时间：2026-11-09（Asia/Shanghai），本机真实 Chrome + 真实 Hono API/TCP + 真实 SQLite
> 执行方式：`node docs/engineering/evidence/ll-mvp-012/browser-verify.mjs docs/engineering/evidence/ll-mvp-012`

## 结论

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 契约单测（start query 构造 / 活动 ID 形状） | **8 / 8 通过** | `packages/contracts/test/wechat-start-contract.test.mjs` |
| 归属推导与边界（真实 Hono `app.request` + 真实 SQLite） | **8 / 8 通过** | `apps/api/test/activity-community-assignment.test.ts` |
| 真实 TCP 登录网络流（Host / Cookie / redirect_uri） | **2 / 2 通过** | `apps/api/test/activity-login-network.test.ts` |
| 既有 OAuth 回归（runtime / auth / return-to / 网络 e2e） | **30 / 30 通过** | `wechat-oauth-runtime` 14、`auth` 3、`auth-oauth-return` 12、`wechat-network-e2e` 1 |
| 浏览器端到端（真实 Vite H5 + 真实 API + 真实 cookie） | **47 / 47 通过，0 失败** | `browser-results.json`、4 张截图 |
| 真实微信公众号授权 | **未验证（无 AppID/AppSecret）** | 见 §5，这是本卡的外部验收缺口 |
| 类型检查 / lint / 构建 | **通过**（见下） | `pnpm lint` 0 error / 38 warning；`pnpm typecheck` 全绿；`pnpm build` 全绿 |
| 仓库 `pnpm check` | **1 个既有失败，与本卡无关** | `ledger-reconciliation-service.test.ts` 时间依赖缺陷，见 §5 |

浏览器脚本退出码 0；`browser-results.json` 中 `passed: 47, failed: 0`。

## 复核追加（2026-11-09）

独立评审后仅补充两项与 #123 直接相关的修正：

- 首页和旧版活动玩法路径即使为了展示而读取公开活动列表第一项，也不会把该默认项当成登录归属上下文；只有入口 URL 明确携带 `activityId` 才会随微信登录请求发送。
- 活动 UUID 按共享契约大小写不敏感；服务端在 SQLite 精确文本查询前规范为小写。

`browser-verify.mjs` 已追加普通首页与无 `activityId` 的旧活动路径回归场景，但这两个新增浏览器场景**尚未在本轮重新执行**。仓库中的 `browser-results.json`、截图及下文原有 **47 / 47** 结果来自此前执行，只证明显式活动链接场景；不得将其解释为新增场景已通过。真实微信授权仍未验证。

## 1. 实现内容

1. **H5 只上报活动上下文。** 活动页拉起登录时，`buildWechatLoginRequest` 用共享契约 `buildWechatStartQuery({ activityId, returnTo })` 生成 `GET /api/auth/wechat/start?activityId=…&returnTo=…`。H5 从不发送 `communityId`；`activityId` 形状非法时契约 helper 直接抛错，而不是拼出一个"能登录但没归属"的 URL。
2. **服务端推导社区。** `resolvePublicActivityCommunityId(db, activityId)` 用 `activities.id + status IN (published, paused, ended)` 查出社区，与 `GET /activities/public/:activityId` 共用同一组 `PUBLIC_STATUSES`。推导值写入 `oauth_states.community_id`（本轮不需要迁移，该列已存在）。
3. **客户端 `communityId` 一律拒绝。** `GET /auth/wechat/start` 只要看到 `communityId` 就返回 400「社区归属只能由活动上下文推导，请传入 activityId」，即使该 UUID 确实存在。**不做静默忽略**：忽略会让旧版 H5 看起来登录成功却什么都没归属。
4. **活动不可用时拒绝而非降级。** ID 形状非法 → 400「活动参数无效」；查不到或非公开（含 `draft`）→ 400「活动不存在或不可公开访问」，且不写 state 行。`activityId=`（显式空值）视为无效活动参数，返回 400 且不创建 state；普通登录必须完全省略 `activityId`。
5. **回调只消费已验证 state 的归属。** 回调用自己的 state 换取 `stateRecord.communityId`，在创建居民用户后 `INSERT ... ON CONFLICT DO NOTHING`。幂等由既有复合主键 `(user_id, community_id)` 保证，**没有新增迁移、没有第二张身份表**。
6. **登录绝不写入业务记录。** 登录路径不写 `activity_participations`、`activity_teams`、`activity_invitations`、`activity_checkins`、`activity_orders`、`activity_reward_grants`；本卡也未改动三人团邀请规则、网格员业绩归属或 CRM 线索负责人。
7. **无活动上下文不归属。** 普通入口（如 `/me`）不带活动上下文；首页或旧活动路径即使为了展示而选出公开列表第一项，也不应把该默认项当作归属上下文。只有入口 URL 明确携带 `activityId` 才会建立社区归属。
8. **回跳目标不变。** `returnTo` 仍由当前路由推导并经共享白名单校验，`activityId` / `invite` 参数原样保留；Pages `HashRouter` 兼容逻辑未改动。

## 2. 环境与复现

- Windows，Node `v24.22.2`，`corepack pnpm` `10.19.0`，Chrome headless + CDP（只用 Node 内置 `fetch`/`WebSocket`，无浏览器自动化依赖）。
- 证据全部跑在**一次性证据库** `.data/ll-mvp-012-browser.sqlite`（`.data` 已被 `.gitignore` 忽略），不触碰任何既有数据库。

```powershell
# 1) 主密钥（仅本地证据用，不提交）
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))" > .data\ll-mvp-012-masterkey.txt

# 2) 播种：两个社区 + 已发布/暂停/草稿三个活动 + 已启用公众号配置
$env:WECHAT_CONFIG_MASTER_KEY = (Get-Content .data\ll-mvp-012-masterkey.txt -Raw).Trim()
apps\api\node_modules\.bin\tsx.cmd docs\engineering\evidence\ll-mvp-012\seed-browser-db.ts

# 3) 证据 API（真实 createApp，仅 token 端点在 fetch 边界替换）
$env:LL_EVIDENCE_DATABASE = "$PWD\.data\ll-mvp-012-browser.sqlite"
$env:LL_EVIDENCE_PORT = '4080'
apps\api\node_modules\.bin\tsx.cmd docs\engineering\evidence\ll-mvp-012\evidence-server.ts

# 4) H5 开发服务器（clean-path 基座，与线上 MVP 路由模式一致）
cd apps\web; .\node_modules\.bin\vite.cmd --base=/ --host 127.0.0.1 --port 5173 --strictPort

# 5) 浏览器证据
node docs\engineering\evidence\ll-mvp-012\browser-verify.mjs docs\engineering\evidence\ll-mvp-012
```

`evidence-server.ts` 只替换了一件事：`/sns/oauth2/access_token` 由进程内 fake 应答。它自己的 `__evidence/*` 路由（snapshot / reset）包在 `app.fetch` 外层，**不属于产品 API**。

## 3. 浏览器验收矩阵（原始已执行 47 项；新增场景待执行）

设备指标为 iPhone 375×812 与 320×568，UA 为 `MicroMessenger/8.0.49`（否则页面不会显示微信登录按钮）。

| 阶段 | 断言要点 |
| --- | --- |
| 0 普通入口（本轮新增，待执行） | `/` 首页与无 `activityId` 的旧活动玩法路径可以展示公开列表第一项，但实际登录请求必须省略 `activityId` / `communityId`；OAuth state 的 `communityId` 为空；回调只创建身份，不创建社区归属或业务记录。 |
| 1 未登录活动页 | 服务端三人团卡片渲染；提示需先登录；提供「微信授权登录」；明确写「登录成功不会自动报名」；未登录时**没有**「确认参与」按钮 |
| 2 页面发出的登录请求 | 实际网络请求为 `/api/auth/wechat/start`，携带 `activityId`，**不含 `communityId`**；`returnTo` 同时保留 `activityId` 与 `invite`；为顶层导航（`Document`）；API 302 到 `open.weixin.qq.com/connect/oauth2/authorize`；`redirect_uri` 指向本 origin 的 `/api/auth/wechat/callback`；authorize URL 不含 `communityId`；带一次性 `state`；浏览器收到 HttpOnly 的 `ll_oauth_nonce`；此刻 `oauth_states` 行**已带推导出的社区** |
| 3 回调消费 state | 回调 302 回到原活动链接并带 `auth=success`；链接保留 `activityId` + `invite`；浏览器拿到 HttpOnly `ll_session`；页面显示「微信登录成功」且仍提示需主动确认；**确认参与按钮仍在且未被自动点击**；地址栏的一次性 `auth` 标记已被清理；地址栏保留活动与邀请参数 |
| 4 登录写入的数据库事实 | `resident_community_assignments` **恰好 1 行**且社区=活动所属社区；`wechat_identities` **恰好 1 行**（`appid=wx1234567890abcdef`）；参与/组队/邀请/签到/奖励/订单计数**全部为 0**；token 端点只被调用 1 次 |
| 5 重复登录 | 清 cookie 后重新登录：拿到全新 state；归属仍为 1 行、身份仍为 1 行；参与/组队仍为 0；两个 state 各自被消费一次，无重放 |
| 6 伪造社区输入 | 页面内 `fetch('/api/auth/wechat/start?activityId=…&communityId=<另一个真实存在的社区>')` → **400**，文案「社区归属只能由活动上下文推导」；草稿活动 → **400**「活动不存在或不可公开访问」；被拒请求没有多写归属或 state；直接把该 URL 当文档打开，浏览器看到的就是这段拒绝文案（`03-refused-activity-375.png`） |
| 7 窄屏 | 375 与 320 视口均无横向溢出；320 下活动与三人团卡片仍在 |

## 4. 证据文件

| 文件 | 内容 |
| --- | --- |
| `browser-results.json` | 47 项断言逐条结果、完整请求时序、最终数据库快照（含 `counts`）、运行参数与"未做真实微信授权"的显式声明 |
| `browser-verify.mjs` | 可复跑 CDP 脚本（唯一依赖是系统 Chrome） |
| `evidence-server.ts` | 真实 `createApp` + 真实 SQLite 的证据服务；未登录观测路由 `__evidence/snapshot`、`__evidence/reset` |
| `seed-browser-db.ts` | 证据库播种脚本（两个社区、三个活动、已启用公众号配置） |
| `01-activity-login-375.png` | 未登录活动页与微信登录入口 |
| `02-activity-logged-in-375.png` | 登录完成后：成功提示 + 仍需主动确认 |
| `03-refused-activity-375.png` | 草稿活动被 400 拒绝时浏览器实际看到的文案 |
| `04-activity-logged-in-320.png` | 320 窄屏下的登录后活动页 |

## 5. 未覆盖 / 已知限制

- **`pnpm check` 的 `apps/api` 阶段有 1 个失败，与本卡无关，且是既有的时间依赖缺陷。** `apps/api/test/ledger-reconciliation-service.test.ts` 的 `CSV rows, batch page entries and entry_count/total_cents tell one story` 断言 `entries.entries.length === 3`，实测 4。原因：该用例把"锁账后补录的事实"写死为 `AFTER_LOCK = 2026-11-09T10:00+08:00`，而 `lockBatch` 未传 `now`，用的是**真实系统时间**作为冻结截止点（`reconciliation-service.ts:857` `options.now ?? new Date()`）；当真实时间越过 `2026-11-09T10:00+08:00` 后，这条"补录"事实就落进了批次，断言必然失败。三条独立证据：(1) `git stash` 掉本卡全部改动后在同一 worktree 重跑该文件，仍是 13/14（`not ok 12`）；(2) `git diff origin/dev -- apps/api/src/ledger apps/api/test/ledger-reconciliation-service.test.ts` 为 0 行；(3) PR CI 的 `check` job 只挂在这一个用例（`not ok 158`，`4 !== 3`），而 `dev@b15229e` 的 Workspace CI 在 `2026-11-07T08:09Z` 是绿的——那时真实时间还没越过该时刻。属 LL-MVP-008 范围，本卡未修改；已在 PR #126 评论中给出根因与建议修法（给 `lockBatch` 传显式 `now`）。
- **没有做真实微信授权。** 本仓库没有可用 AppID/AppSecret，也没有网页授权域名，脚本在浏览器里 block 了 `open.weixin.qq.com`，`code`→`openid` 的交换由证据服务的进程内 fake 应答。因此"真实微信能否把 code 换成该 openid""真实环境下 `snsapi_base` 静默授权表现""线上 HTTPS Cookie 与回调域名"**均未验证**。已经验证的是代码边界：state/nonce/过期/重放、身份创建、归属写入、会话签发、回跳，全部走产品代码。
- 证据库里的公众号配置是播种的假凭证（`wx1234567890abcdef` + 本地生成的主密钥），只用于让 `/auth/wechat/start` 走通真实分支，不能当作任何共享环境凭据。
- 浏览器证据是桌面 Chrome 的移动视口模拟，不是真机微信内置浏览器、软键盘、iOS Safari 或屏幕阅读器测试。
- 没有像素级设计走查，只有布局/溢出/文案与状态断言。
- 真实微信侧的 `open.weixin.qq.com` 被 block，所以 `03-refused-activity-375.png` 之前的阶段里页面停在授权页而不是微信登录页；这是刻意的，不是失败。
- CI 结果以 Draft PR 的检查页为准；本文不预先宣称 CI 通过，也不代表任何人工验收结论。
