import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  LEDGER_ROUTES,
  confirmSettlementOrderPartyRequestSchema,
  createSettlementMappingRequestSchema,
  createSettlementPartyRequestSchema,
  settlementMappingListQuerySchema,
  settlementMappingListResponseSchema,
  settlementMappingSchema,
  settlementOrderPartyResponseSchema,
  settlementOrderPartySnapshotSchema,
  settlementPartyListQuerySchema,
  settlementPartyListResponseSchema,
  settlementPartySchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import { LocalError, type LocalActor } from '../local/shared.js'
import {
  confirmOrderPartySnapshot,
  createSettlementMapping,
  createSettlementParty,
  listSettlementMappings,
  listSettlementParties,
  readOrderPartySnapshot,
} from './settlement-parties.js'

export interface SettlementPartyRouteDeps {
  db: AppDatabase
  config: ApiConfig
  fail: (c: AppContext, status: HttpErrorStatus, code: ApiErrorCode, message: string) => Response
  validCsrf: (c: AppContext, config: ApiConfig, session?: AuthSession | null) => boolean
  now?: () => Date
}

/** Back-office API for explicit, non-inferred seller identity (#183). */
export function registerSettlementPartyRoutes(
  app: Hono<AppBindings>,
  deps: SettlementPartyRouteDeps,
): void {
  const { db, config, fail, validCsrf } = deps
  const now = () => deps.now?.() ?? new Date()
  const guard = (c: AppContext, write: boolean): { session: AuthSession; actor: LocalActor } | Response => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    if (session.staff.role === 'grid_worker' || (write && session.staff.role !== 'admin')) {
      return fail(c, 403, API_ERROR_CODES.forbidden, '当前角色无权查看或管理商户主体')
    }
    if (write && !validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 或来源校验失败')
    }
    return {
      session,
      actor: { userId: session.userId, staffId: session.staff.id, role: session.staff.role },
    }
  }
  const error = (c: AppContext, cause: unknown): Response => {
    if (cause instanceof LocalError) return fail(c, cause.status, cause.code, cause.message)
    throw cause
  }
  const uuid = z.string().uuid()

  app.get(LEDGER_ROUTES.adminSettlementParties, (c) => {
    const auth = guard(c, false)
    if (auth instanceof Response) return auth
    const q = settlementPartyListQuerySchema.safeParse(c.req.query())
    if (!q.success) return fail(c, 400, API_ERROR_CODES.invalidRequest, '社区筛选参数不正确')
    try {
      return c.json(settlementPartyListResponseSchema.parse(
        listSettlementParties(db, auth.actor, q.data.communityId)))
    } catch (cause) { return error(c, cause) }
  })

  app.post(LEDGER_ROUTES.adminSettlementParties, async (c) => {
    const auth = guard(c, true)
    if (auth instanceof Response) return auth
    const body = createSettlementPartyRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return fail(c, 400, API_ERROR_CODES.invalidRequest, '主体资料与核验依据不正确')
    try {
      return c.json(settlementPartySchema.parse(
        createSettlementParty(db, auth.actor, body.data, now())), 201)
    } catch (cause) { return error(c, cause) }
  })

  app.get(LEDGER_ROUTES.adminSettlementMappings, (c) => {
    const auth = guard(c, false)
    if (auth instanceof Response) return auth
    const q = settlementMappingListQuerySchema.safeParse(c.req.query())
    if (!q.success) return fail(c, 400, API_ERROR_CODES.invalidRequest, '社区筛选参数不正确')
    try {
      return c.json(settlementMappingListResponseSchema.parse(
        listSettlementMappings(db, auth.actor, q.data.communityId)))
    } catch (cause) { return error(c, cause) }
  })

  app.post(LEDGER_ROUTES.adminSettlementMappings, async (c) => {
    const auth = guard(c, true)
    if (auth instanceof Response) return auth
    const body = createSettlementMappingRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return fail(c, 400, API_ERROR_CODES.invalidRequest, '商户归属/期限/协议参数不正确')
    try {
      return c.json(settlementMappingSchema.parse(
        createSettlementMapping(db, auth.actor, body.data, now())), 201)
    } catch (cause) { return error(c, cause) }
  })

  app.get(LEDGER_ROUTES.adminSettlementOrderParty, (c) => {
    const auth = guard(c, false)
    if (auth instanceof Response) return auth
    const id = uuid.safeParse(c.req.param('orderId'))
    if (!id.success) return fail(c, 404, API_ERROR_CODES.notFound, '订单不存在')
    try {
      return c.json(settlementOrderPartyResponseSchema.parse(
        readOrderPartySnapshot(db, auth.actor, id.data)))
    } catch (cause) { return error(c, cause) }
  })

  app.post(LEDGER_ROUTES.adminSettlementOrderParty, async (c) => {
    const auth = guard(c, true)
    if (auth instanceof Response) return auth
    const id = uuid.safeParse(c.req.param('orderId'))
    if (!id.success) return fail(c, 404, API_ERROR_CODES.notFound, '订单不存在')
    const body = confirmSettlementOrderPartyRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return fail(c, 400, API_ERROR_CODES.invalidRequest, '请提供具体销售商户映射与核对凭据')
    try {
      return c.json(settlementOrderPartySnapshotSchema.parse(
        confirmOrderPartySnapshot(db, auth.actor, id.data,
          body.data.mappingId, body.data.confirmationRef, now())), 201)
    } catch (cause) { return error(c, cause) }
  })
}
