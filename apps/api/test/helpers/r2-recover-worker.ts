import { fileURLToPath } from 'node:url'
import { createDatabase } from '../../src/db/client.js'
import { recoverParkedPaymentOutboxEvent } from '../../src/payments/outbox.js'

/**
 * One independent R2 recovery process. Two of these race the same parked event,
 * proving the `failed -> pending` conditional transition and the idempotent
 * projection still complete the order exactly once across real processes.
 */
const databasePath = process.env.R2_RECOVER_DB_PATH
const outboxEventId = process.env.R2_RECOVER_OUTBOX_ID
const nowValue = process.env.R2_RECOVER_NOW
if (!databasePath || !outboxEventId || !nowValue) {
  throw new Error('missing recovery worker environment')
}

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
try {
  const result = recoverParkedPaymentOutboxEvent(db, outboxEventId, {
    now: new Date(nowValue),
  })
  process.stdout.write(JSON.stringify({ ok: true, result }))
} catch (error) {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status: unknown }).status
    : null
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : null
  process.stdout.write(JSON.stringify({
    ok: false,
    status,
    code,
    message: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
} finally {
  sqlite.close()
}
