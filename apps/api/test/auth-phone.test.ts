import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import {
  PHONE_AUTH_ROUTES,
  maskMainlandPhone,
  normalizeMainlandPhone,
  type PhoneOtpPurpose,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig, type ApiConfig } from '../src/config.js'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import {
  activities,
  activityParticipations,
  activityRewardGrants,
  activityRuleVersions,
  activityTeams,
  auditLogs,
  communities,
  phoneOtpRequestCounters,
  phoneVerificationCodes,
  residentPhoneIdentities,
  sessions,
  users,
  wechatIdentities,
} from '../src/db/schema.js'
import { hashToken, randomToken } from '../src/auth/security.js'
import {
  PHONE_OTP_MAX_ATTEMPTS,
  PHONE_OTP_PHONE_DAILY_MAX,
  PHONE_OTP_PHONE_HOURLY_MAX,
  PHONE_OTP_RESEND_COOLDOWN_SECONDS,
  PHONE_OTP_TTL_SECONDS,
  type SmsSender,
} from '../src/auth/phone.js'

/**
 * Real HTTP acceptance suite for the phone / SMS one-time-code identity (#93).
 *
 * Every test drives the actual Hono app against a real, freshly migrated SQLite
 * database. The only test seam is the injected `SmsSender` (the delivery channel
 * a real provider would implement) and an injected clock, so expiry, cooldown
 * and throttle windows are exercised without sleeping.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const DEFAULT_IP = '203.0.113.7'
const COOKIE_ORIGIN = 'http://localhost:5174'

interface CapturedSms {
  phone: string
  code: string
  purpose: PhoneOtpPurpose
  expiresInSeconds: number
}

interface TestContext {
  app: ReturnType<typeof createApp>
  db: AppDatabase
  sqlite: SqliteConnection
  outbox: CapturedSms[]
  clock: { current: Date }
  config: ApiConfig
}

function testContext(
  options: {
    /** `null` = deployment without any SMS provider (production default). */
    sender?: SmsSender | null
    env?: NodeJS.ProcessEnv
    logRequests?: boolean
  } = {},
): TestContext {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true', ...options.env })
  const outbox: CapturedSms[] = []
  const capture: SmsSender = {
    async sendVerificationCode(message) {
      outbox.push({ ...message })
    },
  }
  const sender = options.sender === null ? undefined : (options.sender ?? capture)
  const clock = { current: new Date('2026-11-05T00:00:00.000Z') }
  const app = createApp({
    db,
    config,
    logRequests: options.logRequests ?? false,
    smsSender: sender,
    now: () => clock.current,
  })
  return { app, db, sqlite, outbox, clock, config }
}

function advance(context: TestContext, milliseconds: number): void {
  context.clock.current = new Date(context.clock.current.getTime() + milliseconds)
}

function advanceSeconds(context: TestContext, seconds: number): void {
  advance(context, seconds * 1000)
}

/* ------------------------------- HTTP helpers ------------------------------ */

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

function cookieHeader(...pairs: string[]): string {
  return pairs.join('; ')
}

async function csrf(app: ReturnType<typeof createApp>) {
  const response = await app.request('/auth/csrf')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { csrfToken: string }
  return { token: body.csrfToken, cookie: cookiePair(response, 'll_csrf') }
}

function postHeaders(cookie: string, token: string, ip: string = DEFAULT_IP) {
  return {
    'content-type': 'application/json',
    cookie,
    'x-csrf-token': token,
    origin: COOKIE_ORIGIN,
    'x-forwarded-for': ip,
  }
}

async function requestOtp(
  context: TestContext,
  phone: string,
  purpose: PhoneOtpPurpose = 'login',
  ip: string = DEFAULT_IP,
) {
  const state = await csrf(context.app)
  const response = await context.app.request(PHONE_AUTH_ROUTES.requestOtp, {
    method: 'POST',
    headers: postHeaders(state.cookie, state.token, ip),
    body: JSON.stringify({ phone, purpose }),
  })
  return { response, state }
}

/**
 * Requests a code with full control over the forwarding headers, so the IP
 * throttle can be exercised the way a reverse proxy and a spoofing client would
 * actually present themselves.
 */
async function requestOtpWithHeaders(
  context: TestContext,
  phone: string,
  headers: Record<string, string>,
  purpose: PhoneOtpPurpose = 'login',
) {
  const state = await csrf(context.app)
  return context.app.request(PHONE_AUTH_ROUTES.requestOtp, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: state.cookie,
      'x-csrf-token': state.token,
      origin: COOKIE_ORIGIN,
      ...headers,
    },
    body: JSON.stringify({ phone, purpose }),
  })
}

function lastCode(context: TestContext, phone: string): string {
  const normalized = normalizeMainlandPhone(phone)
  const message = [...context.outbox]
    .reverse()
    .find((item) => normalizeMainlandPhone(item.phone) === normalized)
  assert.ok(message, `expected a delivered SMS for ${phone}`)
  return message.code
}

async function phoneLogin(
  context: TestContext,
  phone: string,
  code: string,
  ip: string = DEFAULT_IP,
) {
  const state = await csrf(context.app)
  return context.app.request(PHONE_AUTH_ROUTES.login, {
    method: 'POST',
    headers: postHeaders(state.cookie, state.token, ip),
    body: JSON.stringify({ phone, code }),
  })
}

async function bindPhone(
  context: TestContext,
  phone: string,
  code: string,
  session: { cookie: string; csrfToken: string },
) {
  return context.app.request(PHONE_AUTH_ROUTES.bind, {
    method: 'POST',
    headers: postHeaders(session.cookie, session.csrfToken),
    body: JSON.stringify({ phone, code }),
  })
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/* ------------------------------- Seeding ---------------------------------- */

function createUser(db: AppDatabase, displayName: string | null): string {
  const id = randomUUID()
  const now = new Date()
  db.insert(users).values({ id, displayName, createdAt: now, updatedAt: now }).run()
  return id
}

function seedSession(db: AppDatabase, userId: string) {
  const token = randomToken()
  const csrfToken = randomToken()
  const now = new Date()
  db.insert(sessions)
    .values({
      id: randomUUID(),
      userId,
      staffAccountId: null,
      tokenHash: hashToken(token),
      csrfHash: hashToken(csrfToken),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      createdAt: now,
      lastSeenAt: now,
    })
    .run()
  return { cookie: `ll_session=${token}; ll_csrf=${csrfToken}`, csrfToken }
}

/**
 * Seeds one real activity/team/participation/grant owned by `userId`. These rows
 * stand in for "existing 报名/奖励归属" and every later assertion checks they are
 * neither re-pointed nor rewritten by phone login/binding.
 */
function seedAttribution(db: AppDatabase, userId: string) {
  const now = new Date('2026-11-05T00:00:00.000Z')
  const communityId = randomUUID()
  const activityId = randomUUID()
  const ruleVersionId = randomUUID()
  const teamId = randomUUID()
  const participationId = randomUUID()
  const grantId = randomUUID()
  db.insert(communities).values({ id: communityId, name: `测试社区-${communityId.slice(0, 6)}`, createdAt: now }).run()
  db.insert(activities)
    .values({
      id: activityId,
      communityId,
      title: '邻里互助活动',
      summary: null,
      description: null,
      status: 'published',
      startsAt: now,
      endsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      location: '社区活动中心',
      budgetCapCents: 100_000,
      prizeQuantityCap: 10,
      publicRulesJson: '{}',
      rewardPlanJson: null,
      currentRuleVersionId: null,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
      pausedAt: null,
      endedAt: null,
    })
    .run()
  db.insert(activityRuleVersions)
    .values({
      id: ruleVersionId,
      activityId,
      version: 1,
      snapshotJson: JSON.stringify({
        rewardPlan: { prizeName: '米油礼包', prizeUnitCostCents: 100, prizeQuantityPerTeam: 1 },
      }),
      createdByUserId: userId,
      createdAt: now,
    })
    .run()
  db.insert(activityTeams)
    .values({ id: teamId, activityId, leaderUserId: userId, status: 'open', createdAt: now })
    .run()
  db.insert(activityParticipations)
    .values({
      id: participationId,
      activityId,
      teamId,
      userId,
      seatNo: 1,
      role: 'leader',
      inviteSource: 'self',
      invitationId: null,
      joinedAt: now,
    })
    .run()
  db.insert(activityRewardGrants)
    .values({
      id: grantId,
      activityId,
      ruleVersionId,
      teamId,
      prizeName: '米油礼包',
      quantity: 1,
      unitCostCents: 100,
      totalCostCents: 100,
      status: 'granted',
      recipientRole: 'leader',
      recipientUserId: userId,
      grantedAt: now,
      redeemedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { activityId, teamId, participationId, grantId }
}

function attributionOf(db: AppDatabase, userId: string) {
  return {
    participations: db
      .select()
      .from(activityParticipations)
      .where(eq(activityParticipations.userId, userId))
      .all(),
    grants: db
      .select()
      .from(activityRewardGrants)
      .where(eq(activityRewardGrants.recipientUserId, userId))
      .all(),
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Shared contract helpers                                                 */
/* -------------------------------------------------------------------------- */

test('mainland phone normalization and masking are canonical and strict', () => {
  for (const input of [
    '13800138000',
    ' 13800138000 ',
    '138 0013 8000',
    '138-0013-8000',
    '+86 138-0013-8000',
    '+8613800138000',
    '8613800138000',
    '86 138 0013 8000',
  ]) {
    assert.equal(normalizeMainlandPhone(input), '13800138000', `expected canonical form for ${JSON.stringify(input)}`)
  }
  assert.equal(normalizeMainlandPhone('19912345678'), '19912345678')
  for (const invalid of [
    '',
    '   ',
    '1380013800', // 10 digits
    '138001380001', // 12 digits
    '23800138000', // wrong second digit
    '12800138000', // second digit 2 is not a mobile prefix
    '1380013800a',
    '12345',
    '+1 415 555 0100', // foreign number must not be coerced
    '010-12345678', // landline
    null,
    undefined,
    13800138000 as unknown as string,
  ]) {
    assert.equal(normalizeMainlandPhone(invalid), null, `expected rejection for ${String(invalid)}`)
  }
  assert.equal(maskMainlandPhone('13800138000'), '138****8000')
})

/* -------------------------------------------------------------------------- */
/* 2. Login creates exactly one platform UUID and reuses it                   */
/* -------------------------------------------------------------------------- */

test('phone login creates one platform identity and reuses the same UUID on repeat login', async () => {
  const context = testContext()
  try {
    const first = await requestOtp(context, '+86 138-0013-8000', 'login')
    assert.equal(first.response.status, 202)
    const issued = await readJson<Record<string, unknown>>(first.response)
    assert.deepEqual(Object.keys(issued).sort(), [
      'accepted',
      'expiresInSeconds',
      'maxAttempts',
      'retryAfterSeconds',
    ])
    assert.equal(issued.expiresInSeconds, PHONE_OTP_TTL_SECONDS)
    assert.equal(issued.retryAfterSeconds, PHONE_OTP_RESEND_COOLDOWN_SECONDS)
    assert.equal(issued.maxAttempts, PHONE_OTP_MAX_ATTEMPTS)
    // The delivery channel is the only place a plaintext code exists.
    assert.equal(context.outbox.length, 1)
    assert.equal(context.outbox[0]?.phone, '13800138000')
    assert.match(context.outbox[0]!.code, /^\d{6}$/)

    const code = lastCode(context, '13800138000')
    const login = await phoneLogin(context, '138 0013 8000', code)
    assert.equal(login.status, 200)
    const session = await readJson<{
      authenticated: boolean
      user: { id: string; displayName: string | null }
      staff: unknown
      csrfToken: string
    }>(login)
    assert.equal(session.authenticated, true)
    assert.equal(session.user.displayName, '138****8000')
    assert.equal(session.staff, null)
    const firstUserId = session.user.id

    // The normalized 11-digit phone is the stored identity key.
    const identity = context.db.select().from(residentPhoneIdentities).get()
    assert.equal(identity?.phone, '13800138000')
    assert.equal(identity?.userId, firstUserId)

    const cookies = cookieHeader(cookiePair(login, 'll_session'), cookiePair(login, 'll_csrf'))
    const sessionRead = await context.app.request('/auth/session', { headers: { cookie: cookies } })
    const sessionBody = await readJson<{ authenticated: boolean; user: { id: string } }>(sessionRead)
    assert.equal(sessionBody.user.id, firstUserId)

    // Second login, after the resend cooldown, must resolve the same UUID.
    advanceSeconds(context, PHONE_OTP_RESEND_COOLDOWN_SECONDS + 1)
    const second = await requestOtp(context, '13800138000', 'login')
    assert.equal(second.response.status, 202)
    const secondLogin = await phoneLogin(context, '13800138000', lastCode(context, '13800138000'))
    assert.equal(secondLogin.status, 200)
    const secondBody = await readJson<{ user: { id: string } }>(secondLogin)
    assert.equal(secondBody.user.id, firstUserId)

    assert.equal(context.db.select().from(users).all().length, 1)
    assert.equal(context.db.select().from(residentPhoneIdentities).all().length, 1)
    assert.equal(context.db.select().from(residentPhoneIdentities).get()?.phone, '13800138000')
  } finally {
    context.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 3. Hashing, no leakage, no fixed code                                      */
/* -------------------------------------------------------------------------- */

test('OTP is hash-only and never reaches a response, log line or audit row', async () => {
  const captured: string[] = []
  const originalLog = console.log
  const context = testContext({ logRequests: true })
  try {
    console.log = (...args: unknown[]) => {
      captured.push(args.map((value) => String(value)).join(' '))
    }
    const request = await requestOtp(context, '13800138000', 'login')
    assert.equal(request.response.status, 202)
    const code = lastCode(context, '13800138000')

    const stored = context.db.select().from(phoneVerificationCodes).get()
    assert.ok(stored)
    // Salted hash: neither the code nor its unsalted digest is stored.
    assert.match(stored.codeHash, /^[0-9a-f]{64}$/)
    assert.notEqual(stored.codeHash, code)
    assert.notEqual(stored.codeHash, hashToken(code))
    assert.notEqual(stored.codeHash, hashToken(`13800138000:${code}`))
    for (const value of Object.values(stored)) {
      assert.notEqual(String(value), code)
    }
    // The throttle table stores only hashes of the phone / IP scope.
    for (const counter of context.db.select().from(phoneOtpRequestCounters).all()) {
      assert.match(counter.key, /^[0-9a-f]{64}$/)
      assert.equal(counter.key.includes('13800138000'), false)
      assert.equal(counter.key.includes(DEFAULT_IP), false)
    }

    const wrong = await phoneLogin(context, '13800138000', '000000')
    assert.equal(wrong.status, 400)
    const wrongBody = await readJson<{ error: { code: string; message: string } }>(wrong)
    assert.equal(wrongBody.error.code, 'otp_invalid')
    assert.equal(JSON.stringify(wrongBody).includes(code), false)

    const ok = await phoneLogin(context, '13800138000', code)
    assert.equal(ok.status, 200)

    // Every audit row is free of the code and of the raw phone number.
    const auditRows = context.db.select().from(auditLogs).all()
    assert.ok(auditRows.length > 0)
    for (const row of auditRows) {
      const serialized = `${row.event} ${row.metadata ?? ''} ${row.targetId ?? ''}`
      assert.equal(serialized.includes(code), false)
      assert.equal(serialized.includes('13800138000'), false)
    }
    // The app did log requests (logRequests: true) but never the code.
    assert.ok(captured.some((line) => line.includes('request.completed')))
    for (const line of captured) {
      assert.equal(line.includes(code), false, `verification code leaked into a log line: ${line}`)
    }
  } finally {
    console.log = originalLog
    context.sqlite.close()
  }
})

test('no fixed or master code exists: only the delivered code is accepted', async () => {
  const context = testContext()
  try {
    await requestOtp(context, '13800138000', 'login')
    const code = lastCode(context, '13800138000')
    for (const guess of ['000000', '123456', '666666', '888888']) {
      if (guess === code) continue
      const attempt = await phoneLogin(context, '13800138000', guess)
      assert.notEqual(attempt.status, 200, `fixed code ${guess} must not authenticate`)
    }
  } finally {
    context.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 4. Production without a sender fails closed                               */
/* -------------------------------------------------------------------------- */

test('a deployment without an SMS sender answers 503 not_configured and stores nothing', async () => {
  const context = testContext({
    sender: null,
    env: {
      NODE_ENV: 'production',
      AUTH_DEV_ENABLED: 'false',
      WEB_BASE_URL: 'https://local-life.example.test',
      TRUSTED_ORIGINS: 'http://localhost:5174',
    },
  })
  try {
    const status = await context.app.request(PHONE_AUTH_ROUTES.status)
    const statusBody = await readJson<{ configured: boolean; authenticated: boolean; maskedPhone: string | null }>(status)
    assert.deepEqual(statusBody, { configured: false, authenticated: false, maskedPhone: null })

    const request = await requestOtp(context, '13800138000', 'login')
    assert.equal(request.response.status, 503)
    const body = await readJson<{ error: { code: string; message: string } }>(request.response)
    assert.equal(body.error.code, 'not_configured')
    // Nothing was stored and nothing was "delivered".
    assert.equal(context.db.select().from(phoneVerificationCodes).all().length, 0)
    assert.equal(context.db.select().from(phoneOtpRequestCounters).all().length, 0)
    assert.equal(context.outbox.length, 0)

    // Login cannot succeed either: no code can ever be issued.
    const login = await phoneLogin(context, '13800138000', '123456')
    assert.equal(login.status, 400)
    assert.equal((await readJson<{ error: { code: string } }>(login)).error.code, 'otp_invalid')
  } finally {
    context.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 5. Expiry, single use, supersede                                           */
/* -------------------------------------------------------------------------- */

test('expired codes are rejected and a fresh code still works', async () => {
  const context = testContext()
  try {
    await requestOtp(context, '13800138000', 'login')
    const expiredCode = lastCode(context, '13800138000')
    advanceSeconds(context, PHONE_OTP_TTL_SECONDS + 1)

    const expired = await phoneLogin(context, '13800138000', expiredCode)
    assert.equal(expired.status, 400)
    assert.equal((await readJson<{ error: { code: string } }>(expired)).error.code, 'otp_expired')

    advanceSeconds(context, PHONE_OTP_RESEND_COOLDOWN_SECONDS)
    assert.equal((await requestOtp(context, '13800138000', 'login')).response.status, 202)
    const fresh = await phoneLogin(context, '13800138000', lastCode(context, '13800138000'))
    assert.equal(fresh.status, 200)
  } finally {
    context.sqlite.close()
  }
})

test('a code is single-use and re-requesting supersedes the previous code', async () => {
  const context = testContext()
  try {
    await requestOtp(context, '13800138000', 'login')
    const oldCode = lastCode(context, '13800138000')
    advanceSeconds(context, PHONE_OTP_RESEND_COOLDOWN_SECONDS + 1)
    await requestOtp(context, '13800138000', 'login')
    const newCode = lastCode(context, '13800138000')
    assert.notEqual(oldCode, newCode)

    const superseded = await phoneLogin(context, '13800138000', oldCode)
    assert.equal(superseded.status, 400)
    assert.equal((await readJson<{ error: { code: string } }>(superseded)).error.code, 'otp_invalid')

    const ok = await phoneLogin(context, '13800138000', newCode)
    assert.equal(ok.status, 200)

    const replay = await phoneLogin(context, '13800138000', newCode)
    assert.equal(replay.status, 400)
    assert.equal((await readJson<{ error: { code: string } }>(replay)).error.code, 'otp_invalid')
    const stored = context.db.select().from(phoneVerificationCodes).all()
    assert.equal(stored.filter((row) => row.consumedAt !== null).length, 1)
  } finally {
    context.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 6. Wrong-code attempt cap                                                  */
/* -------------------------------------------------------------------------- */

test('wrong codes are capped at the attempt limit and then invalidate the code', async () => {
  const context = testContext()
  try {
    await requestOtp(context, '13800138000', 'login')
    const code = lastCode(context, '13800138000')
    const wrongCode = code === '000001' ? '000002' : '000001'

    for (let attempt = 1; attempt < PHONE_OTP_MAX_ATTEMPTS; attempt += 1) {
      const response = await phoneLogin(context, '13800138000', wrongCode)
      assert.equal(response.status, 400)
      const body = await readJson<{ error: { code: string; message: string } }>(response)
      assert.equal(body.error.code, 'otp_invalid')
      assert.match(body.error.message, new RegExp(`还可尝试 ${PHONE_OTP_MAX_ATTEMPTS - attempt} 次`))
    }

    const last = await phoneLogin(context, '13800138000', wrongCode)
    assert.equal(last.status, 429)
    assert.equal((await readJson<{ error: { code: string } }>(last)).error.code, 'otp_attempts_exceeded')

    const stored = context.db.select().from(phoneVerificationCodes).get()
    assert.equal(stored?.attempts, PHONE_OTP_MAX_ATTEMPTS)
    assert.notEqual(stored?.invalidatedAt, null)

    // Even the real code is dead now: the resident must request a new one.
    const correct = await phoneLogin(context, '13800138000', code)
    assert.equal(correct.status, 400)
    assert.equal((await readJson<{ error: { code: string } }>(correct)).error.code, 'otp_invalid')
  } finally {
    context.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 7. Frequency control: cooldown, phone hourly/daily, IP daily               */
/* -------------------------------------------------------------------------- */

test('resend cooldown rejects an immediate second request with Retry-After', async () => {
  const context = testContext()
  try {
    assert.equal((await requestOtp(context, '13800138000', 'login')).response.status, 202)
    const blocked = await requestOtp(context, '13800138000', 'login')
    assert.equal(blocked.response.status, 429)
    assert.equal(
      (await readJson<{ error: { code: string } }>(blocked.response)).error.code,
      'otp_cooldown',
    )
    const retryAfter = Number(blocked.response.headers.get('retry-after'))
    assert.ok(retryAfter > 0 && retryAfter <= PHONE_OTP_RESEND_COOLDOWN_SECONDS)
    assert.equal(context.db.select().from(phoneVerificationCodes).all().length, 1)
  } finally {
    context.sqlite.close()
  }
})

test('per-phone hourly and daily caps bound the same number', async () => {
  const context = testContext()
  try {
    const phone = '13800138000'
    for (let issued = 1; issued <= PHONE_OTP_PHONE_HOURLY_MAX; issued += 1) {
      const response = await requestOtp(context, phone, 'login')
      assert.equal(response.response.status, 202, `request ${issued} should succeed`)
      advanceSeconds(context, PHONE_OTP_RESEND_COOLDOWN_SECONDS + 1)
    }
    const hourly = await requestOtp(context, phone, 'login')
    assert.equal(hourly.response.status, 429)
    assert.equal((await readJson<{ error: { code: string } }>(hourly.response)).error.code, 'otp_request_limit')

    // Move into the next hourly window; the daily cap still applies.
    advance(context, 60 * 60 * 1000)
    const remaining = PHONE_OTP_PHONE_DAILY_MAX - PHONE_OTP_PHONE_HOURLY_MAX
    for (let issued = 0; issued < remaining; issued += 1) {
      const response = await requestOtp(context, phone, 'login')
      assert.equal(response.response.status, 202, `daily request ${issued + 1} should succeed`)
      advanceSeconds(context, PHONE_OTP_RESEND_COOLDOWN_SECONDS + 1)
    }
    const daily = await requestOtp(context, phone, 'login')
    assert.equal(daily.response.status, 429)
    assert.equal((await readJson<{ error: { code: string } }>(daily.response)).error.code, 'otp_request_limit')
  } finally {
    context.sqlite.close()
  }
})

test('per-IP daily cap bounds a single address even across many numbers', async () => {
  const context = testContext()
  try {
    for (let index = 0; index < 20; index += 1) {
      const phone = `1380013${String(8000 + index).padStart(4, '0')}`
      const response = await requestOtp(context, phone, 'login')
      assert.equal(response.response.status, 202, `IP request ${index + 1} should succeed`)
    }
    const blockedPhone = '13900139000'
    const blocked = await requestOtp(context, blockedPhone, 'login')
    assert.equal(blocked.response.status, 429)
    assert.equal((await readJson<{ error: { code: string } }>(blocked.response)).error.code, 'otp_request_limit')
    // The rejected request must not leave an issuable code behind.
    const stored = context.db
      .select()
      .from(phoneVerificationCodes)
      .where(eq(phoneVerificationCodes.phone, blockedPhone))
      .all()
    assert.equal(stored.length, 0)
  } finally {
    context.sqlite.close()
  }
})

/**
 * The left-most `X-Forwarded-For` entry is written by the caller, so keying the
 * throttle on it lets one client mint a fresh bucket per request. Only the
 * right-most entry (appended by the trusted reverse proxy) may be used; a proxy
 * that sets `X-Real-IP` instead is honoured as well.
 */
test('spoofed X-Forwarded-For prefixes cannot mint fresh IP throttle buckets', async () => {
  const context = testContext()
  try {
    const trustedHop = '203.0.113.7'
    // 20 delivered codes, each with a rotating spoofed prefix and the same hop.
    for (let index = 0; index < 20; index += 1) {
      const phone = `1380013${String(8100 + index).padStart(4, '0')}`
      const response = await requestOtp(
        context,
        phone,
        'login',
        `10.0.0.${index}, 198.51.100.${index}, ${trustedHop}`,
      )
      assert.equal(response.response.status, 202, `request ${index + 1} should succeed`)
    }

    // A brand-new spoofed prefix must not reset the bucket.
    const spoofedPhone = '13900139000'
    const spoofed = await requestOtp(context, spoofedPhone, 'login', `172.16.0.99, ${trustedHop}`)
    assert.equal(spoofed.response.status, 429)
    assert.equal(
      (await readJson<{ error: { code: string } }>(spoofed.response)).error.code,
      'otp_request_limit',
    )
    const stored = context.db
      .select()
      .from(phoneVerificationCodes)
      .where(eq(phoneVerificationCodes.phone, spoofedPhone))
      .all()
    assert.equal(stored.length, 0, 'a throttled request stores no code')

    // A single-value header maps to the same right-most hop.
    const bare = await requestOtp(context, '13900139001', 'login', trustedHop)
    assert.equal(bare.response.status, 429)

    // A genuinely different proxy hop is a different bucket.
    const otherHop = await requestOtp(context, '13900139002', 'login', '10.0.0.1, 198.51.100.9')
    assert.equal(otherHop.response.status, 202)

    // Proxies configured to set X-Real-IP instead of X-Forwarded-For still work.
    const realIp = await requestOtpWithHeaders(context, '13900139003', {
      'x-real-ip': '198.51.100.10',
    })
    assert.equal(realIp.status, 202)
  } finally {
    context.sqlite.close()
  }
})

/**
 * A provider outage must not behave like a delivered message: the undelivered
 * code is dead, no window is charged and the resident may retry at once instead
 * of waiting out the resend cooldown.
 */
test('a failed SMS delivery consumes no quota and can be retried immediately', async () => {
  const delivered: CapturedSms[] = []
  let failNext = true
  const flaky: SmsSender = {
    async sendVerificationCode(message) {
      delivered.push({ ...message })
      if (failNext) {
        failNext = false
        throw new Error('provider down')
      }
    },
  }
  const context = testContext({ sender: flaky })
  try {
    const phone = '13800138000'
    const failed = await requestOtp(context, phone, 'login')
    assert.equal(failed.response.status, 503)
    assert.equal(
      (await readJson<{ error: { code: string } }>(failed.response)).error.code,
      'sms_delivery_failed',
    )
    assert.equal(delivered.length, 1)
    assert.equal(context.db.select().from(phoneOtpRequestCounters).all().length, 0)

    // The code the resident never received cannot be used.
    const deadCode = delivered[0]?.code
    assert.ok(deadCode)
    const dead = await phoneLogin(context, phone, deadCode)
    assert.equal(dead.status, 400)
    assert.equal((await readJson<{ error: { code: string } }>(dead)).error.code, 'otp_invalid')

    // Retry without advancing the clock: no cooldown residue, no quota spent.
    const retry = await requestOtp(context, phone, 'login')
    assert.equal(retry.response.status, 202)
    assert.equal(delivered.length, 2)

    const login = await phoneLogin(context, phone, delivered[1]?.code ?? '')
    assert.equal(login.status, 200)

    // Only the delivered message advanced the three windows.
    const counters = context.db.select().from(phoneOtpRequestCounters).all()
    assert.equal(counters.length, 3)
    for (const counter of counters) assert.equal(counter.count, 1)
  } finally {
    context.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 8. Concurrency                                                             */
/* -------------------------------------------------------------------------- */

test('concurrent verifications of one code: exactly one login wins', async () => {
  const context = testContext()
  try {
    await requestOtp(context, '13800138000', 'login')
    const code = lastCode(context, '13800138000')
    const state = await csrf(context.app)
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        context.app.request(PHONE_AUTH_ROUTES.login, {
          method: 'POST',
          headers: postHeaders(state.cookie, state.token),
          body: JSON.stringify({ phone: '13800138000', code }),
        }),
      ),
    )
    const statuses = results.map((response) => response.status)
    assert.equal(statuses.filter((status) => status === 200).length, 1)
    assert.deepEqual(
      statuses.filter((status) => status !== 200),
      Array.from({ length: 7 }, () => 400),
    )
    assert.equal(context.db.select().from(users).all().length, 1)
    assert.equal(context.db.select().from(residentPhoneIdentities).all().length, 1)
    const stored = context.db.select().from(phoneVerificationCodes).get()
    assert.equal(stored?.consumedAt !== null, true)
  } finally {
    context.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 9. Database guarantees                                                     */
/* -------------------------------------------------------------------------- */

test('SQLite enforces the one-phone-one-account mapping and the phone shape', () => {
  const context = testContext()
  try {
    const userA = createUser(context.db, '居民A')
    const userB = createUser(context.db, '居民B')
    const now = new Date()
    context.db
      .insert(residentPhoneIdentities)
      .values({
        id: randomUUID(),
        userId: userA,
        phone: '13800138000',
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    assert.throws(
      () =>
        context.db
          .insert(residentPhoneIdentities)
          .values({
            id: randomUUID(),
            userId: userB,
            phone: '13800138000',
            verifiedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run(),
      /UNIQUE constraint failed/i,
    )
    assert.throws(
      () =>
        context.db
          .insert(residentPhoneIdentities)
          .values({
            id: randomUUID(),
            userId: userA,
            phone: '13900139000',
            verifiedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run(),
      /UNIQUE constraint failed/i,
    )
    assert.throws(
      () =>
        context.db
          .insert(residentPhoneIdentities)
          .values({
            id: randomUUID(),
            userId: userB,
            phone: '2380013800',
            verifiedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run(),
      /CHECK constraint failed/i,
    )

    const tables = (
      context.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
    for (const table of [
      'resident_phone_identities',
      'phone_verification_codes',
      'phone_otp_request_counters',
    ]) {
      assert.ok(tables.includes(table), `migration must create ${table}`)
    }
  } finally {
    context.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 10. Binding: same user, conflict, no attribution move                      */
/* -------------------------------------------------------------------------- */

test('a WeChat resident binds a verified phone without moving attribution', async () => {
  const context = testContext()
  try {
    const wechatUserId = createUser(context.db, '微信居民')
    const attribution = seedAttribution(context.db, wechatUserId)
    context.db
      .insert(wechatIdentities)
      .values({
        id: randomUUID(),
        userId: wechatUserId,
        appId: 'wx-test-app',
        openId: `openid-${randomUUID()}`,
        unionId: null,
        createdAt: new Date(),
      })
      .run()
    const session = seedSession(context.db, wechatUserId)

    const otp = await requestOtp(context, '13800138000', 'bind')
    assert.equal(otp.response.status, 202)
    const bind = await bindPhone(context, '13800138000', lastCode(context, '13800138000'), session)
    assert.equal(bind.status, 200)
    assert.deepEqual(await readJson(bind), {
      bound: true,
      alreadyBound: false,
      maskedPhone: '138****8000',
    })

    const identity = context.db
      .select()
      .from(residentPhoneIdentities)
      .where(eq(residentPhoneIdentities.userId, wechatUserId))
      .get()
    assert.equal(identity?.phone, '13800138000')

    // Existing 报名/奖励归属 are byte-identical and still owned by the same UUID.
    const after = attributionOf(context.db, wechatUserId)
    assert.equal(after.participations.length, 1)
    assert.equal(after.participations[0]?.id, attribution.participationId)
    assert.equal(after.participations[0]?.teamId, attribution.teamId)
    assert.equal(after.grants.length, 1)
    assert.equal(after.grants[0]?.id, attribution.grantId)
    assert.equal(after.grants[0]?.status, 'granted')

    // Same phone again is idempotent, not a second identity row.
    advanceSeconds(context, PHONE_OTP_RESEND_COOLDOWN_SECONDS + 1)
    assert.equal((await requestOtp(context, '13800138000', 'bind')).response.status, 202)
    const idempotent = await bindPhone(context, '13800138000', lastCode(context, '13800138000'), session)
    assert.equal(idempotent.status, 200)
    assert.equal((await readJson<{ alreadyBound: boolean }>(idempotent)).alreadyBound, true)
    assert.equal(context.db.select().from(residentPhoneIdentities).all().length, 1)

    // The status endpoint exposes only the masked phone.
    const status = await context.app.request(PHONE_AUTH_ROUTES.status, {
      headers: { cookie: session.cookie },
    })
    const statusBody = await readJson<{
      configured: boolean
      authenticated: boolean
      maskedPhone: string | null
    }>(status)
    assert.deepEqual(statusBody, {
      configured: true,
      authenticated: true,
      maskedPhone: '138****8000',
    })
    assert.equal(JSON.stringify(statusBody).includes('13800138000'), false)

    const boundAudit = context.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, 'phone.identity.bound'))
      .get()
    assert.equal(boundAudit?.actorUserId, wechatUserId)
    assert.equal(boundAudit?.targetId, wechatUserId)
    assert.equal((boundAudit?.metadata ?? '').includes('13800138000'), false)
  } finally {
    context.sqlite.close()
  }
})

test('a phone owned by another account is strictly rejected: no merge, no attribution move', async () => {
  const context = testContext()
  try {
    // Account B owns the phone.
    const phoneUserId = createUser(context.db, null)
    const phoneAttribution = seedAttribution(context.db, phoneUserId)
    const phoneSession = seedSession(context.db, phoneUserId)
    assert.equal((await requestOtp(context, '13800138000', 'bind')).response.status, 202)
    assert.equal(
      (await bindPhone(context, '13800138000', lastCode(context, '13800138000'), phoneSession)).status,
      200,
    )

    // Account A (WeChat) tries to claim the same phone.
    const wechatUserId = createUser(context.db, '微信居民')
    const wechatAttribution = seedAttribution(context.db, wechatUserId)
    const wechatSession = seedSession(context.db, wechatUserId)

    advanceSeconds(context, PHONE_OTP_RESEND_COOLDOWN_SECONDS + 1)
    // Requesting a bind code for an already-bound phone looks identical to an
    // unbound one: account enumeration is not possible at request time.
    const otp = await requestOtp(context, '13800138000', 'bind')
    assert.equal(otp.response.status, 202)
    assert.deepEqual(Object.keys(await readJson<Record<string, unknown>>(otp.response)).sort(), [
      'accepted',
      'expiresInSeconds',
      'maxAttempts',
      'retryAfterSeconds',
    ])

    const bind = await bindPhone(context, '13800138000', lastCode(context, '13800138000'), wechatSession)
    assert.equal(bind.status, 409)
    assert.equal((await readJson<{ error: { code: string } }>(bind)).error.code, 'phone_in_use')

    // Ownership never moved and no account was merged.
    const identity = context.db.select().from(residentPhoneIdentities).get()
    assert.equal(identity?.userId, phoneUserId)
    assert.equal(context.db.select().from(residentPhoneIdentities).all().length, 1)
    assert.equal(context.db.select().from(users).all().length, 2)
    const phoneRows = attributionOf(context.db, phoneUserId)
    assert.equal(phoneRows.participations[0]?.id, phoneAttribution.participationId)
    assert.equal(phoneRows.grants[0]?.id, phoneAttribution.grantId)
    const wechatRows = attributionOf(context.db, wechatUserId)
    assert.equal(wechatRows.participations[0]?.id, wechatAttribution.participationId)
    assert.equal(wechatRows.grants[0]?.id, wechatAttribution.grantId)

    const conflict = context.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, 'phone.identity.conflict'))
      .get()
    assert.equal(conflict?.actorUserId, wechatUserId)
    assert.equal(conflict?.targetId, wechatUserId)

    // #257: proving control of a new free phone replaces the current resident's
    // identity in place. Platform userId and attribution never move.
    const otherPhone = '13900139000'
    advanceSeconds(context, PHONE_OTP_RESEND_COOLDOWN_SECONDS + 1)
    assert.equal((await requestOtp(context, otherPhone, 'bind')).response.status, 202)
    const switchAttempt = await bindPhone(
      context,
      otherPhone,
      lastCode(context, otherPhone),
      phoneSession,
    )
    assert.equal(switchAttempt.status, 200)
    const switchBody = await readJson<{ alreadyBound: boolean; maskedPhone: string }>(switchAttempt)
    assert.equal(switchBody.alreadyBound, false)
    assert.equal(switchBody.maskedPhone, '139****9000')
    const switched = context.db.select().from(residentPhoneIdentities)
      .where(eq(residentPhoneIdentities.userId, phoneUserId)).get()
    assert.equal(switched?.phone, otherPhone)
    assert.equal(context.db.select().from(residentPhoneIdentities).all().length, 1)
    assert.equal(attributionOf(context.db, phoneUserId).participations[0]?.id, phoneAttribution.participationId)
    assert.equal(
      context.db.select().from(auditLogs).where(eq(auditLogs.event, 'phone.identity.replaced')).all().length,
      1,
    )
  } finally {
    context.sqlite.close()
  }
})

test('binding needs a resident session and CSRF, and an unproven phone is never bound', async () => {
  const context = testContext()
  try {
    const userId = createUser(context.db, null)
    const session = seedSession(context.db, userId)

    // No session: 401 even with a valid CSRF token.
    const anonymous = await context.app.request(PHONE_AUTH_ROUTES.bind, {
      method: 'POST',
      headers: postHeaders(cookieHeader(session.cookie.split('; ')[1] ?? ''), session.csrfToken),
      body: JSON.stringify({ phone: '13800138000', code: '123456' }),
    })
    assert.equal(anonymous.status, 401)

    // Session but no CSRF header: 403.
    const noCsrf = await context.app.request(PHONE_AUTH_ROUTES.bind, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie, origin: COOKIE_ORIGIN },
      body: JSON.stringify({ phone: '13800138000', code: '123456' }),
    })
    assert.equal(noCsrf.status, 403)

    // Untrusted Origin + correct CSRF: 403 (validCsrf checks the Origin too).
    const badOrigin = await context.app.request(PHONE_AUTH_ROUTES.bind, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: session.cookie,
        'x-csrf-token': session.csrfToken,
        origin: 'https://evil.example.test',
      },
      body: JSON.stringify({ phone: '13800138000', code: '123456' }),
    })
    assert.equal(badOrigin.status, 403)

    // Wrong code must not write an identity even with a valid session.
    const otp = await requestOtp(context, '13800138000', 'bind')
    assert.equal(otp.response.status, 202)
    const delivered = lastCode(context, '13800138000')
    const wrongCode = delivered === '000009' ? '000008' : '000009'
    const wrongBind = await bindPhone(context, '13800138000', wrongCode, session)
    assert.equal(wrongBind.status, 400)
    assert.equal(context.db.select().from(residentPhoneIdentities).all().length, 0)

    // A forged userId in the body fails strict parsing instead of being ignored.
    const forged = await context.app.request(PHONE_AUTH_ROUTES.bind, {
      method: 'POST',
      headers: postHeaders(session.cookie, session.csrfToken),
      body: JSON.stringify({ phone: '13800138000', code: delivered, userId: randomUUID() }),
    })
    assert.equal(forged.status, 400)
    assert.equal(context.db.select().from(residentPhoneIdentities).all().length, 0)
  } finally {
    context.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 11. Identity switch keeps attribution                                      */
/* -------------------------------------------------------------------------- */

test('switching the resident identity by phone never loses participation or rewards', async () => {
  const context = testContext()
  try {
    // WeChat resident A: bind a phone, then log in with it.
    const wechatUserId = createUser(context.db, '微信居民')
    const wechatAttribution = seedAttribution(context.db, wechatUserId)
    context.db
      .insert(wechatIdentities)
      .values({
        id: randomUUID(),
        userId: wechatUserId,
        appId: 'wx-test-app',
        openId: `openid-${randomUUID()}`,
        unionId: null,
        createdAt: new Date(),
      })
      .run()
    const wechatSession = seedSession(context.db, wechatUserId)
    await requestOtp(context, '13800138000', 'bind')
    assert.equal(
      (await bindPhone(context, '13800138000', lastCode(context, '13800138000'), wechatSession)).status,
      200,
    )

    advanceSeconds(context, PHONE_OTP_RESEND_COOLDOWN_SECONDS + 1)
    await requestOtp(context, '13800138000', 'login')
    const loginA = await phoneLogin(context, '13800138000', lastCode(context, '13800138000'))
    assert.equal(loginA.status, 200)
    const bodyA = await readJson<{ user: { id: string; displayName: string | null } }>(loginA)
    assert.equal(bodyA.user.id, wechatUserId)
    // Binding never overwrites an existing display name.
    assert.equal(bodyA.user.displayName, '微信居民')

    // Phone-only resident B with its own attribution.
    advanceSeconds(context, PHONE_OTP_RESEND_COOLDOWN_SECONDS + 1)
    await requestOtp(context, '13900139000', 'login')
    const loginBCreates = await phoneLogin(context, '13900139000', lastCode(context, '13900139000'))
    assert.equal(loginBCreates.status, 200)
    const bodyB = await readJson<{ user: { id: string } }>(loginBCreates)
    const phoneUserId = bodyB.user.id
    assert.notEqual(phoneUserId, wechatUserId)
    const phoneAttribution = seedAttribution(context.db, phoneUserId)

    // Switch back to B's phone: A's rows are untouched, B's rows are intact.
    advanceSeconds(context, PHONE_OTP_RESEND_COOLDOWN_SECONDS + 1)
    await requestOtp(context, '13900139000', 'login')
    const loginB = await phoneLogin(context, '13900139000', lastCode(context, '13900139000'))
    assert.equal(loginB.status, 200)
    const bodyBLogin = await readJson<{ user: { id: string }; csrfToken: string }>(loginB)
    assert.equal(bodyBLogin.user.id, phoneUserId)

    const cookies = cookieHeader(cookiePair(loginB, 'll_session'), cookiePair(loginB, 'll_csrf'))
    const sessionRead = await context.app.request('/auth/session', { headers: { cookie: cookies } })
    const sessionBody = await readJson<{
      authenticated: boolean
      user: { id: string }
      staff: unknown
    }>(sessionRead)
    assert.equal(sessionBody.user.id, phoneUserId)
    assert.equal(sessionBody.staff, null)

    const rowsA = attributionOf(context.db, wechatUserId)
    assert.equal(rowsA.participations.length, 1)
    assert.equal(rowsA.participations[0]?.id, wechatAttribution.participationId)
    assert.equal(rowsA.grants.length, 1)
    assert.equal(rowsA.grants[0]?.id, wechatAttribution.grantId)
    const rowsB = attributionOf(context.db, phoneUserId)
    assert.equal(rowsB.participations.length, 1)
    assert.equal(rowsB.participations[0]?.id, phoneAttribution.participationId)
    assert.equal(rowsB.grants.length, 1)
    assert.equal(rowsB.grants[0]?.id, phoneAttribution.grantId)

    // Logout still behaves exactly like the existing resident session flow.
    const logout = await context.app.request('/auth/logout', {
      method: 'POST',
      headers: postHeaders(cookies, bodyBLogin.csrfToken),
    })
    assert.equal(logout.status, 204)
    const afterLogout = await context.app.request('/auth/session', { headers: { cookie: cookies } })
    assert.deepEqual(await afterLogout.json(), { authenticated: false })
  } finally {
    context.sqlite.close()
  }
})

test('login and bind reject malformed phones before touching the database', async () => {
  const context = testContext()
  try {
    const bad = await requestOtp(context, '12345', 'login')
    assert.equal(bad.response.status, 400)
    assert.equal((await readJson<{ error: { code: string } }>(bad.response)).error.code, 'invalid_request')

    const badLogin = await phoneLogin(context, '02345678901', '123456')
    assert.equal(badLogin.status, 400)
    assert.equal(
      (await readJson<{ error: { code: string } }>(badLogin)).error.code,
      'invalid_request',
    )
    assert.equal(context.db.select().from(phoneVerificationCodes).all().length, 0)
    assert.equal(context.db.select().from(users).all().length, 0)
  } finally {
    context.sqlite.close()
  }
})
