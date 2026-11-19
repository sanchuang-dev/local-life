import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES, PAYMENT_WECHAT_ROUTES,
  wechatRecoveryResultSchema, wechatRecoveryBatchSchema,
} from '@sanchuang-dev/local-life-contracts'
import type { AppBindings, AppContext } from '../http.js'
import type { PaymentRouteDeps } from '../payments/routes.js'
import { LocalError } from '../local/shared.js'
import { logEvent } from '../log.js'
import {
  verifyAndDecryptWechatNotification, WechatNotificationError,
} from './notification.js'
import {
  confirmVerifiedWechatNotification,
  checkWechatPayment,
  closeAndVerifyWechatPayment,
  recoverDueWechatPayments,
} from './recovery-service.js'

const uuid = z.string().uuid()
const recoveryInput = z.strictObject({ limit: z.number().int().min(1).max(20).default(10) })

/**
 * The notification route is public ONLY to permit signed WeChat requests;
 * the three recovery routes are behind the existing server-held internal token.
 * No resident or admin session can self-report a successful payment.
 */
export function registerWechatPaymentRoutes(
  app: Hono<AppBindings>,
  deps: PaymentRouteDeps,
  requireInternalToken: (c: AppContext) => Response | null,
): void {
  const { db, config, fail } = deps
  function error(c: AppContext, cause: unknown): Response {
    if (cause instanceof LocalError) return fail(c, cause.status, cause.code, cause.message)
    if (cause instanceof WechatNotificationError) {
      const status = cause.kind === 'signature' ? 401 : cause.kind === 'merchant_mismatch' ? 409 : 400
      return fail(c, status, cause.kind === 'signature'
        ? API_ERROR_CODES.paymentEvidenceRejected : API_ERROR_CODES.invalidRequest,
      '微信支付通知未通过安全校验')
    }
    throw cause
  }
  const runtimeOrError = (c: AppContext, requireDecrypt = false) => {
    const runtime = config.wechatPay
    if (!runtime || (requireDecrypt && !runtime.apiV3Key)) {
      return fail(c, 503, API_ERROR_CODES.paymentNotPayable, '真实微信支付服务未配置完整')
    }
    return runtime
  }

  app.post(PAYMENT_WECHAT_ROUTES.notify, async (c) => {
    const runtime = runtimeOrError(c, true)
    if (runtime instanceof Response) return runtime
    const bytes = Number(c.req.header('content-length') ?? '0')
    if (bytes > 1_100_000) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '微信支付通知体过大')
    }
    const body = await c.req.text().catch(() => '')
    if (!body || Buffer.byteLength(body) > 1_100_000) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '微信支付通知体格式错误')
    }
    try {
      const verified = verifyAndDecryptWechatNotification({
        body, headers: c.req.raw.headers, runtime, now: new Date(),
      })
      // PAY-03 owns amount/merchant/order/terminal rules and outbox uniqueness.
      confirmVerifiedWechatNotification(db, runtime, verified)
      c.header('Cache-Control', 'no-store')
      return c.json({ code: 'SUCCESS', message: '成功' })
    } catch (cause) {
      // Only the rejection classification and a one-way fingerprint are safe
      // for logs. Never emit ciphertext, decrypted payload or request headers.
      logEvent('wechat_pay.notification_rejected', {
        reason: cause instanceof WechatNotificationError ? cause.kind
          : cause instanceof LocalError ? 'payment_conflict' : 'processing_error',
        bodySha256: createHash('sha256').update(body).digest('hex'),
      })
      return error(c, cause)
    }
  })

  async function runById(
    c: AppContext, task: 'query' | 'close',
  ) {
    const unauthorized = requireInternalToken(c)
    if (unauthorized) return unauthorized
    const runtime = runtimeOrError(c)
    if (runtime instanceof Response) return runtime
    const id = uuid.safeParse(c.req.param('paymentIntentId'))
    if (!id.success) return fail(c, 404, API_ERROR_CODES.notFound, '支付单不存在')
    // The only input is the intent id. Provider/amount/status come from SQLite.
    if ((c.req.header('content-length') ?? '0') !== '0') {
      const body = await c.req.text().catch(() => '')
      if (body.trim() && body.trim() !== '{}') {
        return fail(c, 400, API_ERROR_CODES.invalidRequest, '不接受浏览器提供支付状态')
      }
    }
    try {
      const result = task === 'query'
        ? await checkWechatPayment(db, runtime, id.data)
        : await closeAndVerifyWechatPayment(db, runtime, id.data)
      c.header('Cache-Control', 'no-store')
      return c.json(wechatRecoveryResultSchema.parse(result),
        result.outcome === 'uncertain' || result.outcome === 'needs_review' ? 202 : 200)
    } catch (cause) { return error(c, cause) }
  }
  app.post(PAYMENT_WECHAT_ROUTES.query, (c) => runById(c, 'query'))
  app.post(PAYMENT_WECHAT_ROUTES.close, (c) => runById(c, 'close'))

  app.post(PAYMENT_WECHAT_ROUTES.recover, async (c) => {
    const unauthorized = requireInternalToken(c)
    if (unauthorized) return unauthorized
    const runtime = runtimeOrError(c)
    if (runtime instanceof Response) return runtime
    const raw = await c.req.text().catch(() => '')
    let body: unknown = {}
    if (raw.trim() !== '') {
      try { body = JSON.parse(raw) as unknown } catch { body = null }
    }
    const parsed = recoveryInput.safeParse(body)
    if (!parsed.success) return fail(c, 400, API_ERROR_CODES.invalidRequest, '恢复参数不正确')
    try {
      const result = await recoverDueWechatPayments(db, runtime, parsed.data.limit)
      c.header('Cache-Control', 'no-store')
      return c.json(wechatRecoveryBatchSchema.parse(result))
    } catch (cause) { return error(c, cause) }
  })
}
