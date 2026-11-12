import { and, desc, eq, gte, lte, or } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  ledgerOrderEvidenceSchema,
  type LedgerOrderEvidence,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  auditLogs,
  ledgerEntries,
  ledgerPaymentOrderLinks,
  localOrders,
  reconciliationBatches,
  users,
} from '../db/schema.js'
import {
  LEDGER_ATTRIBUTION_CONFIRMED_EVENT,
  LocalError,
  assertCommunityAccess,
  iso,
  ledgerEntrySelection,
  toLedgerEntry,
  toShanghaiBusinessDate,
  type LedgerActor,
} from './shared.js'

/** A locked statement also freezes any earlier order it already covered. */
export function isOrderInLockedPeriod(
  db: AppDatabase,
  order: { verifiedAt: Date | null; createdAt: Date },
): boolean {
  const registeredDay = toShanghaiBusinessDate(order.createdAt)
  const verifiedDay = order.verifiedAt
    ? toShanghaiBusinessDate(order.verifiedAt)
    : registeredDay
  return Boolean(db.select({ id: reconciliationBatches.id })
    .from(reconciliationBatches)
    .where(and(
      eq(reconciliationBatches.status, 'locked'),
      // A frozen *registration* cannot be amended by a verification on a
      // different business date. Check both days, not just the last one.
      or(
        and(lte(reconciliationBatches.periodFrom, registeredDay),
          gte(reconciliationBatches.periodTo, registeredDay)),
        and(lte(reconciliationBatches.periodFrom, verifiedDay),
          gte(reconciliationBatches.periodTo, verifiedDay)),
      ),
      gte(reconciliationBatches.lockedAt, order.createdAt),
    )).get())
}

/**
 * One human-readable order ↔ manual receipt trail.
 * Legacy receipts have no link and are NEVER guessed from amounts or timestamps.
 * Evidence recorded here is a human declaration, not independent bank verification.
 */
export function readOrderPaymentEvidence(
  db: AppDatabase,
  actor: LedgerActor,
  orderId: string,
): LedgerOrderEvidence {
  const order = db.select().from(localOrders).where(eq(localOrders.id, orderId)).get()
  if (!order) throw new LocalError(404, API_ERROR_CODES.notFound, '本地订单不存在')
  assertCommunityAccess(db, actor, order.communityId)

  const link = db.select().from(ledgerPaymentOrderLinks)
    .where(eq(ledgerPaymentOrderLinks.orderId, orderId)).get()
  const row = link
    ? db.select(ledgerEntrySelection).from(ledgerEntries)
      .where(eq(ledgerEntries.id, link.entryId)).get()
    : null
  if (link && !row) throw new Error('Linked receipt missing from immutable ledger')
  const receipt = row ? toLedgerEntry(row) : null
  const reversal = receipt
    ? db.select({ id: ledgerEntries.id }).from(ledgerEntries)
      .where(and(eq(ledgerEntries.factKind, 'payment_reversed'),
        eq(ledgerEntries.counterEntryId, receipt.entryId))).get()
    : null

  const confirmation = receipt
    ? db.select({ actorUserId: auditLogs.actorUserId,
        reviewedByName: users.displayName,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(and(eq(auditLogs.event, LEDGER_ATTRIBUTION_CONFIRMED_EVENT),
        eq(auditLogs.targetId, receipt.entryId)))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).get()
    : null
  let confirmed: NonNullable<NonNullable<LedgerOrderEvidence['payment']>['confirmation']> | null = null
  if (confirmation?.actorUserId && confirmation.metadata) {
    try {
      const metadata = JSON.parse(confirmation.metadata) as {
        staffId?: unknown; note?: unknown
      }
      if (typeof metadata.staffId === 'string') {
        confirmed = {
          reviewedByUserId: confirmation.actorUserId,
          reviewedByName: confirmation.reviewedByName,
          staffId: metadata.staffId,
          note: typeof metadata.note === 'string' ? metadata.note : null,
          confirmedAt: iso(confirmation.createdAt),
        }
      }
    } catch {
      // Malformed historical audit metadata cannot be treated as confirmed.
    }
  }

  const locked = isOrderInLockedPeriod(db, order)
  const netPayableCents = order.totalCents - order.couponDiscountCents
  const canRecord = !link && order.status === 'verified' &&
    netPayableCents > 0 && !locked

  const blockingReasons: string[] = []
  let status: LedgerOrderEvidence['status'] = 'no_evidence'
  if (receipt) {
    if (reversal) {
      status = 'reversed'
      blockingReasons.push('该笔收款已全额冲正，不能进入后续结算')
    } else if (receipt.amountCents !== netPayableCents) {
      status = 'amount_mismatch'
      blockingReasons.push('凭据实收与订单登记金额不一致，需人工复核')
    } else if (receipt.attribution.state !== 'attributed' || !confirmed) {
      status = 'pending_attribution'
      blockingReasons.push('业绩归属尚未确认，不能作为结算依据')
    } else {
      status = 'evidence_recorded'
    }
  } else if (order.status === 'verified' && netPayableCents === 0 && order.couponId) {
    status = 'coupon_only_verified'
    blockingReasons.push('消费券全额抵扣，实际应收0元；无现金凭据，补贴结算须另按合同核对')
  } else if (order.status !== 'verified') {
    status = 'pending_order_review'
    blockingReasons.push('订单尚未完成业务核验，不能登记收款关联')
  } else if (locked) {
    status = 'locked_period'
    blockingReasons.push('订单已进入锁定对账期间，不能事后补记凭据')
  } else {
    blockingReasons.push('尚无实收证明，请登记真实收款凭据')
  }

  return ledgerOrderEvidenceSchema.parse({
    orderId,
    orderDisplayNo: orderId.slice(0, 8).toUpperCase(),
    communityId: order.communityId,
    productName: order.productName,
    orderStatus: order.status,
    registeredAmountCents: order.totalCents,
    couponDiscountCents: order.couponDiscountCents,
    netPayableCents,
    canRecord,
    status,
    blockingReasons,
    payment: receipt ? {
      entryId: receipt.entryId,
      amountCents: receipt.amountCents,
      receivedAt: receipt.occurredAt,
      evidenceKind: receipt.evidence.kind,
      evidenceRef: receipt.evidence.ref,
      recordedByStaffId: receipt.recordedByStaffId,
      attribution: receipt.attribution,
      reversedEntryId: reversal?.id ?? null,
      confirmation: confirmed,
    } : null,
  })
}

/** Reverse lookup from a fact row to its order (never guesses a historic link). */
export function readEntryOrderPaymentEvidence(
  db: AppDatabase,
  actor: LedgerActor,
  entryId: string,
): { order: LedgerOrderEvidence | null } {
  const entry = db.select({ communityId: ledgerEntries.communityId })
    .from(ledgerEntries).where(eq(ledgerEntries.id, entryId)).get()
  if (!entry) throw new LocalError(404, API_ERROR_CODES.notFound, '流水条目不存在')
  assertCommunityAccess(db, actor, entry.communityId)
  const link = db.select({ orderId: ledgerPaymentOrderLinks.orderId })
    .from(ledgerPaymentOrderLinks)
    .where(eq(ledgerPaymentOrderLinks.entryId, entryId)).get()
  return { order: link ? readOrderPaymentEvidence(db, actor, link.orderId) : null }
}
