import { createContext, createElement, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  API_ROUTES,
  PHONE_AUTH_ROUTES,
  authSessionResponseSchema,
  wechatProfileStatusSchema,
  type WechatProfileStatusResponse,
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
import { RESIDENT_SESSION_EXPIRED_EVENT } from '../services/residentSessionEvents'

type AuthenticatedSession = Extract<AuthSessionResponse, { authenticated: true }>

interface AuthMethods {
  wechat: boolean
  wechatUnavailableReason: string | null
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
function useResidentAuthController() {
  const [session, setSession] = useState<AuthenticatedSession | null>(null)
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  const [phoneStatus, setPhoneStatus] = useState<PhoneAuthStatusResponse | null>(null)
  const [wechatProfile, setWechatProfile] = useState<WechatProfileStatusResponse | null>(null)
  const [wechatProfileError, setWechatProfileError] = useState<string | null>(null)
  const [phoneStatusLoading, setPhoneStatusLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [sessionStatus, setSessionStatus] = useState<'loading' | 'authenticated' | 'unauthenticated' | 'error'>('loading')
  const [methodsLoading, setMethodsLoading] = useState(true)
  const sessionRequestVersion = useRef(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // An old profile response must never be displayed after logout or account
  // switching. Both the resident ID and generation are checked on resolution.
  const profileOwnerRef = useRef<string | null>(null)
  const profileGenerationRef = useRef(0)
  const setProfileOwner = useCallback((userId: string | null) => {
    profileOwnerRef.current = userId
    profileGenerationRef.current += 1
    setWechatProfile(null)
    setWechatProfileError(null)
  }, [])

  const loadPhoneStatus = useCallback(async (): Promise<PhoneAuthStatusResponse | null> => {
    setPhoneStatusLoading(true)
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
    } finally {
      setPhoneStatusLoading(false)
    }
  }, [])

  const loadWechatProfile = useCallback(async (): Promise<WechatProfileStatusResponse | null> => {
    const owner = profileOwnerRef.current
    if (!owner) return null
    const generation = ++profileGenerationRef.current
    const stillCurrent = () =>
      profileOwnerRef.current === owner && profileGenerationRef.current === generation
    try {
      const response = await fetch(`/api${API_ROUTES.authWechatProfile}`, { credentials: 'include' })
      if (!response.ok) throw new Error(await readError(response))
      const parsed = wechatProfileStatusSchema.parse(await response.json())
      if (!stillCurrent()) return null
      setWechatProfile(parsed)
      setWechatProfileError(null)
      return parsed
    } catch (cause) {
      if (!stillCurrent()) return null
      setWechatProfile(null)
      setWechatProfileError(cause instanceof Error ? cause.message : '暂时无法读取微信资料状态')
      return null
    }
  }, [])

  /** Session and login method capability are independent: a /auth/methods
   * outage must never turn a real resident into an anonymous session. */
  const refreshSession = useCallback(async () => {
    const version = ++sessionRequestVersion.current
    setLoading(true)
    setSessionStatus('loading')
    try {
      const response = await fetch(`/api${API_ROUTES.authSession}`, {
        credentials: 'include',
        cache: 'no-store',
      })
      if (response.status === 401) {
        if (version !== sessionRequestVersion.current) return
        setProfileOwner(null)
        setSession(null)
        setSessionStatus('unauthenticated')
        setError(null)
        return
      }
      if (!response.ok) throw new Error(await readError(response))
      const parsed = authSessionResponseSchema.parse(await response.json())
      if (version !== sessionRequestVersion.current) return
      const owner = parsed.authenticated && !parsed.staff ? parsed.user.id : null
      if (profileOwnerRef.current !== owner) setProfileOwner(owner)
      setSession(parsed.authenticated ? parsed : null)
      setSessionStatus(parsed.authenticated ? 'authenticated' : 'unauthenticated')
      if (owner) void loadWechatProfile()
      setError(null)
    } catch (cause) {
      if (version !== sessionRequestVersion.current) return
      // Fail closed on network, 5xx or malformed JSON. Do not redirect as visitor.
      setProfileOwner(null)
      setSession(null)
      setSessionStatus('error')
      setError(cause instanceof Error ? cause.message : '暂时无法读取账户状态')
    } finally {
      if (version === sessionRequestVersion.current) setLoading(false)
    }
  }, [loadWechatProfile, setProfileOwner])

  const invalidateSession = useCallback(() => {
    // 401 from a protected API supersedes the cached browser session.
    sessionRequestVersion.current += 1
    setProfileOwner(null)
    setSession(null)
    setSessionStatus('unauthenticated')
    setLoading(false)
  }, [setProfileOwner])

  useEffect(() => {
    let active = true
    void refreshSession()
    void loadPhoneStatus()
    setMethodsLoading(true)
    const loadMethods = async () => {
      try {
        const response = await fetch('/api/auth/methods', { credentials: 'include' })
        if (!response.ok) throw new Error(await readError(response))
        const available = (await response.json()) as Partial<AuthMethods>
        if (!active) return
        setMethods({
          wechat: available.wechat === true,
          wechatUnavailableReason:
            typeof available.wechatUnavailableReason === 'string'
              ? available.wechatUnavailableReason
              : null,
          developmentResidentLogin: available.developmentResidentLogin === true,
        })
      } catch {
        if (active) setMethods(null)
      } finally {
        if (active) setMethodsLoading(false)
      }
    }
    void loadMethods()
    window.addEventListener(RESIDENT_SESSION_EXPIRED_EVENT, invalidateSession)
    return () => {
      active = false
      sessionRequestVersion.current += 1
      window.removeEventListener(RESIDENT_SESSION_EXPIRED_EVENT, invalidateSession)
    }
  }, [refreshSession, loadPhoneStatus, invalidateSession])

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
      setProfileOwner(parsed.authenticated && !parsed.staff ? parsed.user.id : null)
      setSession(parsed.authenticated ? parsed : null)
      setSessionStatus(parsed.authenticated ? 'authenticated' : 'unauthenticated')
      await loadPhoneStatus()
      if (parsed.authenticated && !parsed.staff) await loadWechatProfile()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '测试登录失败')
    } finally {
      setBusy(false)
    }
  }, [methods, csrfToken, loadPhoneStatus, loadWechatProfile, setProfileOwner])

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
      setProfileOwner(parsed.authenticated && !parsed.staff ? parsed.user.id : null)
      setSession(parsed.authenticated ? parsed : null)
      setSessionStatus(parsed.authenticated ? 'authenticated' : 'unauthenticated')
      setError(null)
      await loadPhoneStatus()
      if (parsed.authenticated && !parsed.staff) await loadWechatProfile()
    },
    [csrfToken, loadPhoneStatus, loadWechatProfile, setProfileOwner],
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
      setProfileOwner(null)
      setSession(null)
      setSessionStatus('unauthenticated')
      await loadPhoneStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '退出登录失败')
    } finally {
      setBusy(false)
    }
  }, [session, loadPhoneStatus, setProfileOwner])

  return {
    session,
    sessionStatus,
    methods,
    methodsLoading,
    refreshSession,
    phoneStatus,
    wechatProfile,
    wechatProfileError,
    phoneStatusLoading,
    loading,
    busy,
    error,
    startWechatLogin,
    developmentLogin,
    requestPhoneCode,
    loginWithPhone,
    bindPhone,
    refreshPhoneStatus: loadPhoneStatus,
    refreshWechatProfile: loadWechatProfile,
    logout,
  }
}

/** The guard and its child pages observe one session controller, not racing
 * independent /auth/session calls or retaining separate account copies. */
const ResidentAuthContext = createContext<ReturnType<typeof useResidentAuthController> | null>(null)

export function ResidentAuthProvider({ children }: { children: ReactNode }) {
  const value = useResidentAuthController()
  return createElement(ResidentAuthContext.Provider, { value }, children)
}

export function useResidentAuth() {
  const value = useContext(ResidentAuthContext)
  if (!value) throw new Error('ResidentAuthProvider is required')
  return value
}
