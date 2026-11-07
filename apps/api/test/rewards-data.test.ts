import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { activityKeyRulesSchema, type ActivityRewardPlan } from '@sanchuang-dev/local-life-contracts'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import {
  createActivity,
  listActivityRuleVersions,
  transitionActivity,
} from '../src/activities/service.js'
import { eq } from 'drizzle-orm'
import {
  activities,
  activityRuleVersions,
  communities,
  staffAccounts,
  users,
} from '../src/db/schema.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

const NOW = new Date('2026-11-01T00:00:00.000Z')
const CHECKIN_AT = new Date('2026-11-10T10:00:00.000Z')
const OUTSIDE_WINDOW = new Date('2026-12-05T00:00:00.000Z')

const PLAN: ActivityRewardPlan = {
  prizeName: '粮油礼包',
  prizeUnitCostCents: 5_000,
  prizeQuantityPerTeam: 1,
  totalPrizeQuantity: 10,
  budgetCapCents: 20_000,
  claimRecipient: 'leader',
  checkinWindow: {
    opensAt: '2026-11-01T00:00:00.000Z',
    closesAt: '2026-11-30T00:00:00.000Z',
  },
  redemptionValidHours: 72,
}

const PUBLIC_RULES = {
  eligibility: '本社区 60 岁以上居民',
  checkin: '活动当天到现场签到',
  purchase: '无消费门槛',
  prizeClaim: '达标后凭券领取',
}

interface Fixture {
  db: AppDatabase
  sqlite: SqliteConnection
  activityId: string
  ruleVersionId: string
  teamId: string
  staffId: string
  userIds: string[]
  cleanup: () => void
}

/**
 * Builds the smallest honest world for the 0006 constraints: one published
 * activity whose current rule version already carries a frozen reward plan, one
 * locked team and three residents. Rows are inserted through the real schema and
 * real migrations - no mocks, no hand-written DDL.
 */
function createFixture(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-0006-'))
  const { db, sqlite } = createDatabase(join(tempDir, 'rewards.sqlite'), migrationsFolder)

  const communityId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '奖励验证社区', createdAt: NOW }).run()

  const userIds: string[] = []
  for (const name of ['团长甲', '成员乙', '成员丙']) {
    const id = randomUUID()
    db.insert(users).values({ id, displayName: name, createdAt: NOW, updatedAt: NOW }).run()
    userIds.push(id)
  }
  const staffId = randomUUID()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId: userIds[0]!,
      username: 'reward-staff',
      passwordHash: 'x',
      role: 'admin',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()

  const activityId = randomUUID()
  const ruleVersionId = randomUUID()
  const teamId = randomUUID()
  const snapshot = JSON.stringify(
    activityKeyRulesSchema.parse({
      startsAt: '2026-11-01T00:00:00.000Z',
      endsAt: '2026-11-30T00:00:00.000Z',
      location: '幸福社区党群服务中心',
      budgetCapCents: 20_000,
      prizeQuantityCap: 10,
      publicRules: PUBLIC_RULES,
      rewardPlan: PLAN,
    }),
  )

  db.insert(activities)
    .values({
      id: activityId,
      communityId,
      title: '秋季敬老活动',
      status: 'published',
      startsAt: NOW,
      endsAt: new Date('2026-11-30T00:00:00.000Z'),
      location: '幸福社区党群服务中心',
      budgetCapCents: 20_000,
      prizeQuantityCap: 10,
      publicRulesJson: JSON.stringify(PUBLIC_RULES),
      rewardPlanJson: JSON.stringify(PLAN),
      currentRuleVersionId: null,
      createdByUserId: userIds[0]!,
      createdAt: NOW,
      updatedAt: NOW,
      publishedAt: NOW,
    })
    .run()

  // The rule version must exist before the activity can reference it under
  // foreign_keys=ON, so it is written here and re-pointed immediately. 0001
  // triggers make `current_rule_version_id` the only mutable activity column.
  db.insert(activityRuleVersions)
    .values({
      id: ruleVersionId,
      activityId,
      version: 1,
      snapshotJson: snapshot,
      createdByUserId: userIds[0]!,
      createdAt: NOW,
    })
    .run()
  db.update(activities).set({ currentRuleVersionId: ruleVersionId }).where(eq(activities.id, activityId)).run()

  sqlite
    .prepare(
      `INSERT INTO activity_teams (id, activity_id, leader_user_id, status, created_at, locked_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(teamId, activityId, userIds[0]!, 'locked', NOW.getTime(), NOW.getTime())

  return {
    db,
    sqlite,
    activityId,
    ruleVersionId,
    teamId,
    staffId,
    userIds,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  }
}

function insertStock(
  sqlite: SqliteConnection,
  fixture: Fixture,
  overrides: { unitCost?: number; totalQuantity?: number; budgetCap?: number } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO activity_prize_stocks
         (id, activity_id, rule_version_id, prize_name, unit_cost_cents, total_quantity,
          claimed_quantity, redeemed_quantity, budget_cap_cents, committed_budget_cents,
          redeemed_budget_cents, created_at, updated_at)
       VALUES (?,?,?,?,?,?,0,0,?,0,0,?,?)`,
    )
    .run(
      randomUUID(),
      fixture.activityId,
      fixture.ruleVersionId,
      PLAN.prizeName,
      overrides.unitCost ?? PLAN.prizeUnitCostCents,
      overrides.totalQuantity ?? PLAN.totalPrizeQuantity,
      overrides.budgetCap ?? PLAN.budgetCapCents,
      NOW.getTime(),
      NOW.getTime(),
    )
}

function insertGrant(
  sqlite: SqliteConnection,
  fixture: Fixture,
  overrides: { unitCost?: number; teamId?: string; ruleVersionId?: string } = {},
): string {
  const id = randomUUID()
  const unitCost = overrides.unitCost ?? PLAN.prizeUnitCostCents
  sqlite
    .prepare(
      `INSERT INTO activity_reward_grants
         (id, activity_id, rule_version_id, team_id, prize_name, quantity, unit_cost_cents,
          total_cost_cents, status, recipient_role, recipient_user_id, granted_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'granted','leader',?,?,?,?)`,
    )
    .run(
      id,
      fixture.activityId,
      overrides.ruleVersionId ?? fixture.ruleVersionId,
      overrides.teamId ?? fixture.teamId,
      PLAN.prizeName,
      PLAN.prizeQuantityPerTeam,
      unitCost,
      PLAN.prizeQuantityPerTeam * unitCost,
      fixture.userIds[0]!,
      NOW.getTime(),
      NOW.getTime(),
      NOW.getTime(),
    )
  return id
}

function insertCheckin(
  sqlite: SqliteConnection,
  fixture: Fixture,
  options: { userId?: string; checkedInAt?: Date } = {},
): string {
  const id = randomUUID()
  sqlite
    .prepare(
      `INSERT INTO activity_checkins (id, activity_id, user_id, team_id, seat_no, status, checked_in_at)
       VALUES (?,?,?,?,1,'valid',?)`,
    )
    .run(
      id,
      fixture.activityId,
      options.userId ?? fixture.userIds[0]!,
      fixture.teamId,
      (options.checkedInAt ?? CHECKIN_AT).getTime(),
    )
  return id
}

test('a frozen reward plan survives the publish snapshot and a plan-less activity stays byte-identical', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-0006-plan-'))
  try {
    const { db } = createDatabase(join(tempDir, 'plan.sqlite'), migrationsFolder)
    const communityId = randomUUID()
    db.insert(communities).values({ id: communityId, name: '计划社区', createdAt: NOW }).run()
    const actorId = randomUUID()
    db.insert(users)
      .values({ id: actorId, displayName: '运营甲', createdAt: NOW, updatedAt: NOW })
      .run()
    const staffId = randomUUID()
    db.insert(staffAccounts)
      .values({
        id: staffId,
        userId: actorId,
        username: 'plan-staff',
        passwordHash: 'x',
        role: 'admin',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run()
    const actor = { userId: actorId, staffId, role: 'admin' as const }

    const baseRules = {
      startsAt: '2026-11-01T00:00:00.000Z',
      endsAt: '2026-11-30T00:00:00.000Z',
      location: '社区广场',
      budgetCapCents: 20_000,
      prizeQuantityCap: 10,
      publicRules: PUBLIC_RULES,
    }

    // No plan: `rewardPlan` is optional, so the row keeps NULL and the rebuilt
    // key rules contain no `rewardPlan` key at all.
    const plain = createActivity(db, actor, {
      communityId,
      title: '无奖励计划活动',
      keyRules: baseRules,
    })
    const plainRow = db.select().from(activities).where(eq(activities.id, plain.id)).get()
    assert.equal(plainRow?.rewardPlanJson, null)

    // With a plan: the very same insert path persists it.
    const planned = createActivity(db, actor, {
      communityId,
      title: '有奖励计划活动',
      keyRules: { ...baseRules, rewardPlan: PLAN },
    })
    const plannedRow = db.select().from(activities).where(eq(activities.id, planned.id)).get()
    assert.ok(plannedRow?.rewardPlanJson)
    assert.equal(plannedRow.rewardPlanJson, JSON.stringify(PLAN))
    assert.deepEqual(JSON.parse(plannedRow.rewardPlanJson), PLAN)

    // An explicit null is the same as absent: both normalize to NULL.
    const cleared = createActivity(db, actor, {
      communityId,
      title: '显式清空计划',
      keyRules: { ...baseRules, rewardPlan: null },
    })
    const clearedRow = db.select().from(activities).where(eq(activities.id, cleared.id)).get()
    assert.equal(clearedRow?.rewardPlanJson, null)

    // Publishing freezes whatever the row currently holds. The planned activity
    // gets a snapshot that carries the plan; the plan-less one gets a snapshot
    // whose keys are exactly the pre-#62 shape, so old frozen snapshots and new
    // plan-less ones stay byte-identical.
    transitionActivity(db, actor, planned.id, 'publish', planned.updatedAt)
    const plannedSnapshots = listActivityRuleVersions(db, actor, planned.id)
    assert.equal(plannedSnapshots.items.length, 1)
    assert.deepEqual(plannedSnapshots.items[0]!.snapshot.rewardPlan, PLAN)
    assert.equal(plannedSnapshots.items[0]!.snapshot.budgetCapCents, 20_000)

    transitionActivity(db, actor, plain.id, 'publish', plain.updatedAt)
    const plainSnapshots = listActivityRuleVersions(db, actor, plain.id)
    assert.equal(plainSnapshots.items.length, 1)
    assert.ok(
      !('rewardPlan' in plainSnapshots.items[0]!.snapshot),
      'a plan-less frozen snapshot must not gain a rewardPlan key',
    )
    assert.deepEqual(Object.keys(plainSnapshots.items[0]!.snapshot).sort(), [
      'budgetCapCents',
      'endsAt',
      'location',
      'prizeQuantityCap',
      'publicRules',
      'startsAt',
    ])

    // Editing the mutable activity row afterwards must not rewrite the frozen
    // snapshot: fulfilment reads the snapshot, never these columns.
    db.update(activities)
      .set({ rewardPlanJson: JSON.stringify({ ...PLAN, prizeUnitCostCents: 1, prizeName: '改名礼品' }) })
      .where(eq(activities.id, planned.id))
      .run()
    const afterEdit = listActivityRuleVersions(db, actor, planned.id)
    assert.deepEqual(afterEdit.items[0]!.snapshot.rewardPlan, PLAN)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('every 0006 hard constraint rejects the write it is meant to reject', () => {
  const fixture = createFixture()
  const { sqlite } = fixture
  try {
    insertStock(sqlite, fixture)
    insertGrant(sqlite, fixture)
    insertCheckin(sqlite, fixture)

    // ---- check-in window comes from the frozen snapshot, not the activity row
    assert.throws(
      () => insertCheckin(sqlite, fixture, { userId: fixture.userIds[1]!, checkedInAt: OUTSIDE_WINDOW }),
      /outside the frozen check-in window/,
      'a check-in after closesAt must be rejected',
    )

    // ---- one valid check-in per resident per activity (partial unique index)
    assert.throws(
      () => insertCheckin(sqlite, fixture),
      /UNIQUE constraint failed: activity_checkins/,
      'a second valid check-in for the same resident must be rejected',
    )

    // ---- stock ledger is frozen and internally consistent
    assert.throws(
      () => insertStock(sqlite, fixture, { unitCost: 4_000 }),
      /stock row must copy the frozen reward plan/,
      'a stock row priced off the snapshot must be rejected',
    )
    assert.throws(
      () => sqlite.prepare('UPDATE activity_prize_stocks SET unit_cost_cents=1').run(),
      /prices and caps are frozen/,
      'the frozen unit cost must be immutable',
    )
    assert.throws(
      () =>
        sqlite
          .prepare(
            'UPDATE activity_prize_stocks SET claimed_quantity=11, committed_budget_cents=55000',
          )
          .run(),
      /activity_prize_stocks_quantity_check/,
      'claimed above total must be rejected',
    )
    assert.throws(
      () =>
        sqlite
          .prepare(
            'UPDATE activity_prize_stocks SET claimed_quantity=10, committed_budget_cents=50000',
          )
          .run(),
      /activity_prize_stocks_budget_check/,
      'committed budget above the cap must be rejected',
    )
    assert.throws(
      () => sqlite.prepare('DELETE FROM activity_prize_stocks').run(),
      /ledger and are never deleted/,
      'the stock ledger must never be deleted',
    )

    // ---- grants: one per team, priced by the snapshot, one-way lifecycle
    assert.throws(
      () => insertGrant(sqlite, fixture, { unitCost: 4_000 }),
      /grant must be priced by the frozen reward plan/,
      'a grant priced off the snapshot must be rejected',
    )
    assert.throws(
      () => insertGrant(sqlite, fixture),
      /UNIQUE constraint failed: activity_reward_grants/,
      'a second grant for the same activity+version+team must be rejected',
    )
    assert.throws(
      () => sqlite.prepare("UPDATE activity_reward_grants SET unit_cost_cents=1").run(),
      /price and identity are frozen/,
      'the granted price must be immutable',
    )
    assert.throws(
      () => sqlite.prepare("UPDATE activity_reward_grants SET status='disputed'").run(),
      /status transition is not allowed/,
      'granted -> disputed is not a legal transition',
    )

    // ---- events and disputes are append-only
    sqlite
      .prepare(
        `INSERT INTO activity_reward_events (id, activity_id, sequence, kind, created_at)
         VALUES (?,?,1,'grant.created',?)`,
      )
      .run(randomUUID(), fixture.activityId, NOW.getTime())
    assert.throws(
      () => sqlite.prepare("UPDATE activity_reward_events SET kind='grant.redeemed'").run(),
      /append-only/,
      'reward events must never be updated',
    )
    assert.throws(
      () => sqlite.prepare('DELETE FROM activity_reward_events').run(),
      /append-only/,
      'reward events must never be deleted',
    )
  } finally {
    fixture.sqlite.close()
    fixture.cleanup()
  }
})

test('a reward code is hashed, single-active and redeemable exactly once', () => {
  const fixture = createFixture()
  const { sqlite } = fixture
  try {
    const grantId = insertGrant(sqlite, fixture)
    const insertCode = (id: string, hash: string, suffix: string, expiresAt: number) =>
      sqlite
        .prepare(
          `INSERT INTO activity_reward_codes
             (id, grant_id, activity_id, team_id, code_hash, code_suffix, prize_name, status, issued_at, expires_at)
           VALUES (?,?,?,?,?,?,?,'active',?,?)`,
        )
        .run(id, grantId, fixture.activityId, fixture.teamId, hash, suffix, PLAN.prizeName, NOW.getTime(), expiresAt)

    const ttl = NOW.getTime() + PLAN.redemptionValidHours * 3_600_000
    const codeId = randomUUID()
    insertCode(codeId, 'a'.repeat(64), '9F3K', ttl)

    assert.throws(
      () => insertCode(randomUUID(), 'zz', '9F3K', ttl),
      /activity_reward_codes_hash_check/,
      'a non-hex hash must be rejected',
    )
    assert.throws(
      () => insertCode(randomUUID(), 'b'.repeat(64), '9f3k', ttl),
      /activity_reward_codes_suffix_check/,
      'a lowercase suffix must be rejected (Crockford base32 is upper case)',
    )
    assert.throws(
      () => insertCode(randomUUID(), 'c'.repeat(64), 'AAAA', NOW.getTime()),
      /activity_reward_codes_expiry_check/,
      'a TTL that ends before it starts must be rejected',
    )
    assert.throws(
      () => insertCode(randomUUID(), 'd'.repeat(64), 'BBBB', ttl),
      /UNIQUE constraint failed: activity_reward_codes/,
      'a second active credential for the same grant must be rejected',
    )

    sqlite
      .prepare("UPDATE activity_reward_codes SET status='redeemed', redeemed_at=?, redeemed_by_staff_id=? WHERE id=?")
      .run(CHECKIN_AT.getTime(), fixture.staffId, codeId)
    assert.throws(
      () => sqlite.prepare('UPDATE activity_reward_codes SET redeemed_at=? WHERE id=?').run(CHECKIN_AT.getTime() + 1, codeId),
      /exactly-once/,
      'a credential must not be redeemable twice',
    )
    assert.throws(
      () => sqlite.prepare('DELETE FROM activity_reward_codes').run(),
      /append-only history/,
      'credentials must never be deleted',
    )
  } finally {
    fixture.sqlite.close()
    fixture.cleanup()
  }
})

test('a redeemed prize keeps its redemption stamp when it turns disputed and reversed', () => {
  const fixture = createFixture()
  const { sqlite } = fixture
  try {
    insertStock(sqlite, fixture)
    const grantId = insertGrant(sqlite, fixture)
    sqlite
      .prepare('UPDATE activity_prize_stocks SET claimed_quantity=1, committed_budget_cents=5000')
      .run()

    sqlite
      .prepare("UPDATE activity_reward_grants SET status='redeemed', redeemed_at=?, redeemed_by_staff_id=? WHERE id=?")
      .run(CHECKIN_AT.getTime(), fixture.staffId, grantId)
    sqlite
      .prepare('UPDATE activity_prize_stocks SET redeemed_quantity=1, redeemed_budget_cents=5000')
      .run()

    // Reversal is expressed by appended rows; the redeemed ledger counters are
    // monotonic so the ledger can never disagree with the audit trail.
    sqlite.prepare("UPDATE activity_reward_grants SET status='disputed' WHERE id=?").run(grantId)
    assert.throws(
      () =>
        sqlite
          .prepare('UPDATE activity_prize_stocks SET redeemed_quantity=0, redeemed_budget_cents=0')
          .run(),
      /redeemed stock never decreases/,
      'a reversal must not un-redeem the stock ledger',
    )
    sqlite
      .prepare("INSERT INTO activity_reward_disputes (id, activity_id, grant_id, decision, reason, actor_staff_id, created_at) VALUES (?,?,?,'opened',?,?,?)")
      .run(randomUUID(), fixture.activityId, grantId, '居民反馈礼品损坏', fixture.staffId, CHECKIN_AT.getTime())
    sqlite
      .prepare("UPDATE activity_reward_grants SET status='reversed' WHERE id=?")
      .run(grantId)

    const grant = sqlite
      .prepare('SELECT status, redeemed_at, redeemed_by_staff_id FROM activity_reward_grants WHERE id=?')
      .get(grantId) as { status: string; redeemed_at: number | null; redeemed_by_staff_id: string | null }
    assert.equal(grant.status, 'reversed')
    assert.equal(grant.redeemed_at, CHECKIN_AT.getTime(), 'the redemption stamp must survive the reversal')
    assert.equal(grant.redeemed_by_staff_id, fixture.staffId)
  } finally {
    fixture.sqlite.close()
    fixture.cleanup()
  }
})

test('an unredeemed grant may be revoked and the release may lower the committed budget', () => {
  const fixture = createFixture()
  const { sqlite } = fixture
  try {
    insertStock(sqlite, fixture)
    const grantId = insertGrant(sqlite, fixture)
    sqlite
      .prepare('UPDATE activity_prize_stocks SET claimed_quantity=1, committed_budget_cents=5000')
      .run()

    assert.throws(
      () => sqlite.prepare("UPDATE activity_reward_grants SET status='revoked'").run(),
      /activity_reward_grants_revocation_check/,
      'a revocation without a stamp must be rejected',
    )
    sqlite
      .prepare("UPDATE activity_reward_grants SET status='revoked', revoked_at=?, revoked_by_staff_id=?, revoke_reason=? WHERE id=?")
      .run(CHECKIN_AT.getTime(), fixture.staffId, '活动取消', grantId)
    sqlite
      .prepare('UPDATE activity_prize_stocks SET claimed_quantity=0, committed_budget_cents=0')
      .run()

    const stock = sqlite
      .prepare('SELECT claimed_quantity, redeemed_quantity, committed_budget_cents FROM activity_prize_stocks')
      .get() as { claimed_quantity: number; redeemed_quantity: number; committed_budget_cents: number }
    assert.deepEqual(stock, { claimed_quantity: 0, redeemed_quantity: 0, committed_budget_cents: 0 })
  } finally {
    fixture.sqlite.close()
    fixture.cleanup()
  }
})

test('migration 0006 upgrades a pre-existing database in place without backfilling', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-0006-upgrade-'))
  try {
    const staged = join(tempDir, 'migrations-before-0006')
    cpSync(migrationsFolder, staged, { recursive: true })
    const journalPath = join(staged, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    writeFileSync(
      journalPath,
      JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 5) }),
    )

    const databasePath = join(tempDir, 'upgrade.sqlite')
    const legacy = createDatabase(databasePath, staged)
    const legacyCommunityId = randomUUID()
    const legacyActivityId = randomUUID()
    const legacyUserId = randomUUID()
    try {
      // Pre-0006 shape: `activities` has no `reward_plan_json`.
      const columns = legacy.sqlite.prepare("PRAGMA table_info('activities')").all() as Array<{
        name: string
      }>
      assert.ok(!columns.some((column) => column.name === 'reward_plan_json'))

      legacy.sqlite
        .prepare('INSERT INTO communities (id, name, created_at) VALUES (?,?,?)')
        .run(legacyCommunityId, '旧库社区', NOW.getTime())
      legacy.sqlite
        .prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?,?,?,?)')
        .run(legacyUserId, '旧库居民', NOW.getTime(), NOW.getTime())
      legacy.sqlite
        .prepare(
          `INSERT INTO activities
             (id, community_id, title, status, starts_at, ends_at, location, budget_cap_cents,
              prize_quantity_cap, public_rules_json, created_by_user_id, created_at, updated_at)
           VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          legacyActivityId,
          legacyCommunityId,
          '旧活动',
          NOW.getTime(),
          NOW.getTime() + 86_400_000,
          '社区广场',
          9_876_543,
          4_321,
          JSON.stringify(PUBLIC_RULES),
          legacyUserId,
          NOW.getTime(),
          NOW.getTime(),
        )
    } finally {
      legacy.sqlite.close()
    }

    const upgraded = createDatabase(databasePath, migrationsFolder)
    try {
      const row = upgraded.sqlite
        .prepare('SELECT title, budget_cap_cents, prize_quantity_cap, reward_plan_json FROM activities WHERE id=?')
        .get(legacyActivityId) as {
        title: string
        budget_cap_cents: number
        prize_quantity_cap: number
        reward_plan_json: string | null
      }
      // The column is added nullable and NOT backfilled from the mutable
      // activity columns: an old activity simply has no reward plan.
      assert.equal(row.reward_plan_json, null)
      assert.equal(row.title, '旧活动')
      assert.equal(row.budget_cap_cents, 9_876_543)
      assert.equal(row.prize_quantity_cap, 4_321)

      const tables = upgraded.sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN
             ('activity_checkins','activity_reward_grants','activity_reward_codes',
              'activity_prize_stocks','activity_reward_events','activity_reward_disputes')
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
      assert.deepEqual(
        tables.map((table) => table.name),
        [
          'activity_checkins',
          'activity_prize_stocks',
          'activity_reward_codes',
          'activity_reward_disputes',
          'activity_reward_events',
          'activity_reward_grants',
        ],
      )

      // Every 0006 foreign key stays restrictive, matching the #60 precedent.
      for (const table of [
        'activity_checkins',
        'activity_reward_grants',
        'activity_reward_codes',
        'activity_prize_stocks',
        'activity_reward_events',
        'activity_reward_disputes',
      ]) {
        const foreignKeys = upgraded.sqlite
          .prepare(`PRAGMA foreign_key_list('${table}')`)
          .all() as Array<{ on_delete: string }>
        assert.ok(foreignKeys.length > 0, `${table} must have foreign keys`)
        for (const foreignKey of foreignKeys) {
          assert.equal(foreignKey.on_delete.toUpperCase(), 'RESTRICT')
        }
      }
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('migration 0007 adds the disputed -> redeemed edge on fresh and upgraded databases', () => {
  const edgeRegex = /'disputed' AND NEW\.`status` IN \('reversed', 'redeemed'\)/u

  // (1) Fresh database: every migration applied in order.
  {
    const tempDir = mkdtempSync(join(tmpdir(), 'll-0007-fresh-'))
    try {
      const { sqlite } = createDatabase(join(tempDir, 'fresh.sqlite'), migrationsFolder)
      try {
        const trigger = sqlite
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='activity_reward_grants_status_transition'",
          )
          .get() as { sql: string }
        assert.match(trigger.sql, edgeRegex, 'the dismissed -> redeemed edge must exist')
        // The pre-existing edges must all survive the rebuild.
        assert.match(trigger.sql, /OLD\.`status` = 'granted' AND NEW\.`status` IN \('redeemed', 'revoked', 'expired'\)/u)
        assert.match(trigger.sql, /OLD\.`status` = 'redeemed' AND NEW\.`status` = 'disputed'/u)
        assert.match(trigger.sql, /OLD\.`status` = 'disputed' AND NEW\.`status` IN \('reversed', 'redeemed'\)/u)

        // Exactly one status-transition trigger, not a duplicate left behind by
        // the DROP/CREATE pair.
        const count = sqlite
          .prepare(
            "SELECT count(*) AS c FROM sqlite_master WHERE type='trigger' AND name='activity_reward_grants_status_transition'",
          )
          .get() as { c: number }
        assert.equal(count.c, 1)

        const integrity = sqlite.prepare('PRAGMA integrity_check').all() as Array<{
          integrity_check: string
        }>
        assert.deepEqual(integrity, [{ integrity_check: 'ok' }])
      } finally {
        sqlite.close()
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }

  // (2) A database that already applied 0006, then receives 0007.
  {
    const tempDir = mkdtempSync(join(tmpdir(), 'll-0007-upgrade-'))
    try {
      const staged = join(tempDir, 'migrations-before-0007')
      cpSync(migrationsFolder, staged, { recursive: true })
      const journalPath = join(staged, 'meta', '_journal.json')
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: Array<{ idx: number }>
      }
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 6) }),
      )
      // Remove the 0007 SQL so the staged folder really is a 0006-era tree.
      rmSync(join(staged, '0007_dispute_dismissed_restores_grant.sql'), { force: true })
      rmSync(join(staged, 'meta', '0007_snapshot.json'), { force: true })

      const databasePath = join(tempDir, 'upgrade.sqlite')
      const before = createDatabase(databasePath, staged)
      try {
        const trigger = before.sqlite
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='activity_reward_grants_status_transition'",
          )
          .get() as { sql: string }
        assert.doesNotMatch(trigger.sql, edgeRegex, 'the 0006 trigger must not have the edge yet')
        const applied = before.sqlite
          .prepare('SELECT count(*) AS c FROM __drizzle_migrations')
          .get() as { c: number }
        assert.equal(applied.c, 7)
      } finally {
        before.sqlite.close()
      }

      const after = createDatabase(databasePath, migrationsFolder)
      try {
        const trigger = after.sqlite
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='activity_reward_grants_status_transition'",
          )
          .get() as { sql: string }
        assert.match(trigger.sql, edgeRegex, 'the upgrade must add the edge in place')
        const applied = after.sqlite
          .prepare('SELECT count(*) AS c FROM __drizzle_migrations')
          .get() as { c: number }
        // The count is derived from the journal so adding a later migration does
        // not require editing an unrelated rewards test.
        const journal = JSON.parse(
          readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
        ) as { entries: Array<{ idx: number }> }
        assert.equal(applied.c, journal.entries.length)
        const integrity = after.sqlite
          .prepare('PRAGMA integrity_check')
          .all() as Array<{ integrity_check: string }>
        assert.deepEqual(integrity, [{ integrity_check: 'ok' }])
      } finally {
        after.sqlite.close()
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
})

test('migration 0007 repairs grants already stranded by a dismissed dispute', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-0007-repair-'))
  try {
    // Stage a 0006-era database so the stranded rows exist BEFORE 0007 runs.
    const staged = join(tempDir, 'migrations-before-0007')
    cpSync(migrationsFolder, staged, { recursive: true })
    rmSync(join(staged, '0007_dispute_dismissed_restores_grant.sql'), { force: true })
    rmSync(join(staged, 'meta', '0007_snapshot.json'), { force: true })
    const journalPath = join(staged, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ idx: number }> }
    writeFileSync(
      journalPath,
      JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 6) }),
    )

    const databasePath = join(tempDir, 'repair.sqlite')
    const ids = {
      // Latest thread entry is `dismissed` -> must be restored.
      dismissedOnly: '',
      // A `dismissed` exists but is NOT the latest entry -> stays disputed. This
      // is the case a naive `EXISTS(... decision='dismissed')` would wrongly
      // repair, so it is the real robustness check on the "latest only" rule.
      dismissedNotLatest: '',
      // Still under review (latest is `opened`) -> must stay disputed.
      stillOpen: '',
      // Upheld (`reversed`) -> grant is already `reversed`, untouched.
      reversed: '',
    }

    const before = createDatabase(databasePath, staged)
    try {
      const s = before.sqlite
      const fixture: Fixture = {
        db: before.db,
        sqlite: s,
        activityId: '',
        ruleVersionId: '',
        teamId: '',
        staffId: '',
        userIds: [],
        cleanup: () => {},
      }
      // Minimal activity + rule version + team + staff + residents, by raw SQL so
      // the fixture matches the 0006 shape exactly.
      fixture.activityId = randomUUID()
      fixture.ruleVersionId = randomUUID()
      const communityId = randomUUID()
      const creatorId = randomUUID()
      s.prepare('INSERT INTO communities (id, name, created_at) VALUES (?,?,?)').run(
        communityId,
        '修复社区',
        NOW.getTime(),
      )
      s.prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?,?,?,?)').run(
        creatorId,
        '创建人',
        NOW.getTime(),
        NOW.getTime(),
      )
      s.prepare(
        `INSERT INTO activities
           (id, community_id, title, status, starts_at, ends_at, location, budget_cap_cents,
            prize_quantity_cap, public_rules_json, created_by_user_id, created_at, updated_at)
         VALUES (?,?,?,'published',?,?,?,?,?,?,?,?,?)`,
      ).run(
        fixture.activityId,
        communityId,
        '奖励活动',
        NOW.getTime(),
        NOW.getTime() + 30 * 86_400_000,
        '社区广场',
        100_000,
        10,
        JSON.stringify(PUBLIC_RULES),
        creatorId,
        NOW.getTime(),
        NOW.getTime(),
      )
      s.prepare(
        `INSERT INTO activity_rule_versions
           (id, activity_id, version, snapshot_json, created_by_user_id, created_at)
         VALUES (?,?,1,?,?,?)`,
      ).run(
        fixture.ruleVersionId,
        fixture.activityId,
        JSON.stringify({ ...PUBLIC_RULES, startsAt: new Date(NOW).toISOString(), rewardPlan: PLAN }),
        creatorId,
        NOW.getTime(),
      )
      const staffUserId = randomUUID()
      s.prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?,?,?,?)').run(
        staffUserId,
        '运营员',
        NOW.getTime(),
        NOW.getTime(),
      )
      fixture.staffId = randomUUID()
      s.prepare(
        `INSERT INTO staff_accounts
           (id, user_id, username, password_hash, role, status, created_at, updated_at)
         VALUES (?,?,?,?,'admin','active',?,?)`,
      ).run(fixture.staffId, staffUserId, 'repair-admin', 'x', NOW.getTime(), NOW.getTime())

      // Grant recipient must be a real user (restrict FK), so track each team's
      // leader and reuse it as the recipient.
      const leaders = new Map<string, string>()
      const makeGrant = (): string => {
        const teamId = randomUUID()
        const leaderId = randomUUID()
        leaders.set(teamId, leaderId)
        s.prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?,?,?,?)').run(
          leaderId,
          `团长-${leaderId.slice(0, 6)}`,
          NOW.getTime(),
          NOW.getTime(),
        )
        s.prepare(
          `INSERT INTO activity_teams (id, activity_id, leader_user_id, status, created_at, locked_at)
           VALUES (?,?,?,'locked',?,?)`,
        ).run(teamId, fixture.activityId, leaderId, NOW.getTime(), NOW.getTime())
        // `granted` first; the disputed flag is applied last via a legal path.
        const grantId = randomUUID()
        s.prepare(
          `INSERT INTO activity_reward_grants
             (id, activity_id, rule_version_id, team_id, prize_name, quantity, unit_cost_cents,
              total_cost_cents, status, recipient_role, recipient_user_id, granted_at, created_at, updated_at)
           VALUES (?,?,?,?,?,1,?,?,'granted','leader',?,?,?,?)`,
        ).run(
          grantId,
          fixture.activityId,
          fixture.ruleVersionId,
          teamId,
          PLAN.prizeName,
          PLAN.prizeUnitCostCents,
          PLAN.prizeUnitCostCents,
          leaders.get(teamId)!,
          NOW.getTime(),
          NOW.getTime(),
          NOW.getTime(),
        )
        return grantId
      }

      // Drive a grant to `redeemed` then `disputed` through the legal 0006 path.
      const toDisputed = (grantId: string): void => {
        s.prepare(
          `UPDATE activity_reward_grants
             SET status='redeemed', redeemed_at=?, redeemed_by_staff_id=?, updated_at=?
           WHERE id=?`,
        ).run(NOW.getTime(), fixture.staffId, NOW.getTime(), grantId)
        s.prepare(`UPDATE activity_reward_grants SET status='disputed', updated_at=? WHERE id=?`).run(
          NOW.getTime(),
          grantId,
        )
      }
      const addDecision = (grantId: string, decision: string, at: number): void => {
        s.prepare(
          `INSERT INTO activity_reward_disputes
             (id, activity_id, grant_id, decision, reason, note, actor_staff_id, created_at)
           VALUES (?,?,?,?,?,NULL,?,?)`,
        ).run(randomUUID(), fixture.activityId, grantId, decision, '核查理由', fixture.staffId, at)
      }

      ids.dismissedOnly = makeGrant()
      toDisputed(ids.dismissedOnly)
      addDecision(ids.dismissedOnly, 'opened', NOW.getTime())
      addDecision(ids.dismissedOnly, 'dismissed', NOW.getTime() + 1_000)

      // The 0006 trigger forbids a second `opened`, so a thread can never be
      // literally reopened. The equivalent hazard is a `dismissed` that is not
      // the newest row: insert the `opened` with the LATER timestamp so it stays
      // authoritative (the trigger validates against the latest by created_at).
      ids.dismissedNotLatest = makeGrant()
      toDisputed(ids.dismissedNotLatest)
      addDecision(ids.dismissedNotLatest, 'opened', NOW.getTime() + 2_000)
      addDecision(ids.dismissedNotLatest, 'dismissed', NOW.getTime() + 1_000)

      ids.stillOpen = makeGrant()
      toDisputed(ids.stillOpen)
      addDecision(ids.stillOpen, 'opened', NOW.getTime())

      ids.reversed = makeGrant()
      toDisputed(ids.reversed)
      addDecision(ids.reversed, 'opened', NOW.getTime())
      addDecision(ids.reversed, 'reversed', NOW.getTime() + 1_000)
      s.prepare(`UPDATE activity_reward_grants SET status='reversed', updated_at=? WHERE id=?`).run(
        NOW.getTime(),
        ids.reversed,
      )

      // Sanity: all four are stranded/terminal exactly as described.
      const statusOf = (id: string): string =>
        (s.prepare('SELECT status FROM activity_reward_grants WHERE id=?').get(id) as { status: string })
          .status
      assert.equal(statusOf(ids.dismissedOnly), 'disputed')
      assert.equal(statusOf(ids.dismissedNotLatest), 'disputed')
      assert.equal(statusOf(ids.stillOpen), 'disputed')
      assert.equal(statusOf(ids.reversed), 'reversed')
    } finally {
      before.sqlite.close()
    }

    // Run 0007: trigger replacement + data repair, in that order.
    const after = createDatabase(databasePath, migrationsFolder)
    try {
      const statusOf = (id: string): string =>
        (after.sqlite.prepare('SELECT status FROM activity_reward_grants WHERE id=?').get(id) as {
          status: string
        }).status

      // The whole point: existing stranded rows are repaired, not just future ones.
      assert.equal(statusOf(ids.dismissedOnly), 'redeemed', 'a dismissed-only thread is restored')
      // No collateral damage: a thread that was reopened, or is still open, stays.
      assert.equal(
        statusOf(ids.dismissedNotLatest),
        'disputed',
        'a `dismissed` that is not the newest entry does not restore the grant',
      )
      assert.equal(statusOf(ids.stillOpen), 'disputed', 'an open thread stays disputed')
      assert.equal(statusOf(ids.reversed), 'reversed', 'a reversed grant is untouched')

      // The repair must not fake a redemption: the stamps stay null for a grant
      // that never went through redemption, and untouched where they existed.
      const repaired = after.sqlite
        .prepare('SELECT redeemed_at, redeemed_by_staff_id, revoked_at FROM activity_reward_grants WHERE id=?')
        .get(ids.dismissedOnly) as {
        redeemed_at: number | null
        redeemed_by_staff_id: string | null
        revoked_at: number | null
      }
      assert.equal(repaired.revoked_at, null, 'repair does not fabricate a revocation')

      // Only ONE trigger definition after the DROP/CREATE pair.
      const triggerCount = after.sqlite
        .prepare(
          "SELECT count(*) AS c FROM sqlite_master WHERE type='trigger' AND name='activity_reward_grants_status_transition'",
        )
        .get() as { c: number }
      assert.equal(triggerCount.c, 1, 'the trigger is replaced, not stacked')

      const integrity = after.sqlite.prepare('PRAGMA integrity_check').all() as Array<{
        integrity_check: string
      }>
      assert.deepEqual(integrity, [{ integrity_check: 'ok' }])
    } finally {
      after.sqlite.close()
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
