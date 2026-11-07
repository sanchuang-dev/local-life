import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  API_ERROR_CODES,
  type LedgerFactKind,
  type LedgerSourceSystem,
} from '@sanchuang-dev/local-life-contracts'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import {
  auditLogs,
  communities,
  ledgerAnomalies,
  ledgerEntries,
  reconciliationBatches,
  staffAccounts,
  staffCommunityAssignments,
  users,
} from '../src/db/schema.js'
import { LocalError } from '../src/ledger/shared.js'
import {
  RECONCILIATION_CSV_COLUMN_COUNT,
  RECONCILIATION_CSV_HEADERS,
  buildReconciliationCsv,
  createBatch,
  getBatch,
  getBatchEntries,
  getReconciliationDiff,
  listBatches,
  lockBatch,
  maskPhoneNumbers,
  type ReconciliationEntryView,
} from '../src/ledger/reconciliation-service.js'

/**
 * Unit tests of the reconciliation service (LL-MVP-008, Issue #64).
 *
 * These are *real* tests: a real SQLite file, the real migration 0010 triggers
 * and the real Drizzle queries. Nothing is stubbed, because the guarantees that
 * matter here (one open batch per period, one-way lock, append-only facts,
 * frozen statement) live in the database, not in the service.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

const DAY_START = new Date('2026-11-01T00:00:00.000+08:00')
const IN_PERIOD = new Date('2026-11-03T10:30:00.000+08:00')
/** Later than every lock instant used below: a fact recorded *after* the statement. */
const AFTER_LOCK = new Date('2026-11-09T10:00:00.000+08:00')

interface World {
  dir: string
  db: AppDatabase
  sqlite: SqliteConnection
  communityId: string
  otherCommunityId: string
  adminUserId: string
  adminStaffId: string
  operatorUserId: string
  operatorStaffId: string
  gridUserId: string
  gridStaffId: string
  cleanup: () => void
}

function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'll-ledger-recon-'))
  const databasePath = join(dir, 'recon.sqlite')
  const { db, sqlite } = createDatabase(databasePath, migrationsFolder)

  const communityId = randomUUID()
  const otherCommunityId = randomUUID()
  db.insert(communities)
    .values([
      { id: communityId, name: '幸福社区', createdAt: DAY_START },
      { id: otherCommunityId, name: '和平社区', createdAt: DAY_START },
    ])
    .run()

  const addUser = (displayName: string): string => {
    const id = randomUUID()
    db.insert(users).values({ id, displayName, createdAt: DAY_START, updatedAt: DAY_START }).run()
    return id
  }
  const addStaff = (
    displayName: string,
    username: string,
    role: 'admin' | 'operator' | 'grid_worker',
    scopedCommunityIds: string[],
  ): { userId: string; staffId: string } => {
    const userId = addUser(displayName)
    const staffId = randomUUID()
    db.insert(staffAccounts)
      .values({
        id: staffId,
        userId,
        username,
        passwordHash: 'not-a-real-hash',
        role,
        status: 'active',
        createdAt: DAY_START,
        updatedAt: DAY_START,
      })
      .run()
    for (const scoped of scopedCommunityIds) {
      db.insert(staffCommunityAssignments)
        .values({ staffAccountId: staffId, communityId: scoped, createdAt: DAY_START })
        .run()
    }
    return { userId, staffId }
  }

  const admin = addStaff('系统管理员', 'admin', 'admin', [])
  const operator = addStaff('运营小王', 'operator', 'operator', [communityId])
  const grid = addStaff('网格员小李', 'grid', 'grid_worker', [communityId])

  return {
    dir,
    db,
    sqlite,
    communityId,
    otherCommunityId,
    adminUserId: admin.userId,
    adminStaffId: admin.staffId,
    operatorUserId: operator.userId,
    operatorStaffId: operator.staffId,
    gridUserId: grid.userId,
    gridStaffId: grid.staffId,
    cleanup: () => {
      sqlite.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

interface EntryInput {
  factKind: LedgerFactKind
  sourceSystem: LedgerSourceSystem
  sourceId?: string
  sourceDisplayNo?: string
  communityId: string
  amountCents: number
  occurredAt?: Date
  createdAt?: Date
  verifiedAt?: Date | null
  /** Explicit attribution; omit for a `pending` (待归属) fact. */
  attributedStaffId?: string | null
  evidenceRef?: string | null
  evidenceKind?: 'manual_receipt' | 'bank_transfer' | 'crm_confirmation' | 'order_verification' | 'reward_grant' | 'none'
  recordedByStaffId?: string | null
  counterEntryId?: string | null
}

/**
 * Inserts one fact exactly the way the (future) ingestion path must: all
 * cross-column invariants of migration 0010 are satisfied, so a rejection here
 * is a real contract violation, not a fixture bug.
 */
function insertEntry(world: World, input: EntryInput): string {
  const id = randomUUID()
  const attributedStaffId = input.attributedStaffId ?? null
  const isPayment =
    input.factKind === 'payment_received' || input.factKind === 'payment_reversed'
  world.db
    .insert(ledgerEntries)
    .values({
      id,
      factKind: input.factKind,
      sourceSystem: input.sourceSystem,
      sourceId: input.sourceId ?? randomUUID(),
      sourceDisplayNo: input.sourceDisplayNo ?? `SRC-${id.slice(0, 8)}`,
      communityId: input.communityId,
      productId: null,
      attributedStaffId,
      attributionState: attributedStaffId === null ? 'pending' : 'attributed',
      attributionBasis:
        attributedStaffId === null ? 'no_explicit_attribution' : 'explicit_attribution',
      amountCents: input.amountCents,
      settlementAmountStatus: 'pending_rule',
      occurredAt: input.occurredAt ?? IN_PERIOD,
      verifiedAt: input.verifiedAt ?? null,
      recordedByUserId: isPayment ? world.operatorUserId : null,
      recordedByStaffId: input.recordedByStaffId ?? (isPayment ? world.operatorStaffId : null),
      counterEntryId: input.counterEntryId ?? null,
      evidenceRef: input.evidenceRef ?? null,
      evidenceKind:
        input.evidenceKind ?? (isPayment ? 'manual_receipt' : input.factKind === 'order_verified' ? 'order_verification' : 'none'),
      batchId: null,
      createdAt: input.createdAt ?? input.occurredAt ?? IN_PERIOD,
    })
    .run()
  return id
}

function adminActor(world: World) {
  return { userId: world.adminUserId, staffId: world.adminStaffId, role: 'admin' as const }
}

function operatorActor(world: World) {
  return {
    userId: world.operatorUserId,
    staffId: world.operatorStaffId,
    role: 'operator' as const,
  }
}

function gridActor(world: World) {
  return { userId: world.gridUserId, staffId: world.gridStaffId, role: 'grid_worker' as const }
}

function expectLocalError(fn: () => unknown, status: number, code: string): LocalError {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof LocalError, `expected LocalError, got ${String(error)}`)
    assert.equal(error.status, status)
    assert.equal(error.code, code)
    return error
  }
  throw new Error(`expected a LocalError ${status}/${code}`)
}

/* -------------------------------------------------------------------------- */
/* A tiny RFC 4180 reader, so the CSV is verified as data, not as a string     */
/* -------------------------------------------------------------------------- */

function parseCsv(text: string): string[][] {
  assert.ok(text.startsWith('\uFEFF'), 'the CSV must start with a UTF-8 BOM')
  const body = text.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let index = 0
  while (index < body.length) {
    const char = body[index] as string
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          cell += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      cell += char
      index += 1
      continue
    }
    if (char === '"') {
      quoted = true
      index += 1
      continue
    }
    if (char === ',') {
      row.push(cell)
      cell = ''
      index += 1
      continue
    }
    if (char === '\r' && body[index + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      index += 2
      continue
    }
    cell += char
    index += 1
  }
  assert.equal(quoted, false, 'the CSV must not end inside a quoted field')
  assert.equal(row.length, 0, 'the file must end with a complete CRLF-terminated row')
  assert.equal(cell, '')
  return rows
}

/* -------------------------------------------------------------------------- */
/* Export surface                                                             */
/* -------------------------------------------------------------------------- */

test('the service is Hono-free and exposes the seven reconciliation functions', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/ledger/reconciliation-service.ts', import.meta.url)),
    'utf8',
  )
  assert.ok(
    !/from ['"]hono['"]/u.test(source),
    'reconciliation-service.ts must not import Hono: HTTP wiring belongs to the routes card',
  )
  for (const [name, value] of Object.entries({
    createBatch,
    lockBatch,
    listBatches,
    getBatch,
    getBatchEntries,
    getReconciliationDiff,
    buildReconciliationCsv,
  })) {
    assert.equal(typeof value, 'function', `${name} must be a plain service function`)
  }
})

/* -------------------------------------------------------------------------- */
/* Batch lifecycle                                                            */
/* -------------------------------------------------------------------------- */

test('createBatch derives the totals from the immutable facts and refuses a second open batch', () => {
  const world = makeWorld()
  try {
    const grid = gridActor(world)
    expectLocalError(
      () => createBatch(world.db, grid, { periodFrom: '2026-11-01', periodTo: '2026-11-07' }),
      403,
      API_ERROR_CODES.forbidden,
    )

    insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 12_345,
      occurredAt: new Date('2026-11-02T09:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })
    insertEntry(world, {
      factKind: 'reward_cost',
      sourceSystem: 'activity_reward_grant',
      communityId: world.communityId,
      amountCents: 5_000,
      occurredAt: new Date('2026-11-04T18:00:00.000+08:00'),
    })
    // Outside the period: must never be counted.
    insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 999_900,
      occurredAt: new Date('2026-11-09T09:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })

    const created = createBatch(
      world.db,
      adminActor(world),
      { periodFrom: '2026-11-01', periodTo: '2026-11-07', note: '十一月第一周' },
      { now: new Date('2026-11-08T09:00:00.000Z') },
    )
    assert.equal(created.status, 'open')
    assert.equal(created.periodFrom, '2026-11-01')
    assert.equal(created.periodTo, '2026-11-07')
    assert.equal(created.entryCount, 2)
    assert.equal(created.totalCents, 17_345)
    assert.equal(created.lockedAt, null)
    assert.equal(created.note, '十一月第一周')
    assert.match(created.batchNo, /^RB-\d{8}-\d{8}$/u)

    // A second open batch for the same period: 409 and no second row.
    expectLocalError(
      () =>
        createBatch(world.db, adminActor(world), {
          periodFrom: '2026-11-01',
          periodTo: '2026-11-07',
        }),
      409,
      API_ERROR_CODES.conflict,
    )
    const rows = world.db.select().from(reconciliationBatches).all()
    assert.equal(rows.length, 1, 'a period may only ever have one open batch')
    const raw = world.sqlite
      .prepare('SELECT count(*) AS c FROM reconciliation_batches')
      .get() as { c: number }
    assert.equal(raw.c, 1)

    // The partial unique index — not the service — is the real backstop: even a
    // hand-written INSERT cannot create a second open batch for the period.
    assert.throws(
      () =>
        world.sqlite
          .prepare(
            `INSERT INTO reconciliation_batches
               (id, batch_no, period_from, period_to, status, entry_count, total_cents, created_at, updated_at)
             VALUES (?, ?, '2026-11-01', '2026-11-07', 'open', 0, 0, ?, ?)`,
          )
          .run(randomUUID(), 'RB-CONFLICT', DAY_START.getTime(), DAY_START.getTime()),
      /UNIQUE constraint failed: reconciliation_batches.period_from, reconciliation_batches.period_to/iu,
    )

    // An invalid period is a 400, not a silently clamped statement.
    expectLocalError(
      () =>
        createBatch(world.db, adminActor(world), {
          periodFrom: '2026-11-07',
          periodTo: '2026-11-01',
        }),
      400,
      API_ERROR_CODES.invalidRequest,
    )

    const listed = listBatches(world.db, { now: new Date('2026-11-08T09:00:00.000Z') })
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0]?.batchId, created.batchId)
  } finally {
    world.cleanup()
  }
})

test('lockBatch freezes entry_count/total_cents/locked_at and a second lock is 409', () => {
  const world = makeWorld()
  try {
    insertEntry(world, {
      factKind: 'order_verified',
      sourceSystem: 'crm_service_order',
      communityId: world.communityId,
      amountCents: 20_000,
      occurredAt: new Date('2026-11-02T10:00:00.000+08:00'),
      verifiedAt: new Date('2026-11-02T11:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })
    const created = createBatch(world.db, adminActor(world), {
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })

    // A stale optimistic token is a conflict, not a silent lock.
    expectLocalError(
      () =>
        lockBatch(world.db, adminActor(world), created.batchId, {
          expectedUpdatedAt: new Date(0).toISOString(),
        }),
      409,
      API_ERROR_CODES.conflict,
    )

    const lockedAt = new Date('2026-11-08T01:00:00.000Z')
    const locked = lockBatch(
      world.db,
      operatorActor(world),
      created.batchId,
      { expectedUpdatedAt: created.updatedAt, note: '已核对' },
      { now: lockedAt },
    )
    assert.equal(locked.status, 'locked')
    assert.equal(locked.lockedAt, lockedAt.toISOString())
    assert.equal(locked.lockedByUserId, world.operatorUserId)
    assert.equal(locked.lockedByStaffId, world.operatorStaffId)
    assert.equal(locked.entryCount, 1)
    assert.equal(locked.totalCents, 20_000)
    assert.equal(locked.note, '已核对')

    // Locking twice never produces a second success.
    expectLocalError(
      () =>
        lockBatch(world.db, adminActor(world), created.batchId, {
          expectedUpdatedAt: locked.updatedAt,
        }),
      409,
      API_ERROR_CODES.ledgerBatchLocked,
    )

    // Facts that land after the lock stay out of the frozen statement ...
    const late = insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 7_700,
      occurredAt: new Date('2026-11-05T12:00:00.000+08:00'),
      createdAt: AFTER_LOCK,
      attributedStaffId: world.gridStaffId,
    })
    const after = getBatchEntries(world.db, created.batchId)
    assert.equal(after.entries.length, 1, 'a locked statement must not absorb late facts')
    assert.equal(after.stored.entryCount, 1)
    assert.equal(after.stored.totalCents, 20_000)
    assert.deepEqual(after.computed, after.stored)

    // ... but L2 must not be silent: the late fact is surfaced, with its amount,
    // and itemised in the diff as `late_recorded_after_lock`.
    assert.equal(after.lateRecorded.length, 1)
    assert.equal(after.lateRecorded[0]?.entryId, late)
    assert.equal(after.lateRecorded[0]?.reconciliationState, 'unreconciled')

    const lateDiff = getReconciliationDiff(world.db, { batchId: created.batchId })
    assert.equal(lateDiff.lateRecordedCount, 1)
    assert.equal(lateDiff.lateRecordedTotalCents, 7_700)
    const lateItem = lateDiff.items.find((item) => item.reason === 'late_recorded_after_lock')
    assert.ok(lateItem, 'a fact recorded after the lock must appear in the diff')
    assert.equal(lateItem.entryId, late)
    assert.equal(lateItem.severity, 'medium')
    assert.equal(lateDiff.stored?.totalCents, 20_000, 'the statement itself does not move')
    assert.equal(lateDiff.computed.totalCents, 20_000)

    // The row itself is frozen: the totals still read the locked values.
    const reread = getBatch(world.db, created.batchId)
    assert.equal(reread.updatedAt, locked.updatedAt)
    assert.equal(reread.entryCount, 1)
    assert.equal(reread.totalCents, 20_000)
  } finally {
    world.cleanup()
  }
})

test('a fact recorded before the lock but inside the period joins the statement (no false late record)', () => {
  const world = makeWorld()
  try {
    const early = insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 2_200,
      occurredAt: new Date('2026-11-06T09:00:00.000+08:00'),
      createdAt: new Date('2026-11-06T09:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })
    const created = createBatch(world.db, adminActor(world), {
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })
    const locked = lockBatch(world.db, adminActor(world), created.batchId, {
      expectedUpdatedAt: created.updatedAt,
    })
    assert.equal(locked.entryCount, 1)
    const entries = getBatchEntries(world.db, created.batchId)
    assert.deepEqual(
      entries.entries.map((entry) => entry.entryId),
      [early],
    )
    assert.equal(entries.lateRecorded.length, 0, 'nothing was recorded after the lock')

    const diff = getReconciliationDiff(world.db, { batchId: created.batchId })
    assert.equal(diff.lateRecordedCount, 0)
    assert.equal(diff.lateRecordedTotalCents, 0)
    assert.ok(!diff.items.some((item) => item.reason === 'late_recorded_after_lock'))
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Database-level guarantees                                                  */
/* -------------------------------------------------------------------------- */

test('direct SQL cannot rewrite a fact row nor a locked batch', () => {
  const world = makeWorld()
  try {
    const entryId = insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 3_300,
      occurredAt: new Date('2026-11-02T09:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })
    const created = createBatch(world.db, adminActor(world), {
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })
    const locked = lockBatch(world.db, adminActor(world), created.batchId, {
      expectedUpdatedAt: created.updatedAt,
    })

    // Append-only facts: even a hand-written UPDATE is rejected by migration 0010.
    assert.throws(
      () =>
        world.sqlite
          .prepare('UPDATE ledger_entries SET amount_cents = 1 WHERE id = ?')
          .run(entryId),
      /immutable/iu,
    )
    assert.throws(
      () => world.sqlite.prepare('UPDATE ledger_entries SET batch_id = ?').run(created.batchId),
      /immutable/iu,
    )
    assert.throws(
      () => world.sqlite.prepare('DELETE FROM ledger_entries WHERE id = ?').run(entryId),
      /immutable/iu,
    )

    // A locked statement may not be re-priced or re-opened.
    assert.throws(
      () =>
        world.sqlite
          .prepare('UPDATE reconciliation_batches SET total_cents = 1 WHERE id = ?')
          .run(created.batchId),
      /immutable/iu,
    )
    assert.throws(
      () =>
        world.sqlite
          .prepare("UPDATE reconciliation_batches SET status = 'open' WHERE id = ?")
          .run(created.batchId),
      /immutable|open to locked/iu,
    )
    assert.throws(
      () =>
        world.sqlite
          .prepare('DELETE FROM reconciliation_batches WHERE id = ?')
          .run(created.batchId),
      /append-only/iu,
    )

    const fresh = getBatch(world.db, created.batchId)
    assert.equal(fresh.status, 'locked')
    assert.equal(fresh.entryCount, locked.entryCount)
    assert.equal(fresh.totalCents, 3_300)

    // Nothing ever stamped `ledger_entries.batch_id`: membership is derived.
    const stamped = world.sqlite
      .prepare('SELECT count(*) AS c FROM ledger_entries WHERE batch_id IS NOT NULL')
      .get() as { c: number }
    assert.equal(stamped.c, 0)
  } finally {
    world.cleanup()
  }
})

test('a re-curated period cannot be re-created after it was locked', () => {
  const world = makeWorld()
  try {
    const created = createBatch(world.db, adminActor(world), {
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })
    const locked = lockBatch(world.db, adminActor(world), created.batchId, {
      expectedUpdatedAt: created.updatedAt,
    })
    expectLocalError(
      () =>
        createBatch(world.db, adminActor(world), {
          periodFrom: '2026-11-01',
          periodTo: '2026-11-07',
        }),
      409,
      API_ERROR_CODES.ledgerBatchLocked,
    )
    const rows = world.db.select().from(reconciliationBatches).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.status, locked.status)
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

test('getReconciliationDiff reports pending attribution, anomalies and cross-period reversals', () => {
  const world = makeWorld()
  try {
    // A pending (待归属) fact: real money, no owner.
    const pendingEntry = insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 1_500,
      occurredAt: new Date('2026-11-02T09:00:00.000+08:00'),
    })
    // A fact with an open anomaly.
    const anomalousEntry = insertEntry(world, {
      factKind: 'payment_received',
      sourceSystem: 'manual',
      communityId: world.communityId,
      amountCents: 8_800,
      occurredAt: new Date('2026-11-03T09:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
      evidenceRef: '收据号 R-001，经办人手机 13800138000',
    })
    world.db
      .insert(ledgerAnomalies)
      .values({
        id: randomUUID(),
        entryId: anomalousEntry,
        kind: 'source_missing_evidence',
        severity: 'high',
        note: '收据照片缺失',
        flaggedByUserId: world.adminUserId,
        resolvedAt: null,
        createdAt: DAY_START,
      })
      .run()
    // A reversal in this period whose original is outside it.
    const originalOut = insertEntry(world, {
      factKind: 'payment_received',
      sourceSystem: 'manual',
      communityId: world.communityId,
      amountCents: 6_600,
      occurredAt: new Date('2026-10-20T09:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
      evidenceRef: '收据号 R-000',
    })
    const reversal = insertEntry(world, {
      factKind: 'payment_reversed',
      sourceSystem: 'manual',
      communityId: world.communityId,
      amountCents: 6_600,
      occurredAt: new Date('2026-11-04T09:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
      evidenceRef: '冲正单 R-002',
      counterEntryId: originalOut,
    })

    const diff = getReconciliationDiff(world.db, {
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })
    const reasons = diff.items.map((item) => item.reason)
    assert.ok(reasons.includes('pending_attribution'))
    assert.ok(reasons.includes('open_anomaly'))
    assert.ok(reasons.includes('reversal_original_outside_period'))
    assert.ok(
      diff.items.some(
        (item) => item.reason === 'pending_attribution' && item.entryId === pendingEntry,
      ),
    )
    assert.ok(
      diff.items.some((item) => item.reason === 'open_anomaly' && item.entryId === anomalousEntry),
    )
    assert.ok(
      diff.items.some(
        (item) => item.reason === 'reversal_original_outside_period' && item.entryId === reversal,
      ),
    )
    assert.equal(diff.batchId, null)
    assert.equal(diff.status, null)
    // The 10-20 original is outside the period, so only three facts are in it.
    assert.equal(diff.computed.entryCount, 3)
    assert.equal(diff.computed.totalCents, 1_500 + 8_800 + 6_600)
    assert.equal(diff.summary.total, diff.items.length)

    // Resolving the anomaly removes it from the diff; nothing else changes.
    world.sqlite
      .prepare('UPDATE ledger_anomalies SET resolved_at = ? WHERE entry_id = ?')
      .run(DAY_START.getTime(), anomalousEntry)
    const afterResolve = getReconciliationDiff(world.db, {
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })
    assert.ok(!afterResolve.items.some((item) => item.reason === 'open_anomaly'))

    // An empty period is called out before someone locks it.
    const empty = getReconciliationDiff(world.db, {
      periodFrom: '2026-12-01',
      periodTo: '2026-12-02',
    })
    assert.deepEqual(
      empty.items.map((item) => item.reason),
      ['empty_period'],
    )
    assert.equal(empty.computed.totalCents, 0)
  } finally {
    world.cleanup()
  }
})

test('a locked batch with identical stored and derived totals is not reported as drift', () => {
  const world = makeWorld()
  try {
    insertEntry(world, {
      factKind: 'reward_cost',
      sourceSystem: 'activity_reward_grant',
      communityId: world.communityId,
      amountCents: 4_200,
      occurredAt: new Date('2026-11-02T09:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })
    const created = createBatch(world.db, adminActor(world), {
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })
    const locked = lockBatch(world.db, adminActor(world), created.batchId, {
      expectedUpdatedAt: created.updatedAt,
    })
    const diff = getReconciliationDiff(world.db, { batchId: locked.batchId })
    assert.equal(diff.status, 'locked')
    assert.equal(diff.batchNo, locked.batchNo)
    assert.deepEqual(diff.stored, diff.computed)
    assert.ok(!diff.items.some((item) => item.reason === 'batch_totals_drift'))
    assert.ok(!diff.items.some((item) => item.reason === 'empty_period'))
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

test('buildReconciliationCsv emits BOM, CRLF, RFC4180 escaping, Chinese headers, masked phones', () => {
  const world = makeWorld()
  try {
    const attributed = insertEntry(world, {
      factKind: 'payment_received',
      sourceSystem: 'manual',
      communityId: world.communityId,
      amountCents: 123_456,
      occurredAt: new Date('2026-11-02T01:30:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
      // Comma + quote + newline: the three characters that force quoting.
      sourceDisplayNo: 'R-100, "记号"\n第二行',
      evidenceRef: '经办人 13800138000',
    })
    insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 999,
      occurredAt: new Date('2026-11-03T09:00:00.000+08:00'),
    })
    const created = createBatch(world.db, adminActor(world), {
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })
    const locked = lockBatch(world.db, adminActor(world), created.batchId, {
      expectedUpdatedAt: created.updatedAt,
    })

    const generatedAt = new Date('2026-11-08T02:03:04.000Z')
    const csv = buildReconciliationCsv(world.db, {
      actor: adminActor(world),
      batchId: locked.batchId,
      now: generatedAt,
    })

    // Header bytes: BOM first, then the fixed Chinese header row, CRLF ended.
    assert.equal(csv.body.charCodeAt(0), 0xfeff)
    assert.ok(csv.body.startsWith(`\uFEFF${RECONCILIATION_CSV_HEADERS.join(',')}\r\n`))
    assert.ok(csv.body.endsWith('\r\n'))
    assert.equal(csv.rowCount, 2)

    const rows = parseCsv(csv.body)
    assert.equal(rows.length, 3, 'header + two facts')
    for (const row of rows) {
      assert.equal(row.length, RECONCILIATION_CSV_COLUMN_COUNT)
    }
    assert.equal(rows[0]?.[9], '金额(元)')
    assert.equal(rows[0]?.[12], '对账批次')

    // Row order is by occurredAt: the payment (11-02 01:30) comes first.
    const payment = rows[1] as string[]
    const unbatched = rows[2] as string[]
    assert.equal(payment[0], attributed)
    assert.equal(payment[1], '人工收款')
    // RFC 4180: the embedded comma/quote/newline round-trip exactly ...
    assert.equal(payment[2], 'R-100, "记号"\n第二行')
    assert.equal(payment[3], '实收')
    // ... and it is physically quoted, with the inner quotes doubled.
    assert.ok(csv.body.includes('"R-100, ""记号""\n第二行"'))
    // Asia/Shanghai rendering, never UTC.
    assert.equal(payment[4], '2026-11-02 01:30:00')
    assert.equal(payment[5], '', 'a payment has no verification instant')
    assert.equal(payment[6], '幸福社区')
    assert.equal(payment[7], '网格员小李')
    assert.equal(payment[8], '已归属')
    // Money is always cents/100 with two decimals.
    assert.equal(payment[9], '1234.56')
    assert.equal(payment[10], '待结算规则')
    // The phone inside a free-text cell is masked in the middle four digits.
    assert.equal(payment[11], '经办人 138****8000')
    assert.ok(!csv.body.includes('13800138000'), 'no full phone number may leave the office')
    assert.equal(payment[12], locked.batchNo)
    assert.equal(payment[13], '')

    assert.equal(unbatched[8], '待归属')
    assert.equal(unbatched[9], '9.99')
    assert.equal(unbatched[7], '', '待归属 must not name an owner')
    assert.equal(unbatched[12], locked.batchNo, 'a locked statement stamps its batch number')

    // The filename carries the batch number and a Shanghai timestamp.
    assert.ok(csv.filename.startsWith(`ledger-reconciliation-${locked.batchNo}-`))
    assert.match(csv.filename, /-\d{14}\.csv$/u)
    assert.equal(csv.filename, `ledger-reconciliation-${locked.batchNo}-20261108100304.csv`)

    // The export is audited with its row count and filters.
    const audits = world.db.select().from(auditLogs).all()
    const exportAudit = audits.find((row) => row.event === 'ledger.export.csv')
    assert.ok(exportAudit, 'an export without an audit row is not acceptable')
    assert.equal(exportAudit.targetId, locked.batchId)
    assert.equal(exportAudit.actorUserId, world.adminUserId)
    const metadata = JSON.parse(exportAudit.metadata ?? '{}') as Record<string, string>
    assert.equal(metadata.rows, '2')
    assert.equal(metadata.filters, JSON.stringify({ batchId: locked.batchId }))

    // A grid worker may not export at all.
    expectLocalError(
      () =>
        buildReconciliationCsv(world.db, {
          actor: gridActor(world),
          batchId: locked.batchId,
        }),
      403,
      API_ERROR_CODES.forbidden,
    )
  } finally {
    world.cleanup()
  }
})

test('buildReconciliationCsv refuses an out-of-scope community instead of exporting an empty file', () => {
  const world = makeWorld()
  try {
    insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.otherCommunityId,
      amountCents: 100,
      occurredAt: new Date('2026-11-02T09:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })
    expectLocalError(
      () =>
        buildReconciliationCsv(world.db, {
          actor: operatorActor(world),
          periodFrom: '2026-11-01',
          periodTo: '2026-11-07',
          communityId: world.otherCommunityId,
        }),
      403,
      API_ERROR_CODES.forbidden,
    )

    // The operator's own scope still yields a valid, narrower file.
    const csv = buildReconciliationCsv(world.db, {
      actor: operatorActor(world),
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
      now: new Date('2026-11-08T02:03:04.000Z'),
    })
    assert.equal(csv.rowCount, 0)
    assert.equal(csv.batchId, null)
    assert.equal(csv.filename, 'ledger-reconciliation-unbatched-20261108100304.csv')
    const rows = parseCsv(csv.body)
    assert.equal(rows.length, 1, 'an empty period still exports the header row')
  } finally {
    world.cleanup()
  }
})

test('maskPhoneNumbers only masks plausible mainland mobiles', () => {
  assert.equal(maskPhoneNumbers('13800138000'), '138****8000')
  assert.equal(maskPhoneNumbers('电话13800138000请回拨'), '电话138****8000请回拨')
  assert.equal(maskPhoneNumbers('编号 2026110813800'), '编号 2026110813800')
  assert.equal(maskPhoneNumbers('138001380001'), '138001380001')
})

test('CSV rows, batch page entries and entry_count/total_cents tell one story (文档 §10)', () => {
  const world = makeWorld()
  try {
    insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 1_234,
      occurredAt: new Date('2026-11-02T09:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })
    insertEntry(world, {
      factKind: 'order_verified',
      sourceSystem: 'crm_service_order',
      communityId: world.otherCommunityId,
      amountCents: 10_000,
      occurredAt: new Date('2026-11-03T09:00:00.000+08:00'),
      verifiedAt: new Date('2026-11-03T10:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })
    insertEntry(world, {
      factKind: 'reward_cost',
      sourceSystem: 'activity_reward_grant',
      communityId: world.communityId,
      amountCents: 2_000,
      occurredAt: new Date('2026-11-04T09:00:00.000+08:00'),
    })
    const created = createBatch(world.db, adminActor(world), {
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })
    const locked = lockBatch(world.db, adminActor(world), created.batchId, {
      expectedUpdatedAt: created.updatedAt,
    })
    // A fact recorded after the lock: outside all three surfaces, but counted.
    insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 9_999,
      occurredAt: new Date('2026-11-05T09:00:00.000+08:00'),
      createdAt: AFTER_LOCK,
      attributedStaffId: world.gridStaffId,
    })

    const entries = getBatchEntries(world.db, locked.batchId)
    const diff = getReconciliationDiff(world.db, { batchId: locked.batchId })
    const csv = buildReconciliationCsv(world.db, {
      actor: adminActor(world),
      batchId: locked.batchId,
      now: new Date('2026-11-09T02:00:00.000Z'),
    })
    const csvRows = parseCsv(csv.body).slice(1)

    const sum = entries.entries.reduce((total, entry) => total + entry.amountCents, 0)
    assert.equal(entries.entries.length, 3)
    assert.equal(sum, 13_234)
    assert.equal(entries.computed.totalCents, sum)
    assert.equal(entries.stored.totalCents, sum)
    assert.equal(locked.totalCents, sum)
    assert.equal(locked.entryCount, 3)

    // CSV: same rows, same order, same money.
    assert.equal(csv.rowCount, entries.entries.length)
    assert.deepEqual(
      csvRows.map((row) => row[0]),
      entries.entries.map((entry) => entry.entryId),
    )
    assert.deepEqual(
      csvRows.map((row) => row[9]),
      entries.entries.map((entry) => (entry.amountCents / 100).toFixed(2)),
    )
    assert.equal(
      csvRows.reduce((total, row) => total + Math.round(Number(row[9]) * 100), 0),
      sum,
      'the CSV must add up to the same total as the batch',
    )

    // Diff: same computed population, plus the explicitly-counted late fact.
    assert.deepEqual(diff.computed, entries.computed)
    assert.equal(diff.lateRecordedCount, 1)
    assert.equal(diff.lateRecordedTotalCents, 9_999)
    assert.equal(csv.lateRecordedCount, 1)
    assert.equal(csv.lateRecordedTotalCents, 9_999)
    const exportAudit = world.db
      .select()
      .from(auditLogs)
      .all()
      .find((row) => row.event === 'ledger.export.csv')
    assert.ok(exportAudit)
    const metadata = JSON.parse(exportAudit.metadata ?? '{}') as Record<string, string>
    assert.equal(metadata.lateRecordedCount, '1')
    assert.equal(metadata.lateRecordedTotalCents, '9999')
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Durability                                                                 */
/* -------------------------------------------------------------------------- */

test('after sqlite.close() the batch is still locked and recomputes identically', () => {
  const world = makeWorld()
  const databasePath = join(world.dir, 'recon.sqlite')
  let batchId = ''
  let batchNo = ''
  try {
    insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 4_500,
      occurredAt: new Date('2026-11-02T09:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })
    insertEntry(world, {
      factKind: 'reward_cost',
      sourceSystem: 'activity_reward_grant',
      communityId: world.communityId,
      amountCents: 2_500,
      occurredAt: new Date('2026-11-05T09:00:00.000+08:00'),
    })
    const created = createBatch(world.db, adminActor(world), {
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })
    const locked = lockBatch(world.db, adminActor(world), created.batchId, {
      expectedUpdatedAt: created.updatedAt,
    })
    batchId = locked.batchId
    batchNo = locked.batchNo
    world.sqlite.close()

    const reopened = createDatabase(databasePath, migrationsFolder)
    try {
      const batch = getBatch(reopened.db, batchId)
      assert.equal(batch.status, 'locked')
      assert.equal(batch.batchNo, batchNo)
      assert.equal(batch.entryCount, 2)
      assert.equal(batch.totalCents, 7_000)
      assert.equal(batch.lockedAt, locked.lockedAt)

      const entries = getBatchEntries(reopened.db, batchId)
      assert.equal(entries.entries.length, 2)
      assert.deepEqual(entries.computed, entries.stored)
      assert.equal(entries.computed.totalCents, 7_000)

      // The freeze survives a restart: a late fact still stays out.
      insertEntry(
        { ...world, db: reopened.db },
        {
          factKind: 'order_registered',
          sourceSystem: 'local_order',
          communityId: world.communityId,
          amountCents: 55_500,
          occurredAt: new Date('2026-11-06T09:00:00.000+08:00'),
          createdAt: new Date(),
          attributedStaffId: world.gridStaffId,
        },
      )
      const stillFrozen = getBatchEntries(reopened.db, batchId)
      assert.equal(stillFrozen.stored.entryCount, 2)
      assert.equal(stillFrozen.computed.entryCount, 2)
      const diff = getReconciliationDiff(reopened.db, { batchId })
      assert.ok(!diff.items.some((item) => item.reason === 'batch_totals_drift'))
      // The freeze survives a restart *and* the late fact is still reported.
      assert.equal(stillFrozen.lateRecorded.length, 1)
      assert.equal(diff.lateRecordedCount, 1)
      assert.equal(diff.lateRecordedTotalCents, 55_500)
    } finally {
      reopened.sqlite.close()
    }
  } finally {
    rmSync(world.dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------- */
/* Derived membership sanity                                                  */
/* -------------------------------------------------------------------------- */

test('getBatchEntries derives membership from the period and never writes ledger_entries.batch_id', () => {
  const world = makeWorld()
  try {
    const inPeriod = insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 1_000,
      occurredAt: new Date('2026-11-01T00:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })
    // 2026-11-07 23:59 +08:00 is still the last inclusive business second ...
    const lastSecond = insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.otherCommunityId,
      amountCents: 2_000,
      occurredAt: new Date('2026-11-07T23:59:59.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })
    // ... but 2026-11-08 00:00 +08:00 is the next day (and 11-07 16:00Z is not).
    const nextDay = insertEntry(world, {
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      communityId: world.communityId,
      amountCents: 4_000,
      occurredAt: new Date('2026-11-08T00:00:00.000+08:00'),
      attributedStaffId: world.gridStaffId,
    })

    const created = createBatch(world.db, adminActor(world), {
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })
    const entries = getBatchEntries(world.db, created.batchId)
    assert.deepEqual(
      entries.entries.map((entry: ReconciliationEntryView) => entry.entryId).sort(),
      [inPeriod, lastSecond].sort(),
    )
    assert.ok(!entries.entries.some((entry) => entry.entryId === nextDay))
    assert.equal(entries.batch.periodFrom, '2026-11-01')
    assert.equal(entries.batch.periodTo, '2026-11-07')

    // Cross-community facts are part of a global statement.
    assert.ok(entries.entries.some((entry) => entry.communityId === world.otherCommunityId))

    const stamped = world.sqlite
      .prepare('SELECT count(*) AS c FROM ledger_entries WHERE batch_id IS NOT NULL')
      .get() as { c: number }
    assert.equal(stamped.c, 0)

    // An unknown batch id is a 404, never an empty statement.
    expectLocalError(() => getBatch(world.db, randomUUID()), 404, API_ERROR_CODES.notFound)
    expectLocalError(
      () => getBatchEntries(world.db, randomUUID()),
      404,
      API_ERROR_CODES.notFound,
    )
  } finally {
    world.cleanup()
  }
})
