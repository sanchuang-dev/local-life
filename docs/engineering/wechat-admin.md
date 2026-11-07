# 微信公众号后台配置（#113 LL-SYS-001）

> 本文描述 Issue #113 已落地的代码边界，**不代表真实公众号凭证、网页授权域名或真机微信登录已经验收**。
> 本文不包含任何真实 AppID/AppSecret、主密钥、access_token 或 openid。

## 1. 能力与边界

已实现：

- 管理台管理员保存/验证/启用公众号凭证（AppID + AppSecret），AppSecret 只以 AES-256-GCM 密文落库。
- 连接验证真实调用微信 `cgi-bin/token`，只证明 AppID/AppSecret 能换取令牌，令牌立即丢弃。
- 居民微信 OAuth（`/auth/methods`、`/auth/wechat/start`、`/auth/wechat/callback`）从数据库的 active 配置读取同一事实源；启用新配置不需要重启 API。
- OAuth state 绑定具体配置行；切换 AppID 期间的在途回调仍用原配置完成，旧行 retired 但不删除。
- 审计记录保存、验证成功/失败、启用，不含 secret/token。

未实现/未验收：

- 真实公众号凭证与真机微信授权（无凭证，按任务约束不做）。
- 在途回调超过 state 10 分钟有效期后的恢复；过期即按 `wechat_state_invalid` 拒绝。
- 多主密钥并存解密（当前同一进程只加载一个 key_id 的主密钥）。

## 2. 状态模型

数据表 `wechat_oauth_configs`（迁移 `0010_many_whirlwind.sql`）：

| 状态 | 含义 | 约束 |
| --- | --- | --- |
| `draft` | 已保存、未验证的候选 | 无 verified/activated/retired 时间戳 |
| `verified` | 真实连接验证通过、可启用 | 有 `verified_at` |
| `failed` | 最近一次验证失败 | 有 `last_error_code`，无 `verified_at` |
| `active` | 当前运行时唯一生效配置 | 有 `verified_at` + `activated_at`，全表最多一行 |
| `retired` | 被新配置替换的历史版本 | 有 `retired_at`；保留以支持在途回调 |

- 保存候选只会把**非 active 的候选**置为 retired，绝不触碰 active。
- 验证只作用于候选；失败只标记该候选，active 继续服务。
- 启用在一个事务内完成：旧 active → retired，候选 → active；`status='active'` 的 partial unique index 是最终兜底。
- 已 active 的同一行重复启用是幂等成功，不会 retired 自己，也不会写第二条启用审计。

## 3. 加密与主密钥

- 算法：AES-256-GCM；每次加密随机 12 字节 IV、16 字节认证 tag；AAD 为 `${appId}:${accountType}`。
- 数据库列只存 base64(ciphertext)、base64(iv)、base64(tag)、`key_id`；没有明文 AppSecret 列。
- 解密前先比对行的 `key_id` 与进程加载的主密钥 `key_id`，不一致直接 fail closed（`decrypt_failed`），不会尝试用错 key 解密。
- 主密钥来源二选一，同时配置会让进程启动失败：
  - `WECHAT_CONFIG_MASTER_KEY_FILE`：挂载文件，内容为 32 随机字节的 base64（推荐）；
  - `WECHAT_CONFIG_MASTER_KEY`：同样的 base64 内联值（仅本地/secret manager 注入）。
- `WECHAT_CONFIG_KEY_ID` 默认 `v1`；换 key 时同步换这个标签。
- 主密钥缺失时 API 仍可启动：后台配置读取返回 `masterKeyAvailable:false`，保存/验证/启用 503；居民 OAuth 返回不可用，绝不回退明文或旧 env。

### 3.1 初始化 / 备份 / 恢复 / 轮换

初始化（一次性，离线保存）：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

把输出写入受控文件（如 `/run/secrets/wechat-config-master-key`），权限 0400，**不要提交仓库**，并离线备份一份。**注意：文件路径必须是 API 容器内部可读取的路径，且文件对容器运行用户可读；仅把文件创建在主机上并设置 `WECHAT_CONFIG_MASTER_KEY_FILE` 不会自动挂载进去。**

### 3.2 现有在线 MVP 部署器接线（上线前必读）

当前 `sanchuang-dev/proto-infra@prod/scripts/install-local-life-mvp-app.sh` 用 `docker run --user 1000:1000 --read-only --env-file /srv/proto/local-life-mvp/config/api.env` 启动 API，只挂载 `/srv/proto/local-life-mvp/data → /data`；**没有挂载 `/run/secrets` 或 `/srv/proto/local-life-mvp/config`**。

因此在尚未为该部署器增补受控只读 secret mount 之前，不能把主机 `/run/secrets/...` 直接写成 `WECHAT_CONFIG_MASTER_KEY_FILE`，否则容器启动时会因文件不存在/不可读而失败。也不能把主密钥放在与 SQLite 同一份数据备份中以绕过挂载限制。

当前部署器已经支持的**一次性引导路径**是：由获授权的运维人员在主机上保留权限 0600 的 `/srv/proto/local-life-mvp/config/api.env` 内安全设置 `WECHAT_CONFIG_MASTER_KEY`（32 随机字节的 base64）和 `WECHAT_CONFIG_KEY_ID=v1`，并通过既有受控发布流程重建 API 容器使环境生效。**勿把真实值写进 Git、Issue、PR、聊天、Actions 输入或日志**；env-file 中存在此主密钥只是一种经宿主机权限保护的部署方式，不等于已启用 Docker secrets。完成这一**一次性的**初始化之后，管理员日常保存/验证/切换公众号凭证不再需要重启 API。

如要采用更推荐的文件方式，必须另行在 `proto-infra` 审核并实现**只读文件挂载**，确认容器 UID 1000 可读、主机文件权限受控、备份密钥与 SQLite 分离，并在隔离环境实际跑过容器读取检查。该 infra 变更不属于 #113 应用 PR，本 PR 不得假称已经支持主机直接挂载。

- 备份：备份 SQLite 的同时必须备份对应 key 与 `key_id`；只有密文无法恢复。
- 恢复：同一份 SQLite + 同一个 key/key_id 即可解密；key 丢失则所有密文永久不可用（fail closed，不会尝试猜测）。
- 轮换：新 key 与新的 `WECHAT_CONFIG_KEY_ID` 部署后，旧行会因 key_id 不匹配而不可解密；需要管理员重新保存并验证每个配置、再启用。轮换会让旧 active 行和其 10 分钟窗口内的在途回调失败关闭（`wechat_config_unavailable`），请安排在低峰并预留重新授权时间。

## 4. 管理员 API

全部复用现有 staff session / CSRF / Origin 校验，路径以 `packages/contracts` 的 `WECHAT_ADMIN_ROUTES` 为准：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/wechat/config` | `state`、`active`、`candidate`、`recent`、`masterKeyAvailable`、`keyId`、`redirectUri`；admin only |
| POST | `/admin/wechat/config/candidates` | 保存加密候选（不改变 active） |
| POST | `/admin/wechat/config/:configId/verify` | 真实调用 `cgi-bin/token`，10s 超时；失败只标记候选 |
| POST | `/admin/wechat/config/:configId/activate` | 仅 verified 可启用；`{expectedUpdatedAt, confirm:true}`，事务切换 |

- 失败统一 `{ error: { code, message, requestId } }`；错误消息不含 secret、请求 URL、raw errmsg。
- 未登录 401、非 admin 403、错误 CSRF / 不可信 Origin 403。
- `redirectUri` 不是配置项：由 `WEB_BASE_URL` 的 origin + `WECHAT_OAUTH_CALLBACK_PATH` 推导，页面只读展示；需在微信公众平台把同一 URL 配为网页授权回调域名/URL。

## 5. 连接验证 ≠ 微信登录

`verify` 只证明 AppID/AppSecret 能向微信换取 `access_token`，并且只覆盖服务端凭证是否正确。它**不能**证明：

- 网页授权回调域名已在微信后台登记；
- 用户在微信客户端内真的能完成 `snsapi_base` 授权；
- 当前部署的 HTTPS/Cookie 配置可用。

因此后台文案与验收报告必须区分“连接验证通过”和“真机微信登录已验收”。本仓库没有真实凭证，**真机 OAuth 未验收**。

## 6. 单一运行时与热切换

`resolveWechatRuntimeConfig(db, masterKey, { configId? })` 是唯一读取路径：

- `/auth/methods`：无 active → `wechat:false, reason:'not_configured'`；active 存在但主密钥缺失/密文不可解密 → `wechat:false, reason:'wechat_config_unavailable'`；正常 → `wechat:true, reason:null`。不返回配置 id、key id 或 secret。
- `/auth/wechat/start`：解析 active 并解密；不可用 503。state 行写入 `configId`，authorize URL 使用该行 `appId`，`redirect_uri` 用第 4 节推导值。
- `/auth/wechat/callback`：
  1. 先完成 state/nonce/过期/重放校验并原子消费；
  2. 按 `state.configId` 读取该行（允许 `active` 或 `retired`），用该行的 `appId` + 解密后的 `secret` 换 code；
  3. 老 state 无 `configId` → `wechat_state_invalid`；行不存在/不可解密/状态不是 active/retired → 清 OAuth cookie 并 `wechat_config_unavailable`；
  4. 微信身份仍按 `(app_id, open_id)` 唯一映射，切换 AppID 不合并身份；居民 UUID、session、invite/returnTo、防重放逻辑不变。

启动时若仍存在旧 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` / `WECHAT_REDIRECT_URI`，API 只记录一条 `config.wechat_env_ignored` 警告，字段只有变量名与提示，不含值；这些变量不再参与任何运行时决策。

切换期间语义：

- 启用 B 后，新的 start 用 B；A 行变 retired 但保留，A 的 10 分钟在途回调仍按 A 的 secret/appId 完成；
- 若 A 行密文已不可解密（key 轮换/损坏），该回调失败关闭为 `wechat_config_unavailable`，绝不跨账号重试，也不会用 B 的 secret 去消费 A 的 code；
- 回调先消费 state 再调微信，供应商失败返回 `wechat_provider_unavailable`，不会自动重试或自动报名。

## 7. 上线最少步骤

1. 生成主密钥并挂载/注入；设置 `WECHAT_CONFIG_MASTER_KEY_FILE`（或内联）与 `WECHAT_CONFIG_KEY_ID`；不要配置旧 env。
2. 部署 API，确认启动日志没有 `config.invalid`，且（若遗留旧变量）出现一次不含值的 `config.wechat_env_ignored`。
3. 管理员登录管理台 → 系统管理 → 微信公众号：保存 AppID/AppSecret → 点击连接验证 → 成功后才允许启用。
4. 把页面展示的只读回调 URL 登记到微信公众平台的网页授权域名/回调配置。
5. 启用后访问 `/auth/methods` 应为 `wechat:true`；在真实微信客户端内完成一次授权，才算真机验收。
6. 备份 SQLite 与主密钥（含 key_id），记录版本。

## 8. 旧 env 迁移

- 删除部署中的 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_REDIRECT_URI`；它们不再被读取。
- 通过管理台重新录入同一凭证并验证/启用；启用前居民 OAuth 处于 `not_configured`（首次迁移窗口），请安排窗口。
- 回调地址无需迁移配置：始终由 `WEB_BASE_URL` 推导，旧 `WECHAT_REDIRECT_URI` 即使保留也不会被使用。

## 9. 排查

| 现象 | 含义 / 处理 |
| --- | --- |
| `/auth/methods` `not_configured` | 还没有 active 配置：保存 → 验证 → 启用 |
| `/auth/methods` `wechat_config_unavailable` | active 行存在但主密钥缺失/错误或密文损坏：检查 key/key_id/备份，必要时重新保存启用 |
| `/auth/wechat/start` 503 | 同上；不会回退旧 env |
| 回调 `wechat_config_unavailable` | 该 state 绑定的版本不可解密或已不是 active/retired：重新发起登录 |
| 回调 `wechat_state_invalid` | state 缺失/过期/已消费/nonce 不匹配/老 state 无 configId |
| 验证 409/429/503 | 凭证错、微信限流、网络/超时；消息含微信 errcode 数字，不含 secret |

## 10. 验证证据

自动化测试（stub 仅限 `fetch` 边界，其余为真实 Hono + SQLite + 加密）：

- `apps/api/test/wechat-crypto.test.ts`、`wechat-config-db.test.ts`：加密与状态机。
- `apps/api/test/wechat-admin-http.test.ts`、`wechat-verify.test.ts`：管理员 API、真实 token 调用边界、权限/CSRF、审计与泄漏扫描。
- `apps/api/test/wechat-oauth-runtime.test.ts`：无配置、热切换、在途回调、跨 AppID 身份、密钥缺失/篡改、重放/nonce/过期。

这些测试**不是**真实微信 OAuth 验收；真实凭证与真机登录仍为未验证项。
