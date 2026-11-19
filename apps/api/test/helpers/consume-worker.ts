import { fileURLToPath } from 'node:url'
import { createDatabase } from '../../src/db/client.js'
import { runPaymentOutboxConsumer } from '../../src/payments/outbox.js'

/**
 * One independent PAY-05 consumer process.
 *
 * Used by the concurrency test so the claim/projection race is proven across real
 * processes and real better-sqlite3 connections, not inside one event loop.
 */
const databasePath = process.env.CONSUME_DB_PATH
const nowValue = process.env.CONSUME_NOW
if (!databasePath || !nowValue) {
  throw new Error('missing worker environment')
}

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
try {
  const result = runPaymentOutboxConsumer(db, { now: new Date(nowValue) })
  process.stdout.write(JSON.stringify({ ok: true, result }))
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
} finally {
  sqlite.close()
}
