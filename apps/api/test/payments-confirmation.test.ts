import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import test from 'node:test'
import {
  apiErrorSchema,
  paymentConfirmationResponseSchema,
  paymentOutboxEventSchema,
  paymentReviewExceptionSchema,
  type PaymentEvidence,
  type PaymentIntent,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  communities,
  ledgerEntries,
  localOrders,
  localProducts,
  paymentAttempts,
  paymentEvents,
  paymentIntents,
  paymentOutbox,
  paymentReviewExceptions,
  users,
} from '../src/db/schema.js'
import { LocalError } from '../src/local/shared.js'
import { createPaymentIntent, toIntent } from '../src/payments/service.js'
import {
  confirmTrustedPayment,
  listOpenPaymentReviewExceptions,
} from '../src/payments/confirmation.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const NOW = new Date('2026-11-17T02:00:00.000Z')
const TOKEN = 'internal-payment-token-'.padEnd(40, 'x')

type App = ReturnType<typeof createApp>

interface World {
  app: App
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  config: ReturnType<typeof loadConfig>
  communityId: string
  orderId: string
  userId: string
}

function config(databasePath = ':memory:', internalToken = TOKEN) {
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
    PAYMENT_MOCK_ENABLED: 'true',
    PAYMENT_INTERNAL_TOKEN: internalToken,
    DATABASE_PATH: databasePath,
  })
}

function world(databasePath = ':memory:'): World {
  const cfg = config(databasePath)
  const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
  const communityId = randomUUID()
  const userId = randomUUID()
  const productId = randomUUID()
  const orderId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '可信确认片区', createdAt: NOW }).run()
  db.insert(users).values({
    id: userId, displayName: '可信支付居民', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(localProducts).values({
    id: productId,
    communityId,
    name: '可信确认商品',
    unitPriceCents: 3980,
    status: 'on_shelf',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(localOrders).values({
    id: orderId,
    communityId,
    productId,
    residentUserId: userId,
    idempotencyKey: `confirm-${orderId}`,
    status: 'registered',
    recordSource: 'resident',
    productName: '可信确认商品',
    unitPriceCents: 3980,
    quantity: 1,
    totalCents: 3980,
    couponDiscountCents: 0,
    couponId: null,
    note: null,
    createdByStaffId: null,
    attributedStaffId: null,
    sourceActivityId: null,
    sourceTeamId: null,
    verifiedByUserId: null,
    verifiedAt: null,
    verificationNote: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  const app = createApp({ db, config: cfg, logRequests: false })
  return { app, db, sqlite, config: cfg, communityId, orderId, userId }
}

function createIntent(world: World, key = `intent-${randomUUID()}`, orderId = world.orderId): PaymentIntent {
  return createPaymentIntent(
    world.db,
    world.config,
    { userId: world.userId, staffId: null, role: null },
    { localOrderId: orderId, channel: 'mock', idempotencyKey: key },
    { now: NOW },
  ).intent
}

function secondOrder(world: World): string {
  const orderId = randomUUID()
  world.db.insert(localOrders).values({
    id: orderId,
    communityId: world.communityId,
    productId: world.db.select({ id: localProducts.id }).from(localProducts).get()!.id,
    residentUserId: world.userId,
    idempotencyKey: `second-${orderId}`,
    status: 'registered',
    recordSource: 'resident',
    productName: '可信确认商品',
    unitPriceCents: 3980,
    quantity: 1,
    totalCents: 3980,
    couponDiscountCents: 0,
    couponId: null,
    note: null,
    createdByStaffId: null,
    attributedStaffId: null,
    sourceActivityId: null,
    sourceTeamId: null,
    verifiedByUserId: null,
    verifiedAt: null,
    verificationNote: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  return orderId
}

function evidence(intent: PaymentIntent, overrides: Partial<PaymentEvidence> = {}): PaymentEvidence {
  return {
    merchantOrderNo: intent.merchantOrderNo,
    channel: 'mock',
    providerStatus: 'paid',
    providerTransactionId: `wx-txn-${randomUUID()}`,
    amountCents: intent.netPayableCents,
    currency: 'CNY',
    merchantAppId: null,
    merchantId: null,
    observedAt: NOW.toISOString(),
    source: 'notification',
    dedupeKey: `notify-${randomUUID()}`,
    providerEventRef: null,
    failureCode: null,
    failureMessage: null,
    ...overrides,
  }
}

function count(db: AppDatabase, table: SQLiteTable) {
  return db.select().from(table).all().length
}

function assertLocalError(code: string, fn: () => unknown): LocalError {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof LocalError)
    assert.equal(error.code, code)
    return error
  }
  assert.fail('expected a LocalError')
}

function internalHeaders(token = TOKEN) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  }
}

async function runConfirmationWorkers(
  databasePath: string,
  evidences: PaymentEvidence[],
): Promise<Array<{ code: number | null; output: string; error: string }>> {
  const workerPath = fileURLToPath(new URL('./helpers/confirm-worker.ts', import.meta.url))
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  return Promise.all(evidences.map((paidEvidence) => new Promise<{
    code: number | null
    output: string
    error: string
  }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath], {
      cwd,
      env: {
        ...process.env,
        CONFIRM_DB_PATH: databasePath,
        CONFIRM_EVIDENCE: JSON.stringify(paidEvidence),
        CONFIRM_NOW: NOW.toISOString(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let error = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { error += String(chunk) })
    child.on('close', (code) => resolve({ code, output, error }))
  })))
}

test('trusted paid evidence confirms once and writes attempt, event and outbox atomically', () => {
  const w = world()
  try {
    const intent = createIntent(w)
    const paidEvidence = evidence(intent)
    const confirmed = confirmTrustedPayment(w.db, paidEvidence, { now: NOW })
    assert.equal(confirmed.outcome, 'confirmed')
    assert.equal(confirmed.intent.status, 'paid')
    assert.equal(confirmed.attempt?.status, 'paid')
    assert.ok(confirmed.outboxEventId)

    assert.equal(count(w.db, paymentIntents), 1)
    assert.equal(count(w.db, paymentAttempts), 1)
    assert.equal(count(w.db, paymentEvents), 2) // intent_created + channel_notification
    assert.equal(count(w.db, paymentOutbox), 1)
    assert.equal(count(w.db, paymentReviewExceptions), 0)

    const outbox = w.db.select().from(paymentOutbox).get()!
    assert.equal(outbox.topic, 'payment.paid.v1')
    assert.equal(outbox.status, 'pending')
    assert.equal(outbox.attempts, 0)
    const { payloadJson, ...outboxRow } = outbox
    const payload = paymentOutboxEventSchema.parse({
      ...outboxRow,
      availableAt: outbox.availableAt.toISOString(),
      createdAt: outbox.createdAt.toISOString(),
      updatedAt: outbox.updatedAt.toISOString(),
      deliveredAt: outbox.deliveredAt ? outbox.deliveredAt.toISOString() : null,
      payload: JSON.parse(payloadJson),
    })
    assert.equal(payload.payload.paymentIntentId, intent.id)
    assert.equal(payload.payload.amountCents, intent.netPayableCents)
    assert.equal(payload.payload.simulated, true)
    assert.equal(payload.payload.providerTransactionId, paidEvidence.providerTransactionId)

    const acceptedEvent = w.db.select().from(paymentEvents)
      .where(eq(paymentEvents.dedupeKey, paidEvidence.dedupeKey)).get()
    assert.match(acceptedEvent?.evidenceFingerprint ?? '', /^[0-9a-f]{64}$/)

    const replay = confirmTrustedPayment(w.db, paidEvidence, { now: NOW })
    assert.equal(replay.outcome, 'already_confirmed')
    assert.equal(count(w.db, paymentAttempts), 1)
    assert.equal(count(w.db, paymentEvents), 2)
    assert.equal(count(w.db, paymentOutbox), 1)

    // PAY-03 owns neither order completion, coupon nor ledger facts.
    const order = w.db.select().from(localOrders).where(eq(localOrders.id, w.orderId)).get()
    assert.equal(order?.status, 'registered')
    assert.equal(order?.verifiedByUserId, null)
    assert.equal(count(w.db, ledgerEntries), 0)
  } finally {
    w.sqlite.close()
  }
})

test('notification and query evidence for the same transaction converge once', () => {
  const w = world()
  try {
    const intent = createIntent(w)
    const transactionId = `wx-txn-${randomUUID()}`
    const notification = evidence(intent, {
      providerTransactionId: transactionId,
      source: 'notification',
      dedupeKey: 'notify-same-txn',
    })
    assert.equal(confirmTrustedPayment(w.db, notification, { now: NOW }).outcome, 'confirmed')

    const query = evidence(intent, {
      providerTransactionId: transactionId,
      source: 'query',
      dedupeKey: 'query-same-txn',
    })
    assert.equal(confirmTrustedPayment(w.db, query, { now: NOW }).outcome, 'already_confirmed')
    assert.equal(count(w.db, paymentAttempts), 1)
    assert.equal(count(w.db, paymentEvents), 3) // intent_created + both provider observations
    assert.equal(count(w.db, paymentOutbox), 1)
  } finally {
    w.sqlite.close()
  }
})

test('wrong amount, merchant, order and late success are refused and preserved for review', () => {
  const w = world()
  try {
    const intent = createIntent(w)

    assertLocalError('payment_evidence_rejected', () => confirmTrustedPayment(w.db, evidence(intent, {
      amountCents: intent.netPayableCents - 1,
      dedupeKey: 'wrong-amount',
    }), { now: NOW }))
    assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id)).get()?.status, 'pending')
    assert.equal(
      w.db.select().from(paymentReviewExceptions).where(eq(paymentReviewExceptions.dedupeKey, 'wrong-amount')).get()?.kind,
      'amount_mismatch',
    )

    assertLocalError('payment_evidence_rejected', () => confirmTrustedPayment(w.db, evidence(intent, {
      merchantAppId: 'wrong-app',
      merchantId: 'wrong-merchant',
      observedAt: '2026-11-17T01:59:00.000Z',
      providerEventRef: 'evt-wrong-merchant',
      failureCode: 'MCH_MISMATCH',
      failureMessage: '渠道商户号不一致',
      dedupeKey: 'wrong-merchant',
    }), { now: NOW }))
    const merchantException = w.db.select().from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.dedupeKey, 'wrong-merchant')).get()
    assert.equal(merchantException?.kind, 'merchant_mismatch')
    assert.equal(merchantException?.merchantAppId, 'wrong-app')
    assert.equal(merchantException?.merchantId, 'wrong-merchant')
    assert.equal(merchantException?.observedAt.getTime(), Date.parse('2026-11-17T01:59:00.000Z'))
    assert.equal(merchantException?.providerEventRef, 'evt-wrong-merchant')
    assert.equal(merchantException?.failureCode, 'MCH_MISMATCH')
    assert.equal(merchantException?.failureMessage, '渠道商户号不一致')

    assertLocalError('payment_evidence_rejected', () => confirmTrustedPayment(w.db, evidence(intent, {
      merchantOrderNo: 'PAY-UNKNOWN-ORDER-000000000001',
      dedupeKey: 'unknown-order',
    }), { now: NOW }))
    assert.equal(
      w.db.select().from(paymentReviewExceptions).where(eq(paymentReviewExceptions.dedupeKey, 'unknown-order')).get()?.kind,
      'intent_not_found',
    )

    // Close an intent, then present a trusted late success.
    const closedIntent = createIntent(w)
    const closedAt = new Date(NOW.getTime() + 1000)
    w.db.update(paymentIntents).set({ status: 'closed', closedAt, updatedAt: closedAt })
      .where(eq(paymentIntents.id, closedIntent.id)).run()
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, evidence(closedIntent, {
      dedupeKey: 'late-success',
    }), { now: closedAt }))
    assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, closedIntent.id)).get()?.status, 'closed')
    const late = w.db.select().from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.dedupeKey, 'late-success')).get()
    assert.equal(late?.kind, 'late_success_after_closed')
    assert.notEqual(late?.providerTransactionId, null)
    assert.equal(late?.amountCents, closedIntent.netPayableCents)
    assert.equal(w.db.select().from(paymentOutbox).all().length, 0)

    const open = listOpenPaymentReviewExceptions(w.db)
    assert.ok(open.length >= 4)
    for (const exception of open) paymentReviewExceptionSchema.parse(exception)
  } finally {
    w.sqlite.close()
  }
})

test('rejected keys stay reserved and altered accepted evidence is preserved for review', () => {
  const w = world()
  try {
    const intent = createIntent(w)
    const rejectedEvidence = evidence(intent, {
      amountCents: intent.netPayableCents - 1,
      dedupeKey: 'rejected-then-success',
      providerTransactionId: 'rejected-transaction',
    })
    assertLocalError('payment_evidence_rejected', () => confirmTrustedPayment(w.db, rejectedEvidence, { now: NOW }))

    const correctedEvidence = { ...rejectedEvidence, amountCents: intent.netPayableCents }
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, correctedEvidence, { now: NOW }))
    const rejectedSnapshots = w.db.select().from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.dedupeKey, 'rejected-then-success')).all()
    assert.equal(rejectedSnapshots.length, 2)
    assert.notEqual(rejectedSnapshots[0]?.evidenceFingerprint, rejectedSnapshots[1]?.evidenceFingerprint)
    assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id)).get()?.status, 'pending')
    assert.equal(count(w.db, paymentOutbox), 0)
    assert.equal(count(w.db, paymentEvents), 1) // intent_created

    const paidEvidence = evidence(intent, {
      dedupeKey: 'accepted-then-rejected',
      providerTransactionId: 'accepted-transaction',
    })
    assert.equal(confirmTrustedPayment(w.db, paidEvidence, { now: NOW }).outcome, 'confirmed')
    const alteredAcceptedEvidence = { ...paidEvidence, amountCents: paidEvidence.amountCents - 1 }
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, alteredAcceptedEvidence, { now: NOW }))
    const acceptedConflict = w.db.select().from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.dedupeKey, 'accepted-then-rejected')).get()
    assert.equal(acceptedConflict?.kind, 'transaction_conflict')
    assert.equal(acceptedConflict?.amountCents, alteredAcceptedEvidence.amountCents)

    // Exact conflict replay reuses its anomaly row; it does not grow the queue.
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, alteredAcceptedEvidence, { now: NOW }))
    assert.equal(count(w.db, paymentReviewExceptions), 3)
    assert.equal(count(w.db, paymentEvents), 2)
    assert.equal(count(w.db, paymentAttempts), 1)
    assert.equal(count(w.db, paymentOutbox), 1)
  } finally {
    w.sqlite.close()
  }
})

test('an accepted provider key cannot hide a different transaction id for the same intent', () => {
  const w = world()
  try {
    const intent = createIntent(w)
    const accepted = evidence(intent, {
      dedupeKey: 'same-intent-reused-key',
      providerTransactionId: 'provider-transaction-a',
      providerEventRef: 'provider-event-a',
    })
    assert.equal(confirmTrustedPayment(w.db, accepted, { now: NOW }).outcome, 'confirmed')

    const conflicting = {
      ...accepted,
      providerTransactionId: 'provider-transaction-b',
      providerEventRef: 'provider-event-b',
    }
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, conflicting, { now: NOW }))
    const anomalies = w.db.select().from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.dedupeKey, accepted.dedupeKey)).all()
    assert.equal(anomalies.length, 1)
    assert.equal(anomalies[0]?.kind, 'transaction_conflict')
    assert.equal(anomalies[0]?.providerTransactionId, 'provider-transaction-b')
    assert.equal(anomalies[0]?.evidenceFingerprint?.length, 64)
    const acceptedEvent = w.db.select().from(paymentEvents)
      .where(eq(paymentEvents.dedupeKey, accepted.dedupeKey)).get()
    assert.notEqual(anomalies[0]?.evidenceFingerprint, acceptedEvent?.evidenceFingerprint)

    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, conflicting, { now: NOW }))
    assert.equal(count(w.db, paymentReviewExceptions), 1)
    assert.equal(w.db.select().from(paymentIntents).get()?.status, 'paid')
    assert.equal(count(w.db, paymentAttempts), 1)
    assert.equal(count(w.db, paymentEvents), 2)
    assert.equal(count(w.db, paymentOutbox), 1)
  } finally {
    w.sqlite.close()
  }
})

test('an accepted provider key reused by another intent preserves the second intent evidence', () => {
  const w = world()
  try {
    const firstIntent = createIntent(w)
    const secondIntent = createIntent(w, 'second-intent', secondOrder(w))
    const accepted = evidence(firstIntent, {
      dedupeKey: 'cross-intent-reused-key',
      providerTransactionId: 'cross-intent-transaction-a',
    })
    assert.equal(confirmTrustedPayment(w.db, accepted, { now: NOW }).outcome, 'confirmed')

    const conflicting = evidence(secondIntent, {
      dedupeKey: accepted.dedupeKey,
      providerTransactionId: 'cross-intent-transaction-b',
    })
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, conflicting, { now: NOW }))
    const anomalies = w.db.select().from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.dedupeKey, accepted.dedupeKey)).all()
    assert.equal(anomalies.length, 1)
    assert.equal(anomalies[0]?.paymentIntentId, secondIntent.id)
    assert.equal(anomalies[0]?.merchantOrderNo, secondIntent.merchantOrderNo)
    assert.equal(anomalies[0]?.providerTransactionId, 'cross-intent-transaction-b')
    assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, secondIntent.id)).get()?.status, 'pending')
    assert.equal(count(w.db, paymentAttempts), 1)
    assert.equal(count(w.db, paymentEvents), 3) // two intent_created + one accepted provider event
    assert.equal(count(w.db, paymentOutbox), 1)
  } finally {
    w.sqlite.close()
  }
})

test('accepted keys preserve altered amount and merchant evidence without a second paid fact', () => {
  const w = world()
  try {
    const amountIntent = createIntent(w, 'accepted-amount')
    const acceptedAmount = evidence(amountIntent, {
      dedupeKey: 'accepted-amount-key',
      providerTransactionId: 'accepted-amount-transaction',
    })
    assert.equal(confirmTrustedPayment(w.db, acceptedAmount, { now: NOW }).outcome, 'confirmed')
    const alteredAmount = { ...acceptedAmount, amountCents: acceptedAmount.amountCents - 1 }
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, alteredAmount, { now: NOW }))
    const amountAnomaly = w.db.select().from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.dedupeKey, acceptedAmount.dedupeKey)).get()
    assert.equal(amountAnomaly?.amountCents, alteredAmount.amountCents)
    assert.equal(amountAnomaly?.kind, 'transaction_conflict')

    const merchantIntent = createIntent(w, 'accepted-merchant', secondOrder(w))
    const acceptedMerchant = evidence(merchantIntent, {
      dedupeKey: 'accepted-merchant-key',
      providerTransactionId: 'accepted-merchant-transaction',
    })
    assert.equal(confirmTrustedPayment(w.db, acceptedMerchant, { now: NOW }).outcome, 'confirmed')
    const alteredMerchant = {
      ...acceptedMerchant,
      merchantAppId: 'tampered-app',
      merchantId: 'tampered-merchant',
    }
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, alteredMerchant, { now: NOW }))
    const merchantAnomaly = w.db.select().from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.dedupeKey, acceptedMerchant.dedupeKey)).get()
    assert.equal(merchantAnomaly?.merchantAppId, 'tampered-app')
    assert.equal(merchantAnomaly?.merchantId, 'tampered-merchant')

    // Replaying either altered payload is idempotent at the anomaly layer.
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, alteredAmount, { now: NOW }))
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, alteredMerchant, { now: NOW }))
    assert.equal(count(w.db, paymentReviewExceptions), 2)
    assert.equal(count(w.db, paymentIntents), 2)
    assert.equal(count(w.db, paymentAttempts), 2)
    assert.equal(count(w.db, paymentEvents), 4)
    assert.equal(count(w.db, paymentOutbox), 2)
  } finally {
    w.sqlite.close()
  }
})

test('a WeChat intent without persisted merchant identity is refused even with full evidence', () => {
  const w = world()
  try {
    const orderId = secondOrder(w)
    const intentId = randomUUID()
    const createdAt = NOW
    const expiresAt = new Date(NOW.getTime() + 15 * 60 * 1000)
    w.db.insert(paymentIntents).values({
      id: intentId,
      localOrderId: orderId,
      residentUserId: w.userId,
      communityId: w.communityId,
      kind: 'channel',
      channel: 'wechat_jsapi',
      simulated: false,
      merchantOrderNo: `PAY-${intentId.replace(/-/gu, '').toUpperCase().slice(0, 28)}`,
      merchantAppId: null,
      merchantId: null,
      grossAmountCents: 3980,
      discountCents: 0,
      netPayableCents: 3980,
      status: 'pending',
      idempotencyKey: `wechat-missing-${intentId}`,
      expiresAt,
      paidAt: null,
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      createdAt,
      updatedAt: createdAt,
    }).run()
    const intent = toIntent(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).get()!)
    assertLocalError('payment_evidence_rejected', () => confirmTrustedPayment(w.db, evidence(intent, {
      channel: 'wechat_jsapi',
      merchantAppId: 'wx-real-app',
      merchantId: 'real-merchant',
      dedupeKey: 'wechat-intent-missing-merchant',
    }), { now: NOW }))
    assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).get()?.status, 'pending')
    const exception = w.db.select().from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.dedupeKey, 'wechat-intent-missing-merchant')).get()
    assert.equal(exception?.kind, 'merchant_mismatch')
    assert.equal(exception?.merchantAppId, 'wx-real-app')
    assert.equal(exception?.merchantId, 'real-merchant')
    assert.equal(count(w.db, paymentOutbox), 0)
  } finally {
    w.sqlite.close()
  }
})

test('a transaction id cannot be reused by another payment intent', () => {
  const w = world()
  try {
    const first = createIntent(w)
    const txn = `wx-txn-${randomUUID()}`
    assert.equal(confirmTrustedPayment(w.db, evidence(first, {
      providerTransactionId: txn,
      dedupeKey: 'first-confirm',
    }), { now: NOW }).outcome, 'confirmed')

    const second = createIntent(w, 'second-intent', secondOrder(w))
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, evidence(second, {
      providerTransactionId: txn,
      dedupeKey: 'second-conflict',
    }), { now: NOW }))
    assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, second.id)).get()?.status, 'pending')
    assert.equal(
      w.db.select().from(paymentReviewExceptions).where(eq(paymentReviewExceptions.dedupeKey, 'second-conflict')).get()?.kind,
      'transaction_conflict',
    )
  } finally {
    w.sqlite.close()
  }
})

test('terminal and pending evidence never produce paid or outbox', () => {
  const w = world()
  try {
    const failedIntent = createIntent(w)
    const failed = confirmTrustedPayment(w.db, evidence(failedIntent, {
      providerStatus: 'failed',
      providerTransactionId: null,
      failureCode: 'USER_CANCEL',
      failureMessage: '用户取消',
      dedupeKey: 'failed-evidence',
    }), { now: NOW })
    assert.equal(failed.intent.status, 'failed')
    assert.equal(failed.outboxEventId, null)
    assert.equal(w.db.select().from(paymentOutbox).all().length, 0)

    const pendingIntent = createIntent(w, 'pending-intent')
    const pending = confirmTrustedPayment(w.db, evidence(pendingIntent, {
      providerStatus: 'pending',
      providerTransactionId: null,
      dedupeKey: 'pending-evidence',
    }), { now: NOW })
    assert.equal(pending.intent.status, 'confirming')
    assert.equal(pending.outboxEventId, null)
    assert.equal(w.db.select().from(paymentOutbox).all().length, 0)
  } finally {
    w.sqlite.close()
  }
})

test('internal HTTP confirmation requires the server token and never accepts a resident session', async () => {
  const w = world()
  try {
    const intent = createIntent(w)
    const body = JSON.stringify(evidence(intent))

    const missingToken = await w.app.request('/internal/payments/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    assert.equal(missingToken.status, 401)
    assert.equal(
      apiErrorSchema.parse(await missingToken.json()).error.code,
      'payment_internal_unauthorized',
    )

    const invalidBody = await w.app.request('/internal/payments/confirm', {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({ ...evidence(intent), providerStatus: 'bogus' }),
    })
    assert.equal(invalidBody.status, 400)
    assert.equal(
      apiErrorSchema.parse(await invalidBody.json()).error.code,
      'invalid_request',
    )

    const valid = await w.app.request('/internal/payments/confirm', {
      method: 'POST',
      headers: internalHeaders(),
      body,
    })
    assert.equal(valid.status, 200)
    const result = paymentConfirmationResponseSchema.parse(await valid.json())
    assert.equal(result.outcome, 'confirmed')
    assert.equal(result.intent.status, 'paid')

    const cfg = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true', PAYMENT_MOCK_ENABLED: 'true' })
    const unconfiguredDb = createDatabase(':memory:', migrationsFolder)
    try {
      const unconfigured = createApp({ db: unconfiguredDb.db, config: cfg, logRequests: false })
      const unavailable = await unconfigured.request('/internal/payments/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      assert.equal(unavailable.status, 503)
      assert.equal(
        apiErrorSchema.parse(await unavailable.json()).error.code,
        'payment_internal_not_configured',
      )
    } finally {
      unconfiguredDb.sqlite.close()
    }
  } finally {
    w.sqlite.close()
  }
})

test('payment confirmation and pending outbox survive a database restart', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-pay-confirm-restart-'))
  const databasePath = join(tempDir, 'confirm.sqlite')
  let first: World | null = null
  let second: World | null = null
  try {
    first = world(databasePath)
    const intent = first ? createIntent(first) : undefined
    assert.ok(intent)
    const paidEvidence = evidence(intent!)
    assert.equal(confirmTrustedPayment(first!.db, paidEvidence, { now: NOW }).outcome, 'confirmed')
    first.sqlite.close()
    first = null

    const cfg = config(databasePath)
    const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
    second = { app: createApp({ db, config: cfg, logRequests: false }), db, sqlite, config: cfg, communityId: '', orderId: '', userId: '' }
    const restored = db.select().from(paymentIntents).all()
    assert.equal(restored.length, 1)
    assert.equal(restored[0]?.status, 'paid')
    const outbox = db.select().from(paymentOutbox).all()
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0]?.status, 'pending')

    // A retry after restart is an idempotent replay, not a second paid fact.
    const replay = confirmTrustedPayment(db, paidEvidence, { now: NOW })
    assert.equal(replay.outcome, 'already_confirmed')
    assert.equal(db.select().from(paymentAttempts).all().length, 1)
    assert.equal(db.select().from(paymentOutbox).all().length, 1)
  } finally {
    first?.sqlite.close()
    second?.sqlite.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('two independent processes and SQLite connections converge without duplicate paid side effects', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-pay-confirm-race-'))
  const databasePath = join(tempDir, 'race.sqlite')
  const w = world(databasePath)
  try {
    const intent = createIntent(w)
    const paidEvidence = evidence(intent)
    const results = await runConfirmationWorkers(databasePath, [paidEvidence, paidEvidence])
    const parsed = results.map((result) => {
      assert.equal(result.code, 0, `worker failed: ${result.error}`)
      return JSON.parse(result.output) as { ok: boolean; outcome: string }
    })
    assert.deepEqual(
      parsed.map((result) => result.outcome).sort(),
      ['already_confirmed', 'confirmed'],
    )

    assert.equal(w.db.select().from(paymentIntents).get()?.status, 'paid')
    assert.equal(count(w.db, paymentAttempts), 1)
    assert.equal(count(w.db, paymentEvents), 2)
    assert.equal(count(w.db, paymentOutbox), 1)
    assert.equal(count(w.db, paymentReviewExceptions), 0)
  } finally {
    w.sqlite.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('pending evidence can later converge to paid without losing the attempt', () => {
  const w = world()
  try {
    const intent = createIntent(w)
    const txn = `wx-txn-${randomUUID()}`
    const pending = confirmTrustedPayment(w.db, evidence(intent, {
      providerStatus: 'pending',
      providerTransactionId: txn,
      dedupeKey: 'pending-before-paid',
    }), { now: NOW })
    assert.equal(pending.intent.status, 'confirming')
    assert.equal(pending.attempt?.status, 'confirming')
    assert.equal(pending.attempt?.providerTransactionId, txn)

    const paid = confirmTrustedPayment(w.db, evidence(intent, {
      providerTransactionId: txn,
      dedupeKey: 'paid-after-pending',
    }), { now: new Date(NOW.getTime() + 1000) })
    assert.equal(paid.outcome, 'confirmed')
    assert.equal(paid.attempt?.status, 'paid')
    assert.equal(paid.attempt?.providerTransactionId, txn)
    assert.equal(count(w.db, paymentAttempts), 1)
    assert.equal(count(w.db, paymentOutbox), 1)
  } finally {
    w.sqlite.close()
  }
})

test('repeated pending query evidence reuses one open attempt', () => {
  const w = world()
  try {
    const intent = createIntent(w)
    const first = confirmTrustedPayment(w.db, evidence(intent, {
      providerStatus: 'pending',
      providerTransactionId: null,
      dedupeKey: 'pending-query-1',
    }), { now: NOW })
    const second = confirmTrustedPayment(w.db, evidence(intent, {
      providerStatus: 'pending',
      providerTransactionId: null,
      dedupeKey: 'pending-query-2',
    }), { now: new Date(NOW.getTime() + 1000) })
    assert.equal(first.attempt?.id, second.attempt?.id)
    assert.equal(second.attempt?.status, 'confirming')
    assert.equal(count(w.db, paymentAttempts), 1)
    assert.equal(count(w.db, paymentOutbox), 0)
  } finally {
    w.sqlite.close()
  }
})

test('paid intent never accepts terminal evidence and late success after failure is preserved', () => {
  const w = world()
  try {
    const paidIntent = createIntent(w)
    assert.equal(confirmTrustedPayment(w.db, evidence(paidIntent), { now: NOW }).outcome, 'confirmed')
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, evidence(paidIntent, {
      providerStatus: 'failed',
      providerTransactionId: null,
      failureCode: 'CHANNEL_FAILURE',
      failureMessage: '渠道失败',
      dedupeKey: 'paid-then-failed',
    }), { now: NOW }))
    assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, paidIntent.id)).get()?.status, 'paid')
    assert.equal(
      w.db.select().from(paymentReviewExceptions).where(eq(paymentReviewExceptions.dedupeKey, 'paid-then-failed')).get()?.kind,
      'terminal_conflict',
    )
    assert.equal(count(w.db, paymentOutbox), 1)

    const failedIntent = createIntent(w, 'failed-late', secondOrder(w))
    assert.equal(confirmTrustedPayment(w.db, evidence(failedIntent, {
      providerStatus: 'failed',
      providerTransactionId: null,
      failureCode: 'EXPIRED',
      failureMessage: '已过期',
      dedupeKey: 'failed-first',
    }), { now: NOW }).intent.status, 'failed')
    assertLocalError('payment_confirmation_conflict', () => confirmTrustedPayment(w.db, evidence(failedIntent, {
      dedupeKey: 'late-after-failed',
    }), { now: NOW }))
    assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, failedIntent.id)).get()?.status, 'failed')
    const late = w.db.select().from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.dedupeKey, 'late-after-failed')).get()
    assert.equal(late?.kind, 'late_success_after_failed')
    assert.notEqual(late?.providerTransactionId, null)
    assert.equal(count(w.db, paymentOutbox), 1)
  } finally {
    w.sqlite.close()
  }
})

test('a failure after intent/attempt updates rolls the whole paid confirmation back', () => {
  const w = world()
  try {
    const intent = createIntent(w)
    const fakeEventId = randomUUID()
    w.db.insert(paymentEvents).values({
      id: fakeEventId,
      paymentIntentId: intent.id,
      paymentAttemptId: null,
      eventType: 'payment.intent_created',
      source: 'system',
      fromStatus: null,
      toStatus: 'pending',
      providerEventRef: null,
      dedupeKey: 'fake-existing-event',
      note: null,
      createdAt: NOW,
    }).run()
    // Pre-claim the outbox dedupe key so the confirmation must fail after the
    // intent and attempt updates have already run inside its transaction.
    w.db.insert(paymentOutbox).values({
      id: randomUUID(),
      paymentIntentId: intent.id,
      paymentEventId: fakeEventId,
      topic: 'payment.paid.v1',
      dedupeKey: `payment.paid:${intent.id}`,
      payloadJson: '{"test":true}',
      status: 'pending',
      attempts: 0,
      availableAt: NOW,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
      deliveredAt: null,
    }).run()

    assert.throws(() => confirmTrustedPayment(w.db, evidence(intent), { now: NOW }))
    assert.equal(w.db.select().from(paymentIntents).where(eq(paymentIntents.id, intent.id)).get()?.status, 'pending')
    assert.equal(count(w.db, paymentAttempts), 0)
    assert.equal(count(w.db, paymentEvents), 2) // intent_created + the deliberately fake event
    assert.equal(count(w.db, paymentOutbox), 1)
  } finally {
    w.sqlite.close()
  }
})

test('outbox and review evidence reject deletes and identity mutation', () => {
  const w = world()
  try {
    const intent = createIntent(w)
    assert.equal(confirmTrustedPayment(w.db, evidence(intent), { now: NOW }).outcome, 'confirmed')
    const outbox = w.db.select().from(paymentOutbox).get()!
    const channelEvent = w.db.select().from(paymentEvents)
      .where(eq(paymentEvents.eventType, 'payment.channel_notification')).get()!
    assert.throws(() => w.sqlite.prepare('UPDATE payment_events SET evidence_fingerprint = ? WHERE id = ?')
      .run('f'.repeat(64), channelEvent.id))
    assert.throws(() => w.sqlite.prepare('DELETE FROM payment_outbox WHERE id = ?').run(outbox.id))
    assert.throws(() => w.sqlite.prepare('UPDATE payment_outbox SET payload_json = ? WHERE id = ?')
      .run('{}', outbox.id))
    assert.doesNotThrow(() => w.sqlite.prepare('UPDATE payment_outbox SET attempts = attempts + 1 WHERE id = ?')
      .run(outbox.id))

    const invalidIntent = createIntent(w, 'exception-intent', secondOrder(w))
    assertLocalError('payment_evidence_rejected', () => confirmTrustedPayment(w.db, evidence(invalidIntent, {
      amountCents: invalidIntent.netPayableCents + 1,
      dedupeKey: 'durable-exception',
    }), { now: NOW }))
    const exception = w.db.select().from(paymentReviewExceptions).get()!
    assert.throws(() => w.sqlite.prepare('DELETE FROM payment_review_exceptions WHERE id = ?').run(exception.id))
    assert.throws(() => w.sqlite.prepare('UPDATE payment_review_exceptions SET amount_cents = 0 WHERE id = ?')
      .run(exception.id))
    assert.throws(() => w.sqlite.prepare('UPDATE payment_review_exceptions SET merchant_id = ? WHERE id = ?')
      .run('other-merchant', exception.id))
    assert.throws(() => w.sqlite.prepare('UPDATE payment_review_exceptions SET evidence_fingerprint = ? WHERE id = ?')
      .run('f'.repeat(64), exception.id))
    assert.doesNotThrow(() => w.sqlite.prepare(`UPDATE payment_review_exceptions
      SET status = 'resolved', resolved_at = ? WHERE id = ?`).run(NOW.getTime(), exception.id))
  } finally {
    w.sqlite.close()
  }
})

test('competing different transactions across processes produce exactly one paid fact', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-pay-confirm-distinct-race-'))
  const databasePath = join(tempDir, 'distinct-race.sqlite')
  const w = world(databasePath)
  try {
    const intent = createIntent(w)
    const results = await runConfirmationWorkers(databasePath, [
      evidence(intent, { dedupeKey: 'distinct-a' }),
      evidence(intent, { dedupeKey: 'distinct-b' }),
    ])
    const parsed = results.map((result) => JSON.parse(result.output) as {
      ok: boolean
      outcome?: string
      status?: number
      code?: string
    })
    assert.deepEqual(
      parsed.filter((item) => item.ok).map((item) => item.outcome),
      ['confirmed'],
    )
    const rejected = parsed.filter((item) => !item.ok)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0]?.status, 409)
    assert.equal(rejected[0]?.code, 'payment_confirmation_conflict')

    assert.equal(w.db.select().from(paymentIntents).get()?.status, 'paid')
    assert.equal(count(w.db, paymentAttempts), 1)
    assert.equal(count(w.db, paymentOutbox), 1)
    const conflicts = w.db.select().from(paymentReviewExceptions).all()
    assert.equal(conflicts.length, 1)
    assert.equal(conflicts[0]?.kind, 'transaction_conflict')
    for (const result of results) assert.ok(result.output.length > 0, result.error)
  } finally {
    w.sqlite.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('notification and query races across processes produce one paid fact', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-pay-confirm-notify-query-race-'))
  const databasePath = join(tempDir, 'notify-query.sqlite')
  const w = world(databasePath)
  try {
    const intent = createIntent(w)
    const txn = `wx-txn-${randomUUID()}`
    const results = await runConfirmationWorkers(databasePath, [
      evidence(intent, {
        providerTransactionId: txn,
        source: 'notification',
        dedupeKey: 'race-notification',
      }),
      evidence(intent, {
        providerTransactionId: txn,
        source: 'query',
        dedupeKey: 'race-query',
      }),
    ])
    const parsed = results.map((result) => {
      assert.equal(result.code, 0, `worker failed: ${result.error}`)
      return JSON.parse(result.output) as { ok: boolean; outcome: string }
    })
    assert.deepEqual(
      parsed.map((item) => item.outcome).sort(),
      ['already_confirmed', 'confirmed'],
    )
    assert.equal(w.db.select().from(paymentIntents).get()?.status, 'paid')
    assert.equal(count(w.db, paymentAttempts), 1)
    assert.equal(count(w.db, paymentEvents), 3) // intent_created + both provider observations
    assert.equal(count(w.db, paymentOutbox), 1)
  } finally {
    w.sqlite.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})
