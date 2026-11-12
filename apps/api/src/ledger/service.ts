import { createHash, randomUUID } from 'node:crypto'
import { and, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  API_ERROR_CODES,
  ledgerAnomalyKindSchema,
  ledgerAnomalySchema,
  ledgerAnomalySeveritySchema,
  ledgerRecordPaymentRequestSchema,
  ledgerSyncRequestSchema,
  type LedgerSyncRequest,
  type LedgerSyncResponse,
  type LedgerAnomalyListResponse,
  type LedgerAttributionBasis,
  type LedgerEntry,
  type LedgerEvidenceKind,
  type LedgerFactKind,
  type LedgerSourceSystem,
  type SettlementAmountStatus,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  activityRewardDisputes,
  activityRewardGrants,
  auditLogs,
  crmServiceOrders,
  ledgerAnomalies,
  ledgerEntries,
  ledgerEntrySources,
  ledgerPaymentOrderLinks,
  localOrders,
  reconciliationBatches,
  staffAccounts,
  staffCommunityAssignments,
} from '../db/schema.js'
import {
  LEDGER_ATTRIBUTION_CONFIRMED_EVENT,
  LocalError,
  assertCommunityAccess,
  combine,
  insertAudit,
  iso,
  ledgerEntrySelection,
  scopeCommunityIds,
  shanghaiDayEndExclusiveMs,
  shanghaiDayStartMs,
  toShanghaiBusinessDate,
  toLedgerEntry,
  type LedgerActor,
  type LedgerEntryRow,
  type LocalTransaction,
} from './shared.js'
import { cutoffMsOf, membershipConditions } from './reconciliation-service.js'
import { isOrderInLockedPeriod } from './payment-evidence.js'
import { tryIssueEligibleTeamCoupons } from '../purchase-reward/coupon-issuance.js'

/**
 * Write side of the ledger (LL-MVP-008, Issue #64): fact ingestion, manual
 * receipts and their reversals, attribution confirmation and anomaly flags.
 *
 * Three rules shape every function here.
 *
 * 1. **Nothing is corrected in place.** `ledger_entries` is UPDATE/DELETE-blocked
 *    by migration 0010 triggers, so a mistake is answered with a *new* row
 *    (`payment_reversed` / `reward_reversed` carrying `counterEntryId`) or with an
 *    appended record (attribution confirmation, anomaly flag). That is what makes
 *    a printed reconciliation statement reproducible.
 * 2. **Ingestion is idempotent by `(source_system, source_id, fact_kind)`.** The
 *    dedupe key lives in `ledger_entry_sources` with a UNIQUE index, so a replayed
 *    source read can only ever hit the existing fact and is counted as `skipped`.
 * 3. **No invented money.** 三天来源各自的口径永远不合并：
 *    `local_orders.total_cents` 是登记金额，`status='verified'` 只是人工核验，
 *    `crm_service_orders` 根本没有金额列（`amountCents = 0`），奖励成本可以求和但
 *    冲正只追加。收款只有人工登记这一条路径，且必须带凭据与经办人。
 */

/* -------------------------------------------------------------------------- */
/* Request contracts                                                          */
/* -------------------------------------------------------------------------- */

const uuid = z.string().uuid()
const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be an ISO-8601 UTC timestamp')

/**
 * A manual receipt. Every field of the 凭据 is required: an amount without a
 * reference or without the staff member who handled it is not a receipt, it is a
 * guess, and the database CHECK refuses it as well.
 *
 * `sourceId` is optional only so a client *may* pass its own receipt number; the
 * default is a fresh id, and a repeated receipt number is a `409`
 * `ledger_source_duplicate` instead of a second 实收.
 */
export const recordPaymentRequestSchema = ledgerRecordPaymentRequestSchema

export type RecordPaymentRequest = z.infer<typeof recordPaymentRequestSchema>

const canonicalPaymentEvidenceKey = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()

const paymentProofSourceId = (value: string): string =>
  'evidence-proof:' + createHash('sha256')
    .update(canonicalPaymentEvidenceKey(value))
    .digest('hex')

/** A reversal of one receipt: always the full amount, always a new row. */
export const reversePaymentRequestSchema = z.strictObject({
  evidenceRef: z.string().trim().min(1).max(200).optional(),
  evidenceKind: z.enum(['manual_receipt', 'bank_transfer']).optional(),
  /** When the reversal happened (business instant); defaults to "now". */
  reversedAt: isoTimestamp.optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  staffId: uuid.optional(),
})

export type ReversePaymentRequest = z.infer<typeof reversePaymentRequestSchema>

/**
 * Attribution confirmation. Only `pending` facts may be confirmed, and the
 * confirmation is an appended record — the immutable fact row keeps saying
 * `pending` forever.
 */
export const resolveAttributionRequestSchema = z.strictObject({
  entryId: uuid,
  staffId: uuid,
  note: z.string().trim().min(1).max(500).optional(),
})

export type ResolveAttributionRequest = z.infer<typeof resolveAttributionRequestSchema>

/** Flag one fact. Anomalies are review hints; they never rewrite money. */
export const flagAnomalyRequestSchema = z.strictObject({
  entryId: uuid,
  kind: ledgerAnomalyKindSchema,
  severity: ledgerAnomalySeveritySchema,
  note: z.string().trim().min(1).max(500).optional(),
})

export type FlagAnomalyRequest = z.infer<typeof flagAnomalyRequestSchema>

/** Query of the anomaly inbox: by fact, by batch, or the whole scoped inbox. */
export const listAnomaliesQuerySchema = z.strictObject({
  entryId: uuid.optional(),
  batchId: uuid.optional(),
  includeResolved: z
    .preprocess(
      (value) => (value === 'true' ? true : value === 'false' ? false : value),
      z.boolean(),
    )
    .default(false),
})

export type ListAnomaliesQuery = z.infer<typeof listAnomaliesQuerySchema>

/** Public ingestion route and backend share the identical request schema. */
export const syncLedgerFactsRequestSchema = ledgerSyncRequestSchema
export type SyncLedgerFactsRequest = LedgerSyncRequest

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

type SourceCounter = LedgerSyncResponse['sources']['localOrder']
export type LedgerSyncResult = LedgerSyncResponse

/** Everything needed to append one fact. `createdAt` is stamped by the caller. */
interface FactInput {
  factKind: LedgerFactKind
  sourceSystem: LedgerSourceSystem
  sourceId: string
  sourceDisplayNo: string
  communityId: string
  productId: string | null
  attributedStaffId: string | null
  attributionState: 'attributed' | 'pending'
  attributionBasis: LedgerAttributionBasis
  amountCents: number
  settlementAmountStatus?: SettlementAmountStatus
  occurredAt: Date
  verifiedAt: Date | null
  recordedByUserId: string | null
  recordedByStaffId: string | null
  counterEntryId: string | null
  evidenceKind: LedgerEvidenceKind
  evidenceRef: string | null
  createdAt: Date
}

function existingEntryIdOfSource(
  tx: LocalTransaction,
  sourceSystem: LedgerSourceSystem,
  sourceId: string,
  factKind: LedgerFactKind,
): string | null {
  const row = tx
    .select({ entryId: ledgerEntrySources.entryId })
    .from(ledgerEntrySources)
    .where(
      and(
        eq(ledgerEntrySources.sourceSystem, sourceSystem),
        eq(ledgerEntrySources.sourceId, sourceId),
        eq(ledgerEntrySources.factKind, factKind),
      ),
    )
    .get()
  return row?.entryId ?? null
}

/**
 * Appends one fact unless its dedupe key already exists.
 *
 * Returns the entry id either way — the reversal path needs the id of the
 * `reward_cost` row it is reversing, whether this call created it or merely found
 * it. The insert is guarded by the UNIQUE index, so a concurrent second sync
 * (or a duplicate source notification) surfaces as `skipped`, never as a second
 * fact about the same money.
 */
function appendFact(
  tx: LocalTransaction,
  input: FactInput,
): { entryId: string; created: boolean } {
  const existing = existingEntryIdOfSource(
    tx,
    input.sourceSystem,
    input.sourceId,
    input.factKind,
  )
  if (existing !== null) return { entryId: existing, created: false }

  const entryId = randomUUID()
  tx.insert(ledgerEntries)
    .values({
      id: entryId,
      factKind: input.factKind,
      sourceSystem: input.sourceSystem,
      sourceId: input.sourceId,
      sourceDisplayNo: input.sourceDisplayNo,
      communityId: input.communityId,
      productId: input.productId,
      attributedStaffId: input.attributedStaffId,
      attributionState: input.attributionState,
      attributionBasis: input.attributionBasis,
      amountCents: input.amountCents,
      settlementAmountStatus: input.settlementAmountStatus ?? 'pending_rule',
      occurredAt: input.occurredAt,
      verifiedAt: input.verifiedAt,
      recordedByUserId: input.recordedByUserId,
      recordedByStaffId: input.recordedByStaffId,
      counterEntryId: input.counterEntryId,
      evidenceRef: input.evidenceRef,
      evidenceKind: input.evidenceKind,
      // `batch_id` is never stamped: reconciliation membership is derived from the
      // batch period (see `shared.ts`), which is the only rule that survives an
      // append-only fact table.
      batchId: null,
      createdAt: input.createdAt,
    })
    .run()
  tx.insert(ledgerEntrySources)
    .values({
      id: randomUUID(),
      sourceSystem: input.sourceSystem,
      sourceId: input.sourceId,
      factKind: input.factKind,
      entryId,
      createdAt: input.createdAt,
    })
    .run()
  return { entryId, created: true }
}

/** `application/x-www-form-urlencoded`-free helper: the business-date window. */
function occurredWindow(input: SyncLedgerFactsRequest): { startMs: number | null; endMs: number | null } {
  return {
    startMs: input.from ? shanghaiDayStartMs(input.from) : null,
    endMs: input.to ? shanghaiDayEndExclusiveMs(input.to) : null,
  }
}

function emptyCounter(): SourceCounter {
  return { scanned: 0, created: 0, skipped: 0 }
}

function readEntryRow(db: AppDatabase, entryId: string): LedgerEntryRow | null {
  return (
    db
      .select(ledgerEntrySelection)
      .from(ledgerEntries)
      .where(eq(ledgerEntries.id, entryId))
      .get() ?? null
  )
}

function requireEntryRow(db: AppDatabase, actor: LedgerActor, entryId: string): LedgerEntryRow {
  const row = readEntryRow(db, entryId)
  if (!row) {
    throw new LocalError(404, API_ERROR_CODES.notFound, '流水条目不存在')
  }
  // Reading one fact is a scoped read: a grid worker asking for another
  // community's entry is a 403, never a silently empty body.
  assertCommunityAccess(db, actor, row.communityId)
  return row
}

function toDto(row: LedgerEntryRow): LedgerEntry {
  return toLedgerEntry(row)
}

/* -------------------------------------------------------------------------- */
/* Ingestion                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Idempotent ingestion of the three fact sources.
 *
 * | source                | fact kind            | amount                       |
 * | --------------------- | -------------------- | ---------------------------- |
 * | `local_orders`        | `order_registered`   | `total_cents`（登记金额）     |
 * | `local_orders` verified | `order_verified`   | `total_cents`（已核验业绩）   |
 * | `crm_service_orders` confirmed | `order_verified` | **0** — 没有金额列 |
 * | `activity_reward_grants` | `reward_cost`     | `total_cost_cents`           |
 * | grant `reversed` / dispute `reversed` | `reward_reversed` | 同额冲正 |
 *
 * Both halves of the local-order fact are emitted on purpose, and they are never
 * summed into one number: 登记金额 is what the resident asked for, 已核验业绩 is
 * what a human verified. Neither is 实收 — only `payment_received` is, and it can
 * only be created by a human with evidence.
 *
 * `crm_service_orders` has no amount column at all, so a confirmed CRM order is
 * recorded with `amountCents = 0`. Inventing a number there — even a "reasonable"
 * one — would put unverifiable money into a reconciliation statement.
 *
 * Re-running over the same window creates nothing: every fact is keyed by
 * `(source_system, source_id, fact_kind)` and counted as `skipped`.
 */
export function syncLedgerFacts(
  db: AppDatabase,
  actor: LedgerActor,
  input: SyncLedgerFactsRequest = {},
  options: { now?: Date } = {},
): LedgerSyncResult {
  const now = options.now ?? new Date()
  const window = occurredWindow(input)
  const scope = scopeCommunityIds(db, actor)
  if (scope !== null && scope.length === 0) {
    return {
      scanned: 0,
      created: 0,
      skipped: 0,
      sources: {
        localOrder: emptyCounter(),
        crmServiceOrder: emptyCounter(),
        activityRewardGrant: emptyCounter(),
      },
    }
  }
  const createdAt = now

  return db.transaction(
    (tx): LedgerSyncResult => {
      const localOrder = emptyCounter()
      const crmServiceOrder = emptyCounter()
      const activityRewardGrant = emptyCounter()

      /* ----------------------------- local orders ---------------------------- */

      const orderConditions: SQL<unknown>[] = []
      if (scope !== null) orderConditions.push(inArray(localOrders.communityId, scope))
      if (window.startMs !== null) {
        orderConditions.push(gte(localOrders.createdAt, new Date(window.startMs)))
      }
      if (window.endMs !== null) {
        orderConditions.push(lt(localOrders.createdAt, new Date(window.endMs)))
      }
      const orders = tx
        .select({
          id: localOrders.id,
          communityId: localOrders.communityId,
          productId: localOrders.productId,
          status: localOrders.status,
          totalCents: localOrders.totalCents,
          createdAt: localOrders.createdAt,
          verifiedAt: localOrders.verifiedAt,
          updatedAt: localOrders.updatedAt,
        })
        .from(localOrders)
        .where(combine(orderConditions))
        .all()

      for (const order of orders) {
        localOrder.scanned += 1
        // 登记金额：created_at 就是这笔登记发生的时间。
        const registered = appendFact(tx, {
          factKind: 'order_registered',
          sourceSystem: 'local_order',
          sourceId: order.id,
          sourceDisplayNo: order.id,
          communityId: order.communityId,
          productId: order.productId,
          // `local_orders.attributed_staff_id` is written unconditionally with the
          // creator (`src/local/orders.ts`), so it can never distinguish an explicit
          // attribution from creator backfill. Every local-order fact therefore
          // enters the ledger as 待归属; only a human confirmation moves it.
          attributedStaffId: null,
          attributionState: 'pending',
          attributionBasis: 'no_explicit_attribution',
          amountCents: order.totalCents,
          occurredAt: order.createdAt,
          verifiedAt: null,
          recordedByUserId: null,
          recordedByStaffId: null,
          counterEntryId: null,
          evidenceKind: 'none',
          evidenceRef: null,
          createdAt,
        })
        if (registered.created) localOrder.created += 1
        else localOrder.skipped += 1

        if (order.status !== 'verified') continue
        localOrder.scanned += 1
        const verifiedAt = order.verifiedAt ?? order.updatedAt
        const verified = appendFact(tx, {
          factKind: 'order_verified',
          sourceSystem: 'local_order',
          sourceId: order.id,
          sourceDisplayNo: order.id,
          communityId: order.communityId,
          productId: order.productId,
          attributedStaffId: null,
          attributionState: 'pending',
          attributionBasis: 'no_explicit_attribution',
          amountCents: order.totalCents,
          occurredAt: verifiedAt,
          verifiedAt,
          recordedByUserId: null,
          recordedByStaffId: null,
          counterEntryId: null,
          evidenceKind: 'order_verification',
          // The verification itself is the evidence; the order id is the human
          // reference an auditor can look up.
          evidenceRef: order.id,
          createdAt,
        })
        if (verified.created) localOrder.created += 1
        else localOrder.skipped += 1
      }

      /* ---------------------------- CRM service ------------------------------ */

      const crmConditions: SQL<unknown>[] = [eq(crmServiceOrders.status, 'confirmed')]
      if (scope !== null) crmConditions.push(inArray(crmServiceOrders.communityId, scope))
      if (window.startMs !== null) {
        crmConditions.push(gte(crmServiceOrders.createdAt, new Date(window.startMs)))
      }
      if (window.endMs !== null) {
        crmConditions.push(lt(crmServiceOrders.createdAt, new Date(window.endMs)))
      }
      const crmOrders = tx
        .select({
          id: crmServiceOrders.id,
          communityId: crmServiceOrders.communityId,
          orderNo: crmServiceOrders.orderNo,
          evidenceRef: crmServiceOrders.evidenceRef,
          attributedStaffId: crmServiceOrders.attributedStaffId,
          confirmedAt: crmServiceOrders.confirmedAt,
          createdAt: crmServiceOrders.createdAt,
          updatedAt: crmServiceOrders.updatedAt,
        })
        .from(crmServiceOrders)
        .where(combine(crmConditions))
        .all()

      for (const order of crmOrders) {
        crmServiceOrder.scanned += 1
        const confirmedAt = order.confirmedAt ?? order.updatedAt
        const appended = appendFact(tx, {
          factKind: 'order_verified',
          sourceSystem: 'crm_service_order',
          sourceId: order.id,
          sourceDisplayNo: order.orderNo,
          communityId: order.communityId,
          productId: null,
          // The CRM order names its owning staff member explicitly (NOT NULL), so
          // this is a confirmed fact, not an inference from who typed it in.
          attributedStaffId: order.attributedStaffId,
          attributionState: 'attributed',
          attributionBasis: 'confirmed_fact',
          // No amount column exists on the source: 0, never an estimate.
          amountCents: 0,
          occurredAt: confirmedAt,
          verifiedAt: confirmedAt,
          recordedByUserId: null,
          recordedByStaffId: null,
          counterEntryId: null,
          evidenceKind: 'crm_confirmation',
          evidenceRef: order.evidenceRef ?? order.orderNo,
          createdAt,
        })
        if (appended.created) crmServiceOrder.created += 1
        else crmServiceOrder.skipped += 1
      }

      /* --------------------------- reward fulfilment ------------------------- */

      const grantConditions: SQL<unknown>[] = []
      if (scope !== null) grantConditions.push(inArray(activities.communityId, scope))
      if (window.startMs !== null) {
        grantConditions.push(gte(activityRewardGrants.grantedAt, new Date(window.startMs)))
      }
      if (window.endMs !== null) {
        grantConditions.push(lt(activityRewardGrants.grantedAt, new Date(window.endMs)))
      }
      const grants = tx
        .select({
          id: activityRewardGrants.id,
          communityId: activities.communityId,
          prizeName: activityRewardGrants.prizeName,
          totalCostCents: activityRewardGrants.totalCostCents,
          status: activityRewardGrants.status,
          grantedAt: activityRewardGrants.grantedAt,
          redeemedAt: activityRewardGrants.redeemedAt,
        })
        .from(activityRewardGrants)
        .innerJoin(activities, eq(activityRewardGrants.activityId, activities.id))
        .where(combine(grantConditions))
        .all()

      const reversedGrants = new Map<string, string>()

      for (const grant of grants) {
        activityRewardGrant.scanned += 1
        const appended = appendFact(tx, {
          factKind: 'reward_cost',
          sourceSystem: 'activity_reward_grant',
          sourceId: grant.id,
          sourceDisplayNo: grant.id,
          communityId: grant.communityId,
          productId: null,
          // A reward grant belongs to a team, not to a staff member: the source
          // carries no attribution at all, which is `source_missing`, not a guess.
          attributedStaffId: null,
          attributionState: 'pending',
          attributionBasis: 'source_missing',
          amountCents: grant.totalCostCents,
          occurredAt: grant.grantedAt,
          verifiedAt: null,
          recordedByUserId: null,
          recordedByStaffId: null,
          counterEntryId: null,
          evidenceKind: 'reward_grant',
          evidenceRef: grant.id,
          createdAt,
        })
        if (appended.created) activityRewardGrant.created += 1
        else activityRewardGrant.skipped += 1
        reversedGrants.set(grant.id, appended.entryId)

        if (grant.status !== 'reversed') continue
        activityRewardGrant.scanned += 1
        const reversed = appendFact(tx, {
          factKind: 'reward_reversed',
          sourceSystem: 'activity_reward_grant',
          // Distinct from the dispute-driven reversal below: one grant could in
          // principle carry both, and the counter-entry guard refuses the second.
          sourceId: `${grant.id}:status_reversed`,
          sourceDisplayNo: grant.id,
          communityId: grant.communityId,
          productId: null,
          attributedStaffId: null,
          attributionState: 'pending',
          attributionBasis: 'source_missing',
          amountCents: grant.totalCostCents,
          occurredAt: grant.redeemedAt ?? grant.grantedAt,
          verifiedAt: null,
          recordedByUserId: null,
          recordedByStaffId: null,
          counterEntryId: appended.entryId,
          evidenceKind: 'reward_grant',
          evidenceRef: grant.id,
          createdAt,
        })
        if (reversed.created) activityRewardGrant.created += 1
        else activityRewardGrant.skipped += 1
      }

      /* ------------------------ dispute-driven reversal ---------------------- */

      const disputeConditions: SQL<unknown>[] = [eq(activityRewardDisputes.decision, 'reversed')]
      if (scope !== null) disputeConditions.push(inArray(activities.communityId, scope))
      if (window.startMs !== null) {
        disputeConditions.push(gte(activityRewardDisputes.createdAt, new Date(window.startMs)))
      }
      if (window.endMs !== null) {
        disputeConditions.push(lt(activityRewardDisputes.createdAt, new Date(window.endMs)))
      }
      const disputes = tx
        .select({
          id: activityRewardDisputes.id,
          grantId: activityRewardDisputes.grantId,
          communityId: activities.communityId,
          createdAt: activityRewardDisputes.createdAt,
        })
        .from(activityRewardDisputes)
        .innerJoin(activities, eq(activityRewardDisputes.activityId, activities.id))
        .where(combine(disputeConditions))
        .all()

      for (const dispute of disputes) {
        activityRewardGrant.scanned += 1
        let costEntryId = reversedGrants.get(dispute.grantId) ?? null
        if (costEntryId === null) {
          costEntryId = existingEntryIdOfSource(
            tx,
            'activity_reward_grant',
            dispute.grantId,
            'reward_cost',
          )
        }
        if (costEntryId === null) {
          // The grant is outside this window, so the cost fact has not been
          // ingested yet. Its reversal will be appended by the run that covers the
          // grant; skipping here keeps the reversal from pointing at nothing.
          activityRewardGrant.skipped += 1
          continue
        }
        const costRow = tx
          .select({ amountCents: ledgerEntries.amountCents })
          .from(ledgerEntries)
          .where(eq(ledgerEntries.id, costEntryId))
          .get()
        if (!costRow) {
          activityRewardGrant.skipped += 1
          continue
        }
        // A cost fact can only be reversed once: `sum(reversed) <= sum(cost)` must
        // hold for every statement, so a second reversal of the same entry is
        // refused (the counter-entry scope trigger enforces the inverse case).
        const alreadyReversed = tx
          .select({ id: ledgerEntries.id })
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.factKind, 'reward_reversed'),
              eq(ledgerEntries.counterEntryId, costEntryId),
            ),
          )
          .get()
        if (alreadyReversed) {
          activityRewardGrant.skipped += 1
          continue
        }
        const appended = appendFact(tx, {
          factKind: 'reward_reversed',
          sourceSystem: 'activity_reward_grant',
          sourceId: `${dispute.grantId}:dispute:${dispute.id}`,
          sourceDisplayNo: dispute.grantId,
          communityId: dispute.communityId,
          productId: null,
          attributedStaffId: null,
          attributionState: 'pending',
          attributionBasis: 'source_missing',
          amountCents: costRow.amountCents,
          occurredAt: dispute.createdAt,
          verifiedAt: null,
          recordedByUserId: null,
          recordedByStaffId: null,
          counterEntryId: costEntryId,
          evidenceKind: 'reward_grant',
          evidenceRef: dispute.id,
          createdAt,
        })
        if (appended.created) activityRewardGrant.created += 1
        else activityRewardGrant.skipped += 1
      }

      const counters = { localOrder, crmServiceOrder, activityRewardGrant }
      return {
        scanned:
          localOrder.scanned + crmServiceOrder.scanned + activityRewardGrant.scanned,
        created: localOrder.created + crmServiceOrder.created + activityRewardGrant.created,
        skipped: localOrder.skipped + crmServiceOrder.skipped + activityRewardGrant.skipped,
        sources: counters,
      }
    },
    { behavior: 'immediate' },
  )
}

/* -------------------------------------------------------------------------- */
/* Manual receipts                                                            */
/* -------------------------------------------------------------------------- */

/** An active staff account, required to handle money. */
function requireActiveStaff(tx: LocalTransaction, staffId: string, communityId: string): void {
  const staff = tx
    .select({ id: staffAccounts.id, status: staffAccounts.status })
    .from(staffAccounts)
    .where(eq(staffAccounts.id, staffId))
    .get()
  if (!staff || staff.status !== 'active') {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '经办人员不存在或已停用')
  }
  const assignment = tx
    .select({ communityId: staffCommunityAssignments.communityId })
    .from(staffCommunityAssignments)
    .where(
      and(
        eq(staffCommunityAssignments.staffAccountId, staffId),
        eq(staffCommunityAssignments.communityId, communityId),
      ),
    )
    .get()
  if (!assignment) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '经办人员不属于该社区')
  }
}

/**
 * Records one manual receipt (实收).
 *
 * This is the **only** producer of `payment_received` in the MVP: there is no
 * online payment integration, so money is real only when a human wrote down how
 * much, when, on what evidence, and who took it. Every one of those four facts is
 * mandatory; the database CHECK refuses a receipt without evidence or handler, and
 * the contract refuses a non-positive amount.
 */
export function recordPayment(
  db: AppDatabase,
  actor: LedgerActor,
  input: RecordPaymentRequest,
  options: { now?: Date } = {},
): LedgerEntry {
  const parsed = recordPaymentRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '收款参数不正确')
  }
  const body = parsed.data
  const now = options.now ?? new Date()
  const receivedAt = new Date(body.receivedAt)
  if (Number.isNaN(receivedAt.getTime())) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '收款时间不是合法时间')
  }
  if (receivedAt.getTime() > now.getTime()) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '收款时间不能晚于当前时间')
  }
  assertCommunityAccess(db, actor, body.communityId)

  // One receipt number for the whole call: the duplicate probe and the insert must
  // agree, otherwise the idempotency key would be a fresh random every time.
  const sourceId = body.sourceId ?? `receipt:${randomUUID()}`
  const evidenceKey = canonicalPaymentEvidenceKey(body.evidenceRef)
  const proofSourceId = paymentProofSourceId(body.evidenceRef)

  const entryId = db.transaction(
    (tx): string => {
      requireActiveStaff(tx, body.staffId, body.communityId)
      const duplicate = existingEntryIdOfSource(tx, 'manual', sourceId, 'payment_received')
      if (duplicate !== null) {
        throw new LocalError(409, API_ERROR_CODES.ledgerSourceDuplicate, '该收款凭据已登记，不能重复入账')
      }
      // A human-provided sourceId is not sufficient to prevent double counting.
      // Reserve a canonical proof alias in the existing UNIQUE source ledger so
      // Unicode-width/case/whitespace variants cannot race into two receipts.
      if (existingEntryIdOfSource(tx, 'manual', proofSourceId, 'payment_received') !== null) {
        throw new LocalError(409, API_ERROR_CODES.ledgerSourceDuplicate,
          '该凭据编号已有收款登记，不能重复记钱')
      }
      // Historical receipts predate the canonical alias. Keep them immutable,
      // but normalize their raw references when deciding whether a new receipt
      // would duplicate one of those facts.
      const existingProof = tx.select({ evidenceRef: ledgerEntries.evidenceRef })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.factKind, 'payment_received')).all()
        .some((row) => row.evidenceRef !== null &&
          canonicalPaymentEvidenceKey(row.evidenceRef) === evidenceKey)
      if (existingProof) {
        throw new LocalError(409, API_ERROR_CODES.ledgerSourceDuplicate,
          '该凭据编号已有收款登记，不能重复记钱')
      }

      // Only a NEW receipt can be associated with an order, in this SAME
      // immediate SQLite transaction. Never back-match a legacy receipt.
      if (body.orderId) {
        const order = tx.select().from(localOrders)
          .where(eq(localOrders.id, body.orderId)).get()
        if (!order) {
          throw new LocalError(404, API_ERROR_CODES.notFound, '本地订单不存在')
        }
        if (order.communityId !== body.communityId) {
          throw new LocalError(403, API_ERROR_CODES.forbidden, '收款与订单不属于同一社区')
        }
        if (order.status !== 'verified') {
          throw new LocalError(409, API_ERROR_CODES.conflict, '订单尚未人工核验，不能登记对应收款')
        }
        if (order.totalCents <= 0) {
          throw new LocalError(409, API_ERROR_CODES.conflict, '零金额订单不能登记实收凭据')
        }
        if (tx.select({ orderId: ledgerPaymentOrderLinks.orderId })
          .from(ledgerPaymentOrderLinks)
          .where(eq(ledgerPaymentOrderLinks.orderId, body.orderId)).get()) {
          throw new LocalError(409, API_ERROR_CODES.conflict, '该订单已有收款凭据，请在流水详情核查')
        }
        if (tx.select({ orderId: ledgerPaymentOrderLinks.orderId })
          .from(ledgerPaymentOrderLinks)
          .where(eq(ledgerPaymentOrderLinks.evidenceKey, evidenceKey)).get()) {
          throw new LocalError(409, API_ERROR_CODES.conflict, '该收款凭据已被另一笔订单使用')
        }
        if (isOrderInLockedPeriod(db, order)) {
          throw new LocalError(409, API_ERROR_CODES.ledgerBatchLocked,
            '订单已处于锁定对账期间，不能补记关联收款')
        }
      }
      const appended = appendFact(tx, {
        factKind: 'payment_received',
        sourceSystem: 'manual',
        sourceId,
        // API detail contract caps the human display number at 80 chars;
        // retain the complete proof number separately in evidenceRef.
        sourceDisplayNo: body.sourceDisplayNo ?? body.evidenceRef.slice(0, 80),
        communityId: body.communityId,
        productId: null,
        // A receipt names who took the money, not who it belongs to. Attribution
        // starts as 待归属 and is confirmed separately.
        attributedStaffId: null,
        attributionState: 'pending',
        attributionBasis: 'no_explicit_attribution',
        amountCents: body.amountCents,
        occurredAt: receivedAt,
        verifiedAt: null,
        recordedByUserId: actor.userId,
        recordedByStaffId: body.staffId,
        counterEntryId: null,
        evidenceKind: body.evidenceKind,
        evidenceRef: body.evidenceRef,
        createdAt: now,
      })
      if (sourceId !== proofSourceId) {
        tx.insert(ledgerEntrySources).values({
          id: randomUUID(),
          sourceSystem: 'manual',
          sourceId: proofSourceId,
          factKind: 'payment_received',
          entryId: appended.entryId,
          createdAt: now,
        }).run()
      }
      if (body.orderId) {
        tx.insert(ledgerPaymentOrderLinks).values({
          orderId: body.orderId,
          entryId: appended.entryId,
          evidenceKey,
          createdAt: now,
        }).run()
        insertAudit(tx, actor.userId, 'ledger.order_payment.linked', body.orderId, now, {
          entryId: appended.entryId,
          communityId: body.communityId,
          evidenceKind: body.evidenceKind,
          evidenceRef: body.evidenceRef,
          amountCents: String(body.amountCents),
        })
        // Payment can qualify a team whose three seats were filled earlier.
        // No second transaction: receipt + three coupons commit or roll back together.
        const attributedOrder = tx.select({
          sourceActivityId: localOrders.sourceActivityId,
          sourceTeamId: localOrders.sourceTeamId,
        }).from(localOrders).where(eq(localOrders.id, body.orderId)).get()
        if (attributedOrder?.sourceActivityId && attributedOrder.sourceTeamId) {
          tryIssueEligibleTeamCoupons(tx, attributedOrder.sourceActivityId, attributedOrder.sourceTeamId, now)
        }
      }
      insertAudit(tx, actor.userId, 'ledger.payment.recorded', appended.entryId, now, {
        communityId: body.communityId,
        amountCents: String(body.amountCents),
        evidenceKind: body.evidenceKind,
        evidenceRef: body.evidenceRef,
        staffId: body.staffId,
        receivedAt: body.receivedAt,
      })
      return appended.entryId
    },
    { behavior: 'immediate' },
  )

  const row = readEntryRow(db, entryId)
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '流水条目不存在')
  return toDto(row)
}

/**
 * Reverses one receipt by appending a `payment_reversed` row.
 *
 * The original row is never touched (it cannot be), so both the receipt and its
 * reversal stay visible and the net is arithmetic the reader can redo:
 * `sum(payment_received) - sum(payment_reversed)`. Reversing an already reversed
 * receipt, or one that is not a receipt at all, is refused instead of silently
 * producing a negative number somewhere.
 */
export function reversePayment(
  db: AppDatabase,
  actor: LedgerActor,
  entryId: string,
  input: ReversePaymentRequest = {},
  options: { now?: Date } = {},
): LedgerEntry {
  const parsed = reversePaymentRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '冲正参数不正确')
  }
  const body = parsed.data
  const now = options.now ?? new Date()
  const reversedAt = body.reversedAt ? new Date(body.reversedAt) : now
  if (Number.isNaN(reversedAt.getTime())) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '冲正时间不是合法时间')
  }

  const newEntryId = db.transaction(
    (tx): string => {
      const original = tx.select().from(ledgerEntries).where(eq(ledgerEntries.id, entryId)).get()
      if (!original) {
        throw new LocalError(404, API_ERROR_CODES.notFound, '流水条目不存在')
      }
      assertCommunityAccess(db, actor, original.communityId)
      if (original.factKind !== 'payment_received') {
        throw new LocalError(
          409,
          API_ERROR_CODES.ledgerEntryImmutable,
          '只有人工收款记录可以冲正',
        )
      }
      const already = tx
        .select({ id: ledgerEntries.id })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.factKind, 'payment_reversed'),
            eq(ledgerEntries.counterEntryId, entryId),
          ),
        )
        .get()
      if (already) {
        throw new LocalError(
          409,
          API_ERROR_CODES.ledgerEntryImmutable,
          '该收款已冲正，不能重复冲正',
        )
      }
      const staffId = body.staffId ?? actor.staffId
      if (!staffId) {
        throw new LocalError(
          400,
          API_ERROR_CODES.ledgerPaymentEvidenceRequired,
          '冲正必须记录经办人员',
        )
      }
      requireActiveStaff(tx, staffId, original.communityId)
      const evidenceRef = body.evidenceRef ?? original.evidenceRef
      if (!evidenceRef) {
        throw new LocalError(
          400,
          API_ERROR_CODES.ledgerPaymentEvidenceRequired,
          '冲正必须带凭据引用',
        )
      }
      const appended = appendFact(tx, {
        factKind: 'payment_reversed',
        sourceSystem: 'manual',
        sourceId: `reverse:${entryId}`,
        sourceDisplayNo: original.sourceDisplayNo,
        communityId: original.communityId,
        productId: original.productId,
        attributedStaffId: original.attributedStaffId,
        attributionState: original.attributionState,
        attributionBasis: original.attributionBasis,
        // Full reversal only: a partial one would need a rule this MVP does not have.
        amountCents: original.amountCents,
        occurredAt: reversedAt,
        verifiedAt: null,
        recordedByUserId: actor.userId,
        recordedByStaffId: staffId,
        counterEntryId: entryId,
        evidenceKind: body.evidenceKind ?? (original.evidenceKind === 'none' ? 'manual_receipt' : original.evidenceKind),
        evidenceRef,
        createdAt: now,
      })
      insertAudit(tx, actor.userId, 'ledger.payment.reversed', appended.entryId, now, {
        communityId: original.communityId,
        counterEntryId: entryId,
        amountCents: String(original.amountCents),
        staffId,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      })
      return appended.entryId
    },
    { behavior: 'immediate' },
  )

  const row = readEntryRow(db, newEntryId)
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '流水条目不存在')
  return toDto(row)
}

/* -------------------------------------------------------------------------- */
/* Attribution                                                                */
/* -------------------------------------------------------------------------- */

/** `EXISTS`-style check: does this fact already carry a confirmation record? */
function confirmedAttributionOf(
  db: AppDatabase,
  entryId: string,
): { staffId: string } | null {
  const row = db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.event, LEDGER_ATTRIBUTION_CONFIRMED_EVENT),
        eq(auditLogs.targetId, entryId),
      ),
    )
    .orderBy(sql`${auditLogs.createdAt} DESC`, sql`${auditLogs.id} DESC`)
    .get()
  if (!row?.metadata) return null
  try {
    const parsed = JSON.parse(row.metadata) as { staffId?: unknown }
    return typeof parsed.staffId === 'string' ? { staffId: parsed.staffId } : null
  } catch {
    return null
  }
}

/**
 * Confirms who a `pending` fact belongs to.
 *
 * The fact row is immutable, so the confirmation is an **appended record** (an
 * `audit_logs` row with `event = ledger.attribution.confirmed`, `target_id = the
 * entry` and `metadata.staffId`). Reads (`toLedgerEntry`, the overview totals, the
 * `staffId` filter) layer that record on top of the stored state, which is why
 * 待归属 actually drops after a confirmation without a single UPDATE.
 *
 * Only a genuinely `pending` fact may be confirmed: confirming an already
 * attributed fact would let a second human silently re-assign someone's 业绩.
 */
export function resolveAttribution(
  db: AppDatabase,
  actor: LedgerActor,
  input: ResolveAttributionRequest,
  options: { now?: Date } = {},
): LedgerEntry {
  const parsed = resolveAttributionRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '归属确认参数不正确')
  }
  const body = parsed.data
  const now = options.now ?? new Date()

  db.transaction(
    (tx) => {
      const row = readEntryRow(db, body.entryId)
      if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '流水条目不存在')
      assertCommunityAccess(db, actor, row.communityId)

      const orderLink = tx.select({ orderId: ledgerPaymentOrderLinks.orderId })
        .from(ledgerPaymentOrderLinks)
        .where(eq(ledgerPaymentOrderLinks.entryId, body.entryId)).get()
      if (orderLink) {
        if (!body.note || body.note.trim().length < 2) {
          throw new LocalError(400, API_ERROR_CODES.invalidRequest,
            '确认订单收款业绩归属必须填写核验依据')
        }
        const reversed = tx.select({ id: ledgerEntries.id }).from(ledgerEntries)
          .where(and(eq(ledgerEntries.factKind, 'payment_reversed'),
            eq(ledgerEntries.counterEntryId, body.entryId))).get()
        if (reversed) {
          throw new LocalError(409, API_ERROR_CODES.conflict,
            '收款已经冲正，不能再确认业绩归属')
        }
      }

      if (row.attributionState === 'attributed') {
        throw new LocalError(
          409,
          API_ERROR_CODES.ledgerAttributionUnresolved,
          '该流水来源已明确归属，无需确认',
        )
      }
      const confirmed = confirmedAttributionOf(db, body.entryId)
      if (confirmed) {
        throw new LocalError(409, API_ERROR_CODES.conflict, '该流水已确认归属，不能重复确认')
      }
      // A locked statement's ownership is part of its frozen, exportable truth.
      // The fact may be late-recorded for an old period; only facts existing at
      // the lock instant are members and are forbidden from later reassignment.
      const businessDay = toShanghaiBusinessDate(row.occurredAt)
      const frozenMember = tx.select({ id: reconciliationBatches.id })
        .from(reconciliationBatches)
        .where(and(
          eq(reconciliationBatches.status, 'locked'),
          lte(reconciliationBatches.periodFrom, businessDay),
          gte(reconciliationBatches.periodTo, businessDay),
          gte(reconciliationBatches.lockedAt, row.createdAt),
        ))
        .get()
      if (frozenMember) {
        throw new LocalError(409, API_ERROR_CODES.ledgerBatchLocked,
          '该流水已纳入锁定对账批次，归属不可事后更改')
      }

      requireActiveStaff(tx, body.staffId, row.communityId)
      if (orderLink) {
        const assigned = tx.select({ role: staffAccounts.role }).from(staffAccounts)
          .where(eq(staffAccounts.id, body.staffId)).get()
        if (assigned?.role !== 'grid_worker') {
          throw new LocalError(400, API_ERROR_CODES.invalidRequest,
            '本地订单推广业绩只能确认给具备社区授权的网格员')
        }
      }

      insertAudit(tx, actor.userId, LEDGER_ATTRIBUTION_CONFIRMED_EVENT, body.entryId, now, {
        staffId: body.staffId,
        communityId: row.communityId,
        previousState: row.attributionState,
        previousBasis: row.attributionBasis,
        ...(body.note === undefined ? {} : { note: body.note }),
      })
    },
    { behavior: 'immediate' },
  )

  const row = readEntryRow(db, body.entryId)
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '流水条目不存在')
  return toDto(row)
}

/* -------------------------------------------------------------------------- */
/* Anomalies                                                                  */
/* -------------------------------------------------------------------------- */

function toAnomalyDto(row: {
  id: string
  entryId: string
  kind: string
  severity: string
  note: string | null
  flaggedByUserId: string | null
  resolvedAt: Date | null
  createdAt: Date
}): z.infer<typeof ledgerAnomalySchema> {
  return ledgerAnomalySchema.parse({
    anomalyId: row.id,
    entryId: row.entryId,
    kind: row.kind,
    severity: row.severity,
    note: row.note,
    flaggedByUserId: row.flaggedByUserId,
    resolvedAt: row.resolvedAt === null ? null : iso(row.resolvedAt),
    createdAt: iso(row.createdAt),
  })
}

/**
 * Appends an anomaly flag against one fact.
 *
 * Repeated flags are allowed on purpose: two people noticing the same mismatch is
 * history worth keeping, and the inbox already shows the count. Nothing here can
 * delete an anomaly — migration 0010 refuses the DELETE.
 */
export function flagAnomaly(
  db: AppDatabase,
  actor: LedgerActor,
  input: FlagAnomalyRequest,
  options: { now?: Date } = {},
): z.infer<typeof ledgerAnomalySchema> {
  const parsed = flagAnomalyRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '异常标记参数不正确')
  }
  const body = parsed.data
  const now = options.now ?? new Date()

  const anomalyId = db.transaction(
    (tx): string => {
      const row = readEntryRow(db, body.entryId)
      if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '流水条目不存在')
      assertCommunityAccess(db, actor, row.communityId)
      const id = randomUUID()
      tx.insert(ledgerAnomalies)
        .values({
          id,
          entryId: body.entryId,
          kind: body.kind,
          severity: body.severity,
          note: body.note ?? null,
          flaggedByUserId: actor.userId,
          resolvedAt: null,
          createdAt: now,
        })
        .run()
      insertAudit(tx, actor.userId, 'ledger.anomaly.flagged', body.entryId, now, {
        anomalyId: id,
        kind: body.kind,
        severity: body.severity,
      })
      return id
    },
    { behavior: 'immediate' },
  )

  const row = db.select().from(ledgerAnomalies).where(eq(ledgerAnomalies.id, anomalyId)).get()
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '异常记录不存在')
  return toAnomalyDto(row)
}

/**
 * The anomaly inbox, optionally narrowed to one fact or one reconciliation batch.
 *
 * A batch filter uses the *same* membership rule as the statement
 * (`reconciliation-service.membershipConditions`): the facts of the batch period,
 * and — for a locked batch — only those that existed at the lock instant. An
 * anomaly of a fact that arrived after the statement was frozen belongs to the
 * next statement, not to this one.
 */
export function listAnomalies(
  db: AppDatabase,
  actor: LedgerActor,
  query: ListAnomaliesQuery = { includeResolved: false },
  options: { now?: Date } = {},
): LedgerAnomalyListResponse {
  const asOf = (options.now ?? new Date()).toISOString()
  const conditions: SQL<unknown>[] = []
  const scope = scopeCommunityIds(db, actor)
  if (scope !== null) {
    if (scope.length === 0) return { items: [], asOf }
    conditions.push(inArray(ledgerEntries.communityId, scope))
  }
  if (!query.includeResolved) conditions.push(sql`${ledgerAnomalies.resolvedAt} IS NULL`)
  if (query.entryId) conditions.push(eq(ledgerAnomalies.entryId, query.entryId))
  if (query.batchId) {
    const batch = db
      .select()
      .from(reconciliationBatches)
      .where(eq(reconciliationBatches.id, query.batchId))
      .get()
    if (!batch) throw new LocalError(404, API_ERROR_CODES.notFound, '对账批次不存在')
    conditions.push(
      ...membershipConditions(batch.periodFrom, batch.periodTo, cutoffMsOf(batch)),
    )
  }

  const rows = db
    .select({
      id: ledgerAnomalies.id,
      entryId: ledgerAnomalies.entryId,
      kind: ledgerAnomalies.kind,
      severity: ledgerAnomalies.severity,
      note: ledgerAnomalies.note,
      flaggedByUserId: ledgerAnomalies.flaggedByUserId,
      resolvedAt: ledgerAnomalies.resolvedAt,
      createdAt: ledgerAnomalies.createdAt,
    })
    .from(ledgerAnomalies)
    .innerJoin(ledgerEntries, eq(ledgerAnomalies.entryId, ledgerEntries.id))
    .where(combine(conditions))
    .orderBy(sql`${ledgerAnomalies.createdAt} DESC`, sql`${ledgerAnomalies.id} DESC`)
    .limit(200)
    .all()

  return { items: rows.map(toAnomalyDto), asOf }
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** One fact by id, community-scoped. */
export function getLedgerEntry(db: AppDatabase, actor: LedgerActor, entryId: string): LedgerEntry {
  return toDto(requireEntryRow(db, actor, entryId))
}

/**
 * The audit trail of the ledger writes, newest first.
 *
 * Exposed for the evidence bundle and for tests: a fact's history (who confirmed
 * what, who reversed what) lives here, because the fact row itself never changes.
 */
export function listLedgerAuditEvents(
  db: AppDatabase,
  entryId: string,
): Array<{ event: string; actorUserId: string | null; metadata: string | null; createdAt: string }> {
  return db
    .select({
      event: auditLogs.event,
      actorUserId: auditLogs.actorUserId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(eq(auditLogs.targetId, entryId))
    .orderBy(sql`${auditLogs.createdAt} ASC`, sql`${auditLogs.id} ASC`)
    .all()
    .map((row) => ({
      event: row.event,
      actorUserId: row.actorUserId,
      metadata: row.metadata,
      createdAt: iso(row.createdAt),
    }))
}
