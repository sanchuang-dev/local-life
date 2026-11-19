import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../src/config.js'
import { createDatabase } from '../../src/db/client.js'
import {
  executeMockPaymentAction,
  type MockPaymentAction,
  type MockPaymentSource,
} from '../../src/payments/mock-channel.js'

const databasePath = process.env.MOCK_DB_PATH
const intentId = process.env.MOCK_INTENT_ID
const action = process.env.MOCK_ACTION as MockPaymentAction | undefined
const source = process.env.MOCK_SOURCE as MockPaymentSource | undefined
const nowValue = process.env.MOCK_NOW
if (!databasePath || !intentId || !action || !source || !nowValue) {
  throw new Error('missing mock worker environment')
}

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
try {
  const result = executeMockPaymentAction(
    db,
    loadConfig({ NODE_ENV: 'test', PAYMENT_MOCK_ENABLED: 'true' }),
    { paymentIntentId: intentId, action, source },
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
