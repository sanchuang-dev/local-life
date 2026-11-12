import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  API_ERROR_CODES,
  type ActivityRewardPlan,
} from '@sanchuang-dev/local-life-contracts'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import {
  createActivity,
  transitionActivity,
  updateActivity,
} from '../src/activities/service.js'
import { confirmParticipation } from '../src/participation/service.js'
import {
  RewardError,
  claimTeamReward,
  getAdminRewardOverview,
  revokeCheckinWithConsequence,
  revokeGrant,
} from '../src/rewards/service.js'
import { communities, staffAccounts, users } from '../src/db/schema.js'
import { seedConfirmedCommunity } from './resident-community-fixtures.js'

/**
 * Regression suite for the "rule edit mints a new version" class of bug.
 *
 * A published activity gains a new `activity_rule_versions` row on any rule
 * edit — even one that only moves `location`. Before this suite existed both
 * uniqueness constraints were scoped to `rule_version_id`, so:
 *
 *   - `activity_reward_grants` let the same team be granted a SECOND physical
 *     prize in the new version, and both credentials redeemed cleanly;
 *   - `activity_prize_stocks` opened a fresh `claimed_quantity = 0` ledger per
 *     version, silently multiplying `total_prize_quantity` / `budget_cap_cents`
 *     by the number of edits;
 *   - the admin overview filtered grants by the *current* version, so the
 *     projection said `grantsTotal = 1` while the table held two — which is why
 *     the bug could only ever be seen by querying the database.
 *
 * Every assertion below therefore reads the database, not the projection.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

const OPEN = new Date('2026-11-01T00:00:00.000Z')
const IN_WINDOW = new Date('2026-11-10T10:00:00.000Z')

const PLAN: ActivityRewardPlan = {
  prizeName: '粮油礼包',
  prizeUnitCostCents: 5_000,
  prizeQuantityPerTeam: 1,
  totalPrizeQuantity: 4,
  budgetCapCents: 20_000,
  claimRecipient: 'leader',
  checkinWindow: {
    opensAt: '2026-11-01T00:00:00.000Z',
    closesAt: '2026-11-30T00:00:00.000Z',
  },
  redemptionValidHours: 72,
}

const BASE_RULES = {
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2026-11-30T00:00:00.000Z',
  location: '幸福社区党群服务中心',
  budgetCapCents: 20_000,
  prizeQuantityCap: 4,
  publicRules: {
    eligibility: '本社区 60 岁以上居民',
    checkin: '活动当天到现场签到',
    purchase: '无消费门槛',
    prizeClaim: '达标后凭券领取',
  },
}

interface Team {
  leader: string
  members: string[]
  teamId: string
}

interface World {
  db: AppDatabase
  sqlite: SqliteConnection
  activityId: string
  operator: { userId: string; staffId: string; role: 'admin' }
  activityUserId: string
  makeTeam: (label: string) => Team
  cleanup: () => void
}

/**
 * A real (file) database through the real migrations, a real published activity
 * created by the real activity service, and teams assembled by the real
 * participation + check-in services. Nothing is hand-written.
 */
function createWorld(plan: ActivityRewardPlan = PLAN): World {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-version-edit-'))
  const { db, sqlite } = createDatabase(join(tempDir, 'world.sqlite'), migrationsFolder)

  const communityId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '版本编辑社区', createdAt: OPEN }).run()

  const adminUser = randomUUID()
  db.insert(users).values({ id: adminUser, displayName: '管理员', createdAt: OPEN, updatedAt: OPEN }).run()
  const staffId = randomUUID()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId: adminUser,
      username: 'version-admin',
      passwordHash: 'x',
      role: 'admin',
      status: 'active',
      createdAt: OPEN,
      updatedAt: OPEN,
    })
    .run()
  const operator = { userId: adminUser, staffId, role: 'admin' as const }

  const created = createActivity(db, operator, {
    communityId,
    title: '版本编辑活动',
    keyRules: { ...BASE_RULES, rewardPlan: plan },
  })
  const published = transitionActivity(db, operator, created.id, 'publish', created.updatedAt)

  const newUser = (displayName: string): string => {
    const id = randomUUID()
    db.insert(users).values({ id, displayName, createdAt: OPEN, updatedAt: OPEN }).run()
    // #171: every resident below joins an activity of `communityId`, so each one
    // must hold a real confirmed binding (not a legacy assignment).
    seedConfirmedCommunity(db, id, communityId, OPEN)
    return id
  }

  /** A locked 3-seat team with three verified check-ins: fully reward-eligible. */
  const makeTeam = (label: string): Team => {
    const leader = newUser(`团长${label}`)
    const started = confirmParticipation(db, { activityId: published.id, userId: leader, now: OPEN })
    const inviteCode = started.state.team!.inviteCode!
    const teamId = started.state.team!.id
    const members: string[] = []
    for (const suffix of ['乙', '丙']) {
      const member = newUser(`成员${label}${suffix}`)
      confirmParticipation(db, { activityId: published.id, userId: member, inviteCode, now: OPEN })
      members.push(member)
    }
    for (const userId of [leader, ...members]) checkInVerified(world, userId, teamId)
    return { leader, members, teamId }
  }

  const world: World = {
    db,
    sqlite,
    activityId: published.id,
    operator,
    activityUserId: adminUser,
    makeTeam,
    cleanup: () => {
      // Windows cannot unlink an open SQLite file (EBUSY), so close the
      // connection before removing the temp directory. This is test hygiene
      // only: no assertion or production path is affected.
      if (sqlite.open) sqlite.close()
      rmSync(tempDir, { recursive: true, force: true })
    },
  }
  return world
}

/**
 * Writes a verified check-in directly. The assertion targets are the ledger and
 * the grant table, so the check-in path itself is proven elsewhere; going through
 * `recordCheckin` + `verifyCheckin` here would only add fixture noise.
 */
function checkInVerified(world: World, userId: string, teamId: string): void {
  const seat = world.sqlite
    .prepare('SELECT seat_no FROM activity_participations WHERE team_id=? AND user_id=?')
    .get(teamId, userId) as { seat_no: number } | undefined
  world.sqlite
    .prepare(
      `INSERT INTO activity_checkins
         (id, activity_id, user_id, team_id, seat_no, status, checked_in_at, verified_at, verified_by_staff_id)
       VALUES (?,?,?,?,?,'valid',?,?,?)`,
    )
    .run(
      randomUUID(),
      world.activityId,
      userId,
      teamId,
      seat?.seat_no ?? 1,
      IN_WINDOW.getTime(),
      IN_WINDOW.getTime(),
      world.operator.staffId,
    )
}

/**
 * Edits ONLY the location — the smallest realistic edit that bumps the version.
 *
 * `rewardPlan` is deliberately OMITTED rather than restated: this mirrors what an
 * operator's partial update actually sends, and it keeps the helper honest under
 * a "plan is frozen after publication" guard. Omitting means "leave the plan
 * alone", so the edit allocates a new rule version without touching the plan.
 */
function editLocation(world: World, location: string): void {
  const detail = updateActivity(world.db, world.operator, world.activityId, {
    expectedUpdatedAt: currentUpdatedAt(world),
    keyRules: { ...BASE_RULES, location },
  })
  assert.ok(detail.id)
}

function currentUpdatedAt(world: World): string {
  const row = world.sqlite
    .prepare('SELECT updated_at FROM activities WHERE id=?')
    .get(world.activityId) as { updated_at: number }
  return new Date(row.updated_at).toISOString()
}

function ruleVersionCount(world: World): number {
  const row = world.sqlite
    .prepare('SELECT count(*) c FROM activity_rule_versions WHERE activity_id=?')
    .get(world.activityId) as { c: number }
  return row.c
}

function grantRows(world: World): Array<{ id: string; rule_version_id: string; status: string; team_id: string }> {
  return world.sqlite
    .prepare('SELECT id, rule_version_id, status, team_id FROM activity_reward_grants WHERE activity_id=?')
    .all(world.activityId) as Array<{ id: string; rule_version_id: string; status: string; team_id: string }>
}

function stockRows(world: World): Array<{
  rule_version_id: string
  prize_name: string
  claimed_quantity: number
  redeemed_quantity: number
  total_quantity: number
  committed_budget_cents: number
  budget_cap_cents: number
}> {
  return world.sqlite
    .prepare(
      `SELECT rule_version_id, prize_name, claimed_quantity, redeemed_quantity, total_quantity,
              committed_budget_cents, budget_cap_cents
         FROM activity_prize_stocks WHERE activity_id=?`,
    )
    .all(world.activityId) as Array<{
    rule_version_id: string
    prize_name: string
    claimed_quantity: number
    redeemed_quantity: number
    total_quantity: number
    committed_budget_cents: number
    budget_cap_cents: number
  }>
}

function activeCodeCount(world: World): number {
  const row = world.sqlite
    .prepare("SELECT count(*) c FROM activity_reward_codes WHERE activity_id=? AND status='active'")
    .get(world.activityId) as { c: number }
  return row.c
}

test('a rule edit does not hand the same team a second prize', () => {
  const world = createWorld()
  try {
    const team = world.makeTeam('甲')

    const first = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: team.leader,
      now: IN_WINDOW,
    })
    assert.equal(first.created, true, 'the first claim must create the prize')
    assert.equal(grantRows(world).length, 1)
    const firstVersionId = grantRows(world)[0]!.rule_version_id

    // A location-only edit is enough to create a second rule version. This is
    // precisely the step that used to re-issue a prize.
    const versionsBefore = ruleVersionCount(world)
    editLocation(world, '幸福社区东门')
    const versionsAfter = ruleVersionCount(world)
    assert.equal(versionsAfter, versionsBefore + 1, 'the edit must have created a new rule version')

    const second = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: team.leader,
      now: new Date(IN_WINDOW.getTime() + 60_000),
    })

    assert.equal(second.created, false, 'the second claim must be idempotent, not a new prize')
    assert.equal(second.grant.id, first.grant.id, 'the second claim must return the SAME grant')

    const grants = grantRows(world)
    assert.equal(grants.length, 1, 'exactly one grant row may exist for the activity')
    assert.equal(grants[0]!.team_id, team.teamId)
    // The grant keeps the version that priced it — provenance, not a key. A
    // newer version exists, yet the grant was not re-keyed onto it.
    assert.equal(grants[0]!.rule_version_id, firstVersionId, 'the grant keeps its original pricing version')
    const newestVersion = world.sqlite
      .prepare('SELECT id FROM activity_rule_versions WHERE activity_id=? ORDER BY version DESC LIMIT 1')
      .get(world.activityId) as { id: string }
    assert.notEqual(newestVersion.id, firstVersionId, 'a newer version must exist at this point')
    assert.equal(activeCodeCount(world), 1, 'exactly one live credential may exist')

    const stocks = stockRows(world)
    assert.equal(stocks.length, 1, 'the activity owns exactly ONE stock ledger row')
    assert.equal(stocks[0]!.claimed_quantity, 1, 'claimed quantity must not double after an edit')
    assert.equal(stocks[0]!.total_quantity, PLAN.totalPrizeQuantity, 'the pool is not enlarged by an edit')
    assert.equal(stocks[0]!.committed_budget_cents, PLAN.prizeUnitCostCents)

    // The projection must agree with the database: the old code reported
    // grantsTotal = 1 because it filtered grants by the current version.
    const overview = getAdminRewardOverview(world.db, world.operator, world.activityId)
    assert.equal(overview.counts.grantsTotal, 1)
    assert.equal(overview.stock?.claimedQuantity, 1)
    assert.equal(overview.stock?.totalQuantity, PLAN.totalPrizeQuantity)
  } finally {
    world.cleanup()
  }
})

test('a revoked unredeemed grant frees the team to claim again', () => {
  const world = createWorld()
  try {
    const team = world.makeTeam('乙')
    const first = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: team.leader,
      now: IN_WINDOW,
    })

    revokeGrant(world.db, world.operator, {
      activityId: world.activityId,
      grantId: first.grant.id,
      reason: '发错队伍，撤销后重新领取',
      now: new Date(IN_WINDOW.getTime() + 60_000),
    })

    const revoked = grantRows(world)
    assert.equal(revoked.length, 1)
    assert.equal(revoked[0]!.status, 'revoked')
    // Revocation is the one transition that releases the stock/budget claim.
    assert.equal(stockRows(world)[0]!.claimed_quantity, 0)

    // The partial unique index excludes `revoked`, so a corrected grant fits.
    const second = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: team.leader,
      now: new Date(IN_WINDOW.getTime() + 120_000),
    })
    assert.equal(second.created, true, 'a revoked grant must not block a corrected re-grant')
    assert.notEqual(second.grant.id, first.grant.id, 'the re-grant is a new grant')

    const grants = grantRows(world)
    assert.equal(grants.length, 2, 'the revoked row is history and stays')
    assert.deepEqual(
      grants.map((row) => row.status).sort(),
      ['granted', 'revoked'],
      'the append-only history keeps the revoked grant',
    )
    assert.equal(stockRows(world)[0]!.claimed_quantity, 1, 'only the live grant occupies stock')
  } finally {
    world.cleanup()
  }
})

test('a redeemed grant still blocks a second prize, even after an edit', () => {
  const world = createWorld()
  try {
    const team = world.makeTeam('丙')
    const first = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: team.leader,
      now: IN_WINDOW,
    })
    // `redeemed` is the state where a second prize would be physical theft, so
    // it must keep occupying the partial index after any number of edits.
    world.sqlite
      .prepare("UPDATE activity_reward_grants SET status='redeemed', redeemed_at=?, redeemed_by_staff_id=? WHERE id=?")
      .run(IN_WINDOW.getTime(), world.operator.staffId, first.grant.id)

    editLocation(world, '幸福社区西门')
    assert.equal(ruleVersionCount(world), 2, 'the edit created a new version')

    // A redeemed prize is never re-issued — and, since the fix, never even mints
    // a replacement code: the old behaviour returned 200 with a fresh `active`
    // credential that redemption could only refuse.
    let secondError: unknown
    try {
      claimTeamReward(world.db, {
        activityId: world.activityId,
        userId: team.leader,
        now: new Date(IN_WINDOW.getTime() + 60_000),
      })
    } catch (error) {
      secondError = error
    }
    assert.ok(secondError instanceof RewardError, 'a redeemed prize is refused')
    assert.equal(secondError.status, 409)
    assert.equal(secondError.code, API_ERROR_CODES.rewardAlreadyRedeemed)
    assert.equal(secondError.reason, 'reward_already_redeemed')

    assert.equal(grantRows(world).length, 1, 'still exactly one grant')
    assert.equal(stockRows(world)[0]!.claimed_quantity, 1)
    // No dead credential was minted for the refused attempt: the row count for
    // this grant is exactly what it was before the re-claim.
    const codeCount = world.sqlite
      .prepare('SELECT count(*) c FROM activity_reward_codes WHERE grant_id=?')
      .get(first.grant.id) as { c: number }
    assert.equal(codeCount.c, 1, 'the refused re-claim did not mint another credential')
  } finally {
    world.cleanup()
  }
})

test('the stock and budget caps are not multiplied by rule versions', () => {
  // Room for two prizes and money for two, but two *teams* plus an edit would
  // fit a third if each version opened its own ledger.
  const world = createWorld({
    ...PLAN,
    totalPrizeQuantity: 2,
    budgetCapCents: 2 * PLAN.prizeUnitCostCents,
  })
  try {
    const first = world.makeTeam('丁')
    const second = world.makeTeam('戊')

    claimTeamReward(world.db, { activityId: world.activityId, userId: first.leader, now: IN_WINDOW })
    editLocation(world, '幸福社区南门')
    assert.equal(ruleVersionCount(world), 2)

    // The second team still draws from the SAME pool of two.
    claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: second.leader,
      now: new Date(IN_WINDOW.getTime() + 60_000),
    })

    const stocks = stockRows(world)
    assert.equal(stocks.length, 1, 'one ledger row per activity and prize name')
    assert.equal(stocks[0]!.claimed_quantity, 2)
    assert.equal(stocks[0]!.total_quantity, 2)
    assert.equal(
      stocks[0]!.committed_budget_cents,
      2 * PLAN.prizeUnitCostCents,
      'the budget is spent once per prize, not once per version',
    )

    // A third team must be refused by the SAME pool, with the honest reason.
    const third = world.makeTeam('己')
    assert.throws(
      () =>
        claimTeamReward(world.db, {
          activityId: world.activityId,
          userId: third.leader,
          now: new Date(IN_WINDOW.getTime() + 120_000),
        }),
      (error: unknown) => {
        const rewardError = error as { code?: string; reason?: string; status?: number }
        assert.equal(rewardError.status, 409)
        assert.equal(rewardError.code, 'prize_stock_exhausted')
        assert.equal(rewardError.reason, 'stock_exhausted')
        return true
      },
    )
    assert.equal(grantRows(world).length, 2, 'the refused team created no grant')
    assert.equal(stockRows(world)[0]!.claimed_quantity, 2, 'the pool never oversells')
  } finally {
    world.cleanup()
  }
})

test('the database itself refuses a second live grant for the same team', () => {
  const world = createWorld()
  try {
    const team = world.makeTeam('庚')
    const first = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: team.leader,
      now: IN_WINDOW,
    })

    // Bypass the service entirely: the guarantee must live in the schema, so a
    // future caller that forgets the lookup still cannot double-issue.
    const foreign = world.sqlite
      .prepare('SELECT id FROM activity_rule_versions WHERE activity_id=? ORDER BY version DESC LIMIT 1')
      .get(world.activityId) as { id: string }

    assert.throws(
      () =>
        world.sqlite
          .prepare(
            `INSERT INTO activity_reward_grants
               (id, activity_id, rule_version_id, team_id, prize_name, quantity, unit_cost_cents,
                total_cost_cents, status, recipient_role, recipient_user_id, granted_at, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,'granted','leader',?,?,?,?)`,
          )
          .run(
            randomUUID(),
            world.activityId,
            foreign.id,
            team.teamId,
            PLAN.prizeName,
            PLAN.prizeQuantityPerTeam,
            PLAN.prizeUnitCostCents,
            PLAN.prizeQuantityPerTeam * PLAN.prizeUnitCostCents,
            team.leader,
            IN_WINDOW.getTime(),
            IN_WINDOW.getTime(),
            IN_WINDOW.getTime(),
          ),
      (error: unknown) => {
        assert.match(
          String((error as Error).message),
          /UNIQUE constraint failed: activity_reward_grants\.activity_id, activity_reward_grants\.team_id/,
          'the activity-scoped partial unique index must reject the duplicate',
        )
        return true
      },
    )

    // And the revoked escape hatch is exactly one row wide, not zero.
    revokeGrant(world.db, world.operator, {
      activityId: world.activityId,
      grantId: first.grant.id,
      reason: '测试部分索引',
      now: new Date(IN_WINDOW.getTime() + 60_000),
    })
    const regrant = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: team.leader,
      now: new Date(IN_WINDOW.getTime() + 120_000),
    })
    assert.equal(regrant.created, true)
    assert.equal(grantRows(world).length, 2)
  } finally {
    world.cleanup()
  }
})

test('the database itself refuses a second stock ledger for the same prize', () => {
  const world = createWorld()
  try {
    const team = world.makeTeam('辛')
    claimTeamReward(world.db, { activityId: world.activityId, userId: team.leader, now: IN_WINDOW })

    const row = stockRows(world)[0]!
    assert.equal(stockRows(world).length, 1)

    // A second ledger for the same prize — which a version-scoped key allowed —
    // would silently re-open the full pool. The schema must refuse it.
    assert.throws(
      () =>
        world.sqlite
          .prepare(
            `INSERT INTO activity_prize_stocks
               (id, activity_id, rule_version_id, prize_name, unit_cost_cents, total_quantity,
                claimed_quantity, redeemed_quantity, budget_cap_cents, committed_budget_cents,
                redeemed_budget_cents, created_at, updated_at)
             VALUES (?,?,?,?,?,?,0,0,?,0,0,?,?)`,
          )
          .run(
            randomUUID(),
            world.activityId,
            row.rule_version_id,
            PLAN.prizeName,
            PLAN.prizeUnitCostCents,
            PLAN.totalPrizeQuantity,
            PLAN.budgetCapCents,
            IN_WINDOW.getTime(),
            IN_WINDOW.getTime(),
          ),
      (error: unknown) => {
        assert.match(
          String((error as Error).message),
          /UNIQUE constraint failed: activity_prize_stocks\.activity_id, activity_prize_stocks\.prize_name/,
          'the activity-scoped stock key must reject the duplicate ledger',
        )
        return true
      },
    )
    assert.equal(stockRows(world).length, 1)
  } finally {
    world.cleanup()
  }
})

test('revoking a check-in still finds the grant across rule versions', () => {
  const world = createWorld()
  try {
    const team = world.makeTeam('壬')
    const first = claimTeamReward(world.db, {
      activityId: world.activityId,
      userId: team.leader,
      now: IN_WINDOW,
    })

    // The grant is priced by version 1; the edit moves the activity to version 2.
    editLocation(world, '幸福社区北门')
    assert.equal(ruleVersionCount(world), 2)

    // Withdrawing a member's check-in drops the team below 3 verified check-ins,
    // so the prize it no longer qualifies for must be revoked. A version-scoped
    // lookup misses the version-1 grant and silently does nothing.
    const checkinId = (
      world.sqlite
        .prepare("SELECT id FROM activity_checkins WHERE activity_id=? AND user_id=? AND status='valid'")
        .get(world.activityId, team.members[0]!) as { id: string }
    ).id
    const { consequence } = revokeCheckinWithConsequence(world.db, world.operator, {
      activityId: world.activityId,
      checkinId,
      reason: '签到材料不实',
      now: new Date(IN_WINDOW.getTime() + 60_000),
    })

    assert.equal(consequence.grantId, first.grant.id, 'the pre-edit grant must be found')
    assert.equal(consequence.revoked, true, 'an unredeemed grant must be revoked')

    const grants = grantRows(world)
    assert.equal(grants.length, 1)
    assert.equal(grants[0]!.status, 'revoked')
    assert.equal(stockRows(world)[0]!.claimed_quantity, 0, 'revocation releases the stock claim')
    assert.equal(activeCodeCount(world), 0, 'a revoked grant must not leave a live code')
  } finally {
    world.cleanup()
  }
})
