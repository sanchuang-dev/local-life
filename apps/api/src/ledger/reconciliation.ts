import { and, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  reconciliationBatchEntriesResponseSchema,
  reconciliationDiffSchema,
  type LedgerAnomaly,
  type LedgerEntry,
  type ReconciliationBatch,
  type ReconciliationBatchEntriesResponse,
  type ReconciliationDiff,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import { ledgerAnomalies, ledgerEntries, reconciliationBatches } from '../db/schema.js'
import {
  LocalError,
  iso,
  ledgerEntrySelection,
  ledgerScopeConditions,
  toLedgerEntry,
  type LedgerActor,
} from './shared.js'
import {
  buildReconciliationCsv,
  formatShanghaiStamp,
  getBatch,
  getBatchEntries,
  getReconciliationDiff,
  reconciliationPeriodRange,
  type ReconciliationCsv,
  type ReconciliationCsvOptions,
} from './reconciliation-service.js'

/**
 * Contract adapters of the reconciliation surfaces (LL-MVP-008, Issue #64).
 *
 * `reconciliation-service.ts` is the *domain* module: it owns the membership
 * derivation, the lock semantics and the CSV text, and it returns interfaces of
 * its own so it never depends on Hono or on the HTTP response shapes. This
 * module is the thin layer that turns those results into the response DTOs of
 * `@sanchuang-dev/local-life-contracts` — the shapes the routes actually send.
 *
 * Splitting it this way keeps two guarantees:
 * 1. the HTTP layer never re-derives a number (it only re-shapes one), so the
 *    statement page, the diff and the CSV keep describing the same population;
 * 2. every JSON response still passes `schema.parse(...)` on the way out — the
 *    single non-JSON exception (the CSV file) is documented in the route module.
 *
 * Nothing here writes, except the export audit row that
 * `buildReconciliationCsv` records: batches are created and locked by the
 * service, and every read is a read.
 */

/* -------------------------------------------------------------------------- */
/* Batch entries                                                              */
/* -------------------------------------------------------------------------- */

export interface BatchEntriesQuery {
  page: number
  pageSize: number
}

/** Page-size ceiling; the echo in the response is the value that was applied. */
const BATCH_ENTRIES_MAX_PAGE_SIZE = 100

/**
 * One batch page, as `reconciliationBatchEntriesResponseSchema`.
 *
 * `items` are the **frozen members** of the batch (`occurredAt` inside the
 * period *and* `createdAt <= lockedAt`). Facts of the same period recorded after
 * the lock are **not** here on purpose — they are reported by the diff as
 * `lateRecordedCount` / `lateRecordedTotalCents` (文档 §9.2 L2), so a locked
 * statement can never silently grow and a late fact can never silently vanish.
 *
 * The page is a slice of the very statement `getBatchEntries` derived (rows,
 * order and totals all come from the same `collectEntryViews`), and each row is
 * rendered by the shared `toLedgerEntry` mapper with the batch identity injected
 * — so the batch page and the fact list can never render one entry two ways.
 */
export function batchEntriesResponse(
  db: AppDatabase,
  actor: LedgerActor,
  batchId: string,
  query: BatchEntriesQuery,
  now: Date,
): ReconciliationBatchEntriesResponse {
  const statement = getBatchEntries(db, batchId, { actor, now })
  const pageSize = Math.min(Math.max(query.pageSize, 1), BATCH_ENTRIES_MAX_PAGE_SIZE)
  const page = Math.max(query.page, 1)
  const offset = (page - 1) * pageSize
  const pageViews = statement.entries.slice(offset, offset + pageSize)

  return reconciliationBatchEntriesResponseSchema.parse({
    batchId: statement.batch.batchId,
    items: mapMembersToDtos(
      db,
      pageViews.map((view) => view.entryId),
      statement.batch,
    ),
    // `total` counts the whole statement (not the page) with the very predicate
    // `items` come from, so 「共 N 条」can never disagree with what is pageable.
    total: statement.entries.length,
    page,
    pageSize,
    asOf: statement.asOf,
  })
}

/**
 * Re-reads the statement members as `ledgerEntrySchema` rows.
 *
 * Re-reading (instead of mapping the service view) is deliberate: the service
 * view carries display-only joins, while the contract DTO is the same shape the
 * fact list returns. `toLedgerEntry` therefore stays the single mapper, and the
 * frozen batch identity is injected so its derived `reconciliationState` matches
 * the statement the row was read from.
 */
function mapMembersToDtos(
  db: AppDatabase,
  entryIds: string[],
  batch: ReconciliationBatch,
): LedgerEntry[] {
  if (entryIds.length === 0) return []
  const rows = db
    .select(ledgerEntrySelection)
    .from(ledgerEntries)
    .leftJoin(reconciliationBatches, eq(ledgerEntries.batchId, reconciliationBatches.id))
    .where(inArray(ledgerEntries.id, entryIds))
    .all()
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  return entryIds.map((entryId) => {
    const row = rowsById.get(entryId)
    // A statement member that cannot be re-read means the statement and the fact
    // table disagree; failing loudly beats rendering a quietly short page.
    if (!row) {
      throw new Error(`reconciliation member ${entryId} is missing from ledger_entries`)
    }
    return toLedgerEntry({ ...row, batchId: batch.batchId, batchStatus: batch.status })
  })
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

export interface DiffQuery {
  batchId?: string
  periodFrom?: string
  periodTo?: string
}

/**
 * Rows of the drill-down lists. The *totals* beside them are exact for the whole
 * slice, so a display cap can never turn into a wrong badge number.
 */
const DIFF_DRILLDOWN_LIMIT = 100

/**
 * The diff, as `reconciliationDiffSchema`.
 *
 * Two groups of fields are added on top of the service result, and both are
 * **drill-down detail**, never a second verdict:
 * - `unbatched*` — the facts of the period that no `locked` batch covers, i.e.
 *   the part still to be reconciled. For a `locked` batch this is empty by
 *   construction: the period *is* covered (its members are the frozen statement,
 *   its leftovers are the late-recorded facts), so reporting them again as
 *   "not reconciled" would make a locked statement look un-locked;
 * - `openAnomalies` — the unresolved anomalies of the same slice as full rows,
 *   so the page needs no second request and cannot show a count it cannot drill.
 *
 * The service's `items` remain the **conclusions** (待归属 / 未处理异常 / 跨期冲正 /
 * 合计漂移 / 锁后补录 / 空期间); the detail rows above are the raw material, and
 * flattening them into `items` would turn "how many things need a human" into
 * "how many rows exist".
 */
export function diffResponse(
  db: AppDatabase,
  actor: LedgerActor,
  query: DiffQuery,
  now: Date,
): ReconciliationDiff {
  const serviceResult = getReconciliationDiff(
    db,
    {
      ...(query.batchId === undefined ? {} : { batchId: query.batchId }),
      ...(query.periodFrom === undefined ? {} : { periodFrom: query.periodFrom }),
      ...(query.periodTo === undefined ? {} : { periodTo: query.periodTo }),
    },
    { actor, now },
  )
  const range = reconciliationPeriodRange(serviceResult.periodFrom, serviceResult.periodTo)
  const unbatched = collectUnbatched(
    db,
    actor,
    range,
    serviceResult.periodFrom,
    serviceResult.periodTo,
  )

  return reconciliationDiffSchema.parse({
    ...serviceResult,
    unbatchedCount: unbatched.count,
    unbatchedTotalCents: unbatched.totalCents,
    unbatchedEntries: unbatched.items,
    openAnomalies: collectOpenAnomalies(db, actor, range),
  })
}

/**
 * Facts of the requested period that **no `locked` batch covers**.
 *
 * Derived from the same rule as the statement: a fact is covered when its
 * `occurredAt` falls inside a `locked` batch period. Everything else inside the
 * requested period is still to be reconciled. The complement is taken over
 * *periods*, not over rows, which is exactly why a locked period yields `0` here
 * and reports its leftovers as `lateRecorded*` instead — the two numbers are
 * disjoint by construction and never describe the same fact twice.
 */
function collectUnbatched(
  db: AppDatabase,
  actor: LedgerActor,
  range: { startMs: number; endMs: number },
  periodFrom: string,
  periodTo: string,
): { count: number; totalCents: number; items: LedgerEntry[] } {
  const conditions: SQL<unknown>[] = [
    gte(ledgerEntries.occurredAt, new Date(range.startMs)),
    lt(ledgerEntries.occurredAt, new Date(range.endMs)),
  ]
  if (!ledgerScopeConditions(db, actor, conditions)) {
    return { count: 0, totalCents: 0, items: [] }
  }

  // "Not inside any locked period" is spelled as an OR of the two half-planes
  // instead of `NOT (a AND b)`, so the SQL stays index-friendly.
  for (const locked of lockedBatchesOverlapping(db, periodFrom, periodTo)) {
    const lockedRange = reconciliationPeriodRange(locked.periodFrom, locked.periodTo)
    conditions.push(
      or(
        lt(ledgerEntries.occurredAt, new Date(lockedRange.startMs)),
        gte(ledgerEntries.occurredAt, new Date(lockedRange.endMs)),
      )!,
    )
  }

  const where = and(...conditions)
  const aggregate = db
    .select({
      value: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
    })
    .from(ledgerEntries)
    .where(where)
    .get()

  const rows = db
    .select(ledgerEntrySelection)
    .from(ledgerEntries)
    .leftJoin(reconciliationBatches, eq(ledgerEntries.batchId, reconciliationBatches.id))
    .where(where)
    .orderBy(
      sql`${ledgerEntries.occurredAt} DESC`,
      sql`${ledgerEntries.createdAt} DESC`,
      sql`${ledgerEntries.id} DESC`,
    )
    .limit(DIFF_DRILLDOWN_LIMIT)
    .all()

  return {
    count: Number(aggregate?.value ?? 0),
    totalCents: Number(aggregate?.total ?? 0),
    items: rows.map((row) => toLedgerEntry(row)),
  }
}

/** Locked batches whose period intersects the requested one. */
function lockedBatchesOverlapping(
  db: AppDatabase,
  periodFrom: string,
  periodTo: string,
): Array<{ periodFrom: string; periodTo: string }> {
  return db
    .select({
      periodFrom: reconciliationBatches.periodFrom,
      periodTo: reconciliationBatches.periodTo,
    })
    .from(reconciliationBatches)
    .where(
      and(
        eq(reconciliationBatches.status, 'locked'),
        // Exact for `YYYY-MM-DD`: a fixed-width, zero-padded, lexicographic date.
        lte(reconciliationBatches.periodFrom, periodTo),
        gte(reconciliationBatches.periodTo, periodFrom),
      ),
    )
    .all()
}

/**
 * Unresolved anomalies of the slice.
 *
 * An anomaly is *about* a fact, so the join keeps only anomalies whose fact falls
 * inside the requested period: an anomaly of a fact from another period must not
 * be counted into this statement's badge. `resolvedAt` is always `null` here —
 * a resolved anomaly is history, and resolving one never rewrites the fact.
 */
function collectOpenAnomalies(
  db: AppDatabase,
  actor: LedgerActor,
  range: { startMs: number; endMs: number },
): LedgerAnomaly[] {
  const conditions: SQL<unknown>[] = [
    isNull(ledgerAnomalies.resolvedAt),
    gte(ledgerEntries.occurredAt, new Date(range.startMs)),
    lt(ledgerEntries.occurredAt, new Date(range.endMs)),
  ]
  if (!ledgerScopeConditions(db, actor, conditions)) return []
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
    .where(and(...conditions))
    .orderBy(sql`${ledgerAnomalies.createdAt} DESC`)
    .limit(DIFF_DRILLDOWN_LIMIT)
    .all()
  return rows.map((row) => ({
    anomalyId: row.anomalyId,
    entryId: row.entryId,
    kind: row.kind,
    severity: row.severity,
    note: row.note,
    flaggedByUserId: row.flaggedByUserId,
    resolvedAt: row.resolvedAt === null ? null : iso(row.resolvedAt),
    createdAt: iso(row.createdAt),
  }))
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The CSV of one batch (or period): file text, counts and the audit row.
 *
 * The domain module builds the text; this wrapper exists so the route does not
 * reach into the service and so an unknown batch answers `404` **before** a file
 * is assembled. Every export is audited (`ledger.export.csv`) by the service,
 * because a file that leaves the back office must be attributable to a person.
 */
export function exportCsv(
  db: AppDatabase,
  actor: LedgerActor,
  query: Omit<ReconciliationCsvOptions, 'actor'>,
): ReconciliationCsv {
  if (query.batchId !== undefined) {
    // Surface a real 404 instead of building an empty "period" file for a bad id.
    getBatch(db, query.batchId)
  }
  return buildReconciliationCsv(db, { ...query, actor })
}

/**
 * `Content-Disposition` value of an export.
 *
 * ASCII only, no spaces and no Chinese: a non-ASCII filename is decoded
 * differently by every browser and mangles the extension in several, so the file
 * is named after the machine batch number — or `all` for an ad-hoc period
 * export. The stamp is Asia/Shanghai `YYYYMMDDHHmm`, matching the export audit
 * row, so a downloaded file can be lined up with the audit trail.
 */
export function csvDisposition(csv: ReconciliationCsv): string {
  const stamp = formatShanghaiStamp(new Date(csv.generatedAt)).slice(0, 12)
  return `attachment; filename="ledger-${csv.batchNo ?? 'all'}-${stamp}.csv"`
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The diff needs either a batch or a whole period.
 *
 * Half a period is a client bug, not an empty report: answering `400` keeps "the
 * period you asked for is unknown" from being rendered as "this period has no
 * facts", which would be a very comfortable lie on a reconciliation screen.
 */
export function resolveDiffQuery(input: DiffQuery): DiffQuery {
  if (input.batchId) return { batchId: input.batchId }
  if (input.periodFrom && input.periodTo) {
    return { periodFrom: input.periodFrom, periodTo: input.periodTo }
  }
  throw new LocalError(
    400,
    API_ERROR_CODES.invalidRequest,
    '必须指定对账批次，或同时指定期间开始与结束日期',
  )
}
