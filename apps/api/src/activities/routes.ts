import { z } from 'zod'
import type { Hono } from 'hono'
import {
  ACTIVITY_ROUTES,
  API_ERROR_CODES,
  activityStatusSchema,
  activityTransitionRequestSchema,
  createActivityRequestSchema,
  updateActivityRequestSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import {
  ActivityError,
  createActivity,
  getAdminActivity,
  getPublicActivity,
  listActivityAudit,
  listActivityRuleVersions,
  listAdminActivities,
  listPublicActivities,
  transitionActivity,
  updateActivity,
  type ActivityOperator,
} from './service.js'

export interface ActivityRouteDeps {
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

const optionalUuid = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().uuid().optional(),
)

const optionalKeyword = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).max(80).optional(),
)

const publicListQuerySchema = z.object({
  communityId: optionalUuid,
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

const adminListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  communityId: optionalUuid,
  status: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    activityStatusSchema.optional(),
  ),
  keyword: optionalKeyword,
})

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const activityIdSchema = z.string().uuid()

/**
 * Registers the activity routes. Authentication, CSRF and the shared error envelope
 * come from `createApp` so there is exactly one session/permission implementation.
 */
export function registerActivityRoutes(
  app: Hono<AppBindings>,
  deps: ActivityRouteDeps,
): void {
  const { db, config, fail, validCsrf, bodySchemaError } = deps

  const failWithActivityError = (c: AppContext, error: unknown): Response => {
    if (error instanceof ActivityError) {
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

  const operatorOf = (guard: StaffGuard): ActivityOperator => ({
    userId: guard.session.userId,
    staffId: guard.staff.id,
    role: guard.staff.role === 'admin' ? 'admin' : 'operator',
  })

  const requireActivityId = (c: AppContext): string | Response => {
    const parsed = activityIdSchema.safeParse(c.req.param('activityId'))
    if (!parsed.success) {
      return fail(c, 404, API_ERROR_CODES.notFound, '活动不存在')
    }
    return parsed.data
  }

  /* ------------------------------- Public -------------------------------- */

  app.get(ACTIVITY_ROUTES.publicList, (c) => {
    const query = publicListQuerySchema.safeParse({
      communityId: c.req.query('communityId'),
      limit: c.req.query('limit'),
    })
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listPublicActivities(db, query.data))
    } catch (error) {
      return failWithActivityError(c, error)
    }
  })

  app.get(ACTIVITY_ROUTES.publicDetail, (c) => {
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    try {
      return c.json(getPublicActivity(db, activityId))
    } catch (error) {
      return failWithActivityError(c, error)
    }
  })

  /* -------------------------------- Admin -------------------------------- */

  app.get(ACTIVITY_ROUTES.adminList, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权管理活动')
    }
    const query = adminListQuerySchema.safeParse({
      page: c.req.query('page'),
      pageSize: c.req.query('pageSize'),
      communityId: c.req.query('communityId'),
      status: c.req.query('status'),
      keyword: c.req.query('keyword'),
    })
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listAdminActivities(db, operatorOf(guard), query.data))
    } catch (error) {
      return failWithActivityError(c, error)
    }
  })

  app.post(ACTIVITY_ROUTES.adminList, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权管理活动')
    }
    if (!validCsrf(c, config, guard.session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      createActivityRequestSchema,
    )
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '活动信息不正确')
    }
    try {
      return c.json(createActivity(db, operatorOf(guard), body), 201)
    } catch (error) {
      return failWithActivityError(c, error)
    }
  })

  app.get(ACTIVITY_ROUTES.adminDetail, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权管理活动')
    }
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    try {
      return c.json(getAdminActivity(db, operatorOf(guard), activityId))
    } catch (error) {
      return failWithActivityError(c, error)
    }
  })

  app.patch(ACTIVITY_ROUTES.adminDetail, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权管理活动')
    }
    if (!validCsrf(c, config, guard.session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      updateActivityRequestSchema,
    )
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '活动信息不正确')
    }
    try {
      return c.json(updateActivity(db, operatorOf(guard), activityId, body))
    } catch (error) {
      return failWithActivityError(c, error)
    }
  })

  app.post(ACTIVITY_ROUTES.adminPublish, async (c) => {
    return await runTransition(c, 'publish')
  })

  app.post(ACTIVITY_ROUTES.adminPause, async (c) => {
    return await runTransition(c, 'pause')
  })

  app.post(ACTIVITY_ROUTES.adminResume, async (c) => {
    return await runTransition(c, 'resume')
  })

  app.post(ACTIVITY_ROUTES.adminEnd, async (c) => {
    return await runTransition(c, 'end')
  })

  app.get(ACTIVITY_ROUTES.adminRuleVersions, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权管理活动')
    }
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    try {
      return c.json(listActivityRuleVersions(db, operatorOf(guard), activityId))
    } catch (error) {
      return failWithActivityError(c, error)
    }
  })

  app.get(ACTIVITY_ROUTES.adminAudit, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权管理活动')
    }
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    const query = auditQuerySchema.safeParse({ limit: c.req.query('limit') })
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listActivityAudit(db, operatorOf(guard), activityId, query.data.limit))
    } catch (error) {
      return failWithActivityError(c, error)
    }
  })

  async function runTransition(
    c: AppContext,
    action: 'publish' | 'pause' | 'resume' | 'end',
  ): Promise<Response> {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权管理活动')
    }
    if (!validCsrf(c, config, guard.session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      activityTransitionRequestSchema,
    )
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '请求信息不正确')
    }
    try {
      return c.json(
        transitionActivity(
          db,
          operatorOf(guard),
          activityId,
          action,
          body.expectedUpdatedAt,
        ),
      )
    } catch (error) {
      return failWithActivityError(c, error)
    }
  }
}
