# LL-UI-002 DataPanel 浏览器证据

验证对象：`apps/admin` 的通用数据面板 `DataPanel` 及组件验收页 `/#/system/components`。

- 运行方式：本地 `pnpm dev:admin`（Vite，`http://localhost:5174`）+ Playwright 1.64.1（系统 Chrome，`channel: 'chrome'`）。
- 脚本：`/tmp/pw/datapanel-verify.mjs`（临时验证脚本，不进入仓库；同一流程可按下方清单复跑）。
- 页面数据：14 条本地样例，仅用于组件验收；页内筛选/排序/分页，不调用 API。
- 结果：**23/23 检查通过，0 控制台错误/页面异常**（明细见 `datapanel-verification.json`）。

## 覆盖清单

| # | 场景 | 证据 |
| --- | --- | --- |
| 1 | 1440 默认列表、分页总数、行内筛选行 | `datapanel-1440-default.png` |
| 2 | 关键词筛选后 1 条、重置恢复 | `datapanel-1440-keyword.png` |
| 3 | 「更多条件」展开折叠筛选 | `datapanel-1440-more-filters.png` |
| 4 | 高级检索弹窗（金额区间 / 日期区间 / 独立输入 id） | `datapanel-1440-advanced-modal.png`、`datapanel-1440-date-range.png` |
| 5 | 取消不应用草稿；重新打开回到已提交条件 | 检查项 7–8 |
| 6 | 页面拒绝非法区间：弹窗保留 + 显式提示 | `datapanel-1440-rejected.png` |
| 7 | 状态筛选 + 卡片视图 + 行操作真实反馈 | `datapanel-1440-card-view.png` |
| 8 | 列隐藏/密度即时生效，刷新后按 panel id 恢复 | `datapanel-1440-column-density.png` |
| 9 | 加载中不谎报空数据；失败 + 重试；无匹配空态 | `datapanel-1440-loading.png`、`datapanel-1440-error.png`、`datapanel-1440-empty-filter.png` |
| 10 | 1024 / 768 / 767 布局与弹窗视口内、无横向溢出 | `datapanel-1024.png`、`datapanel-768.png`、`datapanel-768-advanced-modal.png`、`datapanel-767.png` |

## 已知限制

- 样例数据与「组件状态」切换只用于验收 loading/error，不代表真实业务 API 状态。
- 服务端分页、排序与 URL 查询状态同步未接入（LL-UI-003 / 业务卡范围）。
- 日期区间在验收页按 `YYYY-MM-DD` 字符串比较；生产 API 的时区与开闭区间语义需由对应业务卡定义。
