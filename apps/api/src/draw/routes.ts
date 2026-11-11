import { z } from 'zod'
import type { Hono } from 'hono'
import {
  ACTIVITY_DRAW_ROUTES,
  API_ERROR_CODES,
  createActivityDrawPrizeRequestSchema,
  saveActivityDrawPoolRequestSchema,
  updateActivityDrawPrizeRequestSchema,
  drawAttemptRequestSchema,
  drawStaffCodeRequestSchema,
  drawStaffRevokeRequestSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import type { LocalActor } from '../local/shared.js'
import { LocalError } from '../local/shared.js'
import { ResidentCommunityError } from '../resident-community/service.js'
import { enterDailyDraw, getMyDrawHistory, getMyDrawState, verifyDrawCredential, redeemDrawCredential, revokeDrawCredential } from './engine.js'
import {
  createDrawPrize,
  getAdminDrawPool,
  getPublicDrawPool,
  saveDrawPool,
  updateDrawPrize,
} from './service.js'

export interface DrawRouteDeps {
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
 * Registers the real draw prize-pool routes (LL-LOT-001, Issue #173).
 *
 * The domain is configuration-only: there is deliberately no resident draw POST
 * and no result/credential generation. Reads and writes reuse the shared session,
 * CSRF, community-scope and error envelope from `createApp`.
 */
export function registerDrawRoutes(app: Hono<AppBindings>, deps: DrawRouteDeps): void {
  const { db, config, fail, validCsrf, bodySchemaError } = deps

  const failWithDrawError = (c: AppContext, error: unknown): Response => {
    if (error instanceof LocalError) {
      return fail(c, error.status, error.code, error.message)
    }
    // #171 LL-IDENTITY-001: entering a draw is a community-scoped write, so the
    // shared confirmed-community guard can refuse it. Without this mapping the
    // refusal escapes as a 500 `internal_error`, which would look like a server
    // fault instead of "confirm your community first".
    if (error instanceof ResidentCommunityError) {
      return fail(c, error.status, error.code, error.message)
    }
    throw error
  }

  const requireStaff = (c: AppContext): StaffGuard | Response => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    return { session, staff: session.staff }
  }

  const requireDrawManager = (c: AppContext): StaffGuard | Response => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权管理抽奖奖品池')
    }
    return guard
  }

  const actorOf = (guard: StaffGuard): LocalActor => ({
    userId: guard.session.userId,
    staffId: guard.staff.id,
    role: guard.staff.role,
  })

  const requireCsrf = (c: AppContext, guard: StaffGuard): Response | null => {
    if (!validCsrf(c, config, guard.session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    return null
  }

  const requireParam = (
    c: AppContext,
    key: 'activityId' | 'prizeId',
    message: string,
  ): string | Response => {
    const parsed = idSchema.safeParse(c.req.param(key))
    if (!parsed.success) {
      return fail(c, 404, API_ERROR_CODES.notFound, message)
    }
    return parsed.data
  }


  /* LL-LOT-002: all resident identity comes from the existing secure cookie. */
  const requireResident = (c: AppContext): AuthSession | Response => {
    const session = c.get('authSession')
    if (!session) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录居民账户')
    return session
  }
  const csrfFor = (c: AppContext, session: AuthSession): Response | null => {
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 或来源校验失败')
    }
    return null
  }

  app.get(ACTIVITY_DRAW_ROUTES.state, (c) => {
    const activityId = requireParam(c, 'activityId', '活动不存在')
    if (activityId instanceof Response) return activityId
    try {
      return c.json(getMyDrawState(db, activityId, c.get('authSession')?.userId ?? null, config.drawCredentialSecret))
    } catch (error) { return failWithDrawError(c, error) }
  })

  app.get(ACTIVITY_DRAW_ROUTES.history, (c) => {
    const session = requireResident(c)
    if (session instanceof Response) return session
    const activityId = requireParam(c, 'activityId', '活动不存在')
    if (activityId instanceof Response) return activityId
    try {
      return c.json(getMyDrawHistory(db, activityId, session.userId, config.drawCredentialSecret))
    } catch (error) { return failWithDrawError(c, error) }
  })

  app.post(ACTIVITY_DRAW_ROUTES.enter, async (c) => {
    const session = requireResident(c)
    if (session instanceof Response) return session
    const rejected = csrfFor(c, session)
    if (rejected) return rejected
    const activityId = requireParam(c, 'activityId', '活动不存在')
    if (activityId instanceof Response) return activityId
    const body = bodySchemaError(await c.req.json().catch(() => null), drawAttemptRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '抽奖请求格式不正确')
    try {
      return c.json(enterDailyDraw(db, {
        activityId, userId: session.userId, idempotencyKey: body.idempotencyKey,
        secret: config.drawCredentialSecret,
      }))
    } catch (error) { return failWithDrawError(c, error) }
  })

  app.post(ACTIVITY_DRAW_ROUTES.adminVerify, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const rejected = csrfFor(c, guard.session)
    if (rejected) return rejected
    const activityId = requireParam(c, 'activityId', '活动不存在')
    if (activityId instanceof Response) return activityId
    const body = bodySchemaError(await c.req.json().catch(() => null), drawStaffCodeRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '核销码格式不正确')
    try { return c.json(verifyDrawCredential(db, actorOf(guard), activityId, body.code)) }
    catch (error) { return failWithDrawError(c, error) }
  })

  app.post(ACTIVITY_DRAW_ROUTES.adminRedeem, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const rejected = csrfFor(c, guard.session)
    if (rejected) return rejected
    const activityId = requireParam(c, 'activityId', '活动不存在')
    if (activityId instanceof Response) return activityId
    const body = bodySchemaError(await c.req.json().catch(() => null), drawStaffCodeRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '核销码格式不正确')
    try { return c.json(redeemDrawCredential(db, actorOf(guard), activityId, body.code)) }
    catch (error) { return failWithDrawError(c, error) }
  })

  app.post(ACTIVITY_DRAW_ROUTES.adminRevoke, async (c) => {
    const guard = requireDrawManager(c)
    if (guard instanceof Response) return guard
    const rejected = csrfFor(c, guard.session)
    if (rejected) return rejected
    const activityId = requireParam(c, 'activityId', '活动不存在')
    if (activityId instanceof Response) return activityId
    const body = bodySchemaError(await c.req.json().catch(() => null), drawStaffRevokeRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '撤销原因或凭据不正确')
    try { return c.json(revokeDrawCredential(db, actorOf(guard), activityId, body.credentialId, body.reason)) }
    catch (error) { return failWithDrawError(c, error) }
  })

  /* ------------------------------- Resident ------------------------------- */

  app.get(ACTIVITY_DRAW_ROUTES.publicPool, (c) => {
    const activityId = requireParam(c, 'activityId', '活动不存在')
    if (activityId instanceof Response) return activityId
    try {
      return c.json(getPublicDrawPool(db, activityId))
    } catch (error) {
      return failWithDrawError(c, error)
    }
  })

  /* ------------------------------- Back office ----------------------------- */

  app.get(ACTIVITY_DRAW_ROUTES.adminPool, (c) => {
    const guard = requireDrawManager(c)
    if (guard instanceof Response) return guard
    const activityId = requireParam(c, 'activityId', '活动不存在')
    if (activityId instanceof Response) return activityId
    try {
      return c.json(getAdminDrawPool(db, actorOf(guard), activityId))
    } catch (error) {
      return failWithDrawError(c, error)
    }
  })

  app.post(ACTIVITY_DRAW_ROUTES.adminSavePool, async (c) => {
    const guard = requireDrawManager(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const activityId = requireParam(c, 'activityId', '活动不存在')
    if (activityId instanceof Response) return activityId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      saveActivityDrawPoolRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '抽奖配置不正确')
    try {
      return c.json(saveDrawPool(db, actorOf(guard), activityId, body))
    } catch (error) {
      return failWithDrawError(c, error)
    }
  })

  app.post(ACTIVITY_DRAW_ROUTES.adminCreatePrize, async (c) => {
    const guard = requireDrawManager(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const activityId = requireParam(c, 'activityId', '活动不存在')
    if (activityId instanceof Response) return activityId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      createActivityDrawPrizeRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '奖品信息不正确')
    try {
      return c.json(createDrawPrize(db, actorOf(guard), activityId, body), 201)
    } catch (error) {
      return failWithDrawError(c, error)
    }
  })

  app.patch(ACTIVITY_DRAW_ROUTES.adminPrize, async (c) => {
    const guard = requireDrawManager(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const activityId = requireParam(c, 'activityId', '活动不存在')
    if (activityId instanceof Response) return activityId
    const prizeId = requireParam(c, 'prizeId', '奖品不存在')
    if (prizeId instanceof Response) return prizeId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      updateActivityDrawPrizeRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '奖品信息不正确')
    try {
      return c.json(updateDrawPrize(db, actorOf(guard), activityId, prizeId, body))
    } catch (error) {
      return failWithDrawError(c, error)
    }
  })
}
