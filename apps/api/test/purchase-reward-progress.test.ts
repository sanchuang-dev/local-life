import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  PURCHASE_REWARD_ROUTES,
  activityParticipationConfirmResponseSchema,
  ledgerEntrySchema,
  localOrderDetailSchema,
  localProductDetailSchema,
  purchaseRewardProgressListResponseSchema,
  purchaseRewardProgressResponseSchema,
  couponWalletResponseSchema,
  couponStockResponseSchema,
  type ActivityStatus,
  type LedgerEntry,
  type LocalOrderDetail,
  type LocalProductDetail,
  type PurchaseRewardProgressListResponse,
  type PurchaseRewardProgressResponse,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activities,
  activityRuleVersions,
  couponIssues,
  couponTeamGrants,
  couponIssueEvents,
  ledgerPaymentOrderLinks,
  staffAccounts,
  users,
} from '../src/db/schema.js'
import { hashPassword } from '../src/auth/security.js'
import { issueEligibleTeamCoupons } from '../src/purchase-reward/coupon-issuance.js'
import { readOrderPaymentEvidence } from '../src/ledger/payment-evidence.js'
import { readSettlementCandidate } from '../src/ledger/settlement-candidates.js'
import { readCouponForOrder } from '../src/purchase-reward/coupon-usage.js'
import { confirmCommunityOrFail } from './resident-community-fixtures.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ADMIN_PASSWORD = 'Admin-Password-123!'
const OPERATOR_PASSWORD = 'Operator-Password-123!'
const RESIDENT_ORIGIN = 'http://localhost:5173'
const ADMIN_ORIGIN = 'http://localhost:5174'

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
}

interface ResidentSession extends Session {
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

interface ApiOptions {
  session?: Session
  body?: unknown
  csrf?: boolean
  origin?: string
}

function api(app: App, method: string, path: string, options: ApiOptions = {}) {
  const { session, body, csrf: withCsrf = method !== 'GET', origin = ADMIN_ORIGIN } = options
  const headers: Record<string, string> = {}
  if (session) headers.cookie = session.cookies
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (session && withCsrf) {
    headers['x-csrf-token'] = session.csrfToken
    headers.origin = origin
  }
  return app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function route(routeTemplate: string, activityId: string): string {
  return routeTemplate.replace(':activityId', activityId)
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string; message: string } }
  return body.error.code
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function testContext() {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const app = createApp({ db, config, logRequests: false })
  return { app, db, sqlite, config }
}

async function createAdmin(db: AppDatabase) {
  const now = new Date()
  const userId = randomUUID()
  const staffId = randomUUID()
  db.insert(users)
    .values({ id: userId, displayName: '系统管理员', createdAt: now, updatedAt: now })
    .run()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId,
      username: 'admin',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { userId, staffId }
}

async function staffSession(app: App, username: string, password: string): Promise<Session> {
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
  const body = (await response.json()) as { csrfToken: string }
  return {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: body.csrfToken,
  }
}

async function residentSession(
  app: App,
  displayName: string,
  communityId: string,
): Promise<ResidentSession> {
  const csrfState = await csrf(app)
  const response = await app.request('/auth/dev/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: csrfState.cookie,
      'x-csrf-token': csrfState.token,
      origin: RESIDENT_ORIGIN,
    },
    body: JSON.stringify({ displayName }),
  })
  assert.equal(response.status, 200, 'resident dev login must succeed')
  const body = (await response.json()) as {
    user: { id: string }
    csrfToken: string
  }
  const session: ResidentSession = {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: body.csrfToken,
    userId: body.user.id,
  }
  await confirmCommunityOrFail(app, session, communityId, RESIDENT_ORIGIN)
  return session
}

async function createCommunity(app: App, admin: Session, name: string): Promise<string> {
  const response = await api(app, 'POST', '/admin/communities', { session: admin, body: { name } })
  assert.equal(response.status, 201, 'community creation must succeed')
  return ((await response.json()) as { id: string }).id
}

async function createOperator(
  app: App,
  admin: Session,
  input: { username: string; displayName: string; password: string; communityIds: string[] },
): Promise<string> {
  const response = await api(app, 'POST', '/admin/staff', {
    session: admin,
    body: { ...input, role: 'operator' },
  })
  assert.equal(response.status, 201, `creating operator ${input.username} must succeed`)
  return ((await response.json()) as { id: string }).id
}

async function createOnShelfProduct(
  app: App,
  admin: Session,
  communityId: string,
  priceCents = 450,
): Promise<LocalProductDetail> {
  const createdResponse = await api(app, 'POST', '/admin/catalog/products', {
    session: admin,
    body: { communityId, name: '社区直供好物', priceCents },
  })
  assert.equal(createdResponse.status, 201)
  const created = localProductDetailSchema.parse(await createdResponse.json())
  const shelfResponse = await api(app, 'POST', `/admin/catalog/products/${created.id}/shelf`, {
    session: admin,
    body: { expectedUpdatedAt: created.updatedAt, status: 'on_shelf' },
  })
  assert.equal(shelfResponse.status, 200)
  return localProductDetailSchema.parse(await shelfResponse.json())
}

const ACTIVITY_RULES_JSON = JSON.stringify({
  eligibility: '本社区居民',
  checkin: '到社区服务中心签到',
  purchase: '购买本地好物',
  prizeClaim: '凭核销码领取',
})

interface ActivityOptions {
  status?: ActivityStatus
  thresholdCents?: number | null
  couponFaceValueCents?: number
  maxRewardedTeams?: number
}

function addActivity(
  db: AppDatabase,
  communityId: string,
  createdByUserId: string,
  options: ActivityOptions = {},
): string {
  const now = new Date()
  const status = options.status ?? 'published'
  const thresholdCents = options.thresholdCents ?? 12_000
  const endsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const id = randomUUID()
  const startsAt = new Date(now.getTime() - 60 * 60 * 1000)
  const purchasePlan = options.thresholdCents === null ? null : {
    thresholdCents,
    couponFaceValueCents: options.couponFaceValueCents ?? 2_000,
    maxRewardedTeams: options.maxRewardedTeams ?? 5,
  }
  db.insert(activities)
    .values({
      id,
      communityId,
      title: '消费团实付进度活动',
      summary: '验证团队有效实付累计',
      description: 'LL-PUR-005 测试活动',
      status,
      startsAt,
      endsAt,
      location: '幸福社区党群服务中心',
      budgetCapCents: 100_000,
      prizeQuantityCap: 100,
      publicRulesJson: ACTIVITY_RULES_JSON,
      purchaseRewardPlanJson: purchasePlan === null ? null : JSON.stringify(purchasePlan),
      currentRuleVersionId: null,
      createdByUserId,
      createdAt: now,
      updatedAt: now,
      publishedAt: status === 'draft' ? null : now,
      pausedAt: status === 'paused' ? now : null,
      endedAt: status === 'ended' ? now : null,
    })
    .run()
  if (status !== 'draft') {
    // Real publication creates an immutable version. Issuance never trusts the
    // activity's mutable column when deciding the promise or coupon budget.
    const versionId = randomUUID()
    db.insert(activityRuleVersions).values({
      id: versionId,
      activityId: id,
      version: 1,
      snapshotJson: JSON.stringify({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        location: '幸福社区党群服务中心',
        budgetCapCents: 100_000,
        prizeQuantityCap: 100,
        publicRules: JSON.parse(ACTIVITY_RULES_JSON),
        ...(purchasePlan === null ? {} : { purchaseRewardPlan: purchasePlan }),
      }),
      createdByUserId,
      createdAt: now,
    }).run()
    db.update(activities).set({ currentRuleVersionId: versionId })
      .where(eq(activities.id, id)).run()
  }
  return id
}

async function confirmParticipation(
  app: App,
  resident: ResidentSession,
  activityId: string,
  inviteCode?: string,
) {
  const response = await api(app, 'POST', `/activities/${activityId}/participation`, {
    session: resident,
    origin: RESIDENT_ORIGIN,
    body: inviteCode === undefined ? {} : { inviteCode },
  })
  assert.equal(response.status, 200, 'confirming participation must succeed')
  return activityParticipationConfirmResponseSchema.parse(await response.json())
}

/** Starts the team, returns its id and the one invite code the leader owns. */
async function startTeam(
  app: App,
  resident: ResidentSession,
  activityId: string,
): Promise<{ teamId: string; inviteCode: string }> {
  const result = await confirmParticipation(app, resident, activityId)
  const state = result.state
  assert.ok(state.team?.id, 'a leader always gets a team')
  assert.ok(state.team.inviteCode, 'an open team exposes its invite code')
  return { teamId: state.team.id, inviteCode: state.team.inviteCode }
}

async function registerOrder(
  app: App,
  resident: ResidentSession,
  input: {
    productId: string
    quantity?: number
    activityId?: string
    teamId?: string
  },
): Promise<LocalOrderDetail> {
  const response = await api(app, 'POST', '/local-orders', {
    session: resident,
    origin: RESIDENT_ORIGIN,
    body: {
      productId: input.productId,
      quantity: input.quantity ?? 1,
      idempotencyKey: randomUUID(),
      ...(input.activityId === undefined ? {} : { sourceActivityId: input.activityId }),
      ...(input.teamId === undefined ? {} : { sourceTeamId: input.teamId }),
    },
  })
  const text = await response.text()
  assert.equal(response.status, 201, `registration should succeed: ${text}`)
  const body = JSON.parse(text) as { created: boolean; order: unknown }
  return localOrderDetailSchema.parse(body.order)
}

async function markVerified(
  app: App,
  operator: Session,
  order: LocalOrderDetail,
): Promise<LocalOrderDetail> {
  const processingResponse = await api(
    app,
    'PATCH',
    `/staff/local-orders/${order.id}/status`,
    {
      session: operator,
      body: { expectedUpdatedAt: order.updatedAt, status: 'processing' },
    },
  )
  assert.equal(processingResponse.status, 200)
  const processing = localOrderDetailSchema.parse(await processingResponse.json())
  const pendingResponse = await api(
    app,
    'PATCH',
    `/staff/local-orders/${order.id}/status`,
    {
      session: operator,
      body: { expectedUpdatedAt: processing.updatedAt, status: 'pending_review' },
    },
  )
  assert.equal(pendingResponse.status, 200)
  const pending = localOrderDetailSchema.parse(await pendingResponse.json())
  const verifyResponse = await api(
    app,
    'POST',
    `/admin/local-orders/${order.id}/verify`,
    {
      session: operator,
      body: {
        expectedUpdatedAt: pending.updatedAt,
        decision: 'verify',
        note: '现场核验通过',
      },
    },
  )
  assert.equal(verifyResponse.status, 200)
  return localOrderDetailSchema.parse(await verifyResponse.json())
}

async function recordPayment(
  app: App,
  operator: Session,
  input: {
    communityId: string
    staffId: string
    orderId: string
    amountCents: number
    evidenceRef: string
  },
): Promise<LedgerEntry> {
  const response = await api(app, 'POST', '/admin/ledger/payments', {
    session: operator,
    body: {
      communityId: input.communityId,
      orderId: input.orderId,
      amountCents: input.amountCents,
      evidenceRef: input.evidenceRef,
      evidenceKind: 'manual_receipt',
      receivedAt: new Date().toISOString(),
      staffId: input.staffId,
    },
  })
  const text = await response.text()
  assert.equal(response.status, 201, `recording a payment should succeed: ${text}`)
  return ledgerEntrySchema.parse(JSON.parse(text))
}

async function reversePayment(
  app: App,
  operator: Session,
  entryId: string,
): Promise<LedgerEntry> {
  const response = await api(app, 'POST', `/admin/ledger/payments/${entryId}/reverse`, {
    session: operator,
    body: { reason: '全额冲正测试' },
  })
  const text = await response.text()
  assert.equal(response.status, 201, `reversing a payment should succeed: ${text}`)
  return ledgerEntrySchema.parse(JSON.parse(text))
}

async function myProgress(
  app: App,
  resident: ResidentSession,
  activityId: string,
): Promise<PurchaseRewardProgressResponse> {
  const response = await api(
    app,
    'GET',
    route(PURCHASE_REWARD_ROUTES.myProgress, activityId),
    { session: resident },
  )
  const text = await response.text()
  assert.equal(response.status, 200, `resident progress should succeed: ${text}`)
  return purchaseRewardProgressResponseSchema.parse(JSON.parse(text))
}

async function staffProgress(
  app: App,
  session: Session,
  activityId: string,
): Promise<PurchaseRewardProgressListResponse> {
  const response = await api(
    app,
    'GET',
    route(PURCHASE_REWARD_ROUTES.staffProgress, activityId),
    { session },
  )
  const text = await response.text()
  assert.equal(response.status, 200, `staff progress should succeed: ${text}`)
  return purchaseRewardProgressListResponseSchema.parse(JSON.parse(text))
}

async function world() {
  const context = testContext()
  const { app, db } = context
  const adminUser = await createAdmin(db)
  const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
  const communityId = await createCommunity(app, admin, '本地生活社区')
  const operatorId = await createOperator(app, admin, {
    username: 'operator',
    displayName: '运营小王',
    password: OPERATOR_PASSWORD,
    communityIds: [communityId],
  })
  const operator = await staffSession(app, 'operator', OPERATOR_PASSWORD)
  return {
    ...context,
    admin,
    adminUser,
    operator,
    operatorId,
    communityId,
    resident: (displayName: string) => residentSession(app, displayName, communityId),
  }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

test('honest empty states: no plan, no participation and no team', async () => {
  const w = await world()
  const { app, db, operator, communityId } = w

  const noPlanActivity = addActivity(db, communityId, w.adminUser.userId, {
    thresholdCents: null,
  })
  const resident = await w.resident('居民甲')
  const noPlan = await myProgress(app, resident, noPlanActivity)
  assert.deepEqual(noPlan, {
    activityId: noPlanActivity,
    activityTitle: '消费团实付进度活动',
    plan: null,
    progress: null,
  })
  const noPlanStaff = await staffProgress(app, operator, noPlanActivity)
  assert.equal(noPlanStaff.plan, null)
  assert.deepEqual(noPlanStaff.items, [])

  const planActivity = addActivity(db, communityId, w.adminUser.userId, {
    thresholdCents: 12_000,
  })
  const beforeJoin = await myProgress(app, resident, planActivity)
  assert.deepEqual(beforeJoin.plan, {
    thresholdCents: 12_000,
    couponFaceValueCents: 2_000,
  })
  assert.equal(beforeJoin.progress, null, 'no participation must not fake a zero team')

  const staffEmpty = await staffProgress(app, operator, planActivity)
  assert.deepEqual(staffEmpty.plan, {
    thresholdCents: 12_000,
    couponFaceValueCents: 2_000,
  })
  assert.deepEqual(staffEmpty.items, [], 'no team means no fabricated team row')
})

test('post-join verified receipts accumulate; eligibility needs a full team and the threshold', async () => {
  const w = await world()
  const { app, db, admin, operator, operatorId, communityId } = w
  const product = await createOnShelfProduct(app, admin, communityId, 500)
  const activityId = addActivity(db, communityId, w.adminUser.userId, {
    thresholdCents: 12_000,
  })
  const residentA = await w.resident('居民甲')

  // Consumption BEFORE joining: this order has no team attribution and can never
  // be retro-fitted to one (the #207 trigger refuses it), so it must not count.
  const beforeJoinOrder = await registerOrder(app, residentA, {
    productId: product.id,
    quantity: 9,
  })
  const verifiedBefore = await markVerified(app, operator, beforeJoinOrder)
  await recordPayment(app, operator, {
    communityId,
    staffId: operatorId,
    orderId: verifiedBefore.id,
    amountCents: 4_500,
    evidenceRef: 'RCPT-BEFORE-JOIN',
  })

  const { teamId, inviteCode } = await startTeam(app, residentA, activityId)
  const afterJoinOrder = await registerOrder(app, residentA, {
    productId: product.id,
    quantity: 9,
    activityId,
    teamId,
  })
  const verifiedAfter = await markVerified(app, operator, afterJoinOrder)
  await recordPayment(app, operator, {
    communityId,
    staffId: operatorId,
    orderId: verifiedAfter.id,
    amountCents: 4_500,
    evidenceRef: 'RCPT-AFTER-JOIN',
  })

  const oneMember = await myProgress(app, residentA, activityId)
  assert.ok(oneMember.progress)
  assert.equal(oneMember.progress.seatsFilled, 1)
  assert.equal(oneMember.progress.teamFull, false)
  assert.equal(oneMember.progress.totalEffectivePaidCents, 4_500)
  assert.equal(oneMember.progress.thresholdCents, 12_000)
  assert.equal(oneMember.progress.remainingCents, 7_500)
  assert.equal(oneMember.progress.eligible, false)
  assert.equal(oneMember.progress.membersContributionCents.length, 1)
  assert.equal(oneMember.progress.membersContributionCents[0]?.isSelf, true)
  assert.equal(oneMember.progress.membersContributionCents[0]?.contributionCents, 4_500)

  // More spend, still one member: total can reach the threshold but eligibility
  // must stay false until the team is actually full.
  const secondOrder = await registerOrder(app, residentA, {
    productId: product.id,
    quantity: 15,
    activityId,
    teamId,
  })
  const secondVerified = await markVerified(app, operator, secondOrder)
  await recordPayment(app, operator, {
    communityId,
    staffId: operatorId,
    orderId: secondVerified.id,
    amountCents: 7_500,
    evidenceRef: 'RCPT-AFTER-JOIN-2',
  })
  const reachedButNotFull = await myProgress(app, residentA, activityId)
  assert.ok(reachedButNotFull.progress)
  assert.equal(reachedButNotFull.progress.totalEffectivePaidCents, 12_000)
  assert.equal(reachedButNotFull.progress.remainingCents, 0)
  assert.equal(reachedButNotFull.progress.teamFull, false)
  assert.equal(reachedButNotFull.progress.eligible, false)

  const residentB = await w.resident('居民乙')
  await confirmParticipation(app, residentB, activityId, inviteCode)
  const residentC = await w.resident('居民丙')
  await confirmParticipation(app, residentC, activityId, inviteCode)

  const full = await myProgress(app, residentA, activityId)
  assert.ok(full.progress)
  assert.equal(full.progress.teamId, teamId)
  assert.equal(full.progress.seatsFilled, 3)
  assert.equal(full.progress.teamFull, true)
  assert.equal(full.progress.totalEffectivePaidCents, 12_000)
  assert.equal(full.progress.remainingCents, 0)
  assert.equal(full.progress.eligible, true)
  assert.deepEqual(
    full.progress.membersContributionCents.map((member) => member.contributionCents),
    [12_000, 0, 0],
  )

  // B's view is the same team progress, but the self marker follows the caller.
  const fromB = await myProgress(app, residentB, activityId)
  assert.ok(fromB.progress)
  assert.equal(fromB.progress.eligible, true)
  assert.deepEqual(
    fromB.progress.membersContributionCents.map((member) => member.isSelf),
    [false, true, false],
  )

  const staffView = await staffProgress(app, operator, activityId)
  assert.equal(staffView.items.length, 1)
  assert.equal(staffView.items[0]?.teamId, teamId)
  assert.equal(staffView.items[0]?.eligible, true)
  assert.equal(staffView.items[0]?.totalEffectivePaidCents, 12_000)
})

test('unverified, unlinked, duplicate and fully reversed receipts never count', async () => {
  const w = await world()
  const { app, db, admin, operator, operatorId, communityId } = w
  const product = await createOnShelfProduct(app, admin, communityId)
  const activityId = addActivity(db, communityId, w.adminUser.userId, {
    thresholdCents: 5_000,
  })
  const residentA = await w.resident('居民甲')
  const { teamId, inviteCode } = await startTeam(app, residentA, activityId)
  const residentB = await w.resident('居民乙')
  await confirmParticipation(app, residentB, activityId, inviteCode)
  const residentC = await w.resident('居民丙')
  await confirmParticipation(app, residentC, activityId, inviteCode)

  const paidOrder = await registerOrder(app, residentA, {
    productId: product.id,
    quantity: 6,
    activityId,
    teamId,
  })
  const verifiedPaid = await markVerified(app, operator, paidOrder)
  const receipt = await recordPayment(app, operator, {
    communityId,
    staffId: operatorId,
    orderId: verifiedPaid.id,
    amountCents: 2_700,
    evidenceRef: 'RCPT-DUPLICATE-PROOF',
  })

  let progress = await myProgress(app, residentA, activityId)
  assert.ok(progress.progress)
  assert.equal(progress.progress.totalEffectivePaidCents, 2_700)
  assert.equal(progress.progress.remainingCents, 2_300)
  assert.equal(progress.progress.eligible, false)

  // Verified but no linked receipt: this is still "no 实收".
  const verifiedNoReceipt = await registerOrder(app, residentA, {
    productId: product.id,
    quantity: 4,
    activityId,
    teamId,
  })
  await markVerified(app, operator, verifiedNoReceipt)

  // Not business-verified: even a well-formed order contributes nothing.
  await registerOrder(app, residentA, {
    productId: product.id,
    quantity: 5,
    activityId,
    teamId,
  })

  progress = await myProgress(app, residentA, activityId)
  assert.ok(progress.progress)
  assert.equal(
    progress.progress.totalEffectivePaidCents,
    2_700,
    'only the verified order with a real receipt may contribute',
  )

  // Same evidence reference for a second order must be refused, not double count.
  const duplicateOrder = await registerOrder(app, residentB, {
    productId: product.id,
    quantity: 4,
    activityId,
    teamId,
  })
  const verifiedDuplicate = await markVerified(app, operator, duplicateOrder)
  const duplicateResponse = await api(app, 'POST', '/admin/ledger/payments', {
    session: operator,
    body: {
      communityId,
      orderId: verifiedDuplicate.id,
      amountCents: 1_800,
      evidenceRef: 'rcpt-duplicate-proof',
      evidenceKind: 'manual_receipt',
      receivedAt: new Date().toISOString(),
      staffId: operatorId,
    },
  })
  assert.equal(duplicateResponse.status, 409)
  assert.equal(await errorCode(duplicateResponse), API_ERROR_CODES.ledgerSourceDuplicate)

  progress = await myProgress(app, residentA, activityId)
  assert.ok(progress.progress)
  assert.equal(progress.progress.totalEffectivePaidCents, 2_700, 'duplicate receipt adds nothing')

  // A second team in the same activity is independent: the same order never
  // contributes to it.
  const residentD = await w.resident('居民丁')
  const secondTeam = await startTeam(app, residentD, activityId)
  assert.notEqual(secondTeam.teamId, teamId)
  const staffView = await staffProgress(app, operator, activityId)
  assert.equal(staffView.items.length, 2)
  const firstTeamProgress = staffView.items.find((item) => item.teamId === teamId)
  const otherTeamProgress = staffView.items.find((item) => item.teamId === secondTeam.teamId)
  assert.equal(firstTeamProgress?.totalEffectivePaidCents, 2_700)
  assert.equal(otherTeamProgress?.totalEffectivePaidCents, 0, 'one order contributes to one team only')

  // Full reversal nets to zero, so the team loses eligibility.
  await reversePayment(app, operator, receipt.entryId)
  progress = await myProgress(app, residentA, activityId)
  assert.ok(progress.progress)
  assert.equal(progress.progress.totalEffectivePaidCents, 0)
  assert.equal(progress.progress.remainingCents, 5_000)
  assert.equal(progress.progress.eligible, false)
  assert.deepEqual(
    progress.progress.membersContributionCents.map((member) => member.contributionCents),
    [0, 0, 0],
  )
})

test('resident reads only their own team and staff reads are community-scoped', async () => {
  const w = await world()
  const { app, db, admin, operator, communityId } = w
  const product = await createOnShelfProduct(app, admin, communityId)
  const activityId = addActivity(db, communityId, w.adminUser.userId, {
    thresholdCents: 10_000,
  })
  const residentA = await w.resident('居民甲')
  const { teamId, inviteCode } = await startTeam(app, residentA, activityId)
  const residentB = await w.resident('居民乙')
  await confirmParticipation(app, residentB, activityId, inviteCode)

  const order = await registerOrder(app, residentA, {
    productId: product.id,
    quantity: 2,
    activityId,
    teamId,
  })
  const verified = await markVerified(app, operator, order)
  await recordPayment(app, operator, {
    communityId,
    staffId: w.operatorId,
    orderId: verified.id,
    amountCents: 900,
    evidenceRef: 'RCPT-SCOPE',
  })

  // A non-participant sees no team and no other resident's totals.
  const outsider = await w.resident('居民戊')
  const outsiderProgress = await myProgress(app, outsider, activityId)
  assert.equal(outsiderProgress.progress, null)

  // Another community's activity is a 403 for an operator assigned only here.
  const otherCommunityId = await createCommunity(app, admin, '另一个社区')
  const otherActivityId = addActivity(db, otherCommunityId, w.adminUser.userId, {
    thresholdCents: 10_000,
  })
  const forbidden = await api(
    app,
    'GET',
    route(PURCHASE_REWARD_ROUTES.staffProgress, otherActivityId),
    { session: operator },
  )
  assert.equal(forbidden.status, 403)
  assert.equal(await errorCode(forbidden), API_ERROR_CODES.forbidden)

  // The same operator may read the assigned community; admin is unscoped.
  const allowed = await staffProgress(app, operator, activityId)
  assert.equal(allowed.items.length, 1)
  const adminView = await staffProgress(app, admin, otherActivityId)
  assert.deepEqual(adminView.items, [])

  // Staff surface requires a staff session; a resident session is not enough.
  const residentOnStaffRoute = await api(
    app,
    'GET',
    route(PURCHASE_REWARD_ROUTES.staffProgress, activityId),
    { session: residentA },
  )
  assert.equal(residentOnStaffRoute.status, 401)
  const anonymous = await api(
    app,
    'GET',
    route(PURCHASE_REWARD_ROUTES.staffProgress, activityId),
  )
  assert.equal(anonymous.status, 401)
  const anonymousResident = await api(
    app,
    'GET',
    route(PURCHASE_REWARD_ROUTES.myProgress, activityId),
  )
  assert.equal(anonymousResident.status, 401)

  // Draft activities stay invisible to residents, like the public activity read.
  const draftActivityId = addActivity(db, communityId, w.adminUser.userId, {
    status: 'draft',
    thresholdCents: 10_000,
  })
  const draftProgress = await api(
    app,
    'GET',
    route(PURCHASE_REWARD_ROUTES.myProgress, draftActivityId),
    { session: residentA },
  )
  assert.equal(draftProgress.status, 404)
  const missingProgress = await api(
    app,
    'GET',
    route(PURCHASE_REWARD_ROUTES.myProgress, randomUUID()),
    { session: residentA },
  )
  assert.equal(missingProgress.status, 404)
})


/* -------------------------------------------------------------------------- */
/* #211 Atomic, one-time equal coupon issuance                                */
/* -------------------------------------------------------------------------- */

async function myCouponWallet(app: App, resident: ResidentSession) {
  const response = await api(app, 'GET', PURCHASE_REWARD_ROUTES.myCoupons, { session: resident })
  assert.equal(response.status, 200)
  return couponWalletResponseSchema.parse(await response.json())
}

async function couponStock(app: App, staff: Session, activityId: string) {
  const response = await api(app, 'GET', route(PURCHASE_REWARD_ROUTES.staffCouponStock, activityId), {
    session: staff,
  })
  assert.equal(response.status, 200)
  return couponStockResponseSchema.parse(await response.json())
}

test('third join issues exactly one identical coupon to each member after existing valid spend', async () => {
  const w = await world()
  const { app, db, admin, operator, operatorId, communityId } = w
  const product = await createOnShelfProduct(app, admin, communityId, 500)
  const activityId = addActivity(db, communityId, w.adminUser.userId, {
    thresholdCents: 1_000, couponFaceValueCents: 200,
  })
  const a = await w.resident('甲')
  const b = await w.resident('乙')
  const c = await w.resident('丙')
  const { teamId, inviteCode } = await startTeam(app, a, activityId)
  await confirmParticipation(app, b, activityId, inviteCode)
  const order = await registerOrder(app, a, { productId: product.id, quantity: 2, activityId, teamId })
  const verified = await markVerified(app, operator, order)
  await recordPayment(app, operator, {
    communityId, staffId: operatorId, orderId: verified.id,
    amountCents: 1_000, evidenceRef: 'COUPON-THIRD-SEAT',
  })
  assert.equal((await myCouponWallet(app, a)).items.length, 0, 'two people must not issue')
  assert.equal((await couponStock(app, operator, activityId)).issuedTeams, 0)
  await confirmParticipation(app, c, activityId, inviteCode)

  for (const member of [a, b, c]) {
    const wallet = await myCouponWallet(app, member)
    assert.equal(wallet.items.length, 1)
    const coupon = wallet.items[0]!
    assert.equal(coupon.activityId, activityId)
    assert.equal(coupon.teamId, teamId)
    assert.equal(coupon.status, 'available')
    assert.equal(coupon.faceValueCents, 200)
    assert.equal(coupon.reservedOrderId, null)
    assert.equal(Date.parse(coupon.expiresAt) - Date.parse(coupon.issuedAt), 30 * 24 * 3600 * 1000)
  }
  const stock = await couponStock(app, operator, activityId)
  assert.equal(stock.issuedTeams, 1)
  assert.equal(stock.issuedValueCents, 600)
  assert.equal(stock.remainingTeams, 4)
  const grants = db.select().from(couponTeamGrants).all()
  assert.equal(grants.length, 1)
  assert.equal(grants[0]?.totalValueCents, 600)
  assert.equal(db.select().from(couponIssueEvents).all().length, 3)
  const retry = await confirmParticipation(app, c, activityId, inviteCode)
  assert.equal(retry.created, false)
  assert.equal((await myCouponWallet(app, a)).items.length, 1)
})

test('payment after three joins issues once; team quota exhaustion leaves the second payment intact', async () => {
  const w = await world()
  const { app, db, admin, operator, operatorId, communityId } = w
  const product = await createOnShelfProduct(app, admin, communityId, 500)
  const activityId = addActivity(db, communityId, w.adminUser.userId, {
    thresholdCents: 1_000, couponFaceValueCents: 300, maxRewardedTeams: 1,
  })
  const a = await w.resident('甲')
  const b = await w.resident('乙')
  const c = await w.resident('丙')
  const { teamId, inviteCode } = await startTeam(app, a, activityId)
  await confirmParticipation(app, b, activityId, inviteCode)
  await confirmParticipation(app, c, activityId, inviteCode)
  assert.equal((await myCouponWallet(app, a)).items.length, 0, 'three seats without spend is not eligible')
  const order = await registerOrder(app, a, { productId: product.id, quantity: 2, activityId, teamId })
  const verified = await markVerified(app, operator, order)
  await recordPayment(app, operator, {
    communityId, staffId: operatorId, orderId: verified.id,
    amountCents: 1_000, evidenceRef: 'COUPON-PAID-AFTER-THREE',
  })
  assert.equal((await myCouponWallet(app, a)).items.length, 1)
  assert.equal(issueEligibleTeamCoupons(db, activityId, teamId), 'already_issued')
  assert.equal(issueEligibleTeamCoupons(db, activityId, teamId), 'already_issued')

  const d = await w.resident('丁')
  const e = await w.resident('戊')
  const f = await w.resident('己')
  const second = await startTeam(app, d, activityId)
  await confirmParticipation(app, e, activityId, second.inviteCode)
  await confirmParticipation(app, f, activityId, second.inviteCode)
  const secondOrder = await registerOrder(app, d, {
    productId: product.id, quantity: 2, activityId, teamId: second.teamId,
  })
  const secondVerified = await markVerified(app, operator, secondOrder)
  await recordPayment(app, operator, {
    communityId, staffId: operatorId, orderId: secondVerified.id,
    amountCents: 1_000, evidenceRef: 'COUPON-QUOTA-EXHAUSTED',
  })
  assert.equal(issueEligibleTeamCoupons(db, activityId, second.teamId), 'exhausted')
  assert.equal((await myCouponWallet(app, d)).items.length, 0, 'budget exhausted: no partial team reward')
  assert.equal(db.select().from(couponTeamGrants).all().length, 1)
  assert.equal(db.select().from(couponIssues).all().length, 3)
  assert.ok(db.select().from(ledgerPaymentOrderLinks).where(eq(ledgerPaymentOrderLinks.orderId, secondVerified.id)).get(),
    'valid receipt must survive budget exhaustion')
  const stock = await couponStock(app, operator, activityId)
  assert.equal(stock.issuedTeams, 1)
  assert.equal(stock.remainingTeams, 0)
  assert.equal(stock.issuedValueCents, stock.totalBudgetCents)

  const outsider = await w.resident('不相关居民')
  assert.deepEqual((await myCouponWallet(app, outsider)).items, [], 'wallet ownership stays server-scoped')
  const noStaff = await api(app, 'GET', route(PURCHASE_REWARD_ROUTES.staffCouponStock, activityId), {
    session: outsider,
  })
  assert.equal(noStaff.status, 401)
  const otherCommunity = await createCommunity(app, admin, '别的社区')
  const otherActivity = addActivity(db, otherCommunity, w.adminUser.userId)
  const crossCommunity = await api(app, 'GET', route(PURCHASE_REWARD_ROUTES.staffCouponStock, otherActivity), {
    session: operator,
  })
  assert.equal(crossCommunity.status, 403)
})

test('failure inserting the second coupon rolls back third seat, grant, budget and first coupon', async () => {
  const w = await world()
  const { app, db, sqlite, admin, operator, operatorId, communityId } = w
  const product = await createOnShelfProduct(app, admin, communityId, 500)
  const activityId = addActivity(db, communityId, w.adminUser.userId, {
    thresholdCents: 1_000, couponFaceValueCents: 250, maxRewardedTeams: 1,
  })
  const a = await w.resident('甲')
  const b = await w.resident('乙')
  const c = await w.resident('丙')
  const { teamId, inviteCode } = await startTeam(app, a, activityId)
  await confirmParticipation(app, b, activityId, inviteCode)
  const order = await registerOrder(app, a, { productId: product.id, quantity: 2, activityId, teamId })
  const verified = await markVerified(app, operator, order)
  await recordPayment(app, operator, {
    communityId, staffId: operatorId, orderId: verified.id,
    amountCents: 1_000, evidenceRef: 'COUPON-ROLLBACK-SECOND',
  })
  sqlite.exec(`CREATE TRIGGER test_reject_second_coupon
    BEFORE INSERT ON coupon_issues WHEN NEW.seat_no = 2
    BEGIN SELECT RAISE(ABORT, 'test second coupon refused'); END`)
  try {
    const failed = await api(app, 'POST', `/activities/${activityId}/participation`, {
      session: c, origin: RESIDENT_ORIGIN, body: { inviteCode },
    })
    assert.ok(failed.status >= 500, 'a DB failure cannot claim joining/funding succeeded')
    assert.equal(db.select().from(couponTeamGrants).all().length, 0)
    assert.equal(db.select().from(couponIssues).all().length, 0)
    assert.equal(db.select().from(couponIssueEvents).all().length, 0)
    assert.equal((await myProgress(app, a, activityId)).progress?.seatsFilled, 2)
  } finally {
    sqlite.exec('DROP TRIGGER test_reject_second_coupon')
  }
  await confirmParticipation(app, c, activityId, inviteCode)
  assert.equal(db.select().from(couponIssues).all().length, 3)
  assert.equal((await couponStock(app, operator, activityId)).issuedTeams, 1)
})


/* -------------------------------------------------------------------------- */
/* #212 One coupon per order: net actual cash, no double-counting             */
/* -------------------------------------------------------------------------- */

async function couponEarnedWorld() {
  const w = await world()
  const { app, db, admin, operator, operatorId, communityId } = w
  const starter = await createOnShelfProduct(app, admin, communityId, 1_000)
  const product = await createOnShelfProduct(app, admin, communityId, 10_000)
  const exactFaceProduct = await createOnShelfProduct(app, admin, communityId, 2_000)
  const tooCheapProduct = await createOnShelfProduct(app, admin, communityId, 1_000)
  const activityId = addActivity(db, communityId, w.adminUser.userId, {
    thresholdCents: 1_000, couponFaceValueCents: 2_000, maxRewardedTeams: 2,
  })
  const a = await w.resident('甲')
  const b = await w.resident('乙')
  const c = await w.resident('丙')
  const { teamId, inviteCode } = await startTeam(app, a, activityId)
  await confirmParticipation(app, b, activityId, inviteCode)
  await confirmParticipation(app, c, activityId, inviteCode)
  const purchase = await registerOrder(app, a, { productId: starter.id, activityId, teamId })
  const verified = await markVerified(app, operator, purchase)
  await recordPayment(app, operator, {
    communityId, staffId: operatorId, orderId: verified.id,
    amountCents: 1_000, evidenceRef: 'COUPON-NET-STARTER',
  })
  const couponId = (await myCouponWallet(app, a)).items[0]?.id
  assert.ok(couponId, 'verified receipt must have issued a resident coupon')
  return { ...w, starter, product, exactFaceProduct, tooCheapProduct,
    a, b, c, activityId, teamId, couponId }
}

test('100 yuan gross - 20 yuan coupon = 80 yuan cash; replay is safe and only real net earns team progress', async () => {
  const w = await couponEarnedWorld()
  const { app, db, admin, operator, operatorId, communityId, a, b, product, activityId, teamId, couponId } = w
  const idempotencyKey = randomUUID()
  const intent = {
    productId: product.id, quantity: 1, couponId, idempotencyKey,
    sourceActivityId: activityId, sourceTeamId: teamId,
  }
  const register = (session: ResidentSession, body: unknown) => api(app, 'POST', '/local-orders', {
    session, origin: RESIDENT_ORIGIN, body,
  })
  const first = await register(a, intent)
  assert.equal(first.status, 201)
  const created = (await first.json()) as { created: boolean; order: unknown }
  assert.equal(created.created, true)
  const order = localOrderDetailSchema.parse(created.order)
  assert.equal(order.snapshot.totalCents, 10_000)
  assert.equal(order.snapshot.couponDiscountCents, 2_000)
  assert.equal(order.snapshot.netPayableCents, 8_000)
  assert.equal(order.snapshot.couponId, couponId)
  assert.equal((await myCouponWallet(app, a)).items[0]?.status, 'reserved')
  assert.equal((await myCouponWallet(app, a)).items[0]?.reservedOrderId, order.id)
  assert.equal(db.select().from(couponIssueEvents).all().length, 4, 'three issued + one reservation event')

  const retry = await register(a, intent)
  assert.equal(retry.status, 200)
  assert.equal(((await retry.json()) as { created: boolean }).created, false)
  assert.equal(db.select().from(couponIssueEvents).all().length, 4)

  const changed = await register(a, { ...intent, couponId: (await myCouponWallet(app, b)).items[0]!.id })
  assert.equal(changed.status, 409)
  assert.equal(await errorCode(changed), API_ERROR_CODES.orderIdempotencyConflict)
  const reuse = await register(a, { ...intent, idempotencyKey: randomUUID() })
  assert.equal(reuse.status, 409, 'same coupon cannot reserve a second order')
  const stolen = await register(b, { productId: product.id, quantity: 1,
    couponId, idempotencyKey: randomUUID() })
  assert.equal(stolen.status, 409, 'another resident cannot use the coupon')
  const forged = await register(a, { productId: product.id, quantity: 1, couponId,
    idempotencyKey: randomUUID(), couponDiscountCents: 1 })
  assert.equal(forged.status, 400, 'client may not declare a discount')

  const verified = await markVerified(app, operator, order)
  assert.equal((await myCouponWallet(app, a)).items[0]?.status, 'reserved',
    'business verification alone is not positive cash evidence')

  const wrong = await api(app, 'POST', '/admin/ledger/payments', { session: operator, body: {
    communityId, orderId: verified.id, amountCents: 10_000,
    evidenceRef: 'COUPON-GROSS-IS-NOT-CASH', evidenceKind: 'manual_receipt',
    receivedAt: new Date().toISOString(), staffId: operatorId,
  } })
  assert.equal(wrong.status, 409)
  assert.equal((await myCouponWallet(app, a)).items[0]?.status, 'reserved')
  assert.equal(db.select().from(ledgerPaymentOrderLinks).where(eq(ledgerPaymentOrderLinks.orderId, order.id)).get(), undefined)

  await recordPayment(app, operator, { communityId, staffId: operatorId, orderId: verified.id,
    amountCents: 8_000, evidenceRef: 'COUPON-NET-8000' })
  const wallet = await myCouponWallet(app, a)
  assert.equal(wallet.items[0]?.status, 'redeemed')
  assert.equal(db.select().from(couponIssueEvents).all().length, 5, 'one append-only redemption')
  const progress = await myProgress(app, a, activityId)
  assert.equal(progress.progress?.totalEffectivePaidCents, 9_000,
    '1,000 real starter receipt + 8,000 net; coupon face is never added as cash')
  const actor = { userId: w.adminUser.userId, staffId: null, role: 'admin' as const }
  const evidence = readOrderPaymentEvidence(db, actor, order.id)
  assert.equal(evidence.registeredAmountCents, 10_000)
  assert.equal(evidence.couponDiscountCents, 2_000)
  assert.equal(evidence.netPayableCents, 8_000)
  assert.equal(evidence.payment?.amountCents, 8_000)
  const candidate = readSettlementCandidate(db, actor, order.id)
  assert.equal(candidate.registeredAmountCents, 10_000)
  assert.equal(candidate.couponDiscountCents, 2_000)
  assert.equal(candidate.netPayableCents, 8_000)
  assert.ok(!candidate.blockingReasons.includes('amount_mismatch'))
  assert.equal((await register(a, { ...intent, idempotencyKey: randomUUID() })).status, 409)
})

test('full-face coupon allows zero net payable, redeems at staff verification without fake cash', async () => {
  const w = await couponEarnedWorld()
  const { app, db, a, operator, communityId, operatorId, exactFaceProduct, tooCheapProduct, couponId, activityId } = w
  const invalid = await api(app, 'POST', '/local-orders', { session: a, origin: RESIDENT_ORIGIN, body: {
    productId: tooCheapProduct.id, quantity: 1, couponId, idempotencyKey: randomUUID(),
  } })
  assert.equal(invalid.status, 400)
  assert.equal((await myCouponWallet(app, a)).items[0]?.status, 'available')
  const orderResponse = await api(app, 'POST', '/local-orders', { session: a, origin: RESIDENT_ORIGIN, body: {
    productId: exactFaceProduct.id, quantity: 1, couponId, idempotencyKey: randomUUID(),
  } })
  assert.equal(orderResponse.status, 201)
  const order = localOrderDetailSchema.parse(((await orderResponse.json()) as {order: unknown}).order)
  assert.equal(order.snapshot.totalCents, 2_000)
  assert.equal(order.snapshot.couponDiscountCents, 2_000)
  assert.equal(order.snapshot.netPayableCents, 0)
  assert.equal((await myCouponWallet(app, a)).items[0]?.status, 'reserved')
  const verified = await markVerified(app, operator, order)
  assert.equal((await myCouponWallet(app, a)).items[0]?.status, 'redeemed')
  const actor = { userId: w.adminUser.userId, staffId: null, role: 'admin' as const }
  const evidence = readOrderPaymentEvidence(db, actor, order.id)
  assert.equal(evidence.canRecord, false)
  assert.equal(evidence.status, 'coupon_only_verified')
  assert.equal(evidence.payment, null)
  const fakeCash = await api(app, 'POST', '/admin/ledger/payments', { session: operator, body: {
    communityId, orderId: verified.id, amountCents: 1,
    evidenceRef: 'COUPON-ZERO-FAKE', evidenceKind: 'manual_receipt',
    receivedAt: new Date().toISOString(), staffId: operatorId,
  } })
  assert.equal(fakeCash.status, 409)
  assert.equal(db.select().from(ledgerPaymentOrderLinks)
    .where(eq(ledgerPaymentOrderLinks.orderId, order.id)).get(), undefined)
  const progress = await myProgress(app, a, activityId)
  assert.equal(progress.progress?.totalEffectivePaidCents, 1_000,
    'zero-cash subsidised order never counts as actual paid spend')
})

test('expired coupon is rejected by the same SQLite reservation guard, not a browser clock', async () => {
  const w = await couponEarnedWorld()
  const expiredAt = new Date(Date.now() + 31 * 24 * 3600 * 1000)
  assert.throws(() => w.db.transaction((tx) => readCouponForOrder(tx, {
    couponId: w.couponId, buyerUserId: w.a.userId, communityId: w.communityId,
    grossCents: 10_000, now: expiredAt,
  }), { behavior: 'immediate' }), /消费券无效|已过期/)
  assert.equal((await myCouponWallet(w.app, w.a)).items[0]?.status, 'available',
    'a failed future-quote cannot accidentally reserve the real coupon now')
})
