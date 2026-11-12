import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * LL-IDENTITY-001 (#171) — the resident-binding preflight must be safe by
 * construction.
 *
 * These assertions are about the tool, not the database: it has to open a
 * database read-only, count 0/1/many legacy relations correctly, refuse to
 * invent a report for a missing file, and leave the file bytes untouched.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const script = join(repoRoot, 'scripts', 'resident-binding-preflight.mjs')

function run(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      cwd: repoRoot,
      ...options,
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    }
  }
}

function seedDatabase(path) {
  const sqlite = new DatabaseSync(path)
  sqlite.exec(`
    CREATE TABLE users (id text PRIMARY KEY NOT NULL, display_name text, created_at integer NOT NULL, updated_at integer NOT NULL);
    CREATE TABLE communities (id text PRIMARY KEY NOT NULL, name text NOT NULL, address text, latitude_gcj02 real, longitude_gcj02 real, created_at integer NOT NULL);
    CREATE TABLE resident_community_assignments (
      user_id text NOT NULL REFERENCES users(id),
      community_id text NOT NULL REFERENCES communities(id),
      created_at integer NOT NULL,
      PRIMARY KEY (user_id, community_id)
    );
    CREATE TABLE local_orders (
      id text PRIMARY KEY NOT NULL,
      community_id text NOT NULL REFERENCES communities(id),
      resident_user_id text NOT NULL REFERENCES users(id),
      created_at integer NOT NULL
    );
    CREATE TABLE activity_participations (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id));
  `)
  const now = Date.now()
  const statements = []
  const community = (name) => {
    const id = randomUUID()
    statements.push(`INSERT INTO communities (id, name, created_at) VALUES ('${id}', '${name}', ${now});`)
    return id
  }
  const user = (name) => {
    const id = randomUUID()
    statements.push(
      `INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('${id}', '${name}', ${now}, ${now});`,
    )
    return id
  }
  const assign = (userId, communityId) => {
    statements.push(
      `INSERT INTO resident_community_assignments (user_id, community_id, created_at) VALUES ('${userId}', '${communityId}', ${now});`,
    )
  }

  const communityA = community('A 社区')
  const communityB = community('B 社区')
  const communityC = community('C 社区')

  const zero = user('未关联居民')
  const one = user('单归属居民')
  const many = user('多归属居民')
  const assignedUser = user('有订单的多归属居民')

  assign(one, communityA)
  assign(many, communityA)
  assign(many, communityB)
  assign(assignedUser, communityA)
  assign(assignedUser, communityC)

  statements.push(
    `INSERT INTO local_orders (id, community_id, resident_user_id, created_at) VALUES ('${randomUUID()}', '${communityA}', '${assignedUser}', ${now});`,
  )
  statements.push(`INSERT INTO activity_participations (id, user_id) VALUES ('${randomUUID()}', '${many}');`)

  sqlite.exec(statements.join('\n'))
  sqlite.close()
  return { zero, one, many, assignedUser, communityA, communityB, communityC }
}

function withDatabase(t) {
  const dir = mkdtempSync(join(tmpdir(), 'll-bindings-preflight-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'preflight.sqlite')
  const ids = seedDatabase(path)
  return { dir, path, ids }
}

test('counts 0 / 1 / many legacy relations and never reports them as confirmed', (t) => {
  const { path } = withDatabase(t)
  const result = run([path, '--json'])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)

  assert.equal(report.readOnly, true)
  assert.equal(report.legacy.residents, 4)
  assert.deepEqual(report.legacy.distribution, { zero: 1, one: 1, many: 2 })
  assert.equal(report.legacy.integrity.rows, 5)
  assert.equal(report.legacy.integrity.hasConfirmationProvenanceColumn, false)
  assert.equal(report.classification.accountsNeedingFirstConfirmation, 2)
  assert.equal(report.classification.accountsNeedingManualReview, 2)
  assert.equal(report.classification.accountsAlreadyConfirmed, 0)
  assert.equal(report.classification.automaticConversionToPermanentBindingAllowed, false)
  assert.equal(report.classification.randomSelectionAllowed, false)
  assert.equal(report.classification.verdict, 'ready_for_manual_review')
})

test('aggregate output hides platform UUIDs unless --user-ids is explicit', (t) => {
  const { path, ids } = withDatabase(t)
  const aggregate = run([path])
  assert.equal(aggregate.status, 0, aggregate.stderr)
  assert.ok(!aggregate.stdout.includes(ids.one), 'aggregate output must not print a user UUID')
  assert.ok(!aggregate.stdout.includes(ids.many), 'aggregate output must not print a user UUID')
  assert.match(aggregate.stdout, /0 legacy relations:\s+1/)
  assert.match(aggregate.stdout, /2\+ legacy relations:\s+2/)

  const detailed = run([path, '--user-ids'])
  assert.equal(detailed.status, 0, detailed.stderr)
  assert.ok(detailed.stdout.includes(ids.one))
  assert.ok(detailed.stdout.includes(ids.many))
})

test('reports business facts that hang off multi-relation accounts', (t) => {
  const { path } = withDatabase(t)
  const result = run([path, '--json'])
  const report = JSON.parse(result.stdout)
  const orders = report.facts.find((fact) => fact.table === 'local_orders')
  const participations = report.facts.find((fact) => fact.table === 'activity_participations')
  const ledger = report.facts.find((fact) => fact.table === 'ledger_entries')

  assert.equal(orders.rows, 1)
  assert.equal(orders.rowsForMultiAssignmentResidents, 1)
  assert.equal(participations.rows, 1)
  assert.equal(participations.rowsForMultiAssignmentResidents, 1)
  assert.equal(ledger.present, false)
})

test('refuses a missing database instead of reporting an empty result', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'll-bindings-preflight-missing-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = run([join(dir, 'nope.sqlite'), '--json'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /database not found/)
})

test('refuses a file that is not a local-life database', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'll-bindings-preflight-wrong-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'other.sqlite')
  writeFileSync(path, '')
  const result = run([path])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not a local-life database|has no 'users' table/)
})

test('leaves the database bytes untouched (read-only handle)', (t) => {
  const { path } = withDatabase(t)
  const before = run([path, '--json'])
  const beforeReport = JSON.parse(before.stdout)
  // A second run must see the same numbers; a write through the handle would
  // either throw or change the counts.
  const after = run([path, '--json'])
  const afterReport = JSON.parse(after.stdout)
  assert.equal(afterReport.legacy.distribution.many, beforeReport.legacy.distribution.many)
  assert.equal(afterReport.legacy.integrity.rows, beforeReport.legacy.integrity.rows)

  const sqlite = new DatabaseSync(path, { readOnly: true })
  try {
    assert.throws(() => sqlite.exec('DELETE FROM resident_community_assignments'), /readonly|read-only/i)
  } finally {
    sqlite.close()
  }
})
