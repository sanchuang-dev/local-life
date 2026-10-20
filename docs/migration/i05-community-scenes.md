# I05 社区首页场景卡与业务入口层级记录

> 对应 [I05 / #27](https://github.com/sanchuang-dev/local-life/issues/27)，实施基线 `dev@2134d96b061f52558f08147eef69086f8aca89ab`（2026-10-19）。
> 本文记录本轮社区首页场景层级调整与本地验证，不代表新增真实社区服务，也不替代维护者验收。

## 1. 本次变化

- `/community` 顶部新增两张生活场景卡：
  - “下午一起下棋” → `/community/activity/chess`（象棋友谊赛）；
  - “晚上去跳舞” → `/community/activity/dance`（广场舞教学）。
- 场景卡的大小标题、时间、地点和标签直接取自既有 `communityActivityDetails`，只把 `chess` / `dance` 两个活动实体映射成生活场景，没有新建活动实体或第二套 Mock。
- 首页浏览顺序调整为：**社区生活场景 → 社区入口 → 正在发生的社区活动 → 社区通知**；广播、活动、文化中心、通知与“待接入”反馈均保持原有行为。
- 从社区场景卡进入活动详情时携带 `from: '/community'`，详情显示“返回社区”；直接访问详情仍回退到社区；从首页活动卡进入时继续保留 I01 的“返回首页”来源。

## 2. 涉及文件

| 文件 | 作用 |
| --- | --- |
| `src/mocks/community.ts` | 新增 `CommunityScene` 类型与 `communityScenes` 映射，复用既有活动详情 |
| `src/components/community/CommunitySceneCards.tsx` | 社区首页专用场景卡区域 |
| `src/pages/CommunityPage.tsx` | 将场景卡放到社区入口之前，保持其余入口与通知不变 |
| `docs/migration/i05-verify.mjs` | 375 / 320 宽度、路由、返回来源与入口可达性的浏览器核对脚本 |

## 3. 验证记录

**静态检查（2026-10-19）：**

```bash
npm ci --no-audit --no-fund   # added 53 packages
npm run check                 # oxlint + tsc -b + vite build，通过
```

**浏览器核对：**

- 环境：Chromium `155.0.8059.0` 无头，`playwright-core` 驱动，`npm run preview -- --host 127.0.0.1 --port 4173`，访问 `http://127.0.0.1:4173/local-life/#/community`。
- 视口：375 × 812 与 320 × 812；脚本 `node docs/migration/i05-verify.mjs` 共 44 项断言全部通过。
- 实际点击并确认：
  - 两张场景卡文案、实体与路由一一匹配；卡片内时间、地点、标签与象棋/广场舞详情一致。
  - 象棋/广场舞场景 → 对应详情，标题与场次不串页；点击“返回社区”回到 `/community`。
  - 直接访问 `/community/activity/chess` 显示“返回社区”；从首页活动卡进入显示“返回首页”并回到 `/`。
  - 社区广播、社区活动、党群文化中心和停水通知入口仍可到达各自页面。
  - 助老服务仍显示“演示：助老服务在首批试点名单内，尚未接入。”
  - 375/320 下文档、body、主滚动区均无横向溢出；场景卡完整落在视口内；底栏与内容区相邻可见；滚动到底后最后内容不被底栏遮挡。
- 运行时：0 个 pageerror，0 个 console.error（忽略 favicon 资源 404）。
- 截图：脚本输出到 `/tmp/opencode/`（`i05-community-375-top.png`、`i05-community-320-top.png`、`i05-chess-375.png` 等），未纳入仓库。

**本次未覆盖：**

- 真机、微信原生小程序/WebView、iOS/Android 差异与其他浏览器。
- 375/320 之外的视口宽度。
- I04 首页与 I06 惠生活内容；本轮只改社区首页场景层级。
- 独立 post-run 验证仍需由可信流程执行，本文不替代维护者验收、合并或收卡。
