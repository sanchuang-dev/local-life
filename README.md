# 三创 · 本地生活（Local Life）

本地生活的 **Pre-MVP 真实工程仓库**：pnpm workspace 管理居民移动端 H5、运营管理台与 Node API。当前已有可运行的身份/权限底座，但尚不是完整的活动运营和交易系统。

## 目录

```text
apps/web/            居民移动端 H5（React + Vite + Tailwind，保留已评审页面）
apps/admin/          管理台（React + Vite + Ant Design 6，登录/账户/社区/居民范围）
apps/api/            API（Node 22+ + Hono + Drizzle ORM + SQLite）
packages/contracts/  API 与客户端共享的 zod DTO/校验 schema
docs/engineering/    工程边界、身份权限、安全配置与验证证据
```

## 一键本地启动（Node.js 22+）

在仓库根目录执行：

```bash
pnpm dev:local
```

该命令会检查端口、依锁文件安装依赖，首次自动创建 `apps/api/.env.local`，初始化并迁移项目内 `.data/local-life-dev.sqlite`，然后启动 H5、管理台与 API。**重复启动不会清库，也不会覆盖已有 `.env.local` 或 `.env`。** 在启动命令所在的终端按 Ctrl+C 停止。

- 端口以当前 `apps/api/.env.local` 为准；下方 URL 对应自定义样例 `4081 / 5222 / 5223`，新安装默认 `4080 / 5173 / 5174`
- 居民 H5：`http://localhost:5222/local-life/#/me`
- 管理台：`http://localhost:5223/`
- API：`http://127.0.0.1:4081/healthz`
- SQLite：`.data/local-life-dev.sqlite`（位于项目内，Git 忽略）

首次需要管理员时，在另一个终端执行 **`pnpm admin:local`**，按提示输入用户名、显示名称和至少 12 位密码。密码不会显示，没有固定的默认管理员。已有管理员时不会重复创建。

只需初始化或升级数据库时使用 **`pnpm db:local:setup`**；原有 `pnpm dev` 保持不变，供自定义环境开发使用。

**本地端口只改一个地方：`apps/api/.env.local`**：

```dotenv
PORT=4081         # API
WEB_PORT=5222     # 居民 H5
ADMIN_PORT=5223   # 管理台
```

改完重新运行 `pnpm dev:local`。启动器从以上三项推导端口检测、Vite 监听、API 代理、`TRUSTED_ORIGINS` 及 `WEB_BASE_URL`，无需在 Vite/其他脚本里重复修改。三项必须是不同的合法端口，冲突直接报错。`TRUSTED_ORIGINS` 和 `WEB_BASE_URL` 不应再写在本地专用配置中（旧配置存在时将被启动器计算值覆盖）。裸 `pnpm dev` 仍使用共享默认端口，用于自定义开发，并不自动读取 `.env.local`。


`dev:local` 单独读取 `apps/api/.env.local`，**不读取或覆盖 `apps/api/.env`**。启动器还会移除父进程导出的 API 环境配置，避免误连线上数据库或加载微信密钥。默认仅开发模式开放居民测试登录（`AUTH_DEV_ENABLED=true`），可在 `.env.local` 中改为 `false`。真实微信 OAuth 仍需真实公众号授权配置；GitHub Pages 只是静态 H5。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm dev            # web(5173) + admin(5174) + api(127.0.0.1:4080)
pnpm check          # oxlint + typecheck + API 测试 + 全部构建
```

单独启动：`pnpm dev:web` / `pnpm dev:admin` / `pnpm dev:api`。

- 居民 H5：http://localhost:5173/local-life/
- 管理台：http://localhost:5174/
- API 健康检查：http://127.0.0.1:4080/healthz
- H5 与管理台开发服务器均将 `/api/*` 同源代理到 API；生产部署需要反向代理提供相同路径，不依赖 Vite 代理。

## 首次初始化管理员

先启动 API 数据库迁移，然后在交互式终端执行：

```bash
pnpm --filter @sanchuang-dev/local-life-api bootstrap-admin
```

命令会交互式收集登录名、显示名称和至少 12 位初始密码，密码输入不回显。若已有管理员，命令会拒绝再次初始化；后续运营员/网格员由管理员在后台创建。数据库默认位于仓库根目录 `.data/local-life.sqlite`，该目录已加入忽略规则。

## API 配置

首次本地开发先执行 `cp apps/api/.env.example apps/api/.env`。需要使用开发居民测试登录时，将本地 `.env` 中的 `AUTH_DEV_ENABLED` 改为 `true`；默认关闭。公众号 AppID/AppSecret 在管理台「系统管理 → 微信公众号」保存、验证并启用（服务端用 `WECHAT_CONFIG_MASTER_KEY[_FILE]` 加密）；OAuth 回调地址由 `WEB_BASE_URL` 的 origin + `/api/auth/wechat/callback` 推导。未启用配置或主密钥缺失时，H5 会明确显示当前不可用，不会伪造登录成功；真实微信真机授权仍需真实凭证单独验收。

生产环境还需设置 `TRUSTED_ORIGINS`、HTTPS Cookie 与同源 `/api` 反向代理。开发居民测试登录默认关闭，只能在非生产环境显式设置 `AUTH_DEV_ENABLED=true`；配置校验会拒绝生产开启。

## 后台 UI 基建与登录

管理台使用 Local Life 绿色主题的 AppShell（分组导航、菜单搜索、工作页签与响应式抽屉），以及复用的 DataPanel（行内筛选、高级检索弹窗、排序/分页意图、列设置与双视图）。**登录未通过时不渲染受保护工作区**；登录后顶部显示真实用户、角色和退出入口。当前可用的社区/账户管理在 `/#/communities`；旧 `/#/users` 自动转到该入口。API 连接诊断在 `/#/system/runtime`；`/#/system/components` 只作带标识的开发组件预览，不是业务数据。

详情参见 [后台基建与身份集成](docs/engineering/admin-foundation.md)。

## 当前已实现

- 居民主用户 UUID、微信身份映射（appid + openid 唯一；unionid 可选）、重复授权复用同一用户。
- 微信网页 OAuth start/callback：一次性 state、浏览器 nonce、10 分钟有效期和重放拒绝；真实公众号凭证尚待配置及实测。
- 后台管理员/运营员/网格员账号、scrypt 密码哈希、登录/退出、服务端会话、CSRF、登录失败限流。
- 社区与后台账号管理；管理员可创建社区、创建运营员/网格员、分配社区；也可将已完成微信授权的居民用户关联为后台身份。
- 社区居民只读列表；运营员/网格员只能读取被分配社区，服务端执行权限校验；不向 CRM 暴露 openid 或微信凭证。
- 开发居民测试登录有明确开关，生产环境禁止启用。
- SQLite + Drizzle schema/migrations；共享 DTO 契约；结构化错误与 requestId。

## 尚未实现 / 不得误称已上线

- **活动发布与 H5 公开读取**（LL-MVP-003）、**三人团与邀请归属**（LL-MVP-004）、**网格员 CRM/业务单人工核验**（LL-MVP-005）已有代码合入 `dev`，但尚未部署到在线 MVP；外部真实业务成交与履约不能因此宣称可用。
- 网格员 CRM 已有跟进、线索和业务单人工核验代码，但不代表广电运营商正式受理/开通能力已经接通。
- CRMEB 商品/订单接入、支付、奖励履约、空中分账。
- 真实微信公众平台授权验收（取决于账号资质、授权域名、AppID/AppSecret 和线上回调配置）。
- 完整客户 CRM、手机号实名验证、短信、密码找回、后台账号停用/重置等管理能力。
- 业务域名部署、生产备份恢复、真机与真实业务端到端验收。

## Pages 与环境边界

GitHub Pages 只发布静态居民 H5，不包含管理台与 API。Pages 演示站点没有真实账户后端；真实身份流程需连接部署后的 API。不要把静态预览地址当作业务环境。

- `main`：默认分支与工作流入口，不是生产环境。
- 业务卡：`feat/*` → `dev`；受控真实服务的**在线 MVP 验收例外**：`dev` → `mvp`（独立晋级 PR、维护者验收），居民域名 `https://local.proto.3cgroup.cn/`、后台域名 `https://local-admin.proto.3cgroup.cn/`，两个站点的 `/api/*` 均代理至同一 Hono/SQLite，`mvp` 合并后自动部署（首次主机接入须独立授权），**目前尚未部署成功**，详见 [在线 MVP 环境决策](docs/engineering/mvp-online-preview.md)。
- `test` / `prod`：继续承担原有 GitHub Pages 静态展示路线；不能与在线 MVP 或正式商用生产环境混称。
- `dev`：集成分支；GitHub Pages 开发预览 https://sanchuang-dev.github.io/local-life/。
- `prod`：演示版本源码；GitHub Pages 展示 https://sanchuang-dev.github.io/local-life/prod/。

## 验证

- `pnpm install --frozen-lockfile`
- `pnpm check`：Oxlint、TypeScript、API 单元/集成测试和三个子项目构建。
- 身份测试覆盖后台登录、账户创建、社区越权拒绝、CSRF、登出、开发登录隔离、微信 OAuth state/nonce/重放与重复授权。
- CI 通过只证明静态检查与构建；真实微信授权、浏览器/真机交互、部署与恢复仍需独立验收。

详细设计见 [身份与权限实现说明](docs/engineering/identity-auth.md) 与 [Pre-MVP 工程说明](docs/engineering/monorepo.md)。
