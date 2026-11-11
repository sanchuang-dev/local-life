import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES, LEDGER_ROUTES,
  createSettlementStatementRequestSchema,
  settlementStatementActionRequestSchema,
  settlementStatementDetailSchema,
  settlementStatementListQuerySchema,
  settlementStatementListResponseSchema,
  recordSettlementPaymentRequestSchema,
  settlementPaymentActionRequestSchema,
  settlementPaymentOverviewSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import { LocalError, type LocalActor } from '../local/shared.js'
import {
  createSettlementStatement, getSettlementStatement,
  listSettlementStatements, lockSettlementStatement,
  performanceLinesForActor, reviewSettlementStatement,
} from './settlement-statements.js'
import {
  disputeSettlementPayment,
  getSettlementPaymentOverview,
  recordSettlementPayment,
  verifySettlementPayment,
} from './settlement-payments.js'
import { entitySettlementCsv, gridPerformanceCsv } from './settlement-statement-csv.js'

export interface SettlementStatementRouteDeps {
  db: AppDatabase
  config: ApiConfig
  fail: (c: AppContext, status: HttpErrorStatus, code: ApiErrorCode, message: string) => Response
  validCsrf: (c: AppContext, config: ApiConfig, session?: AuthSession | null) => boolean
  now?: () => Date
}

/** Offline snapshot API; strictly no bank payment or provider call. */
export function registerSettlementStatementRoutes(
  app: Hono<AppBindings>,
  { db, config, fail, validCsrf, now }: SettlementStatementRouteDeps,
): void {
  const idSchema = z.string().uuid()
  const clock = () => now?.() ?? new Date()
  function guard(
    c: AppContext, mode: 'read' | 'write' | 'admin' | 'performance',
  ): { actor: LocalActor; session: AuthSession } | Response {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c,401,API_ERROR_CODES.unauthorized,'请先登录管理后台')
    if ((mode !== 'performance' && session.staff.role === 'grid_worker') ||
        (mode === 'admin' && session.staff.role !== 'admin')) {
      return fail(c,403,API_ERROR_CODES.forbidden,'当前后台身份无权执行结算操作')
    }
    if ((mode === 'write' || mode === 'admin') && !validCsrf(c,config,session)) {
      return fail(c,403,API_ERROR_CODES.forbidden,'CSRF 或来源校验失败')
    }
    return {
      session,
      actor: { userId:session.userId,staffId:session.staff.id,role:session.staff.role },
    }
  }
  const error = (c: AppContext, e: unknown): Response => {
    if(e instanceof LocalError) return fail(c,e.status,e.code,e.message)
    throw e
  }
  const idOf = (c: AppContext): string | null => {
    const result = idSchema.safeParse(c.req.param('statementId'))
    return result.success ? result.data : null
  }
  const paymentIdOf = (c: AppContext): string | null => {
    const result = idSchema.safeParse(c.req.param('paymentId'))
    return result.success ? result.data : null
  }
  const asCsv = (text: string, id: string, suffix: string): Response => new Response(text, {
    status:200,headers:{
      'Content-Type':'text/csv; charset=utf-8',
      'Content-Disposition':`attachment; filename="settlement-${id}-${suffix}.csv"`,
      'Cache-Control':'private, no-store',
      'X-Content-Type-Options':'nosniff',
    },
  })

  app.get(LEDGER_ROUTES.adminSettlementStatements, (c) => {
    const auth = guard(c,'read')
    if(auth instanceof Response) return auth
    const params = settlementStatementListQuerySchema.safeParse(c.req.query())
    if(!params.success) return fail(c,400,API_ERROR_CODES.invalidRequest,'结算查询参数不正确')
    try {
      return c.json(settlementStatementListResponseSchema.parse(
        listSettlementStatements(db,auth.actor,params.data)))
    } catch(e) { return error(c,e) }
  })
  app.post(LEDGER_ROUTES.adminSettlementStatements, async (c) => {
    const auth = guard(c,'write')
    if(auth instanceof Response) return auth
    const input = createSettlementStatementRequestSchema.safeParse(await c.req.json().catch(()=>null))
    if(!input.success) return fail(c,400,API_ERROR_CODES.invalidRequest,'请核对社区、期间和旧草案版本')
    try {
      return c.json(settlementStatementDetailSchema.parse(
        createSettlementStatement(db,auth.actor,input.data,clock())),201)
    } catch(e) { return error(c,e) }
  })
  app.get(LEDGER_ROUTES.adminSettlementStatement, (c) => {
    const auth=guard(c,'read')
    if(auth instanceof Response) return auth
    const id=idOf(c)
    if(!id) return fail(c,404,API_ERROR_CODES.notFound,'结算单不存在')
    try { return c.json(settlementStatementDetailSchema.parse(
      getSettlementStatement(db,auth.actor,id))) }
    catch(e) { return error(c,e) }
  })
  app.post(LEDGER_ROUTES.adminSettlementReview, async (c) => {
    const auth=guard(c,'admin')
    if(auth instanceof Response) return auth
    const id=idOf(c)
    if(!id) return fail(c,404,API_ERROR_CODES.notFound,'结算单不存在')
    const input=settlementStatementActionRequestSchema.safeParse(await c.req.json().catch(()=>null))
    if(!input.success) return fail(c,400,API_ERROR_CODES.invalidRequest,'缺少复核证据引用或正确草案版本')
    try { return c.json(settlementStatementDetailSchema.parse(reviewSettlementStatement(
      db,auth.actor,id,input.data.expectedRevision,input.data.evidenceRef,clock()))) }
    catch(e) { return error(c,e) }
  })
  app.post(LEDGER_ROUTES.adminSettlementLock, async (c) => {
    const auth=guard(c,'admin')
    if(auth instanceof Response) return auth
    const id=idOf(c)
    if(!id) return fail(c,404,API_ERROR_CODES.notFound,'结算单不存在')
    const input=settlementStatementActionRequestSchema.safeParse(await c.req.json().catch(()=>null))
    if(!input.success) return fail(c,400,API_ERROR_CODES.invalidRequest,'缺少锁单确认引用或正确版本')
    try { return c.json(settlementStatementDetailSchema.parse(lockSettlementStatement(
      db,auth.actor,id,input.data.expectedRevision,input.data.evidenceRef,clock()))) }
    catch(e) { return error(c,e) }
  })

  app.get(LEDGER_ROUTES.adminSettlementPayments, (c) => {
    const auth=guard(c,'read')
    if(auth instanceof Response) return auth
    const id=idOf(c)
    if(!id) return fail(c,404,API_ERROR_CODES.notFound,'结算单不存在')
    try { return c.json(settlementPaymentOverviewSchema.parse(
      getSettlementPaymentOverview(db,auth.actor,id))) }
    catch(e) { return error(c,e) }
  })
  app.post(LEDGER_ROUTES.adminSettlementPayments, async (c) => {
    const auth=guard(c,'admin')
    if(auth instanceof Response) return auth
    const id=idOf(c)
    if(!id) return fail(c,404,API_ERROR_CODES.notFound,'结算单不存在')
    const input=recordSettlementPaymentRequestSchema.safeParse(await c.req.json().catch(()=>null))
    if(!input.success) return fail(c,400,API_ERROR_CODES.invalidRequest,
      '请核对收款主体、整数分金额、实际付款时间、脱敏凭据引用和幂等键')
    try { return c.json(settlementPaymentOverviewSchema.parse(
      recordSettlementPayment(db,auth.actor,id,input.data,clock())),201) }
    catch(e) { return error(c,e) }
  })
  app.post(LEDGER_ROUTES.adminSettlementPaymentVerify, async (c) => {
    const auth=guard(c,'admin')
    if(auth instanceof Response) return auth
    const id=idOf(c)
    const paymentId=paymentIdOf(c)
    if(!id || !paymentId) return fail(c,404,API_ERROR_CODES.notFound,'付款凭据不存在')
    const input=settlementPaymentActionRequestSchema.safeParse(await c.req.json().catch(()=>null))
    if(!input.success) return fail(c,400,API_ERROR_CODES.invalidRequest,'缺少复核证据或事件幂等键')
    try { return c.json(settlementPaymentOverviewSchema.parse(
      verifySettlementPayment(db,auth.actor,id,paymentId,
        input.data.eventIdempotencyKey,input.data.evidenceRef,clock()))) }
    catch(e) { return error(c,e) }
  })
  app.post(LEDGER_ROUTES.adminSettlementPaymentDispute, async (c) => {
    const auth=guard(c,'admin')
    if(auth instanceof Response) return auth
    const id=idOf(c)
    const paymentId=paymentIdOf(c)
    if(!id || !paymentId) return fail(c,404,API_ERROR_CODES.notFound,'付款凭据不存在')
    const input=settlementPaymentActionRequestSchema.safeParse(await c.req.json().catch(()=>null))
    if(!input.success) return fail(c,400,API_ERROR_CODES.invalidRequest,'缺少争议证据或事件幂等键')
    try { return c.json(settlementPaymentOverviewSchema.parse(
      disputeSettlementPayment(db,auth.actor,id,paymentId,
        input.data.eventIdempotencyKey,input.data.evidenceRef,clock()))) }
    catch(e) { return error(c,e) }
  })

  app.get(LEDGER_ROUTES.adminSettlementEntityCsv, (c) => {
    const auth=guard(c,'read')
    if(auth instanceof Response) return auth
    const id=idOf(c)
    if(!id) return fail(c,404,API_ERROR_CODES.notFound,'结算单不存在')
    try { return asCsv(entitySettlementCsv(getSettlementStatement(db,auth.actor,id)),id,'entity') }
    catch(e) { return error(c,e) }
  })
  app.get(LEDGER_ROUTES.adminSettlementPerformanceCsv, (c) => {
    const auth=guard(c,'performance')
    if(auth instanceof Response) return auth
    const id=idOf(c)
    if(!id) return fail(c,404,API_ERROR_CODES.notFound,'结算单不存在')
    try {
      const result=performanceLinesForActor(db,auth.actor,id)
      return asCsv(gridPerformanceCsv(result.statement,result.lines,result.performance),id,'grid-performance')
    } catch(e) { return error(c,e) }
  })
}
