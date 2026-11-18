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
  localOrderDetailSchema,
  paymentConfirmationResponseSchema,
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
  paymentIntents,
  paymentOutbox,
  paymentReviewExceptions,
  mockPaymentEventReservations,
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
  now: string | string[]
}): Promise<Array<{ code: number | null; output: string; error: string }>> {
  const workerPath = fileURLToPath(new URL('./helpers/mock-payment-worker.ts', import.meta.url))
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  return Promise.all(
    input.sources.map((source, index) => {
      const workerNow = Array.isArray(input.now) ? input.now[index] : input.now
      if (!workerNow) throw new Error('missing Mock worker clock')
      return new Promise<{
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
            MOCK_NOW: workerNow,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        let error = ''
        child.stdout.on('data', (chunk) => { output += String(chunk) })
        child.stderr.on('data', (chunk) => { error += String(chunk) })
        child.on('close', (code) => resolve({ code, output, error }))
      })
    }),
  )
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
    assert.equal(payload.providerTransactionId, `MOCK-TXN-${intent.id}`)

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
    assert.equal(failedDetail.attempts[0]?.providerTransactionId, null)

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
    assert.equal(cancelDetail.attempts[0]?.providerTransactionId, null)

    const pendingOrder = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const pendingIntent = await createIntent(world, resident, pendingOrder)
    const pending = executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: pendingIntent.id, action: 'pending', source: 'query' },
      { now: actionTime(pendingIntent, 1) },
    )
    assert.equal(pending.intent.status, 'confirming')
    assert.equal(pending.attempt?.providerTransactionId, null)
    const paid = executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: pendingIntent.id, action: 'succeed', source: 'notification' },
      { now: actionTime(pendingIntent, 3) },
    )
    assert.equal(paid.outcome, 'confirmed')
    assert.equal(paid.intent.status, 'paid')
    assert.equal(paid.attempt?.providerTransactionId, `MOCK-TXN-${pendingIntent.id}`)

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
    const timeoutDetail = await getIntent(world, resident, timeoutIntent.id)
    assert.equal(timeoutDetail.intent.status, 'closed')
    assert.equal(timeoutDetail.attempts[0]?.providerTransactionId, null)
    const replayedTimeout = executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: timeoutIntent.id, action: 'timeout', source: 'notification' },
      { now: new Date(timeoutAt.getTime() + 120_000) },
    )
    assert.equal(replayedTimeout.intent.closedAt, timeoutDetail.intent.closedAt)

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

test('pending -> failure/cancel never inherits a synthetic transaction id', async () => {
  const world = context()
  try {
    const scope = seedCommunityAndProduct(world.db)
    const resident = await loginResident(world.app, 'Mock pending 终态居民')

    for (const action of ['fail', 'cancel'] as const) {
      const orderId = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
      const intent = await createIntent(world, resident, orderId)
      assert.equal(executeMockPaymentAction(
        world.db,
        world.config,
        { paymentIntentId: intent.id, action: 'pending', source: 'query' },
        { now: actionTime(intent, 1) },
      ).intent.status, 'confirming')
      const terminal = executeMockPaymentAction(
        world.db,
        world.config,
        { paymentIntentId: intent.id, action, source: 'notification' },
        { now: actionTime(intent, 2) },
      )
      assert.equal(terminal.intent.status, 'failed')
      const detail = await getIntent(world, resident, intent.id)
      assert.equal(detail.attempts.length, 1)
      assert.equal(detail.attempts[0]?.status, 'failed')
      assert.equal(detail.attempts[0]?.providerTransactionId, null)
    }
  } finally {
    world.sqlite.close()
  }
})

test('Mock observedAt uses the execution clock and repeats reuse the first persisted time', async () => {
  const world = context()
  try {
    const scope = seedCommunityAndProduct(world.db)
    const resident = await loginResident(world.app, 'Mock 时间居民')

    const successOrder = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const successIntent = await createIntent(world, resident, successOrder)
    const firstAt = new Date(Date.parse(successIntent.createdAt) + 1_000)
    const immediate = executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: successIntent.id, action: 'succeed', source: 'notification' },
      { now: firstAt },
    )
    assert.equal(immediate.intent.paidAt, firstAt.toISOString())
    assert.ok(Date.parse(immediate.intent.paidAt!) <= firstAt.getTime())

    // Simulate a payment event created before the reservation migration:
    // the first replay must bootstrap the reservation from the immutable event.
    world.sqlite.exec('DROP TRIGGER mock_payment_event_reservations_immutable_delete')
    world.sqlite.prepare('DELETE FROM mock_payment_event_reservations WHERE dedupe_key = ?')
      .run(`MOCK-EVT-${successIntent.id}-succeed-notification`)
    const laterAt = new Date(Date.parse(successIntent.createdAt) + 6 * 60_000)
    const replay = executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: successIntent.id, action: 'succeed', source: 'notification' },
      { now: laterAt },
    )
    assert.equal(replay.outcome, 'already_confirmed')
    assert.equal(replay.intent.paidAt, firstAt.toISOString())
    assert.equal(replay.attempt?.confirmedAt, firstAt.toISOString())
    const bootstrappedReservation = world.db.select().from(mockPaymentEventReservations)
      .where(eq(mockPaymentEventReservations.dedupeKey,
        `MOCK-EVT-${successIntent.id}-succeed-notification`))
      .get()
    assert.equal(bootstrappedReservation?.observedAt.toISOString(), firstAt.toISOString())

    const cancelOrder = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const cancelIntent = await createIntent(world, resident, cancelOrder)
    const cancelAt = new Date(Date.parse(cancelIntent.createdAt) + 1_000)
    const cancelled = executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: cancelIntent.id, action: 'cancel', source: 'notification' },
      { now: cancelAt },
    )
    assert.equal(cancelled.intent.failedAt, cancelAt.toISOString())
    assert.ok(Date.parse(cancelled.intent.failedAt!) <= cancelAt.getTime())

    const delayedOrder = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const delayedIntent = await createIntent(world, resident, delayedOrder)
    const delayedAt = new Date(Date.parse(delayedIntent.createdAt) + 10 * 60_000)
    const delayed = executeMockPaymentAction(
      world.db,
      world.config,
      { paymentIntentId: delayedIntent.id, action: 'succeed', source: 'notification' },
      { now: delayedAt },
    )
    assert.equal(delayed.intent.paidAt, delayedAt.toISOString())
    assert.ok(Date.parse(delayed.intent.paidAt!) > Date.parse(delayedIntent.createdAt) + 5 * 60_000)
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
    assert.equal(world.db.select().from(paymentReviewExceptions).all().length, 0)
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

test('same Mock event reserves one first-seen clock across processes', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-pay04-reservation-'))
  const databasePath = join(tempDir, 'mock-reservation.sqlite')
  const world = context(databasePath)
  try {
    const scope = seedCommunityAndProduct(world.db)
    const resident = await loginResident(world.app, 'Mock 首次时间并发居民')
    const orderId = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const intent = await createIntent(world, resident, orderId)
    const firstAt = actionTime(intent, 1)
    const secondAt = actionTime(intent, 2)
    const results = await runMockWorkers({
      databasePath,
      intentId: intent.id,
      action: 'succeed',
      sources: ['notification', 'notification'],
      now: [firstAt.toISOString(), secondAt.toISOString()],
    })
    const parsed = results.map((result) => {
      assert.equal(result.code, 0, `worker failed: ${result.error}`)
      return JSON.parse(result.output) as { ok: boolean; outcome: string }
    })
    assert.deepEqual(
      parsed.map((item) => item.outcome).sort(),
      ['already_confirmed', 'confirmed'],
    )

    const detail = await getIntent(world, resident, intent.id)
    assert.equal(detail.intent.status, 'paid')
    assert.ok([firstAt.toISOString(), secondAt.toISOString()].includes(detail.intent.paidAt!))
    const reservation = world.db.select().from(mockPaymentEventReservations)
      .where(eq(mockPaymentEventReservations.dedupeKey,
        `MOCK-EVT-${intent.id}-succeed-notification`))
      .get()
    assert.ok(reservation)
    assert.equal(reservation.observedAt.toISOString(), detail.intent.paidAt)
    assert.equal(world.db.select().from(paymentReviewExceptions).all().length, 0)
    assert.equal(world.db.select().from(paymentAttempts).all().length, 1)
    assert.equal(world.db.select().from(paymentOutbox).all().length, 1)
    assert.throws(
      () => world.db.update(mockPaymentEventReservations)
        .set({ observedAt: secondAt })
        .where(eq(mockPaymentEventReservations.dedupeKey,
          `MOCK-EVT-${intent.id}-succeed-notification`))
        .run(),
      /mock payment event reservation is immutable/u,
    )
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

test('legacy Mock control aliases stay unavailable, fail closed in production and reject tampered input', async () => {
  const world = context()
  try {
    const scope = seedCommunityAndProduct(world.db)
    const resident = await loginResident(world.app, 'Mock 安全居民')
    const orderId = seedOrder(world.db, { ...scope, residentUserId: resident.userId })
    const intent = await createIntent(world, resident, orderId)

    // Legacy/unauthorized Mock control aliases do not exist.
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

function mockActionPath(intentId: string): string {
  return PAYMENT_ROUTES.mockAction.replace(':paymentIntentId', intentId)
}

function mockFacts(world: World, orderId: string, intentId: string) {
  const intent = world.db
    .select({ status: paymentIntents.status })
    .from(paymentIntents)
    .where(eq(paymentIntents.id, intentId))
    .get()
  const order = world.db
    .select({ status: localOrders.status })
    .from(localOrders)
    .where(eq(localOrders.id, orderId))
    .get()
  return {
    orderStatus: order?.status ?? null,
    intentStatus: intent?.status ?? null,
    events: world.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentIntentId, intentId))
      .all().length,
    attempts: world.db
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.paymentIntentId, intentId))
      .all().length,
    outbox: world.db
      .select()
      .from(paymentOutbox)
      .where(eq(paymentOutbox.paymentIntentId, intentId))
      .all().length,
  }
}

async function postMockAction(
  app: App,
  intentId: string,
  options: {
    session?: ResidentSession
    body: unknown
    csrf?: boolean
    origin?: string | null
    csrfToken?: string
  },
) {
  const body = JSON.stringify(options.body)
  if (options.csrfToken !== undefined) {
    return app.request(mockActionPath(intentId), {
      method: 'POST',
      headers: {
        ...(options.session ? { cookie: options.session.cookies } : {}),
        'content-type': 'application/json',
        'x-csrf-token': options.csrfToken,
        ...(options.origin === null ? {} : { origin: options.origin ?? RESIDENT_ORIGIN }),
      },
      body,
    })
  }
  return api(app, 'POST', mockActionPath(intentId), {
    session: options.session,
    body: options.body,
    csrf: options.csrf,
    origin: options.origin,
  })
}

test('resident Mock HTTP route is authenticated, CSRF/origin bound, ownership-scoped and fail-closed', async () => {
  const world = context()
  try {
    const scope = seedCommunityAndProduct(world.db)
    const residentA = await loginResident(world.app, 'Mock HTTP A')
    const residentB = await loginResident(world.app, 'Mock HTTP B')
    const orderA = seedOrder(world.db, { ...scope, residentUserId: residentA.userId })
    const orderB = seedOrder(world.db, { ...scope, residentUserId: residentB.userId })
    const intentA = await createIntent(world, residentA, orderA)
    const intentB = await createIntent(world, residentB, orderB)
    const baselineA = mockFacts(world, orderA, intentA.id)
    const baselineB = mockFacts(world, orderB, intentB.id)

    // 1. Anonymous caller cannot change payment state.
    const anonymous = await postMockAction(world.app, intentA.id, {
      body: { action: 'succeed', source: 'notification' },
    })
    assert.equal(anonymous.status, 401)
    assert.deepEqual(mockFacts(world, orderA, intentA.id), baselineA)

    // 2. A resident session without CSRF is refused.
    const missingCsrf = await postMockAction(world.app, intentA.id, {
      session: residentA,
      body: { action: 'succeed', source: 'notification' },
      csrf: false,
    })
    assert.equal(missingCsrf.status, 403)
    assert.deepEqual(mockFacts(world, orderA, intentA.id), baselineA)

    // A wrong CSRF token is refused as well.
    const wrongCsrf = await postMockAction(world.app, intentA.id, {
      session: residentA,
      body: { action: 'succeed', source: 'notification' },
      csrfToken: 'not-the-session-token',
    })
    assert.equal(wrongCsrf.status, 403)
    assert.deepEqual(mockFacts(world, orderA, intentA.id), baselineA)

    // A valid CSRF token from an untrusted Origin is refused.
    const badOrigin = await postMockAction(world.app, intentA.id, {
      session: residentA,
      body: { action: 'succeed', source: 'notification' },
      origin: 'https://evil.example',
    })
    assert.equal(badOrigin.status, 403)
    assert.deepEqual(mockFacts(world, orderA, intentA.id), baselineA)

    // 3. Resident A gets an indistinguishable 404 for resident B's intent.
    const crossOwner = await postMockAction(world.app, intentB.id, {
      session: residentA,
      body: { action: 'succeed', source: 'notification' },
    })
    assert.equal(crossOwner.status, 404)
    assert.deepEqual(mockFacts(world, orderB, intentB.id), baselineB)

    // 4. A disabled server switch fails closed even for a valid owner/CSRF.
    const disabledApp = createApp({
      db: world.db,
      config: { ...world.config, paymentMockEnabled: false },
      logRequests: false,
    })
    const disabled = await postMockAction(disabledApp, intentA.id, {
      session: residentA,
      body: { action: 'succeed', source: 'notification' },
    })
    assert.equal(disabled.status, 503)
    assert.deepEqual(mockFacts(world, orderA, intentA.id), baselineA)

    // 5. A production-misconfigured app cannot manufacture Mock facts either.
    const productionApp = createApp({
      db: world.db,
      config: {
        ...world.config,
        nodeEnv: 'production' as const,
        paymentMockEnabled: true,
      },
      logRequests: false,
    })
    const production = await postMockAction(productionApp, intentA.id, {
      session: residentA,
      body: { action: 'succeed', source: 'notification' },
    })
    assert.equal(production.status, 503)
    assert.deepEqual(mockFacts(world, orderA, intentA.id), baselineA)

    // Strict bodies cannot inject money facts. Each field is rejected before
    // the driver, and the pending intent/order remain untouched.
    for (const injected of [
      { amount: 1 },
      { paid: true },
      { providerTransactionId: 'MOCK-TXN-forged' },
    ]) {
      const response = await postMockAction(world.app, intentA.id, {
        session: residentA,
        body: { action: 'succeed', ...injected },
      })
      assert.equal(response.status, 400, JSON.stringify(injected))
      assert.deepEqual(mockFacts(world, orderA, intentA.id), baselineA)
    }

    // The only success path is the route -> PAY-03 -> PAY-05 pipeline. Read
    // the order back from the server instead of trusting the action response.
    const success = await postMockAction(world.app, intentA.id, {
      session: residentA,
      body: { action: 'succeed', source: 'notification' },
    })
    assert.equal(success.status, 200)
    const confirmation = paymentConfirmationResponseSchema.parse(await success.json())
    assert.equal(confirmation.intent.status, 'paid')

    const orderResponse = await api(world.app, 'GET', `/local-orders/${orderA}`, {
      session: residentA,
    })
    assert.equal(orderResponse.status, 200)
    const completedOrder = localOrderDetailSchema.parse(await orderResponse.json())
    assert.equal(completedOrder.status, 'online_completed')
    assert.equal(completedOrder.payment?.status, 'paid')
    assert.equal(completedOrder.onlineCompletion?.simulated, true)
    assert.equal(mockFacts(world, orderA, intentA.id).orderStatus, 'online_completed')
  } finally {
    world.sqlite.close()
  }
})
