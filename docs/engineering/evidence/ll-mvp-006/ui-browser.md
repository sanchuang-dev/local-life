# LL-MVP-006 · H5 与后台接线：真实浏览器验证证据

本文件记录在**真实浏览器**里对 LL-MVP-006 前端接线做的实测结果：居民 H5 的签到进度 /
团队奖励 / 一次性凭据、`/me/rewards`、网格员移动端现场核验、管理台`报名与核销`页，以及
管理台活动编辑抽屉在「有 / 无奖励计划」两态下的行为。

- 施工分支：`feat/ll-mvp-006-checkin-rewards`（基线 `dev@7095b845`）
- 本卡改动范围：`apps/web/src/**`、`apps/admin/src/**`（`apps/api` / `packages/contracts` 由
  a1/a2 在共享工作区内改动，见 §10 声明；本卡未修改这两个目录）
- 采集脚本：[`browser/verify.cjs`](browser/verify.cjs)（本目录内可复现）
- 机器可读结果：[`browser-runs.json`](browser-runs.json)
- 截图：[`browser/`](browser/)（18 张，两两互不相同，已用 md5 校验无重复）

---

## 1. 结论摘要

| 验证项 | 结论 | 证据 |
| --- | --- | --- |
| 银发活动页真实签到 / 团队奖励 / 凭据 | 通过 | `ui-375-campaign-real`、`ui-320-campaign-real` |
| 未核验签到不得伪装成已签到 | 通过（服务端 `verifiedAt: null` 与 UI 一致） | `ui-375-unverified-copy` |
| 未核验签到不计入团队奖励进度 | 通过（2/3 而非 3/3） | `ui-375-progress-excludes-unverified` |
| 一次性凭据：领取当次明文、刷新后只剩尾号 | 通过 | `ui-claim-code-shape`、`ui-credential-masked-after-reload` |
| 未满 3 条已核验时领奖被拒 | 通过（409 `reward_unavailable`，未发码） | `ui-claim-blocked-by-unverified` |
| 网格员输码核销成功 | 通过（真实回执） | `ui-375-redeem-success` |
| 重复核销 / 未知码负例 | 通过（按 `error.code` 给真实文案） | `ui-375-redeem-duplicate`、`ui-375-redeem-invalid` |
| 375 / 320 无横向溢出 | 通过（全部 `scrollWidth === clientWidth`） | 见 §3 表格 |
| 窄屏页签可达 | 通过（antd「更多」下拉可进入） | `admin-375-tabs-reachable`、`admin-320-tabs-reachable` |
| 编辑抽屉「有计划」回填 | 通过（奖品名称/成本/数量/库存/预算/有效期 6 项逐一比对服务端值） | `admin-drawer-plan-backfill` |
| 编辑保存不丢奖励计划 | 通过（PATCH 原样回传，规则版本 v1→v2） | `admin-patch-echoes-plan`、`admin-plan-survives-edit` |
| 无修改直接保存 | 通过（0 个 PATCH，规则版本仍为 v1） | `admin-noop-save-no-patch` |
| 编辑抽屉「无计划」告警 | 通过（不是空表单） | `admin-drawer-no-plan` |
| **抽奖 / 大奖 / 阶梯** | **仍是前端演示，未接真实发放** | §6 |

采集结果：**35 条断言全部通过**（`browser-runs.json` 的 `totals` 字段：`{assertions: 35,
passed: 35, failed: 0}`）。

---

## 2. 验收环境与复现方法

### 2.1 端口与数据库

为避免污染日常开发库，本轮验证使用**隔离的一套栈**（独立端口 + 独立 SQLite 文件），
未改动 `.data/local-life-dev.sqlite`，也未改动 `apps/api/.env.local`：

| 角色 | 地址 | 说明 |
| --- | --- | --- |
| API | `http://127.0.0.1:4082` | `PORT=4082`，真实 Hono 进程 |
| H5 | `http://localhost:5224/local-life/` | `LOCAL_LIFE_WEB_PORT=5224`，Vite 代理 `/api` → 4082 |
| Admin | `http://localhost:5225/` | `LOCAL_LIFE_ADMIN_PORT=5225`，同上 |
| DB | `/tmp/ll-mvp-006-ui/verify.sqlite` | `db:prepare` 新建，33 张表 |
| Chrome | `156.0.8078.80` | `--headless=new --remote-debugging-port=9222` |

管理员账户由仓库自带脚本交互式创建，**不直写 `staff_accounts`、不使用内置默认密码**：

```bash
DB=/tmp/ll-mvp-006-ui/verify.sqlite
NODE_ENV=development DATABASE_PATH="$DB" \
  pnpm --filter @sanchuang-dev/local-life-api db:prepare
DATABASE_PATH="$DB" \
  pnpm --filter @sanchuang-dev/local-life-api bootstrap-admin   # 交互式输入登录名/显示名/密码
```

API 启动（`AUTH_DEV_ENABLED=true` 才会开启居民 dev-login）：

```bash
NODE_ENV=development HOST=127.0.0.1 PORT=4082 DATABASE_PATH="$DB" \
AUTH_DEV_ENABLED=true \
TRUSTED_ORIGINS='http://localhost:5224,http://127.0.0.1:5224,http://localhost:5225,http://127.0.0.1:5225' \
WEB_BASE_URL='http://localhost:5224/local-life/' \
  pnpm --filter @sanchuang-dev/local-life-api exec tsx src/index.ts
```

Chrome 启动参数（裸 CDP，未安装 puppeteer；驱动用仓库已有的 `ws`）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-prof-006 --no-first-run --disable-gpu \
  --hide-scrollbars about:blank
```

### 2.2 用到的 CDP 方法

| 方法 | 用途 |
| --- | --- |
| `Page.enable` / `Runtime.enable` / `Network.enable` | 开通域 |
| `Emulation.setDeviceMetricsOverride` | 设置 375/320/1440 视口（`deviceScaleFactor: 2`，窄屏 `mobile: true`） |
| `Network.clearBrowserCookies` + `Network.setCookie` | 在居民 / 网格员 / 管理员身份间切换 |
| `Page.navigate` | 打开页面 |
| `Runtime.evaluate`（`awaitPromise: true, returnByValue: true`） | 读取 DOM、量宽度、点击、注入输入 |
| `Page.captureScreenshot` | 截图 |
| `Network.requestWillBeSent` | **断言真实 PATCH 请求体**（不是看 UI 猜） |

**关键坑（复现时必看）**：只改 hash 的 `Page.navigate` 属于 same-document 导航，React
不会重新挂载，量到的会是上一个身份的旧状态。切换身份或需要重新拉数据时，必须先
`Page.navigate` 到 `about:blank` 再导航到目标 URL（脚本中即 `open(url, { forceReload: true })`）。

### 2.3 复现命令

```bash
node docs/engineering/evidence/ll-mvp-006/browser/verify.cjs \
  --out /tmp/ll-mvp-006-ui/out \
  --admin-session "$LL_SESSION" --admin-csrf "$LL_CSRF"
```

脚本自己完成：建社区 → 建网格员账户（`POST /admin/staff`）→ 建 3 场活动并发布 →
6 名居民 dev-login、入团（3+3）、签到 → 管理员核验（A 场 3/3，B 场故意只核验 2/3）→
A 场队长领码 → 打开浏览器逐页测量、截图、走核销正负例 → 管理台四页签与编辑抽屉两态。

---

## 3. 逐路径宽度实测

判定标准是 `documentElement.scrollWidth === documentElement.clientWidth`，
且没有「不受祖先裁剪」的越界元素。下表数字均为实测值。

| 路径 | 视口 | `clientWidth` | `scrollWidth` | `body.scrollWidth` | 页面溢出 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `#/community/activity/silver-neighborhood?activityId=A` | 375×812 | 375 | 375 | 375 | 否 | 真实签到/奖励/凭据 |
| 同上 | 320×812 | 320 | 320 | 320 | 否 | |
| `#/me/rewards` | 375×812 | 375 | 375 | 375 | 否 | 2 个元素被容器裁剪 |
| `#/me/rewards` | 320×812 | 320 | 320 | 320 | 否 | 3 个元素被容器裁剪 |
| `#/workbench/verify` | 375×812 | 375 | 375 | 375 | 否 | 网格员入口 |
| `#/workbench/verify` | 320×812 | 320 | 320 | 320 | 否 | |
| `#/activities/checkin`（管理台） | 1440×900 | 1440 | 1440 | 1440 | 否 | |
| `#/activities/checkin`（管理台） | 375×812 | 375 | 375 | 375 | 否 | 8 个元素被容器裁剪 |
| `#/activities/checkin`（管理台） | 320×812 | 320 | 320 | 320 | 否 | 8 个元素被容器裁剪 |

**关于「被裁剪」**：`overflow-x: hidden/auto/scroll` 的祖先会把超宽子元素裁掉或收进自己的
滚动区，既不会撑宽 `document`，也不构成页面溢出。本轮唯一的此类情况是 **antd `Tabs`**：
窄屏下未激活的页签被收进右侧「更多」下拉。这不是布局缺陷，但**必须验证页签仍可达**，
因此单独设了断言：

| 视口 | 被裁剪页签 | 「更多」下拉项 | 可达 |
| --- | --- | --- | --- |
| 375×812 | 核销记录、异常处理 | 核销记录、异常处理 | 是 |
| 320×812 | 核销记录、异常处理 | 奖励列表（0）、核销记录、异常处理 | 是 |

> 说明：中途我曾把「被裁剪」误判为「页面溢出」而报 FAIL，查明是裁剪而非溢出后，改成把
> 两类分开统计，并补了上面这条可达性断言。旧的判断会冤枉可用的溢出菜单。

---

## 4. 凭据码与核销：真实数据

### 4.1 本轮真实码

本轮（`runTag 2026-11-04T13-13-50-216Z`，见 `browser-runs.json` 的
`setup.mintedPlaintextCodes` / `setup.redeemedCode`）铸造并核销的码：

| 码 | 场景 | 结果 |
| --- | --- | --- |
| `DPRP9KA29E` | 主活动（东北大米 10 斤装）3 人成团、3/3 已核验，队长在 H5 领取 | 领取当次显示明文 → 刷新后仅 `******A29E` → 网格员输码核销成功 |

格式断言：10 位、字符集 `0-9A-Z` 去掉易混的 `I/L/O/U`（正则 `^[0-9A-HJKMNP-TV-Z]{10}$`）。

> 明文只在**领取那一次响应**里出现。截图里的显示值一律是尾号形态；本节写出完整码是因为
> 该码所在的库是 `/tmp` 下的一次性验收库，已核销失效，且脚本每次运行都会重新铸造新码，
> 旧码不可复用。**每次重跑都会得到不同的码**，请以当次 `browser-runs.json` 为准。

### 4.2 「刷新后只剩尾号」怎么证

同一会话重新加载活动页后：

- 页面文本中 **不再包含**完整码（`plaintextStillVisible: false`）
- 只出现 `******A29E`，尾号与原码后 4 位一致（`codeTail: "A29E"` = `displayedTail: "A29E"`）

并且实测该尾号元素确实落在视口内（`top 402 / bottom 420 / viewport h 812`），
所以那张截图**真的拍到了**它，而不是靠「调用过 scrollIntoView」宣称拍到。

### 4.3 三条服务端负例（UI 按 `error.code` 给文案，不伪造成功）

| 场景 | 服务端 | UI 文案 | 断言 |
| --- | --- | --- | --- |
| 团队只有 2/3 已核验就领奖 | `409 reward_unavailable`，`message: 团队有效签到不足 3 条，暂不满足奖励条件`，**未发码** | 「团队有效签到不足 3 条，暂不满足奖励条件。」 | `ui-claim-blocked-by-unverified` |
| 重复核销同一码 | `409 reward_already_redeemed` | 「该核销码已被核销 / 该凭据已被核销过，不能重复发放。」 | `ui-375-redeem-duplicate` |
| 未知码 `ZZZZZZZZZZ` | `404 redemption_code_invalid` | 「核销码无效 / 该码不存在、已被换新码或已被作废。」 | `ui-375-redeem-invalid` |

成功回执（真实数据，非模板）：`核销成功，奖品已交付。 / 奖品 东北大米 10 斤装 × 3 /
领取人 队长 张阿姨 / 奖励状态 已核销 / 核销时间 2026-11-04 21:14 / 凭据尾号 ******A29E`。

### 4.4 未核验 vs 已核验（同一团队、同一活动）

活动 B 故意只核验 3 人中的 2 人，同一页面分别以两名团员身份打开：

| 身份 | 签到状态徽标 | 文案 | 团队奖励进度 |
| --- | --- | --- | --- |
| 周阿姨（未核验） | `待核验` | 签到成功，待现场核验。核验通过后才计入团队奖励进度。 | `2/3`，且提示「团队有效签到不足 3 条」 |
| 吴大爷（已核验） | `已核验` | 签到已由工作人员现场核验，计入团队奖励进度。 | `2/3`（团队仍差 1 人） |

服务端事实：周阿姨 `verifiedAt: null`，另两人非空；`counts { valid: 3, verified: 2,
pendingVerification: 1 }`。两者进度都显示 2/3，是因为进度按**团队已核验数**算——
未核验那位没有把自己算进去，这正是要证明的点。

---

## 5. 管理台

### 5.1 `/activities/checkin` 的数据来源

页面上的每个数字都来自服务端，没有任何本地造数或占位。逐字段对照：

| 页面元素 | 来源 |
| --- | --- |
| 活动下拉选项（标题 · 社区 · 状态 · `vN`） | `GET /admin/activities?page=1&pageSize=50` |
| 四张统计卡：有效签到 / 已发放奖励 / 剩余库存 / 剩余预算 | `GET /admin/activities/:id/rewards` 的 `counts.*` 与 `stock.*` |
| 「冻结的奖励计划」卡片 9 项 | `overview.plan.*` + `planSource` + `ruleVersion` |
| 签到核验表 | `GET /admin/activities/:id/checkins` 的 `items` 与 `counts` |
| 奖励列表、核销记录 | `overview.grants` / `overview.codes` |
| 异常处理面板 | 已撤销签到 + `disputed`/`revoked` 的授予记录 |

**仅本地推导**（不改变事实，只做呈现）：货币与百分比格式化、`STATUS_META` 状态中文标签、
页签上的计数后缀、撤销原因提示文案。`planSource: 'none'` 渲染为「该活动未配置奖励计划」，
**不回退读活动表的可变字段**，也不显示一张全 0 的库存表。

### 5.2 编辑抽屉「有计划」态：回填自真实 `rewardPlan`

在 `/activities` 打开主活动抽屉读出的值（**不是** placeholder、不是只读降级）。
下表中「强度」一列区分了证据等级：**自动断言**指脚本把抽屉读到的值与服务端
`detail.rewardPlan` 逐字段做等值比较；**旁证**指值已记录在 `browser-runs.json` 里与
服务端一致，但脚本未写成硬断言。

| 字段 | 抽屉实测值 | 服务端值 | 强度 |
| --- | --- | --- | --- |
| 开关 | 开启 | `rewardPlan` 存在 | 自动断言 |
| 奖品名称 | 东北大米 10 斤装 | 同 | 自动断言 |
| 单件成本（元） | 45.00 | `4500` 分 | 自动断言 |
| 每团奖品数量 | 3 | 3 | 自动断言 |
| 奖品总库存（份） | 30 | 30 | 自动断言 |
| 奖励预算上限（元） | 1350.00 | `135000` 分 | 自动断言 |
| 核销有效期（小时） | 72 | 72 | 自动断言 |
| 领取人 | 仅队长 | `claimRecipient: 'leader'` | 旁证 |
| 签到窗口 | 2026-11-03 21:13 \| 2026-11-16 21:13 | 同（Asia/Shanghai） | 旁证 |
| 备注 | 社区仓库统一发放 | `notes` 同 | 旁证（见 `textareas`） |

### 5.3 保存不丢计划：抓真实 PATCH 请求体

只改「举办地点」再保存 → 弹出确认「保存将生成新规则版本 v2」→ 确认。抓到的请求体：

```json
{"expectedUpdatedAt":"…","keyRules":{…,"location":"幸福社区文化广场（证据采集）",
 "rewardPlan":{"prizeName":"东北大米 10 斤装","prizeUnitCostCents":4500,
 "prizeQuantityPerTeam":3,"totalPrizeQuantity":30,"budgetCapCents":135000,
 "claimRecipient":"leader","checkinWindow":{…},"redemptionValidHours":72,
 "notes":"社区仓库统一发放"}}}
```

即 `keyRules.rewardPlan` **原样回传，绝不是 `null`**。保存后服务端复核：`ruleVersion` 由
`1` 变 `2`，`planConfigured: true`、`planSource: 'rule_version_snapshot'`、
`stock.totalQuantity: 30`、`stock.claimedQuantity: 3`（已发出去的 3 份仍在账上）。

对照：**无修改直接保存**不发任何 PATCH（`patchCount: 0`），提示「没有需要保存的修改。」，
且之后规则版本仍为 `v1`——即不会因为一次空保存就凭空产生新版本。

### 5.4 编辑抽屉「无计划」态

无计划活动（`银发验收无计划 …`）打开抽屉：开关为关闭，并显示告警
「未配置奖励计划 / 未配置奖励计划时，发布后居民签到、达标与领奖入口不可用，服务端返回
409 reward_unavailable。」——**不是**一组空白输入框。打开开关才会展开字段，关回去恢复告警。

---

## 6. 明确未接真实履约的部分（demo）

以下内容在 H5 上**仍然是前端演示**，不产生任何服务端记录，也没有真实发放/扣减。
它们与本轮接线的真实功能同页共存，因此这里逐条列出，避免把演示误读为已履约：

| 区块 | 页面原文 | 实际行为 |
| --- | --- | --- |
| 今日抽奖 | 「奖品与抽取均为前端演示，不代表真实发放」 | 前端随机，无 API 调用、无库存扣减 |
| 活动压轴大奖 | 「奖品仅作活动示例」 | 纯展示 |
| 社区里程碑 / 热力榜 | 「以下内容仍为前端演示、不产生真实记录」 | 本地推算的展示数字 |
| 消费组队 | 同上 banner | 无真实组队数据 |
| 成团好礼示例奖品（鸡蛋/纸巾） | 「示例奖品 · 非真实库存」 | 静态示例 |

页面顶部 banner 原文：「以下内容仍为前端演示、不产生真实记录：今日抽奖、活动压轴大奖、
社区里程碑与热力榜、消费组队」。

**真实**的只有：签到（`POST /activities/:id/checkin`）、团队进度与资格、领奖发码
（`POST /activities/:id/rewards/claim`）、凭据尾号、网格员核销、管理台核验/撤销与审计。
商城、支付、对账（Issue #64）不在本卡范围，也未实现。

---

## 7. 未执行 / 不覆盖

1. 未在真机（iOS Safari / 微信内置浏览器 / Android WebView）验证，只用了桌面 Chrome 的
   移动视口模拟（`mobile: true`, `deviceScaleFactor: 2`）。真机的安全区、软键盘与
   长按选中未覆盖。
2. 未做并发核销压测。「重复核销只成功一次」这里验证的是**同一码串行重复提交**；
   真正的并发（多请求同时打同一码）由服务端一次性语义保证，本卡未做压力级复现。
3. 未验证小程序 / 公众号场景（本仓库 H5 为独立站点）。
4. 未连接真实微信支付、商城或对账系统（不在范围）。
5. 未对 320 宽度下的全部历史页面做回归，只覆盖本卡新增/改动的 4 条路径 + 3 个视口。

---

## 8. 过程中发现并修正的两个问题（如实记录）

1. **我的脚本一度把「被容器裁剪」当成「页面溢出」**，导致 `admin-320-checkin` 报 FAIL。
   实测 `scrollWidth === clientWidth === 320`，真正情况是 antd `Tabs` 把未激活页签收进了
   「更多」下拉。已改为分类统计，并新增「页签可从更多菜单进入」的断言。
2. **截图一开始拍的是页面顶部，断言内容在首屏下方**，导致两张图字节相同、无法佐证断言。
   实测应用滚动发生在内部容器（`.app-content`）而截图只覆盖视口，已改为先
   `scrollIntoView` 再截图，并记录目标元素的视口矩形（`top/bottom/left/right`）作为
   「截图里确实能看到」的实测依据。现在 18 张截图两两互不相同。

另外记录一个**环境噪声，不是产品缺陷**：在早期几轮里，`GET /admin/activities/:id` 曾数次
返回 `500 ZodError`，网格员页面曾出现一次 `HTTP 502`。原因是 `pnpm check` 重建
`packages/contracts/dist` 时 `tsx watch` 正在重启 API（日志为 `connect ECONNREFUSED`）。
等重启稳定后同一请求即 200，未再复现；本节 §2 的隔离栈改用固定 API 进程后也不再出现。
本文件所有结论均来自最终那次完整、干净、`35/35` 通过的运行，不依赖这些瞬时失败的时点。

---

## 9. 代码质量门

本卡（前端）范围内单独验证的结果（写本文档时重跑）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| web 类型 | `pnpm --filter @sanchuang-dev/local-life-web exec tsc -b` | 通过 |
| admin 类型 | `pnpm --filter @sanchuang-dev/local-life-admin exec tsc --noEmit` | 通过 |
| admin 测试 | `pnpm --filter @sanchuang-dev/local-life-admin test` | `10 files / 91 tests` 全通过 |
| oxlint | `pnpm check` 首段 | `Found 17 warnings and 0 errors.` |

oxlint 的 17 条是仓库既有基线，其中本卡新增文件命中 `react(set-state-in-effect)`
（`useRewardProgress.ts`、`useRewardWallet.ts`、`ActivityCheckinPage.tsx`）。
按队长要求**保持现状不改**，不为了让计数变干净去改既有告警。

**关于 `pnpm check` 整体**：写本文档时 `pnpm check` **不是 exit 0**，失败点在
`apps/api/src/rewards/service.ts` 的类型错误（`ActivityRow` 无 `endsAt`、`RewardGateReason`
联合类型不匹配）。该文件属于 a1-data / a2-api 的施工范围，且在本文档成文的同一分钟内仍在
被编辑（共享工作区）。后端 typecheck 与 `157 + 7` 项 API 测试在**更早一次完整运行**中是
全绿的；当前的红是后端在途改动，不是本卡前端改动造成的——本卡未修改该文件。

---

## 10. 声明

- 本轮验证对 `apps/api` 与 `packages/contracts` **只发 HTTP 请求，未修改其任何文件**；
  本卡（t4 / a3-ui）的业务代码改动仅限 `apps/web/src/**` 与 `apps/admin/src/**`。
- 需说明：本分支是**多人共享工作区**，`apps/api/**` 与 `packages/contracts/**` 下存在
  a1-data / a2-api 的改动（奖励领域、契约、迁移）。这些不在本文件范围，也不是本文件的
  验证对象；本文所有结论只针对 H5 与后台前端接线。
- 验证使用隔离端口与 `/tmp` 下一次性数据库，未触碰 `.data/local-life-dev.sqlite`，
  也未改动 `apps/api/.env.local`。
- 本文件与 `browser-runs.json`、`browser/*.png` 均由脚本在最后一次干净运行中产出，
  截图未做任何裁剪、拼接或重绘。文中不声称任何未在此列出的验证结论。
- 该分支尚未部署；本卡不涉及发布。
