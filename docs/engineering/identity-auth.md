# LL-MVP-002 · 身份与权限实现说明

> 对应 [Issue #58](https://github.com/sanchuang-dev/local-life/issues/58)。本文描述当前代码已实现的身份与权限边界，不代表微信真实账号或生产环境已验收。

## 1. 身份模型

- `users.id` 是平台唯一 UUID。活动、CRM、订单和奖励后续均应引用该 ID，不使用手机号、openid 或商城 UID 作为平台主键。
- `wechat_identities` 保存公众号身份映射，唯一约束为 `(app_id, open_id)`；`union_id` 可选。重复 OAuth 使用同一平台用户，不创建重复居民。
- `staff_accounts.user_id` 指向同一 `users` 主表。管理员可将已有微信居民用户关联为运营员/网格员；绑定要求该用户已有微信身份，且该用户尚未绑定后台身份。冲突返回 409，不做静默合并。
- 后台角色为 `admin`、`operator`、`grid_worker`。管理员拥有全局后台权限；运营员和网格员必须通过 `staff_community_assignments` 分配一个或多个社区。
- 居民与社区的关系由 `resident_community_assignments` 保存。微信 OAuth start 可带 `communityId`，由服务端验证社区存在后写入。当前该参数只校验社区存在，并非签名邀请凭证；在活动归属/业绩统计启用前，不能把客户端传入的社区参数当成可信的销售归属，后续应由服务端签发活动/社区邀请上下文。

## 2. 会话与安全边界

- 登录后生成 256-bit 随机不透明 session token；Cookie 名称 `ll_session`，数据库只存 SHA-256 hash。
- Cookie 使用 HttpOnly、SameSite=Lax、Path=/；生产环境自动 Secure，可通过 `COOKIE_DOMAIN` 明确共享子域。
- 写请求要求 CSRF double-submit：浏览器可读的 `ll_csrf` Cookie 必须与 `x-csrf-token` 请求头一致；已登录请求还必须匹配数据库中该会话的 CSRF hash。
- 若请求带 Origin，必须命中 `TRUSTED_ORIGINS`。这只是 CSRF Origin allowlist，不会自动开启 CORS；默认部署路径是 H5/Admin 与 API 同源。
- 后台密码使用 Node scrypt（随机 salt，N=16384、r=8、p=1）；连续 8 次失败后按登录名限流 15 分钟。
- 默认会话有效期 7 天，可由 `SESSION_TTL_HOURS` 调整。会话过期或后台账户停用时拒绝访问。
- 登录、登出、社区创建、后台账户创建和首个管理员初始化写入审计事件；不记录密码、Cookie、OAuth code/token 或 openid。

## 3. 微信网页 OAuth

1. `GET /auth/wechat/start?communityId=...` 检查公众号配置与社区 ID，创建随机 state / nonce，数据库只保存二者 hash，state 有效期 10 分钟。
2. nonce 通过 HttpOnly、SameSite=Lax Cookie 绑定当前浏览器；授权请求使用 `snsapi_base`，不主动索取微信头像或手机号。
3. `GET /auth/wechat/callback` 校验 state、nonce、过期时间，并通过原子更新将 state 标记为 consumed；重放请求拒绝。
4. 服务端使用 code 向微信接口换取 openid；凭证仅在 API 服务端使用，不返回给浏览器、不写日志、不持久化 access token。
5. 按 appid + openid 查找或创建居民用户，按 OAuth state 中的社区上下文关联居民，再签发平台 session 并回到 H5 `/#/me`。

真实公众号 AppID/AppSecret、网页授权域名、回调 URL 与线上 HTTPS Cookie 尚未配置/实测。缺配置时 `/auth/wechat/start` 返回明确 503；不能把本地 fake provider 测试说成真实微信验收。

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
- `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_REDIRECT_URI`：成组配置。
- `WEB_BASE_URL`：OAuth 完成后的 H5 回跳地址；生产环境必填。
- `TRUSTED_ORIGINS`：逗号分隔的可信前端 Origin。
- `COOKIE_DOMAIN`：只有在确实跨子域共享 Cookie 时才设置。
- `AUTH_DEV_ENABLED`：默认 false；只允许非生产环境显式开启。

## 6. 明确未覆盖

本卡不实现手机号采集/验证、短信、密码找回、后台账号停用与密码重置、完整客户跟进、活动/订单/交易/奖励、商城同步、分账和生产部署。真实微信 OAuth 必须在具备账号凭证后单独完成真实环境验收。
