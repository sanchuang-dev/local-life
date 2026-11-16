import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import {
  PAYMENT_ROUTES,
  paymentIntentCreateResponseSchema,
  paymentIntentDetailResponseSchema,
  type LocalOrderStatus,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  communities,
  ledgerEntries,
  localOrders,
  localProducts,
  paymentAttempts,
  paymentIntents,
} from '../src/db/schema.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const RESIDENT_ORIGIN = 'http://localhost:5173'
const NOW = new Date('2026-11-16T02:00:00.000Z')

type App = ReturnType<typeof createApp>

interface ResidentSession {
  cookies: string
  csrfToken: string
  userId: string
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

async function loginResident(app: App, name: string): Promise<ResidentSession> {
  const state = await csrf(app)
  const response = await app.request('/auth/dev/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: state.cookie,
      'x-csrf-token': state.token,
      origin: RESIDENT_ORIGIN,
    },
    body: JSON.stringify({ displayName: name }),
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    user: { id: string }
    csrfToken: string
  }
  return {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: body.csrfToken,
    userId: body.user.id,
  }
}

function api(
  app: App,
  method: string,
  path: string,
  options: { session?: ResidentSession; body?: unknown; csrf?: boolean; origin?: string | null } = {},
) {
  const { session, body, csrf: withCsrf = method !== 'GET', origin } = options
  const headers: Record<string, string> = {}
  if (session) headers.cookie = session.cookies
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (session && withCsrf) {
    headers['x-csrf-token'] = session.csrfToken
    if (origin !== null) headers.origin = origin ?? RESIDENT_ORIGIN
  }
  return app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } }
  return body.error.code
}

interface World {
  app: App
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  communityId: string
  productId: string
}

function context(options: { paymentMockEnabled?: boolean; databasePath?: string } = {}): World {
  const { db, sqlite } = createDatabase(options.databasePath ?? ':memory:', migrationsFolder)
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
    PAYMENT_MOCK_ENABLED: options.paymentMockEnabled === false ? 'false' : 'true',
  })
  const app = createApp({ db, config, logRequests: false })
  return { app, db, sqlite, communityId: '', productId: '' }
}

function seedCommunityAndProduct(db: AppDatabase): { communityId: string; productId: string } {
  const communityId = randomUUID()
  const productId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '支付 HTTP 片区', createdAt: NOW }).run()
  db.insert(localProducts).values({
    id: productId,
    communityId,
    name: '支付 HTTP 商品',
    unitPriceCents: 3980,
    status: 'on_shelf',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  return { communityId, productId }
}

function seedOrder(
  db: AppDatabase,
  input: {
    communityId: string
    productId: string
    residentUserId: string
    status?: LocalOrderStatus
    totalCents?: number
    discountCents?: number
  },
): string {
  const id = randomUUID()
  const total = input.totalCents ?? 3980
  db.insert(localOrders).values({
    id,
    communityId: input.communityId,
    productId: input.productId,
    residentUserId: input.residentUserId,
    idempotencyKey: `pay-http-${id}`,
    status: input.status ?? 'registered',
    recordSource: 'resident',
    productName: '支付 HTTP 商品',
    unitPriceCents: total,
    quantity: 1,
    totalCents: total,
    couponDiscountCents: input.discountCents ?? 0,
    couponId: null,
    note: null,
    createdByStaffId: null,
    attributedStaffId: null,
    sourceActivityId: null,
    sourceTeamId: null,
    verifiedByUserId: null,
    verifiedAt: null,
    verificationNote: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  return id
}

function createBody(localOrderId: string, overrides: Record<string, unknown> = {}) {
  return {
    localOrderId,
    channel: 'mock' as const,
    idempotencyKey: `pay-create-${randomUUID()}`,
    ...overrides,
  }
}

test('resident creates one pending mock intent with server-derived amounts and reads it back', async () => {
  const world = context()
  try {
    const { db, app } = world
    const scope = seedCommunityAndProduct(db)
    const resident = await loginResident(app, '支付居民')
    const orderId = seedOrder(db, {
      ...scope,
      residentUserId: resident.userId,
    })

    const response = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(orderId, { idempotencyKey: 'pay-create-0001' }),
    })
    assert.equal(response.status, 201)
    const created = paymentIntentCreateResponseSchema.parse(await response.json())
    assert.equal(created.created, true)
    assert.equal(created.intent.status, 'pending')
    assert.equal(created.intent.channel, 'mock')
    assert.equal(created.intent.simulated, true)
    assert.equal(created.intent.residentUserId, resident.userId)
    assert.equal(created.intent.communityId, scope.communityId)
    assert.equal(created.intent.grossAmountCents, 3980)
    assert.equal(created.intent.discountCents, 0)
    assert.equal(created.intent.netPayableCents, 3980)
    assert.equal(created.intent.paidAt, null)
    assert.equal(created.intent.merchantAppId, null)
    assert.equal(created.intent.merchantId, null)

    db.insert(paymentAttempts).values({
      id: randomUUID(),
      paymentIntentId: created.intent.id,
      attemptNo: 1,
      status: 'pending',
      idempotencyKey: `attempt-history-${randomUUID()}`,
      providerTransactionId: null,
      createdAt: NOW,
      updatedAt: NOW,
      confirmedAt: null,
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
    }).run()

    const detail = await api(app, 'GET', `/payments/intents/${created.intent.id}`, {
      session: resident,
    })
    assert.equal(detail.status, 200)
    const detailBody = paymentIntentDetailResponseSchema.parse(await detail.json())
    assert.equal(detailBody.intent.id, created.intent.id)
    assert.equal(detailBody.attempts.length, 1)
    assert.equal(detailBody.attempts[0]?.status, 'pending')
    assert.equal(detail.headers.get('cache-control'), 'no-store')

    // PAY-02 owns no paid fact, order completion, coupon or ledger write.
    assert.equal(db.select().from(paymentIntents).where(eq(paymentIntents.id, created.intent.id))
      .get()?.status, 'pending')
    assert.equal(db.select().from(ledgerEntries).all().length, 0)
    const order = db.select().from(localOrders).where(eq(localOrders.id, orderId)).get()
    assert.equal(order?.status, 'registered')
    assert.equal(order?.verifiedByUserId, null)
  } finally {
    world.sqlite.close()
  }
})

test('idempotency, active-intent reuse, concurrency and conflicting request content', async () => {
  const world = context()
  try {
    const { db, app } = world
    const scope = seedCommunityAndProduct(db)
    const resident = await loginResident(app, '幂等居民')
    const orderId = seedOrder(db, { ...scope, residentUserId: resident.userId })
    const otherOrderId = seedOrder(db, { ...scope, residentUserId: resident.userId })
    const concurrentOrderId = seedOrder(db, { ...scope, residentUserId: resident.userId })
    const concurrentKeysOrderId = seedOrder(db, { ...scope, residentUserId: resident.userId })
    const key = 'pay-create-idempotent'

    const first = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(orderId, { idempotencyKey: key }),
    })
    assert.equal(first.status, 201)
    const firstBody = paymentIntentCreateResponseSchema.parse(await first.json())

    const repeat = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(orderId, { idempotencyKey: key }),
    })
    assert.equal(repeat.status, 200)
    assert.equal(paymentIntentCreateResponseSchema.parse(await repeat.json()).intent.id, firstBody.intent.id)

    const sameKeyOtherOrder = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(otherOrderId, { idempotencyKey: key }),
    })
    assert.equal(sameKeyOtherOrder.status, 409)
    assert.equal(await errorCode(sameKeyOtherOrder), 'payment_idempotency_conflict')

    // A new key on the same order reuses the active intent instead of stacking.
    const newKey = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(orderId, { idempotencyKey: 'pay-create-new-key' }),
    })
    assert.equal(newKey.status, 200)
    assert.equal(paymentIntentCreateResponseSchema.parse(await newKey.json()).intent.id, firstBody.intent.id)

    // Concurrent same-key calls converge on one row.
    const concurrentKey = 'pay-create-concurrent'
    const concurrent = await Promise.all([
      api(app, 'POST', PAYMENT_ROUTES.createIntent, {
        session: resident,
        body: createBody(concurrentOrderId, { idempotencyKey: concurrentKey }),
      }),
      api(app, 'POST', PAYMENT_ROUTES.createIntent, {
        session: resident,
        body: createBody(concurrentOrderId, { idempotencyKey: concurrentKey }),
      }),
    ])
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 201])
    const concurrentIds = await Promise.all(
      concurrent.map(async (response) =>
        paymentIntentCreateResponseSchema.parse(await response.json()).intent.id),
    )
    assert.equal(new Set(concurrentIds).size, 1)

    // Two different keys racing on a fresh order also converge on one active
    // intent via the IMMEDIATE transaction + active-intent reuse.
    const differentKeys = await Promise.all([
      api(app, 'POST', PAYMENT_ROUTES.createIntent, {
        session: resident,
        body: createBody(concurrentKeysOrderId, { idempotencyKey: 'race-key-a' }),
      }),
      api(app, 'POST', PAYMENT_ROUTES.createIntent, {
        session: resident,
        body: createBody(concurrentKeysOrderId, { idempotencyKey: 'race-key-b' }),
      }),
    ])
    assert.deepEqual(differentKeys.map((response) => response.status).sort(), [200, 201])
    const differentIds = await Promise.all(
      differentKeys.map(async (response) =>
        paymentIntentCreateResponseSchema.parse(await response.json()).intent.id),
    )
    assert.equal(new Set(differentIds).size, 1)

    // One intent for each of the three orders; no uncontrolled duplicates.
    assert.equal(db.select().from(paymentIntents).all().length, 3)
  } finally {
    world.sqlite.close()
  }
})

test('an expired active intent is not assumed unpaid; a closed intent permits a new key', async () => {
  const world = context()
  try {
    const { db, app } = world
    const scope = seedCommunityAndProduct(db)
    const resident = await loginResident(app, '过期支付居民')

    const expiredOrderId = seedOrder(db, { ...scope, residentUserId: resident.userId })
    const expiredId = randomUUID()
    db.insert(paymentIntents).values({
      id: expiredId,
      localOrderId: expiredOrderId,
      residentUserId: resident.userId,
      communityId: scope.communityId,
      kind: 'channel',
      channel: 'mock',
      simulated: true,
      merchantOrderNo: `PAY-${expiredId.replace(/-/gu, '')}`,
      merchantAppId: null,
      merchantId: null,
      grossAmountCents: 3980,
      discountCents: 0,
      netPayableCents: 3980,
      status: 'pending',
      idempotencyKey: `expired-intent-${expiredId}`,
      expiresAt: new Date(NOW.getTime() - 60_000),
      paidAt: null,
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      createdAt: new Date(NOW.getTime() - 120_000),
      updatedAt: new Date(NOW.getTime() - 120_000),
    }).run()
    const expired = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(expiredOrderId, { idempotencyKey: 'fresh-key-after-expiry' }),
    })
    assert.equal(expired.status, 200)
    assert.equal(
      paymentIntentCreateResponseSchema.parse(await expired.json()).intent.id,
      expiredId,
      'expiry alone is not proof the channel did not charge',
    )

    const closedOrderId = seedOrder(db, { ...scope, residentUserId: resident.userId })
    const first = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(closedOrderId, { idempotencyKey: 'closed-first-key' }),
    })
    assert.equal(first.status, 201)
    const firstIntent = paymentIntentCreateResponseSchema.parse(await first.json()).intent
    const closedAt = new Date(Date.parse(firstIntent.updatedAt) + 1000)
    db.update(paymentIntents).set({
      status: 'closed',
      closedAt,
      updatedAt: closedAt,
    }).where(eq(paymentIntents.id, firstIntent.id)).run()

    const retried = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(closedOrderId, { idempotencyKey: 'closed-retry-key' }),
    })
    assert.equal(retried.status, 201)
    const retriedIntent = paymentIntentCreateResponseSchema.parse(await retried.json()).intent
    assert.notEqual(retriedIntent.id, firstIntent.id)
  } finally {
    world.sqlite.close()
  }
})

test('unauthenticated, cross-user, CSRF/Origin and extra-field writes are refused', async () => {
  const world = context()
  try {
    const { db, app } = world
    const scope = seedCommunityAndProduct(db)
    const resident = await loginResident(app, '订单居民')
    const other = await loginResident(app, '其他居民')
    const orderId = seedOrder(db, { ...scope, residentUserId: resident.userId })

    const anonymous = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      body: createBody(orderId),
    })
    assert.equal(anonymous.status, 401)

    const noCsrf = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      csrf: false,
      body: createBody(orderId),
    })
    assert.equal(noCsrf.status, 403)

    const badOrigin = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      origin: 'https://evil.example',
      body: createBody(orderId),
    })
    assert.equal(badOrigin.status, 403)

    const forged = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: {
        ...createBody(orderId),
        residentUserId: other.userId,
        communityId: scope.communityId,
        amountCents: 1,
        merchantOrderNo: 'FORGED',
      },
    })
    assert.equal(forged.status, 400)
    assert.equal(await errorCode(forged), 'invalid_request')

    const crossCreate = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: other,
      body: createBody(orderId),
    })
    assert.equal(crossCreate.status, 404)

    const created = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(orderId),
    })
    assert.equal(created.status, 201)
    const intentId = paymentIntentCreateResponseSchema.parse(await created.json()).intent.id
    const crossRead = await api(app, 'GET', `/payments/intents/${intentId}`, {
      session: other,
    })
    assert.equal(crossRead.status, 404)
  } finally {
    world.sqlite.close()
  }
})

test('closed, verified, zero-amount, already-paid and unavailable-channel boundaries are explicit', async () => {
  const world = context()
  try {
    const { db, app } = world
    const scope = seedCommunityAndProduct(db)
    const resident = await loginResident(app, '边界居民')

    for (const status of ['cancelled', 'rejected', 'verified'] as const) {
      const orderId = seedOrder(db, {
        ...scope,
        residentUserId: resident.userId,
        status,
      })
      const response = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
        session: resident,
        body: createBody(orderId),
      })
      assert.equal(response.status, 409, `${status} must not be payable`)
      assert.equal(await errorCode(response), 'payment_not_payable')
    }

    const zeroOrder = seedOrder(db, {
      ...scope,
      residentUserId: resident.userId,
      totalCents: 0,
    })
    const zero = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(zeroOrder),
    })
    assert.equal(zero.status, 409)
    assert.equal(await errorCode(zero), 'payment_zero_amount_unavailable')

    const paidOrder = seedOrder(db, { ...scope, residentUserId: resident.userId })
    db.insert(paymentIntents).values({
      id: randomUUID(),
      localOrderId: paidOrder,
      residentUserId: resident.userId,
      communityId: scope.communityId,
      kind: 'channel',
      channel: 'mock',
      simulated: true,
      merchantOrderNo: `PAY-${randomUUID()}`,
      merchantAppId: null,
      merchantId: null,
      grossAmountCents: 3980,
      discountCents: 0,
      netPayableCents: 3980,
      status: 'paid',
      idempotencyKey: `already-paid-${randomUUID()}`,
      expiresAt: new Date(NOW.getTime() + 60_000),
      paidAt: NOW,
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
    }).run()
    const paid = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(paidOrder),
    })
    assert.equal(paid.status, 409)
    assert.equal(await errorCode(paid), 'payment_already_paid')

    const channelOrder = seedOrder(db, { ...scope, residentUserId: resident.userId })
    const wechat = await api(app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(channelOrder, { channel: 'wechat_jsapi' }),
    })
    assert.equal(wechat.status, 503)
    assert.equal(await errorCode(wechat), 'payment_channel_unavailable')

    const disabled = context({ paymentMockEnabled: false })
    try {
      const disabledScope = seedCommunityAndProduct(disabled.db)
      const disabledResident = await loginResident(disabled.app, '禁用 Mock 居民')
      const disabledOrder = seedOrder(disabled.db, {
        ...disabledScope,
        residentUserId: disabledResident.userId,
      })
      const unavailable = await api(disabled.app, 'POST', PAYMENT_ROUTES.createIntent, {
        session: disabledResident,
        body: createBody(disabledOrder),
      })
      assert.equal(unavailable.status, 503)
      assert.equal(await errorCode(unavailable), 'payment_channel_unavailable')
    } finally {
      disabled.sqlite.close()
    }
  } finally {
    world.sqlite.close()
  }
})

test('payment intent and attempts survive a database restart', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-payment-http-'))
  const databasePath = join(tempDir, 'payments.sqlite')
  let first: World | null = null
  let second: World | null = null
  try {
    first = context({ databasePath })
    const scope = seedCommunityAndProduct(first.db)
    const resident = await loginResident(first.app, '重启居民')
    const orderId = seedOrder(first.db, { ...scope, residentUserId: resident.userId })
    const response = await api(first.app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: resident,
      body: createBody(orderId),
    })
    assert.equal(response.status, 201)
    const created = paymentIntentCreateResponseSchema.parse(await response.json())
    first.sqlite.close()
    first = null

    second = context({ databasePath })
    const restartRead = await api(second.app, 'GET', `/payments/intents/${created.intent.id}`, {
      session: resident,
    })
    assert.equal(restartRead.status, 200)
    const restored = paymentIntentDetailResponseSchema.parse(await restartRead.json())
    assert.equal(restored.intent.id, created.intent.id)
    assert.equal(restored.intent.status, 'pending')
  } finally {
    first?.sqlite.close()
    second?.sqlite.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('production rejects an enabled mock payment channel at startup', () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      WEB_BASE_URL: 'https://local-life.example',
      PAYMENT_MOCK_ENABLED: 'true',
    }),
    /Mock payment intents/,
  )
})
