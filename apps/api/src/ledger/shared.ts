import { eq, gte, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import {
  LEDGER_FACT_KINDS,
  LEDGER_TIME_ZONE,
  ledgerEntrySchema,
  type LedgerEntry,
  type LedgerFactKind,
  type LedgerListQuery,
  type LedgerOverview,
  type LedgerOverviewQuery,
  type SettlementAmountStatus,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  ledgerAnomalies,
  ledgerEntries,
  reconciliationBatches,
} from '../db/schema.js'
import {
  applyCommunityScope,
  assertCommunityAccess,
  combine,
  escapedLike,
  iso,
  scopeCommunityIds,
  type LocalActor,
} from '../local/shared.js'

/**
 * Shared building blocks of the ledger domain (LL-MVP-008, Issue #64).
 *
 * The authentication/scope primitives are **re-used** from `local/shared.ts` on
 * purpose: a second copy of `scopeCommunityIds` / `assertCommunityAccess` is
 * exactly how two endpoints end up disagreeing about who may read which money.
 * This module only adds what is genuinely ledger-specific:
 *
 * - business-date handling (Asia/Shanghai, no DST, inclusive days);
 * - row -> DTO mapping with the derived reconciliation state;
 * - the read-only overview/list/anomaly queries of the route skeleton.
 *
 * There is deliberately **no** settlement math here: this MVP has no settlement
 * rule, so `settlementAmountStatus` is always `pending_rule` and no payable
 * amount is ever derived from the recorded facts.
 */

/** Caller identity of the ledger surfaces; identical shape to the local domain. */
export type LedgerActor = LocalActor

/**
 * Re-exported so the ledger service and its routes import every scope helper
 * from one place while the implementation stays single-sourced.
 */
export {
  LocalError,
  assertCommunityAccess,
  assertExpectedUpdatedAt,
  combine,
  escapedLike,
  insertAudit,
  iso,
  isoOrNull,
  nextUpdatedAt,
  scopeCommunityIds,
  type LocalTransaction,
} from '../local/shared.js'

/* -------------------------------------------------------------------------- */
/* Business dates (Asia/Shanghai)                                             */
/* -------------------------------------------------------------------------- */

/** China has a single UTC+08:00 offset and no DST, so a fixed offset is exact. */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Start of a business day (`YYYY-MM-DD`) as an epoch millisecond, interpreted in
 * Asia/Shanghai. A ledger period is a human business day, never a UTC day: a
 * receipt recorded at 2026-11-07 01:30 +08:00 belongs to 2026-11-07, not to the
 * UTC date 2026-11-06.
 */
export function shanghaiDayStartMs(businessDate: string): number {
  if (!BUSINESS_DATE_PATTERN.test(businessDate)) {
    throw new Error(`invalid business date: ${businessDate}`)
  }
  const start = Date.parse(`${businessDate}T00:00:00.000+08:00`)
  if (Number.isNaN(start)) throw new Error(`invalid business date: ${businessDate}`)
  return start
}

/** Start of the *next* shanghai business day, i.e. the exclusive end bound. */
export function shanghaiDayEndExclusiveMs(businessDate: string): number {
  return shanghaiDayStartMs(businessDate) + DAY_MS
}

/** The Asia/Shanghai business date a given instant belongs to. */
export function toShanghaiBusinessDate(at: Date): string {
  return new Date(at.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * Half-open `[start, end)` range for the inclusive business-date bounds of a
 * list query. A missing bound is unbounded on that side.
 */
export function ledgerOccurredRange(query: Pick<LedgerListQuery, 'from' | 'to'>): {
  startMs: number | null
  endMs: number | null
} {
  return {
    startMs: query.from ? shanghaiDayStartMs(query.from) : null,
    endMs: query.to ? shanghaiDayEndExclusiveMs(query.to) : null,
  }
}

/* -------------------------------------------------------------------------- */
/* Community scoping                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Scope conditions of the ledger. `false` means the caller has no community at
 * all, so the caller must answer with an empty page instead of every row.
 */
export function ledgerScopeConditions(
  db: AppDatabase,
  actor: LedgerActor,
  conditions: SQL<unknown>[] = [],
): boolean {
  return applyCommunityScope(scopeCommunityIds(db, actor), ledgerEntries.communityId, conditions)
}

/* -------------------------------------------------------------------------- */
/* Row -> DTO                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The audit event that records an attribution confirmation.
 *
 * `ledger_entries` is UPDATE-blocked on disk (migration 0010), so confirming the
 * attribution of a fact can never rewrite the fact. The confirmation is a new,
 * append-only record instead — an `audit_logs` row naming the entry — and every
 * read derives the *current* attribution from it (`pending` -> `attributed`).
 * That is why 待归属 drops after a confirmation without a single `UPDATE`.
 */
export const LEDGER_ATTRIBUTION_CONFIRMED_EVENT = 'ledger.attribution.confirmed'

/*
 * ---------------------------------------------------------------------------
 * Derived columns (never stored)
 * ---------------------------------------------------------------------------
 *
 * Two things a fact must never carry in its own row, because the row is
 * append-only and a later statement would move:
 *
 * 1. **Reconciliation membership.** `ledger_entries.batch_id` is never written
 *    (migration 0010 blocks UPDATE, and nothing stamps it at INSERT), so reading
 *    it would render every fact `unreconciled` forever while the batch page —
 *    which derives membership from the period — calls the same fact `reconciled`.
 *    The subqueries below apply the *identical* rule
 *    `reconciliation-service.ts` uses: `occurred_at` inside the inclusive
 *    `Asia/Shanghai` business-day period, and — for a locked statement — only
 *    facts that existed at the lock instant (`created_at <= locked_at`). A
 *    `locked` batch wins over an `open` one when both cover the day, exactly like
 *    a frozen statement wins over a draft.
 * 2. **A confirmed attribution.** Confirming attribution appends a record (see
 *    `LEDGER_ATTRIBUTION_CONFIRMED_EVENT`); the current attribution is the stored
 *    state *plus* that record. Both the DTO and the overview read it from here,
 *    so 待归属 can drop without any UPDATE.
 *
 * Both are SQL columns, not per-row queries: one statement, no N+1.
 */
const LEDGER_DERIVED_BATCH_ID = sql<string | null>`(
    SELECT b.id
    FROM reconciliation_batches b
    WHERE date(ledger_entries.occurred_at / 1000, 'unixepoch', '+8 hours')
          BETWEEN b.period_from AND b.period_to
      AND (b.status = 'open' OR ledger_entries.created_at <= b.locked_at)
    ORDER BY CASE b.status WHEN 'locked' THEN 0 ELSE 1 END,
             b.period_from DESC,
             b.batch_no DESC
    LIMIT 1
  )`

const LEDGER_DERIVED_BATCH_STATUS = sql<'open' | 'locked' | null>`(
    SELECT b.status
    FROM reconciliation_batches b
    WHERE date(ledger_entries.occurred_at / 1000, 'unixepoch', '+8 hours')
          BETWEEN b.period_from AND b.period_to
      AND (b.status = 'open' OR ledger_entries.created_at <= b.locked_at)
    ORDER BY CASE b.status WHEN 'locked' THEN 0 ELSE 1 END,
             b.period_from DESC,
             b.batch_no DESC
    LIMIT 1
  )`

/** `EXISTS`: this fact has an attribution confirmation record. */
const LEDGER_ATTRIBUTION_IS_CONFIRMED = sql<number>`EXISTS (
    SELECT 1 FROM audit_logs a
    WHERE a.event = ${LEDGER_ATTRIBUTION_CONFIRMED_EVENT}
      AND a.target_id = ledger_entries.id
  )`

/** The staff member named by the newest attribution confirmation, if any. */
const LEDGER_CONFIRMED_STAFF_ID = sql<string | null>`(
    SELECT json_extract(a.metadata, '$.staffId')
    FROM audit_logs a
    WHERE a.event = ${LEDGER_ATTRIBUTION_CONFIRMED_EVENT}
      AND a.target_id = ledger_entries.id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 1
  )`

/** One ledger row joined with its batch status (for the derived state). */
export interface LedgerEntryRow {
  id: string
  factKind: LedgerFactKind
  sourceSystem: LedgerEntry['sourceSystem']
  sourceId: string
  sourceDisplayNo: string
  communityId: string
  productId: string | null
  attributedStaffId: string | null
  attributionState: LedgerEntry['attribution']['state']
  attributionBasis: LedgerEntry['attribution']['basis']
  amountCents: number
  settlementAmountStatus: SettlementAmountStatus
  occurredAt: Date
  verifiedAt: Date | null
  recordedByUserId: string | null
  recordedByStaffId: string | null
  counterEntryId: string | null
  evidenceRef: string | null
  evidenceKind: LedgerEntry['evidence']['kind']
  batchId: string | null
  batchStatus: 'open' | 'locked' | null
  /** Staff member of the newest attribution confirmation; `null` when unconfirmed. */
  confirmedAttributedStaffId?: string | null
  createdAt: Date
}

/** Batch identity a caller already knows (e.g. the statement a row was read for). */
export interface LedgerEntryBatchIdentity {
  batchId: string | null
  batchStatus: 'open' | 'locked' | null
}

/**
 * Map one stored fact to its DTO.
 *
 * Two fields are **derived**, never read verbatim off the immutable row:
 *
 * - `reconciliationState`: `reconciled` only when the covering batch is locked
 *   (locking freezes the statement), `batched` while it is open,
 *   `unreconciled` when no batch covers the fact. `batchId` is non-null exactly
 *   when the state is not `unreconciled` — the contract refinement
 *   (`ledgerEntrySchema`) fails the response otherwise, which is intentional:
 *   a half-derived pair would render a fact as belonging to no statement while
 *   naming one.
 * - `attribution`: a confirmation record on top of the stored state. The stored
 *   row may say `pending` forever (it is append-only); once a confirmation
 *   exists the fact reads `attributed` with the confirmed staff member, and the
 *   overview's 待归属 drops accordingly.
 *
 * `derived` lets a caller that already *knows* the batch identity (the statement
 * reader, which received the batch from `getBatchEntries`) inject it instead of
 * re-deriving it, so both pages cannot disagree. When it is omitted the row's own
 * derived columns are used.
 */
export function toLedgerEntry(
  row: LedgerEntryRow,
  derived?: LedgerEntryBatchIdentity,
): LedgerEntry {
  const batchId = derived ? derived.batchId : row.batchId
  const batchStatus = derived ? derived.batchStatus : row.batchStatus
  const reconciliationState: LedgerEntry['reconciliationState'] =
    batchId === null || batchStatus === null
      ? 'unreconciled'
      : batchStatus === 'locked'
        ? 'reconciled'
        : 'batched'

  const confirmedStaffId = row.confirmedAttributedStaffId ?? null
  const attributed = confirmedStaffId !== null
  const attributionState: LedgerEntry['attribution']['state'] = attributed
    ? 'attributed'
    : row.attributionState
  const attributedStaffId = attributed ? confirmedStaffId : row.attributedStaffId
  // A confirmation is an explicit human decision about *this* fact, so it records
  // the confirmed basis; the stored basis keeps explaining why it needed one.
  const attributionBasis: LedgerEntry['attribution']['basis'] = attributed
    ? 'explicit_attribution'
    : row.attributionBasis

  return ledgerEntrySchema.parse({
    entryId: row.id,
    factKind: row.factKind,
    sourceSystem: row.sourceSystem,
    sourceId: row.sourceId,
    sourceDisplayNo: row.sourceDisplayNo,
    communityId: row.communityId,
    productId: row.productId,
    occurredAt: iso(row.occurredAt),
    verifiedAt: row.verifiedAt === null ? null : iso(row.verifiedAt),
    amountCents: row.amountCents,
    settlementAmountStatus: row.settlementAmountStatus,
    attribution: {
      state: attributionState,
      staffId: attributedStaffId,
      communityId: row.communityId,
      basis: attributionBasis,
    },
    evidence: { kind: row.evidenceKind, ref: row.evidenceRef },
    counterEntryId: row.counterEntryId,
    batchId: reconciliationState === 'unreconciled' ? null : batchId,
    reconciliationState,
    recordedByUserId: row.recordedByUserId,
    recordedByStaffId: row.recordedByStaffId,
    createdAt: iso(row.createdAt),
  })
}

/** The generic row selection used by the list query. */
export const ledgerEntrySelection = {
  id: ledgerEntries.id,
  factKind: ledgerEntries.factKind,
  sourceSystem: ledgerEntries.sourceSystem,
  sourceId: ledgerEntries.sourceId,
  sourceDisplayNo: ledgerEntries.sourceDisplayNo,
  communityId: ledgerEntries.communityId,
  productId: ledgerEntries.productId,
  attributedStaffId: ledgerEntries.attributedStaffId,
  attributionState: ledgerEntries.attributionState,
  attributionBasis: ledgerEntries.attributionBasis,
  amountCents: ledgerEntries.amountCents,
  settlementAmountStatus: ledgerEntries.settlementAmountStatus,
  occurredAt: ledgerEntries.occurredAt,
  verifiedAt: ledgerEntries.verifiedAt,
  recordedByUserId: ledgerEntries.recordedByUserId,
  recordedByStaffId: ledgerEntries.recordedByStaffId,
  counterEntryId: ledgerEntries.counterEntryId,
  evidenceRef: ledgerEntries.evidenceRef,
  evidenceKind: ledgerEntries.evidenceKind,
  /**
   * Derived, never the stored `ledger_entries.batch_id` (which nothing writes).
   * `confirmedAttributedStaffId` is the staff member of the newest attribution
   * confirmation record, or `null` when the fact has none.
   */
  batchId: LEDGER_DERIVED_BATCH_ID,
  batchStatus: LEDGER_DERIVED_BATCH_STATUS,
  confirmedAttributedStaffId: LEDGER_CONFIRMED_STAFF_ID,
  createdAt: ledgerEntries.createdAt,
}

/* -------------------------------------------------------------------------- */
/* Read queries (the route skeleton)                                          */
/* -------------------------------------------------------------------------- */

/**
 * The empty overview. Used when the caller has no community scope at all, so no
 * query is issued; the shape is still a fully valid report with a real `asOf`.
 */
export function emptyLedgerOverview(asOf: string): LedgerOverview {
  const buckets = LEDGER_FACT_KINDS.map((factKind) => ({
    factKind,
    entryCount: 0,
    grossAmountCents: 0,
  }))
  return {
    asOf,
    timeZone: LEDGER_TIME_ZONE,
    amountStatus: 'pending_rule',
    buckets,
    totals: { entryCount: 0, grossAmountCents: 0 },
    attributed: { entryCount: 0, amountCents: 0 },
    pendingAttribution: { entryCount: 0, amountCents: 0 },
    openAnomalies: { count: 0 },
    payment: { receivedCents: 0, reversedCents: 0 },
    reward: { costCents: 0, reversedCents: 0 },
  }
}

function scopedWhere(db: AppDatabase, actor: LedgerActor): SQL<unknown>[] | null {
  const conditions: SQL<unknown>[] = []
  if (!ledgerScopeConditions(db, actor, conditions)) return null
  return conditions
}

/** The narrowings the overview and the list share: scope, business-date range, community, staff. */
type LedgerSharedFilters = Pick<LedgerOverviewQuery, 'from' | 'to' | 'communityId' | 'staffId'>

/**
 * Scope + shared narrowings.
 *
 * The overview and the list must answer over the **same population**: an overview
 * that reports a whole community while `?from=…` only narrows the list would make
 * the two halves of one screen contradict each other. `null` means "this caller
 * has no community at all", so the caller answers with an empty (but valid) page.
 */
function scopeAndFilterConditions(
  db: AppDatabase,
  actor: LedgerActor,
  filters: LedgerSharedFilters,
): SQL<unknown>[] | null {
  const conditions = scopedWhere(db, actor)
  if (conditions === null) return null

  const range = ledgerOccurredRange(filters)
  if (range.startMs !== null) {
    conditions.push(gte(ledgerEntries.occurredAt, new Date(range.startMs)))
  }
  if (range.endMs !== null) {
    conditions.push(lt(ledgerEntries.occurredAt, new Date(range.endMs)))
  }
  if (filters.communityId) {
    // Same rule as the CRM list: asking for a community outside your scope is a
    // 403, not a silently empty page. The scope condition is still applied, so a
    // forged id can never widen what the caller may read.
    assertCommunityAccess(db, actor, filters.communityId)
    conditions.push(eq(ledgerEntries.communityId, filters.communityId))
  }
  if (filters.staffId) {
    // Attribution filter, never the recorder: 记录人不是业绩归属. A confirmed
    // fact belongs to the confirmed staff member even though its immutable row
    // still stores `pending`, so the filter reads the same derived truth the
    // totals and the DTO read.
    const byAttribution = or(
      eq(ledgerEntries.attributedStaffId, filters.staffId),
      sql`${LEDGER_CONFIRMED_STAFF_ID} = ${filters.staffId}`,
    )
    if (byAttribution) conditions.push(byAttribution)
  }
  return conditions
}

/**
 * Aggregate overview of the caller's communities.
 *
 * Every bucket is reported separately — `payment_received` and
 * `payment_reversed` are never netted, and `order_registered` (登记金额) is never
 * presented as money received. `asOf` is the instant this report was computed.
 */
export function getLedgerOverview(
  db: AppDatabase,
  actor: LedgerActor,
  now: Date,
  filters: LedgerSharedFilters = {},
): LedgerOverview {
  const asOf = now.toISOString()
  const conditions = scopeAndFilterConditions(db, actor, filters)
  if (conditions === null) return emptyLedgerOverview(asOf)

  const where = combine(conditions)
  const bucketRows = db
    .select({
      factKind: ledgerEntries.factKind,
      entryCount: sql<number>`count(*)`,
      grossAmountCents: sql<number>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
    })
    .from(ledgerEntries)
    .where(where)
    .groupBy(ledgerEntries.factKind)
    .all()

  const bucketMap = new Map(bucketRows.map((row) => [row.factKind, row]))
  const buckets = LEDGER_FACT_KINDS.map((factKind) => {
    const row = bucketMap.get(factKind)
    return {
      factKind,
      entryCount: Number(row?.entryCount ?? 0),
      grossAmountCents: Number(row?.grossAmountCents ?? 0),
    }
  })
  const bucketOf = (kind: LedgerFactKind) =>
    buckets.find((bucket) => bucket.factKind === kind)?.grossAmountCents ?? 0

  // 归属合计 counts the *current* attribution: a fact stored as `pending` that
  // has since been confirmed by a human belongs to 已归属, not to 待归属. The
  // stored state can never change (append-only), so the confirmation record is
  // what moves the money between the two totals.
  const attributionRow = db
    .select({
      attributedCount: sql<number>`coalesce(sum(CASE WHEN ${ledgerEntries.attributionState} = 'attributed' OR ${LEDGER_ATTRIBUTION_IS_CONFIRMED} THEN 1 ELSE 0 END), 0)`,
      attributedAmount: sql<number>`coalesce(sum(CASE WHEN ${ledgerEntries.attributionState} = 'attributed' OR ${LEDGER_ATTRIBUTION_IS_CONFIRMED} THEN ${ledgerEntries.amountCents} ELSE 0 END), 0)`,
      pendingCount: sql<number>`coalesce(sum(CASE WHEN ${ledgerEntries.attributionState} = 'pending' AND NOT ${LEDGER_ATTRIBUTION_IS_CONFIRMED} THEN 1 ELSE 0 END), 0)`,
      pendingAmount: sql<number>`coalesce(sum(CASE WHEN ${ledgerEntries.attributionState} = 'pending' AND NOT ${LEDGER_ATTRIBUTION_IS_CONFIRMED} THEN ${ledgerEntries.amountCents} ELSE 0 END), 0)`,
    })
    .from(ledgerEntries)
    .where(where)
    .get()

  // Same narrowings as the report itself: an anomaly of a fact outside the
  // selected slice must not be counted into that slice's open-anomaly badge.
  const anomalyConditions: SQL<unknown>[] =
    scopeAndFilterConditions(db, actor, filters) ?? []
  anomalyConditions.push(isNull(ledgerAnomalies.resolvedAt))
  const anomalyRow = db
    .select({ value: sql<number>`count(*)` })
    .from(ledgerAnomalies)
    .innerJoin(ledgerEntries, eq(ledgerAnomalies.entryId, ledgerEntries.id))
    .where(combine(anomalyConditions))
    .get()

  const totals = buckets.reduce(
    (accumulator, bucket) => ({
      entryCount: accumulator.entryCount + bucket.entryCount,
      grossAmountCents: accumulator.grossAmountCents + bucket.grossAmountCents,
    }),
    { entryCount: 0, grossAmountCents: 0 },
  )

  return {
    asOf,
    timeZone: LEDGER_TIME_ZONE,
    amountStatus: 'pending_rule',
    buckets,
    totals,
    attributed: {
      entryCount: Number(attributionRow?.attributedCount ?? 0),
      amountCents: Number(attributionRow?.attributedAmount ?? 0),
    },
    pendingAttribution: {
      entryCount: Number(attributionRow?.pendingCount ?? 0),
      amountCents: Number(attributionRow?.pendingAmount ?? 0),
    },
    openAnomalies: { count: Number(anomalyRow?.value ?? 0) },
    payment: {
      receivedCents: bucketOf('payment_received'),
      reversedCents: bucketOf('payment_reversed'),
    },
    reward: { costCents: bucketOf('reward_cost'), reversedCents: bucketOf('reward_reversed') },
  }
}

/** `EXISTS` predicate: the entry has at least one unresolved anomaly. */
function hasOpenAnomaly(): SQL<unknown> {
  return sql`EXISTS (
    SELECT 1 FROM ${ledgerAnomalies}
    WHERE ${ledgerAnomalies.entryId} = ${ledgerEntries.id}
      AND ${ledgerAnomalies.resolvedAt} IS NULL
  )`
}

function listConditions(
  db: AppDatabase,
  actor: LedgerActor,
  query: LedgerListQuery,
): SQL<unknown>[] | null {
  const conditions = scopeAndFilterConditions(db, actor, query)
  if (conditions === null) return null

  if (query.factKind) conditions.push(eq(ledgerEntries.factKind, query.factKind))
  if (query.sourceSystem) conditions.push(eq(ledgerEntries.sourceSystem, query.sourceSystem))
  if (query.productId) conditions.push(eq(ledgerEntries.productId, query.productId))
  if (query.keyword) {
    const pattern = escapedLike(query.keyword)
    const keyword = or(
      sql`${ledgerEntries.sourceDisplayNo} LIKE ${pattern} ESCAPE '\\'`,
      sql`${ledgerEntries.sourceId} LIKE ${pattern} ESCAPE '\\'`,
    )
    if (keyword) conditions.push(keyword)
  }
  if (query.anomalyOnly) conditions.push(hasOpenAnomaly())
  return conditions
}

/**
 * Paginated, community-scoped fact list. `total` counts the same predicate as
 * `items`, so "共 N 条" can never disagree with what the operator sees.
 */
export function listLedgerEntries(
  db: AppDatabase,
  actor: LedgerActor,
  query: LedgerListQuery,
  now: Date,
): { items: LedgerEntry[]; total: number; page: number; pageSize: number; asOf: string } {
  const asOf = now.toISOString()
  const conditions = listConditions(db, actor, query)
  if (conditions === null) {
    return { items: [], total: 0, page: query.page, pageSize: query.pageSize, asOf }
  }
  const where = combine(conditions)

  const totalRow = db
    .select({ value: sql<number>`count(*)` })
    .from(ledgerEntries)
    .where(where)
    .get()

  const rows = db
    .select(ledgerEntrySelection)
    .from(ledgerEntries)
    .where(where)
    .orderBy(sql`${ledgerEntries.occurredAt} DESC`, sql`${ledgerEntries.createdAt} DESC`, sql`${ledgerEntries.id} DESC`)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all()

  return {
    items: rows.map((row) => toLedgerEntry(row)),
    total: Number(totalRow?.value ?? 0),
    page: query.page,
    pageSize: query.pageSize,
    asOf,
  }
}

/** Unresolved anomalies of the caller's communities, newest first. */
export function listLedgerAnomalies(
  db: AppDatabase,
  actor: LedgerActor,
  now: Date,
): { items: Array<Record<string, unknown>>; asOf: string } {
  const asOf = now.toISOString()
  const conditions: SQL<unknown>[] = []
  if (!ledgerScopeConditions(db, actor, conditions)) return { items: [], asOf }
  conditions.push(isNull(ledgerAnomalies.resolvedAt))
  const rows = db
    .select({
      anomalyId: ledgerAnomalies.id,
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
    .orderBy(sql`${ledgerAnomalies.createdAt} DESC`)
    .limit(200)
    .all()

  return {
    items: rows.map((row) => ({
      anomalyId: row.anomalyId,
      entryId: row.entryId,
      kind: row.kind,
      severity: row.severity,
      note: row.note,
      flaggedByUserId: row.flaggedByUserId,
      resolvedAt: row.resolvedAt === null ? null : iso(row.resolvedAt),
      createdAt: iso(row.createdAt),
    })),
    asOf,
  }
}

/** Reconciliation batches (global periods, back-office only), newest first. */
export function listReconciliationBatches(
  db: AppDatabase,
  now: Date,
): { items: Array<Record<string, unknown>>; asOf: string } {
  const asOf = now.toISOString()
  const rows = db
    .select()
    .from(reconciliationBatches)
    .orderBy(sql`${reconciliationBatches.periodFrom} DESC`, sql`${reconciliationBatches.batchNo} DESC`)
    .limit(100)
    .all()

  return {
    items: rows.map((row) => ({
      batchId: row.id,
      batchNo: row.batchNo,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      status: row.status,
      entryCount: row.entryCount,
      totalCents: row.totalCents,
      note: row.note,
      lockedAt: row.lockedAt === null ? null : iso(row.lockedAt),
      lockedByUserId: row.lockedByUserId,
      lockedByStaffId: row.lockedByStaffId,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    })),
    asOf,
  }
}

/**
 * Anomaly entries of one fact, used by later cards. Kept here so the anomaly
 * predicate is defined once instead of being re-spelled per endpoint.
 */
export function ledgerAnomalyConditions(entryId: string): SQL<unknown> {
  return eq(ledgerAnomalies.entryId, entryId)
}
