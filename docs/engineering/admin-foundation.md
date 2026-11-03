# 管理台基础框架（LL-UI-001 / LL-UI-002）

> 适用范围：`apps/admin`。参考 `sanchuang-dev/benefit-hub@dev` 的工程实现，按 Local Life 的品牌与业务边界重写，不在运行时引用另一仓库的源码。
>
> 本文件描述管理台外壳与数据面板的职责边界、状态归属与后续接入点。它不是新的产品契约；业务范围仍由各 MVP Issue 决定。

## 1. 目录与职责

```text
apps/admin/src/
  app/
    routes.tsx            # 路由表：真实页面 + 待建设页 + 404
    theme.ts              # ConfigProvider Token（Local Life 绿色品牌）
    shell/
      AppShell.tsx        # 布局、顶部工具区、路由同步工作页签、响应式抽屉
      AppSidebar.tsx      # 品牌、菜单搜索、分组导航、折叠/抽屉
      navigation.ts       # 业务导航模型（页面、分组、待建设状态，纯数据）
      shell.css           # 外壳与页面版心样式
      sidebar.css         # 侧栏样式
  components/
    PageHeader.tsx        # 页面标题/说明/状态/操作区
  layouts/
    AdminLayout.tsx       # 路由布局入口（当前仅渲染 AppShell）
  pages/                  # 页面级组合：真实能力或显式待建设状态
  shared/
    components/           # DataPanel 等跨页面复用组件（LL-UI-002）
    lib/                  # 工作页签、数据面板偏好等纯 UI 状态
```

- 页面拥有业务数据与查询状态；外壳只拥有导航/页签/主题；`shared/` 只承载真正跨页面复用的 UI 基建。
- 不在本层实现 TanStack Query、Zustand、全局 URL 查询状态（LL-UI-003 范围），也不引入 ProComponents。

## 2. 路由与工作页签

- **URL 是当前页面的唯一真相源**。页签由 `location.pathname` + `sessionStorage` 中的打开列表推导，不存在第二套导航状态。
- 路由切换时自动打开页签；当前页签高亮；关闭非当前页签不改变当前页面；关闭当前页签会导航到相邻页签或经营工作台。
- 支持「关闭其他页签 / 关闭全部页签」，入口在页签条右侧的页签操作菜单。
- 浏览器前进/后退直接驱动路由，页签与高亮随之同步；刷新后 `HashRouter` 恢复当前地址，`sessionStorage` 恢复页签条。
- 未知路由显示显式 404 页面，不添加伪造的模块页签。
- 页签存储键：`ll:work-tabs`，带版本号并在读取时做去重、白名单与数量上限校验。

## 3. 主题与视觉

- 品牌色取自居民 H5（`design.md` §2）：主色 `#116d63`，辅助 `#138b79`，内容底色 `#f5f7f7`，白色侧栏/顶部/页头。
- 统一 Token 定义在 `app/theme.ts`：字体、字号、控件高度、圆角、边框、Menu/Table/Tabs 选中态。业务页面不复制品牌色，也不靠大面积覆盖 `.ant-*` 私有类改主题。
- 页面版心：`.page`（左右 16px，窄屏 12px）+ `PageHeader`（吸顶标题/说明/状态/操作区）+ `.page-stack`。
- 未实现模块统一使用 `PlaceholderPage` 的「待建设」状态，并列出后续 Issue 范围；不展示虚构数量、图表或成功提示。

## 4. 响应式与可访问性

- 视口 ≥ 768px：桌面侧栏（248px，可折叠到 68px，`lg` 断点自动折叠）。
- 视口 < 768px：隐藏侧栏，顶部提供「打开导航菜单」按钮，使用 Drawer；导航后关闭抽屉并把焦点还给触发按钮。
- 菜单搜索只收窄可见菜单，不改变路由/页签；无结果时显示「未找到匹配的菜单」。
- 折叠/展开、抽屉、页签操作均为真实按钮，具备 `aria-label` / `aria-expanded`，不存在可点击但无行为的假交互。

## 5. DataPanel 数据面板

- 入口：`shared/components/DataPanel.tsx`；显示偏好：`shared/lib/data-panel-state.ts` + `shared/lib/data-panel-prefs.ts`。
- **查询状态归页面所有**。`DataPanel` 接收受控 `query`（filters / page / pageSize / sort），只回传变更意图；页面决定是否请求、如何处理服务端分页与错误。面板自身不发请求，也不缓存业务数据。
- 筛选：`text` / `select` / `status` / `numberRange` / `dateRange` 五种；前 `inlineFilterLimit` 个常规条件固定在行内，其余常规条件折叠到「更多条件」，标记 `advanced` 的条件只出现在「高级检索」弹窗。弹窗提交被页面拒绝（`onQueryChange` 返回 `false`）时保持打开并给出提示；取消不应用草稿。
- 日期区间只传 `YYYY-MM-DD` 字符串（`{ start?, end? }`），由页面/API 定义时区与开闭区间语义；组件不自行猜测。
- 排序与分页：点击表头只发出 `sort` 意图并回到第 1 页，不在本地重排当前页；分页大小变化回到第 1 页。`pagination=false` 用于完整的小数据集。
- 表格/卡片：同一 `rows` 两种视图；卡片视图需要页面提供 `renderCard`。所有行操作由页面注入，组件不写业务实体。
- 列设置：显示/隐藏、上下移动、表格密度（紧凑/标准/宽松）、视图模式按 `id` 隔离保存在 `localStorage` 的 `ll:data-panel-prefs`（版本化、白名单、上限 30 面板/60 列）。新增列默认显示；至少保留一列；`hideable=false` 的列不可隐藏。
- 状态：加载中不显示「暂无数据」；失败态提供 `errorTitle`/`message` 与「重试」；空态区分「无匹配筛选」与页码过期，后者提供「回到第一页」。筛选摘要不写入 URL（LL-UI-003）。
- 组件验收页：`/#/system/components`（`pages/ComponentPreviewPage.tsx`）使用 14 条本地样例数据，明确标注为开发预览，不代表居民/订单/业绩等真实业务；样例数据与状态切换仅用于验收组件状态，不写库、不调 API。

## 6. 与 #58 身份/权限的接入点

当前分支基于 `origin/dev`，**没有真实登录与路由守卫**（#58 仍在施工且未合并）。本卡不做以下事情：

- 不伪造登录态、用户菜单、退出按钮或受保护路由；
- 不修改 API、cookie、CSRF、OAuth 与会话契约；
- 顶部工具栏如实显示「身份未接入」并注明依赖 #58。

#58 合并时的接入方式：`layouts/AdminLayout.tsx` 是路由布局入口，认证守卫包裹 `AppShell`，把服务端会话中的管理员身份传入顶部工具区；页签/导航逻辑无需改动。

## 7. 验证

- `pnpm install --frozen-lockfile`、`pnpm check`（Oxlint + typecheck + Admin/API 测试 + 全部构建）。
- Admin 组件/交互测试：`vitest run`（jsdom + Testing Library），覆盖导航模型、页签状态、折叠/抽屉与 DataPanel 契约。
- 真实浏览器证据：`docs/engineering/evidence/ll-ui-001/`（1440 / 1024 / 768 / 767）与 `docs/engineering/evidence/ll-ui-002/`；截图不替代维护者实测。
