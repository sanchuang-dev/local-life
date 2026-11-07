# LL-H5-002 手机验证码身份基础 — 浏览器证据（#93）

验证对象：居民 H5 手机号验证码登录 / 绑定入口（`apps/web` 的 `PhoneVerificationForm` 与 `MePage`）以及 `apps/api` 的 `/auth/phone/*` 真实 HTTP 行为。分支 `feat/ll-h5-002-phone-otp-identity`，基线 `dev@c13f96c`，证据对应代码 HEAD `300eee2`（父 `38134e4`：实现 + 修复轮；本目录由后续 `docs(evidence)` 提交加入，未改代码）。`git diff --stat c13f96c..300eee2` = 13 文件 +7626/−36：`packages/contracts/src/index.ts`（PHONE_AUTH_ROUTES、手机号 schema、OTP 申请/核验/绑定/状态 schema、9 个 phone/otp 错误码，全部追加）、`apps/api/src/db/schema.ts` 与迁移 `0008_motionless_chat.sql`（3 张表）、`apps/api/src/auth/phone.ts`、`apps/api/src/auth/phone-routes.ts`、`apps/api/src/app.ts`（仅挂载）、`apps/api/test/auth-phone.test.ts`、`apps/web/src/{hooks/useResidentAuth.ts,components/auth/PhoneVerificationForm.tsx,pages/MePage.tsx}`、`apps/api/test/rewards-data.test.ts`（1 行：迁移数改为按 `_journal.json` 推导）。无 `apps/admin/` 改动。

## 运行方式（本次证据的实际环境）

- 真实 API（`apps/api`）+ 真实 SQLite（迁移 0007→0008），OTP 发送走**注入的测试 sender**（无真实短信供应商），验证码只存 `sha256(id:code)`。
- 浏览器：系统 Chrome（headless=new）+ CDP；375 与 320 两种宽度；覆盖「已配置 sender」与「未配置 sender」两种部署形态。
- 断言写入 `browser-report.json`（`entries` + `results`，4 项场景全 `passed`）。

## 覆盖清单

| # | 场景 | 断言 | 证据 |
| --- | --- | --- | --- |
| 1 | 已配置 sender，375 宽度：申请验证码 | 提示「验证码已发送至 138****8000」（脱敏展示，不回显验证码）；输入错误码后显示「验证码不正确，还可尝试 4 次」；正确码后登录成功 | `01-phone-login-before-375.png`、`02-phone-login-after-375.png`、`03-phone-login-wrong-code-375.png` |
| 2 | 320 宽度重复同一流程 | 无横向溢出，文案与错误态一致（见 `browser-report.json` 第 2 项） | 见 `browser-report.json` |
| 3 | 未配置短信供应商 | 手机号入口显式呈现「短信服务未配置…不可用」，不渲染表单，不伪造成功 | `04-phone-unavailable-before-375.png` |
| 4 | 4 项浏览器场景汇总 | `results` 4/4 `passed` | `browser-report.json` |

## 命令与结果（修复轮后 HEAD）

```
pnpm install --frozen-lockfile              # exit 0
pnpm lint                                   # exit 0，0 errors
pnpm typecheck                              # exit 0
pnpm build                                  # exit 0
pnpm --dir apps/api exec node --import tsx --test test/auth-phone.test.ts  # 20/20
pnpm --dir apps/api exec node --import tsx --test test/auth.test.ts        # 3/3
```

全量 `pnpm check`：API 套件 209 tests / 201 pass / 8 fail，失败集合与基线 `c13f96c`（189/181/8）逐条同名，全部是 Windows 临时目录 `EPERM`，无新增失败。修复轮专项证据（限流与交付失败计数）：`X-Forwarded-For` 追加语义下 25 次请求 → 20×202 后 5×429 `otp_request_limit`；overwrite 语义 20×202 后 429；投递失败 503 `sms_delivery_failed` 时计数表 0 行、可立即重试。详见 `E:\tomz\h5-evidence\h5-002\REPORT-qa-093-r2.md`（未入库）。

## 未验证项与外部依赖

- **真实短信供应商/真实号码送达未验证**：无 SDK、无密钥、无生产配置；公网手机号登录保持禁用（未配置即显式不可用）。
- **部署前提（必须写入运维）**：反向代理必须**追加或覆盖** `X-Forwarded-For`，API 不得直接暴露公网；否则 IP 维度限流可被伪造首值绕过（修复轮已按「取最右 hop」实现，但真实反代未验证）。
- 无 iOS/Android 真机、无微信内置浏览器、无线上部署；Linux CI 与多实例并发未验证。
- 已知取舍：投递成功后推进计数，在途并发请求可理论上有界超额；已消费验证码仍计入同号 60s 冷却。

## 复跑方式

1. 起真实 API（需 `apps/api/.env.local` 或等价 env，含 `AUTH_DEV_ENABLED`），跑迁移到 0008。
2. 以注入 sender 的测试路径或本地 fake sender 触发发码（真实供应商不可用）。
3. `chrome --headless=new --remote-debugging-port=<port>`，CDP 打开 `http://127.0.0.1:<web>/me`，按上表执行；断言与 `browser-report.json` 对齐。
