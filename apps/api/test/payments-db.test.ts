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
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  communities,
  ledgerEntries,
  localOrders,
  localProducts,
  paymentAttempts,
  paymentEvents,
  paymentIntents,
  reconciliationBatches,
  users,
} from '../src/db/schema.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const NOW = new Date('2026-11-16T02:00:00.000Z')
const LATER = new Date('2026-11-16T02:05:00.000Z')

interface World {
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  communityA: string
  communityB: string
  residentA: string
  residentB: string
  productA: string
  orderA: string
  productZero: string
  orderZero: string
}

function uuid(): string {
  return randomUUID()
}

function seedWorld(db: AppDatabase): Omit<World, 'sqlite'> {
  const communityA = uuid()
  const communityB = uuid()
  const residentA = uuid()
  const residentB = uuid()
  const productA = uuid()
  const orderA = uuid()
  const productZero = uuid()
  const orderZero = uuid()
  db.insert(communities).values([
    { id: communityA, name: '支付片区 A', createdAt: NOW },
    { id: communityB, name: '支付片区 B', createdAt: NOW },
  ]).run()
  db.insert(users).values([
    { id: residentA, displayName: '支付居民 A', createdAt: NOW, updatedAt: NOW },
    { id: residentB, displayName: '支付居民 B', createdAt: NOW, updatedAt: NOW },
  ]).run()
  db.insert(localProducts).values([
    {
      id: productA,
      communityId: communityA,
      name: '支付测试商品',
      unitPriceCents: 3980,
      status: 'on_shelf',
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: productZero,
      communityId: communityA,
      name: '零元测试商品',
      unitPriceCents: 0,
      status: 'on_shelf',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]).run()
  db.insert(localOrders).values({
    id: orderA,
    communityId: communityA,
    productId: productA,
    residentUserId: residentA,
    idempotencyKey: `pay-test-${orderA}`,
    status: 'registered',
    recordSource: 'resident',
    productName: '支付测试商品',
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
  db.insert(localOrders).values({
    id: orderZero,
    communityId: communityA,
    productId: productZero,
    residentUserId: residentA,
    idempotencyKey: `pay-zero-${orderZero}`,
    status: 'registered',
    recordSource: 'resident',
    productName: '零元测试商品',
    unitPriceCents: 0,
    quantity: 1,
    totalCents: 0,
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
  return {
    db,
    communityA,
    communityB,
    residentA,
    residentB,
    productA,
    orderA,
    productZero,
    orderZero,
  }
}

function intentRow(world: World, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    localOrderId: world.orderA,
    residentUserId: world.residentA,
    communityId: world.communityA,
    kind: 'channel' as const,
    channel: 'wechat_jsapi' as const,
    simulated: false,
    merchantOrderNo: `PAY-${uuid()}`,
    merchantAppId: null,
    merchantId: null,
    grossAmountCents: 3980,
    discountCents: 0,
    netPayableCents: 3980,
    status: 'pending' as const,
    idempotencyKey: `pay-create-${uuid()}`,
    expiresAt: LATER,
    paidAt: null,
    closedAt: null,
    failedAt: null,
    failureCode: null,
    failureMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function attemptRow(intentId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    paymentIntentId: intentId,
    attemptNo: 1,
    status: 'pending' as const,
    idempotencyKey: `attempt-${uuid()}`,
    providerTransactionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    confirmedAt: null,
    closedAt: null,
    failedAt: null,
    failureCode: null,
    failureMessage: null,
    ...overrides,
  }
}

function context() {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const world = seedWorld(db)
  return { ...world, sqlite }
}

test('payment DDL enforces amounts, ownership, uniqueness and one paid fact', () => {
  const world = context()
  try {
    const { db } = world

    const valid = intentRow(world)
    db.insert(paymentIntents).values(valid).run()
    assert.equal(db.select().from(paymentIntents).all().length, 1)

    // Merchant order number and create idempotency key are unique.
    assert.throws(() => db.insert(paymentIntents).values({
      ...intentRow(world),
      merchantOrderNo: valid.merchantOrderNo,
    }).run())
    assert.throws(() => db.insert(paymentIntents).values({
      ...intentRow(world),
      idempotencyKey: valid.idempotencyKey,
    }).run())

    // Negative, float, overflow and conservation failures are rejected by SQLite.
    for (const patch of [
      { grossAmountCents: -1, discountCents: 0, netPayableCents: -1 },
      { grossAmountCents: 3980.5, discountCents: 0, netPayableCents: 3980.5 },
      {
        grossAmountCents: 9007199254740992,
        discountCents: 0,
        netPayableCents: 9007199254740992,
      },
      { grossAmountCents: 3980, discountCents: 0, netPayableCents: 3981 },
    ]) {
      assert.throws(() => db.insert(paymentIntents).values(intentRow(world, patch)).run())
    }

    // Amounts must equal the local order snapshot, not just be internally valid.
    assert.throws(() => db.insert(paymentIntents).values(intentRow(world, {
      grossAmountCents: 3981,
      discountCents: 0,
      netPayableCents: 3981,
    })).run())

    // The composite reference rejects another user's/community's order identity.
    assert.throws(() => db.insert(paymentIntents).values(intentRow(world, {
      residentUserId: world.residentB,
    })).run())
    assert.throws(() => db.insert(paymentIntents).values(intentRow(world, {
      communityId: world.communityB,
    })).run())

    // Zero amount is a distinct non-channel, paid completion.
    db.insert(paymentIntents).values(intentRow(world, {
      kind: 'zero_amount',
      localOrderId: world.orderZero,
      channel: null,
      simulated: false,
      grossAmountCents: 0,
      discountCents: 0,
      netPayableCents: 0,
      status: 'paid',
      paidAt: LATER,
    })).run()
    assert.throws(() => db.insert(paymentIntents).values(intentRow(world, {
      kind: 'zero_amount',
      localOrderId: world.orderZero,
      channel: null,
      simulated: false,
      grossAmountCents: 0,
      discountCents: 0,
      netPayableCents: 1,
      status: 'paid',
      paidAt: LATER,
    })).run())

    // At most one paid intent per business order.
    db.insert(paymentIntents).values(intentRow(world, {
      status: 'paid',
      paidAt: LATER,
    })).run()
    assert.throws(() => db.insert(paymentIntents).values(intentRow(world, {
      status: 'paid',
      paidAt: LATER,
    })).run())

    // Provider transaction id and paid attempts are unique.
    const paidIntent = db.select().from(paymentIntents)
      .where(eq(paymentIntents.status, 'paid')).all()
      .find((row) => row.kind === 'channel')!
    assert.throws(() => db.update(paymentIntents).set({ paidAt: NOW })
      .where(eq(paymentIntents.id, paidIntent.id)).run())
    const firstAttempt = attemptRow(paidIntent.id, {
      status: 'paid',
      providerTransactionId: 'wx-txn-unique-1',
      confirmedAt: LATER,
      updatedAt: LATER,
    })
    db.insert(paymentAttempts).values(firstAttempt).run()
    const otherIntent = intentRow(world)
    db.insert(paymentIntents).values(otherIntent).run()
    assert.throws(() => db.insert(paymentAttempts).values(attemptRow(otherIntent.id, {
      status: 'paid',
      providerTransactionId: 'wx-txn-unique-1',
      confirmedAt: LATER,
      updatedAt: LATER,
    })).run(), 'provider transaction ids are globally unique')
    assert.throws(() => db.insert(paymentAttempts).values(attemptRow(paidIntent.id, {
      status: 'paid',
      providerTransactionId: 'wx-txn-unique-2',
      confirmedAt: LATER,
      updatedAt: LATER,
    })).run())
    assert.throws(() => db.insert(paymentAttempts).values(attemptRow(paidIntent.id, {
      status: 'paid',
      providerTransactionId: 'wx-txn-unique-1',
      confirmedAt: LATER,
      updatedAt: LATER,
    })).run())
  } finally {
    world.sqlite.close()
  }
})

test('payment/attempt status transitions and immutable snapshots are enforced in SQLite', () => {
  const world = context()
  try {
    const { db } = world
    const intent = intentRow(world)
    db.insert(paymentIntents).values(intent).run()

    db.update(paymentIntents).set({ status: 'confirming', updatedAt: LATER })
      .where(eq(paymentIntents.id, intent.id)).run()
    assert.throws(() => db.update(paymentIntents).set({ status: 'pending', updatedAt: LATER })
      .where(eq(paymentIntents.id, intent.id)).run())
    assert.throws(() => db.update(paymentIntents).set({ grossAmountCents: 1 })
      .where(eq(paymentIntents.id, intent.id)).run())

    const closed = intentRow(world, {
      status: 'closed',
      closedAt: LATER,
    })
    db.insert(paymentIntents).values(closed).run()
    assert.throws(() => db.update(paymentIntents).set({
      status: 'paid',
      paidAt: LATER,
      updatedAt: LATER,
    }).where(eq(paymentIntents.id, closed.id)).run())

    const attempt = attemptRow(intent.id)
    db.insert(paymentAttempts).values(attempt).run()
    db.update(paymentAttempts).set({
      status: 'paid',
      providerTransactionId: 'wx-txn-transition-1',
      confirmedAt: LATER,
      updatedAt: LATER,
    }).where(eq(paymentAttempts.id, attempt.id)).run()
    assert.throws(() => db.update(paymentAttempts).set({
      status: 'pending',
      updatedAt: LATER,
    }).where(eq(paymentAttempts.id, attempt.id)).run())
    assert.throws(() => db.update(paymentAttempts).set({
      providerTransactionId: 'wx-txn-replaced',
    }).where(eq(paymentAttempts.id, attempt.id)).run())
    assert.throws(() => db.update(paymentAttempts).set({
      confirmedAt: NOW,
    }).where(eq(paymentAttempts.id, attempt.id)).run())

    assert.throws(() => db.delete(paymentIntents)
      .where(eq(paymentIntents.id, intent.id)).run())
    assert.throws(() => db.delete(paymentAttempts)
      .where(eq(paymentAttempts.id, attempt.id)).run())
  } finally {
    world.sqlite.close()
  }
})

test('payment events are append-only and cannot cross-link another intent attempt', () => {
  const world = context()
  try {
    const { db } = world
    const first = intentRow(world)
    const second = intentRow(world)
    db.insert(paymentIntents).values([first, second]).run()
    const firstAttempt = attemptRow(first.id)
    const secondAttempt = attemptRow(second.id)
    db.insert(paymentAttempts).values([firstAttempt, secondAttempt]).run()

    const event = {
      id: uuid(),
      paymentIntentId: first.id,
      paymentAttemptId: firstAttempt.id,
      eventType: 'payment.attempt_created' as const,
      source: 'system' as const,
      fromStatus: null,
      toStatus: 'pending' as const,
      providerEventRef: null,
      dedupeKey: `event-${uuid()}`,
      note: null,
      createdAt: NOW,
    }
    db.insert(paymentEvents).values(event).run()
    assert.equal(db.select().from(paymentEvents).all().length, 1)
    assert.throws(() => db.insert(paymentEvents).values({
      ...event,
      id: uuid(),
    }).run(), 'the event dedupe key is unique')

    assert.throws(() => db.insert(paymentEvents).values({
      ...event,
      id: uuid(),
      dedupeKey: `event-${uuid()}`,
      paymentAttemptId: secondAttempt.id,
    }).run())

    assert.throws(() => db.update(paymentEvents).set({ note: 'changed' })
      .where(eq(paymentEvents.id, event.id)).run())
    assert.throws(() => db.delete(paymentEvents)
      .where(eq(paymentEvents.id, event.id)).run())
  } finally {
    world.sqlite.close()
  }
})

test('a pre-payment database upgrades in place without changing historical orders or ledger rows', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-payments-upgrade-'))
  let upgraded: ReturnType<typeof createDatabase> | null = null
  try {
    const staging = join(tempDir, 'migrations-before-payments')
    mkdirSync(join(staging, 'meta'), { recursive: true })
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: Array<{ idx: number; tag: string }> }
    const before = journal.entries.filter((entry) => entry.idx <= 30)
    for (const entry of before) {
      copyFileSync(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(staging, `${entry.tag}.sql`),
      )
    }
    writeFileSync(
      join(staging, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: before }),
    )

    const databasePath = join(tempDir, 'upgrade.sqlite')
    const legacy = createDatabase(databasePath, staging)
    const communityId = uuid()
    const residentId = uuid()
    const productId = uuid()
    const orderId = uuid()
    const batchId = uuid()
    const ledgerId = uuid()
    try {
      legacy.sqlite.prepare(
        'INSERT INTO communities (id, name, created_at) VALUES (?, ?, ?)',
      ).run(communityId, '升级前支付片区', NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run(residentId, '升级前居民', NOW.getTime(), NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO local_products (id, community_id, name, unit_price_cents, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(productId, communityId, '升级前商品', 1000, 'on_shelf', NOW.getTime(), NOW.getTime())
      legacy.sqlite.prepare(
        `INSERT INTO local_orders (
          id, community_id, product_id, resident_user_id, idempotency_key, status,
          record_source, product_name, unit_price_cents, quantity, total_cents,
          coupon_discount_cents, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        orderId, communityId, productId, residentId, `legacy-${orderId}`, 'registered',
        'resident', '升级前商品', 1000, 1, 1000, 0, NOW.getTime(), NOW.getTime(),
      )
      legacy.sqlite.prepare(
        `INSERT INTO reconciliation_batches (
          id, batch_no, period_from, period_to, status, locked_at, locked_by_user_id,
          entry_count, total_cents, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        batchId, `LEGACY-${batchId.slice(0, 8)}`, '2026-11-01', '2026-11-15',
        'locked', NOW.getTime(), residentId, 0, 0, NOW.getTime(), NOW.getTime(),
      )
      legacy.sqlite.prepare(
        `INSERT INTO ledger_entries (
          id, fact_kind, source_system, source_id, source_display_no, community_id,
          product_id, attribution_state, attribution_basis, amount_cents,
          settlement_amount_status, occurred_at, evidence_kind, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ledgerId, 'order_registered', 'local_order', orderId, orderId, communityId,
        productId, 'pending', 'no_explicit_attribution', 1000,
        'pending_rule', NOW.getTime(), 'none', NOW.getTime(),
      )
      const paymentTables = legacy.sqlite.prepare(
        "SELECT count(*) AS value FROM sqlite_master WHERE type='table' AND name LIKE 'payment_%'",
      ).get() as { value: number }
      assert.equal(paymentTables.value, 0)
    } finally {
      legacy.sqlite.close()
    }

    upgraded = createDatabase(databasePath, migrationsFolder)
    const db = upgraded.db
    assert.equal(db.select().from(localOrders).all().length, 1, 'historical order preserved')
    assert.equal(db.select().from(ledgerEntries).all().length, 1, 'historical ledger preserved')
    const preservedBatch = db.select().from(reconciliationBatches).all()
    assert.equal(preservedBatch.length, 1, 'locked batch preserved')
    assert.equal(preservedBatch[0]?.status, 'locked')
    assert.equal(db.select().from(paymentIntents).all().length, 0)
    assert.equal(db.select().from(paymentAttempts).all().length, 0)
    assert.equal(db.select().from(paymentEvents).all().length, 0)
    const order = db.select().from(localOrders).where(eq(localOrders.id, orderId)).get()
    assert.equal(order?.communityId, communityId)
    assert.equal(order?.residentUserId, residentId)
    const ledger = db.select().from(ledgerEntries).where(eq(ledgerEntries.id, ledgerId)).get()
    assert.equal(ledger?.amountCents, 1000)
  } finally {
    upgraded?.sqlite.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})
