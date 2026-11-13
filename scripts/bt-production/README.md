# 本地生活 · 宝塔正式环境发布契约

晋级路线：`feat/* → dev → mvp（proto）→ prod（宝塔）`。只有 `mvp → prod`
的已审核合并 PR 能触发正式 GitHub Actions。发布包的源提交 SHA 是版本号。

`prod` 合并后，Actions 自动检查、构建 H5 / Admin / API、SHA256 校验、
固定 SSH 主机指纹上传，随后**执行宝塔受控激活**。只有收到
`BT_PRODUCTION_ACTIVE_SHA=<SHA>`，且两个公网域名通过真实健康检查，
才能报告部署成功。上传成功不等于版本生效。

## GitHub Secrets

`BT_PROD_SSH_HOST`、`BT_PROD_SSH_USER`、`BT_PROD_SSH_PASSWORD`、
`BT_PROD_SSH_PORT`。凭据不进入发布包、仓库或日志。
发布前还会核对待部署提交仍是 `prod` 最新 HEAD，过时的任务会拒绝执行。

## 服务端唯一真相源

- `/www/local-life/incoming/<SHA>`：GitHub Actions 校验过的发布包
- `/www/local-life/releases/<SHA>`：每个提交对应的解压版本
- `/www/local-life/current`：原子切换的**当前运行版本**
- `/www/local-life/shared/config/api.env`：持久生产配置、绝不被发布包覆盖
- `/www/local-life/shared/data/local-life.sqlite`：**唯一生产 SQLite**
- `/www/local-life/backups/release-<SHA>/`：迁移前数据库及两个站点快照
- `/www/local-life/ops/deploy.lock`：排斥并发发布
- `/www/local-life/ops/manual-recovery-required`：迁移失败安全阻断标志

两个网站仍由宝塔管理：`local-life.3cgroup.cn` /
`local-admin.3cgroup.cn`，API 在宝塔的 `local_life_api` Node 项目中，
监听 `127.0.0.1:18081`。两个站点原静态根保持不变，不修改
全局 Nginx、MySQL、Redis 或其他 PM2 服务，不在共享主机编译 React。

## 自动发布与迁移演练

1. 校验 SHA256 并解压新版本；现网暂不变。
2. 禁止迁移倒退或改写既有 SQL。使用 `better-sqlite3` 在线备份现网
   SQLite 临时副本，**真实执行新版本 Drizzle 迁移**。
3. 新 API 在仅监听本机的临时端口 `18082` 对迁移副本做真实启动健康检查。
   预演失败，禁止停止现网。
4. 通过宝塔接口停止旧 API，制作停写之后的 root-only 在线数据库备份，
   再次用新版本迁移该备份的临时副本。
5. 在真实 SQLite 执行迁移，原子切换 `current`，通过宝塔启动新 API，
   先检查本机 API 健康。
6. 分别复制 H5/Admin 静态文件，先复制全部资源，**最后原子替换首页
   index.html**，并保留旧哈希文件以支持正在打开的旧页面。
7. 检查两个公网 HTTPS 首页内容与新版本精确一致、
   `/api/healthz`、SQLite 完整性、外键、迁移数。全部通过才返回成功。

## 失败与自动回退的边界

- 无 Schema 变化：自动恢复旧 `current` 以及两套原站静态文件，通过宝塔
  重启旧 API，重新检查健康；Action 仍然报错，绝不假绿。
- 已开始 Schema 变更：自动**停止 API 并保留数据库现场及恢复快照**，
  设定 `manual-recovery-required`，暂停后续自动发布。不擅自用旧数据库
  覆盖可能已经产生的新业务写入。
- 解压失败、DB 演练失败：不会切换现网。
- SQLite 文件与密钥均在 `shared` 持久目录，永不复制到公网静态目录。

## 运维入口

- 宝塔「网站」：两个正式域名 / TLS / Nginx。
- 宝塔「Node 项目」：`local_life_api` 服务及日志。
- 宝塔「SQLite」：`local-life-prod` 供表浏览、只读 SQL。
- 宝塔「计划任务」：每日 03:45 运行 `/www/local-life/ops/backup-sqlite.sh`。

**不能使用宝塔 SQLite 内置的直接复制备份按钮**，WAL 可能未全部刷盘。
长期备份使用现有经过检验的 SQLite Online Backup API。

首次空库 `bootstrap.sh` 已经执行过，后续升级严禁再次初始化生产库。

## 本地验证

`python3 -m unittest discover -s scripts/bt-production/tests -v`、
`python3 -m py_compile scripts/bt-production/deploy.py`、
`node --check scripts/bt-production/migrate-db.mjs`、
`bash -n scripts/bt-production/bootstrap.sh`。
全量 CI、proto 验收和正式发布结果必须对应实际 SHA。
