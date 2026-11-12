import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  CRM_ROUTES,
  createCrmFollowUpRequestSchema,
  createCrmLeadRequestSchema,
  createCrmServiceOrderRequestSchema,
  crmLeadListQuerySchema,
  crmOrderListQuerySchema,
  crmOrderReviewRequestSchema,
  transferCrmLeadRequestSchema,
  updateCrmLeadStatusRequestSchema,
  updateCrmOrderStatusRequestSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import {
  CrmError,
  createFollowUp,
  createLead,
  createOrder,
  getFilterOptions,
  getLead,
  getOrder,
  listFollowUps,
  listLeadEvents,
  listLeads,
  listOrderEvents,
  listOrders,
  reviewOrder,
  transferLead,
  updateLeadStatus,
  updateOrderStatus,
  type CrmActor,
} from './service.js'

export interface CrmRouteDeps {
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
 * Registers the community CRM routes. Session, CSRF, trusted Origin and the shared
 * error envelope all come from `createApp`; this module never builds a second auth
 * implementation and always validates its responses with the shared contracts.
 */
export function registerCrmRoutes(app: Hono<AppBindings>, deps: CrmRouteDeps): void {
  const { db, config, fail, validCsrf, bodySchemaError } = deps

  const failWithCrmError = (c: AppContext, error: unknown): Response => {
    if (error instanceof CrmError) {
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

  const requireAdminSide = (c: AppContext): StaffGuard | Response => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权访问后台 CRM')
    }
    return guard
  }

  const actorOf = (guard: StaffGuard): CrmActor => ({
    userId: guard.session.userId,
    staffId: guard.staff.id,
    role: guard.staff.role,
  })

  const requireParam = (c: AppContext, key: 'leadId' | 'orderId'): string | Response => {
    const parsed = idSchema.safeParse(c.req.param(key))
    if (!parsed.success) {
      return fail(c, 404, API_ERROR_CODES.notFound, key === 'leadId' ? '线索不存在' : '业务单不存在')
    }
    return parsed.data
  }

  const requireCsrf = (c: AppContext, guard: StaffGuard): Response | null => {
    if (!validCsrf(c, config, guard.session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    return null
  }

  // Use the shared query contracts as the only source of truth. Empty optional
  // values are dropped so a form that sends `status=` still means "no filter".
  const queryObject = (c: AppContext): Record<string, string> => {
    const cleaned: Record<string, string> = {}
    for (const [key, value] of Object.entries(c.req.query())) {
      if (value !== '') cleaned[key] = value
    }
    return cleaned
  }

  const parseLeadQuery = (c: AppContext) =>
    crmLeadListQuerySchema.safeParse(queryObject(c))

  const parseOrderQuery = (c: AppContext) =>
    crmOrderListQuerySchema.safeParse(queryObject(c))

  /* -------------------------- Grid worker endpoints ----------------------- */

  app.get(CRM_ROUTES.leadList, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const query = parseLeadQuery(c)
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listLeads(db, actorOf(guard), query.data))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.post(CRM_ROUTES.leadList, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      createCrmLeadRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '线索信息不正确')
    try {
      return c.json(createLead(db, actorOf(guard), body), 201)
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.leadDetail, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const leadId = requireParam(c, 'leadId')
    if (leadId instanceof Response) return leadId
    try {
      return c.json(getLead(db, actorOf(guard), leadId))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.patch(CRM_ROUTES.leadStatus, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const leadId = requireParam(c, 'leadId')
    if (leadId instanceof Response) return leadId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      updateCrmLeadStatusRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '线索状态信息不正确')
    try {
      return c.json(updateLeadStatus(db, actorOf(guard), leadId, body))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.post(CRM_ROUTES.leadTransfer, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const leadId = requireParam(c, 'leadId')
    if (leadId instanceof Response) return leadId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      transferCrmLeadRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '转交信息不正确')
    try {
      return c.json(transferLead(db, actorOf(guard), leadId, body))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.leadFollowUps, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const leadId = requireParam(c, 'leadId')
    if (leadId instanceof Response) return leadId
    try {
      return c.json(listFollowUps(db, actorOf(guard), leadId))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.post(CRM_ROUTES.leadFollowUps, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const leadId = requireParam(c, 'leadId')
    if (leadId instanceof Response) return leadId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      createCrmFollowUpRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '跟进信息不正确')
    try {
      return c.json(createFollowUp(db, actorOf(guard), leadId, body), 201)
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.leadAudit, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const leadId = requireParam(c, 'leadId')
    if (leadId instanceof Response) return leadId
    try {
      return c.json(listLeadEvents(db, actorOf(guard), leadId))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.orderList, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const query = parseOrderQuery(c)
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listOrders(db, actorOf(guard), query.data))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.post(CRM_ROUTES.orderList, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      createCrmServiceOrderRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '业务单信息不正确')
    try {
      return c.json(createOrder(db, actorOf(guard), body), 201)
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.orderDetail, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const orderId = requireParam(c, 'orderId')
    if (orderId instanceof Response) return orderId
    try {
      return c.json(getOrder(db, actorOf(guard), orderId))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.patch(CRM_ROUTES.orderStatus, async (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const orderId = requireParam(c, 'orderId')
    if (orderId instanceof Response) return orderId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      updateCrmOrderStatusRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '业务单状态信息不正确')
    try {
      return c.json(updateOrderStatus(db, actorOf(guard), orderId, body))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.orderAudit, (c) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const orderId = requireParam(c, 'orderId')
    if (orderId instanceof Response) return orderId
    try {
      return c.json(listOrderEvents(db, actorOf(guard), orderId))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  /* ---------------------------- Back office ------------------------------- */

  app.get(CRM_ROUTES.adminLeadList, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const query = parseLeadQuery(c)
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listLeads(db, actorOf(guard), query.data))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.adminLeadDetail, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const leadId = requireParam(c, 'leadId')
    if (leadId instanceof Response) return leadId
    try {
      return c.json(getLead(db, actorOf(guard), leadId))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.adminLeadAudit, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const leadId = requireParam(c, 'leadId')
    if (leadId instanceof Response) return leadId
    try {
      return c.json(listLeadEvents(db, actorOf(guard), leadId))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.adminOrderList, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const query = parseOrderQuery(c)
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listOrders(db, actorOf(guard), query.data))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.adminOrderDetail, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const orderId = requireParam(c, 'orderId')
    if (orderId instanceof Response) return orderId
    try {
      return c.json(getOrder(db, actorOf(guard), orderId))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.adminOrderAudit, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const orderId = requireParam(c, 'orderId')
    if (orderId instanceof Response) return orderId
    try {
      return c.json(listOrderEvents(db, actorOf(guard), orderId))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.post(CRM_ROUTES.adminOrderReview, async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const orderId = requireParam(c, 'orderId')
    if (orderId instanceof Response) return orderId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      crmOrderReviewRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '审核信息不正确')
    try {
      return c.json(reviewOrder(db, actorOf(guard), orderId, body))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })

  app.get(CRM_ROUTES.adminFilterOptions, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    try {
      return c.json(getFilterOptions(db, actorOf(guard)))
    } catch (error) {
      return failWithCrmError(c, error)
    }
  })
}
