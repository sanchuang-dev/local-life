# LL-UI-005 浏览器验收证据（Issue #89）

- 采集时间：2026-11-05（Asia/Shanghai）
- 分支：`feat/ll-ui-005-visual-baseline`（基线 `origin/dev@eb5edb6`）
- 环境：Windows 工作机，Node v24.22.2，pnpm 10.19.0，Chrome 156（headless + CDP），本地 API（127.0.0.1:4080）+ Admin Vite（localhost:5174）
- 范围：`apps/admin/src/app/theme.ts`、`apps/admin/src/pages/DashboardPage.tsx` 及同目录测试；未触碰 AppShell、DataPanel 业务控制流、业务数据/API/H5。

## 结论摘要

| 验收点（Issue #89） | 结果 | 证据 |
| --- | --- | --- |
| 经营工作台“当前工作身份 / 开始工作”桌面同行等高、上下边界对齐 | 通过 | `computed-evidence.json` dashboard 1440/1024/768：两卡 `height`、`top`、`bottom` 完全一致；`screenshots/dashboard-*.png` |
| 窄屏自然堆叠、无固定高度、无横向溢出 | 通过 | 375 视口两卡上下堆叠（123/165 自然高度），`styleHeight: 100%` 无 px 固定值；`screenshots/dashboard-375.png` |
| `colorInfo` 与 `colorSuccess` 不再共用 #138b79 | 通过 | `theme.ts` 配置 `colorInfo: #1677ff` / `colorSuccess: #138b79`；`token-evidence.json` |
| `.ant-alert-info` 实际读出 Info 语义，而非成功绿 | 通过 | `--ant-color-info: #1677ff`、`--ant-color-info-bg: #e6f4ff`、`--ant-color-info-border: #91caff`；`--ant-color-success: #138b79`、`--ant-color-success-bg: #c0ccc8`（`computed-evidence.json` components） |
| 品牌青绿主色保留 | 通过 | `colorPrimary` / `colorLink` = `#116d63`；截图主按钮、导航仍为青绿 |
| Warning / Success / Info 语义可辨认 | 通过 | Warning Alert 背景 `#fffbe6`、边框 `#ffe58f`；Info Alert 蓝色；Success Tag 使用 `ant-tag-success` 语义 Token |
| 无 `.ant-alert-info` 等局部硬覆盖 | 通过 | `apps/admin/src` 下无 `.ant-alert-*` / `.ant-tag-*` 硬覆盖样式；颜色全部来自 `adminTheme` |

## 截图索引（`screenshots/`）

| 文件 | 视口 | 内容 |
| --- | --- | --- |
| `dashboard-1440.png` | 1440×900 | 经营工作台：两卡同行等高、顶部对齐 |
| `dashboard-1024.png` | 1024×900 | 同上，1024 宽度 |
| `dashboard-768.png` | 768×900 | 同上，768 宽度（Ant Design `md` 断点仍为两列） |
| `dashboard-375.png` | 375×812 | 窄屏自然堆叠，无固定高度/溢出 |
| `components-1440.png` / `-1024` / `-768` | 1440/1024/768 | `/system/components` 首屏（Warning Alert + DataPanel） |
| `components-info-1440.png` / `-1024` / `-768` | 1440/1024/768 | 滚动至 Info Alert 的对照图 |
| `components-info-alert-1440.png` / `-1024` / `-768` | 2× 局部放大 | Info Alert 近照（蓝色信息语义） |

## 计算样式证据

`computed-evidence.json` 由 headless Chrome CDP `Runtime.evaluate` 读取 `getComputedStyle` 得到（非截图推断）：

- 卡片：1440/1024/768 下 `当前工作身份` 与 `开始工作` 的 `height/top/bottom` 分别相等；375 下自然堆叠。
- 行/列：`.ant-row.ant-row-stretch`，两列均为 `ant-col-xs-24 ant-col-md-12`，Flex 拉伸生效。
- Info Alert：`background-color: rgb(230, 244, 255)`、`border-color: rgb(145, 202, 255)`。
- 语义 Token（读取自 Alert 元素的计算样式自定义属性，Ant Design 6 CSS 变量模式）：
  - `--ant-color-info: #1677ff`、`--ant-color-info-bg: #e6f4ff`、`--ant-color-info-border: #91caff`
  - `--ant-color-success: #138b79`、`--ant-color-success-bg: #c0ccc8`
  - `--ant-color-warning-border: #ffe58f`、`--ant-color-error: #ff4d4f`
- `token-evidence.json` 由 `antd theme.getDesignToken(adminTheme)` 直接输出，证明派生 Token 与浏览器计算值一致。

## 复现步骤

1. 安装依赖（本机无 C++ 工具链；`better-sqlite3@13` 自带 win32-x64 预编译产物，禁用构建脚本即可）：
   `corepack pnpm install --frozen-lockfile --ignore-scripts`
2. 启动服务（等价于 `pnpm dev:local` 的 API/Admin 部分；该脚本会再执行不带 `--ignore-scripts` 的安装，在本机不必要且会触发 node-gyp，故直接启动）：
   - API：`apps/api` 下 `corepack pnpm exec tsx watch src/index.ts`，环境变量取自仓库 `apps/api/.env.local`（`PORT=4080`、`DATABASE_PATH=../../.data/local-life-dev.sqlite`、`AUTH_DEV_ENABLED=true`）
   - Admin：`apps/admin` 下 `corepack pnpm exec vite`（`LOCAL_LIFE_*_PORT` 指向 4080/5173/5174）
3. 首个管理员：本机交互式 `bootstrap-admin` 需要 TTY（隐藏密码输入），本次验收用一次性本地脚本调用同一 `createDatabase` + `hashPassword` + `staffAccounts` 写入路径创建 `admin`；脚本未提交。
4. 浏览器：headless Chrome `--remote-debugging-port=9222` + CDP 脚本登录后采集 `/` 与 `/system/components`，`Emulation.setDeviceMetricsOverride` 切换 1440/1024/768/375 并调用 `Page.captureScreenshot`。采集脚本为一次性本地脚本，未提交。

## 待人工项 / 已知缺口

- 截图与计算样式来自 headless Chrome，未做真机与真实鼠标交互回归；375 覆盖窄屏，但未单独验证 320。
- `/system/components` 页面本身没有 `Alert type="success"` 样例；Success 语义通过成功 Tag（`ant-tag-success`）与派生 Token 证明，Info Alert 与 Success 的区分由 Token 值与视觉截图共同确认。
- 未引入视觉回归自动化；后续如需固化，建议将计算样式断言放入组件测试或截图基线。
- CI 绿不等同于 UI 验收；仍建议维护者按上述截图人工签核。
