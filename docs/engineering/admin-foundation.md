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
- 排序与分页：点击表头只发出 sort 意图并回到第 1 页，不在本地重排当前页；分页大小变化回到第 1 页。表格/卡片共用 DataPanel 内独立 Footer 的分页器，Header 工具栏与 Body 内容区保持独立；全部有分页的 DataPanel 默认填满所在工作区（fillRemainingHeight 默认等于 pagination），Body 内部滚动、Footer 沉底，包括活动、用户、订单、商品、精选优惠、CRM 双标签、经营流水及组件验收。CRM 的标签容器透传弹性高度。pagination=false 用于完整的小数据集，此时不显示 Footer，默认不填满。
- 表格/卡片：同一 `rows` 两种视图；卡片视图需要页面提供 `renderCard`。行操作由页面注入，组件不写业务实体。默认 rowActionMode=compact：明确标记 primary=true 的操作始终在行内；未标记时自动展示前两项普通操作，危险操作默认归入键盘可访问的「更多操作」菜单。特殊列表可设置 rowActionMode=expanded，业务状态切换和二次确认仍由页面负责。
- **业务列表优先复用 DataPanel**：列表级主要创建动作和导入/导出/下载模板等操作放进 `toolbarExtra`；纯页面级、非列表操作才使用 `PageHeader.extra`；刷新使用 `onRefresh`，编辑/上下架等动作使用 `rowActions`。这些扩展能力已经开放，不应为了添加业务按钮重复搭建 `Table + Toolbar + Pagination`。
- 若 API 当前只提供完整列表而不支持分页/查询，页面负责筛选和切片并向受控 `PanelQuery` 回传结果；不得伪装成服务端查询或让 `DataPanel` 私自抓取/缓存业务数据。
- 列设置：显示/隐藏、上下移动、表格密度（紧凑/标准/宽松）、视图模式按 `id` 隔离保存在 `localStorage` 的 `ll:data-panel-prefs`（版本化、白名单、上限 30 面板/60 列）。新增列默认显示；至少保留一列；`hideable=false` 的列不可隐藏。
- 状态：加载中不显示「暂无数据」；失败态提供 `errorTitle`/`message` 与「重试」；空态区分「无匹配筛选」与页码过期，后者提供「回到第一页」。筛选摘要不写入 URL（LL-UI-003）。
- 组件验收页：`/#/system/components`（`pages/ComponentPreviewPage.tsx`）使用 14 条本地样例数据，明确标注为开发预览，不代表居民/订单/业绩等真实业务；样例数据与状态切换仅用于验收组件状态，不写库、不调 API。

## 6. 与 #58 真实身份/权限集成

- `App.tsx` 在渲染任何受保护路由前通过 `/api/auth/session` 恢复会话；未认证/无后台身份时显示真实登录表单，不渲染 AppShell。
- `app/auth-context.tsx` 将经过服务端验证的 `session`、注销状态与错误传入 `AppShell` 和路由组件；顶部显示实际用户/角色，退出调用 `/api/auth/logout`，成功后清空工作页签并切回登录表单。
- 导航仍由 React Router 的 location 决定当前页。 `/communities` 对应 #58 的 `UsersPage`，管理员可管理社区与工作人员；网格员只读被授予社区及居民。服务器再次强制 401/403，菜单隐藏绝不替代后端鉴权。
- `/users` 为独立的用户目录；`/communities` 只维护社区、服务点及已有工作人员关联；`/system/access` 是仅管理员可进入的真实后台账号 DataPanel，创建账号仍使用原有受控 API，关联社区通过管理员专用、CSRF 保护且有审计的接口。开发中的 DataPanel 验收页也只允许已经登录的后台用户访问。
- `/system/runtime` 收纳真实 API 诊断，经营工作台不再放大量工程调试说明，也没有虚构成交/业绩数据。
- #58 微信网页 OAuth 的真实公众号回调仍待取得授权的微信环境验证；本地测试和 CI 不得冒充微信生产验收。

## 6.1 DataPanel 草稿状态修复

- 常规筛选只在已应用查询发生语义变化时同步；不会因列设置、弹窗错误反馈等普通重渲染覆盖未提交草稿。
- 高级检索仅在打开弹窗时从已应用查询和未提交的行内输入初始化；查询遭页面拒绝时保留草稿。已增加回归测试。

## 7. 验证

- `pnpm install --frozen-lockfile`、`pnpm check`（Oxlint + typecheck + Admin/API 测试 + 全部构建）。
- Admin 组件/交互测试：`vitest run`（jsdom + Testing Library），覆盖导航模型、页签状态、折叠/抽屉与 DataPanel 契约。
- 真实浏览器证据：`docs/engineering/evidence/ll-ui-001/`（1440 / 1024 / 768 / 767）与 `docs/engineering/evidence/ll-ui-002/`；截图不替代维护者实测。

## 第三方配置入口

系统管理仅显示 `/system/integrations`「第三方配置」，以两张卡片展示微信公众号和腾讯地图的真实服务端状态，管理员可在同页抽屉中打开原有受控配置界面。保持 `/system/wechat` 和 `/system/tencent-map` 路由供既有深链兼容，但不重复出现在菜单中。卡片只读取服务端状态，不复制密钥表单或管理权限；保存、验证、切换、停用仍走原 API 与 CSRF/确认机制，关闭配置抽屉后重新查询状态。

## 业绩、流水、对账与结算的页面分工

运营后台在「业绩与对账」下按页面分工：`/performance` 只展示服务端聚合的业绩总览（登记金额、已核验业绩、人工实收与冲正、奖励成本与冲正、归属与异常），并按社区、业务日期和业绩归属筛选；`/performance/ledger` 独立承载经营流水的服务端分页查询、事实类型/来源/异常筛选与逐笔详情；两者都不计算应付或分账。订单的实收凭据登记与归属确认已并入 `/orders` 的订单详情抽屉，不再提供「搜索订单 → 再次选择订单」的重复入口，也不另建核查列表。`/reconciliation` 负责经营对账批次、差异与冻结明细 CSV。结算页的六个子视图（候选看板、主体目录、商户映射、合同规则、服务端试算、结算单）放置于顶部白色 `PageHeader.subnav`，下方为业务内容；子视图首次选择才挂载，返回时保留页面状态。进入结算页不请求对账批次，进入对账页不请求结算候选；两页均不凭空推断已付款、应付或可分账金额。

## 页面说明与状态提示

后台使用共享 `PageInfoProvider` 与 `PageInfoAlert`，将纯说明性的蓝色信息框汇总到 `PageHeader` 标题旁的一个问号 Tooltip，供悬停、点击和键盘操作查看。复合页面中，只有当前激活子页的说明参与汇总；被弹窗遮罩挡住的操作说明同时保留弹窗内的紧凑问号。禁止把「真实数据」「已验证身份」「开发预览」等自我声明作为页面状态 Tag。真实错误、警告、审批结果及权限限制必须保持可见，不得被折叠为说明性 Tooltip。
