import { z } from 'zod'
import { desc, eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  type PaymentConfirmationResponse,
  type PaymentEvidence,
  type PaymentIntentCreateResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import {
  paymentAttempts,
  paymentEvents,
  paymentIntents,
  paymentReviewExceptions,
} from '../db/schema.js'
import { LocalError, type LocalActor } from '../local/shared.js'
import { confirmTrustedPayment } from './confirmation.js'
import { createPaymentIntent } from './service.js'

/**
 * PAY-04 is deliberately an in-process driver, not an HTTP surface. Tests,
 * local scripts and later H5 development can exercise the isolated Mock channel
 * without exposing a public route that could mark a resident's payment paid.
 *
 * Every result below still goes through PAY-03 `confirmTrustedPayment`; this
 * module only normalizes synthetic provider evidence and never writes payment
 * state, orders, coupons or ledger facts itself.
 */

export const MOCK_PAYMENT_ACTIONS = ['succeed', 'fail', 'cancel', 'timeout', 'pending'] as const
export type MockPaymentAction = (typeof MOCK_PAYMENT_ACTIONS)[number]

export const MOCK_PAYMENT_SOURCES = ['notification', 'query'] as const
export type MockPaymentSource = (typeof MOCK_PAYMENT_SOURCES)[number]

const createMockPaymentSchema = z.strictObject({
  localOrderId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(8).max(128),
})

const mockScenarioSchema = z.strictObject({
  paymentIntentId: z.string().uuid(),
  action: z.enum(MOCK_PAYMENT_ACTIONS),
  source: z.enum(MOCK_PAYMENT_SOURCES),
})

type MockConfig = Pick<ApiConfig, 'paymentMockEnabled' | 'nodeEnv'>
type IntentRow = typeof paymentIntents.$inferSelect

const MOCK_FAILURE_CODE = 'MOCK_PAYMENT_FAILED'
const MOCK_CANCEL_CODE = 'MOCK_USER_CANCELLED'

function assertMockChannelEnabled(config: MockConfig): void {
  if (config.nodeEnv === 'production' || !config.paymentMockEnabled) {
    throw new LocalError(
      503,
      API_ERROR_CODES.paymentChannelUnavailable,
      '模拟支付渠道未启用',
    )
  }
}

function mockDedupeKey(
  intent: IntentRow,
  action: MockPaymentAction,
  source: MockPaymentSource,
): string {
  return `MOCK-EVT-${intent.id}-${action}-${source}`
}

/**
 * Replay the original persisted observation time for the same provider event.
 * The provider event row is the durable multi-process source of truth; the
 * attempt/exception is used for cases where the event's createdAt is not the
 * original evidence time (notably timeout uses expiresAt, late success has only
 * a review exception). This avoids process-local caches.
 */
function persistedMockObservedAt(
  db: AppDatabase,
  intent: IntentRow,
  action: MockPaymentAction,
  source: MockPaymentSource,
): Date | null {
  const event = db.select().from(paymentEvents)
    .where(eq(paymentEvents.dedupeKey, mockDedupeKey(intent, action, source)))
    .get()
  if (event) {
    if (action === 'timeout') {
      const attempt = event.paymentAttemptId
        ? db.select().from(paymentAttempts)
          .where(eq(paymentAttempts.id, event.paymentAttemptId))
          .get()
        : null
      return attempt?.closedAt ?? intent.closedAt ?? intent.expiresAt
    }
    // For success/fail/cancel/pending, PAY-03's channel event createdAt is the
    // first confirmation clock (the same value supplied as observedAt).
    return event.createdAt
  }
  const exception = db.select().from(paymentReviewExceptions)
    .where(eq(paymentReviewExceptions.dedupeKey, mockDedupeKey(intent, action, source)))
    .orderBy(desc(paymentReviewExceptions.createdAt), desc(paymentReviewExceptions.id))
    .get()
  return exception?.observedAt ?? null
}

function mockObservedAt(
  db: AppDatabase,
  intent: IntentRow,
  action: MockPaymentAction,
  source: MockPaymentSource,
  now: Date,
): Date {
  const persisted = persistedMockObservedAt(db, intent, action, source)
  if (persisted) return persisted
  // Timeout occurs at the server-side expiry, never before it. Every other
  // first observation carries the actual simulated clock instead of a value
  // fabricated from intent.createdAt.
  return action === 'timeout' ? (intent.closedAt ?? intent.expiresAt) : now
}

function mockProviderStatus(action: MockPaymentAction): PaymentEvidence['providerStatus'] {
  if (action === 'succeed') return 'paid'
  if (action === 'fail' || action === 'cancel') return 'failed'
  if (action === 'timeout') return 'closed'
  return 'pending'
}

function mockProviderTransactionId(
  intent: IntentRow,
  action: MockPaymentAction,
): string | null {
  return action === 'succeed' ? `MOCK-TXN-${intent.id}` : null
}

function mockEvidence(
  db: AppDatabase,
  intent: IntentRow,
  action: MockPaymentAction,
  source: MockPaymentSource,
  now: Date,
): PaymentEvidence {
  const providerStatus = mockProviderStatus(action)
  return {
    merchantOrderNo: intent.merchantOrderNo,
    channel: 'mock',
    providerStatus,
    // Only a successful simulation owns a synthetic channel transaction. A
    // failed/cancelled/closed/pending result must not leave a transaction id on
    // its attempt, especially after pending -> terminal.
    providerTransactionId: mockProviderTransactionId(intent, action),
    amountCents: intent.netPayableCents,
    currency: 'CNY',
    merchantAppId: null,
    merchantId: null,
    observedAt: mockObservedAt(db, intent, action, source, now).toISOString(),
    source,
    dedupeKey: mockDedupeKey(intent, action, source),
    providerEventRef: `MOCK-REF-${intent.id}-${action}-${source}`,
    failureCode: action === 'fail'
      ? MOCK_FAILURE_CODE
      : action === 'cancel'
        ? MOCK_CANCEL_CODE
        : null,
    failureMessage: action === 'fail'
      ? '模拟支付失败'
      : action === 'cancel'
        ? '模拟用户取消支付'
        : null,
  }
}

/**
 * Start an isolated Mock payment through the ordinary PAY-02 create path.
 * The caller supplies only an owned order id and an idempotency key; server
 * code derives channel, amount, ownership, merchant order number and simulated
 * flag. This is intentionally not registered as an HTTP route.
 */
export function createMockPayment(
  db: AppDatabase,
  config: MockConfig,
  actor: LocalActor,
  input: { localOrderId: string; idempotencyKey: string },
  options: { now?: Date } = {},
): PaymentIntentCreateResponse {
  assertMockChannelEnabled(config)
  const parsed = createMockPaymentSchema.parse(input)
  return createPaymentIntent(
    db,
    config,
    actor,
    { ...parsed, channel: 'mock' },
    options,
  )
}

/**
 * Drive one server-side provider result for an existing Mock payment intent.
 * `source=notification` models a provider callback; `source=query` models an
 * active query. Both converge through the same PAY-03 confirmation kernel.
 *
 * `timeout` is rejected until the intent's server-side expiry has passed so the
 * driver cannot fabricate a premature close. Late success intentionally returns
 * PAY-03's conflict error after persisting a review exception, without changing
 * the closed/failed terminal state.
 */
export function executeMockPaymentAction(
  db: AppDatabase,
  config: MockConfig,
  input: { paymentIntentId: string; action: MockPaymentAction; source: MockPaymentSource },
  options: { now?: Date } = {},
): PaymentConfirmationResponse {
  assertMockChannelEnabled(config)
  const parsed = mockScenarioSchema.parse(input)
  const now = options.now ?? new Date()
  const intent = db.select().from(paymentIntents)
    .where(eq(paymentIntents.id, parsed.paymentIntentId))
    .get()
  if (!intent) {
    throw new LocalError(404, API_ERROR_CODES.notFound, '支付单不存在')
  }
  if (intent.kind !== 'channel' || intent.channel !== 'mock' || !intent.simulated) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '仅支持隔离 Mock 支付意图')
  }
  if (parsed.action === 'timeout' && now.getTime() < intent.expiresAt.getTime()) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, 'Mock 支付尚未到期，不能模拟超时')
  }
  return confirmTrustedPayment(
    db,
    mockEvidence(db, intent, parsed.action, parsed.source, now),
    { now },
  )
}
