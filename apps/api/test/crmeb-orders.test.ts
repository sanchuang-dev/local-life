import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { and, eq } from 'drizzle-orm'
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
import { createDatabase, type AppDatabase } from '../src/db/client.js'
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
    assert.equal(result.eventsAppended, 7)
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
    assert.equal(events.length, 7)
    assert.ok(events.some((event) => event.eventKey === 'refund:rf2001'))
    // Every event of an order has a strictly increasing per-order sequence.
    const sequencesByOrder = new Map<string, number[]>()
    for (const event of events) {
      const list = sequencesByOrder.get(event.orderId) ?? []
      list.push(event.sequence)
      sequencesByOrder.set(event.orderId, list)
    }
    for (const sequences of sequencesByOrder.values()) {
      assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b))
      // No gaps and no duplicates: revisions are exactly 1..n after retries.
      assert.deepEqual(
        sequences,
        Array.from({ length: sequences.length }, (_, index) => index + 1),
      )
    }

    const runs = db.select().from(crmebSyncRuns).all()
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.status, 'succeeded')
    assert.equal(runs[0]?.ordersScanned, 5)
    assert.equal(runs[0]?.validTransactions, 1)
    assert.equal(runs[0]?.eventsAppended, 7)
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
    assert.equal(db.select().from(crmebOrderEvents).all().length, 7)
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

interface EventRow {
  id: string
  orderId: string
  sequence: number
  eventKey: string
  payloadJson: string | null
}

function jsonOf(event: EventRow): Record<string, unknown> {
  return JSON.parse(event.payloadJson ?? '{}') as Record<string, unknown>
}

function orderStreamEvents(
  db: AppDatabase,
  orderId: string,
): EventRow[] {
  return db
    .select()
    .from(crmebOrderEvents)
    .where(
      and(
        eq(crmebOrderEvents.orderId, orderId),
        eq(crmebOrderEvents.eventKey, 'order'),
      ),
    )
    .orderBy(crmebOrderEvents.sequence)
    .all()
}

test('the order timeline appends paid → refunding → paid instead of swallowing repeated state combinations', async () => {
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
    const sync = async () => {
      const response = await api(app, 'POST', SYNC_PATH, { session: admin, body: {} })
      assert.equal(response.status, 200)
      return crmebOrderSyncResponseSchema.parse(await response.json())
    }
    const detail = simulated.options.orderDetails.cp1001!
    const cp1001 = () =>
      db
        .select()
        .from(crmebOrders)
        .where(eq(crmebOrders.externalOrderNo, 'cp1001'))
        .get()!

    const first = await sync()
    assert.equal(first.status, 'succeeded')
    const initial = orderStreamEvents(db, cp1001().id)
    assert.equal(initial.length, 1)
    assert.deepEqual(jsonOf(initial[0]!), {
      paid: true,
      rawStatus: 3,
      refundStatus: 0,
      status: 'completed',
      validTransaction: true,
      payAmountCents: 9_990,
      hasRefund: false,
      source: 'outapi_pull',
    })

    // paid → refunding (refund_status=1 wins over the raw status).
    detail.refund_status = 1
    const refundingRun = await sync()
    assert.equal(refundingRun.status, 'succeeded')
    const refunding = orderStreamEvents(db, cp1001().id)
    assert.equal(refunding.length, 2)
    assert.equal(jsonOf(refunding[1]!)['status'], 'refunding')
    assert.equal(jsonOf(refunding[1]!)['validTransaction'], false)
    assert.equal(cp1001().validTransaction, false)

    // Refund cancelled → the very same `paid/completed` combination as the
    // first observation must still be a new timeline row.
    detail.refund_status = 0
    const restoredRun = await sync()
    assert.equal(restoredRun.status, 'succeeded')
    const restored = orderStreamEvents(db, cp1001().id)
    assert.equal(restored.length, 3)
    assert.deepEqual(
      restored.map((event) => jsonOf(event)['status']),
      ['completed', 'refunding', 'completed'],
    )
    assert.deepEqual(
      restored.map((event) => jsonOf(event)['validTransaction']),
      [true, false, true],
    )
    assert.deepEqual(
      restored.map((event) => event.sequence),
      [1, 2, 3],
    )
    assert.equal(cp1001().validTransaction, true)

    // An identical fourth sync is still idempotent.
    const repeated = await sync()
    assert.equal(repeated.status, 'succeeded')
    assert.equal(repeated.eventsAppended, 0)
    assert.equal(orderStreamEvents(db, cp1001().id).length, 3)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('a refund amount change appends a new event while an unchanged resync stays idempotent', async () => {
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
    const sync = async () => {
      const response = await api(app, 'POST', SYNC_PATH, { session: admin, body: {} })
      assert.equal(response.status, 200)
      return crmebOrderSyncResponseSchema.parse(await response.json())
    }
    const orders = await sync()
    assert.equal(orders.status, 'succeeded')
    const order = db
      .select()
      .from(crmebOrders)
      .where(eq(crmebOrders.externalOrderNo, 'cp1004'))
      .get()!
    const refundEvents = () =>
      db
        .select()
        .from(crmebOrderEvents)
        .where(
          and(
            eq(crmebOrderEvents.orderId, order.id),
            eq(crmebOrderEvents.eventKey, 'refund:rf2001'),
          ),
        )
        .orderBy(crmebOrderEvents.sequence)
        .all()
    assert.equal(refundEvents().length, 1)

    // Same refund_type/status, only the amounts change.
    const refund = simulated.options.refunds[0]!
    refund.refund_price = '30.00'
    refund.refunded_price = '30.00'
    const changed = await sync()
    assert.equal(changed.status, 'succeeded')
    assert.equal(changed.refunds.updated, 1)
    assert.equal(changed.eventsAppended, 1)
    const afterChange = refundEvents()
    assert.equal(afterChange.length, 2)
    const refundSequences = afterChange.map((event) => event.sequence)
    assert.ok(refundSequences[1]! > refundSequences[0]!)
    // Sequence is per order, shared with the order-snapshot stream, so both
    // refund events also prove the unique (order_id, sequence) allocation.
    assert.equal(new Set(refundSequences).size, 2)
    const latest = jsonOf(afterChange[1]!)
    assert.equal(latest['refundType'], 6)
    assert.equal(latest['refundAmountCents'], 3_000)
    assert.equal(latest['refundedAmountCents'], 3_000)
    const mirror = db
      .select()
      .from(crmebRefunds)
      .where(eq(crmebRefunds.externalRefundNo, 'rf2001'))
      .get()
    assert.equal(mirror?.refundAmountCents, 3_000)
    assert.equal(mirror?.refundedAmountCents, 3_000)
    assert.equal(mirror?.refundType, 6)

    // Same snapshot again → no new refund event, but the refund stream has no gap.
    const unchanged = await sync()
    assert.equal(unchanged.status, 'succeeded')
    assert.equal(unchanged.refunds.unchanged, 1)
    assert.equal(unchanged.eventsAppended, 0)
    assert.equal(refundEvents().length, 2)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('an incomplete refund sweep revokes channel-wide stale valid transactions and recovery restores clean orders', async () => {
  const manyRefunds = Array.from({ length: 150 }, (_, index) => ({
    id: 8_500 + index,
    store_order_id: 9004,
    order_id: `rfwide-${String(index).padStart(3, '0')}`,
    refund_type: 5,
    refund_price: '1.00',
    add_time: 1_790_000_500 + index,
  }))
  const allOrders = SIMULATED_ORDER_LIST
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    orders: allOrders,
    orderDetails: SIMULATED_ORDER_DETAILS,
    refunds: manyRefunds,
  })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const sync = async (body: Record<string, unknown> = {}) => {
      const response = await api(app, 'POST', SYNC_PATH, { session: admin, body })
      assert.equal(response.status, 200)
      return crmebOrderSyncResponseSchema.parse(await response.json())
    }
    const orderByNo = (orderNo: string) =>
      db
        .select()
        .from(crmebOrders)
        .where(eq(crmebOrders.externalOrderNo, orderNo))
        .get()!

    const first = await sync()
    assert.equal(first.status, 'succeeded')
    assert.equal(orderByNo('cp1001').validTransaction, true)
    assert.equal(orderByNo('cp1004').validTransaction, false)

    // The next round does not contain cp1001 at all and starts on refund page 2,
    // so the sweep is incomplete: the previously valid order must be revoked.
    simulated.options.orders = []
    const incomplete = await sync({ refundPage: 2, refundLimit: 100 })
    assert.equal(incomplete.status, 'failed')
    assert.equal(incomplete.cursor.refunds.complete, false)
    assert.equal(incomplete.validTransactions, 0)
    const incompleteError = incomplete.errors.find(
      (error) => error.scope === 'refund' && error.code === 'refund_scan_incomplete',
    )
    assert.ok(incompleteError)
    assert.match(incompleteError.message, /1 条/)
    assert.equal(orderByNo('cp1001').validTransaction, false)
    const invalidatedRun = db.select().from(crmebSyncRuns).all().at(-1)!
    const invalidatedScope = JSON.parse(invalidatedRun.scopeJson ?? '{}') as {
      refundScanComplete?: boolean
      refundScanInvalidated?: number
    }
    assert.equal(invalidatedScope.refundScanComplete, false)
    assert.equal(invalidatedScope.refundScanInvalidated, 1)
    const revokedEvents = orderStreamEvents(db, orderByNo('cp1001').id)
    assert.equal(jsonOf(revokedEvents.at(-1)!)['validTransaction'], false)
    assert.equal(jsonOf(revokedEvents.at(-1)!)['reason'], 'refund_scan_incomplete')

    // A complete sweep that re-observes the clean order restores it and appends
    // a recovery event; the order with a refund_type>0 record stays excluded.
    simulated.options.orders = allOrders
    const recovered = await sync()
    assert.equal(recovered.status, 'succeeded')
    assert.equal(recovered.cursor.refunds.complete, true)
    assert.equal(orderByNo('cp1001').validTransaction, true)
    assert.equal(orderByNo('cp1004').validTransaction, false)
    const recoveryEvents = orderStreamEvents(db, orderByNo('cp1001').id)
    const recovery = jsonOf(recoveryEvents.at(-1)!)
    assert.equal(recovery['validTransaction'], true)
    assert.equal(recovery['reason'], undefined)

    // An upstream refund/list failure is also an incomplete sweep.
    simulated.options.orders = []
    simulated.options.refundListFailureStatus = 403
    const upstreamFailure = await sync()
    assert.equal(upstreamFailure.status, 'failed')
    assert.ok(
      upstreamFailure.errors.some(
        (error) => error.code === 'refund_scan_incomplete',
      ),
    )
    assert.equal(orderByNo('cp1001').validTransaction, false)

    // ... and a later complete run restores it again.
    simulated.options.orders = allOrders
    simulated.options.refundListFailureStatus = undefined
    const recoveredAgain = await sync()
    assert.equal(recoveredAgain.status, 'succeeded')
    assert.equal(orderByNo('cp1001').validTransaction, true)
    const finalEvents = orderStreamEvents(db, orderByNo('cp1001').id)
    const sequences = finalEvents.map((event) => event.sequence)
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right))
    assert.equal(new Set(sequences).size, sequences.length)
    assert.ok(sequences.length >= 5)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('migration 0005 upgrades a legacy event table in place and backfills deterministic sequences', () => {
  const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
  const tempRoot = mkdtempSync(join(tmpdir(), 'crmeb-0005-'))
  const legacyFolder = join(tempRoot, 'migrations-before-0005')
  const databasePath = join(tempRoot, 'legacy.sqlite')
  cpSync(migrationsFolder, legacyFolder, { recursive: true })
  const journalPath = join(legacyFolder, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number; tag: string; when: number }>
  }
  assert.ok(journal.entries.some((entry) => entry.tag.startsWith('0005_')))
  writeFileSync(
    journalPath,
    JSON.stringify({
      ...journal,
      entries: journal.entries.filter((entry) => !entry.tag.startsWith('0005_')),
    }),
  )

  const legacy = createDatabase(databasePath, legacyFolder)
  const now = Date.now()
  const orderId = 'legacy-order-1'
  try {
    legacy.sqlite
      .prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?,?,?,?)')
      .run('legacy-user', '旧库用户', now, now)
    legacy.sqlite
      .prepare(
        `INSERT INTO crmeb_orders (id, channel, external_order_id, external_order_no, pay_amount_cents, paid, status, raw_status, refund_status, valid_transaction, raw_hash, synced_at, created_at, updated_at)
         VALUES (?, 'crmeb', ?, ?, ?, 1, 'completed', 3, 0, 1, ?, ?, ?, ?)`,
      )
      .run(orderId, 9_901, 'legacy-cp1', 6_000, 'legacy-hash', now, now, now)
    const insertEvent = legacy.sqlite.prepare(
      'INSERT INTO crmeb_order_events (id, order_id, event_key, payload_hash, payload_json, occurred_at, created_at) VALUES (?,?,?,?,?,?,?)',
    )
    // Two rows share created_at=1000: the id tie-break decides their order.
    insertEvent.run('legacy-b', orderId, 'order:1:3:0', 'hash-b', '{"step":"paid"}', now, 1_000)
    insertEvent.run('legacy-a', orderId, 'order:1:-1:1', 'hash-a', '{"step":"refunding"}', now, 1_000)
    insertEvent.run('legacy-c', orderId, 'refund:legacy-rf:6', 'hash-c', '{"step":"refund"}', now, 2_000)
  } finally {
    legacy.sqlite.close()
  }

  const upgraded = createDatabase(databasePath, migrationsFolder)
  try {
    const rows = upgraded.sqlite
      .prepare(
        'SELECT id, sequence, payload_json FROM crmeb_order_events ORDER BY sequence',
      )
      .all() as Array<{ id: string; sequence: number; payload_json: string }>
    assert.deepEqual(
      rows.map((row) => [row.id, row.sequence]),
      [
        ['legacy-a', 1],
        ['legacy-b', 2],
        ['legacy-c', 3],
      ],
    )
    // History survived the in-place upgrade.
    assert.equal(rows.length, 3)

    const insertUpgraded = upgraded.sqlite.prepare(
      'INSERT INTO crmeb_order_events (id, order_id, sequence, event_key, payload_hash, payload_json, occurred_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    assert.throws(
      () =>
        insertUpgraded.run('legacy-dup', orderId, 2, 'order', 'x', '{}', now, now),
      /UNIQUE/,
    )
    assert.throws(
      () =>
        insertUpgraded.run('legacy-zero', orderId, 0, 'order', 'x', '{}', now, now),
      /positive integer/,
    )
    assert.throws(
      () =>
        upgraded.sqlite
          .prepare('UPDATE crmeb_order_events SET payload_hash = ? WHERE id = ?')
          .run('tampered', 'legacy-a'),
      /append-only/,
    )
    assert.throws(
      () =>
        upgraded.sqlite
          .prepare('DELETE FROM crmeb_order_events WHERE id = ?')
          .run('legacy-a'),
      /append-only/,
    )

    const indexes = upgraded.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'crmeb_order_events'")
      .all() as Array<{ name: string }>
    const indexNames = indexes.map((index) => index.name)
    assert.ok(indexNames.includes('crmeb_order_events_order_sequence_uq'))
    assert.ok(!indexNames.includes('crmeb_order_events_order_event_uq'))
  } finally {
    upgraded.sqlite.close()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('a fresh database applies every migration and exposes the sequenced event table', () => {
  const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
  const fresh = createDatabase(':memory:', migrationsFolder)
  try {
    const columns = fresh.sqlite
      .prepare('PRAGMA table_info(crmeb_order_events)')
      .all() as Array<{ name: string; notnull: number }>
    const sequence = columns.find((column) => column.name === 'sequence')
    assert.ok(sequence)
    assert.equal(sequence.notnull, 1)
    const indexes = fresh.sqlite
      .prepare("PRAGMA index_list(crmeb_order_events)")
      .all() as Array<{ name: string; unique: number }>
    const sequenced = indexes.find(
      (index) => index.name === 'crmeb_order_events_order_sequence_uq',
    )
    assert.ok(sequenced)
    assert.equal(sequenced.unique, 1)
  } finally {
    fresh.sqlite.close()
  }
})
