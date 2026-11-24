# 活动视觉配置（LL-ACT-VIS-001 / #309）

> 本文是 Issue #309 活动视觉配置的**唯一语义契约真相源**：字段与空值语义、四主题枚举与 H5 语义 token、图片 URL 安全约束、长度限制、H5 回退优先级、后台编辑权限、发布后仅改视觉与 `ruleVersion`/奖励/预算冻结边界。
>
> 字段与校验的可执行定义只存在于共享 zod 契约（本文不复制第二份 schema）；测试锁定行为。实现与本文件不一致时，应在同一 PR 内修正本文件，而不是另建一份字段说明。

关联实现：共享契约 [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)、持久化 [apps/api/src/db/schema.ts](../../apps/api/src/db/schema.ts) 与 [0042 迁移](../../apps/api/db/migrations/0042_activity_visual_config.sql)、后台 [ActivitiesPage.tsx](../../apps/admin/src/pages/ActivitiesPage.tsx)、H5 [activityVisual.ts](../../apps/web/src/components/activity/activityVisual.ts) 与 [SilverNeighborhoodCampaignPage.tsx](../../apps/web/src/pages/SilverNeighborhoodCampaignPage.tsx)。

## 1. 字段与存储

`visualConfig` 是活动上的**展示层**配置，共五个字段；与参与、团队、签到、奖励、预算、支付等业务规则无关。

| 字段 | 类型/枚举 | 约束 | `null` 语义 |
| --- | --- | --- | --- |
| `themeKey` | `community-green` / `festival-red` / `health-blue` / `warm-gold` | 写路径只接受四枚举；默认 `community-green` | 不允许单字段 `null`；用 `visualConfig: null` 复位 |
| `heroImageUrl` | `string \| null` | 仅绝对 `http(s)` URL，trim 后 ≤ 2048 字符 | 未配置，H5 使用兼容默认图 |
| `promoTitle` | `string \| null` | trim 后 ≤ 40 字符 | 未配置 |
| `promoSubtitle` | `string \| null` | trim 后 ≤ 80 字符 | 未配置 |
| `posterImageUrl` | `string \| null` | 仅绝对 `http(s)` URL，trim 后 ≤ 2048 字符 | 未配置，分享海报回退头图 |

- 持久化在 `activities` 表的 `theme_key`（`NOT NULL DEFAULT 'community-green'`）与四个可空列；**不进入** `activity_rule_versions.snapshot_json`，因此不属于发布时冻结的业务规则快照。
- 公开 summary/detail 与 admin detail 都返回同一五字段 `visualConfig`；公开响应由 zod 剥掉未知/内部字段。admin 列表 summary 不返回该对象，编辑器读取 detail。
- 创建时可省略；旧客户端不传 `visualConfig` 不会清空任何视觉字段（更新语义见 §3）。

## 2. 主题枚举与 H5 语义 token

四个主题是评审过的封闭色板，新增主题必须同时更新共享枚举、H5 token、后台预览与测试：

| key | 中文名 | 典型用途 |
| --- | --- | --- |
| `community-green` | 社区绿 | 默认；日常与邻里活动，精确复刻 #309 前的页面观感 |
| `festival-red` | 节庆红 | 节日、庆典与热闹场次 |
| `health-blue` | 健康蓝 | 义诊、健康筛查与公益服务 |
| `warm-gold` | 暖阳金 | 敬老、助老与温暖关怀 |

H5 将 key 映射为 16 个有限语义 CSS variables（`--activity-primary`、`-background`、`-surface`、`-border`、`-text`、`-button`、`-on-primary`、`-countdown` 等），以 inline style 只作用于活动详情页根节点 `.activity-page`；[activityTheme.css](../../apps/web/src/components/activity/activityTheme.css) 的选择器不命中 `:root`/`body`/`html`，不影响全站。业务状态色（进行中/暂停/结束、错误/警告、奖励档位）保持不变，不随主题染色。

`community-green` 的 token 与 #309 前一致；未知或缺失 key 在 H5 侧防御性回退到社区绿（写路径本身拒绝非法枚举）。暖阳金按钮和后台预览主色统一使用 `#8f6514`。

后台编辑器在既有活动表单内新增第四个「界面风格」Tab：四主题色板、头图/海报 URL 输入与预览/替换/清空、宣传标题/副标题，以及读取当前表单值的手机比例实时预览；仅选择主题也可以保存。

## 3. 空值 / 清除语义

创建时：省略 `visualConfig`、显式传 `null` 或空对象 `{}` 都表示“未配置视觉”，落库为默认绿主题 + 四个 `null`。

更新时三态必须严格区分：

| 请求 | 结果 |
| --- | --- |
| 省略 `visualConfig` | 视觉配置完全不变（普通标题/规则编辑不会误清素材） |
| `visualConfig: null` | 清空四个素材/文案，并把主题复位为 `community-green` |
| `visualConfig: { ... }` | 只补丁传入的字段；未传字段保持原值 |

对象内单字段传 `null` 或空白字符串（trim 后为空）表示清除该字段；`themeKey` 不能单独传 `null`。空白字符串转 `null` 由共享输入的预处理统一完成，后台表单也把空输入映射为 `null`。更新请求中，`visualConfig: {}`、只带 `expectedUpdatedAt`、含非法主题/URL/超长文案的请求返回 `400 invalid_request`；未知字段被 zod 剥离，不会落库或泄漏。

后台编辑器只有在视觉值实际变化时才把 `visualConfig` 放进 PATCH；仅视觉变化时请求体为 `{ expectedUpdatedAt, visualConfig }`，**不带** `keyRules`，也不触发“生成新规则版本”确认。发布/暂停中的活动可仅保存视觉；保存成功后重新 GET 服务端详情，Tab 切换不丢值。

## 4. H5 回退优先级

所有远程图片在使用前由 H5 重新校验：trim 后必须是绝对 `http(s)` URL 且 ≤ 2048 字符；不合法的存储值按“未配置”处理，绝不写入 `<img src>` 或微信 `imgUrl`。

- **头图**：配置的 `heroImageUrl` → 通用 `images/community-activity-artwork.webp`（仅原名「银发社区欢乐季」兼容原头图）；加载失败自动尝试下一候选，全部失败显示带主题色的占位块，不出现破图。
- **分享海报**：`posterImageUrl` → `heroImageUrl` → 内置兼容图（去重后按序尝试），加载失败同样逐级回退。
- **宣传带**：只要配置了宣传标题/副标题、头图、海报或非默认主题，就显示宣传带；标题为 `promoTitle ?? activity.title`，副标题只取 `promoSubtitle`，不覆盖活动真实地点、时间、规则信息。仅原名「银发社区欢乐季」且默认绿、完全没有视觉配置时不渲染宣传带；其他活动始终展示真实标题，保留 #309 前布局，避免与图内标题重复。
- **海报文案**：标题为 `promoTitle ?? activity.title`；副标题为 `promoSubtitle ?? 社区名 + 当前席位`。活动详情分享不再复用旧银发口号。
- **微信 JS-SDK**：好友/朋友圈标题 = `promoTitle ?? activity.title`；描述 = `promoSubtitle ?? activity.summary ??` 通用邀请语；封面 = 海报 → 头图 → 绝对化后的内置兼容图。
- **活动列表**：只复用 `heroImageUrl`；未配置或加载失败回退到共享 `ActivityArtwork` 插画，没有真实头图时不伪造。
- **分享链接与二维码**：QR/系统分享/复制链接共用 `buildActivityShareUrl(activityId, invite)`；邀请码只来自当前登录居民所在、仍开放且有剩余席位的三人团，无邀请身份时不伪造邀请参数。二维码固定渲染在海报图/文案下方的独立白色区域，不覆盖海报主体，也不把运营海报图当二维码；截图保存未实现。

分享抽屉只在活动已发布且未结束、当前居民属于开放且有邀请码的团队时出现；不满足条件时页面明确提示邀请入口关闭。

## 5. 权限、并发与发布后冻结边界

- `admin` 可编辑全部社区；`operator` 只能编辑 `staff_community_assignments` 授权的社区；`grid_worker` 对活动管理接口返回 403；未登录返回 401。写请求继续要求 CSRF double-submit 与可信 Origin，并沿用 `expectedUpdatedAt` 乐观并发（冲突 409）。
- 视觉字段是展示层补丁：发布/暂停后仅更新视觉**允许**，并且必须满足
  - 不新增 `activity_rule_versions`；
  - 不修改 `status`、`ruleVersion`、`currentRuleVersionId`、`publishedAt`、起止时间、场地、预算、奖品名额、`publicRules`、`rewardPlan`、`purchaseRewardPlan`；
  - 不改变奖励/预算冻结数据，也不走“新规则版本”确认。
- 已结束活动仍按既有生命周期规则拒绝修改（包括视觉）。视觉更新与普通编辑共用 `activity.updated` 审计路径。
- 发布后奖励计划、消费奖励计划仍按既有冻结规则返回 409；本卡没有放宽任何业务规则。

## 6. 迁移 0042 与 QA 0041 的序号关系

[0042_activity_visual_config.sql](../../apps/api/db/migrations/0042_activity_visual_config.sql) 只做五次 `ALTER TABLE activities ADD COLUMN`，**没有任何 UPDATE**：`theme_key` 以默认值让历史行获得社区绿，四个素材/文案列保持 `NULL`，因此历史银发活动保留原素材与原布局，其他活动也不会被写入伪造宣传标题。

本分支的 journal 最后一条是 `idx: 41`、`tag: "0042_activity_visual_config"`（见 [meta/_journal.json](../../apps/api/db/migrations/meta/_journal.json)）。这是有意为之：

- `0041` 已被 QA 分支的居民联系电话迁移占用；本分支**没有**创建、改名或修改 `0041` 文件，文件序号暂时留空不影响 drizzle 按 journal 顺序读取。
- 合并集成时应先落入 `0041_resident_contact_phone.sql`，再将 0042 的 journal 条目改为 `idx: 42` 且保持 `when` 晚于 0041；顺序应为 0041 → 0042。
- drizzle migrator 以 `__drizzle_migrations.created_at` 与 journal `when` 比较决定是否应用；若某环境已经记录 0042 的时间戳，后补一个更早 `when` 的 0041 不会自动补跑，需要显式处理。因此本分支不应在 0041 未合并前单独晋级/部署。

## 7. 已知偏差与验证缺口

以下内容如实记录，不视为已验收通过：

1. **未挂路由的旧分享组件**：`ActivityHomePage` / `components/home/ActivityShareSheet.tsx` 当前未被 `App.tsx` 引用，仍保留旧海报口号且未接入 `visualConfig`；本轮明确在范围外，活动详情分享抽屉已使用新实现。
2. 后台暖阳金预览已与 H5 主色统一。
3. **无真实浏览器验收**：375×812 与 320 宽度只做了静态宽度审计（未发现 >320 固定宽），没有 Playwright/Puppeteer 截图或真机走查；视觉验收留给维护者。
4. 仅原名「银发社区欢乐季」未配置视觉时保留旧图与布局；其他活动使用通用插画并展示真实标题。
5. **不包含**：图片上传/素材库、图片生成、海报编辑器、任意二维码坐标、多套海报、截图下载，以及真实微信/线上环境验证。测试是 Node/纯函数/jsdom 静态与组件级验证，不等于线上可用。

## 8. 契约测试与验证入口

- 共享契约：[packages/contracts/test/activity-visual-config.test.mjs](../../packages/contracts/test/activity-visual-config.test.mjs)（四枚举、URL scheme/长度、文案上限、空串→null、空对象拒绝、公开五字段）。
- P1 持久化/API：[apps/api/test/activity-visual-config.test.ts](../../apps/api/test/activity-visual-config.test.ts)（历史库 0000–0040 升级、创建/缺省、三态清除、非法输入、公开投影、权限/CSRF/并发、发布后视觉更新不 bump `ruleVersion`）。
- P2 后台：[apps/admin/src/pages/ActivitiesPage.test.tsx](../../apps/admin/src/pages/ActivitiesPage.test.tsx)（表单映射、四主题预览、视觉-only 保存与服务端重读、清空/失败/非法 URL、脏表单退出确认）。
- P3 H5：[activity-visual.test.mjs](../../apps/web/test/activity-visual.test.mjs)、[activity-visual-page.test.mjs](../../apps/web/test/activity-visual-page.test.mjs)、[activity-share-url.test.mjs](../../apps/web/test/activity-share-url.test.mjs)、[wechat-share.test.mjs](../../apps/web/test/wechat-share.test.mjs)。

阶段验证入口（按风险分层执行，最终以 CI/维护者 `pnpm check` 为准）：

```bash
pnpm --filter @sanchuang-dev/local-life-contracts test
pnpm --filter @sanchuang-dev/local-life-api typecheck
pnpm --filter @sanchuang-dev/local-life-api exec node --import tsx --test test/activities.test.ts test/activity-visual-config.test.ts
pnpm --filter @sanchuang-dev/local-life-contracts build && pnpm --filter @sanchuang-dev/local-life-admin typecheck
pnpm --filter @sanchuang-dev/local-life-admin test
pnpm --filter @sanchuang-dev/local-life-contracts build && pnpm --filter @sanchuang-dev/local-life-admin build
pnpm --filter @sanchuang-dev/local-life-contracts build && pnpm --filter @sanchuang-dev/local-life-web test
pnpm --filter @sanchuang-dev/local-life-web typecheck
pnpm --filter @sanchuang-dev/local-life-contracts build && pnpm --filter @sanchuang-dev/local-life-web build:mvp
```
