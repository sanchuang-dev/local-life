import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, notInArray } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  paymentAttemptSchema,
  paymentIntentCreateResponseSchema,
  paymentIntentDetailResponseSchema,
  paymentIntentSchema,
  paymentPrepayResponseSchema,
  type CreatePaymentIntentRequest,
  type PaymentAttempt,
  type PaymentIntent,
  type PaymentIntentCreateResponse,
  type PaymentIntentDetailResponse,
  type PaymentCapabilities,
  type PaymentPrepayResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import {
  ledgerEntrySources,
  localOrderOnlineCompletions,
  localOrderOnlineConflicts,
  localOrders,
  paymentAttempts,
  paymentEvents,
  paymentIntents,
  paymentReviewExceptions,
  wechatIdentities,
  wechatPayPrepayAttempts,
} from '../db/schema.js'
import {
  LocalError,
  iso,
  type LocalActor,
  type LocalTransaction,
} from '../local/shared.js'
import { logEvent } from '../log.js'
import {
  buildWechatPayJsapiRequest,
  computePrepayExpiresAt,
  executeWechatPayJsapiRequest,
  sha256Hex,
} from '../wechat-pay/provider.js'
import { createWechatJsapiInvocation } from '../wechat-pay/signing.js'

const PAYMENT_INTENT_TTL_MS = 15 * 60 * 1000

/**
 * Old manual terminal states are not silently converted into online payments.
 * PAY-05 reuses this exact set when projecting a trusted paid event, so the two
 * payment cards can never disagree about what "payable" means.
 */
export const PAYABLE_ORDER_STATUSES: Readonly<Record<string, true>> = {
  registered: true,
  processing: true,
  pending_review: true,
}

type PaymentIntentRow = typeof paymentIntents.$inferSelect
type PaymentAttemptRow = typeof paymentAttempts.$inferSelect

/** Conflict kinds that mean "a trusted payment may exist for this order". */
const PAYMENT_BLOCKING_CONFLICT_KINDS = [
  'late_success',
  'consumer_exhausted',
  'manual_online_double_collection',
] as const

/**
 * R1 authoritative manual/online boundary.
 *
 * A manual verification or manual receipt asserts "a human settled this order".
 * That assertion is only safe when the server can PROVE the order has no online
 * money: every payment intent must be in a trusted terminal unpaid state
 * (`closed`/`failed`), and there must be no completion, no `online_payment`
 * ledger receipt and no open money anomaly. Anything else — including an
 * in-flight `pending`/`confirming` intent whose channel outcome is still
 * unknown — is treated as "possibly paid" and refused.
 *
 * This runs inside the caller's `BEGIN IMMEDIATE` transaction, beside the write
 * it protects: SQLite serialises writers, so a trusted confirmation cannot slip
 * between this check and the manual write. It is intentionally the single shared
 * implementation for both `verifyOrder` and `recordPayment`; a UI hint or a
 * route-level check is not a substitute.
 */
export function assertManualPaymentBoundary(tx: LocalTransaction, orderId: string): void {
  const blockingIntent = tx
    .select({
      id: paymentIntents.id,
      status: paymentIntents.status,
      kind: paymentIntents.kind,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.localOrderId, orderId),
        notInArray(paymentIntents.status, ['closed', 'failed']),
      ),
    )
    .orderBy(asc(paymentIntents.createdAt), asc(paymentIntents.id))
    .get()
  if (blockingIntent) {
    throw new LocalError(
      409,
      API_ERROR_CODES.paymentOnlineCompletionConflict,
      `该订单存在支付单 ${blockingIntent.id}（${blockingIntent.kind}/${blockingIntent.status}），资金可能已付或结果未定，禁止人工核验/实收`,
    )
  }

  const completion = tx
    .select({ id: localOrderOnlineCompletions.id })
    .from(localOrderOnlineCompletions)
    .where(eq(localOrderOnlineCompletions.localOrderId, orderId))
    .get()
  const onlineReceipt = tx
    .select({ id: ledgerEntrySources.id })
    .from(ledgerEntrySources)
    .innerJoin(
      localOrderOnlineCompletions,
      eq(ledgerEntrySources.sourceId, localOrderOnlineCompletions.id),
    )
    .where(
      and(
        eq(ledgerEntrySources.sourceSystem, 'online_payment'),
        eq(ledgerEntrySources.factKind, 'payment_received'),
        eq(localOrderOnlineCompletions.localOrderId, orderId),
      ),
    )
    .get()
  if (completion || onlineReceipt) {
    throw new LocalError(
      409,
      API_ERROR_CODES.paymentOnlineCompletionConflict,
      '该订单已有在线完成或线上账本实收事实，禁止人工核验/实收',
    )
  }

  const openConflict = tx
    .select({ id: localOrderOnlineConflicts.id, kind: localOrderOnlineConflicts.kind })
    .from(localOrderOnlineConflicts)
    .where(
      and(
        eq(localOrderOnlineConflicts.localOrderId, orderId),
        eq(localOrderOnlineConflicts.status, 'open'),
        inArray(localOrderOnlineConflicts.kind, [...PAYMENT_BLOCKING_CONFLICT_KINDS]),
      ),
    )
    .get()
  if (openConflict) {
    throw new LocalError(
      409,
      API_ERROR_CODES.paymentOnlineCompletionConflict,
      `该订单存在待核对的支付异常（${openConflict.kind}），禁止人工核验/实收`,
    )
  }

  // Any unresolved provider-evidence anomaly means the server cannot prove that
  // the channel is safely unpaid. This is intentionally broader than only
  // late-success: amount/merchant/transaction/terminal conflicts can also carry
  // a real provider observation and must be reviewed before manual collection.
  const openReviewException = tx
    .select({ id: paymentReviewExceptions.id, kind: paymentReviewExceptions.kind })
    .from(paymentReviewExceptions)
    .innerJoin(
      paymentIntents,
      eq(paymentReviewExceptions.paymentIntentId, paymentIntents.id),
    )
    .where(
      and(
        eq(paymentIntents.localOrderId, orderId),
        eq(paymentReviewExceptions.status, 'open'),
      ),
    )
    .get()
  if (openReviewException) {
    throw new LocalError(
      409,
      API_ERROR_CODES.paymentOnlineCompletionConflict,
      `该订单存在待复核的支付证据异常（${openReviewException.kind}），无法证明渠道未付款，禁止人工核验/实收`,
    )
  }
}

/**
 * PAY-02 creation policy. It creates only a pending intent for the explicitly
 * enabled, isolated Mock channel. It does not call a gateway, create a paid
 * fact, complete the order, touch coupons or write the ledger.
 *
 * WeChat is deliberately unavailable until PAY-10 supplies real merchant
 * configuration and the channel client. An unavailable channel is a 503, never
 * a silent fallback to Mock or a simulated success.
 */
function assertChannelAvailable(
  config: Pick<ApiConfig, 'paymentMockEnabled' | 'nodeEnv' | 'wechatPay'>,
  channel: CreatePaymentIntentRequest['channel'],
): void {
  if (channel === 'mock') {
    if (config.paymentMockEnabled && config.nodeEnv !== 'production') return
    throw new LocalError(
      503,
      API_ERROR_CODES.paymentChannelUnavailable,
      '模拟支付渠道未启用，暂时无法创建支付单',
    )
  }
  if (channel === 'wechat_jsapi' && config.wechatPay) return
  throw new LocalError(
    503,
    API_ERROR_CODES.paymentChannelUnavailable,
    '微信支付渠道尚未配置，暂时无法创建支付单',
  )
}

export function getPaymentCapabilities(config: ApiConfig): PaymentCapabilities {
  const mockAvailable = config.paymentMockEnabled && config.nodeEnv !== 'production'
  const wechatJsapiAvailable = Boolean(config.wechatPay)
  return {
    mockAvailable,
    // PAY-10 owns the real WeChat merchant/client. Without read-only merchant
    // credentials the server says unavailable and never falls back to Mock.
    wechatJsapiAvailable,
    zeroAmountAvailable: true,
    mockUnavailableReason: mockAvailable ? null : 'mock_disabled',
    wechatUnavailableReason: wechatJsapiAvailable ? null : 'not_configured',
  }
}

export function toIntent(row: PaymentIntentRow): PaymentIntent {
  return paymentIntentSchema.parse({
    ...row,
    expiresAt: iso(row.expiresAt),
    paidAt: row.paidAt ? iso(row.paidAt) : null,
    closedAt: row.closedAt ? iso(row.closedAt) : null,
    failedAt: row.failedAt ? iso(row.failedAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

export function toAttempt(row: PaymentAttemptRow): PaymentAttempt {
  return paymentAttemptSchema.parse({
    ...row,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    confirmedAt: row.confirmedAt ? iso(row.confirmedAt) : null,
    closedAt: row.closedAt ? iso(row.closedAt) : null,
    failedAt: row.failedAt ? iso(row.failedAt) : null,
  })
}

/** A retry with the same key must describe the same server-derived intent. */
function isSameIdempotentRequest(
  existing: PaymentIntentRow,
  actor: LocalActor,
  body: CreatePaymentIntentRequest,
  order: typeof localOrders.$inferSelect,
): boolean {
  return (
    existing.localOrderId === body.localOrderId &&
    existing.channel === body.channel &&
    existing.residentUserId === actor.userId &&
    existing.communityId === order.communityId &&
    existing.grossAmountCents === order.totalCents &&
    existing.discountCents === order.couponDiscountCents &&
    existing.netPayableCents === order.totalCents - order.couponDiscountCents
  )
}

function conflict(message: string, code = API_ERROR_CODES.paymentIdempotencyConflict): never {
  throw new LocalError(409, code, message)
}

/**
 * Creates or safely returns a resident-owned pending payment intent.
 *
 * The browser supplies only order UUID, channel and idempotency key. All money,
 * ownership and merchant values are derived from SQLite and the server config.
 */
export function createPaymentIntent(
  db: AppDatabase,
  config: Pick<ApiConfig, 'paymentMockEnabled' | 'nodeEnv' | 'wechatPay'>,
  actor: LocalActor,
  body: CreatePaymentIntentRequest,
  options: { now?: Date } = {},
): PaymentIntentCreateResponse {
  const now = options.now ?? new Date()

  return db.transaction((tx) => {
    const order = tx.select().from(localOrders)
      .where(eq(localOrders.id, body.localOrderId)).get()
    // Another resident's order is a 404, not an enumerable 403.
    if (!order || order.residentUserId !== actor.userId) {
      throw new LocalError(404, API_ERROR_CODES.notFound, '本地订单不存在')
    }

    const netPayableCents = order.totalCents - order.couponDiscountCents
    if (netPayableCents < 0) {
      throw new LocalError(400, API_ERROR_CODES.invalidRequest, '订单金额快照不正确')
    }

    const existingByKey = tx.select().from(paymentIntents)
      .where(eq(paymentIntents.idempotencyKey, body.idempotencyKey)).get()
    if (existingByKey) {
      if (!isSameIdempotentRequest(existingByKey, actor, body, order)) {
        conflict('幂等键已用于另一笔支付请求')
      }
      return paymentIntentCreateResponseSchema.parse({
        created: false,
        intent: toIntent(existingByKey),
      })
    }

    if (netPayableCents === 0) {
      throw new LocalError(
        409,
        API_ERROR_CODES.paymentZeroAmountUnavailable,
        '零元订单的完成路径尚未开放，请等待后续支付能力',
      )
    }

    if (!PAYABLE_ORDER_STATUSES[order.status]) {
      throw new LocalError(
        409,
        API_ERROR_CODES.paymentNotPayable,
        '当前订单状态不可创建支付单',
      )
    }

    const paid = tx.select({ id: paymentIntents.id }).from(paymentIntents)
      .where(and(
        eq(paymentIntents.localOrderId, order.id),
        eq(paymentIntents.status, 'paid'),
      )).get()
    if (paid) {
      throw new LocalError(409, API_ERROR_CODES.paymentAlreadyPaid, '该订单已有有效支付，不能重复创建')
    }

    // One active intent per order is reused even when the client retries with a
    // new idempotency key. An expired intent is still returned: expiry is not
    // proof that the channel did not receive money; PAY-03 owns trusted queries.
    const active = tx.select().from(paymentIntents)
      .where(and(
        eq(paymentIntents.localOrderId, order.id),
        inArray(paymentIntents.status, ['pending', 'confirming']),
      ))
      .orderBy(desc(paymentIntents.createdAt), desc(paymentIntents.id))
      .get()
    if (active) {
      if (active.channel !== body.channel || active.residentUserId !== actor.userId) {
        throw new LocalError(
          409,
          API_ERROR_CODES.paymentActiveIntentConflict,
          '该订单已有待处理支付单，请先查询或关闭原支付单',
        )
      }
      return paymentIntentCreateResponseSchema.parse({
        created: false,
        intent: toIntent(active),
      })
    }

    assertChannelAvailable(config, body.channel)

    const id = randomUUID()
    const row: PaymentIntentRow = {
      id,
      localOrderId: order.id,
      residentUserId: actor.userId,
      communityId: order.communityId,
      kind: 'channel',
      channel: body.channel,
      simulated: body.channel === 'mock',
      // WeChat JSAPI out_trade_no: 6-32 chars. `PAY-` + 28 hex = 32 exactly,
      // retaining 112 bits of randomness while staying usable by PAY-10
      // without a second merchant-order-number generator.
      merchantOrderNo: `PAY-${id.replace(/-/gu, '').toUpperCase().slice(0, 28)}`,
      // A real WeChat intent freezes the trusted single-merchant identity at
      // creation. PAY-03 rejects wechat evidence unless these columns match the
      // provider evidence, and the 0031 trigger makes them immutable afterwards,
      // so they must be written here — never left null or filled in later.
      merchantAppId: body.channel === 'wechat_jsapi' ? config.wechatPay?.appId ?? null : null,
      merchantId: body.channel === 'wechat_jsapi' ? config.wechatPay?.mchid ?? null : null,
      grossAmountCents: order.totalCents,
      discountCents: order.couponDiscountCents,
      netPayableCents,
      status: 'pending',
      idempotencyKey: body.idempotencyKey,
      expiresAt: new Date(now.getTime() + PAYMENT_INTENT_TTL_MS),
      paidAt: null,
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      createdAt: now,
      updatedAt: now,
    }
    try {
      tx.insert(paymentIntents).values(row).run()
      tx.insert(paymentEvents).values({
        id: randomUUID(),
        paymentIntentId: id,
        paymentAttemptId: null,
        eventType: 'payment.intent_created',
        source: 'system',
        fromStatus: null,
        toStatus: 'pending',
        providerEventRef: null,
        dedupeKey: `payment.intent_created:${id}`,
        note: null,
        createdAt: now,
      }).run()
    } catch (error) {
      // The IMMEDIATE transaction serializes writers, but a unique collision can
      // still happen across processes/reconnect. Re-read by the idempotency key.
      if (error instanceof Error && /UNIQUE constraint failed|constraint failed/iu.test(error.message)) {
        const retried = tx.select().from(paymentIntents)
          .where(eq(paymentIntents.idempotencyKey, body.idempotencyKey)).get()
        if (retried && isSameIdempotentRequest(retried, actor, body, order)) {
          return paymentIntentCreateResponseSchema.parse({
            created: false,
            intent: toIntent(retried),
          })
        }
      }
      throw error
    }

    return paymentIntentCreateResponseSchema.parse({
      created: true,
      intent: toIntent(row),
    })
  }, { behavior: 'immediate' })
}

/** Resident-scoped read: another resident's intent is a 404. */
export function getMyPaymentIntent(
  db: AppDatabase,
  actor: LocalActor,
  paymentIntentId: string,
): PaymentIntentDetailResponse {
  const row = db.select().from(paymentIntents)
    .where(and(
      eq(paymentIntents.id, paymentIntentId),
      eq(paymentIntents.residentUserId, actor.userId),
    ))
    .get()
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '支付单不存在')

  const attempts = db.select().from(paymentAttempts)
    .where(eq(paymentAttempts.paymentIntentId, row.id))
    .orderBy(asc(paymentAttempts.attemptNo), asc(paymentAttempts.createdAt))
    .all()
  return paymentIntentDetailResponseSchema.parse({
    intent: toIntent(row),
    attempts: attempts.map(toAttempt),
  })
}

/* -------------------------------------------------------------------------- */
/* PAY-10 WeChat Pay APIv3 JSAPI prepay                                       */
/* -------------------------------------------------------------------------- */

/** A deterministic provider refusal may be retried a bounded number of times. */
export const WECHAT_PREPAY_MAX_REJECTED_ATTEMPTS = 3

type PrepayAttemptRow = typeof wechatPayPrepayAttempts.$inferSelect

function truncateText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function prepayConflict(code: (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES], message: string) {
  return new LocalError(409, code, message)
}

/**
 * PAY-10: create (or safely reuse) a WeChat Pay APIv3 JSAPI prepay for one
 * resident-owned payment intent.
 *
 * Truth boundaries enforced here:
 * - The browser supplies only the intent id; appId/mchid/amount/openid/
 *   out_trade_no/package/paySign are all server-derived.
 * - Money is the frozen intent snapshot, re-validated against the local order.
 * - `prepay_id` is persisted only in `wechat_pay_prepay_attempts` and never
 *   becomes `payment_attempts.provider_transaction_id`, a `paid` intent, an
 *   order completion, a ledger fact or a channel transaction.
 * - A verified provider refusal is a bounded retry; a timeout/unknown outcome
 *   is persisted as `uncertain` and blocks blind re-submission until PAY-11
 *   query/close converges it.
 */
export async function createWechatJsapiPrepay(
  db: AppDatabase,
  config: ApiConfig,
  actor: LocalActor,
  paymentIntentId: string,
  deps: { now?: Date; fetcher?: typeof fetch } = {},
): Promise<PaymentPrepayResponse> {
  const runtime = config.wechatPay
  if (!runtime) {
    throw new LocalError(
      503,
      API_ERROR_CODES.paymentChannelUnavailable,
      '微信支付渠道尚未配置，暂时无法发起支付',
    )
  }
  const now = deps.now ?? new Date()

  const intent = db
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.id, paymentIntentId),
        eq(paymentIntents.residentUserId, actor.userId),
      ),
    )
    .get()
  // Another resident's intent is a 404, not an enumerable 403.
  if (!intent) throw new LocalError(404, API_ERROR_CODES.notFound, '支付单不存在')

  if (intent.kind !== 'channel' || intent.channel !== 'wechat_jsapi' || intent.simulated) {
    throw new LocalError(
      409,
      API_ERROR_CODES.paymentNotPayable,
      '该支付单不是微信 JSAPI 渠道支付单',
    )
  }
  if (intent.status === 'paid') {
    throw new LocalError(409, API_ERROR_CODES.paymentAlreadyPaid, '该支付单已支付，不能再次调起')
  }
  if (intent.status === 'confirming') {
    throw prepayConflict(
      API_ERROR_CODES.paymentActiveIntentConflict,
      '该支付单正在确认支付结果，不能发起新的预下单',
    )
  }
  if (intent.status !== 'pending') {
    throw new LocalError(
      409,
      API_ERROR_CODES.paymentNotPayable,
      '支付单已关闭或失败，需经查单/关单确认后重新创建支付单',
    )
  }
  // The frozen merchant identity must still match the configured merchant. A
  // null (pre-repair/legacy) or rotated appid/mchid can never be confirmed by
  // PAY-03, so refuse before any outbound payable order is created.
  if (intent.merchantAppId !== runtime.appId || intent.merchantId !== runtime.mchid) {
    throw new LocalError(
      409,
      API_ERROR_CODES.paymentNotPayable,
      '支付单的商户身份与当前微信支付配置不一致，禁止发起预下单',
    )
  }

  const order = db
    .select()
    .from(localOrders)
    .where(
      and(
        eq(localOrders.id, intent.localOrderId),
        eq(localOrders.residentUserId, actor.userId),
        eq(localOrders.communityId, intent.communityId),
      ),
    )
    .get()
  if (!order) {
    throw new LocalError(409, API_ERROR_CODES.paymentNotPayable, '本地订单不存在或归属不一致')
  }
  // Re-validate the frozen money snapshot against the live order; the browser
  // never contributes an amount here.
  if (
    order.totalCents !== intent.grossAmountCents ||
    order.couponDiscountCents !== intent.discountCents ||
    order.totalCents - order.couponDiscountCents !== intent.netPayableCents ||
    intent.netPayableCents <= 0
  ) {
    throw new LocalError(409, API_ERROR_CODES.paymentNotPayable, '订单金额快照已变化，不能发起支付')
  }
  if (!PAYABLE_ORDER_STATUSES[order.status]) {
    throw new LocalError(409, API_ERROR_CODES.paymentNotPayable, '当前订单状态不可发起支付')
  }

  if (intent.expiresAt.getTime() <= now.getTime()) {
    throw new LocalError(
      409,
      API_ERROR_CODES.paymentNotPayable,
      '支付单已过期，不能继续调起支付；渠道结果需由查单/关单收敛',
    )
  }
  // WeChat silently moves `time_expire` to "now + 1 minute" when it is sooner,
  // which would extend payment beyond the intent deadline. Refuse instead.
  if (intent.expiresAt.getTime() - now.getTime() < 60_000) {
    throw new LocalError(
      409,
      API_ERROR_CODES.paymentNotPayable,
      '支付单即将过期，请重新创建支付单',
    )
  }

  // The openid comes only from the trusted (appid, resident) identity mapping.
  const identity = db
    .select({ openId: wechatIdentities.openId })
    .from(wechatIdentities)
    .where(
      and(
        eq(wechatIdentities.userId, actor.userId),
        eq(wechatIdentities.appId, runtime.appId),
      ),
    )
    .orderBy(asc(wechatIdentities.createdAt), asc(wechatIdentities.id))
    .get()
  if (!identity) {
    throw new LocalError(
      409,
      API_ERROR_CODES.paymentNotPayable,
      '当前账户未绑定该公众号微信身份，无法发起微信支付',
    )
  }

  const trimmedProductName = order.productName.trim()
  const description = truncateText(
    trimmedProductName.length > 0 ? trimmedProductName : `本地生活订单 ${intent.merchantOrderNo}`,
    127,
  )
  const request = buildWechatPayJsapiRequest(runtime, {
    appId: runtime.appId,
    mchid: runtime.mchid,
    description,
    outTradeNo: intent.merchantOrderNo,
    timeExpire: intent.expiresAt,
    notifyUrl: runtime.notifyUrl,
    amountTotalCents: intent.netPayableCents,
    openid: identity.openId,
  }, { now })
  const prepayExpiresAt = computePrepayExpiresAt(now, intent.expiresAt)

  type Reservation =
    | { kind: 'reuse'; row: PrepayAttemptRow }
    | { kind: 'reserve'; row: PrepayAttemptRow }

  const reservation = db.transaction(
    (tx): Reservation => {
      const rows = tx
        .select()
        .from(wechatPayPrepayAttempts)
        .where(eq(wechatPayPrepayAttempts.paymentIntentId, intent.id))
        .orderBy(desc(wechatPayPrepayAttempts.attemptNo), desc(wechatPayPrepayAttempts.createdAt))
        .all()
      const succeeded = rows.find((row) => row.status === 'succeeded')
      if (succeeded) {
        const stillValid =
          succeeded.requestFingerprint === request.fingerprint &&
          succeeded.prepayId !== null &&
          succeeded.prepayExpiresAt !== null &&
          succeeded.prepayExpiresAt.getTime() > now.getTime() &&
          succeeded.timeExpireAt.getTime() > now.getTime()
        if (!stillValid) {
          throw prepayConflict(
            API_ERROR_CODES.paymentNotPayable,
            '预支付凭据已过期或配置已变化，不能继续调起；须由查单/关单确认后重建支付单',
          )
        }
        return { kind: 'reuse', row: succeeded }
      }
      const blocking = rows.find(
        (row) => row.status === 'requesting' || row.status === 'uncertain',
      )
      if (blocking) {
        throw prepayConflict(
          API_ERROR_CODES.paymentActiveIntentConflict,
          '该支付单存在渠道结果未定的预下单请求，禁止重复发起；请等待查单/关单收敛',
        )
      }
      const rejectedCount = rows.filter((row) => row.status === 'rejected').length
      if (rejectedCount >= WECHAT_PREPAY_MAX_REJECTED_ATTEMPTS) {
        throw new LocalError(
          503,
          API_ERROR_CODES.paymentChannelUnavailable,
          '微信支付连续拒绝预下单，已停止自动重试',
        )
      }
      const reservedRow: PrepayAttemptRow = {
        id: randomUUID(),
        paymentIntentId: intent.id,
        attemptNo: (rows[0]?.attemptNo ?? 0) + 1,
        status: 'requesting',
        requestFingerprint: request.fingerprint,
        outTradeNo: intent.merchantOrderNo,
        appid: runtime.appId,
        mchid: runtime.mchid,
        payerOpenidSha256: sha256Hex(identity.openId),
        amountCents: intent.netPayableCents,
        timeExpireAt: intent.expiresAt,
        requestMethod: request.method,
        requestPath: request.path,
        requestBodySha256: request.bodySha256,
        requestBodyRedactedJson: request.redactedBodyJson,
        requestCreatedAt: now,
        responseStatus: null,
        responseRequestId: null,
        responseBodySha256: null,
        responseErrorCode: null,
        responseErrorMessage: null,
        prepayId: null,
        prepayExpiresAt: null,
        failureCode: null,
        failureMessage: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      tx.insert(wechatPayPrepayAttempts).values(reservedRow).run()
      return { kind: 'reserve', row: reservedRow }
    },
    { behavior: 'immediate' },
  )

  if (reservation.kind === 'reuse') {
    const succeeded = reservation.row
    logEvent('wechat_pay.prepay_reused', {
      paymentIntentId: intent.id,
      prepayAttemptId: succeeded.id,
    })
    return paymentPrepayResponseSchema.parse({
      outcome: 'prepay_reused',
      paymentIntentId: intent.id,
      channel: 'wechat_jsapi',
      prepayExpiresAt: iso(succeeded.prepayExpiresAt!),
      invocation: createWechatJsapiInvocation({
        appId: runtime.appId,
        prepayId: succeeded.prepayId!,
        merchantPrivateKey: runtime.merchantPrivateKey,
        now,
      }),
    })
  }

  const attemptId = reservation.row.id
  const reservedAttemptNo = reservation.row.attemptNo
  const result = await executeWechatPayJsapiRequest({
    request,
    runtime,
    now,
    ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
  })

  db.transaction((tx) => {
    const completedAt = now
    const base = {
      responseStatus: result.responseStatus,
      responseRequestId: result.requestId,
      responseBodySha256: result.responseBodySha256,
      completedAt,
      updatedAt: completedAt,
    }
    let values:
      | (typeof base & {
          status: 'succeeded'
          prepayId: string
          prepayExpiresAt: Date
        })
      | (typeof base & {
          status: 'rejected'
          failureCode: string
          failureMessage: string
          responseErrorCode: string
          responseErrorMessage: string
        })
      | (typeof base & {
          status: 'uncertain'
          failureCode: string
          failureMessage: string
        })
    if (result.kind === 'prepay') {
      values = {
        ...base,
        status: 'succeeded',
        prepayId: result.prepayId,
        prepayExpiresAt,
      }
    } else if (result.kind === 'rejected') {
      values = {
        ...base,
        status: 'rejected',
        failureCode: result.code,
        failureMessage: result.message,
        responseErrorCode: result.code,
        responseErrorMessage: result.message,
      }
    } else {
      values = {
        ...base,
        status: 'uncertain',
        failureCode: result.failureCode,
        failureMessage: truncateText(result.detail, 500),
      }
    }
    const updated = tx
      .update(wechatPayPrepayAttempts)
      .set(values)
      .where(
        and(
          eq(wechatPayPrepayAttempts.id, attemptId),
          eq(wechatPayPrepayAttempts.status, 'requesting'),
        ),
      )
      .run()
    if (updated.changes !== 1) {
      throw new LocalError(409, API_ERROR_CODES.conflict, '预下单结果已被其他请求更新')
    }
  })

  logEvent('wechat_pay.prepay', {
    paymentIntentId: intent.id,
    prepayAttemptId: attemptId,
    prepayAttemptNo: reservedAttemptNo,
    status: result.kind === 'prepay' ? 'succeeded' : result.kind,
    providerStatus: result.responseStatus,
    providerRequestId: result.requestId,
    failureCode: result.kind === 'prepay' ? null : result.kind === 'rejected' ? result.code : result.failureCode,
  })

  if (result.kind === 'rejected') {
    throw new LocalError(
      503,
      API_ERROR_CODES.paymentChannelUnavailable,
      `微信支付拒绝预下单（${result.code}），未产生可支付订单`,
    )
  }
  if (result.kind === 'uncertain') {
    throw new LocalError(
      503,
      API_ERROR_CODES.paymentChannelUnavailable,
      '微信支付结果未定，已停止重复下单；请等待查单/关单收敛后再试',
    )
  }

  return paymentPrepayResponseSchema.parse({
    outcome: 'prepay_created',
    paymentIntentId: intent.id,
    channel: 'wechat_jsapi',
    prepayExpiresAt: iso(prepayExpiresAt),
    invocation: createWechatJsapiInvocation({
      appId: runtime.appId,
      prepayId: result.prepayId,
      merchantPrivateKey: runtime.merchantPrivateKey,
      now,
    }),
  })
}
