# 工程规约（AGENTS.md）的 dev → mvp 同步

> 记录时间：2026-11-12。对比基线：`dev@cf9b8e2`（本卡修改前）与 `mvp@68af211`。
> 本文只描述可核对的同步流程与当前差异；它不是晋级授权，也不代表 `mvp` 已部署或已验收。

## 1. 单一来源与边界

- **`dev` 是业务施工和工程规约的当前来源**。功能卡与文档修正都从最新 `dev` 开 `feat/*`，以 Draft PR 提交到 `dev`。
- **`main` 只是默认分支和工作流入口**，不是生产分支，也不是本仓库工程规约的编辑分支。
- **`mvp` 是经维护者验收后的在线验收发布源**。除紧急回滚外，不直接向 `mvp` 提交业务或文档修改；`dev → mvp` 必须通过独立的晋级 PR。
- **代码存在不等于线上可用**。`dev` 中已有实现和测试，只证明对应代码路径存在；实际是否部署、健康检查是否通过、真实微信/CRMEB/支付依赖是否可用，必须以 `mvp` 的发布 SHA、运行证据和验收记录为准。

## 2. 当前可核对的差异

在 2026-11-12 的基线上，`AGENTS.md` 只有两处差异；其余章节一致：

| 位置 | `dev` | `mvp` | 处理 |
| --- | --- | --- | --- |
| §1 阶段与定位 | 按当前 `dev` 代码列出活动、三人团、CRM、奖励履约、CRMEB adapter、流水/对账/结算、商品订单、消费返券与抽奖，并明确代码存在不等于线上可用 | 仍把奖励履约、商城、分账写成“后续业务卡处理”，没有体现已合入的模块 | 本次只在 `dev` 修正；随下一次已授权的 `dev → mvp` 晋级 PR 同步 |
| §6 分支、验证与牛马 | 按改动范围与风险分层验证；金额、认证、迁移、并发、持久化等使用真实边界 | 仍要求提交前至少 `pnpm install --frozen-lockfile` 与 `pnpm check`，并统一要求 UI/路由真实浏览器 375/320 验收 | 同上；`mvp` 同步前不得把旧口径当成现行施工要求 |

`dev` 与 `mvp` 的业务代码差异不在这份文档的同步范围内。需要晋级哪些能力，仍由维护者按各自 Issue 验收和发布风险单独决定。

## 3. 差异核对命令

在任意干净的仓库副本中执行：

```bash
git fetch origin dev mvp
git diff --stat origin/dev origin/mvp -- AGENTS.md
git diff origin/dev origin/mvp -- AGENTS.md
```

只查看 `mvp` 是否仍是旧验证口径：

```bash
git show origin/mvp:AGENTS.md | grep -nE '按改动范围和风险验证|提交前至少运行'
```

预期在未同步时能命中“提交前至少运行”，且看不到“按改动范围和风险验证”。同步完成后，这两项检查应以 `mvp` 的实际内容为准重新核对，不能仅凭本文件的记录推断。

## 4. 晋级时的同步流程

1. 文档修正和业务卡一样，先从最新 `dev` 开 `feat/*`，提交 Draft PR 到 `dev`，由维护者审查。
2. 维护者创建并审查独立的 `dev → mvp` 晋级 PR；施工 Agent 不直接 push `mvp`，不自行晋级或部署。
3. 晋级 PR 中核对工程规约是否随 `dev` 一起进入发布源：

   ```bash
   git diff --stat origin/mvp HEAD -- AGENTS.md
   git diff origin/mvp HEAD -- AGENTS.md
   ```

   只应出现已审查的规约变化；如出现无关的文档回退或旧口径回写，应停止晋级并说明原因。
4. 晋级合并后再次核对：

   ```bash
   git diff --quiet origin/mvp origin/dev -- AGENTS.md && echo 'AGENTS.md synced'
   ```

   如果 `dev` 在晋级后又产生新提交，`AGENTS.md` 可能再次领先 `mvp`；此时记录差异并等待下一次授权晋级，不要直接在 `mvp` 补写。
5. 在 PR 或交接说明中贴出上述命令及真实输出。文档同步不等于功能验收，也不等于部署成功。

## 5. 本次改动范围

本卡只修改 `dev` 上的工程规约和直接相关的工程文档：

- `AGENTS.md`：阶段能力描述、管理台目录说明、未完成/未验收模块的真实状态表述；
- `docs/engineering/monorepo.md`：当前业务边界和验证入口；
- `docs/engineering/agents-sync.md`：本文记录的 `dev → mvp` 同步流程与差异。

未修改 `apps/**`、`packages/**`、工作流、锁文件或环境配置。
