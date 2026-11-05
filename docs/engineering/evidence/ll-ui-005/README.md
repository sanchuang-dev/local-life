# LL-UI-005 浏览器验收证据

- 日期：2026-11-05（本目录截图与 JSON 于 14:23 由 Playwright 重新生成）
- 分支：`feat/ll-ui-005-visual-baseline-r1`（基线 `origin/dev` `eb5edb6`）
- 环境：Windows 10，系统 Chrome（Playwright 1.64.1 `channel: chrome`，headless），本地 API `127.0.0.1:4180` + Admin Vite `http://localhost:5274`（与并行施工占用的默认 4080/5174 端口隔离），真实登录 `ui005admin`（本地 SQLite，仅验收数据）。
- 自动化：`browser-evidence.json` 记录每个视口的 `getBoundingClientRect()`、`getComputedStyle()` 与 Ant Design CSS 变量读数；无 page exception，仅 4 条既有 Ant Design 弃用警告（`Spin.tip`、`Space.direction`，与本卡无关）。

## 卡片高度实测（经营工作台 `/`）

| 视口 | 当前工作身份 top/bottom/height | 开始工作 top/bottom/height | 结论 |
| --- | --- | --- | --- |
| 1440 | 179.61 / 344.61 / 165.00 | 179.61 / 344.61 / 165.00 | 顶部、底部完全对齐 |
| 1024 | 179.61 / 344.61 / 165.00 | 179.61 / 344.61 / 165.00 | 顶部、底部完全对齐 |
| 768 | 179.61 / 388.61 / 209.00 | 179.61 / 388.61 / 209.00 | 顶部、底部完全对齐 |
| 390（额外） | 200.03 / 323.03 / 123.00 | 339.03 / 504.03 / 165.00 | 自然堆叠，各自内容高度，无固定高度 |

- `Row` 实际 class 为 `ant-row ant-row-stretch`，两个 `Col` 使用 `xs=24 / md=12`；1440 / 1024 / 768 下 `document.documentElement.scrollWidth` 等于视口宽度，无横向溢出。
- 390 宽度为额外回归检查（Issue 要求 1440/1024/768），确认窄屏没有固定高度或空白巨块。

## 语义色实测（`/system/components` 与 `/communities`）

| Token | 值 | 说明 |
| --- | --- | --- |
| `--ant-color-primary` | `#116d63` | 品牌青绿不变 |
| `--ant-color-info` | `#1677ff` | Info 独立为蓝色 |
| `--ant-color-info-bg` | `#e6f4ff` | 不再复用成功绿 |
| `--ant-color-info-border` | `#91caff` | 由 Ant Design 算法派生 |
| `--ant-color-success` | `#138b79` | 品牌青绿家族 |
| `--ant-color-success-bg` | `#c0ccc8` | 与 Info 背景明显不同 |
| `--ant-color-success-border` | `#6fb3a2` | — |
| `--ant-color-warning` | `#faad14` | Ant Design 默认，保持可辨认 |
| `--ant-color-error` | `#ff4d4f` | Ant Design 默认，保持可辨认 |

- `Alert type=info`（`/system/components`「本卡的能力边界」）computed：背景 `rgb(230, 244, 255)`、边框 `rgb(145, 202, 255)`，即方案派生值，无 `.ant-alert-info` 硬覆盖。
- 成功态对照：`/communities` 后台账户状态 `Tag color="success"`（「正常」）computed 背景 `rgb(192, 204, 200)`、文字 `rgb(19, 139, 121)`，与 Info 蓝色提示可直接区分。

## 文件

| 文件 | 内容 |
| --- | --- |
| `dashboard-1440.png` | 1440 宽经营工作台，双卡等高 |
| `dashboard-1024.png` | 1024 宽经营工作台 |
| `dashboard-768.png` | 768 宽经营工作台 |
| `dashboard-390.png` | 390 宽额外检查，双卡自然堆叠 |
| `components-1440.png` | `/system/components`，Info 提示为蓝色 |
| `components-768.png` | 768 宽组件页 |
| `alert-info-1440.png` | Info Alert 局部截图 |
| `communities-1440.png` | `/communities` 的 success Tag 对照 |
| `browser-evidence.json` | 原始测量值、computed 样式与 console 记录 |

## 不证明什么

- headless Chrome 只证明对应视口下的 DOM/布局与 token 计算；不证明物理触屏、跨浏览器（Safari/Firefox）或真机表现。
- 不覆盖 ADM-002/ADM-004，不覆盖 AppShell、CRM、居民 H5 或业务数据。
- 390 宽截图顶部身份区文字挤压属于既有 AppShell 窄屏表现，不在本卡改动范围，未修改。
