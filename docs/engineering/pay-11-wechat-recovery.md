# PAY-11 · 微信支付通知、查单、关单与安全恢复

实施卡：[#286](https://github.com/sanchuang-dev/local-life/issues/286)，实施基线为 `dev`，以 `feat/pay-11 → Draft PR → dev` 交付。以下是**离线可验证的服务端代码合同**；不表示微信商户已开通或银行已到账。

## 协议与权威

- 微信通知公网入口 `POST /api/payments/wechat/notify`（Caddy `/api/*` 代理至 Hono `/payments/wechat/notify`）。先按原始 HTTP body、Wechatpay-* 签名头、平台信任锚与 5 分钟时间窗验签，再以 32 字节 APIv3 密钥 AES-256-GCM 解密 ciphertext、nonce、associated_data 和认证 tag。签名/解密错误拒绝；不记录明文、密钥、OpenID 或密文。
- 仅 `TRANSACTION.SUCCESS` 且 `trade_state=SUCCESS` 可以进入 PAY-03；商户 AppID/mchid、商户订单号、渠道交易号、冻结整数分和 CNY 均接受服务端校验。`prepay_id` 只是预下单凭据，不等于交易号。通知重放、主动查单竞态和终态冲突交给 PAY-03 的事务内证据去重、异常队列与唯一 `payment.paid.v1` outbox；PAY-05/PAY-06 继续负责唯一订单完成、线上收款及业务投影。下游消费失败保留 outbox，不能把浏览器结果当成功事实。
- **APIv3 的可选字段兼容**：查单在 NOTPAY/CLOSED/REVOKED 等非已付状态可能不返回 amount、total、currency；这些状态只在微信验签可信、商户号/AppID/商户订单号完全匹配时用于更新状态，不据此制造渠道已收款。SUCCESS 仍强制有渠道 total、CNY、transaction_id、success_time 并与冻结净应付校验；缺少实付证据一律 unresolved，不以本地金额填充“成功支付”。支付通知 resource.associated_data 可能省略或为空，按空字节参与 AES-GCM 验证；密文允许官方 1,048,576 字符范围，整个 JSON 通知最大 1,100,000 字节以防资源滥用。
- **运营核查**：PAY-11 的最新未知、退款待复核、关单请求未二次确认会在 PAY-09 现有支付差异列表分类为 provider_exception；服务端沿用运营员社区权限，详情最多展示最近 20 条脱敏审计摘要（操作、结果、代码、时间），不含原始微信响应、密钥、交易明文；0039 另用 SQLite UPDATE/DELETE 阻断触发器实现真正 append-only。
- **恢复公平性**：批量恢复按持久审计的最近查单时间升序、再按创建时间升序，优先处理未查的意图；连续故障的最老一批不能无限占住 20 个槽位。重启后不丢轮转顺序，仍须由服务端内部可信调度调用，未自动发布周期任务。
- 查单：签名 `GET /v3/pay/transactions/out-trade-no/{out_trade_no}?mchid=...`，只有微信签名可信的 200 响应、商户/订单/金额匹配才能确认为支付状态；其他结果标未知并保留审计。
- 关单：签名 `POST /v3/pay/transactions/out-trade-no/{out_trade_no}/close`，**HTTP 204 仅是发送成功，不是订单已关闭**。仅查得 `NOTPAY` 才发起关单，发送后必须再次可信查单出现 `CLOSED`/`REVOKED` 才允许 PAY-03 进入关闭终态。`USERPAYING`、超时、预支付过期、关单 204 与失败/未知一律不自动释放可重付资金机会。
- `PAYERROR` = 失败，不能显示为待付；`REFUND` 只记录需人工复核，不自动退款、冲账或分润；已关闭后的迟到成功是持久异常，不把终态回退为 paid。

官方一手文档：[JSAPI 通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791861)、[响应验签](https://pay.weixin.qq.com/doc/v3/merchant/4013053420)、[JSAPI 商户订单号查单](https://pay.wechatpay.cn/doc/v3/merchant/4012791859)、[关闭订单](https://pay.wechatpay.cn/doc/v3/merchant/4012791860)。上线时应对照官方最新的查单、关单与证书轮换文档再次校验。

## 文件与部署配置

商户号、绑定服务号 AppID、商户 API 私钥/序列、微信平台公钥及公钥 ID（或平台证书）继续使用 PAY-10 组。PAY-11 新增：`WECHAT_PAY_API_V3_KEY_FILE`，文件包含**字面量 32 个可打印 ASCII 字节**，不是 hex 或 base64；推荐 0600、服务帐号专有、只读挂载；内存中仅 Node `KeyObject`。该密钥独立于 OAuth AppSecret 与 PAY-10 商户 RSA 私钥；无密钥通知端返回 503。若 `NODE_ENV=production` 且商户支付组已配置，缺失或非法 APIv3 key 会**使启动失败**，不开放一个无法认证回调的真实收银台。

`WECHAT_PAY_NOTIFY_URL` 必须为 `https://实际公网域名/api/payments/wechat/notify`。必须有真实商户号/公众号绑定、JSAPI 权限、授权目录、HTTPS 回调域名与平台信任锚，才能宣称环境具备上线条件。测试环境可仅启动 PAY-10 出站并让 PAY-11 通知 503；严禁称其为真实已收款。所有商户配置、PAY-11 密钥、内部 token 都不允许写进 H5/Admin、Git、SQLite 或日志。

证书/密钥轮换：在商户平台确认新公钥及 `PUB_KEY_ID_...`（或有效 X509 平台证书），新文件名原子挂载受控密钥组，滚动重启 API 并做签名负例；当前配置一次信任**一个**平台序列，不能在轮换过渡期自行关闭签名校验。回滚恢复上一组完整可信文件后重启。运行时需要 NTP 校时。正式轮换窗口和 Web 授权必须实际操作核验。

## 内部恢复（仅服务端持有 PAYMENT_INTERNAL_TOKEN）

- `POST /api/internal/payments/wechat/:paymentIntentId/query`：单条可信查单，资金事实仍由 PAY-03 写入。
- `POST /api/internal/payments/wechat/:paymentIntentId/close`：先可信查单，仅 NOTPAY 尝试关单，再查单确认；失败不写“已关闭”。
- `POST /api/internal/payments/wechat/recover`：JSON `{"limit":10}`；最多批量 20 条到期/预下单未知的待处理 intent，供可信内部调度器/运维触发并重试。**代码不自动启动定时轮询任务**；不能将 Token 放入公开 URL、页面或第三方客户端。

所有恢复路由有现成的内部 Token 守卫，居民/后台账号不能以登录态代替。迁移 `0039_wechat_pay_recovery.sql` 只新增 `wechat_pay_recovery_checks` 追加审计：操作/结果/安全代码/响应体 SHA-256；**不是账本、支付证据或银行入账凭证**。有冲突的渠道证据仍归 PAY-03 `payment_review_exceptions`。

## 验证、残余风险与回滚

```bash
pnpm install --frozen-lockfile
pnpm --filter @sanchuang-dev/local-life-contracts build
pnpm --filter @sanchuang-dev/local-life-api typecheck
NODE_USE_ENV_PROXY=0 pnpm --filter @sanchuang-dev/local-life-api exec node --import tsx --test test/pay-10-signing.test.ts test/pay-10-provider.test.ts test/pay-10-persistence.test.ts test/pay-11-wechat-recovery.test.ts
pnpm lint
```

维护者复审补充了省略 AAD、大于 64KiB 的有效通知、无 amount 的 NOTPAY/CLOSED、缺支付金额的 SUCCESS 不可伪造收款、26 笔异常批量恢复经重启轮转、PAY-09 社区授权只读异常可见性及不可变审计负例。跨 PAY-08/PAY-10/PAY-11 运行证据详见 PR #303 最终 HEAD 的审查报告。\n\n本卡真实 Hono/SQLite 测试覆盖成功通知、伪造/错证/时间过期、AES-GCM 篡改、错商户/错金额、通知与查单竞争、重放、下游去重、进程重启、查单、关单 204 但未确认关闭、迟到成功、退款边界、内网权限。微信服务器仅是本地受控假 HTTP 服务；**无真实微信商户实付、证书轮换现场或银行对账证据**，须由总卡 #275 另行验收。无自动退款/分账/对账写路径。

回滚：撤回 PAY-11 路由/代码与内网恢复调度，恢复已验证商户配置。迁移 0039 为附加式审计，不改变已存在支付意图、不可变账本和发券记录；绝不为了回滚删除真实可信支付或 PAY-03 outbox。
