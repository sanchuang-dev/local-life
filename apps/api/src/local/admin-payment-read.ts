import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import {
  adminLocalOrderDetailSchema,
  adminOrderPaymentSectionSchema,
  type AdminLocalOrderDetail,
  type AdminOrderPaymentSection,
  type LocalOrderDetail,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  ledgerEntries,
  ledgerEntrySources,
  ledgerPaymentOrderLinks,
  localOrderOnlineCompletions,
  localOrderOnlineConflicts,
  paymentAttempts,
  paymentEvents,
  paymentIntents,
  paymentReviewExceptions,
} from '../db/schema.js'
import { getStaffOrder } from './orders.js'
import { iso, type LocalActor } from './shared.js'

/**
 * PAY-08 (#283) back-office payment read model.
 *
 * This module only *reads* the existing payment/ledger truth sources to assemble
 * the read-only section embedded in the existing order detail drawer:
 *
 * - `payment_intents` / `payment_attempts` / `payment_events` (PAY-01–PAY-04);
 * - `local_order_online_completions` / `local_order_online_conflicts` (PAY-05);
 * - `payment_review_exceptions` (PAY-03);
 * - `ledger_entries` + `ledger_entry_sources` (`manual` and `online_payment`).
 *
 * It never writes, never creates a second payment state/transaction table and
 * never re-derives an amount: money always comes from the frozen rows. Raw
 * provider transaction references are masked before they leave the server; the
 * merchant AppID/merchant id are deliberately not projected.
 */

/** Keep at most the last four characters of a channel reference. */
export function maskProviderTransactionId(value: string | null): string | null {
  if (!value) return null
  const tail = value
    .slice(-4)
    .replace(/[^A-Za-z0-9_-]/gu, '')
    .slice(0, 4)
  return `****${tail}`
}

type ManualReceiptRow = {
  entry: typeof ledgerEntries.$inferSelect
  reversal: { entryId: string; amountCents: number; occurredAt: string } | null
}

function manualReceiptsOf(db: AppDatabase, orderId: string): ManualReceiptRow[] {
  const linked = db
    .select({ entry: ledgerEntries })
    .from(ledgerPaymentOrderLinks)
    .innerJoin(ledgerEntries, eq(ledgerPaymentOrderLinks.entryId, ledgerEntries.id))
    .where(eq(ledgerPaymentOrderLinks.orderId, orderId))
    .orderBy(asc(ledgerEntries.occurredAt), asc(ledgerEntries.id))
    .all()
  if (linked.length === 0) return []
  const entryIds = linked.map((row) => row.entry.id)
  const reversals = db
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.factKind, 'payment_reversed'),
        inArray(ledgerEntries.counterEntryId, entryIds),
      ),
    )
    .orderBy(asc(ledgerEntries.occurredAt), asc(ledgerEntries.id))
    .all()
  const reversalsByCounter = new Map<string, (typeof reversals)[number]>()
  for (const reversal of reversals) {
    if (reversal.counterEntryId && !reversalsByCounter.has(reversal.counterEntryId)) {
      reversalsByCounter.set(reversal.counterEntryId, reversal)
    }
  }
  return linked.map(({ entry }) => {
    const reversal = reversalsByCounter.get(entry.id)
    return {
      entry,
      reversal: reversal
        ? {
            entryId: reversal.id,
            amountCents: reversal.amountCents,
            occurredAt: iso(reversal.occurredAt),
          }
        : null,
    }
  })
}

/** `online_payment` receipts are keyed by the PAY-05 completion id. */
function onlineLedgerReceiptsOf(
  db: AppDatabase,
  completionId: string | null,
): Array<{
  entry: typeof ledgerEntries.$inferSelect
}> {
  if (!completionId) return []
  return db
    .select({ entry: ledgerEntries })
    .from(ledgerEntrySources)
    .innerJoin(ledgerEntries, eq(ledgerEntrySources.entryId, ledgerEntries.id))
    .where(
      and(
        eq(ledgerEntrySources.sourceSystem, 'online_payment'),
        eq(ledgerEntrySources.sourceId, completionId),
        eq(ledgerEntrySources.factKind, 'payment_received'),
      ),
    )
    .orderBy(asc(ledgerEntries.occurredAt), asc(ledgerEntries.id))
    .all()
}

export function readAdminOrderPaymentSection(
  db: AppDatabase,
  detail: LocalOrderDetail,
): AdminOrderPaymentSection {
  const orderId = detail.id
  const intents = db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.localOrderId, orderId))
    .orderBy(asc(paymentIntents.createdAt), asc(paymentIntents.id))
    .all()
  const intentIds = intents.map((intent) => intent.id)

  const attempts =
    intentIds.length === 0
      ? []
      : db
          .select()
          .from(paymentAttempts)
          .where(inArray(paymentAttempts.paymentIntentId, intentIds))
          .orderBy(
            asc(paymentAttempts.paymentIntentId),
            asc(paymentAttempts.attemptNo),
            asc(paymentAttempts.createdAt),
          )
          .all()
  const events =
    intentIds.length === 0
      ? []
      : db
          .select()
          .from(paymentEvents)
          .where(inArray(paymentEvents.paymentIntentId, intentIds))
          .orderBy(asc(paymentEvents.createdAt), asc(paymentEvents.id))
          .all()

  const attemptsByIntent = new Map<string, typeof attempts>()
  for (const attempt of attempts) {
    const list = attemptsByIntent.get(attempt.paymentIntentId) ?? []
    list.push(attempt)
    attemptsByIntent.set(attempt.paymentIntentId, list)
  }
  const eventsByIntent = new Map<string, typeof events>()
  for (const event of events) {
    const list = eventsByIntent.get(event.paymentIntentId) ?? []
    list.push(event)
    eventsByIntent.set(event.paymentIntentId, list)
  }

  const completion = db
    .select()
    .from(localOrderOnlineCompletions)
    .where(eq(localOrderOnlineCompletions.localOrderId, orderId))
    .get()
  const conflicts = db
    .select()
    .from(localOrderOnlineConflicts)
    .where(eq(localOrderOnlineConflicts.localOrderId, orderId))
    .orderBy(asc(localOrderOnlineConflicts.createdAt), asc(localOrderOnlineConflicts.id))
    .all()
  const reviewExceptions =
    intentIds.length === 0
      ? []
      : db
          .select()
          .from(paymentReviewExceptions)
          .where(inArray(paymentReviewExceptions.paymentIntentId, intentIds))
          .orderBy(desc(paymentReviewExceptions.observedAt), desc(paymentReviewExceptions.id))
          .all()

  const manualReceiptRows = manualReceiptsOf(db, orderId)
  const onlineReceiptRows = onlineLedgerReceiptsOf(db, completion?.id ?? null)

  const manualReceivedCents =
    manualReceiptRows.reduce((sum, row) => sum + row.entry.amountCents, 0) -
    manualReceiptRows.reduce((sum, row) => sum + (row.reversal?.amountCents ?? 0), 0)
  const onlineRealReceivedCents = onlineReceiptRows
    .filter((row) => !row.entry.simulated)
    .reduce((sum, row) => sum + row.entry.amountCents, 0)
  const onlineSimulatedReceivedCents = onlineReceiptRows
    .filter((row) => row.entry.simulated)
    .reduce((sum, row) => sum + row.entry.amountCents, 0)

  return adminOrderPaymentSectionSchema.parse({
    amounts: {
      grossAmountCents: detail.snapshot.totalCents,
      couponDiscountCents: detail.snapshot.couponDiscountCents,
      netPayableCents: detail.snapshot.netPayableCents,
    },
    manual: {
      verified: detail.status === 'verified' && detail.verification !== null,
      verifiedAt: detail.verification?.verifiedAt ?? null,
      verifiedBy: detail.verification?.verifiedBy ?? null,
      note: detail.verification?.note ?? null,
      receipts: manualReceiptRows.map(({ entry, reversal }) => ({
        entryId: entry.id,
        factKind: 'payment_received' as const,
        amountCents: entry.amountCents,
        evidenceKind: entry.evidenceKind,
        evidenceRef: entry.evidenceRef,
        occurredAt: iso(entry.occurredAt),
        createdAt: iso(entry.createdAt),
        reversal,
      })),
    },
    online: {
      intents: intents.map((intent) => ({
        id: intent.id,
        kind: intent.kind,
        channel: intent.channel,
        simulated: intent.simulated,
        merchantOrderNo: intent.merchantOrderNo,
        grossAmountCents: intent.grossAmountCents,
        discountCents: intent.discountCents,
        netPayableCents: intent.netPayableCents,
        status: intent.status,
        expiresAt: iso(intent.expiresAt),
        paidAt: intent.paidAt ? iso(intent.paidAt) : null,
        closedAt: intent.closedAt ? iso(intent.closedAt) : null,
        failedAt: intent.failedAt ? iso(intent.failedAt) : null,
        failureCode: intent.failureCode,
        failureMessage: intent.failureMessage,
        createdAt: iso(intent.createdAt),
        updatedAt: iso(intent.updatedAt),
        attempts: (attemptsByIntent.get(intent.id) ?? []).map((attempt) => ({
          id: attempt.id,
          attemptNo: attempt.attemptNo,
          status: attempt.status,
          providerTransactionIdMasked: maskProviderTransactionId(
            attempt.providerTransactionId,
          ),
          createdAt: iso(attempt.createdAt),
          updatedAt: iso(attempt.updatedAt),
          confirmedAt: attempt.confirmedAt ? iso(attempt.confirmedAt) : null,
          closedAt: attempt.closedAt ? iso(attempt.closedAt) : null,
          failedAt: attempt.failedAt ? iso(attempt.failedAt) : null,
          failureCode: attempt.failureCode,
          failureMessage: attempt.failureMessage,
        })),
        events: (eventsByIntent.get(intent.id) ?? []).map((event) => ({
          id: event.id,
          eventType: event.eventType,
          source: event.source,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          createdAt: iso(event.createdAt),
        })),
      })),
      completion: completion
        ? {
            paymentIntentId: completion.paymentIntentId,
            kind: completion.kind,
            simulated: completion.simulated,
            amountCents: completion.amountCents,
            discountCents: completion.discountCents,
            providerTransactionIdMasked: maskProviderTransactionId(
              completion.providerTransactionId,
            ),
            completedAt: iso(completion.completedAt),
          }
        : null,
      ledgerReceipts: onlineReceiptRows.map(({ entry }) => ({
        entryId: entry.id,
        factKind: 'payment_received' as const,
        sourceSystem: 'online_payment' as const,
        amountCents: entry.amountCents,
        simulated: entry.simulated,
        providerTransactionIdMasked: maskProviderTransactionId(entry.evidenceRef),
        occurredAt: iso(entry.occurredAt),
        createdAt: iso(entry.createdAt),
      })),
      conflicts: conflicts.map((conflict) => ({
        id: conflict.id,
        kind: conflict.kind,
        status: conflict.status,
        createdAt: iso(conflict.createdAt),
        resolvedAt: conflict.resolvedAt ? iso(conflict.resolvedAt) : null,
      })),
      reviewExceptions: reviewExceptions.map((exception) => ({
        id: exception.id,
        kind: exception.kind,
        status: exception.status,
        channel: exception.channel as 'mock' | 'wechat_jsapi',
        merchantOrderNo: exception.merchantOrderNo,
        providerTransactionIdMasked: maskProviderTransactionId(
          exception.providerTransactionId,
        ),
        amountCents: exception.amountCents,
        source: exception.source,
        failureCode: exception.failureCode,
        observedAt: iso(exception.observedAt),
        createdAt: iso(exception.createdAt),
        resolvedAt: exception.resolvedAt ? iso(exception.resolvedAt) : null,
      })),
    },
    receiptTotals: {
      manualReceivedCents,
      onlineRealReceivedCents,
      onlineSimulatedReceivedCents,
    },
    // Literal by contract: there is no bank-settlement evidence for channel money.
    bankSettlement: { status: 'unverified' },
  })
}

/** Attach the read-only section to an already access-checked order detail. */
export function withAdminPaymentSection(
  db: AppDatabase,
  detail: LocalOrderDetail,
): AdminLocalOrderDetail {
  return adminLocalOrderDetailSchema.parse({
    ...detail,
    // The shared order detail exposes the completion's raw channel reference to
    // the resident who owns the order; the back-office DTO masks it as well, so
    // no admin response can leak a full provider transaction id.
    onlineCompletion: detail.onlineCompletion
      ? {
          ...detail.onlineCompletion,
          providerTransactionId: maskProviderTransactionId(
            detail.onlineCompletion.providerTransactionId,
          ),
        }
      : null,
    paymentSection: readAdminOrderPaymentSection(db, detail),
  })
}

/**
 * Scoped back-office detail. `getStaffOrder` already enforces the caller's
 * community scope (admin = all, operator = assigned, others refused by the
 * `/admin/*` route guard), so this never widens access.
 */
export function getAdminLocalOrderDetail(
  db: AppDatabase,
  actor: LocalActor,
  orderId: string,
): AdminLocalOrderDetail {
  return withAdminPaymentSection(db, getStaffOrder(db, actor, orderId))
}
