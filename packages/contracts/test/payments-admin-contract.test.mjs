import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  adminLocalOrderDetailSchema,
  adminLocalOrderListQuerySchema,
  adminOrderPaymentSectionSchema,
  adminMaskedProviderTransactionIdSchema,
  localOrderDetailSchema,
} from '@sanchuang-dev/local-life-contracts'

/**
 * PAY-08 (#283) back-office payment read contract.
 *
 * These tests pin the *shape and boundaries* of the read-only payment section:
 * no raw provider reference, no merchant credential, no claim of bank
 * settlement, and payment filters that cannot be smuggled into the shared
 * resident/staff query schema.
 */

const NOW = '2026-11-16T02:00:00.000Z'
const LATER = '2026-11-16T02:15:00.000Z'

const IDS = {
  order: '123e4567-e89b-42d3-a456-426614174001',
  community: '123e4567-e89b-42d3-a456-426614174002',
  resident: '123e4567-e89b-42d3-a456-426614174003',
  product: '123e4567-e89b-42d3-a456-426614174004',
  intent: '123e4567-e89b-42d3-a456-426614174005',
  attempt: '123e4567-e89b-42d3-a456-426614174006',
  event: '123e4567-e89b-42d3-a456-426614174007',
  receipt: '123e4567-e89b-42d3-a456-426614174008',
  exception: '123e4567-e89b-42d3-a456-426614174009',
  conflict: '123e4567-e89b-42d3-a456-42661417400a',
}

function orderDetail(overrides = {}) {
  return {
    id: IDS.order,
    community: { id: IDS.community, name: '幸福社区' },
    resident: { id: IDS.resident, displayName: '居民张三' },
    snapshot: {
      productId: IDS.product,
      productName: '社区助农蔬菜包',
      unitPriceCents: 1990,
      quantity: 2,
      totalCents: 3980,
      couponId: null,
      couponDiscountCents: 0,
      netPayableCents: 3980,
    },
    status: 'online_completed',
    recordSource: 'resident',
    createdByStaff: null,
    attributedStaff: null,
    sourceActivity: null,
    sourceTeam: null,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    residentContact: { phone: null, address: null },
    verification: null,
    onlineCompletion: {
      paymentIntentId: IDS.intent,
      kind: 'channel',
      simulated: true,
      amountCents: 3980,
      discountCents: 0,
      providerTransactionId: 'MOCK-TXN-RAW-9f8e7d6c',
      completedAt: NOW,
    },
    onlineConflicts: [],
    statusNote: null,
    events: [],
    ...overrides,
  }
}

function section(overrides = {}) {
  return {
    amounts: {
      grossAmountCents: 3980,
      couponDiscountCents: 500,
      netPayableCents: 3480,
    },
    manual: {
      verified: false,
      verifiedAt: null,
      verifiedBy: null,
      note: null,
      receipts: [
        {
          entryId: IDS.receipt,
          factKind: 'payment_received',
          amountCents: 3480,
          evidenceKind: 'manual_receipt',
          evidenceRef: 'RCPT-0001',
          occurredAt: NOW,
          createdAt: NOW,
          reversal: null,
        },
      ],
    },
    online: {
      intents: [
        {
          id: IDS.intent,
          kind: 'channel',
          channel: 'mock',
          simulated: true,
          merchantOrderNo: 'PAY-20261116ABCDEF0123456789ABCD',
          grossAmountCents: 3980,
          discountCents: 500,
          netPayableCents: 3480,
          status: 'paid',
          expiresAt: LATER,
          paidAt: NOW,
          closedAt: null,
          failedAt: null,
          failureCode: null,
          failureMessage: null,
          createdAt: NOW,
          updatedAt: NOW,
          attempts: [
            {
              id: IDS.attempt,
              attemptNo: 1,
              status: 'paid',
              providerTransactionIdMasked: '****d6c',
              createdAt: NOW,
              updatedAt: NOW,
              confirmedAt: NOW,
              closedAt: null,
              failedAt: null,
              failureCode: null,
              failureMessage: null,
            },
          ],
          events: [
            {
              id: IDS.event,
              eventType: 'payment.status_changed',
              source: 'channel',
              fromStatus: 'pending',
              toStatus: 'paid',
              createdAt: NOW,
            },
          ],
        },
      ],
      completion: {
        paymentIntentId: IDS.intent,
        kind: 'channel',
        simulated: true,
        amountCents: 3480,
        discountCents: 500,
        providerTransactionIdMasked: '****d6c',
        completedAt: NOW,
      },
      ledgerReceipts: [
        {
          entryId: IDS.receipt,
          factKind: 'payment_received',
          sourceSystem: 'online_payment',
          amountCents: 3480,
          simulated: true,
          providerTransactionIdMasked: '****d6c',
          occurredAt: NOW,
          createdAt: NOW,
        },
      ],
      conflicts: [
        {
          id: IDS.conflict,
          kind: 'manual_online_double_collection',
          status: 'open',
          createdAt: NOW,
          resolvedAt: null,
        },
      ],
      reviewExceptions: [
        {
          id: IDS.exception,
          kind: 'late_success_after_closed',
          status: 'open',
          channel: 'mock',
          merchantOrderNo: 'PAY-20261116ABCDEF0123456789ABCD',
          providerTransactionIdMasked: '****d6c',
          amountCents: 3480,
          source: 'notification',
          failureCode: null,
          observedAt: NOW,
          createdAt: NOW,
          resolvedAt: null,
        },
      ],
    },
    receiptTotals: {
      manualReceivedCents: 0,
      onlineRealReceivedCents: 0,
      onlineSimulatedReceivedCents: 3480,
    },
    bankSettlement: { status: 'unverified' },
    ...overrides,
  }
}

describe('PAY-08 admin payment read contract', () => {
  it('accepts a manual-only order without any payment intent', () => {
    const details = orderDetail({
      status: 'verified',
      verification: {
        verifiedBy: { id: IDS.resident, displayName: '运营核验员' },
        verifiedAt: NOW,
        note: '已电话核对',
      },
      onlineCompletion: null,
    })
    const parsed = adminLocalOrderDetailSchema.parse({
      ...details,
      paymentSection: section({
        online: {
          intents: [],
          completion: null,
          ledgerReceipts: [],
          conflicts: [],
          reviewExceptions: [],
        },
        receiptTotals: {
          manualReceivedCents: 3480,
          onlineRealReceivedCents: 0,
          onlineSimulatedReceivedCents: 0,
        },
      }),
    })
    assert.equal(parsed.paymentSection.online.intents.length, 0)
    assert.equal(parsed.paymentSection.manual.receipts.length, 1)
  })

  it('keeps the parent order-detail refinements after extending the schema', () => {
    // onlineCompletion must be present exactly for online_completed orders.
    assert.equal(
      adminLocalOrderDetailSchema.safeParse({
        ...orderDetail(),
        status: 'registered',
        paymentSection: section(),
      }).success,
      false,
    )
    // A verified order must carry verification details.
    assert.equal(
      adminLocalOrderDetailSchema.safeParse({
        ...orderDetail({ status: 'verified', onlineCompletion: null }),
        paymentSection: section(),
      }).success,
      false,
    )
    assert.equal(
      adminLocalOrderDetailSchema.safeParse({
        ...orderDetail(),
        paymentSection: section(),
      }).success,
      true,
    )
  })

  it('refuses a raw provider transaction id and any extra field', () => {
    const results = [
      adminMaskedProviderTransactionIdSchema.safeParse('MOCK-TXN-RAW-9f8e7d6c'),
      adminMaskedProviderTransactionIdSchema.safeParse('****d6c8'),
      adminMaskedProviderTransactionIdSchema.safeParse('****'),
    ]
    assert.equal(results[0].success, false)
    assert.equal(results[1].success, true)
    assert.equal(results[2].success, true)

    const withRaw = section()
    withRaw.online.intents[0].providerTransactionId = 'MOCK-TXN-RAW-9f8e7d6c'
    assert.equal(adminOrderPaymentSectionSchema.safeParse(withRaw).success, false)

    const withPrivateKey = section()
    withPrivateKey.online.intents[0].merchantPrivateKey = 'SECRET'
    assert.equal(adminOrderPaymentSectionSchema.safeParse(withPrivateKey).success, false)
  })

  it('only ever allows the bank-settlement status "unverified"', () => {
    assert.equal(
      adminOrderPaymentSectionSchema.safeParse(section()).success,
      true,
    )
    const settled = section()
    settled.bankSettlement = { status: 'settled' }
    assert.equal(adminOrderPaymentSectionSchema.safeParse(settled).success, false)
  })

  it('rejects a payment section whose totals go negative', () => {
    const bad = section()
    bad.receiptTotals.manualReceivedCents = -1
    assert.equal(adminOrderPaymentSectionSchema.safeParse(bad).success, false)
  })

  it('parses the shared order-detail schema unchanged (no payment section required there)', () => {
    assert.equal(localOrderDetailSchema.safeParse(orderDetail()).success, true)
  })

  it('applies list pagination defaults and keeps payment filters optional', () => {
    const defaults = adminLocalOrderListQuerySchema.parse({})
    assert.equal(defaults.page, 1)
    assert.equal(defaults.pageSize, 20)
    assert.equal(defaults.paymentStatus, undefined)
    assert.equal(defaults.paymentMode, undefined)
  })

  it('accepts every documented payment filter', () => {
    const parsed = adminLocalOrderListQuerySchema.parse({
      page: '2',
      pageSize: '50',
      communityId: IDS.community,
      orderId: IDS.order,
      merchantOrderNo: 'PAY-20261116ABCDEF0123456789ABCD',
      providerTransactionId: 'MOCK-TXN-RAW-9f8e7d6c',
      paymentStatus: 'paid',
      paymentChannel: 'mock',
      paymentMode: 'simulated',
      createdFrom: NOW,
      createdTo: LATER,
    })
    assert.equal(parsed.page, 2)
    assert.equal(parsed.pageSize, 50)
    assert.equal(parsed.paymentStatus, 'paid')
    assert.equal(parsed.paymentMode, 'simulated')
  })

  it('rejects an inverted or invalid date range and unknown payment mode', () => {
    assert.equal(
      adminLocalOrderListQuerySchema.safeParse({
        createdFrom: LATER,
        createdTo: NOW,
      }).success,
      false,
    )
    assert.equal(
      adminLocalOrderListQuerySchema.safeParse({ paymentMode: 'both' }).success,
      false,
    )
    assert.equal(
      adminLocalOrderListQuerySchema.safeParse({ paymentStatus: 'settled' }).success,
      false,
    )
  })

  it('rejects order filters that are not the documented back-office shape', () => {
    // Merchant order numbers must stay channel-safe (these are WeChat out_trade_no values).
    assert.equal(
      adminLocalOrderListQuerySchema.safeParse({ merchantOrderNo: 'PAY 001' }).success,
      false,
    )
    assert.equal(
      adminLocalOrderListQuerySchema.safeParse({ merchantOrderNo: 'PAY' }).success,
      false,
    )
  })
})
