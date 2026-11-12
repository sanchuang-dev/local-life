# LL-H5-005 · 活动微信分享浏览器验证（Issue #124）

## 测试的实际路径

- 已发布活动：首页 `/`，从数据库读真实发布信息、参与者和三人团队数据。活动玩法页 `/community/activity/silver-neighborhood` 仍由首页可达，复用同一个真实团队邀请码与签名 Hook。
- **未改** `/community/activity` 和 `/community/activity/:activityId` 的历史演示活动详情，以及分享海报和二维码结构。
- 服务器端沿用 #122 `POST /wechat/js-sdk/signature`；外部调用 `/api/wechat/js-sdk/signature`，签名 URL 为当前浏览器页面 URL（无 hash），不是分享目标 URL。

## 真实浏览器验证

**环境**：macOS Chrome 157 Headless，模拟微信 iPhone User-Agent、普通 Chrome User-Agent；居民 H5 Vite BrowserRouter；真实 Node/Hono API，已迁移 SQLite、真实 `#122` 进程内签名缓存与 SHA-1 服务。测试活动来自现有仓库 `docs/engineering/evidence/ll-mvp-012/seed-browser-db.ts` 的一次性发布活动，居民通过已有开发测试登录、主动确认参与创建真实三人团队。

**仅替身边界**：API 请求微信上游 token / jsapi_ticket 时由本地 fake 返回受控数据；浏览器侧的 `window.wx` 接口由 JS-SDK 测试替身记录 `config`、`updateAppMessageShareData`、`updateTimelineShareData` 和错误回调；非微信的 `navigator.share`、clipboard 仅在浏览器环境记录参数。没有真实微信 AppSecret、访问令牌或对微信服务器发起任何请求。

最终同一份代码的浏览器断言 **25/25 通过**，包括：

- 未登录时仅可分享真实活动公开 URL，含 `activityId`，不生成邀请码；
- 登录居民明确确认参与后，微信好友与朋友圈分享卡片使用同一条真实 `activityId + invite` 链接；活动标题、摘要及 `/images/silver-neighborhood-hero.webp` 封面一致；
- 真实可达的活动玩法子页使用相同团队邀请链接；
- 微信内分享按钮只显示右上角菜单说明，不调用 `navigator.share` 或不存在的微信分享面板 API；
- 375px 与 320px 弹层截图，QR、按钮及信息完整，`scrollWidth <= clientWidth`；
- SDK `wx.error` 失败时活动页面、复制与二维码不受阻断，错误状态明确可见；
- 普通 Chrome 浏览器仍使用原来的 `navigator.share`，收到真实活动和邀请码；该路径不调用微信 SDK；
- Chrome 无未捕获页面异常或 `window.error`。

截图与机器可读断言：

| 文件 | 说明 |
| --- | --- |
| `01-wechat-share-375.png` | 375px 微信邀请弹层 |
| `02-wechat-share-320.png` | 320px 微信邀请弹层 |
| `03-wechat-sdk-failure-375.png` | 375px JS-SDK 异常后二维码和复制可用 |
| `04-non-wechat-native-375.png` | 375px 普通浏览器继续使用系统分享 |
| `browser-results.json` | 25 条断言和好友／朋友圈实际配置参数（仅本地虚构用户与邀请码） |

定向共享逻辑测试：`pnpm --dir apps/web test`，3 个小测试通过；验证真实活动内容与封面 base、两个分享 API 的 payload、过期回调不注册旧邀请以及配置错误冒泡。

## 尚未覆盖的外部环节

此验证**不是微信真机联调**：需要经授权的真实公众号启用配置、合法的 JS 接口安全域名、HTTPS 线上居民站点、真实微信内置浏览器，分别用“发送给朋友”和“分享到朋友圈”实测最终卡片。上线或真实微信验收不在此 Draft PR 内；本卡不改动后端凭证、票据服务或服务器部署。
