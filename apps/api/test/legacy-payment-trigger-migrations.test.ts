import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'
import { createDatabase } from '../src/db/client.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
type Entry = { idx: number; tag: string; when: number; version: string; breakpoints: boolean }
const journal = JSON.parse(
  readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
) as { version: string; dialect: string; entries: Entry[] }

function partialFolder(t: TestContext, maxIndex: number): string {
  const path = mkdtempSync(join(tmpdir(), 'local-life-payment-migration-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  mkdirSync(join(path, 'meta'))
  const entries = journal.entries.filter((e) => e.idx <= maxIndex)
  writeFileSync(join(path, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  for (const entry of entries) {
    copyFileSync(join(migrationsFolder, entry.tag + '.sql'), join(path, entry.tag + '.sql'))
  }
  return path
}

function assertProtected(sqlite: ReturnType<typeof createDatabase>['sqlite']): void {
  for (const name of [
    'payment_outbox_immutable_identity',
    'payment_review_exceptions_immutable_evidence',
  ]) {
    assert.ok(
      sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name),
      name + ' must exist after migration',
    )
  }

  // Inserts below isolate the trigger assertions from the foreign-key
  // evidence topology; no user data or production DB is touched.
  sqlite.pragma('foreign_keys = OFF')
  sqlite.prepare(`INSERT INTO payment_outbox
    (id,payment_intent_id,payment_event_id,topic,dedupe_key,payload_json,
     status,attempts,available_at,last_error,created_at,updated_at,delivered_at)
    VALUES ('probe-outbox','probe-intent','probe-event','payment.paid.v1',
      'probe-key','{}','pending',0,1,NULL,1,1,NULL)`).run()
  assert.throws(
    () => sqlite.prepare("UPDATE payment_outbox SET payload_json='tampered' WHERE id='probe-outbox'").run(),
    /immutable/u,
  )
  sqlite.prepare("UPDATE payment_outbox SET attempts=1 WHERE id='probe-outbox'").run()

  sqlite.prepare(`INSERT INTO payment_review_exceptions
    (id,merchant_order_no,channel,observed_at,source,dedupe_key,
     evidence_fingerprint,kind,detail,status,created_at)
    VALUES ('probe-exception','PAY-TEST-LEGACY','mock',1,'query',
      'probe-exception-key',?,'unknown_evidence','test case','open',1)`)
    .run('a'.repeat(64))
  assert.throws(
    () => sqlite.prepare(
      "UPDATE payment_review_exceptions SET detail='tampered' WHERE id='probe-exception'",
    ).run(),
    /immutable/u,
  )
  sqlite.prepare("UPDATE payment_review_exceptions SET status='reviewed' WHERE id='probe-exception'").run()
}

test('legacy PAY-03 database without its historical update triggers upgrades safely', (t) => {
  const path = mkdtempSync(join(tmpdir(), 'local-life-payment-legacy-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  const dbPath = join(path, 'local-life.sqlite')
  const initial = createDatabase(dbPath, partialFolder(t, 32))
  initial.sqlite.exec(`
    DROP TRIGGER payment_outbox_immutable_identity;
    DROP TRIGGER payment_review_exceptions_immutable_evidence;
  `)
  initial.sqlite.close()

  const upgraded = createDatabase(dbPath, migrationsFolder)
  try {
    const check = upgraded.sqlite.pragma('integrity_check', { simple: true })
    assert.equal(check, 'ok')
    assert.deepEqual(upgraded.sqlite.pragma('foreign_key_check'), [])
    const row = upgraded.sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations')
      .get() as { count: number }
    assert.equal(row.count, journal.entries.length)
    assertProtected(upgraded.sqlite)
  } finally {
    upgraded.sqlite.close()
  }
})

test('forward repair also handles databases already through 0039 with absent triggers', (t) => {
  const path = mkdtempSync(join(tmpdir(), 'local-life-payment-legacy-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  const dbPath = join(path, 'local-life.sqlite')
  const initial = createDatabase(dbPath, partialFolder(t, 39))
  initial.sqlite.exec(`
    DROP TRIGGER payment_outbox_immutable_identity;
    DROP TRIGGER payment_review_exceptions_immutable_evidence;
  `)
  initial.sqlite.close()
  const upgraded = createDatabase(dbPath, migrationsFolder)
  try {
    assertProtected(upgraded.sqlite)
  } finally {
    upgraded.sqlite.close()
  }
})

test('fresh database still migrates with both payment evidence protections', (t) => {
  const path = mkdtempSync(join(tmpdir(), 'local-life-payment-fresh-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  const created = createDatabase(join(path, 'local-life.sqlite'), migrationsFolder)
  try {
    assertProtected(created.sqlite)
  } finally {
    created.sqlite.close()
  }
})
