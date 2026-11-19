import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  adminLocalOrderDetailSchema,
  paymentDifferenceSchema,
  paymentDifferencesQuerySchema,
  paymentDifferencesResponseSchema,
  paymentReconciliationRoutes,
} from '@sanchuang-dev/local-life-contracts'
import type { AppBindings, AppContext } from '../http.js'
import { LocalError, type LocalActor } from '../local/shared.js'
import type { LedgerRouteDeps } from './routes.js'
import { listPaymentDifferences, paymentDifferenceDetail, paymentDifferencesCsv } from './payment-reconciliation.js'

/** PAY-09 read-only endpoints, preserving the existing admin/operator permission boundary. */
export function registerPaymentReconciliationRoutes(app: Hono<AppBindings>, deps: LedgerRouteDeps): void {
  const { db, fail, now: injectedNow } = deps
  const now = () => injectedNow?.() ?? new Date()

  function actor(c: AppContext): LocalActor | Response {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    if (session.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权访问支付异常对账')
    }
    return { userId: session.userId, staffId: session.staff.id, role: session.staff.role }
  }
  function errorResponse(c: AppContext, error: unknown): Response {
    if (error instanceof LocalError) return fail(c, error.status, error.code, error.message)
    throw error
  }
  function parsedQuery(c: AppContext) {
    return paymentDifferencesQuerySchema.safeParse(c.req.query())
  }

  app.get(paymentReconciliationRoutes.list, (c) => {
    const who = actor(c)
    if (who instanceof Response) return who
    const query = parsedQuery(c)
    if (!query.success) return fail(c, 400, API_ERROR_CODES.invalidRequest, '支付差异查询参数不正确')
    try {
      const result = listPaymentDifferences(db, who, query.data, now())
      c.header('Cache-Control', 'no-store')
      return c.json(paymentDifferencesResponseSchema.parse(result))
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get(paymentReconciliationRoutes.detail, (c) => {
    const who = actor(c)
    if (who instanceof Response) return who
    const intentId = z.string().uuid().safeParse(c.req.param('intentId'))
    if (!intentId.success) return fail(c, 404, API_ERROR_CODES.notFound, '支付核对记录不存在')
    try {
      const detail = paymentDifferenceDetail(db, who, intentId.data, now())
      c.header('Cache-Control', 'no-store')
      return c.json({
        ...paymentDifferenceSchema.parse(detail),
        asOf: detail.asOf,
        order: adminLocalOrderDetailSchema.parse(detail.order),
      })
    } catch (error) {
      return errorResponse(c, error)
    }
  })

  app.get(paymentReconciliationRoutes.exportCsv, (c) => {
    const who = actor(c)
    if (who instanceof Response) return who
    const query = parsedQuery(c)
    if (!query.success) return fail(c, 400, API_ERROR_CODES.invalidRequest, '支付差异导出条件不正确')
    try {
      const csv = paymentDifferencesCsv(db, who, query.data, now())
      return new Response(csv.content, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="payment-reconciliation.csv"',
          'Cache-Control': 'no-store',
          'X-Payment-Row-Count': String(csv.rows),
          'Access-Control-Expose-Headers': 'Content-Disposition, X-Payment-Row-Count',
        },
      })
    } catch (error) {
      return errorResponse(c, error)
    }
  })
}
