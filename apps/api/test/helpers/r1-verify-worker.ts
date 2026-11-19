import { fileURLToPath } from 'node:url'
import type { LocalOrderVerifyRequest } from '@sanchuang-dev/local-life-contracts'
import { createDatabase } from '../../src/db/client.js'
import { verifyOrder } from '../../src/local/orders.js'
import type { LocalActor } from '../../src/local/shared.js'

/**
 * One independent R1 manual-verification process.
 *
 * Used by the dual-process race test so the manual/online boundary is proven
 * across real processes and real better-sqlite3 connections, not inside one event
 * loop.
 */
const databasePath = process.env.R1_VERIFY_DB_PATH
const orderId = process.env.R1_VERIFY_ORDER_ID
const actorJson = process.env.R1_VERIFY_ACTOR
const bodyJson = process.env.R1_VERIFY_BODY
if (!databasePath || !orderId || !actorJson || !bodyJson) {
  throw new Error('missing verify worker environment')
}

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
try {
  const detail = verifyOrder(
    db,
    JSON.parse(actorJson) as LocalActor,
    orderId,
    JSON.parse(bodyJson) as LocalOrderVerifyRequest,
  )
  process.stdout.write(JSON.stringify({ ok: true, status: detail.status }))
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
