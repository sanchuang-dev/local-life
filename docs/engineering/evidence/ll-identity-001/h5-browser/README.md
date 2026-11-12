# LL-IDENTITY-001 (#171) 居民 H5 真实浏览器证据

产物目录：`docs/engineering/evidence/ll-identity-001/h5-browser/`。由 Agent B 在隔离 worktree 中生成，
由 Lead 随本卡归档（B 的提交范围仅限 `apps/web`，因此证据目录由 Lead 提交）。

运行日期：2026-11-11（Asia/Shanghai）。

## 被验证的真实组件

| 层 | 真实来源 |
| --- | --- |
| H5 | `E:\tomz\local-life-wt\ll-identity-001\ui`，commit `c927fb1`，Vite dev server `http://localhost:5173/local-life/`（真实 base + HashRouter） |
| API | `E:\tomz\local-life-wt\ll-identity-001\lead`（已集成 A/B/C 分支 + `origin/dev`），`tsx apps/api/src/index.ts`，`127.0.0.1:4080` |
| DB | 真实 SQLite `.data/ll-identity-001-browser.sqlite`，含 `0020_ll_identity_001_binding.sql` 迁移与两条社区记录 |
| 浏览器 | 系统 Chrome 157.0.8103.39，`--headless=new` + DevTools Protocol（仅 Node 内置 `fetch`/`WebSocket`，无自动化依赖） |

## 本轮确实跑通的路径

1. 未登录访问 `/me/community/confirm?communityId=…` → 被既有 `ResidentSiteGate` 送去统一登录，
   `next` 完整保留该确认目标与 `communityId`。
2. 真实开发登录（`POST /api/auth/dev/login`，双提交 CSRF + 会话 Cookie）后回到同一确认页、同一社区。
3. 确认页展示社区名称、服务点地址、「绑定后不可修改」，无任何切换/解绑/重绑控件；
   第一步「我已了解，继续确认」不可提交，第二步勾选前提交按钮 disabled，勾选后可用。
4. 从社区发现页「切换浏览社区 → 选梧桐里社区 → 确认浏览这个社区」进入，走「绑定为常驻社区」→
   两步确认 → `POST /api/resident-community/confirm` 成功（**整轮只发出 1 次 confirm 请求**）。
5. 「我的」与 `/me/community` 只读展示已确认社区与确认日期，无切换/解绑/重绑控件。
6. 切换到「柳岸花城社区」只是浏览：常驻社区仍是梧桐里社区，页面文案说明浏览不改变常驻社区；
   再回 `/me/community` 仍是梧桐里社区。
7. 已确认后再访问其他社区的确认页：不提供「确认绑定为常驻社区」，只说明原常驻社区不变。
8. 无 `communityId` 的确认页：不猜测、不默认任何社区，提示「没有可确认的社区」。
9. 320px 宽：社区发现页、「我的」、「我的常驻社区」、确认拒绝页均无横向溢出。

结果：`browser-results.json` 记录 **40/40 checks passed**（含 4 个 320px 布局断言）。

## 明确未覆盖（不得据此声称已验证）

- 微信授权登录（仓库无 AppID/AppSecret，未向 `open.weixin.qq.com` 发任何请求）、短信验证码登录。
- `pending_review`（≥2 条历史归属）与 `conflict` 的**真实数据**浏览器形态；这两种状态由
  API/单元测试覆盖，本浏览器轮次只覆盖了「已确认后再确认其他社区」的服务端拒绝路径。
- 后台合规纠正（`admin_compliance_correction`）产生的绑定。
- 匿名（未登录）浏览：既有 `ResidentSiteGate` 对全部居民路由要求会话，本轮未改动该门禁；
  因此「浏览自由」在 H5 的证据是「浏览不会创建或迁移常驻社区」，不是「未登录可浏览」。
- iOS Safari / 真实微信内置浏览器 / 真机触控；本轮只有桌面 Chrome 的移动视口模拟。

## 复现

```pwsh
# 1) 已集成的 API（lead worktree）
$env:DATABASE_PATH='…\.data\ll-identity-001-browser.sqlite'; $env:AUTH_DEV_ENABLED='true'
$env:TRUSTED_ORIGINS='http://127.0.0.1:5173,http://localhost:5173'; $env:PORT='4080'
apps/api/node_modules/.bin/tsx.cmd apps/api/src/index.ts

# 2) H5（ui worktree）
pnpm --filter @sanchuang-dev/local-life-web dev

# 3) 证据脚本
node ll-identity-001-browser-verify.mjs <输出目录>
```

脚本按 `chrome --headless=new` 启动系统 Chrome，通过 CDP 驱动真实页面；不含任何 mock、
不拦截产品请求、不改写 API 响应。
