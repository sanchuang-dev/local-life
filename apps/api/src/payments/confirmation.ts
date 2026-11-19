import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  paymentConfirmationResponseSchema,
  paymentEvidenceSchema,
  paymentPaidEventPayloadSchema,
  paymentReviewExceptionSchema,
  type ApiErrorCode,
  type PaymentConfirmationResponse,
  type PaymentEvidence,
  type PaymentReviewException,
  type PaymentReviewExceptionKind,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  localOrders,
  paymentAttempts,
  paymentEvents,
  paymentIntents,
  paymentOutbox,
  paymentReviewExceptions,
} from '../db/schema.js'
import { LocalError, iso, nextUpdatedAt, type LocalTransaction } from '../local/shared.js'
import { toAttempt, toIntent } from './service.js'

type FailureStatus = 400 | 404 | 409

interface ConfirmationFailure {
  kind: 'failure'
  status: FailureStatus
  code: ApiErrorCode
  message: string
}

type ConfirmationOutcome =
  | { kind: 'ok'; response: PaymentConfirmationResponse }
  | ConfirmationFailure

type IntentRow = typeof paymentIntents.$inferSelect
type AttemptRow = typeof paymentAttempts.$inferSelect
type ExceptionKind = PaymentReviewExceptionKind

function failure(
  status: FailureStatus,
  code: ApiErrorCode,
  message: string,
): ConfirmationFailure {
  return { kind: 'failure', status, code, message }
}

/**
 * Bind a provider dedupe key to the complete normalized evidence it represents.
 * A fixed tuple avoids depending on caller object-property order; timestamps are
 * canonicalized so equivalent timezone offsets describe the same observation.
 */
function paymentEvidenceFingerprint(evidence: PaymentEvidence): string {
  const canonicalEvidence = [
    evidence.merchantOrderNo,
    evidence.channel,
    evidence.providerStatus,
    evidence.providerTransactionId,
    evidence.amountCents,
    evidence.currency,
    evidence.merchantAppId,
    evidence.merchantId,
    new Date(evidence.observedAt).toISOString(),
    evidence.source,
    evidence.dedupeKey,
    evidence.providerEventRef,
    evidence.failureCode,
    evidence.failureMessage,
  ]
  return createHash('sha256').update(JSON.stringify(canonicalEvidence)).digest('hex')
}

/**
 * Persist a conflict/late/unknown channel observation without changing the
 * payment or attempt state. Exact evidence replays reuse one snapshot; a reused
 * provider key with different evidence gets its own immutable anomaly snapshot.
 */
function recordException(
  tx: LocalTransaction,
  evidence: PaymentEvidence,
  paymentIntentId: string | null,
  kind: ExceptionKind,
  detail: string,
  now: Date,
): string {
  const fingerprint = paymentEvidenceFingerprint(evidence)
  const existing = tx.select({ id: paymentReviewExceptions.id })
    .from(paymentReviewExceptions)
    .where(and(
      eq(paymentReviewExceptions.dedupeKey, evidence.dedupeKey),
      eq(paymentReviewExceptions.evidenceFingerprint, fingerprint),
    ))
    .get()
  if (existing) return existing.id

  const id = randomUUID()
  tx.insert(paymentReviewExceptions).values({
    id,
    paymentIntentId,
    merchantOrderNo: evidence.merchantOrderNo,
    channel: evidence.channel,
    providerTransactionId: evidence.providerTransactionId,
    amountCents: evidence.amountCents,
    merchantAppId: evidence.merchantAppId,
    merchantId: evidence.merchantId,
    observedAt: new Date(evidence.observedAt),
    source: evidence.source,
    dedupeKey: evidence.dedupeKey,
    evidenceFingerprint: fingerprint,
    providerEventRef: evidence.providerEventRef,
    failureCode: evidence.failureCode,
    failureMessage: evidence.failureMessage,
    kind,
    detail,
    status: 'open',
    createdAt: now,
    resolvedAt: null,
  }).run()
  return id
}

function appendChannelEvent(
  tx: LocalTransaction,
  evidence: PaymentEvidence,
  intentId: string,
  attemptId: string | null,
  fromStatus: IntentRow['status'],
  toStatus: IntentRow['status'],
  now: Date,
): string {
  const id = randomUUID()
  tx.insert(paymentEvents).values({
    id,
    paymentIntentId: intentId,
    paymentAttemptId: attemptId,
    eventType: evidence.source === 'notification'
      ? 'payment.channel_notification'
      : 'payment.channel_query',
    source: 'channel',
    fromStatus,
    toStatus,
    providerEventRef: evidence.providerEventRef ?? evidence.providerTransactionId ?? evidence.dedupeKey,
    dedupeKey: evidence.dedupeKey,
    evidenceFingerprint: paymentEvidenceFingerprint(evidence),
    note: null,
    createdAt: now,
  }).run()
  return id
}

function nextAttemptNo(tx: LocalTransaction, intentId: string): number {
  return (
    tx.select({ attemptNo: paymentAttempts.attemptNo })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.paymentIntentId, intentId))
      .orderBy(desc(paymentAttempts.attemptNo))
      .get()?.attemptNo ?? 0
  ) + 1
}

function attemptOfEvent(
  tx: LocalTransaction,
  paymentAttemptId: string | null,
): AttemptRow | null {
  if (!paymentAttemptId) return null
  return tx.select().from(paymentAttempts)
    .where(eq(paymentAttempts.id, paymentAttemptId)).get() ?? null
}

function openAttemptOfIntent(tx: LocalTransaction, intentId: string): AttemptRow | null {
  return tx.select().from(paymentAttempts)
    .where(and(
      eq(paymentAttempts.paymentIntentId, intentId),
      inArray(paymentAttempts.status, ['pending', 'confirming']),
    ))
    .orderBy(desc(paymentAttempts.createdAt), desc(paymentAttempts.id))
    .get() ?? null
}

function outboxOfIntent(tx: LocalTransaction, intentId: string): string | null {
  return tx.select({ id: paymentOutbox.id }).from(paymentOutbox)
    .where(eq(paymentOutbox.paymentIntentId, intentId)).get()?.id ?? null
}

/** Validate the trusted evidence against the persisted intent and its order. */
function validateEvidence(
  tx: LocalTransaction,
  evidence: PaymentEvidence,
  now: Date,
): { intent: IntentRow; order: typeof localOrders.$inferSelect } | ConfirmationFailure {
  const intent = tx.select().from(paymentIntents)
    .where(eq(paymentIntents.merchantOrderNo, evidence.merchantOrderNo))
    .get()
  if (!intent) {
    recordException(tx, evidence, null, 'intent_not_found', '商户订单号不存在', now)
    return failure(404, API_ERROR_CODES.paymentEvidenceRejected, '支付单不存在或商户订单号不匹配')
  }
  if (intent.kind !== 'channel') {
    recordException(tx, evidence, intent.id, 'unknown_evidence', '零元支付意图不接受渠道证据', now)
    return failure(409, API_ERROR_CODES.paymentEvidenceRejected, '该支付意图不接受渠道证据')
  }
  const order = tx.select().from(localOrders)
    .where(eq(localOrders.id, intent.localOrderId)).get()
  if (
    !order ||
    order.residentUserId !== intent.residentUserId ||
    order.communityId !== intent.communityId
  ) {
    recordException(tx, evidence, intent.id, 'ownership_mismatch', '支付意图与订单归属不一致', now)
    return failure(409, API_ERROR_CODES.paymentEvidenceRejected, '支付意图与订单归属不一致')
  }
  if (evidence.channel !== intent.channel) {
    recordException(tx, evidence, intent.id, 'channel_mismatch', '渠道不匹配', now)
    return failure(409, API_ERROR_CODES.paymentEvidenceRejected, '支付渠道不匹配')
  }
  if (intent.channel === 'wechat_jsapi' && (!intent.merchantAppId || !intent.merchantId)) {
    recordException(tx, evidence, intent.id, 'merchant_mismatch', '支付意图缺少微信商户身份', now)
    return failure(409, API_ERROR_CODES.paymentEvidenceRejected, '支付意图缺少微信商户身份')
  }
  if (
    evidence.merchantAppId !== intent.merchantAppId ||
    evidence.merchantId !== intent.merchantId
  ) {
    recordException(tx, evidence, intent.id, 'merchant_mismatch', '商户上下文不匹配', now)
    return failure(409, API_ERROR_CODES.paymentEvidenceRejected, '商户上下文不匹配')
  }
  if (evidence.amountCents !== intent.netPayableCents) {
    recordException(
      tx,
      evidence,
      intent.id,
      'amount_mismatch',
      `金额不匹配：期望 ${intent.netPayableCents} 分，收到 ${evidence.amountCents} 分`,
      now,
    )
    return failure(409, API_ERROR_CODES.paymentEvidenceRejected, '支付金额与冻结金额不一致')
  }
  return { intent, order }
}

function confirmPaid(
  tx: LocalTransaction,
  evidence: PaymentEvidence,
  intent: IntentRow,
  existingAttempt: AttemptRow | null,
  now: Date,
): ConfirmationOutcome {
  if (intent.status === 'paid') {
    const paidAttempt = existingAttempt?.status === 'paid'
      ? existingAttempt
      : tx.select().from(paymentAttempts)
        .where(eq(paymentAttempts.paymentIntentId, intent.id))
        .orderBy(desc(paymentAttempts.confirmedAt), desc(paymentAttempts.id))
        .get()
    if (paidAttempt?.status === 'paid' && paidAttempt.providerTransactionId === evidence.providerTransactionId) {
      // A distinct notification/query key is a distinct provider observation,
      // even though it must not create another paid transition or outbox row.
      appendChannelEvent(tx, evidence, intent.id, paidAttempt.id, intent.status, 'paid', now)
      return {
        kind: 'ok',
        response: paymentConfirmationResponseSchema.parse({
          outcome: 'already_confirmed',
          intent: toIntent(intent),
          attempt: toAttempt(paidAttempt),
          outboxEventId: outboxOfIntent(tx, intent.id),
        }),
      }
    }
    recordException(tx, evidence, intent.id, 'transaction_conflict', '支付意图已成功但渠道交易号不一致', now)
    return failure(409, API_ERROR_CODES.paymentConfirmationConflict, '支付已确认，渠道交易号不一致，已进入复核')
  }
  if (intent.status === 'closed' || intent.status === 'failed') {
    const kind: ExceptionKind = intent.status === 'closed'
      ? 'late_success_after_closed'
      : 'late_success_after_failed'
    recordException(tx, evidence, intent.id, kind, '支付意图已终态后收到可信成功证据', now)
    return failure(409, API_ERROR_CODES.paymentConfirmationConflict, '支付意图已终结，迟到成功证据已记录待复核')
  }
  if (existingAttempt && existingAttempt.status !== 'pending' && existingAttempt.status !== 'confirming') {
    recordException(tx, evidence, intent.id, 'terminal_conflict', '支付尝试已终态，不能回退为成功', now)
    return failure(409, API_ERROR_CODES.paymentConfirmationConflict, '支付尝试状态不允许确认成功')
  }

  let attempt: AttemptRow
  if (existingAttempt) {
    const updatedAt = nextUpdatedAt(existingAttempt.updatedAt, now)
    tx.update(paymentAttempts).set({
      status: 'paid',
      providerTransactionId: evidence.providerTransactionId,
      confirmedAt: new Date(evidence.observedAt),
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      updatedAt,
    }).where(eq(paymentAttempts.id, existingAttempt.id)).run()
    attempt = tx.select().from(paymentAttempts)
      .where(eq(paymentAttempts.id, existingAttempt.id)).get()!
  } else {
    const id = randomUUID()
    tx.insert(paymentAttempts).values({
      id,
      paymentIntentId: intent.id,
      attemptNo: nextAttemptNo(tx, intent.id),
      status: 'paid',
      idempotencyKey: evidence.dedupeKey,
      providerTransactionId: evidence.providerTransactionId,
      createdAt: now,
      updatedAt: now,
      confirmedAt: new Date(evidence.observedAt),
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
    }).run()
    attempt = tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, id)).get()!
  }

  const updatedAt = nextUpdatedAt(intent.updatedAt, now)
  tx.update(paymentIntents).set({
    status: 'paid',
    paidAt: new Date(evidence.observedAt),
    closedAt: null,
    failedAt: null,
    failureCode: null,
    failureMessage: null,
    updatedAt,
  }).where(eq(paymentIntents.id, intent.id)).run()
  const confirmedIntent = tx.select().from(paymentIntents)
    .where(eq(paymentIntents.id, intent.id)).get()!

  const eventId = appendChannelEvent(
    tx,
    evidence,
    intent.id,
    attempt.id,
    intent.status,
    'paid',
    now,
  )
  const payload = paymentPaidEventPayloadSchema.parse({
    paymentIntentId: intent.id,
    localOrderId: intent.localOrderId,
    residentUserId: intent.residentUserId,
    communityId: intent.communityId,
    amountCents: intent.netPayableCents,
    providerTransactionId: evidence.providerTransactionId,
    simulated: intent.simulated,
    paidAt: evidence.observedAt,
  })
  const outboxId = randomUUID()
  tx.insert(paymentOutbox).values({
    id: outboxId,
    paymentIntentId: intent.id,
    paymentEventId: eventId,
    topic: 'payment.paid.v1',
    dedupeKey: `payment.paid:${intent.id}`,
    payloadJson: JSON.stringify(payload),
    status: 'pending',
    attempts: 0,
    availableAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    deliveredAt: null,
  }).run()

  return {
    kind: 'ok',
    response: paymentConfirmationResponseSchema.parse({
      outcome: 'confirmed',
      intent: toIntent(confirmedIntent),
      attempt: toAttempt(attempt),
      outboxEventId: outboxId,
    }),
  }
}

function confirmTerminal(
  tx: LocalTransaction,
  evidence: PaymentEvidence,
  intent: IntentRow,
  existingAttempt: AttemptRow | null,
  now: Date,
): ConfirmationOutcome {
  const target = evidence.providerStatus === 'failed' ? 'failed' : 'closed'
  if (intent.status === 'paid') {
    recordException(tx, evidence, intent.id, 'terminal_conflict', '已成功支付意图收到失败/关闭证据', now)
    return failure(409, API_ERROR_CODES.paymentConfirmationConflict, '支付已成功，失败/关闭证据已记录复核')
  }
  if (intent.status === 'closed' || intent.status === 'failed') {
    if (intent.status === target) {
      appendChannelEvent(tx, evidence, intent.id, existingAttempt?.id ?? null, intent.status, intent.status, now)
      return {
        kind: 'ok',
        response: paymentConfirmationResponseSchema.parse({
          outcome: 'already_confirmed',
          intent: toIntent(intent),
          attempt: existingAttempt ? toAttempt(existingAttempt) : null,
          outboxEventId: null,
        }),
      }
    }
    recordException(tx, evidence, intent.id, 'terminal_conflict', '终态之间发生冲突', now)
    return failure(409, API_ERROR_CODES.paymentConfirmationConflict, '支付意图终态与渠道结果冲突')
  }
  if (existingAttempt && existingAttempt.status !== 'pending' && existingAttempt.status !== 'confirming' &&
      existingAttempt.status !== target) {
    recordException(tx, evidence, intent.id, 'terminal_conflict', '支付尝试终态冲突', now)
    return failure(409, API_ERROR_CODES.paymentConfirmationConflict, '支付尝试状态与渠道结果冲突')
  }

  let attempt: AttemptRow
  if (existingAttempt) {
    if (existingAttempt.status === target) {
      attempt = existingAttempt
    } else {
      const updatedAt = nextUpdatedAt(existingAttempt.updatedAt, now)
      tx.update(paymentAttempts).set({
        status: target,
        providerTransactionId: evidence.providerTransactionId ?? existingAttempt.providerTransactionId,
        confirmedAt: null,
        closedAt: target === 'closed' ? new Date(evidence.observedAt) : null,
        failedAt: target === 'failed' ? new Date(evidence.observedAt) : null,
        failureCode: target === 'failed' ? evidence.failureCode : null,
        failureMessage: target === 'failed' ? evidence.failureMessage : null,
        updatedAt,
      }).where(eq(paymentAttempts.id, existingAttempt.id)).run()
      attempt = tx.select().from(paymentAttempts)
        .where(eq(paymentAttempts.id, existingAttempt.id)).get()!
    }
  } else {
    const id = randomUUID()
    tx.insert(paymentAttempts).values({
      id,
      paymentIntentId: intent.id,
      attemptNo: nextAttemptNo(tx, intent.id),
      status: target,
      idempotencyKey: evidence.dedupeKey,
      providerTransactionId: evidence.providerTransactionId,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
      closedAt: target === 'closed' ? new Date(evidence.observedAt) : null,
      failedAt: target === 'failed' ? new Date(evidence.observedAt) : null,
      failureCode: target === 'failed' ? evidence.failureCode : null,
      failureMessage: target === 'failed' ? evidence.failureMessage : null,
    }).run()
    attempt = tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, id)).get()!
  }

  const updatedAt = nextUpdatedAt(intent.updatedAt, now)
  tx.update(paymentIntents).set({
    status: target,
    paidAt: null,
    closedAt: target === 'closed' ? new Date(evidence.observedAt) : null,
    failedAt: target === 'failed' ? new Date(evidence.observedAt) : null,
    failureCode: target === 'failed' ? evidence.failureCode : null,
    failureMessage: target === 'failed' ? evidence.failureMessage : null,
    updatedAt,
  }).where(eq(paymentIntents.id, intent.id)).run()
  appendChannelEvent(tx, evidence, intent.id, attempt.id, intent.status, target, now)
  const current = tx.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id)).get()!
  return {
    kind: 'ok',
    response: paymentConfirmationResponseSchema.parse({
      outcome: 'recorded',
      intent: toIntent(current),
      attempt: toAttempt(attempt),
      outboxEventId: null,
    }),
  }
}

function confirmPending(
  tx: LocalTransaction,
  evidence: PaymentEvidence,
  intent: IntentRow,
  existingAttempt: AttemptRow | null,
  now: Date,
): ConfirmationOutcome {
  if (intent.status === 'paid' || intent.status === 'closed' || intent.status === 'failed') {
    recordException(tx, evidence, intent.id, 'terminal_conflict', '终态支付意图收到待确认证据', now)
    return failure(409, API_ERROR_CODES.paymentConfirmationConflict, '支付意图已终态，不能回退为待确认')
  }
  if (existingAttempt && existingAttempt.status !== 'pending' && existingAttempt.status !== 'confirming') {
    recordException(tx, evidence, intent.id, 'terminal_conflict', '支付尝试已终态', now)
    return failure(409, API_ERROR_CODES.paymentConfirmationConflict, '支付尝试状态与渠道结果冲突')
  }
  let attempt: AttemptRow | null = existingAttempt
  if (attempt && attempt.status === 'pending') {
    const updatedAt = nextUpdatedAt(attempt.updatedAt, now)
    tx.update(paymentAttempts).set({
      status: 'confirming',
      providerTransactionId: evidence.providerTransactionId ?? attempt.providerTransactionId,
      updatedAt,
    }).where(eq(paymentAttempts.id, attempt.id)).run()
    attempt = tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, attempt.id)).get()!
  }
  if (!attempt) {
    const id = randomUUID()
    tx.insert(paymentAttempts).values({
      id,
      paymentIntentId: intent.id,
      attemptNo: nextAttemptNo(tx, intent.id),
      status: 'confirming',
      idempotencyKey: evidence.dedupeKey,
      providerTransactionId: evidence.providerTransactionId,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
    }).run()
    attempt = tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, id)).get()!
  }
  if (intent.status === 'pending') {
    const updatedAt = nextUpdatedAt(intent.updatedAt, now)
    tx.update(paymentIntents).set({ status: 'confirming', updatedAt })
      .where(eq(paymentIntents.id, intent.id)).run()
  }
  appendChannelEvent(
    tx,
    evidence,
    intent.id,
    attempt.id,
    intent.status,
    intent.status === 'pending' ? 'confirming' : intent.status,
    now,
  )
  const current = tx.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id)).get()!
  return {
    kind: 'ok',
    response: paymentConfirmationResponseSchema.parse({
      outcome: 'recorded',
      intent: toIntent(current),
      attempt: toAttempt(attempt),
      outboxEventId: null,
    }),
  }
}

/**
 * Trusted provider adapter entry point. The caller must already have verified
 * the provider signature/query (PAY-11); this function validates the normalized
 * evidence against the persisted intent/order and converges state atomically.
 */
export function confirmTrustedPayment(
  db: AppDatabase,
  input: PaymentEvidence,
  options: { now?: Date } = {},
): PaymentConfirmationResponse {
  const evidence = paymentEvidenceSchema.parse(input)
  const now = options.now ?? new Date()

  const outcome = db.transaction((tx): ConfirmationOutcome => {
    // Resolve provider event identity before validating against mutable lifecycle
    // state. Exact evidence is an idempotent replay; changed evidence is an
    // immutable conflict snapshot, never a successful replay.
    const duplicate = tx.select().from(paymentEvents)
      .where(eq(paymentEvents.dedupeKey, evidence.dedupeKey)).get()
    if (duplicate) {
      if (duplicate.evidenceFingerprint !== paymentEvidenceFingerprint(evidence)) {
        const observedIntent = tx.select({ id: paymentIntents.id }).from(paymentIntents)
          .where(eq(paymentIntents.merchantOrderNo, evidence.merchantOrderNo)).get()
        recordException(
          tx,
          evidence,
          observedIntent?.id ?? null,
          'transaction_conflict',
          '渠道事件去重键已被不同证据内容重复使用',
          now,
        )
        return failure(
          409,
          API_ERROR_CODES.paymentConfirmationConflict,
          '渠道事件去重键冲突，已保存复核证据',
        )
      }

      const duplicateIntent = tx.select().from(paymentIntents)
        .where(eq(paymentIntents.id, duplicate.paymentIntentId)).get()
      if (!duplicateIntent) {
        recordException(tx, evidence, null, 'unknown_evidence', '已接受事件关联支付意图不存在', now)
        return failure(409, API_ERROR_CODES.paymentConfirmationConflict, '已接受事件关联的支付意图不可用')
      }
      const duplicateAttempt = attemptOfEvent(tx, duplicate.paymentAttemptId)
      return {
        kind: 'ok',
        response: paymentConfirmationResponseSchema.parse({
          outcome: duplicateIntent.status === 'paid' ? 'already_confirmed' : 'recorded',
          intent: toIntent(duplicateIntent),
          attempt: duplicateAttempt ? toAttempt(duplicateAttempt) : null,
          outboxEventId: outboxOfIntent(tx, duplicateIntent.id),
        }),
      }
    }

    // A rejected provider key is permanently reserved. A changed payload is
    // still recorded as a separate anomaly rather than silently discarded.
    const rejected = tx.select({ id: paymentReviewExceptions.id })
      .from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.dedupeKey, evidence.dedupeKey))
      .get()
    if (rejected) {
      const matchedIntent = tx.select({ id: paymentIntents.id }).from(paymentIntents)
        .where(eq(paymentIntents.merchantOrderNo, evidence.merchantOrderNo)).get()
      recordException(
        tx,
        evidence,
        matchedIntent?.id ?? null,
        'transaction_conflict',
        '渠道事件去重键已被此前拒绝的证据占用，不能复用',
        now,
      )
      return failure(
        409,
        API_ERROR_CODES.paymentConfirmationConflict,
        '该渠道证据去重键已进入复核，不能重复声明成功',
      )
    }

    const validated = validateEvidence(tx, evidence, now)
    if ('kind' in validated) return validated
    const { intent } = validated

    const txnAttempt = evidence.providerTransactionId
      ? tx.select().from(paymentAttempts)
        .where(eq(paymentAttempts.providerTransactionId, evidence.providerTransactionId)).get() ?? null
      : null
    if (txnAttempt && txnAttempt.paymentIntentId !== intent.id) {
      recordException(tx, evidence, intent.id, 'transaction_conflict', '渠道交易号已属于另一支付意图', now)
      return failure(409, API_ERROR_CODES.paymentConfirmationConflict, '渠道交易号已被其他支付意图使用，已记录复核')
    }
    // A pending/query result can arrive before the channel transaction id is
    // known; reuse the open attempt instead of creating one per poll. Paid and
    // terminal intents only reuse the exact transaction attempt.
    const openAttempt = intent.status === 'pending' || intent.status === 'confirming'
      ? openAttemptOfIntent(tx, intent.id)
      : null
    const existingAttempt = txnAttempt ?? (
      openAttempt &&
      (evidence.providerTransactionId === null || openAttempt.providerTransactionId === null)
        ? openAttempt
        : null
    )

    if (evidence.providerStatus === 'paid') {
      return confirmPaid(tx, evidence, intent, existingAttempt, now)
    }
    if (evidence.providerStatus === 'failed' || evidence.providerStatus === 'closed') {
      return confirmTerminal(tx, evidence, intent, existingAttempt, now)
    }
    return confirmPending(tx, evidence, intent, existingAttempt, now)
  }, { behavior: 'immediate' })

  if (outcome.kind === 'failure') {
    throw new LocalError(outcome.status, outcome.code, outcome.message)
  }
  return outcome.response
}

/** Review queue read for PAY-11 operations; resolution UI belongs to a later card. */
export function listOpenPaymentReviewExceptions(
  db: AppDatabase,
  limit = 100,
): PaymentReviewException[] {
  return db.select().from(paymentReviewExceptions)
    .where(eq(paymentReviewExceptions.status, 'open'))
    .orderBy(desc(paymentReviewExceptions.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200))
    .all()
    .map((row) => paymentReviewExceptionSchema.parse({
      id: row.id,
      paymentIntentId: row.paymentIntentId,
      merchantOrderNo: row.merchantOrderNo,
      channel: row.channel,
      providerTransactionId: row.providerTransactionId,
      amountCents: row.amountCents,
      merchantAppId: row.merchantAppId,
      merchantId: row.merchantId,
      observedAt: iso(row.observedAt),
      source: row.source,
      dedupeKey: row.dedupeKey,
      providerEventRef: row.providerEventRef,
      failureCode: row.failureCode,
      failureMessage: row.failureMessage,
      kind: row.kind,
      detail: row.detail,
      status: row.status,
      createdAt: iso(row.createdAt),
      resolvedAt: row.resolvedAt ? iso(row.resolvedAt) : null,
    }))
}
