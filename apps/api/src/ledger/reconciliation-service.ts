import { randomUUID } from 'node:crypto'
import { and, eq, gt, gte, inArray, isNull, lt, lte, sql, type SQL } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  createBatchRequestSchema,
  maskMainlandPhone,
  reconciliationBatchSchema,
  type CreateBatchRequest,
  type LedgerAttributionBasis,
  type LedgerAttributionState,
  type LedgerEvidenceKind,
  type LedgerFactKind,
  type LedgerSourceSystem,
  type LockBatchRequest,
  type ReconciliationBatch,
  type SettlementAmountStatus,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  communities,
  auditLogs,
  ledgerAnomalies,
  ledgerEntries,
  reconciliationBatches,
  staffAccounts,
  users,
} from '../db/schema.js'
import {
  LEDGER_ATTRIBUTION_CONFIRMED_EVENT,
  LocalError,
  assertCommunityAccess,
  assertExpectedUpdatedAt,
  insertAudit,
  iso,
  isoOrNull,
  nextUpdatedAt,
  scopeCommunityIds,
  shanghaiDayEndExclusiveMs,
  shanghaiDayStartMs,
  type LedgerActor,
  type LocalTransaction,
} from './shared.js'

/**
 * Reconciliation batches, their derived statement, the diff and the CSV export
 * (LL-MVP-008, Issue #64).
 *
 * This module is deliberately **Hono-free**: it takes a Drizzle database, a
 * resolved actor and plain values, and either returns contract DTOs or throws
 * `LocalError`. The HTTP layer (session guard, CSRF, `grid_worker` 403, content
 * headers) is wired by the routes card. Keeping the split means the batch lock
 * can be exercised against a real SQLite file without an HTTP server.
 *
 * ## Membership is derived, never stamped
 *
 * `ledger_entries` is append-only: migration 0010 ABORTs every UPDATE, so a
 * batch could never write `ledger_entries.batch_id` after the fact. Batch
 * membership is therefore **derived from the business-day period**, and that is
 * the only definition used by `getBatchEntries`, `getReconciliationDiff` and the
 * CSV. `ledger_entries.batch_id` stays `null` forever unless the fact ingestion
 * path set it at INSERT time; nothing here ever writes it.
 *
 * A locked batch is a *statement*: entries inserted after the lock must not
 * silently enter it. Membership therefore also requires `created_at <= cutoff`,
 * where `cutoff` is the batch's `locked_at` for a locked batch (open batches
 * keep growing while they are being reconciled). This single rule is what makes
 * "锁定后新增条目不进旧批次" true and keeps a printed statement reproducible.
 *
 * ## L2: a fact that lands after its period was locked
 *
 * Append-only + period derivation has a consequence that must be stated, not
 * discovered: a fact whose 业务日期 is inside a **locked** period but which is
 * recorded afterwards can never join that statement, and can never be removed
 * from the period either. It is not "未纳入" by accident — it is excluded by
 * design. Therefore every surface says so out loud:
 * - `getBatchEntries` returns it in `lateRecorded` (separate from `entries`);
 * - `getReconciliationDiff` itemises it as `late_recorded_after_lock` and
 *   reports `lateRecordedCount` / `lateRecordedTotalCents`;
 * - `buildReconciliationCsv` leaves it out of the file (the file *is* the
 *   statement) but reports the same two numbers and audits them.
 * The operator's remedy is a reversal or an entry in the next period — never a
 * re-lock, which the triggers refuse.
 *
 * ## Single writer, not a distributed lock
 *
 * SQLite has no `SELECT ... FOR UPDATE`. "One open batch per period" is guarded
 * by the partial unique index `reconciliation_batches_open_period_uq`
 * (`WHERE status = 'open'`) plus a `BEGIN IMMEDIATE` transaction
 * (`{ behavior: 'immediate' }`) and a conditional `UPDATE ... changes === 1`.
 * That is **single-writer** serialization on one SQLite file — it is not a
 * distributed lock, and this module never claims to be one. Two API processes
 * on the same file still rely on SQLite's own file locking.
 *
 * ## What a batch is NOT
 *
 * `entry_count` / `total_cents` describe the **recorded gross facts** of the
 * period. There is no settlement rule in this MVP (`settlement_amount_status`
 * stays `pending_rule`), so a batch never produces a payable or distribution
 * amount. Reversals stay their own positive-amount rows and are never netted
 * into the received total.
 */

/* -------------------------------------------------------------------------- */
/* Constants and small helpers                                                */
/* -------------------------------------------------------------------------- */

/** Reads may use the pooled connection; writes run inside the immediate transaction. */
type Executor = AppDatabase | LocalTransaction

/** Rows in one CSV file. Beyond this the caller must narrow the period or pick a batch. */
export const RECONCILIATION_CSV_MAX_ROWS = 5_000

/**
 * Fixed CSV column order. Chinese headers are what an operator sees in Excel;
 * `流水号` first keeps every row traceable back to the immutable fact.
 *
 * The column *set* is fixed: a reconciliation file whose columns moved would not
 * be comparable with yesterday's export. Enum values are rendered as Chinese
 * labels (the `流水号` is the machine key back to the API/DB), and money is
 * always `(cents / 100).toFixed(2)`.
 */
export const RECONCILIATION_CSV_HEADERS = [
  '流水号',
  '来源系统',
  '来源单号',
  '事实类型',
  '发生时间',
  '核验时间',
  '社区',
  '归属网格员',
  '归属状态',
  '金额(元)',
  '结算口径',
  '凭据引用',
  '对账批次',
  '异常',
] as const

export const RECONCILIATION_CSV_COLUMN_COUNT = RECONCILIATION_CSV_HEADERS.length

const FACT_KIND_LABELS: Record<LedgerFactKind, string> = {
  order_registered: '订单登记',
  order_verified: '已核验业绩',
  payment_received: '实收',
  payment_reversed: '收款冲正',
  reward_cost: '奖励成本',
  reward_reversed: '奖励冲正',
}

const SOURCE_SYSTEM_LABELS: Record<LedgerSourceSystem, string> = {
  local_order: '本地订单',
  crm_service_order: '广电CRM',
  activity_reward_grant: '奖励履约',
  manual: '人工收款',
}

const ATTRIBUTION_STATE_LABELS: Record<LedgerAttributionState, string> = {
  attributed: '已归属',
  pending: '待归属',
}

const SETTLEMENT_LABELS: Record<SettlementAmountStatus, string> = {
  pending_rule: '待结算规则',
  estimated: '规则估算',
}

const ANOMALY_KIND_LABELS: Record<string, string> = {
  amount_mismatch: '金额不一致',
  attribution_conflict: '归属冲突',
  source_missing_evidence: '证据缺失',
  duplicate_candidate: '疑似重复',
  period_gap: '期间缺口',
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

/** `2026-11-07T01:30:00.000Z` -> `2026-11-07 09:30:00` (Asia/Shanghai, no DST). */
export function formatShanghaiDateTime(at: Date): string {
  return new Date(at.getTime() + SHANGHAI_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ')
}

/** Compact Asia/Shanghai stamp used in the export filename (`YYYYMMDDHHmmss`). */
export function formatShanghaiStamp(at: Date): string {
  return new Date(at.getTime() + SHANGHAI_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/gu, '')
    .replace('T', '')
}

/**
 * Redacts mainland mobile numbers in a free-text cell.
 *
 * A ledger fact must never carry a full resident phone number, but evidence
 * references are typed by staff and may contain one. Over-redaction is the
 * intended trade-off: an 11-digit token starting with `13`-`19` is treated as a
 * phone even when it was meant as a business key, because the alternative is
 * leaking a resident's number into a file that leaves the back office.
 */
export function maskPhoneNumbers(value: string): string {
  return value.replace(/(?<!\d)(1[3-9]\d{9})(?!\d)/gu, (phone) => maskMainlandPhone(phone))
}

/** RFC 4180 cell: quote only when needed, double the quotes. */
function csvCell(value: string): string {
  const masked = maskPhoneNumbers(value)
  // Quoting CSV is not sufficient to stop Excel interpreting formula cells.
  // Prefix a text marker even when whitespace/control characters precede it.
  const safe = /^[\u0000-\u0020]*[=+\-@]/u.test(masked) ? `'${masked}` : masked
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe
}

/**
 * Parses and validates an inclusive business-day period into a half-open
 * `Asia/Shanghai` millisecond range.
 *
 * Exported on purpose: `api-facts` is aligning the流水 page (`shared.ts`
 * `toLedgerEntry`) on the *same* derived-membership rule this module uses, and a
 * second, subtly different date-range implementation is exactly how the两个页面
 * end up disagreeing. When that helper lands in `shared.ts` this one becomes a
 * re-export — the semantics (`[start, end)` in +08:00, no DST, inclusive
 * `periodFrom`/`periodTo` business dates) must not change.
 */
export function reconciliationPeriodRange(
  periodFrom: string,
  periodTo: string,
): { startMs: number; endMs: number } {
  if (!BUSINESS_DATE_PATTERN.test(periodFrom) || !BUSINESS_DATE_PATTERN.test(periodTo)) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '对账期间必须是 YYYY-MM-DD 业务日期')
  }
  if (periodTo < periodFrom) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '对账期间的结束日期不能早于开始日期')
  }
  return {
    startMs: shanghaiDayStartMs(periodFrom),
    endMs: shanghaiDayEndExclusiveMs(periodTo),
  }
}

/**
 * Writes and exports are back-office actions. The routes card already refuses
 * `grid_worker` on `/admin/reconciliation/*`; repeating the rule here means a
 * future handler cannot forget it.
 */
function requireBackOffice(actor: LedgerActor): void {
  if (actor.role !== 'admin' && actor.role !== 'operator') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '只有管理员或运营员可以对账')
  }
}

/* -------------------------------------------------------------------------- */
/* Batch DTO                                                                  */
/* -------------------------------------------------------------------------- */

type BatchRow = typeof reconciliationBatches.$inferSelect

function toReconciliationBatch(row: BatchRow): ReconciliationBatch {
  return reconciliationBatchSchema.parse({
    batchId: row.id,
    batchNo: row.batchNo,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    status: row.status,
    entryCount: row.entryCount,
    totalCents: row.totalCents,
    note: row.note,
    lockedAt: isoOrNull(row.lockedAt),
    lockedByUserId: row.lockedByUserId,
    lockedByStaffId: row.lockedByStaffId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

function readBatchRow(executor: Executor, batchId: string): BatchRow | null {
  return (
    executor.select().from(reconciliationBatches).where(eq(reconciliationBatches.id, batchId)).get() ??
    null
  )
}

function requireBatchRow(executor: Executor, batchId: string): BatchRow {
  const row = readBatchRow(executor, batchId)
  if (!row) {
    throw new LocalError(404, API_ERROR_CODES.notFound, '对账批次不存在')
  }
  return row
}

/**
 * The lock cutoff of a batch: a locked statement only contains facts that
 * existed when it was frozen. `null` means "no cutoff" (an open batch keeps
 * absorbing facts of its period, including late-recorded ones).
 *
 * Exported for `api-facts`: the流水 page must answer `reconciliationState` from
 * the *same* cutoff rule, otherwise the batch page and the entry list disagree
 * about the very same fact (see the L1 note on `toLedgerEntry`).
 */
export function cutoffMsOf(batch: {
  status: 'open' | 'locked'
  lockedAt: Date | null
}): number | null {
  return batch.status === 'locked' && batch.lockedAt ? batch.lockedAt.getTime() : null
}

/* -------------------------------------------------------------------------- */
/* Derived membership                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Conditions of "facts that belong to this period as of `cutoffMs`".
 *
 * `occurredAt` is the business instant (a half-open Asia/Shanghai day range);
 * `createdAt` is when the fact entered the ledger. Both are required: without
 * the second one a locked statement would change as soon as a late fact lands.
 *
 * Exported for `api-facts` so the entry list derives batch membership from the
 * identical rule. When it moves into `shared.ts` this stays the same expression
 * and only the import changes — the semantics are the contract:
 * `occurred_at ∈ [periodFrom 00:00 +08:00, periodTo+1d 00:00 +08:00)` **and**
 * (`cutoffMs === null` **or** `created_at <= cutoffMs`).
 */
export function membershipConditions(
  periodFrom: string,
  periodTo: string,
  cutoffMs: number | null,
): SQL<unknown>[] {
  const range = reconciliationPeriodRange(periodFrom, periodTo)
  const conditions: SQL<unknown>[] = [
    gte(ledgerEntries.occurredAt, new Date(range.startMs)),
    lt(ledgerEntries.occurredAt, new Date(range.endMs)),
  ]
  if (cutoffMs !== null) {
    conditions.push(lte(ledgerEntries.createdAt, new Date(cutoffMs)))
  }
  return conditions
}

function summarizeEntries(
  executor: Executor,
  periodFrom: string,
  periodTo: string,
  cutoffMs: number | null,
): { entryCount: number; totalCents: number } {
  const row = executor
    .select({
      entryCount: sql<number>`count(*)`,
      totalCents: sql<number>`coalesce(sum(${ledgerEntries.amountCents}), 0)`,
    })
    .from(ledgerEntries)
    .where(and(...membershipConditions(periodFrom, periodTo, cutoffMs)))
    .get()
  return {
    entryCount: Number(row?.entryCount ?? 0),
    totalCents: Number(row?.totalCents ?? 0),
  }
}

/** One fact as the reconciliation statement (and its CSV) renders it. */
export interface ReconciliationEntryView {
  entryId: string
  factKind: LedgerFactKind
  sourceSystem: LedgerSourceSystem
  sourceId: string
  sourceDisplayNo: string
  communityId: string
  communityName: string | null
  attributedStaffId: string | null
  attributedStaffName: string | null
  attributionState: LedgerAttributionState
  attributionBasis: LedgerAttributionBasis
  amountCents: number
  settlementAmountStatus: SettlementAmountStatus
  occurredAt: string
  verifiedAt: string | null
  recordedByStaffId: string | null
  evidenceKind: LedgerEvidenceKind
  evidenceRef: string | null
  counterEntryId: string | null
  /** Derived batch identity; `null` for an ad-hoc (unbatched) period view. */
  batchId: string | null
  batchNo: string | null
  reconciliationState: 'unreconciled' | 'batched' | 'reconciled'
  /** Unresolved anomalies of this fact, oldest first. Resolved ones are history. */
  anomalies: Array<{
    anomalyId: string
    kind: string
    severity: 'low' | 'medium' | 'high'
    note: string | null
  }>
}

interface EntryViewFilter {
  /** When set, membership and the frozen cutoff come from this batch. */
  batchId?: string
  periodFrom?: string
  periodTo?: string
  communityId?: string
  /**
   * Community scope of the caller. `null` = unscoped (admin). It is applied as
   * an *intersection* even when a batch is selected: the batch DTO keeps its
   * global totals, while `computed` describes what this caller may see. The two
   * are only compared for `batch_totals_drift` when nothing narrowed the read.
   */
  scope?: string[] | null
}

interface CollectedEntries {
  batch: BatchRow | null
  entries: ReconciliationEntryView[]
  stored: { entryCount: number; totalCents: number } | null
  computed: { entryCount: number; totalCents: number }
  /**
   * Facts whose business date is inside a **locked** batch period but which were
   * recorded after `locked_at`. They can never join the frozen statement
   * (append-only + period derivation), so they are surfaced here instead of
   * disappearing: the diff turns each of them into a `late_recorded_after_lock`
   * item. Always empty for an open batch or an ad-hoc period.
   */
  lateRecorded: ReconciliationEntryView[]
  /** `true` when a community narrowing (scope or explicit id) was applied. */
  narrowed: boolean
}

/**
 * Reads the derived statement of a batch, or of an ad-hoc period.
 *
 * The returned `entries` are the single source of truth for the statement, the
 * diff and the CSV: three surfaces that must not disagree about which facts
 * belong to a statement.
 *
 * `lateRecorded` is the one thing the statement deliberately excludes, and it is
 * computed here (not in the diff) so that every caller gets the same answer.
 */
function collectEntryViews(db: AppDatabase, filter: EntryViewFilter): CollectedEntries {
  let batch: BatchRow | null = null
  let periodFrom: string
  let periodTo: string
  let cutoffMs: number | null = null
  let batchId: string | null = null
  let batchNo: string | null = null
  let reconciliationState: ReconciliationEntryView['reconciliationState'] = 'unreconciled'
  let narrowed = false

  if (filter.batchId) {
    batch = requireBatchRow(db, filter.batchId)
    periodFrom = batch.periodFrom
    periodTo = batch.periodTo
    cutoffMs = cutoffMsOf(batch)
    batchId = batch.id
    batchNo = batch.batchNo
    reconciliationState = batch.status === 'locked' ? 'reconciled' : 'batched'
  } else {
    if (!filter.periodFrom || !filter.periodTo) {
      throw new LocalError(400, API_ERROR_CODES.invalidRequest, '必须指定对账批次或对账期间')
    }
    periodFrom = filter.periodFrom
    periodTo = filter.periodTo
    reconciliationPeriodRange(periodFrom, periodTo)
  }

  const conditions = membershipConditions(periodFrom, periodTo, cutoffMs)
  // Narrowing conditions are kept apart from the period/cutoff conditions so the
  // late-recorded query below can reuse them without re-deriving the range.
  const narrowConditions: SQL<unknown>[] = []
  if (filter.communityId) {
    narrowConditions.push(eq(ledgerEntries.communityId, filter.communityId))
    narrowed = true
  }
  // Scope is applied *in addition* to an explicit narrowing, never instead of
  // it, so a forged `communityId` can only ever return fewer rows.
  if (filter.scope !== undefined && filter.scope !== null) {
    if (filter.scope.length === 0) {
      return {
        batch,
        entries: [],
        stored: batch ? { entryCount: batch.entryCount, totalCents: batch.totalCents } : null,
        computed: { entryCount: 0, totalCents: 0 },
        lateRecorded: [],
        narrowed: true,
      }
    }
    narrowConditions.push(inArray(ledgerEntries.communityId, filter.scope))
    narrowed = true
  }
  conditions.push(...narrowConditions)

  const rows = db
    .select(ENTRY_VIEW_COLUMNS)
    .from(ledgerEntries)
    .where(and(...conditions))
    .orderBy(
      sql`${ledgerEntries.occurredAt} ASC`,
      sql`${ledgerEntries.createdAt} ASC`,
      sql`${ledgerEntries.id} ASC`,
    )
    .all()

  const identity = { batchId, batchNo, reconciliationState, attributionCutoffMs: cutoffMs }
  const entries = mapEntryRows(db, rows, identity)

  // Late-recorded facts: same business period, but they entered the ledger after
  // the statement was frozen. `membershipConditions` excludes them on purpose
  // (a locked batch must not move), so they are collected separately and handed
  // to the diff instead of vanishing. They keep `reconciliationState` of their
  // own: they are *not* part of the locked statement.
  let lateRecorded: ReconciliationEntryView[] = []
  if (cutoffMs !== null) {
    const lateRows = db
      .select(ENTRY_VIEW_COLUMNS)
      .from(ledgerEntries)
      .where(
        and(
          ...membershipConditions(periodFrom, periodTo, null),
          gt(ledgerEntries.createdAt, new Date(cutoffMs)),
          ...narrowConditions,
        ),
      )
      .orderBy(
        sql`${ledgerEntries.occurredAt} ASC`,
        sql`${ledgerEntries.createdAt} ASC`,
        sql`${ledgerEntries.id} ASC`,
      )
      .all()
    lateRecorded = mapEntryRows(db, lateRows, {
      batchId: null,
      batchNo: null,
      reconciliationState: 'unreconciled',
      attributionCutoffMs: null,
    })
  }

  return {
    batch,
    entries,
    stored: batch ? { entryCount: batch.entryCount, totalCents: batch.totalCents } : null,
    computed: {
      entryCount: entries.length,
      totalCents: entries.reduce((total, entry) => total + entry.amountCents, 0),
    },
    lateRecorded,
    narrowed,
  }
}

/** Columns every statement/CSV/diff read needs; one definition, three callers. */
const ENTRY_VIEW_COLUMNS = {
  entryId: ledgerEntries.id,
  factKind: ledgerEntries.factKind,
  sourceSystem: ledgerEntries.sourceSystem,
  sourceId: ledgerEntries.sourceId,
  sourceDisplayNo: ledgerEntries.sourceDisplayNo,
  communityId: ledgerEntries.communityId,
  attributedStaffId: ledgerEntries.attributedStaffId,
  attributionState: ledgerEntries.attributionState,
  attributionBasis: ledgerEntries.attributionBasis,
  amountCents: ledgerEntries.amountCents,
  settlementAmountStatus: ledgerEntries.settlementAmountStatus,
  occurredAt: ledgerEntries.occurredAt,
  verifiedAt: ledgerEntries.verifiedAt,
  recordedByStaffId: ledgerEntries.recordedByStaffId,
  evidenceKind: ledgerEntries.evidenceKind,
  evidenceRef: ledgerEntries.evidenceRef,
  counterEntryId: ledgerEntries.counterEntryId,
} as const

type EntryRow = {
  entryId: string
  factKind: LedgerFactKind
  sourceSystem: LedgerSourceSystem
  sourceId: string
  sourceDisplayNo: string
  communityId: string
  attributedStaffId: string | null
  attributionState: LedgerAttributionState
  attributionBasis: LedgerAttributionBasis
  amountCents: number
  settlementAmountStatus: SettlementAmountStatus
  occurredAt: Date
  verifiedAt: Date | null
  recordedByStaffId: string | null
  evidenceKind: LedgerEvidenceKind
  evidenceRef: string | null
  counterEntryId: string | null
}

interface EntryViewIdentity {
  batchId: string | null
  batchNo: string | null
  reconciliationState: ReconciliationEntryView['reconciliationState']
  /** Locked statements freeze the attribution known at their lock instant. */
  attributionCutoffMs: number | null
}

/**
 * Maps stored fact rows to statement views, resolving the display-only joins
 * (community name, staff display name, unresolved anomalies) in three batched
 * queries instead of N+1.
 */
function mapEntryRows(
  db: AppDatabase,
  rows: EntryRow[],
  identity: EntryViewIdentity,
): ReconciliationEntryView[] {
  const communityIds = [...new Set(rows.map((row) => row.communityId))]
  const communityNames = new Map<string, string>()
  if (communityIds.length > 0) {
    const communityRows = db
      .select({ id: communities.id, name: communities.name })
      .from(communities)
      .where(inArray(communities.id, communityIds))
      .all()
    for (const row of communityRows) communityNames.set(row.id, row.name)
  }

  // Confirmation is an appended audit fact, not a mutation of ledger_entries.
  // Apply the same projection as the main ledger list, with an as-of cutoff for
  // immutable locked statements. Read all confirmations in one query, not N+1.
  const entryIds = rows.map((row) => row.entryId)
  const confirmedByEntry = new Map<string, string>()
  if (entryIds.length > 0) {
    const confirmations = db
      .select({
        entryId: auditLogs.targetId,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .where(and(
        eq(auditLogs.event, LEDGER_ATTRIBUTION_CONFIRMED_EVENT),
        inArray(auditLogs.targetId, entryIds),
        ...(identity.attributionCutoffMs === null
          ? []
          : [lte(auditLogs.createdAt, new Date(identity.attributionCutoffMs))]),
      ))
      .orderBy(sql`${auditLogs.createdAt} DESC`, sql`${auditLogs.id} DESC`)
      .all()
    for (const confirmation of confirmations) {
      if (!confirmation.entryId || confirmedByEntry.has(confirmation.entryId) || !confirmation.metadata) continue
      try {
        const parsed: unknown = JSON.parse(confirmation.metadata)
        if (typeof parsed === 'object' && parsed !== null && 'staffId' in parsed &&
            typeof parsed.staffId === 'string') {
          confirmedByEntry.set(confirmation.entryId, parsed.staffId)
        }
      } catch {
        // An invalid legacy audit record does not fabricate an attribution.
      }
    }
  }

  const staffIds = [
    ...new Set(rows.map((row) => confirmedByEntry.get(row.entryId) ?? row.attributedStaffId)
      .filter((id): id is string => id !== null)),
  ]
  const staffNames = new Map<string, string>()
  if (staffIds.length > 0) {
    const staffRows = db
      .select({ id: staffAccounts.id, displayName: users.displayName })
      .from(staffAccounts)
      .innerJoin(users, eq(staffAccounts.userId, users.id))
      .where(inArray(staffAccounts.id, staffIds))
      .all()
    for (const row of staffRows) {
      // `users.display_name` is nullable; an unnamed account simply contributes no
      // name and the CSV falls back to the staff id.
      if (row.displayName) staffNames.set(row.id, row.displayName)
    }
  }

  const anomalyByEntry = new Map<string, ReconciliationEntryView['anomalies']>()
  if (entryIds.length > 0) {
    const anomalyRows = db
      .select({
        anomalyId: ledgerAnomalies.id,
        entryId: ledgerAnomalies.entryId,
        kind: ledgerAnomalies.kind,
        severity: ledgerAnomalies.severity,
        note: ledgerAnomalies.note,
      })
      .from(ledgerAnomalies)
      .where(and(inArray(ledgerAnomalies.entryId, entryIds), isNull(ledgerAnomalies.resolvedAt)))
      .orderBy(sql`${ledgerAnomalies.createdAt} ASC`)
      .all()
    for (const row of anomalyRows) {
      const list = anomalyByEntry.get(row.entryId) ?? []
      list.push({
        anomalyId: row.anomalyId,
        kind: row.kind,
        severity: row.severity,
        note: row.note,
      })
      anomalyByEntry.set(row.entryId, list)
    }
  }

  return rows.map((row) => {
    const confirmedStaff = confirmedByEntry.get(row.entryId)
    const staffId = confirmedStaff ?? row.attributedStaffId
    return {
    entryId: row.entryId,
    factKind: row.factKind,
    sourceSystem: row.sourceSystem,
    sourceId: row.sourceId,
    sourceDisplayNo: row.sourceDisplayNo,
    communityId: row.communityId,
    communityName: communityNames.get(row.communityId) ?? null,
    attributedStaffId: staffId,
    attributedStaffName: staffId ? (staffNames.get(staffId) ?? null) : null,
    attributionState: confirmedStaff ? 'attributed' : row.attributionState,
    attributionBasis: confirmedStaff ? 'explicit_attribution' : row.attributionBasis,
    amountCents: row.amountCents,
    settlementAmountStatus: row.settlementAmountStatus,
    occurredAt: iso(row.occurredAt),
    verifiedAt: isoOrNull(row.verifiedAt),
    recordedByStaffId: row.recordedByStaffId,
    evidenceKind: row.evidenceKind,
    evidenceRef: row.evidenceRef,
    counterEntryId: row.counterEntryId,
    batchId: identity.batchId,
    batchNo: identity.batchNo,
    reconciliationState: identity.reconciliationState,
    anomalies: anomalyByEntry.get(row.entryId) ?? [],
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Batch creation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Creates an `open` reconciliation batch for an inclusive business-day period.
 *
 * The body never carries an amount, a count or a community: those are derived
 * from the immutable facts, so a client can neither pre-seed a fake total nor
 * widen the statement.
 *
 * A period may only ever have **one** batch:
 * - while it is `open` the partial unique index rejects a second one, and this
 *   function answers `409 conflict` before it gets there;
 * - once it is `locked` the period is a frozen statement. Re-creating it is
 *   refused with `ledger_batch_locked`; re-dating or re-splitting a reconciled
 *   period is a deliberate, separate operation that this card does not ship.
 */
export function createBatch(
  db: AppDatabase,
  actor: LedgerActor,
  input: CreateBatchRequest,
  options: { now?: Date } = {},
): ReconciliationBatch {
  requireBackOffice(actor)
  const parsed = createBatchRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '对账批次参数不正确')
  }
  const body = parsed.data
  const now = options.now ?? new Date()
  reconciliationPeriodRange(body.periodFrom, body.periodTo)

  try {
    return db.transaction(
      (tx): ReconciliationBatch => {
        const existing = tx
          .select({ id: reconciliationBatches.id, status: reconciliationBatches.status })
          .from(reconciliationBatches)
          .where(
            and(
              eq(reconciliationBatches.periodFrom, body.periodFrom),
              eq(reconciliationBatches.periodTo, body.periodTo),
            ),
          )
          .all()
        if (existing.some((row) => row.status === 'locked')) {
          throw new LocalError(
            409,
            API_ERROR_CODES.ledgerBatchLocked,
            '该期间的对账批次已锁定，不能重复创建',
          )
        }
        if (existing.length > 0) {
          throw new LocalError(409, API_ERROR_CODES.conflict, '该期间已有开放中的对账批次')
        }

        // Deterministic and human-readable: `RB-<from>-<to>`.
        const batchNo = `RB-${body.periodFrom.replace(/-/gu, '')}-${body.periodTo.replace(/-/gu, '')}`
        const summary = summarizeEntries(tx, body.periodFrom, body.periodTo, now.getTime())
        const batchId = randomUUID()
        tx.insert(reconciliationBatches)
          .values({
            id: batchId,
            batchNo,
            periodFrom: body.periodFrom,
            periodTo: body.periodTo,
            status: 'open',
            lockedAt: null,
            lockedByUserId: null,
            lockedByStaffId: null,
            // Snapshot at creation. Informational while the batch is open (late
            // facts may still land); `lockBatch` recomputes and freezes it.
            entryCount: summary.entryCount,
            totalCents: summary.totalCents,
            note: body.note ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        insertAudit(tx, actor.userId, 'ledger.reconciliation.batch.created', batchId, now, {
          batchNo,
          periodFrom: body.periodFrom,
          periodTo: body.periodTo,
          entryCount: String(summary.entryCount),
          totalCents: String(summary.totalCents),
        })
        return toReconciliationBatch(requireBatchRow(tx, batchId))
      },
      { behavior: 'immediate' },
    )
  } catch (error) {
    if (error instanceof LocalError) throw error
    // The partial unique index is the real backstop: even if two writers race
    // past the check above, only one open batch per period can exist.
    if (
      error instanceof Error &&
      /UNIQUE constraint failed|constraint failed/iu.test(error.message)
    ) {
      throw new LocalError(409, API_ERROR_CODES.conflict, '该期间已有开放中的对账批次')
    }
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Batch locking                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Locks an `open` batch: `open -> locked`, one way, exactly once.
 *
 * The lock freezes the statement: `entry_count` / `total_cents` are recomputed
 * from the facts that existed at this instant (`created_at <= locked_at`) and
 * stored, and the migration-0010 triggers refuse every later change to the row.
 * A second lock is `409 ledger_batch_locked`; a stale `expectedUpdatedAt` is
 * `409 conflict` — never a silent re-lock that would move a printed number.
 */
export function lockBatch(
  db: AppDatabase,
  actor: LedgerActor,
  batchId: string,
  input: LockBatchRequest,
  options: { now?: Date } = {},
): ReconciliationBatch {
  requireBackOffice(actor)
  const now = options.now ?? new Date()

  return db.transaction(
    (tx): ReconciliationBatch => {
      const row = requireBatchRow(tx, batchId)
      if (row.status === 'locked') {
        throw new LocalError(409, API_ERROR_CODES.ledgerBatchLocked, '该对账批次已锁定，不能重复锁定')
      }
      assertExpectedUpdatedAt(row.updatedAt, input.expectedUpdatedAt)

      const summary = summarizeEntries(tx, row.periodFrom, row.periodTo, now.getTime())
      const updated = tx
        .update(reconciliationBatches)
        .set({
          status: 'locked',
          entryCount: summary.entryCount,
          totalCents: summary.totalCents,
          lockedAt: now,
          lockedByUserId: actor.userId,
          lockedByStaffId: actor.staffId,
          ...(input.note === undefined ? {} : { note: input.note }),
          updatedAt: nextUpdatedAt(row.updatedAt, now),
        })
        .where(
          and(
            eq(reconciliationBatches.id, batchId),
            eq(reconciliationBatches.status, 'open'),
            eq(reconciliationBatches.updatedAt, row.updatedAt),
          ),
        )
        .run()
      if (updated.changes !== 1) {
        throw new LocalError(409, API_ERROR_CODES.conflict, '数据已被其他操作更新，请刷新后重试')
      }

      insertAudit(tx, actor.userId, 'ledger.reconciliation.batch.locked', batchId, now, {
        batchNo: row.batchNo,
        periodFrom: row.periodFrom,
        periodTo: row.periodTo,
        entryCount: String(summary.entryCount),
        totalCents: String(summary.totalCents),
      })
      return toReconciliationBatch(requireBatchRow(tx, batchId))
    },
    { behavior: 'immediate' },
  )
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** Batches (global periods, back-office only), newest period first. */
export function listBatches(
  db: AppDatabase,
  options: { limit?: number; now?: Date } = {},
): { items: ReconciliationBatch[]; asOf: string } {
  const now = options.now ?? new Date()
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200)
  const rows = db
    .select()
    .from(reconciliationBatches)
    .orderBy(
      sql`${reconciliationBatches.periodFrom} DESC`,
      sql`${reconciliationBatches.batchNo} DESC`,
    )
    .limit(limit)
    .all()
  return { items: rows.map(toReconciliationBatch), asOf: now.toISOString() }
}

/** One batch by id; `404` when it does not exist. */
export function getBatch(db: AppDatabase, batchId: string): ReconciliationBatch {
  return toReconciliationBatch(requireBatchRow(db, batchId))
}

/**
 * The derived statement of one batch: its facts, their totals and the batch DTO.
 *
 * `stored` is what the row says (`entry_count` / `total_cents`); `computed` is
 * what the immutable facts say under the membership rule. For a locked batch
 * they are equal — that is the freeze — and `getReconciliationDiff` reports a
 * `batch_totals_drift` if they ever disagree.
 *
 * `options.actor` adds the caller's community scope; omit it only for an
 * unscoped (admin) read.
 */
export function getBatchEntries(
  db: AppDatabase,
  batchId: string,
  options: { actor?: LedgerActor; now?: Date } = {},
): {
  batch: ReconciliationBatch
  entries: ReconciliationEntryView[]
  stored: { entryCount: number; totalCents: number }
  computed: { entryCount: number; totalCents: number }
  /**
   * Facts of the batch period recorded **after** the lock (L2). They are
   * deliberately not part of `entries`; `getReconciliationDiff` itemises them as
   * `late_recorded_after_lock`.
   */
  lateRecorded: ReconciliationEntryView[]
  asOf: string
} {
  const scope = options.actor ? scopeCommunityIds(db, options.actor) : null
  const collected = collectEntryViews(db, {
    batchId,
    ...(scope === null ? {} : { scope }),
  })
  if (!collected.batch || collected.stored === null) {
    throw new LocalError(404, API_ERROR_CODES.notFound, '对账批次不存在')
  }
  return {
    batch: toReconciliationBatch(collected.batch),
    entries: collected.entries,
    stored: collected.stored,
    computed: collected.computed,
    lateRecorded: collected.lateRecorded,
    asOf: (options.now ?? new Date()).toISOString(),
  }
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

export type ReconciliationDiffReason =
  | 'pending_attribution'
  | 'open_anomaly'
  | 'reversal_original_outside_period'
  | 'batch_totals_drift'
  | 'late_recorded_after_lock'
  | 'empty_period'

export interface ReconciliationDiffItem {
  reason: ReconciliationDiffReason
  severity: 'low' | 'medium' | 'high'
  /** `null` for a batch-level finding (e.g. totals drift). */
  entryId: string | null
  sourceDisplayNo: string | null
  /** Human explanation; never contains a phone number or a secret. */
  detail: string
}

export interface ReconciliationDiff {
  batchId: string | null
  batchNo: string | null
  status: 'open' | 'locked' | null
  periodFrom: string
  periodTo: string
  /** What the batch row claims; `null` for an ad-hoc period. */
  stored: { entryCount: number; totalCents: number } | null
  /** What the immutable facts say under the derived-membership rule. */
  computed: { entryCount: number; totalCents: number }
  items: ReconciliationDiffItem[]
  summary: { total: number; low: number; medium: number; high: number }
  /**
   * Facts of a **locked** period that were recorded after the lock. They can
   * never join the frozen statement (append-only + period derivation), so they
   * are counted here and itemised as `late_recorded_after_lock` instead of
   * disappearing. Always `0` for an open batch or an ad-hoc period.
   */
  lateRecordedCount: number
  /** Sum of `lateRecordedCount` amounts, so the gap is measurable, not just felt. */
  lateRecordedTotalCents: number
  asOf: string
}

export interface ReconciliationDiffQuery {
  batchId?: string
  periodFrom?: string
  periodTo?: string
}

/**
 * The reconciliation diff of one batch (or an ad-hoc period).
 *
 * It answers "what still needs a human before this statement is clean", using
 * only facts that are already immutable:
 * - `pending_attribution` — 待归属 facts: the money is real but cannot be
 *   attributed to a grid worker. The diff never invents an owner;
 * - `open_anomaly` — an unresolved anomaly of the period (amount mismatch,
 *   attribution conflict, missing evidence, duplicate candidate, period gap);
 * - `reversal_original_outside_period` — the reversal belongs to this period
 *   but the entry it reverses does not, so the pair cannot be checked here;
 * - `batch_totals_drift` — a **locked** batch whose stored totals differ from
 *   the derived ones (defensive: unreachable through this service, only through
 *   a hand-written row or a bad migration);
 * - `late_recorded_after_lock` — L2 (文档 §9.2)：锁后补录的同期间事实。由于
 *   append-only 且成员按期间派生，这类事实**不可能**补进已锁批次；与其让它静默
 *   消失，不如逐条列入差异清单并给出笔数/金额，交给人决定是补一张冲正、还是并入
 *   下一期间。这是该场景的显式答案，而不是「未纳入」的沉默；
 * - `empty_period` — a period with no facts at all is worth a look before it is
 *   locked.
 */
export function getReconciliationDiff(
  db: AppDatabase,
  query: ReconciliationDiffQuery,
  options: { actor?: LedgerActor; now?: Date } = {},
): ReconciliationDiff {
  const scope = options.actor ? scopeCommunityIds(db, options.actor) : null
  const collected = collectEntryViews(db, {
    ...(query.batchId === undefined ? {} : { batchId: query.batchId }),
    ...(query.periodFrom === undefined ? {} : { periodFrom: query.periodFrom }),
    ...(query.periodTo === undefined ? {} : { periodTo: query.periodTo }),
    ...(scope === null ? {} : { scope }),
  })
  const batch = collected.batch
  const periodFrom = batch?.periodFrom ?? query.periodFrom!
  const periodTo = batch?.periodTo ?? query.periodTo!
  const asOf = (options.now ?? new Date()).toISOString()
  const items: ReconciliationDiffItem[] = []

  for (const entry of collected.entries) {
    if (entry.attributionState === 'pending') {
      items.push({
        reason: 'pending_attribution',
        severity: 'medium',
        entryId: entry.entryId,
        sourceDisplayNo: entry.sourceDisplayNo,
        detail: '该笔流水没有明确的业绩归属（待归属），不能计入任何人的业绩',
      })
    }
    for (const anomaly of entry.anomalies) {
      items.push({
        reason: 'open_anomaly',
        severity: anomaly.severity,
        entryId: entry.entryId,
        sourceDisplayNo: entry.sourceDisplayNo,
        detail: `未处理异常：${ANOMALY_KIND_LABELS[anomaly.kind] ?? anomaly.kind}${
          anomaly.note ? `（${anomaly.note}）` : ''
        }`,
      })
    }
  }

  // A reversal is only verifiable next to its original: if the original is
  // outside this period the pair must be checked across periods.
  const counterIds = [
    ...new Set(
      collected.entries
        .map((entry) => entry.counterEntryId)
        .filter((id): id is string => id !== null),
    ),
  ]
  if (counterIds.length > 0) {
    const counters = db
      .select({ id: ledgerEntries.id, occurredAt: ledgerEntries.occurredAt })
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.id, counterIds))
      .all()
    const counterById = new Map(counters.map((row) => [row.id, row.occurredAt]))
    const range = reconciliationPeriodRange(periodFrom, periodTo)
    for (const entry of collected.entries) {
      if (!entry.counterEntryId) continue
      const original = counterById.get(entry.counterEntryId)
      if (!original) continue
      const originalMs = original.getTime()
      if (originalMs < range.startMs || originalMs >= range.endMs) {
        items.push({
          reason: 'reversal_original_outside_period',
          severity: 'medium',
          entryId: entry.entryId,
          sourceDisplayNo: entry.sourceDisplayNo,
          detail: '冲正流水在本期间，但被冲正的原流水不在本期间，需要跨期间核对',
        })
      }
    }
  }

  // Totals drift can only be judged on the *same* population the row was frozen
  // over. A narrowed read (operator scope / community filter) is a subset and
  // must never be reported as "the batch is wrong".
  if (batch && batch.status === 'locked' && !collected.narrowed) {
    if (
      collected.stored &&
      (collected.stored.entryCount !== collected.computed.entryCount ||
        collected.stored.totalCents !== collected.computed.totalCents)
    ) {
      items.push({
        reason: 'batch_totals_drift',
        severity: 'high',
        entryId: null,
        sourceDisplayNo: null,
        detail: `锁定批次的记录合计（${collected.stored.entryCount} 笔 / ${collected.stored.totalCents} 分）与明细复算（${collected.computed.entryCount} 笔 / ${collected.computed.totalCents} 分）不一致`,
      })
    }
  }

  if (collected.computed.entryCount === 0 && !collected.narrowed) {
    items.push({
      reason: 'empty_period',
      severity: 'low',
      entryId: null,
      sourceDisplayNo: null,
      detail: '该期间没有任何流水，锁定前请确认不是漏记',
    })
  }

  // L2: facts recorded after the lock whose business date falls inside the
  // frozen period. They are *inside* the period but *outside* the statement, so
  // they must be visible. Reported even when narrowed, because the fact that a
  // statement can no longer absorb them does not depend on who is looking.
  for (const entry of collected.lateRecorded) {
    items.push({
      reason: 'late_recorded_after_lock',
      severity: 'medium',
      entryId: entry.entryId,
      sourceDisplayNo: entry.sourceDisplayNo,
      detail: `该流水发生在已锁定期间（${periodFrom} ~ ${periodTo}）内，但在批次锁定后才补录，未计入批次合计；请补冲正或并入下一期间`,
    })
  }

  return {
    batchId: batch?.id ?? null,
    batchNo: batch?.batchNo ?? null,
    status: batch?.status ?? null,
    periodFrom,
    periodTo,
    stored: collected.stored,
    computed: collected.computed,
    items,
    summary: {
      total: items.length,
      low: items.filter((item) => item.severity === 'low').length,
      medium: items.filter((item) => item.severity === 'medium').length,
      high: items.filter((item) => item.severity === 'high').length,
    },
    lateRecordedCount: collected.lateRecorded.length,
    lateRecordedTotalCents: collected.lateRecorded.reduce(
      (total, entry) => total + entry.amountCents,
      0,
    ),
    asOf,
  }
}

/* -------------------------------------------------------------------------- */
/* CSV export                                                                 */
/* -------------------------------------------------------------------------- */

export interface ReconciliationCsvOptions {
  /** The exporting operator; required because an unaudited export is not allowed. */
  actor: LedgerActor
  batchId?: string
  periodFrom?: string
  periodTo?: string
  communityId?: string
  now?: Date
}

export interface ReconciliationCsv {
  filename: string
  /** The complete file text: BOM + header + rows, `\r\n` terminated. */
  body: string
  rowCount: number
  batchId: string | null
  batchNo: string | null
  filters: Record<string, string>
  /**
   * Facts of the same period recorded after the lock. They are **not** in
   * `body` (the file is the statement, and the statement does not move), but the
   * caller must surface this count so the operator knows the export and the
   * period are not the same population (L2).
   */
  lateRecordedCount: number
  lateRecordedTotalCents: number
  generatedAt: string
}

/**
 * Builds the reconciliation CSV and records the export in `audit_logs`.
 *
 * This is the **only** non-JSON response in the API. Every other endpoint ends
 * in `c.json(schema.parse(...))` so the contract is enforced on the way out; a
 * CSV cannot be parsed by a zod response schema, so this module returns plain
 * text and the route (t9) must set the headers itself (`text/csv; charset=utf-8`,
 * `Content-Disposition`) and must NOT wrap it in `c.json`. The fixed column set
 * is machine-checked by the unit test instead of by zod.
 *
 * Rules:
 * - UTF-8 BOM (`\uFEFF`) so Excel on Windows opens it as UTF-8, not GBK;
 * - CRLF line endings, every row (including the last) terminates with `\r\n`;
 * - RFC 4180 quoting: `"` doubled, fields with `,` / `"` / CR / LF quoted;
 * - money is `(cents / 100).toFixed(2)`, never a float sum;
 * - business dates/times are rendered in Asia/Shanghai (`YYYY-MM-DD HH:mm:ss`);
 * - phone numbers are masked (`138****8000`) in every text cell;
 * - the export itself is audited (`ledger.export.csv`), because a file that
 *   leaves the back office must be attributable to a person;
 * - facts recorded after the lock are **not** in the file (the file is the
 *   statement) and are reported through `lateRecordedCount` /
 *   `lateRecordedTotalCents` and the audit metadata instead of vanishing (L2).
 *
 * The row population comes from the very same `collectEntryViews` used by
 * `getBatchEntries`, so the CSV, the batch page and `entry_count`/`total_cents`
 * can never tell three different stories (文档 §10 硬要求).
 */
export function buildReconciliationCsv(
  db: AppDatabase,
  options: ReconciliationCsvOptions,
): ReconciliationCsv {
  const { actor } = options
  requireBackOffice(actor)
  const now = options.now ?? new Date()
  if (options.communityId) {
    // Asking for a community outside your scope is a 403, never a silently
    // empty file (same rule as the ledger list).
    assertCommunityAccess(db, actor, options.communityId)
  }

  const collected = collectEntryViews(db, {
    ...(options.batchId === undefined ? {} : { batchId: options.batchId }),
    ...(options.periodFrom === undefined ? {} : { periodFrom: options.periodFrom }),
    ...(options.periodTo === undefined ? {} : { periodTo: options.periodTo }),
    ...(options.communityId === undefined ? {} : { communityId: options.communityId }),
    scope: scopeCommunityIds(db, actor),
  })

  if (collected.entries.length > RECONCILIATION_CSV_MAX_ROWS) {
    throw new LocalError(
      400,
      API_ERROR_CODES.invalidRequest,
      `导出范围过大（超过 ${RECONCILIATION_CSV_MAX_ROWS} 行），请指定对账批次或缩小期间`,
    )
  }

  const lines: string[] = [RECONCILIATION_CSV_HEADERS.map((header) => csvCell(header)).join(',')]
  for (const entry of collected.entries) {
    const anomalyText = entry.anomalies
      .map(
        (anomaly) => `${ANOMALY_KIND_LABELS[anomaly.kind] ?? anomaly.kind}(${anomaly.severity})`,
      )
      .join('; ')
    const cells = [
      entry.entryId,
      SOURCE_SYSTEM_LABELS[entry.sourceSystem],
      entry.sourceDisplayNo,
      FACT_KIND_LABELS[entry.factKind],
      formatShanghaiDateTime(new Date(entry.occurredAt)),
      entry.verifiedAt === null ? '' : formatShanghaiDateTime(new Date(entry.verifiedAt)),
      entry.communityName ?? entry.communityId,
      entry.attributedStaffName ?? (entry.attributedStaffId === null ? '' : entry.attributedStaffId),
      ATTRIBUTION_STATE_LABELS[entry.attributionState],
      (entry.amountCents / 100).toFixed(2),
      SETTLEMENT_LABELS[entry.settlementAmountStatus],
      entry.evidenceRef ?? '',
      entry.batchNo ?? '',
      anomalyText,
    ]
    lines.push(cells.map((cell) => csvCell(cell)).join(','))
  }

  const body = `\uFEFF${lines.join('\r\n')}\r\n`
  const batchNo = collected.batch?.batchNo ?? null
  const filename = `ledger-reconciliation-${batchNo ?? 'unbatched'}-${formatShanghaiStamp(now)}.csv`
  const filters: Record<string, string> = {}
  if (options.batchId) filters.batchId = options.batchId
  if (options.periodFrom) filters.periodFrom = options.periodFrom
  if (options.periodTo) filters.periodTo = options.periodTo
  if (options.communityId) filters.communityId = options.communityId

  // The audit row is written after the file text exists: an export that fails
  // to build must not leave an audit entry claiming a file nobody received.
  const lateRecordedTotalCents = collected.lateRecorded.reduce(
    (total, entry) => total + entry.amountCents,
    0,
  )
  db.transaction((tx) => {
    insertAudit(tx, actor.userId, 'ledger.export.csv', collected.batch?.id ?? 'unbatched', now, {
      rows: String(collected.entries.length),
      filters: JSON.stringify(filters),
      // L2 must be auditable too: the file does not contain these facts, so the
      // export record says how many were left out and why.
      lateRecordedCount: String(collected.lateRecorded.length),
      lateRecordedTotalCents: String(lateRecordedTotalCents),
    })
  })

  return {
    filename,
    body,
    rowCount: collected.entries.length,
    batchId: collected.batch?.id ?? null,
    batchNo,
    filters,
    lateRecordedCount: collected.lateRecorded.length,
    lateRecordedTotalCents,
    generatedAt: now.toISOString(),
  }
}
