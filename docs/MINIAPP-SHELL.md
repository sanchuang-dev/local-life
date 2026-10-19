# 小程序风格界面框架（原型阶段）

这是基于 React + Vite + Tailwind CSS + React Router + Lucide React 的 **H5 可视化原型**，不是可直接提交微信审核的原生小程序。

- `src/components/MiniProgramShell.tsx`：顶栏、模拟微信胶囊、内容滚动容器、底部导航和安全区处理。
- `src/pages/HomePage.tsx`：按 [C01 迁移地图](migration/v03-map.md) 迁入的首页演示内容（Banner、常用服务、广电入口、社区消息与活动）；未迁入页面以“待接入”提示说明，不代表正式产品定稿。
- `src/pages/GdPage.tsx`：广电服务最低展示页（`/gd`），手机卡/宽带/电视/上门服务均明确标注演示、待接入。
- `src/pages/CommunityPage.tsx` 与 `src/pages/CommunityBroadcastPage.tsx`、`CommunityActivityPage.tsx`、`CommunityCulturePage.tsx`、`CommunityNoticePage.tsx`：C03 迁入的社区列表、社区广播、活动详情、党群文化中心与消息详情（`/community`、`/community/broadcast`、`/community/activity`、`/community/culture`、`/community/notice/:noticeId`）。广播无音频资源，不提供真实播放；报名/签到/提醒均为演示提示。样例数据在 `src/mocks/community.ts`。
- `src/pages/ScaffoldPage.tsx`：其它标签页的占位容器及 404 回退。
- 主路由在 `src/App.tsx`，沿用现有 `HashRouter` 以兼容静态 Pages。
- **底部首页/发现/我的仅用于验证三 Tab 样式、切换和页面骨架，并非正式产品信息架构**。产品决策后更换导航表、对应路由和占位页。
- 顶部时间、状态栏、系统胶囊为 H5 预览视觉模拟，不提供真实微信宿主能力；未来进入真实微信小程序时应由微信原生导航托管，避免双顶栏。
- 演示卡片不是可下单、预约、报名或提交的真实服务，均以占位展示。

验证范围：375 × 812 优先；路由 Tab 切换、返回、404、容器滚动与窄屏；`npm run check`。如未执行真实手机/浏览器交互测试，应单独说明。

C03 社区模块的最近一次浏览器核对（2026-10-19，Chromium 155 无头 375 × 812 / 320）：社区列表进入消息详情、活动详情并返回；广播「历史广播」空态、广播信息详情展开、党群文化门类筛选空态、活动签到演示提示；上述页面 320/375 无横向溢出；0 个前端异常。
