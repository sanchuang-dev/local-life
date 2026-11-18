import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import {
  ledgerOverviewSchema,
  type LedgerEntry,
  type LedgerOverview,
} from '@sanchuang-dev/local-life-contracts'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activities,
  activityInvitations,
  activityParticipations,
  activityRuleVersions,
  activityTeams,
  communities,
  couponIssues,
  couponTeamGrants,
  ledgerEntries,
  localOrderOnlineCompletions,
  localOrders,
  localProducts,
  paymentIntents,
  staffAccounts,
  staffCommunityAssignments,
  users,
} from '../src/db/schema.js'
import {
  buildReconciliationCsv,
  createBatch,
  getBatchEntries,
  lockBatch,
} from '../src/ledger/reconciliation-service.js'
import {
  getLedgerOverview,
  listLedgerEntries,
} from '../src/ledger/shared.js'
import {
  recordPayment,
  reversePayment,
  syncLedgerFacts,
  projectOnlineCompletionsToLedger,
} from '../src/ledger/service.js'
import { getMyPurchaseRewardProgress } from '../src/purchase-reward/service.js'
import { runPaymentOutboxConsumer } from '../src/payments/outbox.js'
import type { LocalActor } from '../src/local/shared.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const NOW = new Date('2026-11-18T02:00:00.000Z')
const PERIOD_FROM = '2026-11-18'
const PERIOD_TO = '2026-11-18'

interface World {
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  communityId: string
  productId: string
  adminUserId: string
  adminStaffId: string
  residentId: string
  plan: { thresholdCents: number; couponFaceValueCents: number; maxRewardedTeams: number } | null
  activityId: string
  teamId: string
  memberIds: string[]
  couponId: string | null
}

function actor(userId: string, role: LocalActor['role'] = 'admin', staffId: string | null = null): LocalActor {
  return { userId, staffId, role }
}

function makeWorld(options: {
  withTeam?: boolean
  couponDiscountCents?: number
  databasePath?: string
} = {}): World {
  const { db, sqlite } = createDatabase(options.databasePath ?? ':memory:', migrationsFolder)
  const communityId = randomUUID()
  const productId = randomUUID()
  const adminUserId = randomUUID()
  const adminStaffId = randomUUID()
  const residentId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '线上账本片区', createdAt: NOW }).run()
  db.insert(users).values([
    { id: adminUserId, displayName: '账本管理员', createdAt: NOW, updatedAt: NOW },
    { id: residentId, displayName: '线上账本居民', createdAt: NOW, updatedAt: NOW },
  ]).run()
  db.insert(staffAccounts).values({
    id: adminStaffId,
    userId: adminUserId,
    username: `admin-${adminStaffId}`,
    passwordHash: 'not-used',
    role: 'admin',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(staffCommunityAssignments).values({
    staffAccountId: adminStaffId,
    communityId,
    assignmentKind: 'operator_scope',
    createdAt: NOW,
  }).run()
  db.insert(localProducts).values({
    id: productId,
    communityId,
    name: '线上账本商品',
    unitPriceCents: 3980,
    status: 'on_shelf',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()

  let plan: World['plan'] = null
  let activityId = ''
  let teamId = ''
  let memberIds: string[] = []
  let couponId: string | null = null
  if (options.withTeam) {
    plan = {
      thresholdCents: 1000,
      couponFaceValueCents: options.couponDiscountCents ?? 500,
      maxRewardedTeams: 10,
    }
    activityId = randomUUID()
    teamId = randomUUID()
    const ruleVersionId = randomUUID()
    db.insert(activities).values({
      id: activityId,
      communityId,
      title: '线上消费团',
      summary: 'PAY-06 测试活动',
      description: '线上消费累计',
      status: 'published',
      startsAt: new Date(NOW.getTime() - 3_600_000),
      endsAt: new Date(NOW.getTime() + 86_400_000),
      location: '测试社区',
      budgetCapCents: 100_000,
      prizeQuantityCap: 100,
      publicRulesJson: '{}',
      purchaseRewardPlanJson: JSON.stringify(plan),
      currentRuleVersionId: null,
      createdByUserId: adminUserId,
      createdAt: NOW,
      updatedAt: NOW,
      publishedAt: NOW,
      pausedAt: null,
      endedAt: null,
    }).run()
    db.insert(activityRuleVersions).values({
      id: ruleVersionId,
      activityId,
      version: 1,
      snapshotJson: JSON.stringify({ purchaseRewardPlan: plan }),
      createdByUserId: adminUserId,
      createdAt: NOW,
    }).run()
    db.update(activities).set({ currentRuleVersionId: ruleVersionId })
      .where(eq(activities.id, activityId)).run()
    db.insert(activityTeams).values({
      id: teamId,
      activityId,
      leaderUserId: residentId,
      status: 'locked',
      createdAt: NOW,
      lockedAt: NOW,
    }).run()
    memberIds = [randomUUID(), randomUUID()]
    const invitationId = randomUUID()
    db.insert(activityInvitations).values({
      id: invitationId,
      code: randomUUID().replace(/-/gu, ''),
      activityId,
      teamId,
      inviterUserId: residentId,
      createdAt: NOW,
    }).run()
    for (const [index, userId] of [residentId, ...memberIds].entries()) {
      if (userId !== residentId) {
        db.insert(users).values({
          id: userId,
          displayName: `消费团成员${index}`,
          createdAt: NOW,
          updatedAt: NOW,
        }).run()
      }
      db.insert(activityParticipations).values({
        id: randomUUID(),
        activityId,
        teamId,
        userId,
        seatNo: index + 1,
        role: index === 0 ? 'leader' : 'member',
        inviteSource: index === 0 ? 'self' : 'invite',
        invitationId: index === 0 ? null : invitationId,
        joinedAt: new Date(NOW.getTime() - 60_000),
      }).run()
    }
    if (options.couponDiscountCents) {
      const grantId = randomUUID()
      db.insert(couponTeamGrants).values({
        id: grantId,
        activityId,
        teamId,
        ruleVersionId,
        faceValueCents: options.couponDiscountCents,
        totalValueCents: options.couponDiscountCents * 3,
        grantedAt: NOW,
      }).run()
      couponId = randomUUID()
      db.insert(couponIssues).values({
        id: couponId,
        grantId,
        activityId,
        teamId,
        userId: residentId,
        seatNo: 1,
        faceValueCents: options.couponDiscountCents,
        status: 'available',
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 86_400_000),
        reservedOrderId: null,
        reservedAt: null,
        redeemedAt: null,
        voidedAt: null,
        updatedAt: NOW,
      }).run()
    }
  }
  return {
    db, sqlite, communityId, productId, adminUserId, adminStaffId, residentId,
    plan, activityId, teamId, memberIds, couponId,
  }
}

function addOrder(
  w: World,
  options: {
    totalCents?: number
    discountCents?: number
      couponId?: string | null
    sourceActivityId?: string | null
    sourceTeamId?: string | null
  } = {},
): string {
  const id = randomUUID()
  const total = options.totalCents ?? 3980
  const discount = options.discountCents ?? 0
  w.db.insert(localOrders).values({
    id,
    communityId: w.communityId,
    productId: w.productId,
    residentUserId: w.residentId,
    idempotencyKey: `online-${id}`,
    status: 'registered',
    recordSource: 'resident',
    productName: '线上账本商品',
    unitPriceCents: total,
    quantity: 1,
    totalCents: total,
    couponDiscountCents: discount,
    couponId: options.couponId ?? null,
    note: null,
    createdByStaffId: null,
    attributedStaffId: null,
    sourceActivityId: options.sourceActivityId ?? null,
    sourceTeamId: options.sourceTeamId ?? null,
    verifiedByUserId: null,
    verifiedAt: null,
    verificationNote: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  return id
}

function addOnlineCompletion(
  w: World,
  orderId: string,
  options: { simulated?: boolean; kind?: 'channel' | 'zero_amount'; amountCents?: number } = {},
): { intentId: string; completionId: string; transactionId: string | null; completedAt: Date } {
  const order = w.db.select().from(localOrders).where(eq(localOrders.id, orderId)).get()
  assert.ok(order)
  const kind = options.kind ?? 'channel'
  const amountCents = options.amountCents ?? (kind === 'zero_amount' ? 0 : order.totalCents - order.couponDiscountCents)
  const simulated = options.simulated ?? false
  const intentId = randomUUID()
  const transactionId = kind === 'zero_amount' ? null : simulated ? `MOCK-TXN-${intentId}` : `WX-TXN-${intentId}`
  const completedAt = new Date(Date.parse(order.createdAt.toISOString()) + 5_000)
  w.db.insert(paymentIntents).values({
    id: intentId,
    localOrderId: order.id,
    residentUserId: order.residentUserId,
    communityId: order.communityId,
    kind,
    channel: kind === 'zero_amount' ? null : simulated ? 'mock' : 'wechat_jsapi',
    simulated,
    merchantOrderNo: `PAY-${intentId.replace(/-/gu, '').toUpperCase().slice(0, 28)}`,
    merchantAppId: kind === 'zero_amount' || simulated ? null : 'wx-test-app',
    merchantId: kind === 'zero_amount' || simulated ? null : 'test-merchant',
    grossAmountCents: order.totalCents,
    discountCents: order.couponDiscountCents,
    netPayableCents: amountCents,
    status: 'paid',
    idempotencyKey: `online-intent-${intentId}`,
    expiresAt: new Date(completedAt.getTime() + 60_000),
    paidAt: completedAt,
    closedAt: null,
    failedAt: null,
    failureCode: null,
    failureMessage: null,
    createdAt: new Date(completedAt.getTime() - 10_000),
    updatedAt: completedAt,
  }).run()
  w.db.insert(localOrderOnlineCompletions).values({
    id: randomUUID(),
    localOrderId: order.id,
    paymentIntentId: intentId,
    kind,
    simulated,
    grossAmountCents: order.totalCents,
    discountCents: order.couponDiscountCents,
    amountCents,
    providerTransactionId: transactionId,
    completedAt,
    createdAt: completedAt,
  }).run()
  w.db.update(localOrders).set({ status: 'online_completed', updatedAt: completedAt })
    .where(eq(localOrders.id, order.id)).run()
  const completion = w.db.select().from(localOrderOnlineCompletions)
    .where(eq(localOrderOnlineCompletions.localOrderId, order.id)).get()!
  return { intentId, completionId: completion.id, transactionId, completedAt }
}

function overview(w: World): LedgerOverview {
  return ledgerOverviewSchema.parse(getLedgerOverview(
    w.db,
    actor(w.adminUserId),
    NOW,
    { from: PERIOD_FROM, to: PERIOD_TO, communityId: w.communityId },
  ))
}

function entries(w: World, simulated?: boolean): LedgerEntry[] {
  return listLedgerEntries(
    w.db,
    actor(w.adminUserId),
    { page: 1, pageSize: 100, anomalyOnly: false, from: PERIOD_FROM, to: PERIOD_TO, ...(simulated === undefined ? {} : { simulated }) },
    NOW,
  ).items
}

test('real online completion projects exactly one online receipt', () => {
  const w = makeWorld()
  try {
    const orderId = addOrder(w)
    addOnlineCompletion(w, orderId)
    const result = projectOnlineCompletionsToLedger(w.db, { now: NOW })
    assert.equal(result.created, 1)
    const rows = entries(w, false)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.factKind, 'payment_received')
    assert.equal(rows[0]?.sourceSystem, 'online_payment')
    assert.equal(rows[0]?.simulated, false)
    assert.equal(rows[0]?.evidence.kind, 'channel_payment')
    assert.equal(rows[0]?.amountCents, 3980)
    assert.equal(rows[0]?.recordedByStaffId, null)
    assert.equal(overview(w).payment.receivedCents, 3980)
    assert.equal(overview(w).payment.onlineRealReceivedCents, 3980)
    assert.equal(overview(w).payment.onlineSimulatedReceivedCents, 0)
    assert.equal(projectOnlineCompletionsToLedger(w.db, { now: NOW }).created, 0)
  } finally {
    w.sqlite.close()
  }
})

test('mock online completion is queryable but excluded from formal totals and CSV', () => {
  const w = makeWorld()
  try {
    const mockOrder = addOrder(w)
    const mock = addOnlineCompletion(w, mockOrder, { simulated: true })
    const realOrder = addOrder(w)
    const real = addOnlineCompletion(w, realOrder, { simulated: false })
    projectOnlineCompletionsToLedger(w.db, { now: NOW })
    const formal = overview(w)
    assert.equal(formal.payment.receivedCents, 3980)
    assert.equal(formal.payment.onlineRealReceivedCents, 3980)
    assert.equal(formal.payment.onlineSimulatedReceivedCents, 3980)
    assert.equal(formal.buckets.find((b) => b.factKind === 'payment_received')?.grossAmountCents, 3980)

    const simulated = entries(w, true)
    assert.equal(simulated.length, 1)
    assert.equal(simulated[0]?.simulated, true)
    assert.equal(simulated[0]?.evidence.ref, mock.transactionId)

    const batch = createBatch(w.db, actor(w.adminUserId), {
      periodFrom: PERIOD_FROM,
      periodTo: PERIOD_TO,
      note: 'PAY-06 正式批次',
    }, { now: NOW })
    assert.equal(batch.totalCents, 3980)
    const statement = getBatchEntries(w.db, batch.batchId, { actor: actor(w.adminUserId), now: NOW })
    assert.equal(statement.entries.length, 1)
    assert.equal(statement.entries[0]?.sourceId, w.db.select().from(localOrderOnlineCompletions)
      .where(eq(localOrderOnlineCompletions.localOrderId, realOrder)).get()?.id)
    const csv = buildReconciliationCsv(w.db, {
      actor: actor(w.adminUserId),
      periodFrom: PERIOD_FROM,
      periodTo: PERIOD_TO,
      now: NOW,
    })
    assert.ok(csv.body.includes(real.transactionId!))
    assert.ok(!csv.body.includes(mock.transactionId!))
  } finally {
    w.sqlite.close()
  }
})

test('coupon net paid is the only cash ledger amount', () => {
  const w = makeWorld({ withTeam: true, couponDiscountCents: 1000 })
  try {
    const discountedOrder = addOrder(w, {
      totalCents: 3980,
      discountCents: 1000,
      couponId: w.couponId,
      sourceActivityId: w.activityId,
      sourceTeamId: w.teamId,
    })
    addOnlineCompletion(w, discountedOrder)
    projectOnlineCompletionsToLedger(w.db, { now: NOW })
    assert.equal(entries(w, false)[0]?.amountCents, 2980)
    assert.equal(entries(w, false)[0]?.evidence.ref?.startsWith('WX-TXN-'), true)
  } finally {
    w.sqlite.close()
  }
})

test('zero-amount coupon completion creates no cash or consumption fact', () => {
  const w = makeWorld({ withTeam: true, couponDiscountCents: 500 })
  try {
    const zeroOrder = addOrder(w, {
      totalCents: 500,
      discountCents: 500,
      couponId: w.couponId,
      sourceActivityId: w.activityId,
      sourceTeamId: w.teamId,
    })
    addOnlineCompletion(w, zeroOrder, { kind: 'zero_amount' })
    const result = projectOnlineCompletionsToLedger(w.db, { now: NOW })
    assert.equal(result.created, 0)
    assert.equal(entries(w, false).filter((entry) => entry.sourceId === zeroOrder).length, 0)
    assert.equal(overview(w).payment.receivedCents, 0)
    const progress = getMyPurchaseRewardProgress(w.db, actor(w.residentId, null, null), w.activityId)
    assert.equal(progress.progress?.totalEffectivePaidCents, 0)
  } finally {
    w.sqlite.close()
  }
})

test('online completion drives one team cumulative and one three-coupon grant', () => {
  const w = makeWorld({ withTeam: true })
  try {
    const orderId = addOrder(w, {
      sourceActivityId: w.activityId,
      sourceTeamId: w.teamId,
    })
    addOnlineCompletion(w, orderId)
    projectOnlineCompletionsToLedger(w.db, { now: NOW })
    const progress = getMyPurchaseRewardProgress(
      w.db,
      actor(w.residentId, null, null),
      w.activityId,
    )
    assert.equal(progress.progress?.totalEffectivePaidCents, 3980)
    assert.equal(progress.progress?.eligible, true)
    assert.equal(w.db.select().from(couponTeamGrants).all().length, 1)
    assert.equal(w.db.select().from(couponIssues).all().length, 3)
    projectOnlineCompletionsToLedger(w.db, { now: NOW })
    assert.equal(w.db.select().from(couponTeamGrants).all().length, 1)
    assert.equal(w.db.select().from(couponIssues).all().length, 3)
  } finally {
    w.sqlite.close()
  }
})

test('manual and online payment paths remain mutually exclusive', () => {
  const w = makeWorld()
  try {
    const orderId = addOrder(w)
    addOnlineCompletion(w, orderId)
    projectOnlineCompletionsToLedger(w.db, { now: NOW })
    assert.throws(() => recordPayment(w.db, actor(w.adminUserId, 'admin', w.adminStaffId), {
      communityId: w.communityId,
      orderId,
      amountCents: 3980,
      evidenceRef: 'manual-after-online',
      evidenceKind: 'manual_receipt',
      receivedAt: NOW.toISOString(),
      staffId: w.adminStaffId,
    }, { now: NOW }), /尚未人工核验|不能登记对应收款/u)
    const onlineEntry = entries(w, false).find((entry) => entry.factKind === 'payment_received')!
    assert.throws(() => reversePayment(w.db, actor(w.adminUserId), onlineEntry.entryId, {}, { now: NOW }),
      /在线退款\/冲正尚未支持/u)
    assert.equal(w.db.select().from(ledgerEntries).all().filter((row) => row.factKind === 'payment_received').length, 1)
  } finally {
    w.sqlite.close()
  }
})

test('syncLedgerFacts projects a pre-existing completion and is replay-safe', () => {
  const w = makeWorld()
  try {
    const orderId = addOrder(w)
    addOnlineCompletion(w, orderId)
    const first = syncLedgerFacts(w.db, actor(w.adminUserId), { from: PERIOD_FROM, to: PERIOD_TO }, { now: NOW })
    assert.equal(first.sources.onlineCompletion.created, 1)
    const second = syncLedgerFacts(w.db, actor(w.adminUserId), { from: PERIOD_FROM, to: PERIOD_TO }, { now: NOW })
    assert.equal(second.sources.onlineCompletion.created, 0)
    assert.equal(w.db.select().from(ledgerEntries).all().length, 2)
  } finally {
    w.sqlite.close()
  }
})


test('two independent processes project one online completion exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-pay06-projection-'))
  const databasePath = join(dir, 'projection.sqlite')
  const w = makeWorld({ databasePath })
  try {
    const orderId = addOrder(w)
    addOnlineCompletion(w, orderId)
    const workerPath = fileURLToPath(new URL('./helpers/online-ledger-worker.ts', import.meta.url))
    const cwd = fileURLToPath(new URL('..', import.meta.url))
    const results = await Promise.all([0, 1].map(() => new Promise<{ code: number | null; output: string; error: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', workerPath], {
        cwd,
        env: {
          ...process.env,
          ONLINE_LEDGER_DB: databasePath,
          ONLINE_LEDGER_NOW: NOW.toISOString(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let error = ''
      child.stdout.on('data', (chunk) => { output += String(chunk) })
      child.stderr.on('data', (chunk) => { error += String(chunk) })
      child.on('close', (code) => resolve({ code, output, error }))
    })))
    const parsed = results.map((result) => {
      assert.equal(result.code, 0, result.error)
      return JSON.parse(result.output) as { created: number; skipped: number }
    })
    assert.equal(parsed.reduce((sum, result) => sum + result.created, 0), 1)
    assert.equal(w.db.select().from(ledgerEntries).all().filter((row) => row.sourceSystem === 'online_payment').length, 1)
  } finally {
    w.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})


test('the outbox consumer follow-up projects an already-completed online order', () => {
  const w = makeWorld()
  try {
    const orderId = addOrder(w)
    addOnlineCompletion(w, orderId)
    runPaymentOutboxConsumer(w.db, { now: NOW })
    assert.equal(
      w.db.select().from(ledgerEntries).all()
        .filter((row) => row.sourceSystem === 'online_payment').length,
      1,
    )
  } finally {
    w.sqlite.close()
  }
})

test('0035 -> 0036 upgrades a populated ledger without changing historical rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-pay06-migration-'))
  let upgraded: ReturnType<typeof createDatabase> | null = null
  try {
    const source = migrationsFolder
    const staged = join(dir, 'migrations-before-0036')
    mkdirSync(join(staged, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(join(source, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    const entries = journal.entries.filter((entry) => entry.idx <= 35)
    for (const entry of entries) {
      copyFileSync(join(source, `${entry.tag}.sql`), join(staged, `${entry.tag}.sql`))
    }
    writeFileSync(
      join(staged, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries }, null, 2),
    )
    const databasePath = join(dir, 'upgrade.sqlite')
    const legacy = createDatabase(databasePath, staged)
    const communityId = randomUUID()
    const entryId = randomUUID()
    legacy.db.insert(communities).values({ id: communityId, name: '升级历史片区', createdAt: NOW }).run()
    legacy.sqlite.prepare(`INSERT INTO ledger_entries
      (id, fact_kind, source_system, source_id, source_display_no, community_id,
       product_id, attributed_staff_id, attribution_state, attribution_basis,
       amount_cents, settlement_amount_status, occurred_at, verified_at,
       recorded_by_user_id, recorded_by_staff_id, counter_entry_id, evidence_ref,
       evidence_kind, batch_id, created_at)
      VALUES (?, 'order_registered', 'local_order', ?, ?, ?, NULL, NULL, 'pending',
        'source_missing', 1234, 'pending_rule', ?, NULL, NULL, NULL, NULL, NULL,
        'none', NULL, ?)`).run(
      entryId, entryId, entryId, communityId, NOW.getTime(), NOW.getTime(),
    )
    legacy.sqlite.close()

    upgraded = createDatabase(databasePath, migrationsFolder)
    const row = upgraded.db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.id, entryId)).get()
    assert.equal(row?.amountCents, 1234)
    assert.equal(row?.simulated, false)
    assert.equal(row?.sourceSystem, 'local_order')
  } finally {
    upgraded?.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})


test('a late online projection after lock never rewrites the locked statement', () => {
  const w = makeWorld()
  try {
    const firstOrder = addOrder(w)
    addOnlineCompletion(w, firstOrder)
    projectOnlineCompletionsToLedger(w.db, { now: NOW })
    const batch = createBatch(w.db, actor(w.adminUserId), {
      periodFrom: PERIOD_FROM,
      periodTo: PERIOD_TO,
    }, { now: NOW })
    const locked = lockBatch(w.db, actor(w.adminUserId), batch.batchId, {
      expectedUpdatedAt: batch.updatedAt,
    }, { now: new Date(NOW.getTime() + 60_000) })
    assert.equal(locked.status, 'locked')
    const before = getBatchEntries(w.db, batch.batchId, { actor: actor(w.adminUserId), now: NOW }).entries

    const lateOrder = addOrder(w)
    addOnlineCompletion(w, lateOrder)
    projectOnlineCompletionsToLedger(w.db, { now: new Date(NOW.getTime() + 120_000) })
    const after = getBatchEntries(w.db, batch.batchId, { actor: actor(w.adminUserId), now: NOW }).entries
    assert.equal(after.length, before.length)
    assert.equal(after[0]?.amountCents, before[0]?.amountCents)
    assert.equal(w.db.select().from(ledgerEntries).all().filter((row) => row.sourceSystem === 'online_payment').length, 2)
  } finally {
    w.sqlite.close()
  }
})


test('projection recovery after a database restart remains exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-pay06-restart-'))
  const databasePath = join(dir, 'restart.sqlite')
  let first: World | null = null
  let second: World | null = null
  try {
    first = makeWorld({ databasePath })
    const orderId = addOrder(first)
    addOnlineCompletion(first, orderId)
    assert.equal(projectOnlineCompletionsToLedger(first.db, { now: NOW }).created, 1)
    const communityId = first.communityId
    first.sqlite.close()
    first = null

    second = makeWorld({ databasePath })
    assert.equal(second.communityId === communityId, false) // fixture adds new seed rows to the same file
    assert.equal(projectOnlineCompletionsToLedger(second.db, { now: NOW }).created, 0)
    assert.equal(second.db.select().from(ledgerEntries).all().filter((row) => row.sourceSystem === 'online_payment').length, 1)
  } finally {
    first?.sqlite.close()
    second?.sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
