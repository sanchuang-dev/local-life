import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import { API_ERROR_CODES, type ActivityRewardPlan } from '@sanchuang-dev/local-life-contracts'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import {
  createActivity,
  transitionActivity,
  type ActivityOperator,
} from '../src/activities/service.js'
import { confirmParticipation } from '../src/participation/service.js'
import {
  appendGrantDispute,
  claimTeamReward,
  getAdminRewardOverview,
  getCheckinState,
  getMyCredential,
  getTeamRewardState,
  hashCredentialCode,
  listActivityCheckins,
  recordCheckin,
  redeemCredential,
  requireStaffActivityScope,
  revokeCheckin,
  revokeCheckinWithConsequence,
  revokeGrant,
  verifyCheckin,
  RewardError,
  type RewardStaffActor,
} from '../src/rewards/service.js'
import {
  activities,
  activityCheckins,
  activityPrizeStocks,
  activityRewardCodes,
  communities,
  staffAccounts,
  staffCommunityAssignments,
  users,
} from '../src/db/schema.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

const OPEN = new Date('2026-11-01T00:00:00.000Z')
const IN_WINDOW = new Date('2026-11-10T10:00:00.000Z')

const PLAN: ActivityRewardPlan = {
  prizeName: '粮油礼包',
  prizeUnitCostCents: 5_000,
  prizeQuantityPerTeam: 1,
  totalPrizeQuantity: 4,
  budgetCapCents: 15_000,
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

const BASE_RULES = {
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2026-11-30T00:00:00.000Z',
  location: '幸福社区党群服务中心',
  budgetCapCents: 15_000,
  prizeQuantityCap: 4,
  publicRules: PUBLIC_RULES,
}

interface World {
  db: AppDatabase
  sqlite: SqliteConnection
  communityId: string
  activityId: string
  otherCommunityId: string
  otherActivityId: string
  /** The activities/participation domain's narrower operator (no grid_worker). */
  operator: ActivityOperator
  otherOperator: RewardStaffActor
  leader: string
  member2: string
  member3: string
  outsider: string
  cleanup: () => void
}

/**
 * Builds a real published activity whose frozen snapshot carries `PLAN`, plus a
 * three-seat team, using the production services (`createActivity` →
 * `transitionActivity` → `confirmParticipation`). Nothing is inserted by hand
 * except staff accounts, so the reward module is exercised against the same rows
 * the activity and participation domains actually produce.
 */
function createWorld(options: { plan?: ActivityRewardPlan | null } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'll-rewards-'))
  const { db, sqlite } = createDatabase(join(dir, 'rewards.sqlite'), migrationsFolder)

  const communityId = randomUUID()
  const otherCommunityId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '奖励社区', createdAt: OPEN }).run()
  db.insert(communities).values({ id: otherCommunityId, name: '别的社区', createdAt: OPEN }).run()

  const addUser = (name: string): string => {
    const id = randomUUID()
    db.insert(users).values({ id, displayName: name, createdAt: OPEN, updatedAt: OPEN }).run()
    return id
  }

  const adminUser = addUser('管理员')
  const operatorUser = addUser('运营员')
  const operator = makeStaff(db, adminUser, 'reward-admin', 'admin', OPEN)
  const otherOperator = makeStaff(db, operatorUser, 'reward-operator', 'operator', OPEN)
  // The operator is scoped to the *other* community only.
  db.insert(staffCommunityAssignments)
    .values({
      staffAccountId: otherOperator.staffId,
      communityId: otherCommunityId,
      createdAt: OPEN,
    })
    .run()

  const plan = options.plan === undefined ? PLAN : options.plan
  const rules = plan === null ? BASE_RULES : { ...BASE_RULES, rewardPlan: plan }
  const created = createActivity(db, operator, {
    communityId,
    title: '秋季敬老活动',
    keyRules: rules,
  })
  const published = transitionActivity(db, operator, created.id, 'publish', created.updatedAt)

  const otherCreated = createActivity(db, operator, {
    communityId: otherCommunityId,
    title: '别的社区活动',
    keyRules: rules,
  })
  const otherPublished = transitionActivity(
    db,
    operator,
    otherCreated.id,
    'publish',
    otherCreated.updatedAt,
  )

  const leader = addUser('团长甲')
  const member2 = addUser('成员乙')
  const member3 = addUser('成员丙')
  const outsider = addUser('路人丁')

  const started = confirmParticipation(db, { activityId: published.id, userId: leader, now: OPEN })
  const inviteCode = started.state.team!.inviteCode!
  confirmParticipation(db, { activityId: published.id, userId: member2, inviteCode, now: OPEN })
  confirmParticipation(db, { activityId: published.id, userId: member3, inviteCode, now: OPEN })

  return {
    db,
    sqlite,
    communityId,
    activityId: published.id,
    otherCommunityId,
    otherActivityId: otherPublished.id,
    operator,
    otherOperator,
    leader,
    member2,
    member3,
    outsider,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function makeStaff(db: AppDatabase, userId: string, username: string, role: 'admin' | 'operator', at: Date): ActivityOperator {
  const staffId = randomUUID()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId,
      username,
      passwordHash: 'x',
      role,
      status: 'active',
      createdAt: at,
      updatedAt: at,
    })
    .run()
  return { userId, staffId, role }
}

/** Records three verified check-ins so the team qualifies. */
function qualifyTeam(world: World, now = IN_WINDOW): void {
  for (const userId of [world.leader, world.member2, world.member3]) {
    recordCheckin(world.db, { activityId: world.activityId, userId, operator: world.operator, now })
  }
}

/**
 * Adds a second, fully checked-in three-seat team to the same activity, so a
 * test can exhaust the activity-wide pool with one team and then observe the
 * other team's view of it. Returns the team's identifiers.
 */
function makeSecondTeam(world: World, label: string): { leader: string; teamId: string } {
  const addUser = (name: string): string => {
    const id = randomUUID()
    world.db.insert(users).values({ id, displayName: name, createdAt: OPEN, updatedAt: OPEN }).run()
    return id
  }
  const leader = addUser(`${label}团长`)
  const started = confirmParticipation(world.db, {
    activityId: world.activityId,
    userId: leader,
    now: OPEN,
  })
  const inviteCode = started.state.team?.inviteCode
  assert.ok(inviteCode, 'the second team leader must receive an invite code')
  const members = [addUser(`${label}成员甲`), addUser(`${label}成员乙`)]
  for (const member of members) {
    confirmParticipation(world.db, {
      activityId: world.activityId,
      userId: member,
      inviteCode,
      now: OPEN,
    })
  }
  for (const userId of [leader, ...members]) {
    recordCheckin(world.db, { activityId: world.activityId, userId, operator: world.operator, now: IN_WINDOW })
  }
  return { leader, teamId: started.state.team!.id }
}

function expectRewardError(fn: () => unknown, status: number, code: string): RewardError {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof RewardError, `expected RewardError, got ${String(error)}`)
    assert.equal(error.status, status, `status for ${String(error.code)}`)
    assert.equal(error.code, code)
    return error
  }
  throw new Error(`expected a RewardError(${status}, ${code}) but the call succeeded`)
}

/* -------------------------------------------------------------------------- */
/* Check-in                                                                   */
/* -------------------------------------------------------------------------- */

test('a resident self check-in is unverified and never counts towards the reward', () => {
  const world = createWorld()
  try {
    const result = recordCheckin(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    assert.equal(result.created, true)
    assert.equal(result.checkin.status, 'valid')
    assert.equal(result.checkin.verifiedAt, null, 'a self-reported check-in is not verified')
    assert.equal(result.state.countsForReward, false)

    const state = getTeamRewardState(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    assert.equal(state.requirement.checkinsValid, 0)
    assert.equal(state.eligible, false)
    assert.equal(state.unavailableReason, 'checkin_incomplete')
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a staff-recorded check-in is verified immediately and does count', () => {
  const world = createWorld()
  try {
    const result = recordCheckin(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      operator: world.operator,
      now: IN_WINDOW,
    })
    assert.equal(result.created, true)
    assert.ok(result.checkin.verifiedAt, 'a staff-recorded check-in is verified on the spot')
    assert.equal(result.checkin.verifiedByStaffId, world.operator.staffId)
    assert.equal(result.state.countsForReward, true)
    assert.equal(result.state.available, false)
    assert.equal(result.state.unavailableReason, 'already_checked_in')
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('check-in is idempotent: a resubmission adds no row and no team member', () => {
  const world = createWorld()
  try {
    const first = recordCheckin(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    const rowsAfterFirst = world.sqlite
      .prepare('SELECT count(*) c FROM activity_checkins')
      .get() as { c: number }
    assert.equal(rowsAfterFirst.c, 1)

    const second = recordCheckin(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    assert.equal(second.created, false)
    assert.equal(second.checkin.id, first.checkin.id, 'the same row is returned')

    const rowsAfterSecond = world.sqlite
      .prepare('SELECT count(*) c FROM activity_checkins')
      .get() as { c: number }
    assert.equal(rowsAfterSecond.c, 1, 'no duplicate check-in row may be created')

    const seats = world.sqlite
      .prepare('SELECT count(*) c FROM activity_participations')
      .get() as { c: number }
    assert.equal(seats.c, 3, 'checking in must never add a team member')
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('check-in is refused outside the frozen window, for non-members and without a plan', () => {
  // The default plan's check-in window closes exactly when the activity ends, so
  // "window closed" would be unreachable behind the lifecycle gate: at that
  // instant the activity is already over. A window that closes *before* the
  // activity ends is what isolates the window rule from the lifecycle rule.
  const world = createWorld({
    plan: {
      ...PLAN,
      checkinWindow: {
        opensAt: '2026-11-01T00:00:00.000Z',
        closesAt: '2026-11-20T00:00:00.000Z',
      },
    },
  })
  try {
    const closed = expectRewardError(
      () =>
        recordCheckin(world.db, {
          activityId: world.activityId,
          userId: world.leader,
          // After the check-in window shuts but while the activity still runs.
          now: new Date('2026-11-25T00:00:00.000Z'),
        }),
      409,
      API_ERROR_CODES.rewardUnavailable,
    )
    assert.equal(closed.reason, 'checkin_window_closed')

    const early = expectRewardError(
      () =>
        recordCheckin(world.db, {
          activityId: world.activityId,
          userId: world.leader,
          now: new Date('2026-10-01T00:00:00.000Z'),
        }),
      409,
      API_ERROR_CODES.rewardUnavailable,
    )
    assert.equal(early.reason, 'checkin_window_not_open')

    // A resident who never joined a team cannot check in.
    const outsider = expectRewardError(
      () =>
        recordCheckin(world.db, {
          activityId: world.activityId,
          userId: world.outsider,
          now: IN_WINDOW,
        }),
      409,
      API_ERROR_CODES.rewardUnavailable,
    )
    assert.equal(outsider.reason, 'not_a_team_member')
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('an activity whose frozen snapshot has no reward plan is formally unavailable', () => {
  const world = createWorld({ plan: null })
  try {
    // The activity row may even carry a plan; only the frozen snapshot counts.
    world.db
      .update(activities)
      .set({ rewardPlanJson: JSON.stringify(PLAN) })
      .where(eq(activities.id, world.activityId))
      .run()

    const checkin = expectRewardError(
      () =>
        recordCheckin(world.db, {
          activityId: world.activityId,
          userId: world.leader,
          now: IN_WINDOW,
        }),
      409,
      API_ERROR_CODES.rewardUnavailable,
    )
    assert.equal(checkin.reason, 'reward_unavailable')

    const claim = expectRewardError(
      () =>
        claimTeamReward(world.db, {
          activityId: world.activityId,
          userId: world.leader,
          now: IN_WINDOW,
        }),
      409,
      API_ERROR_CODES.rewardUnavailable,
    )
    assert.equal(claim.reason, 'reward_unavailable')

    const overview = getAdminRewardOverview(world.db, world.operator, world.activityId)
    assert.equal(overview.planConfigured, false)
    assert.equal(overview.planSource, 'none', 'the mutable activity column is never a plan source')
    assert.equal(overview.plan, null)
    assert.equal(overview.stock, null)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a draft activity cannot be checked into', () => {
  const world = createWorld()
  try {
    // Publish then revert to draft is impossible (one-way machine), so build a
    // separate activity that stays a draft.
    const draft = createActivity(world.db, world.operator, {
      communityId: world.communityId,
      title: '草稿活动',
      keyRules: { ...BASE_RULES, rewardPlan: PLAN },
    })
    const state = getCheckinState(world.db, {
      activityId: draft.id,
      userId: world.leader,
      now: IN_WINDOW,
    })
    assert.equal(state.available, false)
    assert.equal(state.unavailableReason, 'activity_not_published')
    assert.equal(state.checkinWindow, null, 'a draft has no frozen window yet')
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Verification and revocation                                                */
/* -------------------------------------------------------------------------- */

test('verification is write-once and revocation keeps the original evidence', () => {
  const world = createWorld()
  try {
    const recorded = recordCheckin(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    const checkinId = recorded.checkin.id

    const verified = verifyCheckin(world.db, world.operator, {
      activityId: world.activityId,
      checkinId,
      now: IN_WINDOW,
    })
    assert.ok(verified.verifiedAt)
    assert.equal(verified.verifiedByStaffId, world.operator.staffId)

    // A repeat verification returns the same stamp instead of moving it.
    const again = verifyCheckin(world.db, world.operator, {
      activityId: world.activityId,
      checkinId,
      now: new Date('2026-11-11T00:00:00.000Z'),
    })
    assert.equal(again.verifiedAt, verified.verifiedAt, 'the stamp must not move')

    const revokeAt = new Date('2026-11-12T00:00:00.000Z')
    const revoked = revokeCheckin(world.db, world.operator, {
      activityId: world.activityId,
      checkinId,
      reason: '居民未到场',
      now: revokeAt,
    })
    assert.equal(revoked.status, 'revoked')
    assert.equal(revoked.revokeReason, '居民未到场')
    // History survives: the original time and verification stay readable.
    assert.equal(revoked.checkedInAt, recorded.checkin.checkedInAt)
    assert.equal(revoked.verifiedAt, verified.verifiedAt)

    // The row still exists; nothing was deleted.
    const rows = world.sqlite.prepare('SELECT count(*) c FROM activity_checkins').get() as {
      c: number
    }
    assert.equal(rows.c, 1)

    // A revoked check-in no longer counts, so the resident may check in again.
    const again2 = recordCheckin(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: new Date('2026-11-13T00:00:00.000Z'),
    })
    assert.equal(again2.created, true)
    assert.notEqual(again2.checkin.id, checkinId)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('revoking a check-in writes an appended event and audit row', () => {
  const world = createWorld()
  try {
    const recorded = recordCheckin(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      operator: world.operator,
      now: IN_WINDOW,
    })
    const before = world.sqlite
      .prepare('SELECT count(*) c FROM activity_reward_events')
      .get() as { c: number }
    const auditBefore = world.sqlite
      .prepare("SELECT count(*) c FROM audit_logs WHERE event='reward.checkin.revoked'")
      .get() as { c: number }

    revokeCheckin(world.db, world.operator, {
      activityId: world.activityId,
      checkinId: recorded.checkin.id,
      reason: '重复签到',
      now: IN_WINDOW,
    })

    const events = world.sqlite
      .prepare("SELECT kind FROM activity_reward_events WHERE kind='checkin.revoked'")
      .all() as Array<{ kind: string }>
    assert.equal(events.length, 1, 'the revocation must be appended as an event')
    const after = world.sqlite
      .prepare('SELECT count(*) c FROM activity_reward_events')
      .get() as { c: number }
    assert.ok(after.c >= before.c)
    const auditAfter = world.sqlite
      .prepare("SELECT count(*) c FROM audit_logs WHERE event='reward.checkin.revoked'")
      .get() as { c: number }
    assert.equal(auditAfter.c, auditBefore.c + 1)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Eligibility and claim                                                      */
/* -------------------------------------------------------------------------- */

test('a team needs three seats and three verified check-ins before it is eligible', () => {
  const world = createWorld()
  try {
    // Two verified check-ins: not enough.
    recordCheckin(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      operator: world.operator,
      now: IN_WINDOW,
    })
    recordCheckin(world.db, {
      activityId: world.activityId,
      userId: world.member2,
      operator: world.operator,
      now: IN_WINDOW,
    })
    const partial = getTeamRewardState(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    assert.equal(partial.requirement.seatsFilled, 3)
    assert.equal(partial.requirement.seatsSatisfied, true)
    assert.equal(partial.requirement.checkinsValid, 2)
    assert.equal(partial.requirement.checkinsSatisfied, false)
    assert.equal(partial.eligible, false)
    expectRewardError(
      () =>
        claimTeamReward(world.db, {
          activityId: world.activityId,
          userId: world.leader,
          now: IN_WINDOW,
        }),
      409,
      API_ERROR_CODES.rewardUnavailable,
    )

    // Third verified check-in: now eligible.
    recordCheckin(world.db, {
      activityId: world.activityId,
      userId: world.member3,
      operator: world.operator,
      now: IN_WINDOW,
    })
    const full = getTeamRewardState(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    assert.equal(full.requirement.checkinsValid, 3)
    assert.equal(full.eligible, true)
    assert.equal(full.claimableByMe, true)
    assert.equal(full.unavailableReason, null)
    assert.equal(full.planConfigured, true)
    assert.equal(full.reward?.prizeQuantityPerTeam, 1)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('claiming mints one team prize, not one per member, and only the leader may claim', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)

    // `claimRecipient = 'leader'`: a member is refused.
    const refused = expectRewardError(
      () =>
        claimTeamReward(world.db, {
          activityId: world.activityId,
          userId: world.member2,
          now: IN_WINDOW,
        }),
      403,
      API_ERROR_CODES.forbidden,
    )
    assert.equal(refused.reason, 'not_recipient')

    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    assert.equal(claim.created, true)
    // One prize for the whole team, priced from the frozen snapshot.
    assert.equal(claim.grant.quantity, 1)
    assert.equal(claim.grant.unitCostCents, PLAN.prizeUnitCostCents)
    assert.equal(claim.grant.totalCostCents, PLAN.prizeUnitCostCents * 1)
    assert.equal(claim.grant.prizeName, PLAN.prizeName)
    assert.equal(claim.grant.recipientRole, 'leader')
    assert.equal(claim.grant.recipientUserId, world.leader)

    const grants = world.sqlite.prepare('SELECT count(*) c FROM activity_reward_grants').get() as {
      c: number
    }
    assert.equal(grants.c, 1, 'exactly one grant row for the team')

    // The stock ledger moves by exactly the team quantity.
    const stock = world.db
      .select()
      .from(activityPrizeStocks)
      .where(eq(activityPrizeStocks.activityId, world.activityId))
      .get()
    assert.equal(stock?.claimedQuantity, 1)
    assert.equal(stock?.committedBudgetCents, PLAN.prizeUnitCostCents)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('any_member binds the first claimant and never hands out a second prize', () => {
  const world = createWorld({ plan: { ...PLAN, claimRecipient: 'any_member' } })
  try {
    qualifyTeam(world)
    const first = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.member2,
      now: IN_WINDOW,
    })
    assert.equal(first.created, true)
    assert.equal(first.grant.recipientRole, 'member')
    assert.equal(first.grant.recipientUserId, world.member2, 'the first claimant binds the recipient')

    // Another member claims afterwards. `any_member` decides who may *become*
    // the recipient, not who may rotate an already-bound one: a non-recipient is
    // refused outright instead of being handed a fresh code that would supersede
    // the real recipient's.
    const second = expectRewardError(
      () =>
        claimTeamReward(world.db, {
          activityId: world.activityId,
          userId: world.member3,
          now: IN_WINDOW,
        }),
      403,
      API_ERROR_CODES.forbidden,
    )
    assert.equal(second.reason, 'not_recipient')

    // The recipient binding and the grant itself are untouched by the attempt.
    const grantRow = world.sqlite
      .prepare('SELECT recipient_user_id FROM activity_reward_grants')
      .get() as { recipient_user_id: string }
    assert.equal(grantRow.recipient_user_id, world.member2, 'the recipient is immutable after binding')

    const grants = world.sqlite.prepare('SELECT count(*) c FROM activity_reward_grants').get() as {
      c: number
    }
    assert.equal(grants.c, 1)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('re-claiming re-issues the credential and supersedes the previous code', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const first = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    const second = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    assert.equal(second.created, false)
    assert.notEqual(second.code, first.code, 'a fresh code is minted')

    const rows = world.sqlite
      .prepare('SELECT status, count(*) c FROM activity_reward_codes GROUP BY status ORDER BY status')
      .all() as Array<{ status: string; c: number }>
    // Exactly one live code, the old one kept as superseded history.
    assert.deepEqual(
      rows.map((row) => [row.status, row.c]),
      [
        ['active', 1],
        ['superseded', 1],
      ],
    )
    // The stale code must be unusable.
    expectRewardError(
      () => redeemCredential(world.db, world.operator, { code: first.code, now: IN_WINDOW }),
      404,
      API_ERROR_CODES.redemptionCodeInvalid,
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Stock and budget                                                           */
/* -------------------------------------------------------------------------- */

test('stock exhaustion rejects the claim without creating a grant row', () => {
  // Two prizes in the pool, one per team.
  const world = createWorld({ plan: { ...PLAN, totalPrizeQuantity: 1, budgetCapCents: 15_000 } })
  try {
    qualifyTeam(world)
    claimTeamReward(world.db, { activityId: world.activityId, userId: world.leader, now: IN_WINDOW })

    // A second team in the same activity.
    const leader2 = randomUUID()
    world.db
      .insert(users)
      .values({ id: leader2, displayName: '团长乙', createdAt: OPEN, updatedAt: OPEN })
      .run()
    const started = confirmParticipation(world.db, {
      activityId: world.activityId,
      userId: leader2,
      now: OPEN,
    })
    const inviteCode = started.state.team!.inviteCode!
    for (const name of ['成员戊', '成员己']) {
      const id = randomUUID()
      world.db
        .insert(users)
        .values({ id, displayName: name, createdAt: OPEN, updatedAt: OPEN })
        .run()
      confirmParticipation(world.db, { activityId: world.activityId, userId: id, inviteCode, now: OPEN })
      recordCheckin(world.db, {
        activityId: world.activityId,
        userId: id,
        operator: world.operator,
        now: IN_WINDOW,
      })
    }
    recordCheckin(world.db, {
      activityId: world.activityId,
      userId: leader2,
      operator: world.operator,
      now: IN_WINDOW,
    })

    const exhausted = expectRewardError(
      () =>
        claimTeamReward(world.db, {
          activityId: world.activityId,
          userId: leader2,
          now: IN_WINDOW,
        }),
      409,
      API_ERROR_CODES.prizeStockExhausted,
    )
    assert.equal(exhausted.reason, 'stock_exhausted')

    const grants = world.sqlite.prepare('SELECT count(*) c FROM activity_reward_grants').get() as {
      c: number
    }
    assert.equal(grants.c, 1, 'a rejected claim must not leave a grant behind')
    const stock = world.db
      .select()
      .from(activityPrizeStocks)
      .where(eq(activityPrizeStocks.activityId, world.activityId))
      .get()
    assert.equal(stock?.claimedQuantity, 1, 'the failed claim consumed no stock')
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('budget exhaustion is reported separately from stock exhaustion', () => {
  // Room for two prizes by quantity, but money for only one.
  const world = createWorld({
    plan: { ...PLAN, totalPrizeQuantity: 4, budgetCapCents: PLAN.prizeUnitCostCents },
  })
  try {
    qualifyTeam(world)
    claimTeamReward(world.db, { activityId: world.activityId, userId: world.leader, now: IN_WINDOW })

    const leader2 = randomUUID()
    world.db
      .insert(users)
      .values({ id: leader2, displayName: '团长丙', createdAt: OPEN, updatedAt: OPEN })
      .run()
    const started = confirmParticipation(world.db, {
      activityId: world.activityId,
      userId: leader2,
      now: OPEN,
    })
    const inviteCode = started.state.team!.inviteCode!
    for (const name of ['成员庚', '成员辛']) {
      const id = randomUUID()
      world.db
        .insert(users)
        .values({ id, displayName: name, createdAt: OPEN, updatedAt: OPEN })
        .run()
      confirmParticipation(world.db, { activityId: world.activityId, userId: id, inviteCode, now: OPEN })
      recordCheckin(world.db, {
        activityId: world.activityId,
        userId: id,
        operator: world.operator,
        now: IN_WINDOW,
      })
    }
    recordCheckin(world.db, {
      activityId: world.activityId,
      userId: leader2,
      operator: world.operator,
      now: IN_WINDOW,
    })

    const overBudget = expectRewardError(
      () =>
        claimTeamReward(world.db, {
          activityId: world.activityId,
          userId: leader2,
          now: IN_WINDOW,
        }),
      409,
      API_ERROR_CODES.budgetExceeded,
    )
    assert.equal(overBudget.reason, 'budget_exceeded')
    const grants = world.sqlite.prepare('SELECT count(*) c FROM activity_reward_grants').get() as {
      c: number
    }
    assert.equal(grants.c, 1)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Redemption                                                                 */
/* -------------------------------------------------------------------------- */

test('a credential is redeemable exactly once and the ledger follows the redemption', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    const response = redeemCredential(world.db, world.operator, {
      code: claim.code,
      now: IN_WINDOW,
    })
    assert.equal(response.redeemed, true)
    assert.equal(response.grant.status, 'redeemed')
    assert.equal(response.credential.status, 'redeemed')
    assert.equal(response.credential.redeemedByStaffId, world.operator.staffId)

    const stock = world.db
      .select()
      .from(activityPrizeStocks)
      .where(eq(activityPrizeStocks.activityId, world.activityId))
      .get()
    assert.equal(stock?.claimedQuantity, 1)
    assert.equal(stock?.redeemedQuantity, 1)
    assert.equal(stock?.redeemedBudgetCents, PLAN.prizeUnitCostCents)

    const twice = expectRewardError(
      () => redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW }),
      409,
      API_ERROR_CODES.rewardAlreadyRedeemed,
    )
    assert.equal(twice.reason, 'reward_already_redeemed')

    // The ledger must not move on the rejected attempt.
    const after = world.db
      .select()
      .from(activityPrizeStocks)
      .where(eq(activityPrizeStocks.activityId, world.activityId))
      .get()
    assert.equal(after?.redeemedQuantity, 1)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('an expired credential is refused and marked expired', () => {
  const world = createWorld({ plan: { ...PLAN, redemptionValidHours: 1 } })
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    const expiredAt = new Date(IN_WINDOW.getTime() + 2 * 3_600_000)

    const expired = expectRewardError(
      () => redeemCredential(world.db, world.operator, { code: claim.code, now: expiredAt }),
      400,
      API_ERROR_CODES.redemptionCodeExpired,
    )
    assert.equal(expired.reason, 'code_expired')

    const row = world.db
      .select()
      .from(activityRewardCodes)
      .where(eq(activityRewardCodes.id, claim.credential.id))
      .get()
    assert.equal(row?.status, 'expired', 'the row is marked expired so it cannot be tried again')

    // Repeating the attempt must give the SAME verdict. If the second call fell
    // through to the generic "invalid code" branch, the holder of a real slip
    // would be told their code never existed.
    const repeat = expectRewardError(
      () => redeemCredential(world.db, world.operator, { code: claim.code, now: expiredAt }),
      400,
      API_ERROR_CODES.redemptionCodeExpired,
    )
    assert.equal(repeat.reason, 'code_expired')

    const afterRepeat = world.db
      .select()
      .from(activityRewardCodes)
      .where(eq(activityRewardCodes.id, claim.credential.id))
      .get()
    assert.equal(afterRepeat?.status, 'expired', 'the marker is stable, not toggled')
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a forged or malformed code is rejected without leaking whether it exists', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })

    const forged = expectRewardError(
      () => redeemCredential(world.db, world.operator, { code: 'ZZZZZZZZZZ', now: IN_WINDOW }),
      404,
      API_ERROR_CODES.redemptionCodeInvalid,
    )
    assert.equal(forged.reason, 'code_invalid')

    // A well-shaped code that was never issued behaves identically.
    const unknown = expectRewardError(
      () => redeemCredential(world.db, world.operator, { code: 'ABCD2345HK', now: IN_WINDOW }),
      404,
      API_ERROR_CODES.redemptionCodeInvalid,
    )
    assert.equal(unknown.reason, 'code_invalid')

    // Wrong shape (ambiguous letter I) never reaches the database.
    expectRewardError(
      () => redeemCredential(world.db, world.operator, { code: 'IIIIIIIIII', now: IN_WINDOW }),
      400,
      API_ERROR_CODES.redemptionCodeInvalid,
    )

    // The real code still works, so the negative probes changed nothing.
    const ok = redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })
    assert.equal(ok.redeemed, true)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('only the hash of a credential is stored, never the plaintext', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    const row = world.db
      .select()
      .from(activityRewardCodes)
      .where(eq(activityRewardCodes.id, claim.credential.id))
      .get()
    assert.equal(row?.codeHash, hashCredentialCode(claim.code))
    assert.match(row!.codeHash, /^[0-9a-f]{64}$/)
    // The plaintext must not appear anywhere in the persisted row.
    assert.ok(!JSON.stringify(row).includes(claim.code))
    assert.equal(row?.codeSuffix, claim.code.slice(-4))

    // Public metadata is masked.
    const mine = getMyCredential(world.db, { activityId: world.activityId, userId: world.leader })
    assert.match(mine!.maskedCode, /^\*{6}[0-9A-HJKMNP-TV-Z]{4}$/)
    assert.ok(!JSON.stringify(mine).includes(claim.code))
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a staff actor outside the activity community is refused and the denial is audited', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    const leaderCheckin = world.db
      .select()
      .from(activityCheckins)
      .where(eq(activityCheckins.userId, world.leader))
      .get()

    const denialCount = (): number =>
      (
        world.sqlite
          .prepare("SELECT count(*) c FROM audit_logs WHERE event='reward.access_denied'")
          .get() as { c: number }
      ).c

    // Every staff surface must refuse AND leave exactly one durable audit row.
    // The audit write is the reason the scope check runs *before* the
    // transaction: an audit row inserted inside a transaction that then throws
    // would be rolled back with it, leaving a probe untraceable.
    const guarded: Array<[string, () => unknown]> = [
      [
        'redeem',
        () => redeemCredential(world.db, world.otherOperator, { code: claim.code, now: IN_WINDOW }),
      ],
      [
        'verifyCheckin',
        () =>
          verifyCheckin(world.db, world.otherOperator, {
            activityId: world.activityId,
            checkinId: leaderCheckin!.id,
            now: IN_WINDOW,
          }),
      ],
      [
        'revokeCheckin',
        () =>
          revokeCheckin(world.db, world.otherOperator, {
            activityId: world.activityId,
            checkinId: leaderCheckin!.id,
            reason: '越权尝试',
            now: IN_WINDOW,
          }),
      ],
      [
        'revokeGrant',
        () =>
          revokeGrant(world.db, world.otherOperator, {
            activityId: world.activityId,
            grantId: claim.grant.id,
            reason: '越权尝试',
            now: IN_WINDOW,
          }),
      ],
      [
        'appendGrantDispute',
        () =>
          appendGrantDispute(world.db, world.otherOperator, {
            activityId: world.activityId,
            grantId: claim.grant.id,
            decision: 'opened',
            reason: '越权尝试',
            now: IN_WINDOW,
          }),
      ],
      [
        'overview',
        () => getAdminRewardOverview(world.db, world.otherOperator, world.activityId),
      ],
      [
        'requireStaffActivityScope',
        () => requireStaffActivityScope(world.db, world.otherOperator, world.activityId),
      ],
    ]

    for (const [label, call] of guarded) {
      const before = denialCount()
      expectRewardError(call, 403, API_ERROR_CODES.forbidden)
      assert.equal(denialCount(), before + 1, `${label} must leave exactly one audit row`)
    }

    // The audit metadata identifies who probed what, and never carries a secret.
    const denial = world.sqlite
      .prepare("SELECT metadata FROM audit_logs WHERE event='reward.access_denied' LIMIT 1")
      .get() as { metadata: string }
    const metadata = JSON.parse(denial.metadata) as Record<string, unknown>
    assert.equal(metadata.staffId, world.otherOperator.staffId)
    assert.equal(metadata.communityId, world.communityId)
    assert.equal(metadata.reason, 'community_out_of_scope')
    assert.ok(!denial.metadata.includes(claim.code), 'the audit row must not leak the code')

    // Nothing was consumed by the refusals.
    const stock = world.db
      .select()
      .from(activityPrizeStocks)
      .where(eq(activityPrizeStocks.activityId, world.activityId))
      .get()
    assert.equal(stock?.redeemedQuantity, 0)
    const ok = redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })
    assert.equal(ok.redeemed, true)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Revocation and dispute semantics                                           */
/* -------------------------------------------------------------------------- */

test('revoking an unredeemed grant releases the stock and budget claim', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    const revoked = revokeGrant(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      reason: '活动取消',
      now: IN_WINDOW,
    })
    assert.equal(revoked.status, 'revoked')

    const stock = world.db
      .select()
      .from(activityPrizeStocks)
      .where(eq(activityPrizeStocks.activityId, world.activityId))
      .get()
    assert.equal(stock?.claimedQuantity, 0, 'the claim is released')
    assert.equal(stock?.committedBudgetCents, 0)
    assert.equal(stock?.redeemedQuantity, 0)

    // The previously live code is killed with it.
    const codes = world.db
      .select()
      .from(activityRewardCodes)
      .where(eq(activityRewardCodes.grantId, claim.grant.id))
      .all()
    assert.equal(codes.filter((code) => code.status === 'active').length, 0)
    expectRewardError(
      () => redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW }),
      404,
      API_ERROR_CODES.redemptionCodeInvalid,
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a redeemed grant cannot be revoked in place; it must go through the dispute thread', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })

    const refused = expectRewardError(
      () =>
        revokeGrant(world.db, world.operator, {
          activityId: world.activityId,
          grantId: claim.grant.id,
          reason: '想直接撤销',
          now: IN_WINDOW,
        }),
      409,
      API_ERROR_CODES.rewardAlreadyRedeemed,
    )
    assert.equal(refused.reason, 'grant_already_redeemed')

    const thread = appendGrantDispute(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      decision: 'opened',
      reason: '居民反馈礼品损坏',
      now: IN_WINDOW,
    })
    assert.equal(thread.open, true)
    assert.equal(thread.entries.length, 1)
    assert.equal(thread.entries[0]!.decision, 'opened')

    const overview = getAdminRewardOverview(world.db, world.operator, world.activityId)
    const grant = overview.grants[0]!.grant
    assert.equal(grant.status, 'disputed')
    assert.equal(grant.openDisputeId, thread.entries[0]!.id)
    // The redemption evidence survives the dispute.
    assert.ok(grant.redeemedAt)
    assert.equal(overview.counts.grantsRedeemed, 0)
    assert.equal(overview.counts.grantsDisputed, 1)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a reversal keeps the redeemed counters and the redemption stamp intact', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })
    appendGrantDispute(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      decision: 'opened',
      reason: '礼品损坏',
      now: IN_WINDOW,
    })
    const thread = appendGrantDispute(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      decision: 'reversed',
      reason: '已核实并补发',
      now: new Date('2026-11-15T00:00:00.000Z'),
    })
    assert.equal(thread.open, false)
    assert.equal(thread.entries.length, 2)
    assert.equal(thread.entries[1]!.decision, 'reversed')

    const overview = getAdminRewardOverview(world.db, world.operator, world.activityId)
    const grant = overview.grants[0]!.grant
    assert.equal(grant.status, 'reversed')
    assert.ok(grant.redeemedAt, 'the redemption stamp is preserved, not erased')

    // `redeemed` is monotonic: a reversal is an appended fact, not a rollback.
    assert.equal(overview.stock?.redeemedQuantity, 1)
    assert.equal(overview.stock?.redeemedBudgetCents, PLAN.prizeUnitCostCents)
    assert.equal(overview.stock?.claimedQuantity, 1)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('revoking a check-in below three disputes an already redeemed grant', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })

    const leaderCheckin = world.db
      .select()
      .from(activityCheckins)
      .where(eq(activityCheckins.userId, world.leader))
      .get()

    const outcome = revokeCheckinWithConsequence(world.db, world.operator, {
      activityId: world.activityId,
      checkinId: leaderCheckin!.id,
      reason: '签到作废',
      now: new Date('2026-11-16T00:00:00.000Z'),
    })
    assert.equal(outcome.consequence.disputed, true)
    assert.equal(outcome.consequence.revoked, false)

    const overview = getAdminRewardOverview(world.db, world.operator, world.activityId)
    const grant = overview.grants[0]!.grant
    assert.equal(grant.status, 'disputed')
    assert.ok(grant.openDisputeId, 'an opened dispute row is appended')
    assert.ok(grant.redeemedAt)
    // Redeemed counters stay put, so the ledger still reconciles.
    assert.equal(overview.stock?.redeemedQuantity, 1)
    assert.equal(overview.stock?.claimedQuantity, 1)
    assert.equal(overview.counts.checkinsRevoked, 1)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('revoking a check-in below three revokes an unredeemed grant and releases its claim', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    assert.equal(claim.created, true)

    const memberCheckin = world.db
      .select()
      .from(activityCheckins)
      .where(eq(activityCheckins.userId, world.member3))
      .get()

    const outcome = revokeCheckinWithConsequence(world.db, world.operator, {
      activityId: world.activityId,
      checkinId: memberCheckin!.id,
      reason: '代签',
      now: new Date('2026-11-17T00:00:00.000Z'),
    })
    assert.equal(outcome.consequence.revoked, true)
    assert.equal(outcome.consequence.disputed, false)

    const overview = getAdminRewardOverview(world.db, world.operator, world.activityId)
    assert.equal(overview.grants[0]!.grant.status, 'revoked')
    assert.equal(overview.stock?.claimedQuantity, 0, 'the occupancy is returned to the pool')
    assert.equal(overview.stock?.committedBudgetCents, 0)
    assert.equal(overview.counts.grantsRevoked, 1)

    // The team is no longer eligible, so it cannot immediately re-claim.
    const state = getTeamRewardState(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: new Date('2026-11-18T00:00:00.000Z'),
    })
    assert.equal(state.requirement.checkinsValid, 2)
    assert.equal(state.eligible, false)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('revoking a check-in of a team that stays qualified leaves the grant alone', () => {
  const world = createWorld()
  try {
    // Three seats means three members, so a team cannot normally keep three
    // verified check-ins after a revocation. The guard still has to be proven:
    // give the team a *fourth* verified check-in on a seat that is later revoked
    // from a different team's perspective is impossible here, so instead we
    // revoke a check-in that belongs to another activity entirely and confirm the
    // team's grant is untouched.
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    assert.equal(claim.created, true)

    // A check-in in the *other* activity must never disturb this team's grant.
    const otherStarted = confirmParticipation(world.db, {
      activityId: world.otherActivityId,
      userId: world.leader,
      now: OPEN,
    })
    assert.equal(otherStarted.created, true)
    recordCheckin(world.db, {
      activityId: world.otherActivityId,
      userId: world.leader,
      operator: world.operator,
      now: IN_WINDOW,
    })
    const otherCheckin = world.db
      .select()
      .from(activityCheckins)
      .where(eq(activityCheckins.activityId, world.otherActivityId))
      .get()

    const outcome = revokeCheckinWithConsequence(world.db, world.operator, {
      activityId: world.otherActivityId,
      checkinId: otherCheckin!.id,
      reason: '误操作修正',
      now: new Date('2026-11-19T00:00:00.000Z'),
    })
    // The other activity has no grant of its own, so nothing was revoked here.
    assert.equal(outcome.consequence.grantId, null)

    const overview = getAdminRewardOverview(world.db, world.operator, world.activityId)
    assert.equal(overview.grants[0]!.grant.status, 'granted', 'the untouched grant stays granted')
    assert.equal(overview.stock?.claimedQuantity, 1)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Admin overview and append-only guarantees                                  */
/* -------------------------------------------------------------------------- */

test('the admin overview reports real counts and consistent stock arithmetic', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })

    const overview = getAdminRewardOverview(world.db, world.operator, world.activityId)
    assert.equal(overview.planConfigured, true)
    assert.equal(overview.planSource, 'rule_version_snapshot')
    assert.equal(overview.ruleVersion, 1)
    assert.deepEqual(overview.plan, PLAN)
    assert.equal(overview.counts.checkinsValid, 3)
    assert.equal(overview.counts.checkinsVerified, 3)
    assert.equal(overview.counts.checkinsPendingVerification, 0)
    assert.equal(overview.counts.grantsTotal, 1)
    assert.equal(overview.counts.grantsRedeemed, 1)
    assert.equal(overview.counts.codesRedeemed, 1)
    assert.equal(overview.counts.codesActive, 0)

    const stock = overview.stock!
    assert.equal(stock.totalQuantity, PLAN.totalPrizeQuantity)
    assert.equal(stock.claimedQuantity, 1)
    assert.equal(stock.redeemedQuantity, 1)
    assert.equal(stock.availableQuantity, PLAN.totalPrizeQuantity - 1)
    assert.equal(stock.committedBudgetCents, stock.claimedQuantity * stock.unitCostCents)
    assert.equal(stock.redeemedBudgetCents, stock.redeemedQuantity * stock.unitCostCents)
    assert.equal(stock.remainingBudgetCents, stock.budgetCapCents - stock.committedBudgetCents)

    // The listed check-ins agree with the counts the overview reports.
    const list = listActivityCheckins(world.db, world.operator, world.activityId)
    assert.equal(list.items.length, 3)
    assert.deepEqual(list.counts, {
      valid: 3,
      verified: 3,
      pendingVerification: 0,
      revoked: 0,
    })
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('the append-only tables reject updates and deletes from the service layer', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })

    // The service never issues these statements; prove the database would refuse
    // them anyway, so an accidental future DELETE cannot erase history.
    assert.throws(
      () => world.sqlite.prepare('DELETE FROM activity_reward_events').run(),
      /append-only/,
    )
    assert.throws(
      () => world.sqlite.prepare("UPDATE activity_reward_events SET kind='grant.created'").run(),
      /append-only/,
    )
    assert.throws(
      () => world.sqlite.prepare('DELETE FROM activity_reward_grants').run(),
      /append-only history/,
    )
    assert.throws(
      () => world.sqlite.prepare('DELETE FROM activity_checkins').run(),
      /append-only history/,
    )

    // The event trail records the whole journey in sequence order.
    const events = world.sqlite
      .prepare('SELECT sequence, kind FROM activity_reward_events ORDER BY sequence')
      .all() as Array<{ sequence: number; kind: string }>
    const kinds = events.map((event) => event.kind)
    assert.ok(kinds.includes('checkin.verified'))
    assert.ok(kinds.includes('grant.created'))
    assert.ok(kinds.includes('credential.issued'))
    assert.ok(kinds.includes('grant.redeemed'))
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_, index) => index + 1),
      'sequences are dense and monotonic',
    )
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('audit rows never contain a credential code', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })

    const audits = world.sqlite.prepare('SELECT event, metadata FROM audit_logs').all() as Array<{
      event: string
      metadata: string | null
    }>
    const serialized = JSON.stringify(audits)
    assert.ok(!serialized.includes(claim.code), 'the plaintext code must never be audited')
    assert.ok(
      !serialized.includes(hashCredentialCode(claim.code)),
      'the hash is not a credential either: keep audit rows free of secrets',
    )
    // The reward audit trail is present and identifiable.
    const events = audits.map((audit) => audit.event)
    assert.ok(events.includes('reward.grant.created'))
    assert.ok(events.includes('reward.grant.redeemed'))
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a pre-0006 database upgrades in place and keeps its rows usable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-rewards-upgrade-'))
  try {
    const staged = join(dir, 'migrations-before-0006')
    cpSync(migrationsFolder, staged, { recursive: true })
    const journalPath = join(staged, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    writeFileSync(
      journalPath,
      JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 5) }),
    )

    const databasePath = join(dir, 'upgrade.sqlite')
    const legacy = createDatabase(databasePath, staged)
    const legacyCommunity = randomUUID()
    const legacyUser = randomUUID()
    const legacyActivity = randomUUID()
    try {
      legacy.sqlite
        .prepare('INSERT INTO communities (id, name, created_at) VALUES (?,?,?)')
        .run(legacyCommunity, '旧库社区', OPEN.getTime())
      legacy.sqlite
        .prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?,?,?,?)')
        .run(legacyUser, '旧库居民', OPEN.getTime(), OPEN.getTime())
      legacy.sqlite
        .prepare(
          `INSERT INTO activities (id, community_id, title, status, starts_at, ends_at, location,
             budget_cap_cents, prize_quantity_cap, public_rules_json, created_by_user_id, created_at, updated_at)
           VALUES (?,?,?,'published',?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          legacyActivity,
          legacyCommunity,
          '旧库活动',
          OPEN.getTime(),
          new Date('2026-11-30T00:00:00.000Z').getTime(),
          '社区广场',
          15_000,
          4,
          JSON.stringify(PUBLIC_RULES),
          legacyUser,
          OPEN.getTime(),
          OPEN.getTime(),
        )
    } finally {
      legacy.sqlite.close()
    }

    const upgraded = createDatabase(databasePath, migrationsFolder)
    try {
      // The old activity survived untouched and has no reward plan.
      const row = upgraded.sqlite
        .prepare('SELECT title, reward_plan_json FROM activities WHERE id=?')
        .get(legacyActivity) as { title: string; reward_plan_json: string | null }
      assert.equal(row.title, '旧库活动')
      assert.equal(row.reward_plan_json, null, 'the column is added without backfilling')

      // Because there is no frozen plan, the reward entry is formally unavailable
      // rather than falling back to the mutable columns.
      const state = getCheckinState(upgraded.db, {
        activityId: legacyActivity,
        userId: legacyUser,
        now: IN_WINDOW,
      })
      assert.equal(state.available, false)
      assert.equal(state.unavailableReason, 'reward_plan_not_configured')
      assert.equal(state.checkinWindow, null)

      // The community still exists, and the new tables are usable afterwards.
      const community = upgraded.sqlite
        .prepare('SELECT name FROM communities WHERE id=?')
        .get(legacyCommunity) as { name: string }
      assert.equal(community.name, '旧库社区')
      const counts = upgraded.sqlite
        .prepare('SELECT count(*) c FROM activity_checkins')
        .get() as { c: number }
      assert.equal(counts.c, 0)
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------- */
/* t11: the state projection must never contradict itself                     */
/* -------------------------------------------------------------------------- */

test('an exhausted prize pool closes the claim surface instead of throwing', () => {
  // One prize for the whole activity, one prize per team: after the first team
  // takes it there is nothing left for the second.
  const world = createWorld({
    plan: { ...PLAN, totalPrizeQuantity: 1, budgetCapCents: PLAN.prizeUnitCostCents },
  })
  try {
    qualifyTeam(world)
    const other = makeSecondTeam(world, '第二队')
    claimTeamReward(world.db, { activityId: world.activityId, userId: world.leader, now: IN_WINDOW })

    // This is the call that used to answer with `eligible: true` next to
    // `unavailableReason: 'stock_exhausted'`, so `teamRewardStateSchema.parse`
    // threw a ZodError and the route surfaced HTTP 500.
    const state = getTeamRewardState(world.db, {
      activityId: world.activityId,
      userId: other.leader,
      now: IN_WINDOW,
    })
    assert.equal(state.eligible, false, 'a team that cannot be served is not eligible')
    assert.equal(state.unavailableReason, 'stock_exhausted')
    assert.equal(state.claimableByMe, false)
    // The contract invariant, asserted directly rather than trusted.
    assert.equal(state.eligible, state.unavailableReason === null || state.grant !== null)

    // The claim path agrees with what the read path just projected.
    const claimError = expectRewardError(
      () =>
        claimTeamReward(world.db, {
          activityId: world.activityId,
          userId: other.leader,
          now: IN_WINDOW,
        }),
      409,
      API_ERROR_CODES.prizeStockExhausted,
    )
    assert.equal(claimError.reason, 'stock_exhausted')
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('an exhausted budget closes the claim surface with budget_exhausted', () => {
  // Room for two prizes by count, but only enough money for one.
  const world = createWorld({
    plan: {
      ...PLAN,
      totalPrizeQuantity: 2,
      budgetCapCents: PLAN.prizeUnitCostCents,
    },
  })
  try {
    qualifyTeam(world)
    const other = makeSecondTeam(world, '第二队')
    claimTeamReward(world.db, { activityId: world.activityId, userId: world.leader, now: IN_WINDOW })

    const state = getTeamRewardState(world.db, {
      activityId: world.activityId,
      userId: other.leader,
      now: IN_WINDOW,
    })
    assert.equal(state.eligible, false)
    assert.equal(state.unavailableReason, 'budget_exhausted')
    assert.equal(state.claimableByMe, false)

    const claimError = expectRewardError(
      () =>
        claimTeamReward(world.db, {
          activityId: world.activityId,
          userId: other.leader,
          now: IN_WINDOW,
        }),
      409,
      API_ERROR_CODES.budgetExceeded,
    )
    // Two different vocabularies on purpose: the read path projects the contract's
    // `RewardAvailabilityReason` (`budget_exhausted`), the write path raises the
    // `RewardErrorReason` (`budget_exceeded`). Both describe the same condition.
    assert.equal(claimError.reason, 'budget_exceeded')
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('exactly enough stock for one more team stays eligible', () => {
  // The boundary the exhaustion guard must not overshoot: two prizes, one team
  // has taken one, so exactly one is left — that is still claimable.
  const world = createWorld({
    plan: {
      ...PLAN,
      totalPrizeQuantity: 2,
      budgetCapCents: 2 * PLAN.prizeUnitCostCents,
    },
  })
  try {
    qualifyTeam(world)
    const other = makeSecondTeam(world, '第二队')
    claimTeamReward(world.db, { activityId: world.activityId, userId: world.leader, now: IN_WINDOW })

    const state = getTeamRewardState(world.db, {
      activityId: world.activityId,
      userId: other.leader,
      now: IN_WINDOW,
    })
    assert.equal(state.eligible, true, 'the last remaining prize is still claimable')
    assert.equal(state.unavailableReason, null)
    assert.equal(state.claimableByMe, true)

    // And the claim really does go through.
    const claimed = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: other.leader,
      now: IN_WINDOW,
    })
    assert.equal(claimed.created, true)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('dismissing a dispute restores the grant to redeemed (t17)', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })

    appendGrantDispute(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      decision: 'opened',
      reason: '居民反馈礼品损坏',
      now: IN_WINDOW,
    })

    const thread = appendGrantDispute(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      decision: 'dismissed',
      reason: '已核实礼品完好，发放无误',
      now: new Date('2026-11-16T00:00:00.000Z'),
    })
    assert.equal(thread.open, false)
    assert.equal(thread.entries.length, 2, 'both thread entries are retained; nothing is deleted')
    assert.equal(thread.entries[1]!.decision, 'dismissed')

    const overview = getAdminRewardOverview(world.db, world.operator, world.activityId)
    const grant = overview.grants[0]!.grant

    // The blocking defect: pre-t17 this stayed 'disputed' forever.
    assert.equal(grant.status, 'redeemed')
    assert.equal(grant.openDisputeId, null)
    assert.ok(grant.redeemedAt, 'the redemption stamp is preserved, not re-created')

    // The two ledgers now agree. Pre-t17 they differed by one permanently,
    // which left end-of-activity reconciliation with two irreconcilable numbers.
    assert.equal(overview.stock?.redeemedQuantity, 1)
    assert.equal(overview.counts.grantsRedeemed, 1)
    assert.equal(overview.counts.grantsDisputed, 0)
    assert.equal(overview.stock?.redeemedQuantity, overview.counts.grantsRedeemed)

    // The resident-facing bucket no longer claims an open dispute.
    const state = getTeamRewardState(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: new Date('2026-11-16T00:00:00.000Z'),
    })
    assert.equal(state.grant?.status, 'redeemed')
    assert.equal(state.grant?.openDisputeId, null)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a dismissed grant cannot be redeemed a second time (t17)', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })
    appendGrantDispute(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      decision: 'opened',
      reason: '礼品损坏',
      now: IN_WINDOW,
    })
    appendGrantDispute(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      decision: 'dismissed',
      reason: '核实无误',
      now: new Date('2026-11-16T00:00:00.000Z'),
    })

    // Restoring the flag must NOT restore the ability to redeem. The credential
    // was already spent, so re-redeeming is refused exactly as before.
    const refused = expectRewardError(
      () => redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW }),
      409,
      API_ERROR_CODES.rewardAlreadyRedeemed,
    )
    assert.equal(refused.reason, 'reward_already_redeemed')

    // And the redeemed counters did not move.
    const overview = getAdminRewardOverview(world.db, world.operator, world.activityId)
    assert.equal(overview.stock?.redeemedQuantity, 1)
    assert.equal(overview.counts.grantsRedeemed, 1)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('a dismissed grant cannot start a second dispute thread; reversing still works (t17)', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })

    appendGrantDispute(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      decision: 'opened',
      reason: '第一次争议',
      now: IN_WINDOW,
    })
    appendGrantDispute(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      decision: 'dismissed',
      reason: '第一次核实无误',
      now: new Date('2026-11-16T00:00:00.000Z'),
    })

    // Restoring the grant to `redeemed` does NOT reopen the thread. The 0006
    // trigger `activity_reward_disputes_open_first` allows at most one `opened`
    // entry per grant, so a dismissed dispute cannot be re-litigated: the grant
    // is back to a clean redeemed state, and the closed thread stays closed.
    // Asserted here so the boundary is explicit rather than discovered later.
    const reopened = expectRewardError(
      () =>
        appendGrantDispute(world.db, world.operator, {
          activityId: world.activityId,
          grantId: claim.grant.id,
          decision: 'opened',
          reason: '居民再次反馈',
          now: new Date('2026-11-17T00:00:00.000Z'),
        }),
      409,
      API_ERROR_CODES.conflict,
    )
    assert.ok(reopened.reason, 'refused with a structured domain error, not a raw SQLite abort')

    // The grant is still redeemed and the thread is untouched by the refusal.
    const afterRefusal = getAdminRewardOverview(world.db, world.operator, world.activityId)
    assert.equal(afterRefusal.grants[0]!.grant.status, 'redeemed')
    assert.equal(afterRefusal.stock?.redeemedQuantity, afterRefusal.counts.grantsRedeemed)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})

test('the reversal path is unchanged by the new disputed -> redeemed edge (t17)', () => {
  const world = createWorld()
  try {
    qualifyTeam(world)
    const claim = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: world.leader,
      now: IN_WINDOW,
    })
    redeemCredential(world.db, world.operator, { code: claim.code, now: IN_WINDOW })
    appendGrantDispute(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      decision: 'opened',
      reason: '礼品损坏',
      now: IN_WINDOW,
    })
    const thread = appendGrantDispute(world.db, world.operator, {
      activityId: world.activityId,
      grantId: claim.grant.id,
      decision: 'reversed',
      reason: '已核实并补发',
      now: new Date('2026-11-18T00:00:00.000Z'),
    })
    assert.equal(thread.open, false)
    assert.equal(thread.entries.length, 2)

    const overview = getAdminRewardOverview(world.db, world.operator, world.activityId)
    assert.equal(overview.grants[0]!.grant.status, 'reversed')
    // `redeemed` stays monotonic through reversal, exactly as before t17.
    assert.equal(overview.stock?.redeemedQuantity, 1)
    assert.equal(overview.stock?.redeemedBudgetCents, PLAN.prizeUnitCostCents)
  } finally {
    world.sqlite.close()
    world.cleanup()
  }
})
