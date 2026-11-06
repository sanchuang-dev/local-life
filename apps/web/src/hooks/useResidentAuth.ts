import { useCallback, useEffect, useState } from 'react'
import {
  API_ROUTES,
  PHONE_AUTH_ROUTES,
  authSessionResponseSchema,
  phoneAuthStatusResponseSchema,
  phoneBindResponseSchema,
  phoneOtpRequestResponseSchema,
  type AuthSessionResponse,
  type PhoneAuthStatusResponse,
  type PhoneBindResponse,
  type PhoneOtpPurpose,
  type PhoneOtpRequestResponse,
} from '@sanchuang-dev/local-life-contracts'
import { apiErrorFromResponse } from './apiError'
import { isWeChatBrowser } from '../components/auth/wechatEnvironment'

type AuthenticatedSession = Extract<AuthSessionResponse, { authenticated: true }>

interface AuthMethods {
  wechat: boolean
  developmentResidentLogin: boolean
}

async function readError(response: Response): Promise<string> {
  // The shared envelope is the only source of a real API message.
  const error = await apiErrorFromResponse(response, '请求失败')
  return error.message
}

/**
 * Real resident authentication state.
 *
 * Three methods share one session/CSRF/Origin implementation: WeChat OAuth (the
 * redirect never returns here), the development-only resident login, and phone +
 * SMS code. The phone method additionally reports whether this deployment has an
 * SMS sender at all, so the UI can present it as unavailable instead of offering
 * a button that can only fail. No code is ever auto-filled or cached.
 */
export function useResidentAuth() {
  const [session, setSession] = useState<AuthenticatedSession | null>(null)
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  const [phoneStatus, setPhoneStatus] = useState<PhoneAuthStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadPhoneStatus = useCallback(async (): Promise<PhoneAuthStatusResponse | null> => {
    try {
      const response = await fetch(`/api${PHONE_AUTH_ROUTES.status}`, { credentials: 'include' })
      if (!response.ok) throw new Error(await readError(response))
      const parsed = phoneAuthStatusResponseSchema.parse(await response.json())
      setPhoneStatus(parsed)
      return parsed
    } catch {
      // The phone panel degrades to "unknown/unavailable"; the rest of the
      // account page keeps working (WeChat/dev login are unaffected).
      setPhoneStatus(null)
      return null
    }
  }, [])

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
    void loadPhoneStatus()
    return () => {
      active = false
    }
  }, [loadPhoneStatus])

  /** Fetch a fresh double-submit token; the resident session cookie is reused. */
  const csrfToken = useCallback(async (): Promise<string> => {
    const response = await fetch(`/api${API_ROUTES.authCsrf}`, { credentials: 'include' })
    if (!response.ok) throw new Error(await readError(response))
    return ((await response.json()) as { csrfToken: string }).csrfToken
  }, [])

  const startWechatLogin = useCallback(() => {
    if (typeof navigator === 'undefined' || !isWeChatBrowser(navigator.userAgent)) {
      setError('请在微信内打开页面授权登录，或使用手机号登录')
      return
    }
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
      const token = await csrfToken()
      const response = await fetch('/api/auth/dev/login', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': token,
        },
        body: JSON.stringify({ displayName: '本地测试居民' }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const parsed = authSessionResponseSchema.parse(await response.json())
      setSession(parsed.authenticated ? parsed : null)
      await loadPhoneStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '测试登录失败')
    } finally {
      setBusy(false)
    }
  }, [methods, csrfToken, loadPhoneStatus])

  /**
   * Request an SMS code. The code is delivered out of band by the deployment's
   * sender; the response only carries timing metadata. Errors are surfaced
   * verbatim (cooldown, limit, not configured) so the UI can show the real reason.
   */
  const requestPhoneCode = useCallback(
    async (phone: string, purpose: PhoneOtpPurpose): Promise<PhoneOtpRequestResponse> => {
      const token = await csrfToken()
      const response = await fetch(`/api${PHONE_AUTH_ROUTES.requestOtp}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': token,
        },
        body: JSON.stringify({ phone, purpose }),
      })
      if (!response.ok) throw new Error(await readError(response))
      return phoneOtpRequestResponseSchema.parse(await response.json())
    },
    [csrfToken],
  )

  const loginWithPhone = useCallback(
    async (phone: string, code: string) => {
      const token = await csrfToken()
      const response = await fetch(`/api${PHONE_AUTH_ROUTES.login}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': token,
        },
        body: JSON.stringify({ phone, code }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const parsed = authSessionResponseSchema.parse(await response.json())
      setSession(parsed.authenticated ? parsed : null)
      setError(null)
      await loadPhoneStatus()
    },
    [csrfToken, loadPhoneStatus],
  )

  const bindPhone = useCallback(
    async (phone: string, code: string): Promise<PhoneBindResponse> => {
      const token = await csrfToken()
      const response = await fetch(`/api${PHONE_AUTH_ROUTES.bind}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': token,
        },
        body: JSON.stringify({ phone, code }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const parsed = phoneBindResponseSchema.parse(await response.json())
      await loadPhoneStatus()
      return parsed
    },
    [csrfToken, loadPhoneStatus],
  )

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
      await loadPhoneStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '退出登录失败')
    } finally {
      setBusy(false)
    }
  }, [session, loadPhoneStatus])

  return {
    session,
    methods,
    phoneStatus,
    loading,
    busy,
    error,
    startWechatLogin,
    developmentLogin,
    requestPhoneCode,
    loginWithPhone,
    bindPhone,
    refreshPhoneStatus: loadPhoneStatus,
    logout,
  }
}
