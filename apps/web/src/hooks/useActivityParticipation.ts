import { reportResidentSessionExpired } from '../services/residentSessionEvents'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  API_ERROR_CODES,
  API_ROUTES,
  PARTICIPATION_ROUTES,
  activityParticipationConfirmRequestSchema,
  activityParticipationConfirmResponseSchema,
  activityParticipationStateSchema,
  apiErrorSchema,
  type ActivityParticipationState,
} from '@sanchuang-dev/local-life-contracts'

/** The H5 talks to the API through the same-origin `/api` prefix. */
const API_PREFIX = '/api'

/**
 * Resident participation state for one activity.
 *
 * `unauthenticated` is a first-class state instead of an error: the page shows a
 * login call-to-action and must never auto-confirm participation for a visitor
 * who only opened a shared link.
 */
export type ParticipationLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ActivityParticipationState }

export type ParticipationConfirmResult =
  | { ok: true; created: boolean }
  | {
      ok: false
      message: string
      code: string | null
      status: number | null
    }

export type UseActivityParticipationResult = {
  state: ParticipationLoadState
  refresh: () => void
  confirm: (inviteCode?: string | null) => Promise<ParticipationConfirmResult>
  confirming: boolean
}

type UseActivityParticipationOptions = {
  /** Real activity id, or null while the activity itself is still loading. */
  activityId: string | null
  /** Session identity key. A changed key (login/logout) re-reads the state. */
  sessionKey: string | null
  /** True while the account session is still being read. */
  authLoading: boolean
}

function participationPath(route: string, activityId: string): string {
  return route.replace(':activityId', encodeURIComponent(activityId))
}

async function readErrorMessage(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null)
  const parsed = apiErrorSchema.safeParse(payload)
  if (parsed.success) return parsed.data.error.message
  return `参与状态请求失败（HTTP ${response.status}）`
}

async function readCsrfToken(): Promise<string> {
  const response = await fetch(`${API_PREFIX}${API_ROUTES.authCsrf}`, {
    credentials: 'include',
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(await readErrorMessage(response))
  const payload: unknown = await response.json().catch(() => null)
  const token =
    payload && typeof payload === 'object' && 'csrfToken' in payload
      ? (payload as { csrfToken?: unknown }).csrfToken
      : null
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('无法获取安全校验令牌，请刷新页面后重试')
  }
  return token
}

/**
 * Map the API's structured error to a resident-readable message. Every status
 * the confirm endpoint can return has an explicit branch so the H5 never shows
 * a silent failure or a fake success.
 */
function confirmErrorMessage(
  status: number,
  code: string | null,
  serverMessage: string | null,
): string {
  if (code === API_ERROR_CODES.teamFull) return '该三人团已满员，无法加入。'
  if (code === API_ERROR_CODES.activityUnavailable) {
    return '活动当前不可参与（可能未发布、已暂停或已结束）。'
  }
  if (code === API_ERROR_CODES.inviteInvalid) {
    return '邀请链接无效或已失效，请向邀请人重新获取。'
  }
  if (status === 401) return '登录状态已失效，请重新登录后再参与。'
  if (status === 403) return serverMessage ?? '当前账号无权参与本活动。'
  if (status === 429) return serverMessage ?? '操作过于频繁，请稍后再试。'
  if (status >= 500) return '参与服务暂时不可用，请稍后重试。'
  return serverMessage ?? `参与请求失败（HTTP ${status}）`
}

/**
 * Read and update the authenticated resident's participation in one activity.
 *
 * Identity always comes from the session cookie; the client sends no user id.
 * Reading (and opening/copying/sharing a link) never writes a participation —
 * only an explicit `confirm` POST does. The confirm request carries the session
 * CSRF token and is guarded against double submission.
 */
export function useActivityParticipation({
  activityId,
  sessionKey,
  authLoading,
}: UseActivityParticipationOptions): UseActivityParticipationResult {
  const [state, setState] = useState<ParticipationLoadState>({ status: 'idle' })
  const [confirming, setConfirming] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const inFlight = useRef(false)

  const refresh = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    if (!activityId || authLoading) {
      setState({ status: 'idle' })
      return
    }

    // Without a session the API would answer 401; do not send the read at all.
    // A visitor opening a shared link must not create or probe participation.
    if (!sessionKey) {
      setState({ status: 'unauthenticated' })
      return
    }

    let active = true
    const controller = new AbortController()

    const load = async () => {
      setState({ status: 'loading' })
      try {
        const response = await fetch(`${API_PREFIX}${participationPath(PARTICIPATION_ROUTES.state, activityId)}`, {
          signal: controller.signal,
          credentials: 'include',
          cache: 'no-store',
        })

        if (response.status === 401) {
          if (active) {
            reportResidentSessionExpired()
            setState({ status: 'unauthenticated' })
          }
          return
        }
        if (!response.ok) throw new Error(await readErrorMessage(response))

        const parsed = activityParticipationStateSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('参与状态数据格式异常，无法安全展示')

        if (active) setState({ status: 'ready', data: parsed.data })
      } catch (cause) {
        if (!active || controller.signal.aborted) return
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法读取参与状态',
        })
      }
    }

    void load()

    return () => {
      active = false
      controller.abort()
    }
  }, [activityId, sessionKey, authLoading, reloadToken])

  const confirm = useCallback(
    async (inviteCode?: string | null): Promise<ParticipationConfirmResult> => {
      if (!activityId) {
        return {
          ok: false,
          message: '活动信息尚未加载，暂时无法参与。',
          code: null,
          status: null,
        }
      }
      if (inFlight.current) {
        return {
          ok: false,
          message: '正在提交，请勿重复点击。',
          code: null,
          status: null,
        }
      }

      // Validate the body with the shared contract. Unknown fields (including a
      // forged userId) are rejected before any request is sent.
      const request = activityParticipationConfirmRequestSchema.safeParse(
        inviteCode ? { inviteCode } : {},
      )
      if (!request.success) {
        return {
          ok: false,
          message: '邀请码格式不正确，无法提交。',
          code: API_ERROR_CODES.inviteInvalid,
          status: 400,
        }
      }

      inFlight.current = true
      setConfirming(true)
      try {
        const csrfToken = await readCsrfToken()
        const response = await fetch(`${API_PREFIX}${participationPath(PARTICIPATION_ROUTES.confirm, activityId)}`, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify(request.data),
        })

        const payload: unknown = await response.json().catch(() => null)

        if (!response.ok) {
          const parsedError = apiErrorSchema.safeParse(payload)
          const code = parsedError.success ? parsedError.data.error.code : null
          const serverMessage = parsedError.success
            ? parsedError.data.error.message
            : null
          if (response.status === 401) {
            reportResidentSessionExpired()
            setState({ status: 'unauthenticated' })
          }
          return {
            ok: false,
            message: confirmErrorMessage(response.status, code, serverMessage),
            code,
            status: response.status,
          }
        }

        const parsed = activityParticipationConfirmResponseSchema.safeParse(payload)
        if (!parsed.success) {
          return {
            ok: false,
            message: '参与结果数据格式异常，请刷新后确认状态。',
            code: null,
            status: response.status,
          }
        }

        // The confirm response is the new server truth; render it directly
        // instead of re-reading and risking a flash of a stale state.
        setState({ status: 'ready', data: parsed.data.state })
        return { ok: true, created: parsed.data.created }
      } catch (cause) {
        return {
          ok: false,
          message:
            cause instanceof Error
              ? cause.message
              : '参与请求未完成，请检查网络后重试。',
          code: null,
          status: null,
        }
      } finally {
        inFlight.current = false
        setConfirming(false)
      }
    },
    [activityId],
  )

  return { state, refresh, confirm, confirming }
}
