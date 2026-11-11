import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  RESIDENT_COMMUNITY_BINDING_SOURCES,
  RESIDENT_COMMUNITY_ROUTES,
  residentCommunityStatusResponseSchema,
} from '@sanchuang-dev/local-life-contracts'
import {
  assertResidentOfConfirmedCommunity,
  clearBindingCandidate,
  confirmResidentCommunity,
  getResidentCommunityStatus,
  readConfirmedBinding,
  recordBindingCandidate,
  ResidentCommunityError,
} from '../src/resident-community/service.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  communities,
  residentCommunityAssignments,
  residentCommunityBindingCandidates,
  residentCommunityBindings,
  users,
} from '../src/db/schema.js'

/**
 * Database-level proof for #171 LL-IDENTITY-001.
 *
 * The point of this file is that the uniqueness of "one permanent community per
 * resident" is a property of the SQLite schema, not of the TypeScript service. So
 * the central test bypasses the service completely and `INSERT`s a second
 * confirmed binding with raw SQL: SQLite must refuse it. Everything else here
 * checks the migration is additive (no historical row lost, no legacy constraint
 * added) and that the service derives the four documented states correctly.
 */

const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url))
const NOW = new Date('2026-11-11T04:00:00.000Z')
const LATER = new Date(NOW.getTime() + 60 * 60 * 1000)

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const communityA = uuid(9001)
const communityB = uuid(9002)
const communityC = uuid(9003)

function migrate(): { db: AppDatabase; sqlite: ReturnType<typeof createDatabase>['sqlite'] } {
  return createDatabase(':memory:', migrations)
}

function seedCommunities(db: AppDatabase): void {
  db.insert(communities)
    .values([
      { id: communityA, name: '阳光社区', address: '阳光路 1 号', createdAt: NOW },
      { id: communityB, name: '和平社区', address: null, createdAt: NOW },
      { id: communityC, name: '新风社区', address: '新风街 9 号', createdAt: NOW },
    ])
    .run()
}

function seedResident(db: AppDatabase, displayName = '测试居民'): string {
  const id = randomUUID()
  db.insert(users).values({ id, displayName, createdAt: NOW, updatedAt: NOW }).run()
  return id
}

function countRows(sqlite: ReturnType<typeof createDatabase>['sqlite'], table: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }
  return row.value
}

function rejectsWith(fn: () => unknown, code: string): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof ResidentCommunityError, `expected ResidentCommunityError, got ${String(thrown)}`)
  assert.equal(thrown.code, code)
}

/* -------------------------------------------------------------------------- */
/* Schema invariant                                                           */
/* -------------------------------------------------------------------------- */

test('the migration file itself carries the partial unique index and the status check', () => {
  const sql = readFileSync(join(migrations, '0020_ll_identity_001_binding.sql'), 'utf8')
  // The invariant must be visible in the deployed SQL, not only in the ORM.
  assert.match(
    sql,
    /CREATE UNIQUE INDEX `resident_community_bindings_user_confirmed_uq` .*WHERE .*status.* = 'confirmed'/,
  )
  assert.match(sql, /CHECK\("resident_community_bindings"\."status" = 'confirmed'\)/)
  // Additive only: the legacy table is never altered or constrained.
  assert.equal(sql.includes('ALTER TABLE `resident_community_assignments`'), false)
  assert.equal(/resident_community_assignments/.test(sql.replace(/--[^\n]*/g, '')), false)
})

test('bypassing the service, a second confirmed binding is rejected by SQLite', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    db.insert(residentCommunityBindings)
      .values({
        id: randomUUID(),
        userId,
        communityId: communityA,
        status: 'confirmed',
        confirmedAt: NOW,
        source: 'resident_h5_confirmed',
        confirmedByUserId: userId,
        evidenceRef: 'audit-1',
        createdAt: NOW,
      })
      .run()

    // Same community: still a second "confirmed" row for one resident.
    assert.throws(
      () =>
        db
          .insert(residentCommunityBindings)
          .values({
            id: randomUUID(),
            userId,
            communityId: communityA,
            status: 'confirmed',
            confirmedAt: LATER,
            source: 'resident_h5_confirmed',
            confirmedByUserId: userId,
            evidenceRef: 'audit-2',
            createdAt: LATER,
          })
          .run(),
      /UNIQUE constraint failed: resident_community_bindings\.user_id/,
    )
    // Different community: same refusal, the resident cannot hold two.
    assert.throws(
      () =>
        db
          .insert(residentCommunityBindings)
          .values({
            id: randomUUID(),
            userId,
            communityId: communityB,
            status: 'confirmed',
            confirmedAt: LATER,
            source: 'resident_h5_confirmed',
            confirmedByUserId: userId,
            evidenceRef: 'audit-3',
            createdAt: LATER,
          })
          .run(),
      /UNIQUE constraint failed: resident_community_bindings\.user_id/,
    )
    assert.equal(countRows(sqlite, 'resident_community_bindings'), 1)

    // A different resident is unaffected.
    const other = seedResident(db, '另一位居民')
    db.insert(residentCommunityBindings)
      .values({
        id: randomUUID(),
        userId: other,
        communityId: communityB,
        status: 'confirmed',
        confirmedAt: NOW,
        source: 'resident_h5_confirmed',
        confirmedByUserId: other,
        evidenceRef: 'audit-4',
        createdAt: NOW,
      })
      .run()
    assert.equal(countRows(sqlite, 'resident_community_bindings'), 2)
  } finally {
    sqlite.close()
  }
})

test('the status column only admits confirmed (no silent widening of the invariant)', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    // Raw SQL on purpose: the CHECK must hold for statements the ORM would never
    // type-check, including a future migration that forgets to widen it.
    assert.throws(
      () =>
        sqlite
          .prepare(
            `INSERT INTO resident_community_bindings
               (id, user_id, community_id, status, confirmed_at, source, confirmed_by_user_id, evidence_ref, created_at)
             VALUES (?, ?, ?, 'superseded', ?, 'resident_h5_confirmed', ?, 'audit', ?)`,
          )
          .run(randomUUID(), userId, communityA, NOW.getTime(), userId, NOW.getTime()),
      /CHECK constraint failed: resident_community_bindings_status_check/,
    )
  } finally {
    sqlite.close()
  }
})

test('a binding needs a real community, a legal source and a non-empty evidence ref', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    const insert = sqlite.prepare(
      `INSERT INTO resident_community_bindings
         (id, user_id, community_id, status, confirmed_at, source, confirmed_by_user_id, evidence_ref, created_at)
       VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)`,
    )
    const values = (overrides: {
      communityId?: string
      source?: string
      evidenceRef?: string
    }): unknown[] => [
      randomUUID(),
      userId,
      overrides.communityId ?? communityA,
      NOW.getTime(),
      overrides.source ?? 'resident_h5_confirmed',
      userId,
      overrides.evidenceRef ?? 'audit',
      NOW.getTime(),
    ]
    assert.throws(
      () => insert.run(...values({ communityId: uuid(7777) })),
      /FOREIGN KEY constraint failed/,
    )
    assert.throws(
      () => insert.run(...values({ source: 'client_said_so' })),
      /CHECK constraint failed: resident_community_bindings_source_check/,
    )
    assert.throws(
      () => insert.run(...values({ evidenceRef: '' })),
      /CHECK constraint failed: resident_community_bindings_evidence_check/,
    )
    assert.equal(countRows(sqlite, 'resident_community_bindings'), 0)
  } finally {
    sqlite.close()
  }
})

test('candidates: one row per resident, expiry after suggestion, stored source only', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    // The service upserts, so a second suggestion replaces the first.
    assert.equal(
      recordBindingCandidate(db, {
        userId,
        communityId: communityA,
        source: 'activity_oauth_candidate',
        now: NOW,
      }),
      true,
    )
    assert.equal(
      recordBindingCandidate(db, {
        userId,
        communityId: communityB,
        source: 'activity_oauth_candidate',
        now: LATER,
      }),
      true,
    )
    const rows = db.select().from(residentCommunityBindingCandidates).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.communityId, communityB)
    assert.deepEqual(rows[0]!.suggestedAt, LATER)

    // Raw SQL again: the CHECKs must hold even for values the ORM type system
    // would reject, because a future writer may not go through the service.
    const insertCandidate = sqlite.prepare(
      `INSERT INTO resident_community_binding_candidates
         (user_id, community_id, source, suggested_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    assert.throws(
      () =>
        insertCandidate.run(
          uuid(4003),
          communityC,
          'legacy_single_assignment_candidate',
          NOW.getTime(),
          LATER.getTime(),
          NOW.getTime(),
        ),
      /CHECK constraint failed: resident_community_candidates_source_check/,
    )
    assert.throws(
      () =>
        insertCandidate.run(
          uuid(4003),
          communityC,
          'activity_oauth_candidate',
          // A candidate that expires before it was suggested is nonsense.
          NOW.getTime(),
          NOW.getTime(),
          NOW.getTime(),
        ),
      /CHECK constraint failed: resident_community_candidates_expiry_check/,
    )
    assert.equal(countRows(sqlite, 'resident_community_binding_candidates'), 1)
  } finally {
    sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Additive migration / historical preservation                                */
/* -------------------------------------------------------------------------- */

test('historical assignments survive untouched and are never promoted to a binding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'll-identity-'))
  const databasePath = join(directory, 'legacy.sqlite')
  try {
    // Seed the "pre-#171 world" with raw SQL only, so this test never depends on
    // the ORM details it is supposed to be independent of.
    const legacy = createDatabase(databasePath, migrations)
    const now = NOW.getTime()
    const insertCommunity = legacy.sqlite.prepare(
      'INSERT INTO communities (id, name, address, created_at) VALUES (?, ?, NULL, ?)',
    )
    insertCommunity.run(communityA, '阳光社区', now)
    insertCommunity.run(communityB, '和平社区', now)
    const single = uuid(4001)
    const multi = uuid(4002)
    for (const id of [single, multi]) {
      legacy.sqlite
        .prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(id, '历史居民', now, now)
    }
    const assign = legacy.sqlite.prepare(
      'INSERT INTO resident_community_assignments (user_id, community_id, created_at) VALUES (?, ?, ?)',
    )
    assign.run(single, communityA, now)
    assign.run(multi, communityA, now)
    assign.run(multi, communityB, now + 1000)
    legacy.sqlite.close()

    // Re-open: migrations run again and must be no-ops for the legacy table.
    const upgraded = createDatabase(databasePath, migrations)
    try {
      const rows = upgraded.sqlite
        .prepare('SELECT user_id, community_id FROM resident_community_assignments ORDER BY user_id, community_id')
        .all() as Array<{ user_id: string; community_id: string }>
      assert.equal(rows.length, 3)
      assert.deepEqual(
        rows.map((row) => `${row.user_id}:${row.community_id}`),
        [`${multi}:${communityA}`, `${multi}:${communityB}`, `${single}:${communityA}`].sort(),
      )
      // Nothing was copied into the binding table by the migration.
      assert.equal(countRows(upgraded.sqlite, 'resident_community_bindings'), 0)
      assert.equal(countRows(upgraded.sqlite, 'resident_community_binding_candidates'), 0)

      // The single historical relation becomes a *candidate*, the multi one review.
      assert.equal(
        getResidentCommunityStatus(upgraded.db, single, NOW).candidate?.source,
        'legacy_single_assignment_candidate',
      )
      assert.equal(getResidentCommunityStatus(upgraded.db, multi, NOW).status, 'pending_review')
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------- */
/* Service state machine                                                      */
/* -------------------------------------------------------------------------- */

test('unbound resident: no binding, can confirm, candidate lists the legacy relation only once confirmed', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    const status = getResidentCommunityStatus(db, userId, NOW)
    assert.equal(status.status, 'unbound')
    assert.equal(status.binding, null)
    assert.equal(status.candidate, null)
    assert.equal(status.canConfirm, true)
    assert.equal(status.confirmBlockedReason, null)
    assert.deepEqual(status.legacyHistory, { assignmentCount: 0, pendingReview: false, assignments: [] })
    // The read is a pure read: it writes nothing.
    assert.equal(countRows(sqlite, 'resident_community_bindings'), 0)
    assert.equal(countRows(sqlite, 'resident_community_binding_candidates'), 0)
  } finally {
    sqlite.close()
  }
})

test('a single historical relation is a candidate, never a binding', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    db.insert(residentCommunityAssignments)
      .values({ userId, communityId: communityB, createdAt: NOW })
      .run()

    const status = getResidentCommunityStatus(db, userId, NOW)
    assert.equal(status.status, 'unbound')
    assert.equal(status.binding, null)
    assert.equal(status.canConfirm, true)
    assert.equal(status.candidate?.community.id, communityB)
    assert.equal(status.candidate?.source, 'legacy_single_assignment_candidate')
    assert.equal(status.candidate?.expiresAt, null)
    assert.equal(status.legacyHistory.assignmentCount, 1)
    assert.equal(status.legacyHistory.pendingReview, false)
    assert.equal(countRows(sqlite, 'resident_community_bindings'), 0)
  } finally {
    sqlite.close()
  }
})

test('two or more historical relations are pending_review and cannot self-confirm', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    db.insert(residentCommunityAssignments)
      .values([
        { userId, communityId: communityC, createdAt: LATER },
        { userId, communityId: communityA, createdAt: NOW },
      ])
      .run()

    const status = getResidentCommunityStatus(db, userId, NOW)
    assert.equal(status.status, 'pending_review')
    assert.equal(status.canConfirm, false)
    assert.equal(status.confirmBlockedReason, 'pending_review')
    assert.equal(status.candidate, null, 'no earliest/latest row may be suggested')
    assert.equal(status.legacyHistory.assignmentCount, 2)
    assert.equal(status.legacyHistory.pendingReview, true)
    // Stable ordering by community id, independent of assignment time.
    assert.deepEqual(
      status.legacyHistory.assignments.map((row) => row.community.id),
      [communityA, communityC],
    )

    rejectsWith(
      () => confirmResidentCommunity(db, { userId, communityId: communityA, now: NOW }),
      API_ERROR_CODES.residentCommunityPendingReview,
    )
    assert.equal(countRows(sqlite, 'resident_community_bindings'), 0)
  } finally {
    sqlite.close()
  }
})

test('first confirmation is written once, with audit evidence, in one transaction', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    recordBindingCandidate(db, { userId, communityId: communityA, source: 'activity_oauth_candidate', now: NOW })

    const result = confirmResidentCommunity(db, { userId, communityId: communityB, now: LATER })
    assert.equal(result.idempotent, false)
    assert.equal(result.binding.community.id, communityB)
    assert.equal(result.binding.community.name, '和平社区')
    assert.equal(result.binding.community.serviceAddress, null)
    assert.equal(result.binding.source, 'resident_h5_confirmed')
    assert.equal(result.binding.confirmedAt, LATER.toISOString())

    const stored = readConfirmedBinding(db, userId)
    assert.ok(stored)
    assert.equal(stored.communityId, communityB)
    assert.equal(stored.source, 'resident_h5_confirmed')
    // The audit row and the binding reference each other.
    const audit = sqlite
      .prepare('SELECT id, actor_user_id, event, target_id, metadata FROM audit_logs WHERE id = ?')
      .get(stored.evidenceRef) as {
      id: string
      actor_user_id: string
      event: string
      target_id: string
      metadata: string
    }
    assert.equal(audit.actor_user_id, userId)
    assert.equal(audit.event, 'resident_community.bound')
    assert.equal(audit.target_id, stored.id)
    const metadata = JSON.parse(audit.metadata) as Record<string, string>
    assert.deepEqual(metadata, { source: 'resident_h5_confirmed', communityId: communityB })
    // No credential leaks into the audit row.
    for (const forbidden of ['openid', 'open_id', 'unionid', 'union_id', 'token', 'cookie', 'session', 'secret']) {
      assert.equal(audit.metadata.toLowerCase().includes(forbidden), false, forbidden)
    }
    // Confirming consumed the pending suggestion.
    assert.equal(countRows(sqlite, 'resident_community_binding_candidates'), 0)
    assert.equal(countRows(sqlite, 'resident_community_bindings'), 1)

    const status = getResidentCommunityStatus(db, userId, LATER)
    assert.equal(status.status, 'confirmed')
    assert.equal(status.binding?.community.id, communityB)
    assert.equal(status.candidate, null)
    assert.equal(status.canConfirm, false)
    assert.equal(status.confirmBlockedReason, 'already_confirmed')
    // Historical assignment rows are untouched by a confirmation.
    assert.equal(countRows(sqlite, 'resident_community_assignments'), 0)
  } finally {
    sqlite.close()
  }
})

test('confirming the same community again is idempotent and writes nothing', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    const first = confirmResidentCommunity(db, { userId, communityId: communityA, now: NOW })
    assert.equal(first.idempotent, false)
    const auditCount = countRows(sqlite, 'audit_logs')

    const again = confirmResidentCommunity(db, {
      userId,
      communityId: communityA,
      now: new Date(NOW.getTime() + 86_400_000),
    })
    assert.equal(again.idempotent, true)
    // The original confirmation time is preserved: a replay never re-dates it.
    assert.equal(again.binding.confirmedAt, NOW.toISOString())
    assert.equal(countRows(sqlite, 'resident_community_bindings'), 1)
    assert.equal(countRows(sqlite, 'audit_logs'), auditCount)
  } finally {
    sqlite.close()
  }
})

test('confirming a different community is an explicit conflict and changes nothing', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    confirmResidentCommunity(db, { userId, communityId: communityA, now: NOW })

    let conflict: unknown
    try {
      confirmResidentCommunity(db, { userId, communityId: communityB, now: LATER })
    } catch (error) {
      conflict = error
    }
    assert.ok(conflict instanceof ResidentCommunityError)
    assert.equal(conflict.status, 409)
    assert.equal(conflict.code, API_ERROR_CODES.residentCommunityConflict)
    // The message names the already-confirmed community, so callers need no extra read.
    assert.match(conflict.message, /阳光社区/)

    const stored = readConfirmedBinding(db, userId)
    assert.equal(stored?.communityId, communityA)
    assert.equal(countRows(sqlite, 'resident_community_bindings'), 1)

    // And even a simultaneous direct insert cannot slip a second row in.
    assert.throws(
      () =>
        sqlite
          .prepare(
            `INSERT INTO resident_community_bindings
               (id, user_id, community_id, status, confirmed_at, source, confirmed_by_user_id, evidence_ref, created_at)
             VALUES (?, ?, ?, 'confirmed', ?, 'resident_h5_confirmed', ?, 'race', ?)`,
          )
          .run(randomUUID(), userId, communityB, LATER.getTime(), userId, LATER.getTime()),
      /UNIQUE constraint failed/,
    )
  } finally {
    sqlite.close()
  }
})

test('an unknown community is refused with 404 and creates nothing', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    rejectsWith(
      () => confirmResidentCommunity(db, { userId, communityId: uuid(7777), now: NOW }),
      API_ERROR_CODES.residentCommunityNotFound,
    )
    assert.equal(countRows(sqlite, 'resident_community_bindings'), 0)
    assert.equal(countRows(sqlite, 'audit_logs'), 0)
  } finally {
    sqlite.close()
  }
})

test('a confirmed resident never gets a new candidate written', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    confirmResidentCommunity(db, { userId, communityId: communityA, now: NOW })

    assert.equal(
      recordBindingCandidate(db, {
        userId,
        communityId: communityB,
        source: 'activity_oauth_candidate',
        now: LATER,
      }),
      false,
    )
    assert.equal(countRows(sqlite, 'resident_community_binding_candidates'), 0)

    // Legacy history that disagrees with the binding is still surfaced read-only:
    // the row is a *fact* the operator must reconcile, never a rebind offer.
    db.insert(residentCommunityAssignments)
      .values({ userId, communityId: communityC, createdAt: NOW })
      .run()
    const status = getResidentCommunityStatus(db, userId, LATER)
    assert.equal(status.status, 'conflict')
    assert.equal(status.binding?.community.id, communityA)
    assert.equal(status.candidate?.community.id, communityC)
    assert.equal(status.canConfirm, false)
    assert.equal(status.confirmBlockedReason, 'candidate_conflict')
    assert.equal(status.legacyHistory.assignmentCount, 1)
    assert.equal(countRows(sqlite, 'resident_community_bindings'), 1)
  } finally {
    sqlite.close()
  }
})

test('legacy history matching the confirmed community stays a plain confirmed state', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    db.insert(residentCommunityAssignments)
      .values({ userId, communityId: communityA, createdAt: NOW })
      .run()
    confirmResidentCommunity(db, { userId, communityId: communityA, now: LATER })

    const status = getResidentCommunityStatus(db, userId, LATER)
    assert.equal(status.status, 'confirmed')
    assert.equal(status.binding?.community.id, communityA)
    assert.equal(status.candidate, null)
    assert.equal(status.canConfirm, false)
    assert.equal(status.confirmBlockedReason, 'already_confirmed')
    assert.equal(status.legacyHistory.assignmentCount, 1)
  } finally {
    sqlite.close()
  }
})

test('an expired candidate is ignored by the status read but not deleted', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    recordBindingCandidate(db, {
      userId,
      communityId: communityA,
      source: 'activity_oauth_candidate',
      now: NOW,
      ttlMs: 1000,
    })
    assert.equal(getResidentCommunityStatus(db, userId, NOW).candidate?.community.id, communityA)
    const expired = getResidentCommunityStatus(db, userId, new Date(NOW.getTime() + 1001))
    assert.equal(expired.status, 'unbound')
    assert.equal(expired.candidate, null)
    assert.equal(expired.canConfirm, true)
    assert.equal(countRows(sqlite, 'resident_community_binding_candidates'), 1)

    // An explicitly cleared candidate is gone.
    clearBindingCandidate(db, userId)
    assert.equal(countRows(sqlite, 'resident_community_binding_candidates'), 0)
  } finally {
    sqlite.close()
  }
})

test('recordBindingCandidate ignores a community that does not exist', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    assert.equal(
      recordBindingCandidate(db, {
        userId,
        communityId: uuid(7777),
        source: 'activity_oauth_candidate',
        now: NOW,
      }),
      false,
    )
    assert.equal(countRows(sqlite, 'resident_community_binding_candidates'), 0)
  } finally {
    sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Community-scoped write guard                                               */
/* -------------------------------------------------------------------------- */

test('the write guard requires a confirmed binding, not a legacy assignment', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    // A legacy relation is not enough.
    db.insert(residentCommunityAssignments)
      .values({ userId, communityId: communityA, createdAt: NOW })
      .run()
    rejectsWith(
      () => assertResidentOfConfirmedCommunity(db, userId, communityA),
      API_ERROR_CODES.residentCommunityNotBound,
    )

    confirmResidentCommunity(db, { userId, communityId: communityA, now: NOW })
    // Same community passes silently.
    assertResidentOfConfirmedCommunity(db, userId, communityA)

    // Another community is refused with an actionable message naming the binding.
    let wrong: unknown
    try {
      assertResidentOfConfirmedCommunity(db, userId, communityB)
    } catch (error) {
      wrong = error
    }
    assert.ok(wrong instanceof ResidentCommunityError)
    assert.equal(wrong.status, 403)
    assert.equal(wrong.code, API_ERROR_CODES.residentCommunityConflict)
    assert.match(wrong.message, /阳光社区/)

    // An unknown community is a 404, not a 403.
    rejectsWith(
      () => assertResidentOfConfirmedCommunity(db, userId, uuid(7777)),
      API_ERROR_CODES.residentCommunityNotFound,
    )
  } finally {
    sqlite.close()
  }
})

test('delete of a community referenced by a binding is restricted', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const userId = seedResident(db)
    confirmResidentCommunity(db, { userId, communityId: communityA, now: NOW })
    assert.throws(
      () => db.delete(communities).where(eq(communities.id, communityA)).run(),
      /FOREIGN KEY constraint failed/,
    )
  } finally {
    sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Contract parity                                                            */
/* -------------------------------------------------------------------------- */

test('every derived state parses against the shared contract', () => {
  const { db, sqlite } = migrate()
  try {
    seedCommunities(db)
    const states = [
      // unbound
      getResidentCommunityStatus(db, seedResident(db), NOW),
      // unbound + legacy candidate
      (() => {
        const id = seedResident(db)
        db.insert(residentCommunityAssignments).values({ userId: id, communityId: communityA, createdAt: NOW }).run()
        return getResidentCommunityStatus(db, id, NOW)
      })(),
      // pending_review
      (() => {
        const id = seedResident(db)
        db.insert(residentCommunityAssignments)
          .values([
            { userId: id, communityId: communityA, createdAt: NOW },
            { userId: id, communityId: communityB, createdAt: LATER },
          ])
          .run()
        return getResidentCommunityStatus(db, id, NOW)
      })(),
      // unbound + stored candidate
      (() => {
        const id = seedResident(db)
        recordBindingCandidate(db, { userId: id, communityId: communityC, source: 'activity_oauth_candidate', now: NOW })
        return getResidentCommunityStatus(db, id, NOW)
      })(),
      // confirmed
      (() => {
        const id = seedResident(db)
        confirmResidentCommunity(db, { userId: id, communityId: communityA, now: NOW })
        return getResidentCommunityStatus(db, id, NOW)
      })(),
    ]
    for (const state of states) {
      assert.equal(residentCommunityStatusResponseSchema.safeParse(state).success, true)
    }
    assert.deepEqual(
      states.map((state) => state.status),
      ['unbound', 'unbound', 'pending_review', 'unbound', 'confirmed'],
    )
    assert.equal(RESIDENT_COMMUNITY_ROUTES.status, '/resident-community/status')
    assert.deepEqual([...RESIDENT_COMMUNITY_BINDING_SOURCES], [
      'resident_h5_confirmed',
      'admin_compliance_correction',
    ])
  } finally {
    sqlite.close()
  }
})
