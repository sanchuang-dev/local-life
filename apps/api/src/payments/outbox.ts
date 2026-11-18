import { and, asc, desc, eq, lte, lt, sql } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  paymentFailedOutboxListResponseSchema,
  paymentOutboxConsumeResponseSchema,
  paymentOutboxRecoveryResponseSchema,
  type PaymentFailedOutboxListResponse,
  type PaymentOutboxConsumeResponse,
  type PaymentOutboxRecoveryOutcome,
  type PaymentOutboxRecoveryResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  localOrderOnlineConflicts,
  localOrders,
  paymentAttempts,
  paymentIntents,
  paymentOutbox,
} from '../db/schema.js'
import { LocalError } from '../local/shared.js'
import { projectOnlineCompletionsToLedger } from '../ledger/service.js'
import {
  consumePaidOutboxEvent,
  projectPaymentExceptionsOntoOrders,
  recordParkedOutboxConflict,
  settleDeferredCouponReleases,
  type PaidOutboxOutcome,
} from './order-completion.js'

/**
 * Minimum lease before a `processing` row is considered abandoned.
 *
 * A consumer claims a row by flipping it to `processing` inside its own
 * transaction, then projects it. If the process dies in between, the row stays
 * `processing`; this lease is the only recovery signal. It must stay well above
 * the longest plausible projection so a live consumer is not stolen from, and the
 * projection itself is idempotent anyway (unique completion facts).
 */
export const PAYMENT_OUTBOX_LEASE_MS = 60_000

/** Attempts before a transient failure is parked as `failed` for an operator. */
export const PAYMENT_OUTBOX_MAX_ATTEMPTS = 5

/** Server-side cap: one consumer call cannot drain an unbounded history. */
export const PAYMENT_OUTBOX_MAX_BATCH = 50

export interface PaymentOutboxConsumerOptions {
  limit?: number
  now?: Date
  leaseMs?: number
  maxAttempts?: number
}

type OutboxRow = typeof paymentOutbox.$inferSelect
type AppliedStatus = 'delivered' | 'pending' | 'failed'

interface AppliedResult {
  applied: AppliedStatus
  outcomeKind: PaidOutboxOutcome['kind']
}

function backoffMs(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.max(attempts - 1, 0), 60_000)
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 480 ? message : `${message.slice(0, 479)}…`
}

/**
 * Record a failed consumer run against the already-claimed row.
 *
 * The claim transaction committed before the projection started, so this second
 * transaction is what turns "died mid-flight" into either a retry with backoff or
 * a parked `failed` row. It also re-checks `delivered` so a rerun after a late
 * success never rewinds a delivered event.
 */
function recordConsumerFailure(
  db: AppDatabase,
  outboxId: string,
  message: string,
  now: Date,
  maxAttempts: number,
): AppliedStatus {
  return db.transaction((tx): AppliedStatus => {
    const row = tx.select().from(paymentOutbox).where(eq(paymentOutbox.id, outboxId)).get()
    if (!row) return 'failed'
    if (row.status === 'delivered') return 'delivered'
    if (row.status !== 'processing') return row.status === 'failed' ? 'failed' : 'pending'
    const attempts = row.attempts
    if (attempts >= maxAttempts) {
      tx.update(paymentOutbox).set({
        status: 'failed',
        attempts,
        lastError: message,
        updatedAt: now,
      }).where(eq(paymentOutbox.id, outboxId)).run()
      // R2: the order-level anomaly is written with the parking transition, not
      // left for an operator to reconstruct from an internal outbox row.
      recordParkedOutboxConflict(tx, {
        outboxId,
        paymentIntentId: row.paymentIntentId,
        reason: message,
        now,
      })
      return 'failed'
    }
    tx.update(paymentOutbox).set({
      status: 'pending',
      attempts,
      lastError: message,
      availableAt: new Date(now.getTime() + backoffMs(attempts)),
      updatedAt: now,
    }).where(eq(paymentOutbox.id, outboxId)).run()
    return 'pending'
  }, { behavior: 'immediate' })
}

/**
 * Claim one due `pending` row and project it, in the same two-phase shape the
 * consumer loop uses: the claim is its own IMMEDIATE transaction (so attempts are
 * counted even if the process dies mid-projection), and projection + outbox
 * bookkeeping commit atomically.
 *
 * Returns `null` when another consumer won the claim first. Shared by the batch
 * consumer and the R2 controlled recovery entry point, so a replay can never
 * follow a different projection path than the original delivery.
 */
function claimAndProjectCandidate(
  db: AppDatabase,
  candidateId: string,
  now: Date,
  maxAttempts: number,
): { outboxId: string; result: AppliedResult } | null {
  // Claim in its own IMMEDIATE transaction. Increment attempts here, before any
  // work can crash, so every claimed execution is counted once.
  const row: OutboxRow | null = db.transaction((tx) => {
    const result = tx.update(paymentOutbox).set({
      status: 'processing',
      attempts: sql`${paymentOutbox.attempts} + 1`,
      updatedAt: now,
    }).where(and(
      eq(paymentOutbox.id, candidateId),
      eq(paymentOutbox.status, 'pending'),
    )).run()
    if (result.changes !== 1) return null
    return tx.select().from(paymentOutbox)
      .where(eq(paymentOutbox.id, candidateId))
      .get() ?? null
  }, { behavior: 'immediate' })
  if (!row) return null

  // Projection and outbox bookkeeping commit atomically.
  let result: AppliedResult
  try {
    result = db.transaction((tx): AppliedResult => {
      const current = tx.select().from(paymentOutbox)
        .where(eq(paymentOutbox.id, row.id))
        .get()
      if (!current) return { applied: 'failed', outcomeKind: 'failed' }
      if (current.status !== 'processing') {
        if (current.status === 'delivered') return { applied: 'delivered', outcomeKind: 'already_completed' }
        if (current.status === 'failed') return { applied: 'failed', outcomeKind: 'failed' }
        return { applied: 'pending', outcomeKind: 'retry' }
      }
      const outcome = consumePaidOutboxEvent(tx, current, now)
      // Attempts were incremented in the claim transaction.
      const attempts = current.attempts
      if (outcome.kind === 'completed' || outcome.kind === 'already_completed') {
        tx.update(paymentOutbox).set({
          status: 'delivered',
          attempts,
          availableAt: now,
          lastError: null,
          updatedAt: now,
          deliveredAt: now,
        }).where(and(
          eq(paymentOutbox.id, row.id),
          eq(paymentOutbox.status, 'processing'),
        )).run()
        return { applied: 'delivered', outcomeKind: outcome.kind }
      }
      if (outcome.kind === 'conflict' || outcome.kind === 'failed') {
        const detail = outcome.kind === 'conflict' ? outcome.detail : outcome.error
        tx.update(paymentOutbox).set({
          status: 'failed',
          attempts,
          lastError: detail,
          updatedAt: now,
        }).where(and(
          eq(paymentOutbox.id, row.id),
          eq(paymentOutbox.status, 'processing'),
        )).run()
        if (outcome.kind === 'failed') {
          // A permanent inconsistency that could not build an order-level
          // conflict inside the projection (e.g. bad payload) is still made
          // visible on the order when the intent/order resolve.
          recordParkedOutboxConflict(tx, {
            outboxId: row.id,
            paymentIntentId: current.paymentIntentId,
            reason: outcome.error,
            now,
          })
        }
        return { applied: 'failed', outcomeKind: outcome.kind }
      }
      if (attempts >= maxAttempts) {
        tx.update(paymentOutbox).set({
          status: 'failed',
          attempts,
          lastError: outcome.error,
          updatedAt: now,
        }).where(and(
          eq(paymentOutbox.id, row.id),
          eq(paymentOutbox.status, 'processing'),
        )).run()
        recordParkedOutboxConflict(tx, {
          outboxId: row.id,
          paymentIntentId: current.paymentIntentId,
          reason: outcome.error,
          now,
        })
        return { applied: 'failed', outcomeKind: 'retry' }
      }
      tx.update(paymentOutbox).set({
        status: 'pending',
        attempts,
        lastError: outcome.error,
        availableAt: new Date(now.getTime() + backoffMs(attempts)),
        updatedAt: now,
      }).where(and(
        eq(paymentOutbox.id, row.id),
        eq(paymentOutbox.status, 'processing'),
      )).run()
      return { applied: 'pending', outcomeKind: 'retry' }
    }, { behavior: 'immediate' })
  } catch (error) {
    result = {
      applied: recordConsumerFailure(db, row.id, errorText(error), now, maxAttempts),
      outcomeKind: 'retry',
    }
  }
  return { outboxId: row.id, result }
}

/**
 * One bounded PAY-05 consumer cycle over the existing PAY-03 outbox.
 *
 * It does four things, in order:
 * 1. reclaims `processing` rows whose consumer died (lease expired);
 * 2. claims up to `limit` due `pending` rows, one write transaction each, so two
 *    concurrent consumers can never project the same event;
 * 3. projects every claimed `payment.paid.v1` event onto its order (completion,
 *    coupon redemption, audit) and commits that together with the outbox
 *    bookkeeping; a permanent business conflict parks the row as `failed` with a
 *    durable order-level conflict row, while a transient error retries with
 *    exponential backoff and eventually parks as `failed`;
 * 4. settles deferred coupon releases and projects PAY-03 late-success
 *    exceptions, both of which are idempotent and safe to re-run.
 *
 * No new queue is introduced: this is the minimal consumer for the existing
 * durable outbox, and every step is restart-safe.
 */
export function runPaymentOutboxConsumer(
  db: AppDatabase,
  options: PaymentOutboxConsumerOptions = {},
): PaymentOutboxConsumeResponse {
  const now = options.now ?? new Date()
  const limit = Math.min(Math.max(options.limit ?? 20, 1), PAYMENT_OUTBOX_MAX_BATCH)
  const leaseMs = options.leaseMs ?? PAYMENT_OUTBOX_LEASE_MS
  const maxAttempts = options.maxAttempts ?? PAYMENT_OUTBOX_MAX_ATTEMPTS

  let claimed = 0
  let completed = 0
  let alreadyCompleted = 0
  let conflicts = 0
  let retried = 0
  let failed = 0

  // 1. Recover abandoned claims. The attempt was counted when the row was
  // claimed, so a process crash cannot evade the five-attempt ceiling.
  db.transaction((tx) => {
    const expired = tx.select({
      id: paymentOutbox.id,
      paymentIntentId: paymentOutbox.paymentIntentId,
      attempts: paymentOutbox.attempts,
      lastError: paymentOutbox.lastError,
    }).from(paymentOutbox)
      .where(and(
        eq(paymentOutbox.status, 'processing'),
        lt(paymentOutbox.updatedAt, new Date(now.getTime() - leaseMs)),
      ))
      .all()

    for (const row of expired) {
      const exhausted = row.attempts >= maxAttempts
      const parkedReason = row.lastError ?? '消费者在最后一次尝试中中断，租约到期后已泊车'
      const result = tx.update(paymentOutbox).set(exhausted
        ? {
            status: 'failed',
            lastError: parkedReason,
            updatedAt: now,
          }
        : {
            status: 'pending',
            lastError: '消费者在投影完成前中断，租约到期后重新入队',
            availableAt: now,
            updatedAt: now,
          }).where(and(
            eq(paymentOutbox.id, row.id),
            eq(paymentOutbox.status, 'processing'),
          )).run()
      if (exhausted && result.changes === 1) {
        failed += 1
        recordParkedOutboxConflict(tx, {
          outboxId: row.id,
          paymentIntentId: row.paymentIntentId,
          reason: parkedReason,
          now,
        })
      }
    }
  }, { behavior: 'immediate' })

  // 2. Fair ordering; delivered/failed rows are never picked up again.
  const candidates = db.select({ id: paymentOutbox.id }).from(paymentOutbox)
    .where(and(
      eq(paymentOutbox.status, 'pending'),
      lte(paymentOutbox.availableAt, now),
    ))
    .orderBy(asc(paymentOutbox.availableAt), asc(paymentOutbox.createdAt), asc(paymentOutbox.id))
    .limit(limit)
    .all()

  for (const candidate of candidates) {
    const processed = claimAndProjectCandidate(db, candidate.id, now, maxAttempts)
    if (!processed) continue
    claimed += 1
    const { result } = processed

    if (result.outcomeKind === 'completed') completed += 1
    else if (result.outcomeKind === 'already_completed') alreadyCompleted += 1
    else if (result.outcomeKind === 'conflict') conflicts += 1
    else if (result.outcomeKind === 'failed') failed += 1
    else if (result.applied === 'failed') failed += 1
    else retried += 1
  }

  // 4. Idempotent follow-ups: release deferred coupons once payment is terminal,
  // and surface PAY-03's preserved late successes on the order.
  const couponsReleased = settleDeferredCouponReleases(db, now)
  const exceptionsProjected = projectPaymentExceptionsOntoOrders(db, now)
  // PAY-06: project every newly completed order (and any pre-PAY-06 backlog)
  // into the single operating ledger. Unique source keys make this replay-safe.
  projectOnlineCompletionsToLedger(db, { now })

  return paymentOutboxConsumeResponseSchema.parse({
    claimed,
    completed,
    alreadyCompleted,
    conflicts,
    retried,
    failed,
    couponsReleased,
    exceptionsProjected,
    asOf: now.toISOString(),
  })
}

/* -------------------------------------------------------------------------- */
/* R2: parked-outbox visibility and controlled recovery                       */
/* -------------------------------------------------------------------------- */

/** Server-side cap on the internal parked-event list. */
export const PAYMENT_OUTBOX_FAILED_LIST_MAX = 200

export interface PaymentOutboxRecoveryOptions {
  now?: Date
  maxAttempts?: number
}

/**
 * R2 controlled recovery of ONE parked (`failed`) payment event.
 *
 * The operator never issues SQL by hand: this function is the only replay path.
 * It is safe because every step is idempotent:
 *
 * 1. `failed -> pending` is a conditional UPDATE inside an IMMEDIATE transaction,
 *    so exactly one concurrent recovery can win; a loser observes the new state
 *    instead of replaying twice.
 * 2. The replay calls the exact same claim/projection routine as the consumer, so
 *    the trusted completion, coupon redemption, reward grant and ledger receipt
 *    remain guarded by the existing unique facts.
 * 3. On delivery, the linked `open` conflicts are marked `resolved` (evidence and
 *    the original failure reason are immutable and stay readable) and the PAY-06
 *    ledger projection runs again, which is replay-safe.
 * 4. A delivered event is never replayed: recovery answers `already_completed`.
 */
export function recoverParkedPaymentOutboxEvent(
  db: AppDatabase,
  outboxEventId: string,
  options: PaymentOutboxRecoveryOptions = {},
): PaymentOutboxRecoveryResponse {
  const now = options.now ?? new Date()
  const maxAttempts = options.maxAttempts ?? PAYMENT_OUTBOX_MAX_ATTEMPTS

  const reset = db.transaction((tx): { alreadyDelivered: boolean } => {
    const row = tx.select().from(paymentOutbox)
      .where(eq(paymentOutbox.id, outboxEventId))
      .get()
    if (!row) {
      throw new LocalError(404, API_ERROR_CODES.notFound, '支付事件不存在')
    }
    if (row.status === 'delivered') return { alreadyDelivered: true }
    if (row.status !== 'failed') {
      // `pending`/`processing` already have an owner; replaying them here would
      // race the scheduler for no reason. Only a parked row is recoverable.
      throw new LocalError(
        409,
        API_ERROR_CODES.paymentOutboxRecoveryConflict,
        '只有已泊车的支付事件可以受控恢复',
      )
    }
    const updated = tx.update(paymentOutbox).set({
      status: 'pending',
      attempts: 0,
      availableAt: now,
      updatedAt: now,
    }).where(and(
      eq(paymentOutbox.id, outboxEventId),
      eq(paymentOutbox.status, 'failed'),
    )).run()
    if (updated.changes !== 1) {
      const current = tx.select({ status: paymentOutbox.status }).from(paymentOutbox)
        .where(eq(paymentOutbox.id, outboxEventId))
        .get()
      if (current?.status === 'delivered') return { alreadyDelivered: true }
      throw new LocalError(
        409,
        API_ERROR_CODES.paymentOutboxRecoveryConflict,
        '该支付事件正在被其他恢复流程处理',
      )
    }
    return { alreadyDelivered: false }
  }, { behavior: 'immediate' })

  const processed = reset.alreadyDelivered
    ? null
    : claimAndProjectCandidate(db, outboxEventId, now, maxAttempts)

  const finalRow = db.select().from(paymentOutbox)
    .where(eq(paymentOutbox.id, outboxEventId))
    .get()
  if (!finalRow) {
    throw new LocalError(404, API_ERROR_CODES.notFound, '支付事件不存在')
  }
  const intent = db.select().from(paymentIntents)
    .where(eq(paymentIntents.id, finalRow.paymentIntentId))
    .get()
  const order = intent
    ? db.select({ id: localOrders.id, status: localOrders.status }).from(localOrders)
      .where(eq(localOrders.id, intent.localOrderId))
      .get()
    : undefined

  let conflictsResolved = 0
  if (finalRow.status === 'delivered') {
    // Resolve the parking anomaly without deleting or rewriting the evidence: the
    // immutability trigger keeps `kind`, `detail`, ids and `created_at` forever.
    conflictsResolved = db.transaction((tx) => {
      const result = tx.update(localOrderOnlineConflicts).set({
        status: 'resolved',
        resolvedAt: now,
      }).where(and(
        eq(localOrderOnlineConflicts.paymentOutboxId, outboxEventId),
        eq(localOrderOnlineConflicts.status, 'open'),
      )).run()
      return result.changes
    }, { behavior: 'immediate' })
    // PAY-06 projection is unique-keyed; running it again is a no-op or the
    // missing receipt, never a second one.
    projectOnlineCompletionsToLedger(db, { now })
  }

  const outcome: PaymentOutboxRecoveryOutcome = finalRow.status === 'delivered'
    ? reset.alreadyDelivered || processed === null
      ? 'already_completed'
      : 'recovered'
    : finalRow.status === 'failed'
      ? 'still_failed'
      : 'retry_scheduled'

  return paymentOutboxRecoveryResponseSchema.parse({
    outboxEventId,
    outcome,
    status: finalRow.status,
    localOrderId: order?.id ?? null,
    paymentIntentId: intent?.id ?? null,
    orderStatus: order?.status ?? null,
    conflictsResolved,
    asOf: now.toISOString(),
  })
}

/**
 * R2 internal query path. Returns every parked event with the frozen intent
 * amount, the paid attempt's channel transaction and the durable order-level
 * conflicts, so an operator can locate and replay a stuck payment without
 * opening SQLite or mutating `payment_outbox` directly.
 */
export function listFailedPaymentOutboxEvents(
  db: AppDatabase,
  options: { limit?: number; now?: Date } = {},
): PaymentFailedOutboxListResponse {
  const now = options.now ?? new Date()
  const limit = Math.min(
    Math.max(options.limit ?? 50, 1),
    PAYMENT_OUTBOX_FAILED_LIST_MAX,
  )
  const rows = db.select().from(paymentOutbox)
    .where(eq(paymentOutbox.status, 'failed'))
    .orderBy(desc(paymentOutbox.updatedAt), asc(paymentOutbox.id))
    .limit(limit)
    .all()

  const items = rows.map((row) => {
    const intent = db.select().from(paymentIntents)
      .where(eq(paymentIntents.id, row.paymentIntentId))
      .get()
    const order = intent
      ? db.select({ id: localOrders.id, status: localOrders.status }).from(localOrders)
        .where(eq(localOrders.id, intent.localOrderId))
        .get()
      : undefined
    const paidAttempt = intent
      ? db.select({ providerTransactionId: paymentAttempts.providerTransactionId })
        .from(paymentAttempts)
        .where(and(
          eq(paymentAttempts.paymentIntentId, intent.id),
          eq(paymentAttempts.status, 'paid'),
        ))
        .get()
      : undefined
    const conflicts = db.select().from(localOrderOnlineConflicts)
      .where(eq(localOrderOnlineConflicts.paymentOutboxId, row.id))
      .orderBy(asc(localOrderOnlineConflicts.createdAt), asc(localOrderOnlineConflicts.id))
      .all()
    return {
      outboxEventId: row.id,
      paymentIntentId: row.paymentIntentId,
      localOrderId: order?.id ?? null,
      orderStatus: order?.status ?? null,
      topic: row.topic,
      status: 'failed' as const,
      attempts: row.attempts,
      lastError: row.lastError,
      amountCents: intent?.netPayableCents ?? 0,
      providerTransactionId: paidAttempt?.providerTransactionId ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      conflicts: conflicts.map((conflict) => ({
        id: conflict.id,
        kind: conflict.kind,
        status: conflict.status,
        detail: conflict.detail,
        createdAt: conflict.createdAt.toISOString(),
        resolvedAt: conflict.resolvedAt ? conflict.resolvedAt.toISOString() : null,
      })),
    }
  })

  return paymentFailedOutboxListResponseSchema.parse({
    items,
    asOf: now.toISOString(),
  })
}
