# 本地生活 · 施工规约

本仓库继承 [三创组织宪法](https://github.com/sanchuang-dev/.github/blob/main/AGENTS.md)。施工前读取组织现行规则、本文件与当前任务契约。本文件只规定本项目特例，不复制组织的派卡、权限和验收流程。

## 1. 阶段与定位

- 自 [Issue #57](https://github.com/sanchuang-dev/local-life/issues/57) 起，本仓库进入 **Pre-MVP 真实工程基座**：pnpm workspace + 居民 H5 + 管理台 + Node API。
- **居民 H5** 保留已评审页面、视觉和路由；居民主身份现已接入账户 API。微信网页授权只有在公众号 AppID、AppSecret、授权回调域名等真实配置齐备后才可使用。
- **管理台** 已具备管理员/运营员/网格员登录、退出、会话、社区分配和居民列表的服务端权限校验；**活动创建/发布/暂停和居民 H5 公开读取已由 LL-MVP-003 落地**。参与/三人团、跟进、成交、订单、奖励与对账仍由后续业务卡实现。
- **API** 使用 SQLite + Drizzle 持久化用户、微信身份、后台账户、社区范围、会话、OAuth state、限流与审计记录。数据库只允许落在 `apps/api` 内。
- 所有未实现业务必须显式标注，不得用 Mock 成功、写死数据或假鉴权伪装。
- 产品仍按 MVP 任务卡逐步收敛；旧 [V0.3](https://github.com/sanchuang-dev/base-prototype/blob/demo/local-life/docs/PRD-V0.3.md) 只是历史参考。

## 2. 技术栈与目录

固定栈：Node.js 22+、pnpm 10、React 19 + TypeScript + Vite、Tailwind CSS 4、React Router（HashRouter）、Lucide；管理台 Ant Design 6；API 为 Hono + zod + Drizzle ORM + SQLite。实际版本以各 `package.json` 与 `pnpm-lock.yaml` 为准。

```text
apps/web/       # 居民移动端 H5，保留 /local-life/ Pages base
apps/admin/     # 管理台：身份登录、社区/后台账户管理、社区居民只读列表
apps/api/       # Node + Hono API、SQLite/Drizzle schema 与 migrations
packages/contracts/  # 共享 zod schema 与类型；API 与客户端不得各自复制 DTO
docs/engineering/    # 工程边界、身份/权限、安全配置与验证证据
```

- 根目录只放 workspace 配置、锁文件、文档和工作流；业务代码进 `apps/*`，跨端契约进 `packages/*`。
- 不引入 Nx / Turborepo / 微服务框架；不为「以后可能用到」预建空领域层。
- 路由统一走 React Router；H5 继续用 `HashRouter` 兼容 GitHub Pages 深链接，不新增第二套路由逻辑。
- TypeScript 明确约束业务数据与 Props，不用无边界 `any`；后端代码保持 strict。

## 3. 命令与端口

```bash
pnpm dev:local                   # 一键启动本地 SQLite + H5 + Admin + API（自动装依赖并执行迁移）
pnpm db:local:setup              # 仅初始化或迁移项目内 .data/local-life-dev.sqlite
pnpm admin:local                 # 首次安全交互式创建管理员，无内置默认密码
pnpm install --frozen-lockfile   # 安装（CI/验收必须用 frozen lockfile）
pnpm dev                         # 并行启动 web + admin + api（先构建 contracts）
pnpm dev:web / dev:admin / dev:api
pnpm check                       # oxlint + typecheck + API 测试 + 全量构建
pnpm --filter @sanchuang-dev/local-life-api bootstrap-admin  # 初始化首个管理员
```

- `pnpm dev:local` 的唯一可编辑端口真相源是被 Git 忽略的 `apps/api/.env.local`：`PORT` (API)、`WEB_PORT` (H5)、`ADMIN_PORT` (Admin)。脚本自动推导检查端口、Vite 监听/代理、API Origin allowlist 和 Web 回跳地址；不得再在其他地方独立修改这些数值。
- 未使用本地启动器的裸 `pnpm dev` 保留共享默认端口，定义在 `scripts/local-ports.mjs`，H5 默认 5173、Admin 默认 5174、API 默认 4080。
- H5 Vite base 为 `/local-life/`；本地 `/api/*` 同源代理到 API。服务 `GET /healthz` 返回共享契约校验后的 JSON。
- 管理台/H5 的浏览器请求统一走当前站点的 `/api` 前缀。部署时由反向代理将 `/api/*` 转发到 API，保持 Cookie 同源；不把 Vite 代理当成生产配置。

## 4. 前端规则

- **移动端优先**：以 375 × 812 为主要查看基准，兼顾 320 等窄屏、触控面积、滚动与底部安全区；不得为了桌面效果损坏移动端。
- 设计依据按优先级：**当前用户确认 > 新版已确认原型/截图 > 已验收页面 > 旧版 V0.3 参考 > 实现者推断**。视觉基线在 [design.md](design.md)。
- 保留 H5 现有页面与交互；新增页面放 `apps/web/src/pages/`，复用组件放 `components/`，样例数据放 `mocks/`。图片引用继续通过 `import.meta.env.BASE_URL`，不得写死会绕过 Pages base 的绝对路径。
- H5 账户状态通过 `hooks/useResidentAuth.ts` 访问 API；真实 API 调用不得散落复制 DTO，加载、空、错误、禁用状态必须如实展示。
- 管理台由 `App.tsx` 先校验真实后台会话，成功后才渲染 `app/shell/AppShell.tsx`；由 `app/auth-context.tsx` 统一传递会话到顶部身份/退出与真实功能路由。前端菜单隐藏不能替代 API 鉴权。管理员可管理社区与后台账户；运营员/网格员只能访问服务器分配的社区范围。
- AppShell（导航/页签/主题）与 DataPanel（受控数据面板）沿用 Benefit Hub 已验证设计思路，但保持 Local Life 自身的 Token 与 URL 单一真相源。业务查询状态由页面管理，不在 DataPanel 自造 API 缓存；详见 `docs/engineering/admin-foundation.md`。
- 内容、活动参与、跟进、成交、订单、奖励与对账模块未完成前，必须明确标注未实现，不显示虚构业务数据；已上线代码中的活动配置与发布不能被误写为未实现。

## 5. API、身份与持久化

- 配置在启动时用 zod 校验，非法值必须让进程失败，不许静默回退到看似健康的默认值。
- 所有对外错误使用 `packages/contracts` 的 `{ error: { code, message, requestId? } }` 结构。
- 新增 DTO/schema 一律先改 `packages/contracts`，API 用 schema 校验输入/响应；客户端不得复制一份类型真相源。
- SQLite + Drizzle 仅在 `apps/api` 内；schema 在 `apps/api/src/db/schema.ts`，迁移在 `apps/api/db/migrations/`，服务启动时执行迁移。不要在 H5/Admin 各自引入数据库或维护第二套数据。
- 居民主用户 UUID 是平台主键；微信身份以 `(appid, openid)` 唯一映射，unionid 可选，不以手机号/OpenID/商城 UID 代替平台用户 ID。
- 后台账号关联平台用户；管理员可将已完成微信授权的居民用户关联为运营员/网格员，重复关联必须拒绝，不能静默合并。
- `admin` 可管理全体社区；`operator` 与 `grid_worker` 必须通过 `staff_community_assignments` 获得社区范围。CRM 查询必须在服务端检查归属，居民列表只返回当前必要字段。
- 会话使用随机不透明 Cookie，数据库只存 token hash；Cookie 为 HttpOnly + SameSite=Lax，生产环境 Secure。写请求要求 CSRF double-submit token 和可信 Origin。
- 微信 OAuth 必须验证一次性 state、浏览器 nonce、有效期与重放；未配置公众号凭证时明确返回不可用，不得模拟成功。开发居民测试登录只有显式 `AUTH_DEV_ENABLED=true` 才开启，生产配置禁止开启。
- 登录密码使用 scrypt 哈希；登录失败限流；审计日志不得记录密码、Cookie、OAuth code/token、openid 等凭证或敏感标识。
- GitHub Pages 是静态站点，不得把 API 伪装成已部署可用；管理台和 API 不进入 Pages 产物。

## 6. 分支、验证与牛马

- `main` 是默认分支和工作流入口，**不是生产分支**；业务施工仍从最新 `dev` 开 `feat/*` 并向 `dev` 提交 Draft PR。**本仓库在线 MVP 验收环境的已批准例外为 `dev → mvp`**：仅经维护者验收的增量以独立晋级 PR 进入 `mvp`，合并后自动部署；居民 H5 使用 `https://local.proto.3cgroup.cn/`、管理后台使用 `https://local-admin.proto.3cgroup.cn/`，两域名各自同源 `/api/*` 代理到同一 Hono/SQLite；`mvp` 不是商用生产分支。现有 `test/prod` 继续承担 GitHub Pages 静态展示兼容，部署设计与授权边界详见 [在线 MVP 环境决策](docs/engineering/mvp-online-preview.md)。
- 小步施工，只修改任务范围；不顺手迁移旧页面、重构无关模块或删除历史证据。
- 提交前至少运行 `pnpm install --frozen-lockfile` 与 `pnpm check`。改 UI/路由还必须用真实浏览器验证 375 与 320 宽度下的入口、返回、图片和深链接；改 API 必须发真实 HTTP 请求；改 Pages 必须验证 dev 与 `/prod/` 两份构建的 base 路径。身份、权限、持久化和 OAuth 必须覆盖成功路径、未认证/越权/重放/过期/缺配置负例。
- CI 绿不等于验收通过，未验证不得宣称通过。外部微信/商城/支付依赖未具备真实凭证时，记录阻塞项，不以 mock 冒称真实环境验收。
- 三创 Worker 只允许针对明确授权的 Open Issue 施工并交付 Draft PR；无自行合并、关卡、晋级或发布权。
