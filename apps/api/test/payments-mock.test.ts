import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
  paymentPaidEventPayloadSchema,
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
  paymentEvents,
  paymentOutbox,
  paymentReviewExceptions,
} from '../src/db/schema.js'
import { LocalError } from '../src/local/shared.js'
import {
  createMockPayment,
  executeMockPaymentAction,
  type MockPaymentAction,
  type MockPaymentSource,
} from '../src/payments/mock-channel.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const RESIDENT_ORIGIN = 'http://localhost:5173'
const NOW = new Date('2026-11-17T02:00:00.000Z')
const INTERNAL_TOKEN = 'mock-payment-internal-token-'.padEnd(40, 'x')

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
  config: ReturnType<typeof loadConfig>
  communityId: string
  productId: string
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
  const body = (await response.json()) as { user: { id: string }; csrfToken: string }
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

function context(databasePath = ':memory:'): World {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
    PAYMENT_MOCK_ENABLED: 'true',
    PAYMENT_INTERNAL_TOKEN: INTERNAL_TOKEN,
    DATABASE_PATH: databasePath,
  })
  const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
  const app = createApp({ db, config, logRequests: false })
  return { app, db, sqlite, config, communityId: '', productId: '' }
}

function seedCommunityAndProduct(db: AppDatabase): { communityId: string; productId: string } {
  const communityId = randomUUID()
  const productId = randomUUID()
  db.insert(communities).values({ id: communityId, name: 'Mock 支付片区', createdAt: NOW }).run()
  db.insert(localProducts).values({
    id: productId,
    communityId,
    name: 'Mock 支付商品',
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
  },
): string {
  const id = randomUUID()
  db.insert(localOrders).values({
    id,
    communityId: input.communityId,
    productId: input.productId,
    residentUserId: input.residentUserId,
    idempotencyKey: `mock-order-${id}`,
    status: input.status ?? 'registered',
    recordSource: 'resident',
    productName: 'Mock 支付商品',
    unitPriceCents: 3980,
    quantity: 1,
    totalCents: 3980,
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
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  return id
}

async function createIntent(
  world: World,
  resident: ResidentSession,
  orderId: string,
): Promise<ReturnType<typeof paymentIntentCreateResponseSchema.parse>['intent']> {
  const response = await api(world.app, 'POST', PAYMENT_ROUTES.createIntent, {
    session: resident,
    body: {
      localOrderId: orderId,
      channel: 'mock',
      idempotencyKey: `mock-intent-${randomUUID()}`,
    },
  })
  assert.equal(response.status, 201)
  return paymentIntentCreateResponseSchema.parse(await response.json()).intent
}

async function getIntent(world: World, resident: ResidentSession, intentId: string) {
  const response = await api(world.app, 'GET', `/payments/intents/${intentId}`, {
    session: resident,
  })
  assert.equal(response.status, 200)
  return paymentIntentDetailResponseSchema.parse(await response.json())
}

function actionTime(intent: { createdAt: string; expiresAt: string }, offsetMinutes = 3): Date {
  return new Date(Date.parse(intent.createdAt) + offsetMinutes * 60_000)
}

function assertLocalError(code: string, fn: () => unknown): LocalError {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof LocalError)
    assert.equal(error.code, code)
    return error
  }
  assert.fail('expected a LocalError')
}

async function runMockWorkers(input: {
  databasePath: string
  intentId: string
  action: MockPaymentAction
  sources: MockPaymentSource[]
  now: string
}): Promise<Array<{ code: number | null; output: string; error: string }>> {
  const workerPath = fileURLToPath(new URL('./helpers/mock-payment-worker.ts', import.meta.url))
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  return Promise.all(input.sources.map((source) => new Promise<{
    code: number | null
    output: string
    error: string
  }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath], {
      cwd,
      env: {
        ...process.env,
        MOCK_DB_PATH: input.databasePath,
        MOCK_INTENT_ID: input.intentId,
        MOCK_ACTION: input.action,
        MOCK_SOURCE: source,
        MOCK_NOW: input.now,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let error = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { error += String(chunk) })
    child.on('close', (code) => resolve({ code, output, error }))
  })))
}

test('Mock success is driven through PAY-03 and remains visibly simulated', async () => {
  const world = context()
  try {
    const scope = seedCommunityAndProduct(world.db)
    const resident = await loginResident(world.app, 'Mock 成功居民')
    const orderId = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const intent = await createIntent(world, resident, orderId)

    const confirmation = executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: intent.id, action: 'succeed', source: 'notification' },
      { now: actionTime(intent) },
    )
    assert.equal(confirmation.outcome, 'confirmed')
    assert.equal(confirmation.intent.status, 'paid')
    assert.equal(confirmation.attempt?.status, 'paid')
    assert.match(confirmation.attempt?.providerTransactionId ?? '', /^MOCK-TXN-/u)
    assert.ok(confirmation.outboxEventId)

    const detail = await getIntent(world, resident, intent.id)
    assert.equal(detail.intent.status, 'paid')
    assert.equal(detail.intent.simulated, true)
    assert.equal(detail.attempts.length, 1)

    const outbox = world.db.select().from(paymentOutbox).get()!
    const payload = paymentPaidEventPayloadSchema.parse(JSON.parse(outbox.payloadJson))
    assert.equal(payload.simulated, true)
    assert.match(payload.providerTransactionId, /^MOCK-TXN-/u)

    // Mock confirmation never completes the order, writes a manual receipt or
    // touches an immutable ledger fact.
    assert.equal(world.db.select().from(ledgerEntries).all().length, 0)
    const order = world.db.select().from(localOrders).where(eq(localOrders.id, orderId)).get()
    assert.equal(order?.status, 'registered')
    assert.equal(order?.verifiedByUserId, null)
  } finally {
    world.sqlite.close()
  }
})

test('Mock failure, cancellation, timeout and pending outcomes use the same state machine', async () => {
  const world = context()
  try {
    const scope = seedCommunityAndProduct(world.db)
    const resident = await loginResident(world.app, 'Mock 场景居民')
    const actor = { userId: resident.userId, staffId: null, role: null as null }

    const failedOrder = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const failedIntent = await createIntent(world, resident, failedOrder)
    assert.equal(executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: failedIntent.id, action: 'fail', source: 'notification' },
      { now: actionTime(failedIntent, 1) },
    ).intent.status, 'failed')
    const failedDetail = await getIntent(world, resident, failedIntent.id)
    assert.equal(failedDetail.attempts[0]?.failureCode, 'MOCK_PAYMENT_FAILED')

    const cancelOrder = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const cancelIntent = await createIntent(world, resident, cancelOrder)
    assert.equal(executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: cancelIntent.id, action: 'cancel', source: 'query' },
      { now: actionTime(cancelIntent, 1) },
    ).intent.status, 'failed')
    const cancelDetail = await getIntent(world, resident, cancelIntent.id)
    assert.equal(cancelDetail.attempts[0]?.failureCode, 'MOCK_USER_CANCELLED')

    const pendingOrder = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const pendingIntent = await createIntent(world, resident, pendingOrder)
    const pending = executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: pendingIntent.id, action: 'pending', source: 'query' },
      { now: actionTime(pendingIntent, 1) },
    )
    assert.equal(pending.intent.status, 'confirming')
    const paid = executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: pendingIntent.id, action: 'succeed', source: 'notification' },
      { now: actionTime(pendingIntent, 3) },
    )
    assert.equal(paid.outcome, 'confirmed')
    assert.equal(paid.intent.status, 'paid')

    const timeoutOrder = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const timeoutIntent = createMockPayment(
      world.db,
      world.config,
      actor,
      { localOrderId: timeoutOrder, idempotencyKey: `mock-timeout-${randomUUID()}` },
      { now: NOW },
    ).intent
    assertLocalError('invalid_request', () => executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: timeoutIntent.id, action: 'timeout', source: 'notification' },
      { now: actionTime(timeoutIntent, 1) },
    ))
    const timeoutAt = new Date(Date.parse(timeoutIntent.expiresAt) + 60_000)
    const timeout = executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: timeoutIntent.id, action: 'timeout', source: 'notification' },
      { now: timeoutAt },
    )
    assert.equal(timeout.intent.status, 'closed')
    assert.equal((await getIntent(world, resident, timeoutIntent.id)).intent.status, 'closed')

    // A trusted late success never rewinds closed -> paid; it remains a review
    // exception and cannot produce a paid attempt/outbox.
    const beforeOutbox = world.db.select().from(paymentOutbox).all().length
    assertLocalError('payment_confirmation_conflict', () => executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: timeoutIntent.id, action: 'succeed', source: 'notification' },
      { now: new Date(timeoutAt.getTime() + 60_000) },
    ))
    assert.equal((await getIntent(world, resident, timeoutIntent.id)).intent.status, 'closed')
    assert.equal(world.db.select().from(paymentOutbox).all().length, beforeOutbox)
    const late = world.db.select().from(paymentReviewExceptions)
      .where(eq(paymentReviewExceptions.kind, 'late_success_after_closed')).get()
    assert.ok(late)
  } finally {
    world.sqlite.close()
  }
})

test('duplicate Mock notifications are idempotent and produce one paid fact', async () => {
  const world = context()
  try {
    const scope = seedCommunityAndProduct(world.db)
    const resident = await loginResident(world.app, 'Mock 重复通知居民')
    const orderId = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const intent = await createIntent(world, resident, orderId)
    const request = {
      paymentIntentId: intent.id,
      action: 'succeed' as const,
      source: 'notification' as const,
    }
    const first = executeMockPaymentAction(world.db, world.config, request, {
      now: actionTime(intent),
    })
    const second = executeMockPaymentAction(world.db, world.config, request, {
      now: actionTime(intent, 4),
    })
    assert.equal(first.outcome, 'confirmed')
    assert.equal(second.outcome, 'already_confirmed')
    assert.equal(world.db.select().from(paymentAttempts).all().length, 1)
    assert.equal(world.db.select().from(paymentOutbox).all().length, 1)
    assert.equal(world.db.select().from(paymentEvents).all().length, 2)
  } finally {
    world.sqlite.close()
  }
})

test('notification and active-query races in two processes converge on one paid fact', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-pay04-race-'))
  const databasePath = join(tempDir, 'mock-race.sqlite')
  const world = context(databasePath)
  try {
    const scope = seedCommunityAndProduct(world.db)
    const resident = await loginResident(world.app, 'Mock 并发居民')
    const orderId = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const intent = await createIntent(world, resident, orderId)
    const results = await runMockWorkers({
      databasePath,
      intentId: intent.id,
      action: 'succeed',
      sources: ['notification', 'query'],
      now: actionTime(intent).toISOString(),
    })
    const parsed = results.map((result) => {
      assert.equal(result.code, 0, `worker failed: ${result.error}`)
      return JSON.parse(result.output) as { ok: boolean; outcome: string }
    })
    assert.deepEqual(
      parsed.map((item) => item.outcome).sort(),
      ['already_confirmed', 'confirmed'],
    )
    assert.equal((await getIntent(world, resident, intent.id)).intent.status, 'paid')
    assert.equal(world.db.select().from(paymentAttempts).all().length, 1)
    assert.equal(world.db.select().from(paymentOutbox).all().length, 1)
  } finally {
    world.sqlite.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('a Mock payment result survives a process/database restart and remains queryable', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-pay04-restart-'))
  const databasePath = join(tempDir, 'mock-restart.sqlite')
  let first: World | null = null
  let second: World | null = null
  try {
    first = context(databasePath)
    const scope = seedCommunityAndProduct(first.db)
    const resident = await loginResident(first.app, 'Mock 重启居民')
    const orderId = seedOrder(first.db, { ...scope, residentUserId: resident.userId })
    const intent = await createIntent(first, resident, orderId)
    executeMockPaymentAction(
      first.db,
      first.config,
      { paymentIntentId: intent.id, action: 'succeed', source: 'notification' },
      { now: actionTime(intent) },
    )
    first.sqlite.close()
    first = null

    second = context(databasePath)
    const restored = await getIntent(second, resident, intent.id)
    assert.equal(restored.intent.status, 'paid')
    assert.equal(restored.intent.simulated, true)
    assert.equal(second.db.select().from(paymentOutbox).all().length, 1)
    assert.equal(
      executeMockPaymentAction(
        second.db,
        second.config,
        { paymentIntentId: intent.id, action: 'succeed', source: 'notification' },
        { now: actionTime(intent, 5) },
      ).outcome,
      'already_confirmed',
    )
  } finally {
    first?.sqlite.close()
    second?.sqlite.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('Mock control is internal-only, fail-closed in production and rejects tampered input', async () => {
  const world = context()
  try {
    const scope = seedCommunityAndProduct(world.db)
    const resident = await loginResident(world.app, 'Mock 安全居民')
    const orderId = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const intent = await createIntent(world, resident, orderId)

    // No public Mock control route exists.
    for (const path of ['/internal/payments/mock', '/payments/mock/execute']) {
      const response = await api(world.app, 'POST', path, {
        session: resident,
        body: { paymentIntentId: intent.id, action: 'succeed', source: 'notification' },
      })
      assert.equal(response.status, 404)
    }

    // A resident session cannot substitute for the PAY-03 internal token.
    const internal = await api(world.app, 'POST', '/internal/payments/confirm', {
      session: resident,
      body: {
        merchantOrderNo: intent.merchantOrderNo,
        channel: 'mock',
        providerStatus: 'paid',
        providerTransactionId: 'MOCK-TXN-unauthorized',
        amountCents: intent.netPayableCents,
        currency: 'CNY',
        merchantAppId: null,
        merchantId: null,
        observedAt: NOW.toISOString(),
        source: 'notification',
        dedupeKey: 'MOCK-EVT-unauthorized',
        providerEventRef: null,
        failureCode: null,
        failureMessage: null,
      },
    })
    assert.equal(internal.status, 401)

    // Production/public-preview configuration fails before the driver runs.
    assert.throws(
      () => loadConfig({
        NODE_ENV: 'production',
        WEB_BASE_URL: 'https://local.proto.3cgroup.cn/',
        PAYMENT_MOCK_ENABLED: 'true',
      }),
      /Mock payment intents/,
    )
    const unsafeConfig = { ...world.config, nodeEnv: 'production' as const, paymentMockEnabled: true }
    assertLocalError('payment_channel_unavailable', () => executeMockPaymentAction(
      world.db,
      unsafeConfig,
      { paymentIntentId: intent.id, action: 'succeed', source: 'notification' },
      { now: actionTime(intent) },
    ))
    assertLocalError('payment_channel_unavailable', () => executeMockPaymentAction(
      world.db,
      { ...world.config, paymentMockEnabled: false },
      { paymentIntentId: intent.id, action: 'succeed', source: 'notification' },
      { now: actionTime(intent) },
    ))

    // Strict internal input rejects an attempt to smuggle amount/merchant data.
    assert.throws(() => executeMockPaymentAction(
      world.db,
      world.config,
      {
        paymentIntentId: intent.id,
        action: 'succeed',
        source: 'notification',
        amountCents: 1,
        merchantId: 'forged',
      } as never,
      { now: actionTime(intent) },
    ), /Unrecognized key|unrecognized_keys/u)
    assert.equal((await getIntent(world, resident, intent.id)).intent.status, 'pending')
    assert.equal(world.db.select().from(paymentOutbox).all().length, 0)
  } finally {
    world.sqlite.close()
  }
})
