import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  API_ROUTES,
  authSessionResponseSchema,
  type AuthSessionResponse,
} from '@sanchuang-dev/local-life-contracts'
import { apiErrorFromResponse } from './apiError'

type AuthenticatedSession = Extract<AuthSessionResponse, { authenticated: true }>

/** A real `/auth/session` payload that carries a staff account and its communities. */
export type StaffSession = AuthenticatedSession & {
  staff: NonNullable<AuthenticatedSession['staff']>
}

export type StaffSessionValue = {
  /** Only a real staff session is exposed here; a resident account is not a workbench identity. */
  session: StaffSession | null
  /** True when the browser has a real session but it belongs to a resident-only account. */
  residentOnly: boolean
  loading: boolean
  /** Load error only. Login/logout errors are thrown to the calling form. */
  error: string | null
  login: (username: string, password: string) => Promise<StaffSession>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

export const StaffSessionContext = createContext<StaffSessionValue | null>(null)

function isStaffSession(session: AuthenticatedSession): session is StaffSession {
  return session.staff !== null
}

async function fetchSessionPayload(): Promise<AuthSessionResponse> {
  const response = await fetch(`/api${API_ROUTES.authSession}`, {
    credentials: 'include',
    cache: 'no-store',
  })
  if (!response.ok) throw await apiErrorFromResponse(response, '读取账户状态失败')
  return authSessionResponseSchema.parse(await response.json())
}

/**
 * Staff identity for the mobile workbench.
 *
 * The role and community scope always come from the real `/auth/session`
 * response (server-side staff account), never from local storage, a query
 * parameter or a build-time constant. Residents keep using `useResidentAuth`.
 */
export function useStaffSessionController(): StaffSessionValue {
  const [session, setSession] = useState<StaffSession | null>(null)
  const [rawSession, setRawSession] = useState<AuthenticatedSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const applySession = useCallback((payload: AuthSessionResponse) => {
    if (!payload.authenticated) {
      setRawSession(null)
      setSession(null)
      return
    }
    setRawSession(payload)
    setSession(isStaffSession(payload) ? payload : null)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const payload = await fetchSessionPayload()
      applySession(payload)
      setError(null)
    } catch (cause) {
      setRawSession(null)
      setSession(null)
      setError(cause instanceof Error ? cause.message : '暂时无法连接账户服务')
    } finally {
      setLoading(false)
    }
  }, [applySession])

  useEffect(() => {
    let active = true
    fetchSessionPayload()
      .then((payload) => {
        if (!active) return
        applySession(payload)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setRawSession(null)
        setSession(null)
        setError(cause instanceof Error ? cause.message : '暂时无法连接账户服务')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [applySession])

  const login = useCallback(
    async (username: string, password: string): Promise<StaffSession> => {
      const csrfResponse = await fetch(`/api${API_ROUTES.authCsrf}`, {
        credentials: 'include',
        cache: 'no-store',
      })
      if (!csrfResponse.ok) throw await apiErrorFromResponse(csrfResponse, '获取登录凭证失败')
      const csrf = (await csrfResponse.json()) as { csrfToken: string }

      const response = await fetch(`/api${API_ROUTES.authLogin}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf.csrfToken,
        },
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) throw await apiErrorFromResponse(response, '登录失败')

      const parsed = authSessionResponseSchema.parse(await response.json())
      if (!parsed.authenticated) throw new Error('登录失败，请重试')
      if (!parsed.staff) {
        applySession(parsed)
        throw new Error('该账户没有网格员工作台权限')
      }
      const staffSession: StaffSession = { ...parsed, staff: parsed.staff }
      applySession(staffSession)
      setError(null)
      return staffSession
    },
    [applySession],
  )

  const logout = useCallback(async () => {
    const csrfToken = rawSession?.csrfToken
    if (!csrfToken) return
    const response = await fetch(`/api${API_ROUTES.authLogout}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': csrfToken },
    })
    if (!response.ok) throw await apiErrorFromResponse(response, '退出登录失败')
    setRawSession(null)
    setSession(null)
    setError(null)
  }, [rawSession])

  return useMemo(
    () => ({
      session,
      residentOnly: rawSession !== null && session === null,
      loading,
      error,
      login,
      logout,
      refresh,
    }),
    [session, rawSession, loading, error, login, logout, refresh],
  )
}

export function useStaffSession(): StaffSessionValue {
  const value = useContext(StaffSessionContext)
  if (!value) throw new Error('useStaffSession 必须在 StaffSessionProvider 内使用')
  return value
}
