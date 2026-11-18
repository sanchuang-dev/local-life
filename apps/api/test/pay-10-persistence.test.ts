import assert from 'node:assert/strict'
import { createPublicKey, randomUUID, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test, { type TestContext } from 'node:test'
import {
  PAYMENT_ROUTES,
  paymentCapabilitiesSchema,
  paymentIntentCreateResponseSchema,
  paymentPrepayResponseSchema,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  communities,
  ledgerEntries,
  localOrderOnlineCompletions,
  localOrders,
  localProducts,
  paymentAttempts,
  paymentEvents,
  paymentIntents,
  wechatIdentities,
  wechatPayPrepayAttempts,
} from '../src/db/schema.js'
import type { LocalActor } from '../src/local/shared.js'
import { createWechatJsapiPrepay } from '../src/payments/service.js'
import {
  TEST_APPID,
  TEST_MCHID,
  TEST_MERCHANT_PRIVATE_KEY_PEM,
  TEST_MERCHANT_PUBLIC_KEY_PEM,
  TEST_MERCHANT_SERIAL,
  TEST_PLATFORM_KEY_ID,
  TEST_PLATFORM_PUBLIC_KEY_PEM,
  startFakeWechatServer,
  type FakeWechatServer,
} from './fixtures/wechat-pay-test-support.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const RESIDENT_ORIGIN = 'http://localhost:5173'
const PREPAY_ID = 'wx201410272009395522657a690389285100'
const SUCCESS_BODY = JSON.stringify({ prepay_id: PREPAY_ID })

type App = ReturnType<typeof createApp>

interface ResidentSession {
  cookies: string
  csrfToken: string
  userId: string
}

interface World {
  app: App
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  databasePath: string
  directory: string
  server: FakeWechatServer | null
  resident: ResidentSession
  orderId: string
  intentId: string
  openId: string
  config: ReturnType<typeof loadConfig>
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

function api(
  app: App,
  method: string,
  path: string,
  options: { session?: ResidentSession; body?: unknown; csrf?: boolean } = {},
) {
  const { session, body, csrf: withCsrf = method !== 'GET' } = options
  const headers: Record<string, string> = {}
  if (session) headers.cookie = session.cookies
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (session && withCsrf) {
    headers['x-csrf-token'] = session.csrfToken
    headers.origin = RESIDENT_ORIGIN
  }
  return app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function loginResident(app: App): Promise<ResidentSession> {
  const csrfResponse = await app.request('/auth/csrf')
  const csrfBody = (await csrfResponse.json()) as { csrfToken: string }
  const response = await app.request('/auth/dev/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookiePair(csrfResponse, 'll_csrf'),
      'x-csrf-token': csrfBody.csrfToken,
      origin: RESIDENT_ORIGIN,
    },
    body: JSON.stringify({ displayName: 'PAY-10 微信居民' }),
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { user: { id: string }; csrfToken: string }
  return {
    cookies: `${cookiePair(response, 'll_session')}; ${cookiePair(response, 'll_csrf')}`,
    csrfToken: body.csrfToken,
    userId: body.user.id,
  }
}

function wechatEnv(
  directory: string,
  apiBaseUrl: string | undefined,
): Record<string, string> {
  const merchantKeyPath = join(directory, 'merchant-key.pem')
  const platformKeyPath = join(directory, 'platform-key.pem')
  writeFileSync(merchantKeyPath, TEST_MERCHANT_PRIVATE_KEY_PEM)
  writeFileSync(platformKeyPath, TEST_PLATFORM_PUBLIC_KEY_PEM)
  return {
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
    WECHAT_PAY_MCHID: TEST_MCHID,
    WECHAT_PAY_APPID: TEST_APPID,
    WECHAT_PAY_MERCHANT_SERIAL_NO: TEST_MERCHANT_SERIAL,
    WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE: merchantKeyPath,
    WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE: platformKeyPath,
    WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID: TEST_PLATFORM_KEY_ID,
    WECHAT_PAY_NOTIFY_URL: 'https://local-life.example.test/api/payments/wechat/notify',
    ...(apiBaseUrl ? { WECHAT_PAY_API_BASE_URL: apiBaseUrl } : {}),
  }
}

const ORDER_TIME = new Date('2026-11-18T06:55:00.000Z')

async function createWorld(
  t: TestContext,
  responder: (request: { index: number }) => { status: number; body: string },
  options: { configured?: boolean; withIdentity?: boolean } = {},
): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), 'pay-10-db-'))
  const server = options.configured === false ? null : await startFakeWechatServer(responder)
  const databasePath = join(directory, 'pay-10.sqlite')
  const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
  t.after(async () => {
    try {
      sqlite.close()
    } catch {
      // already closed by a restart test
    }
    await server?.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const config = loadConfig(
    options.configured === false
      ? { NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' }
      : wechatEnv(directory, server!.baseUrl),
  )
  const app = createApp({ db, config, logRequests: false })
  const resident = await loginResident(app)

  const communityId = randomUUID()
  const productId = randomUUID()
  db.insert(communities).values({ id: communityId, name: 'PAY-10 片区', createdAt: ORDER_TIME }).run()
  db.insert(localProducts).values({
    id: productId,
    communityId,
    name: '本地生活测试商品',
    unitPriceCents: 3_980,
    status: 'on_shelf',
    createdAt: ORDER_TIME,
    updatedAt: ORDER_TIME,
  }).run()
  const orderId = randomUUID()
  db.insert(localOrders).values({
    id: orderId,
    communityId,
    productId,
    residentUserId: resident.userId,
    idempotencyKey: `pay-10-order-${orderId}`,
    status: 'registered',
    recordSource: 'resident',
    productName: '本地生活测试商品',
    unitPriceCents: 3_980,
    quantity: 1,
    totalCents: 3_980,
    couponDiscountCents: 0,
    couponId: null,
    note: null,
    createdByStaffId: null,
    attributedStaffId: null,
    sourceActivityId: null,
    sourceTeamId: null,
    verifiedByUserId: null,
    verifiedAt: null,
    verificationNote: null,
    createdAt: ORDER_TIME,
    updatedAt: ORDER_TIME,
  }).run()
  const openId = 'o-pay-10-test-openid'
  if (options.withIdentity !== false) {
    db.insert(wechatIdentities).values({
      id: randomUUID(),
      userId: resident.userId,
      appId: TEST_APPID,
      openId,
      unionId: null,
      nickname: null,
      avatarUrl: null,
      sex: null,
      province: null,
      city: null,
      country: null,
      privilegeJson: null,
      profileAuthorizedAt: null,
      profileUpdatedAt: null,
      createdAt: ORDER_TIME,
    }).run()
  }

  const intentResponse = options.configured === false
    ? null
    : await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
        session: resident,
        body: {
          localOrderId: orderId,
          channel: 'wechat_jsapi',
          idempotencyKey: `pay-10-intent-${orderId}`,
        },
      })
  let intentId = ''
  if (intentResponse) {
    assert.equal(intentResponse.status, 201)
    const intentBody = paymentIntentCreateResponseSchema.parse(await intentResponse.json())
    intentId = intentBody.intent.id
  }

  return {
    app,
    db,
    sqlite,
    databasePath,
    directory,
    server,
    resident,
    orderId,
    intentId,
    openId,
    config,
  }
}

function actorOf(world: World): LocalActor {
  return { userId: world.resident.userId, staffId: null, role: null }
}

async function postPrepay(world: World): Promise<Response> {
  return api(world.app, 'POST', `/payments/intents/${world.intentId}/wechat-jsapi/prepay`, {
    session: world.resident,
  })
}

function errorCodeOf(response: Response): Promise<string> {
  return response.json().then((body: unknown) => {
    assert.ok(body && typeof body === 'object' && 'error' in body)
    return (body as { error: { code: string } }).error.code
  })
}

test('PAY-10 prepay persists a verified prepay credential without any paid fact', async (t) => {
  const world = await createWorld(t, () => ({ status: 200, body: SUCCESS_BODY }))
  const response = await postPrepay(world)
  assert.equal(response.status, 201)
  const result = paymentPrepayResponseSchema.parse(await response.json())
  assert.equal(result.outcome, 'prepay_created')
  assert.equal(result.channel, 'wechat_jsapi')
  assert.equal(result.invocation.package, `prepay_id=${PREPAY_ID}`)
  assert.equal(result.invocation.signType, 'RSA')
  const paySignMessage = `${result.invocation.appId}\n${result.invocation.timeStamp}\n${result.invocation.nonceStr}\n${result.invocation.package}\n`
  assert.equal(
    verify(
      'sha256',
      Buffer.from(paySignMessage, 'utf8'),
      createPublicKey({ key: TEST_MERCHANT_PUBLIC_KEY_PEM, format: 'pem' }),
      Buffer.from(result.invocation.paySign, 'base64'),
    ),
    true,
  )

  const captured = world.server!.requests[0]!
  assert.equal(captured.method, 'POST')
  assert.equal(captured.url, '/v3/pay/transactions/jsapi')
  const body = JSON.parse(captured.body) as {
    appid: string
    mchid: string
    out_trade_no: string
    time_expire: string
    notify_url: string
    amount: { total: number; currency: string }
    payer: { openid: string }
  }
  assert.equal(body.appid, TEST_APPID)
  assert.equal(body.mchid, TEST_MCHID)
  assert.equal(body.out_trade_no.startsWith('PAY-'), true)
  assert.match(body.time_expire, /\+08:00$/u)
  assert.equal(body.notify_url, 'https://local-life.example.test/api/payments/wechat/notify')
  assert.equal(body.amount.total, 3_980)
  assert.equal(body.amount.currency, 'CNY')
  assert.equal(body.payer.openid, world.openId)

  const [intent] = world.db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, world.intentId))
    .all()
  assert.ok(intent)
  assert.equal(intent.status, 'pending')
  assert.equal(intent.paidAt, null)
  assert.equal(intent.merchantAppId, null)
  assert.equal(intent.merchantId, null)
  assert.equal(world.db.select().from(paymentAttempts).all().length, 0)
  assert.equal(world.db.select().from(localOrderOnlineCompletions).all().length, 0)
  assert.equal(world.db.select().from(ledgerEntries).all().length, 0)
  assert.equal(world.db.select().from(paymentEvents).all().length, 1)

  const rows = world.db.select().from(wechatPayPrepayAttempts).all()
  assert.equal(rows.length, 1)
  const attempt = rows[0]!
  assert.equal(attempt.status, 'succeeded')
  assert.equal(attempt.prepayId, PREPAY_ID)
  assert.ok(attempt.prepayExpiresAt)
  assert.equal(attempt.prepayExpiresAt.getTime() <= intent.expiresAt.getTime(), true)
  assert.equal(attempt.timeExpireAt.getTime(), intent.expiresAt.getTime())
  assert.equal(attempt.responseStatus, 200)
  assert.equal(attempt.responseRequestId, 'fake-request-0')
  assert.equal(attempt.failureCode, null)
  assert.equal(attempt.requestBodyRedactedJson.includes(world.openId), false)
  assert.match(attempt.payerOpenidSha256, /^[0-9a-f]{64}$/u)
  assert.match(attempt.requestBodySha256, /^[0-9a-f]{64}$/u)
  assert.match(attempt.requestFingerprint, /^[0-9a-f]{64}$/u)
  // The private key never reaches SQLite.
  const rawDatabase = readFileSync(world.databasePath).toString('latin1')
  assert.equal(rawDatabase.includes('PRIVATE KEY'), false)
  assert.equal(rawDatabase.includes('BEGIN RSA'), false)
})

test('PAY-10 duplicate prepay reuses the same provider credential without a second outbound call', async (t) => {
  const world = await createWorld(t, () => ({ status: 200, body: SUCCESS_BODY }))
  const first = await postPrepay(world)
  assert.equal(first.status, 201)
  const firstBody = paymentPrepayResponseSchema.parse(await first.json())
  const second = await postPrepay(world)
  assert.equal(second.status, 200)
  const secondBody = paymentPrepayResponseSchema.parse(await second.json())
  assert.equal(secondBody.outcome, 'prepay_reused')
  assert.equal(secondBody.invocation.package, firstBody.invocation.package)
  assert.equal(world.server!.requests.length, 1)
  assert.equal(world.db.select().from(wechatPayPrepayAttempts).all().length, 1)
})

test('PAY-10 prepay survives a process restart and the channel capability is explicit', async (t) => {
  const world = await createWorld(t, () => ({ status: 200, body: SUCCESS_BODY }))
  const first = await postPrepay(world)
  assert.equal(first.status, 201)

  world.sqlite.close()
  const reopened = createDatabase(world.databasePath, migrationsFolder)
  try {
    const app = createApp({ db: reopened.db, config: world.config, logRequests: false })
    const capabilityResponse = await app.request(PAYMENT_ROUTES.capabilities)
    const capabilities = paymentCapabilitiesSchema.parse(await capabilityResponse.json())
    assert.equal(capabilities.wechatJsapiAvailable, true)
    assert.equal(capabilities.wechatUnavailableReason, null)

    const second = await api(app, 'POST', `/payments/intents/${world.intentId}/wechat-jsapi/prepay`, {
      session: world.resident,
    })
    assert.equal(second.status, 200)
    const secondBody = paymentPrepayResponseSchema.parse(await second.json())
    assert.equal(secondBody.outcome, 'prepay_reused')
    assert.equal(world.server!.requests.length, 1)
    assert.equal(reopened.db.select().from(wechatPayPrepayAttempts).all().length, 1)
  } finally {
    reopened.sqlite.close()
  }
})

test('PAY-10 expired payment intent refuses invocation instead of reusing or paying', async (t) => {
  const world = await createWorld(t, () => ({ status: 200, body: SUCCESS_BODY }))
  const first = await postPrepay(world)
  assert.equal(first.status, 201)
  const [intent] = world.db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, world.intentId))
    .all()
  assert.ok(intent)
  await assert.rejects(
    createWechatJsapiPrepay(world.db, world.config, actorOf(world), world.intentId, {
      now: new Date(intent.expiresAt.getTime() + 1_000),
    }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409)
      assert.equal((error as { code?: string }).code, 'payment_not_payable')
      return true
    },
  )
  assert.equal(world.server!.requests.length, 1)
  const [after] = world.db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, world.intentId))
    .all()
  assert.equal(after?.status, 'pending')
  assert.equal(after?.paidAt, null)
})

test('PAY-10 deterministic provider rejection is bounded and retryable', async (t) => {
  const world = await createWorld(t, (request) =>
    request.index === 0
      ? { status: 400, body: '{"code":"PARAM_ERROR","message":"参数错误"}' }
      : { status: 200, body: SUCCESS_BODY },
  )
  const rejected = await postPrepay(world)
  assert.equal(rejected.status, 503)
  assert.equal(await errorCodeOf(rejected), 'payment_channel_unavailable')
  const rowsAfterRejection = world.db.select().from(wechatPayPrepayAttempts).all()
  assert.equal(rowsAfterRejection.length, 1)
  assert.equal(rowsAfterRejection[0]?.status, 'rejected')
  assert.equal(rowsAfterRejection[0]?.responseErrorCode, 'PARAM_ERROR')
  assert.equal(rowsAfterRejection[0]?.prepayId, null)

  const retried = await postPrepay(world)
  assert.equal(retried.status, 201)
  const retriedBody = paymentPrepayResponseSchema.parse(await retried.json())
  assert.equal(retriedBody.outcome, 'prepay_created')
  assert.equal(world.server!.requests.length, 2)
  const rows = world.db.select().from(wechatPayPrepayAttempts).all()
  assert.deepEqual(
    rows.map((row) => row.status).sort(),
    ['rejected', 'succeeded'],
  )
  const [intent] = world.db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, world.intentId))
    .all()
  assert.equal(intent?.status, 'pending')
})

test('PAY-10 unknown provider outcome blocks blind re-submission until query/close', async (t) => {
  const world = await createWorld(t, () => ({
    status: 500,
    body: '{"code":"SYSTEM_ERROR","message":"系统错误"}',
  }))
  const unknown = await postPrepay(world)
  assert.equal(unknown.status, 503)
  assert.equal(await errorCodeOf(unknown), 'payment_channel_unavailable')
  const rows = world.db.select().from(wechatPayPrepayAttempts).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.status, 'uncertain')
  assert.equal(rows[0]?.prepayId, null)
  assert.equal(rows[0]?.failureCode, 'provider_server_error')

  const blocked = await postPrepay(world)
  assert.equal(blocked.status, 409)
  assert.equal(await errorCodeOf(blocked), 'payment_active_intent_conflict')
  assert.equal(world.server!.requests.length, 1)
  assert.equal(world.db.select().from(wechatPayPrepayAttempts).all().length, 1)
  const [intent] = world.db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.id, world.intentId))
    .all()
  assert.equal(intent?.status, 'pending')
  assert.equal(intent?.paidAt, null)
  assert.equal(world.db.select().from(ledgerEntries).all().length, 0)
})

test('PAY-10 closed intent refuses a new prepay and a paid intent is never re-invoked', async (t) => {
  const world = await createWorld(t, () => ({ status: 200, body: SUCCESS_BODY }))
  world.sqlite
    .prepare('UPDATE payment_intents SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?')
    .run('closed', Date.now(), Date.now(), world.intentId)
  const closed = await postPrepay(world)
  assert.equal(closed.status, 409)
  assert.equal(await errorCodeOf(closed), 'payment_not_payable')
  assert.equal(world.server!.requests.length, 0)
  assert.equal(world.db.select().from(wechatPayPrepayAttempts).all().length, 0)

  const paidWorld = await createWorld(t, () => ({ status: 200, body: SUCCESS_BODY }))
  paidWorld.sqlite
    .prepare('UPDATE payment_intents SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?')
    .run('paid', Date.now(), Date.now(), paidWorld.intentId)
  const paid = await postPrepay(paidWorld)
  assert.equal(paid.status, 409)
  assert.equal(await errorCodeOf(paid), 'payment_already_paid')
  assert.equal(paidWorld.server!.requests.length, 0)
})

test('PAY-10 missing trusted WeChat identity fails closed without an outbound request', async (t) => {
  const world = await createWorld(
    t,
    () => ({ status: 200, body: SUCCESS_BODY }),
    { withIdentity: false },
  )
  const response = await postPrepay(world)
  assert.equal(response.status, 409)
  assert.equal(await errorCodeOf(response), 'payment_not_payable')
  assert.equal(world.server!.requests.length, 0)
  assert.equal(world.db.select().from(wechatPayPrepayAttempts).all().length, 0)
})

test('PAY-10 without merchant configuration reports unavailable and never falls back to Mock', async (t) => {
  const world = await createWorld(
    t,
    () => ({ status: 200, body: SUCCESS_BODY }),
    { configured: false },
  )
  const capabilityResponse = await world.app.request(PAYMENT_ROUTES.capabilities)
  const capabilities = paymentCapabilitiesSchema.parse(await capabilityResponse.json())
  assert.equal(capabilities.wechatJsapiAvailable, false)
  assert.equal(capabilities.wechatUnavailableReason, 'not_configured')

  const prepay = await api(
    world.app,
    'POST',
    `/payments/intents/${randomUUID()}/wechat-jsapi/prepay`,
    { session: world.resident },
  )
  assert.equal(prepay.status, 503)
  assert.equal(await errorCodeOf(prepay), 'payment_channel_unavailable')

  const create = await api(world.app, 'POST', PAYMENT_ROUTES.createIntent, {
    session: world.resident,
    body: {
      localOrderId: world.orderId,
      channel: 'wechat_jsapi',
      idempotencyKey: `pay-10-no-config-${world.orderId}`,
    },
  })
  assert.equal(create.status, 503)
  assert.equal(await errorCodeOf(create), 'payment_channel_unavailable')
  assert.equal(world.db.select().from(paymentIntents).all().length, 0)
})
