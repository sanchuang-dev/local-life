# LL-UI-007 / Issue #91 社区与后台账户抽屉验收证据

> 分支：`feat/ll-ui-007-community-drawers`　基线：`dev@eb5edb6d1e81ab1e5c6cbb7a51e3bcc48fa3d9a0`
> 范围：管理后台 `/communities`（UsersPage）的两个创建入口与抽屉交互
> 执行时间：2026-11-05（Asia/Shanghai），本机真实 Chrome + 真实本地 API/SQLite
> 执行方式：`node docs/engineering/evidence/ll-ui-007/browser-verify.mjs docs/engineering/evidence/ll-ui-007`

## 结论

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 页面单测（真实页面 + 显式 fetch stub） | **11 / 11 通过** | `apps/admin/src/pages/UsersPage.test.tsx` |
| 浏览器端到端（真实登录、真实 CSRF、真实 API） | **102 / 102 通过，0 失败** | `browser-results.json`、23 张截图 |
| 类型检查 / lint / 构建 | 以本分支 `pnpm check` 与 PR CI 为准 | 见 PR 检查页 |
| 视觉走查 | **未做人工设计走查**，只验证布局/可用性约束 | 本文 §5 明列 |

浏览器脚本退出码 0；`browser-results.json` 中 `passed: 102, failed: 0`。

## 1. 实现内容

- “创建社区”“创建后台账户（角色 + 负责社区）”入口保留在列表主区域，创建表单只在抽屉中出现，不占用列表。
- 社区抽屉 `size={400}`（紧凑），账户抽屉 `size={560}`（更宽以容纳角色/多社区）。两者都用 Ant Design `Drawer` 的固定 footer。
- 仅管理员可见入口与抽屉；网格员页面不发起管理员写请求，也不挂载抽屉。
- 真实调用既有 `POST /api/admin/communities`、`POST /api/admin/staff`，带登录会话和 `x-csrf-token`；没有新增 API、合同、SQLite 或 H5 改动。
- 成功后只刷新对应列表：创建社区只重读社区列表并保留当前选中社区/居民表/滚动位置；创建账户只重读账户列表。
- 失败保留抽屉与输入，并在抽屉内显示服务端错误；校验失败不发 POST。
- 有内容关闭时确认（放弃并关闭 / 继续编辑）；干净表单直接关闭。
- 提交中禁用按钮并用同步 ref 防双击，双击只产生一次 POST。
- 关闭动画结束后焦点回到触发按钮（`focus({ preventScroll: true })`），不改变页面滚动。
- 抽屉宽度不超过视口，body 可滚动，窄屏 footer 仍可见；主页面在各宽度无横向溢出。

## 2. 环境与复现

- Windows，Node `v24.22.2`，`corepack pnpm` `10.19.0`，Chrome（headless + CDP）。
- 本 worktree 的 `.env.local` 端口：API `4280`、web `5373`、admin `5474`。
- 本机账号（**仅本地证据库**，不是任何共享环境凭据）：`evidence.admin` / `EvidenceAdminPass123`。
- 启动本地栈（本机 `pnpm dev:local` 在 Node 24 下会因 `spawnSync pnpm.cmd EINVAL` 失败，这是既有工具限制；改用显式环境变量启动）：

```powershell
$env:NODE_ENV='development'; $env:HOST='127.0.0.1'; $env:PORT='4280'
$env:WEB_PORT='5373'; $env:ADMIN_PORT='5474'
$env:DATABASE_PATH='../../.data/local-life-dev.sqlite'
$env:SESSION_TTL_HOURS='168'; $env:AUTH_DEV_ENABLED='true'
$env:LOCAL_LIFE_API_PORT='4280'; $env:LOCAL_LIFE_WEB_PORT='5373'; $env:LOCAL_LIFE_ADMIN_PORT='5474'
$env:TRUSTED_ORIGINS='http://localhost:5373,http://127.0.0.1:5373,http://localhost:5474,http://127.0.0.1:5474'
$env:WEB_BASE_URL='http://localhost:5373/local-life/'
$env:DOTENV_CONFIG_PATH='E:\tomz\local-life-wt\ui-007\apps\api\.env.local'
corepack pnpm dev
```

- 跑浏览器证据（每次使用 `RUN_TAG` 生成唯一社区名，可安全重复执行；只增数据、不删库）：

```powershell
$env:LL_ADMIN_ORIGIN='http://localhost:5474'
$env:LL_API_ORIGIN='http://127.0.0.1:4280'
$env:LL_ADMIN_USER='evidence.admin'
$env:LL_ADMIN_PASSWORD='EvidenceAdminPass123'
$env:LL_CDP_PORT='9571'
node docs/engineering/evidence/ll-ui-007/browser-verify.mjs docs/engineering/evidence/ll-ui-007
```

- 跑页面单测：

```powershell
corepack pnpm --filter @local-life/admin exec vitest run src/pages/UsersPage.test.tsx
```

## 3. 浏览器验收矩阵

视口均为真实 CDP 设备指标模拟；每档都实际打开、填写、关闭抽屉并测量 DOM。

| 视口 | 社区抽屉 | 账户抽屉 | 横向溢出 | footer | 表单滚动 | 焦点回归 |
| --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | 400px | 560px | 无 | 可见 | 不需要 | 通过 |
| 1024×800 | 400px | 560px | 无 | 可见 | 不需要 | 通过 |
| 768×800 | 400px | 560px | 无 | 可见且不遮表单 | body 可滚 | 通过 |
| 767×800 | 400px | 560px | 无 | 可见且不遮表单 | body 可滚 | 通过 |
| 375×812 | 375px（贴合视口） | 375px | 无 | 可见且不遮表单 | body 可滚 | 通过 |
| 320×640 | 320px（贴合视口） | 320px | 无 | 可见且不遮表单 | body 可滚 | 通过 |

行为矩阵（真实 API）：

| 场景 | 断言 |
| --- | --- |
| 管理员进入 `/communities` | 两个创建入口可见；到达时无抽屉；表单不在主区域 |
| 创建社区成功 | 201 持久化；只多 1 次社区 GET；当前社区、居民表、滚动位置不变；焦点回到“新建社区” |
| 创建社区校验失败 | 抽屉不关、输入保留、0 次 POST |
| 创建后台账户成功 | 角色 + 负责社区写入；只刷新账户列表；焦点回到“新增账户” |
| 服务端 409（重复账号） | 抽屉内显示真实错误；用户名保留；抽屉不关 |
| 账户必填校验 | 缺角色/社区时不发 POST |
| 脏表单关闭 | 弹确认；继续编辑保留内容；放弃关闭不创建；焦点回触发按钮 |
| 干净表单关闭 | 无确认，直接关闭 |
| 双击提交 | 只发 1 次 POST，只创建 1 条 |
| 网格员登录 | 入口隐藏、抽屉不挂载；服务端对其创建社区/账户请求返回 403；匿名读取管理员社区列表返回 401 |

## 4. 证据文件

| 文件 | 内容 |
| --- | --- |
| `browser-results.json` | 102 项断言逐条结果、请求时序（含 CSRF/POST 次数）、运行标签与时间 |
| `browser-verify.mjs` | 可复跑的 CDP 脚本（无额外自动化依赖，使用 Node 内置模块） |
| `01-communities-1440-initial.png` | 1440 初始列表与两个入口 |
| `02-community-drawer-1440.png` | 社区紧凑抽屉 |
| `03-community-validation-error-1440.png` | 社区校验错误、输入保留 |
| `04b-community-select-after-create-1440.png` | 创建后滚动到新社区选项 |
| `04-community-created-1440.png` | 创建成功、列表刷新、选中社区不变 |
| `05-community-select-refreshed-1440.png` | 第二次创建后选择器选项仍来自刷新后的 API 列表 |
| `06-staff-drawer-1440.png` | 账户宽抽屉（角色 + 负责社区） |
| `07-staff-validation-error-1440.png` | 账户必填校验 |
| `08-staff-created-1440.png` | 账户创建成功、列表刷新 |
| `09-staff-duplicate-error-1440.png` | 真实 409 错误留在抽屉内 |
| `10-dirty-close-confirm-1440.png` | 脏关闭确认 |
| `11-dirty-close-discarded-1440.png` | 放弃后关闭 |
| `12-double-click-1440.png` | 双击只创建一次 |
| `13-community-drawer-1024.png` / `13b-staff-drawer-1024.png` | 1024 两抽屉 |
| `14-community-drawer-768.png` / `15-staff-drawer-768.png` | 768 两抽屉 |
| `16-community-drawer-767.png` | 767 断点 |
| `17-community-drawer-375.png` / `18-staff-drawer-375.png` | 375 两抽屉 |
| `19-community-drawer-320.png` / `19b-staff-drawer-320.png` | 320 两抽屉 |
| `20-permission-grid-worker-1440.png` | 网格员视角：无创建入口 |

## 5. 未覆盖 / 已知限制

- **没有社区/账户的编辑、删除、停用 API**，因此本卡不提供这些操作，也没有用假按钮或本地 mock 冒充。若产品需要，必须先有明确的后端合同，另开卡片。
- 浏览器证据是桌面 Chrome 的视口模拟，不是真机触摸、软键盘、Safari/Firefox 或屏幕阅读器测试；这些仍需人工验收。
- 没有像素级视觉走查/设计稿对比，只有布局、溢出、footer 可见性和键盘/滚动可用性断言。
- 本地证据库会保留脚本创建的社区/账户（唯一后缀，不覆盖既有数据）；不重置数据库。
- CI 结果以 Draft PR 的检查页为准；本地 `pnpm check` 与 PR CI 是两道独立门禁，本文不预先宣称 CI 通过。
