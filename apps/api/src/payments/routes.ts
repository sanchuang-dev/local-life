import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  PAYMENT_INTERNAL_ROUTES,
  PAYMENT_ROUTES,
  createPaymentIntentRequestSchema,
  mockPaymentActionRequestSchema,
  paymentEvidenceSchema,
  paymentOutboxConsumeRequestSchema,
  paymentOutboxRecoveryRequestSchema,
  paymentPrepayRequestSchema,
  type CreatePaymentIntentRequest,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import { constantTimeTextEqual } from '../auth/security.js'
import { LocalError, type LocalActor } from '../local/shared.js'
import { confirmTrustedPayment } from './confirmation.js'
import { executeOwnedMockPaymentAction } from './mock-channel.js'
import {
  listFailedPaymentOutboxEvents,
  recoverParkedPaymentOutboxEvent,
  runPaymentOutboxConsumer,
} from './outbox.js'
import {
  createPaymentIntent,
  createWechatJsapiPrepay,
  getMyPaymentIntent,
  getPaymentCapabilities,
} from './service.js'

export interface PaymentRouteDeps {
  db: AppDatabase
  config: ApiConfig
  fail: (
    c: AppContext,
    status: HttpErrorStatus,
    code: (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES],
    message: string,
  ) => Response
  validCsrf: (c: AppContext, config: ApiConfig, session?: AuthSession | null) => boolean
  bodySchemaError: <T>(value: unknown, schema: z.ZodType<T>) => T | null
}

const paymentIntentIdSchema = z.string().uuid()

/** Bounded internal list of parked events; the service also caps it server-side. */
const outboxFailedListLimitSchema = z.preprocess(
  (value) => (value === undefined || value === '' ? undefined : Number(value)),
  z.number().int().min(1).max(200).optional(),
)

/**
 * Resident payment intent surface (PAY-02).
 *
 * Only creation and owner-scoped read are registered. There is deliberately no
 * resident-callable status write: `paid` belongs to trusted PAY-03 processing.
 */
export function registerPaymentRoutes(
  app: Hono<AppBindings>,
  deps: PaymentRouteDeps,
): void {
  const { db, config, fail, validCsrf, bodySchemaError } = deps

  const failWithPaymentError = (c: AppContext, error: unknown): Response => {
    if (error instanceof LocalError) {
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

  /**
   * Shared guard for the two internal payment surfaces. A missing server token is
   * a 503 (fail closed), a wrong/absent Bearer token is a 401. Neither a resident
   * session nor a CSRF token can stand in for it.
   */
  const requireInternalToken = (c: AppContext): Response | null => {
    const expectedToken = config.paymentInternalToken
    if (!expectedToken) {
      return fail(c, 503, API_ERROR_CODES.paymentInternalNotConfigured, '内部支付确认未配置')
    }
    const authorization = c.req.header('authorization')?.trim() ?? ''
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : ''
    if (!token || !constantTimeTextEqual(token, expectedToken)) {
      return fail(c, 401, API_ERROR_CODES.paymentInternalUnauthorized, '内部支付确认凭证无效')
    }
    return null
  }

  app.get(PAYMENT_ROUTES.capabilities, (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(getPaymentCapabilities(config))
  })

  /**
   * Resident-owned Mock action for the isolated H5 experience. The server
   * capability flag is false in production, and this handler still requires a
   * real resident session, CSRF/Origin and ownership of the Mock intent. It
   * never accepts amount/merchant/transaction/evidence input and calls the same
   * PAY-03 confirmation + PAY-05 consumer as any other Mock action.
   */
  app.post(PAYMENT_ROUTES.mockAction, async (c) => {
    const guard = requireResident(c)
    if (guard instanceof Response) return guard
    if (!validCsrf(c, config, guard.session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const intentId = paymentIntentIdSchema.safeParse(c.req.param('paymentIntentId'))
    if (!intentId.success) return fail(c, 404, API_ERROR_CODES.notFound, '支付单不存在')
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      mockPaymentActionRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '模拟支付参数不正确')
    try {
      const result = executeOwnedMockPaymentAction(db, config, guard.actor, {
        paymentIntentId: intentId.data,
        action: body.action,
        source: body.source,
      })
      if (result.intent.status === 'paid') {
        // Complete the order through the existing PAY-05 consumer; no second
        // state machine and no browser-supplied success flag.
        runPaymentOutboxConsumer(db)
      }
      c.header('Cache-Control', 'no-store')
      return c.json(result)
    } catch (error) {
      return failWithPaymentError(c, error)
    }
  })

  /**
   * PAY-10 resident-owned WeChat JSAPI prepay.
   *
   * The request body is strictly empty: the intent id is the only client value.
   * appId/mchid/amount/openid/out_trade_no/package/paySign are all derived from
   * server state; the response is invocation parameters, never a paid fact.
   */
  app.post(PAYMENT_ROUTES.wechatJsapiPrepay, async (c) => {
    const guard = requireResident(c)
    if (guard instanceof Response) return guard
    if (!validCsrf(c, config, guard.session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const intentId = paymentIntentIdSchema.safeParse(c.req.param('paymentIntentId'))
    if (!intentId.success) return fail(c, 404, API_ERROR_CODES.notFound, '支付单不存在')
    const raw = await c.req.text().catch(() => '')
    let parsedBody: unknown = {}
    if (raw.trim() !== '') {
      try {
        parsedBody = JSON.parse(raw)
      } catch {
        parsedBody = null
      }
    }
    const body = bodySchemaError(parsedBody, paymentPrepayRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '预下单参数不正确')
    try {
      const result = await createWechatJsapiPrepay(db, config, guard.actor, intentId.data)
      c.header('Cache-Control', 'no-store')
      return c.json(result, result.outcome === 'prepay_created' ? 201 : 200)
    } catch (error) {
      return failWithPaymentError(c, error)
    }
  })

  app.post(PAYMENT_ROUTES.createIntent, async (c) => {
    const guard = requireResident(c)
    if (guard instanceof Response) return guard
    if (!validCsrf(c, config, guard.session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      createPaymentIntentRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '支付单参数不正确')
    try {
      const result = createPaymentIntent(db, config, guard.actor, body as CreatePaymentIntentRequest)
      c.header('Cache-Control', 'no-store')
      return c.json(result, result.created ? 201 : 200)
    } catch (error) {
      return failWithPaymentError(c, error)
    }
  })

  /**
   * Internal provider-result endpoint for PAY-11 adapters and integration tests.
   * It is not a resident route: a server-held token is required and no session
   * or browser CSRF token can substitute for it.
   */
  app.post(PAYMENT_INTERNAL_ROUTES.confirm, async (c) => {
    const unauthorized = requireInternalToken(c)
    if (unauthorized) return unauthorized
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      paymentEvidenceSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '支付证据格式不正确')
    try {
      const result = confirmTrustedPayment(db, body)
      c.header('Cache-Control', 'no-store')
      return c.json(result)
    } catch (error) {
      return failWithPaymentError(c, error)
    }
  })

  /**
   * PAY-05 consumer trigger. Same server-side token as `confirm`: a browser,
   * resident session or CSRF token can never drive order completion.
   *
   * The body is optional (an empty POST drains the default batch). Every claim is
   * one `BEGIN IMMEDIATE` transaction, so repeated or concurrent calls are safe.
   */
  app.post(PAYMENT_INTERNAL_ROUTES.consumeOutbox, async (c) => {
    const unauthorized = requireInternalToken(c)
    if (unauthorized) return unauthorized
    const raw = await c.req.json().catch(() => ({}))
    const body = bodySchemaError(raw ?? {}, paymentOutboxConsumeRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '消费参数不正确')
    try {
      const result = runPaymentOutboxConsumer(db, {
        ...(body.limit === undefined ? {} : { limit: body.limit }),
      })
      c.header('Cache-Control', 'no-store')
      return c.json(result)
    } catch (error) {
      return failWithPaymentError(c, error)
    }
  })

  /**
   * R2 parked-event query. Same internal token as every trust-bearing entry
   * point. It exposes the order/intent/amount/channel reference/failure reason so
   * an operator never has to read or UPDATE the outbox table by hand.
   */
  app.get(PAYMENT_INTERNAL_ROUTES.failedOutbox, (c) => {
    const unauthorized = requireInternalToken(c)
    if (unauthorized) return unauthorized
    const limit = outboxFailedListLimitSchema.safeParse(c.req.query('limit') ?? undefined)
    if (!limit.success) return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    try {
      const result = listFailedPaymentOutboxEvents(db, {
        ...(limit.data === undefined ? {} : { limit: limit.data }),
      })
      c.header('Cache-Control', 'no-store')
      return c.json(result)
    } catch (error) {
      return failWithPaymentError(c, error)
    }
  })

  /**
   * R2 controlled recovery. Only a parked (`failed`) event is replayable; the
   * replay goes through the same idempotent projection as the consumer and then
   * marks the linked open conflicts `resolved`. Repeated/concurrent recovery and
   * replay of an already delivered event are safe no-ops / explicit 409s, never a
   * second completion.
   */
  app.post(PAYMENT_INTERNAL_ROUTES.recoverOutbox, async (c) => {
    const unauthorized = requireInternalToken(c)
    if (unauthorized) return unauthorized
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      paymentOutboxRecoveryRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '恢复参数不正确')
    try {
      const result = recoverParkedPaymentOutboxEvent(db, body.outboxEventId)
      c.header('Cache-Control', 'no-store')
      return c.json(result)
    } catch (error) {
      return failWithPaymentError(c, error)
    }
  })

  app.get(PAYMENT_ROUTES.myIntentDetail, (c) => {
    const guard = requireResident(c)
    if (guard instanceof Response) return guard
    const parsed = paymentIntentIdSchema.safeParse(c.req.param('paymentIntentId'))
    if (!parsed.success) return fail(c, 404, API_ERROR_CODES.notFound, '支付单不存在')
    try {
      const result = getMyPaymentIntent(db, guard.actor, parsed.data)
      c.header('Cache-Control', 'no-store')
      return c.json(result)
    } catch (error) {
      return failWithPaymentError(c, error)
    }
  })
}
