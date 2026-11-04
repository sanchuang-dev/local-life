# 本地生活 · 在线 MVP 验收环境决策（2026-11-04）

> **决策状态：负责人已确认双域名、两个入口各自同源代理、`dev → mvp` 合并后自动部署；尚未完成部署。**
> 本文是仓库级环境例外和实现约束，不是现有服务已运行的证明。实际部署证据记录在对应 PR / Issue。关联总里程碑 [#66](https://github.com/sanchuang-dev/local-life/issues/66) 与最终验收 [#65](https://github.com/sanchuang-dev/local-life/issues/65)。

## 1. 目的与已确认决定

- **居民端：`https://local.proto.3cgroup.cn/`**；**管理后台：`https://local-admin.proto.3cgroup.cn/`**。两者均为独立 HTTPS Origin，各自提供同源 `/api/*` 入口，内部汇聚到**同一 Hono API + SQLite**。不再用 `xxx.proto.3cgroup.com`、`life.proto.3cgroup.com` 或历史的 `local-life.proto.3cgroup.cn` 作为新 MVP 入口；旧站必须保留，不覆盖、不拆除。
- **环境性质：公开 HTTPS 域名上的受控 MVP 联调/演示环境**，供负责人以真实浏览器和手机查看。**允许外部访客直接访问居民 H5 的公开活动内容，但未验收的报名、交易、中奖、福利兑现等业务必须不可操作**；后台登录及服务端鉴权必需。它不是正式商用生产环境；不得接入真实未授权居民名单或虚构交易/发奖。
- **分支例外：`feat/* → dev → mvp`**。实施卡仍从最新 `dev` 开 `feat/*` 并提交 Draft PR → `dev`；通过维护者独立验收后，以独立晋级 PR 将已审查的 `dev` 内容提升至 `mvp`。`mvp` 是**可变的在线验收发布源**，不是开发工作分支，也不是代替组织 `prod` 的商用生产分支。除紧急回滚，不允许直接向 `mvp` 提交业务修改。
- 现存 `test` / `prod` 与 `preview.yml` 的 GitHub Pages **静态展示**路线保留，不能将其等同于本环境；`main` 仍仅为仓库默认/工作流入口。正式商用发布路线须另行验收并冻结，不能从 `mvp` 自动推断已可商用。
- 在线化应当**先于全部业务模块完工**；第一阶段只部署已实现的 H5 + 管理台 + API + SQLite，未实现的三人团、CRM、商城与核销真实能力必须清楚显示为不可用/演示，不得假成功。

## 2. 当前核验与阻塞（仅 2026-11-04 观测，不等于部署验收）

- **2026-11-04 已实测**：`local.proto.3cgroup.cn` A 记录解析到 `8.148.148.135`，HTTPS TLS handshake 错误，**暂不可正常访问**。新增 `local-admin.proto.3cgroup.cn` **尚未执行 DNS/TLS 查询，不得视为已解析或证书就绪**。
- 历史 `local-life.proto.3cgroup.cn` 解析到同一 IP，HTTPS 返回 200，响应服务器为 Caddy。说明可优先调查复用现有主机和 Caddy，但**没有授权改动现有站点**，也不能因此假设证书、端口、容器或磁盘可用。
- 当前 `dev` 的 `apps/web/vite.config.ts` 构建 base 固定为 `/local-life/`；`apps/admin` 默认根 base；`/api/*` 在开发期由 Vite 去前缀代理到 Hono 原始路由，线上必须由真实反向代理等价实现。
- 现有 CI 仅监听 `dev/test/prod`，Pages Workflow 仅部署 `dev/prod` 的静态 H5；**`mvp` 构建、部署、备份/回滚及权限门禁尚未实现**。

## 3. 双域名、同一套 API/SQLite 的 MVP 服务形态（2026-11-04 已批准设计；待实证部署）

优先复用三创公司原型服务器上的 Caddy；居民端和后台分别使用单独的 HTTPS 虚拟站点，**每个浏览器页面只访问自身 Origin 的 `/api/*`**，两站点代理到同一个仅内网或本机可访问的 Hono 服务。无需把 Node API 独立开放为第三个公网域名。是否使用 Docker/Compose 以主机事实为准。

| 外部 URL | 功能 | Caddy 与构建要求 |
| --- | --- | --- |
| `https://local.proto.3cgroup.cn/` | 居民 H5，公开活动只读 | 独立 H5 构建：`base=/`，保留 HashRouter |
| `https://local.proto.3cgroup.cn/api/*` | 居民端同源 API | Caddy 去除 `/api` 前缀，再代理到同一 Hono |
| `https://local-admin.proto.3cgroup.cn/` | 受保护运营管理台 | 独立 Admin 构建：`base=/`，保留 HashRouter；服务端强制鉴权 |
| `https://local-admin.proto.3cgroup.cn/api/*` | 后台同源 API | Caddy 以相同 `/api` 前缀语义代理到**相同 Hono 进程** |
| 两域名各自的 `/api/healthz` | 真实后端健康检查 | 映射到现有 Hono `GET /healthz`，不可用静态 200 冒充 |

部署安全与身份边界：

1. **MVP 单独构建**：H5 和 Admin 的 Vite `base` 都为 `/`，因为它们分别运行在独立域名根路径；不能改动 GitHub Pages 的 `/local-life/`、`/local-life/prod/` 预览构建。HashRouter 页面刷新、资源路径、入口与深链接都必须测试。
2. **API 同源访问**：页面只对当前站点 `/api/*` 发送请求；Caddy 在两个域名上分别执行相同的路径去前缀和反向代理规则。浏览器不直接访问第三个 API Origin，因此无需新增跨源 CORS/credentials 接线。禁止为节省工作量暴露 API 内部端口。
3. **Cookie 和 CSRF**：每个站点以各自的 host-only HttpOnly/Secure/SameSite=Lax Cookie 提供会话，不配置跨四级子域共享的 `COOKIE_DOMAIN`。两站可共用后台数据库/session 表，但浏览器 Cookie 按域隔离，**不承诺跨站单点登录**。Hono 对写请求继续校验 CSRF token 和完整 Origin；`local` 与 `local-admin` 是不同 Origin，虽处于同一 site，SameSite 本身**不能**替代 Origin/CSRF 验证。应为两站点单独回归登录、登出、Cookie 生命周期、跨站伪造 Origin 及错误 CSRF 负例。
4. **配置**：公网运行 `NODE_ENV=production`、`AUTH_DEV_ENABLED=false`，`WEB_BASE_URL=https://local.proto.3cgroup.cn/`；`TRUSTED_ORIGINS` 必须是这两个 **精确 HTTPS Origin**（逗号分隔）。微信 OAuth 使用居民域名的授权回跳，真实 AppID、回调域名和后台操作权限必须有实际授权；不能把开发登录放行到公网。后台登录独立，不让管理台复用居民端的微信跳转回调。
5. **数据**：一套 Node API、单写者 SQLite，放于独立持久卷（不在发布目录），预备备份、恢复、迁移和回滚；共享的 H5/Admin API 数据不复制为第二份数据库。敏感配置只存在授权服务器侧。
6. **运营边界**：居民活动公开只读；后台真实登录且服务端鉴权；未验收的报名、交易、领奖等路径必须禁用或真实返回不可用，不能让静态 Mock 数据冒充已提交成功。
7. **上线约束**：两个四级域名分别核对 DNS、TLS、Caddy 生效配置及安全响应，保留旧 `local-life.proto.3cgroup.cn` 原型站。部署前建版本化产物、数据库备份及健康检查机制；回滚只切换兼容应用版本，不能自动恢复旧 DB 快照导致用户数据丢失。

## 3A. 已确认的自动发布方案（2026-11-04：方案 A）

维护者明确确认：**经审查的 `dev → mvp` 晋级 PR 合并后，`mvp` 分支的 push 自动触发在线验收环境部署**。这是发布策略决定，**并非已上线事实，也不授权直接修改现有服务器**。部署系统实际接通前，以现有 [#75](https://github.com/sanchuang-dev/local-life/issues/75) 的构建/CI 准备和 [#76](https://github.com/sanchuang-dev/local-life/issues/76) 的只读主机预检为前置；最终生产服务的首次写入必须明确获准。

### 发布触发与权限

1. 功能卡 `feat/* → dev` 的 Draft PR 先由维护者完成代码与行为验收；未通过不得合并。
2. `dev → mvp` **独立晋级 PR** 须经过必要 CI 和维护者审查后合并；禁止施工 Agent 直接 push 到 `mvp`，设置对应 GitHub 分支保护/规则集。
3. **唯一自动部署触发条件：受保护 `mvp` 的 push**，针对该事件的确切 commit SHA 构建和发布；不能因为 `dev` 更新、普通 PR 或 Pages workflow 触发真实主机部署。
4. GitHub Actions 部署 job 绑定独立 `mvp` Environment / 受限密钥；受信任的部署身份只能访问此项目目标目录和必要服务，不共享主机 root 身份。完成一次性授权和部署配置后，**每次正常晋级不再人工点击发布批准**。需合理设置串行发布以避免并发新旧版本交错。
5. 自动执行 frozen install / `pnpm check` / 独立 MVP web-admin-api 构建、产物/源 SHA 对应验证；失败在部署前停止。不得只靠 CI 绿认定运行成功。

### 部署与失败处理

1. 将同一 SHA 的 H5、Admin 与 API 作为**一个版本化发布单元**上传到独立 release 目录或版本化服务产物；Caddy 和服务进程的现有正常站点不能被未经授权覆盖。
2. 正式切换前校验磁盘/卷、配置、证书、可信 Origin、持久 DB 备份可用性；以 DB 副本演练待执行迁移及兼容性。避免让未验收的新旧 API 同时对同一 SQLite 写入。
3. 在可控的短暂切换窗口应用经核实的兼容迁移、启动新版本、验证真正的 `/api/healthz` 和静态资源/后台/会话关键链路。**只有成功后才将在线路由/当前版本指向新发布**。
4. 部署失败必须保留可定位的 SHA、健康证据和日志；部署前失败不影响当前版本。部署后故障优先恢复上一版**兼容的应用程序**。**不能无条件回滚 SQLite 到旧备份**，否则会丢失本次更新后合法写入的用户与业务记录。破坏性或不兼容迁移必须另行批准维护窗口。
5. 成功/失败都记录 GitHub Actions run、构建 SHA、线上健康结果、数据库迁移版本和回滚结果；禁止伪造线上验收通过。若线上工作流不能安全完成，就保持旧版并明确报错。

### SQLite 持久化与备份底线

- 本项目 MVP 采用**单写者 API + 独立持久化 SQLite**；数据目录不属于 Git 仓库、构建产物或可被清理的 release 目录，重建容器/切换版本不得清空。
- 启用 SQLite WAL 时，应使用 SQLite 原生在线备份接口、`VACUUM INTO` 或经验证的热备方法，**不能在仍有写入时仅复制主 `.sqlite` 文件**；备份的恢复可用性必须实测。
- 至少在每次涉及迁移的部署前做可恢复备份；常规每日备份、保留/异地加密副本策略根据实际磁盘、数据敏感度和主机权限核定。备份访问凭证和居民数据不得进入 Actions log。
- 数据库迁移推荐**向前兼容的增量演进**。仅回退代码无法处理的新 DB schema 时，应停止自动回滚并升级维护者决定，禁止自动恢复过期备份掩盖丢失。
- MVP 虽然是验收环境，但位于公网，因此 API 采用 `NODE_ENV=production` / `AUTH_DEV_ENABLED=false`，且未配置微信授权时不通过弱化生产校验来开放模拟登录。

## 3B. 现有公司原型机与部署责任边界（仓库证据，非主机实测）

- 当前 [`sanchuang-dev/proto-infra@prod/Caddyfile`](https://github.com/sanchuang-dev/proto-infra/blob/prod/Caddyfile) 已声明 `proto.3cgroup.cn`、`local-life.proto.3cgroup.cn` 等静态站点及 `benefit.proto.3cgroup.cn` 的 `127.0.0.1:18080` 反向代理；**尚未声明 `local.proto.3cgroup.cn` 和 `local-admin.proto.3cgroup.cn`**。前者 TLS 失败与此相符，但根因必须核对主机实际生效配置和日志；后者 DNS/TLS 尚未实测。
- [`proto-infra@prod/docs/DEPLOYMENT.md`](https://github.com/sanchuang-dev/proto-infra/blob/prod/docs/DEPLOYMENT.md) 记录公司独立阿里云 **2C2G** 原型机，原型入口的 Caddy 配置与旧静态站发布由 `proto-infra` 管理。其旧 [`deploy-local-life.yml`](https://github.com/sanchuang-dev/proto-infra/blob/prod/.github/workflows/deploy-local-life.yml) 固定抓取历史 `local-life/prod` 静态源，**不应直接复用为新的 H5/Admin/API/SQLite MVP 全栈部署器**；保留旧域名业务及兼容路径。
- **职责分离**：`proto-infra` 管**两个新域名**的 Caddy ingress、主机侧共享入口与证书配置；`local-life` 管自己的 `mvp` 提交、**两个根路径静态构建**、受控部署、唯一私有 API 进程与数据目录。两个 Caddy 站点是一次性受控变更，由 `proto-infra` 独立审核/晋级，不能让每次 `mvp` 更新覆盖共享 Caddyfile。
- **自动部署方案 A 不绕过 `proto-infra` 的发布纪律**：目标站点首次接入须按 `proto-infra` 的 `prod` 授权流程完成；以后 `local-life@mvp` push 只发布本应用的预先获准目录及隔离服务，不触发 `proto-infra` 配置变更，也不擅自触碰其他原型。
- 优先复用现有主机但尚未完成资源预检：验算 CPU、可用 RAM、磁盘、现有容器/服务端口、Caddy 生效配置和日志；构建产物优先在 CI 编译而非 2C2G 主机现场编译。若资源确实不足，先向负责人报告事实与额外成本，再决定是否迁移/增加主机。
- `proto-infra` 现有部署密钥属于**那个仓库**，不能假设 `local-life` 的 GitHub Actions 自动继承；后者须获得单独授予且范围受限的应用发布权限。禁止拷贝或记录历史 SSH 密码到仓库、日志或聊天。
- 首次接入实机前，若需要持久化 SQLite 与 Node API，优先镜像已有同主机服务的隔离部署形态；到底使用单容器+私有绑定卷还是 systemd 单进程，以 **当前主机实际 Docker/systemd 资源与运维工具** 为准，避免同时维护两种实施路径。

## 4. 首次可看版本的验收标准

- **居民域名** HTTPS 可访问 H5 首页和活动深链，未认证用户能够只读查看公开活动；尚未放开的报名、奖励、购买等操作不可产生成功状态。
- **后台域名** HTTPS 可访问独立 Admin 登录页，管理员使用真实会话登录、创建/发布活动；独立浏览器从居民域名读到同一 SQLite 的活动状态。运营员/网格员的社区越权及 CSRF 负例必须失败。
- 两个域名的 `/api/healthz` 都指向同一真实 Hono API；仅凭静态 HTML 返回 200 不算通过。服务器重启持久数据不丢失，两个站点的 host-only Cookie 独立，并验证没有错误的跨域共享/跨 Origin 登录假设。
- 两个新域名分别验证 DNS、TLS、HTTP→HTTPS、资产加载、登录/登出、Hash 深链、路由刷新。现有旧站和 GitHub Pages `dev/prod` 静态演示必须保持正常。
- 线上部署准确报告 `mvp` commit SHA、构建 ID、数据库 schema 版本、健康/备份/回滚证据；首轮自动部署流水线完成前不能宣称上线。
- 三人团、CRM、商城、兑奖等由各自业务卡验收后增量晋级 `mvp`；缺微信 OAuth/商城真实授权时功能明确不可用。
- Chrome 375×812 和 320 宽度检查居民移动端入口、状态和错误；PC 验证后台布局；尽可能用手机真实浏览器/微信宿主验证 OAuth 和分享入口，无法验证则列出明确阻塞。


## 5. 施工拆分与权限边界

- **部署预检/方案卡**：分别只读核对**两个新域名**的 DNS 控制面、Caddy、证书、容器/端口、存储、目录、备份和权限；输出可复用的实施方案与阻塞。允许本地构建验收；**不得**未经授权登录改动主机或申请未知外部资源。
- **MVP 构建与发布卡**：新增居民端和后台**双根路径**构建命令、CI 对 `mvp` 的验证、明确发布目标与回滚机制；PR 仍从 `dev` 接入，经过维护者审查后再晋级 `mvp`。
- **实际域名上线/联调**：涉及 DNS、Caddy、现有服务、秘钥或生产旁路写入时，先由维护者确认目标主机及改动授权，再执行并保留证据。此处的域名决策 **不等于**授予改动旧站、生产配置或居民数据的权限。
- **最终业务端到端**：沿用 [#65](https://github.com/sanchuang-dev/local-life/issues/65) 的完整居民—网格员—运营—奖励—订单—对账验收；不以第一版在线可看代替最终结项。

## 6. 应主动升级确认的工时/决策门槛

发现以下情形立即向负责人确认，暂停有风险的扩大实施，不要求负责人盯常规小卡：

- 两个新域名中任一个 HTTPS 的失败原因超出普通 Caddy 站点/证书排查，必须改动现有正常服务、DNS 托管或更换主机；
- 需要重新设计身份/跨域 Cookie、脱离既有 HashRouter、大规模移动既有路由或复制第二套后端；
- SQLite、容器或备份方案要求破坏性迁移、触及生产居民数据，或需要新的付费资源/真实秘钥；
- 超出已授权单卡范围的明显工时膨胀、Agent Teams 两轮复核仍不通过或跨卡共享 schema/迁移出现冲突；
- 产品决策（团规则、奖励归属、真实试运营开放边界）仍未确认但施工会把它写成不可撤销合同。

**承诺区分**：这份文档记录的是 **已同意的双域名/同源代理/自动发布策略** 与 **待验证的部署设计**；任何上线事实仍以两个可访问的地址、部署 SHA、运行日志及实测为准。
