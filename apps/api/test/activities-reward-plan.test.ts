import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import {
  activityKeyRulesSchema,
  activityKeyRulesWriteSchema,
  activityRewardPlanSchema,
  type ActivityKeyRules,
  type ActivityRewardPlan,
} from '@sanchuang-dev/local-life-contracts'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import {
  createActivity,
  getAdminActivity,
  getPublicActivity,
  listActivityRuleVersions,
  transitionActivity,
  updateActivity,
  type ActivityOperator,
} from '../src/activities/service.js'
import { confirmParticipation } from '../src/participation/service.js'
import { getAdminRewardOverview, getCheckinState } from '../src/rewards/service.js'
import {
  activities,
  activityRuleVersions,
  communities,
  staffAccounts,
  users,
} from '../src/db/schema.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

const OPEN = new Date('2026-11-01T00:00:00.000Z')
const IN_WINDOW = new Date('2026-11-10T10:00:00.000Z')

const PLAN: ActivityRewardPlan = {
  prizeName: '粮油礼包',
  prizeUnitCostCents: 5_000,
  prizeQuantityPerTeam: 1,
  totalPrizeQuantity: 10,
  budgetCapCents: 50_000,
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
  budgetCapCents: 50_000,
  prizeQuantityCap: 10,
  publicRules: {
    eligibility: '本社区 60 岁以上居民',
    checkin: '活动当天到现场签到',
    purchase: '无消费门槛',
    prizeClaim: '达标后凭券领取',
  },
  rewardPlan: PLAN,
}

/**
 * Key rules WITHOUT the `rewardPlan` key at all, which is what an ordinary
 * admin edit sends: the operator changed the venue and saved. The field is
 * `.nullable().optional()`, so omitting it is legal.
 */
function rulesWithoutPlan(location: string): ActivityKeyRules {
  const { rewardPlan: _omitted, ...rest } = BASE_RULES
  return { ...rest, location }
}

interface World {
  db: AppDatabase
  sqlite: SqliteConnection
  communityId: string
  operator: ActivityOperator
  cleanup: () => void
}

function createWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'll-activity-plan-'))
  const { db, sqlite } = createDatabase(join(dir, 'plan.sqlite'), migrationsFolder)

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
      username: 'plan-admin',
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

/** The newest frozen snapshot. `listActivityRuleVersions` orders by version DESC. */
function newestSnapshot(world: World, activityId: string): ActivityKeyRules {
  const versions = listActivityRuleVersions(world.db, world.operator, activityId)
  assert.ok(versions.items.length > 0, 'the activity must have at least one rule version')
  return versions.items[0]!.snapshot
}

/* -------------------------------------------------------------------------- */
/* The regression this file exists for                                        */
/* -------------------------------------------------------------------------- */

test('an ordinary edit to a published activity keeps the frozen reward plan', () => {
  const world = createWorld()
  try {
    const created = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '秋季敬老活动',
      keyRules: BASE_RULES,
    })
    const published = transitionActivity(
      world.db,
      world.operator,
      created.id,
      'publish',
      created.updatedAt,
    )

    // A resident joins so the check-in surface is genuinely reachable, not just
    // "not configured".
    const leader = randomUUID()
    world.db
      .insert(users)
      .values({ id: leader, displayName: '团长甲', createdAt: OPEN, updatedAt: OPEN })
      .run()
    confirmParticipation(world.db, { activityId: published.id, userId: leader, now: OPEN })

    const before = getCheckinState(world.db, {
      activityId: published.id,
      userId: leader,
      now: IN_WINDOW,
    })
    assert.equal(before.available, true, 'the reward entry works before the edit')

    // The bug: an edit that only moves the venue and omits `rewardPlan` used to
    // wipe the plan out of the FROZEN SNAPSHOT, which is the only thing
    // fulfilment reads.
    const updated = updateActivity(world.db, world.operator, published.id, {
      expectedUpdatedAt: published.updatedAt,
      keyRules: rulesWithoutPlan('幸福社区党群服务中心'),
    })

    // The edit itself must have taken effect.
    assert.equal(updated.location, '幸福社区党群服务中心')

    // 1) The frozen snapshot still carries the plan. Asserting the column would
    //    have passed even with the bug, because fulfilment never reads it.
    const snapshot = newestSnapshot(world, published.id)
    assert.notEqual(
      snapshot.rewardPlan,
      undefined,
      'the newest snapshot must still carry a reward plan',
    )
    assert.notEqual(snapshot.rewardPlan, null)
    assert.deepEqual(
      activityRewardPlanSchema.parse(snapshot.rewardPlan),
      activityRewardPlanSchema.parse(PLAN),
      'the frozen plan must be byte-identical to what was published',
    )

    // 2) The resident can still check in — the actual business consequence.
    const after = getCheckinState(world.db, {
      activityId: published.id,
      userId: leader,
      now: IN_WINDOW,
    })
    assert.equal(after.available, true, 'the resident reward entry must survive the edit')
    assert.equal(after.unavailableReason, null, 'no reward_unavailable reason may appear')

    // 3) The admin overview still reports the snapshot as the plan source.
    const overview = getAdminRewardOverview(world.db, world.operator, published.id)
    assert.equal(overview.planSource, 'rule_version_snapshot')
    assert.notEqual(overview.planSource, 'none')
    assert.equal(overview.planConfigured, true)
    assert.notEqual(overview.plan, null)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('an ordinary edit to a draft activity keeps the reward plan and exposes it', () => {
  const world = createWorld()
  try {
    const created = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '草稿活动',
      keyRules: BASE_RULES,
    })
    // A draft has no rule version yet, so the admin detail is the only way a form
    // can read the plan back. Without it the client necessarily drops the field.
    assert.notEqual(
      created.rewardPlan,
      null,
      'the admin detail must expose the plan so a form can round-trip it',
    )

    const updated = updateActivity(world.db, world.operator, created.id, {
      expectedUpdatedAt: created.updatedAt,
      keyRules: rulesWithoutPlan('新地点'),
    })
    assert.equal(updated.location, '新地点')
    assert.notEqual(updated.rewardPlan, null, 'the draft keeps its plan after a partial edit')
    assert.deepEqual(
      activityRewardPlanSchema.parse(updated.rewardPlan),
      activityRewardPlanSchema.parse(PLAN),
    )

    // The stored column agrees, so publishing later freezes the right plan.
    const row = world.db
      .select({ rewardPlanJson: activities.rewardPlanJson })
      .from(activities)
      .where(eq(activities.id, created.id))
      .get()
    assert.notEqual(row?.rewardPlanJson, null)

    // A draft is legitimately closed to residents, but the reason must be
    // "not published yet" — NOT "no plan". That distinction is the proof that
    // the plan survived the edit.
    const draftState = getCheckinState(world.db, {
      activityId: created.id,
      userId: world.operator.userId,
      now: IN_WINDOW,
    })
    assert.equal(draftState.available, false)
    assert.equal(draftState.unavailableReason, 'activity_not_published')
    assert.notEqual(draftState.unavailableReason, 'reward_plan_not_configured')

    // Publishing now must produce a snapshot that carries the plan.
    const published = transitionActivity(
      world.db,
      world.operator,
      created.id,
      'publish',
      updated.updatedAt,
    )
    const snapshot = newestSnapshot(world, published.id)
    assert.notEqual(snapshot.rewardPlan, null)

    // And the resident surface is genuinely open rather than "not configured".
    const leader = randomUUID()
    world.db
      .insert(users)
      .values({ id: leader, displayName: '团长乙', createdAt: OPEN, updatedAt: OPEN })
      .run()
    confirmParticipation(world.db, { activityId: published.id, userId: leader, now: OPEN })
    const state = getCheckinState(world.db, {
      activityId: published.id,
      userId: leader,
      now: IN_WINDOW,
    })
    assert.equal(state.available, true)
    assert.notEqual(state.unavailableReason, 'reward_plan_not_configured')
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* The three-way semantics: absent / null / value                             */
/* -------------------------------------------------------------------------- */

test('an explicit null clears the plan, and only an explicit null does', () => {
  const world = createWorld()
  try {
    const created = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '活动',
      keyRules: BASE_RULES,
    })
    const published = transitionActivity(
      world.db,
      world.operator,
      created.id,
      'publish',
      created.updatedAt,
    )

    // 1) Absent -> inherited. Edit twice to prove it is not a one-shot effect.
    const first = updateActivity(world.db, world.operator, published.id, {
      expectedUpdatedAt: published.updatedAt,
      keyRules: rulesWithoutPlan('地点一'),
    })
    assert.notEqual(first.rewardPlan, null)
    const second = updateActivity(world.db, world.operator, published.id, {
      expectedUpdatedAt: first.updatedAt,
      keyRules: rulesWithoutPlan('地点二'),
    })
    assert.notEqual(second.rewardPlan, null, 'repeated partial edits must not erode the plan')
    assert.notEqual(newestSnapshot(world, published.id).rewardPlan, null)

    // The plan never drifted, so no spurious rule version pile-up beyond the
    // real edits.
    assert.equal(listActivityRuleVersions(world.db, world.operator, published.id).items.length, 3)

    // 2) Explicit null on a PUBLISHED activity is refused outright: the prize
    //    ledger is keyed by prize name, so clearing (or renaming) after
    //    publication would reset the activity-wide quota. See
    //    activities-reward-plan-frozen.test.ts for the full lock contract.
    assert.throws(
      () =>
        updateActivity(world.db, world.operator, published.id, {
          expectedUpdatedAt: second.updatedAt,
          keyRules: { ...rulesWithoutPlan('地点二'), rewardPlan: null },
        }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'reward_plan_locked',
      'a published plan can no longer be cleared',
    )
    assert.notEqual(newestSnapshot(world, published.id).rewardPlan, null)

    // 3) The clear/restore pair is still supported while the activity is a
    //    draft, which is where plan editing legitimately happens.
    const draft = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '草稿活动',
      keyRules: BASE_RULES,
    })
    const cleared = updateActivity(world.db, world.operator, draft.id, {
      expectedUpdatedAt: draft.updatedAt,
      keyRules: { ...rulesWithoutPlan('地点二'), rewardPlan: null },
    })
    assert.equal(cleared.rewardPlan, null)

    const restored = updateActivity(world.db, world.operator, draft.id, {
      expectedUpdatedAt: cleared.updatedAt,
      keyRules: { ...rulesWithoutPlan('地点二'), rewardPlan: PLAN },
    })
    assert.notEqual(restored.rewardPlan, null)
    assert.deepEqual(
      activityRewardPlanSchema.parse(restored.rewardPlan),
      activityRewardPlanSchema.parse(PLAN),
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('the plan is preserved even when the edit changes an unrelated rule', () => {
  const world = createWorld()
  try {
    const created = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '活动',
      keyRules: BASE_RULES,
    })
    const published = transitionActivity(
      world.db,
      world.operator,
      created.id,
      'publish',
      created.updatedAt,
    )

    // Change the budget cap (a real rule change) while omitting rewardPlan.
    const updated = updateActivity(world.db, world.operator, published.id, {
      expectedUpdatedAt: published.updatedAt,
      keyRules: { ...rulesWithoutPlan('人民广场'), budgetCapCents: 60_000 },
    })
    assert.equal(updated.budgetCapCents, 60_000)

    const snapshot = newestSnapshot(world, published.id)
    assert.equal(snapshot.budgetCapCents, 60_000, 'the changed rule is frozen')
    assert.notEqual(snapshot.rewardPlan, null, 'the omitted plan is inherited')
    assert.deepEqual(
      activityRewardPlanSchema.parse(snapshot.rewardPlan),
      activityRewardPlanSchema.parse(PLAN),
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('an edit without rewardPlan does not rewrite the plan into the snapshot', () => {
  const world = createWorld()
  try {
    const customPlan: ActivityRewardPlan = {
      ...PLAN,
      prizeName: '定制礼包',
      prizeUnitCostCents: 8_800,
      budgetCapCents: 88_000,
    }
    const created = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '活动',
      keyRules: { ...BASE_RULES, rewardPlan: customPlan },
    })
    const published = transitionActivity(
      world.db,
      world.operator,
      created.id,
      'publish',
      created.updatedAt,
    )

    // Send an unrelated plan shape would be wrong; sending none must keep the
    // *stored* plan rather than any default.
    updateActivity(world.db, world.operator, published.id, {
      expectedUpdatedAt: published.updatedAt,
      keyRules: rulesWithoutPlan('新地点'),
    })

    const snapshot = newestSnapshot(world, published.id)
    assert.deepEqual(
      activityRewardPlanSchema.parse(snapshot.rewardPlan),
      activityRewardPlanSchema.parse(customPlan),
      'the inherited plan is the one that was actually stored, not a default',
    )

    // The stored snapshot JSON is what fulfilment parses, so verify it directly:
    // this is the exact column the reward service reads.
    const versionRow = world.db
      .select({
        snapshotJson: activityRuleVersions.snapshotJson,
        version: activityRuleVersions.version,
      })
      .from(activityRuleVersions)
      .where(eq(activityRuleVersions.id, published.currentRuleVersionId!))
      .get()
    assert.ok(versionRow, 'the current rule version must exist')
    assert.ok(
      versionRow.snapshotJson.includes('定制礼包'),
      'the frozen snapshot JSON must still contain the plan',
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* t13: the check-in window must sit inside the activity window                */
/* -------------------------------------------------------------------------- */

/**
 * The bug this block exists for: `rewardPlan.checkinWindow` and the activity's
 * own `startsAt`/`endsAt` were never cross-checked, so a plan could authorise
 * check-ins - and therefore claims and redemptions - before the activity had
 * started. `lifecycleBlockReason` gates only draft/paused/ended, which leaves
 * "published but not started yet" wide open, so the guard has to live in the
 * contract.
 */
function planWithWindow(opensAt: string, closesAt: string): ActivityRewardPlan {
  return { ...PLAN, checkinWindow: { opensAt, closesAt } }
}

function rulesWithWindow(rules: ActivityKeyRules, opensAt: string, closesAt: string): ActivityKeyRules {
  return { ...rules, rewardPlan: planWithWindow(opensAt, closesAt) }
}

/** Assert that creating an activity with these rules is refused, naming `path`. */
function expectCreateRejected(world: World, rules: ActivityKeyRules, path: string[]): void {
  assert.throws(
    () =>
      createActivity(world.db, world.operator, {
        communityId: world.communityId,
        title: '窗口越界活动',
        keyRules: rules,
      }),
    (error: unknown) => {
      // The contract rejects with a ZodError; `issues[].path` is the only precise
      // way to prove *which* field the operator has to fix. `message` is just a
      // JSON dump of the same issues, so assert on the array instead.
      const issues = (error as { issues?: Array<{ path: (string | number)[]; message: string }> })
        .issues
      assert.ok(Array.isArray(issues), `expected a validation error, got: ${String(error)}`)
      const match = issues.find((issue) => issue.path.join('.') === path.join('.'))
      assert.ok(
        match,
        `expected an issue at ${path.join('.')}, got: ${issues
          .map((issue) => issue.path.join('.'))
          .join(', ')}`,
      )
      // And the text must name the window, not just say "invalid".
      assert.ok(match.message.includes('checkinWindow'), match.message)
      return true
    },
  )
}

test('a check-in window entirely before the activity is rejected', () => {
  const world = createWorld()
  try {
    // Activity runs 11-01 .. 11-30, the window sits two weeks earlier.
    expectCreateRejected(
      world,
      rulesWithWindow(BASE_RULES, '2026-10-01T00:00:00.000Z', '2026-10-10T00:00:00.000Z'),
      ['rewardPlan', 'checkinWindow', 'opensAt'],
    )
    assert.equal(
      world.db.select().from(activities).all().length,
      0,
      'a rejected create must not leave a row behind',
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a check-in window entirely after the activity is rejected', () => {
  const world = createWorld()
  try {
    expectCreateRejected(
      world,
      rulesWithWindow(BASE_RULES, '2026-12-05T00:00:00.000Z', '2026-12-10T00:00:00.000Z'),
      ['rewardPlan', 'checkinWindow', 'closesAt'],
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a window starting one second before the activity is rejected', () => {
  const world = createWorld()
  try {
    // startsAt is 2026-11-01T00:00:00.000Z; one second earlier is out of bounds.
    expectCreateRejected(
      world,
      rulesWithWindow(BASE_RULES, '2026-10-31T23:59:59.000Z', '2026-11-30T00:00:00.000Z'),
      ['rewardPlan', 'checkinWindow', 'opensAt'],
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a window closing one second after the activity is rejected', () => {
  const world = createWorld()
  try {
    // endsAt is 2026-11-30T00:00:00.000Z; one second later is out of bounds.
    expectCreateRejected(
      world,
      rulesWithWindow(BASE_RULES, '2026-11-01T00:00:00.000Z', '2026-11-30T00:00:01.000Z'),
      ['rewardPlan', 'checkinWindow', 'closesAt'],
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a window exactly equal to the activity bounds is accepted and publishable', () => {
  const world = createWorld()
  try {
    const created = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '窗口与活动等长',
      keyRules: BASE_RULES, // PLAN's window is exactly BASE_RULES startsAt..endsAt
    })
    const published = transitionActivity(
      world.db,
      world.operator,
      created.id,
      'publish',
      created.updatedAt,
    )
    assert.equal(published.status, 'published')
    assert.deepEqual(newestSnapshot(world, published.id).rewardPlan?.checkinWindow, {
      opensAt: '2026-11-01T00:00:00.000Z',
      closesAt: '2026-11-30T00:00:00.000Z',
    })
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a window strictly inside the activity is accepted', () => {
  const world = createWorld()
  try {
    const created = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '窗口在活动之内',
      keyRules: rulesWithWindow(BASE_RULES, '2026-11-05T00:00:00.000Z', '2026-11-20T00:00:00.000Z'),
    })
    // Rule versions are minted on publish, not on create, so publish first and
    // then read the frozen snapshot - that is the only thing fulfilment reads.
    const published = transitionActivity(
      world.db,
      world.operator,
      created.id,
      'publish',
      created.updatedAt,
    )
    assert.equal(published.status, 'published')
    assert.deepEqual(newestSnapshot(world, published.id).rewardPlan?.checkinWindow, {
      opensAt: '2026-11-05T00:00:00.000Z',
      closesAt: '2026-11-20T00:00:00.000Z',
    })
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('an updating edit cannot move the window outside the activity', () => {
  const world = createWorld()
  try {
    const created = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '草稿阶段改窗口',
      keyRules: BASE_RULES,
    })
    // Draft: the plan is not frozen yet, so a bad window must still be refused.
    assert.throws(
      () =>
        updateActivity(world.db, world.operator, created.id, {
          expectedUpdatedAt: created.updatedAt,
          keyRules: rulesWithWindow(
            BASE_RULES,
            '2026-10-01T00:00:00.000Z',
            '2026-11-30T00:00:00.000Z',
          ),
        }),
      (error: unknown) => {
        const issues = (error as { issues?: Array<{ path: (string | number)[] }> }).issues
        assert.ok(Array.isArray(issues), `expected a validation error, got: ${String(error)}`)
        assert.ok(
          issues.some((issue) => issue.path.join('.') === 'rewardPlan.checkinWindow.opensAt'),
          issues.map((issue) => issue.path.join('.')).join(', '),
        )
        return true
      },
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('an activity without a reward plan is unaffected by the window cross-check', () => {
  const world = createWorld()
  try {
    // No `rewardPlan` key at all: the pre-#62 shape.
    const withoutPlan = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '无奖励计划活动',
      keyRules: rulesWithoutPlan('人民广场'),
    })
    const published = transitionActivity(
      world.db,
      world.operator,
      withoutPlan.id,
      'publish',
      withoutPlan.updatedAt,
    )
    assert.equal(published.status, 'published')
    assert.equal(
      newestSnapshot(world, published.id).rewardPlan,
      undefined,
      'a plan-free snapshot must not gain a rewardPlan key',
    )

    // Explicit null is the other legal "no plan" state.
    const cleared = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '显式清空计划活动',
      keyRules: { ...rulesWithoutPlan('人民广场'), rewardPlan: null },
    })
    assert.ok(cleared.id)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Historical rows stay readable (and repairable)                             */
/* -------------------------------------------------------------------------- */

/**
 * Why this block exists.
 *
 * The obvious way to implement the cross-check is a `superRefine` on
 * `activityKeyRulesSchema`. That schema is also the parser for *already-stored*
 * data - every frozen `activity_rule_versions.snapshot_json` read path goes
 * through it - so folding the rule in would make every row written before the
 * rule existed unreadable: the rule-version list, the resident check-in state
 * and the admin reward overview would all throw, i.e. HTTP 500 on already
 * published activities. Worse, the operator could not repair the row, because
 * `updateActivity` re-validates the stored plan.
 *
 * So the guard lives on the write path only. These tests pin both halves:
 * bad new input is refused, old rows still read.
 */
function seedLegacyOutOfBoundsActivity(world: World, status: 'draft' | 'published'): string {
  const activityId = randomUUID()
  const ruleVersionId = randomUUID()
  // A snapshot as it could legitimately have been frozen BEFORE the cross-check:
  // the window (11-01..11-10) sits entirely before the activity (11-20..11-30).
  const legacySnapshot = JSON.stringify({
    startsAt: '2026-11-20T00:00:00.000Z',
    endsAt: '2026-11-30T00:00:00.000Z',
    location: '人民广场',
    budgetCapCents: 50_000,
    prizeQuantityCap: 10,
    publicRules: BASE_RULES.publicRules,
    rewardPlan: {
      ...PLAN,
      checkinWindow: { opensAt: '2026-11-01T00:00:00.000Z', closesAt: '2026-11-10T00:00:00.000Z' },
    },
  })
  // Inserted with raw SQL on purpose: the service layer would (correctly) refuse
  // to create this now, but a real database already contains such rows.
  world.sqlite
    .prepare(
      `INSERT INTO activity_rule_versions (id, activity_id, version, snapshot_json, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(ruleVersionId, activityId, 1, legacySnapshot, world.operator.userId, OPEN.getTime())
  world.sqlite
    .prepare(
      `INSERT INTO activities (id, community_id, title, status, starts_at, ends_at, location,
         budget_cap_cents, prize_quantity_cap, public_rules_json, reward_plan_json,
         current_rule_version_id, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      activityId,
      world.communityId,
      '历史活动',
      status,
      new Date('2026-11-20T00:00:00.000Z').getTime(),
      new Date('2026-11-30T00:00:00.000Z').getTime(),
      '人民广场',
      50_000,
      10,
      JSON.stringify(BASE_RULES.publicRules),
      JSON.stringify(PLAN),
      ruleVersionId,
      world.operator.userId,
      OPEN.getTime(),
      OPEN.getTime(),
    )
  return activityId
}

test('a row frozen before the cross-check still reads on every surface', () => {
  const world = createWorld()
  try {
    const activityId = seedLegacyOutOfBoundsActivity(world, 'published')

    // Every read path that re-parses `snapshot_json` must survive an
    // out-of-bounds window written before the rule existed.
    const detail = getAdminActivity(world.db, world.operator, activityId)
    assert.equal(detail.id, activityId)

    const versions = listActivityRuleVersions(world.db, world.operator, activityId)
    assert.equal(versions.items.length, 1)
    assert.equal(
      versions.items[0]!.snapshot.rewardPlan?.checkinWindow.opensAt,
      '2026-11-01T00:00:00.000Z',
      'the legacy window is surfaced as stored, not silently rewritten',
    )

    // The venue edit is the exact operation an operator would run; with a plan
    // key present it is a plain re-send and must still work.
    const overview = getAdminRewardOverview(world.db, world.operator, activityId)
    assert.equal(overview.planConfigured, true)

    const publicDetail = getPublicActivity(world.db, activityId)
    assert.equal(publicDetail.id, activityId)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('an operator can repair a legacy out-of-bounds window', () => {
  const world = createWorld()
  try {
    const activityId = seedLegacyOutOfBoundsActivity(world, 'draft')
    const detail = getAdminActivity(world.db, world.operator, activityId)

    // The repair: move the window inside the activity. If the lenient read path
    // did not exist, this call would throw on the *stored* plan before it could
    // ever apply the fix.
    const fixed = updateActivity(world.db, world.operator, activityId, {
      expectedUpdatedAt: detail.updatedAt,
      keyRules: {
        ...BASE_RULES,
        rewardPlan: {
          ...PLAN,
          checkinWindow: {
            opensAt: '2026-11-21T00:00:00.000Z',
            closesAt: '2026-11-25T00:00:00.000Z',
          },
        },
      },
    })
    assert.equal(fixed.rewardPlan?.checkinWindow.opensAt, '2026-11-21T00:00:00.000Z')
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('the lenient read schema still accepts an out-of-bounds window', () => {
  // Pinning the split directly: `activityKeyRulesSchema` (read) accepts what
  // `activityKeyRulesWriteSchema` (write) refuses. If someone later folds the
  // cross-check back into the read schema, this test goes red before any
  // already-published activity does.
  const outOfBounds = {
    ...BASE_RULES,
    rewardPlan: {
      ...PLAN,
      checkinWindow: { opensAt: '2026-10-01T00:00:00.000Z', closesAt: '2026-10-10T00:00:00.000Z' },
    },
  }
  assert.equal(activityKeyRulesSchema.safeParse(outOfBounds).success, true, 'read schema stays lenient')
  assert.equal(
    activityKeyRulesWriteSchema.safeParse(outOfBounds).success,
    false,
    'write schema refuses it',
  )
})
