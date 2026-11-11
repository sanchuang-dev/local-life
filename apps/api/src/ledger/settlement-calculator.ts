import type {
  SettlementRuleVersion,
  SettlementTrialAllocation,
} from '@sanchuang-dev/local-life-contracts'

export type AllocationTerms = Pick<SettlementRuleVersion,
  'ratesBps' | 'processorFeeBps' | 'processorFeeOwner' |
  'roundingRecipient' | 'feeBase' | 'roundingPolicy' |
  'processorFeeRounding' | 'reversalPolicy' | 'partialRefundPolicy'>

export type AllocationResult =
  | { allocation: SettlementTrialAllocation; blockingReason: null }
  | { allocation: null; blockingReason: 'fee_exceeds_owner_share' }

/**
 * One order, one fully linked actual received receipt, all in integer cents.
 * Floor each gross allocation, give the 0..2 remainder to the EXPLICIT party,
 * then deduct the explicitly approved processing fee from its named owner.
 *
 * Invariant: net seller + net Sanchuang + net Guangdian + fee === gross.
 * BigInt intermediates prevent silent loss of cents on large safe integers.
 * This is a quote ONLY; payment authorization belongs to later work.
 */
export function allocateSettlementCents(
  grossReceivedCents: number,
  terms: AllocationTerms,
): AllocationResult {
  if (!Number.isSafeInteger(grossReceivedCents) || grossReceivedCents <= 0) {
    throw new RangeError('Actual receipt must be a positive safe integer number of cents')
  }
  const rates = terms.ratesBps
  const values = [rates.seller, rates.sanchuang, rates.guangdian, terms.processorFeeBps]
  if (!values.every((x) => Number.isInteger(x) && x >= 0 && x <= 10000) ||
      rates.seller + rates.sanchuang + rates.guangdian !== 10000 ||
      terms.feeBase !== 'actual_received' ||
      terms.roundingPolicy !== 'floor_then_named_remainder' ||
      terms.processorFeeRounding !== 'floor' ||
      terms.reversalPolicy !== 'full_reversal_blocks' ||
      terms.partialRefundPolicy !== 'unsupported_blocks' ||
      !['seller', 'sanchuang', 'guangdian'].includes(terms.roundingRecipient) ||
      ((terms.processorFeeBps === 0) !== (terms.processorFeeOwner === 'none'))) {
    throw new RangeError('Incomplete or invalid approved integer allocation terms')
  }

  const gross = BigInt(grossReceivedCents)
  const divisor = 10000n
  const shares = {
    seller: gross * BigInt(rates.seller) / divisor,
    sanchuang: gross * BigInt(rates.sanchuang) / divisor,
    guangdian: gross * BigInt(rates.guangdian) / divisor,
  }
  const residual = gross - shares.seller - shares.sanchuang - shares.guangdian
  shares[terms.roundingRecipient] += residual

  const fee = gross * BigInt(terms.processorFeeBps) / divisor
  if (terms.processorFeeOwner !== 'none') {
    if (fee > shares[terms.processorFeeOwner]) {
      return { allocation: null, blockingReason: 'fee_exceeds_owner_share' }
    }
    shares[terms.processorFeeOwner] -= fee
  } else if (fee !== 0n) {
    throw new RangeError('Nonzero fee requires an explicitly named owner')
  }
  const net = shares.seller + shares.sanchuang + shares.guangdian
  if (net + fee !== gross) throw new Error('Settlement cent-conservation invariant failed')

  return {
    blockingReason: null,
    allocation: {
      grossReceivedCents,
      processorFeeCents: Number(fee),
      sellerNetCents: Number(shares.seller),
      sanchuangNetCents: Number(shares.sanchuang),
      guangdianNetCents: Number(shares.guangdian),
      totalNetCents: Number(net),
      conservedTotalCents: Number(net + fee),
      roundingResidualCents: Number(residual),
    },
  }
}
