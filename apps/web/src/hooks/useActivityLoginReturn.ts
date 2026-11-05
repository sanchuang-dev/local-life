import { useCallback, useEffect, useState } from 'react'
import { API_ROUTES } from '@sanchuang-dev/local-life-contracts'
import {
  ACTIVITY_LOGIN_RESULT_PARAMS,
  API_PREFIX,
  appRouteFromLocation,
  browserLocation,
  buildWechatLoginRequest,
  clearActivityLoginContext,
  loadActivityLoginContext,
  parseActivityLoginResult,
  routeQuery,
  routeToLocation,
  saveActivityLoginContext,
  withoutQueryParams,
  type ActivityLoginContext,
  type ActivityLoginResult,
} from '../components/activity/loginReturn'

/**
 * WeChat availability, reported with an explicit reason. `wechat: false` must
 * render as unavailable — never as a button that silently does nothing.
 */
export type WechatLoginAvailability =
  | { status: 'loading' }
  | {
      status: 'ready'
      wechat: boolean
      unavailableReason: string | null
      developmentResidentLogin: boolean
    }
  | { status: 'error'; message: string }

export type UseActivityLoginReturnOptions = {
  activityId: string | null
  inviteCode: string | null
  inviteInvalid: boolean
}

export type UseActivityLoginReturnResult = {
  availability: WechatLoginAvailability
  loginResult: ActivityLoginResult
  pendingContext: ActivityLoginContext | null
  /** Save the pre-login context and hand the browser to WeChat. */
  startWechatLogin: () => void
  /** Re-read `/auth/methods` after a network failure. */
  retryAvailability: () => void
  /** Dismiss a failed-attempt notice; the resident may then retry explicitly. */
  dismissLoginResult: () => void
}

function readErrorMessage(response: Response): Promise<string> {
  return response
    .json()
    .catch(() => null)
    .then((payload: unknown) => {
      if (payload && typeof payload === 'object') {
        const error = (payload as { error?: { message?: unknown } }).error
        if (error && typeof error.message === 'string' && error.message) return error.message
      }
      return `请求失败（HTTP ${response.status}）`
    })
}

/**
 * Initial OAuth-result + saved-context read. Done as a lazy state initializer so
 * reading the URL and `sessionStorage` does not become a render-time effect.
 */
function readInitialLoginState(): {
  result: ActivityLoginResult
  context: ActivityLoginContext | null
} {
  const route = appRouteFromLocation(browserLocation())
  const result = parseActivityLoginResult(routeQuery(route))
  if (result?.status === 'success') {
    // Identity is established; the returned URL still carries activityId/invite,
    // so the stored pre-login context has done its job and must not linger.
    return { result, context: null }
  }
  return { result, context: loadActivityLoginContext() }
}

/**
 * Login-return mechanics for one activity page.
 *
 * The page keeps rendering whatever the participation API says; this hook only
 * answers "can we start WeChat login, where will it come back to, and what did
 * the last attempt report". It never confirms participation: logging in is not
 * joining, and the explicit confirm stays a separate resident action.
 */
export function useActivityLoginReturn({
  activityId,
  inviteCode,
  inviteInvalid,
}: UseActivityLoginReturnOptions): UseActivityLoginReturnResult {
  const [initial] = useState(readInitialLoginState)
  const [availability, setAvailability] = useState<WechatLoginAvailability>({ status: 'loading' })
  const [loginResult, setLoginResult] = useState<ActivityLoginResult>(initial.result)
  const [pendingContext, setPendingContext] = useState<ActivityLoginContext | null>(initial.context)
  const [availabilityAttempt, setAvailabilityAttempt] = useState(0)

  // Strip the one-off OAuth markers after they have been read, so a refresh
  // cannot replay a stale "login failed" banner. URL/storage writes only.
  useEffect(() => {
    if (!initial.result) return
    const location = browserLocation()
    const route = appRouteFromLocation(location)
    if (!parseActivityLoginResult(routeQuery(route))) return
    const cleaned = withoutQueryParams(route, ACTIVITY_LOGIN_RESULT_PARAMS)
    window.history.replaceState(window.history.state, '', routeToLocation(location, cleaned))
    if (initial.result.status === 'success') clearActivityLoginContext()
  }, [initial])

  useEffect(() => {
    let active = true
    const controller = new AbortController()

    const load = async () => {
      try {
        const response = await fetch(`${API_PREFIX}${API_ROUTES.authMethods}`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(await readErrorMessage(response))
        const payload: unknown = await response.json().catch(() => null)
        if (!active) return
        const record =
          payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>)
            : {}
        const wechat = record.wechat === true
        const rawReason = record.wechatUnavailableReason
        setAvailability({
          status: 'ready',
          wechat,
          unavailableReason: wechat
            ? null
            : typeof rawReason === 'string' && rawReason
              ? rawReason
              : 'not_configured',
          developmentResidentLogin: record.developmentResidentLogin === true,
        })
      } catch (cause) {
        if (!active || controller.signal.aborted) return
        setAvailability({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法读取登录方式',
        })
      }
    }

    void load()
    return () => {
      active = false
      controller.abort()
    }
  }, [availabilityAttempt])

  const startWechatLogin = useCallback(() => {
    // The return target comes from the current route (never a client parameter),
    // is validated against the shared allowlist, and the API re-validates it.
    const request = buildWechatLoginRequest(browserLocation(), {
      activityId,
      inviteCode,
      inviteInvalid,
    })
    saveActivityLoginContext(request.context)
    setPendingContext(request.context)
    setLoginResult(null)
    window.location.assign(request.url)
  }, [activityId, inviteCode, inviteInvalid])

  const retryAvailability = useCallback(() => {
    setAvailability({ status: 'loading' })
    setAvailabilityAttempt((attempt) => attempt + 1)
  }, [])

  const dismissLoginResult = useCallback(() => setLoginResult(null), [])

  return {
    availability,
    loginResult,
    pendingContext,
    startWechatLogin,
    retryAvailability,
    dismissLoginResult,
  }
}

