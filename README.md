# 三创 · 本地生活（Local Life）

本地生活的 Pre-MVP 工程仓库：pnpm workspace 管理**居民移动端 H5**、**管理台**与 **Node API**。当前交付的是可运行、可审查的工程基座，不是已上线的业务系统。

## 目录

```text
apps/web/            居民移动端 H5（React + Vite + Tailwind，原已评审页面）
apps/admin/          管理台（React + Vite + Ant Design 6，统一 AppShell + 待建设业务入口）
apps/api/            API（Node 22 + Hono + zod，GET /healthz）
packages/contracts/  共享 DTO/校验 schema（zod）
docs/engineering/    工程边界与验证证据
```

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm dev            # 并行启动 web(5173) + admin(5174) + api(127.0.0.1:4080)
pnpm check          # oxlint + typecheck + Admin/API 测试 + 全部构建
```

单独启动：`pnpm dev:web` / `pnpm dev:admin` / `pnpm dev:api`。API 健康检查：

```bash
curl -s http://127.0.0.1:4080/healthz
# {"status":"ok","service":"local-life-api","version":"0.0.0","uptimeSeconds":1,"timestamp":"..."}
```

管理台通过 Vite 代理请求 `/api/healthz`，接口不可达时会显示真实错误，不会伪造成功状态。

管理台已具备统一外壳（左侧分组导航、菜单搜索、可折叠侧栏、路由同步工作页签、顶部工具区、页面标题区与响应式布局），详见 [管理台基础框架](docs/engineering/admin-foundation.md)。真实登录与鉴权仍由 #58 提供，本分支不伪造登录态。

## 当前边界（重要）

- **已实现**：H5 现有页面与路由原样保留；workspace 脚本与单锁文件；Hono API 的配置校验、结构化错误、`/healthz`；管理台统一 AppShell（分组导航/搜索/页签/主题/响应式）；共享契约包；dev/prod 双 Pages 构建。
- **未实现**：管理员登录/权限、任何业务 CRUD、SQLite/Drizzle 数据库、微信 OAuth、真实支付/订单/设备。管理台对应入口均显式标注「待建设」；统一身份与路由守卫依赖 #58，尚未合并。
- **不发布**：管理台与 API 不进 GitHub Pages；Pages 只有静态 H5，不冒充在线 API。
- **prod 分支**在晋级前仍是旧单包布局，Pages 工作流保留有注释的兼容构建路径；`dev` 完成晋级后才会统一。

详见 [工程基座说明](docs/engineering/monorepo.md) 与 [AGENTS.md](AGENTS.md)。

## 测试与证据

- `pnpm check` 覆盖 Oxlint、TypeScript、API 契约/错误测试与三个子项目构建。
- UI 回归使用真实浏览器在 375 × 812 与 320 宽度验证，证据见 `docs/engineering/evidence/`。
- CI 通过只证明静态检查与构建；设备/浏览器交互与真实部署仍需维护者实测。

## 仓库与环境

- `main`：默认分支与工作流入口，**不是生产环境**。
- `feat/*` → `dev` → `test` → `prod`：依三创组织环境约定；本阶段只向 `dev` 提 Draft PR。
- `dev`：集成分支；GitHub Pages 开发预览 https://sanchuang-dev.github.io/local-life/ 。
- `prod`：演示版本源码；GitHub Pages 展示 https://sanchuang-dev.github.io/local-life/prod/ 。
- Pages 发布：`.github/workflows/preview.yml` 将 `dev` 构建到根目录、`prod` 以 `--base /local-life/prod/` 构建到 `prod/`，合并为一次原子发布。`prod` 更新通过 `workflow_dispatch` 触发允许部署的 `dev` 工作流。
- 校验：`.github/workflows/ci.yml` 使用 pnpm 执行 `pnpm check`。

## 历史与产品决策

历史 V0.3 仍在 [base-prototype 的 demo/local-life 分支](https://github.com/sanchuang-dev/base-prototype/tree/demo/local-life)，原展示链接为 https://sanchuang-dev.github.io/base-prototype/local-life/ 。历史页面、PRD 与 `docs/migration/` 只作为讨论与迁移记录，不代表当前实现约定。

## 自动化与牛马

CI 对环境分支与 PR 执行真实安装/检查/构建。三创 Worker 只负责实现和交付 Draft PR，不具备验收、合并、关闭 Issue 或发布权限。
