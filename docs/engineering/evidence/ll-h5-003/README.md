# LL-H5-003 正式居民 H5 AppShell — 浏览器证据（#94）

验证对象：居民 H5 外壳从「假小程序演示壳」替换为三入口正式 AppShell（活动 `/`、惠生活 `/life`、我的 `/me`），高亮完全由路由决定。分支 `feat/ll-h5-003-h5-app-shell`，基线 `dev@c13f96c`，证据对应代码 HEAD `0ecbd6f`（父 `12e0621`：外壳实现 + viewport/index.html 收尾；本目录由后续 `docs(evidence)` 提交加入，未改代码）。`git diff --stat c13f96c..0ecbd6f` = 9 文件 +315/−267：删除 `apps/web/src/components/MiniProgramShell.tsx`，新增 `apps/web/src/components/shell/{AppShell,BottomTabBar,navigation,useKeyboardVisible}`，改 `apps/web/src/{App.tsx,index.css,index.html}` 与 `docs/MINIAPP-SHELL.md`。无 `apps/api/`、`packages/contracts/`、`apps/admin/`、`.github/`、`package.json`、`pnpm-lock.yaml` 改动，无数据库迁移。

## 运行方式（本次证据的实际环境）

- 两套真实构建产物，同一份 Chrome：`pnpm --filter @sanchuang-dev/local-life-web build`（Pages 预览，`base=/local-life/`，HashRouter）与 `build:mvp`（`base=/`，BrowserRouter）。
- 静态服务托管 dist，系统 Chrome（headless=new）+ CDP；375 / 320 / 1440 三种视口；CDP 模拟安全区 `top=44`、`bottom=34`。
- 断言写入 `browser-run.json`（`summary: total 26 / passed 26 / failed 0`）与 `pixel-checks.json`（38 项像素几何检查）。

## 覆盖清单

| # | 场景 | 断言 | 证据 |
| --- | --- | --- | --- |
| 1 | MVP build（`base=/`）375 首页 | 无假状态栏/电池/胶囊/原型文案（`fakeChromeIcons=0`、`headers=0`）；底部恰好三入口且「活动」高亮；`overflowX=0` | `01-mvp-375-activities-home.png` |
| 2 | Pages build（`base=/local-life/`，HashRouter）375 首页 | 三入口与高亮一致，深链 `#/community/activity/…` 可达 | `02-pages-hash-375-activities-home.png` |
| 3 | 320 宽度首页 | 无横向溢出、底栏贴底、正文预留 66px | `03-mvp-320-activities-home.png` |
| 4 | 1440 桌面 | 720 列居中、无圆角/阴影手机框、三入口仍可达 | `04-mvp-1440-desktop-home.png` |
| 5 | 路由是高亮唯一真相源 | `/` 与 `/community/activity/**` → 活动；`/life`、`/points` → 惠生活；`/me`、`/workbench/**` → 我的；`aria-current=page` 由 `pathname` 派生（shell 无本地 tab 状态） | `browser-run.json` |
| 6 | 安全区与键盘 | `env(safe-area-inset-*)` 生效（正文 100px / 底栏 34px）；`visualViewport` 键盘让位；`scrollWidth <= clientWidth` | `pixel-checks.json`（38 项） |

## 命令与结果

```
pnpm install --frozen-lockfile   # exit 0
pnpm lint                        # exit 0，17 warnings / 0 errors（与基线同）
pnpm typecheck                   # exit 0
pnpm build                       # exit 0（Pages，index-B27WkU3c.js）
pnpm --filter @sanchuang-dev/local-life-web build:mvp   # exit 0（index-BU0_tBvE.js）
```

`pnpm check` exit 1，唯一失败为 dev 基线既有的 Windows-only `EPERM`（API rewards 套件 8 例：`rewards-version-edit` 7 + `rewards-data` 1）；已在干净基线 worktree（detach `c13f96c`）复跑同一套件得到相同失败集合（`identicalFailureSet=true`），不是本卡引入。浏览器全量：26/26 通过、0 console 错误；像素几何 38/38。

## 未验证项与外部依赖

- **未启动真实 API**：`/me`、活动详情、`/workbench/**` 在证据环境为真实 502/不可用态；本次只验证外壳、导航、安全区与深链几何，不代表接口可用性。
- **截图未经人眼目视**：生成本证据的 reviewer/worker 模型无图像输入，结论来自 DOM/计算样式断言 + 像素几何检查 + 独立重渲复核（另一次由 reviewer 自行起静态服务重渲 `dist-mvp` 复核三入口与假壳移除）。
- 无 iOS 真机、无微信内置浏览器（`viewport-fit=cover` 的 iOS 收益靠 meta 生效 + CDP 模拟 insets 证明）、无线上部署、未覆盖 Firefox/Safari。
- 已知陈旧引用（不在本卡边界，建议后续独立小 PR 清理）：`docs/engineering/design.md:4`、`docs/migration/v03-map.md:76` 仍指向已删除的 `MiniProgramShell.tsx`。

## 复跑方式

1. `pnpm --filter @sanchuang-dev/local-life-web build` 与 `... build:mvp` 生成两套 dist。
2. 用任意静态服务器托管 `apps/web/dist`（注意 `base` 与路由形态），Chrome headless + CDP 打开首页与子页。
3. 断言口径与 `browser-run.json` / `pixel-checks.json` 一致；`E:\tomz\h5-evidence\h5-003\tools\run.mjs` 与 `cdp-h5-003.mjs` 是可复核脚本（未入库）。
