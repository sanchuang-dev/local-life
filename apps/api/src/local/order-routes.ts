import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  LOCAL_ORDER_ROUTES,
  createLocalOrderOnBehalfRequestSchema,
  createLocalOrderRequestSchema,
  localOrderListQuerySchema,
  localOrderVerifyRequestSchema,
  updateLocalOrderStatusRequestSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import {
  getMyOrder,
  getStaffOrder,
  listMyOrders,
  listOrderEvents,
  listStaffOrders,
  registerOrderOnBehalf,
  registerResidentOrder,
  updateOrderStatus,
  verifyOrder,
} from './orders.js'
import { LocalError, type LocalActor } from './shared.js'
import { ResidentCommunityError } from '../resident-community/service.js'

export interface LocalOrderRouteDeps {
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

const idSchema = z.string().uuid()

interface StaffGuard {
  session: AuthSession
  staff: NonNullable<AuthSession['staff']>
}

/**
 * Registers the local resident-order routes (#109 LL-MVP-010).
 *
 * Three prefixes with three different guards, sharing one service layer:
 * - `/local-orders*`       resident session only; the resident is never in the URL/body
 * - `/staff/local-orders*` any staff role, community-scoped (grid workers included,
 *                          because `/admin/*` rejects them by convention)
 * - `/admin/local-orders*` admin/operator; verification lives exclusively here
 *
 * Session, CSRF double-submit + trusted Origin and the error envelope all come
 * from `createApp`; this module never builds a second auth implementation.
 */
export function registerLocalOrderRoutes(
  app: Hono<AppBindings>,
  deps: LocalOrderRouteDeps,
): void {
  const { db, config, fail, validCsrf, bodySchemaError } = deps

  const failWithLocalError = (c: AppContext, error: unknown): Response => {
    if (error instanceof LocalError) {
      return fail(c, error.status, error.code, error.message)
    }
    // #171 LL-IDENTITY-001: registering an order (self-service or staff-recorded)
    // is a community-scoped write and is refused by the shared confirmed-community
    // guard when the resident has no binding or belongs to another community. Map
    // that refusal to the standard envelope instead of a 500 internal_error.
    if (error instanceof ResidentCommunityError) {
      return fail(c, error.status, error.code, error.message)
    }
    throw error
  }

  const requireResident = (c: AppContext): { session: AuthSession; actor: LocalActor } | Response => {
    const session = c.get('authSession')
    if (!session) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录居民账户')
    }
    return {
      session,
      actor: {
        userId: session.userId,
        staffId: session.staff?.id ?? null,
        role: session.staff?.role ?? null,
      },
    }
  }

  const requireStaff = (c: AppContext): StaffGuard | Response => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    return { session, staff: session.staff }
  }

  const requireAdminSide = (c: AppContext): StaffGuard | Response => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权执行订单核验')
    }
    return guard
  }

  const actorOf = (guard: StaffGuard): LocalActor => ({
    userId: guard.session.userId,
    staffId: guard.staff.id,
    role: guard.staff.role,
  })

  const requireCsrf = (c: AppContext, session: AuthSession): Response | null => {
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    return null
  }

  const requireParam = (c: AppContext): string | Response => {
    const parsed = idSchema.safeParse(c.req.param('localOrderId'))
    if (!parsed.success) {
      return fail(c, 404, API_ERROR_CODES.notFound, '订单不存在')
    }
    return parsed.data
  }

  const queryObject = (c: AppContext): Record<string, string> => {
    const cleaned: Record<string, string> = {}
    for (const [key, value] of Object.entries(c.req.query())) {
      if (value !== '') cleaned[key] = value
    }
    return cleaned
  }

  const parseQuery = (c: AppContext) => localOrderListQuerySchema.safeParse(queryObject(c))

  /* ------------------------------- Resident -------------------------------- */

  app.get(LOCAL_ORDER_ROUTES.myOrders, (c) => {
    const guard = requireResident(c)
    if (guard instanceof Response) return guard
    const query = parseQuery(c)
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listMyOrders(db, guard.actor, query.data))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.post(LOCAL_ORDER_ROUTES.myOrders, async (c) => {
    const guard = requireResident(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      createLocalOrderRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '登记信息不正确')
    try {
      const result = registerResidentOrder(db, guard.actor, body)
      return c.json(result, result.created ? 201 : 200)
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.get(LOCAL_ORDER_ROUTES.myOrderDetail, (c) => {
    const guard = requireResident(c)
    if (guard instanceof Response) return guard
    const orderId = requireParam(c)
    if (orderId instanceof Response) return orderId
    try {
      return c.json(getMyOrder(db, guard.actor, orderId))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  /* -------------------------------- Staff ---------------------------------- */

  app.get(LOCAL_ORDER_ROUTES.staffOrders, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const query = parseQuery(c)
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listStaffOrders(db, actorOf(guard), query.data))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.post(LOCAL_ORDER_ROUTES.staffOrders, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      createLocalOrderOnBehalfRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '代录信息不正确')
    try {
      const result = registerOrderOnBehalf(db, actorOf(guard), body)
      return c.json(result, result.created ? 201 : 200)
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.get(LOCAL_ORDER_ROUTES.staffOrderDetail, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const orderId = requireParam(c)
    if (orderId instanceof Response) return orderId
    try {
      return c.json(getStaffOrder(db, actorOf(guard), orderId))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.patch(LOCAL_ORDER_ROUTES.staffOrderStatus, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const orderId = requireParam(c)
    if (orderId instanceof Response) return orderId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      updateLocalOrderStatusRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '订单状态信息不正确')
    try {
      return c.json(updateOrderStatus(db, actorOf(guard), orderId, body))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  /* ------------------------------ Back office ------------------------------- */

  app.get(LOCAL_ORDER_ROUTES.adminOrders, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const query = parseQuery(c)
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listStaffOrders(db, actorOf(guard), query.data))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.get(LOCAL_ORDER_ROUTES.adminOrderDetail, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const orderId = requireParam(c)
    if (orderId instanceof Response) return orderId
    try {
      return c.json(getStaffOrder(db, actorOf(guard), orderId))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.patch(LOCAL_ORDER_ROUTES.adminOrderStatus, async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const orderId = requireParam(c)
    if (orderId instanceof Response) return orderId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      updateLocalOrderStatusRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '订单状态信息不正确')
    try {
      return c.json(updateOrderStatus(db, actorOf(guard), orderId, body))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.post(LOCAL_ORDER_ROUTES.adminOrderVerify, async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const orderId = requireParam(c)
    if (orderId instanceof Response) return orderId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      localOrderVerifyRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '核验信息不正确')
    try {
      return c.json(verifyOrder(db, actorOf(guard), orderId, body))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.get(LOCAL_ORDER_ROUTES.adminOrderEvents, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const orderId = requireParam(c)
    if (orderId instanceof Response) return orderId
    try {
      return c.json(listOrderEvents(db, actorOf(guard), orderId))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })
}
