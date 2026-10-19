# C06 迁移回归矩阵（我的页 + 五模块集成收口）

> 对应 [C06 / #11](https://github.com/sanchuang-dev/local-life/issues/11)，实施基线 `dev@6af6ddbfd2b859ffb2d6cdd2d3dccd02bbeff131`（2026-10-19）。
> 本文记录 C06 当时的可浏览性、入口、回退和遗留项，不代表新版信息架构或业务功能定稿。
> 导航更新（I03 / #23）：底栏已调整为首页 / 社区 / 健康 / 惠生活 / 我的，`/discover` 与「我的 → 原型演示导航」已退场。本文第 1、2、4 节中关于三 Tab、服务导览和演示导航的描述保留为 C06 历史状态。见 [I03 导航归位记录](i03-navigation.md)。

## 1. 演示入口与导航边界

- 底部仍是临时的 **首页 / 发现 / 我的** 三 Tab，仅用于验证壳层样式和切换，不是新版产品导航。
- `我的` 页底部新增 **原型演示导航**，集中列出 V0.3 已迁页面。该入口明确标注“非产品导航”，只服务浏览回归和产品减法讨论。
- 五个历史模块（首页 / 社区 / 健康 / 惠生活 / 我的）均可到达：首页与我的走底部 Tab，社区/健康/惠生活通过“我的 → 原型演示导航”和首页常用服务进入；没有把旧版五 Tab 写入底部导航。
- 共享子页面通过 `state={{ from }}` 记住来源：我的 → 积分/设备/广电、健康 → 我的设备会返回来源模块；直接访问时回退到各自父级。
- 未知路由统一落到 404，提供“返回首页”和“浏览服务导览”两个出口。

## 2. 五个历史模块回归矩阵

| 历史模块 | 演示入口 | 已覆盖路由 | 返回路径 | 结果 |
| --- | --- | --- | --- | --- |
| 首页 | 底部 Tab、我的 → 演示导航 | `/`、`/gd` | 底部 Tab / 广电页返回来来源模块或首页 | 通过 |
| 社区 | 首页常用服务、我的 → 演示导航 | `/community`、`/community/broadcast`、`/community/activity`、`/community/culture`、`/community/notice/:noticeId` | 子页返回 `/community` | 通过 |
| 健康 | 首页“健康服务”、我的 → 演示导航 | `/health`、`/health/assistant`、`/health/device`、`/health/lecture`、`/me/devices` | 子页返回 `/health`；我的设备按来源返回健康或我的 | 通过 |
| 惠生活 | 首页“惠生活”、我的 → 演示导航 | `/life`、`/life/exchange`、`/life/product/:productId`、`/points` | 商品/兑换返回 `/life`；积分按来源返回惠生活或我的 | 通过 |
| 我的 | 底部 Tab、404 → 服务导览/首页 | `/me`、`/points`、`/me/devices`、`/gd` | 服务子页返回 `/me` | 通过 |

其余路由：未知路由进入 404；`/discover` 在 I01 中已从占位容器改为可操作的已迁页面/服务导览。

## 3. V0.3 十六屏覆盖清单

| # | 历史屏幕 | 当前路由 | 状态 |
| --- | --- | --- | --- |
| 1 | home | `/` | 已迁，演示 |
| 2 | gd | `/gd` | 已迁，演示 |
| 3 | community | `/community` | 已迁，演示 |
| 4 | broadcast | `/community/broadcast` | 已迁，无真实音频 |
| 5 | activity | `/community/activity` | 已迁，签到/提醒为演示 |
| 6 | culture | `/community/culture` | 已迁，演示排期 |
| 7 | health | `/health` | 已迁，演示 |
| 8 | ai | `/health/assistant` | 已迁，固定样例、无真实 AI |
| 9 | device | `/health/device` | 已迁，无真实硬件 |
| 10 | lecture | `/health/lecture` | 已迁，无音视频播放 |
| 11 | mydevices | `/me/devices` | 已迁，无真实绑定 |
| 12 | life | `/life` | 已迁，演示商品 |
| 13 | product | `/life/product/:productId` | 已迁，按商品 id 展示 |
| 14 | exchange | `/life/exchange` | 已迁，无真实兑换 |
| 15 | points | `/points` | 已迁，静态示例积分 |
| 16 | me | `/me` | 已迁，含服务/设置/演示导航 |

C03 额外新增的消息详情 `/community/notice/:noticeId` 也纳入回归。

## 4. 未迁入、未实现与待产品决定

**明确未迁入（点击显示演示提示，不伪造成功）：**

- 我的活动、优惠券、我的订单、我的收藏、健康档案、家庭成员、地址管理、客服。
- 真实实名/账号、订单、优惠券、核销、支付、库存、门店地图、家庭成员或客服会话。
- 设备绑定/同步、健康数据采集、AI 应答、音视频/直播播放、积分发放。
- 发现 Tab 的正式内容。

**待产品决定：**

- 新版一级导航与 Tab 数量；当前三 Tab 仅为临时壳层。
- “我的”页保留哪些信息块、积分归属（我的与惠生活的入口关系）。
- “发现”是否保留、承载什么内容。
- 是否/何时切换旧版演示 URL；不在本卡范围。
- 旧版 56 个 `data-demo` 控件未逐项复刻，哪些值得进入新版需产品筛选。

## 5. 验证记录

**静态检查：**

```bash
npm ci          # 53 packages，0 vulnerabilities
npm run check   # oxlint + tsc -b + vite build，全部通过
```

构建产物：`dist/index.html`、`dist/assets/index-*.css`、`dist/assets/index-*.js`。构建通过不等于交互验收。

**浏览器核对（2026-10-19）：**

- 环境：Chromium `155.0.8059.0` 无头；`npm run preview -- --host 127.0.0.1 --port 4173`；访问 `http://127.0.0.1:4173/local-life/#/`。
- 视口：375 × 812（主基准）和 320 × 812（窄屏）。
- 实际点击并确认结果：
  - 首页底部“我的” → `/me`，显示示例用户、积分、服务、设置和演示导航。
  - 我的 → 我的积分 → “返回我的”回 `/me`。
  - 我的 → 我的设备 → “返回我的”回 `/me`。
  - 我的 → 广电服务 → “返回我的”回 `/me`。
  - 健康 → 我的设备 → “返回健康服务”回 `/health`。
  - 我的 → 演示导航：首页、社区、健康、惠生活四个历史模块入口均到达；“我的”为当前页。
  - 首页 → 社区广播 → “返回社区”回 `/community`。
  - 社区 → 活动详情 → “返回社区”回 `/community`。
  - 惠生活 → 商品详情 → “返回惠生活”回 `/life`。
  - 惠生活 → 积分兑换 → “返回惠生活”回 `/life`。
  - 未知路由 → 404 → “打开演示导航”回 `/me`。
- 320px 全路由扫描：`/`、`/gd`、`/community`、`/community/broadcast`、`/community/activity`、`/community/culture`、`/community/notice/water`、`/health`、`/health/assistant`、`/health/device`、`/health/lecture`、`/life`、`/life/exchange`、`/life/product/rice-5kg`、`/points`、`/me/devices`、`/me`、`/discover` 均无横向溢出（文档/body/main 宽度均为 320）。
- 375px“我的”页同样无横向溢出；顶部资料卡、三项统计、服务列表、演示导航与底部导航可滚动查看，底栏不遮挡内容。
- 本次交互与扫描：**0 个运行时异常，0 个 console error**。

**本次未覆盖：**

- 真机、微信原生小程序/WebView、iOS/Android 差异。
- 旧版全部 56 个演示控件的逐项点击和所有历史微交互。
- 其它浏览器与更多视口宽度。
- C02–C05 模块内部细节由各自卡片证据覆盖；本卡只验证集成入口、返回和可见状态。
