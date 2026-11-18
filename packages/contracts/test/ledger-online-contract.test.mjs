import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ledgerEntrySchema } from '@sanchuang-dev/local-life-contracts'

const NOW = '2026-11-18T02:00:00.000Z'
const UUID = '123e4567-e89b-42d3-a456-426614174001'

function entry(overrides = {}) {
  return {
    entryId: UUID,
    factKind: 'payment_received',
    sourceSystem: 'online_payment',
    simulated: false,
    sourceId: 'completion-0001',
    sourceDisplayNo: 'order-0001',
    communityId: UUID,
    productId: null,
    occurredAt: NOW,
    verifiedAt: null,
    amountCents: 2980,
    settlementAmountStatus: 'pending_rule',
    attribution: {
      state: 'pending',
      staffId: null,
      communityId: UUID,
      basis: 'source_missing',
    },
    evidence: { kind: 'channel_payment', ref: 'WX-TXN-0001' },
    counterEntryId: null,
    batchId: null,
    reconciliationState: 'unreconciled',
    recordedByUserId: null,
    recordedByStaffId: null,
    createdAt: NOW,
    ...overrides,
  }
}

describe('PAY-06 online ledger entry contract', () => {
  it('accepts real and simulated online receipts without a human handler', () => {
    assert.equal(ledgerEntrySchema.safeParse(entry()).success, true)
    assert.equal(ledgerEntrySchema.safeParse(entry({ simulated: true })).success, true)
  })

  it('never lets an online receipt impersonate a manual receipt', () => {
    assert.equal(ledgerEntrySchema.safeParse(entry({ recordedByStaffId: UUID })).success, false)
    assert.equal(ledgerEntrySchema.safeParse(entry({
      evidence: { kind: 'manual_receipt', ref: '收据 1' },
    })).success, false)
    assert.equal(ledgerEntrySchema.safeParse(entry({ simulated: true, sourceSystem: 'manual' })).success, false)
  })

  it('keeps manual receipts on the staff/evidence rule', () => {
    const manual = entry({
      sourceSystem: 'manual',
      recordedByStaffId: UUID,
      evidence: { kind: 'manual_receipt', ref: '收据 1' },
    })
    assert.equal(ledgerEntrySchema.safeParse(manual).success, true)
    assert.equal(ledgerEntrySchema.safeParse({ ...manual, recordedByStaffId: null }).success, false)
  })
})
