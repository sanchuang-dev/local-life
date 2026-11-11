import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

/**
 * LL-IDENTITY-001 (#171) read-only proof.
 *
 * The PR claims the preflight tool cannot modify a production database. This test
 * proves the claim at the level that matters: SQLite itself refuses every write on
 * a `{ readOnly: true }` handle, so no future edit to the tool's own SQL can turn
 * the check into a mutation.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtureScript = join(repoRoot, 'scripts/resident-binding-evidence-fixture.mjs')
const proofScript = join(repoRoot, 'scripts/resident-binding-readonly-proof.mjs')
const preflightScript = join(repoRoot, 'scripts/resident-binding-preflight.mjs')

function withFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'll-resident-binding-'))
  const databasePath = join(directory, 'evidence.sqlite')
  try {
    execFileSync(process.execPath, [fixtureScript, databasePath], { cwd: repoRoot, stdio: 'pipe' })
    run(databasePath)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Row counts of every table a write could plausibly touch. */
function snapshotCounts(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const tables = [
      'users',
      'communities',
      'resident_community_assignments',
      'resident_community_bindings',
      'resident_community_binding_candidates',
      'local_orders',
      'local_products',
      'ledger_entries',
    ]
    return Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]),
    )
  } finally {
    db.close()
  }
}

test('the read-only proof script refuses every write on a readOnly handle', () => {
  withFixture((databasePath) => {
    const stdout = execFileSync(process.execPath, [proofScript, databasePath], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    const result = JSON.parse(stdout)
    assert.equal(result.readOnly, true)
    assert.equal(result.allWritesRefused, true)
    assert.ok(result.results.length >= 4, 'every write shape is attempted')
    for (const row of result.results) {
      assert.equal(row.refused, true, `${row.sql} must be refused`)
      assert.match(row.error, /readonly database|read-only/iu)
    }
  })
})

test('running the preflight leaves the database byte-identical and never writes a row', () => {
  withFixture((databasePath) => {
    const before = snapshotCounts(databasePath)
    const bytesBefore = readFileSync(databasePath)
    execFileSync(process.execPath, [preflightScript, databasePath, '--json'], {
      cwd: repoRoot,
      stdio: 'pipe',
    })
    const after = snapshotCounts(databasePath)
    const bytesAfter = readFileSync(databasePath)
    assert.deepEqual(after, before, 'no row count changed')
    assert.equal(Buffer.compare(bytesBefore, bytesAfter), 0, 'the file is byte-identical')
  })
})

test('the preflight reports unrunnable input instead of pretending an empty database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'll-resident-binding-missing-'))
  const missing = join(directory, 'never-created.sqlite')
  try {
    assert.throws(
      () => execFileSync(process.execPath, [preflightScript, missing], { cwd: repoRoot, stdio: 'pipe' }),
      (error) => error.status !== 0,
      'a path that does not exist must fail instead of reporting zeros',
    )
    assert.equal(readFileSync.length > 0, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the fixture database really holds the three legacy shapes and the #171 tables', () => {
  withFixture((databasePath) => {
    const counts = snapshotCounts(databasePath)
    assert.equal(counts.users, 3)
    assert.equal(counts.resident_community_assignments, 3, '0 / 1 / 2 legacy relations')
    assert.equal(counts.resident_community_bindings, 0, 'nothing is auto-confirmed')
    assert.equal(counts.resident_community_binding_candidates, 0, 'no candidate is invented')
    assert.equal(counts.local_orders, 1)
    assert.equal(counts.ledger_entries, 1)

    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const buckets = db
        .prepare(
          `SELECT n AS relations, COUNT(*) AS accounts FROM (
             SELECT u.id, COUNT(a.community_id) AS n
             FROM users u LEFT JOIN resident_community_assignments a ON a.user_id = u.id
             GROUP BY u.id
           ) GROUP BY n ORDER BY n`,
        )
        .all()
      assert.deepEqual(
        buckets.map((row) => [row.relations, row.accounts]),
        [[0, 1], [1, 1], [2, 1]],
      )
    } finally {
      db.close()
    }
  })
})

test('a direct INSERT that bypasses the API cannot create a second confirmed binding', () => {
  withFixture((databasePath) => {
    // Writable handle on purpose: this is the "malicious DBA / buggy script" case,
    // not the preflight case. The invariants must hold without the service.
    const db = new DatabaseSync(databasePath)
    try {
      const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id
      const [communityA, communityB] = db
        .prepare('SELECT id FROM communities ORDER BY name')
        .all()
        .map((row) => row.id)
      const insert = db.prepare(
        `INSERT INTO resident_community_bindings
           (id, user_id, community_id, status, confirmed_at, source, evidence_ref, created_at)
         VALUES (?, ?, ?, 'confirmed', ?, 'resident_h5_confirmed', ?, ?)`,
      )
      insert.run('binding-1', userId, communityA, Date.now(), 'audit-1', Date.now())

      // Second confirmed binding for the same resident — same community or not —
      // must be refused by SQLite.
      for (const communityId of [communityA, communityB]) {
        assert.throws(
          () => insert.run(`binding-${communityId}`, userId, communityId, Date.now(), 'a', Date.now()),
          /UNIQUE constraint failed: resident_community_bindings\.user_id/u,
        )
      }
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM resident_community_bindings').get().n,
        1,
        'exactly one confirmed binding survives',
      )

      // The status CHECK is the second layer: a non-confirmed row cannot be used to
      // smuggle a second permanent community past the partial index.
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO resident_community_bindings
                 (id, user_id, community_id, status, confirmed_at, source, evidence_ref, created_at)
               VALUES ('binding-x', ?, ?, 'superseded', ?, 'admin_compliance_correction', 'a', ?)`,
            )
            .run(userId, communityB, Date.now(), Date.now()),
        /CHECK constraint failed: resident_community_bindings_status_check/u,
      )
    } finally {
      db.close()
    }

    // The migration file itself must carry both layers, because they are what make
    // the invariant physical rather than a convention.
    const migration = readFileSync(
      resolve(repoRoot, 'apps/api/db/migrations/0020_ll_identity_001_binding.sql'),
      'utf8',
    )
    assert.match(migration, /CREATE UNIQUE INDEX `resident_community_bindings_user_confirmed_uq`/u)
    assert.match(migration, /WHERE "resident_community_bindings"."status" = 'confirmed'/u)
    assert.match(
      migration,
      /CONSTRAINT "resident_community_bindings_status_check" CHECK\([^)]*`status` = 'confirmed'\)|CONSTRAINT "resident_community_bindings_status_check" CHECK\([^)]*"status" = 'confirmed'\)/u,
    )
    assert.doesNotMatch(migration, /ALTER TABLE `?resident_community_assignments/iu)
  })
})
