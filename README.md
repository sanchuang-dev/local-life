# 三创 · 本地生活（Local Life）

独立可维护的本地生活前端项目。**当前阶段为可演示的前端原型，不是已接入真实业务的生产系统。**

## 技术栈

- React + TypeScript / Vite
- Tailwind CSS（官方 Vite 插件）
- React Router（静态 Pages 使用 HashRouter，避免刷新深链接返回 404）
- Lucide React（通用图标）
- npm lockfile；Node.js 22

## 本地开发

```bash
npm ci
npm run dev
npm run check
npm run build
```

构建产物在 `dist/`。V0.3 的 16 个历史界面已全部迁入 React 演示：首页、广电、社区、健康、惠生活与“我的”均可浏览。底部导航已按本轮演示信息架构归位为**首页 / 社区 / 健康 / 惠生活 / 我的**五个业务模块；旧「发现」技术路由目录已退场（`/discover` 落到 404），「我的」页不再展示原型演示导航。详见 [C06 迁移回归矩阵](docs/migration/c06-regression.md) 与 [I03 导航归位记录](docs/migration/i03-navigation.md)。未接入的服务、订单、支付、设备与账号均明确标注演示，不会发起真实业务。

**前端施工规约**：[AGENTS.md](AGENTS.md)。参照卡博士 Web 的页面、组件、数据边界，但不照搬 WebView / JSBridge / Com Design 规范。

## 仓库及环境

- `main`：默认分支，工作流入口和基线记录；**不是生产环境**。
- `feat/*` → `dev` → `test` → `prod`：依三创组织环境约定。
- `dev`：集成分支；GitHub Pages 开发预览：https://sanchuang-dev.github.io/local-life/ 。
- `test`：验收集成分支，CI 检查，不单独部署。
- `prod`：正式演示版本源码，GitHub Pages 展示：https://sanchuang-dev.github.io/local-life/prod/ 。
- **部署机制**：单仓库 Pages 只有一个站点，`.github/workflows/preview.yml` 将 `dev` 打包到根目录，将 `prod` 以 Vite 基路径 `/local-life/prod/` 独立打包到 `prod/`；两份构建共用一次 Pages 发布。它们是演示站点，不代表真实支付/订单/设备服务已上线。URL 在 Pages 工作流首次成功完成后生效。
- 校验：`npm run check`（Oxlint + TypeScript + Vite Build）。

## 历史原型与产品决策

历史 V0.3 仍在 [base-prototype 的 demo/local-life 分支](https://github.com/sanchuang-dev/base-prototype/tree/demo/local-life)，原展示链接为
https://sanchuang-dev.github.io/base-prototype/local-life/ 。

历史页面与 PRD **只作为产品讨论输入**；本轮减法/加法尚未定稿，不机械复制旧 UI、不擅自改旧链接或统一展厅。以后迁移发布入口须独立决策和验收，消除双重源码维护。

## 自动化与牛马

CI 对环境分支与 PR 执行真实构建校验。免费 Worker 已通过 [PR #1](https://github.com/sanchuang-dev/local-life/pull/1) 接入当前 [三创组织标准](https://github.com/sanchuang-dev/.github/blob/main/docs/engineering/free-worker-onboarding.md)，但本仓库 Issue → Draft PR 真实 E2E **尚未验证**。牛马只负责实现和交付 Draft PR，不具备验收、合并或发布权限。
