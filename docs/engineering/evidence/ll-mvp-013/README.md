# LL-MVP-013 / Issue #125 — 居民目录验收证据

## 现行数据模型与最小改动

- API: `GET /crm/residents`，管理台同源调用 `GET /api/crm/residents`，入口仍通过已登录员工 Session 及 `staff_community_assignments` 校验指定 `communityId`。管理员可以选择所有存在社区；运营员、网格员仅可读取自己的分配社区。
- 共享 contracts：`residentDirectoryQuerySchema`（必填社区 UUID、默认页码 1、默认每页 20、每页最大 100、页码最大 10000、搜索长度 1–80）；`residentDirectoryResponseSchema`（`items,total,page,pageSize`），H5 与 Admin 没有自建居民 DTO。
- 居民身份与社区归属仍是已有 `users` + `resident_community_assignments`。微信资料来自 #121 的 `wechat_identities`，只读已明确授权、属于数据库**当前启用公众号 AppID** 的资料（与现有 `/auth/wechat/profile` 的身份规则一致）。多条身份取最近授权的一条，不得放大居民行数、总数或跨账号/公众号污染。
- 返回只包含平台用户 UUID、显示用名称、本地显示名、已授权微信昵称与头像 URL、授权时间、注册/加入社区时间。展示优先级：**已授权的微信昵称 > 本地显示名 >「微信用户」**；不改动 `users.display_name`，也不返回 OpenID、UnionID、手机号、地址、身份证、access_token 等敏感信息。
- 检索直接在 SQLite 中按当前社区过滤并统计，总数不依赖分页结果长度；名字和 UUID 采用转义后的字面 substring `LIKE`，特殊字符 `% / _ / \\` 不变通配符；参数全部绑定。按加入时间降序、平台 UUID 升序稳定排序。超出末页返回空 `items`，保留真实 `total`。
- 管理台 `UsersPage` 在已有社区选择器下增加搜索、后端分页、计数、已授权头像/昵称、加载/空/失败/重试；切换社区或搜索后页码回到 1。后端每次最多返回 100 条（界面提供 10/20/50），不下载全部居民。
- **没有数据库迁移、Redis、额外索引、CRM 线索编辑、导出或营销能力。**

## 运行证据（真实 TCP HTTP + 已迁移 SQLite）

`apps/api/test/resident-directory-http.test.ts`：3 个聚焦用例，使用真实 Node TCP Hono listener 与 SQLite 迁移，不 mock 目录服务、路由、鉴权、数据库或查询；工作账号与 141 位居民由受控 fixture 插入，微信资料来自现有数据库 schema。

| 要点 | 实测 |
|---|---|
| 137 人社区分页 | `pageSize=50`：第 1–4 页各返回 **50、50、37、0** 条；每页 `total=137`，前 3 页 137 个不同 UUID，无缺漏 |
| 社区隔离 | A 社区 137 人、B 社区 4 人；管理员可查；已分配 A 的运营员及网格员仅可查 A；越权访问 B 返回 403 |
| 未登录/非法请求 | 未认证 401；无社区、非法 UUID、页码 0/10001、每页 101、超长关键字均 400；不存在社区 404 |
| 显示与搜索 | 已授权微信昵称和头像优先；原始本地名保持不变；未授权/其他公众号资料不会显示；本地名、当前公众号已授权昵称、完整用户 UUID 均可检索 |
| SQL 字面搜索 | `% / _ / \\` 不被当作 SQL 通配符；空匹配 `total=0` |
| 性能边界 | `EXPLAIN QUERY PLAN` 确认社区过滤使用仓库已有 `resident_community_community_idx`；微信身份的 `user_id` 也有现成索引；无需新表或缓存 |

## 管理台交互

`apps/admin/src/pages/UsersPage.test.tsx`：完整该文件 **13/13 通过**。新增的两组用例实际渲染原 `UsersPage` 与 Ant Design 控件，通过精确 HTTP 边界 stub 观察真实查询参数与状态变化；覆盖首次加载服务器 43 人计数、翻页、按昵称搜索、清除、社区切换、后端空结果、居民接口 503 提示及按钮重试。原有社区/后台账号管理测试均通过。

## 验收边界

- #121 微信资料自主授权、#123 OAuth 社区归属为前置数据写入路径，本卡不重写也不宣称真实微信账户授权、关联已做真机验收。已有 schema 与代码提供可读取的资料/归属，外部授权成功后目录可自然展示。
- 本卡无额外浏览器截图、真实微信环境或上线验收；**组件交互测试不能冒称实际 375/320 浏览器视觉验收**。维护者此前要求停止反复浏览器测试，因此只做了针对真实 UI 控件的聚焦回归。此视觉事项留待有浏览器执行权限的后续联调或维护者风险验收。
- 施工结束前按仓库规约执行 **一次完整 `pnpm check`**；实际退出码和 CI 最终状态见 Draft PR。
