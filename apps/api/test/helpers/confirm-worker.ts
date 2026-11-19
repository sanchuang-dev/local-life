import { fileURLToPath } from 'node:url'
import type { PaymentEvidence } from '@sanchuang-dev/local-life-contracts'
import { createDatabase } from '../../src/db/client.js'
import { confirmTrustedPayment } from '../../src/payments/confirmation.js'

const databasePath = process.env.CONFIRM_DB_PATH
const evidenceJson = process.env.CONFIRM_EVIDENCE
const nowValue = process.env.CONFIRM_NOW
if (!databasePath || !evidenceJson || !nowValue) {
  throw new Error('missing worker environment')
}

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
try {
  const result = confirmTrustedPayment(
    db,
    JSON.parse(evidenceJson) as PaymentEvidence,
    { now: new Date(nowValue) },
  )
  process.stdout.write(JSON.stringify({ ok: true, outcome: result.outcome }))
} catch (error) {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status: unknown }).status
    : null
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : null
  process.stdout.write(JSON.stringify({ ok: false, status, code }))
  process.exitCode = 1
} finally {
  sqlite.close()
}
