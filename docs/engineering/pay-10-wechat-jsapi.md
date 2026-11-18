# PAY-10 · 微信支付 APIv3 JSAPI 预下单（feat/pay-10）

- Issue：[#285](https://github.com/sanchuang-dev/local-life/issues/285)
- 基线：`origin/dev@7a7785d`
- 官方文档核对日期：**2026-11-18**（以下协议事实逐条来自当天抓取的官方页面；旧调研只当线索）

## 1. 官方协议事实与来源

| 主题 | 事实 | 官方来源（2026-11-18 抓取） |
| --- | --- | --- |
| JSAPI 下单 | `POST /v3/pay/transactions/jsapi`；请求域名 `https://api.mch.weixin.qq.com`；成功应答**只有 `prepay_id`** | <https://pay.weixin.qq.com/doc/v3/merchant/4012791856> |
| 下单必填字段 | `appid`、`mchid`、`description`(≤127)、`out_trade_no`(6–32，数字/大小写字母/`_-|*`)、`notify_url`、`amount.total`(整数分，>0)、`payer.openid` | 同上 |
| `time_expire` | RFC3339 `yyyy-MM-DDTHH:mm:ss+TIMEZONE`；早于下单后 1 分钟会被微信自动改为 1 分钟；超过 15 天会被截断；未传默认 7 天 | 同上 |
| appid↔mchid | 下单 appid 必须与 mchid 绑定；JSAPI 需已认证服务号/政府或媒体公众号 | <https://pay.weixin.qq.com/doc/v3/merchant/4013070756>、<https://pay.weixin.qq.com/doc/v3/merchant/4015423216> |
| JSAPI 权限/授权目录 | JSAPI 支付权限、appid 绑定、支付授权目录是三件独立配置；调起时微信校验页面 URL 是否落在已登记目录 | <https://pay.weixin.qq.com/doc/v3/merchant/4015423216> |
| 请求签名 | 五行签名串 `METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n`；RSA-SHA256；Base64；`Authorization: WECHATPAY2-SHA256-RSA2048 mchid=..,nonce_str=..,signature=..,timestamp=..,serial_no=..`；`serial_no` 是**商户 API 证书**序列号 | <https://pay.weixin.qq.com/doc/v3/merchant/4012365334> |
| 调起签名 | 四行 `appId\ntimeStamp\nnonceStr\npackage\n`，`package` 必须形如 `prepay_id=***`；`signType` 不参与签名但必须传 `RSA` | <https://pay.weixin.qq.com/doc/v3/merchant/4012365339>、<https://pay.weixin.qq.com/doc/v3/merchant/4012791857> |
| 应答验签 | 三行 `timestamp\nnonce\n原始应答body\n`；使用微信支付公钥（推荐）或平台证书验 SHA256-RSA；`Wechatpay-Serial` 必须与本地信任锚一致；时间戳偏差建议 ≤5 分钟 | <https://pay.weixin.qq.com/doc/v3/merchant/4013053249>、<https://pay.weixin.qq.com/doc/v3/merchant/4013053420> |
| `prepay_id` 语义 | 预支付交易会话标识（官方 2 小时有效），仅用于调起收银台；**不是**交易号，也不能当付款成功 | <https://pay.weixin.qq.com/doc/v3/merchant/4012791856>、<https://pay.weixin.qq.com/doc/v3/merchant/4012791857> |
| APIv3 Key | 只用于回调 `resource` 解密/平台证书解密；**不是** PAY-10 出站签名前置 | <https://pay.weixin.qq.com/doc/v3/merchant/4013070756> |

> 官方“应答验签”示例文档中的签名值与随文公钥在本机程序化复核不匹配（同一签名在公钥/平台证书两篇文档各配了不同公钥却都写 `Verified OK`）。因此本卡**不照抄**该示例做 KAT，而是用官方**请求签名 / JSAPI paySign** 测试密钥向量做已知答案测试，并用固定本地测试密钥对为应答验签建立固定向量。该发现与 #285 早期调研“验签示例不是配对向量”的结论一致。

## 2. 服务端单商户配置（只读文件）

环境变量（全部可选；**要么全配、要么不配**；缺一项即启动失败）：

| 变量 | 说明 |
| --- | --- |
| `WECHAT_PAY_MCHID` | 商户号，6–32 位字母数字 |
| `WECHAT_PAY_APPID` | 已认证服务号 AppID，须与 mchid 已绑定 |
| `WECHAT_PAY_MERCHANT_SERIAL_NO` | 商户 API 证书序列号（hex） |
| `WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE` | 商户 API 证书私钥 PEM **只读文件**，RSA ≥2048，不可带口令 |
| `WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE` + `WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID` | 微信支付公钥（推荐）及其 `PUB_KEY_ID_...` |
| `WECHAT_PAY_PLATFORM_CERTIFICATE_FILE` | 备选：微信支付平台证书（与公钥二选一，序列号由证书导出） |
| `WECHAT_PAY_NOTIFY_URL` | `https` 回调地址；PAY-10 只把它写入下单请求，回调处理归 PAY-11 |
| `WECHAT_PAY_API_BASE_URL` | 可选，默认官方主域名；仅测试可用 loopback `http://127.0.0.1` |
| `WECHAT_PAY_TIMEOUT_MS` | 可选，1000–30000，默认 10000 |

边界：

- 私钥只以 Node `KeyObject` 存在于进程内；**不进 SQLite、不进 Git、不进浏览器、不写日志**；`JSON.stringify(config)` 不会输出 PEM。
- 不复用公众号 AppSecret/AES-GCM AAD 主密钥模型，不做数据库商户配置，不做管理台配置页。
- POSIX 下拒绝 group/other 可写的密钥文件；生产环境强制 `https`；配置缺失时 capability 明确为 `wechatJsapiAvailable=false`，接口 503，绝不回退 Mock。
- 平台证书模式的代码路径已实现（解析 PEM、校验证书有效期、从证书导出序列号），但本机无 `openssl`，未生成 X.509 测试证书做自动化验证（见“未验证项”）。

## 3. 预下单链路

`resident session + CSRF → payment intent(owner) → payable snapshot 复核 → (appid,userId) 可信 openid 映射 → APIv3 请求体 → 五行签名 → HTTPS → 原始应答验签/解析 → prepay 凭据持久化 → JSAPI 调起参数`

- `out_trade_no` 直接复用 PAY-02 的 `payment_intents.merchant_order_no`（`PAY-` + 28 hex = 32 字符，符合微信 6–32 约束），不再造第二套单号。
- 金额只用 `payment_intents.net_payable_cents`（PAY-02 冻结快照），并再次与 `local_orders.total_cents - coupon_discount_cents` 对齐；浏览器不能传金额。
- `openid` 只来自 `wechat_identities(appid, userId)` 可信映射；缺失即 409，不发请求。
- `time_expire` = 意图 `expires_at`（RFC3339 `+08:00`），与 `prepay_expires_at` 独立维护；本地调起有效期 = `min(now+2h, intent.expires_at)`。剩余不足 1 分钟直接拒绝，避免微信把支付窗口自动延长到意图截止之后。
- `description` 使用订单冻结的 `product_name`（≤127）。
- JSAPI 调起参数 `appId/timeStamp/nonceStr/package/signType/paySign` 全部服务端生成，新的时间戳/随机串每次重新签名；浏览器只拿到响应。

## 4. 持久化（迁移 0038）

新增 `wechat_pay_prepay_attempts`（只加表/索引/触发器，不改 0031–0037，不新增第二套 payment intent）：

- `prepay_id` 与 `payment_attempts.provider_transaction_id` **分离**；不写 `paid/payment_received/online_completed/channel transaction`。
- 记录 attempt 级：`attempt_no`、`request_fingerprint`(SHA-256 of `POST\nPATH\nBODY`)、`request_body_sha256`、脱敏后的请求体（payer openid 替换为 `sha256:<hex>`）、`payer_openid_sha256`、`time_expire_at`、`prepay_expires_at`。
- 出站审计：HTTP 状态、微信 `Request-ID`、应答 body SHA-256、**验签通过后**的微信错误码/消息；原始未验签 body 不落库。
- 状态：`requesting → succeeded | rejected | uncertain`；`requesting` 之外的记录是终态历史，触发器禁止回写/删除；请求快照列不可变。
- `succeeded` 必须同时有 `prepay_id`、`prepay_expires_at`、HTTP 200；`rejected/uncertain` 才允许失败码。

## 5. 重试与未知结果

| 已持久化状态 | 再次请求的行为 |
| --- | --- |
| `succeeded` 且指纹一致、prepay 未过期、意图未过期 | **复用**同一 `prepay_id`，不重发 HTTP，重新生成调起时间戳/随机串/签名 |
| `succeeded` 但 prepay 过期/意图过期/指纹变化 | 409，拒绝继续调起；不当作已付款，也不自动新建可扣款交易 |
| `rejected`（验签通过的确定性 4xx/微信错误） | 允许有界重试（最多 3 次），不产生“已扣款”状态 |
| `uncertain`（超时/网络/验签失败/5xx/畸形应答/缺 prepay_id） | 409，后续请求被阻断；**必须由 PAY-11 查单/关单收敛**，本卡不盲目重发 |
| `requesting`（进程崩溃残留或并发请求） | 409，结果未定，禁止重复发起 |
| 意图 `closed/failed` | 409；只有经可信查单/关单确认未支付后，才允许走 PAY-02 新生命周期 |
| 意图 `paid` | 409 `payment_already_paid`，永不重复调起 |

## 6. 明确不做（PAY-11 及后续）

微信通知接收/验签/`resource` 解密、主动查单、关单、退款、分账、账本投影、H5 页面、Admin 商户配置、真实资金部署、APIv3 Key 托管。`notify_url` 在本卡只是下单必填参数，PAY-10 不提供该回调端点。

## 7. 运维：密钥/证书更换与回滚

1. 新私钥/证书按新文件名挂载为只读文件（服务用户可读，group/other 不可写）。
2. 同步更新 `WECHAT_PAY_MERCHANT_SERIAL_NO`（及公钥文件/ID 或平台证书文件）。
3. 滚动重启 API；启动校验失败则进程不启动，旧进程继续服务（失败关闭，不静默降级）。
4. 回滚：恢复上一组文件与变量并重启；`wechat_pay_prepay_attempts` 为追加式审计，无需回滚数据。已发出的 `prepay_id` 到期自然失效，未决结果由 PAY-11 查单/关单处理。
5. 不做数据库私钥托管；不把私钥打进镜像/仓库。

## 8. 离线测试证据（真实结果见 PR）

- `pay-10-signing.test.ts`：官方请求签名 KAT（含完整 Authorization）、官方 JSAPI paySign KAT、负例、固定应答验签向量及负例、nonce、配置 fail-closed 与密钥不泄漏。
- `pay-10-provider.test.ts`：受控 `127.0.0.1` HTTP server，逐字节断言 method/path/body/Authorization/timestamp/nonce/signature；覆盖有效签名、错签、缺签名头、超时、畸形 JSON、4xx 微信错误、HTTP 200 微信错误、5xx、网络错误、缺 `prepay_id`、序列号不匹配、时间戳过期。
- `pay-10-persistence.test.ts`：真实 SQLite 文件 + 真实 Hono 路由：持久化、重启、重复请求复用、过期、确定性拒绝后重试、unknown 阻断、closed/paid 拒绝、缺 openid、未配置 capability/503；断言 intent 仍为 pending、无 payment_attempts/completion/ledger 事实、私钥不出现在 DB 文件。
- `packages/contracts`：路由/请求/调起/响应 DTO 与“prepay 不是付款”的 strict 字段约束。

## 9. 未验证项与外部阻塞

- 真实商户号/证书/AppID 绑定/JSAPI 权限/支付授权目录/备案回调域名均未具备：**没有真实联调，也没有真实小额支付证据**。PR 不会声称“已联调”。
- 平台证书模式缺少可自动生成的 X.509 测试证书（本机无 openssl），仅代码审查级支持。
- 微信侧 `prepay_id` 对相同 `out_trade_no` 重复下单的幂等行为未做真实探测；本卡在本地成功态直接复用，不依赖该行为。
- 当前时间戳/签名算法完全离线可复算；生产部署仍需 NTP 与只读挂载核查。
