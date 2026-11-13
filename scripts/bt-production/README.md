# 本地生活 · 宝塔正式环境

正式环境独立于 MVP，源代码仍由 GitHub 管理。标签 `bt-prod-v*` 触发 GitHub Actions，为 H5、后台与 API 生成同一 SHA 的发布包，并通过已核验主机 Ed25519 指纹的 SSH **安全上传**到服务器 `/www/local-life/incoming/<SHA>`。

**上传成功不等于正式上线。** 第一次部署前，宝塔 Node 项目、后台域名 HTTPS、全新 SQLite、备份和真实 API 健康检查都必须经过验证。

## 四个 GitHub Actions Secrets

- `BT_PROD_SSH_HOST` — 主机 IP 或域名
- `BT_PROD_SSH_USER` — SSH 用户
- `BT_PROD_SSH_PASSWORD` — SSH 密码
- `BT_PROD_SSH_PORT` — SSH 端口

不得把 Secret 值放进源码或运行日志。使用已验收的 mvp 提交打独立的生产发布 tag；不要直接从未经审查的 dev 发布。

## 已观察到的宝塔宿主机

Alibaba Cloud Linux 4、Linux x86_64、glibc 2.38、Node v24.22.1、Nginx、MySQL、Redis 和既有应用。不要在该共享宿主机编译完整前端，不覆盖同事原业务。

居民域名：`local-life.3cgroup.cn`；后台域名：`local-admin.3cgroup.cn`。

## 第一次初始化步骤

1. 等 Action 返回 `BT_PRODUCTION_STAGED_SHA=<SHA>`，再检查服务器中对应发布包的 SHA256。
2. 首次完全空库时运行 `bash /www/local-life/incoming/<SHA>/bootstrap.sh <SHA>`。只创建一个持久 SQLite、独立 API 发布目录和服务器本地微信主密钥；不会迁移 MVP 数据，也不修改现有 Nginx。
3. 在宝塔正式注册独立 Node 项目：运行目录 `/www/local-life/current/api`、Node v24.22.1、启动命令 `node dist/index.js`、运行用户 `www`。API 只监听 `127.0.0.1:18081`。
4. 在宝塔登记两个网站并分别配置 HTTPS。两个域名的 `/api/*` 都要去掉前缀代理到同一 API。前端目录指向对应发布包、并配置 SPA history 回退。
5. 使用上传的 register-bt-node.py 通过宝塔既有 Node 项目接口登记 local_life_api，随后按已有安全初始化程序创建首个管理员，验证登录权限、CSRF、SQLite 完整性和持久化。
6. 启用定时在线备份，做恢复试验，再对外确认上线。

## 数据与发布纪律

数据库和服务端密钥持久保存在 `/www/local-life/shared`，不属于发布包。新版本迁移前必须先做 SQLite 在线备份，并在备份副本上演练迁移。任何回滚不能用旧数据库覆盖已经产生的新业务记录。

当前 Action **只负责构建和上传**。首轮服务配置验收通过后，再设计受控的版本切换和自动发布，不能将 staging 误报为发布成功。
