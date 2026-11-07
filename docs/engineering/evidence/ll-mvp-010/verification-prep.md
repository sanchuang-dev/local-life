# LL-MVP-010 · 验证预热资产（t9）

> 执行者：`verifier`（独立验证；本任务**不判定** R1/R2 成败，只准备可复用验证资产）
> 时间：2026-11-06（Asia/Shanghai）
> 工作区：`E:\tomz\local-life-wt\mvp-010`（分支 `feat/ll-mvp-010-local-catalog-orders`，HEAD `007f433`）
> 基线对照 worktree：`E:\tomz\local-life-wt\baseline-eprem`（`origin/dev@ae8441a`，干净）

本文件记录四件事：**CDP 浏览器脚手架**、**本地起服务配方**、**E2E 建库骨架**、**EPERM 基线对照**。
所有脚本都放在 `.evidence/`（已加入本机 `.git/info/exclude`，**不会提交进仓库**）；证据产物（截图 + JSON）放在本目录。

---

## 1. CDP 浏览器脚手架

**位置**：`.evidence/browser-verify.mjs`（约 550 行，仅用 Node 内建 `fetch` / `WebSocket` / `child_process`，无 playwright、无 puppeteer）

**能力**

| 能力 | 实现 |
| --- | --- |
| 指定 URL | `--page <label>=<url>`（可多次），内部 `Page.navigate` + 等 `document.readyState === 'complete'` |
| 指定视口 | `--viewports 320x640,375x812,1440x900` → `Emulation.setDeviceMetricsOverride` |
| 截图 | `Page.captureScreenshot`（`captureBeyondViewport:false`），文件名 `<prefix>-<page>-<width>.png` |
| 横向溢出 | 每次采样 `document.documentElement.scrollWidth` / `body.scrollWidth` vs `window.innerWidth`，断言 `scrollWidth <= innerWidth + 1`，并附最大元素 `right` 坐标 |
| console 错误 | `Runtime.consoleAPICalled`（type=error/assert）+ `Log.entryAdded`（level=error） |
| 未捕获异常 | `Runtime.exceptionThrown` |
| 网络 | 记录 `Network.loadingFailed`（并关联 `requestWillBeSent` 取真实 URL）、`Network.responseReceived` 的 ≥400；**页面自身 abort（StrictMode effect cleanup）单独归类，不计失败** |
| 噪声白名单 | `--allow-console '<needle>'`，命中的消息进 `allowedNoise` 仍保留在 JSON 里，不静默丢弃 |
| 结果落盘 | `--results <name>.json`：逐条 `{name, ok, detail}` + 截图绝对路径 + 汇总 |

**可复用导出**（t10/t5 做真实交互时用，不必复制整份脚本）：`launchChrome()`、`openPage(chrome, url, {width,height})`、`closePage()`、`Cdp`（`eval` / `waitFor` / `screenshot` / `setViewport` / `layout`）、`writeResults()`。

**端口隔离**：CDP 端口默认 `9400 + pid % 400`，可用 `LL_CDP_PORT` 覆盖；Chrome 用独立临时 profile，避免多 worktree 并行时驱动到别人的标签页。
**关键坑（本次踩过并修正）**：`/json/new?<url>` 直接带 URL 会被 Chrome 拒绝（`HTTP 500 Could not create new page`），必须 `about:blank` + CDP 导航；`Browser.close` 会杀掉整个浏览器，因此每档视口只关自己的 tab。

### 1.1 三档基线截图（证明脚手架本身可用）

被测页面：现有 `/life`（惠生活），H5 走 Pages 形态的 HashRouter（`base=/local-life/`）。

```powershell
$node='C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node .evidence\browser-verify.mjs `
    --out docs\engineering\evidence\ll-mvp-010 `
    --page life=http://127.0.0.1:5173/local-life/#/life `
    --viewports 320x640,375x812,1440x900 `
    --wait-text 惠生活 `
    --prefix scaffold-life `
    --results scaffold-browser-results.json
```

结果：**24 passed / 0 failed，exit 0**（`docs/engineering/evidence/ll-mvp-010/scaffold-browser-results.json`）。
浏览器：系统 Chrome `156.0.8078.80`（`C:\Program Files\Google\Chrome\Application\chrome.exe`），`--headless=new`。

| 视口 | 截图 | innerWidth | documentScrollWidth | bodyScrollWidth | console error | 异常 |
| --- | --- | --- | --- | --- | --- | --- |
| 320×640 | `scaffold-life-life-320.png` | 320 | 320 | 320 | 0 | 0 |
| 375×812 | `scaffold-life-life-375.png` | 375 | 375 | 375 | 0 | 0 |
| 1440×900 | `scaffold-life-life-1440.png` | 1440 | 1440 | 1440 | 0 | 0 |

网络侧唯一非 2xx 现象：`/api/integrations/crmeb/status` 被页面 AbortController 取消（`canceled:true`，React StrictMode 双挂载），已归类为 `canceledByPage`，不是失败。

### 1.2 复用到管理台（同一份脚手架，不改代码）

```powershell
& $node .evidence\browser-verify.mjs --out .evidence `
    --page admin=http://127.0.0.1:5174/ --viewports 375x812 `
    --prefix scaffold-admin --wait-text 登录 `
    --allow-console 'antd: Spin' --results scaffold-admin-results.json
```

结果：**8 passed / 0 failed**（`.evidence/scaffold-admin-results.json`、`.evidence/scaffold-admin-admin-375.png`）。
说明：`antd: Spin` 的 `tip` 弃用警告是**既有**代码（`apps/admin/src/App.tsx:75`）产生的，属于基线噪声；本脚本用显式白名单保留它、而不是删掉日志。

---

## 2. 本地起服务配方（端口真相源 = `apps/api/.env.local`）

**位置**：`.evidence/local-stack.mjs`（不提交）

**端口为什么不硬编码**

1. 真相源只有一个：`apps/api/.env.local`（由 `scripts/local-dev.mjs` 的 `prepareLocalFiles()` 用 `wx` 独占创建，已 gitignore）。
2. `scripts/local-ports.mjs` 的 `resolveLocalPorts()` 是唯一的解析器（`PORT` / `WEB_PORT` / `ADMIN_PORT`，默认 4080/5173/5174，且强制三者互不相同）。
3. 本脚本调用 `prepareLocalFiles(root)` 拿到 `{ envPath, dbPath, ports }`，一切 URL/端口/代理环境变量都由它派生；脚本里**没有出现任何字面端口**（可 `grep -n '4080\|5173\|5174' .evidence/local-stack.mjs` → 无命中）。

**为什么不用 `pnpm dev:local` 直接起**：该启动器 `spawnSync('pnpm.cmd')`，而本机 PATH 上没有可用的 `pnpm.cmd`（只有 bundled `node` + `pnpm.mjs`）。本脚本用同样的进程与环境变量直连：

| 服务 | 命令 | 关键环境变量 |
| --- | --- | --- |
| API | `node --import tsx src/index.ts`（cwd `apps/api`） | `DOTENV_CONFIG_PATH=<.env.local>`、`PORT`、`NODE_ENV=development`、`TRUSTED_ORIGINS` |
| H5 | `node apps/web/node_modules/vite/bin/vite.js --host 127.0.0.1` | `LOCAL_LIFE_WEB_PORT`、`LOCAL_LIFE_API_PORT`（Vite 代理用） |
| Admin | `node apps/admin/node_modules/vite/bin/vite.js --host 127.0.0.1` | `LOCAL_LIFE_ADMIN_PORT`、`LOCAL_LIFE_API_PORT` |

> `--host 127.0.0.1` 是必需的：Vite 默认只监听 `localhost`，本机解析到 `::1`，会让 `127.0.0.1` 的健康检查/浏览器脚本连不上（本次实测踩到）。

**动作**

```powershell
& $node .evidence\local-stack.mjs health      # 只读检查：端口来源、三项是否在线、HTTP 状态
& $node .evidence\local-stack.mjs start       # 起 API+H5+Admin，等健康（API /healthz、H5/Admin 校验 <div id="root">）
& $node .evidence\local-stack.mjs start --only api,h5
& $node .evidence\local-stack.mjs stop        # SIGTERM → 等 6s → SIGKILL 兜底，并复查端口
& $node .evidence\local-stack.mjs run -- <command...>   # 起服务 → 执行检查 → 无论成败都关停
```

- 端口占用前置检查（127.0.0.1/::1 双栈），有占用直接失败并提示先 `stop`，避免 Vite 静默换端口。
- 进程树：先 `SIGTERM`，6s 后 `SIGKILL`，最后用 `process.kill(pid, 0)` 复查并在 `stack.json` 留下残留记录。
- 日志：`.evidence/logs/{api,h5,admin}.log`；进程表：`.evidence/logs/stack.json`。

**实测**

| 场景 | 结果 |
| --- | --- |
| `start`（默认端口 4080/5173/5174） | 3/3 健康就绪；`health` 全 `ok:true` |
| `run -- node -e ...` | 注入 `LL_API_ORIGIN` / `LL_H5_ORIGIN` / `LL_ADMIN_ORIGIN` 正确，退出后 3 个端口全部释放 |
| 把 `.env.local` 改成 4180/5273/5274 后 `health` | 输出端口随文件变为 4180/5273/5274，说明**没有硬编码**；恢复后再次验证回 4080/5173/5174 |
| `stop` | 端口 4080/5173/5174（及 4180/5273/5274）全部 `False` |

---

## 3. E2E 建库骨架（真实 Hono + 真实文件 SQLite）

**位置**：`.evidence/e2e-skeleton.mts`（TypeScript，用 `apps/api` 的 `tsx` 运行，因此必须在 `apps/api` 目录下执行）

```powershell
cd apps\api
& $node --import tsx ..\..\.evidence\e2e-skeleton.mts   # exit 0
```

**链路（全部真实，无 mock）**：`createDatabase(file)` → drizzle `migrate()` 跑完 0000–0009 → `createApp()` → `GET /healthz` → 直插一个 admin（仓库无 HTTP 建管理员入口，`bootstrap-admin` 是交互脚本）→ `POST /auth/login`（CSRF double-submit + Origin）→ `POST /admin/communities` 写一行 → `sqlite.close()` → 同一文件重开 → `GET /admin/communities` 读回 → `sqlite.close()` → `rmSync`。

**实测输出（`.evidence/e2e-skeleton.log`）**：

```
ok   migrations created the schema — 39 tables
ok   healthz returns ok — {"status":"ok","service":"local-life-api",...}
ok   admin login succeeds
ok   POST /admin/communities creates a row — {"id":"c9cbb80c-...","name":"端到端社区"}
ok   row survives close + reopen — {"items":[{"id":"c9cbb80c-...","name":"端到端社区"}]}
ok   reopened database holds exactly the written community
ok   healthz works after reopen
ok   temp directory removed without EPERM

8 passed, 0 failed        # exit 0
```

39 张表 = 既有 35 张 + R1 的 `local_products` / `local_orders` / `local_order_events` + `__drizzle_migrations`，说明 0009 已经在文件库上真实生效（**本任务只验证建库链路，不对业务语义下结论**）。

**避坑写法（已固化进骨架）**：

```ts
try { first?.sqlite.close() } catch {}
try { second?.sqlite.close() } catch {}
try { rmSync(temp, { recursive: true, force: true }); check('temp directory removed without EPERM', true) }
catch (error) { check('temp directory removed without EPERM', false, error.message) }
```

即：**先 `close()` 再删目录**，并把清理结果本身作为一条断言（而不是 `try/catch` 吞掉）。

**给 t10/t5 的复用点**：`cookiePairs/cookiePair/csrf/writeHeaders/login` 五个 helper 直接对应 `apps/api/test/crm.test.ts:58-122`；`createAdmin` 直插对应 `:160-180`；文件库重开对应 `:748-864`。业务断言（商品/订单）留给 t10/t5，骨架里刻意没有。

---

## 4. EPERM 对照基线

见 [`baseline-eprem.md`](./baseline-eprem.md)。一句话结论：**干净 `origin/dev@ae8441a` 上 223 tests / 8 fail；特性分支 `007f433` 上 240 tests / 8 fail；失败用例名集合完全一致（`identicalFailureSet=true`），全部是 Windows `rmSync` 的 `EPERM`，根因是 `rewards-data.test.ts:342` 与 `rewards-version-edit.test.ts:161` 清理前没有 `sqlite.close()`。未修复，也不声称修复。**

---

## 5. 复跑清单

```powershell
$node='C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm='C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'

# 1) 起服务 + 三档截图（一条命令，含起停）
& $node .evidence\local-stack.mjs run -- $node .evidence\browser-verify.mjs `
    --out docs\engineering\evidence\ll-mvp-010 `
    --page life=http://127.0.0.1:5173/local-life/#/life `
    --viewports 320x640,375x812,1440x900 --wait-text 惠生活 `
    --prefix scaffold-life --results scaffold-browser-results.json

# 2) E2E 骨架
cd apps\api; & $node --import tsx ..\..\.evidence\e2e-skeleton.mts; cd ..\..

# 3) EPERM 对照（基线 worktree）
cd E:\tomz\local-life-wt\baseline-eprem
& $node $pnpm --filter @sanchuang-dev/local-life-api test
```

---

## 6. 未验证项与盲区（明确写出）

1. **脚手架没跑过 `pnpm lint/typecheck`**：它在 `.evidence/`，不在任何 workspace 包内，不属于仓库代码；`--check` 语法检查通过（exit 0），但未做类型检查。
2. **只验证了 `/life` 与管理台登录页**：R2 的商品登记、「我的」订单、订单核验、网格员工作台**尚未存在/未验证**，本任务不做结论。
3. **未在 CI（Linux）复跑 EPERM 对照**：只在 Windows 本机对照；Linux 行为未验证。
4. **未截取 320 高度的真实滚动内容**：`captureBeyondViewport:false`，截图 = 首屏；长列表页需滚动后多次截图（t10/t5 补）。
5. **无 iOS Safari / 微信内置浏览器**：只有桌面 Chrome 的 `--headless=new` 与 CDP 视口模拟。
6. **数据库重启只覆盖 1 次**：E2E 骨架 close→reopen 一次；多进程并发与真实进程重启留给 t10。
7. **`recon.md` 里“8 例失败”的描述已由实测确认**，但失败**数量**会随机器/文件锁时序波动（本次两轮都是 8，未做 10 轮统计）。
