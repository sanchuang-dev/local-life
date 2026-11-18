import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { and, eq } from 'drizzle-orm'
import test from 'node:test'
import {
  LOCAL_ORDER_ROUTES,
  PAYMENT_INTERNAL_ROUTES,
  PAYMENT_ROUTES,
  adminLocalOrderDetailSchema,
  localOrderDetailSchema,
  localOrderListResponseSchema,
  paymentIntentCreateResponseSchema,
  type AdminLocalOrderDetail,
  type LocalOrderDetail,
  type LocalOrderListResponse,
  type PaymentEvidence,
  type PaymentIntent,
} from '@sanchuang-dev/local-life-contracts'
import { hashPassword } from '../src/auth/security.js'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activities,
  activityParticipations,
  activityRuleVersions,
  activityTeams,
  communities,
  couponIssues,
  couponTeamGrants,
  ledgerEntries,
  ledgerPaymentOrderLinks,
  localOrderOnlineCompletions,
  localOrderOnlineConflicts,
  localOrders,
  localProducts,
  paymentIntents,
  paymentReviewExceptions,
  staffAccounts,
  staffCommunityAssignments,
  users,
} from '../src/db/schema.js'
import { recordPayment } from '../src/ledger/service.js'
import { seedConfirmedCommunity } from './resident-community-fixtures.js'

/**
 * PAY-08 (#283) — back-office payment read path.
 *
 * Real Hono + real SQLite (migrations applied through `createDatabase`). The
 * fixture drives the *existing* writer paths where possible:
 * - PAY-02 creates the Mock intent, PAY-03's internal token endpoint confirms it,
 *   and PAY-05's outbox consumer completes the order / records the conflicts;
 * - manual orders go through the existing verification endpoint and the ledger
 *   `recordPayment` receipt.
 * A `consumer_exhausted` conflict and a real `wechat_jsapi` intent are inserted
 * as durable facts to exercise the read model of states whose writers live in
 * other suites (R2 fault injection and PAY-10/11), exactly as they would look in
 * SQLite. No API write route is added or faked.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ADMIN_ORIGIN = 'http://localhost:5174'
const RESIDENT_ORIGIN = 'http://localhost:5173'
const ADMIN_PASSWORD = 'Admin-Password-123!'
const OPERATOR_PASSWORD = 'Operator-Password-123!'
const GRID_PASSWORD = 'Grid-Worker-Password-123!'
const INTERNAL_TOKEN = 'pay-08-internal-payment-token'.padEnd(40, 'x')

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
  userId: string
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers (same shape as the PAY-05 suites)                             */
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

function cookieHeader(...pairs: string[]): string {
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

async function loginStaff(app: App, username: string, password: string): Promise<Session> {
  const state = await csrf(app)
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: state.cookie,
      'x-csrf-token': state.token,
      origin: ADMIN_ORIGIN,
    },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(response.status, 200, `${username} login must succeed`)
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
  origin?: string | null
  headers?: Record<string, string>
}

function api(app: App, method: string, path: string, options: ApiOptions = {}) {
  const { session, body, origin, headers: extraHeaders } = options
  const headers: Record<string, string> = { ...extraHeaders }
  if (session) headers.cookie = session.cookies
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (session && method !== 'GET') {
    headers['x-csrf-token'] = session.csrfToken
    if (origin !== null) headers.origin = origin ?? ADMIN_ORIGIN
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

function now(): Date {
  return new Date()
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000)
}

/* -------------------------------------------------------------------------- */
/* World                                                                      */
/* -------------------------------------------------------------------------- */

interface World {
  app: App
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  communityA: string
  communityB: string
  productA: string
  productB: string
  adminUserId: string
  adminStaffId: string
  admin: Session
  operator: Session
  grid: Session
  residentA: Session
  residentB: Session
}

async function insertStaff(
  db: AppDatabase,
  input: {
    username: string
    displayName: string
    password: string
    role: 'admin' | 'operator' | 'grid_worker'
  },
): Promise<{ userId: string; staffId: string }> {
  const at = now()
  const userId = randomUUID()
  const staffId = randomUUID()
  db.insert(users)
    .values({ id: userId, displayName: input.displayName, createdAt: at, updatedAt: at })
    .run()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId,
      username: input.username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      status: 'active',
      createdAt: at,
      updatedAt: at,
    })
    .run()
  return { userId, staffId }
}

async function buildWorld(): Promise<World> {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
    PAYMENT_MOCK_ENABLED: 'true',
    PAYMENT_INTERNAL_TOKEN: INTERNAL_TOKEN,
  })
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const app = createApp({ db, config, logRequests: false })
  const at = now()

  const adminStaff = await insertStaff(db, {
    username: 'pay08-admin',
    displayName: '支付管理员',
    password: ADMIN_PASSWORD,
    role: 'admin',
  })
  const operatorStaff = await insertStaff(db, {
    username: 'pay08-operator',
    displayName: '运营员甲',
    password: OPERATOR_PASSWORD,
    role: 'operator',
  })
  const gridStaff = await insertStaff(db, {
    username: 'pay08-grid',
    displayName: '网格员甲',
    password: GRID_PASSWORD,
    role: 'grid_worker',
  })

  const communityA = randomUUID()
  const communityB = randomUUID()
  db.insert(communities).values({ id: communityA, name: '幸福社区', createdAt: at }).run()
  db.insert(communities).values({ id: communityB, name: '阳光社区', createdAt: at }).run()

  // Operator: assigned A only. Grid worker: current territory A only. Both are
  // still refused by the /admin/* guard in a different way (grid 403, operator
  // cross-community 403 from the service).
  // An admin is unscoped for reads/route guards, but the ledger still requires a
  // real staff↔community assignment for the human who handles money.
  db.insert(staffCommunityAssignments)
    .values({
      staffAccountId: adminStaff.staffId,
      communityId: communityA,
      assignmentKind: 'operator_scope',
      createdAt: at,
    })
    .run()
  db.insert(staffCommunityAssignments)
    .values({
      staffAccountId: operatorStaff.staffId,
      communityId: communityA,
      assignmentKind: 'operator_scope',
      createdAt: at,
    })
    .run()
  db.insert(staffCommunityAssignments)
    .values({
      staffAccountId: gridStaff.staffId,
      communityId: communityA,
      assignmentKind: 'grid_territory',
      createdAt: at,
    })
    .run()

  const productA = randomUUID()
  const productB = randomUUID()
  db.insert(localProducts)
    .values({
      id: productA,
      communityId: communityA,
      name: '社区助农蔬菜包',
      unitPriceCents: 3980,
      status: 'on_shelf',
      createdAt: at,
      updatedAt: at,
    })
    .run()
  db.insert(localProducts)
    .values({
      id: productB,
      communityId: communityB,
      name: '阳光社区水果箱',
      unitPriceCents: 2980,
      status: 'on_shelf',
      createdAt: at,
      updatedAt: at,
    })
    .run()

  const admin = await loginStaff(app, 'pay08-admin', ADMIN_PASSWORD)
  const operator = await loginStaff(app, 'pay08-operator', OPERATOR_PASSWORD)
  const grid = await loginStaff(app, 'pay08-grid', GRID_PASSWORD)
  const residentA = await loginResident(app, '幸福社区居民')
  const residentB = await loginResident(app, '阳光社区居民')
  seedConfirmedCommunity(db, residentA.userId, communityA, at)
  seedConfirmedCommunity(db, residentB.userId, communityB, at)

  return {
    app,
    db,
    sqlite,
    communityA,
    communityB,
    productA,
    productB,
    adminUserId: adminStaff.userId,
    adminStaffId: adminStaff.staffId,
    admin,
    operator,
    grid,
    residentA,
    residentB,
  }
}

/* -------------------------------------------------------------------------- */
/* Writer-path helpers                                                        */
/* -------------------------------------------------------------------------- */

async function registerOrder(
  w: World,
  resident: Session,
  productId: string,
  options: { couponId?: string } = {},
): Promise<LocalOrderDetail> {
  const response = await api(w.app, 'POST', LOCAL_ORDER_ROUTES.myOrders, {
    session: resident,
    origin: RESIDENT_ORIGIN,
    body: {
      productId,
      quantity: 1,
      idempotencyKey: randomUUID(),
      ...(options.couponId === undefined ? {} : { couponId: options.couponId }),
    },
  })
  const text = await response.text()
  assert.equal(response.status, 201, `order registration must succeed: ${text}`)
  const body = JSON.parse(text) as { order: unknown }
  return localOrderDetailSchema.parse(body.order)
}

async function toPendingReview(w: World, order: LocalOrderDetail): Promise<LocalOrderDetail> {
  let detail = order
  for (const status of ['processing', 'pending_review'] as const) {
    const response = await api(w.app, 'PATCH', `/admin/local-orders/${detail.id}/status`, {
      session: w.admin,
      body: { expectedUpdatedAt: detail.updatedAt, status },
    })
    const text = await response.text()
    assert.equal(response.status, 200, `order -> ${status} must succeed: ${text}`)
    detail = adminLocalOrderDetailSchema.parse(JSON.parse(text))
  }
  return detail
}

async function verifyOrderViaHttp(
  w: World,
  order: LocalOrderDetail,
  note = '已电话与居民核对',
): Promise<AdminLocalOrderDetail> {
  const response = await api(w.app, 'POST', `/admin/local-orders/${order.id}/verify`, {
    session: w.admin,
    body: { expectedUpdatedAt: order.updatedAt, decision: 'verify', note },
  })
  const text = await response.text()
  assert.equal(response.status, 200, `order verification must succeed: ${text}`)
  return adminLocalOrderDetailSchema.parse(JSON.parse(text))
}

function recordManualReceipt(w: World, order: LocalOrderDetail, evidenceRef: string) {
  return recordPayment(w.db, {
    userId: w.adminUserId,
    staffId: w.adminStaffId,
    role: 'admin',
  }, {
    communityId: order.community.id,
    orderId: order.id,
    amountCents: order.snapshot.netPayableCents,
    evidenceRef,
    evidenceKind: 'bank_transfer',
    receivedAt: now().toISOString(),
    staffId: w.adminStaffId,
  })
}

async function createMockIntent(
  w: World,
  resident: Session,
  order: LocalOrderDetail,
): Promise<PaymentIntent> {
  const response = await api(w.app, 'POST', PAYMENT_ROUTES.createIntent, {
    session: resident,
    origin: RESIDENT_ORIGIN,
    body: { localOrderId: order.id, channel: 'mock', idempotencyKey: `intent-${randomUUID()}` },
  })
  const text = await response.text()
  assert.equal(response.status, 201, `intent creation must succeed: ${text}`)
  return paymentIntentCreateResponseSchema.parse(JSON.parse(text)).intent
}

function evidence(
  intent: PaymentIntent,
  providerStatus: 'paid' | 'closed' | 'failed' | 'pending',
  overrides: Partial<PaymentEvidence> = {},
): PaymentEvidence {
  return {
    merchantOrderNo: intent.merchantOrderNo,
    channel: 'mock',
    providerStatus,
    providerTransactionId: `MOCK-TXN-${randomUUID()}`,
    amountCents: intent.netPayableCents,
    currency: 'CNY',
    merchantAppId: null,
    merchantId: null,
    observedAt: now().toISOString(),
    source: 'notification',
    dedupeKey: `notify-${randomUUID()}`,
    providerEventRef: null,
    failureCode: null,
    failureMessage: null,
    ...overrides,
  }
}

async function confirmEvidence(w: World, value: PaymentEvidence): Promise<Response> {
  return api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.confirm, {
    body: value,
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
  })
}

async function consumeOutbox(w: World): Promise<Response> {
  return api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.consumeOutbox, {
    body: {},
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
  })
}

/** Direct insert of a pre-PAY-10 pending channel intent. */
function insertPendingChannelIntent(
  w: World,
  order: LocalOrderDetail,
  channel: 'mock' | 'wechat_jsapi',
): PaymentIntent {
  const at = now()
  const id = randomUUID()
  const channelPayment = channel === 'wechat_jsapi'
  w.db.insert(paymentIntents)
    .values({
      id,
      localOrderId: order.id,
      residentUserId: order.resident.id,
      communityId: order.community.id,
      kind: 'channel',
      channel,
      simulated: channel === 'mock',
      merchantOrderNo: `PAY-${id.replace(/-/gu, '').toUpperCase().slice(0, 28)}`,
      merchantAppId: channelPayment ? 'wx-pay08-appid' : null,
      merchantId: channelPayment ? 'pay08-merchant' : null,
      grossAmountCents: order.snapshot.totalCents,
      discountCents: order.snapshot.couponDiscountCents,
      netPayableCents: order.snapshot.netPayableCents,
      status: 'pending',
      idempotencyKey: `legacy-intent-${id}`,
      expiresAt: minutesAgo(-15),
      paidAt: null,
      closedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      createdAt: at,
      updatedAt: at,
    })
    .run()
  const row = w.db.select().from(paymentIntents).where(eq(paymentIntents.id, id)).get()
  assert.ok(row, 'inserted intent must exist')
  return {
    ...row,
    expiresAt: row.expiresAt.toISOString(),
    paidAt: null,
    closedAt: null,
    failedAt: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function insertConsumerExhaustedConflict(
  w: World,
  order: LocalOrderDetail,
  intentId: string,
): void {
  w.db.insert(localOrderOnlineConflicts)
    .values({
      id: randomUUID(),
      localOrderId: order.id,
      paymentIntentId: intentId,
      paymentOutboxId: null,
      dedupeKey: `consumer_exhausted:pay08-fixture:${intentId}`,
      kind: 'consumer_exhausted',
      detail: 'PAY-08 读模型夹具：完成消费重试耗尽，渠道已确认，待人工受控恢复',
      status: 'open',
      createdAt: now(),
      resolvedAt: null,
    })
    .run()
}

/**
 * Seed one available consumption coupon owned by the resident, so a fully
 * discounted order can go through the real PAY-05 zero-amount path. Only the
 * rows `readCouponForOrder` needs are written; no participation/reward is
 * fabricated.
 */
function seedZeroAmountCoupon(
  w: World,
  residentUserId: string,
  faceValueCents: number,
  at: Date,
): string {
  const activityId = randomUUID()
  const teamId = randomUUID()
  const ruleVersionId = randomUUID()
  const plan = {
    thresholdCents: 1000,
    couponFaceValueCents: faceValueCents,
    maxRewardedTeams: 10,
  }
  w.db
    .insert(activities)
    .values({
      id: activityId,
      communityId: w.communityA,
      title: 'PAY-08 零元券单活动',
      summary: '零元券单读模型夹具',
      description: '零元券单读模型夹具',
      status: 'published',
      startsAt: new Date(at.getTime() - 3_600_000),
      endsAt: new Date(at.getTime() + 7 * 86_400_000),
      location: '幸福社区',
      budgetCapCents: 100_000,
      prizeQuantityCap: 100,
      publicRulesJson: '{}',
      purchaseRewardPlanJson: JSON.stringify(plan),
      currentRuleVersionId: null,
      createdByUserId: w.adminUserId,
      createdAt: at,
      updatedAt: at,
      publishedAt: at,
      pausedAt: null,
      endedAt: null,
    })
    .run()
  w.db
    .insert(activityRuleVersions)
    .values({
      id: ruleVersionId,
      activityId,
      version: 1,
      snapshotJson: JSON.stringify({ purchaseRewardPlan: plan }),
      createdByUserId: w.adminUserId,
      createdAt: at,
    })
    .run()
  w.db
    .update(activities)
    .set({ currentRuleVersionId: ruleVersionId })
    .where(eq(activities.id, activityId))
    .run()
  w.db
    .insert(activityTeams)
    .values({
      id: teamId,
      activityId,
      leaderUserId: residentUserId,
      status: 'locked',
      createdAt: at,
      lockedAt: at,
    })
    .run()
  // The coupon-issue trigger requires the holder to really be a member of the
  // grant's team; no reward is minted beyond that one seat.
  w.db
    .insert(activityParticipations)
    .values({
      id: randomUUID(),
      activityId,
      teamId,
      userId: residentUserId,
      seatNo: 1,
      role: 'leader',
      inviteSource: 'self',
      invitationId: null,
      joinedAt: new Date(at.getTime() - 60_000),
    })
    .run()
  const grantId = randomUUID()
  w.db
    .insert(couponTeamGrants)
    .values({
      id: grantId,
      activityId,
      teamId,
      ruleVersionId,
      faceValueCents,
      totalValueCents: faceValueCents * 3,
      grantedAt: at,
    })
    .run()
  const couponId = randomUUID()
  w.db
    .insert(couponIssues)
    .values({
      id: couponId,
      grantId,
      activityId,
      teamId,
      userId: residentUserId,
      seatNo: 1,
      faceValueCents,
      status: 'available',
      issuedAt: at,
      expiresAt: new Date(at.getTime() + 30 * 86_400_000),
      reservedOrderId: null,
      reservedAt: null,
      redeemedAt: null,
      voidedAt: null,
      updatedAt: at,
    })
    .run()
  return couponId
}

/* -------------------------------------------------------------------------- */
/* Scenario                                                                   */
/* -------------------------------------------------------------------------- */

interface Scenario {
  onlineOrder: AdminLocalOrderDetail
  onlineIntent: PaymentIntent
  onlineTransactionId: string
  manualOrder: AdminLocalOrderDetail
  manualReceiptAmountCents: number
  doubleOrder: AdminLocalOrderDetail
  lateOrder: AdminLocalOrderDetail
  lateTransactionId: string
  cancelledOrder: AdminLocalOrderDetail
  exhaustedOrder: AdminLocalOrderDetail
  zeroOrder: AdminLocalOrderDetail
  communityBOrder: AdminLocalOrderDetail
  createdAt: Date
}

async function seedScenario(w: World): Promise<Scenario> {
  const createdAt = now()
  // A: trusted Mock channel payment completed online, then a terminal conflict
  // observation to prove review exceptions are surfaced.
  const onlineBase = await registerOrder(w, w.residentA, w.productA)
  const onlineIntent = await createMockIntent(w, w.residentA, onlineBase)
  const paidEvidence = evidence(onlineIntent, 'paid')
  const confirmPaid = await confirmEvidence(w, paidEvidence)
  assert.equal(confirmPaid.status, 200, `mock payment confirmation: ${await confirmPaid.text()}`)
  const consumePaid = await consumeOutbox(w)
  assert.equal(consumePaid.status, 200)
  const terminalConflict = await confirmEvidence(w, evidence(onlineIntent, 'closed'))
  assert.equal(terminalConflict.status, 409, 'a closed observation on a paid intent is a conflict')

  // B: legacy/manual order — verification + manual receipt, no payment intent.
  const manualBase = await registerOrder(w, w.residentA, w.productA)
  const manualPending = await toPendingReview(w, manualBase)
  const manualOrder = await verifyOrderViaHttp(w, manualPending)
  const manualReceipt = recordManualReceipt(w, manualOrder, 'BANK-PAY08-B0001')

  // C: manual receipt then a trusted channel success → manual/online double collection.
  const doubleBase = await registerOrder(w, w.residentA, w.productA)
  const doublePending = await toPendingReview(w, doubleBase)
  const doubleVerified = await verifyOrderViaHttp(w, doublePending)
  recordManualReceipt(w, doubleVerified, 'BANK-PAY08-C0001')
  const legacyIntent = insertPendingChannelIntent(w, doubleVerified, 'mock')
  const doubleConfirm = await confirmEvidence(w, evidence(legacyIntent, 'paid'))
  assert.equal(doubleConfirm.status, 200)
  const doubleConsume = await consumeOutbox(w)
  assert.equal(doubleConsume.status, 200)

  // D: late success after close → PAY-03 review exception.
  const lateBase = await registerOrder(w, w.residentA, w.productA)
  const lateIntent = await createMockIntent(w, w.residentA, lateBase)
  const closeResponse = await confirmEvidence(w, evidence(lateIntent, 'closed'))
  assert.equal(closeResponse.status, 200)
  const latePaidEvidence = evidence(lateIntent, 'paid')
  const lateResponse = await confirmEvidence(w, latePaidEvidence)
  assert.equal(lateResponse.status, 409, 'late success must not confirm the closed intent')

  // E: trusted paid intent whose order is cancelled before consumption.
  const cancelledBase = await registerOrder(w, w.residentA, w.productA)
  const cancelledIntent = await createMockIntent(w, w.residentA, cancelledBase)
  const cancelledConfirm = await confirmEvidence(w, evidence(cancelledIntent, 'paid'))
  assert.equal(cancelledConfirm.status, 200)
  const cancelResponse = await api(
    w.app,
    'PATCH',
    `/admin/local-orders/${cancelledBase.id}/status`,
    {
      session: w.admin,
      body: { expectedUpdatedAt: cancelledBase.updatedAt, status: 'cancelled' },
    },
  )
  assert.equal(cancelResponse.status, 200, await cancelResponse.text())
  const cancelledConsume = await consumeOutbox(w)
  assert.equal(cancelledConsume.status, 200)

  // F: parked consumer_exhausted conflict + a real (wechat_jsapi) intent, which
  // cannot yet be created through PAY-02 (PAY-10/11 own it). Both are durable
  // facts in the real tables so the read model and simulated/real filter can be
  // proven without faking an API.
  const exhaustedBase = await registerOrder(w, w.residentA, w.productA)
  const realIntent = insertPendingChannelIntent(w, exhaustedBase, 'wechat_jsapi')
  insertConsumerExhaustedConflict(w, exhaustedBase, realIntent.id)

  // G: the fully coupon-discounted zero-amount path (PAY-05): no channel, no
  // provider transaction, no online_payment ledger receipt.
  const zeroCouponId = seedZeroAmountCoupon(w, w.residentA.userId, 3980, createdAt)
  const zeroBase = await registerOrder(w, w.residentA, w.productA, {
    couponId: zeroCouponId,
  })
  assert.equal(zeroBase.snapshot.netPayableCents, 0, 'coupon must fully cover the order')
  assert.equal(zeroBase.snapshot.couponDiscountCents, 3980)
  const zeroResponse = await api(
    w.app,
    'POST',
    LOCAL_ORDER_ROUTES.myZeroAmountCompletion.replace(':localOrderId', zeroBase.id),
    { session: w.residentA, origin: RESIDENT_ORIGIN },
  )
  const zeroText = await zeroResponse.text()
  assert.equal(zeroResponse.status, 201, `zero-amount completion must succeed: ${zeroText}`)
  const zeroBody = JSON.parse(zeroText) as { created: boolean; order: unknown }
  assert.equal(zeroBody.created, true)
  assert.equal(
    localOrderDetailSchema.parse(zeroBody.order).status,
    'online_completed',
  )

  // H: another community for the operator/grid isolation negative tests.
  const communityBBase = await registerOrder(w, w.residentB, w.productB)

  const detail = async (orderId: string) => {
    const response = await api(w.app, 'GET', `/admin/local-orders/${orderId}`, {
      session: w.admin,
    })
    const text = await response.text()
    assert.equal(response.status, 200, `admin detail must succeed: ${text}`)
    return adminLocalOrderDetailSchema.parse(JSON.parse(text))
  }

  return {
    onlineOrder: await detail(onlineBase.id),
    onlineIntent,
    onlineTransactionId: paidEvidence.providerTransactionId as string,
    manualOrder: await detail(manualBase.id),
    manualReceiptAmountCents: manualReceipt.amountCents,
    doubleOrder: await detail(doubleBase.id),
    lateOrder: await detail(lateBase.id),
    lateTransactionId: latePaidEvidence.providerTransactionId as string,
    cancelledOrder: await detail(cancelledBase.id),
    exhaustedOrder: await detail(exhaustedBase.id),
    zeroOrder: await detail(zeroBase.id),
    communityBOrder: await detail(communityBBase.id),
    createdAt,
  }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

test('PAY-08 back-office payment read', async (t) => {
  const w = await buildWorld()
  const scenario = await seedScenario(w)

  async function adminList(rawQuery: Record<string, string>): Promise<LocalOrderListResponse> {
    const params = new URLSearchParams(rawQuery)
    const response = await api(
      w.app,
      'GET',
      `${LOCAL_ORDER_ROUTES.adminOrders}?${params.toString()}`,
      { session: w.admin },
    )
    const text = await response.text()
    assert.equal(response.status, 200, `admin list must succeed: ${text}`)
    return localOrderListResponseSchema.parse(JSON.parse(text))
  }

  await t.test('detail layers the frozen amounts, manual facts and online facts', async () => {
    const { onlineOrder } = scenario
    assert.equal(onlineOrder.status, 'online_completed')
    assert.equal(onlineOrder.paymentSection.amounts.grossAmountCents, 3980)
    assert.equal(onlineOrder.paymentSection.amounts.couponDiscountCents, 0)
    assert.equal(onlineOrder.paymentSection.amounts.netPayableCents, 3980)
    // Manual layer is empty: an online completion never fabricates verification.
    assert.equal(onlineOrder.paymentSection.manual.verified, false)
    assert.equal(onlineOrder.paymentSection.manual.receipts.length, 0)
    // Online layer is complete and clearly Mock.
    assert.equal(onlineOrder.paymentSection.online.intents.length, 1)
    const intent = onlineOrder.paymentSection.online.intents[0]
    assert.equal(intent.status, 'paid')
    assert.equal(intent.simulated, true)
    assert.equal(intent.channel, 'mock')
    assert.equal(intent.attempts.length, 1)
    assert.equal(intent.attempts[0].status, 'paid')
    assert.equal(intent.events.length > 0, true)
    assert.equal(onlineOrder.paymentSection.online.completion?.kind, 'channel')
    assert.equal(onlineOrder.paymentSection.online.completion?.amountCents, 3980)
    assert.equal(onlineOrder.paymentSection.online.ledgerReceipts.length, 1)
    assert.equal(onlineOrder.paymentSection.online.ledgerReceipts[0].sourceSystem, 'online_payment')
    assert.equal(onlineOrder.paymentSection.online.ledgerReceipts[0].simulated, true)
  })

  await t.test('Mock money stays out of the real online receipt total', async () => {
    const totals = scenario.onlineOrder.paymentSection.receiptTotals
    assert.equal(totals.onlineRealReceivedCents, 0)
    assert.equal(totals.onlineSimulatedReceivedCents, 3980)
    assert.equal(scenario.onlineOrder.paymentSection.bankSettlement.status, 'unverified')
  })

  await t.test('raw channel references and merchant credentials never leave the server', async () => {
    const response = await api(
      w.app,
      'GET',
      `/admin/local-orders/${scenario.onlineOrder.id}`,
      { session: w.admin },
    )
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.equal(text.includes(scenario.onlineTransactionId), false)
    assert.equal(text.includes('wx-pay08-appid'), false)
    assert.equal(text.includes('pay08-merchant'), false)
    assert.match(
      scenario.onlineOrder.paymentSection.online.completion?.providerTransactionIdMasked ?? '',
      /^\*{4}/u,
    )
    assert.equal(text.includes('已到账'), false)
    assert.equal(text.includes('已结算'), false)
  })

  await t.test('a legacy manual order shows verification and its receipt, not a fake online state', async () => {
    const order = scenario.manualOrder
    assert.equal(order.paymentSection.manual.verified, true)
    assert.equal(order.paymentSection.manual.verifiedBy?.displayName, '支付管理员')
    assert.equal(order.paymentSection.manual.receipts.length, 1)
    assert.equal(
      order.paymentSection.manual.receipts[0].amountCents,
      scenario.manualReceiptAmountCents,
    )
    assert.equal(order.paymentSection.manual.receipts[0].reversal, null)
    assert.equal(order.paymentSection.online.intents.length, 0)
    assert.equal(order.paymentSection.online.completion, null)
    assert.equal(order.paymentSection.receiptTotals.manualReceivedCents, 3980)
    assert.equal(order.paymentSection.bankSettlement.status, 'unverified')
  })

  await t.test('the existing exception vocabularies are surfaced read-only', async () => {
    const doubleKinds = scenario.doubleOrder.paymentSection.online.conflicts.map(
      (conflict) => conflict.kind,
    )
    assert.ok(doubleKinds.includes('manual_online_double_collection'))
    assert.equal(scenario.doubleOrder.paymentSection.online.completion, null)

    const lateKinds = scenario.lateOrder.paymentSection.online.reviewExceptions.map(
      (exception) => exception.kind,
    )
    assert.ok(lateKinds.includes('late_success_after_closed'))
    const lateException = scenario.lateOrder.paymentSection.online.reviewExceptions[0]
    assert.equal(lateException.providerTransactionIdMasked?.startsWith('****'), true)
    assert.equal(
      JSON.stringify(scenario.lateOrder).includes(scenario.lateTransactionId),
      false,
    )

    const cancelledKinds = scenario.cancelledOrder.paymentSection.online.conflicts.map(
      (conflict) => conflict.kind,
    )
    assert.ok(cancelledKinds.includes('order_not_payable'))

    const exhaustedKinds = scenario.exhaustedOrder.paymentSection.online.conflicts.map(
      (conflict) => conflict.kind,
    )
    assert.ok(exhaustedKinds.includes('consumer_exhausted'))
  })

  await t.test('terminal payment conflicts are visible without rewriting the intent', async () => {
    const kinds = scenario.onlineOrder.paymentSection.online.reviewExceptions.map(
      (exception) => exception.kind,
    )
    assert.ok(kinds.includes('terminal_conflict'))
    assert.equal(scenario.onlineOrder.paymentSection.online.intents[0].status, 'paid')
  })

  await t.test('zero-amount intent and completion never read as a channel payment', async () => {
    const order = scenario.zeroOrder
    assert.equal(order.status, 'online_completed')
    assert.equal(order.paymentSection.amounts.grossAmountCents, 3980)
    assert.equal(order.paymentSection.amounts.couponDiscountCents, 3980)
    assert.equal(order.paymentSection.amounts.netPayableCents, 0)

    const intents = order.paymentSection.online.intents
    assert.equal(intents.length, 1)
    const intent = intents[0]
    assert.equal(intent.kind, 'zero_amount')
    assert.equal(intent.channel, null)
    assert.equal(intent.simulated, false)
    assert.equal(intent.status, 'paid')
    assert.equal(intent.netPayableCents, 0)
    assert.equal(intent.attempts.length, 0)
    // A zero-amount completion has no channel notification/query evidence.
    assert.equal(
      intent.events.some(
        (event) =>
          event.eventType === 'payment.channel_notification' ||
          event.eventType === 'payment.channel_query',
      ),
      false,
    )

    const completion = order.paymentSection.online.completion
    assert.ok(completion)
    assert.equal(completion.kind, 'zero_amount')
    assert.equal(completion.amountCents, 0)
    assert.equal(completion.simulated, false)
    assert.equal(completion.providerTransactionIdMasked, null)
    assert.equal(order.paymentSection.online.ledgerReceipts.length, 0)
    assert.deepEqual(order.paymentSection.receiptTotals, {
      manualReceivedCents: 0,
      onlineRealReceivedCents: 0,
      onlineSimulatedReceivedCents: 0,
    })

    // The response must not carry channel-payment wording or a fabricated id.
    const response = await api(
      w.app,
      'GET',
      `/admin/local-orders/${order.id}`,
      { session: w.admin },
    )
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.equal(text.includes('真实渠道'), false)
    assert.equal(text.includes('渠道支付已确认'), false)
    assert.equal(text.includes('MOCK-TXN'), false)

    // The list item preserves the only legal marker (`channel: null`) the UI
    // turns into「零元券单」copy; it is neither simulated nor a real channel.
    const list = await adminList({ orderId: order.id })
    assert.equal(list.total, 1)
    assert.equal(list.items[0]?.payment?.channel, null)
    assert.equal(list.items[0]?.payment?.status, 'paid')
    assert.equal(list.items[0]?.payment?.simulated, false)
    assert.equal((await adminList({ paymentMode: 'simulated' })).total, 4)
    assert.equal((await adminList({ paymentMode: 'real' })).total, 1)
  })

  await t.test('server-side filters match only the real facts', async () => {
    const all = await adminList({})
    assert.equal(all.total, 8)
    assert.equal(all.page, 1)
    assert.equal(all.pageSize, 20)

    const pageTwo = await adminList({ page: '2', pageSize: '2' })
    assert.equal(pageTwo.total, 8)
    assert.equal(pageTwo.items.length, 2)

    const byOrderId = await adminList({ orderId: scenario.manualOrder.id })
    assert.equal(byOrderId.total, 1)
    assert.equal(byOrderId.items[0]?.id, scenario.manualOrder.id)

    const byMerchantOrderNo = await adminList({
      merchantOrderNo: scenario.onlineIntent.merchantOrderNo,
    })
    assert.equal(byMerchantOrderNo.total, 1)
    assert.equal(byMerchantOrderNo.items[0]?.id, scenario.onlineOrder.id)

    const byTransaction = await adminList({
      providerTransactionId: scenario.onlineTransactionId,
    })
    assert.equal(byTransaction.total, 1)
    assert.equal(byTransaction.items[0]?.id, scenario.onlineOrder.id)

    // F2: the late-success transaction id exists only in
    // `payment_review_exceptions` (no paid attempt/completion), and must still
    // locate its order through the server-side filter.
    const byLateTransaction = await adminList({
      providerTransactionId: scenario.lateTransactionId,
    })
    assert.equal(byLateTransaction.total, 1)
    assert.equal(byLateTransaction.items[0]?.id, scenario.lateOrder.id)

    const paid = await adminList({ paymentStatus: 'paid' })
    assert.equal(paid.total, 4)

    const simulated = await adminList({ paymentMode: 'simulated' })
    assert.equal(simulated.total, 4)

    const real = await adminList({ paymentMode: 'real' })
    assert.equal(real.total, 1)
    assert.equal(real.items[0]?.id, scenario.exhaustedOrder.id)
    assert.equal(real.items[0]?.payment?.simulated, false)

    const communityB = await adminList({ communityId: w.communityB })
    assert.equal(communityB.total, 1)
    assert.equal(communityB.items[0]?.id, scenario.communityBOrder.id)

    const future = new Date(Date.now() + 60 * 60_000).toISOString()
    const noneInFuture = await adminList({ createdFrom: future })
    assert.equal(noneInFuture.total, 0)

    const past = new Date(Date.now() - 60 * 60_000).toISOString()
    const allInWindow = await adminList({ createdFrom: past, createdTo: new Date().toISOString() })
    assert.equal(allInWindow.total, 8)
  })

  await t.test('operator scope: assigned community only, cross-community denied', async () => {
    const list = await api(w.app, 'GET', LOCAL_ORDER_ROUTES.adminOrders, {
      session: w.operator,
    })
    const listBody = localOrderListResponseSchema.parse(await list.json())
    assert.equal(list.status, 200)
    assert.equal(listBody.total, 7)
    assert.equal(listBody.items.every((item) => item.community.id === w.communityA), true)

    const crossList = await api(
      w.app,
      'GET',
      `${LOCAL_ORDER_ROUTES.adminOrders}?communityId=${w.communityB}`,
      { session: w.operator },
    )
    assert.equal(crossList.status, 403)
    assert.equal(await errorCode(crossList), 'forbidden')

    const inScope = await api(
      w.app,
      'GET',
      `/admin/local-orders/${scenario.onlineOrder.id}`,
      { session: w.operator },
    )
    assert.equal(inScope.status, 200)

    const crossDetail = await api(
      w.app,
      'GET',
      `/admin/local-orders/${scenario.communityBOrder.id}`,
      { session: w.operator },
    )
    assert.equal(crossDetail.status, 403)
    assert.equal(await errorCode(crossDetail), 'forbidden')
  })

  await t.test('grid workers are refused by the back-office payment read', async () => {
    const list = await api(w.app, 'GET', LOCAL_ORDER_ROUTES.adminOrders, { session: w.grid })
    assert.equal(list.status, 403)
    assert.equal(await errorCode(list), 'forbidden')

    const detail = await api(
      w.app,
      'GET',
      `/admin/local-orders/${scenario.onlineOrder.id}`,
      { session: w.grid },
    )
    assert.equal(detail.status, 403)
    assert.equal(await errorCode(detail), 'forbidden')
  })

  await t.test('anonymous reads answer 401', async () => {
    const list = await api(w.app, 'GET', LOCAL_ORDER_ROUTES.adminOrders)
    assert.equal(list.status, 401)
    const detail = await api(
      w.app,
      'GET',
      `/admin/local-orders/${scenario.onlineOrder.id}`,
    )
    assert.equal(detail.status, 401)
  })

  await t.test('invalid payment filters are a 400, never a silently ignored query', async () => {
    const response = await api(
      w.app,
      'GET',
      `${LOCAL_ORDER_ROUTES.adminOrders}?paymentMode=both`,
      { session: w.admin },
    )
    assert.equal(response.status, 400)
    assert.equal(await errorCode(response), 'invalid_request')
  })

  await t.test('the payment section is attached to admin write responses too', async () => {
    const base = await registerOrder(w, w.residentA, w.productA)
    const response = await api(
      w.app,
      'PATCH',
      `/admin/local-orders/${base.id}/status`,
      {
        session: w.admin,
        body: { expectedUpdatedAt: base.updatedAt, status: 'processing' },
      },
    )
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const parsed = adminLocalOrderDetailSchema.parse(JSON.parse(text))
    assert.equal(parsed.paymentSection.online.intents.length, 0)
    assert.equal(parsed.paymentSection.bankSettlement.status, 'unverified')
  })

  await t.test('no second payment/transaction table or write route was introduced', async () => {
    const tables = w.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
    const paymentTables = tables
      .map((row) => row.name)
      .filter(
        (name) =>
          name.startsWith('payment_') ||
          name.startsWith('local_order_online_') ||
          name === 'mock_payment_event_reservations',
      )
    assert.deepEqual(paymentTables, [
      'local_order_online_completions',
      'local_order_online_conflicts',
      'mock_payment_event_reservations',
      'payment_attempts',
      'payment_events',
      'payment_intents',
      'payment_outbox',
      'payment_review_exceptions',
    ])
    // The read path created nothing: the fixture counts stayed as written.
    const completed = w.db
      .select({ id: localOrderOnlineCompletions.id })
      .from(localOrderOnlineCompletions)
      .all()
    const links = w.db.select({ entryId: ledgerPaymentOrderLinks.entryId }).from(ledgerPaymentOrderLinks).all()
    const exceptions = w.db
      .select({ id: paymentReviewExceptions.id })
      .from(paymentReviewExceptions)
      .all()
    assert.equal(completed.length, 2)
    assert.equal(links.length, 2)
    // Only the channel completion projects an `online_payment` receipt; the
    // zero-amount completion must never fabricate 0-cash online money.
    const onlineReceipts = w.db
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.factKind, 'payment_received'),
          eq(ledgerEntries.sourceSystem, 'online_payment'),
        ),
      )
      .all()
    assert.equal(onlineReceipts.length, 1)
    assert.equal(exceptions.length >= 1, true)
    // `local_orders` rows are never mutated by the read path.
    assert.equal(w.db.select({ id: localOrders.id }).from(localOrders).all().length, 9)
  })
})
