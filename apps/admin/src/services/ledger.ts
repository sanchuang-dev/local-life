import {
  LEDGER_ROUTES,
  apiErrorSchema,
  createBatchRequestSchema,
  ledgerAnomalyListResponseSchema,
  ledgerListResponseSchema,
  ledgerOverviewSchema,
  lockBatchRequestSchema,
  reconciliationBatchEntriesResponseSchema,
  reconciliationBatchListResponseSchema,
  reconciliationBatchSchema,
  reconciliationDiffSchema,
  type CreateBatchRequest,
  type LedgerAnomaly,
  type LedgerAnomalyKind,
  type LedgerAnomalyListResponse,
  type LedgerAnomalySeverity,
  type LedgerAttributionBasis,
  type LedgerAttributionState,
  type LedgerEvidenceKind,
  type LedgerFactKind,
  type LedgerListQuery,
  type LedgerListResponse,
  type LedgerOverview,
  type LedgerOverviewQuery,
  type LedgerReconciliationState,
  type LedgerSourceSystem,
  type LockBatchRequest,
  type ReconciliationBatch,
  type ReconciliationBatchEntriesResponse,
  type ReconciliationBatchListResponse,
  type ReconciliationDiff,
  type SettlementAmountStatus,
} from '@sanchuang-dev/local-life-contracts'
import {
  LocalApiError,
  fillRoute,
  parsePayload,
  requestLocalJson,
  withQuery,
} from './localApi'

/**
 * Back-office transport for the operating ledger (LL-MVP-008, Issue #64).
 *
 * Every JSON call goes through `requestLocalJson`, so the response is *parsed by
 * the shared contract* before a page sees it and a real 400/401/403/409/404 keeps
 * its status + server message. URLs are always built from `LEDGER_ROUTES`; no
 * path string is written twice.
 *
 * Money rule for every screen that consumes this module: `*Cents` is an integer
 * amount in 分 and is **账面登记毛额（不是应付）**. This MVP has no settlement
 * rule, so `settlementAmountStatus` is `pending_rule` and no page may derive a
 * payable / distribution / payout figure from these numbers.
 */

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The overview accepts only the scope/time narrowings the server implements.
 * Sending anything else would be a `400` (the contract query is a strictObject),
 * so the page cannot silently filter a report that the server ignored.
 */
export type LedgerOverviewFilters = Pick<
  LedgerOverviewQuery,
  'from' | 'to' | 'communityId' | 'staffId'
>

/**
 * The list query. `anomalyOnly` is optional on the *input* side even though the
 * parsed contract value always carries a boolean: the page only sends the flag
 * when a human switched it on.
 */
export type LedgerEntryQuery = Omit<LedgerListQuery, 'anomalyOnly'> & {
  anomalyOnly?: boolean
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** GET /admin/ledger/overview — per-fact-kind aggregates + report `asOf`. */
export async function getLedgerOverview(
  filters: LedgerOverviewFilters,
  signal?: AbortSignal,
): Promise<LedgerOverview> {
  const payload = await requestLocalJson(
    withQuery(`/api${LEDGER_ROUTES.adminOverview}`, {
      from: filters.from,
      to: filters.to,
      communityId: filters.communityId,
      staffId: filters.staffId,
    }),
    { signal },
  )
  return parsePayload(ledgerOverviewSchema, payload, '经营流水总览')
}

/**
 * GET /admin/ledger/entries — server-side paging and filtering.
 *
 * The contract fixes the ordering (`occurredAt DESC, createdAt DESC, id DESC`)
 * and has no sort parameter, so the page never re-sorts a page locally and never
 * sums the returned rows into a "total": the only totals on screen come from the
 * overview endpoint.
 */
export async function listLedgerEntries(
  query: LedgerEntryQuery,
  signal?: AbortSignal,
): Promise<LedgerListResponse> {
  const payload = await requestLocalJson(
    withQuery(`/api${LEDGER_ROUTES.adminEntries}`, {
      page: query.page,
      pageSize: query.pageSize,
      from: query.from,
      to: query.to,
      communityId: query.communityId,
      staffId: query.staffId,
      factKind: query.factKind,
      productId: query.productId,
      sourceSystem: query.sourceSystem,
      // Sent only when switched on: an explicit `false` would be noise a reader
      // could mistake for a supported filter value.
      anomalyOnly: query.anomalyOnly === true ? 'true' : undefined,
      keyword: query.keyword,
    }),
    { signal },
  )
  return parsePayload(ledgerListResponseSchema, payload, '经营流水明细')
}

/**
 * GET /admin/ledger/anomalies — unresolved anomalies only (the server returns
 * `resolvedAt IS NULL`, capped at 200). There is no per-entry anomaly endpoint,
 * so the entry drawer groups this bounded list by `entryId` locally instead of
 * inventing a second request or a second count.
 */
export async function listLedgerAnomalies(signal?: AbortSignal): Promise<LedgerAnomaly[]> {
  const payload = await requestLocalJson(`/api${LEDGER_ROUTES.adminAnomalies}`, { signal })
  const parsed = parsePayload<LedgerAnomalyListResponse>(
    ledgerAnomalyListResponseSchema,
    payload,
    '未解决异常',
  )
  return parsed.items
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * GET /admin/reconciliation/batches — the whole (capped) batch list.
 *
 * Reconciliation periods are global, so this endpoint takes no query parameters
 * at all: the page must not invent paging or filtering that the server cannot
 * honour.
 */
export async function listReconciliationBatches(
  signal?: AbortSignal,
): Promise<ReconciliationBatchListResponse> {
  const payload = await requestLocalJson(`/api${LEDGER_ROUTES.adminBatches}`, { signal })
  return parsePayload(reconciliationBatchListResponseSchema, payload, '对账批次列表')
}

/**
 * GET /admin/reconciliation/batches/:batchId/entries — the batch's **frozen**
 * members, paged.
 *
 * `items` deliberately excludes facts recorded after the lock (`createdAt >
 * lockedAt`): they are not part of a frozen statement. Their count and amount are
 * reported by {@link getReconciliationDiff} (`lateRecorded*`), so this list must
 * never be presented as "every fact of the period".
 */
export async function listReconciliationBatchEntries(
  batchId: string,
  page: { page: number; pageSize: number },
  signal?: AbortSignal,
): Promise<ReconciliationBatchEntriesResponse> {
  const payload = await requestLocalJson(
    withQuery(
      `/api${fillRoute(LEDGER_ROUTES.adminBatchEntries, ':batchId', batchId)}`,
      { page: page.page, pageSize: page.pageSize },
    ),
    { signal },
  )
  return parsePayload(reconciliationBatchEntriesResponseSchema, payload, '对账批次明细')
}

/**
 * GET /admin/reconciliation/diff?batchId=… — what still needs a human.
 *
 * The diff is the *complement* of the derived batch membership: facts of the
 * period that no `locked` batch covers (`unbatched*`, 待办) plus the facts of a
 * locked period recorded after the lock (`lateRecorded*`, 既成事实) plus the open
 * anomalies. The two counts are disjoint by construction; the page shows them
 * side by side and **never adds them together**.
 */
export async function getReconciliationDiff(
  batchId: string,
  signal?: AbortSignal,
): Promise<ReconciliationDiff> {
  const payload = await requestLocalJson(
    withQuery(`/api${LEDGER_ROUTES.adminDiff}`, { batchId }),
    { signal },
  )
  return parsePayload(reconciliationDiffSchema, payload, '对账差异')
}

/**
 * POST /admin/reconciliation/batches — opens a batch for a business-day period.
 *
 * The body carries no community, total or entry count: the server derives all of
 * them, so a client can neither pre-seed a total nor widen the period.
 */
export async function createReconciliationBatch(
  csrfToken: string,
  request: CreateBatchRequest,
): Promise<ReconciliationBatch> {
  const body = createBatchRequestSchema.parse(request)
  const payload = await requestLocalJson(`/api${LEDGER_ROUTES.adminBatches}`, {
    method: 'POST',
    csrfToken,
    body,
  })
  return parsePayload(reconciliationBatchSchema, payload, '对账批次创建结果')
}

/**
 * POST /admin/reconciliation/batches/:batchId/lock — freezes a statement.
 *
 * `expectedUpdatedAt` is the shared optimistic-concurrency token: locking a stale
 * view is a `409` (`conflict`) and locking twice is a `409`
 * (`ledger_batch_locked`) — never a silent second success. The page must show the
 * server's answer and refresh, not retry on its own.
 */
export async function lockReconciliationBatch(
  csrfToken: string,
  batchId: string,
  request: LockBatchRequest,
): Promise<ReconciliationBatch> {
  const body = lockBatchRequestSchema.parse(request)
  const payload = await requestLocalJson(
    `/api${fillRoute(LEDGER_ROUTES.adminBatchLock, ':batchId', batchId)}`,
    { method: 'POST', csrfToken, body },
  )
  return parsePayload(reconciliationBatchSchema, payload, '对账批次锁定结果')
}

/* -------------------------------------------------------------------------- */
/* CSV download channel (the repo's first non-JSON response)                   */
/* -------------------------------------------------------------------------- */

/**
 * Why this cannot reuse `requestLocalJson`:
 *
 * `requestLocalJson` ends with `await response.json()`. The reconciliation export
 * is a `text/csv` attachment (UTF-8 BOM + CRLF + RFC 4180 quoting), so piping it
 * through that helper would throw on a perfectly good file, and — worse — a
 * "helpful" fallback that parsed the error envelope as data would let an error
 * document be saved as a `.csv`. This module therefore owns the only
 * `response.blob()` call in the admin app:
 *
 * 1. `fetch(…, { credentials:'include', headers:{ accept:'text/csv' } })` — the
 *    same-origin cookie is sent explicitly, because a raw `fetch` has none of the
 *    helper's defaults;
 * 2. non-2xx (and any `200` whose body is not a file) → read the body as text,
 *    parse the shared `{ error: { code, message } }` envelope and throw a real
 *    `LocalApiError`, so the operator sees 401/403/404/400 instead of a broken
 *    download;
 * 3. filename from `Content-Disposition` (`filename*=UTF-8''…` first, then
 *    `filename="…"`), sanitised, with a deterministic `ledger-<date>.csv` default;
 * 4. `URL.createObjectURL` + a temporary `<a download>` + `revokeObjectURL`, in a
 *    helper that also works under jsdom (no `createObjectURL` → nothing to hand
 *    to the OS, so tests can still assert the request URL and the parsed name).
 */
/**
 * The export accepts exactly one narrowing: a batch id. The route's query set is
 * owned by `apps/api` and was confirmed as `?batchId=<uuid>` or no parameters at
 * all; sending an unconfirmed `periodFrom`/`communityId` to a strict query parse
 * would be a `400`, so this client does not invent the ability to export an
 * arbitrary slice. "Nothing selected" therefore means the documented whole-period
 * export, and the page words it as such.
 */
export interface LedgerCsvQuery {
  /** Export exactly one batch's frozen members. Omitted = the server's full export. */
  batchId?: string
}

/**
 * What the response said about the file it produced.
 *
 * `lateRecorded*` is the pair the UI must mention after a *batch* export: the
 * frozen statement cannot contain facts recorded after the lock, so a file that
 * silently omitted them would look complete. The header names are ASCII and the
 * API exposes them through `Access-Control-Expose-Headers`; a missing header is
 * `null` (older server / proxy stripped it) and the page then says less, never
 * more.
 */
export interface LedgerCsvResult {
  /** File name taken from the server response, or the deterministic fallback. */
  filename: string
  byteLength: number
  contentType: string | null
  /** `X-Ledger-Row-Count`: data rows in the file, or `null` when not reported. */
  rowCount: number | null
  lateRecordedCount: number | null
  lateRecordedTotalCents: number | null
}

export interface LedgerCsvOptions {
  signal?: AbortSignal
  /** Test seam: capture the blob instead of touching the DOM/OS download. */
  save?: (blob: Blob, filename: string) => void
}

/** GET /admin/reconciliation/export.csv — audited, redacted, Excel-friendly CSV. */
export async function downloadLedgerCsv(
  query: LedgerCsvQuery = {},
  options: LedgerCsvOptions = {},
): Promise<LedgerCsvResult> {
  const path = withQuery(`/api${LEDGER_ROUTES.adminExportCsv}`, {
    batchId: query.batchId,
  })

  let response: Response
  try {
    response = await fetch(path, {
      method: 'GET',
      credentials: 'include',
      signal: options.signal,
      headers: { accept: 'text/csv' },
    })
  } catch (cause) {
    if (options.signal?.aborted) throw cause
    throw new LocalApiError(0, 'network_error', '无法连接管理后台 API，导出未开始。')
  }

  if (!response.ok) throw await csvFailure(response)

  const contentType = response.headers.get('content-type')
  // A 200 carrying JSON is the error envelope, not a file. Saving it as `.csv`
  // would hand the operator an unreadable "success".
  if (contentType !== null && /json/iu.test(contentType)) {
    throw await csvFailure(response)
  }

  const blob = await response.blob()
  const filename =
    filenameFromDisposition(response.headers.get('content-disposition')) ??
    defaultCsvFilename(new Date())
  const save = options.save ?? saveBlob
  save(blob, filename)
  return {
    filename,
    byteLength: blob.size,
    contentType,
    rowCount: headerCount(response.headers, 'x-ledger-row-count'),
    lateRecordedCount: headerCount(response.headers, 'x-ledger-late-recorded-count'),
    lateRecordedTotalCents: headerCount(response.headers, 'x-ledger-late-recorded-total-cents'),
  }
}

/** A `X-Ledger-*` counter header: a non-negative integer, or `null` if unusable. */
function headerCount(headers: Headers, name: string): number | null {
  const raw = headers.get(name)
  if (raw === null) return null
  const value = Number(raw.trim())
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** Reads a non-file response and turns it back into the shared error envelope. */
async function csvFailure(response: Response): Promise<LocalApiError> {
  const text = await response.text().catch(() => '')
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  const parsed = apiErrorSchema.safeParse(payload)
  if (parsed.success) {
    return new LocalApiError(response.status, parsed.data.error.code, parsed.data.error.message)
  }
  const trimmed = text.trim()
  return new LocalApiError(
    response.status,
    'http_error',
    trimmed.length > 0 && trimmed.length <= 200 && !/^\s*</u.test(trimmed)
      ? trimmed
      : `导出失败（HTTP ${response.status}）`,
  )
}

/** `Content-Disposition` → safe `*.csv` file name, or `null` when unusable. */
export function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/u.exec(disposition)
  const plain = /filename\s*=\s*"?([^";]+)"?/u.exec(disposition)
  const raw = extended?.[1] ?? plain?.[1]
  if (!raw) return null
  let decoded = raw.trim()
  if (extended?.[1]) {
    try {
      decoded = decodeURIComponent(raw.trim())
    } catch {
      decoded = raw.trim()
    }
  }
  // Strip any path component: a server- or proxy-supplied name must not be able
  // to steer the browser outside the downloads folder.
  const base = decoded.split(/[\\/]/u).pop() ?? ''
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-').trim()
  if (safe.length === 0) return null
  const withSuffix = /\.csv$/iu.test(safe) ? safe : `${safe}.csv`
  return withSuffix.slice(0, 120)
}

/**
 * Deterministic fallback name, in Asia/Shanghai (the ledger's business time zone)
 * so the file lines up with the period the operator just looked at.
 */
export function defaultCsvFilename(now: Date): string {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const date = shanghai.toISOString().slice(0, 10).replace(/-/gu, '')
  return `ledger-${date}.csv`
}

/**
 * Hands the file to the browser. Under jsdom `URL.createObjectURL` does not
 * exist; the guard keeps the page (and its tests) from throwing after a
 * successful, contracted response. Nothing is faked: the caller still receives
 * the real file name and byte length.
 */
export function saveBlob(blob: Blob, filename: string): void {
  if (typeof URL.createObjectURL !== 'function') return
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // Revoke on the next macrotask: revoking synchronously can cancel the
  // navigation in some browsers.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

/* -------------------------------------------------------------------------- */
/* Presentation constants + formatters                                        */
/* -------------------------------------------------------------------------- */

/*
 * Copy and formatting shared by 业绩看板 and 对账结算. They live here (rather than
 * in each page) so the two screens, the batch drawer and the CSV feedback can
 * never describe the same fact kind with two different words.
 *
 * Hard rule from the contract (§「没有结算规则就没有应付金额」): none of these
 * strings may claim a payment succeeded, a deal closed, a service was activated,
 * a settlement happened, or a commission is payable. The amounts are recorded
 * gross figures only.
 */

export const LEDGER_FACT_KIND_LABELS: Record<LedgerFactKind, string> = {
  order_registered: '登记金额',
  order_verified: '已核验业绩',
  payment_received: '人工实收',
  payment_reversed: '收款冲正',
  reward_cost: '奖励成本',
  reward_reversed: '奖励冲正',
}

/** One-line 口径 for each fact kind. Shown next to the KPI, never merged away. */
export const LEDGER_FACT_KIND_NOTES: Record<LedgerFactKind, string> = {
  order_registered: '居民下单时登记的账面金额；不是实收，也不代表业务已办理。',
  order_verified: '运营人工核验通过的订单事实；只计入业绩口径，不是付款凭据。',
  payment_received: '线下人工登记 · 含凭据（收据 / 转账 / CRM 确认）的实收；本 MVP 没有在线支付。',
  payment_reversed: '收款冲正单独成行，不从实收里静默抵扣。',
  reward_cost: '活动奖励履约的实际成本；不是营收，也不抵扣业绩。',
  reward_reversed: '奖励成本冲正单独成行。',
}

export const LEDGER_SOURCE_SYSTEM_LABELS: Record<LedgerSourceSystem, string> = {
  local_order: '本地订单',
  crm_service_order: '广电 CRM',
  activity_reward_grant: '奖励履约',
  manual: '人工登记',
}

export const LEDGER_ANOMALY_KIND_LABELS: Record<LedgerAnomalyKind, string> = {
  amount_mismatch: '金额不一致',
  attribution_conflict: '归属冲突',
  source_missing_evidence: '来源缺少凭据',
  duplicate_candidate: '疑似重复',
  period_gap: '期间缺口',
}

export const LEDGER_ANOMALY_SEVERITY_LABELS: Record<LedgerAnomalySeverity, string> = {
  low: '低',
  medium: '中',
  high: '高',
}

export const LEDGER_ATTRIBUTION_STATE_LABELS: Record<LedgerAttributionState, string> = {
  attributed: '已归属',
  pending: '待归属',
}

export const LEDGER_ATTRIBUTION_BASIS_LABELS: Record<LedgerAttributionBasis, string> = {
  explicit_attribution: '来源显式归属',
  confirmed_fact: '已确认的归属事实',
  no_explicit_attribution: '来源无归属信息',
  source_missing: '来源缺失',
}

export const LEDGER_EVIDENCE_KIND_LABELS: Record<LedgerEvidenceKind, string> = {
  manual_receipt: '人工收据',
  bank_transfer: '转账凭据',
  crm_confirmation: 'CRM 确认',
  order_verification: '订单核验记录',
  reward_grant: '奖励发放记录',
  none: '无凭据',
}

export const LEDGER_RECONCILIATION_STATE_LABELS: Record<LedgerReconciliationState, string> = {
  unreconciled: '未纳入批次',
  batched: '已进开放批次',
  reconciled: '已随批次锁定',
}

export const SETTLEMENT_AMOUNT_STATUS_LABELS: Record<SettlementAmountStatus, string> = {
  pending_rule: '待核定',
  estimated: '估算（人工确认）',
}

const AMOUNT_FORMATTER = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** Integer cents → `¥1,234.56`. Never a float sum, never a bare number. */
export function formatCents(cents: number): string {
  return `¥${AMOUNT_FORMATTER.format(Math.round(cents) / 100)}`
}

/** UTC instant → `YYYY-MM-DD HH:mm` in Asia/Shanghai (the ledger's time zone). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return DATE_TIME_FORMATTER.format(date).replace(/\//gu, '-')
}

/** Short form for dense table cells: `MM-DD HH:mm`. */
export function formatShortDateTime(iso: string | null | undefined): string {
  const formatted = formatDateTime(iso)
  return formatted.length >= 16 ? formatted.slice(5) : formatted
}

export { fillRoute, withQuery }
