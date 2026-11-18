import { fileURLToPath } from 'node:url'
import type { RecordPaymentRequest } from '../../src/ledger/service.js'
import { recordPayment } from '../../src/ledger/service.js'
import { createDatabase } from '../../src/db/client.js'
import type { LocalActor } from '../../src/local/shared.js'

/**
 * One independent manual-receipt process. Two of these race the same verified
 * order, proving the existing order-link uniqueness still yields exactly one
 * manual ledger link under real cross-process concurrency.
 */
const databasePath = process.env.R1_RECEIPT_DB_PATH
const actorJson = process.env.R1_RECEIPT_ACTOR
const requestJson = process.env.R1_RECEIPT_REQUEST
const nowValue = process.env.R1_RECEIPT_NOW
if (!databasePath || !actorJson || !requestJson || !nowValue) {
  throw new Error('missing receipt worker environment')
}

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
try {
  const entry = recordPayment(
    db,
    JSON.parse(actorJson) as LocalActor,
    JSON.parse(requestJson) as RecordPaymentRequest,
    { now: new Date(nowValue) },
  )
  process.stdout.write(JSON.stringify({ ok: true, entryId: entry.entryId }))
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
