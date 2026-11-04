import assert from 'node:assert/strict'
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
import { eq } from 'drizzle-orm'
import test from 'node:test'
import {
  CRM_ACTIVATION_SOURCE,
  type CrmFollowUpListResponse,
  type CrmLeadDetail,
  type CrmLeadEventListResponse,
  type CrmLeadListResponse,
  type CrmOrderDetail,
  type CrmOrderEventListResponse,
  type CrmOrderListResponse,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activities,
  auditLogs,
  communities,
  crmFollowUps,
  crmLeadEvents,
  crmOrderEvents,
  staffAccounts,
  users,
} from '../src/db/schema.js'
import { hashPassword } from '../src/auth/security.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ADMIN_PASSWORD = 'Admin-Password-123!'
const OPERATOR_PASSWORD = 'Operator-Password-123!'
const GRID_PASSWORD = 'Grid-Worker-Password-123!'
const SECOND_GRID_PASSWORD = 'Second-Grid-Password-123!'

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
}

interface ErrorEnvelope {
  error: { code: string; message: string }
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

async function csrf(app: App) {
  const response = await app.request('/auth/csrf')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { csrfToken: string }
  return { token: body.csrfToken, cookie: cookiePair(response, 'll_csrf') }
}

function cookieHeader(...pairs: string[]) {
  return pairs.join('; ')
}

function writeHeaders(cookie: string, token: string) {
  return {
    'content-type': 'application/json',
    cookie,
    'x-csrf-token': token,
    origin: 'http://localhost:5174',
  }
}

async function login(app: App, username: string, password: string) {
  const csrfState = await csrf(app)
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: writeHeaders(csrfState.cookie, csrfState.token),
    body: JSON.stringify({ username, password }),
  })
  return {
    response,
    csrfToken: response.ok
      ? ((await response.clone().json()) as { csrfToken: string }).csrfToken
      : null,
  }
}

async function staffSession(
  app: App,
  username: string,
  password: string,
): Promise<Session> {
  const result = await login(app, username, password)
  assert.equal(result.response.status, 200, `${username} should be able to log in`)
  assert.ok(result.csrfToken)
  return {
    cookies: cookieHeader(
      cookiePair(result.response, 'll_session'),
      cookiePair(result.response, 'll_csrf'),
    ),
    csrfToken: result.csrfToken,
  }
}

interface ApiOptions {
  session?: Session
  body?: unknown
  csrf?: boolean
  origin?: string
}

function api(app: App, method: string, path: string, options: ApiOptions = {}) {
  const { session, body, csrf: withCsrf = method !== 'GET', origin } = options
  const headers: Record<string, string> = {}
  if (session) headers.cookie = session.cookies
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (session && withCsrf) {
    headers['x-csrf-token'] = session.csrfToken
    headers.origin = origin ?? 'http://localhost:5174'
  } else if (origin) {
    headers.origin = origin
  }
  return app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  return (await response.json()) as ErrorEnvelope
}

function testContext() {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const app = createApp({ db, config, logRequests: false })
  return { app, db, sqlite }
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

async function createCommunity(app: App, admin: Session, name: string): Promise<string> {
  const response = await api(app, 'POST', '/admin/communities', {
    session: admin,
    body: { name },
  })
  assert.equal(response.status, 201, 'community creation must succeed')
  return ((await response.json()) as { id: string }).id
}

interface StaffInput {
  username: string
  displayName: string
  password: string
  role: 'operator' | 'grid_worker'
  communityIds: string[]
}

async function createStaffAccount(
  app: App,
  admin: Session,
  input: StaffInput,
): Promise<string> {
  const response = await api(app, 'POST', '/admin/staff', {
    session: admin,
    body: input,
  })
  assert.equal(response.status, 201, `creating staff ${input.username} must succeed`)
  return ((await response.json()) as { id: string }).id
}

function seedActivity(
  db: AppDatabase,
  communityId: string,
  createdByUserId: string,
  title: string,
): string {
  const id = randomUUID()
  const now = new Date()
  db.insert(activities)
    .values({
      id,
      communityId,
      title,
      summary: null,
      description: null,
      status: 'published',
      startsAt: now,
      endsAt: new Date(now.getTime() + 60 * 60 * 1000),
      location: '社区服务中心',
      budgetCapCents: 0,
      prizeQuantityCap: 0,
      publicRulesJson: JSON.stringify({
        eligibility: '本社区居民',
        checkin: '现场签到',
        purchase: '现场办理',
        prizeClaim: '凭核验码领取',
      }),
      currentRuleVersionId: null,
      createdByUserId,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
      pausedAt: null,
      endedAt: null,
    })
    .run()
  return id
}

interface LeadPayload {
  communityId: string
  ownerStaffId?: string
  contactName?: string
  contactPhone?: string
  sourceType?: 'activity' | 'grid_promotion' | 'walk_in' | 'resident_referral'
  sourceActivityId?: string
  promotionStaffId?: string
  residentUserId?: string
  nextContactAt?: string
  [key: string]: unknown
}

function leadPayload(communityId: string, overrides: Partial<LeadPayload> = {}): LeadPayload {
  return {
    communityId,
    contactName: '张阿姨',
    contactPhone: '13800000000',
    sourceType: 'walk_in',
    ...overrides,
  }
}

async function createLead(app: App, session: Session, payload: LeadPayload) {
  const response = await api(app, 'POST', '/crm/leads', { session, body: payload })
  assert.equal(response.status, 201, 'lead creation must succeed')
  return (await response.json()) as CrmLeadDetail
}

async function leadDetail(app: App, session: Session, leadId: string) {
  const response = await api(app, 'GET', `/crm/leads/${leadId}`, { session })
  assert.equal(response.status, 200)
  return (await response.json()) as CrmLeadDetail
}

async function leadList(app: App, session: Session, query = '') {
  const response = await api(app, 'GET', `/crm/leads${query}`, { session })
  assert.equal(response.status, 200)
  return (await response.json()) as CrmLeadListResponse
}

async function orderDetail(app: App, session: Session, orderId: string) {
  const response = await api(app, 'GET', `/crm/orders/${orderId}`, { session })
  assert.equal(response.status, 200)
  return (await response.json()) as CrmOrderDetail
}

async function orderList(app: App, session: Session, query = '') {
  const response = await api(app, 'GET', `/crm/orders${query}`, { session })
  assert.equal(response.status, 200)
  return (await response.json()) as CrmOrderListResponse
}

async function createOrder(
  app: App,
  session: Session,
  body: {
    leadId: string
    orderNo: string
    businessType?: 'gd_mobile' | 'gd_tv'
    customerName?: string
    contactPhone?: string
    evidenceRef?: string
    notes?: string
  },
) {
  const response = await api(app, 'POST', '/crm/orders', {
    session,
    body: { businessType: 'gd_mobile', ...body },
  })
  assert.equal(response.status, 201, 'order creation must succeed')
  return (await response.json()) as CrmOrderDetail
}

function leadTransition(
  app: App,
  session: Session,
  leadId: string,
  expectedUpdatedAt: string,
  status: 'contacting' | 'invalid',
  note?: string,
) {
  return api(app, 'PATCH', `/crm/leads/${leadId}/status`, {
    session,
    body: { expectedUpdatedAt, status, ...(note ? { note } : {}) },
  })
}

function orderTransition(
  app: App,
  session: Session,
  orderId: string,
  expectedUpdatedAt: string,
  status: 'processing' | 'pending_verification' | 'failed' | 'cancelled',
  extra: { note?: string; failureReason?: string } = {},
) {
  return api(app, 'PATCH', `/crm/orders/${orderId}/status`, {
    session,
    body: { expectedUpdatedAt, status, ...extra },
  })
}

function review(
  app: App,
  session: Session,
  orderId: string,
  expectedUpdatedAt: string,
  decision: 'confirm' | 'reject',
  note: string,
) {
  return api(app, 'POST', `/admin/crm/orders/${orderId}/review`, {
    session,
    body: { expectedUpdatedAt, decision, note },
  })
}

async function sendOrderToVerification(
  app: App,
  session: Session,
  orderId: string,
): Promise<CrmOrderDetail> {
  let detail = await orderDetail(app, session, orderId)
  let response = await orderTransition(
    app,
    session,
    orderId,
    detail.updatedAt,
    'processing',
  )
  assert.equal(response.status, 200, 'submitted -> processing must succeed')
  detail = (await response.json()) as CrmOrderDetail
  response = await orderTransition(
    app,
    session,
    orderId,
    detail.updatedAt,
    'pending_verification',
  )
  assert.equal(response.status, 200, 'processing -> pending_verification must succeed')
  return (await response.json()) as CrmOrderDetail
}

function withTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/* -------------------------------------------------------------------------- */
/* Auth, CSRF and envelope                                                    */
/* -------------------------------------------------------------------------- */

test('CRM reads require a staff session and writes require CSRF + trusted Origin', async () => {
  const { app, db, sqlite } = testContext()
  try {
    const sampleId = randomUUID()
    const readPaths = [
      `/crm/leads`,
      `/crm/leads/${sampleId}`,
      `/crm/leads/${sampleId}/follow-ups`,
      `/crm/leads/${sampleId}/audit`,
      `/crm/orders`,
      `/crm/orders/${sampleId}`,
      `/crm/orders/${sampleId}/audit`,
      `/admin/crm/leads`,
      `/admin/crm/orders`,
      `/admin/crm/filter-options`,
    ]
    for (const path of readPaths) {
      const response = await app.request(path)
      assert.equal(response.status, 401, `${path} must require a staff session`)
      const body = await errorEnvelope(response)
      assert.equal(body.error.code, 'unauthorized')
      assert.equal(typeof body.error.message, 'string')
    }

    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, 'CSRF 社区')
    await createStaffAccount(app, admin, {
      username: 'csrf-grid',
      displayName: 'CSRF 网格员',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityId],
    })
    const grid = await staffSession(app, 'csrf-grid', GRID_PASSWORD)
    const payload = leadPayload(communityId)

    const writeRoutes = [
      { method: 'POST', path: '/crm/leads', body: payload },
      {
        method: 'PATCH',
        path: `/crm/leads/${sampleId}/status`,
        body: { expectedUpdatedAt: new Date().toISOString(), status: 'contacting' },
      },
      {
        method: 'POST',
        path: `/crm/leads/${sampleId}/transfer`,
        body: {
          expectedUpdatedAt: new Date().toISOString(),
          toOwnerStaffId: sampleId,
          reason: '未授权',
        },
      },
      {
        method: 'POST',
        path: `/crm/leads/${sampleId}/follow-ups`,
        body: { expectedUpdatedAt: new Date().toISOString(), content: '未授权' },
      },
      { method: 'POST', path: '/crm/orders', body: { leadId: sampleId, orderNo: 'X-001', businessType: 'gd_mobile' } },
      {
        method: 'PATCH',
        path: `/crm/orders/${sampleId}/status`,
        body: { expectedUpdatedAt: new Date().toISOString(), status: 'processing' },
      },
      {
        method: 'POST',
        path: `/admin/crm/orders/${sampleId}/review`,
        body: {
          expectedUpdatedAt: new Date().toISOString(),
          decision: 'confirm',
          note: '未授权',
        },
      },
    ]

    for (const route of writeRoutes) {
      const response = await api(app, route.method, route.path, {
        session: grid,
        body: route.body,
        csrf: false,
      })
      assert.equal(response.status, 403, `${route.method} ${route.path} must reject missing CSRF`)
      assert.equal((await errorEnvelope(response)).error.code, 'forbidden')
    }

    const badOrigin = await api(app, 'POST', '/crm/leads', {
      session: grid,
      body: payload,
      origin: 'http://evil.example',
    })
    assert.equal(badOrigin.status, 403)
    assert.equal((await errorEnvelope(badOrigin)).error.code, 'forbidden')
  } finally {
    sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Review CSRF is not masked by the role check                                */
/* -------------------------------------------------------------------------- */

test('operator review on a pending order rejects a missing CSRF token with 403, then succeeds with it', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '审核 CSRF 社区')
    await createStaffAccount(app, admin, {
      username: 'review-csrf-grid',
      displayName: '审核 CSRF 网格员',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityId],
    })
    await createStaffAccount(app, admin, {
      username: 'review-csrf-operator',
      displayName: '审核 CSRF 运营',
      password: OPERATOR_PASSWORD,
      role: 'operator',
      communityIds: [communityId],
    })
    const grid = await staffSession(app, 'review-csrf-grid', GRID_PASSWORD)
    const operator = await staffSession(app, 'review-csrf-operator', OPERATOR_PASSWORD)

    const lead = await createLead(app, grid, leadPayload(communityId, { contactName: '审核 CSRF 居民' }))
    const order = await createOrder(app, grid, {
      leadId: lead.id,
      orderNo: 'REVIEW-CSRF-1',
      businessType: 'gd_mobile',
    })
    const pending = await sendOrderToVerification(app, grid, order.id)

    // Operator passes requireAdminSide; only the CSRF check can reject this write.
    const noCsrf = await api(app, 'POST', `/admin/crm/orders/${order.id}/review`, {
      session: operator,
      origin: 'http://localhost:5174',
      csrf: false,
      body: {
        expectedUpdatedAt: pending.updatedAt,
        decision: 'confirm',
        note: '缺少 CSRF 的审核',
      },
    })
    assert.equal(noCsrf.status, 403)
    const noCsrfBody = await errorEnvelope(noCsrf)
    assert.equal(noCsrfBody.error.code, 'forbidden')
    assert.match(noCsrfBody.error.message, /CSRF/u)
    assert.equal((await orderDetail(app, operator, order.id)).status, 'pending_verification')

    const withCsrf = await review(
      app,
      operator,
      order.id,
      pending.updatedAt,
      'confirm',
      '带 CSRF 的人工核验',
    )
    assert.equal(withCsrf.status, 200)
    assert.equal(((await withCsrf.json()) as CrmOrderDetail).status, 'confirmed')
  } finally {
    sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Community scope and ownership                                              */
/* -------------------------------------------------------------------------- */

test('community scope, ownership and client-supplied attribution are enforced server-side', async () => {
  const { app, db, sqlite } = testContext()
  try {
    const adminInfo = await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityA = await createCommunity(app, admin, '社区 A')
    const communityB = await createCommunity(app, admin, '社区 B')
    await createStaffAccount(app, admin, {
      username: 'grid-a1',
      displayName: '网格员 A1',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityA],
    })
    await createStaffAccount(app, admin, {
      username: 'grid-a2',
      displayName: '网格员 A2',
      password: SECOND_GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityA],
    })
    const gridA3 = await createStaffAccount(app, admin, {
      username: 'grid-b1',
      displayName: '网格员 B1',
      password: 'Grid-B-Password-123!',
      role: 'grid_worker',
      communityIds: [communityB],
    })
    await createStaffAccount(app, admin, {
      username: 'operator-a',
      displayName: '运营 A',
      password: OPERATOR_PASSWORD,
      role: 'operator',
      communityIds: [communityA],
    })
    const grid1 = await staffSession(app, 'grid-a1', GRID_PASSWORD)
    const grid2 = await staffSession(app, 'grid-a2', SECOND_GRID_PASSWORD)
    const grid3 = await staffSession(app, 'grid-b1', 'Grid-B-Password-123!')
    const operator = await staffSession(app, 'operator-a', OPERATOR_PASSWORD)

    const activityA = seedActivity(db, communityA, adminInfo.userId, '社区 A 活动')
    const activityB = seedActivity(db, communityB, adminInfo.userId, '社区 B 活动')

    // Client-supplied owner/status/createdBy are ignored or rejected.
    const created = await createLead(app, grid1, {
      ...leadPayload(communityA, {
        sourceType: 'activity',
        sourceActivityId: activityA,
      }),
      ownerStaffId: undefined,
      status: 'converted',
      createdByStaffId: 'client-supplied',
    })
    assert.equal(created.status, 'new')
    assert.equal(created.sourceActivity?.id, activityA)
    assert.equal(created.ownerStaff.displayName, '网格员 A1')

    const ownOwnerField = await api(app, 'POST', '/crm/leads', {
      session: grid1,
      body: leadPayload(communityA, { ownerStaffId: gridA3 }),
    })
    assert.equal(ownOwnerField.status, 403, 'grid worker cannot create for another owner')

    const crossCommunityCreate = await api(app, 'POST', '/crm/leads', {
      session: grid1,
      body: leadPayload(communityB),
    })
    assert.equal(crossCommunityCreate.status, 403)

    const crossActivity = await api(app, 'POST', '/crm/leads', {
      session: grid1,
      body: leadPayload(communityA, {
        sourceType: 'activity',
        sourceActivityId: activityB,
      }),
    })
    assert.equal(crossActivity.status, 400, 'activity source must belong to the community')

    const missingActivity = await api(app, 'POST', '/crm/leads', {
      session: grid1,
      body: leadPayload(communityA, { sourceType: 'activity' }),
    })
    assert.equal(missingActivity.status, 400)

    // Other grid worker cannot read, follow up, transfer or change status.
    const otherRead = await api(app, 'GET', `/crm/leads/${created.id}`, { session: grid2 })
    assert.equal(otherRead.status, 403)
    const otherFollowUp = await api(app, 'GET', `/crm/leads/${created.id}/follow-ups`, {
      session: grid2,
    })
    assert.equal(otherFollowUp.status, 403)
    const otherTransfer = await api(app, 'POST', `/crm/leads/${created.id}/transfer`, {
      session: grid2,
      body: {
        expectedUpdatedAt: created.updatedAt,
        toOwnerStaffId: gridA3,
        reason: '抢占测试',
      },
    })
    assert.equal(otherTransfer.status, 403)
    const otherStatus = await leadTransition(
      app,
      grid2,
      created.id,
      created.updatedAt,
      'contacting',
    )
    assert.equal(otherStatus.status, 403)

    // Cross-community grid worker sees 403, never the row.
    const crossRead = await api(app, 'GET', `/crm/leads/${created.id}`, { session: grid3 })
    assert.equal(crossRead.status, 403)

    // Operator can manage inside the assigned community, but not outside it.
    const operatorRead = await api(app, 'GET', `/crm/leads/${created.id}`, { session: operator })
    assert.equal(operatorRead.status, 200)
    const operatorStatus = await leadTransition(
      app,
      operator,
      created.id,
      created.updatedAt,
      'contacting',
      '运营接手',
    )
    assert.equal(operatorStatus.status, 200)
    const operatorCrossCommunity = await api(
      app,
      'GET',
      `/crm/leads?communityId=${communityB}`,
      { session: operator },
    )
    assert.equal(operatorCrossCommunity.status, 403)

    // Admin can cross communities, and client-supplied audit fields are ignored.
    const adminRead = await api(app, 'GET', `/crm/leads/${created.id}`, { session: admin })
    assert.equal(adminRead.status, 200)

    // Grid worker cannot hit back-office review endpoints.
    const gridAdmin = await api(app, 'GET', '/admin/crm/leads', { session: grid1 })
    assert.equal(gridAdmin.status, 403)

    // Lists are scoped: grid sees only its own leads, operator sees assigned community.
    const grid2Lead = await createLead(app, grid2, leadPayload(communityA, { contactName: '李叔叔' }))
    const gridList = await leadList(app, grid1)
    assert.deepEqual(
      gridList.items.map((item) => item.id),
      [created.id],
    )
    assert.equal(gridList.items[0]?.contactPhoneMasked, '138****0000')
    assert.equal(JSON.stringify(gridList).includes('13800000000'), false)
    assert.equal(created.contactPhone, '13800000000')
    const gridOtherStaffFilter = await api(app, 'GET', `/crm/leads?staffId=${gridA3}`, {
      session: grid1,
    })
    assert.equal(gridOtherStaffFilter.status, 403)
    const operatorList = await leadList(app, operator, '?communityId=' + communityA)
    assert.equal(operatorList.total, 2)
    assert.ok(operatorList.items.some((item) => item.id === grid2Lead.id))
    const adminList = await leadList(app, admin)
    assert.equal(adminList.total, 2)

    // The grid worker cannot see the other grid worker's lead through the H5 list.
    assert.equal(
      gridList.items.some((item) => item.id === grid2Lead.id),
      false,
    )
  } finally {
    sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Follow-ups, next contact and persistence                                   */
/* -------------------------------------------------------------------------- */

test('follow-ups persist, update lastContactedAt/nextContactAt, and survive a database reopen', async () => {
  const temp = withTempDir('ll-crm-persist-')
  const databasePath = join(temp.dir, 'crm.sqlite')
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const first = createDatabase(databasePath, migrationsFolder)
  try {
    await createAdmin(first.db)
    const app = createApp({ db: first.db, config, logRequests: false })
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '持久化社区')
    const persistGridId = await createStaffAccount(app, admin, {
      username: 'persist-grid',
      displayName: '持久化网格员',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityId],
    })
    const grid = await staffSession(app, 'persist-grid', GRID_PASSWORD)
    const firstReminder = '2026-12-01T02:00:00.000Z'
    const lead = await createLead(
      app,
      grid,
      leadPayload(communityId, {
        nextContactAt: firstReminder,
        sourceType: 'grid_promotion',
        promotionStaffId: persistGridId,
      }),
    )
    assert.equal(lead.nextContactAt, firstReminder)
    assert.equal(lead.lastContactedAt, null)
    assert.equal(lead.sourceType, 'grid_promotion')
    assert.equal(lead.promotionStaff?.id, persistGridId)

    const nextReminder = '2026-12-08T02:00:00.000Z'
    const followResponse = await api(app, 'POST', `/crm/leads/${lead.id}/follow-ups`, {
      session: grid,
      body: {
        expectedUpdatedAt: lead.updatedAt,
        content: '电话沟通，居民同意周末上门',
        nextContactAt: nextReminder,
      },
    })
    assert.equal(followResponse.status, 201)
    const followBody = (await followResponse.json()) as {
      followUp: { content: string; nextContactAt: string }
      lead: CrmLeadDetail
    }
    assert.equal(followBody.followUp.content, '电话沟通，居民同意周末上门')
    assert.equal(followBody.followUp.nextContactAt, nextReminder)
    assert.equal(followBody.lead.nextContactAt, nextReminder)
    assert.notEqual(followBody.lead.lastContactedAt, null)
    assert.equal(followBody.lead.followUpCount, 1)

    // Returned updatedAt must match the persisted row, otherwise the next write is a false 409.
    const afterFollow = await leadDetail(app, grid, lead.id)
    assert.equal(afterFollow.updatedAt, followBody.lead.updatedAt)

    const stale = await api(app, 'POST', `/crm/leads/${lead.id}/follow-ups`, {
      session: grid,
      body: {
        expectedUpdatedAt: lead.updatedAt,
        content: '过期令牌',
      },
    })
    assert.equal(stale.status, 409)
    assert.equal((await errorEnvelope(stale)).error.code, 'conflict')

    const clearResponse = await api(app, 'POST', `/crm/leads/${lead.id}/follow-ups`, {
      session: grid,
      body: {
        expectedUpdatedAt: afterFollow.updatedAt,
        content: '居民暂时不需要跟进',
        nextContactAt: null,
      },
    })
    assert.equal(clearResponse.status, 201)
    const cleared = (await clearResponse.json()) as { lead: CrmLeadDetail }
    assert.equal(cleared.lead.nextContactAt, null)
    assert.equal(cleared.lead.followUpCount, 2)

    const followUps = await api(app, 'GET', `/crm/leads/${lead.id}/follow-ups`, {
      session: grid,
    })
    assert.equal(followUps.status, 200)
    const followList = (await followUps.json()) as CrmFollowUpListResponse
    assert.equal(followList.items.length, 2)
    assert.equal(followList.items[0]?.content, '电话沟通，居民同意周末上门')

    // Close the connection the way a process restart would.
    first.sqlite.close()

    const second = createDatabase(databasePath, migrationsFolder)
    try {
      const restarted = createApp({ db: second.db, config, logRequests: false })
      const restored = await leadDetail(restarted, grid, lead.id)
      assert.equal(restored.nextContactAt, null)
      assert.equal(restored.lastContactedAt, cleared.lead.lastContactedAt)
      assert.equal(restored.followUpCount, 2)
      const restoredFollowUps = await api(
        restarted,
        'GET',
        `/crm/leads/${lead.id}/follow-ups`,
        { session: grid },
      )
      const restoredList = (await restoredFollowUps.json()) as CrmFollowUpListResponse
      assert.equal(restoredList.items.length, 2)
      assert.equal(restoredList.items[1]?.content, '居民暂时不需要跟进')
    } finally {
      second.sqlite.close()
    }
  } finally {
    try {
      first.sqlite.close()
    } catch {
      // Already closed after the persistence assertion.
    }
    temp.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* Transfer and attribution snapshots                                         */
/* -------------------------------------------------------------------------- */

test('transfer records from/to owner, operator and reason; confirmed order attribution stays frozen', async () => {
  const { app, db, sqlite } = testContext()
  try {
    const adminInfo = await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityA = await createCommunity(app, admin, '转交社区 A')
    const communityB = await createCommunity(app, admin, '转交社区 B')
    const grid1Id = await createStaffAccount(app, admin, {
      username: 'transfer-grid1',
      displayName: '转交网格员 1',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityA],
    })
    const grid2Id = await createStaffAccount(app, admin, {
      username: 'transfer-grid2',
      displayName: '转交网格员 2',
      password: SECOND_GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityA],
    })
    const outerGridId = await createStaffAccount(app, admin, {
      username: 'transfer-outer',
      displayName: '外社区网格员',
      password: 'Outer-Grid-Password-123!',
      role: 'grid_worker',
      communityIds: [communityB],
    })
    const operatorId = await createStaffAccount(app, admin, {
      username: 'transfer-operator',
      displayName: '转交运营',
      password: OPERATOR_PASSWORD,
      role: 'operator',
      communityIds: [communityA],
    })
    const grid1 = await staffSession(app, 'transfer-grid1', GRID_PASSWORD)
    const grid2 = await staffSession(app, 'transfer-grid2', SECOND_GRID_PASSWORD)
    const operator = await staffSession(app, 'transfer-operator', OPERATOR_PASSWORD)
    const activityId = seedActivity(db, communityA, adminInfo.userId, '转交来源活动')

    const lead = await createLead(app, grid1, {
      ...leadPayload(communityA, {
        sourceType: 'activity',
        sourceActivityId: activityId,
        promotionStaffId: undefined,
      }),
    })
    const order = await createOrder(app, grid1, {
      leadId: lead.id,
      orderNo: 'TRANSFER-001',
      businessType: 'gd_tv',
    })
    assert.equal(order.attributedStaff.id, grid1Id)
    assert.equal(order.sourceActivity?.id, activityId)
    assert.equal(order.status, 'submitted')

    // Wrong community target is rejected.
    const crossTarget = await api(app, 'POST', `/crm/leads/${lead.id}/transfer`, {
      session: grid1,
      body: {
        expectedUpdatedAt: lead.updatedAt,
        toOwnerStaffId: outerGridId,
        reason: '跨社区',
      },
    })
    assert.equal(crossTarget.status, 400)

    const transResponse = await api(app, 'POST', `/crm/leads/${lead.id}/transfer`, {
      session: grid1,
      body: {
        expectedUpdatedAt: lead.updatedAt,
        toOwnerStaffId: grid2Id,
        reason: '居民要求换网格员',
      },
    })
    assert.equal(transResponse.status, 200)
    const transferred = (await transResponse.json()) as CrmLeadDetail
    assert.equal(transferred.ownerStaff.id, grid2Id)
    assert.equal(transferred.updatedAt !== lead.updatedAt, true)

    // F5: admin is an operator, never an attribution target.
    const adminTarget = await api(app, 'POST', `/crm/leads/${lead.id}/transfer`, {
      session: grid2,
      body: {
        expectedUpdatedAt: transferred.updatedAt,
        toOwnerStaffId: adminInfo.staffId,
        reason: '转给管理员',
      },
    })
    assert.equal(adminTarget.status, 400)
    assert.equal((await errorEnvelope(adminTarget)).error.code, 'invalid_request')
    assert.equal((await leadDetail(app, grid2, lead.id)).ownerStaff.id, grid2Id)

    const eventsResponse = await api(app, 'GET', `/crm/leads/${lead.id}/audit`, {
      session: operator,
    })
    assert.equal(eventsResponse.status, 200)
    const events = (await eventsResponse.json()) as CrmLeadEventListResponse
    const transferEvent = events.items.find((item) => item.event === 'lead.transferred')
    assert.ok(transferEvent)
    assert.equal(transferEvent.fromOwnerStaff?.id, grid1Id)
    assert.equal(transferEvent.toOwnerStaff?.id, grid2Id)
    assert.equal(transferEvent.note, '居民要求换网格员')
    assert.equal(transferEvent.actor?.displayName, '转交网格员 1')

    // Old owner loses access; order attribution does not move.
    const oldOwnerRead = await api(app, 'GET', `/crm/leads/${lead.id}`, { session: grid1 })
    assert.equal(oldOwnerRead.status, 403)
    const newOwnerRead = await api(app, 'GET', `/crm/leads/${lead.id}`, { session: grid2 })
    assert.equal(newOwnerRead.status, 200)
    const orderAfterTransfer = await orderDetail(app, operator, order.id)
    assert.equal(orderAfterTransfer.attributedStaff.id, grid1Id)
    assert.equal(orderAfterTransfer.sourceActivity?.id, activityId)

    // Drive the order to confirmed through the only allowed path.
    const pending = await sendOrderToVerification(app, grid1, order.id)
    const confirmedResponse = await review(
      app,
      operator,
      order.id,
      pending.updatedAt,
      'confirm',
      '电话回访确认已办理',
    )
    assert.equal(confirmedResponse.status, 200)
    const confirmed = (await confirmedResponse.json()) as CrmOrderDetail
    assert.equal(confirmed.status, 'confirmed')
    assert.equal(confirmed.attributedStaff.id, grid1Id, 'attribution is frozen at creation')
    assert.equal(confirmed.activationSource, CRM_ACTIVATION_SOURCE)

    // A later transfer can change the lead owner but must never move the confirmed order.
    const afterConfirmLead = await leadDetail(app, grid2, lead.id)
    const secondTransfer = await api(app, 'POST', `/crm/leads/${lead.id}/transfer`, {
      session: grid2,
      body: {
        expectedUpdatedAt: afterConfirmLead.updatedAt,
        toOwnerStaffId: grid1Id,
        reason: '成交后交回原网格员',
      },
    })
    assert.equal(secondTransfer.status, 200)
    const confirmedAfterTransfer = await orderDetail(app, operator, order.id)
    assert.equal(confirmedAfterTransfer.attributedStaff.id, grid1Id)
    assert.equal(confirmedAfterTransfer.status, 'confirmed')
    const operatorAccount = db
      .select({ userId: staffAccounts.userId })
      .from(staffAccounts)
      .where(eq(staffAccounts.id, operatorId))
      .get()
    assert.equal(confirmedAfterTransfer.confirmedBy?.id, operatorAccount?.userId)
  } finally {
    sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Order state machine / review                                               */
/* -------------------------------------------------------------------------- */

test('order state machine is strict, confirmed only comes from manual review, duplicate orderNo is 409', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityA = await createCommunity(app, admin, '业务社区 A')
    const communityB = await createCommunity(app, admin, '业务社区 B')
    await createStaffAccount(app, admin, {
      username: 'order-grid-b',
      displayName: '外社区网格员',
      password: 'Order-Grid-B-Password-123!',
      role: 'grid_worker',
      communityIds: [communityB],
    })
    const gridId = await createStaffAccount(app, admin, {
      username: 'order-grid',
      displayName: '业务网格员',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityA],
    })
    await createStaffAccount(app, admin, {
      username: 'order-operator',
      displayName: '业务运营',
      password: OPERATOR_PASSWORD,
      role: 'operator',
      communityIds: [communityA],
    })
    await createStaffAccount(app, admin, {
      username: 'order-outsider',
      displayName: '同社区其他网格员',
      password: SECOND_GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityA],
    })
    const grid = await staffSession(app, 'order-grid', GRID_PASSWORD)
    const gridB = await staffSession(app, 'order-grid-b', 'Order-Grid-B-Password-123!')
    const outsider = await staffSession(app, 'order-outsider', SECOND_GRID_PASSWORD)
    const operator = await staffSession(app, 'order-operator', OPERATOR_PASSWORD)
    const lead = await createLead(app, grid, {
      ...leadPayload(communityA, {
        sourceType: 'grid_promotion',
        promotionStaffId: gridId,
      }),
    })
    const order = await createOrder(app, grid, {
      leadId: lead.id,
      orderNo: 'GD-0001',
      businessType: 'gd_mobile',
      evidenceRef: '工单截图 2026-11-04 #3',
    })
    assert.equal(order.status, 'submitted')
    assert.equal(order.attributedStaff.id, gridId)
    assert.equal(order.sourceActivity, null, 'non-activity source must not carry an activity')
    assert.equal(order.promotionStaff?.id, gridId)
    assert.equal(order.activationSource, null)
    assert.equal(order.confirmation, null)
    assert.equal(order.events.length, 1)
    assert.equal(order.events[0]?.event, 'order.created')

    // Client-supplied attribution/reviewer/activation fields are ignored.
    const spoofedOrderResponse = await api(app, 'POST', '/crm/orders', {
      session: grid,
      body: {
        leadId: lead.id,
        orderNo: 'GD-0005',
        businessType: 'gd_mobile',
        attributedStaffId: randomUUID(),
        promotionStaffId: randomUUID(),
        sourceActivityId: randomUUID(),
        confirmedByUserId: randomUUID(),
        activationSource: 'manual_verification',
        status: 'confirmed',
      },
    })
    assert.equal(spoofedOrderResponse.status, 201)
    const spoofedOrder = (await spoofedOrderResponse.json()) as CrmOrderDetail
    assert.equal(spoofedOrder.attributedStaff.id, gridId)
    assert.equal(spoofedOrder.status, 'submitted')
    assert.equal(spoofedOrder.activationSource, null)
    assert.equal(spoofedOrder.confirmation, null)

    // Same-community grid worker who neither created nor is attributed cannot read/write it.
    for (const [method, path, body] of [
      ['GET', `/crm/orders/${order.id}`, undefined],
      ['GET', `/crm/orders/${order.id}/audit`, undefined],
      [
        'PATCH',
        `/crm/orders/${order.id}/status`,
        { expectedUpdatedAt: order.updatedAt, status: 'processing' },
      ],
    ] as const) {
      const response = await api(app, method, path, {
        session: outsider,
        ...(body === undefined ? {} : { body }),
      })
      assert.equal(response.status, 403, `${method} ${path} must be 403 for outsider`)
    }

    const duplicate = await api(app, 'POST', '/crm/orders', {
      session: grid,
      body: { leadId: lead.id, orderNo: 'GD-0001', businessType: 'gd_tv' },
    })
    assert.equal(duplicate.status, 409)
    assert.equal((await errorEnvelope(duplicate)).error.code, 'conflict')

    // Same orderNo is allowed in another community.
    const leadB = await createLead(app, gridB, leadPayload(communityB))
    const otherCommunityOrder = await createOrder(app, admin, {
      leadId: leadB.id,
      orderNo: 'GD-0001',
      businessType: 'gd_tv',
    })
    assert.equal(otherCommunityOrder.status, 'submitted')

    // Illegal transitions: submitted cannot jump to pending_verification / cancelled after processing.
    const illegal = await orderTransition(
      app,
      grid,
      order.id,
      order.updatedAt,
      'pending_verification',
    )
    assert.equal(illegal.status, 409)

    const reviewTooEarly = await review(
      app,
      operator,
      order.id,
      order.updatedAt,
      'confirm',
      '过早确认',
    )
    assert.equal(reviewTooEarly.status, 409)

    const pending = await sendOrderToVerification(app, grid, order.id)
    assert.equal(pending.status, 'pending_verification')

    // Grid worker cannot perform the manual review.
    const gridReview = await review(
      app,
      grid,
      order.id,
      pending.updatedAt,
      'confirm',
      '网格员尝试确认',
    )
    assert.equal(gridReview.status, 403)

    // Wrong reviewer from another community is rejected.
    const outerOperatorId = await createStaffAccount(app, admin, {
      username: 'order-operator-b',
      displayName: '外社区运营',
      password: 'Outer-Operator-Password-123!',
      role: 'operator',
      communityIds: [communityB],
    })
    assert.ok(outerOperatorId)
    const outerOperator = await staffSession(
      app,
      'order-operator-b',
      'Outer-Operator-Password-123!',
    )

    // F4: cross-community order detail/audit are 403 for both operator and grid.
    for (const path of [`/crm/orders/${order.id}`, `/crm/orders/${order.id}/audit`]) {
      const operatorRead = await api(app, 'GET', path, { session: outerOperator })
      assert.equal(operatorRead.status, 403, `outer operator must not read ${path}`)
      const gridRead = await api(app, 'GET', path, { session: gridB })
      assert.equal(gridRead.status, 403, `outer grid must not read ${path}`)
    }

    const crossCommunityReview = await review(
      app,
      outerOperator,
      order.id,
      pending.updatedAt,
      'confirm',
      '越权确认',
    )
    assert.equal(crossCommunityReview.status, 403)

    const confirmedResponse = await api(
      app,
      'POST',
      `/admin/crm/orders/${order.id}/review`,
      {
        session: operator,
        body: {
          expectedUpdatedAt: pending.updatedAt,
          decision: 'confirm',
          note: '人工电话核验通过',
          confirmedByUserId: randomUUID(),
          reviewerUserId: randomUUID(),
          activationSource: 'manual_verification',
        },
      },
    )
    assert.equal(confirmedResponse.status, 200)
    const confirmed = (await confirmedResponse.json()) as CrmOrderDetail
    assert.equal(confirmed.status, 'confirmed')
    assert.equal(confirmed.activationSource, 'manual_verification')
    assert.equal(confirmed.confirmation?.confirmedBy?.displayName, '业务运营')
    assert.equal(confirmed.confirmation?.note, '人工电话核验通过')
    assert.notEqual(confirmed.confirmedAt, null)
    assert.equal(confirmed.failureReason, null)
    assert.equal(confirmed.events.filter((item) => item.event === 'order.reviewed').length, 1)

    // No "activated" field or wording may leak into the response.
    const serialized = JSON.stringify(confirmed)
    for (const forbidden of ['已开通', '已激活', 'activated', 'activationStatus', 'activatedAt']) {
      assert.equal(serialized.includes(forbidden), false, `response must not contain ${forbidden}`)
    }
    assert.equal('activatedAt' in confirmed, false)

    // Confirmed is terminal: no status transition and no second review.
    const afterConfirm = await orderDetail(app, operator, order.id)
    const terminal = await orderTransition(
      app,
      operator,
      order.id,
      afterConfirm.updatedAt,
      'cancelled',
    )
    assert.equal(terminal.status, 409)
    const secondReview = await review(
      app,
      operator,
      order.id,
      afterConfirm.updatedAt,
      'confirm',
      '重复确认',
    )
    assert.equal(secondReview.status, 409)

    const convertedLead = await leadDetail(app, operator, lead.id)
    assert.equal(convertedLead.status, 'converted')
    const leadTimelineResponse = await api(
      app,
      'GET',
      `/admin/crm/leads/${lead.id}/audit`,
      { session: operator },
    )
    assert.equal(leadTimelineResponse.status, 200)
    const leadTimeline = (await leadTimelineResponse.json()) as CrmLeadEventListResponse
    const conversionHops = leadTimeline.items.filter(
      (item) => item.event === 'lead.status_changed',
    )
    assert.deepEqual(
      conversionHops.map((item) => [item.fromStatus, item.toStatus]),
      [
        ['new', 'contacting'],
        ['contacting', 'converted'],
      ],
      'new leads must advance through contacting, never a direct new -> converted hop',
    )
    assert.equal(
      conversionHops.some(
        (item) => item.fromStatus === 'new' && item.toStatus === 'converted',
      ),
      false,
    )
    const conversionAudits = db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, lead.id))
      .all()
      .filter((row) => row.event === 'crm.lead.status_changed')
    assert.equal(
      conversionAudits.length,
      2,
      'each legal lead hop must write its own audit row',
    )

    // Invalid leads are not auto-revived: review is 409 and the order stays pending.
    const invalidLead = await createLead(
      app,
      grid,
      leadPayload(communityA, { contactName: '无效线索居民' }),
    )
    const invalidOrder = await createOrder(app, grid, {
      leadId: invalidLead.id,
      orderNo: 'GD-0006',
      businessType: 'gd_mobile',
    })
    const invalidPending = await sendOrderToVerification(app, grid, invalidOrder.id)
    const invalidLeadBefore = await leadDetail(app, grid, invalidLead.id)
    const invalidTransition = await leadTransition(
      app,
      grid,
      invalidLead.id,
      invalidLeadBefore.updatedAt,
      'invalid',
      '居民明确拒绝',
    )
    assert.equal(invalidTransition.status, 200)
    const invalidReview = await review(
      app,
      operator,
      invalidOrder.id,
      invalidPending.updatedAt,
      'confirm',
      '无效线索直接确认',
    )
    assert.equal(invalidReview.status, 409)
    assert.equal((await errorEnvelope(invalidReview)).error.code, 'conflict')
    const invalidOrderAfter = await orderDetail(app, operator, invalidOrder.id)
    assert.equal(invalidOrderAfter.status, 'pending_verification')
    assert.equal((await leadDetail(app, operator, invalidLead.id)).status, 'invalid')
    const invalidTimelineResponse = await api(
      app,
      'GET',
      `/admin/crm/orders/${invalidOrder.id}/audit`,
      { session: operator },
    )
    assert.equal(invalidTimelineResponse.status, 200)
    const invalidTimeline = (await invalidTimelineResponse.json()) as CrmOrderEventListResponse
    assert.equal(
      invalidTimeline.items.some((item) => item.event === 'order.reviewed'),
      false,
      'a rejected invalid-lead review must roll back the order review event',
    )

    // Restoring invalid -> contacting is the explicit human path, then review succeeds.
    const invalidLeadAfter = await leadDetail(app, grid, invalidLead.id)
    const restoreResponse = await leadTransition(
      app,
      grid,
      invalidLead.id,
      invalidLeadAfter.updatedAt,
      'contacting',
      '重新联系后恢复',
    )
    assert.equal(restoreResponse.status, 200)
    const restoredLead = (await restoreResponse.json()) as CrmLeadDetail
    assert.equal(restoredLead.status, 'contacting')
    const restoredReview = await review(
      app,
      operator,
      invalidOrder.id,
      invalidOrderAfter.updatedAt,
      'confirm',
      '恢复跟进后人工核验',
    )
    assert.equal(restoredReview.status, 200)
    assert.equal(
      ((await restoredReview.json()) as CrmOrderDetail).status,
      'confirmed',
    )
    assert.equal((await leadDetail(app, operator, invalidLead.id)).status, 'converted')

    // Reject path: pending_verification -> failed with failureReason.
    const rejectLead = await createLead(app, grid, leadPayload(communityA, { contactName: '驳回居民' }))
    const rejectOrder = await createOrder(app, grid, {
      leadId: rejectLead.id,
      orderNo: 'GD-0002',
      businessType: 'gd_tv',
    })
    const rejectPending = await sendOrderToVerification(app, grid, rejectOrder.id)
    const rejectedResponse = await review(
      app,
      operator,
      rejectOrder.id,
      rejectPending.updatedAt,
      'reject',
      '居民取消办理',
    )
    assert.equal(rejectedResponse.status, 200)
    const rejected = (await rejectedResponse.json()) as CrmOrderDetail
    assert.equal(rejected.status, 'failed')
    assert.equal(rejected.failureReason, '居民取消办理')
    assert.equal(rejected.activationSource, null)
    assert.equal(rejected.confirmation, null)
    const rejectLeadAfter = await leadDetail(app, operator, rejectLead.id)
    assert.notEqual(rejectLeadAfter.status, 'converted')

    // Cancel is allowed before confirmation, then becomes terminal.
    const cancelLead = await createLead(app, grid, leadPayload(communityA, { contactName: '取消居民' }))
    const cancelOrder = await createOrder(app, grid, {
      leadId: cancelLead.id,
      orderNo: 'GD-0003',
      businessType: 'gd_mobile',
    })
    const cancelled = await orderTransition(
      app,
      grid,
      cancelOrder.id,
      cancelOrder.updatedAt,
      'cancelled',
      { note: '居民放弃' },
    )
    assert.equal(cancelled.status, 200)
    const cancelledDetail = (await cancelled.json()) as CrmOrderDetail
    assert.equal(cancelledDetail.status, 'cancelled')
    const afterCancel = await orderTransition(
      app,
      grid,
      cancelOrder.id,
      cancelledDetail.updatedAt,
      'processing',
    )
    assert.equal(afterCancel.status, 409)

    // Failure requires a reason.
    const failLead = await createLead(app, grid, leadPayload(communityA, { contactName: '失败居民' }))
    const failOrder = await createOrder(app, grid, {
      leadId: failLead.id,
      orderNo: 'GD-0004',
      businessType: 'gd_mobile',
    })
    const failedWithoutReason = await orderTransition(
      app,
      grid,
      failOrder.id,
      failOrder.updatedAt,
      'failed',
    )
    assert.equal(failedWithoutReason.status, 400)
  } finally {
    sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Concurrent review                                                          */
/* -------------------------------------------------------------------------- */

test('concurrent confirm and reject on the same pending order: exactly one wins and one review event is written', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '并发审核社区')
    await createStaffAccount(app, admin, {
      username: 'concurrent-grid',
      displayName: '并发网格员',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityId],
    })
    await createStaffAccount(app, admin, {
      username: 'concurrent-operator',
      displayName: '并发运营',
      password: OPERATOR_PASSWORD,
      role: 'operator',
      communityIds: [communityId],
    })
    const grid = await staffSession(app, 'concurrent-grid', GRID_PASSWORD)
    const operator = await staffSession(app, 'concurrent-operator', OPERATOR_PASSWORD)

    const lead = await createLead(app, grid, leadPayload(communityId, { contactName: '并发居民' }))
    const order = await createOrder(app, grid, {
      leadId: lead.id,
      orderNo: 'CONCURRENT-001',
      businessType: 'gd_mobile',
    })
    const pending = await sendOrderToVerification(app, grid, order.id)

    const [first, second] = await Promise.all([
      review(app, operator, order.id, pending.updatedAt, 'confirm', '并发确认'),
      review(app, operator, order.id, pending.updatedAt, 'reject', '并发驳回'),
    ])
    const statuses = [first.status, second.status].sort((a, b) => a - b)
    assert.deepEqual(statuses, [200, 409])

    const finalOrder = await orderDetail(app, operator, order.id)
    assert.equal(
      finalOrder.events.filter((item) => item.event === 'order.reviewed').length,
      1,
      'only one review event may be written',
    )
    assert.equal(
      finalOrder.events.filter((item) => item.toStatus === 'confirmed').length,
      1,
      'at most one confirmation transition',
    )

    const reviewAuditRows = db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, order.id))
      .all()
      .filter((row) => row.event === 'crm.order.confirmed' || row.event === 'crm.order.rejected')
    assert.equal(reviewAuditRows.length, 1, 'exactly one review audit row')

    const finalLead = await leadDetail(app, operator, lead.id)
    if (finalOrder.status === 'confirmed') {
      assert.equal(finalLead.status, 'converted')
      assert.equal(finalOrder.activationSource, 'manual_verification')
    } else {
      assert.equal(finalOrder.status, 'failed')
      assert.notEqual(finalLead.status, 'converted')
    }

    const repeat = await review(
      app,
      operator,
      order.id,
      finalOrder.updatedAt,
      'confirm',
      '重复审核',
    )
    assert.equal(repeat.status, 409)
    const afterRepeat = await orderDetail(app, operator, order.id)
    assert.equal(
      afterRepeat.events.filter((item) => item.event === 'order.reviewed').length,
      1,
    )
  } finally {
    sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Server-side filters and pagination                                         */
/* -------------------------------------------------------------------------- */

test('lists filter and paginate on the server, with grid worker scope and 400 on invalid params', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityA = await createCommunity(app, admin, '分页社区 A')
    const communityB = await createCommunity(app, admin, '分页社区 B')
    const gridAId = await createStaffAccount(app, admin, {
      username: 'page-grid-a',
      displayName: '分页网格 A',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityA],
    })
    const gridA2Id = await createStaffAccount(app, admin, {
      username: 'page-grid-a2',
      displayName: '分页网格 A2',
      password: SECOND_GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityA],
    })
    await createStaffAccount(app, admin, {
      username: 'page-grid-b',
      displayName: '分页网格 B',
      password: 'Page-Grid-B-Password-123!',
      role: 'grid_worker',
      communityIds: [communityB],
    })
    await createStaffAccount(app, admin, {
      username: 'page-operator',
      displayName: '分页运营',
      password: OPERATOR_PASSWORD,
      role: 'operator',
      communityIds: [communityA],
    })
    const gridA = await staffSession(app, 'page-grid-a', GRID_PASSWORD)
    const gridA2 = await staffSession(app, 'page-grid-a2', SECOND_GRID_PASSWORD)
    const gridB = await staffSession(app, 'page-grid-b', 'Page-Grid-B-Password-123!')
    const operator = await staffSession(app, 'page-operator', OPERATOR_PASSWORD)

    const first = await createLead(
      app,
      gridA,
      leadPayload(communityA, {
        contactName: '关键字甲',
        contactPhone: '13900000001',
        sourceType: 'walk_in',
        nextContactAt: '2026-12-01T02:00:00.000Z',
      }),
    )
    const second = await createLead(
      app,
      gridA,
      leadPayload(communityA, {
        contactName: '关键字乙',
        contactPhone: '13900000002',
        sourceType: 'resident_referral',
        nextContactAt: '2026-12-02T02:00:00.000Z',
      }),
    )
    const third = await createLead(
      app,
      gridA2,
      leadPayload(communityA, {
        contactName: '关键字丙',
        contactPhone: '13900000003',
        sourceType: 'walk_in',
        nextContactAt: '2026-12-03T02:00:00.000Z',
      }),
    )
    // The fourth lead is created by the community-B grid worker so the admin never
    // becomes a lead owner (admin is an operator, not an attribution target).
    const fourth = await createLead(
      app,
      gridB,
      leadPayload(communityB, {
        contactName: '关键字丁',
        contactPhone: '13900000004',
        sourceType: 'walk_in',
        nextContactAt: '2026-12-04T02:00:00.000Z',
      }),
    )

    // Lead pagination is server-side and follows nextContactAt ASC, so page 1/2
    // have a real expected order and must not overlap.
    const page1 = await leadList(app, admin, '?page=1&pageSize=2')
    assert.equal(page1.items.length, 2)
    assert.equal(page1.total, 4)
    const page2 = await leadList(app, admin, '?page=2&pageSize=2')
    assert.equal(page2.items.length, 2)
    assert.equal(page2.page, 2)
    assert.deepEqual(
      page1.items.map((item) => item.id),
      [first.id, second.id],
    )
    assert.deepEqual(
      page2.items.map((item) => item.id),
      [third.id, fourth.id],
    )
    assert.equal(
      page1.items.some((item) => page2.items.some((other) => other.id === item.id)),
      false,
    )

    const byCommunity = await leadList(app, admin, `?communityId=${communityB}`)
    assert.equal(byCommunity.total, 1)
    assert.equal(byCommunity.items[0]?.community.id, communityB)

    const byStaff = await leadList(app, admin, `?staffId=${gridAId}`)
    assert.equal(byStaff.total, 2)
    const byOtherStaff = await leadList(app, admin, `?staffId=${gridA2Id}`)
    assert.equal(byOtherStaff.total, 1)

    const bySource = await leadList(app, admin, '?sourceType=resident_referral')
    assert.equal(bySource.total, 1)
    assert.equal(bySource.items[0]?.sourceType, 'resident_referral')

    const byKeyword = await leadList(app, admin, '?keyword=' + encodeURIComponent('关键字丙'))
    assert.equal(byKeyword.total, 1)
    assert.equal(byKeyword.items[0]?.id, third.id)

    const contacting = await leadTransition(
      app,
      gridA,
      first.id,
      first.updatedAt,
      'contacting',
    )
    assert.equal(contacting.status, 200)
    const byStatus = await leadList(app, admin, '?status=contacting')
    assert.equal(byStatus.total, 1)

    // Grid worker list sees only own leads even inside the same community.
    const gridList = await leadList(app, gridA)
    assert.equal(gridList.total, 2)
    assert.equal(gridList.items.some((item) => item.id === third.id), false)

    // Operator sees the assigned community, not community B.
    const operatorList = await leadList(app, operator)
    assert.equal(operatorList.total, 3)
    const operatorCross = await api(app, 'GET', `/admin/crm/leads?communityId=${communityB}`, {
      session: operator,
    })
    assert.equal(operatorCross.status, 403)

    // Orders: filters, pagination and grid scope.
    const orderLead = await createLead(app, gridA, leadPayload(communityA, { contactName: '订单甲' }))
    const order1 = await createOrder(app, gridA, {
      leadId: orderLead.id,
      orderNo: 'PAGE-MOBILE-1',
      businessType: 'gd_mobile',
    })
    await createOrder(app, gridA, {
      leadId: orderLead.id,
      orderNo: 'PAGE-TV-1',
      businessType: 'gd_tv',
    })
    const orderLeadB = await createLead(app, gridB, leadPayload(communityB, { contactName: '订单乙' }))
    await createOrder(app, admin, {
      leadId: orderLeadB.id,
      orderNo: 'PAGE-B-1',
      businessType: 'gd_mobile',
    })
    const pendingOrder = await sendOrderToVerification(app, gridA, order1.id)
    assert.equal(pendingOrder.id, order1.id)

    const orders = await orderList(app, admin)
    assert.equal(orders.total, 3)
    const byBusiness = await orderList(app, admin, '?businessType=gd_tv')
    assert.equal(byBusiness.total, 1)
    const byOrderStatus = await orderList(app, admin, '?status=pending_verification')
    assert.equal(byOrderStatus.total, 1)
    const byOrderKeyword = await orderList(app, admin, '?keyword=PAGE-TV')
    assert.equal(byOrderKeyword.total, 1)
    const byOrderCommunity = await orderList(app, admin, `?communityId=${communityB}`)
    assert.equal(byOrderCommunity.total, 1)
    const byOrderStaff = await orderList(app, admin, `?staffId=${gridAId}`)
    assert.equal(byOrderStaff.total, 2)

    const gridOrders = await orderList(app, gridA)
    assert.equal(gridOrders.total, 2)
    const gridOrdersOther = await api(app, 'GET', `/crm/orders?staffId=${gridA2Id}`, {
      session: gridA,
    })
    assert.equal(gridOrdersOther.status, 403)
    const operatorOrders = await orderList(app, operator)
    assert.equal(operatorOrders.total, 2)

    // Invalid query parameters are 400, not silently coerced.
    for (const query of [
      '?page=0',
      '?pageSize=1000',
      '?communityId=not-a-uuid',
      '?status=bogus',
      '?sourceType=bogus',
      '?page=abc',
    ]) {
      const response = await api(app, 'GET', `/admin/crm/leads${query}`, { session: admin })
      assert.equal(response.status, 400, `invalid query ${query} must be 400`)
    }
    for (const query of ['?page=0', '?status=bogus', '?businessType=bogus']) {
      const response = await api(app, 'GET', `/admin/crm/orders${query}`, { session: admin })
      assert.equal(response.status, 400, `invalid order query ${query} must be 400`)
    }

    // Filter options are scoped by role and include all enum values.
    const adminOptions = await api(app, 'GET', '/admin/crm/filter-options', { session: admin })
    assert.equal(adminOptions.status, 200)
    const adminBody = (await adminOptions.json()) as {
      communities: Array<{ id: string }>
      staff: Array<{ id: string }>
      businessTypes: string[]
      orderStatuses: string[]
    }
    assert.equal(adminBody.communities.length, 2)
    assert.ok(adminBody.staff.some((item) => item.id === gridAId))
    assert.deepEqual(adminBody.businessTypes, ['gd_mobile', 'gd_tv'])
    assert.equal(adminBody.orderStatuses.includes('confirmed'), true)

    const operatorOptionsResponse = await api(
      app,
      'GET',
      '/admin/crm/filter-options',
      { session: operator },
    )
    assert.equal(operatorOptionsResponse.status, 200)
    const operatorOptions = (await operatorOptionsResponse.json()) as {
      communities: Array<{ id: string }>
      staff: Array<{ id: string }>
    }
    assert.equal(operatorOptions.communities.length, 1)
    assert.equal(operatorOptions.communities[0]?.id, communityA)
    assert.equal(operatorOptions.staff.some((item) => item.id === gridAId), true)
  } finally {
    sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Audit append-only and privacy                                              */
/* -------------------------------------------------------------------------- */

test('domain events and audit rows are append-only and never contain sensitive values', async () => {
  const { app, db, sqlite } = testContext()
  try {
    const adminInfo = await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '审计社区')
    const gridId = await createStaffAccount(app, admin, {
      username: 'audit-grid',
      displayName: '审计网格员',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityId],
    })
    const grid2Id = await createStaffAccount(app, admin, {
      username: 'audit-grid2',
      displayName: '审计网格员 2',
      password: SECOND_GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityId],
    })
    await createStaffAccount(app, admin, {
      username: 'audit-operator',
      displayName: '审计运营',
      password: OPERATOR_PASSWORD,
      role: 'operator',
      communityIds: [communityId],
    })
    const grid = await staffSession(app, 'audit-grid', GRID_PASSWORD)
    const grid2 = await staffSession(app, 'audit-grid2', SECOND_GRID_PASSWORD)
    const operator = await staffSession(app, 'audit-operator', OPERATOR_PASSWORD)
    const activityId = seedActivity(db, communityId, adminInfo.userId, '审计活动')

    const lead = await createLead(app, grid, {
      ...leadPayload(communityId, {
        contactPhone: '13712345678',
        sourceType: 'activity',
        sourceActivityId: activityId,
      }),
    })
    const follow = await api(app, 'POST', `/crm/leads/${lead.id}/follow-ups`, {
      session: grid,
      body: { expectedUpdatedAt: lead.updatedAt, content: '首次上门沟通' },
    })
    assert.equal(follow.status, 201)
    const latest = (await follow.json()) as { lead: CrmLeadDetail }
    const transfer = await api(app, 'POST', `/crm/leads/${lead.id}/transfer`, {
      session: grid,
      body: {
        expectedUpdatedAt: latest.lead.updatedAt,
        toOwnerStaffId: grid2Id,
        reason: '按小区重新分配',
      },
    })
    assert.equal(transfer.status, 200)
    const transferred = (await transfer.json()) as CrmLeadDetail
    const order = await createOrder(app, grid2, {
      leadId: lead.id,
      orderNo: 'AUDIT-001',
      businessType: 'gd_mobile',
      contactPhone: '13712345678',
      evidenceRef: '核验截图 #42',
    })
    const pending = await sendOrderToVerification(app, grid2, order.id)
    const confirmed = await review(
      app,
      operator,
      order.id,
      pending.updatedAt,
      'confirm',
      '人工核验截图一致',
    )
    assert.equal(confirmed.status, 200)

    // Every write produced append-only domain events.
    const leadEvents = db
      .select()
      .from(crmLeadEvents)
      .where(eq(crmLeadEvents.leadId, lead.id))
      .all()
    const eventNames = leadEvents.map((event) => event.event)
    for (const expected of [
      'lead.created',
      'lead.follow_up_added',
      'lead.transferred',
      'lead.status_changed',
    ]) {
      assert.ok(eventNames.includes(expected), `missing lead event ${expected}`)
    }
    const orderEvents = db
      .select()
      .from(crmOrderEvents)
      .where(eq(crmOrderEvents.orderId, order.id))
      .all()
    assert.deepEqual(
      orderEvents.map((event) => event.event),
      ['order.created', 'order.status_changed', 'order.status_changed', 'order.reviewed'],
    )
    assert.equal(transferred.ownerStaff.id, grid2Id)
    assert.equal(lead.createdByStaff.id, gridId)

    // Audit rows cover creation, follow-up, transfer, order creation and review.
    const auditRows = db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, lead.id))
      .all()
    const auditEvents = auditRows.map((row) => row.event)
    for (const expected of [
      'crm.lead.created',
      'crm.follow_up.created',
      'crm.lead.transferred',
      'crm.lead.status_changed',
    ]) {
      assert.ok(auditEvents.includes(expected), `missing audit event ${expected}`)
    }
    const orderAudit = db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, order.id))
      .all()
      .map((row) => row.event)
    assert.ok(orderAudit.includes('crm.order.created'))
    assert.ok(orderAudit.includes('crm.order.confirmed'))

    const serializedAudit = JSON.stringify(
      db.select().from(auditLogs).all().map((row) => row.metadata),
    )
    for (const forbidden of [
      '13712345678',
      'Admin-Password',
      'Grid-Worker-Password',
      'll_session',
      'll_csrf',
      'openid',
      'passwordHash',
      'password_hash',
    ]) {
      assert.equal(
        serializedAudit.includes(forbidden),
        false,
        `audit metadata must not contain ${forbidden}`,
      )
    }

    // Append-only triggers reject UPDATE and DELETE even from application code.
    const firstLeadEvent = leadEvents[0]
    assert.ok(firstLeadEvent)
    assert.throws(
      () =>
        db
          .update(crmLeadEvents)
          .set({ note: 'rewritten' })
          .where(eq(crmLeadEvents.id, firstLeadEvent.id))
          .run(),
      /immutable/u,
    )
    assert.throws(
      () => db.delete(crmLeadEvents).where(eq(crmLeadEvents.id, firstLeadEvent.id)).run(),
      /immutable/u,
    )
    const firstOrderEvent = orderEvents[0]
    assert.ok(firstOrderEvent)
    assert.throws(
      () =>
        db
          .update(crmOrderEvents)
          .set({ note: 'rewritten' })
          .where(eq(crmOrderEvents.id, firstOrderEvent.id))
          .run(),
      /immutable/u,
    )
    assert.throws(
      () => db.delete(crmOrderEvents).where(eq(crmOrderEvents.id, firstOrderEvent.id)).run(),
      /immutable/u,
    )
    const followRow = db
      .select()
      .from(crmFollowUps)
      .where(eq(crmFollowUps.leadId, lead.id))
      .get()
    assert.ok(followRow)
    assert.throws(
      () =>
        db
          .update(crmFollowUps)
          .set({ content: 'rewritten' })
          .where(eq(crmFollowUps.id, followRow.id))
          .run(),
      /immutable/u,
    )
    assert.throws(
      () => db.delete(crmFollowUps).where(eq(crmFollowUps.id, followRow.id)).run(),
      /immutable/u,
    )

    // Timeline endpoints expose the complete order and lead events.
    const orderTimeline = await api(app, 'GET', `/admin/crm/orders/${order.id}/audit`, {
      session: operator,
    })
    assert.equal(orderTimeline.status, 200)
    const orderTimelineBody = (await orderTimeline.json()) as CrmOrderEventListResponse
    assert.deepEqual(
      orderTimelineBody.items.map((item) => item.event),
      ['order.created', 'order.status_changed', 'order.status_changed', 'order.reviewed'],
    )
    const leadTimeline = await api(app, 'GET', `/admin/crm/leads/${lead.id}/audit`, {
      session: operator,
    })
    assert.equal(leadTimeline.status, 200)
    const leadTimelineBody = (await leadTimeline.json()) as CrmLeadEventListResponse
    assert.ok(leadTimelineBody.items.some((item) => item.event === 'lead.transferred'))
    assert.equal(
      leadTimelineBody.items.find((item) => item.event === 'lead.transferred')?.note,
      '按小区重新分配',
    )
  } finally {
    sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Migration upgrade                                                          */
/* -------------------------------------------------------------------------- */

test('a pre-CRM database upgrades in place, keeps existing rows and becomes usable', async () => {
  const temp = withTempDir('ll-crm-upgrade-')
  try {
    const stagingFolder = join(temp.dir, 'migrations-before-crm')
    mkdirSync(join(stagingFolder, 'meta'), { recursive: true })
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: Array<{ tag: string }> }
    for (const file of ['0000_freezing_micromax.sql', '0001_oval_mulholland_black.sql']) {
      copyFileSync(join(migrationsFolder, file), join(stagingFolder, file))
    }
    writeFileSync(
      join(stagingFolder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }),
    )

    const databasePath = join(temp.dir, 'upgrade.sqlite')
    const legacy = createDatabase(databasePath, stagingFolder)
    const legacyCommunityId = randomUUID()
    const legacyUserId = randomUUID()
    const now = new Date()
    try {
      const crmTables = legacy.sqlite
        .prepare("SELECT count(*) AS value FROM sqlite_master WHERE type = 'table' AND name GLOB 'crm_*'")
        .get() as { value: number }
      assert.equal(crmTables.value, 0, 'the pre-CRM database has no CRM tables')
      legacy.db
        .insert(communities)
        .values({ id: legacyCommunityId, name: '升级前 CRM 社区', createdAt: now })
        .run()
      legacy.db
        .insert(users)
        .values({ id: legacyUserId, displayName: '升级前居民', createdAt: now, updatedAt: now })
        .run()
    } finally {
      legacy.sqlite.close()
    }

    const upgraded = createDatabase(databasePath, migrationsFolder)
    try {
      const preservedCommunity = upgraded.db
        .select()
        .from(communities)
        .where(eq(communities.id, legacyCommunityId))
        .get()
      assert.equal(preservedCommunity?.name, '升级前 CRM 社区')
      const crmTableCount = upgraded.sqlite
        .prepare("SELECT count(*) AS value FROM sqlite_master WHERE type = 'table' AND name GLOB 'crm_*'")
        .get() as { value: number }
      assert.equal(crmTableCount.value, 5)

      await createAdmin(upgraded.db)
      const app = createApp({
        db: upgraded.db,
        config: loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' }),
        logRequests: false,
      })
      const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
      await createStaffAccount(app, admin, {
        username: 'upgrade-grid',
        displayName: '升级网格员',
        password: GRID_PASSWORD,
        role: 'grid_worker',
        communityIds: [legacyCommunityId],
      })
      const grid = await staffSession(app, 'upgrade-grid', GRID_PASSWORD)
      const lead = await createLead(app, grid, leadPayload(legacyCommunityId))
      assert.equal(lead.community.id, legacyCommunityId)
      const order = await createOrder(app, grid, {
        leadId: lead.id,
        orderNo: 'UPGRADE-001',
        businessType: 'gd_tv',
      })
      assert.equal(order.status, 'submitted')
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    temp.cleanup()
  }
})
