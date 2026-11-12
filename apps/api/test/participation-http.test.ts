import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import {
  API_ERROR_CODES,
  activityParticipationConfirmResponseSchema,
  activityParticipationStateSchema,
  type ActivityParticipationConfirmResponse,
  type ActivityParticipationState,
  type ActivityStatus,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activities,
  activityInvitations,
  activityParticipations,
  activityTeams,
  communities,
} from '../src/db/schema.js'
import { confirmCommunityOrFail } from './resident-community-fixtures.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ORIGIN = 'http://localhost:5173'
const NOW = new Date('2026-11-04T10:00:00.000Z')

const PUBLIC_RULES_JSON = JSON.stringify({
  eligibility: '本社区 60 岁以上居民',
  checkin: '到社区服务中心签到并领取参与卡',
  purchase: '现场购买指定套餐一份',
  prizeClaim: '凭核销码领取，每人限一次',
  notes: '活动最终解释权归社区所有',
})

type App = ReturnType<typeof createApp>

interface ResidentSession {
  cookies: string
  csrfToken: string
  userId: string
}

interface Fixture {
  app: App
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  communityId: string
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

function cookieHeader(...pairs: string[]) {
  return pairs.join('; ')
}

async function csrf(app: App) {
  const response = await app.request('/auth/csrf')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { csrfToken: string }
  return { token: body.csrfToken, cookie: cookiePair(response, 'll_csrf') }
}

/**
 * Creates a real resident account and session through the documented dev login,
 * then — #171 LL-IDENTITY-001 — confirms `communityId` as the resident's permanent
 * community through `POST /resident-community/confirm`.
 *
 * Joining a team is a community-scoped write, so without that confirmation the
 * service now answers 403 `resident_community_not_bound`. The confirmation here is
 * the resident's own real first confirmation, not a test bypass.
 */
async function residentSession(
  app: App,
  displayName: string,
  communityId: string,
): Promise<ResidentSession> {
  const csrfState = await csrf(app)
  const response = await app.request('/auth/dev/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: csrfState.cookie,
      'x-csrf-token': csrfState.token,
      origin: ORIGIN,
    },
    body: JSON.stringify({ displayName }),
  })
  assert.equal(response.status, 200, 'resident dev login must succeed')
  const body = (await response.json()) as {
    authenticated: boolean
    user: { id: string }
    csrfToken: string
  }
  assert.equal(body.authenticated, true)
  const session: ResidentSession = {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: body.csrfToken,
    userId: body.user.id,
  }
  await confirmCommunityOrFail(app, session, communityId, ORIGIN)
  return session
}

interface ApiOptions {
  session?: ResidentSession
  body?: unknown
  /** CSRF defaults to required for every non-GET request. */
  csrf?: boolean
  origin?: string | null
}

function api(app: App, method: string, path: string, options: ApiOptions = {}) {
  const { session, body, csrf: withCsrf = method !== 'GET', origin = ORIGIN } = options
  const headers: Record<string, string> = {}
  if (session) headers.cookie = session.cookies
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (session && withCsrf) {
    headers['x-csrf-token'] = session.csrfToken
    if (origin !== null) headers.origin = origin
  }
  return app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function participationPath(activityId: string) {
  return `/activities/${activityId}/participation`
}

async function confirmResponse(response: Response): Promise<ActivityParticipationConfirmResponse> {
  return activityParticipationConfirmResponseSchema.parse(await response.json())
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string; message: string } }
  return body.error.code
}

async function getState(
  app: App,
  session: ResidentSession,
  activityId: string,
): Promise<ActivityParticipationState> {
  const response = await api(app, 'GET', participationPath(activityId), { session })
  assert.equal(response.status, 200, 'GET participation must succeed')
  return activityParticipationStateSchema.parse(await response.json())
}

function postConfirm(
  app: App,
  session: ResidentSession,
  activityId: string,
  body: Record<string, unknown> = {},
) {
  return api(app, 'POST', participationPath(activityId), { session, body })
}

interface ActivityOptions {
  status?: ActivityStatus
  endsAt?: Date
}

function addActivity(
  db: AppDatabase,
  communityId: string,
  createdByUserId: string,
  options: ActivityOptions = {},
): string {
  const status = options.status ?? 'published'
  const endsAt = options.endsAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  const id = randomUUID()
  db.insert(activities)
    .values({
      id,
      communityId,
      title: '银发社区欢乐季',
      summary: '秋季社区敬老活动',
      description: '面向本社区 60 岁以上居民的线下活动',
      status,
      startsAt: new Date(endsAt.getTime() - 2 * 60 * 60 * 1000),
      endsAt,
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

function countParticipations(db: AppDatabase, activityId: string): number {
  return db
    .select({ id: activityParticipations.id })
    .from(activityParticipations)
    .where(eq(activityParticipations.activityId, activityId))
    .all().length
}

function countTeams(db: AppDatabase, activityId: string): number {
  return db
    .select({ id: activityTeams.id })
    .from(activityTeams)
    .where(eq(activityTeams.activityId, activityId))
    .all().length
}

function countInvitations(db: AppDatabase, activityId: string): number {
  return db
    .select({ id: activityInvitations.id })
    .from(activityInvitations)
    .where(eq(activityInvitations.activityId, activityId))
    .all().length
}

function testContext(): Fixture {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const app = createApp({ db, config, logRequests: false })
  const communityId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '幸福社区', createdAt: NOW }).run()
  return { app, db, sqlite, communityId }
}

test('A/B/C form a locked 3/3 team over HTTP; the fourth is rejected and re-confirm is idempotent', async () => {
  const { app, db, sqlite, communityId } = testContext()
  try {
    const residentA = await residentSession(app, '居民A', communityId)
    const residentB = await residentSession(app, '居民B', communityId)
    const residentC = await residentSession(app, '居民C', communityId)
    const residentD = await residentSession(app, '居民D', communityId)
    const activityId = addActivity(db, communityId, residentA.userId)

    const firstResponse = await postConfirm(app, residentA, activityId)
    assert.equal(firstResponse.status, 200)
    const first = await confirmResponse(firstResponse)
    assert.equal(first.created, true)
    assert.equal(first.state.activityStatus, 'published')
    assert.equal(first.state.joinable, false)
    assert.equal(first.state.unavailableReason, null)
    assert.equal(first.state.participation?.seatNo, 1)
    assert.equal(first.state.participation?.role, 'leader')
    assert.equal(first.state.participation?.inviteSource, 'self')
    assert.equal(first.state.participation?.invitationId, null)
    assert.equal(first.state.team?.seatsTotal, 3)
    assert.equal(first.state.team?.seatsFilled, 1)
    assert.equal(first.state.team?.status, 'open')
    const inviteCode = first.state.team?.inviteCode
    assert.ok(inviteCode, 'the leader team must expose a round-trippable invite code')
    assert.match(inviteCode, /^[a-f0-9]{32}$/)
    const teamId = first.state.team?.id

    const secondResponse = await postConfirm(app, residentB, activityId, { inviteCode })
    assert.equal(secondResponse.status, 200)
    const second = await confirmResponse(secondResponse)
    assert.equal(second.created, true)
    assert.equal(second.state.participation?.seatNo, 2)
    assert.equal(second.state.participation?.inviteSource, 'invite')
    assert.equal(second.state.team?.seatsFilled, 2)

    const thirdResponse = await postConfirm(app, residentC, activityId, { inviteCode })
    assert.equal(thirdResponse.status, 200)
    const third = await confirmResponse(thirdResponse)
    assert.equal(third.created, true)
    assert.equal(third.state.participation?.seatNo, 3)
    assert.equal(third.state.team?.seatsFilled, 3)
    assert.equal(third.state.team?.status, 'locked')
    assert.equal(third.state.team?.inviteCode, null)
    assert.equal(third.state.team?.id, teamId)
    assert.deepEqual(
      third.state.team?.members.map((member) => member.seatNo),
      [1, 2, 3],
    )
    assert.deepEqual(
      third.state.team?.members.map((member) => member.isSelf),
      [false, false, true],
    )

    const fourthResponse = await postConfirm(app, residentD, activityId, { inviteCode })
    assert.equal(fourthResponse.status, 409)
    assert.equal(await errorCode(fourthResponse), API_ERROR_CODES.teamFull)
    const fourthState = await getState(app, residentD, activityId)
    assert.equal(fourthState.participation, null)
    assert.equal(fourthState.team, null)
    // `joinable` describes whether D may confirm at all; it is still true because
    // a resident can start another team. The full team only rejects the confirm
    // that presents its invite code (409 team_full above).
    assert.equal(fourthState.joinable, true)

    // GET must reflect the same persisted state the POST responses returned.
    const thirdState = await getState(app, residentC, activityId)
    assert.deepEqual(thirdState, third.state)
    const firstState = await getState(app, residentA, activityId)
    assert.equal(firstState.participation?.seatNo, 1)
    assert.equal(firstState.team?.id, teamId)
    assert.equal(firstState.team?.seatsFilled, 3)
    assert.deepEqual(
      firstState.team?.members.map((member) => member.isSelf),
      [true, false, false],
    )

    const repeatResponse = await postConfirm(app, residentA, activityId)
    assert.equal(repeatResponse.status, 200)
    const repeat = await confirmResponse(repeatResponse)
    assert.equal(repeat.created, false)
    assert.deepEqual(repeat.state, firstState)

    // B already joined; re-confirming with the share link must not move the seat
    // or rewrite the frozen attribution.
    const bRepeatResponse = await postConfirm(app, residentB, activityId, { inviteCode })
    assert.equal(bRepeatResponse.status, 200)
    const bRepeat = await confirmResponse(bRepeatResponse)
    assert.equal(bRepeat.created, false)
    assert.equal(bRepeat.state.participation?.seatNo, 2)
    assert.equal(
      bRepeat.state.participation?.invitationId,
      second.state.participation?.invitationId,
    )
    assert.equal(bRepeat.state.team?.status, 'locked')
    assert.equal(bRepeat.state.team?.seatsFilled, 3)

    assert.equal(countParticipations(db, activityId), 3)
    assert.equal(countTeams(db, activityId), 1)
    assert.equal(countInvitations(db, activityId), 1)
    const storedTeam = db.select().from(activityTeams).where(eq(activityTeams.id, teamId!)).get()
    assert.equal(storedTeam?.status, 'locked')
  } finally {
    sqlite.close()
  }
})

test('participation HTTP rejects missing session/CSRF, forged userId and invalid invite codes without writes', async () => {
  const { app, db, sqlite, communityId } = testContext()
  try {
    const residentA = await residentSession(app, '居民A', communityId)
    const residentB = await residentSession(app, '居民B', communityId)
    const activityId = addActivity(db, communityId, residentA.userId)
    const path = participationPath(activityId)

    const anonymousGet = await api(app, 'GET', path)
    assert.equal(anonymousGet.status, 401)
    assert.equal(await errorCode(anonymousGet), API_ERROR_CODES.unauthorized)
    const anonymousPost = await api(app, 'POST', path, { body: {} })
    assert.equal(anonymousPost.status, 401)

    const missingCsrf = await api(app, 'POST', path, { session: residentA, body: {}, csrf: false })
    assert.equal(missingCsrf.status, 403)
    assert.equal(await errorCode(missingCsrf), API_ERROR_CODES.forbidden)

    const untrustedOrigin = await api(app, 'POST', path, {
      session: residentA,
      body: {},
      origin: 'https://evil.example',
    })
    assert.equal(untrustedOrigin.status, 403)

    // A forged userId must fail the strict body schema; B must not be joined by A.
    const forged = await postConfirm(app, residentA, activityId, { userId: residentB.userId })
    assert.equal(forged.status, 400)
    assert.equal(await errorCode(forged), API_ERROR_CODES.invalidRequest)
    assert.equal(countParticipations(db, activityId), 0)
    assert.equal(countTeams(db, activityId), 0)
    assert.equal(countInvitations(db, activityId), 0)
    assert.equal((await getState(app, residentA, activityId)).participation, null)
    assert.equal((await getState(app, residentB, activityId)).participation, null)

    const invalidInvite = await postConfirm(app, residentA, activityId, {
      inviteCode: 'e'.repeat(32),
    })
    assert.equal(invalidInvite.status, 400)
    assert.equal(await errorCode(invalidInvite), API_ERROR_CODES.inviteInvalid)
    assert.equal(countParticipations(db, activityId), 0)

    // A code minted for another activity is indistinguishable from a fake one.
    const otherActivityId = addActivity(db, communityId, residentA.userId)
    const otherResponse = await postConfirm(app, residentA, otherActivityId)
    assert.equal(otherResponse.status, 200)
    const other = await confirmResponse(otherResponse)
    const otherCode = other.state.team?.inviteCode
    assert.ok(otherCode)
    const crossActivity = await postConfirm(app, residentB, activityId, { inviteCode: otherCode })
    assert.equal(crossActivity.status, 400)
    assert.equal(await errorCode(crossActivity), API_ERROR_CODES.inviteInvalid)
    assert.equal(countParticipations(db, activityId), 0)
    assert.equal(countTeams(db, activityId), 0)
    assert.equal(countInvitations(db, activityId), 0)

    const draftId = addActivity(db, communityId, residentA.userId, { status: 'draft' })
    const draftPost = await postConfirm(app, residentA, draftId)
    assert.equal(draftPost.status, 404)
    assert.equal(await errorCode(draftPost), API_ERROR_CODES.notFound)
    const draftGet = await api(app, 'GET', participationPath(draftId), { session: residentA })
    assert.equal(draftGet.status, 404)

    const missingId = randomUUID()
    const missingPost = await postConfirm(app, residentA, missingId)
    assert.equal(missingPost.status, 404)
    assert.equal(await errorCode(missingPost), API_ERROR_CODES.notFound)
    const missingGet = await api(app, 'GET', participationPath(missingId), { session: residentA })
    assert.equal(missingGet.status, 404)
    const malformedGet = await api(app, 'GET', '/activities/not-a-uuid/participation', {
      session: residentA,
    })
    assert.equal(malformedGet.status, 404)

    const pausedId = addActivity(db, communityId, residentA.userId, { status: 'paused' })
    const pausedPost = await postConfirm(app, residentA, pausedId)
    assert.equal(pausedPost.status, 409)
    assert.equal(await errorCode(pausedPost), API_ERROR_CODES.activityUnavailable)
    const pausedState = await getState(app, residentA, pausedId)
    assert.equal(pausedState.activityStatus, 'paused')
    assert.equal(pausedState.joinable, false)
    assert.equal(pausedState.unavailableReason, 'activity_not_published')

    const endedId = addActivity(db, communityId, residentA.userId, { status: 'ended' })
    const endedPost = await postConfirm(app, residentA, endedId)
    assert.equal(endedPost.status, 409)
    assert.equal(await errorCode(endedPost), API_ERROR_CODES.activityUnavailable)
    const endedState = await getState(app, residentA, endedId)
    assert.equal(endedState.activityStatus, 'ended')
    assert.equal(endedState.joinable, false)
    assert.equal(endedState.unavailableReason, 'activity_ended')

    const expiredId = addActivity(db, communityId, residentA.userId, {
      endsAt: new Date(Date.now() - 60 * 60 * 1000),
    })
    const expiredPost = await postConfirm(app, residentA, expiredId)
    assert.equal(expiredPost.status, 409)
    assert.equal(await errorCode(expiredPost), API_ERROR_CODES.activityUnavailable)
    const expiredState = await getState(app, residentA, expiredId)
    assert.equal(expiredState.activityStatus, 'published')
    assert.equal(expiredState.joinable, false)
    assert.equal(expiredState.unavailableReason, 'activity_ended')

    // Every blocked path above must leave no participation, team or invitation.
    for (const blockedActivityId of [activityId, draftId, pausedId, endedId, expiredId]) {
      assert.equal(countParticipations(db, blockedActivityId), 0)
      assert.equal(countTeams(db, blockedActivityId), 0)
      assert.equal(countInvitations(db, blockedActivityId), 0)
    }
  } finally {
    sqlite.close()
  }
})

test('first confirmed attribution stays frozen and the same resident can team up in another activity', async () => {
  const { app, db, sqlite, communityId } = testContext()
  try {
    const residentA = await residentSession(app, '居民A', communityId)
    const residentB = await residentSession(app, '居民B', communityId)
    const residentC = await residentSession(app, '居民C', communityId)
    const firstActivityId = addActivity(db, communityId, residentA.userId)
    const secondActivityId = addActivity(db, communityId, residentA.userId)

    const leaderResponse = await postConfirm(app, residentA, firstActivityId)
    assert.equal(leaderResponse.status, 200)
    const leader = await confirmResponse(leaderResponse)
    const inviteCode = leader.state.team?.inviteCode
    assert.ok(inviteCode)

    const bResponse = await postConfirm(app, residentB, firstActivityId, { inviteCode })
    assert.equal(bResponse.status, 200)
    const bFirst = await confirmResponse(bResponse)
    assert.equal(bFirst.created, true)
    assert.equal(bFirst.state.participation?.seatNo, 2)
    assert.equal(bFirst.state.participation?.inviteSource, 'invite')
    const bParticipation = bFirst.state.participation

    const cResponse = await postConfirm(app, residentC, firstActivityId, { inviteCode })
    assert.equal(cResponse.status, 200)
    assert.equal((await confirmResponse(cResponse)).state.team?.seatsFilled, 3)

    // B opens the same share link again after the team locked: nothing changes.
    const bAgainResponse = await postConfirm(app, residentB, firstActivityId, { inviteCode })
    assert.equal(bAgainResponse.status, 200)
    const bAgain = await confirmResponse(bAgainResponse)
    assert.equal(bAgain.created, false)
    assert.deepEqual(bAgain.state.participation, bParticipation)
    assert.equal(bAgain.state.team?.seatsFilled, 3)
    assert.equal(bAgain.state.team?.status, 'locked')

    // A resident limited to one team per activity may still join another activity.
    const bOtherResponse = await postConfirm(app, residentB, secondActivityId)
    assert.equal(bOtherResponse.status, 200)
    const bOther = await confirmResponse(bOtherResponse)
    assert.equal(bOther.created, true)
    assert.equal(bOther.state.participation?.seatNo, 1)
    assert.equal(bOther.state.participation?.role, 'leader')
    assert.equal(bOther.state.participation?.inviteSource, 'self')
    assert.notEqual(bOther.state.team?.id, bFirst.state.team?.id)

    // The second activity did not touch the frozen first-activity attribution.
    const bFirstState = await getState(app, residentB, firstActivityId)
    assert.deepEqual(bFirstState.participation, bParticipation)
    const bOtherState = await getState(app, residentB, secondActivityId)
    assert.deepEqual(bOtherState, bOther.state)
    assert.equal(countParticipations(db, firstActivityId), 3)
    assert.equal(countParticipations(db, secondActivityId), 1)
  } finally {
    sqlite.close()
  }
})

test('concurrent HTTP confirms never create a fourth seat', async () => {
  const { app, db, sqlite, communityId } = testContext()
  try {
    const residentA = await residentSession(app, '居民A', communityId)
    const residentB = await residentSession(app, '居民B', communityId)
    const residentC = await residentSession(app, '居民C', communityId)
    const residentD = await residentSession(app, '居民D', communityId)
    const residentE = await residentSession(app, '居民E', communityId)
    const activityId = addActivity(db, communityId, residentA.userId)

    const leaderResponse = await postConfirm(app, residentA, activityId)
    assert.equal(leaderResponse.status, 200)
    const leader = await confirmResponse(leaderResponse)
    const inviteCode = leader.state.team?.inviteCode
    assert.ok(inviteCode)
    const secondResponse = await postConfirm(app, residentB, activityId, { inviteCode })
    assert.equal(secondResponse.status, 200)
    assert.equal((await confirmResponse(secondResponse)).state.team?.seatsFilled, 2)

    // Three residents race for the single remaining seat.
    const contenders = [residentC, residentD, residentE]
    const responses = await Promise.all(
      contenders.map((session) => postConfirm(app, session, activityId, { inviteCode })),
    )
    assert.deepEqual(
      responses.map((response) => response.status).sort((left, right) => left - right),
      [200, 409, 409],
    )
    const winnerIndex = responses.findIndex((response) => response.status === 200)
    const winner = await confirmResponse(responses[winnerIndex]!)
    assert.equal(winner.created, true)
    assert.equal(winner.state.participation?.seatNo, 3)
    assert.equal(winner.state.team?.seatsFilled, 3)
    assert.equal(winner.state.team?.status, 'locked')
    for (const response of responses.filter((candidate) => candidate.status !== 200)) {
      assert.equal(await errorCode(response), API_ERROR_CODES.teamFull)
    }

    const leaderState = await getState(app, residentA, activityId)
    assert.equal(leaderState.team?.seatsFilled, 3)
    assert.equal(leaderState.team?.status, 'locked')
    assert.deepEqual(
      leaderState.team?.members.map((member) => member.seatNo),
      [1, 2, 3],
    )

    assert.equal(countParticipations(db, activityId), 3)
    assert.equal(countTeams(db, activityId), 1)
    assert.equal(countInvitations(db, activityId), 1)
    const storedSeats = db
      .select({ seatNo: activityParticipations.seatNo })
      .from(activityParticipations)
      .where(eq(activityParticipations.activityId, activityId))
      .all()
      .map((row) => row.seatNo)
      .sort((left, right) => left - right)
    assert.deepEqual(storedSeats, [1, 2, 3])
  } finally {
    sqlite.close()
  }
})
