# LL-UI-007 社区与后台账户新建 Drawer 浏览器证据

验证对象：`apps/admin` 的「账户与社区」页面（`/communities`）中「创建社区」「创建后台账户」两个新建入口。

- 运行方式：本地 `pnpm dev:admin`（Vite，`http://localhost:5174`）+ 本地 API（`http://127.0.0.1:4080`，真实 SQLite 数据）。
- 驱动方式：本机 Chrome 156 headless + CDP（脚本 `browser-verify.mjs`，位于仓库外的临时证据目录，不随仓库提交）。
- 数据：真实管理员会话（`e2eadmin`），真实 `POST /api/admin/communities`、`POST /api/admin/staff`、`GET` 列表与 `403` 响应，无 mock。
- 结果：**20/20 检查通过**，无未预期的控制台运行时错误；详细逐项结果见 `ll-ui-007-verification.json`。

## 覆盖清单

| # | 场景 | 证据 |
| --- | --- | --- |
| 1 | 1440 宽度下先展示社区/账户/居民三块现有数据及两个新建入口 | `01-communities-1440-initial.png` |
| 2 | 「新建社区」以右侧 Drawer 打开，页面数据仍可见 | `02-community-drawer-1440.png` |
| 3 | 空名称拦截；去除首尾空格后长度非法拦截（2–60 字符） | `03-community-validation-1440.png` |
| 4 | 真实 API 创建成功：Drawer 关闭、列表数量刷新、当前社区与滚动位置保留 | `04-community-created-1440.png` |
| 5 | 脏表单关闭二次确认（继续编辑 / 放弃并关闭），关闭后焦点回到「新建社区」 | `05-community-close-confirm-1440.png` |
| 6 | 「新增账户」Drawer：账号/姓名/密码/角色/负责社区/关联用户 | `06-staff-drawer-1440.png` |
| 7 | 真实 API 创建后台账户（网格员 + 负责社区）后列表刷新 | `07-staff-created-1440.png` |
| 8 | 服务端 409（账号重复）失败时 Drawer 保留输入并显示服务端错误 | `08-staff-duplicate-error-1440.png` |
| 9 | 1024 宽度下 Drawer 不横向溢出 | `09-staff-drawer-1024.png` |
| 10 | 768 宽度下 Drawer 底部操作按钮完整可见且不横向溢出 | `10-staff-drawer-768.png` |
| 11 | 375 宽度下社区 Drawer 不横向溢出、底部操作完整 | `11-community-drawer-375.png` |
| 12 | 375 宽度下宽 Drawer（640）可纵向滚动、不横向溢出、底部操作完整 | `12-staff-drawer-375.png` |
| 13 | 运营员登录：页面不显示「新建社区」「新增账户」，直接 `POST` 返回真实 403 | `13-operator-readonly-1440.png` |

## 已知限制

- 截图来自 Windows 本机 headless Chrome 156（1440×900、1024/768/375 视口），不覆盖 Safari/Firefox 与真实移动设备。
- 本机数据是临时 E2E 种子库，截图中的「E2E社区…」等名称仅用于验收，不代表生产数据。
- 控制台存在既有 `[antd: Spin] tip is deprecated` 警告（来自 `App.tsx`，不在本卡修改范围），未计入失败。
- 单元测试为 jsdom 行为测试，不能替代上述真实浏览器验收；两者结果均记录在 PR 正文。
