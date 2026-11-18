import { z } from 'zod'

/**
 * PAY-01/PAY-02 payment domain contracts.
 *
 * This module is the shared truth source for a payment intent, its channel
 * attempts, its append-only event trail and the resident creation/query DTOs.
 * It deliberately does NOT implement a channel gateway, order fulfilment,
 * receipts, ledger projection or refunds: those are later payment cards.
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

/** Resident-only payment routes. No payment status write route exists. */
export const PAYMENT_ROUTES = {
  createIntent: '/payments/intents',
  myIntentDetail: '/payments/intents/:paymentIntentId',
  /** Public, read-only payment-channel capability flags (never a status write). */
  capabilities: '/payments/capabilities',
  /**
   * Resident-owned Mock action. Only available when the server explicitly
   * advertises `mockAvailable`; it still goes through PAY-03 confirmation.
   */
  mockAction: '/payments/intents/:paymentIntentId/mock',
} as const

/** Internal adapter/test surface; requires a server-side token, never a resident session. */
export const PAYMENT_INTERNAL_ROUTES = {
  confirm: '/internal/payments/confirm',
  /**
   * PAY-05 downstream consumer trigger. It drains the durable `payment.paid.v1`
   * outbox into order completion and settles deferred coupon releases. It is
   * token-gated like `confirm`: a browser or resident session cannot drive
   * trust-bearing payment projections.
   */
  consumeOutbox: '/internal/payments/outbox/consume',
} as const

/**
 * Server capability truth for the resident payment UI. The browser must never
 * infer a channel from its own build mode; only these flags and their reasons
 * decide whether a payment button exists.
 */
export const paymentCapabilitiesSchema = z.strictObject({
  mockAvailable: z.boolean(),
  wechatJsapiAvailable: z.boolean(),
  zeroAmountAvailable: z.boolean(),
  mockUnavailableReason: z.enum(['mock_disabled']).nullable(),
  wechatUnavailableReason: z.enum(['not_configured']).nullable(),
})
export type PaymentCapabilities = z.infer<typeof paymentCapabilitiesSchema>

/** Mock-only UI actions. No amount, merchant, transaction id or raw evidence. */
export const mockPaymentActionSchema = z.enum(['succeed', 'fail', 'cancel', 'timeout', 'pending'])
export type MockPaymentAction = z.infer<typeof mockPaymentActionSchema>

export const mockPaymentActionRequestSchema = z.strictObject({
  action: mockPaymentActionSchema,
  /** Defaults to a provider notification; query is useful for recovery replay. */
  source: z.enum(['notification', 'query']).default('notification'),
})
export type MockPaymentActionRequest = z.infer<typeof mockPaymentActionRequestSchema>

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
 * WeChat JSAPI `out_trade_no` is 6-32 characters. Keep the shared contract at
 * least as strict as the real channel so PAY-02 already produces a usable id.
 */
const merchantOrderNoSchema = z
  .string()
  .trim()
  .min(6)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, 'merchant order number must be channel-safe')

/**
 * Match the SQLite terminal_time CHECK constraints exactly. A terminal state
 * owns one timestamp; the other terminal timestamps must be null. Failure
 * details are meaningful only in the failed state.
 */
function terminalFactIssues(
  status: PaymentStatus,
  timestamps: { paid: string | null; closed: string | null; failed: string | null },
  failure: { code: string | null; message: string | null },
  paidField: 'paidAt' | 'confirmedAt',
): Array<{ path: string[]; message: string }> {
  const issues: Array<{ path: string[]; message: string }> = []
  const fields = [
    { state: 'paid', field: paidField, value: timestamps.paid },
    { state: 'closed', field: 'closedAt', value: timestamps.closed },
    { state: 'failed', field: 'failedAt', value: timestamps.failed },
  ] as const

  for (const field of fields) {
    if ((status === field.state) !== (field.value !== null)) {
      issues.push({
        path: [field.field],
        message: `${field.field} must be set exactly when status is ${field.state}`,
      })
    }
  }
  if (status !== 'failed') {
    if (failure.code !== null) {
      issues.push({ path: ['failureCode'], message: 'failureCode requires failed status' })
    }
    if (failure.message !== null) {
      issues.push({ path: ['failureMessage'], message: 'failureMessage requires failed status' })
    }
  }
  return issues
}

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
    merchantOrderNo: merchantOrderNoSchema,
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
    for (const issue of terminalFactIssues(
      value.status,
      { paid: value.paidAt, closed: value.closedAt, failed: value.failedAt },
      { code: value.failureCode, message: value.failureMessage },
      'paidAt',
    )) {
      ctx.addIssue({ code: 'custom', ...issue })
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
    for (const issue of terminalFactIssues(
      value.status,
      { paid: value.confirmedAt, closed: value.closedAt, failed: value.failedAt },
      { code: value.failureCode, message: value.failureMessage },
      'confirmedAt',
    )) {
      ctx.addIssue({ code: 'custom', ...issue })
    }
    if (value.status === 'paid' && value.providerTransactionId === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'paid attempt requires providerTransactionId',
        path: ['providerTransactionId'],
      })
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
/* PAY-03 trusted provider evidence, outbox and review exceptions             */
/* -------------------------------------------------------------------------- */

/** Normalized result supplied only by a trusted provider adapter (PAY-11). */
export const paymentEvidenceStatusSchema = z.enum(['paid', 'failed', 'closed', 'pending'])
export type PaymentEvidenceStatus = z.infer<typeof paymentEvidenceStatusSchema>

export const paymentEvidenceSourceSchema = z.enum(['notification', 'query'])
export type PaymentEvidenceSource = z.infer<typeof paymentEvidenceSourceSchema>

export const paymentEvidenceSchema = z
  .strictObject({
    merchantOrderNo: merchantOrderNoSchema,
    channel: paymentChannelSchema,
    providerStatus: paymentEvidenceStatusSchema,
    /** Required for a paid result; null for pending/closed/failed evidence. */
    providerTransactionId: z.string().trim().min(1).max(128).nullable(),
    amountCents: paymentCentsSchema,
    currency: z.literal('CNY'),
    merchantAppId: z.string().trim().min(1).max(64).nullable(),
    merchantId: z.string().trim().min(1).max(64).nullable(),
    observedAt: z.string().datetime({ offset: true }),
    source: paymentEvidenceSourceSchema,
    /** Provider event/query identity; the database enforces global uniqueness. */
    dedupeKey: z.string().trim().min(1).max(200),
    providerEventRef: z.string().trim().min(1).max(128).nullable(),
    failureCode: z.string().trim().min(1).max(64).nullable(),
    failureMessage: z.string().trim().min(1).max(500).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.providerStatus === 'paid' && value.providerTransactionId === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'paid evidence requires providerTransactionId',
        path: ['providerTransactionId'],
      })
    }
    if (value.channel === 'wechat_jsapi') {
      if (value.merchantAppId === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'wechat evidence requires merchantAppId',
          path: ['merchantAppId'],
        })
      }
      if (value.merchantId === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'wechat evidence requires merchantId',
          path: ['merchantId'],
        })
      }
    }
  })
export type PaymentEvidence = z.infer<typeof paymentEvidenceSchema>

export const paymentConfirmationOutcomeSchema = z.enum([
  'confirmed',
  'already_confirmed',
  'recorded',
])
export type PaymentConfirmationOutcome = z.infer<typeof paymentConfirmationOutcomeSchema>

export const paymentConfirmationResponseSchema = z.strictObject({
  outcome: paymentConfirmationOutcomeSchema,
  intent: paymentIntentSchema,
  attempt: paymentAttemptSchema.nullable(),
  outboxEventId: z.string().uuid().nullable(),
})
export type PaymentConfirmationResponse = z.infer<typeof paymentConfirmationResponseSchema>

/** Stable downstream handoff payload; PAY-05/PAY-06 own its consumption. */
export const paymentPaidEventPayloadSchema = z.strictObject({
  paymentIntentId: z.string().uuid(),
  localOrderId: z.string().uuid(),
  residentUserId: z.string().uuid(),
  communityId: z.string().uuid(),
  amountCents: paymentCentsSchema,
  providerTransactionId: z.string().trim().min(1).max(128),
  simulated: z.boolean(),
  paidAt: z.string().datetime({ offset: true }),
})
export type PaymentPaidEventPayload = z.infer<typeof paymentPaidEventPayloadSchema>

export const paymentOutboxStatusSchema = z.enum(['pending', 'processing', 'delivered', 'failed'])
export type PaymentOutboxStatus = z.infer<typeof paymentOutboxStatusSchema>

export const paymentOutboxEventSchema = z.strictObject({
  id: z.string().uuid(),
  paymentIntentId: z.string().uuid(),
  paymentEventId: z.string().uuid(),
  topic: z.literal('payment.paid.v1'),
  dedupeKey: z.string().trim().min(1).max(200),
  payload: paymentPaidEventPayloadSchema,
  status: paymentOutboxStatusSchema,
  attempts: z.number().int().nonnegative(),
  availableAt: z.string().datetime({ offset: true }),
  lastError: z.string().trim().min(1).max(500).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  deliveredAt: z.string().datetime({ offset: true }).nullable(),
})
export type PaymentOutboxEvent = z.infer<typeof paymentOutboxEventSchema>

export const paymentReviewExceptionKindSchema = z.enum([
  'intent_not_found',
  'amount_mismatch',
  'merchant_mismatch',
  'channel_mismatch',
  'ownership_mismatch',
  'transaction_conflict',
  'late_success_after_closed',
  'late_success_after_failed',
  'terminal_conflict',
  'unknown_evidence',
])
export type PaymentReviewExceptionKind = z.infer<typeof paymentReviewExceptionKindSchema>

export const paymentReviewExceptionSchema = z.strictObject({
  id: z.string().uuid(),
  paymentIntentId: z.string().uuid().nullable(),
  merchantOrderNo: merchantOrderNoSchema,
  channel: paymentChannelSchema,
  providerTransactionId: z.string().trim().min(1).max(128).nullable(),
  amountCents: paymentCentsSchema.nullable(),
  merchantAppId: z.string().trim().min(1).max(64).nullable(),
  merchantId: z.string().trim().min(1).max(64).nullable(),
  observedAt: z.string().datetime({ offset: true }),
  source: paymentEvidenceSourceSchema,
  dedupeKey: z.string().trim().min(1).max(200),
  providerEventRef: z.string().trim().min(1).max(128).nullable(),
  failureCode: z.string().trim().min(1).max(64).nullable(),
  failureMessage: z.string().trim().min(1).max(500).nullable(),
  kind: paymentReviewExceptionKindSchema,
  detail: z.string().trim().min(1).max(500),
  status: z.enum(['open', 'reviewed', 'resolved']),
  createdAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).nullable(),
})
export type PaymentReviewException = z.infer<typeof paymentReviewExceptionSchema>

export const paymentReviewExceptionListResponseSchema = z.strictObject({
  items: z.array(paymentReviewExceptionSchema),
})
export type PaymentReviewExceptionListResponse = z.infer<
  typeof paymentReviewExceptionListResponseSchema
>

/* -------------------------------------------------------------------------- */
/* PAY-02 resident create/query DTOs and responses                          */
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

/** Create returns the existing intent with `created:false` on an idempotent retry. */
export const paymentIntentCreateResponseSchema = z.strictObject({
  created: z.boolean(),
  intent: paymentIntentSchema,
})
export type PaymentIntentCreateResponse = z.infer<typeof paymentIntentCreateResponseSchema>

/** Resident-owned detail: the intent plus its attempts; events stay internal. */
export const paymentIntentDetailResponseSchema = z.strictObject({
  intent: paymentIntentSchema,
  attempts: z.array(paymentAttemptSchema),
})
export type PaymentIntentDetailResponse = z.infer<typeof paymentIntentDetailResponseSchema>

export const paymentIntentListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  localOrderId: z.string().uuid().optional(),
  communityId: z.string().uuid().optional(),
  status: paymentStatusSchema.optional(),
  channel: paymentChannelSchema.optional(),
  merchantOrderNo: merchantOrderNoSchema.optional(),
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

/* -------------------------------------------------------------------------- */
/* PAY-05 outbox consumer contract                                           */
/* -------------------------------------------------------------------------- */

/**
 * One consumer run. The server caps the batch size; a client cannot ask for an
 * unbounded drain. Every count is a per-run observation, not a ledger total.
 */
export const paymentOutboxConsumeRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).optional(),
})
export type PaymentOutboxConsumeRequest = z.infer<
  typeof paymentOutboxConsumeRequestSchema
>

export const paymentOutboxConsumeResponseSchema = z.strictObject({
  /** Events claimed by this run (including ones that later conflicted). */
  claimed: z.number().int().nonnegative(),
  /** Trusted paid events that completed an order exactly once in this run. */
  completed: z.number().int().nonnegative(),
  /** Replays that found the same completion already present. */
  alreadyCompleted: z.number().int().nonnegative(),
  /** Events preserved as an order-level manual-review conflict. */
  conflicts: z.number().int().nonnegative(),
  /** Events left pending for a later retry (transient failure/backoff). */
  retried: z.number().int().nonnegative(),
  /** Events that exhausted the retry budget and are parked as `failed`. */
  failed: z.number().int().nonnegative(),
  /** Deferred coupon releases completed because payment is now terminal. */
  couponsReleased: z.number().int().nonnegative(),
  /** PAY-03 late-success exceptions projected onto their order. */
  exceptionsProjected: z.number().int().nonnegative(),
  asOf: z.string().datetime({ offset: true }),
})
export type PaymentOutboxConsumeResponse = z.infer<
  typeof paymentOutboxConsumeResponseSchema
>
