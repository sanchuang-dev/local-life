import { useCallback, useEffect, useRef, useState } from 'react'
import {
  API_ROUTES,
  PHONE_AUTH_ROUTES,
  authSessionResponseSchema,
  wechatProfileStartResponseSchema,
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
export function useResidentAuth() {
  const [session, setSession] = useState<AuthenticatedSession | null>(null)
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  const [phoneStatus, setPhoneStatus] = useState<PhoneAuthStatusResponse | null>(null)
  const [wechatProfile, setWechatProfile] = useState<WechatProfileStatusResponse | null>(null)
  const [wechatProfileError, setWechatProfileError] = useState<string | null>(null)
  const [phoneStatusLoading, setPhoneStatusLoading] = useState(true)
  const [loading, setLoading] = useState(true)
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
        const available = (await methodsResponse.json()) as Partial<AuthMethods>
        if (!active) return
        setProfileOwner(parsed.authenticated && !parsed.staff ? parsed.user.id : null)
        setSession(parsed.authenticated ? parsed : null)
        setMethods({
          wechat: available.wechat === true,
          wechatUnavailableReason:
            typeof available.wechatUnavailableReason === 'string'
              ? available.wechatUnavailableReason
              : null,
          developmentResidentLogin: available.developmentResidentLogin === true,
        })
        if (parsed.authenticated && !parsed.staff) void loadWechatProfile()
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
      profileGenerationRef.current += 1
    }
  }, [loadPhoneStatus, loadWechatProfile, setProfileOwner])

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

  const startWechatProfileAuthorization = useCallback(async () => {
    if (!session || session.staff) return
    if (typeof navigator === 'undefined' || !isWeChatBrowser(navigator.userAgent)) {
      setWechatProfileError('请在微信内打开页面，再主动授权同步头像和昵称')
      return
    }
    if (!wechatProfile?.available) {
      setWechatProfileError('当前账户没有可用的公众号微信身份，不能自动绑定其他微信账户')
      return
    }
    setBusy(true)
    setWechatProfileError(null)
    try {
      const token = await csrfToken()
      const response = await fetch(`/api${API_ROUTES.authWechatProfileStart}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'x-csrf-token': token },
      })
      if (!response.ok) throw new Error(await readError(response))
      const parsed = wechatProfileStartResponseSchema.parse(await response.json())
      window.location.assign(parsed.authorizationUrl)
    } catch (cause) {
      setWechatProfileError(cause instanceof Error ? cause.message : '发起微信资料授权失败')
    } finally {
      setBusy(false)
    }
  }, [session, wechatProfile, csrfToken])

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
      await loadPhoneStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '退出登录失败')
    } finally {
      setBusy(false)
    }
  }, [session, loadPhoneStatus, setProfileOwner])

  return {
    session,
    methods,
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
    startWechatProfileAuthorization,
    logout,
  }
}
