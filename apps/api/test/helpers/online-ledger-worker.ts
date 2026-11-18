import { fileURLToPath } from 'node:url'
import { createDatabase } from '../../src/db/client.js'
import { projectOnlineCompletionsToLedger } from '../../src/ledger/service.js'

const databasePath = process.env.ONLINE_LEDGER_DB
const nowValue = process.env.ONLINE_LEDGER_NOW
if (!databasePath || !nowValue) throw new Error('missing online ledger worker environment')

const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url))
const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
try {
  const result = projectOnlineCompletionsToLedger(db, { now: new Date(nowValue) })
  process.stdout.write(JSON.stringify(result))
} finally {
  sqlite.close()
}
