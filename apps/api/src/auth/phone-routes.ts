import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { z } from 'zod'
import {
  API_ERROR_CODES,
  PHONE_AUTH_ROUTES,
  authSessionResponseSchema,
  maskMainlandPhone,
  normalizeMainlandPhone,
  phoneAuthStatusResponseSchema,
  phoneBindResponseSchema,
  phoneOtpRequestResponseSchema,
  phoneOtpRequestSchema,
  phoneOtpVerifyRequestSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import { residentPhoneIdentities } from '../db/schema.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import {
  PhoneOtpError,
  bindVerifiedPhone,
  loginWithPhone,
  recordPhoneAudit,
  requestPhoneVerificationCode,
  type SmsSender,
} from './phone.js'

export interface PhoneAuthRouteDeps {
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
  /** Reuses the app's single session factory; no phone-specific session shape. */
  createSession: (
    db: AppDatabase,
    config: ApiConfig,
    userId: string,
    staffAccountId: string | null,
  ) => { token: string; csrfToken: string }
  setSessionCookies: (
    c: AppContext,
    config: ApiConfig,
    token: string,
    csrfToken: string,
  ) => void
  /** Absent in every shipped deployment: no SMS provider is bundled. */
  smsSender?: SmsSender
  now: () => Date
}

/**
 * Client address for the IP throttle. This API is served behind the site reverse
 * proxy (Vite dev proxy / production proxy), which sets `x-forwarded-for`; the
 * tests inject it explicitly. Without a proxy the value degrades to a single
 * shared bucket, which is still bounded.
 */
function clientIp(c: AppContext): string {
  const forwarded = c.req.header('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  if (first) return first.slice(0, 64)
  const real = c.req.header('x-real-ip')?.trim()
  return real ? real.slice(0, 64) : 'unknown'
}

/**
 * Registers the phone identity HTTP surface (#93).
 *
 * Boundaries enforced here:
 * - JSON bodies are strict contracts schemas; a forged `userId` fails parsing.
 * - Every write needs the existing CSRF double-submit token + a trusted Origin;
 *   the session/CSRF/Origin implementation is reused, not re-implemented.
 * - Responses never contain a verification code, and no endpoint reports whether
 *   a phone is already registered before the caller proved control of it.
 * - Login creates one resident row per phone; every later login returns the same
 *   platform UUID, so participation/reward attribution never moves.
 */
export function registerPhoneAuthRoutes(
  app: Hono<AppBindings>,
  deps: PhoneAuthRouteDeps,
): void {
  const { db, config, fail, validCsrf, bodySchemaError, createSession, setSessionCookies } = deps
  const now = deps.now

  const phoneError = (
    c: AppContext,
    purpose: string,
    error: unknown,
  ): Response => {
    if (!(error instanceof PhoneOtpError)) throw error
    if (error.retryAfterSeconds !== undefined) {
      c.header('retry-after', String(error.retryAfterSeconds))
    }
    recordPhoneAudit(db, 'phone.otp.rejected', {
      metadata: { purpose, outcome: error.code },
    })
    return fail(c, error.status, error.code, error.message)
  }

  app.get(PHONE_AUTH_ROUTES.status, (c) => {
    const session = c.get('authSession')
    const identity = session
      ? db
          .select()
          .from(residentPhoneIdentities)
          .where(eq(residentPhoneIdentities.userId, session.userId))
          .get()
      : undefined
    return c.json(
      phoneAuthStatusResponseSchema.parse({
        // No injected sender means public phone login is genuinely unavailable.
        configured: Boolean(deps.smsSender),
        authenticated: Boolean(session),
        maskedPhone: identity ? maskMainlandPhone(identity.phone) : null,
      }),
    )
  })

  app.post(PHONE_AUTH_ROUTES.requestOtp, async (c) => {
    if (!validCsrf(c, deps.config)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败，请刷新页面后重试')
    }
    const body = bodySchemaError(await c.req.json().catch(() => null), phoneOtpRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '手机号格式不正确')
    const phone = normalizeMainlandPhone(body.phone)
    if (!phone) return fail(c, 400, API_ERROR_CODES.phoneInvalid, '请输入有效的中国大陆手机号')

    try {
      const issued = await requestPhoneVerificationCode(
        { db, now },
        {
          phone,
          purpose: body.purpose,
          ip: clientIp(c),
          sender: deps.smsSender,
        },
      )
      recordPhoneAudit(db, 'phone.otp.issued', {
        metadata: { purpose: body.purpose, outcome: 'sent' },
      })
      return c.json(
        phoneOtpRequestResponseSchema.parse({ accepted: true, ...issued }),
        202,
      )
    } catch (error) {
      return phoneError(c, body.purpose, error)
    }
  })

  app.post(PHONE_AUTH_ROUTES.login, async (c) => {
    if (!validCsrf(c, config)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败，请刷新页面后重试')
    }
    const body = bodySchemaError(await c.req.json().catch(() => null), phoneOtpVerifyRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '手机号或验证码格式不正确')
    const phone = normalizeMainlandPhone(body.phone)
    if (!phone) return fail(c, 400, API_ERROR_CODES.phoneInvalid, '请输入有效的中国大陆手机号')

    try {
      const result = loginWithPhone({ db, now }, { phone, code: body.code })
      const created = createSession(db, config, result.userId, null)
      setSessionCookies(c, config, created.token, created.csrfToken)
      recordPhoneAudit(db, 'phone.login', {
        actorUserId: result.userId,
        targetId: result.userId,
        metadata: { method: 'phone_otp' },
      })
      return c.json(
        authSessionResponseSchema.parse({
          authenticated: true,
          user: { id: result.userId, displayName: result.displayName },
          staff: null,
          csrfToken: created.csrfToken,
        }),
      )
    } catch (error) {
      return phoneError(c, 'login', error)
    }
  })

  app.post(PHONE_AUTH_ROUTES.bind, async (c) => {
    const session = c.get('authSession')
    if (!session) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录后再绑定手机号')
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const body = bodySchemaError(await c.req.json().catch(() => null), phoneOtpVerifyRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '手机号或验证码格式不正确')
    const phone = normalizeMainlandPhone(body.phone)
    if (!phone) return fail(c, 400, API_ERROR_CODES.phoneInvalid, '请输入有效的中国大陆手机号')

    try {
      const result = bindVerifiedPhone(
        { db, now },
        { userId: session.userId, phone, code: body.code },
      )
      return c.json(
        phoneBindResponseSchema.parse({
          bound: true,
          alreadyBound: result.alreadyBound,
          maskedPhone: result.maskedPhone,
        }),
      )
    } catch (error) {
      return phoneError(c, 'bind', error)
    }
  })
}
