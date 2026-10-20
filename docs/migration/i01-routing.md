# I01 路由与导航闭环记录

> 对应 [I01 / #20](https://github.com/sanchuang-dev/local-life/issues/20)，实施基线 `dev@7e20321d6a61a9caf505ebb4455456c5e2130ac4`（2026-10-19）。
> 本文记录本次路由修复、已验证路径与已知限制，不代表新版信息架构或业务功能定稿。
> 后续 I03 / #23 已按维护者决策改为五 Tab 并下线 `/discover`；本文中“发现”Tab 与“浏览服务导览”的描述保留为 I01 当时记录。

## 1. 本次变化

- 首页 Banner“查看活动”改为进入 `/community/activity/welfare-day`，展示与“周末便民服务日”文案匹配的便民服务演示详情，不再复用文艺演出或只弹“待接入”。
- 新增 `/community/activity/:activityId`，为象棋友谊赛、广场舞教学等首页活动提供各自详情；`/community/activity` 保留为默认文艺演出详情。
- 首页活动卡片、Banner、社区消息与广播入口传递来源 `state.from`；活动详情、广播、通知、文化页按来源返回，直接访问时仍回退到所属模块。
- `/discover` 从空白脚手架改为“已迁页面/服务导览”，复用现有页面入口与数据；仍明确标注“示例服务导览 · 非正式导航定稿”。
- 404 页拆为独立 `NotFoundPage`，保留“返回首页”，并新增“浏览服务导览”出口。
- `community.ts` 仅新增最少的匹配演示详情与字段，没有引入新依赖或第二套导航。

## 2. 浏览器核对（2026-10-19）

- 环境：Chromium（系统 `/usr/bin/chromium`）+ `playwright-core` 驱动；`npm run preview -- --host 127.0.0.1 --port 4173`，访问 `http://127.0.0.1:4173/local-life/`。
- 视口：375 × 812（主基准）与 320 × 812（窄屏）。
- 实际点击并确认：
  - 首页 Banner“查看活动” → `/community/activity/welfare-day`，显示“周末便民服务日”和便民服务字段，不含“社区文艺演出”；“返回首页”回 `/`。
  - 首页“象棋友谊赛” → `/community/activity/chess`，显示象棋赛时间/名额；“返回首页”回 `/`。
  - 首页“广场舞教学” → `/community/activity/dance`，显示免费教学信息；“返回首页”回 `/`。
  - 底部三 Tab：首页 `/`、发现 `/discover`、我的 `/me` 均有内容；发现页有 19 个可点击的已迁页面入口，当前 Tab 高亮正确。
  - 我的 → 我的积分 → “返回我的”回 `/me`；健康 → 我的设备 → “返回健康服务”回 `/health`。
  - 首页 → 社区广播 → “返回首页”回 `/`；社区 → 社区广播 → “返回社区”回 `/community`。
  - 广播信息展开 → “查看广播对应活动” → `/community/activity/performance` → “返回社区广播”回广播页。
  - 直接访问并刷新 `/community/activity/chess` 后仍显示象棋详情。
  - 浏览器后退：`/` → `/discover` → `/me`，后退回 `/discover`、再回 `/`。
  - 未知路由 → 404 → “浏览服务导览”回 `/discover`；再次进入 404 → “返回首页”回 `/`。
  - 无效活动实体 `/community/activity/does-not-exist` 显示“活动不存在”，可返回社区。
  - 底部高亮：活动详情等首页模块子页保持“首页”选中。
- 布局：`/`、`/discover`、`/community/activity/welfare-day`、`/community/activity/chess` 在 375/320 下文档、body 与主滚动区宽度均等于视口宽度；无横向溢出。首页与发现页滚动到底后，最后内容块仍位于底部导航之上。
- 运行时：0 个 page error；仅既有 `/favicon.ico` 404 控制台提示，非本次路由变更引入。

## 3. 静态检查

```bash
npm ci --no-audit --no-fund   # 53 packages
npm run check                 # oxlint + tsc -b + vite build，全部通过
```

## 4. 已知限制

- 未做真机、微信原生小程序/WebView、iOS/Android 差异验证。
- 浏览器证据来自无头 Chromium；截图使用临时安装的中文字体，不构成视觉像素级验收。
- `/discover` 的页面名称、分组与正式内容仍待产品决定；本次只保证入口可操作、可返回。
- 独立 post-run 验证仍需由可信流程执行，本文不替代维护者验收。
