# I03 五大业务导航归位记录

> 对应 [I03 / #23](https://github.com/sanchuang-dev/local-life/issues/23)，实施基线 `dev@85b280b2c0a8195dafb905cd6161a67f494af517`（2026-10-19）。
> 本文记录本轮导航调整、路由归属与回归验证，不代表新增业务功能或生产接入。

## 1. 本次变化

- 底部导航调整为五个业务模块：首页 `/`、社区 `/community`、健康 `/health`、惠生活 `/life`、我的 `/me`。
- 一级页不再显示“返回首页”；社区、健康、惠生活的页头与其他一级页一致，直接以模块图标、标题和说明开始。
- 子页保留所属模块/来源返回；共享子页按来源高亮，直接访问时按稳定主归属落点：
  - `/points`：来源为“我的”时高亮我的，否则回退惠生活。
  - `/me/devices`：来源为“健康”时高亮健康，否则回退我的。
  - `/gd`：来源为“我的”时高亮我的，否则回退首页。
- 下线“发现”Tab、`/discover` 页面与 `demoIndexGroups` 技术路由清单；“我的”页不再出现“原型演示导航”。
- 404 移除“浏览服务导览”，改为“返回首页”和真实业务入口“去社区看看”。

## 2. 路由归属

| 模块 | 一级路由 | 子页 |
| --- | --- | --- |
| 首页 | `/` | `/gd` |
| 社区 | `/community` | `/community/broadcast`、`/community/activity`、`/community/activity/:activityId`、`/community/culture`、`/community/notice/:noticeId` |
| 健康 | `/health` | `/health/assistant`、`/health/device`、`/health/lecture`、`/me/devices`（共享） |
| 惠生活 | `/life` | `/life/exchange`、`/life/product/:productId`、`/points`（共享） |
| 我的 | `/me` | `/points`（共享）、`/me/devices`（共享）、`/gd`（来源为我的时） |

`/discover` 与任意未知路径进入 404，不再提供技术路由目录。

## 3. 验证记录

**静态检查：**

```bash
npm ci --no-audit --no-fund   # 53 packages，0 vulnerabilities
npm run check                 # oxlint + tsc -b + vite build，通过
```

**浏览器核对（2026-10-19）：**

- 环境：Chromium `155.0.8059.0` 无头，`playwright-core` 驱动；`npm run preview -- --host 127.0.0.1 --port 4173`，访问 `http://127.0.0.1:4173/local-life/#/`。
- 视口：375 × 812（主基准）与 320 × 812（窄屏），共 152 项断言全部通过。
- 实际点击并确认：
  - 五 Tab 均进入语义匹配路由并正确高亮；一级页无“返回首页”按钮。
  - 社区 → 社区广播 / 社区活动，返回社区；浏览器后退回社区。
  - 健康 → 健康讲堂；健康 → 我的设备，来源高亮健康，返回健康服务。
  - 惠生活 → 5 斤装大米商品详情；惠生活 → 积分兑换；惠生活 → 积分明细，来源高亮惠生活，返回惠生活。
  - 我的 → 我的积分，来源高亮我的，返回我的；我的 → 广电服务，来源高亮我的，返回我的。
  - `/community/activity/chess` Hash 直达并刷新后内容保持，社区高亮；`/points`、`/me/devices` 直达刷新按稳定主归属高亮。
  - `/discover` 与未知路径进入 404，不再出现“发现/浏览服务导览”；“去社区看看”进入 `/community`。
  - “我的”页不存在“原型演示导航”和 19 条内部路由入口。
  - 全路由 20 条路径在 375/320 下文档、body、主滚动区宽度均等于视口宽度；主滚动区与底部导航无重叠，滚动到底后最后内容可见。
- 运行时：0 个 pageerror，0 个 console.error（忽略 favicon 资源 404）。

**本次未覆盖：**

- 真机、微信原生小程序/WebView、iOS/Android 差异。
- 其它浏览器与 375/320 之外的视口宽度。
- 各模块业务卡片的后续新增内容（I04–I06）不在本卡范围。
- 独立 post-run 验证仍需由可信流程执行，本文不替代维护者验收。
