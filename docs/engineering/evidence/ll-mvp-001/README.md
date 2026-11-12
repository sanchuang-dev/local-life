# LL-MVP-001 验证证据

> 任务：[Issue #57](https://github.com/sanchuang-dev/local-life/issues/57)
> 实施基线：`dev` @ `758b625`；分支 `feat/ll-mvp-001-monorepo`。
> 环境：macOS，Node v22.23.2，pnpm 10.19.0，本机 Chrome 156.0.8078.74。

## 1. 安装与检查

```text
$ pnpm install --frozen-lockfile        # OK（单锁文件 pnpm-lock.yaml）
$ pnpm lint                             # oxlint，0 warning / 0 error
$ pnpm typecheck                        # contracts build + web/admin/api typecheck OK
$ pnpm test                             # API node:test 4/4 pass
$ pnpm build                            # web / admin / api 全部构建成功
$ pnpm check                            # lint + typecheck + test + build 全绿
```

`apps/web` 构建产物：`apps/web/dist/index.html`，资源引用 `/local-life/assets/*`。
`apps/admin` 构建产物：`apps/admin/dist`（仅本地，不发布）。
`apps/api` 构建产物：`apps/api/dist`。

## 2. API 真实 HTTP

启动 `node apps/api/dist/index.js`（127.0.0.1:4080）后：

```text
GET /healthz -> 200
{"status":"ok","service":"local-life-api","version":"0.0.0","uptimeSeconds":0,"timestamp":"2026-11-02T10:09:02.052Z"}
（响应头含 x-request-id）

GET /nope -> 404
{"error":{"code":"not_found","message":"No route for GET /nope","requestId":"6ee63304-f0d6-4247-992b-b3e8c0544b73"}}

PORT=abc node apps/api/dist/index.js -> exit 1
{"event":"config.invalid","message":"Invalid API environment: PORT: Invalid input: expected number, received NaN"}
```

管理台通过 Vite 代理 `GET /api/healthz` 请求同一服务（见下方浏览器检查）。

## 3. GitHub Pages 双构建

本地按 Pages 站点结构组装并用静态服务器验证：

```text
$ pnpm --filter @sanchuang-dev/local-life-web build                # dev 构建
$ pnpm --filter @sanchuang-dev/local-life-web build:prod-preview   # prod 构建
dev  index.html:  /local-life/assets/index-*.js
prod index.html:  /local-life/prod/assets/index-*.js
```

`preview.yml` 的组装断言（`/local-life/assets/`、`/local-life/prod/assets/`、两份 `index.html`）与本地结果一致。

## 4. 浏览器回归（375 × 812 / 320）

工具：本机 Chrome 156 + `puppeteer-core`（临时安装，不是仓库依赖）。脚本在
`/tmp/ll-browser/verify.mjs`，对本地 Pages 模拟站点、管理台 dev server 和真实 API 执行 30 项检查，全部通过：

- H5：标题、五个 Tab 可见、Tab 切换 + `aria-current` 高亮 + 各 Tab 内容标记、首页演示说明、图片全部加载、无横向溢出。
- 银发活动页：`#/community/activity/silver-neighborhood` 直接深链接可打开、图片从 `/local-life/images/` 加载、375/320 无横向溢出。
- prod 构建：深链接可渲染、图片从 `/local-life/prod/images/` 加载。
- 管理台：可独立打开；`/api/healthz` 经代理真实连通；未实现模块显示「该模块尚未实现」；**停掉 API 后点击「重新检查」显示真实「无法连接本地 API」**，没有假成功。
- 控制台：除故障演练故意产生的 502 外无错误；无失败网络请求（`ERR_ABORTED` 为 React StrictMode 卸载时主动取消的请求）。

## 5. 截图

| 文件 | 内容 |
| --- | --- |
| `web-home-375.png` / `web-home-320.png` | 首页 375 / 320 |
| `web-tab-community-375.png` | 社区 Tab |
| `web-tab-health-375.png` | 健康 Tab |
| `web-tab-life-375.png` | 惠生活 Tab |
| `web-tab-me-375.png` | 我的 Tab |
| `web-silver-375.png` / `web-silver-320.png` | 银发活动页 375 / 320 |
| `pages-prod-silver-375.png` | prod 构建（`/local-life/prod/`）的银发活动页 |
| `admin-dashboard.png` | 管理台总览，API 已连通 |
| `admin-unimplemented.png` | 未实现模块的明确空状态 |
| `admin-api-error.png` | API 停止后的真实错误状态 |

## 6. 未覆盖 / 风险

- 未在真实 GitHub Pages 部署后复验；本地静态服务器按相同路径与产物组装，CI/Pages 首次运行仍需维护者确认。
- 管理台未部署、无登录/权限，只有本地 dev server。
- 移动端为 Chrome 模拟视口，不是真机/微信 WebView；触控与安全区需后续真机验证。
- `prod` 分支仍是旧单包布局，Pages 工作流的兼容分支须在 prod 晋级后删除。
