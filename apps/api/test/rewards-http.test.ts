import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import {
  API_ERROR_CODES,
  activityCheckinSchema,
  activityCheckinStateSchema,
  activityRewardClaimResponseSchema,
  activityRewardCredentialSchema,
  activityRewardGrantSchema,
  adminActivityCheckinListSchema,
  adminActivityRewardOverviewSchema,
  rewardRedeemResponseSchema,
  teamRewardStateSchema,
  type ActivityCheckinState,
  type ActivityRewardClaimResponse,
  type ActivityStatus,
  type AdminActivityCheckinList,
  type AdminActivityDetail,
  type RewardRedeemResponse,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import { hashPassword } from '../src/auth/security.js'
import {
  activities,
  activityPrizeStocks,
  activityRewardCodes,
  auditLogs,
  communities,
  staffAccounts,
  staffCommunityAssignments,
  users,
} from '../src/db/schema.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const WEB_ORIGIN = 'http://localhost:5173'
const ADMIN_ORIGIN = 'http://localhost:5174'
const TRUSTED_ORIGIN_HEADER = ADMIN_ORIGIN
const ADMIN_PASSWORD = 'Admin-Password-123!'
const OPERATOR_PASSWORD = 'Operator-Password-123!'
const GRID_PASSWORD = 'Grid-Worker-Password-123!'
const OTHER_GRID_PASSWORD = 'Other-Grid-Password-123!'

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
  userId: string
}

interface ErrorEnvelope {
  error: { code: string; message: string; requestId?: string }
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

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

async function login(app: App, username: string, password: string): Promise<Session> {
  const csrfState = await csrf(app)
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: csrfState.cookie,
      'x-csrf-token': csrfState.token,
      origin: ADMIN_ORIGIN,
    },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(response.status, 200, `${username} should be able to log in`)
  const body = (await response.json()) as { user: { id: string }; csrfToken: string }
  return {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: body.csrfToken,
    userId: body.user.id,
  }
}

async function residentSession(
  app: App,
  displayName: string,
  communityId?: string,
): Promise<Session> {
  const csrfState = await csrf(app)
  const response = await app.request('/auth/dev/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: csrfState.cookie,
      'x-csrf-token': csrfState.token,
      origin: WEB_ORIGIN,
    },
    body: JSON.stringify({ displayName }),
  })
  assert.equal(response.status, 200, 'resident dev login must succeed')
  const body = (await response.json()) as { user: { id: string }; csrfToken: string }
  const session: Session = {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: body.csrfToken,
    userId: body.user.id,
  }
  // #171 LL-IDENTITY-001: login no longer attributes a community. Everything
  // community-scoped (joining a team, check-in, claim, draw, purchase link) now
  // requires the resident's own confirmed binding, so tests that perform such a
  // write confirm the community here — the same `POST /resident-community/confirm`
  // call a real resident makes, with the real CSRF token and Origin.
  if (communityId !== undefined) {
    const confirmed = await app.request('/resident-community/confirm', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: session.cookies,
        'x-csrf-token': session.csrfToken,
        origin: WEB_ORIGIN,
      },
      body: JSON.stringify({ communityId }),
    })
    assert.equal(confirmed.status, 200, `resident confirmation must succeed: ${await confirmed.clone().text()}`)
  }
  return session
}

interface ApiOptions {
  session?: Session
  body?: unknown
  /** CSRF defaults to required for every non-GET request. */
  csrf?: boolean
  origin?: string | null
  /** Send no body at all (exercises the empty-body path). */
  emptyBody?: boolean
  rawBody?: string
}

function api(app: App, method: string, path: string, options: ApiOptions = {}) {
  const {
    session,
    body,
    csrf: withCsrf = method !== 'GET',
    origin = TRUSTED_ORIGIN_HEADER,
    emptyBody = false,
    rawBody,
  } = options
  const headers: Record<string, string> = {}
  if (session) headers.cookie = session.cookies
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
  if (payload !== undefined) headers['content-type'] = 'application/json'
  if (session && withCsrf) {
    headers['x-csrf-token'] = session.csrfToken
    if (origin !== null) headers.origin = origin
  }
  return app.request(path, {
    method,
    headers,
    ...(payload === undefined || emptyBody ? {} : { body: payload }),
  })
}

async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  const body = (await response.json()) as ErrorEnvelope
  assert.equal(typeof body.error?.code, 'string', 'every failure must use the shared error envelope')
  assert.equal(typeof body.error.message, 'string')
  return body
}

async function expectError(
  response: Response,
  status: number,
  code: string,
  label: string,
): Promise<ErrorEnvelope> {
  assert.equal(response.status, status, `${label}: expected HTTP ${status}`)
  const body = await errorEnvelope(response)
  assert.equal(body.error.code, code, `${label}: expected error code ${code}`)
  return body
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface Fixture {
  app: App
  db: AppDatabase
  communityId: string
  otherCommunityId: string
  admin: Session
  operator: Session
  grid: Session
  otherGrid: Session
}

const NOW = new Date()

function rewardPlan(overrides: Record<string, unknown> = {}) {
  return {
    prizeName: '粮油礼包',
    prizeUnitCostCents: 5_000,
    prizeQuantityPerTeam: 1,
    totalPrizeQuantity: 10,
    budgetCapCents: 50_000,
    claimRecipient: 'leader' as const,
    checkinWindow: {
      opensAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      closesAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    },
    redemptionValidHours: 72,
    ...overrides,
  }
}

async function seedStaff(
  db: AppDatabase,
  input: {
    username: string
    password: string
    role: 'admin' | 'operator' | 'grid_worker'
    communityIds?: string[]
  },
): Promise<void> {
  const now = new Date()
  const userId = randomUUID()
  const staffId = randomUUID()
  db.insert(users)
    .values({ id: userId, displayName: input.username, createdAt: now, updatedAt: now })
    .run()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId,
      username: input.username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  for (const communityId of input.communityIds ?? []) {
    db.insert(staffCommunityAssignments)
      .values({ staffAccountId: staffId, communityId, createdAt: now })
      .run()
  }
}

async function createFixture(): Promise<Fixture> {
  const { db } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const app = createApp({ db, config, logRequests: false })

  const communityId = randomUUID()
  const otherCommunityId = randomUUID()
  const now = new Date()
  db.insert(communities)
    .values([
      { id: communityId, name: '幸福社区', createdAt: now },
      { id: otherCommunityId, name: '邻家社区', createdAt: now },
    ])
    .run()

  await seedStaff(db, { username: 'admin', password: ADMIN_PASSWORD, role: 'admin' })
  await seedStaff(db, {
    username: 'operator.a',
    password: OPERATOR_PASSWORD,
    role: 'operator',
    communityIds: [communityId],
  })
  await seedStaff(db, {
    username: 'grid.a',
    password: GRID_PASSWORD,
    role: 'grid_worker',
    communityIds: [communityId],
  })
  await seedStaff(db, {
    username: 'grid.b',
    password: OTHER_GRID_PASSWORD,
    role: 'grid_worker',
    communityIds: [otherCommunityId],
  })

  return {
    app,
    db,
    communityId,
    otherCommunityId,
    admin: await login(app, 'admin', ADMIN_PASSWORD),
    operator: await login(app, 'operator.a', OPERATOR_PASSWORD),
    grid: await login(app, 'grid.a', GRID_PASSWORD),
    otherGrid: await login(app, 'grid.b', OTHER_GRID_PASSWORD),
  }
}

interface ActivityOptions {
  communityId?: string
  plan?: Record<string, unknown> | null
  publish?: boolean
  status?: ActivityStatus
}

/** Creates an activity through the real admin HTTP surface and publishes it. */
async function createActivity(fixture: Fixture, options: ActivityOptions = {}): Promise<string> {
  const { app, communityId } = fixture
  const plan = options.plan === undefined ? rewardPlan() : options.plan
  // The activity window must *contain* the plan's check-in window (t13), so it
  // is derived from the same `NOW` the default plan uses rather than from a
  // fresh `Date.now()`. A per-call `now - 1h` start would drift a few ms past
  // the plan's `now - 1h` start and be rejected as out of bounds.
  const startsAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)
  const endsAt = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000)
  const response = await api(app, 'POST', '/admin/activities', {
    session: fixture.admin,
    body: {
      communityId: options.communityId ?? communityId,
      title: '秋季敬老欢乐季',
      summary: '真实签到与团队奖励',
      keyRules: {
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        location: '幸福社区党群服务中心',
        budgetCapCents: 50_000,
        prizeQuantityCap: 10,
        publicRules: {
          eligibility: '本社区 60 岁以上居民',
          checkin: '现场签到',
          purchase: '无消费门槛',
          prizeClaim: '达标后凭核销码领取',
        },
        ...(plan === null ? {} : { rewardPlan: plan }),
      },
    },
  })
  assert.equal(response.status, 201, 'activity creation must succeed')
  const activityId = ((await response.json()) as { id: string }).id
  if (options.publish ?? true) {
    const detailResponse = await api(app, 'GET', `/admin/activities/${activityId}`, {
      session: fixture.admin,
    })
    assert.equal(detailResponse.status, 200)
    const detail = (await detailResponse.json()) as { updatedAt: string }
    const publishResponse = await api(app, 'POST', `/admin/activities/${activityId}/publish`, {
      session: fixture.admin,
      body: { expectedUpdatedAt: detail.updatedAt },
    })
    assert.equal(publishResponse.status, 200, 'activity publish must succeed')
  }
  return activityId
}

async function joinTeam(
  app: App,
  residents: Session[],
  activityId: string,
): Promise<void> {
  const [leader, ...members] = residents
  assert.ok(leader, 'a team needs a leader')
  const first = await api(app, 'POST', `/activities/${activityId}/participation`, {
    session: leader,
    body: {},
  })
  assert.equal(first.status, 200, 'leader confirmation must succeed')
  const firstBody = (await first.json()) as { state: { team: { inviteCode: string | null } | null } }
  const inviteCode = firstBody.state.team?.inviteCode
  assert.ok(inviteCode, 'the leader team must expose an invite code')
  for (const member of members) {
    const response = await api(app, 'POST', `/activities/${activityId}/participation`, {
      session: member,
      body: { inviteCode },
    })
    assert.equal(response.status, 200, 'member confirmation must succeed')
  }
}

async function selfCheckin(app: App, session: Session, activityId: string): Promise<ActivityCheckinState> {
  const response = await api(app, 'POST', `/activities/${activityId}/checkin`, {
    session,
    emptyBody: true,
  })
  assert.equal(response.status, 200, 'resident self check-in must succeed')
  return activityCheckinStateSchema.parse(await response.json())
}

async function adminCheckins(
  app: App,
  session: Session,
  activityId: string,
): Promise<AdminActivityCheckinList> {
  const response = await api(app, 'GET', `/admin/activities/${activityId}/checkins`, { session })
  assert.equal(response.status, 200, 'admin check-in list must succeed')
  return adminActivityCheckinListSchema.parse(await response.json())
}

async function verifyAllCheckins(
  app: App,
  session: Session,
  activityId: string,
): Promise<void> {
  const list = await adminCheckins(app, session, activityId)
  assert.equal(list.items.length, 3)
  for (const item of list.items) {
    const response = await api(
      app,
      'POST',
      `/admin/activities/${activityId}/checkins/${item.id}/verify`,
      { session, body: {} },
    )
    assert.equal(response.status, 200, 'staff verification must succeed')
    const checkin = activityCheckinSchema.parse(await response.json())
    assert.equal(checkin.status, 'valid')
    assert.notEqual(checkin.verifiedAt, null)
  }
}

/**
 * Verifies every still-unverified check-in. Needed once an activity carries more
 * than one team: `verifyAllCheckins` asserts exactly three rows, which is the
 * right guard for the single-team cases but not for these.
 */
async function verifyPendingCheckins(
  app: App,
  session: Session,
  activityId: string,
): Promise<void> {
  const list = await adminCheckins(app, session, activityId)
  const pending = list.items.filter((item) => item.verifiedAt === null)
  assert.ok(pending.length > 0, 'there must be something to verify')
  for (const item of pending) {
    const response = await api(
      app,
      'POST',
      `/admin/activities/${activityId}/checkins/${item.id}/verify`,
      { session, body: {} },
    )
    assert.equal(response.status, 200, 'staff verification must succeed')
    const checkin = activityCheckinSchema.parse(await response.json())
    assert.equal(checkin.status, 'valid')
    assert.notEqual(checkin.verifiedAt, null)
  }
}

async function claimReward(
  app: App,
  session: Session,
  activityId: string,
): Promise<ActivityRewardClaimResponse> {
  const response = await api(app, 'POST', `/activities/${activityId}/rewards/claim`, {
    session,
    emptyBody: true,
  })
  assert.equal(response.status, 200, 'claim must succeed')
  return activityRewardClaimResponseSchema.parse(await response.json())
}

interface AuditRow {
  targetId: string | null
  metadata: Record<string, unknown> | null
  raw: string | null
}

function auditRows(db: AppDatabase, event: string): AuditRow[] {
  return db
    .select({ targetId: auditLogs.targetId, metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(eq(auditLogs.event, event))
    .all()
    .map((row) => ({
      targetId: row.targetId,
      metadata: row.metadata === null ? null : (JSON.parse(row.metadata) as Record<string, unknown>),
      raw: row.metadata,
    }))
}

function auditEvents(db: AppDatabase, event: string): number {
  return auditRows(db, event).length
}

/** Builds a 3-person team, three verified check-ins and one claimed credential. */
async function issuedCredential(
  fixture: Fixture,
  activityId: string,
  residents: Session[],
): Promise<{ code: string; grantId: string }> {
  await joinTeam(fixture.app, residents, activityId)
  for (const resident of residents) {
    await selfCheckin(fixture.app, resident, activityId)
  }
  await verifyAllCheckins(fixture.app, fixture.operator, activityId)
  const claim = await claimReward(fixture.app, residents[0]!, activityId)
  return { code: claim.code, grantId: claim.grant.id }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

test('every reward route rejects an unauthenticated caller with 401', async () => {
  const fixture = await createFixture()
  const activityId = randomUUID()
  const routes: Array<{ method: string; path: string }> = [
    { method: 'GET', path: `/activities/${activityId}/checkin` },
    { method: 'POST', path: `/activities/${activityId}/checkin` },
    { method: 'GET', path: `/activities/${activityId}/rewards` },
    { method: 'POST', path: `/activities/${activityId}/rewards/claim` },
    { method: 'GET', path: `/activities/${activityId}/rewards/credential` },
    { method: 'GET', path: `/admin/activities/${activityId}/checkins` },
    { method: 'POST', path: `/admin/activities/${activityId}/checkins/${randomUUID()}/verify` },
    { method: 'POST', path: `/admin/activities/${activityId}/checkins/${randomUUID()}/revoke` },
    { method: 'GET', path: `/admin/activities/${activityId}/rewards` },
    {
      method: 'POST',
      path: `/admin/activities/${activityId}/rewards/grants/${randomUUID()}/revoke`,
    },
    {
      method: 'POST',
      path: `/admin/activities/${activityId}/rewards/grants/${randomUUID()}/disputes`,
    },
    { method: 'POST', path: '/rewards/redeem' },
  ]
  for (const route of routes) {
    const response = await api(fixture.app, route.method, route.path, {
      body: route.method === 'POST' ? {} : undefined,
    })
    await expectError(response, 401, API_ERROR_CODES.unauthorized, `${route.method} ${route.path}`)
  }
})

test('a forged resident identity is rejected instead of ignored; CSRF and Origin are required', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residentA = await residentSession(app, '居民A', fixture.communityId)
  const residentB = await residentSession(app, '居民B', fixture.communityId)
  await joinTeam(app, [residentA, residentB, await residentSession(app, '居民C', fixture.communityId)], activityId)

  // Naming another resident in the body is a contract violation, not a no-op.
  const forgedCheckin = await api(app, 'POST', `/activities/${activityId}/checkin`, {
    session: residentA,
    body: { userId: residentB.userId },
  })
  await expectError(
    forgedCheckin,
    400,
    API_ERROR_CODES.invalidRequest,
    'check-in body must not name a user',
  )
  const forgedClaim = await api(app, 'POST', `/activities/${activityId}/rewards/claim`, {
    session: residentA,
    body: { userId: residentB.userId, teamId: randomUUID() },
  })
  await expectError(
    forgedClaim,
    400,
    API_ERROR_CODES.invalidRequest,
    'claim body must not name a user or team',
  )

  // No CSRF header at all.
  const noCsrf = await api(app, 'POST', `/activities/${activityId}/checkin`, {
    session: residentA,
    csrf: false,
    emptyBody: true,
  })
  await expectError(noCsrf, 403, API_ERROR_CODES.forbidden, 'missing CSRF token')

  // A valid token from an untrusted Origin.
  const badOrigin = await api(app, 'POST', `/activities/${activityId}/checkin`, {
    session: residentA,
    origin: 'https://evil.example',
    emptyBody: true,
  })
  await expectError(badOrigin, 403, API_ERROR_CODES.forbidden, 'untrusted Origin')

  // No valid check-in was created by any rejected request.
  const list = await adminCheckins(app, fixture.operator, activityId)
  assert.equal(list.items.length, 0)
})

test('resident self check-in is idempotent, unverified, and does not unlock the prize', async () => {
  const fixture = await createFixture()
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(fixture.app, name, fixture.communityId)),
  )
  await joinTeam(fixture.app, residents, activityId)

  const first = await selfCheckin(fixture.app, residents[0]!, activityId)
  assert.equal(first.available, false)
  assert.equal(first.unavailableReason, 'already_checked_in')
  assert.ok(first.checkin)
  assert.equal(first.checkin.verifiedAt, null, 'a self check-in is not verified')
  assert.equal(first.countsForReward, false)

  const second = await selfCheckin(fixture.app, residents[0]!, activityId)
  assert.equal(second.checkin?.id, first.checkin.id, 're-submitting must not create a second row')

  const list = await adminCheckins(fixture.app, fixture.operator, activityId)
  assert.equal(list.items.length, 1, 'duplicate submissions must not duplicate the fact')
  assert.equal(list.counts.pendingVerification, 1)

  const state = await api(fixture.app, 'GET', `/activities/${activityId}/rewards`, {
    session: residents[0]!,
  })
  assert.equal(state.status, 200)
  const rewardState = teamRewardStateSchema.parse(await state.json())
  assert.equal(rewardState.planConfigured, true)
  assert.equal(rewardState.requirement.seatsFilled, 3)
  assert.equal(
    rewardState.requirement.checkinsValid,
    0,
    'an unverified self check-in must not count towards the three-check-in requirement',
  )
  assert.equal(rewardState.eligible, false)
  assert.equal(rewardState.unavailableReason, 'checkin_incomplete')
  assert.equal(rewardState.grant, null)

  // The other two members check in, then staff verifies all three: only then do
  // the three verified check-ins become eligibility.
  await selfCheckin(fixture.app, residents[1]!, activityId)
  await selfCheckin(fixture.app, residents[2]!, activityId)
  await verifyAllCheckins(fixture.app, fixture.operator, activityId)
  const afterVerify = await api(fixture.app, 'GET', `/activities/${activityId}/rewards`, {
    session: residents[0]!,
  })
  const verifiedState = teamRewardStateSchema.parse(await afterVerify.json())
  assert.equal(verifiedState.requirement.checkinsValid, 3)
  assert.equal(verifiedState.eligible, true)
  assert.equal(verifiedState.claimableByMe, true, 'the leader may claim a leader-only prize')
  assert.equal(verifiedState.unavailableReason, null)
})

test('claim issues one 10-character code; a repeat claim is idempotent and never re-issues a second grant', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, residents, activityId)
  for (const resident of residents) await selfCheckin(app, resident, activityId)
  await verifyAllCheckins(app, fixture.operator, activityId)

  const first = await claimReward(app, residents[0]!, activityId)
  assert.equal(first.created, true)
  assert.match(first.code, /^[0-9A-HJKMNP-TV-Z]{10}$/, 'code must be Crockford base32')
  assert.equal(first.grant.status, 'granted')
  assert.equal(first.grant.quantity, 1)
  assert.equal(first.grant.unitCostCents, 5_000)
  assert.equal(first.grant.totalCostCents, 5_000)
  assert.equal(first.grant.recipientRole, 'leader')
  assert.equal(first.grant.recipientUserId, residents[0]!.userId)
  assert.match(first.credential.maskedCode, /^\*{6}[0-9A-HJKMNP-TV-Z]{4}$/)
  assert.equal(first.credential.maskedCode.slice(-4), first.code.slice(-4))

  const second = await claimReward(app, residents[0]!, activityId)
  assert.equal(second.created, false)
  assert.equal(second.grant.id, first.grant.id, 'a team owns exactly one grant')
  assert.match(second.code, /^[0-9A-HJKMNP-TV-Z]{10}$/)

  const overview = await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
    session: fixture.operator,
  })
  assert.equal(overview.status, 200)
  const parsed = adminActivityRewardOverviewSchema.parse(await overview.json())
  assert.equal(parsed.planSource, 'rule_version_snapshot')
  assert.equal(parsed.counts.grantsTotal, 1)
  assert.equal(parsed.counts.grantsGranted, 1)
  assert.equal(parsed.counts.codesActive, 1, 'the old code is superseded, exactly one stays active')
  assert.ok(parsed.stock)
  assert.equal(parsed.stock.claimedQuantity, 1)
  assert.equal(parsed.stock.redeemedQuantity, 0)

  // The credential endpoint returns metadata only.
  const credentialResponse = await api(app, 'GET', `/activities/${activityId}/rewards/credential`, {
    session: residents[0]!,
  })
  assert.equal(credentialResponse.status, 200)
  const credential = activityRewardCredentialSchema.parse(await credentialResponse.json())
  assert.equal(credential.status, 'active')
  assert.match(credential.maskedCode, /^\*{6}[0-9A-HJKMNP-TV-Z]{4}$/)
  assert.ok(!('code' in credential), 'the plaintext code must never be returned by a read')

  // A non-member's credential read is a 404, not a leak.
  const outsider = await residentSession(app, '路人丁', fixture.communityId)
  const outsiderResponse = await api(app, 'GET', `/activities/${activityId}/rewards/credential`, {
    session: outsider,
  })
  await expectError(outsiderResponse, 404, API_ERROR_CODES.notFound, 'outsider credential read')
})

test('redeem is exactly once; forged, superseded and cross-community codes are rejected', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  const { code } = await issuedCredential(fixture, activityId, residents)

  // A forged code looks exactly like an unknown one.
  const forged = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code: 'ZZZZZZZZZZ' },
  })
  await expectError(forged, 404, API_ERROR_CODES.redemptionCodeInvalid, 'forged code')

  // A malformed code fails the strict contract before any DB read.
  const malformed = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code: 'abc' },
  })
  await expectError(malformed, 400, API_ERROR_CODES.invalidRequest, 'malformed code')

  // The assigned grid worker of the activity's community may redeem.
  const redeemed = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code },
  })
  assert.equal(redeemed.status, 200)
  const receipt: RewardRedeemResponse = rewardRedeemResponseSchema.parse(await redeemed.json())
  assert.equal(receipt.redeemed, true)
  assert.equal(receipt.grant.status, 'redeemed')
  assert.notEqual(receipt.grant.redeemedAt, null)
  assert.equal(receipt.credential.status, 'redeemed')
  assert.match(receipt.credential.maskedCode, /^\*{6}[0-9A-HJKMNP-TV-Z]{4}$/)

  // The exact same code can never be spent twice.
  const repeated = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code },
  })
  await expectError(repeated, 409, API_ERROR_CODES.rewardAlreadyRedeemed, 'repeat redemption')

  const overview = await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
    session: fixture.operator,
  })
  const parsed = adminActivityRewardOverviewSchema.parse(await overview.json())
  assert.equal(parsed.counts.grantsRedeemed, 1)
  assert.ok(parsed.stock)
  assert.equal(parsed.stock.redeemedQuantity, 1)
  assert.equal(parsed.stock.redeemedBudgetCents, 5_000)

  // A grid worker of another community is out of scope: 403 and an audit row.
  const secondActivity = await createActivity(fixture)
  const secondResidents = await Promise.all(
    ['居民戊', '居民己', '居民庚'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  const second = await issuedCredential(fixture, secondActivity, secondResidents)
  const before = auditRows(fixture.db, 'reward.access_denied')
  const crossCommunity = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.otherGrid,
    body: { code: second.code },
  })
  await expectError(crossCommunity, 403, API_ERROR_CODES.forbidden, 'cross-community redeem')
  const after = auditRows(fixture.db, 'reward.access_denied')
  assert.equal(
    after.length,
    before.length + 1,
    'a denied cross-community redemption must be audited exactly once',
  )
  const denial = after[after.length - 1]
  assert.ok(denial)
  assert.equal(denial.targetId, secondActivity, 'the audit row names the attempted activity')
  assert.equal(denial.metadata?.reason, 'community_out_of_scope')
  assert.equal(typeof denial.metadata?.staffId, 'string')
  assert.equal(denial.metadata?.communityId, fixture.communityId, 'the denial records the actor community')
  assert.equal(
    denial.raw?.includes(second.code),
    false,
    'a denial audit must never store the plaintext credential code',
  )

  // The credential still belongs to the other community: its own operator succeeds.
  const localRedeem = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.operator,
    body: { code: second.code },
  })
  assert.equal(localRedeem.status, 200)
})

test('staff surfaces deny residents, cross-community staff and CSRF-less writes, and audit the denials', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const outsiderResident = await residentSession(app, '普通居民', fixture.communityId)

  // A resident session has no staff identity at all.
  const residentList = await api(app, 'GET', `/admin/activities/${activityId}/checkins`, {
    session: outsiderResident,
  })
  await expectError(residentList, 401, API_ERROR_CODES.unauthorized, 'resident on staff list')
  const residentOverview = await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
    session: outsiderResident,
  })
  await expectError(residentOverview, 401, API_ERROR_CODES.unauthorized, 'resident on admin overview')

  // A grid worker of another community is authenticated but out of scope.
  const beforeList = auditEvents(fixture.db, 'reward.access_denied')
  const crossList = await api(app, 'GET', `/admin/activities/${activityId}/checkins`, {
    session: fixture.otherGrid,
  })
  await expectError(crossList, 403, API_ERROR_CODES.forbidden, 'cross-community check-in list')
  const crossOverview = await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
    session: fixture.otherGrid,
  })
  await expectError(crossOverview, 403, API_ERROR_CODES.forbidden, 'cross-community overview')
  assert.equal(
    auditEvents(fixture.db, 'reward.access_denied'),
    beforeList + 2,
    'each denied read leaves exactly one audit row',
  )

  // Every other staff write is denied the same way, and each denial is durable.
  const writeProbes: Array<{ path: string; body: unknown }> = [
    { path: `/admin/activities/${activityId}/checkins/${randomUUID()}/verify`, body: {} },
    {
      path: `/admin/activities/${activityId}/checkins/${randomUUID()}/revoke`,
      body: { reason: '越权撤销' },
    },
    {
      path: `/admin/activities/${activityId}/rewards/grants/${randomUUID()}/revoke`,
      body: { reason: '越权作废' },
    },
    {
      path: `/admin/activities/${activityId}/rewards/grants/${randomUUID()}/disputes`,
      body: { decision: 'opened', reason: '越权争议' },
    },
  ]
  for (const probe of writeProbes) {
    const before = auditEvents(fixture.db, 'reward.access_denied')
    const denied = await api(app, 'POST', probe.path, {
      session: fixture.otherGrid,
      body: probe.body,
    })
    await expectError(denied, 403, API_ERROR_CODES.forbidden, probe.path)
    assert.equal(
      auditEvents(fixture.db, 'reward.access_denied'),
      before + 1,
      `${probe.path}: the denial must survive outside the refused transaction`,
    )
  }

  // The assigned grid worker and operator are allowed.
  assert.equal(
    (await api(app, 'GET', `/admin/activities/${activityId}/checkins`, { session: fixture.grid }))
      .status,
    200,
  )
  assert.equal(
    (await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
      session: fixture.operator,
    })).status,
    200,
  )

  // Writes without CSRF are refused before the service layer runs.
  const noCsrfVerify = await api(
    app,
    'POST',
    `/admin/activities/${activityId}/checkins/${randomUUID()}/verify`,
    { session: fixture.operator, csrf: false, body: {} },
  )
  await expectError(noCsrfVerify, 403, API_ERROR_CODES.forbidden, 'verify without CSRF')
  const noCsrfRedeem = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    csrf: false,
    body: { code: 'ZZZZZZZZZZ' },
  })
  await expectError(noCsrfRedeem, 403, API_ERROR_CODES.forbidden, 'redeem without CSRF')

  // A non-uuid activity id is a 404, not a 500.
  const badId = await api(app, 'GET', '/admin/activities/not-a-uuid/checkins', {
    session: fixture.operator,
  })
  await expectError(badId, 404, API_ERROR_CODES.notFound, 'malformed activity id')
})

test('a draft activity, a missing reward plan and a closed window all answer reward_unavailable', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const resident = await residentSession(app, '居民甲', fixture.communityId)

  const draftActivityId = await createActivity(fixture, { publish: false })
  const draftCheckin = await api(app, 'POST', `/activities/${draftActivityId}/checkin`, {
    session: resident,
    emptyBody: true,
  })
  await expectError(
    draftCheckin,
    409,
    API_ERROR_CODES.rewardUnavailable,
    'check-in on a draft activity',
  )
  const draftState = await api(app, 'GET', `/activities/${draftActivityId}/checkin`, {
    session: resident,
  })
  assert.equal(draftState.status, 200)
  const draftBody = activityCheckinStateSchema.parse(await draftState.json())
  assert.equal(draftBody.available, false)
  assert.equal(draftBody.unavailableReason, 'activity_not_published')
  assert.equal(draftBody.checkin, null)

  // A published activity whose frozen snapshot has no plan cannot fall back to
  // the mutable activity columns.
  const noPlanActivityId = await createActivity(fixture, { plan: null })
  const noPlanCheckin = await api(app, 'POST', `/activities/${noPlanActivityId}/checkin`, {
    session: resident,
    emptyBody: true,
  })
  await expectError(
    noPlanCheckin,
    409,
    API_ERROR_CODES.rewardUnavailable,
    'check-in without a frozen reward plan',
  )
  const noPlanState = await api(app, 'GET', `/activities/${noPlanActivityId}/checkin`, {
    session: resident,
  })
  const noPlanBody = activityCheckinStateSchema.parse(await noPlanState.json())
  assert.equal(noPlanBody.unavailableReason, 'reward_plan_not_configured')
  assert.equal(noPlanBody.checkinWindow, null)

  const noPlanOverview = await api(
    app,
    'GET',
    `/admin/activities/${noPlanActivityId}/rewards`,
    { session: fixture.operator },
  )
  assert.equal(noPlanOverview.status, 200)
  const noPlanRewards = adminActivityRewardOverviewSchema.parse(await noPlanOverview.json())
  assert.equal(noPlanRewards.planSource, 'none')
  assert.equal(noPlanRewards.planConfigured, false)
  assert.equal(noPlanRewards.plan, null)
  assert.equal(noPlanRewards.stock, null)
  assert.equal(noPlanRewards.counts.grantsTotal, 0)

  // A plan whose check-in window already closed is refused by the frozen window.
  const closedActivityId = await createActivity(fixture, {
    plan: rewardPlan({
      checkinWindow: {
        opensAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
        closesAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    }),
  })
  const closedResidents = await Promise.all(
    ['居民A1', '居民A2', '居民A3'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, closedResidents, closedActivityId)
  const closedCheckin = await api(app, 'POST', `/activities/${closedActivityId}/checkin`, {
    session: closedResidents[0]!,
    emptyBody: true,
  })
  await expectError(
    closedCheckin,
    409,
    API_ERROR_CODES.rewardUnavailable,
    'check-in after the frozen window closed',
  )
  const closedState = await api(app, 'GET', `/activities/${closedActivityId}/checkin`, {
    session: closedResidents[0]!,
  })
  const closedBody = activityCheckinStateSchema.parse(await closedState.json())
  assert.equal(closedBody.unavailableReason, 'checkin_window_closed')
})

test('revoking a check-in after issuance makes the credential unusable', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  const { code } = await issuedCredential(fixture, activityId, residents)

  const list = await adminCheckins(app, fixture.grid, activityId)
  const victim = list.items[0]
  assert.ok(victim)
  const revokeResponse = await api(
    app,
    'POST',
    `/admin/activities/${activityId}/checkins/${victim.id}/revoke`,
    { session: fixture.grid, body: { reason: '现场复核发现未到场' } },
  )
  assert.equal(revokeResponse.status, 200)
  const revoked = activityCheckinSchema.parse(await revokeResponse.json())
  assert.equal(revoked.status, 'revoked')
  assert.notEqual(revoked.revokedAt, null)
  assert.equal(revoked.revokeReason, '现场复核发现未到场')

  // The unredeemed grant is revoked and its stock occupancy released; the code
  // is revoked too, so presenting it can never succeed.
  const overview = await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
    session: fixture.operator,
  })
  const parsed = adminActivityRewardOverviewSchema.parse(await overview.json())
  assert.equal(parsed.counts.grantsRevoked, 1)
  assert.equal(parsed.counts.grantsGranted, 0)
  assert.equal(parsed.counts.codesActive, 0)
  assert.ok(parsed.stock)
  assert.equal(parsed.stock.claimedQuantity, 0, 'an unredeemed revocation releases the claim')
  assert.equal(parsed.stock.redeemedQuantity, 0)

  const redeemAfterRevoke = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code },
  })
  await expectError(
    redeemAfterRevoke,
    404,
    API_ERROR_CODES.redemptionCodeInvalid,
    'redeeming a credential whose check-in was revoked',
  )

  // A revoked check-in cannot be revoked twice nor verified afterwards.
  const secondRevoke = await api(
    app,
    'POST',
    `/admin/activities/${activityId}/checkins/${victim.id}/revoke`,
    { session: fixture.grid, body: { reason: '重复撤销请求' } },
  )
  await expectError(secondRevoke, 409, API_ERROR_CODES.conflict, 'double revocation')
  const verifyRevoked = await api(
    app,
    'POST',
    `/admin/activities/${activityId}/checkins/${victim.id}/verify`,
    { session: fixture.grid, body: {} },
  )
  await expectError(verifyRevoked, 409, API_ERROR_CODES.conflict, 'verifying a revoked check-in')
})

test('revoking a check-in of an already redeemed prize moves the grant to disputed, not un-redeemed', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  const { code, grantId } = await issuedCredential(fixture, activityId, residents)

  // Redeem first: from here on the prize physically left the stock room.
  const redeemed = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.operator,
    body: { code },
  })
  assert.equal(redeemed.status, 200)

  const list = await adminCheckins(app, fixture.operator, activityId)
  const victim = list.items[0]
  assert.ok(victim)
  const revokeResponse = await api(
    app,
    'POST',
    `/admin/activities/${activityId}/checkins/${victim.id}/revoke`,
    { session: fixture.operator, body: { reason: '签到材料造假' } },
  )
  assert.equal(revokeResponse.status, 200)

  const overview = adminActivityRewardOverviewSchema.parse(
    await (await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
      session: fixture.operator,
    })).json(),
  )
  const row = overview.grants.find((entry) => entry.grant.id === grantId)
  assert.ok(row)
  assert.equal(row.grant.status, 'disputed')
  assert.equal(row.openDispute, true, 'the dispute is recorded as an appended thread')
  assert.notEqual(row.grant.redeemedAt, null, 'redemption evidence is preserved')
  assert.equal(overview.counts.grantsRedeemed, 0)
  assert.equal(overview.counts.grantsDisputed, 1)
  assert.ok(overview.stock)
  assert.equal(overview.stock.claimedQuantity, 1, 'a redeemed dispute keeps its claim')
  assert.equal(
    overview.stock.redeemedQuantity,
    1,
    'the redeemed ledger must never be rolled back by a reversal',
  )
})

test('grant revocation and dispute threads are staff-only, append-only and scoped', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  const { grantId, code } = await issuedCredential(fixture, activityId, residents)

  const grantRevoke = await api(
    app,
    'POST',
    `/admin/activities/${activityId}/rewards/grants/${grantId}/revoke`,
    { session: fixture.otherGrid, body: { reason: '越权作废' } },
  )
  await expectError(grantRevoke, 403, API_ERROR_CODES.forbidden, 'cross-community grant revoke')

  const dispute = await api(
    app,
    'POST',
    `/admin/activities/${activityId}/rewards/grants/${grantId}/disputes`,
    { session: fixture.operator, body: { decision: 'opened', reason: '奖品破损' } },
  )
  await expectError(
    dispute,
    409,
    API_ERROR_CODES.conflict,
    'a dispute can only be opened on a redeemed grant',
  )

  // Redeem, then open a dispute and reverse it: both are appended, never edited.
  const redeemResponse = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.operator,
    body: { code },
  })
  assert.equal(redeemResponse.status, 200)
  const receipt = rewardRedeemResponseSchema.parse(await redeemResponse.json())
  assert.equal(receipt.grant.id, grantId)

  const opened = await api(
    app,
    'POST',
    `/admin/activities/${activityId}/rewards/grants/${grantId}/disputes`,
    { session: fixture.operator, body: { decision: 'opened', reason: '居民投诉奖品破损' } },
  )
  assert.equal(opened.status, 200)
  const thread = (await opened.json()) as { open: boolean; entries: unknown[] }
  assert.equal(thread.open, true)
  assert.equal(thread.entries.length, 1)

  const reversed = await api(
    app,
    'POST',
    `/admin/activities/${activityId}/rewards/grants/${grantId}/disputes`,
    { session: fixture.operator, body: { decision: 'reversed', reason: '已重新补发' } },
  )
  assert.equal(reversed.status, 200)
  const reversedThread = (await reversed.json()) as { open: boolean; entries: unknown[] }
  assert.equal(reversedThread.open, false)
  assert.equal(reversedThread.entries.length, 2)

  const overview = adminActivityRewardOverviewSchema.parse(
    await (await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
      session: fixture.operator,
    })).json(),
  )
  assert.equal(overview.counts.grantsReversed, 1)
  assert.ok(overview.stock)
  assert.equal(overview.stock.redeemedQuantity, 1, 'a reversal must not lower the redeemed ledger')

  // A revoked (unredeemed) grant can be revoked through the staff surface once.
  const secondActivity = await createActivity(fixture)
  const secondResidents = await Promise.all(
    ['居民戊', '居民己', '居民庚'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  const secondGrant = await issuedCredential(fixture, secondActivity, secondResidents)
  const revoked = await api(
    app,
    'POST',
    `/admin/activities/${secondActivity}/rewards/grants/${secondGrant.grantId}/revoke`,
    { session: fixture.grid, body: { reason: '重复发放，回收' } },
  )
  assert.equal(revoked.status, 200)
  assert.equal(activityRewardGrantSchema.parse(await revoked.json()).status, 'revoked')
  const doubleRevoke = await api(
    app,
    'POST',
    `/admin/activities/${secondActivity}/rewards/grants/${secondGrant.grantId}/revoke`,
    { session: fixture.grid, body: { reason: '再次回收' } },
  )
  await expectError(doubleRevoke, 409, API_ERROR_CODES.conflict, 'double grant revocation')
})

test('an expired credential is refused even though its hash still matches', async (t) => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  const { code, grantId } = await issuedCredential(fixture, activityId, residents)

  // `expires_at` is immutable by trigger, so expiry is produced the only honest
  // way: move the clock past the code's 72-hour TTL. 80 hours stays inside the
  // 168-hour staff session TTL, so the caller is still authenticated.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 80 * 60 * 60 * 1000 })

  const expired = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code },
  })
  // The service answers an expired code with 400 `redemption_code_expired`
  // (pinned by `rewards.test.ts`); clients must branch on the code, not the status.
  await expectError(expired, 400, API_ERROR_CODES.redemptionCodeExpired, 'expired code')

  t.mock.timers.reset()

  // The expiry decision is durable: the row moved to `expired` and the grant is
  // untouched, so nobody loses a prize because a slip went stale.
  const overview = adminActivityRewardOverviewSchema.parse(
    await (await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
      session: fixture.operator,
    })).json(),
  )
  assert.equal(overview.counts.codesActive, 0)
  assert.equal(overview.counts.grantsGranted, 1)
  assert.equal(overview.counts.grantsRedeemed, 0)
  const codeRows = fixture.db
    .select({ status: activityRewardCodes.status })
    .from(activityRewardCodes)
    .where(eq(activityRewardCodes.grantId, grantId))
    .all()
  assert.deepEqual(
    codeRows.map((row) => row.status),
    ['expired'],
    'the credential is marked expired, not silently deleted',
  )

  // The same slip must always get the same answer: a real but stale credential
  // reports `expired` on every attempt, so the desk reissues instead of treating
  // the resident as a forger. (superseded/revoked codes stay indistinguishable
  // from unknown ones — those could point at a live replacement.)
  const again = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code },
  })
  await expectError(again, 400, API_ERROR_CODES.redemptionCodeExpired, 'expired code replay')
})

// Renamed in t10. It previously read "pausing an activity closes the check-in and
// claim surfaces", but the pause happens BEFORE any check-in, so the claim was
// refused by `checkin_incomplete`, not by the lifecycle gate — the name claimed
// coverage the case never had. The real lifecycle sequencing is covered by the
// `F3:` cases at the end of this file, which qualify the team first and then
// pause/end. What this case actually proves is that neither surface 500s and no
// prize leaks, so the name now says exactly that.
test('pausing before any check-in leaves both surfaces closed and leaks no prize', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, residents, activityId)

  const detail = await api(app, 'GET', `/admin/activities/${activityId}`, {
    session: fixture.admin,
  })
  const { updatedAt } = (await detail.json()) as { updatedAt: string }
  const paused = await api(app, 'POST', `/admin/activities/${activityId}/pause`, {
    session: fixture.admin,
    body: { expectedUpdatedAt: updatedAt },
  })
  assert.equal(paused.status, 200)

  const pausedCheckin = await api(app, 'POST', `/activities/${activityId}/checkin`, {
    session: residents[0]!,
    emptyBody: true,
  })
  await expectError(
    pausedCheckin,
    409,
    API_ERROR_CODES.rewardUnavailable,
    'check-in on a paused activity',
  )
  const pausedState = await api(app, 'GET', `/activities/${activityId}/checkin`, {
    session: residents[0]!,
  })
  const state = activityCheckinStateSchema.parse(await pausedState.json())
  assert.equal(state.available, false)
  assert.equal(state.unavailableReason, 'activity_not_published')
  assert.equal(state.checkin, null)

  const pausedClaim = await api(app, 'POST', `/activities/${activityId}/rewards/claim`, {
    session: residents[0]!,
    emptyBody: true,
  })
  await expectError(
    pausedClaim,
    409,
    API_ERROR_CODES.rewardUnavailable,
    'claim on a paused activity',
  )

  // No prize leaked out of a paused activity.
  const overview = adminActivityRewardOverviewSchema.parse(
    await (await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
      session: fixture.operator,
    })).json(),
  )
  assert.equal(overview.counts.grantsTotal, 0)
  assert.ok(overview.stock === null || overview.stock.claimedQuantity === 0)
})

test('responses stay on-contract for every success path (shared schemas parse them)', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, residents, activityId)
  for (const resident of residents) await selfCheckin(app, resident, activityId)
  const list = await adminCheckins(app, fixture.grid, activityId)
  assert.equal(list.counts.valid, 3)
  assert.equal(list.counts.pendingVerification, 3)
  await verifyAllCheckins(app, fixture.grid, activityId)

  const state = await api(app, 'GET', `/activities/${activityId}/rewards`, {
    session: residents[1]!,
  })
  const rewardState = teamRewardStateSchema.parse(await state.json())
  assert.equal(rewardState.teamId, list.items[0]?.teamId)
  assert.equal(rewardState.claimableByMe, false, 'a member cannot claim a leader-only prize')
  assert.equal(rewardState.reward?.prizeName, '粮油礼包')

  const memberClaim = await api(app, 'POST', `/activities/${activityId}/rewards/claim`, {
    session: residents[1]!,
    emptyBody: true,
  })
  await expectError(memberClaim, 403, API_ERROR_CODES.forbidden, 'member claiming leader prize')

  const claim = await claimReward(app, residents[0]!, activityId)
  assert.equal(claim.created, true)
  const stored = fixture.db
    .select({ id: activities.id })
    .from(activities)
    .where(eq(activities.id, activityId))
    .get()
  assert.ok(stored, 'the activity must still exist')
})

/* -------------------------------------------------------------------------- */
/* t10: life-cycle and recipient boundaries (real HTTP, real SQLite)          */
/* -------------------------------------------------------------------------- */

/** Reads the activity's stored update token so a transition can be issued. */
async function activityUpdatedAt(
  app: App,
  session: Session,
  activityId: string,
): Promise<string> {
  const detail = await api(app, 'GET', `/admin/activities/${activityId}`, { session })
  assert.equal(detail.status, 200)
  const body = (await detail.json()) as { updatedAt: string }
  return body.updatedAt
}

async function pauseActivity(app: App, session: Session, activityId: string): Promise<void> {
  const expectedUpdatedAt = await activityUpdatedAt(app, session, activityId)
  const paused = await api(app, 'POST', `/admin/activities/${activityId}/pause`, {
    session,
    body: { expectedUpdatedAt },
  })
  assert.equal(paused.status, 200, 'pause must succeed')
}

async function endActivity(app: App, session: Session, activityId: string): Promise<void> {
  const expectedUpdatedAt = await activityUpdatedAt(app, session, activityId)
  const ended = await api(app, 'POST', `/admin/activities/${activityId}/end`, {
    session,
    body: { expectedUpdatedAt },
  })
  assert.equal(ended.status, 200, 'end must succeed')
}

/** Reward overview plus the raw ledger, for "nothing was consumed" assertions. */
async function rewardFootprint(fixture: Fixture, activityId: string) {
  const overview = adminActivityRewardOverviewSchema.parse(
    await (await api(fixture.app, 'GET', `/admin/activities/${activityId}/rewards`, {
      session: fixture.operator,
    })).json(),
  )
  const stock = fixture.db
    .select({
      claimedQuantity: activityPrizeStocks.claimedQuantity,
      committedBudgetCents: activityPrizeStocks.committedBudgetCents,
    })
    .from(activityPrizeStocks)
    .where(eq(activityPrizeStocks.activityId, activityId))
    .all()
  return { overview, stock }
}

test('F1: a non-recipient cannot rotate the recipient credential after a grant exists', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture, {
    plan: rewardPlan({ claimRecipient: 'leader' }),
  })
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, residents, activityId)
  for (const resident of residents) await selfCheckin(app, resident, activityId)
  await verifyAllCheckins(app, fixture.operator, activityId)

  const leaderClaim = await claimReward(app, residents[0]!, activityId)
  assert.equal(leaderClaim.created, true)
  assert.equal(leaderClaim.grant.recipientUserId, leaderClaim.grant.recipientUserId)

  // The teammate is not the recipient and must be refused. Before the fix this
  // returned 200 with a fresh plaintext code and silently superseded the
  // leader's, so the prize could be handed over by whoever called last.
  const memberClaim = await api(app, 'POST', `/activities/${activityId}/rewards/claim`, {
    session: residents[1]!,
    emptyBody: true,
  })
  // `expectError` already parsed the envelope; the reason must say the prize
  // belongs to another member, not merely "forbidden".
  const memberError = await expectError(
    memberClaim,
    403,
    API_ERROR_CODES.forbidden,
    'non-recipient re-claim',
  )
  assert.match(memberError.error.message, /受领人/u)

  // The leader's original code still works: it was never superseded.
  const redeemed = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code: leaderClaim.code },
  })
  assert.equal(redeemed.status, 200, "the recipient's original code must still redeem")

  // Exactly one credential was ever minted for this grant.
  const codes = fixture.db
    .select({ id: activityRewardCodes.id })
    .from(activityRewardCodes)
    .where(eq(activityRewardCodes.grantId, leaderClaim.grant.id))
    .all()
  assert.equal(codes.length, 1, 'the refused re-claim minted no credential')
})

test('F2: re-claiming a redeemed grant mints no dead code and codesActive stays honest', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, residents, activityId)
  for (const resident of residents) await selfCheckin(app, resident, activityId)
  await verifyAllCheckins(app, fixture.operator, activityId)

  const claim = await claimReward(app, residents[0]!, activityId)
  const redeemed = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code: claim.code },
  })
  assert.equal(redeemed.status, 200)

  // Re-claiming after redemption is refused rather than answered with a fresh
  // `active` code that redemption could only ever answer 409 to.
  const reClaim = await api(app, 'POST', `/activities/${activityId}/rewards/claim`, {
    session: residents[0]!,
    emptyBody: true,
  })
  await expectError(reClaim, 409, API_ERROR_CODES.rewardAlreadyRedeemed, 're-claim after redeem')

  const codes = fixture.db
    .select({ id: activityRewardCodes.id, status: activityRewardCodes.status })
    .from(activityRewardCodes)
    .where(eq(activityRewardCodes.grantId, claim.grant.id))
    .all()
  assert.equal(codes.length, 1, 'no dead code was minted')
  assert.deepEqual(
    codes.map((row) => row.status),
    ['redeemed'],
  )

  const { overview } = await rewardFootprint(fixture, activityId)
  assert.equal(overview.counts.codesActive, 0, 'nothing is presented as in-flight')
  assert.equal(overview.counts.codesRedeemed, 1)
  assert.equal(overview.counts.grantsRedeemed, 1)
})

test('F3: pausing after qualification closes claim, and consumes no stock or budget', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, residents, activityId)
  // The real sequence: qualify first, THEN pause. The old test paused first, so
  // it only ever proved `checkin_incomplete` and never exercised the lifecycle.
  for (const resident of residents) await selfCheckin(app, resident, activityId)
  await verifyAllCheckins(app, fixture.operator, activityId)
  await pauseActivity(app, fixture.admin, activityId)

  const state = teamRewardStateSchema.parse(
    await (await api(app, 'GET', `/activities/${activityId}/rewards`, {
      session: residents[0]!,
    })).json(),
  )
  assert.equal(state.eligible, false, 'a paused activity cannot be claimable')
  assert.equal(state.claimableByMe, false)
  assert.equal(state.unavailableReason, 'activity_not_published')

  const claim = await api(app, 'POST', `/activities/${activityId}/rewards/claim`, {
    session: residents[0]!,
    emptyBody: true,
  })
  await expectError(claim, 409, API_ERROR_CODES.rewardUnavailable, 'claim on a paused activity')

  // The check-in surface is closed at the same instant: no split verdict.
  const checkinState = activityCheckinStateSchema.parse(
    await (await api(app, 'GET', `/activities/${activityId}/checkin`, {
      session: residents[0]!,
    })).json(),
  )
  assert.equal(checkinState.available, false)

  const { overview, stock } = await rewardFootprint(fixture, activityId)
  assert.equal(overview.counts.grantsTotal, 0, 'no grant leaked out')
  assert.deepEqual(stock, [], 'no stock row was opened')
  assert.ok(overview.stock === null || overview.stock.claimedQuantity === 0)
})

test('F3: ending after qualification closes claim with an activity_ended reason', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, residents, activityId)
  for (const resident of residents) await selfCheckin(app, resident, activityId)
  await verifyAllCheckins(app, fixture.operator, activityId)
  await endActivity(app, fixture.admin, activityId)

  const state = teamRewardStateSchema.parse(
    await (await api(app, 'GET', `/activities/${activityId}/rewards`, {
      session: residents[0]!,
    })).json(),
  )
  assert.equal(state.eligible, false)
  assert.equal(state.claimableByMe, false)
  // `activity_ended` is now reachable on the claim surface, not just on check-in.
  assert.equal(state.unavailableReason, 'activity_ended')

  const claim = await api(app, 'POST', `/activities/${activityId}/rewards/claim`, {
    session: residents[0]!,
    emptyBody: true,
  })
  await expectError(claim, 409, API_ERROR_CODES.rewardUnavailable, 'claim on an ended activity')

  const { overview, stock } = await rewardFootprint(fixture, activityId)
  assert.equal(overview.counts.grantsTotal, 0)
  assert.deepEqual(stock, [])
})

test('F3: pausing after a claim closes redemption, leaving the ledger untouched', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, residents, activityId)
  for (const resident of residents) await selfCheckin(app, resident, activityId)
  await verifyAllCheckins(app, fixture.operator, activityId)

  const claim = await claimReward(app, residents[0]!, activityId)
  await pauseActivity(app, fixture.admin, activityId)

  const redeem = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code: claim.code },
  })
  // A genuine credential on a closed activity: 409 `reward_unavailable`, not a
  // 404 that would tell staff the resident handed them a bad slip.
  await expectError(redeem, 409, API_ERROR_CODES.rewardUnavailable, 'redeem on a paused activity')

  const { overview } = await rewardFootprint(fixture, activityId)
  assert.equal(overview.counts.grantsRedeemed, 0, 'nothing was redeemed')
  assert.equal(overview.counts.codesRedeemed, 0)
  // The claim itself still stands: pausing does not roll back an issued prize.
  assert.equal(overview.counts.grantsGranted, 1)
  assert.equal(overview.counts.codesActive, 1)

  // Resuming makes the same code work again — the refusal was about the
  // activity being closed, not about the credential being bad.
  const expectedUpdatedAt = await activityUpdatedAt(app, fixture.admin, activityId)
  const resumed = await api(app, 'POST', `/admin/activities/${activityId}/resume`, {
    session: fixture.admin,
    body: { expectedUpdatedAt },
  })
  assert.equal(resumed.status, 200)
  const redeemed = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code: claim.code },
  })
  assert.equal(redeemed.status, 200, 'the credential survives the pause')
})

test('F3: ending after a claim closes redemption too', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture)
  const residents = await Promise.all(
    ['居民甲', '居民乙', '居民丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, residents, activityId)
  for (const resident of residents) await selfCheckin(app, resident, activityId)
  await verifyAllCheckins(app, fixture.operator, activityId)

  const claim = await claimReward(app, residents[0]!, activityId)
  await endActivity(app, fixture.admin, activityId)

  const redeem = await api(app, 'POST', '/rewards/redeem', {
    session: fixture.grid,
    body: { code: claim.code },
  })
  await expectError(redeem, 409, API_ERROR_CODES.rewardUnavailable, 'redeem on an ended activity')

  const { overview } = await rewardFootprint(fixture, activityId)
  assert.equal(overview.counts.grantsRedeemed, 0)
})

/* -------------------------------------------------------------------------- */
/* t11: the resident reward state must never 500 on an exhausted pool         */
/* -------------------------------------------------------------------------- */

test('an exhausted prize pool answers 200 with stock_exhausted, not a 500', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  // Exactly one prize for the whole activity.
  const activityId = await createActivity(fixture, {
    plan: rewardPlan({ totalPrizeQuantity: 1, prizeUnitCostCents: 5_000, budgetCapCents: 5_000 }),
  })
  const first = await Promise.all(
    ['甲队甲', '甲队乙', '甲队丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, first, activityId)
  for (const resident of first) await selfCheckin(app, resident, activityId)
  await verifyAllCheckins(app, fixture.operator, activityId)
  await claimReward(app, first[0]!, activityId)

  // A second qualified team now finds the pool empty.
  const second = await Promise.all(
    ['乙队甲', '乙队乙', '乙队丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, second, activityId)
  for (const resident of second) await selfCheckin(app, resident, activityId)
  await verifyPendingCheckins(app, fixture.operator, activityId)

  const response = await api(app, 'GET', `/activities/${activityId}/rewards`, {
    session: second[0]!,
  })
  // 200, not 500: the state projection used to return `eligible: true` beside
  // `unavailableReason: 'stock_exhausted'`, which the contract rejects.
  assert.equal(response.status, 200, 'reading an exhausted pool is not an error')
  const state = teamRewardStateSchema.parse(await response.json())
  assert.equal(state.eligible, false)
  assert.equal(state.unavailableReason, 'stock_exhausted')
  assert.equal(state.claimableByMe, false)

  // The claim agrees with the projection.
  const claim = await api(app, 'POST', `/activities/${activityId}/rewards/claim`, {
    session: second[0]!,
    emptyBody: true,
  })
  await expectError(claim, 409, API_ERROR_CODES.prizeStockExhausted, 'claim from an exhausted pool')

  // The admin overview shares the same ledger projection; it must stay
  // contract-valid (parse, not throw) while the pool is empty.
  const overview = adminActivityRewardOverviewSchema.parse(
    await (await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
      session: fixture.operator,
    })).json(),
  )
  assert.equal(overview.stock?.availableQuantity, 0)
  assert.equal(overview.stock?.remainingBudgetCents, 0)
  assert.equal(overview.counts.grantsGranted, 1)
})

test('an exhausted budget answers 200 with budget_exhausted, not a 500', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  // Two prizes by count, but money for only one.
  const activityId = await createActivity(fixture, {
    plan: rewardPlan({ totalPrizeQuantity: 2, prizeUnitCostCents: 5_000, budgetCapCents: 5_000 }),
  })
  const first = await Promise.all(
    ['甲队甲', '甲队乙', '甲队丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, first, activityId)
  for (const resident of first) await selfCheckin(app, resident, activityId)
  await verifyAllCheckins(app, fixture.operator, activityId)
  await claimReward(app, first[0]!, activityId)

  const second = await Promise.all(
    ['乙队甲', '乙队乙', '乙队丙'].map((name) => residentSession(app, name, fixture.communityId)),
  )
  await joinTeam(app, second, activityId)
  for (const resident of second) await selfCheckin(app, resident, activityId)
  await verifyPendingCheckins(app, fixture.operator, activityId)

  const response = await api(app, 'GET', `/activities/${activityId}/rewards`, {
    session: second[0]!,
  })
  assert.equal(response.status, 200, 'reading an exhausted budget is not an error')
  const state = teamRewardStateSchema.parse(await response.json())
  assert.equal(state.eligible, false)
  assert.equal(state.unavailableReason, 'budget_exhausted')
  assert.equal(state.claimableByMe, false)

  const claim = await api(app, 'POST', `/activities/${activityId}/rewards/claim`, {
    session: second[0]!,
    emptyBody: true,
  })
  await expectError(claim, 409, API_ERROR_CODES.budgetExceeded, 'claim from an exhausted budget')

  const overview = adminActivityRewardOverviewSchema.parse(
    await (await api(app, 'GET', `/admin/activities/${activityId}/rewards`, {
      session: fixture.operator,
    })).json(),
  )
  // Quantity remains, money does not: the two counters must tell different
  // stories here, which is exactly what a naive projection would flatten.
  assert.equal(overview.stock?.availableQuantity, 1)
  assert.equal(overview.stock?.remainingBudgetCents, 0)
})

/* -------------------------------------------------------------------------- */
/* t13: the check-in window must sit inside the activity (HTTP surface)       */
/* -------------------------------------------------------------------------- */

test('a plan whose check-in window falls outside the activity is refused with 400', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  // Activity runs 2026-12-01 02:00 .. 10:00 UTC; put the window a month earlier.
  const response = await api(app, 'POST', '/admin/activities', {
    session: fixture.admin,
    body: {
      communityId: fixture.communityId,
      title: '窗口越界活动',
      keyRules: {
        startsAt: '2026-12-01T02:00:00.000Z',
        endsAt: '2026-12-01T10:00:00.000Z',
        location: '幸福社区党群服务中心',
        budgetCapCents: 50_000,
        prizeQuantityCap: 10,
        publicRules: {
          eligibility: '本社区 60 岁以上居民',
          checkin: '现场签到',
          purchase: '无消费门槛',
          prizeClaim: '达标后凭核销码领取',
        },
        rewardPlan: rewardPlan({
          checkinWindow: {
            opensAt: '2026-11-01T00:00:00.000Z',
            closesAt: '2026-11-10T00:00:00.000Z',
          },
        }),
      },
    },
  })
  // 400 at the HTTP boundary, not a 500: the body fails `createActivityRequestSchema`.
  await expectError(response, 400, API_ERROR_CODES.invalidRequest, 'check-in window out of bounds')

  // And nothing was written.
  const list = await api(app, 'GET', `/admin/activities?communityId=${fixture.communityId}`, {
    session: fixture.admin,
  })
  const items = ((await list.json()) as { items: Array<{ title: string }> }).items
  assert.equal(items.some((item) => item.title === '窗口越界活动'), false)
})

test('a plan whose check-in window is inside the activity is accepted with 201', async () => {
  const fixture = await createFixture()
  // `createActivity` derives the activity window from the same `NOW` the default
  // plan uses, so an explicitly-nested window must be expressed relative to it.
  const activityId = await createActivity(fixture, {
    plan: rewardPlan({
      checkinWindow: {
        opensAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
        closesAt: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
      },
    }),
  })
  const detail = await api(fixture.app, 'GET', `/admin/activities/${activityId}`, {
    session: fixture.admin,
  })
  assert.equal(detail.status, 200)
})

/* -------------------------------------------------------------------------- */
/* t17 / B1: an inherited-plan edit that goes out of bounds must be a 400      */
/*                                                                             */
/* The contract makes `rewardPlan` optional and documents "key absent ->       */
/* inherit the stored plan" as supported. Such an edit is legal input, so the  */
/* failure mode must be a normal 400 with an error code - not the empty-body   */
/* 500 that a raw `ZodError` produced (zod 4's ZodError is not an             */
/* `instanceof Error`, so Hono's #handleError re-throws it and never runs      */
/* `onError`). These tests assert the HTTP status explicitly because the       */
/* original gap was exactly that no test ever mapped this rule to a status.    */
/* -------------------------------------------------------------------------- */

test('an edit that omits rewardPlan and shrinks the activity is refused with 400', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  // Activity runs from NOW-1d to NOW+7d; its plan closes at NOW+30m, so it is
  // comfortably in bounds at creation.
  const activityId = await createActivity(fixture, {
    plan: rewardPlan({
      checkinWindow: {
        opensAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
        closesAt: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
      },
    }),
  })
  const before = await api(app, 'GET', `/admin/activities/${activityId}`, {
    session: fixture.admin,
  })
  const detail = (await before.json()) as AdminActivityDetail & { updatedAt: string }

  // Send the full keyRules back EXCEPT `rewardPlan`, and pull `endsAt` in front of
  // the inherited window's close. The stored plan is in bounds w.r.t. the OLD
  // activity window, so this edit is the one that introduces the violation.
  const response = await api(app, 'PATCH', `/admin/activities/${activityId}`, {
    session: fixture.admin,
    body: {
      expectedUpdatedAt: detail.updatedAt,
      keyRules: {
        startsAt: detail.startsAt,
        endsAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
        location: detail.location,
        budgetCapCents: detail.budgetCapCents,
        prizeQuantityCap: detail.prizeQuantityCap,
        publicRules: detail.publicRules,
        // rewardPlan deliberately omitted: contract says "inherit the stored plan"
      },
    },
  })
  // The whole point: a 400 with a code, NOT an empty-body 500 and not a rejected
  // promise. `expectError` also proves a parseable error envelope came back.
  const body = await expectError(
    response,
    400,
    API_ERROR_CODES.invalidRequest,
    'inherited plan out of bounds',
  )
  assert.match(body.error.message, /checkinWindow/u)

  // Nothing was written: the activity still ends where it did.
  const after = await api(app, 'GET', `/admin/activities/${activityId}`, {
    session: fixture.admin,
  })
  const afterDetail = (await after.json()) as AdminActivityDetail
  assert.equal(afterDetail.endsAt, detail.endsAt)
  assert.deepEqual(afterDetail.rewardPlan, detail.rewardPlan)
})

test('an edit that omits rewardPlan and keeps the window in bounds still succeeds', async () => {
  const fixture = await createFixture()
  const { app } = fixture
  const activityId = await createActivity(fixture, {
    plan: rewardPlan({
      checkinWindow: {
        opensAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
        closesAt: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
      },
    }),
  })
  const before = await api(app, 'GET', `/admin/activities/${activityId}`, {
    session: fixture.admin,
  })
  const detail = (await before.json()) as AdminActivityDetail & { updatedAt: string }

  // Widen the activity instead: the inherited window stays inside it.
  const response = await api(app, 'PATCH', `/admin/activities/${activityId}`, {
    session: fixture.admin,
    body: {
      expectedUpdatedAt: detail.updatedAt,
      keyRules: {
        startsAt: detail.startsAt,
        endsAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        location: '幸福社区党群服务中心（新址）',
        budgetCapCents: detail.budgetCapCents,
        prizeQuantityCap: detail.prizeQuantityCap,
        publicRules: detail.publicRules,
      },
    },
  })
  assert.equal(response.status, 200, 'a legal inherited-plan edit is not refused')
  const updated = (await response.json()) as AdminActivityDetail
  // The inherited plan survived the edit - the t7 guarantee, still holding.
  assert.deepEqual(updated.rewardPlan, detail.rewardPlan)
  assert.equal(updated.location, '幸福社区党群服务中心（新址）')
})
