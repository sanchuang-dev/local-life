import {
  REWARD_ROUTES,
  activityCheckinRequestSchema,
  activityCheckinRevokeRequestSchema,
  activityCheckinSchema,
  activityCheckinStateSchema,
  activityCheckinVerifyRequestSchema,
  activityRewardClaimResponseSchema,
  activityRewardCredentialSchema,
  activityRewardDisputeRequestSchema,
  activityRewardDisputeThreadSchema,
  activityRewardGrantRevokeRequestSchema,
  activityRewardGrantSchema,
  adminActivityCheckinListSchema,
  adminActivityRewardOverviewSchema,
  rewardRedeemRequestSchema,
  rewardRedeemResponseSchema,
  teamRewardStateSchema,
  type ActivityCheckin,
  type ActivityCheckinState,
  type ActivityRewardClaimResponse,
  type ActivityRewardCredential,
  type ActivityRewardDisputeThread,
  type ActivityRewardGrant,
  type AdminActivityCheckinList,
  type AdminActivityRewardOverview,
  type RewardRedeemResponse,
  type TeamRewardState,
} from '@sanchuang-dev/local-life-contracts'
import { apiErrorFromResponse } from '../hooks/apiError'

/**
 * Real check-in / team-reward / fulfilment transport for the resident H5 and
 * the mobile workbench.
 *
 * Every path comes from `REWARD_ROUTES` and every response is parsed with the
 * shared contracts schema, so a drifted payload becomes an explicit error
 * instead of a half-rendered screen. Resident identity is always the session
 * cookie: no call in this module accepts a `userId`, and every write sends the
 * real CSRF double-submit token.
 */

/** The H5 talks to the API through the same-origin `/api` prefix. */
const API_PREFIX = '/api'

export class RewardApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly requestId: string | null

  constructor(message: string, status: number, code: string | null, requestId: string | null) {
    super(message)
    this.name = 'RewardApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export function isRewardApiError(cause: unknown): cause is RewardApiError {
  return cause instanceof RewardApiError
}

/** Structural view of a zod schema, so this app needs no direct zod dependency. */
interface SafelyParsable<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false }
}

export type RewardPathParams = {
  activityId?: string
  checkinId?: string
  grantId?: string
}

export function rewardApiPath(route: string, params: RewardPathParams = {}): string {
  const path = route.replace(/:activityId|:checkinId|:grantId/gu, (key) => {
    const value = params[key.slice(1) as keyof RewardPathParams]
    if (!value) throw new Error(`缺少路径参数 ${key}`)
    return encodeURIComponent(value)
  })
  return `${API_PREFIX}${path}`
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
  const headers = new Headers({ accept: 'application/json' })
  if (body !== undefined) headers.set('content-type', 'application/json')
  if (method !== 'GET') {
    if (!csrfToken) {
      throw new RewardApiError('登录状态已失效，请重新登录', 401, 'unauthorized', null)
    }
    headers.set('x-csrf-token', csrfToken)
  }

  const response = await fetch(path, {
    method,
    signal,
    credentials: 'include',
    cache: 'no-store',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  if (!response.ok) {
    const parsed = await apiErrorFromResponse(response, `${label}失败`)
    throw new RewardApiError(parsed.message, parsed.status, parsed.code, parsed.requestId)
  }

  const payload: unknown = await response.json().catch(() => null)
  const result = parse.safeParse(payload)
  if (!result.success) {
    throw new RewardApiError(`${label}数据格式异常，无法安全展示`, response.status, null, null)
  }
  return result.data
}

/* -------------------------------- Resident -------------------------------- */

/** GET /activities/:activityId/checkin — the resident's own check-in state. */
export function getCheckinState(
  activityId: string,
  signal?: AbortSignal,
): Promise<ActivityCheckinState> {
  return requestReward(
    rewardApiPath(REWARD_ROUTES.checkinState, { activityId }),
    activityCheckinStateSchema,
    '签到状态',
    { signal },
  )
}

/**
 * POST /activities/:activityId/checkin — records a real self check-in.
 *
 * A resident check-in lands with `verifiedAt = null`, so it does **not** count
 * towards the three-check-in reward requirement until staff verify it on site.
 * The response is the same state shape as the GET, so callers can render the
 * server truth directly.
 */
export function recordCheckin(
  csrfToken: string,
  activityId: string,
  note?: string,
): Promise<ActivityCheckinState> {
  const body = activityCheckinRequestSchema.parse(note ? { note } : {})
  return requestReward(
    rewardApiPath(REWARD_ROUTES.checkin, { activityId }),
    activityCheckinStateSchema,
    '签到',
    { method: 'POST', csrfToken, body },
  )
}

/** GET /activities/:activityId/rewards — team qualification, grant, credential. */
export function getTeamRewardState(
  activityId: string,
  signal?: AbortSignal,
): Promise<TeamRewardState> {
  return requestReward(
    rewardApiPath(REWARD_ROUTES.teamReward, { activityId }),
    teamRewardStateSchema,
    '团队奖励状态',
    { signal },
  )
}

/** POST /activities/:activityId/rewards/claim — idempotent claim, returns the code once. */
export function claimTeamReward(
  csrfToken: string,
  activityId: string,
): Promise<ActivityRewardClaimResponse> {
  return requestReward(
    rewardApiPath(REWARD_ROUTES.claim, { activityId }),
    activityRewardClaimResponseSchema,
    '领取奖励',
    { method: 'POST', csrfToken, body: {} },
  )
}

/** GET /activities/:activityId/rewards/credential — masked credential metadata only. */
export function getMyCredential(
  activityId: string,
  signal?: AbortSignal,
): Promise<ActivityRewardCredential> {
  return requestReward(
    rewardApiPath(REWARD_ROUTES.credential, { activityId }),
    activityRewardCredentialSchema,
    '核销凭据',
    { signal },
  )
}

/* --------------------------------- Staff ---------------------------------- */

/** GET /admin/activities/:activityId/checkins — check-ins plus verification counts. */
export function listActivityCheckins(
  activityId: string,
  signal?: AbortSignal,
): Promise<AdminActivityCheckinList> {
  return requestReward(
    rewardApiPath(REWARD_ROUTES.adminCheckins, { activityId }),
    adminActivityCheckinListSchema,
    '签到列表',
    { signal },
  )
}

/** POST .../checkins/:checkinId/verify — only verified check-ins count for a reward. */
export function verifyCheckin(
  csrfToken: string,
  activityId: string,
  checkinId: string,
  note?: string,
): Promise<ActivityCheckin> {
  const body = activityCheckinVerifyRequestSchema.parse(note ? { note } : {})
  return requestReward(
    rewardApiPath(REWARD_ROUTES.adminCheckinVerify, { activityId, checkinId }),
    activityCheckinSchema,
    '签到核验',
    { method: 'POST', csrfToken, body },
  )
}

/** POST .../checkins/:checkinId/revoke — a revoked check-in stops counting. */
export function revokeCheckin(
  csrfToken: string,
  activityId: string,
  checkinId: string,
  reason: string,
): Promise<ActivityCheckin> {
  const body = activityCheckinRevokeRequestSchema.parse({ reason })
  return requestReward(
    rewardApiPath(REWARD_ROUTES.adminCheckinRevoke, { activityId, checkinId }),
    activityCheckinSchema,
    '撤销签到',
    { method: 'POST', csrfToken, body },
  )
}

/** GET /admin/activities/:activityId/rewards — frozen plan, stock, budget, grants. */
export function getAdminRewardOverview(
  activityId: string,
  signal?: AbortSignal,
): Promise<AdminActivityRewardOverview> {
  return requestReward(
    rewardApiPath(REWARD_ROUTES.adminRewards, { activityId }),
    adminActivityRewardOverviewSchema,
    '奖励概览',
    { signal },
  )
}

/** POST .../rewards/grants/:grantId/revoke — audited revocation of one grant. */
export function revokeRewardGrant(
  csrfToken: string,
  activityId: string,
  grantId: string,
  reason: string,
): Promise<ActivityRewardGrant> {
  const body = activityRewardGrantRevokeRequestSchema.parse({ reason })
  return requestReward(
    rewardApiPath(REWARD_ROUTES.adminGrantRevoke, { activityId, grantId }),
    activityRewardGrantSchema,
    '撤销奖励',
    { method: 'POST', csrfToken, body },
  )
}

/** POST .../rewards/grants/:grantId/disputes — append-only dispute entry. */
export function appendGrantDispute(
  csrfToken: string,
  activityId: string,
  grantId: string,
  input: { decision: 'opened' | 'reversed' | 'dismissed'; reason: string; note?: string },
): Promise<ActivityRewardDisputeThread> {
  const body = activityRewardDisputeRequestSchema.parse(input)
  return requestReward(
    rewardApiPath(REWARD_ROUTES.adminGrantDisputes, { activityId, grantId }),
    activityRewardDisputeThreadSchema,
    '奖励争议',
    { method: 'POST', csrfToken, body },
  )
}

/**
 * POST /rewards/redeem — one-time redemption of a 10-character code.
 *
 * There is deliberately no activity id: the code alone resolves the activity and
 * its community, so a grid worker can redeem on site without picking an activity
 * first. The server still rejects an out-of-scope code with 403.
 */
export function redeemCredentialCode(
  csrfToken: string,
  code: string,
  note?: string,
): Promise<RewardRedeemResponse> {
  const body = rewardRedeemRequestSchema.parse(note ? { code, note } : { code })
  return requestReward(
    rewardApiPath(REWARD_ROUTES.redeem),
    rewardRedeemResponseSchema,
    '核销',
    { method: 'POST', csrfToken, body },
  )
}
