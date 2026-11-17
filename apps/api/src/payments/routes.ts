import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  PAYMENT_INTERNAL_ROUTES,
  PAYMENT_ROUTES,
  createPaymentIntentRequestSchema,
  paymentEvidenceSchema,
  type CreatePaymentIntentRequest,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import { constantTimeTextEqual } from '../auth/security.js'
import { LocalError, type LocalActor } from '../local/shared.js'
import { confirmTrustedPayment } from './confirmation.js'
import { createPaymentIntent, getMyPaymentIntent } from './service.js'

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
