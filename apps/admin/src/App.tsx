import { Route, Routes } from 'react-router'
import { AdminLayout } from './layouts/AdminLayout'
import { DashboardPage } from './pages/DashboardPage'
import { PlaceholderPage } from './pages/PlaceholderPage'

/**
 * Navigation entries exist so the information architecture is reviewable, but
 * every one of them is explicitly unimplemented in this engineering slice.
 */
const PENDING_MODULES = [
  {
    path: '/content',
    title: '内容管理',
    description: '社区公告、活动文案与素材的创建、审核和上下线。',
    planned: ['内容列表与筛选', '编辑与预览', '审核状态流转'],
  },
  {
    path: '/activities',
    title: '活动管理',
    description: '银发社区欢乐季等活动的配置、报名与效果数据。',
    planned: ['活动配置', '报名名单', '活动数据看板'],
  },
  {
    path: '/users',
    title: '用户与权限',
    description: '管理员账号、角色与操作审计。',
    planned: ['登录与账号', '角色权限', '操作审计'],
  },
  {
    path: '/settings',
    title: '系统设置',
    description: 'API 地址、运行环境与发布配置的只读说明。',
    planned: ['环境信息', '发布记录'],
  },
]

export default function App() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<DashboardPage />} />
        {PENDING_MODULES.map((pendingModule) => (
          <Route
            key={pendingModule.path}
            path={pendingModule.path}
            element={<PlaceholderPage {...pendingModule} />}
          />
        ))}
        <Route
          path="*"
          element={
            <PlaceholderPage
              title="页面不存在"
              description="该管理台地址没有对应模块。"
              planned={[]}
            />
          }
        />
      </Route>
    </Routes>
  )
}
