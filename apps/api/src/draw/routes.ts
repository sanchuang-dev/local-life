import { z } from 'zod'
import type { Hono } from 'hono'
import {
  ACTIVITY_DRAW_ROUTES,
  API_ERROR_CODES,
  createActivityDrawPrizeRequestSchema,
  saveActivityDrawPoolRequestSchema,
  updateActivityDrawPrizeRequestSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import type { LocalActor } from '../local/shared.js'
import { LocalError } from '../local/shared.js'
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
