# Pre-MVP 工程基座（LL-MVP-001）

> 对应 Issue [#57](https://github.com/sanchuang-dev/local-life/issues/57)。本文记录**已经落地**的目录、命令和边界，不写未来架构规划。

## 1. 结构

| 路径 | 角色 | 是否发布 |
| --- | --- | --- |
| `apps/web` | 居民移动端 H5，原根目录 `src/`、`public/`、Vite 配置原样迁入 | 是，GitHub Pages 根路径 `/local-life/` |
| `apps/admin` | 管理台工程壳：Ant Design 6 布局 + 明确未实现模块 | 否 |
| `apps/api` | Hono API：配置校验、结构化错误、`GET /healthz` | 否 |
| `packages/contracts` | 共享 zod schema/类型（健康检查、错误信封、路由常量） | 作为 workspace 依赖 |

根目录保留 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`AGENTS.md`、`README.md`、`docs/`、`.github/`。`package-lock.json` 已移除，单锁文件为 `pnpm-lock.yaml`。

## 2. 为什么这样切

- **H5 不重画**：迁移只改路径，不改页面实现、路由表、Tailwind 样式和图片引用；`import.meta.env.BASE_URL` 继续保证 `/local-life/` 与 `/local-life/prod/` 的资源解析。
- **管理台/API 是骨架而非假系统**：所有未实现模块渲染「未实现」页；API 只有健康检查和错误处理，没有业务表、假账号或 Mock 成功。
- **契约唯一**：`packages/contracts` 是 API 与客户端的 DTO 事实源。API 用 `healthResponseSchema.parse()` 校验自己的响应，管理台用同一 schema 校验响应；任何一侧漂移都会显式失败。
- **不引入多余工具**：没有 Nx/Turborepo、没有状态管理、没有业务数据库；workspace 用 pnpm 原生能力 + 根脚本排序。

## 3. 启动与端口

| 服务 | 命令 | 地址 |
| --- | --- | --- |
| 全部 | `pnpm dev` | web 5173 / admin 5174 / api 4080 |
| H5 | `pnpm dev:web` | http://127.0.0.1:5173/local-life/ |
| 管理台 | `pnpm dev:admin` | http://127.0.0.1:5174/ |
| API | `pnpm dev:api` | http://127.0.0.1:4080/healthz |

`pnpm dev` 先构建 `packages/contracts`（admin/API 依赖其 `dist`），再并行启动三个服务。管理台 `/api/*` 由 Vite 代理去掉 `/api` 前缀转发到 4080，因此浏览器侧是同源请求。

## 4. API 边界

已实现：

- `GET /healthz` → `{ status, service, version, uptimeSeconds, timestamp }`，响应先过共享 schema。
- 每个请求生成 `x-request-id`，访问日志为单行 JSON。
- 404/500 返回 `{ error: { code, message, requestId } }`；500 不向客户端泄露堆栈。
- 启动配置 `NODE_ENV` / `HOST` / `PORT` 用 zod 校验，非法值直接失败退出。

明确未实现：登录/鉴权、业务路由、SQLite/Drizzle、迁移、CORS 策略、限流、部署。后续数据库只允许在 `apps/api` 内引入，先评审 schema 与敏感数据边界，不预建空 repository/domain 层。

## 5. GitHub Pages 双预览

`.github/workflows/preview.yml` 保持单站点原子发布：

1. 同时 checkout `dev`（`dev-source`）与 `prod`（`prod-source`）。
2. `dev-source`：`pnpm install --frozen-lockfile` + `pnpm check`，产物在 `apps/web/dist`。
3. `prod-source`：若已是 workspace（`pnpm-lock.yaml` + `apps/web/package.json`），用 `pnpm --filter @sanchuang-dev/local-life-web build:prod-preview`；否则回退旧单包 `npm ci` + `npx vite build --base /local-life/prod/`。**兼容路径只为 prod 晋级前服务，晋级后应删除**。
4. 合并 `apps/web/dist` 到根、prod 产物到 `/prod/`，断言两份 `index.html` 的 `/local-life/assets/`、`/local-life/prod/assets/` 引用后上传。

管理台与 API 不进入 Pages 产物；静态站点不会把 API 伪装成可用。

## 6. 验证基线

- `pnpm install --frozen-lockfile`
- `pnpm check`：Oxlint → contracts 构建 + 各包 typecheck → API 测试（node:test）→ 拓扑构建
- 真实 HTTP：`curl http://127.0.0.1:4080/healthz` 与 404 错误信封
- 浏览器：375 × 812 与 320 宽度检查首页、五 Tab、银发活动页深链接；Pages 双构建按 `/local-life/` 前缀本地静态服务校验
- 证据：`docs/engineering/evidence/ll-mvp-001/`

## 7. 已知边界与风险

- `prod` 分支在晋级前仍是旧单包布局，Pages 工作流保留兼容分支；需在 prod 晋级评审时删除。
- 管理台与 API 只在本地运行，没有部署、鉴权或生产配置；CI 无法证明真实浏览器交互。
- 迁移提交会保留旧 `docs/migration/` 历史文档与脚本，其中根 `src/` 路径描述的是迁移当时状态，不代表当前目录。
