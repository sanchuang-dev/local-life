import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema.js'

export type AppDatabase = BetterSQLite3Database<typeof schema>
export type SqliteConnection = InstanceType<typeof Database>

/**
 * Stable identity of one foreign-key violation, used to distinguish a
 * pre-existing data inconsistency from one this migration run introduced.
 */
function foreignKeyViolationKeys(sqlite: SqliteConnection): string[] {
  const rows = sqlite.pragma('foreign_key_check') as Array<{
    table: string
    rowid: number
    parent: string
    fkid: number
  }>
  return rows.map((row) => `${row.table}:${row.rowid}:${row.parent}:${row.fkid}`)
}

export function createDatabase(
  databasePath: string,
  migrationsFolder: string,
): { db: AppDatabase; sqlite: SqliteConnection } {
  const absolutePath =
    databasePath === ':memory:' ? databasePath : resolve(process.cwd(), databasePath)

  if (absolutePath !== ':memory:') {
    mkdirSync(dirname(absolutePath), { recursive: true })
  }

  const sqlite = new Database(absolutePath)
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')

  const db = drizzle(sqlite, { schema })

  // A historical database may already carry an inconsistency that predates the
  // current triggers; upgrading must not turn that into a startup outage, so only
  // violations introduced by this run fail closed below.
  const preexistingViolations = new Set(foreignKeyViolationKeys(sqlite))

  // Migrations include same-shape table rebuilds (SQLite cannot alter a CHECK
  // constraint), e.g. PAY-05 extends the local order status vocabulary. The
  // documented SQLite procedure for that is to disable foreign-key enforcement
  // while the schema is rewritten and then prove the database is still
  // consistent. Both pragmas must sit outside the migrator's transaction, which
  // is why they live here rather than in a migration file.
  sqlite.pragma('foreign_keys = OFF')
  try {
    migrate(db, { migrationsFolder: resolve(migrationsFolder) })
  } finally {
    sqlite.pragma('foreign_keys = ON')
    // Rebuild migrations may switch to legacy rename semantics; keep the
    // connection on SQLite's default behaviour afterwards.
    sqlite.pragma('legacy_alter_table = OFF')
  }

  const introduced = foreignKeyViolationKeys(sqlite)
    .filter((key) => !preexistingViolations.has(key))
  if (introduced.length > 0) {
    const tables = [...new Set(introduced.map((key) => key.split(':', 1)[0]))].join(', ')
    sqlite.close()
    throw new Error(`数据库迁移引入了外键一致性破坏（${introduced.length} 行）：${tables}`)
  }

  return { db, sqlite }
}
