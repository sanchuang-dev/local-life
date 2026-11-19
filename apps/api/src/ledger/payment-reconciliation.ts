import { sql, type SQL } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  paymentDifferenceSchema,
  paymentDifferencesResponseSchema,
  type PaymentDifference,
  type PaymentDifferencesQuery,
  type PaymentDifferencesResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  assertCommunityAccess, scopeCommunityIds, LocalError, type LocalActor,
} from '../local/shared.js'
import { shanghaiDayEndExclusiveMs, shanghaiDayStartMs, toShanghaiBusinessDate } from './shared.js'
import { getAdminLocalOrderDetail } from '../local/admin-payment-read.js'

/** PAY-09: SQL-derived local payment reconciliation, no mutable state or second ledger. */
interface RawFact {
  intent_id: string
  order_id: string
  merchant_order_no: string
  community_id: string
  source: 'mock' | 'wechat_jsapi' | 'zero_amount'
  simulated: number
  payment_status: string
  order_status: string
  reason: PaymentDifference['reason']
  created_at: number
  net_amount_cents: number
  completion_amount_cents: number | null
  ledger_amount_cents: number | null
}

function factCte(db: AppDatabase, actor: LocalActor, q: PaymentDifferencesQuery, now: Date, intentId?: string): SQL {
  const scoped = scopeCommunityIds(db, actor)
  if (q.communityId) assertCommunityAccess(db, actor, q.communityId)
  const conditions: SQL[] = []
  if (scoped !== null) {
    conditions.push(scoped.length ? sql`pi.community_id IN (${sql.join(scoped.map((v) => sql`${v}`), sql`, `)})` : sql`0 = 1`)
  }
  if (q.communityId) conditions.push(sql`pi.community_id = ${q.communityId}`)
  if (q.from) conditions.push(sql`pi.created_at >= ${shanghaiDayStartMs(q.from)}`)
  if (q.to) conditions.push(sql`pi.created_at < ${shanghaiDayEndExclusiveMs(q.to)}`)
  if (intentId) conditions.push(sql`pi.id = ${intentId}`)
  if (q.source !== 'all') {
    if (q.source === 'zero_amount') conditions.push(sql`pi.kind = 'zero_amount'`)
    else conditions.push(sql`pi.channel = ${q.source}`)
  }
  return sql`
    WITH facts AS (
      SELECT
        pi.id AS intent_id,
        pi.local_order_id AS order_id,
        pi.merchant_order_no AS merchant_order_no,
        pi.community_id AS community_id,
        CASE WHEN pi.kind = 'zero_amount' THEN 'zero_amount' ELSE pi.channel END AS source,
        pi.simulated AS simulated,
        pi.status AS payment_status,
        lo.status AS order_status,
        pi.created_at AS created_at,
        pi.net_payable_cents AS net_amount_cents,
        co.amount_cents AS completion_amount_cents,
        co.simulated AS completion_simulated,
        (SELECT SUM(le.amount_cents)
           FROM ledger_entry_sources les JOIN ledger_entries le ON le.id = les.entry_id
          WHERE les.source_system = 'online_payment'
            AND les.source_id = co.id AND les.fact_kind = 'payment_received'
        ) AS ledger_amount_cents,
        (SELECT COUNT(*)
           FROM ledger_entry_sources les JOIN ledger_entries le ON le.id = les.entry_id
          WHERE les.source_system = 'online_payment'
            AND les.source_id = co.id AND les.fact_kind = 'payment_received'
            AND le.simulated <> pi.simulated
        ) AS wrong_ledger_kind,
        (SELECT COUNT(*) FROM payment_attempts pa
          WHERE pa.payment_intent_id = pi.id AND pa.status = 'paid'
            AND pa.provider_transaction_id IS NOT NULL
        ) AS paid_attempts,
        (SELECT COUNT(*) FROM payment_review_exceptions pre
          WHERE pre.payment_intent_id = pi.id AND pre.status <> 'resolved'
        ) AS review_exceptions,
        (SELECT COUNT(*) FROM payment_review_exceptions pre
          WHERE pre.payment_intent_id = pi.id AND pre.status <> 'resolved'
            AND pre.kind = 'amount_mismatch'
        ) AS amount_exceptions,
        (SELECT COUNT(*) FROM local_order_online_conflicts lc
          WHERE lc.local_order_id = pi.local_order_id AND lc.status <> 'resolved'
        ) AS online_conflicts,
        (SELECT COUNT(*) FROM (
          SELECT pe.provider_event_ref FROM payment_events pe
          WHERE pe.payment_intent_id = pi.id
            AND pe.source = 'channel'
            AND pe.provider_event_ref IS NOT NULL
            AND pe.event_type IN ('payment.channel_notification', 'payment.channel_query')
          -- A notification and a later active query of the same transaction are
          -- two legitimate kinds of observation; only repeats within the SAME
          -- event kind should be flagged as duplicate evidence.
          GROUP BY pe.event_type, pe.provider_event_ref HAVING COUNT(*) > 1
        )) AS repeated_channel_events,
        (SELECT COUNT(*) FROM ledger_payment_order_links mpl
          JOIN ledger_entries ml ON ml.id = mpl.entry_id
          WHERE mpl.order_id = pi.local_order_id
            AND ml.fact_kind = 'payment_received' AND ml.source_system = 'manual'
            AND NOT EXISTS (
              SELECT 1 FROM ledger_entries reversal
              WHERE reversal.counter_entry_id = ml.id AND reversal.fact_kind = 'payment_reversed'
            )
        ) AS active_manual_receipts,
        (SELECT COUNT(*) FROM wechat_pay_prepay_attempts pp
          WHERE pp.payment_intent_id = pi.id AND pp.status IN ('requesting','uncertain')
        ) AS uncertain_prepays,
        (SELECT rc.operation FROM wechat_pay_recovery_checks rc
          WHERE rc.payment_intent_id = pi.id
          ORDER BY rc.created_at DESC, rc.rowid DESC LIMIT 1
        ) AS last_recovery_operation,
        (SELECT rc.result FROM wechat_pay_recovery_checks rc
          WHERE rc.payment_intent_id = pi.id
          ORDER BY rc.created_at DESC, rc.rowid DESC LIMIT 1
        ) AS last_recovery_result,
        (SELECT rc.detail_code FROM wechat_pay_recovery_checks rc
          WHERE rc.payment_intent_id = pi.id
          ORDER BY rc.created_at DESC, rc.rowid DESC LIMIT 1
        ) AS last_recovery_detail,
        pi.expires_at AS expires_at
      FROM payment_intents pi
      JOIN local_orders lo ON lo.id = pi.local_order_id
      LEFT JOIN local_order_online_completions co ON co.payment_intent_id = pi.id
      ${conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``}
    ),
    classified AS (
      SELECT *,
        CASE
          WHEN amount_exceptions > 0 THEN 'amount_mismatch'
          WHEN review_exceptions > 0 OR online_conflicts > 0 THEN 'provider_exception'
          WHEN last_recovery_result IN ('uncertain','request_sent')
            OR (last_recovery_operation = 'post_close_query'
                AND last_recovery_detail NOT IN ('CLOSED','REVOKED'))
            THEN 'provider_exception'
          WHEN repeated_channel_events > 0 THEN 'duplicate_provider_event'
          WHEN payment_status = 'paid' AND active_manual_receipts > 0 THEN 'manual_online_conflict'
          WHEN completion_amount_cents IS NOT NULL
             AND (completion_amount_cents <> net_amount_cents
               OR completion_simulated <> simulated
               OR (ledger_amount_cents IS NOT NULL AND ledger_amount_cents <> completion_amount_cents)
               OR wrong_ledger_kind > 0)
            THEN 'amount_mismatch'
          WHEN payment_status = 'paid' AND source <> 'zero_amount'
             AND paid_attempts = 0 THEN 'channel_evidence_missing'
          WHEN payment_status = 'paid' AND completion_amount_cents IS NULL THEN 'paid_not_projected'
          WHEN payment_status = 'paid' AND source <> 'zero_amount'
             AND ledger_amount_cents IS NULL THEN 'ledger_missing'
          WHEN (payment_status = 'paid' AND order_status <> 'online_completed')
             OR (payment_status <> 'paid' AND completion_amount_cents IS NOT NULL)
            THEN 'order_state_conflict'
          WHEN payment_status IN ('pending','confirming') AND uncertain_prepays > 0
            THEN 'outbound_uncertain'
          WHEN payment_status IN ('pending','confirming') AND expires_at <= ${now.getTime()}
            THEN 'confirmation_timeout'
          WHEN payment_status IN ('pending','confirming') THEN 'awaiting_payment'
          ELSE 'local_consistent'
        END AS reason
      FROM facts
    )`
}

function classificationFilter(q: PaymentDifferencesQuery): SQL {
  const conditions: SQL[] = []
  if (q.reason) conditions.push(sql`reason = ${q.reason}`)
  if (q.status === 'difference') conditions.push(sql`reason NOT IN ('local_consistent','awaiting_payment')`)
  if (q.status === 'consistent') conditions.push(sql`reason = 'local_consistent'`)
  if (q.status === 'awaiting') conditions.push(sql`reason = 'awaiting_payment'`)
  return conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``
}

function toDifference(raw: RawFact): PaymentDifference {
  const status: PaymentDifference['status'] =
    raw.reason === 'local_consistent' ? 'consistent'
      : raw.reason === 'awaiting_payment' ? 'awaiting' : 'difference'
  return paymentDifferenceSchema.parse({
    intentId: raw.intent_id,
    orderId: raw.order_id,
    merchantOrderNo: raw.merchant_order_no,
    communityId: raw.community_id,
    source: raw.source,
    simulated: Boolean(raw.simulated),
    paymentStatus: raw.payment_status,
    orderStatus: raw.order_status,
    reason: raw.reason,
    status,
    businessDate: toShanghaiBusinessDate(new Date(raw.created_at)),
    createdAt: new Date(raw.created_at).toISOString(),
    netAmountCents: raw.net_amount_cents,
    completionAmountCents: raw.completion_amount_cents,
    ledgerAmountCents: raw.ledger_amount_cents,
    bankSettlement: 'unverified',
    channelBill: 'not_connected',
  })
}

const fields = sql`intent_id, order_id, merchant_order_no, community_id,
 source, simulated, payment_status, order_status, reason, created_at,
 net_amount_cents, completion_amount_cents, ledger_amount_cents`

function rawRows(
  db: AppDatabase, actor: LocalActor, q: PaymentDifferencesQuery, now: Date,
  limit: number, offset: number, intentId?: string,
): RawFact[] {
  const cte = factCte(db, actor, q, now, intentId)
  const where = classificationFilter(q)
  return db.all(sql`${cte}
    SELECT ${fields} FROM classified ${where}
    ORDER BY created_at DESC, intent_id DESC LIMIT ${limit} OFFSET ${offset}
  `) as RawFact[]
}

export function listPaymentDifferences(
  db: AppDatabase, actor: LocalActor, q: PaymentDifferencesQuery, now = new Date(),
): PaymentDifferencesResponse {
  const cte = factCte(db, actor, q, now)
  const where = classificationFilter(q)
  const count = db.get(sql`${cte} SELECT COUNT(*) AS total FROM classified ${where}`) as { total: number } | undefined
  const rows = rawRows(db, actor, q, now, q.pageSize, (q.page - 1) * q.pageSize)
  return paymentDifferencesResponseSchema.parse({
    items: rows.map(toDifference), total: count?.total ?? 0,
    page: q.page, pageSize: q.pageSize, asOf: now.toISOString(),
  })
}

export function paymentDifferenceDetail(
  db: AppDatabase, actor: LocalActor, intentId: string, now = new Date(),
) {
  const q: PaymentDifferencesQuery = { page: 1, pageSize: 1, status: 'all', source: 'all' }
  const raw = rawRows(db, actor, q, now, 1, 0, intentId)[0]
  if (!raw) throw new LocalError(404, API_ERROR_CODES.notFound, '支付核对记录不存在')
  // Scope was already enforced by rawRows, including the 404 privacy guard.
  // Expose the minimal audit reason/time, never raw response bodies or hashes.
  const recoveryChecks = db.all(sql`
    SELECT operation, result, detail_code AS detailCode, created_at AS createdAt
    FROM wechat_pay_recovery_checks
    WHERE payment_intent_id = ${intentId}
    ORDER BY created_at DESC, rowid DESC LIMIT 20
  `) as Array<{
    operation: 'query' | 'close' | 'post_close_query'
    result: 'verified' | 'uncertain' | 'request_sent'
    detailCode: string
    createdAt: number
  }>
  return {
    ...toDifference(raw), asOf: now.toISOString(),
    order: getAdminLocalOrderDetail(db, actor, raw.order_id),
    recoveryChecks: recoveryChecks.map((item) => ({
      operation: item.operation, result: item.result,
      detailCode: item.detailCode,
      createdAt: new Date(item.createdAt).toISOString(),
    })),
  }
}

export const PAYMENT_CSV_MAX_ROWS = 5000
const CSV_COLUMNS = [
  '支付单ID','订单ID','商户订单号','社区ID','业务日期(北京时间)','来源',
  '模拟支付','支付状态','订单状态','核对结果','差异类型','净应付(分)',
  '订单完成金额(分)','线上流水金额(分)','微信渠道账单','银行结算',
] as const
function csvCell(value: string | number | null): string {
  let valueText = value === null ? '' : String(value)
  if (/^[\s\uFEFF]*[=+\-@]/u.test(valueText) || /^[\t\r\n]/u.test(valueText)) {
    valueText = "'" + valueText
  }
  return '"' + valueText.replace(/"/gu, '""') + '"'
}
export function paymentDifferencesCsv(
  db: AppDatabase, actor: LocalActor, q: PaymentDifferencesQuery, now = new Date(),
): { content: string; rows: number } {
  const rows = rawRows(db, actor, q, now, PAYMENT_CSV_MAX_ROWS + 1, 0)
  if (rows.length > PAYMENT_CSV_MAX_ROWS) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '数据超过 5000 行，请缩小业务日期或社区范围后导出')
  }
  const lines = [CSV_COLUMNS.map(csvCell).join(',')]
  for (const row of rows.map(toDifference)) {
    lines.push([
      row.intentId, row.orderId, row.merchantOrderNo, row.communityId, row.businessDate,
      row.source, row.simulated ? '仅测试' : '非模拟', row.paymentStatus, row.orderStatus,
      row.status, row.reason, row.netAmountCents, row.completionAmountCents,
      row.ledgerAmountCents, '未接入微信渠道账单', '未核实',
    ].map(csvCell).join(','))
  }
  return { content: '\uFEFF' + lines.join('\r\n') + '\r\n', rows: rows.length }
}
