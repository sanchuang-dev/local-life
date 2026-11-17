import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq } from 'drizzle-orm'
import test from 'node:test'
import {
  API_ERROR_CODES,
  LOCAL_ORDER_ROUTES,
  PAYMENT_INTERNAL_ROUTES,
  PAYMENT_ROUTES,
  localOrderDetailSchema,
  localOrderOnlineCompletionResponseSchema,
  paymentIntentCreateResponseSchema,
  paymentOutboxConsumeResponseSchema,
  type LocalOrderDetail,
  type PaymentEvidence,
  type PaymentIntent,
} from '@sanchuang-dev/local-life-contracts'
import { hashPassword } from '../src/auth/security.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activities,
  activityInvitations,
  activityParticipations,
  activityRuleVersions,
  activityTeams,
  auditLogs,
  communities,
  couponIssueEvents,
  couponIssues,
  couponRewardDisputes,
  couponTeamGrants,
  ledgerEntries,
  localOrderEvents,
  localOrderOnlineCompletions,
  localOrderOnlineConflicts,
  localOrders,
  localProducts,
  paymentAttempts,
  paymentEvents,
  paymentIntents,
  paymentOutbox,
  paymentReviewExceptions,
  staffAccounts,
  users,
} from '../src/db/schema.js'
import { seedConfirmedCommunity } from './resident-community-fixtures.js'
import { readOrderPaymentEvidence } from '../src/ledger/payment-evidence.js'
import { confirmTrustedPayment } from '../src/payments/confirmation.js'
import { projectPaymentExceptionsOntoOrders, settleDeferredCouponReleases } from '../src/payments/order-completion.js'
import {
  PAYMENT_OUTBOX_LEASE_MS,
  PAYMENT_OUTBOX_MAX_ATTEMPTS,
  runPaymentOutboxConsumer,
} from '../src/payments/outbox.js'
import { createPaymentIntent } from '../src/payments/service.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const RESIDENT_ORIGIN = 'http://localhost:5173'
const ADMIN_ORIGIN = 'http://localhost:5174'
const ADMIN_PASSWORD = 'Admin-Password-123!'
const SUBSCRIBER_TOKEN = 'internal-payment-token-'.padEnd(40, 'x')
/** Fixture timestamps: fixed so seeded rows are deterministic. */
const OBSERVED_AT = new Date('2026-11-17T02:00:00.000Z')

/**
 * HTTP-driven services (PAY-02/03 and the consumer route) use the real clock, so
 * every direct consumer run has to be scheduled relative to "now" instead of the
 * fixture timestamp.
 */
function realNow(offsetMs = 0): Date {
  return new Date(Date.now() + offsetMs)
}

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
  userId: string
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

async function loginResident(app: App, displayName: string): Promise<Session> {
  const state = await csrf(app)
  const response = await app.request('/auth/dev/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: state.cookie,
      'x-csrf-token': state.token,
      origin: RESIDENT_ORIGIN,
    },
    body: JSON.stringify({ displayName }),
  })
  assert.equal(response.status, 200, 'resident dev login must succeed')
  const body = (await response.json()) as { user: { id: string }; csrfToken: string }
  return {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: body.csrfToken,
    userId: body.user.id,
  }
}

async function loginStaff(app: App): Promise<Session> {
  const state = await csrf(app)
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: state.cookie,
      'x-csrf-token': state.token,
      origin: ADMIN_ORIGIN,
    },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  })
  assert.equal(response.status, 200, 'admin login must succeed')
  const body = (await response.json()) as { csrfToken: string }
  return {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: body.csrfToken,
    userId: '',
  }
}

interface ApiOptions {
  session?: Session
  body?: unknown
  csrf?: boolean
  origin?: string | null
  headers?: Record<string, string>
}

function api(app: App, method: string, path: string, options: ApiOptions = {}) {
  const { session, body, csrf: withCsrf = method !== 'GET', origin, headers: extraHeaders } = options
  const headers: Record<string, string> = { ...extraHeaders }
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

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface World {
  app: App
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  config: ReturnType<typeof loadConfig>
  communityId: string
  productId: string
  coordinatorUserId: string
  admin: Session
  resident: Session
}

async function world(options: { priceCents?: number; databasePath?: string } = {}): Promise<World> {
  const databasePath = options.databasePath ?? ':memory:'
  const cfg = loadConfig({
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
    PAYMENT_MOCK_ENABLED: 'true',
    PAYMENT_INTERNAL_TOKEN: SUBSCRIBER_TOKEN,
    DATABASE_PATH: databasePath,
  })
  const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
  const app = createApp({ db, config: cfg, logRequests: false })

  const coordinatorUserId = randomUUID()
  const staffId = randomUUID()
  db.insert(users).values({
    id: coordinatorUserId,
    displayName: '系统管理员',
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
  }).run()
  db.insert(staffAccounts).values({
    id: staffId,
    userId: coordinatorUserId,
    username: 'admin',
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    status: 'active',
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
  }).run()

  const communityId = randomUUID()
  const productId = randomUUID()
  db.insert(communities).values({
    id: communityId,
    name: '支付完成片区',
    createdAt: OBSERVED_AT,
  }).run()
  db.insert(localProducts).values({
    id: productId,
    communityId,
    name: '支付完成商品',
    unitPriceCents: options.priceCents ?? 3980,
    status: 'on_shelf',
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
  }).run()

  const admin = await loginStaff(app)
  const resident = await loginResident(app, '在线支付居民')
  seedConfirmedCommunity(db, resident.userId, communityId, OBSERVED_AT)

  return { app, db, sqlite, config: cfg, communityId, productId, coordinatorUserId, admin, resident }
}

function orderRow(db: AppDatabase, orderId: string) {
  const row = db.select().from(localOrders).where(eq(localOrders.id, orderId)).get()
  assert.ok(row, 'order row must exist')
  return row
}

function couponRow(db: AppDatabase, couponId: string) {
  const row = db.select().from(couponIssues).where(eq(couponIssues.id, couponId)).get()
  assert.ok(row, 'coupon row must exist')
  return row
}

interface CouponFixture {
  activityId: string
  teamId: string
  grantId: string
  couponId: string
}

/**
 * A real reward grant with one coupon reserved for the buyer.
 *
 * Coupons can only exist for a locked three-seat team of a published purchase
 * reward activity, so the fixture writes exactly that shape and lets the existing
 * #211 triggers validate it. Issuance itself is not what this card tests; the
 * coupon lifecycle it feeds (reserve / redeem / release) is the real service.
 */
function seedRewardCoupon(
  db: AppDatabase,
  input: {
    communityId: string
    buyerUserId: string
    createdByUserId: string
    faceValueCents: number
  },
): CouponFixture {
  const now = OBSERVED_AT
  const activityId = randomUUID()
  const purchasePlan = {
    thresholdCents: input.faceValueCents * 3,
    couponFaceValueCents: input.faceValueCents,
    maxRewardedTeams: 5,
  }
  db.insert(activities).values({
    id: activityId,
    communityId: input.communityId,
    title: '支付完成消费团活动',
    summary: '消费返券活动',
    description: 'PAY-05 消费券完成路径',
    status: 'published',
    startsAt: new Date(now.getTime() - 60 * 60 * 1000),
    endsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    location: '幸福社区党群服务中心',
    budgetCapCents: 100_000,
    prizeQuantityCap: 100,
    publicRulesJson: JSON.stringify({
      eligibility: '本社区注册居民',
      checkin: '到社区服务中心签到',
      purchase: '购买指定本地商品',
      prizeClaim: '凭券抵扣',
      notes: '活动最终解释权归社区所有',
    }),
    purchaseRewardPlanJson: JSON.stringify(purchasePlan),
    currentRuleVersionId: null,
    createdByUserId: input.createdByUserId,
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
    pausedAt: null,
    endedAt: null,
  }).run()

  const ruleVersionId = randomUUID()
  db.insert(activityRuleVersions).values({
    id: ruleVersionId,
    activityId,
    version: 1,
    snapshotJson: JSON.stringify({
      startsAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      endsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      location: '幸福社区党群服务中心',
      budgetCapCents: 100_000,
      prizeQuantityCap: 100,
      publicRules: {},
      purchaseRewardPlan: purchasePlan,
    }),
    createdByUserId: input.createdByUserId,
    createdAt: now,
  }).run()
  db.update(activities).set({ currentRuleVersionId: ruleVersionId })
    .where(eq(activities.id, activityId))
    .run()

  const teamId = randomUUID()
  db.insert(activityTeams).values({
    id: teamId,
    activityId,
    leaderUserId: input.buyerUserId,
    status: 'locked',
    createdAt: now,
    lockedAt: now,
  }).run()

  const memberIds = [randomUUID(), randomUUID()]
  for (const memberId of memberIds) {
    db.insert(users).values({
      id: memberId,
      displayName: '消费团成员',
      createdAt: now,
      updatedAt: now,
    }).run()
  }
  const invitationId = randomUUID()
  db.insert(activityInvitations).values({
    id: invitationId,
    code: randomUUID().replace(/-/gu, ''),
    activityId,
    teamId,
    inviterUserId: input.buyerUserId,
    createdAt: now,
  }).run()
  db.insert(activityParticipations).values({
    id: randomUUID(),
    activityId,
    teamId,
    userId: input.buyerUserId,
    seatNo: 1,
    role: 'leader',
    inviteSource: 'self',
    invitationId: null,
    joinedAt: new Date(now.getTime() - 30 * 60 * 1000),
  }).run()
  memberIds.forEach((memberId, index) => {
    db.insert(activityParticipations).values({
      id: randomUUID(),
      activityId,
      teamId,
      userId: memberId,
      seatNo: index + 2,
      role: 'member',
      inviteSource: 'invite',
      invitationId,
      joinedAt: new Date(now.getTime() - 20 * 60 * 1000),
    }).run()
  })

  const grantId = randomUUID()
  db.insert(couponTeamGrants).values({
    id: grantId,
    activityId,
    teamId,
    ruleVersionId,
    faceValueCents: input.faceValueCents,
    totalValueCents: input.faceValueCents * 3,
    grantedAt: now,
  }).run()

  const seats: Array<{ userId: string; seatNo: number }> = [
    { userId: input.buyerUserId, seatNo: 1 },
    ...memberIds.map((userId, index) => ({ userId, seatNo: index + 2 })),
  ]
  let buyerCouponId = ''
  for (const seat of seats) {
    const couponId = randomUUID()
    db.insert(couponIssues).values({
      id: couponId,
      grantId,
      activityId,
      teamId,
      userId: seat.userId,
      seatNo: seat.seatNo,
      faceValueCents: input.faceValueCents,
      status: 'available',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      reservedOrderId: null,
      reservedAt: null,
      redeemedAt: null,
      voidedAt: null,
      updatedAt: now,
    }).run()
    db.insert(couponIssueEvents).values({
      id: randomUUID(),
      couponId,
      kind: 'issued',
      orderId: null,
      createdAt: now,
    }).run()
    if (seat.seatNo === 1) buyerCouponId = couponId
  }
  return { activityId, teamId, grantId, couponId: buyerCouponId }
}

/** Register a real resident order through the documented HTTP surface. */
async function registerOrder(
  w: World,
  input: { quantity?: number; couponId?: string } = {},
): Promise<LocalOrderDetail> {
  const response = await api(w.app, 'POST', LOCAL_ORDER_ROUTES.myOrders, {
    session: w.resident,
    body: {
      productId: w.productId,
      quantity: input.quantity ?? 1,
      idempotencyKey: randomUUID(),
      ...(input.couponId === undefined ? {} : { couponId: input.couponId }),
    },
  })
  const text = await response.text()
  assert.equal(response.status, 201, `order registration must succeed: ${text}`)
  const body = JSON.parse(text) as { created: boolean; order: unknown }
  return localOrderDetailSchema.parse(body.order)
}

async function createIntent(
  w: World,
  orderId: string,
  options: { idempotencyKey?: string } = {},
): Promise<PaymentIntent> {
  const response = await api(w.app, 'POST', PAYMENT_ROUTES.createIntent, {
    session: w.resident,
    body: {
      localOrderId: orderId,
      channel: 'mock',
      idempotencyKey: options.idempotencyKey ?? `intent-${randomUUID()}`,
    },
  })
  const text = await response.text()
  assert.equal(response.status, 201, `intent creation must succeed: ${text}`)
  return paymentIntentCreateResponseSchema.parse(JSON.parse(text)).intent
}

function paidEvidence(intent: PaymentIntent, overrides: Partial<PaymentEvidence> = {}): PaymentEvidence {
  return {
    merchantOrderNo: intent.merchantOrderNo,
    channel: 'mock',
    providerStatus: 'paid',
    providerTransactionId: `mock-txn-${randomUUID()}`,
    amountCents: intent.netPayableCents,
    currency: 'CNY',
    merchantAppId: null,
    merchantId: null,
    observedAt: OBSERVED_AT.toISOString(),
    source: 'notification',
    dedupeKey: `notify-${randomUUID()}`,
    providerEventRef: null,
    failureCode: null,
    failureMessage: null,
    ...overrides,
  }
}

async function confirmEvidence(w: World, evidence: PaymentEvidence): Promise<Response> {
  return api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.confirm, {
    body: evidence,
    headers: { authorization: `Bearer ${SUBSCRIBER_TOKEN}` },
  })
}

async function confirmPaid(w: World, intent: PaymentIntent): Promise<Response> {
  const response = await confirmEvidence(w, paidEvidence(intent))
  assert.equal(response.status, 200, `trusted paid evidence must confirm: ${await response.clone().text()}`)
  return response
}

async function consume(w: World, options: { token?: string; limit?: number; origin?: string | null } = {}) {
  const response = await api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.consumeOutbox, {
    body: options.limit === undefined ? {} : { limit: options.limit },
    headers: options.token === undefined
      ? { authorization: `Bearer ${SUBSCRIBER_TOKEN}` }
      : { authorization: `Bearer ${options.token}` },
  })
  return response
}

async function consumeOk(w: World) {
  const response = await consume(w)
  const text = await response.text()
  assert.equal(response.status, 200, `consumer must succeed: ${text}`)
  return paymentOutboxConsumeResponseSchema.parse(JSON.parse(text))
}

async function readOrder(w: World, order: LocalOrderDetail): Promise<LocalOrderDetail> {
  const response = await api(w.app, 'GET', `/local-orders/${order.id}`, { session: w.resident })
  assert.equal(response.status, 200)
  return localOrderDetailSchema.parse(await response.json())
}

async function staffCancel(w: World, order: LocalOrderDetail) {
  return api(w.app, 'PATCH', `/admin/local-orders/${order.id}/status`, {
    session: w.admin,
    origin: ADMIN_ORIGIN,
    body: { expectedUpdatedAt: order.updatedAt, status: 'cancelled' },
  })
}

function outline(db: AppDatabase, orderId: string) {
  return db.select().from(localOrderOnlineCompletions)
    .where(eq(localOrderOnlineCompletions.localOrderId, orderId))
    .all()
}

function conflicts(db: AppDatabase, orderId: string) {
  return db.select().from(localOrderOnlineConflicts)
    .where(eq(localOrderOnlineConflicts.localOrderId, orderId))
    .all()
}

function orderEvents(db: AppDatabase, orderId: string) {
  return db.select().from(localOrderEvents)
    .where(eq(localOrderEvents.orderId, orderId))
    .all()
}

function withTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows may still hold a SQLite handle; a leftover temp dir is harmless.
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Trusted paid event -> exactly one online completion                     */
/* -------------------------------------------------------------------------- */

test('a trusted paid event completes the order once and writes no manual verification fact', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    assert.equal(order.status, 'registered')
    assert.equal(order.onlineCompletion, null)

    const intent = await createIntent(w, order.id)
    await confirmPaid(w, intent)
    const first = await consumeOk(w)
    assert.equal(first.claimed, 1)
    assert.equal(first.completed, 1)

    const detail = await readOrder(w, order)
    assert.equal(detail.status, 'online_completed')
    assert.equal(detail.verification, null, 'online payment is never a human verification')
    assert.equal(detail.onlineCompletion?.kind, 'channel')
    assert.equal(detail.onlineCompletion?.amountCents, 3980)
    assert.equal(detail.onlineCompletion?.simulated, true)
    assert.equal(detail.onlineCompletion?.paymentIntentId, intent.id)
    assert.ok(detail.onlineCompletion?.providerTransactionId)
    assert.equal(detail.onlineConflicts.length, 0)
    assert.equal(
      orderEvents(w.db, order.id).filter((event) => event.event === 'order.online_completed').length,
      1,
      'exactly one completion timeline event',
    )

    const row = orderRow(w.db, order.id)
    assert.equal(row.verifiedAt, null)
    assert.equal(row.verifiedByUserId, null)
    assert.equal(
      w.db.select().from(ledgerEntries).where(eq(ledgerEntries.sourceId, order.id)).all().length,
      0,
      'PAY-05 writes no ledger fact (PAY-06 owns the finance projection)',
    )
    const outbox = w.db.select().from(paymentOutbox).all()
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0]?.status, 'delivered')
    assert.equal(outline(w.db, order.id).length, 1)

    // The online fact can never be turned into a manual receipt: the ledger's
    // manual evidence surface only accepts a human-verified order.
    const evidence = readOrderPaymentEvidence(
      w.db,
      { userId: w.coordinatorUserId, staffId: null, role: 'admin' },
      order.id,
    )
    assert.equal(evidence.canRecord, false)
    assert.equal(evidence.orderStatus, 'online_completed')
    assert.equal(evidence.status, 'pending_order_review')

    // Re-running the consumer must not project a second completion.
    const second = await consumeOk(w)
    assert.equal(second.claimed, 0)
    assert.equal(second.completed, 0)
    assert.equal(outline(w.db, order.id).length, 1)
  } finally {
    w.sqlite.close()
  }
})

test('replaying the same trusted event is idempotent even if the outbox row is re-driven', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    const intent = await createIntent(w, order.id)
    await confirmPaid(w, intent)
    await consumeOk(w)

    // Simulate a lost delivery marker: the event itself is unchanged.
    w.db.update(paymentOutbox).set({ status: 'pending', deliveredAt: null, attempts: 1 }).run()
    const replay = await consumeOk(w)
    assert.equal(replay.claimed, 1)
    assert.equal(replay.alreadyCompleted, 1)
    assert.equal(replay.completed, 0)
    assert.equal(outline(w.db, order.id).length, 1)
    assert.equal(
      orderEvents(w.db, order.id).filter((event) => event.event === 'order.online_completed').length,
      1,
    )
  } finally {
    w.sqlite.close()
  }
})

test('two consumers over one file database produce exactly one completion', async () => {
  const temp = withTempDir('ll-pay05-concurrent-')
  const databasePath = join(temp.dir, 'concurrent.sqlite')
  const first = await world({ databasePath })
  let second: ReturnType<typeof createDatabase> | null = null
  try {
    const order = await registerOrder(first)
    const intent = await createIntent(first, order.id)
    await confirmPaid(first, intent)

    second = createDatabase(databasePath, migrationsFolder)
    // A second consumer claims the row first (as if another process won the claim).
    const claim = second.db.transaction((tx) => {
      return tx.update(paymentOutbox)
        .set({ status: 'processing', attempts: 1, updatedAt: realNow() })
        .where(eq(paymentOutbox.status, 'pending'))
        .run()
    }, { behavior: 'immediate' })
    assert.equal(claim.changes, 1)

    // While the lease is live, nobody may steal the row: no duplicate projection.
    const blocked = runPaymentOutboxConsumer(first.db, {
      now: realNow(1_000),
      leaseMs: 60_000,
    })
    assert.equal(blocked.claimed, 0)
    assert.equal(outline(first.db, order.id).length, 0)

    // After the lease expires the abandoned claim is reclaimed and projected once.
    const recovered = runPaymentOutboxConsumer(first.db, {
      now: realNow(61_000),
      leaseMs: 60_000,
    })
    assert.equal(recovered.claimed, 1)
    assert.equal(recovered.completed, 1)
    assert.equal(outline(first.db, order.id).length, 1)

    // The other consumer sees a delivered row and does nothing.
    const loser = runPaymentOutboxConsumer(second.db, {
      now: realNow(62_000),
    })
    assert.equal(loser.claimed, 0)
    assert.equal(outline(second.db, order.id).length, 1)
    assert.equal(orderRow(second.db, order.id).status, 'online_completed')
  } finally {
    try {
      second?.sqlite.close()
    } catch {
      // ignore
    }
    first.sqlite.close()
    temp.cleanup()
  }
})

test('two independent consumer processes project the same event exactly once', async () => {
  const temp = withTempDir('ll-pay05-multiprocess-')
  const databasePath = join(temp.dir, 'multi.sqlite')
  const w = await world({ databasePath })
  try {
    const order = await registerOrder(w)
    const intent = await createIntent(w, order.id)
    await confirmPaid(w, intent)

    const workerPath = fileURLToPath(new URL('./helpers/consume-worker.ts', import.meta.url))
    const cwd = fileURLToPath(new URL('..', import.meta.url))
    const scheduledAt = realNow(1_000).toISOString()
    const runWorker = () => new Promise<{ code: number | null; output: string; error: string }>(
      (resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', workerPath], {
          cwd,
          env: { ...process.env, CONSUME_DB_PATH: databasePath, CONSUME_NOW: scheduledAt },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        let error = ''
        child.stdout.on('data', (chunk) => { output += String(chunk) })
        child.stderr.on('data', (chunk) => { error += String(chunk) })
        child.on('close', (code) => resolve({ code, output, error }))
      },
    )
    const results = await Promise.all([runWorker(), runWorker()])
    for (const result of results) {
      assert.equal(result.code, 0, result.error || result.output)
    }
    const parsed = results.map((result) => JSON.parse(result.output) as {
      result: { claimed: number; completed: number; alreadyCompleted: number }
    })
    const completed = parsed.reduce((total, item) => total + item.result.completed, 0)
    const alreadyCompleted = parsed.reduce(
      (total, item) => total + item.result.alreadyCompleted,
      0,
    )
    assert.equal(completed, 1, 'exactly one operating-system process completes the order')
    assert.ok(completed + alreadyCompleted >= 1)
    assert.equal(outline(w.db, order.id).length, 1)
    assert.equal(
      orderEvents(w.db, order.id).filter((event) => event.event === 'order.online_completed').length,
      1,
    )
    assert.equal(orderRow(w.db, order.id).status, 'online_completed')
    assert.equal(w.db.select().from(paymentOutbox).get()?.status, 'delivered')
  } finally {
    w.sqlite.close()
    temp.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* 2. Negative / conflict paths                                               */
/* -------------------------------------------------------------------------- */test('durable payment evidence cannot be rewritten and an inconsistent event is parked for review', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    const intent = await createIntent(w, order.id)
    await confirmPaid(w, intent)

    // The durable payload is immutable at the database level, so no consumer can
    // be tricked by a rewritten amount.
    assert.throws(
      () => w.db.update(paymentOutbox).set({ payloadJson: '{}' }).run(),
      /immutable/iu,
    )

    // A structurally valid but inconsistent paid event (a claimed paid success for
    // an intent that is still pending) must never complete the order.
    const staleOrder = await registerOrder(w)
    const staleIntent = await createIntent(w, staleOrder.id)
    const eventId = randomUUID()
    w.db.insert(paymentEvents).values({
      id: eventId,
      paymentIntentId: staleIntent.id,
      paymentAttemptId: null,
      eventType: 'payment.channel_query',
      source: 'channel',
      fromStatus: 'pending',
      toStatus: 'pending',
      providerEventRef: 'stale-query',
      dedupeKey: `stale-query-${eventId}`,
      evidenceFingerprint: 'a'.repeat(64),
      note: null,
      createdAt: realNow(),
    }).run()
    w.db.insert(paymentOutbox).values({
      id: randomUUID(),
      paymentIntentId: staleIntent.id,
      paymentEventId: eventId,
      topic: 'payment.paid.v1',
      dedupeKey: `payment.paid:${staleIntent.id}`,
      payloadJson: JSON.stringify({
        paymentIntentId: staleIntent.id,
        localOrderId: staleOrder.id,
        residentUserId: w.resident.userId,
        communityId: w.communityId,
        amountCents: staleIntent.netPayableCents,
        providerTransactionId: 'mock-txn-stale',
        simulated: true,
        paidAt: realNow().toISOString(),
      }),
      status: 'pending',
      attempts: 0,
      availableAt: realNow(),
      lastError: null,
      createdAt: realNow(),
      updatedAt: realNow(),
      deliveredAt: null,
    }).run()

    const result = await consumeOk(w)
    assert.equal(result.claimed, 2)
    assert.equal(result.completed, 1, 'only the genuinely confirmed payment completes')
    assert.equal(result.conflicts, 1)
    assert.equal(outline(w.db, order.id).length, 1)
    assert.equal(orderRow(w.db, order.id).status, 'online_completed')
    assert.equal(outline(w.db, staleOrder.id).length, 0)
    assert.equal(orderRow(w.db, staleOrder.id).status, 'registered')
    const staleDetail = await readOrder(w, staleOrder)
    assert.equal(staleDetail.onlineCompletion, null)
    assert.equal(staleDetail.onlineConflicts[0]?.kind, 'payment_state_invalid')
    const parked = w.db.select().from(paymentOutbox)
      .where(eq(paymentOutbox.paymentIntentId, staleIntent.id)).get()!
    assert.equal(parked.status, 'failed')
    assert.ok(parked.lastError)
  } finally {
    w.sqlite.close()
  }
})

test('a trusted paid event for a cancelled order is preserved for human review, never auto-completed', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    const intent = await createIntent(w, order.id)
    const cancelled = await staffCancel(w, order)
    assert.equal(cancelled.status, 200)
    // The channel still captures the money afterwards: PAY-03 accepts pending -> paid.
    await confirmPaid(w, intent)

    const result = await consumeOk(w)
    assert.equal(result.conflicts, 1)
    assert.equal(result.completed, 0)
    assert.equal(orderRow(w.db, order.id).status, 'cancelled')
    assert.equal(outline(w.db, order.id).length, 0)
    const detail = await readOrder(w, order)
    assert.equal(detail.status, 'cancelled')
    assert.equal(detail.onlineCompletion, null)
    assert.equal(detail.onlineConflicts[0]?.kind, 'order_not_payable')
    assert.equal(detail.onlineConflicts[0]?.status, 'open')
    assert.ok(
      w.db.select().from(paymentOutbox).get()!.payloadJson.includes(intent.id),
      'the real payment evidence is retained',
    )
  } finally {
    w.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 3. Coupon reservation, release and late payment                           */
/* -------------------------------------------------------------------------- */

test('cancelling an order with a live payment defers the coupon release', async () => {
  const w = await world({ priceCents: 1000 })
  try {
    const fixture = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 200,
    })
    const order = await registerOrder(w, { couponId: fixture.couponId })
    assert.equal(order.snapshot.netPayableCents, 800)
    assert.equal(couponRow(w.db, fixture.couponId).status, 'reserved')

    // A live payment intent exists; the cancellation must not release the coupon.
    await createIntent(w, order.id)
    const cancelled = await staffCancel(w, order)
    assert.equal(cancelled.status, 200)

    // Status is terminal, but the channel may still capture: the coupon stays held.
    assert.equal(orderRow(w.db, order.id).status, 'cancelled')
    const coupon = couponRow(w.db, fixture.couponId)
    assert.equal(coupon.status, 'reserved')
    assert.equal(coupon.reservedOrderId, order.id)
    assert.equal(
      w.db.select().from(couponIssueEvents)
        .where(and(eq(couponIssueEvents.couponId, fixture.couponId), eq(couponIssueEvents.kind, 'released')))
        .all().length,
      0,
      'no release while the payment is pending',
    )
    const audit = w.db.select().from(auditLogs)
      .where(eq(auditLogs.targetId, order.id))
      .all()
      .find((row) => row.event === 'local_order.status_changed')
    assert.ok(audit)
    assert.equal(JSON.parse(audit.metadata ?? '{}').couponRelease, 'deferred')

    // Expiry is not evidence of failure: a long-expired pending intent still holds
    // the reservation, because only a trusted channel result may release it.
    const afterExpiry = runPaymentOutboxConsumer(w.db, {
      now: realNow(24 * 60 * 60 * 1_000),
    })
    assert.equal(afterExpiry.couponsReleased, 0)
    assert.equal(couponRow(w.db, fixture.couponId).status, 'reserved')
  } finally {
    w.sqlite.close()
  }
})

test('cancelling after the channel already captured money never releases the coupon', async () => {
  const w = await world({ priceCents: 1000 })
  try {
    const fixture = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 200,
    })
    const order = await registerOrder(w, { couponId: fixture.couponId })
    const intent = await createIntent(w, order.id)
    await confirmPaid(w, intent)

    // Money is already captured (intent paid) but the consumer has not projected it.
    const cancelled = await staffCancel(w, order)
    assert.equal(cancelled.status, 200)
    assert.equal(couponRow(w.db, fixture.couponId).status, 'reserved')
    assert.equal(
      w.db.select().from(couponIssueEvents)
        .where(and(
          eq(couponIssueEvents.couponId, fixture.couponId),
          eq(couponIssueEvents.kind, 'released'),
        ))
        .all().length,
      0,
      'a paid intent keeps the coupon held for review instead of releasing it',
    )

    // The trusted paid event cannot complete the cancelled order; it is preserved
    // for human reconciliation and the coupon is NOT handed to another order.
    const result = await consumeOk(w)
    assert.equal(result.completed, 0)
    assert.equal(result.conflicts, 1)
    const detail = await readOrder(w, order)
    assert.equal(detail.status, 'cancelled')
    assert.equal(detail.onlineCompletion, null)
    assert.equal(detail.onlineConflicts[0]?.kind, 'order_not_payable')
    assert.equal(couponRow(w.db, fixture.couponId).status, 'reserved')
    assert.equal(couponRow(w.db, fixture.couponId).reservedOrderId, order.id)
    // A later sweep also refuses to release it: the intent stays `paid`.
    assert.equal(runPaymentOutboxConsumer(w.db, { now: realNow(60_000) }).couponsReleased, 0)
    assert.equal(couponRow(w.db, fixture.couponId).status, 'reserved')
  } finally {
    w.sqlite.close()
  }
})

test('a trusted channel close releases the deferred coupon exactly once', async () => {
  const w = await world({ priceCents: 1000 })
  try {
    const fixture = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 200,
    })
    const order = await registerOrder(w, { couponId: fixture.couponId })
    const intent = await createIntent(w, order.id)
    assert.equal((await staffCancel(w, order)).status, 200)
    assert.equal(couponRow(w.db, fixture.couponId).status, 'reserved')

    const closed = await confirmEvidence(w, paidEvidence(intent, {
      providerStatus: 'closed',
      providerTransactionId: null,
    }))
    assert.equal(closed.status, 200)

    const result = await consumeOk(w)
    assert.equal(result.couponsReleased, 1)
    assert.equal(orderRow(w.db, order.id).status, 'cancelled')
    const coupon = couponRow(w.db, fixture.couponId)
    assert.equal(coupon.status, 'available')
    assert.equal(coupon.reservedOrderId, null)
    assert.equal(
      w.db.select().from(couponIssueEvents)
        .where(and(eq(couponIssueEvents.couponId, fixture.couponId), eq(couponIssueEvents.kind, 'released')))
        .all().length,
      1,
    )
    assert.equal(outline(w.db, order.id).length, 0)

    const again = await consumeOk(w)
    assert.equal(again.couponsReleased, 0)
    assert.equal(
      w.db.select().from(couponIssueEvents)
        .where(and(eq(couponIssueEvents.couponId, fixture.couponId), eq(couponIssueEvents.kind, 'released')))
        .all().length,
      1,
      'a second consumer run never releases twice',
    )
  } finally {
    w.sqlite.close()
  }
})

test('a trusted channel failure releases the deferred coupon exactly once', async () => {
  const w = await world({ priceCents: 1000 })
  try {
    const fixture = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 200,
    })
    const order = await registerOrder(w, { couponId: fixture.couponId })
    const intent = await createIntent(w, order.id)
    assert.equal((await staffCancel(w, order)).status, 200)

    const failed = await confirmEvidence(w, paidEvidence(intent, {
      providerStatus: 'failed',
      providerTransactionId: null,
      failureCode: 'USERPAY_FAILED',
      failureMessage: '支付失败',
    }))
    assert.equal(failed.status, 200)

    const result = await consumeOk(w)
    assert.equal(result.couponsReleased, 1)
    assert.equal(couponRow(w.db, fixture.couponId).status, 'available')
    assert.equal(runPaymentOutboxConsumer(w.db, { now: realNow(1_000) }).couponsReleased, 0)
  } finally {
    w.sqlite.close()
  }
})

test('deferred coupon release skips an older live payment before applying its batch limit', async () => {
  const w = await world({ priceCents: 1000 })
  try {
    const pendingCoupon = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 200,
    })
    const pendingOrder = await registerOrder(w, { couponId: pendingCoupon.couponId })
    await createIntent(w, pendingOrder.id)
    assert.equal((await staffCancel(w, pendingOrder)).status, 200)

    const closedCoupon = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 200,
    })
    const closedOrder = await registerOrder(w, { couponId: closedCoupon.couponId })
    const closedIntent = await createIntent(w, closedOrder.id)
    assert.equal((await staffCancel(w, closedOrder)).status, 200)
    assert.equal((await confirmEvidence(w, paidEvidence(closedIntent, {
      providerStatus: 'closed',
      providerTransactionId: null,
    }))).status, 200)

    assert.equal(settleDeferredCouponReleases(w.db, realNow(), { limit: 1 }), 1)
    assert.equal(couponRow(w.db, pendingCoupon.couponId).status, 'reserved')
    assert.equal(couponRow(w.db, closedCoupon.couponId).status, 'available')
  } finally {
    w.sqlite.close()
  }
})

test('a preserved late-success exception blocks a deferred coupon release', async () => {
  const w = await world({ priceCents: 1000 })
  try {
    const fixture = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 200,
    })
    const order = await registerOrder(w, { couponId: fixture.couponId })
    const intent = await createIntent(w, order.id)
    assert.equal((await staffCancel(w, order)).status, 200)
    assert.equal((await confirmEvidence(w, paidEvidence(intent, {
      providerStatus: 'closed',
      providerTransactionId: null,
    }))).status, 200)

    // PAY-03 already preserved the late paid evidence before PAY-05's release sweep.
    const late = await confirmEvidence(w, paidEvidence(intent))
    assert.equal(late.status, 409)
    assert.equal(await errorCode(late), API_ERROR_CODES.paymentConfirmationConflict)

    const result = await consumeOk(w)
    assert.equal(result.couponsReleased, 0)
    assert.equal(result.exceptionsProjected, 1)
    const coupon = couponRow(w.db, fixture.couponId)
    assert.equal(coupon.status, 'reserved')
    assert.equal(coupon.reservedOrderId, order.id)
    const detail = await readOrder(w, order)
    assert.equal(detail.status, 'cancelled')
    assert.equal(detail.onlineConflicts[0]?.kind, 'late_success')
  } finally {
    w.sqlite.close()
  }
})

test('late-success exception projection advances past already projected rows', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    for (let index = 0; index < 2; index += 1) {
      const intent = await createIntent(w, order.id)
      assert.equal((await confirmEvidence(w, paidEvidence(intent, {
        providerStatus: 'closed',
        providerTransactionId: null,
      }))).status, 200)
      const late = await confirmEvidence(w, paidEvidence(intent))
      assert.equal(late.status, 409)
      assert.equal(await errorCode(late), API_ERROR_CODES.paymentConfirmationConflict)
    }

    assert.equal(w.db.select().from(paymentReviewExceptions).all().length, 2)
    assert.equal(projectPaymentExceptionsOntoOrders(w.db, realNow(), { limit: 1 }), 1)
    assert.equal(projectPaymentExceptionsOntoOrders(w.db, realNow(1), { limit: 1 }), 1)
    assert.equal(conflicts(w.db, order.id).length, 2)
  } finally {
    w.sqlite.close()
  }
})

test('a late trusted success after close stays cancelled, keeps the released coupon released and opens manual review', async () => {
  const w = await world({ priceCents: 1000 })
  try {
    const fixture = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 200,
    })
    const order = await registerOrder(w, { couponId: fixture.couponId })
    const intent = await createIntent(w, order.id)
    assert.equal((await staffCancel(w, order)).status, 200)
    assert.equal(
      (await confirmEvidence(w, paidEvidence(intent, {
        providerStatus: 'closed',
        providerTransactionId: null,
      }))).status,
      200,
    )
    await consumeOk(w)
    assert.equal(couponRow(w.db, fixture.couponId).status, 'available')

    // The channel reports the real money afterwards.
    const late = await confirmEvidence(w, paidEvidence(intent))
    assert.equal(late.status, 409)
    assert.equal(await errorCode(late), API_ERROR_CODES.paymentConfirmationConflict)
    assert.equal(
      w.db.select().from(paymentReviewExceptions).all().length,
      1,
      'PAY-03 keeps the trusted evidence as an exception',
    )
    // closed -> paid is refused, so no paid event/outbox was ever produced.
    assert.equal(w.db.select().from(paymentOutbox).all().length, 0)

    const result = await consumeOk(w)
    assert.equal(result.exceptionsProjected, 1)
    assert.equal(result.completed, 0)
    const detail = await readOrder(w, order)
    assert.equal(detail.status, 'cancelled')
    assert.equal(detail.onlineCompletion, null)
    assert.equal(detail.onlineConflicts[0]?.kind, 'late_success')
    assert.equal(detail.onlineConflicts[0]?.status, 'open')
    const coupon = couponRow(w.db, fixture.couponId)
    assert.equal(coupon.status, 'available', 'a released coupon is never re-reserved automatically')
    assert.equal(coupon.reservedOrderId, null)
    assert.equal(outline(w.db, order.id).length, 0)
    assert.equal(orderRow(w.db, order.id).status, 'cancelled')

    // Re-running only re-states the same conflict; it never duplicates it.
    await consumeOk(w)
    assert.equal(conflicts(w.db, order.id).length, 1)
  } finally {
    w.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 4. Zero-amount coupon orders                                               */
/* -------------------------------------------------------------------------- */

test('a fully coupon-discounted order completes independently without any channel fact', async () => {
  const w = await world({ priceCents: 450 })
  try {
    const fixture = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 450,
    })
    const order = await registerOrder(w, { couponId: fixture.couponId })
    assert.equal(order.snapshot.totalCents, 450)
    assert.equal(order.snapshot.couponDiscountCents, 450)
    assert.equal(order.snapshot.netPayableCents, 0)

    // PAY-02 still refuses a zero net payable intent: the guard is not bypassed.
    const zeroIntent = await api(w.app, 'POST', PAYMENT_ROUTES.createIntent, {
      session: w.resident,
      body: {
        localOrderId: order.id,
        channel: 'mock',
        idempotencyKey: `zero-should-fail-${randomUUID()}`,
      },
    })
    assert.equal(zeroIntent.status, 409)
    assert.equal(await errorCode(zeroIntent), API_ERROR_CODES.paymentZeroAmountUnavailable)

    const path = LOCAL_ORDER_ROUTES.myZeroAmountCompletion.replace(':localOrderId', order.id)
    const completed = await api(w.app, 'POST', path, { session: w.resident })
    const completedText = await completed.text()
    assert.equal(completed.status, 201, `zero-amount completion must succeed: ${completedText}`)
    const body = localOrderOnlineCompletionResponseSchema.parse(JSON.parse(completedText))
    assert.equal(body.created, true)
    assert.equal(body.order.status, 'online_completed')
    assert.equal(body.order.verification, null)
    assert.equal(body.order.onlineCompletion?.kind, 'zero_amount')
    assert.equal(body.order.onlineCompletion?.amountCents, 0)
    assert.equal(body.order.onlineCompletion?.providerTransactionId, null)
    assert.equal(body.order.onlineCompletion?.simulated, false)

    // Payment-domain record exists, but with no channel, no attempt and no positive cash.
    const intent = w.db.select().from(paymentIntents).all()
    assert.equal(intent.length, 1)
    assert.equal(intent[0]?.kind, 'zero_amount')
    assert.equal(intent[0]?.channel, null)
    assert.equal(intent[0]?.status, 'paid')
    assert.equal(intent[0]?.netPayableCents, 0)
    assert.equal(w.db.select().from(paymentAttempts).all().length, 0)
    assert.equal(w.db.select().from(paymentOutbox).all().length, 0, 'no fake channel success evidence')
    assert.equal(w.db.select().from(ledgerEntries).all().length, 0, 'no positive cash record')
    assert.equal(couponRow(w.db, fixture.couponId).status, 'redeemed')
    assert.equal(outline(w.db, order.id).length, 1)

    // Idempotent replay: same completion, no second coupon redemption.
    const replay = await api(w.app, 'POST', path, { session: w.resident })
    assert.equal(replay.status, 200)
    const replayed = localOrderOnlineCompletionResponseSchema.parse(await replay.json())
    assert.equal(replayed.created, false)
    assert.equal(outline(w.db, order.id).length, 1)
    assert.equal(
      w.db.select().from(couponIssueEvents)
        .where(and(eq(couponIssueEvents.couponId, fixture.couponId), eq(couponIssueEvents.kind, 'redeemed')))
        .all().length,
      1,
    )
    assert.equal(w.db.select().from(paymentIntents).all().length, 1)
  } finally {
    w.sqlite.close()
  }
})

test('zero-amount completion refuses a released coupon and a non-zero order', async () => {
  const w = await world({ priceCents: 450 })
  try {
    const fixture = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 450,
    })
    const order = await registerOrder(w, { couponId: fixture.couponId })
    // No payment intent exists, so cancelling releases the reservation (#213 path).
    assert.equal((await staffCancel(w, order)).status, 200)
    assert.equal(couponRow(w.db, fixture.couponId).status, 'available')

    const path = LOCAL_ORDER_ROUTES.myZeroAmountCompletion.replace(':localOrderId', order.id)
    const rejected = await api(w.app, 'POST', path, { session: w.resident })
    assert.equal(rejected.status, 409)
    assert.equal(couponRow(w.db, fixture.couponId).status, 'available')
    assert.equal(outline(w.db, order.id).length, 0)

    // A non-zero payable order is not a zero-amount candidate even if reachable.
    const plain = await registerOrder(w)
    const plainPath = LOCAL_ORDER_ROUTES.myZeroAmountCompletion.replace(':localOrderId', plain.id)
    const nonZero = await api(w.app, 'POST', plainPath, { session: w.resident })
    assert.equal(nonZero.status, 409)
    assert.equal(await errorCode(nonZero), API_ERROR_CODES.paymentZeroAmountUnavailable)
  } finally {
    w.sqlite.close()
  }
})

test('a redeemed coupon cannot be used again and a reversed reward coupon stays unusable', async () => {
  const w = await world({ priceCents: 450 })
  try {
    const fixture = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 450,
    })
    const order = await registerOrder(w, { couponId: fixture.couponId })
    const path = LOCAL_ORDER_ROUTES.myZeroAmountCompletion.replace(':localOrderId', order.id)
    assert.equal((await api(w.app, 'POST', path, { session: w.resident })).status, 201)
    assert.equal(couponRow(w.db, fixture.couponId).status, 'redeemed')

    const reused = await api(w.app, 'POST', LOCAL_ORDER_ROUTES.myOrders, {
      session: w.resident,
      body: {
        productId: w.productId,
        quantity: 1,
        couponId: fixture.couponId,
        idempotencyKey: randomUUID(),
      },
    })
    assert.equal(reused.status, 409, 'a redeemed coupon is refused by the real registration path')

    // #213: a full reversal of the source reward voids unspent coupons.
    const secondFixture = seedRewardCoupon(w.db, {
      communityId: w.communityId,
      buyerUserId: w.resident.userId,
      createdByUserId: w.coordinatorUserId,
      faceValueCents: 450,
    })
    const reversalEntryId = randomUUID()
    w.db.insert(ledgerEntries).values({
      id: reversalEntryId,
      factKind: 'order_registered',
      sourceSystem: 'local_order',
      sourceId: `pay05-void-fixture-${randomUUID()}`,
      sourceDisplayNo: 'void-fixture',
      communityId: w.communityId,
      productId: w.productId,
      attributedStaffId: null,
      attributionState: 'pending',
      attributionBasis: 'no_explicit_attribution',
      amountCents: 0,
      settlementAmountStatus: 'pending_rule',
      occurredAt: OBSERVED_AT,
      verifiedAt: null,
      recordedByUserId: null,
      recordedByStaffId: null,
      counterEntryId: null,
      evidenceRef: null,
      evidenceKind: 'none',
      batchId: null,
      createdAt: OBSERVED_AT,
    }).run()
    w.db.insert(couponRewardDisputes).values({
      id: randomUUID(),
      disputeKey: `grant:${secondFixture.grantId}:eligibility-lost`,
      kind: 'reward_eligibility_lost',
      grantId: secondFixture.grantId,
      couponId: null,
      sourceOrderId: order.id,
      reversalEntryId,
      resolution: 'auto_void',
      createdAt: OBSERVED_AT,
    }).run()
    w.db.update(couponIssues).set({
      status: 'void',
      voidedAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT,
    }).where(eq(couponIssues.id, secondFixture.couponId)).run()
    assert.equal(couponRow(w.db, secondFixture.couponId).status, 'void')

    const fromVoided = await api(w.app, 'POST', LOCAL_ORDER_ROUTES.myOrders, {
      session: w.resident,
      body: {
        productId: w.productId,
        quantity: 1,
        couponId: secondFixture.couponId,
        idempotencyKey: randomUUID(),
      },
    })
    assert.equal(fromVoided.status, 409, 'a voided (reversed reward) coupon must not be reused')
  } finally {
    w.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 5. Legacy manual paths remain untouched                                   */
/* -------------------------------------------------------------------------- */

test('the legacy manual verification path is unchanged and never claims online payment', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    const processing = await api(w.app, 'PATCH', `/admin/local-orders/${order.id}/status`, {
      session: w.admin,
      origin: ADMIN_ORIGIN,
      body: { expectedUpdatedAt: order.updatedAt, status: 'processing' },
    })
    assert.equal(processing.status, 200)
    const processingDetail = localOrderDetailSchema.parse(await processing.json())
    const pending = await api(w.app, 'PATCH', `/admin/local-orders/${order.id}/status`, {
      session: w.admin,
      origin: ADMIN_ORIGIN,
      body: { expectedUpdatedAt: processingDetail.updatedAt, status: 'pending_review' },
    })
    assert.equal(pending.status, 200)
    const pendingDetail = localOrderDetailSchema.parse(await pending.json())

    const verified = await api(w.app, `POST`, `/admin/local-orders/${order.id}/verify`, {
      session: w.admin,
      origin: ADMIN_ORIGIN,
      body: { expectedUpdatedAt: pendingDetail.updatedAt, decision: 'verify', note: '已电话核实' },
    })
    assert.equal(verified.status, 200)
    const detail = localOrderDetailSchema.parse(await verified.json())
    assert.equal(detail.status, 'verified')
    assert.equal(detail.verification?.note, '已电话核实')
    assert.equal(detail.onlineCompletion, null, 'manual verification never claims an online payment')
    assert.equal(detail.onlineConflicts.length, 0)
    assert.equal(outline(w.db, order.id).length, 0)
    assert.equal(
      w.db.select().from(localOrders).where(eq(localOrders.id, order.id)).get()?.verifiedAt !== null,
      true,
    )

    // A terminal online/manual fact cannot be re-verified: the manual path keeps
    // its explicit 409 guard.
    const again = await api(w.app, `POST`, `/admin/local-orders/${order.id}/verify`, {
      session: w.admin,
      origin: ADMIN_ORIGIN,
      body: { expectedUpdatedAt: detail.updatedAt, decision: 'verify', note: '重复核验' },
    })
    assert.equal(again.status, 409)
    assert.equal(await errorCode(again), API_ERROR_CODES.orderAlreadyVerified)
  } finally {
    w.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 6. Consumer retry / recovery behaviour                                     */
/* -------------------------------------------------------------------------- */

test('an expired final claimed attempt is parked after a process crash', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    const intent = await createIntent(w, order.id)
    await confirmPaid(w, intent)
    const outbox = w.db.select().from(paymentOutbox).get()!
    const now = realNow()
    w.db.update(paymentOutbox).set({
      status: 'processing',
      attempts: PAYMENT_OUTBOX_MAX_ATTEMPTS,
      updatedAt: new Date(now.getTime() - PAYMENT_OUTBOX_LEASE_MS - 1),
    }).where(eq(paymentOutbox.id, outbox.id)).run()

    const result = runPaymentOutboxConsumer(w.db, { now, leaseMs: PAYMENT_OUTBOX_LEASE_MS })
    assert.equal(result.claimed, 0)
    assert.equal(result.failed, 1)
    const parked = w.db.select().from(paymentOutbox).get()!
    assert.equal(parked.status, 'failed')
    assert.equal(parked.attempts, PAYMENT_OUTBOX_MAX_ATTEMPTS)
    assert.ok(parked.lastError?.includes('最后一次尝试'))
    assert.equal(orderRow(w.db, order.id).status, 'registered')
    assert.equal(outline(w.db, order.id).length, 0)
  } finally {
    w.sqlite.close()
  }
})

test('a transient projection failure retries with backoff and completes after recovery', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    const intent = await createIntent(w, order.id)
    await confirmPaid(w, intent)

    // Inject a real database failure at the completion write, then let the
    // consumer run: the claim must be released with a retry, not lost.
    w.sqlite.exec(`
      CREATE TRIGGER pay05_fail_injection
      BEFORE INSERT ON local_order_online_completions
      BEGIN
        SELECT RAISE(ABORT, 'injected transient failure');
      END;
    `)
    const failedRun = runPaymentOutboxConsumer(w.db, { now: realNow(1_000) })
    assert.equal(failedRun.claimed, 1)
    assert.equal(failedRun.retried, 1)
    assert.equal(failedRun.completed, 0)
    const pendingRow = w.db.select().from(paymentOutbox).get()!
    assert.equal(pendingRow.status, 'pending')
    assert.equal(pendingRow.attempts, 1)
    assert.ok(pendingRow.lastError?.includes('injected transient failure'))
    assert.ok(
      pendingRow.availableAt.getTime() > pendingRow.updatedAt.getTime(),
      'backoff is persisted',
    )
    assert.equal(outline(w.db, order.id).length, 0)

    // Before the backoff expires nothing is claimed.
    const tooEarly = runPaymentOutboxConsumer(w.db, { now: realNow(1_000) })
    assert.equal(tooEarly.claimed, 0)

    w.sqlite.exec('DROP TRIGGER pay05_fail_injection')
    const recovered = runPaymentOutboxConsumer(w.db, {
      now: realNow(60_000),
    })
    assert.equal(recovered.claimed, 1)
    assert.equal(recovered.completed, 1)
    assert.equal(orderRow(w.db, order.id).status, 'online_completed')
    assert.equal(outline(w.db, order.id).length, 1)
    assert.equal(w.db.select().from(paymentOutbox).get()?.attempts, 2)
  } finally {
    w.sqlite.close()
  }
})

test('the internal consumer route refuses browser sessions, missing tokens and misconfiguration', async () => {
  const w = await world()
  try {
    const noToken = await consume(w, { token: '' })
    assert.equal(noToken.status, 401)
    assert.equal(await errorCode(noToken), API_ERROR_CODES.paymentInternalUnauthorized)

    const residentSession = await api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.consumeOutbox, {
      session: w.resident,
      body: {},
    })
    assert.equal(residentSession.status, 401)

    const unconfigured = createDatabase(':memory:', migrationsFolder)
    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        AUTH_DEV_ENABLED: 'true',
        PAYMENT_MOCK_ENABLED: 'true',
        PAYMENT_INTERNAL_TOKEN: undefined,
      })
      const app = createApp({ db: unconfigured.db, config, logRequests: false })
      const response = await app.request(PAYMENT_INTERNAL_ROUTES.consumeOutbox, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer whatever',
        },
        body: '{}',
      })
      assert.equal(response.status, 503)
      assert.equal(await errorCode(response), API_ERROR_CODES.paymentInternalNotConfigured)
    } finally {
      unconfigured.sqlite.close()
    }
  } finally {
    w.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 7. Migration: fresh + historical database                                 */
/* -------------------------------------------------------------------------- */

test('a historical 0033 database upgrades in place, keeps its rows and completes online', async () => {
  const temp = withTempDir('ll-pay05-upgrade-')
  const databasePath = join(temp.dir, 'upgrade.sqlite')
  const stagingFolder = join(temp.dir, 'migrations-0033')
  try {
    mkdirSync(join(stagingFolder, 'meta'), { recursive: true })
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> }
    const upTo0033 = journal.entries.slice(0, 34)
    assert.equal(upTo0033.at(-1)?.tag, '0033_payment_event_evidence_fingerprint')
    for (const entry of upTo0033) {
      copyFileSync(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(stagingFolder, `${entry.tag}.sql`),
      )
    }
    writeFileSync(
      join(stagingFolder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: upTo0033 }),
    )

    const legacy = createDatabase(databasePath, stagingFolder)
    const communityId = randomUUID()
    const productId = randomUUID()
    const userId = randomUUID()
    const orderId = randomUUID()
    const oldEventId = randomUUID()
    try {
      legacy.db.insert(communities).values({
        id: communityId,
        name: '升级前片区',
        createdAt: OBSERVED_AT,
      }).run()
      legacy.db.insert(localProducts).values({
        id: productId,
        communityId,
        name: '升级前商品',
        unitPriceCents: 2600,
        status: 'on_shelf',
        createdAt: OBSERVED_AT,
        updatedAt: OBSERVED_AT,
      }).run()
      legacy.db.insert(users).values({
        id: userId,
        displayName: '升级前居民',
        createdAt: OBSERVED_AT,
        updatedAt: OBSERVED_AT,
      }).run()
      legacy.db.insert(localOrders).values({
        id: orderId,
        communityId,
        productId,
        residentUserId: userId,
        idempotencyKey: `legacy-${orderId}`,
        status: 'registered',
        recordSource: 'resident',
        productName: '升级前商品',
        unitPriceCents: 2600,
        quantity: 1,
        totalCents: 2600,
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
        createdAt: OBSERVED_AT,
        updatedAt: OBSERVED_AT,
      }).run()
      legacy.db.insert(localOrderEvents).values({
        id: oldEventId,
        orderId,
        actorUserId: userId,
        actorStaffId: null,
        event: 'order.registered',
        fromStatus: null,
        toStatus: 'registered',
        note: '历史登记',
        sourceType: 'local_order',
        sourceId: orderId,
        createdAt: OBSERVED_AT,
      }).run()
      // A real pending payment intent + trusted confirmation written by PAY-02/03.
      const cfg = loadConfig({
        NODE_ENV: 'test',
        AUTH_DEV_ENABLED: 'true',
        PAYMENT_MOCK_ENABLED: 'true',
        PAYMENT_INTERNAL_TOKEN: SUBSCRIBER_TOKEN,
      })
      const intent = createPaymentIntent(
        legacy.db,
        cfg,
        { userId, staffId: null, role: null },
        { localOrderId: orderId, channel: 'mock', idempotencyKey: `legacy-intent-${orderId}` },
        { now: OBSERVED_AT },
      ).intent
      confirmTrustedPayment(legacy.db, paidEvidence(intent), { now: OBSERVED_AT })
      assert.equal(legacy.db.select().from(paymentOutbox).all()[0]?.status, 'pending')
    } finally {
      legacy.sqlite.close()
    }

    const upgraded = createDatabase(databasePath, migrationsFolder)
    try {
      // Every historical row survives the local_orders / local_order_events rebuild.
      assert.equal(upgraded.db.select().from(localOrders).all().length, 1)
      assert.equal(upgraded.db.select().from(localOrderEvents).all().length, 1)
      assert.equal(upgraded.db.select().from(paymentIntents).all().length, 1)
      assert.equal(upgraded.db.select().from(localOrderEvents).get()?.note, '历史登记')
      assert.equal(
        upgraded.sqlite.prepare('PRAGMA foreign_key_check').all().length,
        0,
        'the rebuilt parent tables keep every foreign key valid',
      )
      // New tables exist and the extended event vocabulary is accepted.
      const tables = upgraded.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name)
      assert.ok(tables.includes('local_order_online_completions'))
      assert.ok(tables.includes('local_order_online_conflicts'))
      const triggers = upgraded.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('local_orders','local_order_events')")
        .all()
        .map((row) => (row as { name: string }).name)
      for (const trigger of [
        'local_orders_coupon_insert_check',
        'local_orders_coupon_immutable',
        'local_orders_attribution_immutable',
        'local_orders_source_team_check',
        'local_orders_online_completion_fact_check',
        'local_orders_online_completed_terminal',
        'local_order_events_no_update',
        'local_order_events_no_delete',
      ]) {
        assert.ok(triggers.includes(trigger), `${trigger} must survive the rebuild`)
      }

      // And the pre-existing trusted payment completes through the new consumer.
      const result = runPaymentOutboxConsumer(upgraded.db, { now: OBSERVED_AT })
      assert.equal(result.completed, 1)
      const row = upgraded.db.select().from(localOrders)
        .where(eq(localOrders.id, orderId)).get()!
      assert.equal(row.status, 'online_completed')
      assert.equal(row.verifiedAt, null)
      assert.equal(
        upgraded.db.select().from(localOrderEvents)
          .where(eq(localOrderEvents.orderId, orderId)).all().length,
        2,
        'the historical event is preserved and one completion event is appended',
      )
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    temp.cleanup()
  }
})

test('the extended status and event constraints reject unknown values', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    assert.throws(
      () => w.db.update(localOrders).set({ status: 'refunded' as never })
        .where(eq(localOrders.id, order.id)).run(),
      /CHECK constraint failed|constraint failed/iu,
    )
    assert.throws(
      () => w.db.insert(localOrderEvents).values({
        id: randomUUID(),
        orderId: order.id,
        actorUserId: null,
        actorStaffId: null,
        event: 'order.refunded' as never,
        fromStatus: null,
        toStatus: null,
        note: null,
        sourceType: 'local_order',
        sourceId: order.id,
        createdAt: OBSERVED_AT,
      }).run(),
      /CHECK constraint failed|constraint failed/iu,
    )
    // The completion fact cannot be rewritten or deleted.
    const intent = await createIntent(w, order.id)
    await confirmPaid(w, intent)
    await consumeOk(w)
    const completion = outline(w.db, order.id)[0]!
    assert.throws(
      () => w.db.update(localOrderOnlineCompletions).set({ amountCents: 1 })
        .where(eq(localOrderOnlineCompletions.id, completion.id)).run(),
      /immutable/iu,
    )
    assert.throws(
      () => w.db.delete(localOrderOnlineCompletions)
        .where(eq(localOrderOnlineCompletions.id, completion.id)).run(),
      /immutable/iu,
    )
    // online_completed is terminal: even a direct status write is refused.
    assert.throws(
      () => w.db.update(localOrders).set({ status: 'cancelled' })
        .where(eq(localOrders.id, order.id)).run(),
      /terminal/iu,
    )
  } finally {
    w.sqlite.close()
  }
})
