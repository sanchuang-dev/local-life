# LL-MVP-010 · R2 前端代码审查（t7）

> 审查者：`api-r1`（只读审查；**未修改任何业务代码**，本文件是唯一写入的产物）
> 时间：2026-11-06（Asia/Shanghai）
> 被审查对象：提交 `ac4c385` `feat(web,admin): local catalogue and resident order surfaces (R2)`（58 文件 / +7395 −21）
> 父提交：`007f433`（R1 服务端，t6 已判 pass）
> 分支：`feat/ll-mvp-010-local-catalog-orders`；基线 `origin/dev@ae8441a`
> **结论：verdict = pass**。Issue #109 Scope R2 的四项前端要求逐条成立；captain 指定的 9 个重点全部实测/实读复核，**0 条阻断、0 条中级**；2 条 low 观察项不构成返修条件（§8）。

---

## 0. 审查范围与方法

### 0.1 范围

| 项 | 内容 |
| --- | --- |
| 在范围 | `ac4c385` 的 58 个文件：`apps/web/src/**`、`apps/admin/src/**`、`docs/engineering/evidence/ll-mvp-010/` 的 R2 证据 |
| 不在范围 | `apps/api/src/**`、`packages/contracts/src/**`（R1，`007f433`，t6 已审）、R2 的浏览器断言真实性（t5 已独立实测） |
| 只读约束 | 遵守：`git status --porcelain apps packages` 相对 `ac4c385` 为空；审查期临时日志写入已 git-exclude 的 `.tmp-verify/`，无业务文件改动 |

**可测性说明**：`git diff --stat 007f433 HEAD -- apps/api packages/contracts` **输出为空**，即 R2 提交没有触碰任何服务端文件；因此本轮读到的 H5/管理台行为就是对着 `007f433` 的真实契约。

### 0.2 实际执行的命令与退出码（全部在 R2 树上）

| # | 命令 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `pnpm lint` | **0** | `Found 29 warnings and 0 errors`（231 files）；基线 20 warnings，净增 9 条全部落在 R2 新文件，且规则类别与基线同源（见 §7.1） |
| 2 | `pnpm typecheck` | **0** | contracts build + 四包 `tsc` 全绿 |
| 3 | `pnpm build` | **0** | web/admin/api 全部构建成功；仅 Vite chunk-size 建议（既有） |
| 4 | `pnpm --filter @sanchuang-dev/local-life-admin test` | **0** | `Test Files 16 passed (16)` / `Tests 132 passed (132)`，304.96s |
| 5 | `pnpm --filter @sanchuang-dev/local-life-admin exec vitest run src/pages/ProductsPage.test.tsx src/pages/OrdersPage.test.tsx` | **0** | `19 passed (19)`，输出中无 antd 废弃告警 |

未跑 `pnpm --filter @sanchuang-dev/local-life-api test`：R2 未改服务端（#5 的可测性说明），且该命令在 Windows 上的 8 例 rewards `EPERM` 已由 `baseline-eprem.md` 定性为基线环境问题，与本提交无关。

---

## 1. 逐条验收判定（t7 合同 7 条）

| # | 验收项 | 判定 | 关键证据（文件:行） |
| --- | --- | --- | --- |
| 1 | Issue #109 Scope R2 四项前端要求逐条 pass/fail | **通过（4/4）** | 见 §2 的 R2-1…R2-4 映射表 |
| 2 | H5 真读本地商品 API；未登录/空/加载/错误四态如实；登记文案不出现支付成功 | **通过** | `useLocalCatalog.ts:36-58`（loading/error/empty/ready）；`LocalCatalogSection.tsx:34/43/49/71` 四分支；空态文案 `:59`「本页不会用示例商品或商城商品填充本地目录」；CTA「登记订单 / 提交办理意向」`LocalProductPage.tsx:214/312` |
| 3 | 「我的」列表/状态/详情/刷新来自真 API | **通过** | `MyOrdersPage.tsx:6/116/123/146/150/164/224`；`MyOrderDetailPage.tsx:47/78/129/219/253`；`useLocalOrders.ts:100-126`（loadMore 真实分页） |
| 4 | 管理台商品 + 订单核验复用 AppShell/DataPanel/Drawer 与既有 token，无新视觉体系 | **通过** | `ProductsPage.tsx:530-531` `DataPanel id="local-products"`、`:585` `size={520}`；`OrdersPage.tsx:547` `id="local-orders"`、`:597` `size={600}`；`PageHeader`/`Result`/`Descriptions`/`Timeline` 全是既有组件；`local-console.css` 仅 109 行、只用 `--ant-color-*` 变量 + hex 回退，无 `!important` |
| 5 | 网格员只能处理授权社区订单，越权明确 403 | **通过** | 路由只走 `/staff/local-orders*`（`localOrders.ts:101/119/147`）；社区筛选仅取 `session.staff.communities`（`WorkbenchLocalOrdersPage.tsx:47/50/115-118`）；`useStaffLocalOrders.ts:89` 401/403 → `forbidden`，`:137-150` 渲染「没有权限查看社区订单」；管理台 `/admin/*` 对网格员是零请求的 403 页（`ProductsPage.tsx:137-154`、`OrdersPage.tsx:144-161`） |
| 6 | 三入口 AppShell、BrowserRouter/Pages HashRouter、活动深链不回归 | **通过** | `main.tsx` **未被本提交修改**；`components/shell/navigation.ts` **未被修改**（`activePrimaryTab` 仍把 `/life` 归到 life、把 `/me` 与 `/workbench` 归到 me）；`App.tsx` 改动**纯新增** 6 条 Route（`:63/67/68/77/78`），无删除行 |
| 7 | 真实浏览器证据覆盖 320/375/桌面，无溢出与明显交互缺陷 | **通过（证据归 t5，本轮只核其自洽性）** | `r2-browser-results.json`：`passed 117 / failed 0`，27 张截图；`t5-visual-pages.json` 30 行全部 `scrollWidth === innerWidth`；`t5-drawer-results.json` 320/375 铺满、1440 为 520/600 |

---

## 2. Scope R2 四项要求 → 判定（对应 `recon.md §2.2` R2-1…R2-7）

| recon 编号 | 要求要点 | 判定 | 证据 |
| --- | --- | --- | --- |
| R2-1 | H5「惠生活」读本地商品 API，展示真实上架目录与详情；四态如实；不出现假商品 | **通过** | 只有 `localCatalog.ts` 三个真调用；`useLocalCatalog.ts:42-45` 传真实 `communityId/page/pageSize`；`LocalProductCard.tsx:6-12` 注释明确「never invents a price, a discount or a stock claim」，字段全部来自 `LocalProductSummary` |
| R2-2 | 已登录居民可登记；未登录明确提示且不能提交；文案「登记订单 / 提交办理意向」，无支付成功/已成交 | **通过** | `LocalProductPage.tsx:51` `canRegister` 要求 `session`；无会话时渲染 `unavailableAction`「登录后登记订单」（`:53-57`、`:317-319`）；成功态 `:269-289`「办理意向已登记」+「平台不收款，这也不代表业务已开通」；幂等键 `:46`、成功后换新 `:72` |
| R2-3 | 「我的」提供本人订单列表、状态、详情与刷新，数据来自真 API | **通过** | `/me/orders` + `/me/orders/:localOrderId`（`App.tsx:67-68`）；`MePage.tsx:301/312` 新增入口卡；`DemoNote` 改写 `:364`；状态词与 `LOCAL_ORDER_STATUS_TRANSITIONS` 同源（`localOrderLabels.ts:15-22`） |
| R2-4 | 管理台商品管理：创建/编辑/上架/下架，复用 AppShell/DataPanel/Drawer 与 Token | **通过** | `ProductsPage.tsx` 749 行；`routes.tsx:37` 真路由在 `...PLANNED_PAGES` **之前**（`:17`、`:43`）；`navigation.ts:93-99` 已翻 `status:'ready'`、`planned:[]`、`roles:['admin','operator']` |
| R2-5 | 管理台订单查询：按权限与社区筛选、处理状态、运营人工核验；不把已核验渲染成已付款/已开通 | **通过** | `OrdersPage.tsx:86-92` `TRANSITION_ACTIONS` 无 `verified`；`:311-315` 从 `LOCAL_ORDER_STATUS_TRANSITIONS` 再滤一遍；核验走独立 `verifyAdminLocalOrder`（`localOrders.ts:102-110`）；`:759`「该结论仅为人工事实核验，不代表收款、成交或业务办理已完成。」 |
| R2-6 | 网格员工作台只能看/处理授权社区订单；越权明确 403 | **通过** | 见 §1-#5 证据链；另有 `useStaffLocalOrders.ts:36` 注释「A 403 is a distinct state」 |
| R2-7 | 三入口 AppShell、双 Router、活动深链、既有页面不回归 | **通过** | R2 未改任何「不回归」相关文件（`main.tsx`、`shell/navigation.ts`、`theme.ts`、`package.json`、`pnpm-lock.yaml` 全不在提交内） |

**判定口径**：要求「UI 与服务端事实一致、无假按钮/假数据/误导文案」。不评判视觉设计好坏（t5 已声明不做像素级走查）。

---

## 3. 与服务端契约的一致性（本轮重点）

### 3.1 状态机展示

| 服务端事实 | UI 是否一致 | 证据 |
| --- | --- | --- |
| 6 态，`LOCAL_ORDER_STATUS_TRANSITIONS` 是唯一权威 | **一致** | H5 标签 `localOrderLabels.ts:15-22`；工作台动作 `:71-75` **不硬编码**，而是从 `LOCAL_ORDER_STATUS_TRANSITIONS[current]` 过滤；管理台 `OrdersPage.tsx:311-315` 同样从契约过滤 |
| `verified` 只能经 `/verify` 获得，`localOrderTransitionStatusSchema` 不含它 | **一致，且三处都挡死** | 工作台 `localOrderLabels.ts:71-75` 白名单不含 `verified`；管理台 `TRANSITION_ACTIONS`（`:86-92`）不含；`allowedTransitions`（`:311-315`）再滤一次。工作台文案 `WorkbenchLocalOrderDetailPage.tsx:209-211`「只能提交服务端允许的状态；“人工核验通过”不在工作台可选项内。」 |
| 终态不可再变；`rejected` 必须有原因 | **一致** | 工作台 `:213-218` 终态说明；`:85-86`「标记未通过必须填写原因。」（前端拦截，服务端 400 兜底）；管理台内联驳回框 `:377-379`（前端）、`:387-389` 核验备注 ≥2 字符 |
| 核验语义 = 人工事实确认，≠ 已付款/已开通 | **一致** | `localOrderLabels.ts:28`「运营人员已人工核验订单事实；这不代表收款或业务办理已完成。」；`MyOrderDetailPage.tsx:123`；`WorkbenchLocalOrderDetailPage.tsx:201-203`；`OrdersPage.tsx:405/501/759` |
| 陈旧 `expectedUpdatedAt` → 409 | **一致** | 三端写请求都带 `expectedUpdatedAt`（`ProductsPage.tsx:357`、`OrdersPage.tsx` 转场、`WorkbenchLocalOrderDetailPage.tsx:249` 文案「如果订单已被其他人处理，服务端会以 409 拒绝」）；`describeLocalError` 把 409 统一渲染为「数据已被更新：…」（`localApi.ts:161`） |
| 他人订单 404（反枚举） | **一致** | `MyOrderDetailPage.tsx:158-164/219`「订单不存在或无权查看」；工作台「订单不存在或不在授权社区」 |

### 3.2 权限边界

| 服务端事实 | UI 是否一致 | 证据 |
| --- | --- | --- |
| `/admin/*` 对 `grid_worker` 403 | **一致（且是零请求的本地拦截，不靠 403 兜底）** | `ProductsPage.tsx:137-154` 与 `OrdersPage.tsx:144-161` 在 `session.staff.role === 'grid_worker'` 时直接返回 `Result status="403"`，不挂载控制台组件因此不发请求；文案明确「即使直接访问该地址，服务端同样会拒绝」 |
| `/staff/local-orders*` 三角色可用、按授权社区限定 | **一致** | 工作台只调用 `listStaffLocalOrders/getStaffLocalOrder/updateStaffLocalOrderStatus`；社区下拉只在 `communities.length > 1` 出现（`:115-118`），`communityId` 先校验属于 session 授权集合（`:50`）才写进 URL |
| 居民侧无取消/编辑路由 | **一致（无假按钮）** | 见 §4.1 |
| 居民不能读他人订单、不能调 `/staff/*` | **一致** | 见 §3.1 末两行 |

### 3.3 价格与快照

- H5 只格式化、不计算权威价格：`formatLocalPriceCents`（`localOrderLabels.ts:108-112`）只做 `(cents/100).toFixed(2)`；`MyOrderDetailPage.tsx:47` 用 `order.snapshot.totalCents`，不是前端重算。
- 参考合计标注在 `LocalProductPage.tsx:251-252`「（以服务端快照为准）」；`t5-cross-community-results.json` 抓到的实际渲染正文同含此句。
- 管理台金额录入用整数分（`ProductsPage.tsx:87-92` `centsToYuan`/`yuanToCents` 双向 `Math.round`），不引入浮点累加。
- 提交体不含价格：`registerLocalOrder` 的 body 只有 `productId/quantity/note/idempotencyKey`（`localOrders.ts:39-49`、schema `createLocalOrderRequestSchema.parse` 兜底）。

---

## 4. 假按钮 / 假数据 / 误导文案专项

### 4.1 居民自助取消（captain 指定的判据）

**结论：不存在假按钮。** 全文检索 `取消订单|取消登记|取消我的` 在 `apps/web/src` 只命中一处：`localOrderLabels.ts:84`，而该函数 `localOrderTransitionActions` 的唯一两个调用点都在工作台（`WorkbenchLocalOrderDetailPage.tsx:30/67`）。`MyOrderDetailPage.tsx:158-164` 明写：

> Read-only on purpose: the contract has no resident cancel or edit route, so this page offers none.

该页可交互元素只有「刷新状态」（`:247-253`）与「继续逛惠生活」（`:255-262`），另有错误态的「重新读取」（`:224-226`）。`services/localOrders.ts:15-22` 也在服务层写明只暴露三个调用、「never invents a fourth」。

### 4.2 假数据 / fixture

- 对 R2 全部新增 `.ts/.tsx` 检索 `from '.*mocks|from '.*fixtures|demoData`：**0 命中**。
- 检索 `crmeb|fixture|mock|sample|示例商品`：只命中说明性文案（如 `LocalCatalogSection.tsx:59` 明确声明不会用示例商品填充）。
- 空态/未登录态均为真分支：`LocalCatalogSection.tsx:49`（empty）、`MyOrdersPage.tsx:164`（unauthenticated）、`:224`（空态两分句）。

### 4.3 禁用文案（支付成功 / 已成交 / 已开通 / 一键下单 / 下单成功）

对 R2 全部新增文件检索，命中仅 6 处，逐条判定：

| 位置 | 内容 | 判定 |
| --- | --- | --- |
| `localOrderLabels.ts:11` | 注释说明「never 已付款 / 已成交 / 已开通」 | 合规（注释） |
| `LocalProductPage.tsx:279` | 「平台不收款，这也不代表业务已开通。」 | 合规（否定句） |
| `MyOrderDetailPage.tsx:123` | 「不代表已收款、已成交或业务已开通。」 | 合规（否定句） |
| `OrdersPage.test.tsx:261/329/426` | 断言 `not.toMatch(/支付成功|已成交|已开通/)` | 合规（测试防线，反向断言） |

即真渲染文案里**没有任何一处**把登记说成支付/成交/开通。

### 4.4 伪造交互

- 管理台两页检索 `删除|导出|打印|下载|提醒|发送短信|拨号`：**0 命中**（没有「假删除」「假导出」）。
- H5 新页检索 `分享|收藏|客服|咨询|拨号|电话联系|评价`：**0 命中**。
- 所有按钮都有真实 handler 或真实 `Link`；无 `onClick={() => {}}`。

---

## 5. 文件边界 / 依赖 / 视觉体系

### 5.1 动没动不该动的文件

`git show --name-only ac4c385` 的全部路径落在三处：`apps/web/src/**`、`apps/admin/src/**`、`docs/engineering/evidence/ll-mvp-010/**`。**没有** `apps/api`、`packages/contracts`、迁移、`package.json`、`pnpm-lock.yaml`、`main.tsx`、`theme.ts`、`components/shell/navigation.ts`。

被改的既有文件只有 6 个，且改动是接线而非重写：

| 文件 | 改动性质 |
| --- | --- |
| `apps/web/src/App.tsx` | 纯新增 import + 6 条 Route（diff 无删除行） |
| `apps/web/src/pages/LifePage.tsx` | 本地好物区块提到优惠购之前 + DemoNote 文案 |
| `apps/web/src/pages/MePage.tsx` | 新增「我的订单」入口卡 + DemoNote 文案 |
| `apps/web/src/pages/workbench/WorkbenchLeadsPage.tsx` | 新增「社区订单」入口链接 |
| `apps/admin/src/app/routes.tsx` | 真路由插到 `...PLANNED_PAGES` 之前 |
| `apps/admin/src/app/shell/navigation.ts` | `/products`、`/orders` 翻 `ready` |

### 5.2 新依赖

`package.json` / `pnpm-lock.yaml` **不在提交内** → 零新增依赖。`services/*.ts` 只 import 契约包、`localApi` 与既有模块；页面只用 `antd` + `lucide-react` + `react-router`（全是既有依赖）。二维码/图表/日期库等都没引入；时间格式化用 `Intl.DateTimeFormat`（`localOrderLabels.ts:91-106`、`OrdersPage.tsx:94-102`）。

### 5.3 视觉体系

- 管理台：`DataPanel` + `PageHeader` + `Drawer` + `Descriptions` + `Timeline` + `Alert` + `Result` 全部是既有组件（`DataPanel.tsx` 早在 `5708803`/LL-MVP-006 前后就存在）。
- `local-console.css` 是**页面级** CSS（只被 `ProductsPage.tsx:44`、`OrdersPage.tsx:41` import），不是全局主题；只用 `var(--ant-color-border-secondary, #e8f0ec)`、`var(--ant-color-text-description, #64748b)` 两个 antd token 且与 `theme.ts:26/30` 同值，所以变量缺失时也不会变色。
- 无 `!important`；只重置了 `.local-drawer` 作用域内的 `.ant-descriptions`/`.ant-timeline` 上边距——作用域收敛，不污染其他页面。
- H5：沿用既有 teal/slate 调色板与 `rounded-[18px]` 卡片语言，与 `ShopDealsSection`/`MePage` 视觉同族。

---

## 6. 响应式与可访问性（代码层面，非「碰巧不溢出」）

t5 已用真实 Chrome 证明 `scrollWidth === innerWidth`。本轮独立核**为什么**不溢出：

| 检查 | 结果 |
| --- | --- |
| 固定像素宽度 `w-[NNNpx]`/`width:NNNpx` | 新增 `.tsx` 中 **0 处**；只有 3 处 `max-w-[280~300px]` 的居中说明段落（`LocalCatalogSection.tsx:58`、`LocalProductPage.tsx:120`、`MyOrdersPage.tsx:226`），`max-w` 在窄视口不会撑破 |
| 唯一 `width: 120px` | `local-console.css:100` 的 `.local-snapshot-item { min-width }`，位于 `display:flex; flex-wrap:wrap`（`:91-95`）容器内，320px 下换行而非溢出 |
| 绝对定位 | 仅 1 处：时间线圆点 `MyOrderDetailPage.tsx:134` `-left-[5px]`，相对 `li.relative` 且在 4px 内边距内，不产生横向滚动 |
| `overflow-hidden` 掩盖 | 2 处，都是卡片图片/长文本裁切（`LocalProductCard.tsx:19`、`LocalProductPage.tsx:150`），同时配合 `min-w-0` + `truncate`/`line-clamp-2`/`break-words`，是正确做法而非掩盖 |
| 表格窄屏 | `DataPanel` 用 `scroll={{ x: 'max-content' }}`（`DataPanel.tsx:717`），表格在容器内横向滚动，页面本身不溢出 |
| 抽屉窄屏 | `size={520}`/`size={600}` 在 320/375 下由 antd 自动收成全宽（`t5-drawer-results.json`：320→320px、375→375px） |
| 触控目标 | 主按钮普遍 `min-h-[44px]`/`min-h-[48px]`（`LocalProductCard` 整卡可点，`:18`）+ `focus-visible:outline-2` |
| 语义 | `role="status"`/`aria-live`（加载）、`role="alert"`（错误）、`aria-hidden` 装饰图标、`aria-label` 卡片全称；无 `aria-*` 误用 |
| 空/错/未登录 | 每个新页面都有独立分支文案，不是「白屏 + console.error」 |

**一点如实说明**：`MyOrderDetailPage.tsx`、`WorkbenchLocalOrderDetailPage.tsx` 的主按钮没有 `focus-visible` 类（前者 0 处、后者 0 处），而基线里 `MePage`(5)/`PointsPage`(2)/`WorkbenchLeadsPage`(2) 是有的。这属于**键盘可见性的一致性瑕疵**，不构成功能缺陷（Tailwind 默认 outline 未被移除，全局 CSS 只对 `.app-shell__main` 和 `.app-shell__skip` 做了 outline 处理，见 `index.css:86/132`），因此记为 low 观察项（§8-O-B），不阻断。

---

## 7. 实跑结果

### 7.1 lint：29 warnings / 0 errors（基线 20）

净增 9 条，逐条都在 R2 新文件，且**规则类别在基线已存在**：

| 位置 | 规则 | 基线同类先例 |
| --- | --- | --- |
| `apps/admin/src/pages/ProductsPage.tsx:749` | `react(only-export-components)`（`export const productPriceHelpers` 与被测页面同文件） | — 新类别，但仅测试复用所需，无运行时影响 |
| `apps/web/src/hooks/useStaffLocalOrders.ts:62,141`、`useLocalOrders.ts:58,149`、`useLocalCatalog.ts:40,89` | `react-hooks(set-state-in-effect)` | `CrmPage.tsx`、`ActivitiesPage.tsx`、`ActivityCheckinPage.tsx`、`useRewardWallet`、`App.auth.test.tsx` 早已命中同类 |
| `apps/admin/src/pages/OrdersPage.tsx:204,223` | 同上 | 同上 |

即：**没有引入新的 lint 规则类型债务**（除 1 条测试导出），`0 errors`。

### 7.2 typecheck / build / test

见 §0.2 表 #2/#3/#4/#5，全部 exit 0。

新增测试真实性抽查：`ProductsPage.test.tsx`（367 行 / 9 例）与 `OrdersPage.test.tsx`（482 行 / 10 例）都通过 `renderAdmin` + 显式 `stubApi` 前缀表驱动真实页面，断言的是渲染文本与发出的请求（而非 mock 组件）；其中包含「never offers a direct verified status button」「shows the real 409 when the order was already verified elsewhere」等**反向断言**，与 §3 的契约结论互证。

---

## 8. 观察项（low，均不要求 R2 返修）

| ID | 位置 | 现象 | 判定 |
| --- | --- | --- | --- |
| **O-1** | `apps/web/src/hooks/useLocalCatalog.ts:119-134` | `useCatalogCommunities` 导出但全仓无调用者（H5 没有居民→社区映射端点，社区筛选最终未做） | 死代码，`typecheck` 不报（未启用 `noUnusedExports`）。建议后续删除或补上筛选，**不阻断** |
| **O-2** | `apps/admin/src/services/localOrders.ts:116-123` | `listAdminLocalOrderEvents` 导出但无调用者（时间线随 detail 一起返回，`detail.events` 已够用） | 同 O-1，死代码，不阻断 |
| **O-3** | `apps/web/src/pages/LocalProductPage.tsx:51` | `canRegister` 只判 `session` + `on_shelf`，不判「居民社区 === 商品社区」；邻社区商品仍渲染可点按钮，点击后由服务端 403 拦下（`t5-cross-community-results.json`：`uiWarnsBeforeClick:false`、`serverRefuses:true`） | 与 `verification-visual.md §10 O-A` 同一结论。`GET /catalog/products` 是公开目录（recon §4.1），#109 的跨社区规则是**服务端**权限要求且已强制；UI 提前提示属体验优化。记为可选优化，**不阻断** |
| **O-4** | `MyOrderDetailPage.tsx:224/247/255`、`WorkbenchLocalOrderDetailPage.tsx:222/281/289` | 主按钮未加 `focus-visible` 工具类，与基线部分页面的键盘焦点样式不一致 | 浏览器默认 focus ring 未禁用，可键盘操作可见；属一致性瑕疵，**不阻断** |

上述 4 条均不影响验收 7 项，也与 #109 的「服务端为唯一信任源」原则无冲突。

---

## 9. 明确未验证面（不得当作通过）

- **H5 无单测框架**：`apps/web` 没有 vitest/jsdom，R2 的 H5 逻辑只经 typecheck + 真实 Chrome 覆盖；本轮**不为 R2 声称任何 H5 单元测试覆盖**。
- **浏览器证据是桌面 Chrome 视口模拟**：不是真机触摸/软键盘，未测 Safari/Firefox/WebView、屏幕阅读器、色彩对比度。
- **未做像素级设计走查**：不评判间距/字号是否符合设计稿。
- **未重跑 R2 的 117 条浏览器断言**（归 t5，且需起三个开发服务）；本轮只核其 JSON 的自洽性与覆盖清单。
- **未测 CRMEB 优惠购成功态**（本机未配置真实商城）。

---

## 10. 结论

**verdict = pass。**

- Issue #109 Scope R2 的四项前端要求（真目录+四态、居民登记与「我的」、管理台商品管理、管理台订单查询与人工核验）逐条成立，网格员工作台按授权社区限定、越权明确 403。
- UI 与服务端事实一致：状态机三处都从 `LOCAL_ORDER_STATUS_TRANSITIONS` 取、`verified` 在三端的状态按钮中均不可达、核验语义处处标注「不代表收款/成交/开通」、陈旧版本号 409 与反枚举 404 都有对应文案。
- 无假按钮（居民无取消入口）、无假数据（零 fixture/mock 引用）、无禁用支付文案（仅否定句与测试反向断言）。
- 未触碰 `apps/api`、`packages/contracts`、迁移与依赖清单；零新增依赖、零新视觉体系，页面级 CSS 只用既有 token。
- lint 0 error / typecheck / build / admin 132 测试全部实跑通过；净增 lint warning 不引入新规则类型债务。

**返修清单：无。** 4 条 low 观察项（§8）留待后续小改，不构成准入条件。
