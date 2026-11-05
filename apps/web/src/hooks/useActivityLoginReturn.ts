import { useCallback, useEffect, useState } from 'react'
import { API_ROUTES } from '@sanchuang-dev/local-life-contracts'
import {
  API_PREFIX,
  browserLocation,
  buildWechatLoginRequest,
  loadActivityLoginContext,
  saveActivityLoginContext,
  type ActivityLoginContext,
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
  pendingContext: ActivityLoginContext | null
  /** Save the pre-login context and hand the browser to WeChat. */
  startWechatLogin: () => void
  /** Re-read `/auth/methods` after a network failure. */
  retryAvailability: () => void
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
 * Login-return mechanics for one activity page.
 *
 * The page keeps rendering whatever the participation API says; this hook only
 * answers "can we start WeChat login, where will it come back to". It never
 * confirms participation: logging in is not joining, and the explicit confirm
 * stays a separate resident action.
 *
 * Login markers (`auth` / `auth_error`) are deliberately NOT read here. This hook
 * only mounts with the unauthenticated login card, and the page-level cleanup
 * strips the markers before that card mounts, so reading them here would lose the
 * failure notice. The page snapshots them once and passes them down instead.
 */
export function useActivityLoginReturn({
  activityId,
  inviteCode,
  inviteInvalid,
}: UseActivityLoginReturnOptions): UseActivityLoginReturnResult {
  const [availability, setAvailability] = useState<WechatLoginAvailability>({ status: 'loading' })
  const [pendingContext, setPendingContext] = useState<ActivityLoginContext | null>(() =>
    loadActivityLoginContext(),
  )
  const [availabilityAttempt, setAvailabilityAttempt] = useState(0)

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
    window.location.assign(request.url)
  }, [activityId, inviteCode, inviteInvalid])

  const retryAvailability = useCallback(() => {
    setAvailability({ status: 'loading' })
    setAvailabilityAttempt((attempt) => attempt + 1)
  }, [])

  return {
    availability,
    pendingContext,
    startWechatLogin,
    retryAvailability,
  }
}

