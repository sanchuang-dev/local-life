# V0.3 旧原型 → React 迁移地图（C01）

> **身份：迁移交接资料，不是新版产品 PRD。** 对应 [C01 / #6](https://github.com/sanchuang-dev/local-life/issues/6)，下游 [C02–C06](https://github.com/sanchuang-dev/local-life/issues/7) 依本文的已证实事实施工。新版本保留/删除/增加什么，仍以用户后续产品决策为准。迁移不得把旧版五 Tab 固化为新产品规范。
>
> 本次检查：2026-10-19；新工程实施基线 `sanchuang-dev/local-life@dev`。本文件只记录原型的结构、演示行为、迁移映射和证据边界。

## 1. 已核实的旧版事实与来源

| 来源 | 事实及可信边界 |
| --- | --- |
| [旧版产品说明](https://github.com/sanchuang-dev/base-prototype/blob/demo/local-life/docs/PRD-V0.3.md) | 描述当时的产品意图，不保证每项已实现；旧五个一级 Tab：**首页/社区/健康/惠生活/我的**。 |
| [旧分支](https://github.com/sanchuang-dev/base-prototype/tree/demo/local-life)，SHA `b9c0b3872761c9e589db0b29250fa37bb139d96f` | `release/v0.3.1/index.html.gz.b64.part.00–04` 可解压还原静态 HTML；这是历史打包输入，并非可直接移植的 React 源码。 |
| [线上旧版](https://sanchuang-dev.github.io/base-prototype/local-life/) | 直接 HTTP 下载检查：HTML **133,972 字节**、SHA-256 `cec419b9cd2cc22ef59a9ae5c035753566cb1ec8cfdb6246f16d149dddf0976d`；与旧 [main/demos.json](https://github.com/sanchuang-dev/base-prototype/blob/main/demos.json) 的预期校验值吻合。**下游参考线上发布行为，不只看还原包**。 |
| 仓库归属 | `base-prototype/main` 负责原演示发布；`local-life/dev` 负责新 React 版。未经单独授权，**旧站网址、发布工作流和历史文件一律不动**。 |

**量化盘点（线上 HTML 静态解析）：** 5 个一级 Tab、16 个 `data-screen` 页面、64 个内部 `#/` 链接、56 个带 `data-demo` 的模拟反馈控件、8 个 `img` 引用、42 个内联 SVG symbol；均为**DOM 数量而非 64 种独立业务功能**。全部页面在同一份 HTML 中切换显示，JS 路由位于尾部内联脚本。

**源码与发布版本确有差异**：还原 `release/v0.3.1` 的 HTML 是 **132,113 字节**（SHA-256 `fa171baa73d582134818884289cf7dfbfec7d4d5c48a4e47d849eeeda84a76a8`），与线上版不一致。对比发现线上版补了：`home` 页标题、详情页 `parent` 字段、`history.pushState/replaceState`、拦截内部链接、`popstate` 与 `hashchange` 处理、按历史返回及无历史时回父级。**迁移时以线上导航语义为准**，不要照抄还原包的旧返回实现。

## 2. 全部 16 个页面的交接表

`旧路由` 是线上事实；`React 建议路由` 是**施工提议**，不是已经存在的路由，也不是最终 Tab 方案。React 继续使用现有 `HashRouter`，因此例如 `/community/broadcast` 实际 URL 将呈现 `/#/community/broadcast`。

| 旧 `#/...` | 页面和已见内容 | 建议 React 路由 | 责任卡 |
| --- | --- | --- | --- |
| `home` | 首页 Banner/便民服务日、广电卡、常用入口、社区消息/活动、积分/健康/惠生活摘要 | `/` | **C02 #7** |
| `gd` | 广电服务：手机卡/宽带/电视/上门、融合套餐、服务记录及广播联动入口 | `/gd` | **C02 #7**（最低可用展示页） |
| `community` | 社区活动列表、社区广播入口、通知、便民卡片 | `/community` | **C03 #8** |
| `broadcast` | 停水/文艺广播、文字稿/重听模拟、关联活动 | `/community/broadcast` | **C03 #8** |
| `activity` | 文艺演出详情、节目单、模拟签到与提醒 | `/community/activity` | **C03 #8** |
| `culture` | 党群文化、书法/太极/合唱/讲座活动 | `/community/culture` | **C03 #8** |
| `health` | 社区助手、家庭设备、健康档案入口、讲堂内容 | `/health` | **C04 #9** |
| `ai` | 社区助手对话演示（通过 Toast 显示模拟回复） | `/health/assistant` | **C04 #9**（模拟态） |
| `device` | 魔镜·健康终端和潜在能力 | `/health/device` | **C04 #9**（展示态） |
| `lecture` | 健康讲堂、科普文章/音频、预约展示 | `/health/lecture` | **C04 #9** |
| `mydevices` | 魔镜、血压计、手环以及模拟绑定 | `/me/devices` | **C04 #9**（C06 接“我的”入口） |
| `life` | 积分好礼、附近可核销门店、礼品列表 | `/life` | **C05 #10** |
| `product` | 单一商品详情（现有标题“5 斤装大米”）、兑换说明 | `/life/product` | **C05 #10** |
| `exchange` | 积分兑换好礼列表、积分入口 | `/life/exchange` | **C05 #10** |
| `points` | 示例积分余额、任务、明细、规则 | `/points` | **C05 #10**（C06 接“我的”入口） |
| `me` | 示例用户“张阿姨”、积分、我的设备、广电服务、设置帮助 | `/me` | **C06 #11** |

**跨域共用页面只设一个代码所有者：** `gd` 归 C02、`mydevices` 归 C04、`points` 归 C05；其他卡**只接入口**，不得另起一份重复页面或演示积分账本。

## 3. 迁移交互合同：先做 P0，P1 有边界

### P0：必须能看、能点、能返回

| 路径 | 旧版证据 | 下游归属和最低验收 |
| --- | --- | --- |
| 首页 → 广电服务 → 返回 | `home` 里手机卡/宽带/电视/上门等链接均指向 `#/gd`；线上路由表 `gd.parent=home` | C02：四个入口能进入同一展示页；未接真实业务用“演示/待接入”，从详情返回首页 |
| 首页 → 社区/广播 → 活动详情 → 返回 | `community` 可进入 `broadcast`、`activity`、`culture`；`broadcast` 含 `#/activity` | C03：消息/广播/活动各有可访问视图，来源明确，详情返回到合理父级 |
| 首页 → 健康 → 讲堂/助手/魔镜/设备 | `health` 链向 `ai`、`mydevices`、`device`、`lecture` | C04：主要入口和返回可用，设备/AI 不得伪造接入 |
| 首页/惠生活 → 商品/兑换 → 积分 | `life` 链向 `product`、`exchange`、`points`；`points` 链向 `exchange`、`lecture`、`activity`、`mydevices` | C05：列表→详情→返回与积分示意；C06 验跨模块入口 |
| 我的 → 积分/设备/广电 → 返回 | `me` 链向 `points`、`mydevices`、`gd` | C06：集成已有页面，确保入口路径通畅，不能再造对应页面 |

### P1：只在对应卡片容量允许时复现

- 广播“文字稿 / 重听”：页面上 `[data-demo]` 只弹出“演示：……”提示；单独 `[data-play-toggle]` 切换播放/暂停图标和 CSS 状态，**HTML 没有 `audio` 标签**。不应对外承诺有真实音频。
- 活动“签到 +30 积分”和“开场提醒”：旧版是演示 Toast，**没有持久化积分、扫码或通知服务**。优先展示正确提示，不实施真实服务。
- `segmented`、`chips`：只切换 `aria-selected` / `aria-pressed` 选中态，不保证内容过滤或服务端状态改变。
- AI 助手回答、健康设备绑定、商家详情、商品兑换、广电开户、上门预约、我的订单/券等：旧版主要靠 `data-demo` 的提示模拟，**不应假装已接 API 或支付**。

**已发现需要避免的旧版语义陷阱：**
1. 旧版 **多件商品链接共用 `#/product`**，而这个页面固定显示“5 斤装大米”；React 版如果要按商品展示正确详情，需要先确认 SKU/选中项模型；**C05 不得无依据地实现全部商品一致详情或伪交易**。
2. 旧版从积分任务可跳往健康讲堂、活动及设备；跨页路由须在 C06 统一校验，不要为了单卡通过而把入口去掉。
3. 旧版 5 Tab 对应 `home/community/health/life/me`；新版现有 `首页/发现/我的` 是**框架占位**。可以用临时“旧版页面索引/演示入口”承载 16 页，**不得未经讨论直接锁定新版五 Tab**。（I03 / #23 已按维护者最新决策确认本轮演示采用五 Tab；`/discover` 与临时演示入口已退场。）
4. 旧版所有服务均为模拟；PRD 对社区广播“重听→详情→报名→提醒→签到→积分”的完整描述是产品意图，不等于已完成完整业务闭环。

## 4. 素材与迁移实现边界

- 线上旧版包含 **8 个 `img` 引用，指向 `images.unsplash.com` 外部图片**（下棋、长者活动、水果等）。这些是历史演示素材：不得无授权批量复制/重托管；先核准许可及实际可用性，缺失时使用可说明的占位样式。
- 旧页面含 **42 个内联 SVG symbol**，仅是图标/装饰资源。新工程已有 **Lucide React**，优先按语义重选图标，不移植整套旧 SVG sprite。
- 旧版 HTML、CSS、JS 共存于同一静态文件；**不要把它作为 iframe 或复制进 React JSX 长期维护**，也不要将压缩 Base64 和打补丁脚本搬入新仓库。
- 为演示内容建稳定 `src/mocks/` 数据源；一个页面一组 Mock/fixture 即可，不为未存在的后端写复杂仓储框架。
- 页面/路由按需放进 `src/pages/`、`src/App.tsx`。公共布局复用现行 `MiniProgramShell`，绿色视觉遵循 [design.md](../../design.md)，避免每卡发明新的头栏或底部导航。
- 新工程预览：<https://sanchuang-dev.github.io/local-life/>；旧版演示：<https://sanchuang-dev.github.io/base-prototype/local-life/>。两者**并行存在**，不改 `base-prototype/main` 的发布映射，除非用户另外授权切换。

## 5. C02–C06 独立施工指令（按卡推进）

| 卡 | 唯一主要修改域 | 施工收口与接口 |
| --- | --- | --- |
| **C02 [#7](https://github.com/sanchuang-dev/local-life/issues/7)** | `HomePage`、首页拆分组件、`/gd` 最低展示页及数据 | 先做首页+广电入口；其它模块仅导航到已有页面或明确待接入；不能大改壳。 |
| **C03 [#8](https://github.com/sanchuang-dev/local-life/issues/8)** | `community/broadcast/activity/culture` 页面和数据 | 保留广播→活动链接、来源文案、演示签到/提醒；不碰健康和积分实现。 |
| **C04 [#9](https://github.com/sanchuang-dev/local-life/issues/9)** | `health/assistant/device/lecture/me-devices` | 设备归 C04；C06 复用入口。没有真实医疗/AI/设备服务。 |
| **C05 [#10](https://github.com/sanchuang-dev/local-life/issues/10)** | `life/product/exchange/points` | 积分与兑换同一数据源，不能伪扣积分/伪发券；C06 复用积分入口。 |
| **C06 [#11](https://github.com/sanchuang-dev/local-life/issues/11)** | `me`、导航集成与页面回归矩阵 | 不重写其它卡功能；把 16 页的主要入口/返回实际跑通并列出遗留问题。 |

**协作规则：** 所有开发卡均从当时最新 `dev` 拉 `feat/*`，只提交本卡一个 Draft PR；前卡经审查并合并后才启动后卡。保持旧版 V0.3 为历史证据，新代码渐进迁入，不交叉复制同一业务事实源。

## 6. 已完成核对与仍有缺口

**已完成：**
- 对照 [历史 V0.3 PRD](https://github.com/sanchuang-dev/base-prototype/blob/demo/local-life/docs/PRD-V0.3.md)、旧分支规则与 `release/v0.3.1` 压缩包还原 HTML。
- 以 HTTP 获取线上发布 HTML，记录文件体积、SHA-256，并对照发布 manifest 预期哈希。
- 对比两种 HTML：确认都是 **16 个路由屏幕、5 Tab、64 内部链接、56 个 `data-demo` 演示控件**；识别线上版本新增的历史路由兼容补丁。
- 静态核实线上 HTML 的`data-screen`、`data-tab`、`href="#/..."`、`data-demo`、`data-play-toggle` 和路由脚本；上表内容有具体源代码依据。

**已完成浏览器抽样验证（线上旧站）：**
- 使用 Google Chrome 155 的无头移动视口 **375×812**，直接访问所有 **16 个旧 Hash 路由**，逐一验证对应 `.screen.active` 正确、归属一级 Tab 正确、详情页/一级页返回按钮显示状态正确。
- 从首页实际点击 `#/gd`，确认切换到广电页、首页 Tab 保持高亮、返回按钮可回到 `#/home`。
- 在广播页面点击“文字稿”模拟项，确认出现 `演示：广播文字稿` Toast；点击播放控件可切换 `is-playing` / 按钮文案；无 `audio` 标签与媒体源，**只是播放态展示**。
- 本次脚本收集到的前端页面异常：**0 个**；这只证明上述抽样路径，不等于全面业务 E2E。

**仍未覆盖：**
- 对 16 页所有链接/全部 56 个 Toast 按钮的逐项点击、外部 Unsplash 图源许可和可用性、真实微信小程序/WebView、机型和浏览器兼容矩阵。
- 目前只建议迁移路由和界面，不能把 V0.3 的业务假数据当作真实 API 合同。

**C02 开工门槛：** 本文件由人工审查并合入 `dev`；C02 的实际 Issue 仍需授权启动。第一张牛马卡还要验证本仓库的 Issue → Worker → Draft PR 通路，没跑通不得冒充已完成。
