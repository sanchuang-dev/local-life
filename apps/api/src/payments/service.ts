import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  paymentAttemptSchema,
  paymentIntentCreateResponseSchema,
  paymentIntentDetailResponseSchema,
  paymentIntentSchema,
  type CreatePaymentIntentRequest,
  type PaymentAttempt,
  type PaymentIntent,
  type PaymentIntentCreateResponse,
  type PaymentIntentDetailResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import {
  localOrders,
  paymentAttempts,
  paymentEvents,
  paymentIntents,
} from '../db/schema.js'
import { LocalError, iso, type LocalActor } from '../local/shared.js'

const PAYMENT_INTENT_TTL_MS = 15 * 60 * 1000

/** Old manual terminal states are not silently converted into online payments. */
const PAYABLE_ORDER_STATUSES: Readonly<Record<string, true>> = {
  registered: true,
  processing: true,
  pending_review: true,
}

type PaymentIntentRow = typeof paymentIntents.$inferSelect
type PaymentAttemptRow = typeof paymentAttempts.$inferSelect

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
  config: Pick<ApiConfig, 'paymentMockEnabled' | 'nodeEnv'>,
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
  throw new LocalError(
    503,
    API_ERROR_CODES.paymentChannelUnavailable,
    '微信支付渠道尚未配置，暂时无法创建支付单',
  )
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
  config: Pick<ApiConfig, 'paymentMockEnabled' | 'nodeEnv'>,
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
      merchantAppId: null,
      merchantId: null,
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
