# LL-MVP-002 · 身份与权限实现说明

> 对应 [Issue #58](https://github.com/sanchuang-dev/local-life/issues/58)。本文描述当前代码已实现的身份与权限边界，不代表微信真实账号或生产环境已验收。

## 1. 身份模型

- `users.id` 是平台唯一 UUID。活动、CRM、订单和奖励后续均应引用该 ID，不使用手机号、openid 或商城 UID 作为平台主键。
- `wechat_identities` 保存公众号身份映射，唯一约束为 `(app_id, open_id)`；`union_id` 可选。重复 OAuth 使用同一平台用户，不创建重复居民。
- `staff_accounts.user_id` 指向同一 `users` 主表。管理员可将已有微信居民用户关联为运营员/网格员；绑定要求该用户已有微信身份，且该用户尚未绑定后台身份。冲突返回 409，不做静默合并。
- 后台角色为 `admin`、`operator`、`grid_worker`。管理员拥有全局后台权限；运营员和网格员必须通过 `staff_community_assignments` 分配一个或多个社区。
- 居民与社区的关系由 `resident_community_assignments` 保存，主键为 `(user_id, community_id)`，因此同一居民在同一社区重复登录只会命中已有行（`ON CONFLICT DO NOTHING`），天然幂等。
- 社区归属只能由服务端推导（#123）。只有入口 URL 明确携带 `activityId` 时，活动 H5 才把该 ID 带入微信登录；首页为了展示而从公开列表选出的默认活动不构成归属上下文。`GET /auth/wechat/start` 读取该活动行、复用公开可见性规则（`published` / `paused` / `ended`）得到社区，再写入 OAuth state。客户端显式传 `communityId` 会被 400 拒绝——即使该 UUID 确实存在，也不构成归属依据；否则任何人都能凭一个存在的社区 UUID 给自己挂上任意归属。活动缺失、ID 形状非法或不可公开访问时直接拒绝，不做"登录成功但未归属"的静默降级。不带活动上下文的普通登录（如 `/me` 入口）不建立任何社区归属。
- 活动上下文与邀请、网格员业绩归属是三条独立链路：`invite` 只在参与确认时校验，登录既不写入参与/报名，也不改变邀请归属或 CRM 线索负责人。

## 2. 会话与安全边界

- 登录后生成 256-bit 随机不透明 session token；Cookie 名称 `ll_session`，数据库只存 SHA-256 hash。
- Cookie 使用 HttpOnly、SameSite=Lax、Path=/；生产环境自动 Secure，可通过 `COOKIE_DOMAIN` 明确共享子域。
- 写请求要求 CSRF double-submit：浏览器可读的 `ll_csrf` Cookie 必须与 `x-csrf-token` 请求头一致；已登录请求还必须匹配数据库中该会话的 CSRF hash。
- 若请求带 Origin，必须命中 `TRUSTED_ORIGINS`。这只是 CSRF Origin allowlist，不会自动开启 CORS；默认部署路径是 H5/Admin 与 API 同源。
- 后台密码使用 Node scrypt（随机 salt，N=16384、r=8、p=1）；连续 8 次失败后按登录名限流 15 分钟。
- 默认会话有效期 7 天，可由 `SESSION_TTL_HOURS` 调整。会话过期或后台账户停用时拒绝访问。
- 登录、登出、社区创建、后台账户创建和首个管理员初始化写入审计事件；不记录密码、Cookie、OAuth code/token 或 openid。

## 3. 微信网页 OAuth

公众号凭证不再来自启动 env，而是来自管理台保存并经管理员启用的 `wechat_oauth_configs` active 行（详见 [wechat-admin.md](wechat-admin.md)）。`/auth/methods`、`start`、`callback` 共用 `resolveWechatRuntimeConfig` 这一读取路径：每次请求从数据库解析并用主密钥解密，激活新配置后无需重启。

1. `GET /auth/methods`：无 active 行 → `wechat:false` + `not_configured`；active 行存在但主密钥缺失/密文不可解密 → `wechat:false` + `wechat_config_unavailable`；可用 → `wechat:true`。响应不含配置 id、key id、secret。
2. `GET /auth/wechat/start?activityId=...` 解析 active 可用配置（不可用返回 503，不回退旧 env），校验 `activityId` 与 returnTo，由活动行推导社区，创建随机 state / nonce，数据库只保存二者 hash，state 有效期 10 分钟，并把该配置行的 id 写入 `oauth_states.config_id`、把推导出的社区写入 `oauth_states.community_id`（无活动上下文时为空）。`communityId` 查询参数一律 400 拒绝。授权请求使用该行 appId、`snsapi_base` 与系统推导的回调地址（`WEB_BASE_URL` origin + `/api/auth/wechat/callback`）。
3. nonce 通过 HttpOnly、SameSite=Lax Cookie 绑定当前浏览器。
4. `GET /auth/wechat/callback` 先校验 state、nonce、过期时间，并通过原子更新将 state 标记为 consumed；重放拒绝。随后按 `state.config_id` 读取该配置行（允许 `active` 或 `retired`，以支持切换期间的在途回调），用该行的 appId + secret 换 openid：绝不使用回调时新 active 配置的 secret。老 state 无 configId → `wechat_state_invalid`；行不存在/不可解密 → 清 OAuth cookie 并 `wechat_config_unavailable`，不跨账号重试。
5. 服务端使用 code 向微信接口换取 openid；凭证仅在 API 服务端使用，不返回给浏览器、不写日志、不持久化 access token。
6. 按 `(appid, openid)` 查找或创建居民用户，按 OAuth state 中已验证的社区归属建立 `resident_community_assignments`（已存在则跳过），再签发平台 session 并回到 H5；切换 AppID 不会合并不同账号的身份。start 与 callback 之间活动即使被下架，也以已签发 state 为准完成这次在途归属。登录不写入参与/报名/组队/订单/奖励，邀请回跳仍由显式确认触发。

真实公众号 AppID/AppSecret、网页授权域名、回调 URL 与线上 HTTPS Cookie 尚未配置/实测。缺配置或配置不可解密时，`/auth/wechat/start` 返回明确 503；只能把本地 stub fetch 测试视为代码边界验证，不能当作真实微信验收。

## 4. 后台接口

| 接口 | 权限 | 用途 |
| --- | --- | --- |
| `GET /auth/csrf` | 公开 | 获取登录前 CSRF token |
| `POST /auth/login` | 公开 + CSRF | 后台账号登录 |
| `GET /auth/session` | 会话 | 查询当前账户与社区范围 |
| `POST /auth/logout` | 会话 + CSRF | 注销当前会话 |
| `GET /admin/communities` | 后台会话 | 管理员看全体；运营员/网格员只看分配社区 |
| `POST /admin/communities` | admin + CSRF | 创建社区 |
| `GET /admin/staff` | admin | 查看后台账号，不返回密码 hash |
| `POST /admin/staff` | admin + CSRF | 创建运营员/网格员并分配社区；可选关联已有微信居民 userId |
| `GET /crm/residents?communityId=...` | 后台会话 + 服务端社区范围 | 最多返回 100 条居民 ID、显示名与创建时间 |

居民 OAuth：

- `GET /auth/wechat/start`
- `GET /auth/wechat/callback`

开发居民测试登录：

- `POST /auth/dev/login` 仅在非生产且 `AUTH_DEV_ENABLED=true` 时注册可用；默认关闭。生产环境即使设置为 true，配置校验也会拒绝启动。

## 5. 初始化与配置

首次创建管理员：

```bash
pnpm admin:local # 本地 .env.local 与项目内 .data/local-life-dev.sqlite
```

管理员命令只允许在没有现存 admin 账户时创建首个管理员；密码交互输入不回显。后续后台账户在管理台创建。

配置样例见 [apps/api/.env.example](../../apps/api/.env.example)：

- `DATABASE_PATH`：默认 `../../.data/local-life.sqlite`（仓库根目录下）。
- `SESSION_TTL_HOURS`：默认 168 小时。
- `WECHAT_CONFIG_MASTER_KEY_FILE` 或 `WECHAT_CONFIG_MASTER_KEY`：公众号凭证加密主密钥（二选一）；`WECHAT_CONFIG_KEY_ID` 为密钥代际标签。缺省时功能 fail closed。
- 公众号 AppID/AppSecret 在管理台「系统管理 → 微信公众号」录入、验证并启用；不再通过 env 配置。
- 旧 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_REDIRECT_URI` 已弃用：API 不读取，只在启动时记录一条仅含变量名的忽略警告，请迁移后删除。
- `WEB_BASE_URL`：居民 H5 回跳地址；生产环境必填。OAuth 回调地址固定由它的 origin + `/api/auth/wechat/callback` 推导，不可通过 env 单独覆盖。
- `TRUSTED_ORIGINS`：逗号分隔的可信前端 Origin。
- `COOKIE_DOMAIN`：只有在确实跨子域共享 Cookie 时才设置。
- `AUTH_DEV_ENABLED`：默认 false；只允许非生产环境显式开启。

## 6. 明确未覆盖

本卡不实现手机号采集/验证、短信、密码找回、后台账号停用与密码重置、完整客户跟进、活动/订单/交易/奖励、商城同步、分账和生产部署。真实微信 OAuth 必须在具备账号凭证后单独完成真实环境验收；管理台的“连接验证通过”只证明 AppID/AppSecret 能换取 token，不等于真机网页授权、回调域名或 HTTPS Cookie 已验收。
