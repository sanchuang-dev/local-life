import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { PaymentEvidence } from '@sanchuang-dev/local-life-contracts'
import { loadConfig } from '../../src/config.js'
import { createDatabase } from '../../src/db/client.js'
import { confirmTrustedPayment } from '../../src/payments/confirmation.js'
import { runPaymentOutboxConsumer } from '../../src/payments/outbox.js'
import { createPaymentIntent } from '../../src/payments/service.js'

/**
 * One independent R1 online process: optionally create a Mock payment intent,
 * confirm trusted evidence, then drive the completion consumer.
 *
 * The create step races a manual verification in another process; only one of
 * "order verified manually" and "order completed online" may win.
 */
const databasePath = process.env.R1_ONLINE_DB_PATH
const nowValue = process.env.R1_ONLINE_NOW
if (!databasePath || !nowValue) throw new Error('missing online worker environment')
const now = new Date(nowValue)
const createJson = process.env.R1_ONLINE_CREATE
const residentUserId = process.env.R1_ONLINE_RESIDENT
const communityId = process.env.R1_ONLINE_COMMUNITY
const orderId = process.env.R1_ONLINE_ORDER_ID
if (!residentUserId || !communityId || !orderId) {
  throw new Error('missing online worker identity')
}

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
const config = loadConfig({
  NODE_ENV: 'test',
  PAYMENT_MOCK_ENABLED: 'true',
  PAYMENT_INTERNAL_TOKEN: 'r1-worker-internal-token'.padEnd(40, 'x'),
})
try {
  const createResult: { ok: boolean; status?: number; code?: string; intentId?: string } = {
    ok: true,
  }
  let merchantOrderNo: string | null = null
  let amountCents = 0
  if (createJson) {
    try {
      const intent = createPaymentIntent(
        db,
        config,
        { userId: residentUserId, staffId: null, role: null },
        JSON.parse(createJson) as { localOrderId: string; channel: 'mock'; idempotencyKey: string },
        { now },
      ).intent
      createResult.intentId = intent.id
      merchantOrderNo = intent.merchantOrderNo
      amountCents = intent.netPayableCents
    } catch (error) {
      createResult.ok = false
      createResult.status = typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status: number }).status
        : undefined
      createResult.code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined
    }
  }

  let confirmOutcome: string | null = null
  let confirmCode: string | null = null
  let consumer: unknown = null
  if (merchantOrderNo) {
    const evidence: PaymentEvidence = {
      merchantOrderNo,
      channel: 'mock',
      providerStatus: 'paid',
      providerTransactionId: `MOCK-TXN-${randomUUID()}`,
      amountCents,
      currency: 'CNY',
      merchantAppId: null,
      merchantId: null,
      observedAt: now.toISOString(),
      source: 'notification',
      dedupeKey: `r1-race-${randomUUID()}`,
      providerEventRef: null,
      failureCode: null,
      failureMessage: null,
    }
    try {
      confirmOutcome = confirmTrustedPayment(db, evidence, { now }).outcome
    } catch (error) {
      confirmCode = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unknown'
    }
    consumer = runPaymentOutboxConsumer(db, { now })
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    create: createResult,
    confirmOutcome,
    confirmCode,
    consumer,
  }))
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
} finally {
  sqlite.close()
}
