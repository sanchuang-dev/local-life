# 本地生活 · 施工规约

本仓库继承 [三创组织宪法](https://github.com/sanchuang-dev/.github/blob/main/AGENTS.md)。施工前读取组织现行规则、本文件与当前任务契约。本文件只规定本项目特例，不复制组织的派卡、权限和验收流程。

## 1. 阶段与定位

- 自 [Issue #57](https://github.com/sanchuang-dev/local-life/issues/57) 起，本仓库从「纯静态前端原型」进入 **Pre-MVP 真实工程基座**：pnpm workspace + 居民 H5 + 管理台 + Node API。
- **H5 仍是被评审过的演示前端**：已确认的居民页面、视觉和路由不得在本阶段重画或重写；真实登录、支付、订单和设备接入仍未实现。
- 管理台与 API 目前是工程骨架，不是可用业务系统。未实现的能力必须显式标注「未实现」，不得用 Mock 成功、写死数据或假鉴权伪装。
- 产品仍在做减法/加法，**新版功能与 Tab 尚未定稿**；旧 [V0.3](https://github.com/sanchuang-dev/base-prototype/blob/demo/local-life/docs/PRD-V0.3.md) 只是历史参考。

## 2. 技术栈与目录

固定栈：Node.js 22、pnpm 10、React 19 + TypeScript + Vite、Tailwind CSS 4、React Router（HashRouter）、Lucide；管理台 Ant Design 6；API 为 Hono + zod。实际版本以各 `package.json` 与 `pnpm-lock.yaml` 为准。

```text
apps/web/       # 居民移动端 H5（原根目录 src/ 原样迁入，构建 base /local-life/）
apps/admin/     # 管理台空布局（Ant Design 6，开发端口 5174，不发布到 Pages）
apps/api/       # Node 22 + Hono 服务（默认 127.0.0.1:4080，GET /healthz）
packages/contracts/  # 共享 zod schema 与类型；API 与客户端不得各自复制 DTO
docs/engineering/    # 工程边界、验证证据与迁移说明
```

- 根目录只放 workspace 配置、锁文件、文档和工作流；业务代码进 `apps/*`，跨端契约进 `packages/*`。
- 不引入 Nx / Turborepo / 微服务框架；不为「以后可能用到」预建空领域层。
- 路由统一走 React Router；H5 继续用 `HashRouter` 兼容 GitHub Pages 深链接，不新增第二套路由逻辑。
- TypeScript 明确约束业务数据与 Props，不用无边界 `any`；后端代码保持 strict。

## 3. 命令与端口

```bash
pnpm install --frozen-lockfile   # 安装（CI/验收必须用 frozen lockfile）
pnpm dev                         # 并行启动 web + admin + api（先构建 contracts）
pnpm dev:web / dev:admin / dev:api
pnpm check                       # oxlint + typecheck + API 测试 + 全量构建
pnpm build                       # 拓扑顺序构建全部 workspace
```

- web：5173（Vite 默认），资源 base 为 `/local-life/`。
- admin：5174，`/api/*` 由 Vite 代理到 `127.0.0.1:4080`。
- api：`127.0.0.1:4080`，`GET /healthz` 返回契约校验后的 JSON；404/500 使用统一结构化错误。

## 4. 前端规则

- **移动端优先**：以 375 × 812 为主要查看基准，兼顾 320 等窄屏、触控面积、滚动与底部安全区；不得为了桌面效果损坏移动端。
- 设计依据按优先级：**当前用户确认 > 新版已确认原型/截图 > 已验收页面 > 旧版 V0.3 参考 > 实现者推断**。视觉基线在 [design.md](design.md)。
- 保留 H5 现有页面与交互；新增页面放 `apps/web/src/pages/`，复用组件放 `components/`，样例数据放 `mocks/`。图片引用继续通过 `import.meta.env.BASE_URL`，不得写死会绕过 Pages base 的绝对路径。
- 管理台只允许「真实空布局 + 明确未实现入口」。登录、权限、内容/活动/用户 CRUD 必须由后续独立 Issue 授权，本阶段不实现也不伪造。
- 真 API 出现后由 `services/` 收敛访问入口，页面不散写接口 URL 或 `fetch`。加载、空、错误、禁用状态必须如实展示；禁止用 Mock 成功掩盖接口失败。

## 5. API 与契约

- 配置在启动时用 zod 校验，非法值必须让进程失败，不许静默回退到看似健康的默认值。
- 所有对外错误使用 `packages/contracts` 的 `{ error: { code, message, requestId? } }` 结构。
- 新增 DTO/schema 一律先改 `packages/contracts`，API 用 schema 校验自己的响应；客户端不得复制一份类型真相。
- 本阶段**不建业务数据库**。后续 SQLite + Drizzle 只允许在 `apps/api` 内落地，并在单独 Issue 中评审 schema、迁移和敏感数据边界。
- GitHub Pages 是静态站点，不得把 API 伪装成已部署可用；管理台和 API 不进入 Pages 产物。

## 6. 分支、验证与牛马

- `main` 是默认分支和工作流入口，**不是生产分支**；业务工作 `feat/* → dev → test → prod`。本阶段只允许从最新 `dev` 开分支并向 `dev` 提交 Draft PR。
- 小步施工，只修改任务范围；不顺手迁移旧页面、重构无关模块或删除历史证据。
- 提交前至少运行 `pnpm install --frozen-lockfile` 与 `pnpm check`（Oxlint + TypeScript + API 测试 + 全部构建）。改 UI/路由还必须用真实浏览器验证 375 与 320 宽度下的入口、返回、图片和深链接；改 API 必须发真实 HTTP 请求；改 Pages 必须验证 dev 与 `/prod/` 两份构建的 base 路径。CI 绿不等于验收通过，未验证不得宣称通过。
- 三创 V2 免费 Worker 只允许针对明确授权的 Open Issue 施工并交付 Draft PR；牛马无自行合并、关卡、晋级或发布权。**Issue → Draft PR 的真实 E2E 仍待维护者验收**。
