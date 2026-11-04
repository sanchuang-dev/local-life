# 本地生活 · 在线 MVP 验收环境决策（2026-11-04）

> **决策状态：负责人已明确同意域名与 `dev → mvp` 路线；尚未完成部署。**
> 本文是仓库级环境例外和实现约束，不是现有服务已运行的证明。实际部署证据记录在对应 PR / Issue。关联总里程碑 [#66](https://github.com/sanchuang-dev/local-life/issues/66) 与最终验收 [#65](https://github.com/sanchuang-dev/local-life/issues/65)。

## 1. 目的与已确认决定

- **目标唯一入口：`https://local.proto.3cgroup.cn`**。不再用 `xxx.proto.3cgroup.com`、`life.proto.3cgroup.com` 或历史的 `local-life.proto.3cgroup.cn` 作为本项目新 MVP 环境的目标地址。旧站仍有历史用途，未经核实不可覆盖或拆除。
- **环境性质：公开 HTTPS 域名上的受控 MVP 联调/演示环境**，供负责人以真实浏览器和手机查看。它不是正式商用生产环境；不得接入真实未授权居民名单或虚构交易/发奖。
- **分支例外：`feat/* → dev → mvp`**。实施卡仍从最新 `dev` 开 `feat/*` 并提交 Draft PR → `dev`；通过维护者独立验收后，以独立晋级 PR 将已审查的 `dev` 内容提升至 `mvp`。`mvp` 是**可变的在线验收发布源**，不是开发工作分支，也不是代替组织 `prod` 的商用生产分支。除紧急回滚，不允许直接向 `mvp` 提交业务修改。
- 现存 `test` / `prod` 与 `preview.yml` 的 GitHub Pages **静态展示**路线保留，不能将其等同于本环境；`main` 仍仅为仓库默认/工作流入口。正式商用发布路线须另行验收并冻结，不能从 `mvp` 自动推断已可商用。
- 在线化应当**先于全部业务模块完工**；第一阶段只部署已实现的 H5 + 管理台 + API + SQLite，未实现的三人团、CRM、商城与核销真实能力必须清楚显示为不可用/演示，不得假成功。

## 2. 当前核验与阻塞（仅 2026-11-04 观测，不等于部署验收）

- `local.proto.3cgroup.cn` A 记录解析到 `8.148.148.135`；对该域名的 HTTPS 请求出现 TLS handshake 错误，**暂不可正常访问**。
- 历史 `local-life.proto.3cgroup.cn` 解析到同一 IP，HTTPS 返回 200，响应服务器为 Caddy。说明可优先调查复用现有主机和 Caddy，但**没有授权改动现有站点**，也不能因此假设证书、端口、容器或磁盘可用。
- 当前 `dev` 的 `apps/web/vite.config.ts` 构建 base 固定为 `/local-life/`；`apps/admin` 默认根 base；`/api/*` 在开发期由 Vite 去前缀代理到 Hono 原始路由，线上必须由真实反向代理等价实现。
- 现有 CI 仅监听 `dev/test/prod`，Pages Workflow 仅部署 `dev/prod` 的静态 H5；**`mvp` 构建、部署、备份/回滚及权限门禁尚未实现**。

## 3. 推荐线上服务形态（待部署工单实证）

推荐复用现有授权主机上的 **Caddy + 一套隔离的 Node API 服务 + 持久化 SQLite**。优先简单、单主机、同源，不新造云平台；是否使用现有 Docker/Compose 由真实主机现状决定。

| 外部地址 | 功能 | 建议实现 |
| --- | --- | --- |
| `https://local.proto.3cgroup.cn/` | 居民 H5 | Caddy 提供独立构建的 H5 静态产物，`HashRouter` 保留 |
| `https://local.proto.3cgroup.cn/admin/` | 登录受保护的运营管理台 | Caddy 提供 **base 为 `/admin/`** 的 Admin 构建产物，后台真实会话鉴权 |
| `https://local.proto.3cgroup.cn/api/*` | API、认证和活动业务 | Caddy 去掉 `/api` 前缀，再反代至内网绑定的 Hono API |
| `https://local.proto.3cgroup.cn/api/healthz` | 健康检查 | 对应现有 API `GET /healthz`，不得用静态 200 假造健康 |

关键技术约束：

1. 为 **MVP 环境单独构建** H5 的 `base=/`，Admin 的 `base=/admin/`，不要全局修改现有 GitHub Pages 的 `/local-life/`、`/local-life/prod/` 资产路径。根路径和 `/admin/` 必须严格隔离，SPA 刷新、资源、入口与 Hash 路由正常。
2. API 与浏览器同源，外部只有 443；API 仅对本机/私有容器网络监听。Caddy 的 `handle_path /api/*` 可参考现有 Vite `rewrite` 语义，最终语法应依据主机 Caddy 版本核对。
3. Node API 在此公网部署即采用安全的 `NODE_ENV=production`、`AUTH_DEV_ENABLED=false`；`WEB_BASE_URL=https://local.proto.3cgroup.cn/`、`TRUSTED_ORIGINS=https://local.proto.3cgroup.cn`；Cookie 维持 HttpOnly / Secure / SameSite=Lax，默认主机专属域，不扩大共享 Cookie Domain。微信 OAuth 凭证和回调域名须实际授权才接入。
4. SQLite 必须位于**隔离的持久卷**，有备份、恢复和迁移预检；严禁使用开发者本机数据库或 GitHub Pages Mock 作为线上数据。配置与密钥仅存在授权服务端，绝不提交 Git。
5. 在线环境明确显示“测试/试运营前验收”，禁用尚不能履约的购买、中奖、领券成功路径；保护后台入口和测试数据，明确访问范围。若采取全站访问口令，须验证微信 OAuth 回跳、分享/扫码不被拦断。
6. 部署流程需具备构建校验、版本化镜像/产物、最小停机切换、失败回滚、数据库备份恢复和实际 HTTPS 冒烟；禁止简单以 `git pull` 在生产目录覆盖现有服务。

## 4. 首次可看版本的验收标准

- 新域名有效证书下可访问 H5 首页、指定活动深链、`/admin/` 登录页和 `/api/healthz`；外部任何 HTTP 均跳 HTTPS。
- 管理员能通过真实会话登录、创建/发布活动，独立浏览器刷新后 H5 读取同一 SQLite 活动；无权限/跨社区/CSRF 负例失败；静态 Pages 保持不回归。
- 线上部署能准确报告来自 `mvp` 的 commit SHA、构建标识、数据库版本、服务健康与发布记录；重启不丢数据，且有可执行备份恢复与回滚证据。
- 三人团、CRM、商城、兑奖等仅在后续业务切片通过验收后增量晋级 `mvp`。缺微信真实 OAuth 的功能明确受限，绝不拿开发测试身份当正式微信用户。
- 浏览器 375×812 和 320 宽度下检查入口、登录、后退、直达、刷新、API 错误，尽可能补手机真实浏览器/微信宿主检查；未执行的证据明确列缺口。

## 5. 施工拆分与权限边界

- **部署预检/方案卡**：只读核对 DNS 控制面、Caddy、域名证书、容器/端口、存储、目录、备份和权限；输出可复用的实施方案与阻塞。允许本地构建验收；**不得**未经授权登录改动主机或申请未知外部资源。
- **MVP 构建与发布卡**：新增独立构建命令、CI 对 `mvp` 的验证、明确发布目标与回滚机制；PR 仍从 `dev` 接入，经过维护者审查后再晋级 `mvp`。
- **实际域名上线/联调**：涉及 DNS、Caddy、现有服务、秘钥或生产旁路写入时，先由维护者确认目标主机及改动授权，再执行并保留证据。此处的域名决策 **不等于**授予改动旧站、生产配置或居民数据的权限。
- **最终业务端到端**：沿用 [#65](https://github.com/sanchuang-dev/local-life/issues/65) 的完整居民—网格员—运营—奖励—订单—对账验收；不以第一版在线可看代替最终结项。

## 6. 应主动升级确认的工时/决策门槛

发现以下情形立即向负责人确认，暂停有风险的扩大实施，不要求负责人盯常规小卡：

- 新域名 HTTPS 的失败原因超出普通 Caddy 站点/证书排查，必须改动现有正常服务、DNS 托管或更换主机；
- 需要重新设计身份/跨域 Cookie、脱离既有 HashRouter、大规模移动既有路由或复制第二套后端；
- SQLite、容器或备份方案要求破坏性迁移、触及生产居民数据，或需要新的付费资源/真实秘钥；
- 超出已授权单卡范围的明显工时膨胀、Agent Teams 两轮复核仍不通过或跨卡共享 schema/迁移出现冲突；
- 产品决策（团规则、奖励归属、真实试运营开放边界）仍未确认但施工会把它写成不可撤销合同。

**承诺区分**：这份文档记录的是 **已同意的域名/分支/目标** 与 **待验证的部署设计**；任何上线事实仍以可访问的地址、部署 SHA、运行日志及实测为准。
