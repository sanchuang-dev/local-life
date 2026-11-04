# LL-MVP-006 交付说明素材（PR 用）

Issues: [#62](https://github.com/sanchuang-dev/local-life/issues/62)
基线: `dev@7095b845c3a47a6d08d2ad663b10bcffe51e1194`

本文件是给 PR 描述用的素材，不是面向运营的文档（运营口径见 `operator-guide.md`）。
其中 **§2 与 §3 是 R1 要求必须在 PR 说明里披露的两项**，不能省略。

---

## 1. 一句话概括

落地真实签到校验、团队奖励资格、奖品库存/预算占用、一次性核销凭据与追加式审计；
数据层用 SQLite 触发器把不变量钉在库里，而不是只靠应用层自觉。

---

## 2. 【必须披露】部署顺序约束：`0007` 须先于 t17 代码生效

**现象**：若先滚动发布 t17 代码、而数据库仍停在 `0006`，则「驳回争议」会返回
**500 `internal_error`**——带标准错误体（`{ error: { code, message, requestId } }`），
**不是** B1 那种空 body 500；且 grant **不会被脏写**（事务回滚，状态保持在 `disputed`）。

**原因**：t17 在服务层把 `dismissed` 的授予更新为 `redeemed`，而 `0006` 触发器的
`activity_reward_grants_status_transition` 没有 `disputed → redeemed` 这条边，
更新被 `RAISE(ABORT)` 拦下，`mapRewardConstraint` 无法识别该消息，于是冒泡为 500。

**为什么正常部署窗口期为零**：`createDatabase()` 内部**先执行迁移、再返回 `db` 句柄**。
服务进程在拿到可用的数据库对象之前就已经把 `0007` 应用完毕，因此不存在
「新代码 + 旧 schema」的可用状态。这是启动顺序保证，不是运维祈祷。

**结论 / PR 必须写明**：

> **迁移 `0007_dispute_dismissed_restores_grant` 须先于 t17 代码生效。**
> 正常单进程部署下由 `createDatabase()` 的「先迁移后返回」保证；
> 仅当采用「新旧实例并行 + 共享库」的滚动发布时才需人工先迁移。

---

## 3. 【必须披露】产品限制：驳回争议即终态

驳回（`dismissed`）后，该授予回到 `redeemed`，但**四条补救路径全部不可用**：

| 操作 | 结果 |
| --- | --- |
| 重新发起争议 | **409** `dispute_already_resolved` |
| 反转（`reversed`） | **409** `dispute_not_open` |
| 再次驳回（`dismissed`） | **400** `dispute_not_open` |
| 撤销授予（`revoke`） | **409** `reward_already_redeemed` |

根因：数据表触发器 `activity_reward_disputes_open_first` 规定**一条授予只允许一个
`opened`**，因此争议线程**一次性、不可重开**。这是数据层不变量，不是遗漏。

**额外的体验问题**：「撤销授予」被拒绝时的提示语把用户指向"走争议流程"，
而该流程此时**已经关闭**——提示语指向一条走不通的路。

**R1 裁定**：属**需披露的产品限制，不要求在本卡返工**。
**建议后续卡**评估是否允许「驳回后重开争议」（需要放宽上述触发器，属数据模型变更，
不应塞进收尾卡）。

> 运营侧的实际做法：驳回后若仍需处理，走线下补发并记在活动备注，不要再尝试系统内操作。
> 见 `operator-guide.md` §8.3。

---

## 4. t19 收尾清理（死代码）

| 删除项 | 位置 | 依据 |
| --- | --- | --- |
| `redeemCredentialCode` | `apps/admin/src/services/rewards.ts` | 0 消费者；doc comment 声称"与现场工作人员同一套核销"**不实**；且比 `apps/web` 在用的版本**更弱**——缺 `rewardRedeemRequestSchema.parse` 响应校验 |
| `checkinCountsForReward` | `packages/contracts/src/rewards.ts` | 0 消费者（仅 `src` 定义 + `dist` 声明） |

随 `redeemCredentialCode` 一并清除了仅它使用的 `rewardRedeemResponseSchema` 与
`RewardRedeemResponse` 导入（admin 的 `noUnusedLocals: true` 会强制这一步）。

**明确未动**：`checkin_not_verified`。它曾被误判为"零消费导出"，实测有**两个真实消费者**：

- `apps/web/src/components/activity/rewardLabels.ts:70` —— 前端文案映射
- `apps/api/src/rewards/service.ts:1301` —— **409 的 `reason`**（不是顶层 `error.code`）

它的设计用途正是作为 `reason`，误删会造成前端文案缺失。

> **教训（写给未来的维护者）**：`grep` 的结论必须连同**搜索范围**一起给出。
> 只按 `error.code` 的用法搜索，就会漏掉 `reason` 的用法，从而把一个有消费者的常量判成死代码。

测试数保持 **189**（删除的是零消费代码，覆盖度不变）。

---

## 5. 验证

```
pnpm check   → EXIT=0
  oxlint            17 warnings / 0 errors
  typecheck         contracts / api / admin / web 全过
  API tests         189 / 189 pass, 0 fail
  contracts tests   7 / 7 pass
  admin tests       91 / 91 pass
  build             全量通过
```

迁移在**全新库**与**已应用 0006 的旧库**两条路径上都实测，两处 `PRAGMA integrity_check` = `ok`。
