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
  PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS,
  activityKeyRulesSchema,
  purchaseRewardPlanSchema,
  purchaseRewardTotalBudgetCents,
  type ActivityKeyRules,
  type ActivityRewardPlan,
  type AdminActivityDetail,
  type CreateActivityRequest,
  type PublicActivityDetail,
  type PurchaseRewardPlan,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import {
  ActivityError,
  createActivity,
  getAdminActivity,
  getPublicActivity,
  listActivityRuleVersions,
  transitionActivity,
  updateActivity,
  type ActivityOperator,
} from '../src/activities/service.js'
import { getAdminRewardOverview } from '../src/rewards/service.js'
import {
  activities,
  activityRuleVersions,
  communities,
  staffAccounts,
  users,
} from '../src/db/schema.js'
import { hashPassword } from '../src/auth/security.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

const OPEN = new Date('2026-11-01T00:00:00.000Z')
const ADMIN_PASSWORD = 'Admin-Password-123!'

const CHECKIN_PLAN: ActivityRewardPlan = {
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

/** 20,000 cents spent by the team → each of the three members gets a 2,000 cent coupon. */
const PURCHASE_PLAN: PurchaseRewardPlan = {
  thresholdCents: 20_000,
  couponFaceValueCents: 2_000,
  maxRewardedTeams: 50,
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
    purchase: '在本地好物消费满 200 元',
    prizeClaim: '达标后凭券领取',
  },
  rewardPlan: CHECKIN_PLAN,
  purchaseRewardPlan: PURCHASE_PLAN,
}

/** Rules without either optional plan key, i.e. the pre-#62 / pre-#206 shape. */
function rulesWithoutPlans(overrides: Partial<ActivityKeyRules> = {}): ActivityKeyRules {
  const { rewardPlan: _reward, purchaseRewardPlan: _purchase, ...rest } = BASE_RULES
  return { ...rest, ...overrides }
}

/** The pre-#206 shape: the check-in plan exists, the purchase plan does not. */
function rulesWithoutPurchasePlan(
  overrides: Partial<ActivityKeyRules> = {},
): ActivityKeyRules {
  const { purchaseRewardPlan: _purchase, ...rest } = BASE_RULES
  return { ...rest, ...overrides }
}

interface World {
  db: AppDatabase
  sqlite: SqliteConnection
  communityId: string
  operator: ActivityOperator
  outsider: ActivityOperator
  cleanup: () => void
}

function createWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'll-purchase-plan-'))
  const { db, sqlite } = createDatabase(join(dir, 'purchase.sqlite'), migrationsFolder)

  const communityId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '消费奖励社区', createdAt: OPEN }).run()

  const adminUser = randomUUID()
  db.insert(users)
    .values({ id: adminUser, displayName: '管理员', createdAt: OPEN, updatedAt: OPEN })
    .run()
  const staffId = randomUUID()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId: adminUser,
      username: 'purchase-admin',
      passwordHash: 'x',
      role: 'admin',
      status: 'active',
      createdAt: OPEN,
      updatedAt: OPEN,
    })
    .run()

  // An operator with no community assignment: allowed to log in, not to see or
  // edit this community's activity.
  const outsiderUser = randomUUID()
  db.insert(users)
    .values({ id: outsiderUser, displayName: '越权运营员', createdAt: OPEN, updatedAt: OPEN })
    .run()
  const outsiderStaff = randomUUID()
  db.insert(staffAccounts)
    .values({
      id: outsiderStaff,
      userId: outsiderUser,
      username: 'purchase-outsider',
      passwordHash: 'x',
      role: 'operator',
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
    outsider: { userId: outsiderUser, staffId: outsiderStaff, role: 'operator' },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function newestSnapshot(world: World, activityId: string): ActivityKeyRules {
  const versions = listActivityRuleVersions(world.db, world.operator, activityId)
  assert.ok(versions.items.length > 0, 'the activity must have at least one rule version')
  return versions.items[0]!.snapshot
}

function persisted(world: World, activityId: string) {
  const row = world.db
    .select({
      rewardPlanJson: activities.rewardPlanJson,
      purchaseRewardPlanJson: activities.purchaseRewardPlanJson,
    })
    .from(activities)
    .where(eq(activities.id, activityId))
    .get()
  const versions = listActivityRuleVersions(world.db, world.operator, activityId)
  return {
    column: row?.purchaseRewardPlanJson ?? null,
    versionCount: versions.items.length,
    newestSnapshot: versions.items[0]?.snapshot ?? null,
  }
}

function createDraft(world: World, rules: ActivityKeyRules = BASE_RULES): string {
  return createActivity(world.db, world.operator, {
    communityId: world.communityId,
    title: '消费组团活动',
    keyRules: rules,
  }).id
}

function currentUpdatedAt(world: World, activityId: string): string {
  return getAdminActivity(world.db, world.operator, activityId).updatedAt
}

/* -------------------------------------------------------------------------- */
/* Contract: one bounded tier                                                 */
/* -------------------------------------------------------------------------- */

test('the contract rejects a non-positive threshold, face value or team quota', () => {
  const badPlans = [
    { ...PURCHASE_PLAN, thresholdCents: 0 },
    { ...PURCHASE_PLAN, thresholdCents: -1 },
    { ...PURCHASE_PLAN, thresholdCents: 1.5 },
    { ...PURCHASE_PLAN, couponFaceValueCents: 0 },
    { ...PURCHASE_PLAN, couponFaceValueCents: -100 },
    { ...PURCHASE_PLAN, maxRewardedTeams: 0 },
    { ...PURCHASE_PLAN, maxRewardedTeams: 2.5 },
  ]
  for (const plan of badPlans) {
    assert.equal(
      purchaseRewardPlanSchema.safeParse(plan).success,
      false,
      `plan must be rejected: ${JSON.stringify(plan)}`,
    )
  }
})

test('the contract rejects a coupon liability above the activity budget cap', () => {
  const liability = purchaseRewardTotalBudgetCents({
    couponFaceValueCents: 1_000_000,
    maxRewardedTeams: 40,
  })
  assert.equal(liability, 120_000_000)
  assert.ok(liability > PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS)

  const result = purchaseRewardPlanSchema.safeParse({
    thresholdCents: 500_000,
    couponFaceValueCents: 1_000_000,
    maxRewardedTeams: 40,
  })
  assert.equal(result.success, false)
  if (!result.success) {
    assert.ok(
      result.error.issues.some((issue) => issue.path.join('.') === 'maxRewardedTeams'),
      `expected the maxRewardedTeams path, got ${result.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}`,
    )
  }

  // The boundary itself is accepted: exactly the cap is still within budget.
  const boundaryFace = 100_000
  const boundaryTeams = 333
  const boundary = purchaseRewardPlanSchema.safeParse({
    thresholdCents: 999_999,
    couponFaceValueCents: boundaryFace,
    maxRewardedTeams: boundaryTeams,
  })
  assert.equal(boundary.success, true)
  assert.ok(purchaseRewardTotalBudgetCents(boundary.data!) <= PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS)
})

test('a draft activity can write and read back the purchase plan', () => {
  const world = createWorld()
  try {
    const created = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '草稿消费团',
      keyRules: BASE_RULES,
    })
    assert.deepEqual(created.purchaseRewardPlan, PURCHASE_PLAN)
    assert.notEqual(created.purchaseRewardPlan, null)

    const changed: PurchaseRewardPlan = {
      thresholdCents: 30_000,
      couponFaceValueCents: 3_000,
      maxRewardedTeams: 20,
    }
    const updated = updateActivity(world.db, world.operator, created.id, {
      expectedUpdatedAt: created.updatedAt,
      keyRules: { ...BASE_RULES, purchaseRewardPlan: changed },
    })
    assert.deepEqual(updated.purchaseRewardPlan, changed)
    assert.deepEqual(JSON.parse(persisted(world, created.id).column!), changed)

    // A draft has no frozen version yet; the column is the only copy.
    assert.equal(persisted(world, created.id).versionCount, 0)

    // Clearing is deliberate and stays visible as "not configured".
    const cleared = updateActivity(world.db, world.operator, created.id, {
      expectedUpdatedAt: updated.updatedAt,
      keyRules: { ...rulesWithoutPlans(), purchaseRewardPlan: null },
    })
    assert.equal(cleared.purchaseRewardPlan, null)
    assert.equal(persisted(world, created.id).column, null)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('an ordinary edit that omits the key keeps the stored purchase plan', () => {
  const world = createWorld()
  try {
    const activityId = createDraft(world)
    const updated = updateActivity(world.db, world.operator, activityId, {
      expectedUpdatedAt: currentUpdatedAt(world, activityId),
      keyRules: rulesWithoutPlans({ location: '幸福社区党群服务中心' }),
    })
    assert.equal(updated.location, '幸福社区党群服务中心')
    assert.deepEqual(updated.purchaseRewardPlan, PURCHASE_PLAN)
    assert.deepEqual(JSON.parse(persisted(world, activityId).column!), PURCHASE_PLAN)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Publication freeze                                                         */
/* -------------------------------------------------------------------------- */

test('publishing freezes the purchase plan into the rule snapshot', () => {
  const world = createWorld()
  try {
    const activityId = createDraft(world)
    const published = transitionActivity(
      world.db,
      world.operator,
      activityId,
      'publish',
      currentUpdatedAt(world, activityId),
    )
    assert.equal(published.status, 'published')
    assert.deepEqual(newestSnapshot(world, activityId).purchaseRewardPlan, PURCHASE_PLAN)

    const before = persisted(world, activityId)
    assert.throws(
      () =>
        updateActivity(world.db, world.operator, activityId, {
          expectedUpdatedAt: currentUpdatedAt(world, activityId),
          keyRules: {
            ...BASE_RULES,
            purchaseRewardPlan: { ...PURCHASE_PLAN, couponFaceValueCents: 9_999 },
          },
        }),
      (error: unknown) =>
        error instanceof ActivityError &&
        error.status === 409 &&
        error.code === API_ERROR_CODES.purchaseRewardPlanLocked,
      'a published purchase plan must be immutable',
    )

    const after = persisted(world, activityId)
    assert.equal(after.column, before.column)
    assert.equal(after.versionCount, before.versionCount, 'a rejected edit must not mint a version')
    assert.deepEqual(after.newestSnapshot?.purchaseRewardPlan, PURCHASE_PLAN)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a paused activity is frozen too, and resending the same plan stays allowed', () => {
  const world = createWorld()
  try {
    const activityId = createDraft(world)
    transitionActivity(world.db, world.operator, activityId, 'publish', currentUpdatedAt(world, activityId))
    transitionActivity(world.db, world.operator, activityId, 'pause', currentUpdatedAt(world, activityId))

    assert.throws(
      () =>
        updateActivity(world.db, world.operator, activityId, {
          expectedUpdatedAt: currentUpdatedAt(world, activityId),
          keyRules: { ...BASE_RULES, purchaseRewardPlan: { ...PURCHASE_PLAN, maxRewardedTeams: 49 } },
        }),
      (error: unknown) =>
        error instanceof ActivityError &&
        error.code === API_ERROR_CODES.purchaseRewardPlanLocked,
    )

    // The realistic "operator re-submits the whole form" case is not blocked.
    const resent = updateActivity(world.db, world.operator, activityId, {
      expectedUpdatedAt: currentUpdatedAt(world, activityId),
      keyRules: { ...BASE_RULES, location: '新地点' },
    })
    assert.equal(resent.location, '新地点')
    assert.deepEqual(newestSnapshot(world, activityId).purchaseRewardPlan, PURCHASE_PLAN)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a published purchase plan cannot be cleared', () => {
  const world = createWorld()
  try {
    const activityId = createDraft(world)
    transitionActivity(world.db, world.operator, activityId, 'publish', currentUpdatedAt(world, activityId))
    const before = persisted(world, activityId)

    assert.throws(
      () =>
        updateActivity(world.db, world.operator, activityId, {
          expectedUpdatedAt: currentUpdatedAt(world, activityId),
          keyRules: { ...rulesWithoutPlans(), purchaseRewardPlan: null },
        }),
      (error: unknown) =>
        error instanceof ActivityError &&
        error.code === API_ERROR_CODES.purchaseRewardPlanLocked,
    )

    const after = persisted(world, activityId)
    assert.equal(after.column, before.column)
    assert.equal(after.versionCount, before.versionCount)
    assert.deepEqual(after.newestSnapshot?.purchaseRewardPlan, PURCHASE_PLAN)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Compatibility                                                              */
/* -------------------------------------------------------------------------- */

test('an activity without a purchase plan publishes and keeps the old snapshot shape', () => {
  const world = createWorld()
  try {
    // Pre-#206 shape: the check-in reward plan exists, the purchase plan does not.
    const activityId = createDraft(world, rulesWithoutPurchasePlan())
    const published = transitionActivity(
      world.db,
      world.operator,
      activityId,
      'publish',
      currentUpdatedAt(world, activityId),
    )
    assert.equal(published.status, 'published')
    assert.equal(published.purchaseRewardPlan, null)
    assert.equal(published.rewardPlan?.prizeName, CHECKIN_PLAN.prizeName)

    const snapshot = newestSnapshot(world, activityId)
    assert.equal(
      'purchaseRewardPlan' in snapshot,
      false,
      'a plan-free snapshot must not gain the new key',
    )
    assert.deepEqual(snapshot.rewardPlan, CHECKIN_PLAN)

    // The existing check-in reward module still sees its frozen plan.
    const overview = getAdminRewardOverview(world.db, world.operator, activityId)
    assert.equal(overview.planConfigured, true)
    assert.equal(overview.planSource, 'rule_version_snapshot')

    // No plan is exposed to residents as a fake zero-value rule.
    const publicDetail = getPublicActivity(world.db, activityId)
    assert.equal(publicDetail.purchaseReward, null)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a legacy snapshot without the purchase plan is still readable', () => {
  const world = createWorld()
  try {
    // Insert a snapshot exactly as it could have been frozen before #206.
    const activityId = randomUUID()
    const ruleVersionId = randomUUID()
    const legacySnapshot = JSON.stringify(rulesWithoutPurchasePlan())
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
           purchase_reward_plan_json, current_rule_version_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        activityId,
        world.communityId,
        '历史活动',
        'published',
        new Date(BASE_RULES.startsAt).getTime(),
        new Date(BASE_RULES.endsAt).getTime(),
        BASE_RULES.location,
        BASE_RULES.budgetCapCents,
        BASE_RULES.prizeQuantityCap,
        JSON.stringify(BASE_RULES.publicRules),
        JSON.stringify(CHECKIN_PLAN),
        null,
        ruleVersionId,
        world.operator.userId,
        OPEN.getTime(),
        OPEN.getTime(),
      )

    const versions = listActivityRuleVersions(world.db, world.operator, activityId)
    assert.equal(versions.items.length, 1)
    assert.equal('purchaseRewardPlan' in versions.items[0]!.snapshot, false)
    assert.equal(
      activityKeyRulesSchema.parse(versions.items[0]!.snapshot).purchaseRewardPlan,
      undefined,
    )

    const detail = getAdminActivity(world.db, world.operator, activityId)
    assert.equal(detail.purchaseRewardPlan, null)

    // A normal venue edit must not invent or drop anything.
    const updated = updateActivity(world.db, world.operator, activityId, {
      expectedUpdatedAt: detail.updatedAt,
      keyRules: rulesWithoutPlans({ location: '历史活动新地点' }),
    })
    assert.equal(updated.purchaseRewardPlan, null)
    assert.equal('purchaseRewardPlan' in newestSnapshot(world, activityId), false)
    assert.deepEqual(newestSnapshot(world, activityId).rewardPlan, CHECKIN_PLAN)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a purchase plan can coexist with the frozen check-in reward plan', () => {
  const world = createWorld()
  try {
    const activityId = createDraft(world)
    transitionActivity(world.db, world.operator, activityId, 'publish', currentUpdatedAt(world, activityId))
    const snapshot = newestSnapshot(world, activityId)
    assert.deepEqual(snapshot.rewardPlan, CHECKIN_PLAN, 'the check-in plan is untouched')
    assert.deepEqual(snapshot.purchaseRewardPlan, PURCHASE_PLAN)

    // Both frozen copies survive an ordinary post-publication edit.
    updateActivity(world.db, world.operator, activityId, {
      expectedUpdatedAt: currentUpdatedAt(world, activityId),
      keyRules: rulesWithoutPlans({ location: '后发布改地点' }),
    })
    const after = newestSnapshot(world, activityId)
    assert.deepEqual(after.rewardPlan, CHECKIN_PLAN)
    assert.deepEqual(after.purchaseRewardPlan, PURCHASE_PLAN)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Invalid writes and permissions                                             */
/* -------------------------------------------------------------------------- */

test('invalid purchase plans are rejected before any row or version is written', () => {
  const world = createWorld()
  try {
    const invalidBudgetPlan: PurchaseRewardPlan = {
      thresholdCents: 50_000,
      couponFaceValueCents: 1_000_000,
      maxRewardedTeams: 40,
    }
    assert.throws(
      () => createDraft(world, { ...BASE_RULES, purchaseRewardPlan: invalidBudgetPlan }),
      (error: unknown) => {
        const issues = (error as { issues?: Array<{ path: (string | number)[] }> }).issues
        return Array.isArray(issues) &&
          issues.some((issue) => issue.path.join('.') === 'purchaseRewardPlan.maxRewardedTeams')
      },
    )
    assert.equal(world.db.select().from(activities).all().length, 0)

    const draftId = createDraft(world)
    const before = persisted(world, draftId)
    assert.throws(
      () =>
        updateActivity(world.db, world.operator, draftId, {
          expectedUpdatedAt: currentUpdatedAt(world, draftId),
          keyRules: { ...BASE_RULES, purchaseRewardPlan: { ...PURCHASE_PLAN, thresholdCents: 0 } },
        }),
      (error: unknown) => {
        const issues = (error as { issues?: Array<{ path: (string | number)[] }> }).issues
        return Array.isArray(issues) &&
          issues.some((issue) => issue.path.join('.') === 'purchaseRewardPlan.thresholdCents')
      },
    )
    const after = persisted(world, draftId)
    assert.equal(after.column, before.column)
    assert.equal(after.versionCount, before.versionCount)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('an operator outside the community cannot edit the purchase plan', () => {
  const world = createWorld()
  try {
    const activityId = createDraft(world)
    const before = persisted(world, activityId)
    assert.throws(
      () =>
        updateActivity(world.db, world.outsider, activityId, {
          expectedUpdatedAt: currentUpdatedAt(world, activityId),
          keyRules: {
            ...BASE_RULES,
            purchaseRewardPlan: { ...PURCHASE_PLAN, thresholdCents: 1 },
          },
        }),
      (error: unknown) =>
        error instanceof ActivityError &&
        error.status === 403 &&
        error.code === API_ERROR_CODES.forbidden,
    )
    assert.equal(persisted(world, activityId).column, before.column)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Real Hono API: public projection and freeze envelope                       */
/* -------------------------------------------------------------------------- */

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
}

function cookiePairs(response: Response): string[] {
  const value = response.headers.get('set-cookie') ?? ''
  return value
    .split(/,(?=[^;,]+=)/)
    .map((part) => part.split(';', 1)[0]?.trim() ?? '')
    .filter(Boolean)
}

function cookiePair(response: Response, name: string): string {
  const pair = cookiePairs(response).find((value) => value.startsWith(`${name}=`))
  assert.ok(pair, `expected ${name} cookie`)
  return pair
}

async function staffSession(app: App, username: string, password: string): Promise<Session> {
  const csrfResponse = await app.request('/auth/csrf')
  const csrfToken = ((await csrfResponse.json()) as { csrfToken: string }).csrfToken
  const csrfCookie = cookiePair(csrfResponse, 'll_csrf')

  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: csrfCookie,
      'x-csrf-token': csrfToken,
      origin: 'http://localhost:5174',
    },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(response.status, 200, `${username} should be able to log in`)
  const body = (await response.json()) as { csrfToken: string }
  return {
    cookies: `${cookiePair(response, 'll_session')}; ${cookiePair(response, 'll_csrf')}`,
    csrfToken: body.csrfToken,
  }
}

function api(
  app: App,
  method: string,
  path: string,
  options: { session?: Session; body?: unknown } = {},
) {
  const headers: Record<string, string> = {}
  if (options.session) {
    headers.cookie = options.session.cookies
    if (method !== 'GET') {
      headers['x-csrf-token'] = options.session.csrfToken
      headers.origin = 'http://localhost:5174'
    }
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

test('the public API exposes only the threshold and coupon face value', async () => {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  try {
    const now = new Date()
    const userId = randomUUID()
    db.insert(users)
      .values({ id: userId, displayName: '系统管理员', createdAt: now, updatedAt: now })
      .run()
    db.insert(staffAccounts)
      .values({
        id: randomUUID(),
        userId,
        username: 'admin',
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        role: 'admin',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const communityId = randomUUID()
    db.insert(communities).values({ id: communityId, name: '公开投影社区', createdAt: now }).run()

    const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
    const app = createApp({ db, config, logRequests: false })
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)

    const payload: CreateActivityRequest = {
      communityId,
      title: '消费券公开门槛',
      keyRules: BASE_RULES,
    }
    const createdResponse = await api(app, 'POST', '/admin/activities', {
      session: admin,
      body: payload,
    })
    assert.equal(createdResponse.status, 201)
    const created = (await createdResponse.json()) as AdminActivityDetail
    assert.deepEqual(created.purchaseRewardPlan, PURCHASE_PLAN)

    const updateResponse = await api(app, 'PATCH', `/admin/activities/${created.id}`, {
      session: admin,
      body: {
        expectedUpdatedAt: created.updatedAt,
        keyRules: {
          ...BASE_RULES,
          purchaseRewardPlan: { ...PURCHASE_PLAN, thresholdCents: 25_000 },
        },
      },
    })
    assert.equal(updateResponse.status, 200)
    const updated = (await updateResponse.json()) as AdminActivityDetail
    assert.equal(updated.purchaseRewardPlan?.thresholdCents, 25_000)

    const publishResponse = await api(app, 'POST', `/admin/activities/${created.id}/publish`, {
      session: admin,
      body: { expectedUpdatedAt: updated.updatedAt },
    })
    assert.equal(publishResponse.status, 200)
    const published = (await publishResponse.json()) as AdminActivityDetail
    assert.equal(published.purchaseRewardPlan?.thresholdCents, 25_000)

    // Residents get the threshold and face value, never the internal quota.
    const publicResponse = await app.request(`/activities/public/${created.id}`)
    assert.equal(publicResponse.status, 200)
    const publicBody = (await publicResponse.json()) as PublicActivityDetail
    assert.deepEqual(publicBody.purchaseReward, {
      thresholdCents: 25_000,
      couponFaceValueCents: PURCHASE_PLAN.couponFaceValueCents,
    })
    assert.equal('maxRewardedTeams' in publicBody.purchaseReward!, false)
    assert.equal(
      JSON.stringify(publicBody).includes('maxRewardedTeams'),
      false,
      'the internal budget control must not leak to residents',
    )

    // Changing the frozen plan returns the standard error envelope.
    const rejected = await api(app, 'PATCH', `/admin/activities/${created.id}`, {
      session: admin,
      body: {
        expectedUpdatedAt: published.updatedAt,
        keyRules: {
          ...BASE_RULES,
          purchaseRewardPlan: { ...PURCHASE_PLAN, maxRewardedTeams: 1 },
        },
      },
    })
    assert.equal(rejected.status, 409)
    const envelope = (await rejected.json()) as { error: { code: string; message: string } }
    assert.equal(envelope.error.code, API_ERROR_CODES.purchaseRewardPlanLocked)

    // An ordinary venue edit still works and keeps the public projection.
    const edited = await api(app, 'PATCH', `/admin/activities/${created.id}`, {
      session: admin,
      body: {
        expectedUpdatedAt: published.updatedAt,
        keyRules: rulesWithoutPlans({ location: '新场地' }),
      },
    })
    assert.equal(edited.status, 200)
    const afterEditResponse = await app.request(`/activities/public/${created.id}`)
    const afterEdit = (await afterEditResponse.json()) as PublicActivityDetail
    assert.equal(afterEdit.location, '新场地')
    assert.deepEqual(afterEdit.purchaseReward, {
      thresholdCents: 25_000,
      couponFaceValueCents: PURCHASE_PLAN.couponFaceValueCents,
    })

    // Invalid input is refused with the shared envelope, not a 500.
    const invalid = await api(app, 'POST', '/admin/activities', {
      session: admin,
      body: {
        ...payload,
        keyRules: {
          ...BASE_RULES,
          purchaseRewardPlan: { ...PURCHASE_PLAN, thresholdCents: 0 },
        },
      },
    })
    assert.equal(invalid.status, 400)
    assert.equal(
      ((await invalid.json()) as { error: { code: string } }).error.code,
      API_ERROR_CODES.invalidRequest,
    )

    // The persisted frozen snapshot carries the full plan.
    const versionRows = db
      .select({ snapshotJson: activityRuleVersions.snapshotJson })
      .from(activityRuleVersions)
      .where(eq(activityRuleVersions.activityId, created.id))
      .all()
    assert.ok(versionRows.length > 0)
    for (const row of versionRows) {
      assert.ok(row.snapshotJson.includes('maxRewardedTeams'))
      assert.equal(activityKeyRulesSchema.parse(JSON.parse(row.snapshotJson)).purchaseRewardPlan?.thresholdCents, 25_000)
    }
  } finally {
    sqlite.close()
  }
})
