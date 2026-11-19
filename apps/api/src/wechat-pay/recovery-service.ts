import { randomUUID, createHash } from 'node:crypto'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  type PaymentEvidence,
  paymentEvidenceSchema,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import { paymentIntents, wechatPayPrepayAttempts, wechatPayRecoveryChecks } from '../db/schema.js'
import { LocalError } from '../local/shared.js'
import { confirmTrustedPayment } from '../payments/confirmation.js'
import { runPaymentOutboxConsumer } from '../payments/outbox.js'
import { logEvent } from '../log.js'
import type { WechatPayRuntimeConfig } from './credentials.js'
import {
  queryWechatOrder,
  sendWechatCloseOrder,
} from './recovery-provider.js'
import { type VerifiedPaymentNotification } from './notification.js'

type Intent = typeof paymentIntents.$inferSelect
export type WechatRecoveryResult = {
  intentId: string
  outcome: 'paid' | 'closed' | 'failed' | 'pending' | 'uncertain' | 'needs_review'
  tradeState: string | null
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function trustedIntent(db: AppDatabase, runtime: WechatPayRuntimeConfig, id: string): Intent {
  const intent = db.select().from(paymentIntents).where(eq(paymentIntents.id, id)).get()
  if (!intent) throw new LocalError(404, API_ERROR_CODES.notFound, '支付单不存在')
  if (intent.kind !== 'channel' || intent.channel !== 'wechat_jsapi' ||
      intent.simulated || intent.merchantAppId !== runtime.appId ||
      intent.merchantId !== runtime.mchid || intent.netPayableCents <= 0) {
    throw new LocalError(409, API_ERROR_CODES.paymentNotPayable, '该支付单不是当前商户的真实微信支付单')
  }
  return intent
}

function audit(db: AppDatabase, intentId: string,
  operation: 'query' | 'close' | 'post_close_query',
  result: 'verified' | 'uncertain' | 'request_sent',
  detailCode: string,
  responseSha256: string | null,
  now: Date,
): void {
  db.insert(wechatPayRecoveryChecks).values({
    id: randomUUID(), paymentIntentId: intentId, operation, result, detailCode,
    responseSha256, createdAt: now,
  }).run()
}

export function confirmVerifiedWechatNotification(
  db: AppDatabase, runtime: WechatPayRuntimeConfig,
  verified: VerifiedPaymentNotification,
) {
  const transaction = verified.transaction
  if (transaction.appid !== runtime.appId || transaction.mchid !== runtime.mchid) {
    throw new LocalError(409, API_ERROR_CODES.paymentEvidenceRejected, '微信商户身份不匹配')
  }
  const evidence: PaymentEvidence = paymentEvidenceSchema.parse({
    merchantOrderNo: transaction.out_trade_no,
    channel: 'wechat_jsapi',
    providerStatus: 'paid',
    providerTransactionId: transaction.transaction_id,
    amountCents: transaction.amount.total,
    currency: 'CNY',
    merchantAppId: transaction.appid,
    merchantId: transaction.mchid,
    observedAt: verified.observedAt,
    source: 'notification',
    dedupeKey: 'WXN:' + verified.eventId,
    providerEventRef: verified.eventId,
    failureCode: null,
    failureMessage: null,
  })
  const result = confirmTrustedPayment(db, evidence)
  // PAY-03 committed the paid fact + durable outbox atomically. The callback
  // can be acknowledged regardless of a transient downstream consumer failure.
  if (result.intent.status === 'paid') {
    try { runPaymentOutboxConsumer(db) } catch {
      logEvent('wechat_pay.outbox_deferred', { paymentIntentId: result.intent.id })
    }
  }
  return result
}

/** Trusted provider evidence never bypasses PAY-03, even for close recovery. */
export async function checkWechatPayment(
  db: AppDatabase, runtime: WechatPayRuntimeConfig, intentId: string,
  options: { operation?: 'query' | 'post_close_query'; now?: Date; fetcher?: typeof fetch } = {},
): Promise<WechatRecoveryResult> {
  const intent = trustedIntent(db, runtime, intentId)
  const now = options.now ?? new Date()
  const operation = options.operation ?? 'query'
  const result = await queryWechatOrder({
    runtime, merchantOrderNo: intent.merchantOrderNo,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  })
  if (result.kind === 'uncertain') {
    audit(db, intent.id, operation, 'uncertain', result.reason, result.responseHash, now)
    return { intentId, outcome: 'uncertain', tradeState: null }
  }
  const txn = result.transaction
  if (txn.amount.total !== intent.netPayableCents) {
    // The trusted query may reveal a bad amount. Let PAY-03 preserve that
    // evidence as an immutable mismatch rather than deleting the anomaly.
    const mismatch: PaymentEvidence = paymentEvidenceSchema.parse({
      merchantOrderNo: intent.merchantOrderNo, channel: 'wechat_jsapi',
      providerStatus: txn.trade_state === 'SUCCESS' ? 'paid' : 'pending',
      providerTransactionId: txn.trade_state === 'SUCCESS' ? txn.transaction_id! : null,
      amountCents: txn.amount.total, currency: 'CNY',
      merchantAppId: txn.appid, merchantId: txn.mchid,
      observedAt: new Date(Number(result.responseTimestamp) * 1_000).toISOString(),
      source: 'query',
      dedupeKey: 'WXQ:' + sha256(result.responseTimestamp + ':' + result.responseNonce + ':' + result.responseHash),
      providerEventRef: txn.transaction_id ?? null, failureCode: null, failureMessage: null,
    })
    audit(db, intent.id, operation, 'uncertain', 'amount_mismatch', result.responseHash, now)
    confirmTrustedPayment(db, mismatch) // PAY-03 saves mismatch and throws 409.
    return { intentId, outcome: 'needs_review', tradeState: txn.trade_state }
  }

  if (txn.trade_state === 'REFUND') {
    audit(db, intent.id, operation, 'uncertain', 'refund_requires_manual_review', result.responseHash, now)
    return { intentId, outcome: 'needs_review', tradeState: 'REFUND' }
  }
  const status = txn.trade_state === 'SUCCESS' ? 'paid'
    : txn.trade_state === 'CLOSED' || txn.trade_state === 'REVOKED' ? 'closed'
      : txn.trade_state === 'PAYERROR' ? 'failed' : 'pending'
  const evidence: PaymentEvidence = paymentEvidenceSchema.parse({
    merchantOrderNo: txn.out_trade_no,
    channel: 'wechat_jsapi',
    providerStatus: status,
    providerTransactionId: status === 'paid' ? txn.transaction_id! : null,
    amountCents: txn.amount.total,
    currency: 'CNY',
    merchantAppId: txn.appid,
    merchantId: txn.mchid,
    observedAt: status === 'paid' ? txn.success_time!
      : new Date(Number(result.responseTimestamp) * 1_000).toISOString(),
    source: 'query',
    dedupeKey: 'WXQ:' + sha256(result.responseTimestamp + ':' + result.responseNonce + ':' + result.responseHash),
    providerEventRef: txn.transaction_id ?? null,
    failureCode: status === 'failed' ? 'PAYERROR' : null,
    failureMessage: null,
  })
  audit(db, intent.id, operation, 'verified', txn.trade_state, result.responseHash, now)
  const confirmed = confirmTrustedPayment(db, evidence)
  if (confirmed.intent.status === 'paid') {
    try { runPaymentOutboxConsumer(db) } catch {
      logEvent('wechat_pay.outbox_deferred', { paymentIntentId: confirmed.intent.id })
    }
  }
  return {
    intentId, tradeState: txn.trade_state,
    outcome: confirmed.intent.status === 'paid' ? 'paid'
      : confirmed.intent.status === 'closed' ? 'closed'
        : confirmed.intent.status === 'failed' ? 'failed' : 'pending',
  }
}

/**
 * A successful HTTP close is only a request acknowledgment. Closure requires
 * a second *verified* query. If NOTPAY was observed and the close call fails,
 * no terminal state is ever written, leaving retry/recovery safe.
 */
export async function closeAndVerifyWechatPayment(
  db: AppDatabase, runtime: WechatPayRuntimeConfig, intentId: string,
  options: { now?: Date; fetcher?: typeof fetch } = {},
): Promise<WechatRecoveryResult> {
  const intent = trustedIntent(db, runtime, intentId)
  const first = await checkWechatPayment(db, runtime, intentId, options)
  if (first.outcome !== 'pending' || first.tradeState !== 'NOTPAY') return first
  const now = options.now ?? new Date()
  const close = await sendWechatCloseOrder({
    runtime, merchantOrderNo: intent.merchantOrderNo,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  })
  audit(db, intent.id, 'close',
    close.kind === 'sent' ? 'request_sent' : 'uncertain',
    close.kind === 'sent' ? 'close_request_sent' : close.reason,
    close.responseHash, now)
  if (close.kind !== 'sent') return { intentId, outcome: 'uncertain', tradeState: 'NOTPAY' }
  return checkWechatPayment(db, runtime, intentId, {
    ...options, operation: 'post_close_query',
  })
}

/**
 * Bounded operator-triggered recovery (call after process restart, or schedule
 * from an authenticated internal job). No background polling or unbounded scans.
 * Failed checks remain in the append-only audit for the next safe retry.
 */
export async function recoverDueWechatPayments(
  db: AppDatabase, runtime: WechatPayRuntimeConfig,
  limit = 10, now = new Date(),
): Promise<{ checked: number; results: WechatRecoveryResult[] }> {
  const ids = db.selectDistinct({ id: paymentIntents.id })
    .from(paymentIntents)
    .leftJoin(wechatPayPrepayAttempts, eq(wechatPayPrepayAttempts.paymentIntentId, paymentIntents.id))
    .where(and(
      eq(paymentIntents.channel, 'wechat_jsapi'),
      inArray(paymentIntents.status, ['pending', 'confirming']),
      or(
        sql`${paymentIntents.expiresAt} <= ${now.getTime()}`,
        inArray(wechatPayPrepayAttempts.status, ['uncertain', 'requesting']),
      ),
    ))
    .orderBy(asc(paymentIntents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 20))
    .all()
  const results: WechatRecoveryResult[] = []
  for (const row of ids) {
    try {
      results.push(await closeAndVerifyWechatPayment(db, runtime, row.id, { now }))
    } catch (error) {
      if (!(error instanceof LocalError) || error.status !== 409) throw error
      // PAY-03 has already persisted the conflicting channel evidence.
      results.push({ intentId: row.id, outcome: 'needs_review', tradeState: null })
    }
  }
  return { checked: ids.length, results }
}
