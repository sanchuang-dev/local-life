# Local Life MVP · 自动持续发布

## 触发与分支

- 唯一部署触发：`sanchuang-dev/local-life` 的受保护 `mvp` 分支收到 `push`（通常来自已经审核的 `dev → mvp` 晋级 PR）。
- `dev`、一般 PR、GitHub Pages `preview.yml` 只用于构建、预览与审查，不会触发本工作流的服务器写操作。
- 工作流：`.github/workflows/mvp-auto-publish.yml`。发布内容固定为触发事件的 `github.sha`，并在打包及发布前确认仍为当前 `mvp` tip；旧运行不会覆盖新提交。
- 构建与发布在串行 concurrency group 下执行（不取消正在运行的数据库切换）。

## 授权与信任链

- GitHub Organization secrets：`PROTO_SERVER_A_HOST`、`PROTO_SERVER_A_USER`、`PROTO_SERVER_A_PASSWORD`；可选 `PROTO_SERVER_A_PORT`，未配置时使用 SSH 标准端口 22。
- 三项凭据仅注入发布 job 的 SSH 步骤，**构建、代码检出、API 测试、制品打包均不读取服务器凭据**。
- 目标主机限制为 `8.148.148.135` 或 `proto.3cgroup.cn`，并用从 `proto-infra@prod` 现有发布器继承的已审核 Ed25519 主机公钥 SHA256 指纹校验；如果主机或密钥不匹配，拒绝部署，不使用 `StrictHostKeyChecking=no`。
- 受信安装脚本单一来源：`sanchuang-dev/proto-infra@69f33f9addb931ecee082c37a6aedacadc96abf5` 的 `scripts/install-local-life-mvp-app.sh`。`local-life` **不复制、不重写**安装脚本。调整部署器时需先审核并晋级 `proto-infra@prod`，再更新此固定 SHA。
- SSH 用户必须具有现有安装器要求的授权（其入口显式要求 root）。不从任何仓库或工作流创建全权限账号。
- 组织级 secrets 的作用范围建议改为 **Selected repositories**，只授予业务确实需要的仓库；`Public repositories` 会使组织全部公开仓库可读取这些 secrets，范围偏宽。

## 发布流水线

1. `validate`：从受信 infra revision 检查安装脚本语法、固定目录、静态资源权限约束。
2. `package`：检出事件 SHA，执行 Node 22 + pnpm frozen install + 全量 `pnpm check`；分别构建 H5/Admin 根路径页面、校验资源，构建同一 SHA 的 Linux Hono API 镜像，上传短期不可变构建物。
3. `publish`：从固定 infra revision 运行现有安装脚本。先校验工作流产物、受保护 `mvp` 最新 SHA、允许的主机和 SSH 主机公钥；通过密码 SSH 上传同一版本 H5/Admin/API 产物。
4. 服务端安装器负责：SQLite 在线备份、备份完整性校验、迁移副本演练、旧 API 停止及新单写者启动、真实 HTTP 鉴权检查、静态资源切换和版本记录；只作用于 `/srv/proto/local-life-mvp` 和 `127.0.0.1:18081`。
5. GitHub Runner 校验居民和后台两个域名的 HTTPS、`/api/healthz`、实际静态资源、匿名访问后台 API 返回 401，以及旧站无回归；成功后 finalize，失败则尝试安全回滚。
6. 如迁移已改变真实数据库 schema，不自动恢复旧 SQLite 快照，不把数据库数据丢失伪装为成功回滚。失败需维护者检查 Actions 日志中的具体阶段。
   
## 首轮验证与限制

- **新工作流只有进入 `mvp` 后才能通过 `mvp push` 真实触发**。创建 PR 或 GitHub CI 绿不是线上发布成功证明。
- 初次运行需要实证验证 SSH 端口、账号权限、组织 secrets 对仓库的可见性，以及部署后两个 HTTPS 入口。环境未提供真实微信授权、CRMEB 付款配置或奖品供应链时，不宣称业务链路完整上线。
- 查看 GitHub Actions 的 `Local Life MVP Auto Publish` 工作流：应同时出现 `validate / package / publish` 通过，并在发布日志出现 `MVP_DEPLOYMENT_VERIFIED_SHA=<mvp commit>`。真实 DB 备份及迁移副本演练由远端安装器日志确认。
- 当前快速集成线不等于正式商用环境；正式商用发布和用户数据启用另行授权。
