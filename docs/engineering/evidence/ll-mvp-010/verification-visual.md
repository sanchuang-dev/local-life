# LL-MVP-010 · t5 轻量视觉冒烟验证（R2）

> 角色：独立验证员（verifier），只读代码、只跑验证，未修改任何业务实现。
> 任务：t5「轻量视觉冒烟：关键页面三档截图、无横向溢出、文案与 console 异常」，依赖 t3（R1, `007f433`）与 t4（R2, `ac4c385`）。
> 边界（维护者明确要求视觉验收暂缓）：**不做**逐像素比对、全量交互回归、无障碍深挖、多浏览器矩阵。本文只回答"能不能看、会不会溢出、有没有说不该说的话、控制台有没有本分支引入的错误"。

## 1. 结论

**t5 通过（pass），无阻断项、无 R2 返修项。** 但结论只覆盖本文明写的范围；CI 绿和本文绿都不等于 #109 全量验收通过，见 §8 未验证面。

| 判定 | 结果 |
| --- | --- |
| 10 个页面 × 320/375/1440 三档，共 30 次页面加载、231 项硬指标 | **231 passed / 0 failed** |
| 横向溢出（`scrollWidth === innerWidth`，含 `body.scrollWidth`） | 30/30 通过，无一页溢出 |
| 主标题与主 CTA 渲染（非零布局盒、未被 `display:none`/`visibility:hidden`/`opacity:0` 隐藏） | 30/30 页全部命中 |
| 禁用文案（`支付成功 / 已成交 / 已开通 / 付款成功 / 已支付`） | 30/30 页零命中 |
| 本分支引入的 console error | 0（6 条 antd `Spin tip` 告警为既有代码，见 §7） |
| 未捕获异常 / 失败网络请求 | 0 |
| 此前 6 条 antd `Drawer width` 废弃告警 | **已确认转绿**（R2 已改为 `size={520}` / `size={600}`），见 §7.2 |

## 2. 环境与被测快照

| 项 | 值 |
| --- | --- |
| 工作区 | `E:\tomz\local-life-wt\mvp-010` |
| 分支 | `feat/ll-mvp-010-local-catalog-orders` |
| HEAD | `ac4c385eea884611f64fe1348ee3e5c96ffd76e5` `feat(web,admin): local catalogue and resident order surfaces (R2)` |
| R1 提交 | `007f433ca0233a7f13f40bbbfca4b164dcaf5511` |
| 基线 | `origin/dev@ae8441a` |
| 被测 R2 文件 | 28 个（`apps/web/src` 18 + `apps/admin/src` 10），聚合指纹 `7f51d1c71fa43291e931582c346152d4043e244576aa6e4ac0018d2d5b553cf3`，验证时无脏文件（`r2FilesDirtyNow: []`）→ `t5-snapshot.json` |
| R2 提交边界 | 未触碰 `apps/api`、`packages/contracts`、迁移（`git show --name-only ac4c385` 中三者命中数 0） |
| Node | v24.21.0（`…\dsh-primary-runtime\dependencies\node\bin\node.exe`） |
| pnpm | 10.19.0（`…\dependencies\pnpm\bin\pnpm.mjs`） |
| Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe` 156.0.8078.80，`--headless=new` |
| 本地栈 | api `4080`、h5 `5173`、admin `5174`；`apps/api/.env.local` → `DATABASE_PATH=../../.data/local-life-dev.sqlite` |
| 视口 | 320×720、375×812、1440×900（`Emulation.setDeviceMetricsOverride`） |

> 域名口径：Vite 只监听 `::1`，`http://127.0.0.1:5173` 会 `ERR_CONNECTION_REFUSED`，因此全部用 `http://localhost:5173`。H5 用 HashRouter（`base: '/local-life/'`），管理台用 BrowserRouter。这一点会改变"深链能否直接打开"的结论，故记录。

## 3. 复现命令与退出码

全部脚本放 `.evidence/`（已被 `E:\tomz\local-life\.git\info\exclude` 排除，不入库）。

| # | 命令 | 退出码 | 说明 |
| --- | --- | --- | --- |
| 1 | `& $node $pnpm lint` | 0 | 29 warnings / 0 errors（基线 20 / 0，差异见 §7.3） |
| 2 | `& $node $pnpm typecheck` | 0 | api / web / admin 全部 Done |
| 3 | `& $node $pnpm build` | 0 | web 构建成功（仅 chunk > 500 kB 既有提示） |
| 4 | `& $node $pnpm --filter @sanchuang-dev/local-life-admin test` | 0 | 16 files / **132 tests passed**（含 R2 的 `ProductsPage.test.tsx` 9 项、`OrdersPage.test.tsx` 10 项） |
| 5 | `& $node $pnpm --filter @sanchuang-dev/local-life-api test` | **1** | `ℹ tests 240 / pass 232 / fail 8`，8 条全部是 rewards 的 Windows `rmSync EPERM`；与干净基线 `223/215/8` 失败集**逐条相同**，见 §7.5 |
| 6 | `& $node .evidence\t5-visual.mjs --out docs\engineering\evidence\ll-mvp-010 --prefix t5` | **0** | 231 passed / 0 failed，见 `t5-visual-results.json` |
| 7 | `& $node .evidence\t5-drawer-probe.mjs --out …` | 0 | 抽屉几何，见 `t5-drawer-results.json` |
| 8 | `& $node .evidence\t5-drawer-copy.mjs --out …` | 0 | 抽屉文案，见 `t5-drawer-copy-results.json` |
| 9 | `& $node .evidence\t5-verify-form.mjs --out …` | 0 | 核验表单文案，见 `t5-verify-form-results.json` |
| 10 | `& $node .evidence\t5-cross-community.mjs --out …` | 0 | 跨社区居民侧，见 `t5-cross-community-results.json` |
| 11 | `& $node .evidence\t5-life-fold.mjs --out …` | 0 | 首屏位置，见 `t5-life-fold-results.json` |
| 12 | `& $node .evidence\t5-grid-scope.mjs --out …` | 0 | 网格员越权，见 `t5-grid-scope-results.json` |
| 13 | `& $node .evidence\t5-snapshot.mjs --prefix t5 --out …` | 0 | 快照指纹，见 `t5-snapshot.json` |
| 14 | `& $node .evidence\t5-api-failures.mjs` | 0 | HEAD 与基线的 api 失败集逐条比对 → `identicalFailureSet: true` |

> `apps/web` 没有 `test` 脚本（`apps/web/package.json` 的 `scripts` 只有 dev/build/typecheck/preview），所以 `--filter @sanchuang-dev/local-life-web test` 是空跑成功、**不构成任何通过证据**；H5 侧只有类型检查与真实浏览器两条证据。

## 4. 页面清单与三档截图

全部截图存于 `docs/engineering/evidence/ll-mvp-010/`，像素尺寸已逐个读 PNG 头核对与视口一致。

| # | 页面 | URL | 会话 | 320×720 | 375×812 | 1440×900 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 惠生活（本地好物） | `/local-life/#/life` | 居民 | `t5-life-320.png` | `t5-life-375.png` | `t5-life-1440.png` |
| 2 | 本地商品详情 | `/local-life/#/life/local-products/:productId` | 居民 | `t5-life-product-320.png` | `t5-life-product-375.png` | `t5-life-product-1440.png` |
| 3 | 本地商品详情（未登录） | 同上 | 游客 | `t5-life-product-guest-320.png` | `t5-life-product-guest-375.png` | `t5-life-product-guest-1440.png` |
| 4 | 我的订单 | `/local-life/#/me/orders` | 居民 | `t5-my-orders-320.png` | `t5-my-orders-375.png` | `t5-my-orders-1440.png` |
| 5 | 我的订单详情 | `/local-life/#/me/orders/:localOrderId` | 居民 | `t5-my-order-detail-320.png` | `t5-my-order-detail-375.png` | `t5-my-order-detail-1440.png` |
| 6 | 我的（入口） | `/local-life/#/me` | 居民 | `t5-me-320.png` | `t5-me-375.png` | `t5-me-1440.png` |
| 7 | 网格员工作台·社区订单 | `/local-life/#/workbench/local-orders` | 网格员 | `t5-workbench-local-orders-320.png` | `t5-workbench-local-orders-375.png` | `t5-workbench-local-orders-1440.png` |
| 8 | 网格员工作台·订单详情 | `/local-life/#/workbench/local-orders/:id` | 网格员 | `t5-workbench-local-order-detail-320.png` | `t5-workbench-local-order-detail-375.png` | `t5-workbench-local-order-detail-1440.png` |
| 9 | 管理台·商品管理 | `/products` | 运营员 | `t5-admin-products-320.png` | `t5-admin-products-375.png` | `t5-admin-products-1440.png` |
| 10 | 管理台·订单管理 | `/orders` | 运营员 | `t5-admin-orders-320.png` | `t5-admin-orders-375.png` | `t5-admin-orders-1440.png` |

补充截图 15 张（不计入 231 项）：

| 用途 | 文件 |
| --- | --- |
| 抽屉几何（商品/订单 × 三档） | `t5-drawer-products-{320,375,1440}.png`、`t5-drawer-orders-{320,375,1440}.png` |
| 抽屉文案 | `t5-admin-products-drawer-1440.png`、`t5-admin-orders-drawer-1440.png` |
| 人工核验表单（`待人工核验` 状态） | `t5-admin-order-verify-1440.png` |
| 网格员打开他人社区订单 / 工作台列表 / 管理台被拒 | `t5-workbench-foreign-order-375.png`、`t5-workbench-list-375.png`、`t5-admin-orders-gridworker-375.png` |
| 跨社区居民登记失败 | `t5-cross-community-375.png` |
| 本地好物首屏位置 | `t5-life-fold-320.png`、`t5-life-fold-375.png` |

**会话来源（真实，非伪造）**：居民 `POST /auth/dev/login`；运营员/网格员/管理员 `POST /auth/login`（`r2operator` / `r2grid` / `r2admin`）。Cookie 由 API 真实下发后经 CDP `Network.setCookie` 在首次导航前注入，页面不会先闪一个未登录态。

## 5. 每页两条硬指标

判定口径（写死，避免"看起来通过"）：
- **硬指标 A · 无横向溢出**：`documentElement.scrollWidth <= innerWidth + 1` 且 `body.scrollWidth <= innerWidth + 1`。
- **硬指标 B · 主标题 + 主 CTA 已渲染**：元素存在、`display !== none`、`visibility !== hidden`、`opacity > 0`、`width > 0 && height > 0`。`cta` 只接受可点击元素（`button` / `a` / `role=button`），不会因为正文里出现同名字样就算通过。
- 另有：文案检查（见 §6）、console 与异常检查（见 §7）。

| 页面 | 主标题（断言文本） | 主 CTA（断言文本） | 页面高度 320/375/1440 | 结果 |
| --- | --- | --- | --- | --- |
| 惠生活 | `惠生活` (h1) | `我的订单`（链接） | 1747 / 1768 / 1830 | 6/6 渲染 ✔ 无溢出 ✔ |
| 本地商品详情 | 商品名 `社区助农蔬菜包 r2e2e` (h1) | `登记订单`（按钮） | 1225 / 1266 / 1461 | ✔ |
| 本地商品详情（游客） | 商品名 (h1) | `去登录`（链接，替代会必然失败的按钮） | 1317 / 1358 / 1533 | ✔ |
| 我的订单 | `我的订单` (h1) | 订单行 `社区助农蔬菜包 r2e2e` | 720 / 812 / 900 | ✔ |
| 我的订单详情 | `订单详情` | `返回我的订单` | 1056 / 996 / 996 | ✔ |
| 我的 | `我的订单`（入口卡） | — | 958 / 903 / 900 | ✔ |
| 工作台·社区订单 | `社区订单` | — | 2503 / 2417 / 2085 | ✔ |
| 工作台·订单详情 | 商品名 (h1) | `取消订单`（按钮） | 1246 / 1226 / 1146 | ✔ |
| 管理台·商品管理 | `商品管理` (h2) | `新建商品`（按钮） | 720 / 812 / 900 | ✔ |
| 管理台·订单管理 | `订单管理` (h2) | — | 720 / 812 / 900 | ✔ |

**首屏位置（诚实记录，不计失败）**：11 处断言元素"已渲染但不在当前视口内"，多为长页面自然下推，逐条列于 `t5-visual-results.json` 的 `belowFold`。其中值得产品注意的两条：

- `/life` 的 `我的订单` 文字链在 320 宽时 `top=917`（视口 720），375 时 `top=938`（视口 812）——首屏看不到，需要滚动。但「我的」底栏入口可直达同类页面，所以**不判为缺陷**，仅记录。
- 商品详情的 `登记订单` 按钮在 1440×900 时 `top=1242`（视口 900），需滚动一屏才可见；320/375 时 `top=1006/1047`。登记页把说明文案放在按钮之前是产品选择，非缺陷。

**首屏专项探针**（`t5-life-fold-results.json`）：`本地好物` 标题 `top=216`、首个商品卡 `top=259`，在 320/375 两档均在首屏内，且其上方无其他小节（`sectionsBefore: []`）——R2 确实把本地目录置顶了。

## 6. 文案检查

禁用词：`支付成功`、`已成交`、`已开通`、`付款成功`、`已支付`。

- **30/30 页面全文零命中**（`t5-visual-results.json` 每页 `forbidden: []`）。
- 抽屉与核验表单补充探针同样零命中（`t5-drawer-copy-results.json`、`t5-verify-form-results.json`）。

正向文案（应当说清楚的免责），实测命中：

| 位置 | 实测文案（节选） | 证据 |
| --- | --- | --- |
| 商品详情登记区 | 只登记办理意向，平台不收款、不代下单；工作人员会按登记信息联系你。 | `t5-life-product-375.png` |
| 商品详情价格 | 本页价格由社区维护，登记订单时由服务端冻结商品名称与单价快照。 | 同上；抽屉内亦有「按元录入…服务端冻结该价格快照」 |
| 登记成功态 | 办理意向已登记 / 订单已提交…平台不收款，这也不代表业务已开通。 | `LocalProductPage.tsx:276-280` |
| 我的订单 | 本页只登记办理意向 / 平台不收款、不代下单。「人工核验通过」是运营人员对订单事实的人工确认，不代表已收款或业务办理已完成。 | `t5-my-orders-375.png` |
| 管理台订单抽屉 | 本订单只登记办理意向 / 本平台不收款、不代办业务；「人工核验通过」是运营员对订单事实的人工确认。 | `t5-admin-orders-drawer-1440.png` |
| 核验结论区 | 该结论仅为人工事实核验，不代表收款、成交或业务办理已完成。 | `t5-admin-order-verify-1440.png` |
| 工作台订单详情 | 本平台只登记办理意向，不收款、不开通业务。「人工核验通过」只能由运营人员在后台完成，工作台不可直接设置。 | `t5-workbench-local-order-detail-375.png` |

状态标签实测为「已登记 / 处理中 / 待人工核验 / 人工核验通过 / 已取消 / 未通过」，没有把 `verified` 渲染成「已付款」「已开通」。

## 7. console / 异常 / 网络

### 7.1 本轮结果
- **未捕获异常**：30/30 页面 `pageErrors` 为空。
- **失败网络请求**：30/30 页面为空（含 `>=400` 响应；页面自身 abort 已单独归类，不计入失败）。
- **本分支引入的 console error**：0 条。

### 7.2 6 条 `Drawer width` 废弃告警：已转绿（核心判定）

- **修复前**（R2 尚未提交、工作区仍为 `width={520}` / `width={600}`）实跑：`225 passed, 6 failed`，6 条失败全部是
  `Warning: [antd: Drawer] 'width' is deprecated. Please use 'size' instead.`，出现在 `admin-products-{320,375,1440}` 与 `admin-orders-{320,375,1440}`。
  原始日志：`.evidence/t5-visual.log`。
- **修复后**（`ac4c385`）：同一命令 **`231 passed, 0 failed`**，该告警零出现。
- 提交内容已核实：`git show ac4c385:apps/admin/src/pages/ProductsPage.tsx` → `size={520}`；`…/OrdersPage.tsx` → `size={600}`；工作区与提交一致（`r2FilesDirtyNow: []`）。
- **几何复核（告警消失不等于布局正确，故单测）** —— `t5-drawer-results.json`：

| 页面 | 320×720 | 375×812 | 1440×900 |
| --- | --- | --- | --- |
| 商品管理·新建抽屉 | 面板 320px，`left=0`，铺满，不溢出 | 375px，不溢出 | 520px，`right=1440`，不溢出 |
| 订单管理·详情抽屉 | 320px，不溢出 | 375px，不溢出 | 600px，不溢出 |

`summary: { allOpen: true, noneOverflowViewport: true, noDocOverflow: true }`，窄屏下抽屉自适应铺满而不是把 520/600 硬撑出横向滚动条。

### 7.3 仍存在的 console 告警（既有代码，非本分支）
6 条（每个管理台页面 × 三档各 1 条）：

```
Warning: [antd: Spin] `tip` is deprecated. Please use `description` instead.
```

来源 `apps/admin/src/App.tsx:75` 的 `<Spin tip="正在读取登录状态…" />`。**该文件未被 R2 提交触碰**（`git show --name-only ac4c385` 的 `apps/admin` 10 个文件中不含 `App.tsx`），即 `origin/dev` 上就已存在，本次验证按"既有噪声"处理并在报告中保留可见性，**不作为 R2 缺陷**。

分类规则写在 `t5-visual.mjs` 的 `CONSOLE_CLASSES`：只有能匹配到既有代码的告警才降级为 `pre-existing`，任何未分类的 console error 一律算作本分支发现（本次为 0 条），不会被静默丢弃。

### 7.4 lint 差异核实（基线 20 → 29）
`lint` 退出码 0，`29 warnings / 0 errors`。逐条按 `文件|规则` 与基线 `origin/dev@ae8441a` 做差集（`.evidence/t10-lint-baseline.log` vs `.evidence/t5-head-lint.log`），**净新增 9 条，无一条被消除**：

| 文件:行 | 规则 | 是否 R2 新文件 |
| --- | --- | --- |
| `apps/admin/src/pages/ProductsPage.tsx:749` | `react(only-export-components)` | 是（新增） |
| `apps/web/src/hooks/useStaffLocalOrders.ts:62` | `react(set-state-in-effect)` | 是（新增） |
| `apps/web/src/hooks/useStaffLocalOrders.ts:141` | `react(set-state-in-effect)` | 是（新增） |
| `apps/web/src/hooks/useLocalOrders.ts:58` | `react(set-state-in-effect)` | 是（新增） |
| `apps/web/src/hooks/useLocalOrders.ts:149` | `react(set-state-in-effect)` | 是（新增） |
| `apps/web/src/hooks/useLocalCatalog.ts:40` | `react(set-state-in-effect)` | 是（新增） |
| `apps/web/src/hooks/useLocalCatalog.ts:89` | `react(set-state-in-effect)` | 是（新增） |
| `apps/admin/src/pages/OrdersPage.tsx:204` | `react(set-state-in-effect)` | 是（新增） |
| `apps/admin/src/pages/OrdersPage.tsx:223` | `react(set-state-in-effect)` | 是（新增） |

结论：**9 条全部来自 R2 新文件；规则种类与仓库既有完全同类**（基线本来就 `set-state-in-effect` 10 条、`only-export-components` 6 条，分布在 `CrmPage`/`ActivitiesPage`/`ActivityCheckinPage`/`App.auth.test.tsx`/`useRewardWallet` 等），属既有模式的延续，不是新风险类别，仅记录、不返修。`ProductsPage.tsx:749` 的 `export const productPriceHelpers` 是为页面测试暴露的工具，与仓库既有测试导出写法一致。

### 7.5 api 测试：8 例 rewards EPERM（既有环境问题，未修复，也不涉本次改动）

`pnpm --filter @sanchuang-dev/local-life-api test` 退出码 **1**，`ℹ tests 240 / pass 232 / fail 8`。8 条失败全部是同一形态：

```
Error: EPERM, Permission denied: 'C:\Users\ADMINI~1\AppData\Local\Temp\ll-version-edit-…'
  at rmSync (node:fs:1282:18)
  at Object.cleanup (apps/api/test/rewards-version-edit.test.ts:161:20)
```

对照证据（`.evidence/t5-api-failures.mjs` 自动比对）：

| 日志 | tests / pass / fail | 失败用例 |
| --- | --- | --- |
| 干净基线 `origin/dev@ae8441a`（`.evidence/baseline-eprem-api-test.log`） | 223 / 215 / **8** | 8 条 rewards |
| 当前 HEAD `ac4c385`（`.evidence/t5-head-api-test.log`） | 240 / 232 / **8** | 同一 8 条 |

`identicalFailureSet: true`，`only in HEAD: []`，`only in BASELINE: []`——失败集合逐条相同（用例名与临时目录前缀均一致），差异只是本次新增的 17 条本地目录/订单用例全部通过（223→240 的总数增长即来自 R1/R2 新增用例）。

结论：**这是 Windows 上 `rmSync` 删临时目录的既有环境缺陷，不是本分支引入，也不得声称已修复**。t10 已在干净 worktree 上做过同样的对照（`docs/engineering/evidence/ll-mvp-010/verification-api.md` §4）。

## 8. 未验证面（明确写出，勿当作通过）

1. **真实设备**：只有 Chrome 桌面版 `--headless=new` + 视口模拟，**未测** iOS Safari、微信内置浏览器、Android WebView、真机触摸与安全区（`safe-area-inset`）。
2. **交互回归**：除"打开抽屉/打开页面"外**未在浏览器里点击业务动作**。具体未点：
   - 居民端「登记订单 / 提交办理意向」的**成功**路径（成功态文案由代码与 API 契约核对，未由 UI 点击产生）；
   - 管理台「确认人工核验通过」「驳 回」「标记未通过」「创建商品」「上架/下架」的提交（仅验证按钮与表单渲染、文案正确、API 侧等价路径在 t10 已覆盖）；
   - 网格员「取消订单」「开始处理」的提交。
   这些属维护者明确缓办的交互/视觉深挖范围，**不能据本文声称已通过**。
3. **无障碍**：未做键盘遍历、焦点顺序、焦点环可见性、屏幕阅读器输出、颜色对比度、`axe` 扫描。
4. **主题/动效**：未测暗色模式、`prefers-reduced-motion`、系统字体放大/浏览器缩放（125%/150%）。
5. **状态覆盖不全**：已覆盖 有数据（本地目录 4 件）/ 游客（商品详情）/ 跨社区拒绝 / 网格员越权。**未覆盖**：空目录空态、我的订单空态、列表加载骨架、网络错误态、401 会话过期重定向、分页 `hasMore` 提示、图片加载失败占位。
6. **多浏览器/多引擎**：只有 Chromium，未验证 Firefox / WebKit。
7. **数据形态**：全部基于本地 dev 库 `.data/local-life-dev.sqlite`（含 R2 自建的 `r2e2e` 测试商品、`邻社区商品`），**非生产形态数据**；数据量变化会改变页面高度与 `belowFold` 清单。
8. **会话前提**：居民会话来自 `POST /auth/dev/login`，该路由仅在非 production 且 `AUTH_DEV_ENABLED=true` 时存在（`apps/api/src/app.ts:515`）。生产形态下居民登录方式未被本任务验证。
9. **性能**：未测首屏时间、包体积（构建有既存 `chunk > 500 kB` 提示）、弱网。
10. **管理台 320/375 宽**：管理台是桌面后台，320/375 只是"不溢出"下限检查，**未验证在窄屏是否可实际办公**（表格列、操作按钮可点性）。

## 9. 补充探针（超出两条硬指标，但直接对应 R2 需求）

| 探针 | 结论 | 证据 |
| --- | --- | --- |
| 抽屉文案 | 订单抽屉含「运营人工核验」区与免责句；商品页含「上架/下架」控制、创建抽屉含价格快照说明；禁用词零命中 | `t5-drawer-copy-results.json`：`orderDrawerShowsManualVerification=true`、`orderDrawerDisclaimsPayment=true`、`productPageShowsShelfControl=true`、`productDrawerExplainsPriceSnapshot=true`、`noForbiddenCopyAnywhere=true` |
| 核验表单 | 把订单经真实 PATCH（`processing`→`pending_review`，均 200）推进后打开抽屉：可见「运营人工核验」区、备注框 `0/500`、「确认人工核验通过」、「驳 回」、「标记未通过」，并有「不代表收款、成交或业务办理已完成」 | `t5-verify-form-results.json`、`t5-admin-order-verify-1440.png` |
| 跨社区居民登记（负例） | 服务端 403 `forbidden`「居民不属于该社区，无法登记该商品」；UI 在点击后以 `role=alert` 原样呈现该句，不静默、不伪装成功 | `t5-cross-community-results.json`、`t5-cross-community-375.png` |
| 网格员越权（负例） | 打开他社区订单：API 403 `forbidden`；页面显示「订单详情加载失败 / 没有权限：无权访问该社区的数据」，**不泄露**居民姓名、不显示金额、不渲染任何状态操作按钮；工作台列表**不含**该订单；网格员打开管理台 `/orders` 被拒 | `t5-grid-scope-results.json`（`verdict` 6 项全 true）、`t5-workbench-foreign-order-375.png` 等 |
| 首屏位置 | 「本地好物」`top=216`、首卡 `top=259`，320/375 均在首屏 | `t5-life-fold-results.json` |

## 10. 非阻断观察（供维护者取舍，均**不要求 R2 修改**）

**O-A｜跨社区商品在 H5 仍展示可点的「登记订单」按钮。**
`GET /catalog/products` 是免登录的公开上架目录（R1 设计如此，H5 未按社区过滤），因此 A 社区居民能看到 B 社区商品；`LocalProductPage.tsx:51` 的 `canRegister` 只判断 `session && status === 'on_shelf'`，不含"居民是否属于该商品社区"。点下去由服务端 403 拦下，文案清楚（「没有权限：居民不属于该社区，无法登记该商品」）。
- 现状：**服务端隔离正确，UI 体验是"事后告知"而非"事前解释"**。
- 如需优化（可选，非本次返修）：`apps/web/src/pages/LocalProductPage.tsx:51-57` 增加"居民社区 ≠ 商品社区 → 不渲染可点按钮，改为说明句"，与 `unavailableAction` 现有分支同构。
- 依据：#109 的「跨社区隔离」是服务端权限要求，本项不构成违反。

**O-B｜`/life` 的「我的订单」文字链在 320/375 首屏之外**（`top≈917/938`）。底栏「我的」可到达同类入口，故不判缺陷；若后续做转化优化可考虑上移。

**O-C｜保留的 antd `Spin tip` 告警**（§7.3）。属 `apps/admin/src/App.tsx:75` 既有代码，可另行清理，与 #109 无关。

**O-D｜管理台抽屉在 320/375 铺满整屏**（§7.2）。这是 antd 对超窄屏的自适应行为，R2 的 `size={520}/{600}` 是桌面目标宽度，符合预期。

## 11. 返修清单

**无。** t5 无失败项，无需返修的文件与行号。上述 O-A～O-D 均为可选优化与既有问题记录，不作为准入条件。

## 12. 证据索引

| 文件 | 内容 |
| --- | --- |
| `t5-visual-results.json` | 30 次加载 / 231 项断言、`belowFold` 11 条、`preExistingConsole` 6 条、`blindSpots` |
| `t5-visual-pages.json` | 每页逐项断言明细（`found/rendered/inViewport/top`）与首 200 字正文 |
| `t5-snapshot.json` | HEAD、28 个 R2 文件与聚合指纹、验证时是否脏 |
| `t5-drawer-results.json` | 抽屉几何（三档 × 2 页） |
| `t5-drawer-copy-results.json` | 抽屉文案断言 |
| `t5-verify-form-results.json` | 核验表单断言 + 真实状态流转记录 |
| `t5-cross-community-results.json` | 跨社区居民侧 API/UI 对照 |
| `t5-grid-scope-results.json` | 网格员越权 API/UI/列表/管理台 6 项判定 |
| `t5-life-fold-results.json` | 「本地好物」首屏位置 |
| `t5-*.png`（45 张） | 30 张核心三档 + 15 张补充 |

> 脚本位于 `.evidence/`（git exclude，不入库）：`t5-visual.mjs`、`t5-drawer-probe.mjs`、`t5-drawer-copy.mjs`、`t5-verify-form.mjs`、`t5-cross-community.mjs`、`t5-life-fold.mjs`、`t5-grid-scope.mjs`、`t5-snapshot.mjs`、`t5-api-failures.mjs`，共用 t9 的 `browser-verify.mjs`（CDP 驱动）与 `local-stack.mjs`（本地栈）。
> 原始日志（同样在 `.evidence/`）：`t5-visual.log`（修复前 225/6）、`t5-visual-head.log`（修复后 231/0）、`t5-head-lint.log`、`t5-lint-final.log`、`t5-head-api-test.log`、`baseline-eprem-api-test.log`、`t5-admin-test-final.log`。
> 工作区未跟踪的 `.tmp-review-temp/`（32 文件）是他人审查产物，**不属于本任务产出**；本任务所有一次性脚本与日志均落在 `.evidence/`，未进入仓库索引。
