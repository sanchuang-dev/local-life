import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PAYMENT_STATUS_TRANSITIONS,
  canTransitionPaymentStatus,
  paymentAttemptSchema,
  paymentCentsSchema,
  paymentIntentSchema,
  paymentOutboxEventSchema,
  paymentPaidEventPayloadSchema,
  paymentEvidenceSchema,
  paymentReviewExceptionSchema,
  paymentConfirmationResponseSchema,
  PAYMENT_INTERNAL_ROUTES,
  paymentStatusSchema,
  LOCAL_ORDER_ROUTES,
  LOCAL_ORDER_STATUS_TRANSITIONS,
  localOrderEventTypeSchema,
  localOrderOnlineCompletionSchema,
  localOrderOnlineConflictSchema,
  localOrderStatusSchema,
  localOrderTransitionStatusSchema,
  paymentOutboxConsumeRequestSchema,
  paymentOutboxConsumeResponseSchema,
  paymentOutboxRecoveryRequestSchema,
  paymentOutboxRecoveryResponseSchema,
  paymentFailedOutboxListResponseSchema,
} from '@sanchuang-dev/local-life-contracts'

const NOW = '2026-11-16T02:00:00.000Z'
const LATER = '2026-11-16T02:05:00.000Z'

function intent(overrides = {}) {
  return {
    id: '123e4567-e89b-42d3-a456-426614174001',
    localOrderId: '123e4567-e89b-42d3-a456-426614174002',
    residentUserId: '123e4567-e89b-42d3-a456-426614174003',
    communityId: '123e4567-e89b-42d3-a456-426614174004',
    kind: 'channel',
    channel: 'wechat_jsapi',
    simulated: false,
    merchantOrderNo: 'PAY-20261116-0001',
    merchantAppId: null,
    merchantId: null,
    grossAmountCents: 3980,
    discountCents: 500,
    netPayableCents: 3480,
    status: 'pending',
    idempotencyKey: 'pay-create-0001',
    expiresAt: LATER,
    paidAt: null,
    closedAt: null,
    failedAt: null,
    failureCode: null,
    failureMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('payment amount and state contracts', () => {
  it('accepts only non-negative safe integer cents', () => {
    assert.equal(paymentCentsSchema.safeParse(0).success, true)
    assert.equal(paymentCentsSchema.safeParse(3980).success, true)
    assert.equal(paymentCentsSchema.safeParse(-1).success, false)
    assert.equal(paymentCentsSchema.safeParse(19.9).success, false)
    assert.equal(paymentCentsSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success, false)
    assert.equal(paymentCentsSchema.safeParse(Number.NaN).success, false)
  })

  it('defines a one-way lifecycle with no terminal rollback', () => {
    assert.deepEqual(paymentStatusSchema.options, [
      'pending',
      'confirming',
      'paid',
      'closed',
      'failed',
    ])
    for (const from of paymentStatusSchema.options) {
      for (const to of paymentStatusSchema.options) {
        if (from === to) continue
        assert.equal(
          canTransitionPaymentStatus(from, to),
          PAYMENT_STATUS_TRANSITIONS[from].includes(to),
        )
      }
    }
    assert.equal(canTransitionPaymentStatus('pending', 'confirming'), true)
    assert.equal(canTransitionPaymentStatus('confirming', 'paid'), true)
    assert.equal(canTransitionPaymentStatus('paid', 'pending'), false)
    assert.equal(canTransitionPaymentStatus('closed', 'paid'), false)
    assert.equal(canTransitionPaymentStatus('failed', 'confirming'), false)
  })

  it('rejects gross/discount/net conservation failures and channel/kind contradictions', () => {
    assert.equal(paymentIntentSchema.safeParse(intent()).success, true)
    assert.equal(
      paymentIntentSchema.safeParse(intent({ netPayableCents: 3481 })).success,
      false,
    )
    assert.equal(
      paymentIntentSchema.safeParse(intent({ channel: 'mock', simulated: false })).success,
      false,
    )
    assert.equal(
      paymentIntentSchema.safeParse(intent({ channel: 'wechat_jsapi', simulated: true })).success,
      false,
    )
    assert.equal(
      paymentIntentSchema.safeParse(intent({ kind: 'zero_amount', netPayableCents: 0 })).success,
      false,
      'zero amount still needs a paid status, no channel and timestamps',
    )
    assert.equal(
      paymentIntentSchema.safeParse(intent({
        kind: 'zero_amount',
        channel: null,
        simulated: false,
        discountCents: 3980,
        netPayableCents: 0,
        status: 'paid',
        paidAt: LATER,
      })).success,
      true,
    )
  })

  it('keeps merchant order numbers within the WeChat out_trade_no limit', () => {
    assert.equal(paymentIntentSchema.safeParse(intent()).success, true)
    assert.equal(
      paymentIntentSchema.safeParse(intent({ merchantOrderNo: 'PAY-' + 'A'.repeat(28) })).success,
      true,
    )
    assert.equal(
      paymentIntentSchema.safeParse(intent({ merchantOrderNo: 'PAY-' + 'A'.repeat(29) })).success,
      false,
      '33 characters exceeds out_trade_no',
    )
    assert.equal(
      paymentIntentSchema.safeParse(intent({ merchantOrderNo: 'PAY 0001' })).success,
      false,
      'spaces are not channel-safe',
    )
  })

  it('requires terminal timestamps on a paid attempt and a provider transaction id', () => {
    const base = {
      id: '123e4567-e89b-42d3-a456-426614174005',
      paymentIntentId: intent().id,
      attemptNo: 1,
      status: 'paid',
      idempotencyKey: 'attempt-key-0001',
      providerTransactionId: 'wx-txn-0001',
      createdAt: NOW,
      updatedAt: LATER,
      confirmedAt: LATER,
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
    }
    assert.equal(paymentAttemptSchema.safeParse(base).success, true)
    assert.equal(
      paymentAttemptSchema.safeParse({ ...base, providerTransactionId: null }).success,
      false,
    )
    assert.equal(paymentAttemptSchema.safeParse({ ...base, confirmedAt: null }).success, false)
  })

  it('keeps payment intent terminal facts consistent with the SQLite CHECK constraints', () => {
    for (const patch of [
      { status: 'pending' },
      { status: 'confirming' },
      { status: 'paid', paidAt: LATER },
      { status: 'closed', closedAt: LATER },
      { status: 'failed', failedAt: LATER, failureCode: 'DECLINED', failureMessage: 'Declined' },
    ]) {
      assert.equal(paymentIntentSchema.safeParse(intent(patch)).success, true, JSON.stringify(patch))
    }

    for (const patch of [
      { status: 'pending', paidAt: LATER },
      { status: 'confirming', closedAt: LATER },
      { status: 'pending', failedAt: LATER },
      { status: 'paid' },
      { status: 'paid', paidAt: LATER, closedAt: LATER },
      { status: 'closed', closedAt: LATER, paidAt: LATER },
      { status: 'failed', failedAt: LATER, closedAt: LATER },
      { status: 'failed' },
      { status: 'pending', failureCode: 'EARLY_ERROR' },
      { status: 'paid', paidAt: LATER, failureMessage: 'unexpected' },
    ]) {
      assert.equal(paymentIntentSchema.safeParse(intent(patch)).success, false, JSON.stringify(patch))
    }
  })

  it('keeps payment attempt terminal facts consistent with the SQLite CHECK constraints', () => {
    const attempt = (overrides = {}) => ({
      id: '123e4567-e89b-42d3-a456-426614174005',
      paymentIntentId: intent().id,
      attemptNo: 1,
      status: 'pending',
      idempotencyKey: 'attempt-key-0001',
      providerTransactionId: null,
      createdAt: NOW,
      updatedAt: LATER,
      confirmedAt: null,
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      ...overrides,
    })

    for (const patch of [
      { status: 'pending' },
      { status: 'confirming' },
      { status: 'paid', confirmedAt: LATER, providerTransactionId: 'wx-txn-valid' },
      { status: 'closed', closedAt: LATER },
      { status: 'failed', failedAt: LATER, failureCode: 'FAILED', failureMessage: 'Failed' },
    ]) {
      assert.equal(paymentAttemptSchema.safeParse(attempt(patch)).success, true, JSON.stringify(patch))
    }

    for (const patch of [
      { status: 'pending', confirmedAt: LATER },
      { status: 'confirming', failedAt: LATER },
      { status: 'paid', confirmedAt: LATER },
      { status: 'paid', providerTransactionId: 'wx-txn-missing-time' },
      { status: 'paid', confirmedAt: LATER, providerTransactionId: 'wx-txn-conflict', closedAt: LATER },
      { status: 'paid', confirmedAt: LATER, providerTransactionId: 'wx-txn-failure', failureCode: 'FAILED' },
      { status: 'closed', closedAt: LATER, confirmedAt: LATER },
      { status: 'failed', failedAt: LATER, closedAt: LATER },
      { status: 'failed' },
      { status: 'pending', failureMessage: 'unexpected' },
    ]) {
      assert.equal(paymentAttemptSchema.safeParse(attempt(patch)).success, false, JSON.stringify(patch))
    }
  })
})


describe('PAY-03 trusted evidence, outbox and review contracts', () => {
  const paidEvidence = {
    merchantOrderNo: 'PAY-20261116-0001',
    channel: 'wechat_jsapi',
    providerStatus: 'paid',
    providerTransactionId: '4200000000202611160000000001',
    amountCents: 3480,
    currency: 'CNY',
    merchantAppId: 'wx1234567890',
    merchantId: '1900000109',
    observedAt: NOW,
    source: 'notification',
    dedupeKey: 'wx-notify-0001',
    providerEventRef: 'evt-0001',
    failureCode: null,
    failureMessage: null,
  }

  it('requires a provider transaction id for paid evidence only', () => {
    assert.equal(paymentEvidenceSchema.safeParse(paidEvidence).success, true)
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, providerTransactionId: null }).success, false)
    assert.equal(paymentEvidenceSchema.safeParse({
      ...paidEvidence,
      providerStatus: 'pending',
      providerTransactionId: null,
    }).success, true)
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, amountCents: -1 }).success, false)
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, currency: 'USD' }).success, false)
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, extra: true }).success, false)
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, source: 'callback' }).success, false)
  })

  it('rejects fake signatures and malformed channel events before any state write', () => {
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, signature: 'fake' }).success, false)
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, providerStatus: 'succeeded' }).success, false)
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, observedAt: 'not-a-date' }).success, false)
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, amountCents: 1.5 }).success, false)
  })

  it('requires real WeChat merchant identity and never treats null as a match', () => {
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, merchantAppId: null }).success, false)
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, merchantId: null }).success, false)
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, merchantAppId: '' }).success, false)
    assert.equal(paymentEvidenceSchema.safeParse({ ...paidEvidence, merchantId: '' }).success, false)
    assert.equal(paymentEvidenceSchema.safeParse({
      ...paidEvidence,
      channel: 'mock',
      merchantAppId: null,
      merchantId: null,
    }).success, true)
  })

  it('keeps the paid handoff payload stable and strict', () => {
    const payload = {
      paymentIntentId: '123e4567-e89b-42d3-a456-426614174001',
      localOrderId: '123e4567-e89b-42d3-a456-426614174002',
      residentUserId: '123e4567-e89b-42d3-a456-426614174003',
      communityId: '123e4567-e89b-42d3-a456-426614174004',
      amountCents: 3480,
      providerTransactionId: '4200000000202611160000000001',
      simulated: false,
      paidAt: NOW,
    }
    assert.equal(paymentPaidEventPayloadSchema.safeParse(payload).success, true)
    assert.equal(paymentPaidEventPayloadSchema.safeParse({ ...payload, amountCents: 1.5 }).success, false)
    assert.equal(paymentPaidEventPayloadSchema.safeParse({ ...payload, extra: true }).success, false)
    const outbox = {
      id: '123e4567-e89b-42d3-a456-426614174010',
      paymentIntentId: payload.paymentIntentId,
      paymentEventId: '123e4567-e89b-42d3-a456-426614174011',
      topic: 'payment.paid.v1',
      dedupeKey: `payment.paid:${payload.paymentIntentId}`,
      payload,
      status: 'pending',
      attempts: 0,
      availableAt: NOW,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
      deliveredAt: null,
    }
    assert.equal(paymentOutboxEventSchema.safeParse(outbox).success, true)
    assert.equal(paymentOutboxEventSchema.safeParse({ ...outbox, topic: 'payment.refunded.v1' }).success, false)
  })

  it('exposes review exceptions without allowing invented fields', () => {
    const exception = {
      id: '123e4567-e89b-42d3-a456-426614174012',
      paymentIntentId: null,
      merchantOrderNo: 'PAY-20261116-0001',
      channel: 'wechat_jsapi',
      providerTransactionId: null,
      amountCents: null,
      merchantAppId: null,
      merchantId: null,
      observedAt: NOW,
      source: 'query',
      dedupeKey: 'wx-query-0001',
      providerEventRef: null,
      failureCode: null,
      failureMessage: null,
      kind: 'intent_not_found',
      detail: '商户订单号不存在',
      status: 'open',
      createdAt: NOW,
      resolvedAt: null,
    }
    assert.equal(paymentReviewExceptionSchema.safeParse(exception).success, true)
    assert.equal(paymentReviewExceptionSchema.safeParse({ ...exception, kind: 'made_up' }).success, false)
    assert.equal(paymentReviewExceptionSchema.safeParse({ ...exception, extra: true }).success, false)
  })

  it('keeps the internal confirmation route and outcome contract explicit', () => {
    assert.equal(PAYMENT_INTERNAL_ROUTES.confirm, '/internal/payments/confirm')
    const response = {
      outcome: 'confirmed',
      intent: intent({ status: 'paid', paidAt: NOW, channel: 'wechat_jsapi', simulated: false }),
      attempt: null,
      outboxEventId: '123e4567-e89b-42d3-a456-426614174010',
    }
    assert.equal(paymentConfirmationResponseSchema.safeParse(response).success, true)
    assert.equal(paymentConfirmationResponseSchema.safeParse({ ...response, outcome: 'client_says_paid' }).success, false)
  })
})

describe('PAY-05 online completion contracts', () => {
  it('declares the online completion state as a server-only terminal status', () => {
    assert.equal(LOCAL_ORDER_STATUS_TRANSITIONS.registered.includes('online_completed'), true)
    assert.equal(LOCAL_ORDER_STATUS_TRANSITIONS.processing.includes('online_completed'), true)
    assert.equal(LOCAL_ORDER_STATUS_TRANSITIONS.pending_review.includes('online_completed'), true)
    assert.deepEqual(LOCAL_ORDER_STATUS_TRANSITIONS.online_completed, [])
    assert.equal(localOrderTransitionStatusSchema.safeParse('online_completed').success, false)
    assert.equal(localOrderStatusSchema.safeParse('online_completed').success, true)
    assert.equal(localOrderEventTypeSchema.safeParse('order.online_completed').success, true)
  })

  it('separates channel completion from the zero-amount coupon-only completion', () => {
    const channel = {
      paymentIntentId: '123e4567-e89b-42d3-a456-426614174020',
      kind: 'channel',
      simulated: false,
      amountCents: 3480,
      discountCents: 500,
      providerTransactionId: 'wx-txn-1',
      completedAt: NOW,
    }
    assert.equal(localOrderOnlineCompletionSchema.safeParse(channel).success, true)
    // A channel completion can never claim zero cash or omit the channel reference.
    assert.equal(localOrderOnlineCompletionSchema.safeParse({ ...channel, amountCents: 0 }).success, false)
    assert.equal(
      localOrderOnlineCompletionSchema.safeParse({ ...channel, providerTransactionId: null }).success,
      false,
    )

    const zero = {
      paymentIntentId: '123e4567-e89b-42d3-a456-426614174021',
      kind: 'zero_amount',
      simulated: false,
      amountCents: 0,
      discountCents: 3980,
      providerTransactionId: null,
      completedAt: NOW,
    }
    assert.equal(localOrderOnlineCompletionSchema.safeParse(zero).success, true)
    // The coupon-only path must never carry cash, a channel reference or a mock flag.
    assert.equal(localOrderOnlineCompletionSchema.safeParse({ ...zero, amountCents: 1 }).success, false)
    assert.equal(
      localOrderOnlineCompletionSchema.safeParse({ ...zero, providerTransactionId: 'fake' }).success,
      false,
    )
    assert.equal(localOrderOnlineCompletionSchema.safeParse({ ...zero, simulated: true }).success, false)
  })

  it('keeps the durable manual-review conflict vocabulary explicit', () => {
    const conflict = {
      id: '123e4567-e89b-42d3-a456-426614174022',
      kind: 'order_not_payable',
      status: 'open',
      createdAt: NOW,
      resolvedAt: null,
    }
    assert.equal(localOrderOnlineConflictSchema.safeParse(conflict).success, true)
    // The shared order DTO deliberately carries no free-text evidence detail.
    assert.equal(
      localOrderOnlineConflictSchema.safeParse({ ...conflict, detail: 'internal' }).success,
      false,
    )
    for (const kind of [
      'order_not_payable',
      'order_already_completed',
      'payment_state_invalid',
      'coupon_state_invalid',
      'late_success',
      'manual_online_double_collection',
      'consumer_exhausted',
    ]) {
      assert.equal(localOrderOnlineConflictSchema.safeParse({ ...conflict, kind }).success, true)
    }
    assert.equal(localOrderOnlineConflictSchema.safeParse({ ...conflict, kind: 'refund' }).success, false)
    assert.equal(localOrderOnlineConflictSchema.safeParse({ ...conflict, status: 'done' }).success, false)
  })

  it('exposes the token-gated consumer trigger and idempotent completion response', () => {
    assert.equal(PAYMENT_INTERNAL_ROUTES.consumeOutbox, '/internal/payments/outbox/consume')
    assert.equal(
      LOCAL_ORDER_ROUTES.myZeroAmountCompletion,
      '/local-orders/:localOrderId/zero-amount-completion',
    )
    const consumed = {
      claimed: 1,
      completed: 1,
      alreadyCompleted: 0,
      conflicts: 0,
      retried: 0,
      failed: 0,
      couponsReleased: 0,
      exceptionsProjected: 0,
      asOf: NOW,
    }
    assert.equal(paymentOutboxConsumeResponseSchema.safeParse(consumed).success, true)
    assert.equal(
      paymentOutboxConsumeResponseSchema.safeParse({ ...consumed, completed: -1 }).success,
      false,
    )
    assert.equal(
      paymentOutboxConsumeResponseSchema.safeParse({ ...consumed, extra: true }).success,
      false,
    )
    assert.equal(paymentOutboxConsumeRequestSchema.safeParse({}).success, true)
    assert.equal(paymentOutboxConsumeRequestSchema.safeParse({ limit: 51 }).success, false)
    assert.equal(paymentOutboxConsumeRequestSchema.safeParse({ limit: 0 }).success, false)
  })

  it('exposes the token-gated parked-event query and controlled recovery contracts', () => {
    assert.equal(PAYMENT_INTERNAL_ROUTES.recoverOutbox, '/internal/payments/outbox/recover')
    assert.equal(PAYMENT_INTERNAL_ROUTES.failedOutbox, '/internal/payments/outbox/failed')

    const request = { outboxEventId: '123e4567-e89b-42d3-a456-426614174030' }
    assert.equal(paymentOutboxRecoveryRequestSchema.safeParse(request).success, true)
    assert.equal(
      paymentOutboxRecoveryRequestSchema.safeParse({ ...request, outboxEventId: 'nope' }).success,
      false,
    )
    assert.equal(
      paymentOutboxRecoveryRequestSchema.safeParse({ ...request, outboxEventId: undefined }).success,
      false,
    )

    const recovered = {
      ...request,
      outcome: 'recovered',
      status: 'delivered',
      localOrderId: '123e4567-e89b-42d3-a456-426614174002',
      paymentIntentId: '123e4567-e89b-42d3-a456-426614174001',
      orderStatus: 'online_completed',
      conflictsResolved: 1,
      asOf: NOW,
    }
    assert.equal(paymentOutboxRecoveryResponseSchema.safeParse(recovered).success, true)
    for (const outcome of [
      'already_completed',
      'retry_scheduled',
      'still_failed',
    ]) {
      assert.equal(
        paymentOutboxRecoveryResponseSchema.safeParse({ ...recovered, outcome }).success,
        true,
      )
    }
    assert.equal(
      paymentOutboxRecoveryResponseSchema.safeParse({ ...recovered, outcome: 'refunded' }).success,
      false,
    )
    assert.equal(
      paymentOutboxRecoveryResponseSchema.safeParse({ ...recovered, status: 'parked' }).success,
      false,
    )

    const failedList = {
      items: [
        {
          outboxEventId: request.outboxEventId,
          paymentIntentId: recovered.paymentIntentId,
          localOrderId: recovered.localOrderId,
          orderStatus: 'pending_review',
          topic: 'payment.paid.v1',
          status: 'failed',
          attempts: 5,
          lastError: 'injected transient failure',
          amountCents: 3980,
          providerTransactionId: 'MOCK-TXN-1',
          createdAt: NOW,
          updatedAt: LATER,
          conflicts: [
            {
              id: '123e4567-e89b-42d3-a456-426614174031',
              kind: 'consumer_exhausted',
              status: 'open',
              detail: 'PAY-05 完成链重试耗尽',
              createdAt: NOW,
              resolvedAt: null,
            },
          ],
        },
      ],
      asOf: NOW,
    }
    assert.equal(paymentFailedOutboxListResponseSchema.safeParse(failedList).success, true)
    assert.equal(
      paymentFailedOutboxListResponseSchema.safeParse({
        ...failedList,
        items: [{ ...failedList.items[0], status: 'delivered' }],
      }).success,
      false,
    )
  })
})
