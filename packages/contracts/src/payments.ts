import { z } from 'zod'

/**
 * PAY-01 payment domain contracts.
 *
 * This module is the shared truth source for a payment intent, its channel
 * attempts and its append-only event trail. It deliberately does NOT define
 * routers, a channel gateway, order fulfilment, receipts, ledger projection or
 * refunds: those are PAY-02…PAY-11.
 *
 * Three facts stay separate:
 * - `local_orders.verified` is a human business verification;
 * - `payment_intents.status = 'paid'` is a trusted channel/zero-amount payment
 *   fact (PAY-03/PAY-05 will produce it);
 * - `payment_received` in the ledger is a manual receipt with evidence.
 *
 * No field here means "settled to the company bank account".
 *
 * Refund boundary: PAY-01 intentionally has no refund table or refund status.
 * A future refund row will reference `payment_intents.id` and carry its own
 * lifecycle; a paid payment is never represented as "refunded" by mutating this
 * status. The channel transaction reference and immutable amounts are the stable
 * anchors that future refund records can use.
 */

export const PAYMENT_CENTS_MAX = Number.MAX_SAFE_INTEGER

/** Non-negative integer cents; rejects floats, negatives and overflow. */
export const paymentCentsSchema = z
  .number()
  .int('金额必须为整数分')
  .min(0, '金额不能为负数')
  .max(PAYMENT_CENTS_MAX, '金额超出安全整数范围')

export const paymentChannelSchema = z.enum(['mock', 'wechat_jsapi'])
export type PaymentChannel = z.infer<typeof paymentChannelSchema>

/** A channel payment, or the independent zero-amount completion path. */
export const paymentIntentKindSchema = z.enum(['channel', 'zero_amount'])
export type PaymentIntentKind = z.infer<typeof paymentIntentKindSchema>

/**
 * Payment states only. Bank settlement, order fulfilment and refunds are
 * different facts and are intentionally absent.
 */
export const paymentStatusSchema = z.enum([
  'pending',
  'confirming',
  'paid',
  'closed',
  'failed',
])
export type PaymentStatus = z.infer<typeof paymentStatusSchema>

/** Attempts share the payment lifecycle; zero-amount intents have no attempt. */
export const paymentAttemptStatusSchema = paymentStatusSchema
export type PaymentAttemptStatus = z.infer<typeof paymentAttemptStatusSchema>

/** Server-owned state machine mirrored by the SQLite triggers. */
export const PAYMENT_STATUS_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  pending: ['confirming', 'paid', 'closed', 'failed'],
  confirming: ['paid', 'closed', 'failed'],
  paid: [],
  closed: [],
  failed: [],
}

export function canTransitionPaymentStatus(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return PAYMENT_STATUS_TRANSITIONS[from].includes(to)
}

export const paymentEventTypeSchema = z.enum([
  'payment.intent_created',
  'payment.attempt_created',
  'payment.status_changed',
  'payment.channel_notification',
  'payment.channel_query',
])
export type PaymentEventType = z.infer<typeof paymentEventTypeSchema>

export const paymentEventSourceSchema = z.enum([
  'system',
  'channel',
  'admin',
  'reconciliation',
])
export type PaymentEventSource = z.infer<typeof paymentEventSourceSchema>

const merchantPartSchema = z.string().trim().min(1).max(64)

/**
 * One payment intent for a local order. Multiple intents per order are legal
 * (a closed/failed attempt may be retried), but the database allows at most one
 * `paid` intent for an order.
 */
export const paymentIntentSchema = z
  .strictObject({
    id: z.string().uuid(),
    localOrderId: z.string().uuid(),
    residentUserId: z.string().uuid(),
    communityId: z.string().uuid(),
    kind: paymentIntentKindSchema,
    /** Null exactly for `zero_amount`; never a free-form payment method. */
    channel: paymentChannelSchema.nullable(),
    /** Persistently distinguishes simulated money from real channel money. */
    simulated: z.boolean(),
    merchantOrderNo: merchantPartSchema,
    merchantAppId: merchantPartSchema.nullable(),
    merchantId: merchantPartSchema.nullable(),
    grossAmountCents: paymentCentsSchema,
    discountCents: paymentCentsSchema,
    netPayableCents: paymentCentsSchema,
    status: paymentStatusSchema,
    idempotencyKey: z.string().trim().min(8).max(128),
    expiresAt: z.string().datetime({ offset: true }),
    paidAt: z.string().datetime({ offset: true }).nullable(),
    closedAt: z.string().datetime({ offset: true }).nullable(),
    failedAt: z.string().datetime({ offset: true }).nullable(),
    failureCode: z.string().trim().min(1).max(64).nullable(),
    failureMessage: z.string().trim().min(1).max(500).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((value, ctx) => {
    if (value.grossAmountCents - value.discountCents !== value.netPayableCents) {
      ctx.addIssue({
        code: 'custom',
        message: 'gross - discount must equal netPayable',
        path: ['netPayableCents'],
      })
    }
    if (value.kind === 'zero_amount') {
      if (value.channel !== null) {
        ctx.addIssue({ code: 'custom', message: 'zero_amount has no channel', path: ['channel'] })
      }
      if (value.simulated) {
        ctx.addIssue({ code: 'custom', message: 'zero_amount is not simulated', path: ['simulated'] })
      }
      if (value.netPayableCents !== 0) {
        ctx.addIssue({ code: 'custom', message: 'zero_amount requires zero net payable', path: ['netPayableCents'] })
      }
      if (value.status !== 'paid' || value.paidAt === null) {
        ctx.addIssue({ code: 'custom', message: 'zero_amount is completed as paid', path: ['status'] })
      }
    } else {
      if (value.channel === null) {
        ctx.addIssue({ code: 'custom', message: 'channel payment requires a channel', path: ['channel'] })
      }
      if (value.channel === 'mock' && !value.simulated) {
        ctx.addIssue({ code: 'custom', message: 'mock must be simulated', path: ['simulated'] })
      }
      if (value.channel === 'wechat_jsapi' && value.simulated) {
        ctx.addIssue({ code: 'custom', message: 'wechat_jsapi cannot be simulated', path: ['simulated'] })
      }
      if (value.netPayableCents <= 0) {
        ctx.addIssue({ code: 'custom', message: 'channel payment requires positive net payable', path: ['netPayableCents'] })
      }
    }
    if (value.status === 'paid' && value.paidAt === null) {
      ctx.addIssue({ code: 'custom', message: 'paid requires paidAt', path: ['paidAt'] })
    }
    if (value.status === 'closed' && value.closedAt === null) {
      ctx.addIssue({ code: 'custom', message: 'closed requires closedAt', path: ['closedAt'] })
    }
    if (value.status === 'failed' && value.failedAt === null) {
      ctx.addIssue({ code: 'custom', message: 'failed requires failedAt', path: ['failedAt'] })
    }
  })
export type PaymentIntent = z.infer<typeof paymentIntentSchema>

export const paymentAttemptSchema = z
  .strictObject({
    id: z.string().uuid(),
    paymentIntentId: z.string().uuid(),
    attemptNo: z.number().int().min(1),
    status: paymentAttemptStatusSchema,
    idempotencyKey: z.string().trim().min(8).max(128),
    providerTransactionId: z.string().trim().min(1).max(128).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    confirmedAt: z.string().datetime({ offset: true }).nullable(),
    closedAt: z.string().datetime({ offset: true }).nullable(),
    failedAt: z.string().datetime({ offset: true }).nullable(),
    failureCode: z.string().trim().min(1).max(64).nullable(),
    failureMessage: z.string().trim().min(1).max(500).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'paid' && (value.confirmedAt === null || value.providerTransactionId === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'paid attempt requires confirmedAt and providerTransactionId',
        path: ['status'],
      })
    }
    if (value.status === 'closed' && value.closedAt === null) {
      ctx.addIssue({ code: 'custom', message: 'closed requires closedAt', path: ['closedAt'] })
    }
    if (value.status === 'failed' && value.failedAt === null) {
      ctx.addIssue({ code: 'custom', message: 'failed requires failedAt', path: ['failedAt'] })
    }
  })
export type PaymentAttempt = z.infer<typeof paymentAttemptSchema>

/**
 * Append-only payment event. `dedupeKey` is the future notification/query
 * idempotency key; the database enforces global uniqueness when present.
 */
export const paymentEventSchema = z.strictObject({
  id: z.string().uuid(),
  paymentIntentId: z.string().uuid(),
  paymentAttemptId: z.string().uuid().nullable(),
  eventType: paymentEventTypeSchema,
  source: paymentEventSourceSchema,
  fromStatus: paymentStatusSchema.nullable(),
  toStatus: paymentStatusSchema.nullable(),
  providerEventRef: z.string().trim().min(1).max(128).nullable(),
  dedupeKey: z.string().trim().min(1).max(200).nullable(),
  note: z.string().trim().min(1).max(500).nullable(),
  createdAt: z.string().datetime({ offset: true }),
})
export type PaymentEvent = z.infer<typeof paymentEventSchema>

/* -------------------------------------------------------------------------- */
/* Base create/query DTOs for PAY-02 (no route is registered by this card)    */
/* -------------------------------------------------------------------------- */

/**
 * A resident asks to pay one existing local order. The server derives the
 * resident, community, amounts, merchant order number, merchant context and
 * zero-amount kind; none of those are client input.
 */
export const createPaymentIntentRequestSchema = z.strictObject({
  localOrderId: z.string().uuid(),
  channel: paymentChannelSchema,
  /** Client retry key for this create request; server also derives a stable merchant order number. */
  idempotencyKey: z.string().trim().min(8).max(128),
})
export type CreatePaymentIntentRequest = z.infer<typeof createPaymentIntentRequestSchema>

export const updatePaymentStatusRequestSchema = z.strictObject({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  status: paymentStatusSchema,
  note: z.string().trim().max(500).optional(),
})
export type UpdatePaymentStatusRequest = z.infer<typeof updatePaymentStatusRequestSchema>

export const paymentIntentListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  localOrderId: z.string().uuid().optional(),
  communityId: z.string().uuid().optional(),
  status: paymentStatusSchema.optional(),
  channel: paymentChannelSchema.optional(),
  merchantOrderNo: z.string().trim().min(1).max(64).optional(),
})
export type PaymentIntentListQuery = z.infer<typeof paymentIntentListQuerySchema>

export const paymentIntentListResponseSchema = z.strictObject({
  items: z.array(paymentIntentSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
})
export type PaymentIntentListResponse = z.infer<typeof paymentIntentListResponseSchema>

export const paymentEventListResponseSchema = z.strictObject({
  items: z.array(paymentEventSchema),
})
export type PaymentEventListResponse = z.infer<typeof paymentEventListResponseSchema>
