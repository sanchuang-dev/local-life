# 小程序风格界面框架（原型阶段）

这是基于 React + Vite + Tailwind CSS + React Router + Lucide React 的 **H5 可视化原型**，不是可直接提交微信审核的原生小程序。

- `src/components/MiniProgramShell.tsx`：顶栏、模拟微信胶囊、内容滚动容器、底部导航和安全区处理。
- `src/pages/HomePage.tsx`：按 [C01 迁移地图](migration/v03-map.md) 迁入的首页演示内容（Banner、常用服务、广电入口、社区消息与活动）；Banner“查看活动”进入与文案匹配的便民服务日活动详情，首页活动卡片进入各自详情；其余未迁入页面以“待接入”提示说明，不代表正式产品定稿。
- `src/pages/GdPage.tsx`：广电服务最低展示页（`/gd`），手机卡/宽带/电视/上门服务均明确标注演示、待接入。
- `src/pages/CommunityPage.tsx` 与 `src/pages/CommunityBroadcastPage.tsx`、`CommunityActivityPage.tsx`、`CommunityCulturePage.tsx`、`CommunityNoticePage.tsx`：C03 迁入的社区列表、社区广播、活动详情、党群文化中心与消息详情（`/community`、`/community/broadcast`、`/community/activity`、`/community/activity/:activityId`、`/community/culture`、`/community/notice/:noticeId`）。广播无音频资源，不提供真实播放；报名/签到/提醒均为演示提示。样例数据在 `src/mocks/community.ts`。
- `src/pages/HealthPage.tsx` 与 `HealthAssistantPage.tsx`、`HealthDevicePage.tsx`、`HealthLecturePage.tsx`、`HealthDevicesPage.tsx`：C04 迁入的健康首页、社区助手、魔镜终端、健康讲堂与我的设备（`/health`、`/health/assistant`、`/health/device`、`/health/lecture`、`/me/devices`）。设备、健康数值、播放与预约均为演示，不采集或保存个人健康信息；样例数据在 `src/mocks/health.ts`。
- `src/pages/MePage.tsx`：C06 迁入的“我的”页（`/me`），含示例用户、积分/活动/优惠券占位、我的服务与设置帮助；样例数据在 `src/mocks/me.ts`。积分只读 `src/mocks/life.ts` 的单一示例余额。原“原型演示导航”内部路由清单已随 I03 退场，不再出现在居民演示 UI。
- `src/hooks/useBackTarget.ts`：共享子页按内部链接传入的来源返回（我的 → 积分/设备/广电、健康 → 我的设备），直接访问时回退父级。底部 Tab 高亮同样优先使用来源，直接访问时按稳定主归属落点（`/points` → 惠生活，`/me/devices` → 我的，`/gd` → 首页）。
- `src/pages/NotFoundPage.tsx`：404 回退，提供“返回首页”和“去社区看看”两个真实业务出口。
- 主路由在 `src/App.tsx`，沿用现有 `HashRouter` 以兼容静态 Pages。
- **底部导航为本轮已确认的演示信息架构：首页 `/`、社区 `/community`、健康 `/health`、惠生活 `/life`、我的 `/me`**；一级页不再显示“返回首页”，子页保留所属模块/来源返回。`/discover` 路由与技术路由导览已下线，未知路径直接进入 404。
- 顶部时间、状态栏、系统胶囊为 H5 预览视觉模拟，不提供真实微信宿主能力；未来进入真实微信小程序时应由微信原生导航托管，避免双顶栏。
- 演示卡片不是可下单、预约、报名或提交的真实服务，均以占位展示。

验证范围：375 × 812 优先；路由 Tab 切换、返回、404、容器滚动与窄屏；`npm run check`。如未执行真实手机/浏览器交互测试，应单独说明。

C03 社区模块的最近一次浏览器核对（2026-10-19，Chromium 155 无头 375 × 812 / 320）：社区列表进入消息详情、活动详情并返回；广播「历史广播」空态、广播信息详情展开、党群文化门类筛选空态、活动签到演示提示；上述页面 320/375 无横向溢出；0 个前端异常。

C04 健康模块的浏览器核对（2026-10-19，Chromium 155 无头 375 × 812 / 320）：首页健康入口进入 `/health`，再进入社区助手、健康讲堂、魔镜终端与我的设备，各级返回可用（我的设备按 V0.3 父级返回“我的”）；助手快捷提问/发送、设备绑定、讲堂分类筛选与收听按钮均显示演示提示；320/375 无横向溢出；0 个 JS 异常（仅既有 `/favicon.ico` 404）。未迁移真实设备绑定/同步、健康数据采集、音视频播放、AI 应答、直播预约与积分发放；讲堂条目在 V0.3 中也没有独立详情路由，因此未虚构详情页。

C06 集成收口浏览器核对（2026-10-19，Chromium 155 无头 375 × 812 / 320）：`/me` 资料卡、积分/活动/优惠券占位、我的服务、设置与演示导航可见；我的 → 积分/设备/广电均返回“我的”，健康 → 我的设备返回“健康服务”；演示导航可达首页/社区/健康/惠生活四个历史模块，404 可回演示导航。320px 下全部已迁路由无横向溢出，0 个运行时异常、0 个 console error。完整矩阵见 [C06 回归记录](migration/c06-regression.md)；未做真机/微信 WebView 与旧版全部演示控件逐项点击。

I03 导航归位浏览器核对（2026-10-19，Chromium 155 无头 375 × 812 / 320）：五 Tab 首页/社区/健康/惠生活/我的均进入匹配路由并正确高亮；社区/健康/惠生活子页、来源返回、共享页来源高亮、Hash 直达刷新、浏览器后退与 404 真实业务出口均通过；`/discover` 与“我的 → 原型演示导航”不再面向用户。全路由无横向溢出、底栏不遮挡内容，0 个 pageerror、0 个 console.error。见 [I03 导航归位记录](migration/i03-navigation.md)。
