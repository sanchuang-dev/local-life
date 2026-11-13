# 本地生活 · 施工规约

本仓库继承 [三创组织宪法](https://github.com/sanchuang-dev/.github/blob/main/AGENTS.md)。施工前读取组织现行规则、本文件与当前任务契约。本文件只规定本项目特例，不复制组织的派卡、权限和验收流程。

## 1. 阶段与定位

- 自 [Issue #57](https://github.com/sanchuang-dev/local-life/issues/57) 起，本仓库进入 **Pre-MVP 真实工程基座**：pnpm workspace + 居民 H5 + 管理台 + Node API。
- **居民 H5** 保留已评审页面、视觉和路由；居民主身份现已接入账户 API。微信网页授权只有在公众号 AppID、AppSecret、授权回调域名等真实配置齐备后才可使用；CRMEB 商品与购买跳转也只读取服务端真实配置，未配置时必须明确不可用。
- **管理台与 API** 已具备管理员/运营员/网格员登录、退出、会话、社区分配和居民目录的服务端权限校验。`dev` 代码已经包含活动创建/发布/暂停与居民公开读取（LL-MVP-003）、三人团（LL-MVP-004）、网格员 CRM（LL-MVP-005）、签到与奖励履约（LL-MVP-006）、CRMEB adapter（LL-MVP-007）、统一经营流水/对账/结算（LL-MVP-008 及后续 SET 卡）、本地商品目录与居民订单（LL-MVP-010）、消费返券和抽奖（PUR/LOT 卡）等模块；每个模块的真实边界仍以 `docs/engineering/` 对应文档、当前代码和测试为准。
- **代码存在不等于线上可用**：`dev` 上的实现和测试不等于已部署到 `mvp`，也不等于真实微信、CRMEB 或支付依赖已经可用。`mvp` 的实际能力只以对应晋级部署的 SHA、健康检查和验收证据为准；在线支付、自动分账/自动佣金等仍未由现行代码证明可用。
- **API** 使用 SQLite + Drizzle 持久化用户、微信身份、后台账户、社区范围、会话、OAuth state、限流与审计记录。数据库只允许落在 `apps/api` 内。
- 所有未实现业务必须显式标注，不得用 Mock 成功、写死数据或假鉴权伪装。
- 产品仍按 MVP 任务卡逐步收敛；旧 [V0.3](https://github.com/sanchuang-dev/base-prototype/blob/demo/local-life/docs/PRD-V0.3.md) 只是历史参考。

## 2. 技术栈与目录

固定栈：Node.js 22+、pnpm 10、React 19 + TypeScript + Vite、Tailwind CSS 4、React Router（线上 MVP BrowserRouter；Pages 预览保留 HashRouter）、Lucide；管理台 Ant Design 6；API 为 Hono + zod + Drizzle ORM + SQLite。实际版本以各 `package.json` 与 `pnpm-lock.yaml` 为准。

```text
apps/web/       # 居民移动端 H5，保留 /local-life/ Pages base
apps/admin/     # 管理台：身份、活动/CRM、商品订单、业绩对账、系统配置
apps/api/       # Node + Hono API、SQLite/Drizzle schema 与 migrations
packages/contracts/  # 共享 zod schema 与类型；API 与客户端不得各自复制 DTO
docs/engineering/    # 工程边界、身份/权限、安全配置与验证证据
```

- 根目录只放 workspace 配置、锁文件、文档和工作流；业务代码进 `apps/*`，跨端契约进 `packages/*`。
- 不引入 Nx / Turborepo / 微服务框架；不为「以后可能用到」预建空领域层。
- 路由统一走 React Router；线上 MVP 的 H5 和 Admin 均使用 `BrowserRouter`，由已有 Caddy `try_files` 提供深链刷新回退；仅 GitHub Pages 的 H5 静态预览继续使用 `HashRouter`，共用一份 Route 表，不复制业务路由逻辑。
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
- 内容、奖励履约、商城及对账结算等模块若仍有未完成或未验收边界，必须标注真实状态，不显示虚构业务数据；活动发布、三人团、CRM、签到奖励、本地商品与订单、消费返券、抽奖、经营流水与对账结算已有 `dev` 代码，不得误写为完全未实现，更不得把代码存在误称已经线上部署或真实外部依赖已可用。

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

- `main` 是默认分支和工作流入口，**不是生产分支**；业务施工仍从最新 `dev` 开 `feat/*` 并向 `dev` 提交 Draft PR。**本仓库在线 MVP 验收环境的已批准例外为 `dev → mvp`**：仅经维护者验收的增量以独立晋级 PR 进入 `mvp`，合并后自动部署；居民 H5 使用 `https://local.proto.3cgroup.cn/`、管理后台使用 `https://local-admin.proto.3cgroup.cn/`，两域名各自同源 `/api/*` 代理到同一 Hono/SQLite；`mvp` 不是商用生产分支。**正式环境的发布链路为 `feat/* → dev → mvp → prod`**：已在 `mvp` 的 proto 原型服务器验收的改动，经独立 `mvp → prod` 晋级 PR 合并后，才允许发布到宝塔正式环境（居民 `https://local-life.3cgroup.cn/`、后台 `https://local-admin.3cgroup.cn/`）；`prod` 不再接收 `test → prod` 作为生产晋级路径。历史 `test` 保留兼容但不承担现行晋级门禁；GitHub Pages 的 `/prod/` 页面只是 `prod` 提交的静态展示镜像，并非另一套生产环境。详见 [在线 MVP 环境决策](docs/engineering/mvp-online-preview.md) 与 [宝塔正式环境](scripts/bt-production/README.md)。
- 工程规约与 `mvp` 的当前差异、核对命令和晋级同步步骤见 [AGENTS 同步说明](docs/engineering/agents-sync.md)；`mvp` 不得直接修改，未经授权不得晋级或部署。
- 小步施工，只修改任务范围；不顺手迁移旧页面、重构无关模块或删除历史证据。
- **按改动范围和风险验证，不按整个应用规模验收**：施工者优先运行能证明本次变更的最低充分检查（相关类型/静态检查、受影响单元/契约/集成测试、必要构建）；普通小卡不默认做全站 E2E、无关 SQL/迁移回归或重复全量自测。需要安装依赖时使用 `pnpm install --frozen-lockfile`；仓库 `pnpm check` 仍是全量质量检查，按现有 CI/分支门禁执行，不能为省时关闭或弱化必需检查，但不再要求每个低风险施工 Agent 在自己的执行预算内重复跑完它。
- **前端与浏览器**：普通文案、样式、局部组件和低风险路由调整以相关类型检查、组件/路由测试与构建为主；**紧迫交付时，375/320 视口截图、视觉自验收及完整浏览器 E2E 不是施工 Agent 的统一交付硬指标**。涉及响应式布局本身、关键可见交互、鉴权回跳或跨页面核心流程，或任务明确要求视觉比对时，按具体风险安排有成熟浏览器/真机工具的执行者验证；无该能力者明确记录未验证项，不临时发明 CDP 自动化反复排障。
- **API 与 SQL**：API 行为变更验证受影响的真实 Hono/HTTP 路径及必要正反例，不要求遍历所有接口；没有修改持久化、查询语义、数据库结构或 SQL 的小任务，不强制建库、迁移或跑全量 SQL。涉及 schema/迁移、持久化一致性、事务、金额、库存、幂等、并发、社区隔离、登录鉴权、OAuth 或 CSRF 时，必须用对应真实运行边界（必要时 SQLite + HTTP）验证成功与关键失败路径，不能以 Mock 替代被测能力。
- **发布与责任边界**：仅当路由、资源 base、Pages 或部署行为受影响时才验证相应的 dev/`/prod/` 构建路径；全链路 E2E/真机验收由发布风险和实际环境决定，不随每张 PR 机械重复。施工交付须列明运行过的命令、结果及验证缺口；维护者决定低风险缺口能否接受，关键安全/资金/持久化风险不得因紧迫而假定通过。
- CI 绿不等于验收通过，未验证不得宣称通过。外部微信/商城/支付依赖未具备真实凭证时，记录阻塞项，不以 mock 冒称真实环境验收。
- 三创 Worker 只允许针对明确授权的 Open Issue 施工并交付 Draft PR；无自行合并、关卡、晋级或发布权。
