import { useEffect, useState } from 'react'
import { Spin } from 'antd'
import { useRoutes } from 'react-router'
import { AdminAuthProvider } from './app/auth-context'
import { routes } from './app/routes'
import { LoginPage } from './pages/LoginPage'
import { resetWorkTabs } from './shared/lib/work-tabs'
import { fetchSession, loginStaff, logoutStaff, type AuthenticatedSession } from './services/auth'

function AuthenticatedRoutes() {
  return useRoutes(routes)
}

/**
 * Only this component may unlock the admin route tree. The URL remains intact
 * while signed out, so a protected deep link opens after successful login.
 */
export default function App() {
  const [session, setSession] = useState<AuthenticatedSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetchSession()
      .then((result) => {
        if (!active) return
        if (result.authenticated && result.staff) {
          setSession({ ...result, staff: result.staff })
          setError(null)
        } else {
          setSession(null)
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '无法连接账户服务')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
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
      resetWorkTabs() // Never expose the previous staff member's open tab history.
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

  if (!session) return <LoginPage busy={busy} error={error} onLogin={handleLogin} />

  return (
    <AdminAuthProvider value={{ session, busy, error, onLogout: handleLogout }}>
      <AuthenticatedRoutes />
    </AdminAuthProvider>
  )
}
