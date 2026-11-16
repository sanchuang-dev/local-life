import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PAYMENT_STATUS_TRANSITIONS,
  canTransitionPaymentStatus,
  paymentAttemptSchema,
  paymentCentsSchema,
  paymentIntentSchema,
  paymentStatusSchema,
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
