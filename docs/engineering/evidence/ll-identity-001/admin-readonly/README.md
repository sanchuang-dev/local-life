# LL-IDENTITY-001 (#171) 管理台常驻社区只读展示 — 真实浏览器证据

产物目录：`docs/engineering/evidence/ll-identity-001/admin-readonly/`。由 Agent B（居民 H5 / 管理台只读展示）
在隔离 worktree 中生成。B 的提交范围仅限 `apps/admin`，因此证据目录留在工作区、由 Lead 归档。

运行日期：2026-11-11（Asia/Shanghai）。

## 被验证的真实组件

| 层 | 真实来源 |
| --- | --- |
| 管理台 | `E:\tomz\local-life-wt\ll-identity-001\ui`，commit `09a9f17`，`pnpm --filter @sanchuang-dev/local-life-admin dev`，`http://127.0.0.1:5174` |
| API | `E:\tomz\local-life-wt\ll-identity-001\lead`（已集成 A/B/C 分支），`tsx apps/api/src/index.ts`，`127.0.0.1:4080`；管理台的 `/api` 经 Vite 代理同源转发 |
| DB | 真实 SQLite。schema 由 API 自己的 `createDatabase()` 跑完 21 条真实迁移链（含 `0020_ll_identity_001_binding.sql`）后，再插入 5 种归属形态与 1 个真实 scrypt 管理员账户 |
| 浏览器 | 系统 Chrome，`--headless=new` + DevTools Protocol（仅 Node 内置 `fetch`/`WebSocket`，无自动化依赖） |

## 数据库里的 5 种真实形态（本轮全部渲染到）

| 账号 | 事实 | 期望展示 | 实测 |
| --- | --- | --- | --- |
| 陈梧桐 | `resident_community_bindings` 一行本人确认 | 已确认常驻 + 绿色「常驻：梧桐里社区」 | 通过 |
| 林柳岸 | 仅 1 条 `resident_community_assignments` 历史关系 | 历史归属（未确认）+「历史归属：柳岸花城社区」，**不得出现「常驻：」** | 通过 |
| 周双记 | 2 条历史关系 | 历史归属（未确认）×2 + 历史待核查 | 通过 |
| 吴空白 | 无任何关系 | 未关联社区 | 通过 |
| 郑冲突 | 已确认 A，历史关系指向 B | 已确认常驻 + 常驻：梧桐里社区 + 历史归属：柳岸花城社区 + 常驻社区冲突 | 通过 |

## 结果

`browser-results.json` 记录 **29/29 checks passed**，其中关键的「不得出现」类断言：

- 列表页与抽屉内**不存在**任何含「改绑 / 解绑 / 重新绑定 / 重绑 / 切换常驻社区 / 转移常驻 / 设为常驻 / 代确认」
  的可交互控件（`__t.controls()` 遍历真实可见的 `button/a/input/select/textarea/[role=button]`，结果为空数组）。
- 行操作只有「详情」；抽屉内 `form` 与 `button[type=submit]` 数量为 0。
- 历史账号的行文本与抽屉文本里**没有**「常驻：」前缀，也没有把历史关系写成已确认。
- 待核查账号抽屉没有单选/复选/下拉，没有「帮他选」类代选入口。
- 整轮只有 1 个写请求：`POST /api/auth/login`（登录本身），没有任何指向 `/admin`、`/resident-community`、
  `/crm` 的写请求。
- 列表与详情均由真实 `GET /admin/users` 提供（6 个真实请求）。
- 1440 宽无横向溢出。

## 截图

| 文件 | 内容 |
| --- | --- |
| `01-admin-login-1440.png` | 管理台登录页（真实账号登录前） |
| `02-users-list-1440.png` | 用户管理页整页：页头只读说明 + 「常驻社区 / 历史归属」列 + 5 种形态 |
| `03-drawer-historical-1440.png` | 单条历史归属账号的详情抽屉：尚未确认常驻社区 / 历史归属（未确认） / 历史社区归属（只读，不代表已确认） |
| `04-drawer-pending-review-1440.png` | 两条历史归属账号：历史待核查，无可代选控件 |
| `05-drawer-confirmed-1440.png` | 已确认账号：常驻社区 + 本人确认时间 + 来源「本人在居民端确认」 |
| `06-drawer-conflict-1440.png` | 确认与历史不一致：已确认常驻社区 + 常驻社区冲突 |

## 明确未覆盖（不得据此声称已验证）

- 真实生产数据；本轮 5 种形态是**按真实表结构写入的真实行**，不是生产库快照。
- 社区维度运营（`grid_worker`/`operator`）视角下 `residentCommunityState: null` 与
  `communityRelationSource: 'out_of_scope'` 的浏览器形态。这两条分支由
  `apps/admin/src/shared/lib/resident-community-view.test.ts` 与 `UsersPage.test.tsx` 的单元测试覆盖，
  本轮浏览器只跑了 admin 这一种角色。
- `admin_compliance_correction` 产生的绑定（仓库内没有后台纠正入口，也不应该由 UI 触发）。
- 移动端/窄屏管理台布局、真机触控、iOS Safari；本轮只有桌面 Chrome 1440×900。
- 视觉判断：本轮断言全部基于 DOM 文本与控件存在性，没有人工看图（模型不能读取图片）。

## 复现

```pwsh
# 1) 集成后的 API（lead worktree），数据库先由 API 自己的迁移链建好
apps/api/node_modules/.bin/tsx.cmd .data/create-migrated-db.ts <abs-path>\admin-evidence.sqlite
node <ui-worktree>\.data\seed-admin-evidence.cjs <abs-path>\admin-evidence.sqlite '<admin-password>'
$env:DATABASE_PATH='<abs-path>\admin-evidence.sqlite'; $env:AUTH_DEV_ENABLED='true'
$env:TRUSTED_ORIGINS='http://127.0.0.1:5174,http://localhost:5174'; $env:PORT='4080'
apps/api/node_modules/.bin/tsx.cmd apps/api/src/index.ts

# 2) 管理台（ui worktree）
$env:LOCAL_LIFE_API_PORT='4080'; $env:LOCAL_LIFE_ADMIN_PORT='5174'
pnpm --filter @sanchuang-dev/local-life-admin dev --host 127.0.0.1

# 3) 证据脚本
$env:LL_ADMIN_PASSWORD='<admin-password>'
node ll-identity-001-admin-browser-verify.mjs <输出目录>
```

脚本按 `chrome --headless=new` 启动系统 Chrome，通过 CDP 驱动真实页面；不含任何 mock、
不拦截产品请求、不改写 API 响应。
