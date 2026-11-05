import {
  REWARD_ROUTES,
  adminActivityCheckinListSchema,
  adminActivityRewardOverviewSchema,
  activityCheckinSchema,
  activityRewardDisputeThreadSchema,
  activityRewardGrantSchema,
  apiErrorSchema,
  type ActivityCheckin,
  type ActivityRewardDisputeThread,
  type ActivityRewardGrant,
  type AdminActivityCheckinList,
  type AdminActivityRewardOverview,
  type RewardDisputeDecision,
} from '@sanchuang-dev/local-life-contracts'
import { ActivityApiError } from './activities'

/**
 * Admin/operator transport for the LL-MVP-006 fulfilment endpoints.
 *
 * Every path comes from the shared `REWARD_ROUTES` table and every response is
 * parsed with the contracts schema, so a drifted payload becomes an explicit
 * error instead of a table that silently renders nothing. Writes always carry
 * the real session CSRF token; a 401/403 is thrown with the server message so a
 * page can render the real permission state.
 */

/** Structural view of a zod schema, so this app needs no direct zod dependency. */
interface SafelyParsable<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false }
}

type PathParams = { activityId?: string; checkinId?: string; grantId?: string }

function rewardPath(route: string, params: PathParams): string {
  const path = route.replace(/:activityId|:checkinId|:grantId/gu, (key) => {
    const value = params[key.slice(1) as keyof PathParams]
    if (!value) throw new Error(`缺少路径参数 ${key}`)
    return encodeURIComponent(value)
  })
  return `/api${path}`
}

interface RewardRequestOptions {
  method?: 'GET' | 'POST'
  csrfToken?: string
  body?: unknown
  signal?: AbortSignal
}

async function requestReward<T>(
  path: string,
  parse: SafelyParsable<T>,
  label: string,
  options: RewardRequestOptions = {},
): Promise<T> {
  const { method = 'GET', csrfToken, body, signal } = options
  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'include',
      signal,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new ActivityApiError(0, 'network_error', `无法连接${label}接口，请稍后重试。`)
  }

  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload)
    throw new ActivityApiError(
      response.status,
      parsed.success ? parsed.data.error.code : 'http_error',
      parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）`,
    )
  }
  const result = parse.safeParse(payload)
  if (!result.success) {
    throw new ActivityApiError(
      response.status,
      'invalid_response',
      `${label}响应与共享契约不一致，已拒绝渲染。`,
    )
  }
  return result.data
}

/** GET /admin/activities/:activityId/rewards — frozen plan, stock and grants. */
export function getRewardOverview(
  activityId: string,
  signal?: AbortSignal,
): Promise<AdminActivityRewardOverview> {
  return requestReward(
    rewardPath(REWARD_ROUTES.adminRewards, { activityId }),
    adminActivityRewardOverviewSchema,
    '奖励履约总览',
    { signal },
  )
}

/** GET /admin/activities/:activityId/checkins — real check-ins with counts. */
export function listActivityCheckins(
  activityId: string,
  signal?: AbortSignal,
): Promise<AdminActivityCheckinList> {
  return requestReward(
    rewardPath(REWARD_ROUTES.adminCheckins, { activityId }),
    adminActivityCheckinListSchema,
    '签到记录',
    { signal },
  )
}

/** POST .../checkins/:checkinId/verify — only verified check-ins count. */
export function verifyCheckin(
  csrfToken: string,
  activityId: string,
  checkinId: string,
  note?: string,
): Promise<ActivityCheckin> {
  return requestReward(
    rewardPath(REWARD_ROUTES.adminCheckinVerify, { activityId, checkinId }),
    activityCheckinSchema,
    '签到核验',
    {
      method: 'POST',
      csrfToken,
      body: note && note.trim() ? { note: note.trim() } : {},
    },
  )
}

/** POST .../checkins/:checkinId/revoke — the reason is mandatory (2-200 chars). */
export function revokeCheckin(
  csrfToken: string,
  activityId: string,
  checkinId: string,
  reason: string,
): Promise<ActivityCheckin> {
  return requestReward(
    rewardPath(REWARD_ROUTES.adminCheckinRevoke, { activityId, checkinId }),
    activityCheckinSchema,
    '撤销签到',
    { method: 'POST', csrfToken, body: { reason } },
  )
}

/** POST .../rewards/grants/:grantId/revoke — reason 2-500 chars. */
export function revokeRewardGrant(
  csrfToken: string,
  activityId: string,
  grantId: string,
  reason: string,
): Promise<ActivityRewardGrant> {
  return requestReward(
    rewardPath(REWARD_ROUTES.adminGrantRevoke, { activityId, grantId }),
    activityRewardGrantSchema,
    '撤销奖励',
    { method: 'POST', csrfToken, body: { reason } },
  )
}

/** POST .../rewards/grants/:grantId/disputes — append-only thread. */
export function appendGrantDispute(
  csrfToken: string,
  activityId: string,
  grantId: string,
  decision: RewardDisputeDecision,
  reason: string,
  note?: string,
): Promise<ActivityRewardDisputeThread> {
  return requestReward(
    rewardPath(REWARD_ROUTES.adminGrantDisputes, { activityId, grantId }),
    activityRewardDisputeThreadSchema,
    '奖励争议处理',
    { method: 'POST', csrfToken, body: { decision, reason, ...(note ? { note } : {}) } },
  )
}
