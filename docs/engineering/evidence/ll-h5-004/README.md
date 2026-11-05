# LL-H5-004 活动首页与内容收敛 — 浏览器证据（#95）

验证对象：居民 H5 活动首页（`/`）改为真实活动入口，惠生活与我的收敛为真实数据、去掉示例/虚构内容。分支 `feat/ll-h5-004-activity-home`，基线 `dev@c13f96c`，证据对应代码 HEAD `f445900`（单提交；本目录由后续 `docs(evidence)` 提交加入，未改代码）。`git diff --stat c13f96c..f445900` = 7 文件 +872/−345：`apps/web/src/App.tsx`（根路由一行 + import）、`apps/web/src/pages/ActivityHomePage.tsx`（新增）、`apps/web/src/components/home/{activityFormat.ts,ActivityShareSheet.tsx}`（新增）、`apps/web/src/pages/{LifePage,MePage,SilverNeighborhoodCampaignPage}.tsx`。无 `apps/api/`、`packages/contracts/`、`apps/admin/`、`.github/`、外壳文件改动，无迁移。

## 运行方式（本次证据的实际环境）

- 真实 Hono + SQLite（进程内）+ 真实 admin API 发布 2 场活动 + 真实 `build:mvp` 产物；系统 Chrome 156 headless + CDP，375 / 320 / 1440。
- 断言与网络记录写入 `browser-run.json`（23 steps / 51 screenshots / 0 consoleErrors / 0 API 5xx）。
- 本卡实现时外壳仍是基线 `MiniProgramShell`（#94 未合入），登录使用基线开发登录（#92/#93 未合入）。

## 覆盖清单

| # | 场景 | 断言 | 证据 |
| --- | --- | --- | --- |
| 1 | 无已发布活动时打开 `/` | 真实空态「当前没有已发布的活动…」；不回落示例活动/虚构名额/演示奖品 | `05-empty-375-home.png` |
| 2 | 有活动时打开 `/` | 渲染服务端公开列表首个活动（标题/社区/地点/时间/阶段/规则快照全部来自 payload） | `01-home-375.png` |
| 3 | `?activityId=<第二场>` 深链 + 刷新 | 不回调到别的活动，刷新一致 | `browser-run.json`（`deeplink-activity-b*` 步骤） |
| 4 | 邀请弹层 | 二维码真实渲染，复制/分享链接带真实 `activityId` + `invite`，与当前活动一致 | `02-invite-sheet-375.png` |
| 5 | 旧深链 `/community/activity/silver-neighborhood?activityId=…&invite=…` | 仍可用；顶部「返回活动首页」携带同一 `activityId`（回应 #94 A94-1） | `browser-run.json`（`legacy-deeplink` 步骤） |
| 6 | `/life` 惠生活 | 仅真实 CRMEB 优惠购；无示例积分/示例兑换/虚构门店（无「2680」、无虚构门店名）；`?tab=points|local` 显示「尚未接入真实服务」 | `03-life-375.png` |
| 7 | `/me` 未登录 | 无 mock 头像/姓名/统计（无「张阿姨」）；显示未登录与登录入口，保留工作人员入口并说明不会自动获得权限 | `04-me-375-logged-out.png` |
| 8 | `/me` 已登录 | 真实 `displayName`/居民 ID 尾号、当前活动报名、三人团 x/3、真实奖励条目 | `browser-run.json`（`me-logged-in` 步骤） |
| 9 | 无假 CTA | 首页无抽奖/榜单/大奖可点按钮，仅有「演示、不写库」免责声明 | `browser-run.json` |

## 命令与结果

```
pnpm install --frozen-lockfile   # exit 0
pnpm lint                        # exit 0，0 errors / 17 warnings（与 c13f96c 基线同）
pnpm typecheck                   # exit 0
pnpm build                       # exit 0（web 777.44 kB js / 67.34 kB css，仅既有 chunk 警告）
pnpm --filter @sanchuang-dev/local-life-web build:mvp   # exit 0
```

`pnpm check` exit 1，唯一失败集合为 dev 基线既有的 Windows-only `EPERM`（API 189/181/8：`rewards-version-edit` 7 + `rewards-data` 1），与干净基线 `c13f96c` 同命令逐条同名，无新增。独立验收（qa t8）：命令全 exit 0，浏览器 41/41 通过、0 页面异常、0 API 5xx，17 张截图覆盖 375/320/1440。

## 未验证项与外部依赖

- 无 CRMEB/商城配置：惠生活只验证了「未配置即诚实不可用」形态，真实商品/优惠购链路未验证。
- **联调缺口**：#92（微信登录）、#93（手机验证码）、#94（AppShell）在验证时均未合入，登录仅用基线开发登录、外壳仍是 `MiniProgramShell`；合入后需 rebase 复跑。
- 奖励闭环仅验证到 1/3 三人团；抽奖/榜单/大奖仍为旧玩法页的「演示」实现（不写库），未接入真实发放。
- 无真机、无微信内置浏览器、无线上部署；QA 与 reviewer 模型无图像输入，视觉细节需人工目视。

## 复跑方式

1. 起真实 API（独立 SQLite），用 admin API 创建社区并发布 2 场活动（`E:\tomz\h5-evidence\h5-004\harness-verify.mjs` 是可复核脚本，未入库）。
2. `pnpm --filter @sanchuang-dev/local-life-web build:mvp`，静态托管 dist，`/api` 反代到 API。
3. Chrome headless + CDP 按上表执行，断言口径与 `browser-run.json` 对齐（23 steps / 0 consoleErrors）。
