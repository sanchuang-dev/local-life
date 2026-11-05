import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import {
  API_ERROR_CODES,
  activityRewardPlanSchema,
  type ActivityKeyRules,
  type ActivityRewardPlan,
  type ActivityStatus,
} from '@sanchuang-dev/local-life-contracts'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import {
  ActivityError,
  createActivity,
  getAdminActivity,
  listActivityRuleVersions,
  transitionActivity,
  updateActivity,
  type ActivityOperator,
} from '../src/activities/service.js'
import { confirmParticipation } from '../src/participation/service.js'
import { claimTeamReward, recordCheckin } from '../src/rewards/service.js'
import { activities, activityRuleVersions, communities, staffAccounts, users } from '../src/db/schema.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

const OPEN = new Date('2026-11-01T00:00:00.000Z')
const IN_WINDOW = new Date('2026-11-10T10:00:00.000Z')

const PLAN: ActivityRewardPlan = {
  prizeName: '鸡蛋一盒',
  prizeUnitCostCents: 5_000,
  prizeQuantityPerTeam: 1,
  totalPrizeQuantity: 4,
  budgetCapCents: 20_000,
  claimRecipient: 'leader',
  checkinWindow: {
    opensAt: '2026-11-01T00:00:00.000Z',
    closesAt: '2026-11-30T00:00:00.000Z',
  },
  redemptionValidHours: 720,
}

const BASE_RULES: ActivityKeyRules = {
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2026-11-30T00:00:00.000Z',
  location: '人民广场',
  budgetCapCents: 20_000,
  prizeQuantityCap: 4,
  publicRules: {
    eligibility: '本社区 60 岁以上居民',
    checkin: '活动当天到现场签到',
    purchase: '无消费门槛',
    prizeClaim: '达标后凭券领取',
  },
  rewardPlan: PLAN,
}

interface World {
  db: AppDatabase
  sqlite: SqliteConnection
  communityId: string
  operator: ActivityOperator
  cleanup: () => void
}

function createWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'll-plan-frozen-'))
  const { db, sqlite } = createDatabase(join(dir, 'frozen.sqlite'), migrationsFolder)

  const communityId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '奖励社区', createdAt: OPEN }).run()

  const adminUser = randomUUID()
  db.insert(users)
    .values({ id: adminUser, displayName: '管理员', createdAt: OPEN, updatedAt: OPEN })
    .run()
  const staffId = randomUUID()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId: adminUser,
      username: 'frozen-admin',
      passwordHash: 'x',
      role: 'admin',
      status: 'active',
      createdAt: OPEN,
      updatedAt: OPEN,
    })
    .run()

  return {
    db,
    sqlite,
    communityId,
    operator: { userId: adminUser, staffId, role: 'admin' },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Creates an activity and drives it to `status` through the real state machine. */
function makeActivity(world: World, status: ActivityStatus): string {
  const created = createActivity(world.db, world.operator, {
    communityId: world.communityId,
    title: `活动-${status}`,
    keyRules: BASE_RULES,
  })
  let updatedAt = created.updatedAt
  if (status === 'draft') return created.id

  const published = transitionActivity(world.db, world.operator, created.id, 'publish', updatedAt)
  updatedAt = published.updatedAt
  if (status === 'published') return created.id
  if (status === 'paused') {
    transitionActivity(world.db, world.operator, created.id, 'pause', updatedAt)
    return created.id
  }
  const ended = transitionActivity(world.db, world.operator, created.id, 'end', updatedAt)
  void ended
  return created.id
}

/**
 * Seeds a three-person team whose members have all checked in, i.e. a team that
 * is eligible to claim. Returns the leader's user id.
 */
function seedCheckedInTeam(world: World, activityId: string, tag: string): string {
  const leader = randomUUID()
  world.db
    .insert(users)
    .values({ id: leader, displayName: `${tag}-leader`, createdAt: OPEN, updatedAt: OPEN })
    .run()
  const joined = confirmParticipation(world.db, { activityId, userId: leader, now: OPEN })
  const inviteCode = joined.state.team?.inviteCode
  assert.ok(inviteCode, 'the leader must receive an invite code')
  recordCheckin(world.db, { activityId, userId: leader, operator: world.operator, now: IN_WINDOW })

  for (const suffix of ['m1', 'm2']) {
    const member = randomUUID()
    world.db
      .insert(users)
      .values({ id: member, displayName: `${tag}-${suffix}`, createdAt: OPEN, updatedAt: OPEN })
      .run()
    confirmParticipation(world.db, { activityId, userId: member, inviteCode, now: OPEN })
    recordCheckin(world.db, {
      activityId,
      userId: member,
      operator: world.operator,
      now: IN_WINDOW,
    })
  }
  return leader
}

function currentDetail(world: World, activityId: string) {
  return getAdminActivity(world.db, world.operator, activityId)
}

/** Reads the persisted plan and the newest frozen snapshot, for "nothing moved" checks. */
function persisted(world: World, activityId: string) {
  const row = world.db
    .select({ rewardPlanJson: activities.rewardPlanJson })
    .from(activities)
    .where(eq(activities.id, activityId))
    .get()
  const versions = listActivityRuleVersions(world.db, world.operator, activityId)
  const newest = versions.items[0]
  return {
    columnPlan: row?.rewardPlanJson ?? null,
    versionCount: versions.items.length,
    // A draft has never been published, so it has no frozen version at all.
    newestSnapshot: newest?.snapshot ?? null,
    newestVersion: newest?.version ?? null,
  }
}

/** Strips `rewardPlan` to build a payload that omits the key entirely. */
function rulesWithoutPlan(rules: ActivityKeyRules, overrides: Partial<ActivityKeyRules> = {}) {
  const { rewardPlan: _omitted, ...rest } = rules
  return { ...rest, ...overrides }
}

function expectLocked(fn: () => unknown): ActivityError {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof ActivityError, `expected ActivityError, got ${String(error)}`)
    assert.equal(error.status, 409)
    assert.equal(error.code, API_ERROR_CODES.rewardPlanLocked)
    // The message must tell an operator what to do instead of just refusing.
    assert.match(error.message, /结束活动后新建/u)
    return error
  }
  throw new Error('expected the reward plan change to be rejected, but it was accepted')
}

/* -------------------------------------------------------------------------- */
/* Draft may still configure the plan freely                                  */
/* -------------------------------------------------------------------------- */

test('a draft activity may change its reward plan freely', () => {
  const world = createWorld()
  try {
    const activityId = makeActivity(world, 'draft')

    const renamed = updateActivity(world.db, world.operator, activityId, {
      expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
      keyRules: { ...BASE_RULES, rewardPlan: { ...PLAN, prizeName: '牛奶一箱' } },
    })
    assert.equal(renamed.rewardPlan?.prizeName, '牛奶一箱')

    // A draft has no frozen version yet, so only the column carries the plan.
    const afterRename = persisted(world, activityId)
    assert.ok(afterRename.columnPlan?.includes('牛奶一箱'))
    assert.equal(afterRename.versionCount, 0, 'a draft does not mint rule versions')

    // Clearing is allowed while it is still a draft.
    const cleared = updateActivity(world.db, world.operator, activityId, {
      expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
      keyRules: { ...rulesWithoutPlan(BASE_RULES), rewardPlan: null },
    })
    assert.equal(cleared.rewardPlan, null)

    // And it can be configured again before publishing.
    const restored = updateActivity(world.db, world.operator, activityId, {
      expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
      keyRules: BASE_RULES,
    })
    assert.equal(restored.rewardPlan?.prizeName, PLAN.prizeName)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Published / paused: the plan is frozen                                     */
/* -------------------------------------------------------------------------- */

test('a published activity cannot rename the prize', () => {
  const world = createWorld()
  try {
    const activityId = makeActivity(world, 'published')
    const before = persisted(world, activityId)

    expectLocked(() =>
      updateActivity(world.db, world.operator, activityId, {
        expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
        keyRules: { ...BASE_RULES, rewardPlan: { ...PLAN, prizeName: '牛奶一箱' } },
      }),
    )

    // Neither the column nor the frozen snapshot may have moved. The stock ledger
    // is keyed by prize name, so a rename is what would open a fresh quota row.
    const after = persisted(world, activityId)
    assert.equal(after.columnPlan, before.columnPlan)
    assert.deepEqual(after.columnPlan, JSON.parse(JSON.stringify(before.columnPlan)))
    assert.ok(after.columnPlan?.includes(PLAN.prizeName))
    assert.equal(after.versionCount, before.versionCount, 'a rejected edit must not mint a version')
    assert.equal(after.newestVersion, before.newestVersion)
    assert.deepEqual(after.newestSnapshot?.rewardPlan, before.newestSnapshot?.rewardPlan)
    assert.equal(
      activityRewardPlanSchema.parse(after.newestSnapshot?.rewardPlan).prizeName,
      PLAN.prizeName,
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a published activity cannot change the plan budget', () => {
  const world = createWorld()
  try {
    const activityId = makeActivity(world, 'published')
    const before = persisted(world, activityId)

    expectLocked(() =>
      updateActivity(world.db, world.operator, activityId, {
        expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
        keyRules: { ...BASE_RULES, rewardPlan: { ...PLAN, budgetCapCents: 99_999 } },
      }),
    )

    const after = persisted(world, activityId)
    assert.equal(after.columnPlan, before.columnPlan)
    assert.equal(after.versionCount, before.versionCount)
    assert.equal(
      activityRewardPlanSchema.parse(after.newestSnapshot?.rewardPlan).budgetCapCents,
      PLAN.budgetCapCents,
    )
    // The activity-level cap itself is a separate field and was not touched either.
    assert.equal(currentDetail(world, activityId).budgetCapCents, BASE_RULES.budgetCapCents)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a published activity cannot have its plan cleared', () => {
  const world = createWorld()
  try {
    const activityId = makeActivity(world, 'published')
    const before = persisted(world, activityId)

    expectLocked(() =>
      updateActivity(world.db, world.operator, activityId, {
        expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
        keyRules: { ...rulesWithoutPlan(BASE_RULES), rewardPlan: null },
      }),
    )

    // Clearing would drop the frozen plan and close the resident reward entry.
    const after = persisted(world, activityId)
    assert.notEqual(after.columnPlan, null, 'the stored plan must survive an explicit clear attempt')
    assert.notEqual(after.newestSnapshot?.rewardPlan, null)
    assert.equal(after.versionCount, before.versionCount)
    assert.equal(currentDetail(world, activityId).rewardPlan?.prizeName, PLAN.prizeName)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a paused activity is frozen too, so pausing is not a way around the lock', () => {
  const world = createWorld()
  try {
    const activityId = makeActivity(world, 'paused')
    const before = persisted(world, activityId)

    expectLocked(() =>
      updateActivity(world.db, world.operator, activityId, {
        expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
        keyRules: { ...BASE_RULES, rewardPlan: { ...PLAN, prizeName: '牛奶一箱' } },
      }),
    )

    const after = persisted(world, activityId)
    assert.equal(after.columnPlan, before.columnPlan)
    assert.equal(after.versionCount, before.versionCount)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Ordinary edits must keep working                                           */
/* -------------------------------------------------------------------------- */

test('a published activity can still change its venue while resending the same plan', () => {
  const world = createWorld()
  try {
    const activityId = makeActivity(world, 'published')
    const before = persisted(world, activityId)

    // The realistic "operator re-submits the whole form" case: the plan comes
    // back byte-identical. Rejecting this would make the lock unusable.
    const updated = updateActivity(world.db, world.operator, activityId, {
      expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
      keyRules: { ...BASE_RULES, location: '幸福社区党群服务中心' },
    })
    assert.equal(updated.location, '幸福社区党群服务中心')

    const after = persisted(world, activityId)
    assert.equal(after.versionCount, before.versionCount + 1, 'a real edit still mints a version')
    assert.deepEqual(
      activityRewardPlanSchema.parse(after.newestSnapshot?.rewardPlan),
      activityRewardPlanSchema.parse(PLAN),
      'the frozen plan is carried forward unchanged',
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a published activity can still change its venue with the plan key omitted', () => {
  const world = createWorld()
  try {
    const activityId = makeActivity(world, 'published')
    const before = persisted(world, activityId)

    // Omitting the key means "leave the plan alone" — always allowed.
    const updated = updateActivity(world.db, world.operator, activityId, {
      expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
      keyRules: rulesWithoutPlan(BASE_RULES, { location: '新地点' }),
    })
    assert.equal(updated.location, '新地点')

    const after = persisted(world, activityId)
    assert.equal(after.versionCount, before.versionCount + 1)
    assert.notEqual(after.newestSnapshot?.rewardPlan, null)
    assert.equal(
      activityRewardPlanSchema.parse(after.newestSnapshot.rewardPlan).prizeName,
      PLAN.prizeName,
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('other rule fields stay editable on a published activity', () => {
  const world = createWorld()
  try {
    const activityId = makeActivity(world, 'published')

    // The lock is deliberately scoped to `rewardPlan` only. Locking all of
    // keyRules would stop operators from moving a venue, which is not the point.
    const updated = updateActivity(world.db, world.operator, activityId, {
      expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
      keyRules: { ...BASE_RULES, budgetCapCents: 30_000, prizeQuantityCap: 6 },
    })
    assert.equal(updated.budgetCapCents, 30_000)
    assert.equal(updated.prizeQuantityCap, 6)

    const snapshot = persisted(world, activityId).newestSnapshot
    assert.ok(snapshot, 'a published activity always has a frozen snapshot')
    assert.equal(snapshot.budgetCapCents, 30_000)
    assert.equal(snapshot.prizeQuantityCap, 6)
    assert.deepEqual(
      activityRewardPlanSchema.parse(snapshot.rewardPlan),
      activityRewardPlanSchema.parse(PLAN),
      'the plan is untouched by edits to neighbouring fields',
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('an ended activity cannot be edited at all, plan or otherwise', () => {
  const world = createWorld()
  try {
    const activityId = makeActivity(world, 'ended')
    try {
      updateActivity(world.db, world.operator, activityId, {
        expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
        keyRules: { ...BASE_RULES, location: '不允许' },
      })
      throw new Error('expected an ended activity to reject edits')
    } catch (error) {
      assert.ok(error instanceof ActivityError)
      assert.equal(error.status, 409)
      // The pre-existing "ended" guard fires first; the plan lock is not the reason.
      assert.equal(error.code, API_ERROR_CODES.conflict)
    }
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* The gap this lock closes                                                   */
/* -------------------------------------------------------------------------- */

test('a published activity cannot refresh its exhausted prize quota by renaming the prize', () => {
  const world = createWorld()
  try {
    const activityId = makeActivity(world, 'published')
    // Fill the activity-wide pool (totalPrizeQuantity = 4) with two teams of one.
    const firstTeam = seedCheckedInTeam(world, activityId, 'a')
    const secondTeam = seedCheckedInTeam(world, activityId, 'b')
    claimTeamReward(world.db, { activityId, userId: firstTeam, now: IN_WINDOW })
    claimTeamReward(world.db, { activityId, userId: secondTeam, now: IN_WINDOW })

    // Renaming the prize would open a second stock row with claimed = 0 and the
    // full total again — the quota refresh this lock exists to prevent.
    expectLocked(() =>
      updateActivity(world.db, world.operator, activityId, {
        expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
        keyRules: { ...BASE_RULES, rewardPlan: { ...PLAN, prizeName: '牛奶一箱' } },
      }),
    )

    // The ledger still shows exactly one prize name for the whole activity.
    const rows = world.sqlite
      .prepare('SELECT prize_name, claimed_quantity FROM activity_prize_stocks WHERE activity_id = ?')
      .all(activityId) as { prize_name: string; claimed_quantity: number }[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.prize_name, PLAN.prizeName)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('the frozen plan keeps one stock ledger row per activity', () => {
  const world = createWorld()
  try {
    const activityId = makeActivity(world, 'published')
    const before = persisted(world, activityId)

    // Renaming the prize is the exact move that would open a second stock row
    // (claimed = 0, total = the new plan value), resetting the activity quota.
    expectLocked(() =>
      updateActivity(world.db, world.operator, activityId, {
        expectedUpdatedAt: currentDetail(world, activityId).updatedAt,
        keyRules: { ...BASE_RULES, rewardPlan: { ...PLAN, prizeName: '牛奶一箱' } },
      }),
    )

    // The prize name that the stock ledger is keyed by never moved.
    const after = persisted(world, activityId)
    assert.equal(
      activityRewardPlanSchema.parse(after.newestSnapshot?.rewardPlan).prizeName,
      activityRewardPlanSchema.parse(before.newestSnapshot?.rewardPlan).prizeName,
    )
    // And no orphan rule version was written by the rejected attempt.
    const versionRows = world.db
      .select({ id: activityRuleVersions.id })
      .from(activityRuleVersions)
      .where(eq(activityRuleVersions.activityId, activityId))
      .all()
    assert.equal(versionRows.length, after.versionCount)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})
