import { lazy, Suspense, useEffect, useState } from 'react'
import { Route, Routes } from 'react-router'
import { Spin } from 'antd'
import { AdminLayout } from './layouts/AdminLayout'
import { fetchSession, loginStaff, logoutStaff, type AuthenticatedSession } from './services/auth'

const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })))
const LoginPage = lazy(() => import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })))
const PlaceholderPage = lazy(() => import('./pages/PlaceholderPage').then((module) => ({ default: module.PlaceholderPage })))
const UsersPage = lazy(() => import('./pages/UsersPage').then((module) => ({ default: module.UsersPage })))

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
    description: '三人成团活动的配置、发布、报名与效果数据。',
    planned: ['活动配置', '参与名单', '成团与奖励规则'],
  },
  {
    path: '/settings',
    title: '系统设置',
    description: '运行环境、账号安全与集成配置。',
    planned: ['微信公众平台配置', '运行环境', '审计记录查询'],
  },
]

export default function App() {
  const [session, setSession] = useState<AuthenticatedSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetchSession()
      .then((result) => {
        if (active) {
          if (result.authenticated && result.staff) setSession({ ...result, staff: result.staff })
          else setSession(null)
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '无法连接账户服务')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function handleLogin(values: { username: string; password: string }) {
    setBusy(true)
    setError(null)
    try {
      setSession(await loginStaff(values.username, values.password))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleLogout() {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      await logoutStaff(session.csrfToken)
      setSession(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '退出登录失败')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spin tip="正在读取登录状态…" />
      </div>
    )
  }

  if (!session) {
    return (
      <Suspense fallback={<div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><Spin /></div>}>
        <LoginPage busy={busy} error={error} onLogin={handleLogin} />
      </Suspense>
    )
  }

  return (
    <Suspense fallback={<div style={{ minHeight: '50vh', display: 'grid', placeItems: 'center' }}><Spin /></div>}>
    <Routes>
      <Route
        element={
          <AdminLayout session={session} busy={busy} error={error} onLogout={handleLogout} />
        }
      >
        <Route index element={<DashboardPage session={session} />} />
        <Route path="/users" element={<UsersPage session={session} />} />
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
    </Suspense>
  )
}
