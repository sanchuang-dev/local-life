import { z } from 'zod'
import { eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  type PaymentConfirmationResponse,
  type PaymentEvidence,
  type PaymentIntentCreateResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import { paymentIntents } from '../db/schema.js'
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

function terminalOrCreated(intent: IntentRow): Date {
  return intent.paidAt ?? intent.closedAt ?? intent.failedAt ?? intent.createdAt
}

/**
 * Synthetic provider observation times are stable for the same provider event,
 * so a repeated notification/query is an exact PAY-03 replay rather than a
 * different-evidence conflict. Late success is anchored after the terminal time.
 */
function mockObservedAt(intent: IntentRow, action: MockPaymentAction): Date {
  if (action === 'succeed') {
    if (intent.status === 'paid') return terminalOrCreated(intent)
    if (intent.status === 'closed' && intent.closedAt) {
      return new Date(intent.closedAt.getTime() + 60_000)
    }
    if (intent.status === 'failed' && intent.failedAt) {
      return new Date(intent.failedAt.getTime() + 60_000)
    }
    return new Date(intent.createdAt.getTime() + 120_000)
  }
  if (action === 'timeout') {
    return intent.closedAt ?? intent.expiresAt
  }
  if (action === 'fail' || action === 'cancel') {
    return intent.failedAt
      ?? new Date(intent.createdAt.getTime() + (action === 'fail' ? 60_000 : 120_000))
  }
  return new Date(intent.createdAt.getTime() + 30_000)
}

function mockProviderStatus(action: MockPaymentAction): PaymentEvidence['providerStatus'] {
  if (action === 'succeed') return 'paid'
  if (action === 'fail' || action === 'cancel') return 'failed'
  if (action === 'timeout') return 'closed'
  return 'pending'
}

function mockEvidence(
  intent: IntentRow,
  action: MockPaymentAction,
  source: MockPaymentSource,
): PaymentEvidence {
  const providerStatus = mockProviderStatus(action)
  return {
    merchantOrderNo: intent.merchantOrderNo,
    channel: 'mock',
    providerStatus,
    // A synthetic, permanently non-WeChat transaction reference. No caller can
    // supply a transaction id, amount, merchant identity or raw evidence.
    providerTransactionId: `MOCK-TXN-${intent.id}`,
    amountCents: intent.netPayableCents,
    currency: 'CNY',
    merchantAppId: null,
    merchantId: null,
    observedAt: mockObservedAt(intent, action).toISOString(),
    source,
    dedupeKey: `MOCK-EVT-${intent.id}-${action}-${source}`,
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
    mockEvidence(intent, parsed.action, parsed.source),
    { now },
  )
}
