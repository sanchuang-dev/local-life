import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import {
  API_ERROR_CODES,
  WECHAT_ADMIN_ROUTES,
  activateWechatConfigResponseSchema,
  saveWechatConfigResponseSchema,
  verifyWechatConfigResponseSchema,
  wechatAdminActivatePath,
  wechatAdminVerifyPath,
  wechatAdminConfigResponseSchema,
  wechatConfigSummarySchema,
  type WechatAdminConfigResponse,
  type WechatConfigSummary,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig, type ApiConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import { hashPassword } from '../src/auth/security.js'
import { auditLogs, staffAccounts, users, wechatOauthConfigs } from '../src/db/schema.js'
import {
  activateWechatConfig,
  markWechatConfigVerified,
  saveWechatConfigCandidate,
} from '../src/wechat/repository.js'
import { encryptWechatSecret } from '../src/wechat/crypto.js'
import { resolveWechatRuntimeConfig } from '../src/wechat/runtime.js'

/**
 * Integration tests for the admin WeChat configuration API (#113 T2).
 *
 * Everything below the `fetch` boundary is the real stack: real Hono routes,
 * real staff sessions/CSRF/Origin checks, a real migrated SQLite database, real
 * AES-256-GCM encryption and real audit writes. Only the WeChat provider call is
 * stubbed, and only at the injected fetcher.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ADMIN_ORIGIN = 'http://localhost:5174'
const WEB_ORIGIN = 'http://localhost:5173'
const APP_SECRET = 'Fake-AppSecret-Do-Not-Leak-0123456789'
const SECOND_APP_SECRET = 'Second-Fake-AppSecret-9876543210'
const ADMIN_PASSWORD = 'Admin-Password-123!'
const OPERATOR_PASSWORD = 'Operator-Password-123!'
const GRID_PASSWORD = 'Grid-Worker-Password-123!'
const MASTER_KEY = randomBytes(32)
const KEY_ID = 'test-key-1'

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
  userId: string
}

interface ErrorEnvelope {
  error: { code: string; message: string; requestId?: string }
}

type VerifyBehavior =
  | { kind: 'success' }
  | { kind: 'errcode'; errcode: number }
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'http'; status: number }

/* -------------------------------------------------------------------------- */
/* HTTP helpers (same shape as the existing suites)                           */
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

async function residentSession(app: App, displayName: string): Promise<Session> {
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
  assert.equal(response.status, 200)
  const body = (await response.json()) as { user: { id: string }; csrfToken: string }
  return {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: body.csrfToken,
    userId: body.user.id,
  }
}

interface ApiOptions {
  session?: Session
  body?: unknown
  csrf?: boolean
  /** Override the double-submit token (exercises a mismatched token). */
  csrfToken?: string
  origin?: string | null
  rawBody?: string
}

function api(app: App, method: string, path: string, options: ApiOptions = {}) {
  const {
    session,
    body,
    csrf: withCsrf = method !== 'GET',
    csrfToken,
    origin = ADMIN_ORIGIN,
    rawBody,
  } = options
  const headers: Record<string, string> = {}
  if (session) headers.cookie = session.cookies
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
  if (payload !== undefined) headers['content-type'] = 'application/json'
  if (session && withCsrf) {
    headers['x-csrf-token'] = csrfToken ?? session.csrfToken
    if (origin !== null) headers.origin = origin
  }
  return app.request(path, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  })
}

async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  const body = (await response.json()) as ErrorEnvelope
  assert.equal(typeof body.error?.code, 'string', 'failure must use the shared envelope')
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
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

interface Fixture {
  app: App
  db: AppDatabase
  config: ApiConfig
  admin: Session
  operator: Session
  grid: Session
  resident: Session
  verifyCalls: Array<{ url: URL; init?: RequestInit }>
  setVerifyBehavior: (behavior: VerifyBehavior) => void
  /** Every response body seen through `api()`; scanned for leaked secrets. */
  seenBodies: string[]
}

async function seedStaff(
  db: AppDatabase,
  input: { username: string; password: string; role: 'admin' | 'operator' | 'grid_worker' },
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
}

function masterConfig(env: Record<string, string> = {}): ApiConfig {
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
    WECHAT_CONFIG_MASTER_KEY: MASTER_KEY.toString('base64'),
    WECHAT_CONFIG_KEY_ID: KEY_ID,
    ...env,
  })
}

async function createFixture(options: { withMasterKey?: boolean } = {}): Promise<Fixture> {
  const withMasterKey = options.withMasterKey ?? true
  const { db } = createDatabase(':memory:', migrationsFolder)
  const config = withMasterKey
    ? masterConfig()
    : loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })

  let behavior: VerifyBehavior = { kind: 'success' }
  const verifyCalls: Array<{ url: URL; init?: RequestInit }> = []
  const seenBodies: string[] = []
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input))
    verifyCalls.push({ url, init })
    switch (behavior.kind) {
      case 'success':
        return new Response(JSON.stringify({ access_token: 'token-value-that-must-not-leak', expires_in: 7200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      case 'errcode':
        return new Response(JSON.stringify({ errcode: behavior.errcode, errmsg: 'upstream text' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      case 'network': {
        const error = new TypeError('fetch failed')
        throw error
      }
      case 'timeout': {
        const error = new Error('timed out')
        error.name = 'TimeoutError'
        throw error
      }
      case 'http':
        return new Response('provider down', { status: behavior.status })
    }
  }) as typeof fetch

  const app = createApp({ db, config, fetcher, logRequests: false })

  await seedStaff(db, { username: 'admin', password: ADMIN_PASSWORD, role: 'admin' })
  await seedStaff(db, { username: 'operator.a', password: OPERATOR_PASSWORD, role: 'operator' })
  await seedStaff(db, { username: 'grid.a', password: GRID_PASSWORD, role: 'grid_worker' })

  const fixture: Fixture = {
    app,
    db,
    config,
    admin: await login(app, 'admin', ADMIN_PASSWORD),
    operator: await login(app, 'operator.a', OPERATOR_PASSWORD),
    grid: await login(app, 'grid.a', GRID_PASSWORD),
    resident: await residentSession(app, '居民测试'),
    verifyCalls,
    setVerifyBehavior: (next) => {
      behavior = next
    },
    seenBodies,
  }
  return fixture
}

/** Wraps `api()` so every response body is remembered for the leak scan. */
async function call(
  fixture: Fixture,
  method: string,
  path: string,
  options: ApiOptions = {},
): Promise<Response> {
  const response = await api(fixture.app, method, path, options)
  fixture.seenBodies.push(await response.clone().text())
  return response
}

async function getConfig(fixture: Fixture, session: Session = fixture.admin) {
  const response = await call(fixture, 'GET', WECHAT_ADMIN_ROUTES.config, { session })
  assert.equal(response.status, 200)
  return (await response.json()) as WechatAdminConfigResponse
}

async function saveCandidate(
  fixture: Fixture,
  input: { appId?: string; appSecret?: string; accountType?: 'test' | 'official' } = {},
): Promise<{ response: Response; config: WechatConfigSummary }> {
  const response = await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
    session: fixture.admin,
    body: {
      appId: input.appId ?? 'wx1111111111111111',
      appSecret: input.appSecret ?? APP_SECRET,
      accountType: input.accountType ?? 'official',
    },
  })
  assert.equal(response.status, 200, 'saving a candidate must succeed')
  const body = saveWechatConfigResponseSchema.parse(await response.json())
  return { response, config: body.config }
}

async function verifyCandidate(
  fixture: Fixture,
  config: WechatConfigSummary,
): Promise<Response> {
  return call(fixture, 'POST', wechatAdminVerifyPath(config.id), {
    session: fixture.admin,
    body: { expectedUpdatedAt: config.updatedAt },
  })
}

/** Seed one ACTIVE provider directly through the T1 repository. */
function seedActive(
  db: AppDatabase,
  appId = 'wx2222222222222222',
  appSecret = SECOND_APP_SECRET,
): WechatConfigSummary {
  const summary = saveWechatConfigCandidate(db, {
    appId,
    accountType: 'official',
    encrypted: encryptWechatSecret(
      appSecret,
      { appId, accountType: 'official' },
      { key: MASTER_KEY, keyId: KEY_ID },
    ),
    createdByUserId: null,
  })
  const verified = markWechatConfigVerified(db, summary.id)
  return activateWechatConfig(db, verified.id).active
}

function countActive(db: AppDatabase): number {
  return db
    .select()
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.status, 'active'))
    .all().length
}

/* -------------------------------------------------------------------------- */
/* Authorization and read-only state                                          */
/* -------------------------------------------------------------------------- */

test('GET /admin/wechat/config is admin-only and reports an honest empty state', async () => {
  const fixture = await createFixture()

  await expectError(
    await call(fixture, 'GET', WECHAT_ADMIN_ROUTES.config),
    401,
    API_ERROR_CODES.unauthorized,
    'anonymous',
  )
  await expectError(
    await call(fixture, 'GET', WECHAT_ADMIN_ROUTES.config, { session: fixture.operator }),
    403,
    API_ERROR_CODES.forbidden,
    'operator',
  )
  await expectError(
    await call(fixture, 'GET', WECHAT_ADMIN_ROUTES.config, { session: fixture.grid }),
    403,
    API_ERROR_CODES.forbidden,
    'grid worker',
  )
  // A resident (non-staff) session is not a back-office login at all.
  await expectError(
    await call(fixture, 'GET', WECHAT_ADMIN_ROUTES.config, { session: fixture.resident }),
    401,
    API_ERROR_CODES.unauthorized,
    'resident',
  )

  const body = wechatAdminConfigResponseSchema.parse(await getConfig(fixture))
  assert.equal(body.state, 'unconfigured')
  assert.equal(body.active, null)
  assert.equal(body.candidate, null)
  assert.deepEqual(body.recent, [])
  assert.equal(body.masterKeyAvailable, true)
  assert.equal(body.keyId, KEY_ID)
  // WEB_BASE_URL defaults to the resident H5 origin; the callback path is the
  // shared constant, never user-editable.
  assert.equal(body.redirectUri, 'http://localhost:5173/api/auth/wechat/callback')
})

test('a resident session cannot read the WeChat admin config', async () => {
  const fixture = await createFixture()
  const response = await call(fixture, 'GET', WECHAT_ADMIN_ROUTES.config, {
    session: fixture.resident,
  })
  assert.equal(response.status, 401)
})

/* -------------------------------------------------------------------------- */
/* Save candidate                                                             */
/* -------------------------------------------------------------------------- */

test('POST save requires session, admin role, CSRF and a trusted Origin', async () => {
  const fixture = await createFixture()
  const body = { appId: 'wx1111111111111111', appSecret: APP_SECRET, accountType: 'official' }

  await expectError(
    await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, { body }),
    401,
    API_ERROR_CODES.unauthorized,
    'anonymous save',
  )
  await expectError(
    await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
      session: fixture.operator,
      body,
    }),
    403,
    API_ERROR_CODES.forbidden,
    'operator save',
  )
  await expectError(
    await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
      session: fixture.grid,
      body,
    }),
    403,
    API_ERROR_CODES.forbidden,
    'grid save',
  )
  // Admin without CSRF token, and with a mismatched double-submit token.
  await expectError(
    await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
      session: fixture.admin,
      body,
      csrf: false,
    }),
    403,
    API_ERROR_CODES.forbidden,
    'missing csrf',
  )
  await expectError(
    await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
      session: fixture.admin,
      body,
      csrfToken: 'not-the-session-token',
    }),
    403,
    API_ERROR_CODES.forbidden,
    'mismatched csrf',
  )
  // Admin with CSRF but a foreign Origin.
  await expectError(
    await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
      session: fixture.admin,
      body,
      origin: 'https://evil.example',
    }),
    403,
    API_ERROR_CODES.forbidden,
    'untrusted origin',
  )
  // Malformed body (strict schema: unknown key) is a 400 envelope.
  await expectError(
    await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
      session: fixture.admin,
      body: { ...body, userId: 'forged' },
    }),
    400,
    API_ERROR_CODES.invalidRequest,
    'forged field',
  )
  await expectError(
    await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
      session: fixture.admin,
      body: { ...body, appSecret: 'short' },
    }),
    400,
    API_ERROR_CODES.invalidRequest,
    'short secret',
  )
  // AppID must be the public-account shape (wx + 16 alphanumerics).
  const notWechat = await expectError(
    await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
      session: fixture.admin,
      body: { ...body, appId: '1234567890abcdef' },
    }),
    400,
    API_ERROR_CODES.wechatConfigInvalid,
    'non-wechat appid',
  )
  assert.match(notWechat.error.message, /wx/)
  assert.equal(countActive(fixture.db), 0)
})

test('saving a candidate stores only ciphertext and never touches the active row', async () => {
  const fixture = await createFixture()
  const active = seedActive(fixture.db)

  const { config } = await saveCandidate(fixture, { appId: 'wx1111111111111111' })
  assert.equal(config.status, 'draft')
  assert.equal(config.appId, 'wx1111111111111111')
  assert.equal(config.accountType, 'official')
  assert.equal(config.keyId, KEY_ID)
  assert.equal(config.lastErrorCode, null)

  // No secret or encryption material in the DTO.
  const text = JSON.stringify(config)
  assert.equal(text.includes(APP_SECRET), false)
  assert.equal(text.includes('ciphertext'), false)
  assert.equal(text.includes('appSecret'), false)
  wechatConfigSummarySchema.parse(config)

  // At rest: base64 envelope only; the plaintext appears in no column.
  const row = fixture.db
    .select()
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.id, config.id))
    .get()
  assert.ok(row)
  assert.notEqual(row.appSecretCiphertext, APP_SECRET)
  assert.equal(JSON.stringify(row).includes(APP_SECRET), false)
  assert.match(row.appSecretIv, /^[A-Za-z0-9+/]{16}$/u)
  assert.match(row.appSecretTag, /^[A-Za-z0-9+/]{22}==$/u)

  // The previously active provider is untouched and still resolvable.
  assert.equal(countActive(fixture.db), 1)
  const runtime = resolveWechatRuntimeConfig(fixture.db, {
    key: MASTER_KEY,
    keyId: KEY_ID,
  })
  assert.equal(runtime.ok, true)
  if (runtime.ok) {
    assert.equal(runtime.config.configId, active.id)
  }

  // Audited with non-sensitive metadata only.
  const audit = fixture.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.event, 'wechat.config.saved'))
    .get()
  assert.ok(audit)
  assert.equal(audit.actorUserId, fixture.admin.userId)
  assert.equal(audit.targetId, config.id)
  const metadata = JSON.parse(audit.metadata ?? '{}') as Record<string, string>
  assert.equal(metadata.appId, 'wx1111111111111111')
  assert.equal(metadata.accountType, 'official')
  assert.equal(JSON.stringify(metadata).includes(APP_SECRET), false)

  // The status endpoint now reports the candidate, not a fake success.
  const status = await getConfig(fixture)
  // An active provider keeps the badge at 已启用 while the draft is prepared.
  assert.equal(status.state, 'active')
  assert.equal(status.candidate?.id, config.id)
  assert.equal(status.active?.id, active.id)
})

test('saving a newer candidate retires the older candidate, never the active row', async () => {
  const fixture = await createFixture()
  const active = seedActive(fixture.db)
  const first = await saveCandidate(fixture, { appId: 'wx1111111111111111' })
  const second = await saveCandidate(fixture, { appId: 'wx3333333333333333' })

  const firstRow = fixture.db
    .select()
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.id, first.config.id))
    .get()
  assert.equal(firstRow?.status, 'retired')
  assert.ok(firstRow?.retiredAt)

  const status = await getConfig(fixture)
  assert.equal(status.candidate?.id, second.config.id)
  assert.equal(status.candidate?.status, 'draft')
  assert.equal(status.active?.id, active.id)
  assert.equal(countActive(fixture.db), 1)
})

test('a malformed JSON body is rejected instead of silently defaulting', async () => {
  const fixture = await createFixture()
  await expectError(
    await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
      session: fixture.admin,
      rawBody: '{"appId": ',
    }),
    400,
    API_ERROR_CODES.invalidRequest,
    'broken json',
  )
})

/* -------------------------------------------------------------------------- */
/* Real verification                                                          */
/* -------------------------------------------------------------------------- */

test('verification calls the real token endpoint, marks the candidate verified and drops the token', async () => {
  const fixture = await createFixture()
  const { config } = await saveCandidate(fixture)

  const response = await verifyCandidate(fixture, config)
  assert.equal(response.status, 200)
  const body = verifyWechatConfigResponseSchema.parse(await response.json())
  assert.equal(body.verified, true)
  assert.equal(body.config.status, 'verified')
  assert.equal(body.config.verifiedAt !== null, true)

  assert.equal(fixture.verifyCalls.length, 1)
  const callUrl = fixture.verifyCalls[0]!.url
  assert.equal(callUrl.searchParams.get('grant_type'), 'client_credential')
  assert.equal(callUrl.searchParams.get('appid'), config.appId)
  assert.equal(callUrl.searchParams.get('secret'), APP_SECRET)
  assert.ok(fixture.verifyCalls[0]!.init?.signal instanceof AbortSignal)

  // The upstream access_token must not appear in the response, the database or
  // the audit log.
  assert.equal(JSON.stringify(body).includes('token-value-that-must-not-leak'), false)
  const row = fixture.db
    .select()
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.id, config.id))
    .get()
  assert.equal(JSON.stringify(row).includes('token-value-that-must-not-leak'), false)
  assert.equal(row?.verifiedAt !== null, true)
  assert.equal(row?.lastErrorCode, null)

  const audit = fixture.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.event, 'wechat.config.verify_succeeded'))
    .get()
  assert.ok(audit)
  assert.equal(audit.actorUserId, fixture.admin.userId)
  assert.equal(JSON.stringify(audit).includes(APP_SECRET), false)
  assert.equal(JSON.stringify(audit).includes('token-value-that-must-not-leak'), false)

  const status = await getConfig(fixture)
  assert.equal(status.state, 'verified')
})

test('verification requires CSRF/admin and a fresh optimistic version', async () => {
  const fixture = await createFixture()
  const { config } = await saveCandidate(fixture)

  await expectError(
    await call(fixture, 'POST', wechatAdminVerifyPath(config.id), {
      session: fixture.operator,
      body: { expectedUpdatedAt: config.updatedAt },
    }),
    403,
    API_ERROR_CODES.forbidden,
    'operator verify',
  )
  await expectError(
    await call(fixture, 'POST', wechatAdminVerifyPath(config.id), {
      session: fixture.admin,
      body: { expectedUpdatedAt: config.updatedAt },
      csrf: false,
    }),
    403,
    API_ERROR_CODES.forbidden,
    'verify without csrf',
  )
  await expectError(
    await call(fixture, 'POST', wechatAdminVerifyPath(config.id), {
      session: fixture.admin,
      body: { expectedUpdatedAt: config.updatedAt },
      origin: 'https://evil.example',
    }),
    403,
    API_ERROR_CODES.forbidden,
    'verify untrusted origin',
  )
  // A stale tab cannot verify a version it did not see.
  await expectError(
    await call(fixture, 'POST', wechatAdminVerifyPath(config.id), {
      session: fixture.admin,
      body: { expectedUpdatedAt: new Date(Date.parse(config.updatedAt) + 1_000).toISOString() },
    }),
    409,
    API_ERROR_CODES.conflict,
    'stale verify',
  )
  // A missing row is an honest 404, not an internal error.
  await expectError(
    await call(fixture, 'POST', wechatAdminVerifyPath(randomUUID()), {
      session: fixture.admin,
      body: { expectedUpdatedAt: config.updatedAt },
    }),
    404,
    API_ERROR_CODES.notFound,
    'unknown config',
  )
  // The optimistic token is mandatory; an empty body is not an implicit verify.
  await expectError(
    await call(fixture, 'POST', wechatAdminVerifyPath(config.id), {
      session: fixture.admin,
      body: {},
    }),
    400,
    API_ERROR_CODES.invalidRequest,
    'verify without expectedUpdatedAt',
  )
})

test('a wrong AppSecret marks the candidate failed and keeps the active provider working', async () => {
  const fixture = await createFixture()
  const active = seedActive(fixture.db)
  const { config } = await saveCandidate(fixture, { appId: 'wx1111111111111111' })

  fixture.setVerifyBehavior({ kind: 'errcode', errcode: 40125 })
  const response = await verifyCandidate(fixture, config)
  const body = await expectError(
    response,
    409,
    API_ERROR_CODES.wechatConfigVerifyFailed,
    'invalid secret',
  )
  assert.match(body.error.message, /AppSecret/)
  assert.equal(body.error.message.includes(APP_SECRET), false)

  const failed = fixture.db
    .select()
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.id, config.id))
    .get()
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.lastErrorCode, 'invalid_app_secret')
  assert.equal(failed?.verifiedAt, null)

  // The active provider is still exactly the old one and still decrypts.
  assert.equal(countActive(fixture.db), 1)
  const status = await getConfig(fixture)
  assert.equal(status.active?.id, active.id)
  assert.equal(status.candidate?.id, config.id)
  assert.equal(status.candidate?.status, 'failed')
  assert.equal(status.candidate?.lastErrorCode, 'invalid_app_secret')
  const runtime = resolveWechatRuntimeConfig(fixture.db, { key: MASTER_KEY, keyId: KEY_ID })
  assert.equal(runtime.ok, true)
  if (runtime.ok) assert.equal(runtime.config.appId, active.appId)

  const audit = fixture.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.event, 'wechat.config.verify_failed'))
    .get()
  assert.ok(audit)
  assert.equal(JSON.parse(audit.metadata ?? '{}').errorCode, 'invalid_app_secret')
  assert.equal(JSON.stringify(audit).includes(APP_SECRET), false)
})

test('WeChat error codes map to actionable failures, never to success', async () => {
  const cases: Array<{
    behavior: VerifyBehavior
    http: number
    lastErrorCode: string
    message: RegExp
  }> = [
    {
      behavior: { kind: 'errcode', errcode: 40013 },
      http: 409,
      lastErrorCode: 'invalid_app_id',
      message: /AppID/,
    },
    {
      behavior: { kind: 'errcode', errcode: 40164 },
      http: 409,
      lastErrorCode: 'api_forbidden',
      message: /IP 白名单/,
    },
    {
      behavior: { kind: 'errcode', errcode: 45009 },
      http: 429,
      lastErrorCode: 'rate_limited',
      message: /限/,
    },
    {
      behavior: { kind: 'network' },
      http: 503,
      lastErrorCode: 'network_error',
      message: /网络/,
    },
    {
      behavior: { kind: 'timeout' },
      http: 503,
      lastErrorCode: 'timeout',
      message: /超时/,
    },
    {
      behavior: { kind: 'http', status: 502 },
      http: 503,
      lastErrorCode: 'wechat_api_error',
      message: /微信接口/,
    },
  ]

  const fixture = await createFixture()
  for (const expected of cases) {
    const { config } = await saveCandidate(fixture, { appId: 'wx1111111111111111' })
    fixture.setVerifyBehavior(expected.behavior)
    const response = await verifyCandidate(fixture, config)
    const body = await expectError(
      response,
      expected.http,
      API_ERROR_CODES.wechatConfigVerifyFailed,
      `verify ${expected.lastErrorCode}`,
    )
    assert.match(body.error.message, expected.message)
    assert.equal(body.error.message.includes(APP_SECRET), false)

    const row = fixture.db
      .select()
      .from(wechatOauthConfigs)
      .where(eq(wechatOauthConfigs.id, config.id))
      .get()
    assert.equal(row?.status, 'failed')
    assert.equal(row?.lastErrorCode, expected.lastErrorCode)
  }
})

/* -------------------------------------------------------------------------- */
/* Activation                                                                 */
/* -------------------------------------------------------------------------- */

test('activation needs a verified candidate, a fresh version and explicit confirmation', async () => {
  const fixture = await createFixture()
  const { config } = await saveCandidate(fixture)

  // A draft can never be activated.
  await expectError(
    await call(fixture, 'POST', wechatAdminActivatePath(config.id), {
      session: fixture.admin,
      body: { expectedUpdatedAt: config.updatedAt, confirm: true },
    }),
    409,
    API_ERROR_CODES.wechatConfigNotVerified,
    'draft activation',
  )
  // Missing explicit confirmation is a 400, not an implicit switch.
  await expectError(
    await call(fixture, 'POST', wechatAdminActivatePath(config.id), {
      session: fixture.admin,
      body: { expectedUpdatedAt: config.updatedAt },
    }),
    400,
    API_ERROR_CODES.invalidRequest,
    'missing confirm',
  )
  // Non-admin cannot activate.
  await expectError(
    await call(fixture, 'POST', wechatAdminActivatePath(config.id), {
      session: fixture.operator,
      body: { expectedUpdatedAt: config.updatedAt, confirm: true },
    }),
    403,
    API_ERROR_CODES.forbidden,
    'operator activation',
  )
  // An admin without CSRF cannot switch the live provider.
  await expectError(
    await call(fixture, 'POST', wechatAdminActivatePath(config.id), {
      session: fixture.admin,
      body: { expectedUpdatedAt: config.updatedAt, confirm: true },
      csrf: false,
    }),
    403,
    API_ERROR_CODES.forbidden,
    'activation without csrf',
  )

  const verifiedResponse = await verifyCandidate(fixture, config)
  assert.equal(verifiedResponse.status, 200)
  const verified = verifyWechatConfigResponseSchema.parse(await verifiedResponse.json())

  // A stale version is rejected even though the row is verified.
  await expectError(
    await call(fixture, 'POST', wechatAdminActivatePath(config.id), {
      session: fixture.admin,
      body: {
        expectedUpdatedAt: new Date(Date.parse(verified.config.updatedAt) - 1_000).toISOString(),
        confirm: true,
      },
    }),
    409,
    API_ERROR_CODES.conflict,
    'stale activation',
  )

  const response = await call(fixture, 'POST', wechatAdminActivatePath(config.id), {
    session: fixture.admin,
    body: { expectedUpdatedAt: verified.config.updatedAt, confirm: true },
  })
  assert.equal(response.status, 200)
  const body = activateWechatConfigResponseSchema.parse(await response.json())
  assert.equal(body.active.id, config.id)
  assert.equal(body.active.status, 'active')
  assert.equal(body.previous, null)
  assert.equal(countActive(fixture.db), 1)

  const status = await getConfig(fixture)
  assert.equal(status.state, 'active')
  assert.equal(status.active?.id, config.id)
  assert.equal(status.candidate, null)

  const audit = fixture.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.event, 'wechat.config.activated'))
    .get()
  assert.ok(audit)
  assert.equal(audit.targetId, config.id)
  assert.equal(JSON.parse(audit.metadata ?? '{}').appId, config.appId)
  assert.equal(JSON.stringify(audit).includes(APP_SECRET), false)
})

test('switching providers retires the old active version atomically', async () => {
  const fixture = await createFixture()
  const previous = seedActive(fixture.db, 'wx2222222222222222')

  const { config } = await saveCandidate(fixture, { appId: 'wx1111111111111111' })
  const verified = verifyWechatConfigResponseSchema.parse(
    await (await verifyCandidate(fixture, config)).json(),
  )
  const response = await call(fixture, 'POST', wechatAdminActivatePath(config.id), {
    session: fixture.admin,
    body: { expectedUpdatedAt: verified.config.updatedAt, confirm: true },
  })
  assert.equal(response.status, 200)
  const body = activateWechatConfigResponseSchema.parse(await response.json())
  assert.equal(body.active.id, config.id)
  assert.equal(body.previous?.id, previous.id)
  assert.equal(body.previous?.status, 'retired')

  // Exactly one active row; the old row is retired, not deleted.
  assert.equal(countActive(fixture.db), 1)
  const oldRow = fixture.db
    .select()
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.id, previous.id))
    .get()
  assert.equal(oldRow?.status, 'retired')
  assert.ok(oldRow?.retiredAt)

  const runtime = resolveWechatRuntimeConfig(fixture.db, { key: MASTER_KEY, keyId: KEY_ID })
  assert.equal(runtime.ok, true)
  if (runtime.ok) assert.equal(runtime.config.configId, config.id)

  // The audit names what was retired without any secret material.
  const activations = fixture.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.event, 'wechat.config.activated'))
    .all()
  assert.equal(activations.length, 1)
  const metadata = JSON.parse(activations[0]!.metadata ?? '{}') as Record<string, string>
  assert.equal(metadata.appId, config.appId)
  assert.equal(metadata.previousAppId, previous.appId)
  assert.equal(JSON.stringify(metadata).includes(APP_SECRET), false)
})

test('repeated and concurrent activation never produce two active rows', async () => {
  const fixture = await createFixture()
  await seedActive(fixture.db, 'wx2222222222222222')
  const { config } = await saveCandidate(fixture, { appId: 'wx1111111111111111' })
  const verified = verifyWechatConfigResponseSchema.parse(
    await (await verifyCandidate(fixture, config)).json(),
  )
  const request = () =>
    call(fixture, 'POST', wechatAdminActivatePath(config.id), {
      session: fixture.admin,
      body: { expectedUpdatedAt: verified.config.updatedAt, confirm: true },
    })

  const [first, second] = await Promise.all([request(), request()])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(countActive(fixture.db), 1)

  // A third, sequential activation is an idempotent no-op success.
  const third = await request()
  assert.equal(third.status, 200)
  const body = activateWechatConfigResponseSchema.parse(await third.json())
  assert.equal(body.active.id, config.id)
  assert.equal(body.previous, null)
  assert.equal(countActive(fixture.db), 1)
})

/* -------------------------------------------------------------------------- */
/* Fail-closed states                                                         */
/* -------------------------------------------------------------------------- */

test('without a master key the endpoint reports it and every write fails closed', async () => {
  const fixture = await createFixture({ withMasterKey: false })

  const status = await getConfig(fixture)
  assert.equal(status.masterKeyAvailable, false)
  assert.equal(status.keyId, 'v1')

  const save = await call(fixture, 'POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
    session: fixture.admin,
    body: { appId: 'wx1111111111111111', appSecret: APP_SECRET, accountType: 'official' },
  })
  await expectError(
    save,
    503,
    API_ERROR_CODES.wechatConfigMasterKeyUnavailable,
    'save without key',
  )

  const verify = await call(fixture, 'POST', wechatAdminVerifyPath(randomUUID()), {
    session: fixture.admin,
    body: { expectedUpdatedAt: new Date().toISOString() },
  })
  await expectError(
    verify,
    503,
    API_ERROR_CODES.wechatConfigMasterKeyUnavailable,
    'verify without key',
  )

  // Nothing was persisted by the failed save.
  assert.equal(fixture.db.select().from(wechatOauthConfigs).all().length, 0)
})

test('an active row with no master key is reported as unusable, never as success', async () => {
  const fixture = await createFixture()
  const active = seedActive(fixture.db)

  const noKeyConfig = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const noKeyApp = createApp({
    db: fixture.db,
    config: noKeyConfig,
    fetcher: (async () => {
      throw new Error('the status endpoint must not call WeChat')
    }) as typeof fetch,
    logRequests: false,
  })
  // The staff session lives in the same SQLite database, so it is valid here.
  const response = await api(noKeyApp, 'GET', WECHAT_ADMIN_ROUTES.config, {
    session: fixture.admin,
  })
  assert.equal(response.status, 200)
  const status = wechatAdminConfigResponseSchema.parse(await response.json())
  assert.equal(status.masterKeyAvailable, false)
  assert.equal(status.active?.id, active.id)
  assert.equal(status.active?.lastErrorCode, 'master_key_unavailable')

  // An idempotent "activate" is NOT successful when the active account cannot
  // decrypt its AppSecret. Returning 200 here would hide a broken login path.
  const repeat = await api(noKeyApp, 'POST', wechatAdminActivatePath(active.id), {
    session: fixture.admin,
    body: { expectedUpdatedAt: active.updatedAt, confirm: true },
  })
  await expectError(
    repeat,
    503,
    API_ERROR_CODES.wechatConfigMasterKeyUnavailable,
    'repeat activation of active provider without key',
  )
})

test('an undecryptable active row is reported safely instead of crashing the status endpoint', async () => {
  const fixture = await createFixture()
  const active = seedActive(fixture.db)

  fixture.db
    .update(wechatOauthConfigs)
    .set({ appSecretCiphertext: Buffer.from('tampered-but-valid-base64').toString('base64') })
    .where(eq(wechatOauthConfigs.id, active.id))
    .run()

  const status = await getConfig(fixture)
  assert.equal(status.masterKeyAvailable, true)
  assert.equal(status.active?.id, active.id)
  assert.equal(status.active?.lastErrorCode, 'decrypt_failed')
  assert.equal(status.state, 'active')

  const repeat = await call(fixture, 'POST', wechatAdminActivatePath(active.id), {
    session: fixture.admin,
    body: { expectedUpdatedAt: active.updatedAt, confirm: true },
  })
  await expectError(
    repeat,
    409,
    API_ERROR_CODES.wechatConfigDecryptFailed,
    'repeat activation of undecryptable active provider',
  )

  // A verified-but-undecryptable candidate cannot be activated and the old
  // active row stays in place.
  const { config } = await saveCandidate(fixture, { appId: 'wx1111111111111111' })
  fixture.db
    .update(wechatOauthConfigs)
    .set({ appSecretCiphertext: Buffer.from('tampered-but-valid-base64').toString('base64') })
    .where(eq(wechatOauthConfigs.id, config.id))
    .run()
  const current = fixture.db
    .select()
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.id, config.id))
    .get()
  assert.ok(current)
  const verified = markWechatConfigVerified(fixture.db, config.id)
  await expectError(
    await call(fixture, 'POST', wechatAdminActivatePath(verified.id), {
      session: fixture.admin,
      body: { expectedUpdatedAt: verified.updatedAt, confirm: true },
    }),
    409,
    API_ERROR_CODES.wechatConfigDecryptFailed,
    'activate undecryptable',
  )
  assert.equal(countActive(fixture.db), 1)
  const stillActive = fixture.db
    .select()
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.status, 'active'))
    .get()
  assert.equal(stillActive?.id, active.id)
})

test('verification of an undecryptable candidate marks it failed with a safe code', async () => {
  const fixture = await createFixture()
  const { config } = await saveCandidate(fixture)
  fixture.db
    .update(wechatOauthConfigs)
    .set({ appSecretCiphertext: Buffer.from('tampered-but-valid-base64').toString('base64') })
    .where(eq(wechatOauthConfigs.id, config.id))
    .run()

  const response = await verifyCandidate(fixture, config)
  await expectError(
    response,
    409,
    API_ERROR_CODES.wechatConfigDecryptFailed,
    'undecryptable verify',
  )
  const row = fixture.db
    .select()
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.id, config.id))
    .get()
  assert.equal(row?.status, 'failed')
  assert.equal(row?.lastErrorCode, 'decrypt_failed')
})

/* -------------------------------------------------------------------------- */
/* Secret leak scan                                                           */
/* -------------------------------------------------------------------------- */

test('no response body or audit row ever contains the AppSecret or access token', async () => {
  const fixture = await createFixture()
  await seedActive(fixture.db)
  const { config } = await saveCandidate(fixture, { appId: 'wx1111111111111111' })
  fixture.setVerifyBehavior({ kind: 'success' })
  const verified = verifyWechatConfigResponseSchema.parse(
    await (await verifyCandidate(fixture, config)).json(),
  )
  await call(fixture, 'POST', wechatAdminActivatePath(config.id), {
    session: fixture.admin,
    body: { expectedUpdatedAt: verified.config.updatedAt, confirm: true },
  })
  await getConfig(fixture)

  const everything = fixture.seenBodies.join('\n')
  for (const forbidden of [APP_SECRET, SECOND_APP_SECRET, 'token-value-that-must-not-leak']) {
    assert.equal(everything.includes(forbidden), false, `response body leaked ${forbidden}`)
  }
  assert.equal(everything.includes('ciphertext'), false)
  assert.equal(everything.includes('appSecret'), false)

  const audits = fixture.db.select().from(auditLogs).all()
  const auditText = JSON.stringify(audits)
  assert.equal(auditText.includes(APP_SECRET), false)
  assert.equal(auditText.includes(SECOND_APP_SECRET), false)
  assert.equal(auditText.includes('token-value-that-must-not-leak'), false)
})
