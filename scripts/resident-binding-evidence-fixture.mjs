/**
 * Lead-side evidence fixture for LL-IDENTITY-001 (#171).
 *
 * Builds a REAL SQLite database by executing the real migration chain
 * (`apps/api/db/migrations/*.sql` in journal order), then inserts the three legacy
 * shapes a production database can hold (0 / 1 / many historical
 * resident->community relations) plus real business facts hanging off those
 * residents. Nothing is faked or mocked: the resulting file is handed to
 * `scripts/resident-binding-preflight.mjs`, so the preflight output quoted in the
 * PR is produced from a database a real deployment could actually be in.
 *
 * It uses `node:sqlite` (the same driver as the preflight tool) so no workspace
 * package resolution is involved.
 *
 * Usage: node scripts/resident-binding-evidence-fixture.mjs <out-sqlite>
 */
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsFolder = resolve(repoRoot, 'apps/api/db/migrations')

const out = process.argv[2]
if (!out) {
  console.error('usage: node scripts/resident-binding-evidence-fixture.mjs <out-sqlite>')
  process.exit(1)
}
const databasePath = resolve(process.cwd(), out)
rmSync(databasePath, { force: true })

const db = new DatabaseSync(databasePath)
db.exec('PRAGMA foreign_keys = ON')

// Apply every migration in filename order; `0018` creates the #171 tables, so the
// fixture database is schema-identical to a migrated deployment.
const migrationFiles = readdirSync(migrationsFolder)
  .filter((name) => name.endsWith('.sql'))
  .sort()
for (const name of migrationFiles) {
  const sql = readFileSync(resolve(migrationsFolder, name), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed.length > 0) db.exec(trimmed)
  }
}

const now = Date.now()
const communityA = randomUUID()
const communityB = randomUUID()
db.prepare(
  `INSERT INTO communities (id, name, address, latitude_gcj02, longitude_gcj02, created_at)
   VALUES (?, '阳光社区', '阳光路 1 号', 39.9, 116.4, ?), (?, '月亮社区', '月亮路 2 号', 39.8, 116.5, ?)`,
).run(communityA, now, communityB, now)

// 0 / 1 / many historical relations: exactly the three buckets the preflight
// reports, and the three the product decision treats differently.
const residents = [
  { id: randomUUID(), relations: [] },
  { id: randomUUID(), relations: [communityA] },
  { id: randomUUID(), relations: [communityA, communityB] },
]
for (const resident of residents) {
  db.prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(resident.id, '居民', now, now)
  resident.relations.forEach((communityId, index) => {
    db.prepare(
      'INSERT INTO resident_community_assignments (user_id, community_id, created_at) VALUES (?, ?, ?)',
    ).run(resident.id, communityId, now + index)
  })
}

// Real business facts attached to the ambiguous (2-relation) resident: an order and
// a ledger entry, so the preflight has to surface them for human adjudication.
const productId = randomUUID()
db.prepare(
  `INSERT INTO local_products (id, community_id, name, unit_price_cents, status, created_at, updated_at)
   VALUES (?, ?, '社区套餐', 1990, 'on_shelf', ?, ?)`,
).run(productId, communityA, now, now)
db.prepare(
  `INSERT INTO local_orders (
     id, community_id, resident_user_id, product_id, product_name, unit_price_cents,
     quantity, total_cents, status, record_source, idempotency_key, created_at, updated_at
   ) VALUES (?, ?, ?, ?, '社区套餐', 1990, 1, 1990, 'registered', 'resident', 'fixture-1', ?, ?)`,
).run(randomUUID(), communityA, residents[2].id, productId, now, now)
db.prepare(
  `INSERT INTO ledger_entries (
     id, fact_kind, source_system, source_id, source_display_no, community_id, product_id,
     attribution_state, attribution_basis, amount_cents, settlement_amount_status,
     occurred_at, evidence_kind, created_at
   ) VALUES (?, 'order_registered', 'local_order', ?, 'FIXTURE-1', ?, ?, 'pending',
     'no_explicit_attribution', 1990, 'pending_rule', ?, 'none', ?)`,
).run(randomUUID(), communityA, communityA, productId, now, now)

db.close()
console.log(JSON.stringify({
  databasePath,
  migrationsApplied: migrationFiles.length,
  communities: { A: communityA, B: communityB },
  residents: {
    zeroRelations: residents[0].id,
    singleRelation: residents[1].id,
    twoRelations: residents[2].id,
  },
}, null, 2))
