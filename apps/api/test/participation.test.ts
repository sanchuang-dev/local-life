import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import type {
  ActivityParticipationState,
  ActivityStatus,
} from '@sanchuang-dev/local-life-contracts'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import {
  activities,
  activityInvitations,
  activityParticipations,
  activityTeams,
  auditLogs,
  communities,
  users,
} from '../src/db/schema.js'
import {
  confirmParticipation,
  getParticipationState,
  ParticipationError,
} from '../src/participation/service.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const apiRoot = fileURLToPath(new URL('..', import.meta.url))

/** Scenarios use a frozen clock; the database stores real epoch milliseconds. */
const NOW = new Date('2026-11-04T10:00:00.000Z')
const ACTIVITY_START = new Date('2026-12-01T02:00:00.000Z')
const ACTIVITY_END = new Date('2026-12-01T10:00:00.000Z')

const PUBLIC_RULES_JSON = JSON.stringify({
  eligibility: '本社区 60 岁以上居民',
  checkin: '到社区服务中心签到并领取参与卡',
  purchase: '现场购买指定套餐一份',
  prizeClaim: '凭核销码领取，每人限一次',
  notes: '活动最终解释权归社区所有',
})

interface Fixture {
  db: AppDatabase
  sqlite: SqliteConnection
  communityId: string
}

function createFixture(): Fixture {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const communityId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '幸福社区', createdAt: NOW }).run()
  return { db, sqlite, communityId }
}

function addUser(db: AppDatabase, displayName: string | null): string {
  const id = randomUUID()
  db.insert(users).values({ id, displayName, createdAt: NOW, updatedAt: NOW }).run()
  return id
}

interface ActivityOptions {
  status?: ActivityStatus
  startsAt?: Date
  endsAt?: Date
  title?: string
}

function addActivity(
  db: AppDatabase,
  communityId: string,
  createdByUserId: string,
  options: ActivityOptions = {},
): string {
  const status = options.status ?? 'published'
  const id = randomUUID()
  db.insert(activities)
    .values({
      id,
      communityId,
      title: options.title ?? '银发社区欢乐季',
      summary: '秋季社区敬老活动',
      description: '面向本社区 60 岁以上居民的线下活动',
      status,
      startsAt: options.startsAt ?? ACTIVITY_START,
      endsAt: options.endsAt ?? ACTIVITY_END,
      location: '幸福社区党群服务中心',
      budgetCapCents: 987_654,
      prizeQuantityCap: 4_321,
      publicRulesJson: PUBLIC_RULES_JSON,
      currentRuleVersionId: null,
      createdByUserId,
      createdAt: NOW,
      updatedAt: NOW,
      publishedAt: status === 'draft' ? null : NOW,
      pausedAt: status === 'paused' ? NOW : null,
      endedAt: status === 'ended' ? NOW : null,
    })
    .run()
  return id
}

function participationError(run: () => unknown): ParticipationError {
  try {
    run()
  } catch (error) {
    assert.ok(
      error instanceof ParticipationError,
      `expected a ParticipationError, received ${String(error)}`,
    )
    return error
  }
  assert.fail('expected the participation service to reject the request')
}

function storedParticipations(db: AppDatabase, activityId: string) {
  return db
    .select()
    .from(activityParticipations)
    .where(eq(activityParticipations.activityId, activityId))
    .all()
}

function auditMetadata(db: AppDatabase, event: string): Record<string, string>[] {
  return db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.event, event))
    .all()
    .map((row) => JSON.parse(row.metadata ?? '{}') as Record<string, string>)
}

function isUniqueViolation(error: unknown, message: RegExp): boolean {
  return error instanceof Error && message.test(error.message)
}

function withTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('A/B/C fill the three seats, lock the team in the same transaction and reject the fourth resident', () => {
  const { db, sqlite, communityId } = createFixture()
  try {
    const userA = addUser(db, '张三')
    const userB = addUser(db, '李四')
    const userC = addUser(db, '王五')
    const userD = addUser(db, '赵六')
    const activityId = addActivity(db, communityId, userA)

    const first = confirmParticipation(db, { activityId, userId: userA, now: NOW })
    assert.equal(first.created, true)
    assert.equal(first.state.activityStatus, 'published')
    assert.equal(first.state.joinable, false, 'an already participating resident cannot join again')
    assert.equal(first.state.unavailableReason, null)
    assert.equal(first.state.participation?.seatNo, 1)
    assert.equal(first.state.participation?.role, 'leader')
    assert.equal(first.state.participation?.inviteSource, 'self')
    assert.equal(first.state.participation?.invitationId, null)
    assert.equal(first.state.participation?.inviterDisplayName, null)
    assert.equal(first.state.team?.status, 'open')
    assert.equal(first.state.team?.seatsTotal, 3)
    assert.equal(first.state.team?.seatsFilled, 1)
    const teamId = first.state.team!.id
    const inviteCode = first.state.team!.inviteCode
    assert.ok(inviteCode, 'an open team must expose an invite code')
    assert.match(inviteCode, /^[a-f0-9]{32}$/)

    // The state above is backed by rows, not by an in-memory calculation.
    const storedTeam = db.select().from(activityTeams).where(eq(activityTeams.id, teamId)).get()
    assert.equal(storedTeam?.status, 'open')
    assert.equal(storedTeam?.lockedAt, null)
    assert.equal(storedTeam?.leaderUserId, userA)
    const storedInvitation = db
      .select()
      .from(activityInvitations)
      .where(eq(activityInvitations.teamId, teamId))
      .get()
    assert.equal(storedInvitation?.code, inviteCode)
    assert.equal(storedInvitation?.inviterUserId, userA)
    assert.equal(storedInvitation?.activityId, activityId)

    const second = confirmParticipation(db, {
      activityId,
      userId: userB,
      inviteCode,
      now: NOW,
    })
    assert.equal(second.created, true)
    assert.equal(second.state.participation?.seatNo, 2)
    assert.equal(second.state.participation?.role, 'member')
    assert.equal(second.state.participation?.inviteSource, 'invite')
    assert.equal(second.state.participation?.invitationId, storedInvitation?.id)
    assert.equal(second.state.participation?.inviterDisplayName, '张三')
    assert.equal(second.state.team?.id, teamId)
    assert.equal(second.state.team?.status, 'open')
    assert.equal(second.state.team?.seatsFilled, 2)

    const third = confirmParticipation(db, {
      activityId,
      userId: userC,
      inviteCode,
      now: NOW,
    })
    assert.equal(third.created, true)
    assert.equal(third.state.participation?.seatNo, 3)
    assert.equal(third.state.team?.status, 'locked')
    assert.equal(third.state.team?.seatsFilled, 3)
    assert.equal(third.state.team?.inviteCode, null, 'a locked team must stop handing out its code')
    assert.deepEqual(
      third.state.team?.members.map((member) => member.seatNo),
      [1, 2, 3],
    )
    assert.deepEqual(
      third.state.team?.members.map((member) => member.displayName),
      ['张三', '李四', '王五'],
    )
    assert.deepEqual(
      third.state.team?.members.map((member) => member.isSelf),
      [false, false, true],
    )

    // The lock is durable and was written with the third seat, not later.
    const lockedTeam = db.select().from(activityTeams).where(eq(activityTeams.id, teamId)).get()
    assert.equal(lockedTeam?.status, 'locked')
    assert.equal(lockedTeam?.lockedAt?.getTime(), NOW.getTime())
    assert.deepEqual(
      storedParticipations(db, activityId)
        .map((row) => row.seatNo)
        .sort((left, right) => left - right),
      [1, 2, 3],
    )

    const createdAudit = auditMetadata(db, 'participation.created')
    assert.equal(createdAudit.length, 3)
    assert.deepEqual(
      createdAudit.map((metadata) => metadata.seatNo).sort(),
      ['1', '2', '3'],
    )
    const lockedAudit = auditMetadata(db, 'team.locked')
    assert.equal(lockedAudit.length, 1)
    assert.equal(lockedAudit[0]?.teamId, teamId)
    assert.equal(lockedAudit[0]?.seatsFilled, '3')
    for (const metadata of [...createdAudit, ...lockedAudit]) {
      for (const key of Object.keys(metadata)) {
        assert.ok(
          ['teamId', 'seatNo', 'role', 'inviteSource', 'seatsFilled'].includes(key),
          `unexpected audit metadata key ${key}`,
        )
      }
      const raw = JSON.stringify(metadata)
      assert.equal(raw.includes(inviteCode), false, 'audit must never store the invite code')
      assert.equal(/openid|password|token|secret/iu.test(raw), false)
    }

    // The fourth resident can never get a seat four.
    const fourth = participationError(() =>
      confirmParticipation(db, { activityId, userId: userD, inviteCode, now: NOW }),
    )
    assert.equal(fourth.status, 409)
    assert.equal(fourth.code, 'team_full')
    assert.equal(fourth.reason, 'team_full')
    assert.equal(storedParticipations(db, activityId).length, 3)
    assert.equal(
      storedParticipations(db, activityId).some((row) => row.userId === userD),
      false,
    )
    const teamAfterFourth = db
      .select()
      .from(activityTeams)
      .where(eq(activityTeams.id, teamId))
      .get()
    assert.equal(teamAfterFourth?.status, 'locked')
    assert.equal(teamAfterFourth?.lockedAt?.getTime(), NOW.getTime())

    // The rejected resident still sees a truthful state: no team of their own yet.
    const fourthState = getParticipationState(db, {
      activityId,
      userId: userD,
      now: NOW,
    })
    assert.equal(fourthState.participation, null)
    assert.equal(fourthState.team, null)
    assert.equal(fourthState.joinable, true)
  } finally {
    sqlite.close()
  }
})

test('repeated confirm is idempotent and another team invitation never rewrites the frozen attribution', () => {
  const { db, sqlite, communityId } = createFixture()
  try {
    const userA = addUser(db, '团长甲')
    const userB = addUser(db, '成员乙')
    const userC = addUser(db, '团长丙')
    const activityId = addActivity(db, communityId, userA)

    const teamA = confirmParticipation(db, { activityId, userId: userA, now: NOW })
    const codeA = teamA.state.team!.inviteCode!
    const joined = confirmParticipation(db, {
      activityId,
      userId: userB,
      inviteCode: codeA,
      now: NOW,
    })
    assert.equal(joined.created, true)

    // C leads a second, independent team in the same activity.
    const teamC = confirmParticipation(db, { activityId, userId: userC, now: NOW })
    assert.notEqual(teamC.state.team?.id, teamA.state.team?.id)
    const codeC = teamC.state.team!.inviteCode!

    const storedBefore = db
      .select()
      .from(activityParticipations)
      .where(eq(activityParticipations.userId, userB))
      .get()
    assert.ok(storedBefore)

    // Re-confirming with the original code is a no-op.
    const replay = confirmParticipation(db, {
      activityId,
      userId: userB,
      inviteCode: codeA,
      now: NOW,
    })
    assert.equal(replay.created, false)
    assert.equal(replay.state.participation?.id, storedBefore.id)
    assert.equal(replay.state.participation?.seatNo, 2)
    assert.equal(replay.state.team?.id, storedBefore.teamId)

    // Opening C's share link later must not move B or rewrite B's attribution.
    const foreignLink = confirmParticipation(db, {
      activityId,
      userId: userB,
      inviteCode: codeC,
      now: NOW,
    })
    assert.equal(foreignLink.created, false)
    assert.equal(foreignLink.state.participation?.id, storedBefore.id)
    assert.equal(foreignLink.state.participation?.seatNo, 2)
    assert.equal(foreignLink.state.participation?.teamId, storedBefore.teamId)
    assert.equal(foreignLink.state.participation?.invitationId, storedBefore.invitationId)
    assert.equal(foreignLink.state.participation?.inviteSource, 'invite')
    assert.equal(foreignLink.state.team?.id, teamA.state.team?.id)
    assert.equal(foreignLink.state.team?.seatsFilled, 2)
    assert.equal(teamC.state.team?.seatsFilled, 1, 'the other team must not gain a member')

    const storedAfter = db
      .select()
      .from(activityParticipations)
      .where(eq(activityParticipations.userId, userB))
      .get()
    assert.deepEqual(storedAfter, storedBefore, 'the participation row is untouched')
    assert.equal(storedParticipations(db, activityId).length, 3)
    assert.equal(db.select().from(activityTeams).all().length, 2)
  } finally {
    sqlite.close()
  }
})

test('one resident may join a different activity, but never twice in the same one', () => {
  const { db, sqlite, communityId } = createFixture()
  try {
    const userA = addUser(db, '跨场居民')
    const activityOne = addActivity(db, communityId, userA, { title: '第一场' })
    const activityTwo = addActivity(db, communityId, userA, { title: '第二场' })

    const first = confirmParticipation(db, { activityId: activityOne, userId: userA, now: NOW })
    const second = confirmParticipation(db, { activityId: activityTwo, userId: userA, now: NOW })
    assert.equal(first.created, true)
    assert.equal(second.created, true)
    assert.notEqual(first.state.team?.id, second.state.team?.id)
    assert.notEqual(first.state.participation?.id, second.state.participation?.id)
    assert.equal(storedParticipations(db, activityOne).length, 1)
    assert.equal(storedParticipations(db, activityTwo).length, 1)

    // A repeat confirm in the first activity stays in the first team.
    const replay = confirmParticipation(db, { activityId: activityOne, userId: userA, now: NOW })
    assert.equal(replay.created, false)
    assert.equal(replay.state.team?.id, first.state.team?.id)
    assert.equal(storedParticipations(db, activityOne).length, 1)

    // UNIQUE(activity_id, user_id) is the disk-level guard behind the service check.
    const duplicate = {
      id: randomUUID(),
      activityId: activityOne,
      teamId: first.state.team!.id,
      userId: userA,
      seatNo: 1,
      role: 'leader' as const,
      inviteSource: 'self' as const,
      invitationId: null,
      joinedAt: NOW,
    }
    assert.throws(
      () => db.insert(activityParticipations).values(duplicate).run(),
      (error: unknown) => isUniqueViolation(error, /UNIQUE constraint failed/),
    )
  } finally {
    sqlite.close()
  }
})

test('invalid, malformed and cross-activity invite codes are rejected without writing anything', () => {
  const { db, sqlite, communityId } = createFixture()
  try {
    const userA = addUser(db, '团长')
    const userX = addUser(db, '外场团长')
    const userE = addUser(db, '受邀居民')
    const activityOne = addActivity(db, communityId, userA, { title: '本场活动' })
    const activityTwo = addActivity(db, communityId, userX, { title: '另一场活动' })

    confirmParticipation(db, { activityId: activityOne, userId: userA, now: NOW })
    const foreignTeam = confirmParticipation(db, {
      activityId: activityTwo,
      userId: userX,
      now: NOW,
    })
    const foreignCode = foreignTeam.state.team!.inviteCode!

    const teamsBefore = db.select().from(activityTeams).all().length
    const invitationsBefore = db.select().from(activityInvitations).all().length
    const participationsBefore = db.select().from(activityParticipations).all().length

    for (const inviteCode of [
      randomUUID().replaceAll('-', ''), // 32 hex characters that no team owns
      'not-a-valid-invite-code',
      foreignCode.toUpperCase(),
    ]) {
      const error = participationError(() =>
        confirmParticipation(db, {
          activityId: activityOne,
          userId: userE,
          inviteCode,
          now: NOW,
        }),
      )
      assert.equal(error.status, 400)
      assert.equal(error.code, 'invite_invalid')
      assert.equal(error.reason, 'invite_invalid')
    }

    // A code minted for another activity is invalid here, not "team full".
    const crossActivity = participationError(() =>
      confirmParticipation(db, {
        activityId: activityOne,
        userId: userE,
        inviteCode: foreignCode,
        now: NOW,
      }),
    )
    assert.equal(crossActivity.code, 'invite_invalid')
    assert.equal(crossActivity.reason, 'invite_invalid')

    // No half-written team, invitation or participation survived the failures.
    assert.equal(db.select().from(activityTeams).all().length, teamsBefore)
    assert.equal(db.select().from(activityInvitations).all().length, invitationsBefore)
    assert.equal(db.select().from(activityParticipations).all().length, participationsBefore)
    assert.equal(storedParticipations(db, activityOne).some((row) => row.userId === userE), false)

    // The identity of the rejected resident is not leaked between activities.
    const state = getParticipationState(db, { activityId: activityOne, userId: userE, now: NOW })
    assert.equal(state.participation, null)
    assert.equal(state.team, null)
  } finally {
    sqlite.close()
  }
})

test('unpublished, ended and time-expired activities reject participation while reads stay truthful', () => {
  const { db, sqlite, communityId } = createFixture()
  const owner = addUser(db, '活动负责人')
  try {
    const cases: Array<{
      status: ActivityStatus
      endsAt: Date
      expectedStatus: 'published' | 'paused' | 'ended'
      expectedReason: 'activity_not_published' | 'activity_ended'
    }> = [
      {
        status: 'paused',
        endsAt: ACTIVITY_END,
        expectedStatus: 'paused',
        expectedReason: 'activity_not_published',
      },
      {
        status: 'ended',
        endsAt: ACTIVITY_END,
        expectedStatus: 'ended',
        expectedReason: 'activity_ended',
      },
      {
        // Still published in the database, but its end time has passed.
        status: 'published',
        endsAt: new Date('2026-11-01T10:00:00.000Z'),
        expectedStatus: 'published',
        expectedReason: 'activity_ended',
      },
    ]

    for (const scenario of cases) {
      const activityId = addActivity(db, communityId, owner, {
        status: scenario.status,
        endsAt: scenario.endsAt,
        title: `${scenario.status}-${scenario.expectedReason}`,
      })
      const resident = addUser(db, '居民')

      const state = getParticipationState(db, { activityId, userId: resident, now: NOW })
      assert.equal(state.activityStatus, scenario.expectedStatus)
      assert.equal(state.joinable, false)
      assert.equal(state.unavailableReason, scenario.expectedReason)
      assert.equal(state.participation, null)
      assert.equal(state.team, null)

      const error = participationError(() =>
        confirmParticipation(db, { activityId, userId: resident, now: NOW }),
      )
      assert.equal(error.status, 409)
      assert.equal(error.code, 'activity_unavailable')
      assert.equal(error.reason, 'activity_unavailable')
      assert.equal(storedParticipations(db, activityId).length, 0)
      assert.equal(
        db.select().from(activityTeams).where(eq(activityTeams.activityId, activityId)).all().length,
        0,
      )
    }

    // Pre-registration after publish and before the end time is allowed.
    const upcoming = addActivity(db, communityId, owner, {
      startsAt: new Date('2026-12-20T02:00:00.000Z'),
      endsAt: new Date('2026-12-20T10:00:00.000Z'),
      title: '可预报名活动',
    })
    const earlyResident = addUser(db, '预报名居民')
    const upcomingState = getParticipationState(db, {
      activityId: upcoming,
      userId: earlyResident,
      now: NOW,
    })
    assert.equal(upcomingState.joinable, true)
    assert.equal(upcomingState.unavailableReason, null)
    const confirmed = confirmParticipation(db, {
      activityId: upcoming,
      userId: earlyResident,
      now: NOW,
    })
    assert.equal(confirmed.created, true)

    // An existing team is still readable after the activity is paused, but no new
    // participation can be confirmed.
    const pausedExisting = addActivity(db, communityId, owner, { title: '暂停但已有团' })
    const leader = addUser(db, '暂停场团长')
    const seeded = confirmParticipation(db, {
      activityId: pausedExisting,
      userId: leader,
      now: new Date('2026-11-04T09:00:00.000Z'),
    })
    db.update(activities)
      .set({ status: 'paused', pausedAt: NOW })
      .where(eq(activities.id, pausedExisting))
      .run()
    const pausedState = getParticipationState(db, {
      activityId: pausedExisting,
      userId: leader,
      now: NOW,
    })
    assert.equal(pausedState.participation?.id, seeded.state.participation?.id)
    assert.equal(pausedState.team?.id, seeded.state.team?.id)
    assert.equal(pausedState.joinable, false)
    assert.equal(pausedState.unavailableReason, 'activity_not_published')
    const lateJoiner = addUser(db, '迟到居民')
    assert.equal(
      participationError(() =>
        confirmParticipation(db, {
          activityId: pausedExisting,
          userId: lateJoiner,
          inviteCode: seeded.state.team!.inviteCode!,
          now: NOW,
        }),
      ).code,
      'activity_unavailable',
    )
  } finally {
    sqlite.close()
  }
})

test('the service distinguishes a missing activity from a draft, both hidden behind 404', () => {
  const { db, sqlite, communityId } = createFixture()
  try {
    const owner = addUser(db, '负责人')
    const resident = addUser(db, '居民')
    const draftId = addActivity(db, communityId, owner, { status: 'draft', title: '草稿活动' })

    const draftState = participationError(() =>
      getParticipationState(db, { activityId: draftId, userId: resident, now: NOW }),
    )
    assert.equal(draftState.status, 404)
    assert.equal(draftState.code, 'not_found')
    assert.equal(draftState.reason, 'activity_draft')

    const draftConfirm = participationError(() =>
      confirmParticipation(db, { activityId: draftId, userId: resident, now: NOW }),
    )
    assert.equal(draftConfirm.status, 404)
    assert.equal(draftConfirm.code, 'not_found')
    assert.equal(draftConfirm.reason, 'activity_draft')

    const missingId = randomUUID()
    const missingState = participationError(() =>
      getParticipationState(db, { activityId: missingId, userId: resident, now: NOW }),
    )
    assert.equal(missingState.status, 404)
    assert.equal(missingState.code, 'not_found')
    assert.equal(missingState.reason, 'activity_not_found')

    const missingConfirm = participationError(() =>
      confirmParticipation(db, { activityId: missingId, userId: resident, now: NOW }),
    )
    assert.equal(missingConfirm.reason, 'activity_not_found')
    assert.equal(storedParticipations(db, draftId).length, 0)
    assert.equal(
      db.select().from(activityTeams).where(eq(activityTeams.activityId, draftId)).all().length,
      0,
    )
  } finally {
    sqlite.close()
  }
})

test('migration 0002 applies to an empty database with its indexes, foreign keys and triggers', () => {
  const temp = withTempDir('ll-participation-migrate-')
  const databasePath = join(temp.dir, 'fresh.sqlite')
  const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
  try {
    const tableNames = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const table of [
      'activity_teams',
      'activity_invitations',
      'activity_participations',
      'activities',
      'activity_rule_versions',
      'audit_logs',
    ]) {
      assert.ok(tableNames.includes(table), `migration must create ${table}`)
    }

    const indexNames = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const index of [
      'activity_participations_activity_user_uq',
      'activity_participations_team_seat_uq',
      'activity_teams_activity_leader_uq',
      'activity_invitations_code_uq',
      'activity_invitations_team_uq',
    ]) {
      assert.ok(indexNames.includes(index), `migration must create ${index}`)
    }

    const triggerNames = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const trigger of [
      'activity_participations_no_update',
      'activity_participations_no_delete',
      'activity_participations_team_consistency',
      'activity_participations_invitation_scope',
      'activity_teams_no_delete',
      'activity_teams_identity_immutable',
      'activity_teams_status_transition',
      'activity_teams_locked_at_write_once',
      'activity_invitations_no_update',
      'activity_invitations_no_delete',
    ]) {
      assert.ok(triggerNames.includes(trigger), `migration must create ${trigger}`)
    }

    for (const table of [
      'activity_teams',
      'activity_invitations',
      'activity_participations',
    ]) {
      const foreignKeys = sqlite
        .prepare(`PRAGMA foreign_key_list('${table}')`)
        .all() as Array<{ on_delete: string }>
      assert.ok(foreignKeys.length > 0, `${table} must have foreign keys`)
      for (const foreignKey of foreignKeys) {
        assert.equal(
          foreignKey.on_delete.toUpperCase(),
          'RESTRICT',
          `${table} foreign keys must be restrictive`,
        )
      }
    }

    // The three migrations through #60 must remain the exact journal prefix.
    // Later independent features (e.g. CRM 0003) may append new migrations.
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> }
    assert.deepEqual(
      journal.entries.slice(0, 3).map((entry) => entry.tag),
      ['0000_freezing_micromax', '0001_oval_mulholland_black', '0002_nosy_white_queen'],
    )

    // The migrated database is usable end to end, not merely navigable.
    const communityId = randomUUID()
    db.insert(communities).values({ id: communityId, name: '迁移验证社区', createdAt: NOW }).run()
    const leader = addUser(db, '迁移团长')
    const activityId = addActivity(db, communityId, leader)
    const confirmed = confirmParticipation(db, { activityId, userId: leader, now: NOW })
    assert.equal(confirmed.created, true)
    assert.equal(confirmed.state.team?.seatsFilled, 1)
  } finally {
    sqlite.close()
    temp.cleanup()
  }
})

test('triggers reject attribution updates, deletes and any attempt to unlock a full team', () => {
  const { db, sqlite, communityId } = createFixture()
  try {
    const userA = addUser(db, '团长甲')
    const userB = addUser(db, '成员乙')
    const userC = addUser(db, '成员丙')
    const outsider = addUser(db, '外场团长')
    const activityId = addActivity(db, communityId, userA)
    const otherActivityId = addActivity(db, communityId, outsider, { title: '另一场活动' })

    const teamA = confirmParticipation(db, { activityId, userId: userA, now: NOW })
    const codeA = teamA.state.team!.inviteCode!
    confirmParticipation(db, { activityId, userId: userB, inviteCode: codeA, now: NOW })
    confirmParticipation(db, { activityId, userId: userC, inviteCode: codeA, now: NOW })
    const teamId = teamA.state.team!.id
    const foreign = confirmParticipation(db, {
      activityId: otherActivityId,
      userId: outsider,
      now: NOW,
    })
    const foreignInvitationId = db
      .select()
      .from(activityInvitations)
      .where(eq(activityInvitations.teamId, foreign.state.team!.id))
      .get()!.id

    const storedParticipation = db
      .select()
      .from(activityParticipations)
      .where(eq(activityParticipations.userId, userB))
      .get()!
    const storedInvitation = db
      .select()
      .from(activityInvitations)
      .where(eq(activityInvitations.teamId, teamId))
      .get()!

    // Any attribution change on an existing seat is refused at disk level.
    for (const { sql, params } of [
      {
        sql: 'UPDATE activity_participations SET user_id = ? WHERE id = ?',
        params: [randomUUID(), storedParticipation.id],
      },
      {
        sql: 'UPDATE activity_participations SET team_id = ? WHERE id = ?',
        params: [randomUUID(), storedParticipation.id],
      },
      {
        sql: 'UPDATE activity_participations SET activity_id = ? WHERE id = ?',
        params: [randomUUID(), storedParticipation.id],
      },
      {
        sql: 'UPDATE activity_participations SET invitation_id = ? WHERE id = ?',
        params: [randomUUID(), storedParticipation.id],
      },
      {
        sql: 'UPDATE activity_participations SET invite_source = ? WHERE id = ?',
        params: ['self', storedParticipation.id],
      },
      {
        sql: 'UPDATE activity_participations SET seat_no = 1 WHERE id = ?',
        params: [storedParticipation.id],
      },
    ]) {
      assert.throws(
        () => sqlite.prepare(sql).run(...params),
        /immutable/,
        `${sql} must be rejected`,
      )
    }

    for (const statement of [
      'DELETE FROM activity_participations WHERE id = ?',
      'DELETE FROM activity_teams WHERE id = ?',
      'DELETE FROM activity_invitations WHERE id = ?',
    ]) {
      const target = statement.includes('activity_teams')
        ? teamId
        : statement.includes('activity_invitations')
          ? storedInvitation.id
          : storedParticipation.id
      assert.throws(() => sqlite.prepare(statement).run(target), /immutable/)
    }

    // A 3/3 team is locked for good: no unlock, no clearing of locked_at.
    assert.throws(
      () => sqlite.prepare("UPDATE activity_teams SET status = 'open' WHERE id = ?").run(teamId),
      /open to locked/,
    )
    assert.throws(
      () => sqlite.prepare('UPDATE activity_teams SET locked_at = NULL WHERE id = ?').run(teamId),
      /write-once/,
    )
    assert.throws(
      () => sqlite.prepare('UPDATE activity_teams SET leader_user_id = ? WHERE id = ?').run(userB, teamId),
      /immutable/,
    )
    assert.throws(
      () => sqlite.prepare('UPDATE activity_invitations SET code = ? WHERE id = ?').run('f'.repeat(32), storedInvitation.id),
      /immutable/,
    )

    // Roster guards: no fourth seat, no duplicate seat and no cross-activity mix.
    assert.throws(
      () =>
        sqlite
          .prepare(
            'INSERT INTO activity_participations (id, activity_id, team_id, user_id, seat_no, role, invite_source, invitation_id, joined_at) VALUES (?, ?, ?, ?, 4, ?, ?, ?, ?)',
          )
          .run(randomUUID(), activityId, teamId, outsider, 'member', 'invite', storedInvitation.id, NOW.getTime()),
      /CHECK constraint failed/,
    )
    // A taken seat cannot receive a second resident.
    assert.throws(
      () =>
        sqlite
          .prepare(
            'INSERT INTO activity_participations (id, activity_id, team_id, user_id, seat_no, role, invite_source, invitation_id, joined_at) VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?)',
          )
          .run(randomUUID(), activityId, teamId, outsider, 'member', 'invite', storedInvitation.id, NOW.getTime()),
      /UNIQUE constraint failed/,
    )
    // A leader seat must belong to the team's own leader.
    assert.throws(
      () =>
        sqlite
          .prepare(
            'INSERT INTO activity_participations (id, activity_id, team_id, user_id, seat_no, role, invite_source, invitation_id, joined_at) VALUES (?, ?, ?, ?, 3, ?, ?, ?, ?)',
          )
          .run(randomUUID(), activityId, teamId, outsider, 'leader', 'self', null, NOW.getTime()),
      /must match its team/,
    )
    // A team from another activity cannot host this activity's participation.
    assert.throws(
      () =>
        sqlite
          .prepare(
            'INSERT INTO activity_participations (id, activity_id, team_id, user_id, seat_no, role, invite_source, invitation_id, joined_at) VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?)',
          )
          .run(randomUUID(), activityId, foreign.state.team!.id, userB, 'member', 'invite', foreignInvitationId, NOW.getTime()),
      /must match its team|invitation must belong/,
    )
    // An invitation from another activity cannot be frozen into this activity.
    assert.throws(
      () =>
        sqlite
          .prepare(
            'INSERT INTO activity_participations (id, activity_id, team_id, user_id, seat_no, role, invite_source, invitation_id, joined_at) VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?)',
          )
          .run(randomUUID(), activityId, teamId, outsider, 'member', 'invite', foreignInvitationId, NOW.getTime()),
      /invitation must belong/,
    )
    // Two participations for the same resident in one activity are impossible,
    // even in another team of the same activity.
    const extraLeader = addUser(db, '额外团长')
    const extraTeam = confirmParticipation(db, { activityId, userId: extraLeader, now: NOW })
    const extraInvitation = db
      .select()
      .from(activityInvitations)
      .where(eq(activityInvitations.teamId, extraTeam.state.team!.id))
      .get()!
    assert.throws(
      () =>
        sqlite
          .prepare(
            'INSERT INTO activity_participations (id, activity_id, team_id, user_id, seat_no, role, invite_source, invitation_id, joined_at) VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?)',
          )
          .run(randomUUID(), activityId, extraTeam.state.team!.id, userB, 'member', 'invite', extraInvitation.id, NOW.getTime()),
      /UNIQUE constraint failed/,
    )
    // One resident cannot lead two teams in the same activity.
    assert.throws(
      () =>
        sqlite
          .prepare(
            "INSERT INTO activity_teams (id, activity_id, leader_user_id, status, created_at) VALUES (?, ?, ?, 'open', ?)",
          )
          .run(randomUUID(), activityId, userA, NOW.getTime()),
      /UNIQUE constraint failed/,
    )
    // Invite codes are unique and must keep the 32 lowercase hex shape. An
    // invitation-less team isolates the code constraint from UNIQUE(team_id).
    const codeOnlyLeader = addUser(db, '待发码团长')
    const codeOnlyTeamId = randomUUID()
    sqlite
      .prepare(
        "INSERT INTO activity_teams (id, activity_id, leader_user_id, status, created_at) VALUES (?, ?, ?, 'open', ?)",
      )
      .run(codeOnlyTeamId, activityId, codeOnlyLeader, NOW.getTime())
    assert.throws(
      () =>
        sqlite
          .prepare(
            'INSERT INTO activity_invitations (id, code, activity_id, team_id, inviter_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(randomUUID(), storedInvitation.code, activityId, codeOnlyTeamId, codeOnlyLeader, NOW.getTime()),
      /UNIQUE constraint failed/,
    )
    assert.throws(
      () =>
        sqlite
          .prepare(
            'INSERT INTO activity_invitations (id, code, activity_id, team_id, inviter_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(randomUUID(), 'ZZZZ', activityId, codeOnlyTeamId, codeOnlyLeader, NOW.getTime()),
      /CHECK constraint failed/,
    )

    // Nothing above changed the committed team.
    assert.equal(
      db.select().from(activityParticipations).where(eq(activityParticipations.teamId, teamId)).all().length,
      3,
    )
    assert.equal(db.select().from(activityTeams).where(eq(activityTeams.id, teamId)).get()?.status, 'locked')
  } finally {
    sqlite.close()
  }
})

/* ------------------------- multi-process race proof ------------------------- */

interface RaceResult {
  ok: boolean
  created?: boolean
  seatsFilled?: number
  seatNo?: number
  teamStatus?: string
  code?: string | null
  reason?: string | null
  message?: string
  attemptedAt: number
  finishedAt: number
}

interface RaceChild {
  ready: Promise<void>
  go: () => void
  result: Promise<RaceResult>
  kill: () => void
}

const RACE_CHILD_SOURCE = (serviceUrl: string, schemaUrl: string) => `
import readline from 'node:readline'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { confirmParticipation } from ${JSON.stringify(serviceUrl)}
import * as schema from ${JSON.stringify(schemaUrl)}

const [databasePath, activityId, userId, inviteCode] = process.argv.slice(2)
const sqlite = new Database(databasePath)
sqlite.pragma('foreign_keys = ON')
sqlite.pragma('busy_timeout = 5000')
const db = drizzle(sqlite, { schema })

process.stdout.write('ready\\n')
const rl = readline.createInterface({ input: process.stdin })
rl.once('line', () => {
  const attemptedAt = Date.now()
  let payload
  try {
    const result = confirmParticipation(db, { activityId, userId, inviteCode })
    payload = {
      ok: true,
      created: result.created,
      seatsFilled: result.state.team.seatsFilled,
      seatNo: result.state.participation.seatNo,
      teamStatus: result.state.team.status,
      attemptedAt,
      finishedAt: Date.now(),
    }
  } catch (error) {
    payload = {
      ok: false,
      code: error?.code ?? null,
      reason: error?.reason ?? null,
      message: error?.message ?? String(error),
      attemptedAt,
      finishedAt: Date.now(),
    }
  }
  process.stdout.write(JSON.stringify(payload) + '\\n', () => {
    try {
      sqlite.close()
    } catch {}
    rl.close()
    process.exit(0)
  })
})
`

function spawnRaceChild(scriptPath: string, args: string[]): RaceChild {
  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    cwd: apiRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let markReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    if (stdout.includes('ready')) markReady()
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const result = new Promise<RaceResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`race child timed out\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, 30_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const payload = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{'))
        .at(-1)
      if (code !== 0 || payload === undefined) {
        reject(new Error(`race child exited with ${code}\nstdout: ${stdout}\nstderr: ${stderr}`))
        return
      }
      resolve(JSON.parse(payload) as RaceResult)
    })
  })
  void result.catch(() => {})
  return {
    ready,
    go: () => {
      child.stdin.write('go\n')
    },
    result,
    kill: () => child.kill('SIGKILL'),
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

test('two independent SQLite connections race for the last seat: exactly one wins and seats stay at three', async () => {
  const temp = withTempDir('ll-participation-race-')
  const databasePath = join(temp.dir, 'race.sqlite')
  const first = createDatabase(databasePath, migrationsFolder)
  const children: RaceChild[] = []
  try {
    const activityEnd = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const communityId = randomUUID()
    first.db
      .insert(communities)
      .values({ id: communityId, name: '并发验证社区', createdAt: NOW })
      .run()
    const leader = addUser(first.db, '团长')
    const member = addUser(first.db, '第二位成员')
    const contenderOne = addUser(first.db, '抢席一')
    const contenderTwo = addUser(first.db, '抢席二')
    const activityId = addActivity(first.db, communityId, leader, {
      startsAt: new Date(),
      endsAt: activityEnd,
      title: '并发抢最后一席',
    })

    const leaderState = confirmParticipation(first.db, { activityId, userId: leader })
    const inviteCode = leaderState.state.team!.inviteCode!
    const memberState = confirmParticipation(first.db, {
      activityId,
      userId: member,
      inviteCode,
    })
    assert.equal(memberState.state.team?.seatsFilled, 2)
    const teamId = leaderState.state.team!.id

    // Each worker process gets its own better-sqlite3 connection to this file.
    symlinkSync(join(apiRoot, 'node_modules'), join(temp.dir, 'node_modules'), 'dir')
    const scriptPath = join(temp.dir, 'race-child.mjs')
    writeFileSync(
      scriptPath,
      RACE_CHILD_SOURCE(
        new URL('../src/participation/service.ts', import.meta.url).href,
        new URL('../src/db/schema.ts', import.meta.url).href,
      ),
    )

    const contender = (userId: string) =>
      spawnRaceChild(scriptPath, [databasePath, activityId, userId, inviteCode])
    const one = contender(contenderOne)
    const two = contender(contenderTwo)
    children.push(one, two)

    await withTimeout(Promise.all([one.ready, two.ready]), 30_000, 'race children startup')

    // Hold SQLite's write lock so both workers queue behind the same lock before
    // either can read the roster: this is a real race, not two serial calls.
    first.sqlite.prepare('BEGIN IMMEDIATE').run()
    one.go()
    two.go()
    await new Promise((resolve) => setTimeout(resolve, 500))
    first.sqlite.prepare('COMMIT').run()
    const commitAt = Date.now()

    const [resultOne, resultTwo] = await withTimeout(
      Promise.all([one.result, two.result]),
      30_000,
      'race children result',
    )

    // Both workers were genuinely blocked on the lock and resolved after it.
    for (const result of [resultOne, resultTwo]) {
      assert.ok(
        result.attemptedAt <= commitAt,
        `worker attempted at ${result.attemptedAt}, expected before commit ${commitAt}`,
      )
      assert.ok(
        result.finishedAt >= commitAt,
        `worker finished at ${result.finishedAt}, expected after commit ${commitAt}`,
      )
    }

    const successes = [resultOne, resultTwo].filter((result) => result.ok)
    const failures = [resultOne, resultTwo].filter((result) => !result.ok)
    assert.equal(successes.length, 1, `exactly one seat must be granted: ${JSON.stringify([resultOne, resultTwo])}`)
    assert.equal(failures.length, 1)
    assert.equal(successes[0]?.created, true)
    assert.equal(successes[0]?.seatNo, 3)
    assert.equal(successes[0]?.teamStatus, 'locked')
    assert.equal(successes[0]?.seatsFilled, 3)
    assert.equal(failures[0]?.code, 'team_full')
    assert.equal(failures[0]?.reason, 'team_full')

    // Disk truth agrees: three seats, locked once, no fourth row, no lost update.
    const finalParticipations = first.db
      .select()
      .from(activityParticipations)
      .where(eq(activityParticipations.teamId, teamId))
      .all()
    assert.equal(finalParticipations.length, 3)
    assert.deepEqual(
      finalParticipations.map((row) => row.seatNo).sort((left, right) => left - right),
      [1, 2, 3],
    )
    assert.equal(new Set(finalParticipations.map((row) => row.userId)).size, 3)
    const finalTeam = first.db.select().from(activityTeams).where(eq(activityTeams.id, teamId)).get()
    assert.equal(finalTeam?.status, 'locked')
    assert.ok(finalTeam?.lockedAt instanceof Date)
    assert.equal(
      first.db.select().from(auditLogs).where(eq(auditLogs.event, 'team.locked')).all().length,
      1,
      'the team must lock exactly once',
    )
    assert.equal(
      first.db
        .select()
        .from(activityParticipations)
        .where(eq(activityParticipations.activityId, activityId))
        .all()
        .length,
      3,
    )
  } finally {
    for (const child of children) child.kill()
    first.sqlite.close()
    temp.cleanup()
  }
})

test('the service returns the same durable state to a fresh connection', () => {
  const temp = withTempDir('ll-participation-reopen-')
  const databasePath = join(temp.dir, 'persist.sqlite')
  const first = createDatabase(databasePath, migrationsFolder)
  try {
    const communityId = randomUUID()
    first.db.insert(communities).values({ id: communityId, name: '持久化社区', createdAt: NOW }).run()
    const leader = addUser(first.db, '团长')
    const member = addUser(first.db, '成员')
    const activityId = addActivity(first.db, communityId, leader)
    const leaderState = confirmParticipation(first.db, { activityId, userId: leader, now: NOW })
    const joined = confirmParticipation(first.db, {
      activityId,
      userId: member,
      inviteCode: leaderState.state.team!.inviteCode!,
      now: NOW,
    })
    const before = getParticipationState(first.db, { activityId, userId: member, now: NOW })
    assert.deepEqual(before, joined.state)
    first.sqlite.close()

    const second = createDatabase(databasePath, migrationsFolder)
    try {
      const after: ActivityParticipationState = getParticipationState(second.db, {
        activityId,
        userId: member,
        now: NOW,
      })
      assert.deepEqual(after, before, 'a reopened connection must see the identical state')
      const replay = confirmParticipation(second.db, {
        activityId,
        userId: member,
        inviteCode: leaderState.state.team!.inviteCode!,
        now: NOW,
      })
      assert.equal(replay.created, false)
      assert.deepEqual(replay.state, before)
    } finally {
      second.sqlite.close()
    }
  } finally {
    temp.cleanup()
  }
})
