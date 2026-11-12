# LL-UI-006 CRM 二级 Tab 浏览器证据

验证对象：`apps/admin` 的 `/customers` 页面（客户与业务单）二级导航从灰色内容区迁入白色 `PageHeader`，并以 URL `?view=leads|orders` 作为唯一真相源。

- 运行方式：本地 `apps/api` + `apps/admin`（Vite）真实服务，端口取自 `apps/api/.env.local`（API `127.0.0.1:4090`、Admin `http://localhost:5191`），通过真实登录会话调用 `/api/admin/crm/*`。
- 浏览器：系统 Chrome（headless=new），通过 DevTools Protocol 驱动（Node 内置 WebSocket，无额外依赖）；每个场景同时执行 DOM/计算样式断言并截图。
- 数据：仅本地 SQLite `.data/local-life-dev.sqlite` 中的**演示数据**（25 条线索、3 张业务受理单，经仓库 CRM service 函数写入，不提交、不代表生产数据）。
- 断言汇总：`browser-results.json`（全部检查项、几何数据、请求 URL）。最近一次运行：**29/29 通过**（2026-11-05，Windows Chrome headless）。
- 管理员：本地 `bootstrap-admin` 机制创建的 `verify.admin`；headless 环境无法使用交互式 TTY 隐藏输入，故以本地一次性脚本复用同一套 `hashPassword` + 表结构创建，仅存在于被 Git 忽略的 `.data` 目录。

## 覆盖清单

| # | 验收场景 | 证据 |
| --- | --- | --- |
| 1 | 1440 默认 `/customers`：Tabs 位于白色 sticky 页头，活动 Tab「客户线索」，灰色内容区从筛选器/列表开始 | `01-leads-1440.png`；几何断言：header 背景 `rgb(255,255,255)`、Tab 导航底边距页头底边 1px 内、antd 导航分隔线为 0、内容区背景 `rgb(245,247,247)` |
| 2 | `/customers?view=orders` 直达「业务受理单」 | `02-orders-deeplink-1440.png` |
| 3 | 刷新后仍保持「业务受理单」 | `03-orders-refresh-1440.png` |
| 4 | 浏览器后退 / 前进在两视图间正确回放 | `04a-back-leads-1440.png`、`04b-forward-orders-1440.png` |
| 5 | 无效参数 `?view=bogus` 稳定回退「客户线索」 | `05-invalid-fallback-1440.png` |
| 6 | 点击 Tab 只更新 `?view=`，AppShell 不重挂载（顶层工作页签保留） | `17-shell-tabs-1440.png`；断言 `经营工作台 / 客户与业务单` 存在且后者激活 |
| 7 | 未提交筛选草稿跨 Tab 切换保留（keep-alive 面板） | 断言值 `演示客户25` |
| 8 | 关键词查询走真实 API 并只保留匹配行 | `06-filter-keyword-1440.png`；请求 URL 中 `keyword=演示客户25` |
| 9 | 分页仍按服务端分页（25 条 => 第 2 页 5 行） | `07-pagination-page2-1440.png` |
| 10 | 线索详情 Drawer 仍打开真实详情/跟进/审计数据 | `08-lead-drawer-1440.png` |
| 11 | 业务受理单 Drawer 保留人工核验区块与事件时间线 | `09-order-drawer-1440.png` |
| 12 | 滚动后页头与二级 Tab 保持 sticky，且不与 AppShell 页签重叠 | `10-sticky-scrolled-1440.png` |
| 13 | 1440 / 1024 / 768 / 390 宽度无横向溢出，sticky 二级导航仍可见 | `11-` ~ `16-` 截图；每档同时校验 `scrollWidth <= clientWidth` 与 sticky 几何 |

## 复跑方式

1. 在 worktree 内初始化本地库：`corepack pnpm db:local:setup`（或 `pnpm dev:local`，但本机 headless 环境无法 spawn `pnpm.cmd`，改为分别启动 API/Admin）。
2. 带 `apps/api/.env.local` 中的端口/DB/Origin 环境变量启动：
   - `corepack pnpm --filter @sanchuang-dev/local-life-api dev`
   - `LOCAL_LIFE_API_PORT=... LOCAL_LIFE_ADMIN_PORT=... corepack pnpm --filter @sanchuang-dev/local-life-admin dev`
3. 用 `bootstrap-admin` 等价流程创建本地管理员，并按需写入演示 CRM 数据（脚本仅存放于 Git 忽略的 `.data/`）。
4. 运行 CDP 驱动脚本（同样仅存放于 `.data/`，不提交）：登录后依次执行上表场景，截图写入本目录，断言写入 `browser-results.json`。

## 已知限制

- 截图来自本地演示数据，用于验证布局、导航和真实 API 交互，不代表生产数据或线上部署状态。
- 网格员 / 运营员权限负例由 `apps/admin/src/pages/CrmPage.test.tsx` 与 API 测试覆盖；本次浏览器证据只登录管理员，未在真实浏览器中切换受限角色。
- 仅验证 Chrome on Windows；未覆盖 Firefox / Safari。
- 自动化断言覆盖 DOM 结构、计算样式、URL、网络请求与几何尺寸；截图仍需人工目视确认视觉细节（间距、对齐、字体渲染）。
