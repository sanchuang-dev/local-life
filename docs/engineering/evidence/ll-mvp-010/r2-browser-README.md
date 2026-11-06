# LL-MVP-010 / Issue #109 — R2 前端浏览器与端到端证据

> 分支：`feat/ll-mvp-010-local-catalog-orders`　基线：`dev@ae8441a`（R1 服务端 `007f433`）
> 范围：居民 H5「惠生活」本地商品与登记、「我的」订单、网格员工作台社区订单、管理台商品管理与订单管理
> 执行时间：2026-11-06（Asia/Shanghai），本机真实 Chrome + 真实 Hono API + 真实 SQLite + 真实 Vite 开发服务
> 执行方式：`node docs/engineering/evidence/ll-mvp-010/r2-browser-verify.mjs docs/engineering/evidence/ll-mvp-010`

## 结论

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 端到端（同一脚本内先跑真实 API，再跑真实 Chrome） | **117 / 117 通过，0 失败** | `r2-browser-results.json` |
| 浏览器截图 | **27 张**，320 / 375 / 1440 三档 | `01-*.png` … `27-*.png` |
| 横向溢出 | **0 / 27** 页面出现 `scrollWidth > clientWidth` | `r2-browser-results.json` 中每页 `no horizontal overflow` 断言 |
| 管理台页面单测（真实页面 + 显式 fetch stub） | **132 / 132 通过**（含新增 ProductsPage 9 项、OrdersPage 10 项） | `apps/admin/src/pages/ProductsPage.test.tsx`、`OrdersPage.test.tsx` |
| lint / typecheck / build | 全部通过（`pnpm lint` 0 error；29 条 warning 均为既有或既有规则命中） | 本卡报告 |
| 视觉走查 | **未做人工设计走查**，只验证布局、文案口径、权限与状态约束 | 见 §5 |

## 1. 本次覆盖的界面

| 路径 | 界面 | 关键约束 |
| --- | --- | --- |
| `/life` | 惠生活：本地好物（主）+ 优惠购（只读保留） | 商品来自真实 `/catalog/products`；无假商品；CRMEB 未配置时如实提示 |
| `/life/local-products/:productId` | 商品详情与登记 | CTA 文案为「登记订单 / 提交办理意向」；未登录显示登录条件；下架/不存在显示 404 文案 |
| `/me` | 我的 | 新增「我的订单」入口；三入口 AppShell 不回归 |
| `/me/orders` | 我的订单列表 | 真实本人订单；状态筛选；空态/未登录/错误态；刷新 |
| `/me/orders/:localOrderId` | 我的订单详情 | 快照、状态说明、时间线；**不提供居民取消**（服务端无该路由） |
| `/workbench/local-orders` | 网格员社区订单 | 只显示服务端授权社区；社区筛选仅在多社区时出现 |
| `/workbench/local-orders/:localOrderId` | 工作台订单详情 | 状态仅取过渡表中除 `verified` 之外的项；越权订单显示「订单不存在或不在授权社区」 |
| 管理台 `/products` | 商品管理 | 创建/编辑/上下架；整数分；乐观锁 `expectedUpdatedAt`；网格员零请求 + 无权限页 |
| 管理台 `/orders` | 订单管理 | 按权限与社区查询；详情抽屉；状态处理；运营人工核验（独立动作） |

## 2. 环境与复现

- Windows，Node `v24.21.0`，`pnpm 10.19.0`，Chrome（headless + CDP，脚本内注入真实会话 Cookie）。
- 端口取自 `apps/api/.env.local`（本 worktree：API `4080`、H5 `5173`、admin `5174`），脚本默认值与之一致，可用 `LL_WEB_ORIGIN` / `LL_ADMIN_ORIGIN` 覆盖。
- 本机账号（**仅本地证据库**）：管理员由 `pnpm --filter @sanchuang-dev/local-life-api bootstrap-admin` 创建；脚本用 `LL_ADMIN_USER` / `LL_ADMIN_PASSWORD` 登录后，**通过管理 API 自行创建**两个社区、`operator` 与 `grid_worker` 账户、4 个商品；居民账号走 `AUTH_DEV_ENABLED=true` 的 `/auth/dev/login`。
- 已知工具限制：本机 `node scripts/local-dev.mjs` 在 Node 24 下会因 `spawnSync pnpm.cmd EINVAL` 失败（既有问题），因此用显式环境变量分别启动三个开发服务。

```powershell
$env:NODE_ENV='development'; $env:HOST='127.0.0.1'; $env:PORT='4080'
$env:WEB_PORT='5173'; $env:ADMIN_PORT='5174'
$env:DATABASE_PATH='../../.data/local-life-dev.sqlite'
$env:SESSION_TTL_HOURS='168'; $env:AUTH_DEV_ENABLED='true'
$env:TRUSTED_ORIGINS='http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174'
$env:WEB_BASE_URL='http://localhost:5173/local-life/'
# 三个终端分别：api `tsx src/index.ts`、web/admin `vite`

$env:LL_ADMIN_USER='r2admin'; $env:LL_ADMIN_PASSWORD='<本地证据库管理员密码>'
$env:LL_CDP_PORT='9571'
node docs/engineering/evidence/ll-mvp-010/r2-browser-verify.mjs docs/engineering/evidence/ll-mvp-010
```

脚本可重复执行：商品与账号按固定名称 + `RUN_TAG` 幂等复用，只增数据、不删库、不重置。

## 3. 断言清单（117 项）

**API 阶段（真实 Hono，经 H5 的 `/api` 代理，带真实 Cookie + CSRF + Origin）**

- 目录：公开目录只含 `on_shelf`；已下架商品不出现在列表、详情 404；邻社区商品正常列出（目录不做社区隔离，订单登记才校验归属）。
- 登记：201 且 `created=true`；快照 `unitPriceCents` / `totalCents = 单价 × 数量` / `productName` 与登记时一致；初始状态 `registered`；无会话登记 401。
- 归属：本人列表含该订单；详情返回时间线；**另一居民读他人订单 404**，其列表也不含该订单（防枚举）；居民调用 `/staff/.../status` 401/403。
- 工作人员：网格员可读 `/staff/local-orders`，**只返回授权社区订单**，且看不到邻社区订单；`/admin/local-orders`、`/admin/catalog/products` 对其 403。
- 管理台：运营员可读订单列表并推进 `processing` → `pending_review`；陈旧 `expectedUpdatedAt` 409；`verified` 在状态路由上 400，只能经 `/verify` 获得；二次核验 409；`/events` 至少 3 条（registered / status_changed×2 / verified）。
- 商品与快照：新建商品**默认 `off_shelf`**（需显式上架）；下架后新登记 409 `product_off_shelf`；下架**不改写**既有订单快照。

**浏览器阶段（真实 Chrome，页面文案 + 溢出）**

- 每页断言：无横向溢出；关键文案出现；页面正文中若出现「支付成功 / 已成交 / 已开通」，必须只出现在否定句里（正则 `(不代表|不能|不会|并非)…`）。
- 覆盖：`/life`（320/375/1440）、商品详情（320/375/游客）、我的订单（320/375/游客/空态）、订单详情（320/375）、我的（320/375/游客）、社区订单（320/375）、工作台详情、越权订单 404 文案、居民账号访问工作台的登录引导、管理台商品列表（1440/375）、商品新建抽屉（375）、订单列表（1440/375）、订单详情抽屉（375）、网格员访问管理台订单的「无权限」页（1440）。

## 4. 证据文件

| 文件 | 内容 |
| --- | --- |
| `r2-browser-results.json` | 117 条断言逐条结果、页面尺寸与 `scrollWidth`、27 张截图清单、运行时间 |
| `r2-browser-verify.mjs` | 可复跑的 CDP 脚本（只用 Node 内建模块 + 本机 Chrome，无 Playwright 依赖；API 夹具全部走真实管理 API） |
| `01-life-320.png` … `03-life-1440.png` | 惠生活：本地好物为主区块，优惠购只读保留，未配置时如实提示 |
| `04-product-320.png` … `06-product-guest-375.png` | 商品详情与登记 CTA；游客态显示登录条件与「去登录 / 查看登录方式」 |
| `07-my-orders-320.png` … `10-my-orders-empty-375.png` | 我的订单：有数据 / 未登录 / 空态 |
| `11-my-order-detail-375.png` / `12-my-order-detail-320.png` | 订单详情：快照、状态说明、时间线，无居民取消入口 |
| `13-me-320.png` … `15-me-1440.png` | 我的：新增「我的订单」入口，三入口 AppShell 不变 |
| `16-workbench-orders-375.png` … `20-workbench-resident-visitor-375.png` | 社区订单列表、详情、越权 404、居民账号登录引导 |
| `21-admin-products-1440.png` … `23-admin-product-form-375.png` | 商品管理列表与新建抽屉（按元录入、整数分保存） |
| `24-admin-orders-1440.png` … `26-admin-order-detail-375.png` | 订单管理列表与详情抽屉（快照、状态处理、运营人工核验） |
| `27-admin-orders-grid-worker-1440.png` | 网格员访问管理台订单：无权限页且不发数据请求 |

## 5. 未覆盖 / 已知限制

- **居民自助取消不存在**：服务端没有 `/local-orders/:id/cancel`，居民调 `/staff/.../status` 是 401。因此 H5「我的订单」只展示状态与时间线，**不提供取消按钮**；取消由工作人员在工作台/管理台代操作。这是有意为之，不是遗漏。
- 浏览器证据是桌面 Chrome 的视口模拟（`Emulation.setDeviceMetricsOverride`），**不是真机触摸、软键盘、Safari/Firefox 或屏幕阅读器测试**；这些仍需人工验收。
- 没有像素级视觉走查/设计稿对比，只断言布局、溢出、文案口径、权限与状态约束。
- 管理台抽屉内的「提交中/失败保留输入/双击只提交一次」等交互由 `apps/admin/src/pages/{ProductsPage,OrdersPage}.test.tsx` 的页面级单测覆盖，本脚本不重复驱动这些键盘/时序场景。
- CRMEB 优惠购区块只验证「未配置时如实提示、不出现模拟商品」，**未配置真实商城环境**，因此该区块的成功态未在本证据中验证。
- 本地证据库会保留脚本创建的社区/账户/商品/订单（固定名 + `RUN_TAG`，不覆盖既有数据），不重置数据库。
- 本文件不含 #64 的经营台账/对账，也不含生产部署结论。
