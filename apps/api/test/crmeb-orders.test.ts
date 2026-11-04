import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  crmebOrderSyncResponseSchema,
} from '@sanchuang-dev/local-life-contracts'
import {
  ADMIN_PASSWORD,
  GRID_PASSWORD,
  OPERATOR_PASSWORD,
  api,
  createCommunity,
  createStaffAccount,
  createTestContext,
  errorEnvelope,
  type App,
  residentSession,
  seedAdmin,
  staffSession,
} from './crmeb-test-helpers.js'
import {
  crmebIdentities,
  crmebOrderEvents,
  crmebOrders,
  crmebRefunds,
  crmebSyncRuns,
} from '../src/db/schema.js'
import type { AppDatabase } from '../src/db/client.js'
import {
  formatCrmebDateWindow,
  mapCrmebOrderStatus,
} from '../src/crmeb/orders.js'
import { startSimulatedCrmeb } from './crmeb-simulated-server.js'
import {
  SIMULATED_ORDER_DETAILS,
  SIMULATED_ORDER_LIST,
  SIMULATED_PRODUCTS,
  SIMULATED_REFUNDS,
} from './crmeb-fixtures.js'

const SYNC_PATH = '/admin/integrations/crmeb/orders/sync'

interface StaffFixture {
  admin: Awaited<ReturnType<typeof staffSession>>
  operator: Awaited<ReturnType<typeof staffSession>>
  gridWorker: Awaited<ReturnType<typeof staffSession>>
  communityId: string
}

async function staffFixture(app: App, db: AppDatabase): Promise<StaffFixture> {
  await seedAdmin(db)
  const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
  const communityId = await createCommunity(app, admin, '同步社区')
  await createStaffAccount(app, admin, {
    username: 'operator1',
    displayName: '运营员',
    password: OPERATOR_PASSWORD,
    role: 'operator',
    communityIds: [communityId],
  })
  await createStaffAccount(app, admin, {
    username: 'grid1',
    displayName: '网格员',
    password: GRID_PASSWORD,
    role: 'grid_worker',
    communityIds: [communityId],
  })
  return {
    admin,
    operator: await staffSession(app, 'operator1', OPERATOR_PASSWORD),
    gridWorker: await staffSession(app, 'grid1', GRID_PASSWORD),
    communityId,
  }
}

test('order status mapping follows the evidence whitelist and never guesses', () => {
  assert.equal(mapCrmebOrderStatus({ paid: true, status: 3, refundStatus: 0 }), 'completed')
  assert.equal(mapCrmebOrderStatus({ paid: true, status: 2, refundStatus: 0 }), 'received')
  assert.equal(mapCrmebOrderStatus({ paid: true, status: 1, refundStatus: 0 }), 'shipped')
  assert.equal(mapCrmebOrderStatus({ paid: true, status: 4, refundStatus: 0 }), 'shipped')
  assert.equal(mapCrmebOrderStatus({ paid: true, status: 0, refundStatus: 0 }), 'unshipped')
  assert.equal(mapCrmebOrderStatus({ paid: true, status: 3, refundStatus: 2 }), 'refunded')
  assert.equal(mapCrmebOrderStatus({ paid: true, status: -2, refundStatus: 0 }), 'refunded')
  assert.equal(mapCrmebOrderStatus({ paid: true, status: 3, refundStatus: 1 }), 'refunding')
  assert.equal(mapCrmebOrderStatus({ paid: true, status: 3, refundStatus: 3 }), 'partial_refund')
  assert.equal(mapCrmebOrderStatus({ paid: true, status: 3, refundStatus: 4 }), 'partial_refund')
  assert.equal(mapCrmebOrderStatus({ paid: false, status: 0, refundStatus: 0 }), 'unpaid')
  assert.equal(mapCrmebOrderStatus({ paid: true, status: 9, refundStatus: 0 }), 'unknown')
  // CRMEB's `data` window must not use hyphens inside the dates.
  const window = formatCrmebDateWindow(
    new Date('2026-01-02T03:04:05.000Z'),
    new Date('2026-01-03T04:05:06.000Z'),
  )
  assert.equal(window, '2026/01/02 03:04:05-2026/01/03 04:05:06')
  assert.equal(window.split('-').length, 2)
})

test('pull sync mirrors orders idempotently, excludes refunds/cancelled/unknown and audits the run', async () => {
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    orders: SIMULATED_ORDER_LIST,
    orderDetails: SIMULATED_ORDER_DETAILS,
    refunds: SIMULATED_REFUNDS,
  })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  const { db } = context
  try {
    const staff = await staffFixture(context.app, db)
    const resident = await residentSession(context.app, '绑定居民', staff.communityId)
    const binding = await api(context.app, 'POST', '/admin/integrations/crmeb/identities', {
      session: staff.admin,
      body: {
        platformUserId: resident.userId,
        crmebUid: 5001,
        verificationMethod: 'manual_verified',
      },
    })
    assert.equal(binding.status, 201)

    const first = await api(context.app, 'POST', SYNC_PATH, {
      session: staff.admin,
      body: { page: 1, limit: 50 },
    })
    assert.equal(first.status, 200)
    const firstText = await first.text()
    assert.ok(!firstText.includes('simulated-app-secret'))
    assert.ok(!firstText.includes('simulated-token'))
    const result = crmebOrderSyncResponseSchema.parse(JSON.parse(firstText))
    assert.equal(result.status, 'succeeded')
    assert.deepEqual(result.orders, {
      scanned: 5,
      created: 5,
      updated: 0,
      unchanged: 0,
      failed: 0,
    })
    assert.deepEqual(result.refunds, {
      scanned: 1,
      created: 1,
      updated: 0,
      unchanged: 0,
      unmatched: 0,
    })
    assert.equal(result.validTransactions, 1)
    assert.equal(result.eventsAppended, 6)
    assert.equal(result.cursor.lastExternalOrderNo, 'cp1005')
    assert.equal(
      result.cursor.lastAddTime,
      new Date((1_790_000_120) * 1_000).toISOString(),
    )
    assert.deepEqual(result.scope, {
      page: 1,
      limit: 50,
      sinceAddTime: null,
      refundPage: 1,
      refundLimit: 100,
      refundScan: 'mandatory',
      actorRole: 'admin',
    })
    assert.deepEqual(result.cursor.refunds, {
      page: 1,
      pageSize: 100,
      pagesScanned: 1,
      nextPage: null,
      hasMore: false,
      complete: true,
      lastExternalRefundNo: 'rf2001',
      lastRefundAddTime: new Date((1_790_000_200) * 1_000).toISOString(),
    })

    const orders = db.select().from(crmebOrders).all()
    assert.equal(orders.length, 5)
    const byNo = new Map(orders.map((order) => [order.externalOrderNo, order]))

    const completed = byNo.get('cp1001')!
    assert.equal(completed.status, 'completed')
    assert.equal(completed.paid, true)
    assert.equal(completed.validTransaction, true)
    assert.equal(completed.payAmountCents, 9_990)
    assert.equal(completed.platformUserId, resident.userId)
    assert.equal(completed.refundStatus, 0)

    const refunded = byNo.get('cp1002')!
    assert.equal(refunded.status, 'refunded')
    assert.equal(refunded.refundStatus, 2)
    assert.equal(refunded.validTransaction, false)

    const unpaid = byNo.get('cp1003')!
    assert.equal(unpaid.status, 'unpaid')
    assert.equal(unpaid.paid, false)
    assert.equal(unpaid.validTransaction, false)

    // List says completed, but the after-sale scan excludes it from valid sales.
    const afterSale = byNo.get('cp1004')!
    assert.equal(afterSale.status, 'completed')
    assert.equal(afterSale.paid, true)
    assert.equal(afterSale.validTransaction, false)

    const unknown = byNo.get('cp1005')!
    assert.equal(unknown.status, 'unknown')
    assert.equal(unknown.validTransaction, false)

    const refunds = db.select().from(crmebRefunds).all()
    assert.equal(refunds.length, 1)
    assert.equal(refunds[0]?.externalRefundNo, 'rf2001')
    assert.equal(refunds[0]?.externalOrderId, 9004)
    assert.equal(refunds[0]?.refundType, 6)
    assert.equal(refunds[0]?.refundAmountCents, 6_000)

    const events = db.select().from(crmebOrderEvents).all()
    assert.equal(events.length, 6)
    assert.ok(events.some((event) => event.eventKey === 'refund:rf2001:6'))

    const runs = db.select().from(crmebSyncRuns).all()
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.status, 'succeeded')
    assert.equal(runs[0]?.ordersScanned, 5)
    assert.equal(runs[0]?.validTransactions, 1)
    assert.equal(runs[0]?.eventsAppended, 6)
    assert.equal(runs[0]?.refundsUnmatched, 0)
    assert.equal(runs[0]?.trigger, 'admin_manual')
    assert.equal(runs[0]?.actorRole, 'admin')
    assert.equal(runs[0]?.actorUserId, staff.admin.userId)
    assert.deepEqual(JSON.parse(runs[0]?.cursorJson ?? '{}'), result.cursor)

    // A repeated run changes nothing and appends no event.
    const second = await api(context.app, 'POST', SYNC_PATH, {
      session: staff.admin,
      body: { page: 1, limit: 50 },
    })
    assert.equal(second.status, 200)
    const repeated = crmebOrderSyncResponseSchema.parse(await second.json())
    assert.equal(repeated.status, 'succeeded')
    assert.equal(repeated.orders.created, 0)
    assert.equal(repeated.orders.updated, 0)
    assert.equal(repeated.orders.unchanged, 5)
    assert.equal(repeated.refunds.created, 0)
    assert.equal(repeated.refunds.unchanged, 1)
    assert.equal(repeated.validTransactions, 1)
    assert.equal(repeated.eventsAppended, 0)
    assert.equal(db.select().from(crmebOrders).all().length, 5)
    assert.equal(db.select().from(crmebOrderEvents).all().length, 6)
    assert.equal(db.select().from(crmebSyncRuns).all().length, 2)

    // The event table is append-only at the database level.
    const eventId = events[0]!.id
    assert.throws(
      () =>
        db
          .update(crmebOrderEvents)
          .set({ payloadHash: 'tampered' })
          .where(eq(crmebOrderEvents.id, eventId))
          .run(),
      /append-only/,
    )
    assert.throws(
      () => db.delete(crmebOrderEvents).where(eq(crmebOrderEvents.id, eventId)).run(),
      /append-only/,
    )
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('order sync requires staff session, CSRF and an allowed role', async () => {
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    orders: SIMULATED_ORDER_LIST,
    orderDetails: SIMULATED_ORDER_DETAILS,
    refunds: SIMULATED_REFUNDS,
  })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  const { db, app } = context
  try {
    const staff = await staffFixture(app, db)

    const anonymous = await app.request(SYNC_PATH, { method: 'POST' })
    assert.equal(anonymous.status, 401)

    const noCsrf = await api(app, 'POST', SYNC_PATH, {
      session: staff.admin,
      body: {},
      csrf: false,
    })
    assert.equal(noCsrf.status, 403)
    assert.equal((await errorEnvelope(noCsrf)).error.code, API_ERROR_CODES.forbidden)

    const grid = await api(app, 'POST', SYNC_PATH, {
      session: staff.gridWorker,
      body: {},
    })
    assert.equal(grid.status, 403)
    assert.equal((await errorEnvelope(grid)).error.code, API_ERROR_CODES.forbidden)

    const operator = await api(app, 'POST', SYNC_PATH, {
      session: staff.operator,
      body: {},
    })
    assert.equal(operator.status, 403)
    assert.equal((await errorEnvelope(operator)).error.code, API_ERROR_CODES.forbidden)

    const refusedToggle = await api(app, 'POST', SYNC_PATH, {
      session: staff.admin,
      body: { includeRefunds: false },
    })
    assert.equal(refusedToggle.status, 400)
    assert.equal(
      (await errorEnvelope(refusedToggle)).error.code,
      API_ERROR_CODES.invalidRequest,
    )

    const invalid = await api(app, 'POST', SYNC_PATH, {
      session: staff.admin,
      body: { limit: 0 },
    })
    assert.equal(invalid.status, 400)
    assert.equal(
      (await errorEnvelope(invalid)).error.code,
      API_ERROR_CODES.invalidRequest,
    )

    const extractionAttempt = await api(app, 'POST', SYNC_PATH, {
      session: staff.admin,
      body: { page: 1, confirmed: true },
    })
    assert.equal(extractionAttempt.status, 400)

    assert.equal(db.select().from(crmebSyncRuns).all().length, 0)

    const allowed = await api(app, 'POST', SYNC_PATH, {
      session: staff.admin,
      body: {},
    })
    assert.equal(allowed.status, 200)
    assert.equal(db.select().from(crmebSyncRuns).all().length, 1)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('refund/list is paged to exhaustion and the refund cursor is persisted', async () => {
  const manyRefunds = Array.from({ length: 150 }, (_, index) => ({
    id: 8_000 + index,
    store_order_id: 9004,
    order_id: `rfpage-${String(index).padStart(3, '0')}`,
    refund_type: 5,
    refund_price: '1.00',
    refunded_price: '1.00',
    add_time: 1_790_000_300 + index,
  }))
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    orders: SIMULATED_ORDER_LIST,
    orderDetails: SIMULATED_ORDER_DETAILS,
    refunds: manyRefunds,
  })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const response = await api(app, 'POST', SYNC_PATH, { session: admin, body: {} })
    assert.equal(response.status, 200)
    const result = crmebOrderSyncResponseSchema.parse(await response.json())
    assert.equal(result.status, 'succeeded')
    assert.equal(result.refunds.scanned, 150)
    assert.equal(result.refunds.created, 150)
    assert.equal(result.refunds.unmatched, 0)
    assert.equal(result.validTransactions, 1)
    assert.deepEqual(result.cursor.refunds, {
      page: 2,
      pageSize: 100,
      pagesScanned: 2,
      nextPage: null,
      hasMore: false,
      complete: true,
      lastExternalRefundNo: 'rfpage-149',
      lastRefundAddTime: new Date((1_790_000_300 + 149) * 1_000).toISOString(),
    })
    assert.equal(db.select().from(crmebRefunds).all().length, 150)

    const refundRequests = simulated.requests.filter(
      (request) => request.path === '/outapi/refund/list',
    )
    assert.deepEqual(
      refundRequests.map((request) => new URLSearchParams(request.search).get('page')),
      ['1', '2'],
    )
    const run = db.select().from(crmebSyncRuns).all()[0]
    assert.deepEqual(JSON.parse(run?.cursorJson ?? '{}'), result.cursor)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('an incomplete refund sweep can never leave orders counted as valid sales', async () => {
  const manyRefunds = Array.from({ length: 150 }, (_, index) => ({
    id: 8_100 + index,
    store_order_id: 9004,
    order_id: `rfpartial-${String(index).padStart(3, '0')}`,
    refund_type: 5,
    refund_price: '1.00',
    add_time: 1_790_000_400 + index,
  }))
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    orders: SIMULATED_ORDER_LIST,
    orderDetails: SIMULATED_ORDER_DETAILS,
    refunds: manyRefunds,
  })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    // Starting at page 2 skips page 1, so the sweep is intentionally incomplete.
    const response = await api(app, 'POST', SYNC_PATH, {
      session: admin,
      body: { refundPage: 2, refundLimit: 100 },
    })
    assert.equal(response.status, 200)
    const result = crmebOrderSyncResponseSchema.parse(await response.json())
    assert.equal(result.status, 'failed')
    assert.equal(result.refunds.scanned, 50)
    assert.equal(result.cursor.refunds.complete, false)
    assert.equal(result.validTransactions, 0)
    assert.ok(
      result.errors.some(
        (error) => error.scope === 'refund' && error.code === 'refund_scan_incomplete',
      ),
    )
    const completed = db
      .select()
      .from(crmebOrders)
      .where(eq(crmebOrders.externalOrderNo, 'cp1001'))
      .get()
    assert.equal(completed?.validTransaction, false)
    const run = db.select().from(crmebSyncRuns).all()[0]
    assert.equal(run?.status, 'failed')
    assert.equal(run?.validTransactions, 0)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('a changed numeric id for the same order_id is rejected and keeps the old row', async () => {
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    orders: SIMULATED_ORDER_LIST,
    orderDetails: SIMULATED_ORDER_DETAILS,
    refunds: SIMULATED_REFUNDS,
  })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const first = await api(app, 'POST', SYNC_PATH, { session: admin, body: {} })
    assert.equal(first.status, 200)
    const before = db
      .select()
      .from(crmebOrders)
      .where(eq(crmebOrders.externalOrderNo, 'cp1001'))
      .get()
    assert.equal(before?.externalOrderId, 9001)

    // CRMEB now returns a different numeric id for the same business number.
    simulated.options.orderDetailIdOverrides.cp1001 = 9_101
    const second = await api(app, 'POST', SYNC_PATH, { session: admin, body: {} })
    assert.equal(second.status, 200)
    const result = crmebOrderSyncResponseSchema.parse(await second.json())
    assert.equal(result.status, 'failed')
    assert.equal(result.orders.failed, 1)
    assert.ok(
      result.errors.some(
        (error) =>
          error.scope === 'order' &&
          error.externalOrderNo === 'cp1001' &&
          error.code === 'contract_mismatch',
      ),
    )
    const after = db
      .select()
      .from(crmebOrders)
      .where(eq(crmebOrders.externalOrderNo, 'cp1001'))
      .get()
    assert.equal(after?.externalOrderId, 9001)
    assert.equal(after?.rawHash, before?.rawHash)
    assert.equal(db.select().from(crmebOrders).all().length, 5)
    const runs = db.select().from(crmebSyncRuns).all()
    assert.equal(runs.length, 2)
    assert.equal(runs[1]?.status, 'failed')
    assert.ok((runs[1]?.errorsJson ?? '').includes('cp1001'))
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('unconfigured adapter blocks order sync with not_configured', async () => {
  const context = createTestContext()
  try {
    await seedAdmin(context.db)
    const admin = await staffSession(context.app, 'admin', ADMIN_PASSWORD)
    const response = await api(context.app, 'POST', SYNC_PATH, {
      session: admin,
      body: {},
    })
    assert.equal(response.status, 503)
    assert.equal((await errorEnvelope(response)).error.code, API_ERROR_CODES.notConfigured)
    assert.equal(context.db.select().from(crmebSyncRuns).all().length, 0)
  } finally {
    context.sqlite.close()
  }
})

test('upstream list failures fail the run audit and remain retryable', async () => {
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    orders: SIMULATED_ORDER_LIST,
    orderDetails: SIMULATED_ORDER_DETAILS,
    orderListFailureStatus: 403,
  })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const response = await api(app, 'POST', SYNC_PATH, { session: admin, body: {} })
    assert.equal(response.status, 503)
    const body = await errorEnvelope(response)
    assert.equal(body.error.code, API_ERROR_CODES.crmebUpstreamError)
    assert.match(body.error.message, /对外接口/)

    const runs = db.select().from(crmebSyncRuns).all()
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.status, 'failed')
    assert.ok((runs[0]?.errorMessage ?? '').length > 0)
    assert.equal(db.select().from(crmebOrders).all().length, 0)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('a single broken order is recorded as a failed item without hiding the rest', async () => {
  const list = [...SIMULATED_ORDER_LIST]
  const details = { ...SIMULATED_ORDER_DETAILS }
  delete details.cp1002
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    orders: list,
    orderDetails: details,
    refunds: SIMULATED_REFUNDS,
  })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const response = await api(app, 'POST', SYNC_PATH, { session: admin, body: {} })
    assert.equal(response.status, 200)
    const result = crmebOrderSyncResponseSchema.parse(await response.json())
    assert.equal(result.status, 'failed')
    assert.equal(result.orders.scanned, 5)
    assert.equal(result.orders.created, 4)
    assert.equal(result.orders.failed, 1)
    assert.equal(result.errors[0]?.externalOrderNo, 'cp1002')
    assert.equal(result.errors[0]?.code, 'not_found')
    assert.equal(db.select().from(crmebOrders).all().length, 4)

    const runs = db.select().from(crmebSyncRuns).all()
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.status, 'failed')
    assert.ok((runs[0]?.errorsJson ?? '').includes('cp1002'))
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('overlapping sync requests are rejected instead of double-accounting', async () => {
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    orders: SIMULATED_ORDER_LIST,
    orderDetails: SIMULATED_ORDER_DETAILS,
    refunds: SIMULATED_REFUNDS,
  })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const responses = await Promise.all([
      api(app, 'POST', SYNC_PATH, { session: admin, body: {} }),
      api(app, 'POST', SYNC_PATH, { session: admin, body: {} }),
    ])
    const statuses = responses.map((response) => response.status).sort()
    assert.deepEqual(statuses, [200, 409])
    const conflict = responses.find((response) => response.status === 409)
    assert.ok(conflict)
    assert.equal(
      (await errorEnvelope(conflict)).error.code,
      API_ERROR_CODES.crmebSyncInProgress,
    )
    assert.equal(db.select().from(crmebOrders).all().length, 5)
    assert.equal(db.select().from(crmebSyncRuns).all().length, 1)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('identity bindings written by the admin endpoint are used by order sync', async () => {
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    orders: SIMULATED_ORDER_LIST,
    orderDetails: SIMULATED_ORDER_DETAILS,
    refunds: SIMULATED_REFUNDS,
  })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  const { db } = context
  try {
    const staff = await staffFixture(context.app, db)
    const resident = await residentSession(context.app, '映射居民', staff.communityId)
    const identity = await api(context.app, 'POST', '/admin/integrations/crmeb/identities', {
      session: staff.admin,
      body: {
        platformUserId: resident.userId,
        crmebUid: 5002,
        verificationMethod: 'manual_verified',
      },
    })
    assert.equal(identity.status, 201)

    const response = await api(context.app, 'POST', SYNC_PATH, {
      session: staff.admin,
      body: {},
    })
    assert.equal(response.status, 200)
    const order = db
      .select()
      .from(crmebOrders)
      .where(eq(crmebOrders.externalOrderNo, 'cp1002'))
      .get()
    assert.equal(order?.platformUserId, resident.userId)
    assert.equal(db.select().from(crmebIdentities).all().length, 1)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})
