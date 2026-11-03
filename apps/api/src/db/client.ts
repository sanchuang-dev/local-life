import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema.js'

export type AppDatabase = BetterSQLite3Database<typeof schema>
export type SqliteConnection = InstanceType<typeof Database>

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
  migrate(db, { migrationsFolder: resolve(migrationsFolder) })

  return { db, sqlite }
}
