import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

const [command, databasePath, outputPath] = process.argv.slice(2)
if (!['verify', 'backup'].includes(command) || !databasePath) {
  throw new Error('Usage: verify-db.mjs verify|backup DB_PATH [BACKUP_PATH]')
}
if (command === 'backup' && !outputPath) {
  throw new Error('Backup destination required')
}

const journal = JSON.parse(
  readFileSync(new URL('./db/migrations/meta/_journal.json', import.meta.url), 'utf8'),
)
const expectedMigrations = journal.entries.length
if (!expectedMigrations) throw new Error('Missing Drizzle migration journal')

const verify = (path) => {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const integrity = db.pragma('quick_check', { simple: true })
    if (integrity !== 'ok') throw new Error('SQLite quick_check failed')
    if (db.pragma('foreign_key_check').length > 0) {
      throw new Error('SQLite foreign_key_check failed')
    }
    const row = db.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()
    if (row.count !== expectedMigrations) {
      throw new Error(
        'Drizzle migration count does not match journal: ' +
        row.count + ' vs ' + expectedMigrations,
      )
    }
    return { db, migrationCount: row.count }
  } catch (error) {
    db.close()
    throw error
  }
}

const { db, migrationCount } = verify(databasePath)
try {
  if (command === 'backup') {
    await db.backup(outputPath)
  }
} finally {
  db.close()
}
if (command === 'backup') {
  const copied = verify(outputPath)
  copied.db.close()
  console.log('BT_SQLITE_RESTORABLE_BACKUP_OK=yes')
}
console.log('BT_SQLITE_QUICK_CHECK=ok')
console.log('BT_SQLITE_FOREIGN_KEYS=ok')
console.log('BT_DATABASE_MIGRATIONS=' + migrationCount)
