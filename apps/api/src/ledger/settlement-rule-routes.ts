import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  LEDGER_ROUTES,
  createSettlementRuleRequestSchema,
  settlementQuoteRequestSchema,
  settlementQuoteResponseSchema,
  settlementRuleListQuerySchema,
  settlementRuleListResponseSchema,
  settlementRuleVersionSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import { LocalError, type LocalActor } from '../local/shared.js'
import {
  createSettlementRule,
  listSettlementRules,
  quoteSettlementOrder,
} from './settlement-rules.js'

export interface SettlementRuleRouteDeps {
  db: AppDatabase
  config: ApiConfig
  fail: (c: AppContext, status: HttpErrorStatus, code: ApiErrorCode, message: string) => Response
  validCsrf: (c: AppContext, config: ApiConfig, session?: AuthSession | null) => boolean
  now?: () => Date
}

/**
 * Backend-only contract rule version API. A trial estimate is never a payout
 * instruction, a finance approval, or a locked settlement statement.
 */
export function registerSettlementRuleRoutes(
  app: Hono<AppBindings>,
  { db, config, fail, validCsrf, now }: SettlementRuleRouteDeps,
): void {
  function guard(c: AppContext, write: boolean): { actor: LocalActor } | Response {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    if (session.staff.role === 'grid_worker' || (write && session.staff.role !== 'admin')) {
      return fail(c, 403, API_ERROR_CODES.forbidden, '无权管理或读取合同规则')
    }
    if (write && !validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 或来源校验失败')
    }
    return {
      actor: { userId: session.userId, staffId: session.staff.id, role: session.staff.role },
    }
  }
  const onError = (c: AppContext, error: unknown): Response => {
    if (error instanceof LocalError) return fail(c, error.status, error.code, error.message)
    throw error
  }

  app.get(LEDGER_ROUTES.adminSettlementRules, (c) => {
    const auth = guard(c, false)
    if (auth instanceof Response) return auth
    const q = settlementRuleListQuerySchema.safeParse(c.req.query())
    if (!q.success) return fail(c, 400, API_ERROR_CODES.invalidRequest, '合同查询范围不正确')
    try {
      return c.json(settlementRuleListResponseSchema.parse(
        listSettlementRules(db, auth.actor, q.data.communityId, q.data.mappingId)))
    } catch (error) { return onError(c, error) }
  })

  app.post(LEDGER_ROUTES.adminSettlementRules, async (c) => {
    const auth = guard(c, true)
    if (auth instanceof Response) return auth
    const body = createSettlementRuleRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '合同批准依据、分配比例、手续费或期限无效')
    }
    try {
      return c.json(settlementRuleVersionSchema.parse(
        createSettlementRule(db, auth.actor, body.data, now?.() ?? new Date())), 201)
    } catch (error) { return onError(c, error) }
  })

  app.post(LEDGER_ROUTES.adminSettlementQuote, async (c) => {
    // This is POST to avoid exposing order IDs in caching/query logs; read-only.
    const auth = guard(c, true)
    if (auth instanceof Response) return auth
    const body = settlementQuoteRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return fail(c, 400, API_ERROR_CODES.invalidRequest, '订单 ID 不正确')
    try {
      return c.json(settlementQuoteResponseSchema.parse(
        quoteSettlementOrder(db, auth.actor, body.data.orderId)))
    } catch (error) { return onError(c, error) }
  })
}
