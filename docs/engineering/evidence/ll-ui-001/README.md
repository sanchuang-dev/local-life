# LL-UI-001 AppShell 浏览器验收证据

- 日期：2026-11-03
- 分支：`feat/ll-ui-001-002-admin-foundation`（基于 `origin/dev` 42e7156）
- 环境：macOS，Chrome for Testing（Playwright 1.64.1，headless），本地 `pnpm dev:admin`（localhost:5174）+ `pnpm dev:api`（127.0.0.1:4080）
- 数据：仅真实 `GET /api/healthz`；业务页面均为显式「待建设」状态，无虚构经营数据。
- 自动化：`shell-verification.json`（16 项交互断言，0 console error / page exception）。

| 文件 | 视口 | 内容 |
| --- | --- | --- |
| `shell-1440-dashboard.png` | 1440×900 | 经营工作台、分组导航、页签、真实 API 健康检查 |
| `shell-1440-menu-search.png` | 1440×900 | 菜单搜索「订单」收窄结果 |
| `shell-1440-menu-search-empty.png` | 1440×900 | 菜单搜索无结果空态 |
| `shell-1440-work-tabs.png` | 1440×900 | 多路由页签与当前页高亮 |
| `shell-1440-collapsed.png` | 1440×900 | 侧栏折叠到 68px，页签保持 |
| `shell-1024-dashboard.png` | 1024×800 | 桌面布局 |
| `shell-768-dashboard.png` | 768×800 | 平板布局，无横向溢出 |
| `shell-767-drawer.png` | 767×800 | 抽屉导航 |
| `shell-767-drawer-search.png` | 767×800 | 抽屉内菜单搜索 |
| `shell-767-community-page.png` | 767×800 | 抽屉导航后进入待建设页面 |

## 已复现交互

1. 菜单搜索收窄/空态，清除后恢复完整导航。
2. 路由切换自动打开页签；关闭非当前页签不跳转；关闭当前页签跳到相邻页签。
3. 页签操作「关闭其他页签」保留经营工作台 + 当前页。
4. 浏览器后退/前进时页签与高亮同步。
5. 刷新后深链与页签条恢复（sessionStorage）。
6. 侧栏折叠/展开不丢失页签与搜索框状态。
7. 1024/768 保持桌面布局；767 切换抽屉，导航后关闭并归还焦点。
8. 全流程无 console error / page exception。

## 不证明什么

- 不证明 #58 的真实登录、会话过期、越权与退出；该能力尚未合并，本分支明确显示「身份未接入」。
- 不证明 DataPanel 数据面板（LL-UI-002 提交单独提供证据）。
- 不做物理设备/触摸屏验收；headless Chrome 截图只证明该视口下的 DOM/布局与交互结果。
