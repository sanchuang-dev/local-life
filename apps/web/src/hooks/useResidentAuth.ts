import { useCallback, useEffect, useState } from 'react'
import {
  API_ROUTES,
  apiErrorSchema,
  authSessionResponseSchema,
  type AuthSessionResponse,
} from '@sanchuang-dev/local-life-contracts'

type AuthenticatedSession = Extract<AuthSessionResponse, { authenticated: true }>

interface AuthMethods {
  wechat: boolean
  developmentResidentLogin: boolean
}

async function readError(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null)
  const parsed = apiErrorSchema.safeParse(payload)
  return parsed.success
    ? parsed.data.error.message
    : `请求失败（HTTP ${response.status}）`
}

export function useResidentAuth() {
  const [session, setSession] = useState<AuthenticatedSession | null>(null)
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    async function load() {
      try {
        const [sessionResponse, methodsResponse] = await Promise.all([
          fetch(`/api${API_ROUTES.authSession}`, { credentials: 'include' }),
          fetch('/api/auth/methods', { credentials: 'include' }),
        ])
        if (!sessionResponse.ok) throw new Error(await readError(sessionResponse))
        if (!methodsResponse.ok) throw new Error(await readError(methodsResponse))
        const parsed = authSessionResponseSchema.parse(await sessionResponse.json())
        const available = (await methodsResponse.json()) as AuthMethods
        if (!active) return
        setSession(parsed.authenticated ? parsed : null)
        setMethods(available)
        setError(null)
      } catch (cause) {
        if (active) {
          setMethods(null)
          setError(cause instanceof Error ? cause.message : '暂时无法连接账户服务')
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [])

  const startWechatLogin = useCallback(() => {
    if (!methods?.wechat) {
      setError('微信网页授权尚未配置，请联系运营人员')
      return
    }
    window.location.assign(`/api${API_ROUTES.authWechatStart}`)
  }, [methods])

  const developmentLogin = useCallback(async () => {
    if (!methods?.developmentResidentLogin) return
    setBusy(true)
    setError(null)
    try {
      const csrfResponse = await fetch(`/api${API_ROUTES.authCsrf}`, {
        credentials: 'include',
      })
      if (!csrfResponse.ok) throw new Error(await readError(csrfResponse))
      const csrf = (await csrfResponse.json()) as { csrfToken: string }
      const response = await fetch('/api/auth/dev/login', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf.csrfToken,
        },
        body: JSON.stringify({ displayName: '本地测试居民' }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const parsed = authSessionResponseSchema.parse(await response.json())
      setSession(parsed.authenticated ? parsed : null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '测试登录失败')
    } finally {
      setBusy(false)
    }
  }, [methods])

  const logout = useCallback(async () => {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api${API_ROUTES.authLogout}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': session.csrfToken },
      })
      if (!response.ok) throw new Error(await readError(response))
      setSession(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '退出登录失败')
    } finally {
      setBusy(false)
    }
  }, [session])

  return {
    session,
    methods,
    loading,
    busy,
    error,
    startWechatLogin,
    developmentLogin,
    logout,
  }
}
