# 三创 · 本地生活（Local Life）

独立可维护的本地生活前端项目。**当前阶段是工程初始化，不是业务功能迁移完成。**

## 技术栈

- React + TypeScript / Vite
- Tailwind CSS（官方 Vite 插件）
- React Router（静态 Pages 使用 HashRouter，避免刷新深链接返回 404）
- npm lockfile；Node.js 22

## 本地开发

```bash
npm ci
npm run dev
npm run check
npm run build
```

构建产物在 `dist/`。当前只有工程首页、工程信息页和 404 兜底页；**不代表 V0.3 功能已经实现**。

## 仓库及环境

- `main`：默认分支，工作流入口和基线记录；**不是生产环境**。
- `feat/*` → `dev` → `test` → `prod`：依三创组织环境约定。
- `dev`：集成分支；GitHub Pages 可发布**开发预览**，不等于生产发布。
- `test`、`prod`：暂不配置自动部署。
- 校验：`npm run check`（Oxlint + TypeScript + Vite Build）。

## 历史原型与产品决策

历史 V0.3 仍在 [base-prototype 的 demo/local-life 分支](https://github.com/sanchuang-dev/base-prototype/tree/demo/local-life)，原展示链接为
https://sanchuang-dev.github.io/base-prototype/local-life/ 。

历史页面与 PRD **只作为产品讨论输入**；本轮减法/加法尚未定稿，不机械复制旧 UI、不擅自改旧链接或统一展厅。以后迁移发布入口须独立决策和验收，消除双重源码维护。

## 自动化与牛马

CI 对环境分支与 PR 执行真实构建校验。免费 Worker 使用 [三创组织标准接入](https://github.com/sanchuang-dev/.github/blob/main/docs/engineering/free-worker-onboarding.md)，须在独立审查 PR 中启用仓库调用器，完成本仓库真实 Issue → Draft PR 验证后才能称为可用。牛马只负责实现和交付 Draft PR，不具备验收、合并或发布权限。
