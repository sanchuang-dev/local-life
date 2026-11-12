import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  REWARD_ROUTES,
  activityCheckinRequestSchema,
  activityCheckinRevokeRequestSchema,
  activityCheckinSchema,
  activityCheckinStateSchema,
  activityCheckinVerifyRequestSchema,
  activityRewardClaimRequestSchema,
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
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import {
  RewardError,
  appendGrantDispute,
  claimTeamReward,
  getAdminRewardOverview,
  getCheckinState,
  getMyCredential,
  getTeamRewardState,
  listActivityCheckins,
  recordCheckin,
  redeemCredential,
  requireStaffActivityScope,
  revokeCheckin,
  revokeGrant,
  verifyCheckin,
  type RewardStaffActor,
} from './service.js'

export interface RewardRouteDeps {
  db: AppDatabase
  config: ApiConfig
  fail: (
    c: AppContext,
    status: HttpErrorStatus,
    code: ApiErrorCode,
    message: string,
  ) => Response
  validCsrf: (c: AppContext, config: ApiConfig, session?: AuthSession | null) => boolean
  bodySchemaError: <T>(value: unknown, schema: z.ZodType<T>) => T | null
}

interface StaffGuard {
  session: AuthSession
  staff: NonNullable<AuthSession['staff']>
}

const idSchema = z.string().uuid()

/**
 * Registers the check-in / team reward / prize fulfilment HTTP surface (#62).
 *
 * Boundaries enforced here (the service layer re-checks them; neither alone is
 * trusted):
 *
 * - **Resident identity is session-only.** No route accepts a `userId` in the
 *   path, query string or body. Every request body is a strict contracts schema,
 *   so a forged `userId` fails parsing (400) instead of being silently ignored.
 * - **Staff scope is server-side.** `admin` may manage any community; `operator`
 *   and `grid_worker` only the communities in `staff_community_assignments`. A
 *   cross-community attempt is a 403 that is audited as `reward.access_denied`
 *   before the response is returned.
 * - **Every write needs CSRF + a trusted Origin.** `validCsrf` already fails
 *   closed on a missing/mismatched double-submit token and on an Origin outside
 *   the configured allowlist, so the two guards can never drift apart.
 * - **Responses are parsed with the shared contracts schemas before they are
 *   sent**, so a service drift surfaces as a 500 instead of an off-contract
 *   payload.
 */
export function registerRewardRoutes(app: Hono<AppBindings>, deps: RewardRouteDeps): void {
  const { db, config, fail, validCsrf, bodySchemaError } = deps

  const failWithRewardError = (c: AppContext, error: unknown): Response => {
    if (error instanceof RewardError) {
      return fail(c, error.status, error.code, error.message)
    }
    throw error
  }

  /**
   * A `POST` with no body must mean "empty object", not "malformed JSON": the
   * claim body is `strictObject({})` and the verify body has only an optional
   * note, so `Content-Length: 0` is a legitimate request. Anything that *does*
   * carry a body still has to parse as JSON.
   */
  const jsonOrEmpty = async (c: AppContext): Promise<unknown> => {
    const text = await c.req.text()
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  const requireSession = (c: AppContext): AuthSession | Response => {
    const session = c.get('authSession')
    if (!session) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录居民账户')
    }
    return session
  }

  const requireStaff = (c: AppContext): StaffGuard | Response => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    return { session, staff: session.staff }
  }

  const requireCsrf = (c: AppContext, session: AuthSession): Response | null => {
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败，请刷新页面后重试')
    }
    return null
  }

  const requireActivityId = (c: AppContext): string | Response => {
    const parsed = idSchema.safeParse(c.req.param('activityId'))
    if (!parsed.success) {
      return fail(c, 404, API_ERROR_CODES.notFound, '活动不存在')
    }
    return parsed.data
  }

  const requirePathId = (c: AppContext, key: 'checkinId' | 'grantId'): string | Response => {
    const parsed = idSchema.safeParse(c.req.param(key))
    if (!parsed.success) {
      return fail(c, 404, API_ERROR_CODES.notFound, key === 'checkinId' ? '签到不存在' : '奖励不存在')
    }
    return parsed.data
  }

  /**
   * Community scope of a staff actor. `admin` is global; an operator or grid
   * worker must be assigned to the activity's community.
   *
   * The decision lives in the service layer (`requireStaffActivityScope`) so a
   * denied probe is audited exactly once as `reward.access_denied` whether it
   * arrives here or through a service-internal guard. The route wraps it only to
   * translate `RewardError` into the shared error envelope.
   */
  const requireActivityScope = (
    c: AppContext,
    guard: StaffGuard,
    activityId: string,
  ): Response | null => {
    try {
      requireStaffActivityScope(db, actorOf(guard), activityId)
      return null
    } catch (error) {
      return failWithRewardError(c, error)
    }
  }

  const actorOf = (guard: StaffGuard): RewardStaffActor => ({
    userId: guard.session.userId,
    staffId: guard.staff.id,
    role: guard.staff.role,
  })

  /* ------------------------------- Resident ------------------------------- */

  app.get(REWARD_ROUTES.checkinState, (c) => {
    const session = requireSession(c)
    if (session instanceof Response) return session
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId

    try {
      return c.json(
        activityCheckinStateSchema.parse(
          getCheckinState(db, { activityId, userId: session.userId }),
        ),
      )
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })

  app.post(REWARD_ROUTES.checkin, async (c) => {
    const session = requireSession(c)
    if (session instanceof Response) return session
    const csrfFailure = requireCsrf(c, session)
    if (csrfFailure) return csrfFailure
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId

    // A strict body: `{ userId: '...' }` fails parsing instead of being dropped.
    const body = bodySchemaError(await jsonOrEmpty(c), activityCheckinRequestSchema)
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '签到信息不正确')
    }

    try {
      const result = recordCheckin(db, {
        activityId,
        // Session identity only: the request can never name the resident.
        userId: session.userId,
        ...(body.note === undefined ? {} : { note: body.note }),
      })
      return c.json(activityCheckinStateSchema.parse(result.state))
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })

  app.get(REWARD_ROUTES.teamReward, (c) => {
    const session = requireSession(c)
    if (session instanceof Response) return session
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId

    try {
      return c.json(
        teamRewardStateSchema.parse(
          getTeamRewardState(db, { activityId, userId: session.userId }),
        ),
      )
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })

  app.post(REWARD_ROUTES.claim, async (c) => {
    const session = requireSession(c)
    if (session instanceof Response) return session
    const csrfFailure = requireCsrf(c, session)
    if (csrfFailure) return csrfFailure
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId

    // The claim body is an empty strict object: naming a user or a team is a
    // contract violation, not an ignored extra field.
    const body = bodySchemaError(await jsonOrEmpty(c), activityRewardClaimRequestSchema)
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '领奖请求不正确')
    }

    try {
      return c.json(
        activityRewardClaimResponseSchema.parse(
          claimTeamReward(db, { activityId, userId: session.userId }),
        ),
      )
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })

  app.get(REWARD_ROUTES.credential, (c) => {
    const session = requireSession(c)
    if (session instanceof Response) return session
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId

    try {
      const credential = getMyCredential(db, { activityId, userId: session.userId })
      if (!credential) {
        return fail(c, 404, API_ERROR_CODES.notFound, '尚未领取核销凭据')
      }
      return c.json(activityRewardCredentialSchema.parse(credential))
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })

  /* --------------------------------- Staff -------------------------------- */

  app.get(REWARD_ROUTES.adminCheckins, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    const scopeFailure = requireActivityScope(c, guard, activityId)
    if (scopeFailure) return scopeFailure

    try {
      return c.json(
        adminActivityCheckinListSchema.parse(
          listActivityCheckins(db, actorOf(guard), activityId),
        ),
      )
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })

  app.post(REWARD_ROUTES.adminCheckinVerify, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    const checkinId = requirePathId(c, 'checkinId')
    if (checkinId instanceof Response) return checkinId
    const scopeFailure = requireActivityScope(c, guard, activityId)
    if (scopeFailure) return scopeFailure

    const body = bodySchemaError(await jsonOrEmpty(c), activityCheckinVerifyRequestSchema)
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '核验信息不正确')
    }

    try {
      return c.json(
        activityCheckinSchema.parse(
          verifyCheckin(db, actorOf(guard), {
            activityId,
            checkinId,
            ...(body.note === undefined ? {} : { note: body.note }),
          }),
        ),
      )
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })

  app.post(REWARD_ROUTES.adminCheckinRevoke, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    const checkinId = requirePathId(c, 'checkinId')
    if (checkinId instanceof Response) return checkinId
    const scopeFailure = requireActivityScope(c, guard, activityId)
    if (scopeFailure) return scopeFailure

    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      activityCheckinRevokeRequestSchema,
    )
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '撤销原因不正确')
    }

    try {
      return c.json(
        activityCheckinSchema.parse(
          revokeCheckin(db, actorOf(guard), { activityId, checkinId, reason: body.reason }),
        ),
      )
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })

  app.get(REWARD_ROUTES.adminRewards, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    const scopeFailure = requireActivityScope(c, guard, activityId)
    if (scopeFailure) return scopeFailure

    try {
      return c.json(
        adminActivityRewardOverviewSchema.parse(
          getAdminRewardOverview(db, actorOf(guard), activityId),
        ),
      )
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })

  app.post(REWARD_ROUTES.adminGrantRevoke, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    const grantId = requirePathId(c, 'grantId')
    if (grantId instanceof Response) return grantId
    const scopeFailure = requireActivityScope(c, guard, activityId)
    if (scopeFailure) return scopeFailure

    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      activityRewardGrantRevokeRequestSchema,
    )
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '撤销原因不正确')
    }

    try {
      return c.json(
        activityRewardGrantSchema.parse(
          revokeGrant(db, actorOf(guard), { activityId, grantId, reason: body.reason }),
        ),
      )
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })

  app.post(REWARD_ROUTES.adminGrantDisputes, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    const grantId = requirePathId(c, 'grantId')
    if (grantId instanceof Response) return grantId
    const scopeFailure = requireActivityScope(c, guard, activityId)
    if (scopeFailure) return scopeFailure

    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      activityRewardDisputeRequestSchema,
    )
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '争议信息不正确')
    }

    try {
      return c.json(
        activityRewardDisputeThreadSchema.parse(
          appendGrantDispute(db, actorOf(guard), {
            activityId,
            grantId,
            decision: body.decision,
            reason: body.reason,
            ...(body.note === undefined ? {} : { note: body.note }),
          }),
        ),
      )
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })

  /* -------------------------------- Redeem -------------------------------- */

  /**
   * Staff redemption by code. There is deliberately **no** activity id in the
   * URL: the code alone identifies the activity, so the community scope check
   * must happen in the service layer after the hash lookup. A cross-community
   * attempt therefore still ends in 403 + audit, never in a silent success.
   */
  app.post(REWARD_ROUTES.redeem, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure

    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      rewardRedeemRequestSchema,
    )
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '核销信息不正确')
    }

    try {
      return c.json(
        rewardRedeemResponseSchema.parse(
          redeemCredential(db, actorOf(guard), {
            code: body.code,
            ...(body.note === undefined ? {} : { note: body.note }),
          }),
        ),
      )
    } catch (error) {
      return failWithRewardError(c, error)
    }
  })
}
