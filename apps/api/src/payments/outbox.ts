import { and, asc, eq, lte, lt, sql } from 'drizzle-orm'
import {
  paymentOutboxConsumeResponseSchema,
  type PaymentOutboxConsumeResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import { paymentOutbox } from '../db/schema.js'
import {
  consumePaidOutboxEvent,
  projectPaymentExceptionsOntoOrders,
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
      const result = tx.update(paymentOutbox).set(exhausted
        ? {
            status: 'failed',
            lastError: row.lastError ?? '消费者在最后一次尝试中中断，租约到期后已泊车',
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
      if (exhausted && result.changes === 1) failed += 1
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
    // 3a. Claim in its own IMMEDIATE transaction. Increment attempts here,
    // before any work can crash, so every claimed execution is counted once.
    const row: OutboxRow | null = db.transaction((tx) => {
      const result = tx.update(paymentOutbox).set({
        status: 'processing',
        attempts: sql`${paymentOutbox.attempts} + 1`,
        updatedAt: now,
      }).where(and(
        eq(paymentOutbox.id, candidate.id),
        eq(paymentOutbox.status, 'pending'),
      )).run()
      if (result.changes !== 1) return null
      return tx.select().from(paymentOutbox)
        .where(eq(paymentOutbox.id, candidate.id))
        .get() ?? null
    }, { behavior: 'immediate' })
    if (!row) continue
    claimed += 1

    // 3b. Projection and outbox bookkeeping commit atomically.
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
          tx.update(paymentOutbox).set({
            status: 'failed',
            attempts,
            lastError: outcome.kind === 'conflict' ? outcome.detail : outcome.error,
            updatedAt: now,
          }).where(and(
            eq(paymentOutbox.id, row.id),
            eq(paymentOutbox.status, 'processing'),
          )).run()
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
