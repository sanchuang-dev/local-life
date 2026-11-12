# Pre-MVP 工程基座与身份域

> 本文延续 LL-MVP-001（Issue #57）的工程迁移记录，并补充 LL-MVP-002（Issue #58）已经落地的身份与权限底座。本文只记录当前代码事实。

## 1. Workspace 结构

| 路径 | 角色 | 是否发布 |
| --- | --- | --- |
| `apps/web` | 居民移动端 H5，保留已评审页面、活动/奖励/本地商品订单入口与 HashRouter | 是，GitHub Pages 静态预览 |
| `apps/admin` | 管理台：身份登录、活动/CRM、商品订单、业绩对账与系统配置 | 否 |
| `apps/api` | Hono API、Drizzle/SQLite、认证与社区范围鉴权 | 否 |
| `packages/contracts` | API 与客户端共享 zod schema、DTO 和路由常量 | workspace 依赖 |

根目录保留 workspace 配置、单一 `pnpm-lock.yaml`、规约和文档。没有 Nx/Turborepo，也不把 PHP CRMEB 商城源码迁入此 monorepo。

## 2. 本地启动与同源 API

| 服务 | 命令 | 地址 |
| --- | --- | --- |
| 一键本地启动（推荐） | `pnpm dev:local` | 自动安装依赖、初始化/迁移 `.data/local-life-dev.sqlite`，启动三端 |
| 全部（自定义环境） | `pnpm dev` | web 5173 / admin 5174 / api 4080 |
| H5 | `pnpm dev:web` | http://localhost:5173/local-life/ |
| 管理台 | `pnpm dev:admin` | http://localhost:5174/ |
| API | `pnpm dev:api` | http://127.0.0.1:4080/healthz |

H5 与管理台开发服务器均把 `/api/*` 去掉前缀后代理到 API 实际端口，浏览器侧保持各自同源。`pnpm dev:local` 从 `apps/api/.env.local` 的 `PORT`、`WEB_PORT`、`ADMIN_PORT` 唯一读取端口并推导受信任 Origin、Vite 监听与代理目标；裸 `pnpm dev` 则使用 `scripts/local-ports.mjs` 中的默认值。生产部署必须用反向代理提供同样的 `/api` 路径；`TRUSTED_ORIGINS` 是 CSRF Origin allowlist，不会自动启用 CORS。

## 3. API 与持久化

- `GET /healthz` 返回共享 `healthResponseSchema` 校验后的 payload。
- 每个请求生成 `x-request-id`；404/500 返回共享结构化错误信封。
- SQLite + Drizzle 仅在 `apps/api` 内：schema 位于 `src/db/schema.ts`，迁移位于 `db/migrations/`，服务启动时自动应用迁移。
- 裸 API 的默认数据库路径为仓库根目录 `.data/local-life.sqlite`；`pnpm dev:local` 使用 `.data/local-life-dev.sqlite`。两者均由 `.gitignore` 忽略；生产环境必须显式配置持久卷/备份策略。
- `packages/contracts` 是 API、H5、管理台共享 DTO 的唯一来源；客户端不得另造相同接口的数据结构。

## 4. 身份与权限（LL-MVP-002）

- `users.id` 是稳定平台 UUID；微信身份以 `(appid, openid)` 唯一映射，unionid 可选。
- 后台账号 `staff_accounts.user_id` 关联平台用户；管理员可将已完成微信授权的居民账户关联为运营员/网格员，冲突拒绝，不静默合并。
- 角色：`admin`、`operator`、`grid_worker`。管理员可访问全部社区；运营员/网格员仅能访问分配的社区。
- Cookie session 数据库存 token hash；写请求要求 CSRF token 和可信 Origin；后台密码使用 scrypt；登录失败限流；关键账户/社区操作有审计记录。
- 微信 OAuth 具备 start/callback、state、浏览器 nonce、过期和重放拒绝。真实公众号凭证和线上回调仍待配置/实测。
- 开发居民测试登录默认关闭；仅非生产环境显式 `AUTH_DEV_ENABLED=true` 才启用，生产配置禁止开启。
- 管理台可登录、创建社区、创建运营员/网格员、分配社区并查看授权范围内的居民列表。居民列表不暴露 openid、手机号或微信凭证。

完整配置、接口和安全说明见 [identity-auth.md](identity-auth.md)。

## 5. 当前业务边界（2026-11-12 按 `dev` 代码核对）

以下能力在 `dev` 已包含真实 schema、API、页面或 adapter，并有对应测试/证据：

- 活动创建、发布、暂停与居民公开读取（LL-MVP-003）；
- 三人团与网格员 CRM（LL-MVP-004/005）；
- 签到、团队奖励资格、奖品库存与一次性核销（LL-MVP-006）；
- CRMEB adapter、本地商品目录与居民订单（LL-MVP-007/010）；
- 统一经营流水、对账与结算（LL-MVP-008 及后续 SET 卡）；
- 消费返券与抽奖（PUR/LOT 卡）。

这些是**代码事实，不等于 `mvp` 已部署，也不等于真实微信、CRMEB 或支付依赖已经配置可用**。以下事项不能由 `dev` 代码存在推导为可用：在线支付、自动分账/自动佣金、CRMEB 真实生产凭证与完整商城履约、真实公众号 OAuth 真机验收、线上部署与备份恢复验收。模块边界以 [rewards-fulfillment.md](rewards-fulfillment.md)、[ll-mvp-008-ledger-reconciliation.md](ll-mvp-008-ledger-reconciliation.md)、[crmeb-adapter.md](crmeb-adapter.md)、[participation-teams.md](participation-teams.md)、[ll-mvp-005-crm.md](ll-mvp-005-crm.md)、[activity-draw-execution.md](activity-draw-execution.md) 及当前代码为准。

CRMEB 继续作为独立仓库/系统，通过 adapter 与订单契约接入；不将 PHP 商城源码复制进 workspace。

## 6. GitHub Pages 双预览

GitHub Pages 只发布静态 H5：

1. `dev` 构建到站点根目录，base 为 `/local-life/`。
2. `prod` 构建到 `/prod/`，base 为 `/local-life/prod/`。
3. 管理台与 API 不进入 Pages 产物；Pages 上没有真实账户 API，因此账户区域应如实显示服务不可用。

`prod` 晋级 workspace 前，Pages workflow 仍保留旧单包兼容构建路径；该路径的删除条件是 prod 分支完成 monorepo 晋级并通过 Pages 验收。

## 7. 验证

按 [AGENTS.md §6](../../AGENTS.md) 的按风险分层口径执行：低风险文案、样式、局部组件或纯文档改动至少运行 `git diff --check` 并核对引用路径；涉及 API 行为、金额、认证、迁移、持久化、并发或结算时，使用真实 HTTP/SQLite 边界及必要正反例，不以 Mock 替代被测能力。`pnpm check` 仍是全量质量检查，按现有 CI/分支门禁执行，不再要求每个低风险施工重复跑完。

真实微信授权、生产 HTTPS Cookie、部署、备份恢复及真机验收必须在真实环境完成。
