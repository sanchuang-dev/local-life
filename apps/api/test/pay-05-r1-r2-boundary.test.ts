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
  paymentFailedOutboxListResponseSchema,
  paymentIntentCreateResponseSchema,
  paymentOutboxRecoveryResponseSchema,
  type LocalOrderDetail,
  type LocalOrderVerifyRequest,
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
  communities,
  couponIssueEvents,
  couponIssues,
  couponTeamGrants,
  ledgerEntries,
  ledgerPaymentOrderLinks,
  localOrderEvents,
  localOrderOnlineCompletions,
  localOrderOnlineConflicts,
  localOrders,
  localProducts,
  paymentAttempts,
  paymentIntents,
  paymentOutbox,
  paymentReviewExceptions,
  staffAccounts,
  staffCommunityAssignments,
  users,
} from '../src/db/schema.js'
import { seedConfirmedCommunity } from './resident-community-fixtures.js'
import { readLocalOrderDetail } from '../src/local/orders.js'
import type { LocalActor } from '../src/local/shared.js'
import { recordPayment, type RecordPaymentRequest } from '../src/ledger/service.js'
import { confirmTrustedPayment } from '../src/payments/confirmation.js'
import {
  listFailedPaymentOutboxEvents,
  recoverParkedPaymentOutboxEvent,
  runPaymentOutboxConsumer,
} from '../src/payments/outbox.js'
import { getMyPurchaseRewardProgress } from '../src/purchase-reward/service.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const RESIDENT_ORIGIN = 'http://localhost:5173'
const ADMIN_ORIGIN = 'http://localhost:5174'
const ADMIN_PASSWORD = 'Admin-Password-123!'
const INTERNAL_TOKEN = 'r1-r2-internal-payment-token'.padEnd(40, 'x')

type App = ReturnType<typeof createApp>

function now(): Date {
  return new Date()
}

function withTempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers (real Hono, session + CSRF + Origin)                          */
/* -------------------------------------------------------------------------- */

interface Session {
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

interface TeamFixture {
  activityId: string
  teamId: string
  /** Null when the fixture seeds the team without a pre-created grant/coupon. */
  couponId: string | null
  faceValueCents: number
}

interface World {
  app: App
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  config: ReturnType<typeof loadConfig>
  databasePath: string
  communityId: string
  productId: string
  adminUserId: string
  adminStaffId: string
  residentUserId: string
  admin: Session
  resident: Session
  team: TeamFixture | null
}

function teamCsvFixture(
  db: AppDatabase,
  input: {
    communityId: string
    residentUserId: string
    adminUserId: string
    faceValueCents: number
    at: Date
    /** When false the team starts with no grant, so completion can issue one. */
    seedGrant: boolean
  },
): TeamFixture {
  const activityId = randomUUID()
  const teamId = randomUUID()
  const ruleVersionId = randomUUID()
  const plan = {
    thresholdCents: 1000,
    couponFaceValueCents: input.faceValueCents,
    maxRewardedTeams: 10,
  }
  db.insert(activities).values({
    id: activityId,
    communityId: input.communityId,
    title: 'R2 消费团活动',
    summary: 'R2 恢复测试',
    description: 'R2 恢复后消费累计与发券',
    status: 'published',
    startsAt: new Date(input.at.getTime() - 3_600_000),
    endsAt: new Date(input.at.getTime() + 7 * 86_400_000),
    location: '测试社区',
    budgetCapCents: 100_000,
    prizeQuantityCap: 100,
    publicRulesJson: '{}',
    purchaseRewardPlanJson: JSON.stringify(plan),
    currentRuleVersionId: null,
    createdByUserId: input.adminUserId,
    createdAt: input.at,
    updatedAt: input.at,
    publishedAt: input.at,
    pausedAt: null,
    endedAt: null,
  }).run()
  db.insert(activityRuleVersions).values({
    id: ruleVersionId,
    activityId,
    version: 1,
    snapshotJson: JSON.stringify({ purchaseRewardPlan: plan }),
    createdByUserId: input.adminUserId,
    createdAt: input.at,
  }).run()
  db.update(activities).set({ currentRuleVersionId: ruleVersionId })
    .where(eq(activities.id, activityId)).run()
  db.insert(activityTeams).values({
    id: teamId,
    activityId,
    leaderUserId: input.residentUserId,
    status: 'locked',
    createdAt: input.at,
    lockedAt: input.at,
  }).run()
  const invitationId = randomUUID()
  db.insert(activityInvitations).values({
    id: invitationId,
    code: randomUUID().replace(/-/gu, ''),
    activityId,
    teamId,
    inviterUserId: input.residentUserId,
    createdAt: input.at,
  }).run()
  const memberIds = [randomUUID(), randomUUID()]
  for (const memberId of memberIds) {
    db.insert(users).values({
      id: memberId,
      displayName: 'R2 消费团成员',
      createdAt: input.at,
      updatedAt: input.at,
    }).run()
  }
  const seats = [input.residentUserId, ...memberIds]
  seats.forEach((userId, index) => {
    db.insert(activityParticipations).values({
      id: randomUUID(),
      activityId,
      teamId,
      userId,
      seatNo: index + 1,
      role: index === 0 ? 'leader' : 'member',
      inviteSource: index === 0 ? 'self' : 'invite',
      invitationId: index === 0 ? null : invitationId,
      joinedAt: new Date(input.at.getTime() - 60_000),
    }).run()
  })
  if (!input.seedGrant) {
    return { activityId, teamId, couponId: null, faceValueCents: input.faceValueCents }
  }
  const grantId = randomUUID()
  db.insert(couponTeamGrants).values({
    id: grantId,
    activityId,
    teamId,
    ruleVersionId,
    faceValueCents: input.faceValueCents,
    totalValueCents: input.faceValueCents * 3,
    grantedAt: input.at,
  }).run()
  const couponId = randomUUID()
  db.insert(couponIssues).values({
    id: couponId,
    grantId,
    activityId,
    teamId,
    userId: input.residentUserId,
    seatNo: 1,
    faceValueCents: input.faceValueCents,
    status: 'available',
    issuedAt: input.at,
    expiresAt: new Date(input.at.getTime() + 30 * 86_400_000),
    reservedOrderId: null,
    reservedAt: null,
    redeemedAt: null,
    voidedAt: null,
    updatedAt: input.at,
  }).run()
  db.insert(couponIssueEvents).values({
    id: randomUUID(),
    couponId,
    kind: 'issued',
    orderId: null,
    createdAt: input.at,
  }).run()
  return { activityId, teamId, couponId, faceValueCents: input.faceValueCents }
}

async function world(options: {
  databasePath?: string
  withTeam?: boolean
  couponDiscountCents?: number
  seedTeamCoupon?: boolean
  priceCents?: number
} = {}): Promise<World> {
  const databasePath = options.databasePath ?? ':memory:'
  const cfg = loadConfig({
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
    PAYMENT_MOCK_ENABLED: 'true',
    PAYMENT_INTERNAL_TOKEN: INTERNAL_TOKEN,
    DATABASE_PATH: databasePath,
  })
  const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
  const app = createApp({ db, config: cfg, logRequests: false })
  const at = now()
  const adminUserId = randomUUID()
  const adminStaffId = randomUUID()
  db.insert(users).values({
    id: adminUserId,
    displayName: 'R1R2 管理员',
    createdAt: at,
    updatedAt: at,
  }).run()
  db.insert(staffAccounts).values({
    id: adminStaffId,
    userId: adminUserId,
    username: 'admin',
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    status: 'active',
    createdAt: at,
    updatedAt: at,
  }).run()
  const communityId = randomUUID()
  db.insert(communities).values({ id: communityId, name: 'R1R2 片区', createdAt: at }).run()
  db.insert(staffCommunityAssignments).values({
    staffAccountId: adminStaffId,
    communityId,
    assignmentKind: 'operator_scope',
    createdAt: at,
  }).run()
  const productId = randomUUID()
  db.insert(localProducts).values({
    id: productId,
    communityId,
    name: 'R1R2 商品',
    unitPriceCents: options.priceCents ?? 3980,
    status: 'on_shelf',
    createdAt: at,
    updatedAt: at,
  }).run()
  const admin = await loginStaff(app)
  const resident = await loginResident(app, 'R1R2 居民')
  seedConfirmedCommunity(db, resident.userId, communityId, at)
  const team = options.withTeam
    ? teamCsvFixture(db, {
        communityId,
        residentUserId: resident.userId,
        adminUserId,
        faceValueCents: options.couponDiscountCents ?? 500,
        at,
        seedGrant: options.seedTeamCoupon ?? true,
      })
    : null
  return {
    app,
    db,
    sqlite,
    config: cfg,
    databasePath,
    communityId,
    productId,
    adminUserId,
    adminStaffId,
    residentUserId: resident.userId,
    admin,
    resident,
    team,
  }
}

function adminActor(w: World): LocalActor {
  return { userId: w.adminUserId, staffId: w.adminStaffId, role: 'admin' }
}

function residentActor(w: World): LocalActor {
  return { userId: w.residentUserId, staffId: null, role: null }
}

/* ------------------------------ Order flow -------------------------------- */

async function registerOrder(
  w: World,
  input: { couponId?: string; sourceActivityId?: string; sourceTeamId?: string } = {},
): Promise<LocalOrderDetail> {
  const response = await api(w.app, 'POST', LOCAL_ORDER_ROUTES.myOrders, {
    session: w.resident,
    body: {
      productId: w.productId,
      quantity: 1,
      idempotencyKey: randomUUID(),
      ...input,
    },
  })
  const text = await response.text()
  assert.equal(response.status, 201, `order registration must succeed: ${text}`)
  const body = JSON.parse(text) as { created: boolean; order: unknown }
  return localOrderDetailSchema.parse(body.order)
}

async function toPendingReview(w: World, order: LocalOrderDetail): Promise<LocalOrderDetail> {
  let detail = order
  for (const status of ['processing', 'pending_review'] as const) {
    const response = await api(w.app, 'PATCH', `/admin/local-orders/${detail.id}/status`, {
      session: w.admin,
      origin: ADMIN_ORIGIN,
      body: { expectedUpdatedAt: detail.updatedAt, status },
    })
    const text = await response.text()
    assert.equal(response.status, 200, `order -> ${status} must succeed: ${text}`)
    detail = localOrderDetailSchema.parse(JSON.parse(text))
  }
  return detail
}

async function createIntent(w: World, orderId: string): Promise<PaymentIntent> {
  const response = await api(w.app, 'POST', PAYMENT_ROUTES.createIntent, {
    session: w.resident,
    body: { localOrderId: orderId, channel: 'mock', idempotencyKey: `intent-${randomUUID()}` },
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

/** A trusted pending/closed/failed observation for the same intent. */
function statusEvidence(
  intent: PaymentIntent,
  providerStatus: 'pending' | 'closed' | 'failed',
): PaymentEvidence {
  return paidEvidence(intent, {
    providerStatus,
    providerTransactionId: providerStatus === 'pending' ? null : `MOCK-TXN-${randomUUID()}`,
    failureCode: providerStatus === 'failed' ? 'USER_FAILED' : null,
    failureMessage: providerStatus === 'failed' ? '用户支付失败' : null,
  })
}

async function confirmEvidence(w: World, evidence: PaymentEvidence): Promise<Response> {
  return api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.confirm, {
    body: evidence,
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
  })
}

async function consume(w: World, options: { token?: string; limit?: number } = {}) {
  return api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.consumeOutbox, {
    body: options.limit === undefined ? {} : { limit: options.limit },
    headers: { authorization: `Bearer ${options.token ?? INTERNAL_TOKEN}` },
  })
}

async function verifyOrderHttp(
  w: World,
  order: LocalOrderDetail,
  options: { decision?: 'verify' | 'reject'; expectedUpdatedAt?: string } = {},
) {
  const body: LocalOrderVerifyRequest = {
    expectedUpdatedAt: options.expectedUpdatedAt ?? order.updatedAt,
    decision: options.decision ?? 'verify',
    note: 'R1 边界测试核验',
  }
  return api(w.app, 'POST', `/admin/local-orders/${order.id}/verify`, {
    session: w.admin,
    origin: ADMIN_ORIGIN,
    body,
  })
}

function recordPaymentBody(w: World, order: LocalOrderDetail, evidenceRef: string): RecordPaymentRequest {
  return {
    communityId: w.communityId,
    orderId: order.id,
    amountCents: order.snapshot.totalCents - order.snapshot.couponDiscountCents,
    evidenceRef,
    evidenceKind: 'manual_receipt',
    receivedAt: now().toISOString(),
    staffId: w.adminStaffId,
  }
}

function orderRow(w: World, orderId: string) {
  const row = w.db.select().from(localOrders).where(eq(localOrders.id, orderId)).get()
  assert.ok(row, 'order row must exist')
  return row
}

function intentsOf(w: World, orderId: string) {
  return w.db.select().from(paymentIntents)
    .where(eq(paymentIntents.localOrderId, orderId)).all()
}

function completionsOf(w: World, orderId: string) {
  return w.db.select().from(localOrderOnlineCompletions)
    .where(eq(localOrderOnlineCompletions.localOrderId, orderId)).all()
}

function conflictsOf(w: World, orderId: string) {
  return w.db.select().from(localOrderOnlineConflicts)
    .where(eq(localOrderOnlineConflicts.localOrderId, orderId)).all()
}

function manualReceipts(w: World) {
  return w.db.select().from(ledgerEntries)
    .where(and(
      eq(ledgerEntries.factKind, 'payment_received'),
      eq(ledgerEntries.sourceSystem, 'manual'),
    ))
    .all()
}

function onlineReceipts(w: World) {
  return w.db.select().from(ledgerEntries)
    .where(and(
      eq(ledgerEntries.factKind, 'payment_received'),
      eq(ledgerEntries.sourceSystem, 'online_payment'),
    ))
    .all()
}

function orderLinks(w: World) {
  return w.db.select().from(ledgerPaymentOrderLinks).all()
}

function redeemedEvents(w: World, couponId: string) {
  return w.db.select().from(couponIssueEvents)
    .where(and(
      eq(couponIssueEvents.couponId, couponId),
      eq(couponIssueEvents.kind, 'redeemed'),
    ))
    .all()
}

/**
 * Insert a pending channel intent directly.
 *
 * After the R1 boundary this state is unreachable through PAY-02 (a verified
 * order is not payable) —it represents a row written before the repair, or by a
 * legacy adapter racing verification. Tests use it to prove the read/write guards
 * and the reverse-race projection still refuse double collection on such data.
 */
function insertPendingChannelIntent(w: World, orderId: string): PaymentIntent {
  const order = orderRow(w, orderId)
  const id = randomUUID()
  const at = now()
  const intent = {
    id,
    localOrderId: order.id,
    residentUserId: order.residentUserId,
    communityId: order.communityId,
    kind: 'channel' as const,
    channel: 'mock' as const,
    simulated: true,
    merchantOrderNo: `PAY-${id.replace(/-/gu, '').toUpperCase().slice(0, 28)}`,
    merchantAppId: null,
    merchantId: null,
    grossAmountCents: order.totalCents,
    discountCents: order.couponDiscountCents,
    netPayableCents: order.totalCents - order.couponDiscountCents,
    status: 'pending' as const,
    idempotencyKey: `legacy-intent-${id}`,
    expiresAt: new Date(at.getTime() + 15 * 60 * 1000),
    paidAt: null,
    closedAt: null,
    failedAt: null,
    failureCode: null,
    failureMessage: null,
    createdAt: at,
    updatedAt: at,
  }
  w.db.insert(paymentIntents).values(intent).run()
  const row = w.db.select().from(paymentIntents).where(eq(paymentIntents.id, id)).get()
  assert.ok(row)
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

function paidEvidenceForIntentRow(intent: PaymentIntent): PaymentEvidence {
  return paidEvidence(intent)
}

/** Spawn one tsx worker and collect its JSON output. */
async function runWorker(
  workerRelativePath: string,
  env: Record<string, string>,
): Promise<{ code: number | null; output: string; error: string; parsed: Record<string, unknown> }> {
  const workerPath = fileURLToPath(new URL(workerRelativePath, import.meta.url))
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let error = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { error += String(chunk) })
    child.on('close', (code) => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(output) as Record<string, unknown>
      } catch {
        parsed = {}
      }
      resolve({ code, output, error, parsed })
    })
  })
}

/* -------------------------------------------------------------------------- */
/* R1 —manual/online hard boundary                                           */
/* -------------------------------------------------------------------------- */

test('R1-A/B/D: verifyOrder refuses pending, confirming and paid intents and writes no manual fact', async () => {
  const w = await world()
  try {
    for (const state of ['pending', 'confirming', 'paid'] as const) {
      const order = await toPendingReview(w, await registerOrder(w))
      const intent = await createIntent(w, order.id)
      if (state === 'confirming' || state === 'paid') {
        const response = await confirmEvidence(
          w,
          state === 'confirming' ? statusEvidence(intent, 'pending') : paidEvidence(intent),
        )
        assert.equal(response.status, 200, `trusted ${state} evidence must be accepted`)
      }
      const intentRows = intentsOf(w, order.id)
      assert.equal(intentRows[0]?.status, state, `intent must be ${state}`)

      const refused = await verifyOrderHttp(w, order)
      assert.equal(refused.status, 409, `${state}: manual verification must be refused`)
      assert.equal(await errorCode(refused), API_ERROR_CODES.paymentOnlineCompletionConflict)

      const row = orderRow(w, order.id)
      assert.equal(row.status, 'pending_review', `${state}: status must not become verified`)
      assert.equal(row.verifiedAt, null)
      assert.equal(row.verifiedByUserId, null)
      assert.equal(completionsOf(w, order.id).length, 0)
      assert.equal(manualReceipts(w).length, 0)
      assert.equal(orderLinks(w).length, 0)

      if (state === 'paid') {
        // Refusing the manual write never swallows the online fact: the same order
        // still completes through the trusted channel path.
        const consumed = await consume(w)
        assert.equal(consumed.status, 200)
        assert.equal(orderRow(w, order.id).status, 'online_completed')
        assert.equal(completionsOf(w, order.id).length, 1)
        assert.equal(manualReceipts(w).length, 0)
      }
    }
  } finally {
    w.sqlite.close()
  }
})

test('R1-A: a blocked verification leaves the reserved coupon and ledger untouched', async () => {
  const w = await world({ withTeam: true, couponDiscountCents: 500 })
  try {
    const team = w.team!
    const order = await toPendingReview(w, await registerOrder(w, {
      couponId: team.couponId!,
      sourceActivityId: team.activityId,
      sourceTeamId: team.teamId,
    }))
    await createIntent(w, order.id)

    const refused = await verifyOrderHttp(w, order)
    assert.equal(refused.status, 409)
    assert.equal(await errorCode(refused), API_ERROR_CODES.paymentOnlineCompletionConflict)

    assert.equal(orderRow(w, order.id).status, 'pending_review')
    const coupon = w.db.select().from(couponIssues).where(eq(couponIssues.id, team.couponId!)).get()!
    assert.equal(coupon.status, 'reserved')
    assert.equal(coupon.reservedOrderId, order.id)
    assert.equal(redeemedEvents(w, team.couponId!).length, 0)
    assert.equal(manualReceipts(w).length, 0)
  } finally {
    w.sqlite.close()
  }
})

test('R1-A: an open late-success exception blocks verification even when the intent is closed', async () => {
  const w = await world()
  try {
    const order = await toPendingReview(w, await registerOrder(w))
    const intent = await createIntent(w, order.id)
    const closed = await confirmEvidence(w, statusEvidence(intent, 'closed'))
    assert.equal(closed.status, 200)
    // Trusted success after the terminal close: PAY-03 preserves it as an open
    // exception instead of rewinding the intent.
    const late = await confirmEvidence(w, paidEvidence(intent))
    assert.equal(late.status, 409)
    const lateExceptions = w.db.select().from(paymentReviewExceptions).all()
    assert.equal(lateExceptions.length, 1)
    assert.equal(lateExceptions[0]?.kind, 'late_success_after_closed')
    assert.equal(lateExceptions[0]?.status, 'open')

    const refused = await verifyOrderHttp(w, order)
    assert.equal(refused.status, 409)
    assert.equal(await errorCode(refused), API_ERROR_CODES.paymentOnlineCompletionConflict)
    assert.equal(orderRow(w, order.id).status, 'pending_review')
    assert.equal(orderRow(w, order.id).verifiedAt, null)
  } finally {
    w.sqlite.close()
  }
})

test('R1-E: closed/failed intents keep the legacy manual verification and receipt paths working', async () => {
  const w = await world()
  try {
    // No intent at all: the ordinary manual path.
    const plain = await toPendingReview(w, await registerOrder(w))
    const verified = await verifyOrderHttp(w, plain)
    const verifiedText = await verified.text()
    assert.equal(verified.status, 200, verifiedText)
    const verifiedDetail = localOrderDetailSchema.parse(JSON.parse(verifiedText))
    assert.equal(verifiedDetail.status, 'verified')
    assert.equal(verifiedDetail.onlineCompletion, null)

    const receipt = await api(w.app, 'POST', '/admin/ledger/payments', {
      session: w.admin,
      origin: ADMIN_ORIGIN,
      body: recordPaymentBody(w, verifiedDetail, `R1E-PLAIN-${randomUUID()}`),
    })
    assert.equal(receipt.status, 201, await receipt.clone().text())
    assert.equal(orderLinks(w).length, 1)
    assert.equal(manualReceipts(w).length, 1)

    // A trusted closed intent is a proven unpaid terminal state: manual path stays.
    const closedOrder = await toPendingReview(w, await registerOrder(w))
    const closedIntent = await createIntent(w, closedOrder.id)
    assert.equal((await confirmEvidence(w, statusEvidence(closedIntent, 'closed'))).status, 200)
    const closedVerified = await verifyOrderHttp(w, closedOrder)
    const closedText = await closedVerified.text()
    assert.equal(closedVerified.status, 200, closedText)
    const closedDetail = localOrderDetailSchema.parse(JSON.parse(closedText))
    const closedReceipt = await api(w.app, 'POST', '/admin/ledger/payments', {
      session: w.admin,
      origin: ADMIN_ORIGIN,
      body: recordPaymentBody(w, closedDetail, `R1E-CLOSED-${randomUUID()}`),
    })
    assert.equal(closedReceipt.status, 201, await closedReceipt.clone().text())
    assert.equal(orderLinks(w).length, 2)
    assert.equal(manualReceipts(w).length, 2)

    // A trusted failed intent is equally terminal-unpaid.
    const failedOrder = await toPendingReview(w, await registerOrder(w))
    const failedIntent = await createIntent(w, failedOrder.id)
    assert.equal((await confirmEvidence(w, statusEvidence(failedIntent, 'failed'))).status, 200)
    const failedVerified = await verifyOrderHttp(w, failedOrder)
    assert.equal(failedVerified.status, 200, await failedVerified.clone().text())
    assert.equal(orderRow(w, failedOrder.id).status, 'verified')
  } finally {
    w.sqlite.close()
  }
})

test('R1-B: recordPayment service refuses a verified order with a live or paid intent', async () => {
  const w = await world()
  try {
    const order = await toPendingReview(w, await registerOrder(w))
    const verified = await verifyOrderHttp(w, order)
    assert.equal(verified.status, 200)
    const detail = localOrderDetailSchema.parse(await verified.json())

    // A pending intent that appeared after the manual fact.
    const pendingIntent = insertPendingChannelIntent(w, order.id)
    assert.equal(pendingIntent.status, 'pending')
    assert.throws(
      () => recordPayment(
        w.db,
        adminActor(w),
        recordPaymentBody(w, detail, `R1B-PENDING-${randomUUID()}`),
        { now: now() },
      ),
      (error: unknown) => {
        const err = error as { status?: number; code?: string }
        assert.equal(err.status, 409)
        assert.equal(err.code, API_ERROR_CODES.paymentOnlineCompletionConflict)
        return true
      },
    )
    assert.equal(manualReceipts(w).length, 0)
    assert.equal(orderLinks(w).length, 0)

    // The same guard holds for a paid intent (trusted money exists).
    const paidIntent = insertPendingChannelIntent(w, order.id)
    const confirmed = confirmTrustedPayment(w.db, paidEvidenceForIntentRow(paidIntent), { now: now() })
    assert.equal(confirmed.outcome, 'confirmed')
    assert.throws(
      () => recordPayment(
        w.db,
        adminActor(w),
        recordPaymentBody(w, detail, `R1B-PAID-${randomUUID()}`),
        { now: now() },
      ),
      (error: unknown) => {
        const err = error as { status?: number; code?: string }
        assert.equal(err.status, 409)
        assert.equal(err.code, API_ERROR_CODES.paymentOnlineCompletionConflict)
        return true
      },
    )
    assert.equal(manualReceipts(w).length, 0)
    assert.equal(orderLinks(w).length, 0)
  } finally {
    w.sqlite.close()
  }
})

test('R1-C: a verified+received order keeps both money facts visible and never double-collects', async () => {
  const w = await world({ withTeam: true, couponDiscountCents: 500 })
  try {
    const team = w.team!
    const order = await toPendingReview(w, await registerOrder(w, {
      couponId: team.couponId!,
      sourceActivityId: team.activityId,
      sourceTeamId: team.teamId,
    }))
    const verified = await verifyOrderHttp(w, order)
    const verifiedText = await verified.text()
    assert.equal(verified.status, 200, verifiedText)
    const detail = localOrderDetailSchema.parse(JSON.parse(verifiedText))

    const receipt = await api(w.app, 'POST', '/admin/ledger/payments', {
      session: w.admin,
      origin: ADMIN_ORIGIN,
      body: recordPaymentBody(w, detail, `R1C-MANUAL-${randomUUID()}`),
    })
    assert.equal(receipt.status, 201, await receipt.clone().text())
    assert.equal(manualReceipts(w).length, 1)
    assert.equal(orderLinks(w).length, 1)
    assert.equal(redeemedEvents(w, team.couponId!).length, 1)

    // Legacy/race shape: a channel intent for the already-verified order.
    const intent = insertPendingChannelIntent(w, order.id)
    const paid = confirmTrustedPayment(w.db, paidEvidenceForIntentRow(intent), { now: now() })
    assert.equal(paid.outcome, 'confirmed')
    const run = runPaymentOutboxConsumer(w.db, { now: now() })
    assert.equal(run.claimed, 1)
    assert.equal(run.completed, 0)
    assert.equal(run.conflicts, 1)

    // One manual fact only, no online completion/receipt/grant duplicate.
    assert.equal(orderRow(w, order.id).status, 'verified')
    assert.equal(completionsOf(w, order.id).length, 0)
    assert.equal(onlineReceipts(w).length, 0)
    assert.equal(manualReceipts(w).length, 1)
    assert.equal(orderLinks(w).length, 1)
    assert.equal(redeemedEvents(w, team.couponId!).length, 1)
    assert.equal(w.db.select().from(couponTeamGrants).all().length, 1)
    assert.equal(w.db.select().from(couponIssues).all().length, 1)

    const conflicts = conflictsOf(w, order.id)
    assert.equal(conflicts.length, 1)
    const conflict = conflicts[0]!
    assert.equal(conflict.kind, 'manual_online_double_collection')
    assert.equal(conflict.status, 'open')
    assert.equal(conflict.paymentIntentId, intent.id)
    assert.ok(conflict.paymentOutboxId)
    assert.match(conflict.detail, new RegExp(order.id))
    assert.match(conflict.detail, new RegExp(intent.id))
    assert.match(conflict.detail, /MOCK-TXN-/u)
    assert.match(conflict.detail, new RegExp(String(intent.netPayableCents)))
    assert.match(conflict.detail, /人工实收/u)

    // The owner-readable detail exposes the closed-vocabulary anomaly.
    const residentDetail = await api(w.app, 'GET', `/local-orders/${order.id}`, {
      session: w.resident,
    })
    assert.equal(residentDetail.status, 200)
    const residentBody = localOrderDetailSchema.parse(await residentDetail.json())
    assert.equal(residentBody.onlineConflicts[0]?.kind, 'manual_online_double_collection')
    assert.equal(residentBody.onlineConflicts[0]?.status, 'open')

    // And a second manual receipt is now blocked by the payment boundary.
    const secondReceipt = await api(w.app, 'POST', '/admin/ledger/payments', {
      session: w.admin,
      origin: ADMIN_ORIGIN,
      body: recordPaymentBody(w, detail, `R1C-MANUAL-2-${randomUUID()}`),
    })
    assert.equal(secondReceipt.status, 409)
    assert.equal(await errorCode(secondReceipt), API_ERROR_CODES.paymentOnlineCompletionConflict)
    assert.equal(manualReceipts(w).length, 1)
    assert.equal(orderLinks(w).length, 1)

    // A business-conflict failure is visible but is not a consumer-exhaustion
    // retry. The recovery endpoint must not churn the same double-collection
    // conflict or make it look operationally recoverable.
    const recoverBusinessConflict = await api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.recoverOutbox, {
      body: { outboxEventId: conflict.paymentOutboxId! },
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    })
    assert.equal(recoverBusinessConflict.status, 409)
    assert.equal(await errorCode(recoverBusinessConflict), API_ERROR_CODES.paymentOutboxRecoveryConflict)
    assert.equal(orderRow(w, order.id).status, 'verified')
    assert.equal(completionsOf(w, order.id).length, 0)
    assert.equal(conflictsOf(w, order.id)[0]?.status, 'open')
  } finally {
    w.sqlite.close()
  }
})

test('R1-F1: dual-process verify vs trusted online completion never yields both facts', async () => {
  const temp = withTempDir('ll-r1-r2-race-')
  const databasePath = join(temp.dir, 'race.sqlite')
  const w = await world({ databasePath })
  try {
    const order = await toPendingReview(w, await registerOrder(w))
    const [verifyResult, onlineResult] = await Promise.all([
      runWorker('./helpers/r1-verify-worker.ts', {
        R1_VERIFY_DB_PATH: databasePath,
        R1_VERIFY_ORDER_ID: order.id,
        R1_VERIFY_ACTOR: JSON.stringify(adminActor(w)),
        R1_VERIFY_BODY: JSON.stringify({
          expectedUpdatedAt: order.updatedAt,
          decision: 'verify',
          note: '双进程并发核验',
        }),
      }),
      runWorker('./helpers/r1-online-worker.ts', {
        R1_ONLINE_DB_PATH: databasePath,
        R1_ONLINE_NOW: now().toISOString(),
        R1_ONLINE_CREATE: JSON.stringify({
          localOrderId: order.id,
          channel: 'mock',
          idempotencyKey: `race-intent-${randomUUID()}`,
        }),
        R1_ONLINE_RESIDENT: w.residentUserId,
        R1_ONLINE_COMMUNITY: w.communityId,
        R1_ONLINE_ORDER_ID: order.id,
      }),
    ])
    assert.equal(onlineResult.code, 0, onlineResult.error)
    assert.equal(onlineResult.parsed.ok, true, onlineResult.output)
    assert.ok(
      verifyResult.parsed.ok === true || verifyResult.parsed.status === 409,
      `verify worker must either commit or be refused with 409: ${verifyResult.output}`,
    )

    const row = orderRow(w, order.id)
    const completions = completionsOf(w, order.id)
    assert.ok(completions.length <= 1, 'at most one online completion')
    assert.equal(orderLinks(w).length, 0, 'the race never writes a manual ledger link')
    const terminalEvents = w.db.select().from(localOrderEvents)
      .where(and(
        eq(localOrderEvents.orderId, order.id),
        eq(localOrderEvents.event, 'order.verified'),
      ))
      .all()
    const onlineEvents = w.db.select().from(localOrderEvents)
      .where(and(
        eq(localOrderEvents.orderId, order.id),
        eq(localOrderEvents.event, 'order.online_completed'),
      ))
      .all()
    assert.ok(
      (row.status === 'verified' && completions.length === 0 && terminalEvents.length === 1) ||
      (row.status === 'online_completed' && completions.length === 1 && onlineEvents.length === 1),
      `unexpected terminal state: ${row.status}`,
    )
    if (row.status === 'online_completed') {
      assert.equal(row.verifiedAt, null, 'online completion never writes verified_*')
      assert.equal(terminalEvents.length, 0)
      assert.equal(verifyResult.parsed.ok, false)
      assert.equal(
        verifyResult.parsed.code,
        API_ERROR_CODES.paymentOnlineCompletionConflict,
      )
    }
    if (row.status === 'verified') {
      assert.equal(onlineReceipts(w).length, 0)
      assert.equal(completions.length, 0)
    }
  } finally {
    w.sqlite.close()
    temp.cleanup()
  }
})

test('R1-F2: two independent manual-receipt processes yield exactly one ledger link', async () => {
  const temp = withTempDir('ll-r1-r2-manual-race-')
  const databasePath = join(temp.dir, 'manual-race.sqlite')
  const w = await world({ databasePath })
  try {
    const order = await toPendingReview(w, await registerOrder(w))
    const verified = await verifyOrderHttp(w, order)
    const text = await verified.text()
    assert.equal(verified.status, 200, text)
    const detail = localOrderDetailSchema.parse(JSON.parse(text))
    const evidence = [`R1F-MANUAL-A-${randomUUID()}`, `R1F-MANUAL-B-${randomUUID()}`]
    const results = await Promise.all(evidence.map((ref) => runWorker(
      './helpers/r1-record-payment-worker.ts',
      {
        R1_RECEIPT_DB_PATH: databasePath,
        R1_RECEIPT_ACTOR: JSON.stringify(adminActor(w)),
        R1_RECEIPT_REQUEST: JSON.stringify(recordPaymentBody(w, detail, ref)),
        R1_RECEIPT_NOW: now().toISOString(),
      },
    )))
    const ok = results.filter((result) => result.parsed.ok === true)
    const failed = results.filter((result) => result.parsed.ok === false)
    assert.equal(ok.length, 1, results.map((result) => result.output).join('\n'))
    assert.equal(failed.length, 1)
    assert.equal(failed[0]?.parsed.code, API_ERROR_CODES.conflict)
    assert.equal(orderLinks(w).length, 1)
    assert.equal(manualReceipts(w).length, 1)
  } finally {
    w.sqlite.close()
    temp.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* R2 —parked completion chain visibility and controlled recovery            */
/* -------------------------------------------------------------------------- */

const FAIL_TRIGGER = 'pay05_r1_r2_fail_injection'

function installCompletionFailure(sqlite: ReturnType<typeof createDatabase>['sqlite']) {
  sqlite.exec(`
    CREATE TRIGGER ${FAIL_TRIGGER}
    BEFORE INSERT ON local_order_online_completions
    BEGIN
      SELECT RAISE(ABORT, 'injected R2 completion failure');
    END;
  `)
}

function dropCompletionFailure(sqlite: ReturnType<typeof createDatabase>['sqlite']) {
  sqlite.exec(`DROP TRIGGER IF EXISTS ${FAIL_TRIGGER};`)
}

async function parkOrder(w: World, orderId: string) {
  installCompletionFailure(w.sqlite)
  const run = runPaymentOutboxConsumer(w.db, { now: now(), maxAttempts: 1 })
  assert.equal(run.claimed, 1)
  assert.equal(run.failed, 1)
  const outbox = w.db.select().from(paymentOutbox)
    .where(eq(paymentOutbox.paymentIntentId, intentsOf(w, orderId)[0]!.id))
    .get()
  assert.ok(outbox)
  return outbox
}

test('R2-A: exhausting the chain parks the outbox and opens a locatable order-level anomaly', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    const intent = await createIntent(w, order.id)
    const confirmed = await confirmEvidence(w, paidEvidence(intent))
    assert.equal(confirmed.status, 200)
    const outbox = await parkOrder(w, order.id)

    assert.equal(outbox.status, 'failed')
    assert.equal(outbox.attempts, 1)
    assert.match(outbox.lastError ?? '', /injected R2 completion failure/u)
    assert.equal(orderRow(w, order.id).status, 'registered')
    assert.equal(completionsOf(w, order.id).length, 0)

    const conflicts = conflictsOf(w, order.id)
    assert.equal(conflicts.length, 1)
    const conflict = conflicts[0]!
    assert.equal(conflict.kind, 'consumer_exhausted')
    assert.equal(conflict.status, 'open')
    assert.equal(conflict.paymentIntentId, intent.id)
    assert.equal(conflict.paymentOutboxId, outbox.id)
    assert.match(conflict.detail, /injected R2 completion failure/u)
    assert.match(conflict.detail, /MOCK-TXN-/u)
    assert.match(conflict.detail, new RegExp(String(intent.netPayableCents)))
    assert.match(conflict.detail, /\d{4}-\d{2}-\d{2}T/u)

    // Owner-readable order detail is a real server query chain.
    const residentDetail = await api(w.app, 'GET', `/local-orders/${order.id}`, {
      session: w.resident,
    })
    assert.equal(residentDetail.status, 200)
    const detail = localOrderDetailSchema.parse(await residentDetail.json())
    assert.equal(detail.onlineConflicts[0]?.kind, 'consumer_exhausted')
    assert.equal(detail.onlineConflicts[0]?.status, 'open')

    // Internal token-gated list exposes order/intent/amount/channel/failure reason.
    const unauthorized = await api(w.app, 'GET', PAYMENT_INTERNAL_ROUTES.failedOutbox)
    assert.equal(unauthorized.status, 401)
    const listResponse = await api(w.app, 'GET', PAYMENT_INTERNAL_ROUTES.failedOutbox, {
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    })
    assert.equal(listResponse.status, 200, await listResponse.clone().text())
    const list = paymentFailedOutboxListResponseSchema.parse(await listResponse.json())
    assert.equal(list.items.length, 1)
    const item = list.items[0]!
    assert.equal(item.outboxEventId, outbox.id)
    assert.equal(item.localOrderId, order.id)
    assert.equal(item.paymentIntentId, intent.id)
    assert.equal(item.orderStatus, 'registered')
    assert.equal(item.attempts, 1)
    assert.match(item.lastError ?? '', /injected R2 completion failure/u)
    assert.equal(item.amountCents, intent.netPayableCents)
    const paidAttempt = w.db.select().from(paymentAttempts)
      .where(and(
        eq(paymentAttempts.paymentIntentId, intent.id),
        eq(paymentAttempts.status, 'paid'),
      ))
      .get()
    assert.equal(item.providerTransactionId, paidAttempt?.providerTransactionId)
    assert.equal(item.conflicts[0]?.kind, 'consumer_exhausted')
    assert.match(item.conflicts[0]?.detail ?? '', /injected R2 completion failure/u)

    dropCompletionFailure(w.sqlite)
  } finally {
    w.sqlite.close()
  }
})

test('R2-B: the parked anomaly and outbox state survive a database restart', async () => {
  const temp = withTempDir('ll-r1-r2-restart-')
  const databasePath = join(temp.dir, 'restart.sqlite')
  const w = await world({ databasePath })
  let orderId = ''
  let intentId = ''
  let outboxId = ''
  try {
    const order = await registerOrder(w)
    orderId = order.id
    const intent = await createIntent(w, order.id)
    intentId = intent.id
    assert.equal((await confirmEvidence(w, paidEvidence(intent))).status, 200)
    outboxId = (await parkOrder(w, order.id)).id
    dropCompletionFailure(w.sqlite)
  } finally {
    w.sqlite.close()
  }

  const reopened = createDatabase(databasePath, migrationsFolder)
  try {
    const conflict = reopened.db.select().from(localOrderOnlineConflicts)
      .where(eq(localOrderOnlineConflicts.localOrderId, orderId))
      .get()
    assert.ok(conflict, 'the anomaly must survive the restart')
    assert.equal(conflict.kind, 'consumer_exhausted')
    assert.equal(conflict.status, 'open')
    assert.equal(conflict.paymentIntentId, intentId)
    assert.equal(conflict.paymentOutboxId, outboxId)
    const outbox = reopened.db.select().from(paymentOutbox)
      .where(eq(paymentOutbox.id, outboxId)).get()!
    assert.equal(outbox.status, 'failed')
    assert.match(outbox.lastError ?? '', /injected R2 completion failure/u)

    const list = listFailedPaymentOutboxEvents(reopened.db, { now: now() })
    assert.equal(list.items.length, 1)
    assert.equal(list.items[0]?.outboxEventId, outboxId)
    assert.match(list.items[0]?.lastError ?? '', /injected R2 completion failure/u)

    const detail = readLocalOrderDetail(reopened.db, orderId)
    assert.equal(detail.status, 'registered')
    assert.equal(detail.onlineConflicts[0]?.kind, 'consumer_exhausted')
    assert.equal(detail.onlineConflicts[0]?.status, 'open')
  } finally {
    reopened.sqlite.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('R2-C: token-gated recovery completes exactly once, resolves the anomaly and keeps history', async () => {
  const w = await world({ withTeam: true, couponDiscountCents: 500 })
  try {
    const team = w.team!
    const order = await registerOrder(w, {
      couponId: team.couponId!,
      sourceActivityId: team.activityId,
      sourceTeamId: team.teamId,
    })
    const intent = await createIntent(w, order.id)
    assert.equal((await confirmEvidence(w, paidEvidence(intent))).status, 200)
    const outbox = await parkOrder(w, order.id)
    dropCompletionFailure(w.sqlite)

    const conflictsBefore = conflictsOf(w, order.id)
    assert.equal(conflictsBefore.length, 1)
    const failureDetail = conflictsBefore[0]!.detail
    assert.match(failureDetail, /injected R2 completion failure/u)

    const unauthorized = await api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.recoverOutbox, {
      body: { outboxEventId: outbox.id },
    })
    assert.equal(unauthorized.status, 401, 'recovery always needs the internal token')

    const recovered = await api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.recoverOutbox, {
      body: { outboxEventId: outbox.id },
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    })
    const recoveredText = await recovered.text()
    assert.equal(recovered.status, 200, recoveredText)
    const recovery = paymentOutboxRecoveryResponseSchema.parse(JSON.parse(recoveredText))
    assert.equal(recovery.outcome, 'recovered')
    assert.equal(recovery.status, 'delivered')
    assert.equal(recovery.localOrderId, order.id)
    assert.equal(recovery.paymentIntentId, intent.id)
    assert.equal(recovery.orderStatus, 'online_completed')
    assert.equal(recovery.conflictsResolved, 1)

    // Exactly once: one completion, one coupon redemption, one online receipt and
    // one consumption contribution. The team already owned one grant (the coupon
    // this order consumed), so no second grant may appear.
    assert.equal(orderRow(w, order.id).status, 'online_completed')
    assert.equal(orderRow(w, order.id).verifiedAt, null)
    assert.equal(completionsOf(w, order.id).length, 1)
    assert.equal(redeemedEvents(w, team.couponId!).length, 1)
    assert.equal(onlineReceipts(w).length, 1)
    assert.equal(w.db.select().from(couponTeamGrants).all().length, 1)
    assert.equal(w.db.select().from(couponIssues).all().length, 1)
    const progress = getMyPurchaseRewardProgress(w.db, residentActor(w), team.activityId)
    assert.equal(
      progress.progress?.totalEffectivePaidCents,
      intent.netPayableCents,
      'the recovered completion contributes its net paid exactly once',
    )

    // The anomaly is resolved, not deleted, and the failure reason is preserved.
    const conflictsAfter = conflictsOf(w, order.id)
    assert.equal(conflictsAfter.length, 1)
    assert.equal(conflictsAfter[0]!.status, 'resolved')
    assert.ok(conflictsAfter[0]!.resolvedAt)
    assert.equal(conflictsAfter[0]!.detail, failureDetail)
    const outboxAfter = w.db.select().from(paymentOutbox).where(eq(paymentOutbox.id, outbox.id)).get()!
    assert.equal(outboxAfter.status, 'delivered')

    // Replay of the delivered event is a safe no-op.
    const replay = await api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.recoverOutbox, {
      body: { outboxEventId: outbox.id },
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    })
    assert.equal(replay.status, 200)
    const replayBody = paymentOutboxRecoveryResponseSchema.parse(await replay.json())
    assert.equal(replayBody.outcome, 'already_completed')
    assert.equal(replayBody.conflictsResolved, 0)
    assert.equal(completionsOf(w, order.id).length, 1)
    assert.equal(onlineReceipts(w).length, 1)
    assert.equal(conflictsOf(w, order.id).length, 1)

    // A later consumer cycle also cannot complete it again.
    const laterRun = runPaymentOutboxConsumer(w.db, { now: now() })
    assert.equal(laterRun.claimed, 0)
    assert.equal(laterRun.completed, 0)
    assert.equal(completionsOf(w, order.id).length, 1)
    assert.equal(onlineReceipts(w).length, 1)
    assert.equal(redeemedEvents(w, team.couponId!).length, 1)
  } finally {
    w.sqlite.close()
  }
})

test('R2-C: recovery drives exactly one consumption contribution and one reward grant', async () => {
  const w = await world({ withTeam: true, seedTeamCoupon: false, couponDiscountCents: 500 })
  try {
    const team = w.team!
    const order = await registerOrder(w, {
      sourceActivityId: team.activityId,
      sourceTeamId: team.teamId,
    })
    const intent = await createIntent(w, order.id)
    assert.equal((await confirmEvidence(w, paidEvidence(intent))).status, 200)
    const outbox = await parkOrder(w, order.id)
    dropCompletionFailure(w.sqlite)

    const recovered = await api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.recoverOutbox, {
      body: { outboxEventId: outbox.id },
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    })
    assert.equal(recovered.status, 200, await recovered.clone().text())
    const recovery = paymentOutboxRecoveryResponseSchema.parse(await recovered.json())
    assert.equal(recovery.outcome, 'recovered')

    assert.equal(completionsOf(w, order.id).length, 1)
    assert.equal(onlineReceipts(w).length, 1)
    assert.equal(w.db.select().from(couponTeamGrants).all().length, 1)
    assert.equal(w.db.select().from(couponIssues).all().length, 3)
    const progress = getMyPurchaseRewardProgress(w.db, residentActor(w), team.activityId)
    assert.equal(progress.progress?.totalEffectivePaidCents, intent.netPayableCents)
    assert.equal(progress.progress?.eligible, true)

    // Replay cannot mint a second grant or a second set of coupons.
    const replay = recoverParkedPaymentOutboxEvent(w.db, outbox.id, { now: now() })
    assert.equal(replay.outcome, 'already_completed')
    assert.equal(w.db.select().from(couponTeamGrants).all().length, 1)
    assert.equal(w.db.select().from(couponIssues).all().length, 3)
  } finally {
    w.sqlite.close()
  }
})

test('R2-C2: normal consumer delivery resolves a stale consumer-exhausted anomaly', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    const intent = await createIntent(w, order.id)
    assert.equal((await confirmEvidence(w, paidEvidence(intent))).status, 200)
    const outbox = await parkOrder(w, order.id)
    dropCompletionFailure(w.sqlite)

    // Simulate the handoff window after failed -> pending recovery, where the
    // ordinary scheduler wins the claim before the recovery caller.
    w.db.update(paymentOutbox).set({
      status: 'pending',
      attempts: 0,
      availableAt: now(),
      updatedAt: now(),
    }).where(eq(paymentOutbox.id, outbox.id)).run()

    const run = runPaymentOutboxConsumer(w.db, { now: now() })
    assert.equal(run.completed, 1)
    assert.equal(orderRow(w, order.id).status, 'online_completed')
    assert.equal(completionsOf(w, order.id).length, 1)
    const conflict = conflictsOf(w, order.id).find((item) => item.kind === 'consumer_exhausted')
    assert.ok(conflict)
    assert.equal(conflict.status, 'resolved')
    assert.ok(conflict.resolvedAt)
  } finally {
    w.sqlite.close()
  }
})

test('R2-D/E/F: concurrent recovery processes are exactly-once and never duplicate conflicts', async () => {
  const temp = withTempDir('ll-r1-r2-recover-race-')
  const databasePath = join(temp.dir, 'recover-race.sqlite')
  const w = await world({ databasePath })
  try {
    const order = await registerOrder(w)
    const intent = await createIntent(w, order.id)
    assert.equal((await confirmEvidence(w, paidEvidence(intent))).status, 200)
    const outbox = await parkOrder(w, order.id)
    dropCompletionFailure(w.sqlite)

    const recoverEnv = {
      R2_RECOVER_DB_PATH: databasePath,
      R2_RECOVER_OUTBOX_ID: outbox.id,
      R2_RECOVER_NOW: now().toISOString(),
    }
    const results = await Promise.all([
      runWorker('./helpers/r2-recover-worker.ts', recoverEnv),
      runWorker('./helpers/r2-recover-worker.ts', recoverEnv),
    ])
    const outcomes: string[] = []
    let conflicts = 0
    for (const result of results) {
      if (result.parsed.ok === true) {
        const recovery = paymentOutboxRecoveryResponseSchema.parse(result.parsed.result)
        outcomes.push(recovery.outcome)
        continue
      }
      // The losing process observes the winner's state instead of replaying too.
      assert.equal(result.parsed.status, 409, result.output)
      assert.equal(result.parsed.code, API_ERROR_CODES.paymentOutboxRecoveryConflict)
      conflicts += 1
    }
    assert.equal(outcomes.length + conflicts, 2)
    assert.ok(
      outcomes.includes('recovered') || outcomes.includes('already_completed'),
      `one process must complete the replay: ${outcomes.join(',')}`,
    )
    assert.ok(
      outcomes.filter((outcome) => outcome === 'recovered').length <= 1,
      'at most one process reports the replay it performed',
    )
    assert.ok(conflicts <= 1)

    assert.equal(orderRow(w, order.id).status, 'online_completed')
    assert.equal(completionsOf(w, order.id).length, 1)
    assert.equal(onlineReceipts(w).length, 1)
    assert.equal(conflictsOf(w, order.id).length, 1)
    assert.equal(conflictsOf(w, order.id)[0]!.status, 'resolved')
    const outboxAfter = w.db.select().from(paymentOutbox).where(eq(paymentOutbox.id, outbox.id)).get()!
    assert.equal(outboxAfter.status, 'delivered')

    // Replaying a completed event through the service layer is also a no-op.
    const replay = recoverParkedPaymentOutboxEvent(w.db, outbox.id, { now: now() })
    assert.equal(replay.outcome, 'already_completed')
    assert.equal(replay.conflictsResolved, 0)
    assert.equal(completionsOf(w, order.id).length, 1)
    assert.equal(conflictsOf(w, order.id).length, 1)
  } finally {
    w.sqlite.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('R2: recovery only accepts parked rows and reports unknown events as 404', async () => {
  const w = await world()
  try {
    const order = await registerOrder(w)
    const intent = await createIntent(w, order.id)
    assert.equal((await confirmEvidence(w, paidEvidence(intent))).status, 200)
    // Still pending: the scheduled consumer owns it, recovery must not race it.
    const pendingRecovery = await api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.recoverOutbox, {
      body: { outboxEventId: w.db.select().from(paymentOutbox).get()!.id },
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    })
    assert.equal(pendingRecovery.status, 409)
    assert.equal(await errorCode(pendingRecovery), API_ERROR_CODES.paymentOutboxRecoveryConflict)

    const missing = await api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.recoverOutbox, {
      body: { outboxEventId: randomUUID() },
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    })
    assert.equal(missing.status, 404)

    const invalid = await api(w.app, 'POST', PAYMENT_INTERNAL_ROUTES.recoverOutbox, {
      body: { outboxEventId: 'not-a-uuid' },
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    })
    assert.equal(invalid.status, 400)
  } finally {
    w.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Migration: 0036 -> 0037 in place                                            */
/* -------------------------------------------------------------------------- */

test('0037 upgrades a populated 0036 database in place and a second start is a no-op', () => {
  const temp = withTempDir('ll-r1-r2-migrate-')
  const databasePath = join(temp.dir, 'upgrade.sqlite')
  const stagingFolder = join(temp.dir, 'migrations-0036')
  try {
    mkdirSync(join(stagingFolder, 'meta'), { recursive: true })
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> }
    const upTo0036 = journal.entries.slice(0, 37)
    assert.equal(upTo0036.at(-1)?.tag, '0036_online_ledger_projection')
    for (const entry of upTo0036) {
      copyFileSync(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(stagingFolder, `${entry.tag}.sql`),
      )
    }
    writeFileSync(
      join(stagingFolder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: upTo0036 }),
    )

    const legacy = createDatabase(databasePath, stagingFolder)
    const at = now()
    const communityId = randomUUID()
    const productId = randomUUID()
    const userId = randomUUID()
    const orderId = randomUUID()
    const conflictId = randomUUID()
    try {
      legacy.db.insert(communities).values({ id: communityId, name: '0036 片区', createdAt: at }).run()
      legacy.db.insert(users).values({
        id: userId,
        displayName: '0036 居民',
        createdAt: at,
        updatedAt: at,
      }).run()
      legacy.db.insert(localProducts).values({
        id: productId,
        communityId,
        name: '0036 商品',
        unitPriceCents: 2680,
        status: 'on_shelf',
        createdAt: at,
        updatedAt: at,
      }).run()
      legacy.db.insert(localOrders).values({
        id: orderId,
        communityId,
        productId,
        residentUserId: userId,
        idempotencyKey: `legacy-${orderId}`,
        status: 'cancelled',
        recordSource: 'resident',
        productName: '0036 商品',
        unitPriceCents: 2680,
        quantity: 1,
        totalCents: 2680,
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
        createdAt: at,
        updatedAt: at,
      }).run()
      legacy.db.insert(localOrderOnlineConflicts).values({
        id: conflictId,
        localOrderId: orderId,
        paymentIntentId: null,
        paymentOutboxId: null,
        dedupeKey: `legacy-conflict:${conflictId}`,
        kind: 'late_success',
        detail: '0036 历史冲突',
        status: 'open',
        createdAt: at,
        resolvedAt: null,
      }).run()
    } finally {
      legacy.sqlite.close()
    }

    const upgraded = createDatabase(databasePath, migrationsFolder)
    try {
      const preserved = upgraded.db.select().from(localOrderOnlineConflicts).all()
      assert.equal(preserved.length, 1)
      assert.equal(preserved[0]?.id, conflictId)
      assert.equal(preserved[0]?.kind, 'late_success')
      assert.equal(preserved[0]?.detail, '0036 历史冲突')
      assert.equal(upgraded.sqlite.prepare('PRAGMA foreign_key_check').all().length, 0)

      // The extended vocabulary is accepted; unknown kinds still abort.
      assert.doesNotThrow(() => {
        upgraded.db.insert(localOrderOnlineConflicts).values({
          id: randomUUID(),
          localOrderId: orderId,
          paymentIntentId: null,
          paymentOutboxId: null,
          dedupeKey: `consumer-exhausted:${randomUUID()}`,
          kind: 'consumer_exhausted',
          detail: '0037 新异常',
          status: 'open',
          createdAt: at,
          resolvedAt: null,
        }).run()
      })
      assert.throws(() => {
        upgraded.db.insert(localOrderOnlineConflicts).values({
          id: randomUUID(),
          localOrderId: orderId,
          paymentIntentId: null,
          paymentOutboxId: null,
          dedupeKey: `bad:${randomUUID()}`,
          kind: 'refund' as never,
          detail: '非法 kind',
          status: 'open',
          createdAt: at,
          resolvedAt: null,
        }).run()
      }, /kind/u)
      const triggers = upgraded.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'local_order_online_conflicts'")
        .all()
        .map((row) => (row as { name: string }).name)
      assert.ok(triggers.includes('local_order_online_conflicts_no_delete'))
      assert.ok(triggers.includes('local_order_online_conflicts_immutable_evidence'))
      const indexes = upgraded.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'local_order_online_conflicts'")
        .all()
        .map((row) => (row as { name: string }).name)
      assert.ok(indexes.includes('local_order_online_conflicts_dedupe_uq'))
      assert.ok(indexes.includes('local_order_online_conflicts_order_created_idx'))
      assert.ok(indexes.includes('local_order_online_conflicts_status_created_idx'))
    } finally {
      upgraded.sqlite.close()
    }

    // A second start on the already-upgraded file is a no-op.
    const restarted = createDatabase(databasePath, migrationsFolder)
    try {
      assert.equal(restarted.db.select().from(localOrderOnlineConflicts).all().length, 2)
    } finally {
      restarted.sqlite.close()
    }
  } finally {
    temp.cleanup()
  }
})
