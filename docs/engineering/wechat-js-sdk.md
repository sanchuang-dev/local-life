# 微信 JS-SDK 签名服务（LL-SYS-002 / #122）

本卡只提供 **服务端签名与票据缓存**。公众号凭证仍由 #113 的管理台管理，API 通过现有 `resolveWechatRuntimeConfig()` 实时读取数据库中启用的版本。没有增加数据库表、Redis、H5 分享界面或公众号设置入口。

## H5 访问契约

`POST /api/wechat/js-sdk/signature`，浏览器与居民 H5 **同源**，JSON 请求：

```js
const response = await fetch('/api/wechat/js-sdk/signature', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    // 必须使用此时页面的原始地址（保留 query、去掉 # 后的 hash）。
    url: window.location.href.split('#')[0],
  }),
})
if (!response.ok) {
  // 使用共享 apiErrorSchema 的 error.code/message 显示可行动的错误。
  throw new Error('微信 JS-SDK 签名当前不可用')
}
const { appId, timestamp, nonceStr, signature } = await response.json()
// 交给后续 H5 卡调用 wx.config；本卡不初始化 JS-SDK、不添加分享 UI。
```

成功响应（以下字段只是数据结构示例，实际值由后端动态生成）：

```json
{
  "appId": "wx1234567890abcdef",
  "timestamp": 1750000000,
  "nonceStr": "00112233445566778899aabbccddeeff",
  "signature": "ed31a3af9b1f0aa8b91a35f754c7b6a999d81fef"
}
```

上面的 signature 是 **结构示例，不是同一组展示字段的有效签名**；客户端不得复制静态签名。真实签名必须由服务器为当前页面生成。返回头 `Cache-Control: no-store`。

## 安全约束

- **URL 来源**：请求必须具有与 `WEB_BASE_URL` 的 origin 完全一致的 `Origin` 请求头。请求体中的 URL 必须是绝对的 HTTP(S) 地址，且协议和 origin 与 `WEB_BASE_URL` 一致。拒绝用户信息、反斜线、控制字符、超长、畸形、外站及 `/api/*` URL。可签署居民站点任意正常页面路径；`TRUSTED_ORIGINS` 中的管理后台域名**不在**签名允许名单内。
- **准确签名字符串**：服务器先去掉 URL 的 hash，保留 query 与原有百分号编码，以 `jsapi_ticket=<ticket>&noncestr=<nonceStr>&timestamp=<seconds>&url=<url>` 计算 SHA-1。它只在服务端保留票据。
- **秘密**：AppSecret 由原有 DB 密文和主密钥解析。官方 access_token、jsapi_ticket 仅在 API 进程内短暂使用；响应只包含公开 AppID、时间戳、随机 nonce、签名。错误只返回受控中文消息和共享错误码；不反射微信 `errmsg` 或请求 URL。
- **与登录解耦**：公开居民页面可获得签名，不要求已登录账号、不读 OAuth state、不创建登录会话。只有 `POST`，要求浏览器同源 Origin。

## 缓存与故障

- **每个 API 进程一份缓存**：token 和 ticket 各自按官方 `expires_in` 管理，最多信任 7200 秒；在到期前提前刷新（最多 5 分钟，短寿命票据提前约 10%）。成功时重新签发 nonce，**但不重新拉票据**。
- **并发合并**：同配置同资源只会运行一个 refresh Promise；其它请求等待同一结果。公众号被管理员切换时，使用配置行 ID、修订时间和 AppID 共同确定缓存版本，并丢弃旧 slot。若切换发生在旧远端请求进行中，回包前再次读取当前配置，旧请求返回 503，请客户端重试，不能返回旧 AppID 的签名。
- **降级**：微信网络失败、返回畸形数据或错误凭证时 503 (`wechat_js_sdk_unavailable`)；微信频率限制 `45009` / HTTP 429 时 429 (`rate_limited`)。失败后同配置短暂退避 15 秒，避免页面反复初始化造成微信接口风暴。换配置自动清空失败退避。
- **独立寿命**：只过期了 ticket 时，可以继续复用未过期的 token；票据刷新失败则清除本 slot 的 token/ticket，下一次过退避期再完整尝试。重启进程后会重新获取，没有跨实例一致性承诺。

## 已验证与未验证

`apps/api/test/wechat-js-sdk.test.ts` 在真实 Hono TCP HTTP 与已迁移的 SQLite 上执行；**仅外部微信 HTTP 边界使用受控 fake**，签名、缓存、URL 校验、并发与运行时配置解析均为生产实现。测试覆盖固定 SHA-1 向量、严格来源检查、未配置/解密失败、错误与秘密不回传、缓存复用/提前刷新、24 并发请求、16 并发刷新、热切换中旧在途请求拒绝及失败退避。完整仓库检查执行结果见 PR。

**真实微信验证尚未完成**：必须由获授权人员确认公众号启用配置有效、拥有 JS-SDK 所需接口权限、服务器出口 IP 在允许名单中（如果账号要求），并在真实微信内置浏览器使用居民线上 HTTPS 域名实际验证 `wx.config` 成功。本卡不修改服务器或微信密钥，不部署也不替用户配置公众号。GitHub Pages 静态预览域名与线上居民域名不同，不应请求线上签名。

## 错误状态

| HTTP | error.code | 说明 |
| --- | --- | --- |
| 400 | `invalid_request` | JSON / URL 非法，或签名地址不在居民站点 |
| 403 | `forbidden` | 请求不是来自居民站点 Origin |
| 429 | `rate_limited` | 微信上游限流，服务端有短暂退避 |
| 503 | `wechat_js_sdk_unavailable` | 没有启用公众号、解密不可用、上游异常或配置切换中；按消息重试或联系管理员 |
