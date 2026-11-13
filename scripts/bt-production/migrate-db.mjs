// Database-only migration entrypoint. Runs in a reviewed release's API CWD.
// Do not invoke the HTTP listener or touch production credentials during trial.
import { resolve } from 'node:path'
import { createDatabase } from './dist/db/client.js'

const path = process.argv[2]
if (!path || !path.startsWith('/') || path === '/') {
  throw new Error('Absolute SQLite database path required')
}
const expected = resolve(path)
const { sqlite } = createDatabase(expected, './db/migrations')
try {
  if (sqlite.pragma('quick_check', { simple: true }) !== 'ok') {
    throw new Error('SQLite quick_check failed after migration')
  }
  if (sqlite.pragma('foreign_key_check').length > 0) {
    throw new Error('SQLite foreign_key_check failed after migration')
  }
  console.log('BT_DB_MIGRATION_COMPLETED=yes')
} finally {
  sqlite.close()
}
