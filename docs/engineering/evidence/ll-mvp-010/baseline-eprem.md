# LL-MVP-010 · EPERM 对照基线（改动前）

> 执行者：`verifier`（独立验证，未修改任何业务代码）
> 时间：2026-11-06（Asia/Shanghai）
> 目的：给 R1/R2 一个**改动前**的失败基线，避免把 Windows 既有的 `rmSync` EPERM 当成新引入的回归，也避免声称「已修复」。
> 结论先行：**基线 8 例失败，特性分支同样 8 例失败，失败用例名集合完全一致（`identicalFailureSet=true`）；两者均与本地商品目录/本地订单无关，且未修复。**

---

## 1. 环境与命令

| 项 | 值 |
| --- | --- |
| Node | `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` → `v24.21.0` |
| pnpm | 同目录 `pnpm\bin\pnpm.mjs` → `10.19.0`（PATH 上的 `pnpm.exe` 不可用） |
| 操作系统 | Windows（临时目录 `C:\Users\ADMINI~1\AppData\Local\Temp`） |
| 基线 worktree | `E:\tomz\local-life-wt\baseline-eprem`，`git worktree add ... origin/dev`，HEAD `ae8441a`（= `origin/dev`），`git status --short` 为空 |
| 特性 worktree | `E:\tomz\local-life-wt\mvp-010`，分支 `feat/ll-mvp-010-local-catalog-orders`，HEAD `007f433`（R1 提交） |

命令（两侧逐字相同，只在各自 worktree 里执行）：

```powershell
$node='C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm='C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'

# 基线 worktree（干净，origin/dev@ae8441a）
& $node $pnpm install --frozen-lockfile            # exit 0, 223 packages, 7.4s
& $node $pnpm --filter @sanchuang-dev/local-life-contracts build   # exit 0
& $node $pnpm --filter @sanchuang-dev/local-life-api test          # exit 1

# 特性 worktree（feat/ll-mvp-010-local-catalog-orders@007f433）
& $node $pnpm --filter @sanchuang-dev/local-life-api test          # exit 1
```

完整日志（未提交，可重跑生成）：

- `E:\tomz\local-life-wt\mvp-010\.evidence\baseline-eprem-api-test.log`（UTF-16LE，`Tee-Object` 产物）
- `E:\tomz\local-life-wt\mvp-010\.evidence\branch-api-test.log`

---

## 2. 汇总

| 运行 | `tests` | `pass` | `fail` | 结果 |
| --- | --- | --- | --- | --- |
| 干净基线 `origin/dev@ae8441a` | 223 | 215 | **8** | exit 1 |
| 特性分支 `007f433`（R1） | 240 | 232 | **8** | exit 1 |

新增的 17 个用例（240−223）全部通过，失败集合没有变化。

---

## 3. 失败用例清单（两侧完全一致）

| # | 用例 | 测试文件:行（基线） | 错误类型 | 触发点 |
| --- | --- | --- | --- | --- |
| 1 | a frozen reward plan survives the publish snapshot and a plan-less activity stays byte-identical | `test/rewards-data.test.ts:10:208` | `EPERM` | `rmSync(tempDir)` @ `rewards-data.test.ts:342` |
| 2 | a rule edit does not hand the same team a second prize | `test/rewards-version-edit.test.ts:5:339` | `EPERM` | `world.cleanup()` @ `rewards-version-edit.test.ts:161` → 调用点 `:317` |
| 3 | a revoked unredeemed grant frees the team to claim again | `test/rewards-version-edit.test.ts:5:2513` | `EPERM` | 同上 `:161` |
| 4 | a redeemed grant still blocks a second prize, even after an edit | `test/rewards-version-edit.test.ts:5:3750` | `EPERM` | 同上 `:161` |
| 5 | the stock and budget caps are not multiplied by rule versions | `test/rewards-version-edit.test.ts:5:5071` | `EPERM` | 同上 `:161` |
| 6 | the database itself refuses a second live grant for the same team | `test/rewards-version-edit.test.ts:5:6488` | `EPERM` | 同上 `:161` |
| 7 | the database itself refuses a second stock ledger for the same prize | `test/rewards-version-edit.test.ts:8:941` | `EPERM` | 同上 `:161` |
| 8 | revoking a check-in still finds the grant across rule versions | `test/rewards-version-edit.test.ts:12:517` | `EPERM` | 同上 `:161` |

错误原文（两例取样，其余同形）：

```
Error: EPERM, Permission denied: 'C:\Users\ADMINI~1\AppData\Local\Temp\ll-0006-plan-2uipJM'
    at rmSync (node:fs:1282:18)
    at TestContext.<anonymous> (...\apps\api\test\rewards-data.test.ts:342:5)
  code: 'EPERM', syscall: 'rm'

Error: EPERM, Permission denied: 'C:\Users\ADMINI~1\AppData\Local\Temp\ll-version-edit-nvU6YB'
    at rmSync (node:fs:1282:18)
    at Object.cleanup (...\apps\api\test\rewards-version-edit.test.ts:161:20)
  code: 'EPERM', syscall: 'rm'
```

自动比对结果（`.evidence/summarize-failures.mjs`）：`identicalFailureSet= true`，`onlyInFirst= []`，`onlyInSecond= []`。

---

## 4. 根因（读代码确认，不是猜测）

两处清理都**没有先关闭 SQLite 连接**就在 Windows 上递归删除目录：

- `apps/api/test/rewards-version-edit.test.ts:161`
  `cleanup: () => rmSync(tempDir, { recursive: true, force: true })`
  该 `world.sqlite` 由 `createWorld()` 在 `:103` `createDatabase(...)` 打开，`World` 只暴露 `sqlite`，`cleanup()` 从不 `close()`。
- `apps/api/test/rewards-data.test.ts:161` 同上；`:342` 的一个用例直接把 `rmSync(tempDir)` 写在 `finally` 里，而 `createFixture()` 打开的 `rewards.sqlite`（`:70`）从未关闭。

`createDatabase()`（`apps/api/src/db/client.ts:22-25`）设置 `journal_mode = WAL`，WAL/SHM 句柄在 Windows 上未关闭时目录会保持锁定，于是 `rmSync` 抛 `EPERM`。同一文件里其它用例（`rewards-data.test.ts:445/503/550/582/641/699/740...`）都是**先 `sqlite.close()` 再清理**，因此不报错 —— 这反证了根因是「清理前没关库」，而不是测试框架或迁移本身。

---

## 5. 对 t5 的约束（新脚手架主动避坑）

1. **任何临时文件库，`rmSync` 前必须先 `sqlite.close()`**；本任务的 E2E 骨架照此实现，并在最后一步单独断言 `temp directory removed without EPERM`（实测通过，见 `verification-prep.md §4`）。
2. 关闭顺序：`first.sqlite.close()` → 重开 `second` → 断言 → `second.sqlite.close()` → `rmSync`。
3. 清理用 `try/catch` 包裹，避免清理失败掩盖真正的断言失败；但**不要**用 `force:true` 掩盖到「看不出 EPERM」——保留一条显式 check。
4. `pnpm --filter @sanchuang-dev/local-life-api test` 的退出码在 t5 里应区分：
   `fail 8 && 失败名集合 == 本文件 §3` → 视为基线噪声；
   任何**额外的**失败名 → 视为本次改动引入的回归。

---

## 6. 未验证项 / 盲区

- 本基线只覆盖 `apps/api` 的 node:test 套件；未在 CI（Linux）复现，故「CI 上是否也 8 例失败」**未验证**。仓库既有证据（`docs/engineering/evidence/ll-h5-003/README.md`）把该现象描述为 Windows-only，本次未独立复核 Linux 行为。
- `pnpm test`（root，含 `scripts/local-dev.test.mjs`）与 `pnpm check` 未作为结论使用；本文件只对 `apps/api` 的失败集合负责。
- 未修改任何测试以「修复」EPERM；这不在 t9 的 inScope 内，且禁止以改测试掩盖基线。
