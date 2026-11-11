import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  LEDGER_ROUTES,
  settlementCandidateQuerySchema,
  settlementCandidateListResponseSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { AppBindings, AppContext, HttpErrorStatus } from '../http.js'
import type { AppDatabase } from '../db/client.js'
import { LocalError } from '../local/shared.js'
import { listSettlementCandidates } from './settlement-candidates.js'

export interface SettlementCandidateRouteDeps {
  db: AppDatabase
  fail: (c: AppContext, status: HttpErrorStatus, code: ApiErrorCode, message: string) => Response
  now?: () => Date
}

/** Read-only evidence surface. Never mutates or computes payable amounts. */
export function registerSettlementCandidateRoutes(
  app: Hono<AppBindings>,
  { db, fail, now }: SettlementCandidateRouteDeps,
): void {
  app.get(LEDGER_ROUTES.adminSettlementCandidates, (c) => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    if (session.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员没有全局机构结算核查权限')
    }
    const query = settlementCandidateQuerySchema.safeParse(c.req.query())
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '结算候选的社区、期间或分页参数不正确')
    }
    try {
      const actor = {
        userId: session.userId,
        staffId: session.staff.id,
        role: session.staff.role,
      }
      return c.json(settlementCandidateListResponseSchema.parse(
        listSettlementCandidates(db, actor, query.data, now?.() ?? new Date())))
    } catch (cause) {
      if (cause instanceof LocalError) {
        return fail(c, cause.status, cause.code, cause.message)
      }
      throw cause
    }
  })
}
