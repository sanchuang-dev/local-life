import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNotNull, notExists, sql } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  localOrderOnlineCompletionResponseSchema,
  paymentPaidEventPayloadSchema,
  type LocalOrderOnlineCompletionResponse,
  type LocalOrderOnlineConflictKind,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  couponIssues,
  ledgerPaymentOrderLinks,
  localOrderOnlineCompletions,
  localOrderOnlineConflicts,
  localOrders,
  paymentAttempts,
  paymentEvents,
  paymentIntents,
  paymentOutbox,
  paymentReviewExceptions,
} from '../db/schema.js'
import {
  LocalError,
  insertAudit,
  nextUpdatedAt,
  type LocalActor,
  type LocalTransaction,
} from '../local/shared.js'
import { insertOrderEvent, readLocalOrderDetail } from '../local/orders.js'
import { redeemCouponForOrder } from '../purchase-reward/coupon-usage.js'
import { releaseUnpaidOrderCoupon } from '../purchase-reward/coupon-recovery.js'
import { PAYABLE_ORDER_STATUSES } from './service.js'

/** Same 15 minute intent window PAY-02 uses; a zero-amount intent never calls a channel. */
const ZERO_AMOUNT_INTENT_TTL_MS = 15 * 60 * 1000

/**
 * The payable set as a typed list, so the SQL projection uses exactly the same
 * vocabulary as the boolean gate from PAY-02.
 */
const PAYABLE_ORDER_STATUS_LIST = ['registered', 'processing', 'pending_review'] as const

/** Result of projecting one `payment.paid.v1` outbox row onto its order. */
export type PaidOutboxOutcome =
  | { kind: 'completed' }
  | { kind: 'already_completed' }
  | {
      kind: 'conflict'
      conflictKind: LocalOrderOnlineConflictKind
      detail: string
    }
  /** Permanent inconsistency without an order to attach the conflict to. */
  | { kind: 'failed'; error: string }
  /** Transient: safe to retry the same event later. */
  | { kind: 'retry'; error: string }

function clip(text: string, max = 480): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Preserve a manual-review conflict exactly once per dedupe key.
 *
 * This never touches the order status, the coupon or the payment intent: it is
 * the PAY-05 exception queue entry, projected onto the order so staff reading the
 * order detail can see why a trusted payment was not applied.
 */
function recordOrderConflict(
  tx: LocalTransaction,
  input: {
    orderId: string
    paymentIntentId: string | null
    paymentOutboxId: string | null
    dedupeKey: string
    kind: LocalOrderOnlineConflictKind
    detail: string
    now: Date
  },
): boolean {
  const existing = tx.select({ id: localOrderOnlineConflicts.id })
    .from(localOrderOnlineConflicts)
    .where(eq(localOrderOnlineConflicts.dedupeKey, input.dedupeKey))
    .get()
  if (existing) return false
  tx.insert(localOrderOnlineConflicts).values({
    id: randomUUID(),
    localOrderId: input.orderId,
    paymentIntentId: input.paymentIntentId,
    paymentOutboxId: input.paymentOutboxId,
    dedupeKey: input.dedupeKey,
    kind: input.kind,
    detail: clip(input.detail),
    status: 'open',
    createdAt: input.now,
    resolvedAt: null,
  }).run()
  return true
}

/**
 * PAY-05 consumer of the single trusted success event PAY-03 publishes
 * (`payment.paid.v1`). The caller must already run inside a write transaction
 * with the outbox row claimed, so the completion fact and the "delivered"
 * bookkeeping commit together (or not at all).
 *
 * Trust rules enforced here, on top of PAY-03's own evidence validation:
 * - the intent must itself be `paid`, be a channel payment, and belong to the
 *   payload's order/resident/community;
 * - the payload's provider transaction must be the paid attempt's reference;
 * - the frozen order snapshot must equal the intent snapshot and the payload
 *   amount (gross - one coupon = net paid);
 * - the order must still be payable. A cancelled/rejected/verified order never
 *   completes from an event, no matter how trustworthy the money is.
 *
 * The function is a pure state projector: it writes one completion row, one
 * order status projection, one coupon redemption, one timeline event and one
 * audit row. It deliberately writes no ledger fact (PAY-06 owns that).
 */
export function consumePaidOutboxEvent(
  tx: LocalTransaction,
  outbox: typeof paymentOutbox.$inferSelect,
  now: Date,
): PaidOutboxOutcome {
  if (outbox.topic !== 'payment.paid.v1') {
    return { kind: 'failed', error: `未知的支付事件主题：${outbox.topic}` }
  }
  let payload: ReturnType<typeof paymentPaidEventPayloadSchema.parse>
  try {
    payload = paymentPaidEventPayloadSchema.parse(JSON.parse(outbox.payloadJson))
  } catch {
    return { kind: 'failed', error: '支付事件载荷不是合法的 payment.paid.v1 结构' }
  }
  if (outbox.dedupeKey !== `payment.paid:${payload.paymentIntentId}`) {
    return { kind: 'failed', error: `事件去重键与支付单不一致：${outbox.dedupeKey}` }
  }

  const intent = tx.select().from(paymentIntents)
    .where(eq(paymentIntents.id, payload.paymentIntentId))
    .get()
  if (!intent) {
    return { kind: 'failed', error: '支付事件关联的支付意图不存在' }
  }
  // From here on the order id is known from the persisted intent, so a conflict
  // can be attached to an order that actually exists.
  const order = tx.select().from(localOrders)
    .where(eq(localOrders.id, intent.localOrderId))
    .get()

  const inconsistent = (detail: string): PaidOutboxOutcome => {
    if (!order) return { kind: 'failed', error: detail }
    recordOrderConflict(tx, {
      orderId: order.id,
      paymentIntentId: intent.id,
      paymentOutboxId: outbox.id,
      dedupeKey: `paid_event_state_invalid:${intent.id}`,
      kind: 'payment_state_invalid',
      detail,
      now,
    })
    return { kind: 'conflict', conflictKind: 'payment_state_invalid', detail }
  }

  if (intent.kind !== 'channel') {
    return inconsistent('零元支付意图不得产生渠道成功事件')
  }
  if (intent.status !== 'paid') {
    return inconsistent(`支付单不是成功状态：${intent.status}`)
  }
  if (
    intent.localOrderId !== payload.localOrderId ||
    intent.residentUserId !== payload.residentUserId ||
    intent.communityId !== payload.communityId
  ) {
    return inconsistent('支付单与事件的订单/居民/社区归属不一致')
  }
  if (intent.simulated !== payload.simulated) {
    return inconsistent('支付单与事件的模拟标记不一致')
  }
  if (intent.netPayableCents !== payload.amountCents) {
    return inconsistent(
      `事件金额 ${payload.amountCents} 分与支付单净应付 ${intent.netPayableCents} 分不一致`,
    )
  }
  const paidAttempt = tx.select().from(paymentAttempts)
    .where(and(
      eq(paymentAttempts.paymentIntentId, intent.id),
      eq(paymentAttempts.status, 'paid'),
    ))
    .get()
  if (!paidAttempt || paidAttempt.providerTransactionId !== payload.providerTransactionId) {
    return inconsistent('事件渠道交易号与已确认支付尝试不一致')
  }
  if (!order) {
    return { kind: 'failed', error: '支付事件关联的本地订单不存在' }
  }
  if (
    order.residentUserId !== payload.residentUserId ||
    order.communityId !== payload.communityId
  ) {
    return inconsistent('订单与支付事件的居民/社区归属不一致')
  }
  if (
    order.totalCents !== intent.grossAmountCents ||
    order.couponDiscountCents !== intent.discountCents ||
    order.totalCents - order.couponDiscountCents !== payload.amountCents
  ) {
    return inconsistent('订单金额快照与支付单/事件金额不一致')
  }

  const completion = tx.select().from(localOrderOnlineCompletions)
    .where(eq(localOrderOnlineCompletions.localOrderId, order.id))
    .get()
  if (order.status === 'online_completed') {
    if (completion?.paymentIntentId === intent.id) {
      // Exact replay of the same trusted event: idempotent, no second fact.
      return { kind: 'already_completed' }
    }
    recordOrderConflict(tx, {
      orderId: order.id,
      paymentIntentId: intent.id,
      paymentOutboxId: outbox.id,
      dedupeKey: `paid_after_completion:${intent.id}`,
      kind: 'order_already_completed',
      detail: `订单已由另一笔在线完成事实终结，收到支付单 ${intent.id} 的可信成功事件，需人工核对`,
      now,
    })
    return {
      kind: 'conflict',
      conflictKind: 'order_already_completed',
      detail: '订单已在线完成，新的可信支付证据进入人工核对',
    }
  }
  if (!PAYABLE_ORDER_STATUSES[order.status]) {
    recordOrderConflict(tx, {
      orderId: order.id,
      paymentIntentId: intent.id,
      paymentOutboxId: outbox.id,
      dedupeKey: `paid_event_order_not_payable:${intent.id}`,
      kind: 'order_not_payable',
      detail: `订单状态为 ${order.status}，不能在线完成；渠道交易号 ${
        payload.providerTransactionId
      } 的真实到账证据已保留，需人工核对/补偿`,
      now,
    })
    return {
      kind: 'conflict',
      conflictKind: 'order_not_payable',
      detail: `订单状态 ${order.status} 不允许在线完成，已保留待人工核对`,
    }
  }
  if (order.couponId) {
    const coupon = tx.select({
      status: couponIssues.status,
      reservedOrderId: couponIssues.reservedOrderId,
      faceValueCents: couponIssues.faceValueCents,
    }).from(couponIssues)
      .where(eq(couponIssues.id, order.couponId))
      .get()
    if (
      !coupon ||
      coupon.status !== 'reserved' ||
      coupon.reservedOrderId !== order.id ||
      coupon.faceValueCents !== order.couponDiscountCents
    ) {
      recordOrderConflict(tx, {
        orderId: order.id,
        paymentIntentId: intent.id,
        paymentOutboxId: outbox.id,
        dedupeKey: `paid_event_coupon_conflict:${intent.id}`,
        kind: 'coupon_state_invalid',
        detail: `支付已可信成功，但订单消费券不可核销（状态 ${
          coupon?.status ?? '缺失'
        }），禁止自动完成，需人工核对`,
        now,
      })
      return {
        kind: 'conflict',
        conflictKind: 'coupon_state_invalid',
        detail: '消费券状态异常，可信支付未自动完成订单',
      }
    }
  }

  tx.insert(localOrderOnlineCompletions).values({
    id: randomUUID(),
    localOrderId: order.id,
    paymentIntentId: intent.id,
    kind: 'channel',
    simulated: intent.simulated,
    grossAmountCents: order.totalCents,
    discountCents: order.couponDiscountCents,
    amountCents: payload.amountCents,
    providerTransactionId: payload.providerTransactionId,
    completedAt: new Date(payload.paidAt),
    createdAt: now,
  }).run()

  const updatedAt = nextUpdatedAt(order.updatedAt, now)
  const projected = tx.update(localOrders).set({
    status: 'online_completed',
    updatedAt,
  }).where(and(
    eq(localOrders.id, order.id),
    inArray(localOrders.status, PAYABLE_ORDER_STATUS_LIST),
  )).run()
  if (projected.changes !== 1) {
    // Unreachable inside one IMMEDIATE transaction; surface it as a retry rather
    // than pretending the order completed.
    throw new Error('订单状态在在线完成投影时被并发修改')
  }

  if (order.couponId) {
    redeemCouponForOrder(tx, order.id, now)
  }

  insertOrderEvent(tx, {
    orderId: order.id,
    actorUserId: null,
    actorStaffId: null,
    event: 'order.online_completed',
    fromStatus: order.status,
    toStatus: 'online_completed',
    note: payload.simulated
      ? '在线交易完成（隔离模拟渠道可信成功事件）'
      : '在线交易完成（支付渠道可信成功事件）',
    createdAt: now,
  })
  insertAudit(tx, null, 'local_order.online_completed', order.id, now, {
    paymentIntentId: intent.id,
    kind: 'channel',
    simulated: String(payload.simulated),
    amountCents: String(payload.amountCents),
    grossAmountCents: String(order.totalCents),
    couponDiscountCents: String(order.couponDiscountCents),
    providerTransactionId: payload.providerTransactionId,
    outboxId: outbox.id,
  })
  return { kind: 'completed' }
}

/**
 * The independent zero-amount completion path (#280 scope 3).
 *
 * A fully coupon-discounted order must never call a channel (PAY-02 refuses a
 * zero net payable on purpose). The resident triggers this endpoint instead; the
 * server re-derives gross/discount/net from SQLite, re-checks the coupon is still
 * reserved to this order, and completes everything in one transaction:
 * payment-domain `kind='zero_amount'` row (no channel, no provider reference),
 * the immutable completion fact, the order projection, the coupon redemption and
 * the audit trail.
 *
 * Idempotent per order: the second call returns `created:false` and touches
 * nothing. It contributes no positive cash and no `payment.paid.v1` evidence, so
 * it can never count as real net spend (PAY-06).
 */
export function completeZeroAmountOrder(
  db: AppDatabase,
  actor: LocalActor,
  orderId: string,
  options: { now?: Date } = {},
): LocalOrderOnlineCompletionResponse {
  const now = options.now ?? new Date()
  const created = db.transaction((tx): boolean => {
    const order = tx.select().from(localOrders).where(eq(localOrders.id, orderId)).get()
    if (!order || order.residentUserId !== actor.userId) {
      throw new LocalError(404, API_ERROR_CODES.notFound, '本地订单不存在')
    }
    const completion = tx.select({ kind: localOrderOnlineCompletions.kind })
      .from(localOrderOnlineCompletions)
      .where(eq(localOrderOnlineCompletions.localOrderId, order.id))
      .get()
    if (completion) {
      if (completion.kind === 'zero_amount') return false
      throw new LocalError(
        409,
        API_ERROR_CODES.paymentAlreadyPaid,
        '该订单已通过在线支付完成，不能重复零元完成',
      )
    }
    if (!PAYABLE_ORDER_STATUSES[order.status]) {
      throw new LocalError(
        409,
        API_ERROR_CODES.paymentNotPayable,
        '当前订单状态不可完成在线交易',
      )
    }
    const netPayableCents = order.totalCents - order.couponDiscountCents
    if (netPayableCents !== 0) {
      throw new LocalError(
        409,
        API_ERROR_CODES.paymentZeroAmountUnavailable,
        '只有全额消费券抵扣的零元订单可走零元完成路径',
      )
    }
    if (
      !order.couponId ||
      order.couponDiscountCents <= 0 ||
      order.couponDiscountCents !== order.totalCents
    ) {
      throw new LocalError(
        409,
        API_ERROR_CODES.conflict,
        '零元订单缺少有效的全额消费券抵扣快照',
      )
    }

    const paidChannelIntent = tx.select({ id: paymentIntents.id }).from(paymentIntents)
      .where(and(
        eq(paymentIntents.localOrderId, order.id),
        eq(paymentIntents.status, 'paid'),
      ))
      .get()
    if (paidChannelIntent) {
      throw new LocalError(
        409,
        API_ERROR_CODES.paymentAlreadyPaid,
        '该订单已有有效支付，不能重复完成',
      )
    }

    // Re-check the coupon inside this transaction; a released/void/redeemed
    // coupon must block completion instead of being silently re-consumed.
    const coupon = tx.select({
      status: couponIssues.status,
      reservedOrderId: couponIssues.reservedOrderId,
      userId: couponIssues.userId,
      faceValueCents: couponIssues.faceValueCents,
    }).from(couponIssues)
      .where(eq(couponIssues.id, order.couponId))
      .get()
    if (
      !coupon ||
      coupon.userId !== order.residentUserId ||
      coupon.status !== 'reserved' ||
      coupon.reservedOrderId !== order.id ||
      coupon.faceValueCents !== order.couponDiscountCents
    ) {
      throw new LocalError(
        409,
        API_ERROR_CODES.conflict,
        '消费券未绑定该订单或已释放/已核销，不能零元完成',
      )
    }

    const intentId = randomUUID()
    tx.insert(paymentIntents).values({
      id: intentId,
      localOrderId: order.id,
      residentUserId: order.residentUserId,
      communityId: order.communityId,
      kind: 'zero_amount',
      channel: null,
      simulated: false,
      // `ZERO-` + 27 hex = 32 chars, the same channel-safe ceiling PAY-02 uses.
      merchantOrderNo: `ZERO-${intentId.replace(/-/gu, '').toUpperCase().slice(0, 27)}`,
      merchantAppId: null,
      merchantId: null,
      grossAmountCents: order.totalCents,
      discountCents: order.couponDiscountCents,
      netPayableCents: 0,
      status: 'paid',
      idempotencyKey: `zero-amount:${order.id}`,
      expiresAt: new Date(now.getTime() + ZERO_AMOUNT_INTENT_TTL_MS),
      paidAt: now,
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      createdAt: now,
      updatedAt: now,
    }).run()
    tx.insert(paymentEvents).values({
      id: randomUUID(),
      paymentIntentId: intentId,
      paymentAttemptId: null,
      eventType: 'payment.status_changed',
      source: 'system',
      fromStatus: null,
      toStatus: 'paid',
      providerEventRef: null,
      dedupeKey: `payment.zero_amount.completed:${intentId}`,
      note: '零元券单完成：全额消费券抵扣，无渠道支付',
      createdAt: now,
    }).run()

    tx.insert(localOrderOnlineCompletions).values({
      id: randomUUID(),
      localOrderId: order.id,
      paymentIntentId: intentId,
      kind: 'zero_amount',
      simulated: false,
      grossAmountCents: order.totalCents,
      discountCents: order.couponDiscountCents,
      amountCents: 0,
      providerTransactionId: null,
      completedAt: now,
      createdAt: now,
    }).run()

    const updatedAt = nextUpdatedAt(order.updatedAt, now)
    const projected = tx.update(localOrders).set({
      status: 'online_completed',
      updatedAt,
    }).where(and(
      eq(localOrders.id, order.id),
      inArray(localOrders.status, PAYABLE_ORDER_STATUS_LIST),
    )).run()
    if (projected.changes !== 1) {
      throw new LocalError(409, API_ERROR_CODES.conflict, '订单已被其他操作更新，请刷新后重试')
    }

    redeemCouponForOrder(tx, order.id, now)

    insertOrderEvent(tx, {
      orderId: order.id,
      actorUserId: actor.userId,
      actorStaffId: null,
      event: 'order.online_completed',
      fromStatus: order.status,
      toStatus: 'online_completed',
      note: '零元券单在线完成（全额消费券抵扣，无渠道支付）',
      createdAt: now,
    })
    insertAudit(tx, actor.userId, 'local_order.online_completed', order.id, now, {
      paymentIntentId: intentId,
      kind: 'zero_amount',
      amountCents: '0',
      grossAmountCents: String(order.totalCents),
      couponDiscountCents: String(order.couponDiscountCents),
    })
    return true
  }, { behavior: 'immediate' })

  return localOrderOnlineCompletionResponseSchema.parse({
    created,
    order: readLocalOrderDetail(db, orderId),
  })
}

/** Statuses whose deferred coupon release may still be settled. */
const RELEASABLE_ORDER_STATUSES = ['cancelled', 'rejected'] as const

/**
 * Settle coupon reservations that were deliberately deferred because a payment
 * intent was still live, and only now have a trusted terminal channel result.
 *
 * Preconditions mirror `releaseUnpaidOrderCoupon` exactly, plus:
 * - no intent is `pending`/`confirming` (a payment could still capture money);
 * - no intent is `paid` (real money arrived: never auto-release, human review).
 *
 * Expiry alone is never used as evidence: only PAY-03's trusted `closed`/`failed`
 * terminal state makes the reservation releasable. The release itself is the
 * #212/#213 routine, so a coupon is released at most once and never restored
 * from `redeemed`/`void`.
 */
export function settleDeferredCouponReleases(
  db: AppDatabase,
  now: Date,
  options: { limit?: number } = {},
): number {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 200)
  return db.transaction((tx): number => {
    // Filter before LIMIT: a large backlog of still-live payments must not occupy
    // every batch slot and starve reservations that have trusted terminal evidence.
    // A preserved late-success exception is also a hard hold, even if the intent
    // itself is now closed/failed.
    const candidates = tx.select({
      id: localOrders.id,
      couponId: localOrders.couponId,
    }).from(localOrders)
      .innerJoin(couponIssues, and(
        eq(couponIssues.id, localOrders.couponId),
        eq(couponIssues.status, 'reserved'),
        eq(couponIssues.reservedOrderId, localOrders.id),
      ))
      .where(and(
        inArray(localOrders.status, RELEASABLE_ORDER_STATUSES),
        notExists(
          tx.select({ one: sql`1` }).from(ledgerPaymentOrderLinks)
            .where(eq(ledgerPaymentOrderLinks.orderId, localOrders.id)),
        ),
        notExists(
          tx.select({ one: sql`1` }).from(paymentIntents)
            .where(and(
              eq(paymentIntents.localOrderId, localOrders.id),
              inArray(paymentIntents.status, ['pending', 'confirming', 'paid']),
            )),
        ),
        notExists(
          tx.select({ one: sql`1` }).from(paymentReviewExceptions)
            .innerJoin(paymentIntents, eq(paymentReviewExceptions.paymentIntentId, paymentIntents.id))
            .where(and(
              eq(paymentIntents.localOrderId, localOrders.id),
              inArray(paymentReviewExceptions.kind, [
                'late_success_after_closed',
                'late_success_after_failed',
              ]),
            )),
        ),
      ))
      .orderBy(asc(localOrders.createdAt), asc(localOrders.id))
      .limit(limit)
      .all()

    let released = 0
    for (const order of candidates) {
      if (!order.couponId) continue
      const coupon = tx.select({
        status: couponIssues.status,
        reservedOrderId: couponIssues.reservedOrderId,
      }).from(couponIssues)
        .where(eq(couponIssues.id, order.couponId))
        .get()
      if (!coupon || coupon.status !== 'reserved' || coupon.reservedOrderId !== order.id) {
        continue
      }
      const intents = tx.select({ status: paymentIntents.status })
        .from(paymentIntents)
        .where(eq(paymentIntents.localOrderId, order.id))
        .all()
      if (intents.some((intent) => intent.status === 'pending' || intent.status === 'confirming')) {
        continue
      }
      if (intents.some((intent) => intent.status === 'paid')) {
        continue
      }
      const result = releaseUnpaidOrderCoupon(tx, order.id, now)
      if (result === 'released') released += 1
    }
    return released
  }, { behavior: 'immediate' })
}

/**
 * Project PAY-03's preserved late-success exceptions onto their order.
 *
 * PAY-03 refuses `closed -> paid` and stores the trusted evidence in
 * `payment_review_exceptions`; this projection makes that fact visible on the
 * order staff actually look at. Restating PAY-03's rule here: the released coupon
 * is NOT re-reserved and the order stays cancelled/rejected.
 */
export function projectPaymentExceptionsOntoOrders(
  db: AppDatabase,
  now: Date,
  options: { limit?: number } = {},
): number {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 200)
  return db.transaction((tx): number => {
    const exceptions = tx.select({
      id: paymentReviewExceptions.id,
      paymentIntentId: paymentReviewExceptions.paymentIntentId,
      kind: paymentReviewExceptions.kind,
      providerTransactionId: paymentReviewExceptions.providerTransactionId,
      amountCents: paymentReviewExceptions.amountCents,
      detail: paymentReviewExceptions.detail,
    }).from(paymentReviewExceptions)
      .where(and(
        eq(paymentReviewExceptions.status, 'open'),
        inArray(paymentReviewExceptions.kind, [
          'late_success_after_closed',
          'late_success_after_failed',
        ]),
        isNotNull(paymentReviewExceptions.paymentIntentId),
        // Keep already-projected exceptions out of the bounded candidate set.
        // Otherwise the oldest 200 open rows permanently starve later evidence.
        notExists(
          tx.select({ one: sql`1` }).from(localOrderOnlineConflicts)
            .where(eq(
              localOrderOnlineConflicts.dedupeKey,
              sql`'payment_review_exception:' || ${paymentReviewExceptions.id}`,
            )),
        ),
      ))
      .orderBy(asc(paymentReviewExceptions.createdAt), asc(paymentReviewExceptions.id))
      .limit(limit)
      .all()

    let projected = 0
    for (const exception of exceptions) {
      const intent = tx.select({ localOrderId: paymentIntents.localOrderId })
        .from(paymentIntents)
        .where(eq(paymentIntents.id, exception.paymentIntentId!))
        .get()
      if (!intent) continue
      const order = tx.select({ id: localOrders.id, status: localOrders.status })
        .from(localOrders)
        .where(eq(localOrders.id, intent.localOrderId))
        .get()
      if (!order) continue
      const inserted = recordOrderConflict(tx, {
        orderId: order.id,
        paymentIntentId: exception.paymentIntentId,
        paymentOutboxId: null,
        dedupeKey: `payment_review_exception:${exception.id}`,
        kind: 'late_success',
        detail: `支付单终结后收到可信成功证据（${exception.kind}）：${
          exception.detail
        }；金额 ${exception.amountCents ?? '未知'} 分，渠道交易号 ${
          exception.providerTransactionId ?? '未知'
        }。订单保持 ${order.status}，消费券不自动重新占用，需人工核对/补偿`,
        now,
      })
      if (inserted) projected += 1
    }
    return projected
  }, { behavior: 'immediate' })
}
