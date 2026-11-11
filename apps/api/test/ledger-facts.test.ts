import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  API_ERROR_CODES,
  ledgerAnomalyListResponseSchema,
  ledgerAnomalySchema,
  ledgerEntrySchema,
  ledgerListResponseSchema,
  ledgerOverviewSchema,
  type LedgerEntry,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/security.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import {
  activities,
  activityRewardDisputes,
  activityRewardGrants,
  activityRuleVersions,
  activityTeams,
  communities,
  crmLeads,
  crmServiceOrders,
  localOrders,
  localProducts,
  staffAccounts,
  staffCommunityAssignments,
  settlementStatements,
  users,
} from '../src/db/schema.js'
import { listLedgerEntries } from '../src/ledger/shared.js'
import {
  createBatch,
  getBatchEntries,
  lockBatch,
} from '../src/ledger/reconciliation-service.js'
import { recordPayment, resolveAttribution, reversePayment, syncLedgerFacts } from '../src/ledger/service.js'

/**
 * HTTP + service tests of the ledger write side (LL-MVP-008, Issue #64, R3a-2).
 *
 * Everything runs against a real SQLite file with the real migration 0010
 * triggers (append-only facts, counter-entry scope, one-way batch lock). The
 * assets under test are the three-source idempotent ingestion, the manual receipt
 * path that is the *only* producer of 实收, and the append-only correction paths.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

const ADMIN_PASSWORD = 'Admin-Password-123!'
const GRID_PASSWORD = 'Grid-Worker-Password-123!'
const ADMIN_ORIGIN = 'http://localhost:5174'

/** "Now" for every write: after the fixtures, before anything expires. */
const CLOCK = new Date('2026-11-10T02:00:00.000Z')
/** An instant after the reconciliation lock, inside the same business period. */
const AFTER_LOCK = new Date('2026-11-10T03:00:00.000Z')
const PERIOD_FROM = '2026-11-01'
const PERIOD_TO = '2026-11-07'

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers (same shape as the other ledger suites)                       */
/* -------------------------------------------------------------------------- */

function cookiePairs(response: Response): string[] {
  return (response.headers.get('set-cookie') ?? '')
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

function api(
  app: App,
  method: string,
  path: string,
  options: { session?: Session; body?: unknown } = {},
) {
  const headers: Record<string, string> = {}
  if (options.session) {
    headers.cookie = options.session.cookies
    if (method !== 'GET') {
      headers['x-csrf-token'] = options.session.csrfToken
      headers.origin = ADMIN_ORIGIN
    }
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return app.request(path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } }
  return body.error.code
}

/* -------------------------------------------------------------------------- */
/* World                                                                      */
/* -------------------------------------------------------------------------- */

interface World {
  dir: string
  db: AppDatabase
  sqlite: SqliteConnection
  app: App
  communityId: string
  otherCommunityId: string
  adminUserId: string
  adminStaffId: string
  operatorUserId: string
  operatorStaffId: string
  gridStaffId: string
  localOrderId: string
  crmOrderId: string
  otherOrderId: string
  grantId: string
  cleanup: () => void
}

function entryCount(sqlite: SqliteConnection): number {
  const row = sqlite.prepare('SELECT count(*) AS c FROM ledger_entries').get() as { c: number }
  return row.c
}

function countByKind(sqlite: SqliteConnection, factKind: string): number {
  const row = sqlite
    .prepare('SELECT count(*) AS c FROM ledger_entries WHERE fact_kind = ?')
    .get(factKind) as { c: number }
  return row.c
}

function countAnomalies(sqlite: SqliteConnection): number {
  const row = sqlite.prepare('SELECT count(*) AS c FROM ledger_anomalies').get() as { c: number }
  return row.c
}

/**
 * One community, one operator, one grid worker, and exactly one fact of each of
 * the three sources: a resident local order, a *confirmed* 广电 CRM order (which
 * has no amount column at all) and a disputed reward grant with two `reversed`
 * decisions — the second one must not be able to reverse the same cost twice.
 */
async function makeWorld(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'll-ledger-facts-'))
  const { db, sqlite } = createDatabase(join(dir, 'facts.sqlite'), migrationsFolder)

  const now = new Date('2026-11-01T00:00:00.000+08:00')
  const communityId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '幸福社区', createdAt: now }).run()

  const addUser = (displayName: string): string => {
    const id = randomUUID()
    db.insert(users).values({ id, displayName, createdAt: now, updatedAt: now }).run()
    return id
  }
  const addStaff = (
    displayName: string,
    username: string,
    role: 'admin' | 'operator' | 'grid_worker',
    passwordHash: string,
  ): { userId: string; staffId: string } => {
    const userId = addUser(displayName)
    const staffId = randomUUID()
    db.insert(staffAccounts)
      .values({
        id: staffId,
        userId,
        username,
        passwordHash,
        role,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(staffCommunityAssignments)
      .values({ staffAccountId: staffId, communityId, createdAt: now })
      .run()
    return { userId, staffId }
  }

  const adminPasswordHash = await hashPassword(ADMIN_PASSWORD)
  const admin = addStaff('系统管理员', 'admin', 'admin', adminPasswordHash)
  const operator = addStaff('运营小王', 'operator', 'operator', 'not-a-real-hash')
  const grid = addStaff('网格员小李', 'grid', 'grid_worker', await hashPassword(GRID_PASSWORD))
  const residentUserId = addUser('居民甲')

  // A second community the grid worker is *not* assigned to, holding one fact.
  // It exists so the scope assertions below prove a real 403 instead of an
  // accidentally empty list.
  const otherCommunityId = randomUUID()
  db.insert(communities)
    .values({ id: otherCommunityId, name: '和睦社区', createdAt: now })
    .run()

  // --- local order: 登记金额 450 * 2 ---------------------------------------
  const productId = randomUUID()
  db.insert(localProducts)
    .values({
      id: productId,
      communityId,
      name: '本地青菜',
      unitPriceCents: 450,
      status: 'on_shelf',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  const localOrderId = randomUUID()
  db.insert(localOrders)
    .values({
      id: localOrderId,
      communityId,
      productId,
      residentUserId,
      idempotencyKey: randomUUID(),
      status: 'registered',
      recordSource: 'resident',
      productName: '本地青菜',
      unitPriceCents: 450,
      quantity: 2,
      totalCents: 900,
      // Deliberately set: the ingestion must still refuse to read it as an
      // attribution (see `src/local/orders.ts` backfilling `attributed_staff_id`).
      attributedStaffId: grid.staffId,
      createdByStaffId: grid.staffId,
      createdAt: new Date('2026-11-02T09:00:00.000+08:00'),
      updatedAt: new Date('2026-11-02T09:00:00.000+08:00'),
    })
    .run()

  // --- confirmed CRM order: no amount column anywhere ----------------------
  const leadId = randomUUID()
  db.insert(crmLeads)
    .values({
      id: leadId,
      communityId,
      ownerStaffId: grid.staffId,
      residentUserId,
      contactName: '居民甲',
      contactPhone: '13800138000',
      sourceType: 'resident_referral',
      createdByStaffId: grid.staffId,
      status: 'converted',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  const crmOrderId = randomUUID()
  db.insert(crmServiceOrders)
    .values({
      id: crmOrderId,
      communityId,
      leadId,
      orderNo: 'GD-20261103-001',
      businessType: 'gd_mobile',
      status: 'confirmed',
      customerName: '居民甲',
      contactPhone: '13800138000',
      evidenceRef: '工单截图 2026-11-03',
      createdByStaffId: grid.staffId,
      attributedStaffId: operator.staffId,
      confirmedByUserId: operator.userId,
      confirmedAt: new Date('2026-11-03T11:00:00.000+08:00'),
      createdAt: new Date('2026-11-03T10:00:00.000+08:00'),
      updatedAt: new Date('2026-11-03T11:00:00.000+08:00'),
    })
    .run()

  // --- reward grant, disputed and reversed ---------------------------------
  const activityId = randomUUID()
  db.insert(activities)
    .values({
      id: activityId,
      communityId,
      title: '邻里互助活动',
      status: 'published',
      startsAt: now,
      endsAt: new Date('2026-11-30T00:00:00.000+08:00'),
      location: '社区活动中心',
      budgetCapCents: 100_000,
      prizeQuantityCap: 10,
      publicRulesJson: '{}',
      createdByUserId: operator.userId,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
    })
    .run()
  const ruleVersionId = randomUUID()
  db.insert(activityRuleVersions)
    .values({
      id: ruleVersionId,
      activityId,
      version: 1,
      snapshotJson: JSON.stringify({
        rewardPlan: {
          prizeName: '米油礼包',
          prizeUnitCostCents: 1_500,
          prizeQuantityPerTeam: 2,
        },
      }),
      createdByUserId: operator.userId,
      createdAt: now,
    })
    .run()
  const teamId = randomUUID()
  db.insert(activityTeams)
    .values({ id: teamId, activityId, leaderUserId: residentUserId, status: 'open', createdAt: now })
    .run()
  const grantId = randomUUID()
  db.insert(activityRewardGrants)
    .values({
      id: grantId,
      activityId,
      ruleVersionId,
      teamId,
      prizeName: '米油礼包',
      quantity: 2,
      unitCostCents: 1_500,
      totalCostCents: 3_000,
      status: 'reversed',
      recipientRole: 'leader',
      recipientUserId: residentUserId,
      grantedAt: new Date('2026-11-04T09:00:00.000+08:00'),
      redeemedAt: new Date('2026-11-05T09:00:00.000+08:00'),
      redeemedByStaffId: grid.staffId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  // One dispute thread: `opened` then the single terminal `reversed`. Together
  // with `grant.status = 'reversed'` this gives the two independent reversal
  // producers; only one of them may append the `reward_reversed` row.
  for (const [index, decision] of (['opened', 'reversed'] as const).entries()) {
    db.insert(activityRewardDisputes)
      .values({
        id: randomUUID(),
        activityId,
        grantId,
        decision,
        reason: `领取凭证复核 ${index}`,
        actorStaffId: operator.staffId,
        createdAt: new Date(`2026-11-06T0${index + 1}:00:00.000+08:00`),
      })
      .run()
  }

  // --- a fact in a community the grid worker cannot see ---------------------
  const otherProductId = randomUUID()
  db.insert(localProducts)
    .values({
      id: otherProductId,
      communityId: otherCommunityId,
      name: '和睦社区土鸡蛋',
      unitPriceCents: 2_000,
      status: 'on_shelf',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  const otherOrderId = randomUUID()
  db.insert(localOrders)
    .values({
      id: otherOrderId,
      communityId: otherCommunityId,
      productId: otherProductId,
      residentUserId,
      idempotencyKey: randomUUID(),
      status: 'registered',
      recordSource: 'resident',
      productName: '和睦社区土鸡蛋',
      unitPriceCents: 2_000,
      quantity: 1,
      totalCents: 2_000,
      createdByStaffId: operator.staffId,
      createdAt: new Date('2026-11-02T15:00:00.000+08:00'),
      updatedAt: new Date('2026-11-02T15:00:00.000+08:00'),
    })
    .run()

  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const app = createApp({ db, config, logRequests: false, now: () => CLOCK })

  return {
    dir,
    db,
    sqlite,
    app,
    communityId,
    otherCommunityId,
    adminUserId: admin.userId,
    adminStaffId: admin.staffId,
    operatorUserId: operator.userId,
    operatorStaffId: operator.staffId,
    gridStaffId: grid.staffId,
    localOrderId,
    crmOrderId,
    otherOrderId,
    grantId,
    cleanup: () => {
      try {
        sqlite.close()
      } catch {
        // ignore
      }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows may still hold a handle; a leftover temp dir is harmless.
      }
    },
  }
}

const adminActor = (world: World) => ({
  userId: world.operatorUserId,
  staffId: world.operatorStaffId,
  role: 'operator' as const,
})

/**
 * A real `admin` staff member: `scopeCommunityIds` returns `null`, so this actor
 * ingests *both* communities. Only that makes the 网格员 scope assertions below
 * meaningful — otherwise the foreign fact would simply never exist.
 */
const adminAllActor = (world: World) => ({
  userId: world.adminUserId,
  staffId: world.adminStaffId,
  role: 'admin' as const,
})

async function adminSession(app: App): Promise<Session> {
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
    cookies: `${cookiePair(response, 'll_session')}; ${cookiePair(response, 'll_csrf')}`,
    csrfToken: body.csrfToken,
  }
}

async function gridSession(app: App): Promise<Session> {
  const state = await csrf(app)
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: state.cookie,
      'x-csrf-token': state.token,
      origin: ADMIN_ORIGIN,
    },
    body: JSON.stringify({ username: 'grid', password: GRID_PASSWORD }),
  })
  assert.equal(response.status, 200, 'grid worker login must succeed')
  const body = (await response.json()) as { csrfToken: string }
  return {
    cookies: `${cookiePair(response, 'll_session')}; ${cookiePair(response, 'll_csrf')}`,
    csrfToken: body.csrfToken,
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Idempotent ingestion of the three sources                               */
/* -------------------------------------------------------------------------- */

test('the three sources ingest once: a replay creates no new fact and reports skips', async () => {
  const world = await makeWorld()
  try {
    const first = syncLedgerFacts(
      world.db,
      adminActor(world),
      { from: PERIOD_FROM, to: PERIOD_TO },
      { now: CLOCK },
    )
    // local order (registered) + crm order (verified) + reward cost + one reversal
    // (the second `reversed` dispute is refused because the cost is already reversed).
    assert.equal(first.created, 4, JSON.stringify(first))
    assert.equal(first.skipped, 1)
    assert.equal(entryCount(world.sqlite), 4)

    const second = syncLedgerFacts(
      world.db,
      adminActor(world),
      { from: PERIOD_FROM, to: PERIOD_TO },
      { now: CLOCK },
    )
    assert.equal(second.created, 0, 'a replayed sync must not create a second fact')
    assert.ok(second.skipped >= 4)
    assert.equal(entryCount(world.sqlite), 4, 'ledger_entries must be unchanged after a replay')

    // The dedupe keys are real rows, one per fact.
    const sources = world.sqlite
      .prepare('SELECT count(*) AS c FROM ledger_entry_sources')
      .get() as { c: number }
    assert.equal(sources.c, 4)
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* 2. Attribution: a local order is never silently attributed                 */
/* -------------------------------------------------------------------------- */

test('local-order facts stay 待归属 while the confirmed CRM fact is attributed at amount 0', async () => {
  const world = await makeWorld()
  try {
    syncLedgerFacts(world.db, adminActor(world), { from: PERIOD_FROM, to: PERIOD_TO }, { now: CLOCK })
    const page = listLedgerEntries(
      world.db,
      adminActor(world),
      { page: 1, pageSize: 100, anomalyOnly: false },
      CLOCK,
    )
    const local = page.items.find((item) => item.sourceId === world.localOrderId)
    assert.ok(local, 'the local order must have produced a fact')
    assert.equal(local.factKind, 'order_registered')
    assert.equal(local.amountCents, 900)
    assert.equal(local.attribution.state, 'pending')
    assert.equal(local.attribution.staffId, null)
    assert.equal(local.attribution.basis, 'no_explicit_attribution')

    const crm = page.items.find((item) => item.sourceId === world.crmOrderId)
    assert.ok(crm, 'the confirmed CRM order must have produced a fact')
    assert.equal(crm.factKind, 'order_verified')
    assert.equal(crm.amountCents, 0, 'crm_service_orders has no amount column')
    assert.equal(crm.attribution.state, 'attributed')
    assert.equal(crm.attribution.staffId, world.operatorStaffId)
    assert.equal(crm.evidence.kind, 'crm_confirmation')

    const reward = page.items.find((item) => item.factKind === 'reward_cost')
    assert.ok(reward)
    assert.equal(reward.amountCents, 3_000)
    const reversed = page.items.filter((item) => item.factKind === 'reward_reversed')
    assert.equal(reversed.length, 1, 'one cost fact can be reversed only once')
    assert.equal(reversed[0]?.counterEntryId, reward.entryId)
    assert.equal(reversed[0]?.amountCents, reward.amountCents)
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* 3. Manual receipts: evidence is mandatory, and 实收 is what the overview says */
/* -------------------------------------------------------------------------- */

test('a receipt without evidence is a 400 and 实收 only moves when a human records it', async () => {
  const world = await makeWorld()
  try {
    syncLedgerFacts(world.db, adminActor(world), { from: PERIOD_FROM, to: PERIOD_TO }, { now: CLOCK })
    const session = await adminSession(world.app)
    const before = ledgerOverviewSchema.parse(
      await (await api(world.app, 'GET', '/admin/ledger/overview', { session })).json(),
    )
    assert.equal(before.payment.receivedCents, 0)
    assert.equal(before.amountStatus, 'pending_rule')

    const missingEvidence = await api(world.app, 'POST', '/admin/ledger/payments', {
      session,
      body: {
        communityId: world.communityId,
        amountCents: 12_000,
        evidenceKind: 'manual_receipt',
        receivedAt: '2026-11-06T10:00:00.000Z',
        staffId: world.operatorStaffId,
      },
    })
    assert.equal(missingEvidence.status, 400)
    assert.equal(await errorCode(missingEvidence), API_ERROR_CODES.invalidRequest)
    assert.equal(countByKind(world.sqlite, 'payment_received'), 0, 'a refused receipt must not persist')

    const created = await api(world.app, 'POST', '/admin/ledger/payments', {
      session,
      body: {
        communityId: world.communityId,
        amountCents: 12_000,
        evidenceRef: '收据 2026-11-06 #7',
        evidenceKind: 'manual_receipt',
        receivedAt: '2026-11-06T10:00:00.000Z',
        staffId: world.operatorStaffId,
      },
    })
    const text = await created.text()
    assert.equal(created.status, 201, text)
    const payment = ledgerEntrySchema.parse(JSON.parse(text))
    assert.equal(payment.factKind, 'payment_received')
    assert.equal(payment.sourceSystem, 'manual')
    assert.equal(payment.amountCents, 12_000)
    assert.equal(payment.evidence.ref, '收据 2026-11-06 #7')
    assert.equal(payment.recordedByStaffId, world.operatorStaffId)

    const after = ledgerOverviewSchema.parse(
      await (await api(world.app, 'GET', '/admin/ledger/overview', { session })).json(),
    )
    assert.equal(after.payment.receivedCents, 12_000)
    assert.equal(after.payment.reversedCents, 0)

    // A reversal appends a second row: the original receipt is never touched.
    const reversed = await api(
      world.app,
      'POST',
      `/admin/ledger/payments/${payment.entryId}/reverse`,
      { session, body: { reason: '转账被退回' } },
    )
    const reverseText = await reversed.text()
    assert.equal(reversed.status, 201, reverseText)
    const reversal = ledgerEntrySchema.parse(JSON.parse(reverseText))
    assert.equal(reversal.factKind, 'payment_reversed')
    assert.equal(reversal.counterEntryId, payment.entryId)
    assert.equal(reversal.amountCents, payment.amountCents)

    const netted = ledgerOverviewSchema.parse(
      await (await api(world.app, 'GET', '/admin/ledger/overview', { session })).json(),
    )
    assert.equal(netted.payment.receivedCents, 12_000, 'the original receipt stays visible')
    assert.equal(netted.payment.reversedCents, 12_000, 'the reversal is its own positive row')

    const twice = await api(world.app, 'POST', `/admin/ledger/payments/${payment.entryId}/reverse`, {
      session,
      body: {},
    })
    assert.equal(twice.status, 409, 'a receipt can be reversed only once')
    assert.equal(await errorCode(twice), API_ERROR_CODES.ledgerEntryImmutable)
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* 4. Attribution confirmation moves 待归属 -> 已归属 without an UPDATE        */
/* -------------------------------------------------------------------------- */

test('confirming a pending fact drops 待归属 and shows the confirmed staff member', async () => {
  const world = await makeWorld()
  try {
    syncLedgerFacts(world.db, adminActor(world), { from: PERIOD_FROM, to: PERIOD_TO }, { now: CLOCK })
    const session = await adminSession(world.app)
    const before = ledgerOverviewSchema.parse(
      await (await api(world.app, 'GET', '/admin/ledger/overview', { session })).json(),
    )
    assert.ok(before.pendingAttribution.entryCount >= 2)

    const target = ledgerListResponseSchema.parse(
      await (
        await api(
          world.app,
          'GET',
          `/admin/ledger/entries?factKind=order_registered&pageSize=10`,
          { session },
        )
      ).json(),
    )
    const local = target.items[0]
    assert.ok(local)
    assert.equal(local.attribution.state, 'pending')

    const confirmed = await api(world.app, 'POST', '/admin/ledger/attributions', {
      session,
      body: { entryId: local.entryId, staffId: world.gridStaffId, note: '居民确认由小李跟进' },
    })
    const confirmText = await confirmed.text()
    assert.equal(confirmed.status, 201, confirmText)
    const after = ledgerEntrySchema.parse(JSON.parse(confirmText))
    assert.equal(after.attribution.state, 'attributed')
    assert.equal(after.attribution.staffId, world.gridStaffId)
    assert.equal(after.attribution.basis, 'explicit_attribution')
    assert.equal(after.amountCents, local.amountCents, 'the confirmed fact keeps its money')

    const overview = ledgerOverviewSchema.parse(
      await (await api(world.app, 'GET', '/admin/ledger/overview', { session })).json(),
    )
    assert.equal(
      overview.pendingAttribution.entryCount,
      before.pendingAttribution.entryCount - 1,
      '待归属 must actually shrink after a confirmation',
    )
    assert.equal(
      overview.attributed.entryCount,
      before.attributed.entryCount + 1,
      'and 已归属 must grow by the same fact',
    )

    // The immutable row still says `pending`; only the appended record moved it.
    const stored = world.sqlite
      .prepare('SELECT attribution_state FROM ledger_entries WHERE id = ?')
      .get(local.entryId) as { attribution_state: string }
    assert.equal(stored.attribution_state, 'pending')
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* 5. L1 parity: the fact list and the statement render one entry one way      */
/* -------------------------------------------------------------------------- */

/**
 * One shared assertion for both read paths (L1). The list derives batch
 * membership from the batch period; the statement derives it from the same rule.
 * If they ever disagree, one screen says 已对账 while the other says 未对账.
 */
function assertSameReconciliationState(
  listed: LedgerEntry,
  inStatement: LedgerEntry | undefined,
  expected: { state: LedgerEntry['reconciliationState']; batchId: string | null },
) {
  assert.equal(listed.reconciliationState, expected.state, `list state of ${listed.entryId}`)
  assert.equal(listed.batchId, expected.batchId, `list batchId of ${listed.entryId}`)
  if (inStatement) {
    assert.equal(inStatement.reconciliationState, listed.reconciliationState)
    assert.equal(inStatement.batchId, listed.batchId)
  }
}

test('a locked statement and the fact list agree on 已对账, and a post-lock fact stays 未对账', async () => {
  const world = await makeWorld()
  try {
    syncLedgerFacts(world.db, adminActor(world), { from: PERIOD_FROM, to: PERIOD_TO }, { now: CLOCK })
    const batch = createBatch(
      world.db,
      adminActor(world),
      { periodFrom: PERIOD_FROM, periodTo: PERIOD_TO },
      { now: CLOCK },
    )
    const locked = lockBatch(
      world.db,
      adminActor(world),
      batch.batchId,
      { expectedUpdatedAt: batch.updatedAt },
      { now: new Date(CLOCK.getTime() + 60_000) },
    )
    assert.equal(locked.status, 'locked')

    const statement = getBatchEntries(world.db, batch.batchId, { actor: adminActor(world), now: CLOCK })
    const page = listLedgerEntries(
      world.db,
      adminActor(world),
      { page: 1, pageSize: 100, anomalyOnly: false },
      CLOCK,
    )
    const statementById = new Map(statement.entries.map((view) => [view.entryId, view]))
    assert.ok(statement.entries.length >= 4)
    for (const listed of page.items) {
      assertSameReconciliationState(listed, undefined, {
        state: 'reconciled',
        batchId: batch.batchId,
      })
      assert.ok(statementById.has(listed.entryId), 'a reconciled fact must be a statement member')
    }

    // A fact recorded *after* the lock, inside the same period: it can never join
    // the frozen statement, so both paths must say 未对账 with no batch id.
    const late = recordPayment(
      world.db,
      adminActor(world),
      {
        communityId: world.communityId,
        amountCents: 5_000,
        evidenceRef: '收据 2026-11-10 #1',
        evidenceKind: 'manual_receipt',
        receivedAt: '2026-11-06T12:00:00.000Z',
        staffId: world.operatorStaffId,
      },
      { now: AFTER_LOCK },
    )
    const afterPage = listLedgerEntries(
      world.db,
      adminActor(world),
      { page: 1, pageSize: 100, anomalyOnly: false },
      AFTER_LOCK,
    )
    const listedLate = afterPage.items.find((item) => item.entryId === late.entryId)
    assert.ok(listedLate)
    assertSameReconciliationState(listedLate, undefined, { state: 'unreconciled', batchId: null })

    const frozen = getBatchEntries(world.db, batch.batchId, { now: AFTER_LOCK })
    assert.equal(
      frozen.entries.some((view) => view.entryId === late.entryId),
      false,
      'a locked statement must not absorb a fact recorded after the lock',
    )
    assert.equal(frozen.stored.totalCents, statement.stored.totalCents)
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* 6. Attribution is only accepted for a genuinely pending fact                */
/* -------------------------------------------------------------------------- */

test('an already attributed fact refuses a second attribution confirmation', async () => {
  const world = await makeWorld()
  try {
    syncLedgerFacts(world.db, adminActor(world), { from: PERIOD_FROM, to: PERIOD_TO }, { now: CLOCK })
    const page = listLedgerEntries(
      world.db,
      adminActor(world),
      { page: 1, pageSize: 100, anomalyOnly: false },
      CLOCK,
    )
    const crm = page.items.find((item) => item.sourceId === world.crmOrderId)
    assert.ok(crm)

    assert.throws(
      () =>
        resolveAttribution(
          world.db,
          adminActor(world),
          { entryId: crm.entryId, staffId: world.gridStaffId },
          { now: CLOCK },
        ),
      (error: unknown) =>
        error instanceof Error &&
        'status' in error &&
        (error as { status: number }).status === 409,
    )

    const reversedFact = page.items.find((item) => item.factKind === 'payment_received')
    assert.equal(reversedFact, undefined, 'no receipt was recorded in this fixture')

    // And the reward reversal cannot be appended a second time by the service.
    assert.throws(
      () =>
        reversePayment(world.db, adminActor(world), crm.entryId, {}, { now: CLOCK }),
      (error: unknown) =>
        error instanceof Error &&
        'status' in error &&
        (error as { status: number }).status === 409,
      'only a manual receipt can be reversed',
    )
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* 7. Anomalies are append-only review hints, queryable by fact and batch      */
/* -------------------------------------------------------------------------- */

test('anomalies append, are queryable by fact and by batch, and can never be deleted', async () => {
  const world = await makeWorld()
  try {
    syncLedgerFacts(world.db, adminActor(world), { from: PERIOD_FROM, to: PERIOD_TO }, { now: CLOCK })
    const page = listLedgerEntries(
      world.db,
      adminActor(world),
      { page: 1, pageSize: 100, anomalyOnly: false },
      CLOCK,
    )
    const local = page.items.find((item) => item.sourceId === world.localOrderId)
    assert.ok(local)

    const session = await adminSession(world.app)
    const before = ledgerOverviewSchema.parse(
      await (await api(world.app, 'GET', '/admin/ledger/overview', { session })).json(),
    )
    assert.equal(before.openAnomalies.count, 0)

    const flagged = await api(world.app, 'POST', '/admin/ledger/anomalies', {
      session,
      body: {
        entryId: local.entryId,
        kind: 'source_missing_evidence',
        severity: 'medium',
        note: '登记单没有纸质凭证',
      },
    })
    const flaggedText = await flagged.text()
    assert.equal(flagged.status, 201, flaggedText)
    const anomaly = ledgerAnomalySchema.parse(JSON.parse(flaggedText))
    assert.equal(anomaly.entryId, local.entryId)
    assert.equal(anomaly.note, '登记单没有纸质凭证')
    assert.equal(anomaly.resolvedAt, null)

    // Two people noticing the same mismatch is history worth keeping.
    const again = await api(world.app, 'POST', '/admin/ledger/anomalies', {
      session,
      body: { entryId: local.entryId, kind: 'source_missing_evidence', severity: 'high' },
    })
    assert.equal(again.status, 201)
    assert.equal(
      countAnomalies(world.sqlite),
      2,
      'flagging twice appends a second row instead of overwriting the first',
    )

    const byEntry = ledgerAnomalyListResponseSchema.parse(
      await (
        await api(world.app, 'GET', `/admin/ledger/anomalies?entryId=${local.entryId}`, { session })
      ).json(),
    )
    assert.equal(byEntry.items.length, 2)

    // The batch filter uses the same membership rule as the statement.
    const batch = createBatch(
      world.db,
      adminActor(world),
      { periodFrom: PERIOD_FROM, periodTo: PERIOD_TO },
      { now: CLOCK },
    )
    const byBatch = ledgerAnomalyListResponseSchema.parse(
      await (
        await api(world.app, 'GET', `/admin/ledger/anomalies?batchId=${batch.batchId}`, { session })
      ).json(),
    )
    assert.equal(byBatch.items.length, 2)
    assert.ok(byBatch.items.every((item) => item.entryId === local.entryId))

    const overview = ledgerOverviewSchema.parse(
      await (await api(world.app, 'GET', '/admin/ledger/overview', { session })).json(),
    )
    assert.equal(overview.openAnomalies.count, 2)

    // The list can be narrowed to facts that carry an open anomaly.
    const anomalyOnly = ledgerListResponseSchema.parse(
      await (
        await api(world.app, 'GET', '/admin/ledger/entries?anomalyOnly=true', { session })
      ).json(),
    )
    assert.equal(anomalyOnly.items.length, 1)
    assert.equal(anomalyOnly.items[0]?.entryId, local.entryId)

    assert.throws(
      () => world.sqlite.prepare('DELETE FROM ledger_anomalies WHERE id = ?').run(anomaly.anomalyId),
      /append-only|no_delete/i,
      'an anomaly can never be deleted',
    )
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* 8. 网格员 scope: own community only, and no back-office surface at all      */
/* -------------------------------------------------------------------------- */

test('网格员 reads only their own community and is refused the admin ledger routes', async () => {
  const world = await makeWorld()
  try {
    // Ingested by an admin so the *other* community's fact really exists.
    syncLedgerFacts(world.db, adminAllActor(world), { from: PERIOD_FROM, to: PERIOD_TO }, { now: CLOCK })
    const grid = await gridSession(world.app)

    const own = ledgerListResponseSchema.parse(
      await (await api(world.app, 'GET', '/staff/ledger/entries?pageSize=100', { session: grid })).json(),
    )
    assert.ok(own.items.length >= 4)
    assert.ok(
      own.items.every((item) => item.communityId === world.communityId),
      '网格员 must never see another community through /staff/ledger/entries',
    )

    // The other community exists and holds a fact the grid worker cannot read.
    const other = world.sqlite
      .prepare('SELECT count(*) AS c FROM ledger_entries WHERE community_id = ?')
      .get(world.otherCommunityId) as { c: number }
    assert.equal(other.c, 1, 'the foreign community fact exists, so the assertions below are real')

    const crossCommunity = await api(
      world.app,
      'GET',
      `/staff/ledger/entries?communityId=${world.otherCommunityId}`,
      { session: grid },
    )
    assert.equal(crossCommunity.status, 403, 'asking for a foreign community is a 403, not an empty page')

    const crossOverview = await api(
      world.app,
      'GET',
      `/staff/ledger/overview?communityId=${world.otherCommunityId}`,
      { session: grid },
    )
    assert.equal(crossOverview.status, 403)

    for (const path of [
      '/admin/ledger/overview',
      '/admin/ledger/entries',
      '/admin/ledger/anomalies',
    ]) {
      const refused = await api(world.app, 'GET', path, { session: grid })
      assert.equal(refused.status, 403, `网格员 must be refused ${path}`)
      assert.equal(await errorCode(refused), API_ERROR_CODES.forbidden)
    }

    const writeRefused = await api(world.app, 'POST', '/admin/ledger/payments', {
      session: grid,
      body: {
        communityId: world.communityId,
        amountCents: 1_000,
        evidenceRef: '不该落库',
        evidenceKind: 'manual_receipt',
        receivedAt: '2026-11-06T10:00:00.000Z',
        staffId: world.gridStaffId,
      },
    })
    assert.equal(writeRefused.status, 403)
    assert.equal(countByKind(world.sqlite, 'payment_received'), 0)
  } finally {
    world.cleanup()
  }
})


/* -------------------------------------------------------------------------- */
/* Maintainer regression: production route, freeze and Excel export           */
/* -------------------------------------------------------------------------- */

test('real Hono source-sync POST ingests trusted facts, rejects unauthorized writes and replays safely', async () => {
  const world = await makeWorld()
  try {
    assert.equal(entryCount(world.sqlite), 0, 'source fixtures exist but ledger was not yet projected')
    const unauthenticated = await api(world.app, 'POST', '/admin/ledger/sync', { body: {} })
    assert.equal(unauthenticated.status, 401)

    const grid = await gridSession(world.app)
    const forbidden = await api(world.app, 'POST', '/admin/ledger/sync', { session: grid, body: {} })
    assert.equal(forbidden.status, 403)
    assert.equal(entryCount(world.sqlite), 0, 'rejected requests must not write facts')

    const admin = await adminSession(world.app)
    const noCsrf = await world.app.request('/admin/ledger/sync', {
      method: 'POST',
      headers: { cookie: admin.cookies, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(noCsrf.status, 403)
    const badRange = await api(world.app, 'POST', '/admin/ledger/sync', {
      session: admin, body: { from: '2026-11-07', to: '2026-11-01' },
    })
    assert.equal(badRange.status, 400)

    const first = await api(world.app, 'POST', '/admin/ledger/sync', {
      session: admin, body: { from: PERIOD_FROM, to: PERIOD_TO },
    })
    assert.equal(first.status, 200, await first.clone().text())
    const firstResult = await first.json() as { created: number; scanned: number; skipped: number }
    assert.ok(firstResult.created >= 4)
    assert.ok(entryCount(world.sqlite) >= 4)
    const foreign = world.sqlite.prepare(
      'SELECT count(*) AS c FROM ledger_entries WHERE community_id = ?',
    ).get(world.otherCommunityId) as { c: number }
    assert.equal(foreign.c, 1, 'admin projection includes the foreign community fact')

    const replay = await api(world.app, 'POST', '/admin/ledger/sync', {
      session: admin, body: { from: PERIOD_FROM, to: PERIOD_TO },
    })
    assert.equal(replay.status, 200)
    const replayResult = await replay.json() as { created: number; skipped: number }
    assert.equal(replayResult.created, 0)
    assert.ok(replayResult.skipped >= firstResult.created)

    const overview = ledgerOverviewSchema.parse(
      await (await api(world.app, 'GET', '/admin/ledger/overview', { session: admin })).json(),
    )
    assert.equal(overview.totals.entryCount, entryCount(world.sqlite))

    const gridView = ledgerListResponseSchema.parse(
      await (await api(world.app, 'GET', '/staff/ledger/entries?pageSize=100', { session: grid })).json(),
    )
    assert.ok(gridView.items.length > 0)
    assert.ok(gridView.items.every((fact) => fact.communityId === world.communityId))

    // Reopen the file: the source projection was persisted, not an in-memory mock.
    const storedCount = entryCount(world.sqlite)
    world.sqlite.close()
    const reopened = createDatabase(join(world.dir, 'facts.sqlite'), migrationsFolder)
    try {
      assert.equal(entryCount(reopened.sqlite), storedCount)
    } finally {
      reopened.sqlite.close()
    }
  } finally {
    world.cleanup()
  }
})

test('reconciliation CSV reflects confirmed attribution and cannot change ownership after locking', async () => {
  const world = await makeWorld()
  try {
    const admin = await adminSession(world.app)
    const projected = await api(world.app, 'POST', '/admin/ledger/sync', {
      session: admin, body: { from: PERIOD_FROM, to: PERIOD_TO },
    })
    assert.equal(projected.status, 200)
    const entries = ledgerListResponseSchema.parse(
      await (await api(world.app, 'GET', '/admin/ledger/entries?pageSize=100', { session: admin })).json(),
    )
    const local = entries.items.find((row) => row.sourceId === world.localOrderId)
    assert.ok(local)
    const confirm = await api(world.app, 'POST', '/admin/ledger/attributions', {
      session: admin,
      body: { entryId: local.entryId, staffId: world.gridStaffId, note: '已核实归属' },
    })
    assert.equal(confirm.status, 201)

    const create = await api(world.app, 'POST', '/admin/reconciliation/batches', {
      session: admin, body: { periodFrom: PERIOD_FROM, periodTo: PERIOD_TO },
    })
    assert.equal(create.status, 201)
    const batch = await create.json() as { batchId: string; updatedAt: string }
    const detail = await api(world.app, 'GET', `/admin/reconciliation/batches/${batch.batchId}/entries?pageSize=100`, { session: admin })
    assert.equal(detail.status, 200)
    const detailBody = await detail.json() as { items: Array<{ entryId: string; attribution: { state: string; staffId: string | null } }> }
    const joined = detailBody.items.find((row) => row.entryId === local.entryId)
    assert.equal(joined?.attribution.state, 'attributed')
    assert.equal(joined?.attribution.staffId, world.gridStaffId)

    const csvBefore = await api(world.app, 'GET', `/admin/reconciliation/export.csv?batchId=${batch.batchId}`, { session: admin })
    assert.equal(csvBefore.status, 200)
    const csvText = await csvBefore.text()
    const localCsv = csvText.split('\r\n').find((line) => line.includes(world.localOrderId))
    assert.ok(localCsv?.includes('网格员小李'))
    assert.ok(localCsv?.includes('已归属'))

    const lock = await api(world.app, 'POST', `/admin/reconciliation/batches/${batch.batchId}/lock`, {
      session: admin, body: { expectedUpdatedAt: batch.updatedAt },
    })
    assert.equal(lock.status, 200, await lock.clone().text())
    const otherPending = entries.items.find((row) => row.factKind === 'reward_cost')
    assert.ok(otherPending)
    const changeAfterLock = await api(world.app, 'POST', '/admin/ledger/attributions', {
      session: admin, body: { entryId: otherPending.entryId, staffId: world.gridStaffId },
    })
    assert.equal(changeAfterLock.status, 409)
    assert.equal(await errorCode(changeAfterLock), API_ERROR_CODES.ledgerBatchLocked)

    const frozenCsv = await api(world.app, 'GET', `/admin/reconciliation/export.csv?batchId=${batch.batchId}`, { session: admin })
    assert.equal(frozenCsv.status, 200)
    assert.equal(await frozenCsv.text(), csvText, 're-export of a locked statement must be byte-identical')
  } finally {
    world.cleanup()
  }
})

test('CSV export neutralizes formula-leading free-text evidence and source numbers', async () => {
  const world = await makeWorld()
  try {
    const admin = await adminSession(world.app)
    const saved = await api(world.app, 'POST', '/admin/ledger/payments', {
      session: admin,
      body: {
        communityId: world.communityId,
        amountCents: 1234,
        sourceDisplayNo: '=1+1',
        evidenceRef: '@SUM(A1:A3)',
        evidenceKind: 'manual_receipt',
        receivedAt: '2026-11-06T10:00:00.000Z',
        staffId: world.operatorStaffId,
      },
    })
    assert.equal(saved.status, 201)
    const exported = await api(world.app, 'GET',
      `/admin/reconciliation/export.csv?periodFrom=${PERIOD_FROM}&periodTo=${PERIOD_TO}`,
      { session: admin },
    )
    assert.equal(exported.status, 200)
    const bytes = new Uint8Array(await exported.clone().arrayBuffer())
    assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xef, 0xbb, 0xbf], 'file bytes retain UTF-8 BOM')
    const text = await exported.text()
    assert.ok(text.startsWith('流水号,'), 'Response.text() removes the BOM during decoding')
    assert.ok(text.includes(",'=1+1,"))
    assert.ok(text.includes(",'@SUM(A1:A3),"))
  } finally {
    world.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* #166: immutable order ↔ receipt evidence chain (real Hono + SQLite)          */
/* -------------------------------------------------------------------------- */

function markOrderVerified(world: World, orderId: string): void {
  world.sqlite.prepare(
    `UPDATE local_orders
     SET status='verified', verified_at=?, verified_by_user_id=?,
         verification_note=?, updated_at=?
     WHERE id=?`,
  ).run(
    new Date('2026-11-07T03:00:00.000Z').getTime(),
    world.operatorUserId,
    '工作人员已核实登记业务，不代表已收款',
    new Date('2026-11-07T03:00:00.000Z').getTime(),
    orderId,
  )
}

function linkedReceiptRequest(world: World, overrides: Record<string, unknown> = {}) {
  return {
    orderId: world.localOrderId,
    communityId: world.communityId,
    amountCents: 900,
    evidenceKind: 'bank_transfer',
    evidenceRef: 'BANK-LOCAL-LL166-001',
    receivedAt: '2026-11-09T01:00:00.000Z',
    staffId: world.operatorStaffId,
    sourceId: 'receipt-ll166-001',
    ...overrides,
  }
}

test('linked receipt: real HTTP, one immutable payment, staff attribution and full reversal', async () => {
  const world = await makeWorld()
  try {
    const session = await adminSession(world.app)
    const unverified = await api(world.app, 'POST', '/admin/ledger/payments', {
      session, body: linkedReceiptRequest(world),
    })
    assert.equal(unverified.status, 409)
    markOrderVerified(world, world.localOrderId)
    const before = await api(world.app, 'GET',
      `/admin/ledger/orders/${world.localOrderId}/evidence`, { session })
    assert.equal(before.status, 200)
    const initial = await before.json() as { status: string; payment: unknown; canRecord: boolean }
    assert.equal(initial.status, 'no_evidence')
    assert.equal(initial.payment, null)
    assert.equal(initial.canRecord, true)

    const saved = await api(world.app, 'POST', '/admin/ledger/payments', {
      session, body: linkedReceiptRequest(world),
    })
    assert.equal(saved.status, 201)
    const savedEntry = ledgerEntrySchema.parse(await saved.json())
    assert.equal(savedEntry.factKind, 'payment_received')
    assert.equal(savedEntry.attribution.state, 'pending')

    const after = await api(world.app, 'GET',
      `/admin/ledger/orders/${world.localOrderId}/evidence`, { session })
    assert.equal(after.status, 200)
    const linked = await after.json() as {
      status: string; payment: { entryId: string; evidenceRef: string }
    }
    assert.equal(linked.status, 'pending_attribution')
    assert.equal(linked.payment.entryId, savedEntry.entryId)
    assert.equal(linked.payment.evidenceRef, 'BANK-LOCAL-LL166-001')

    const reverseLookup = await api(world.app, 'GET',
      `/admin/ledger/entries/${savedEntry.entryId}/order-evidence`, { session })
    assert.equal(reverseLookup.status, 200)
    assert.equal((await reverseLookup.json() as { order: { orderId: string } }).order.orderId,
      world.localOrderId)

    const noReason = await api(world.app, 'POST', '/admin/ledger/attributions', {
      session, body: { entryId: savedEntry.entryId, staffId: world.gridStaffId },
    })
    assert.equal(noReason.status, 400, 'linked payments require a promotion evidence note')

    const confirmation = await api(world.app, 'POST', '/admin/ledger/attributions', {
      session, body: {
        entryId: savedEntry.entryId, staffId: world.gridStaffId,
        note: '现场邀请记录核验与订单确认一致',
      },
    })
    assert.equal(confirmation.status, 201)
    const verified = await api(world.app, 'GET',
      `/admin/ledger/orders/${world.localOrderId}/evidence`, { session })
    assert.equal(verified.status, 200)
    const verifiedBody = await verified.json() as {
      status: string; payment: { confirmation: { note: string; staffId: string } }
    }
    assert.equal(verifiedBody.status, 'evidence_recorded')
    assert.equal(verifiedBody.payment.confirmation.staffId, world.gridStaffId)
    assert.match(verifiedBody.payment.confirmation.note, /现场邀请/)

    const reversed = await api(world.app, 'POST',
      `/admin/ledger/payments/${savedEntry.entryId}/reverse`, {
        session, body: { staffId: world.operatorStaffId, reason: '收款作废，原单留痕' },
      })
    assert.equal(reversed.status, 201)
    const afterReversal = await api(world.app, 'GET',
      `/admin/ledger/orders/${world.localOrderId}/evidence`, { session })
    assert.equal((await afterReversal.json() as { status: string }).status, 'reversed')

    assert.equal((world.sqlite.prepare('SELECT count(*) AS n FROM ledger_payment_order_links')
      .get() as { n: number }).n, 1)
    assert.throws(() => world.sqlite.prepare(
      'DELETE FROM ledger_payment_order_links WHERE order_id=?',
    ).run(world.localOrderId), /append-only/)
  } finally {
    world.cleanup()
  }
})

test('linked receipt: duplicate/ref replay and wrong-community attempts never create extra money', async () => {
  const world = await makeWorld()
  try {
    const session = await adminSession(world.app)
    markOrderVerified(world, world.localOrderId)
    markOrderVerified(world, world.otherOrderId)
    const csrfMissing = await world.app.request('/admin/ledger/payments', {
      method: 'POST',
      headers: {
        cookie: session.cookies,
        origin: ADMIN_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify(linkedReceiptRequest(world)),
    })
    assert.equal(csrfMissing.status, 403)

    const cross = await api(world.app, 'POST', '/admin/ledger/payments', {
      session,
      body: linkedReceiptRequest(world, { orderId: world.otherOrderId }),
    })
    assert.equal(cross.status, 403)

    const [a, b] = await Promise.all([
      api(world.app, 'POST', '/admin/ledger/payments', {
        session, body: linkedReceiptRequest(world, { sourceId: 'concurrent-one' }),
      }),
      api(world.app, 'POST', '/admin/ledger/payments', {
        session, body: linkedReceiptRequest(world, { sourceId: 'concurrent-two' }),
      }),
    ])
    assert.deepEqual([a.status, b.status].sort(), [201, 409])
    const retry = await api(world.app, 'POST', '/admin/ledger/payments', {
      session, body: linkedReceiptRequest(world, { sourceId: 'concurrent-one' }),
    })
    assert.equal(retry.status, 409)

    const extraOrder = randomUUID()
    world.db.insert(localOrders).values({
      id: extraOrder,
      communityId: world.communityId,
      productId: (world.sqlite.prepare(
        'SELECT product_id AS value FROM local_orders WHERE id=?',
      ).get(world.localOrderId) as { value: string }).value,
      residentUserId: (world.sqlite.prepare(
        'SELECT resident_user_id AS value FROM local_orders WHERE id=?',
      ).get(world.localOrderId) as { value: string }).value,
      idempotencyKey: randomUUID(),
      status: 'registered',
      recordSource: 'resident',
      productName: '青菜另单',
      unitPriceCents: 450,
      quantity: 2,
      totalCents: 900,
      createdAt: new Date('2026-11-06T09:00:00.000Z'),
      updatedAt: new Date('2026-11-06T09:00:00.000Z'),
    }).run()
    markOrderVerified(world, extraOrder)
    const stolenRef = await api(world.app, 'POST', '/admin/ledger/payments', {
      session,
      body: linkedReceiptRequest(world, { orderId: extraOrder, sourceId: 'other-source' }),
    })
    assert.equal(stolenRef.status, 409)
    assert.equal((world.sqlite.prepare(
      'SELECT count(*) AS n FROM ledger_entries WHERE fact_kind=\'payment_received\'',
    ).get() as { n: number }).n, 1)
    assert.equal((world.sqlite.prepare('SELECT count(*) AS n FROM ledger_payment_order_links')
      .get() as { n: number }).n, 1)
  } finally {
    world.cleanup()
  }
})

test('linked receipt mismatch is visible and blocked without claiming real settlement', async () => {
  const world = await makeWorld()
  try {
    const session = await adminSession(world.app)
    markOrderVerified(world, world.localOrderId)
    const recorded = await api(world.app, 'POST', '/admin/ledger/payments', {
      session,
      body: linkedReceiptRequest(world, { amountCents: 800, sourceId: 'mismatch-1',
        evidenceRef: 'BANK-MISMATCH-166' }),
    })
    assert.equal(recorded.status, 201)
    const evidence = await api(world.app, 'GET',
      `/admin/ledger/orders/${world.localOrderId}/evidence`, { session })
    assert.equal(evidence.status, 200)
    const result = await evidence.json() as {
      status: string; canRecord: boolean; blockingReasons: string[]
    }
    assert.equal(result.status, 'amount_mismatch')
    assert.equal(result.canRecord, false)
    assert.ok(result.blockingReasons.some((reason) => reason.includes('不一致')))
  } finally {
    world.cleanup()
  }
})

test('previous unlinked receipt cannot be counted again under a new order/source key', async () => {
  const world = await makeWorld()
  try {
    const session = await adminSession(world.app)
    markOrderVerified(world, world.localOrderId)
    const base = linkedReceiptRequest(world)
    const legacy = await api(world.app, 'POST', '/admin/ledger/payments', {
      session,
      body: {
        ...base,
        orderId: undefined,
        sourceId: 'old-unlinked-receipt',
        evidenceRef: 'ＢＡＮＫ－ＬＯＣＡＬ－ＬＬ１６６－００１',
      },
    })
    assert.equal(legacy.status, 201)
    const duplicateProof = await api(world.app, 'POST', '/admin/ledger/payments', {
      session,
      body: { ...base, sourceId: 'new-linked-receipt' },
    })
    assert.equal(duplicateProof.status, 409)
    assert.equal((world.sqlite.prepare('SELECT count(*) AS n FROM ledger_payment_order_links')
      .get() as { n: number }).n, 0, 'no inferred link for legacy receipts')
    assert.equal((world.sqlite.prepare(
      "SELECT count(*) AS n FROM ledger_entries WHERE fact_kind='payment_received'",
    ).get() as { n: number }).n, 1)
  } finally {
    world.cleanup()
  }
})

test('linked receipt attribution refuses an operator instead of treating recorder as promoter', async () => {
  const world = await makeWorld()
  try {
    const session = await adminSession(world.app)
    markOrderVerified(world, world.localOrderId)
    const saved = await api(world.app, 'POST', '/admin/ledger/payments', {
      session, body: linkedReceiptRequest(world),
    })
    assert.equal(saved.status, 201)
    const entry = ledgerEntrySchema.parse(await saved.json())
    const attempted = await api(world.app, 'POST', '/admin/ledger/attributions', {
      session, body: {
        entryId: entry.entryId,
        staffId: world.operatorStaffId,
        note: '曾经由本人录入，但不具备推广归属身份',
      },
    })
    assert.equal(attempted.status, 400)
    const evidence = await api(world.app, 'GET',
      `/admin/ledger/orders/${world.localOrderId}/evidence`, { session })
    assert.equal((await evidence.json() as { status: string }).status, 'pending_attribution')
  } finally {
    world.cleanup()
  }
})

test('a locked registration period refuses newly linked receipts even if verification was on another day', async () => {
  const world = await makeWorld()
  try {
    markOrderVerified(world, world.localOrderId)
    // Registered Nov 2 inside the locked period, verified Nov 8 outside it.
    // Looking only at verifiedAt would illegally bypass the frozen original.
    world.sqlite.prepare('UPDATE local_orders SET verified_at=?, updated_at=? WHERE id=?')
      .run(Date.parse('2026-11-08T03:00:00Z'), Date.parse('2026-11-08T03:00:00Z'),
        world.localOrderId)
    syncLedgerFacts(world.db, adminActor(world), { from: PERIOD_FROM, to: PERIOD_TO }, { now: CLOCK })
    const batch = createBatch(world.db, adminActor(world),
      { periodFrom: PERIOD_FROM, periodTo: PERIOD_TO }, { now: CLOCK })
    const locked = lockBatch(world.db, adminActor(world), batch.batchId,
      { expectedUpdatedAt: batch.updatedAt },
      { now: new Date(CLOCK.getTime() + 60_000) })
    assert.equal(locked.status, 'locked')
    const session = await adminSession(world.app)
    const before = await api(world.app, 'GET',
      `/admin/ledger/orders/${world.localOrderId}/evidence`, { session })
    assert.equal((await before.json() as { status: string }).status, 'locked_period')

    const receipt = await api(world.app, 'POST', '/admin/ledger/payments', {
      session, body: linkedReceiptRequest(world),
    })
    assert.equal(receipt.status, 409)
    assert.equal((world.sqlite.prepare('SELECT count(*) AS n FROM ledger_payment_order_links')
      .get() as { n: number }).n, 0)
    const after = getBatchEntries(world.db, batch.batchId, { now: CLOCK })
    assert.equal(after.stored.totalCents, locked.totalCents)
  } finally {
    world.cleanup()
  }
})

test('long receipt evidence retains the full proof while keeping response display number bounded', async () => {
  const world = await makeWorld()
  try {
    markOrderVerified(world, world.localOrderId)
    const session = await adminSession(world.app)
    const proof = 'BANK-' + 'A'.repeat(130)
    const response = await api(world.app, 'POST', '/admin/ledger/payments', {
      session, body: linkedReceiptRequest(world, {
        evidenceRef: proof,
        sourceId: 'long-proof-166',
      }),
    })
    assert.equal(response.status, 201)
    const entry = ledgerEntrySchema.parse(await response.json())
    assert.equal(entry.sourceDisplayNo.length, 80)
    assert.equal(entry.evidence.ref, proof)
  } finally {
    world.cleanup()
  }
})


/* -------------------------------------------------------------------------- */
/* #183 · real seller identity is never inferred from an order/community      */
/* -------------------------------------------------------------------------- */

test('settlement party API: no configured seller, explicit verified mapping and immutable order snapshot', async () => {
  const world = await makeWorld()
  try {
    const session = await adminSession(world.app)
    const prefix = '/admin/settlement'
    const initial = await api(world.app, 'GET',
      prefix + '/orders/' + world.localOrderId + '/party', { session })
    assert.equal(initial.status, 200)
    assert.equal((await initial.json() as { sellerStatus: string }).sellerStatus, 'missing_seller')
    const empty = await api(world.app, 'GET', prefix + '/parties', { session })
    assert.deepEqual((await empty.json() as { items: unknown[] }).items, [])

    const createParty = async (role: string, label: string, proof: string | null) => {
      const response = await api(world.app, 'POST', prefix + '/parties', {
        session, body: { role, legalName: label, registryRef: 'TEST-REG-' + role, verificationRef: proof },
      })
      assert.equal(response.status, 201)
      return await response.json() as { id: string; verifiedAt: string | null }
    }
    const seller = await createParty('seller', '测试商品销售主体', 'TEST-SELLER-REGISTRY-APPROVAL')
    const platform = await createParty('sanchuang', '测试三创主体', 'TEST-PLATFORM-APPROVAL')
    const carrier = await createParty('guangdian', '测试广电主体', 'TEST-CARRIER-APPROVAL')
    const unverified = await createParty('seller', '尚未核验的商户', null)
    assert.equal(unverified.verifiedAt, null)
    const replayParty = await api(world.app, 'POST', prefix + '/parties', {
      session, body: {
        role: 'seller', legalName: '重复商户版本',
        registryRef: 'TEST-REG-seller', verificationRef: 'TEST-SELLER-REGISTRY-APPROVAL',
      },
    })
    assert.equal(replayParty.status, 409, 'same verified identity and evidence cannot produce two versions')

    const productId = (world.sqlite.prepare('SELECT product_id AS id FROM local_orders WHERE id=?')
      .get(world.localOrderId) as { id: string }).id
    const body = {
      communityId: world.communityId, productId,
      sellerPartyId: seller.id, sanchuangPartyId: platform.id,
      guangdianPartyId: carrier.id, agreementRef: 'TEST-CONTRACT-2026-001',
      effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30',
    }
    const pendingParty = await api(world.app, 'POST', prefix + '/mappings', {
      session, body: { ...body, sellerPartyId: unverified.id },
    })
    assert.equal(pendingParty.status, 409)
    const wrongScope = await api(world.app, 'POST', prefix + '/mappings', {
      session, body: { ...body, communityId: world.otherCommunityId },
    })
    assert.equal(wrongScope.status, 403)
    const mappingResponse = await api(world.app, 'POST', prefix + '/mappings', {
      session, body,
    })
    assert.equal(mappingResponse.status, 201)
    const mapping = await mappingResponse.json() as { id: string }

    const samePeriod = await api(world.app, 'POST', prefix + '/mappings', {
      session, body: { ...body, effectiveFrom: '2026-11-15', effectiveTo: '2026-12-15' },
    })
    assert.equal(samePeriod.status, 409)
    const beforeVerified = await api(world.app, 'POST',
      prefix + '/orders/' + world.localOrderId + '/party', {
        session, body: { mappingId: mapping.id, confirmationRef: 'TEST-HUMAN-REVIEW-001' },
      })
    assert.equal(beforeVerified.status, 409)

    markOrderVerified(world, world.localOrderId)
    const confirm = await api(world.app, 'POST',
      prefix + '/orders/' + world.localOrderId + '/party', {
        session, body: { mappingId: mapping.id, confirmationRef: 'TEST-HUMAN-REVIEW-001' },
      })
    assert.equal(confirm.status, 201)
    const data = await confirm.json() as { sellerPartyId: string; mappingId: string; confirmationRef: string }
    assert.equal(data.sellerPartyId, seller.id)
    assert.equal(data.mappingId, mapping.id)
    assert.equal(data.confirmationRef, 'TEST-HUMAN-REVIEW-001')

    const saved = await api(world.app, 'GET',
      prefix + '/orders/' + world.localOrderId + '/party', { session })
    assert.equal(saved.status, 200)
    assert.equal((await saved.json() as { sellerStatus: string }).sellerStatus, 'verified')
    const repeated = await api(world.app, 'POST',
      prefix + '/orders/' + world.localOrderId + '/party', {
        session, body: { mappingId: mapping.id, confirmationRef: 'TEST-REPLAY' },
      })
    assert.equal(repeated.status, 409)
    assert.throws(() => world.sqlite.prepare(
      'UPDATE settlement_order_party_snapshots SET agreement_ref=? WHERE order_id=?',
    ).run('hijack', world.localOrderId), /immutable/)
    assert.equal((world.sqlite.prepare(
      "SELECT count(*) AS n FROM audit_logs WHERE event LIKE 'settlement.%'",
    ).get() as { n: number }).n, 6)

    const nextPeriod = await api(world.app, 'POST', prefix + '/mappings', {
      session, body: { ...body, effectiveFrom: '2026-12-01', effectiveTo: '2026-12-31' },
    })
    assert.equal(nextPeriod.status, 201)
    const historic = await api(world.app, 'GET',
      prefix + '/orders/' + world.localOrderId + '/party', { session })
    assert.equal((await historic.json() as { snapshot: { mappingId: string } }).snapshot.mappingId,
      mapping.id, 'later product mapping must never change historic order identity')
  } finally {
    world.cleanup()
  }
})

test('settlement party routes enforce admin writes, CSRF+Origin, grid rejection and scoped reads', async () => {
  const world = await makeWorld()
  try {
    const session = await adminSession(world.app)
    const grid = await gridSession(world.app)
    assert.equal((await api(world.app, 'GET', '/admin/settlement/parties', {
      session: grid,
    })).status, 403)
    assert.equal((await api(world.app, 'POST', '/admin/settlement/parties', {
      session: grid, body: {
        role: 'seller', legalName: '伪商户', registryRef: 'FAKE', verificationRef: 'FAKE',
      },
    })).status, 403)
    const withoutCsrf = await world.app.request('/admin/settlement/parties', {
      method: 'POST',
      headers: {
        cookie: session.cookies, origin: ADMIN_ORIGIN, 'content-type': 'application/json',
      },
      body: JSON.stringify({
        role: 'seller', legalName: '没有防伪令牌', registryRef: 'FAKE',
        verificationRef: 'FAKE',
      }),
    })
    assert.equal(withoutCsrf.status, 403)
    const hostileOrigin = await world.app.request('/admin/settlement/parties', {
      method: 'POST',
      headers: {
        cookie: session.cookies,
        origin: 'https://evil.example',
        'x-csrf-token': session.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        role: 'seller', legalName: '跨域伪主体', registryRef: 'FAKE',
        verificationRef: 'FAKE',
      }),
    })
    assert.equal(hostileOrigin.status, 403)
    const absentOrder = await api(world.app, 'GET',
      '/admin/settlement/orders/' + randomUUID() + '/party', { session })
    assert.equal(absentOrder.status, 404)
    const stranger = { userId: world.operatorUserId,
      staffId: world.operatorStaffId, role: 'operator' as const }
    const { listSettlementMappings, listSettlementParties, readOrderPartySnapshot } =
      await import('../src/ledger/settlement-parties.js')
    assert.deepEqual(listSettlementMappings(world.db, stranger, world.communityId).items, [])
    assert.deepEqual(listSettlementParties(world.db, stranger, world.communityId).items, [])
    assert.throws(() => listSettlementParties(world.db, stranger), /请选择有权社区/)
    assert.throws(() => readOrderPartySnapshot(world.db, stranger, world.otherOrderId), /无权访问/)
  } finally {
    world.cleanup()
  }
})


test('settlement identity migration 0018 upgrades a populated 0017 DB without touching old facts', async () => {
  const { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } =
    await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'll-settlement-upgrade-'))
  try {
    const oldMigrations = join(root, 'old')
    mkdirSync(join(oldMigrations, 'meta'), { recursive: true })
    for (const name of readdirSync(migrationsFolder)) {
      if (/^[0-9]{4}_.*\.sql$/u.test(name) && Number(name.slice(0, 4)) < 18) {
        copyFileSync(join(migrationsFolder, name), join(oldMigrations, name))
      }
    }
    const current = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    assert.equal(current.entries.find((entry) => entry.idx === 18)?.tag, '0018_settlement_parties')
    current.entries = current.entries.filter((entry) => entry.idx < 18)
    writeFileSync(join(oldMigrations, 'meta/_journal.json'), JSON.stringify(current))
    const dbPath = join(root, 'legacy.sqlite')
    const legacy = createDatabase(dbPath, oldMigrations)
    const communityId = randomUUID()
    legacy.db.insert(communities).values({
      id: communityId, name: '升级前已有社区',
      createdAt: new Date('2026-11-01T00:00:00Z'),
    }).run()
    legacy.sqlite.close()

    const upgraded = createDatabase(dbPath, migrationsFolder)
    try {
      const name = upgraded.sqlite.prepare('SELECT name FROM communities WHERE id=?')
        .get(communityId) as { name: string }
      assert.equal(name.name, '升级前已有社区')
      const tables = upgraded.sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'settlement_%'",
      ).all() as Array<{ name: string }>
      const originalIdentityTables = [
        'settlement_order_party_snapshots',
        'settlement_parties',
        'settlement_product_mappings',
      ]
      assert.deepEqual(
        tables.map((row) => row.name)
          .filter((name) => originalIdentityTables.includes(name)).sort(),
        originalIdentityTables.slice().sort(),
        '0018 identity tables must survive migration to the current schema',
      )
      assert.equal((upgraded.sqlite.prepare(
        'SELECT count(*) AS n FROM ledger_entries',
      ).get() as { n: number }).n, 0)
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------- */
/* #184 · read-only pending settlement candidate projection                     */
/* -------------------------------------------------------------------------- */

test('settlement candidate API: no contracts, no receipt, correct scoped pending amounts', async () => {
  const world = await makeWorld()
  try {
    const session = await adminSession(world.app)
    const response = await api(world.app, 'GET',
      '/admin/settlement/candidates?page=1&pageSize=20&communityId=' + world.communityId,
      { session })
    assert.equal(response.status, 200)
    const result = await response.json() as {
      items: Array<{ orderId: string; receipt: unknown;
        blockingReasons: string[]; payableAmountCents: number | null;
        sellerStatus: string }>;
      total: number; payableAmountCents: number | null;
      summaryScope: string;
      summary: { recordedReceiptGrossCents: number; blockedItems: number }
    }
    assert.equal(result.total, 1, 'the other community is excluded')
    assert.equal(result.items[0]?.orderId, world.localOrderId)
    assert.equal(result.items[0]?.receipt, null)
    assert.equal(result.items[0]?.payableAmountCents, null)
    assert.equal(result.payableAmountCents, null)
    assert.equal(result.summaryScope, 'page')
    assert.equal(result.summary.recordedReceiptGrossCents, 0)
    assert.equal(result.summary.blockedItems, 1)
    assert.equal(result.items[0]?.sellerStatus, 'missing_seller')
    assert.equal((result.items[0] as {periodSource?:string})?.periodSource, 'order_registration')
    assert.ok(result.items[0]?.blockingReasons.includes('missing_receipt'))
    assert.ok(result.items[0]?.blockingReasons.includes('missing_seller'))
    assert.ok(result.items[0]?.blockingReasons.includes('missing_approved_rule'))
    const empty = await api(world.app, 'GET',
      '/admin/settlement/candidates?from=2026-12-01&to=2026-12-31', { session })
    assert.equal(empty.status, 200)
    assert.equal((await empty.json() as { total: number }).total, 0)
    assert.equal((await api(world.app, 'GET',
      '/admin/settlement/candidates?from=2026-11-30&to=2026-11-01',
      { session })).status, 400)
    for (const badDay of ['2026-02-31', '2026-11-00', '2026-04-31', '2025-02-29']) {
      for (const key of ['from', 'to']) {
        const rejected = await api(world.app, 'GET',
          '/admin/settlement/candidates?' + key + '=' + badDay, { session })
        assert.equal(rejected.status, 400,
          'impossible calendar day ' + key + '=' + badDay + ' must not roll into another month')
      }
    }
    const leapDay = await api(world.app, 'GET',
      '/admin/settlement/candidates?from=2028-02-29&to=2028-02-29', { session })
    assert.equal(leapDay.status, 200, 'valid leap date must be accepted')
  } finally {
    world.cleanup()
  }
})

test('settlement candidate: linked receipt, confirmed grid, locked facts and reversal never create payout', async () => {
  const world = await makeWorld()
  try {
    const session = await adminSession(world.app)
    markOrderVerified(world, world.localOrderId)
    const saved = await api(world.app, 'POST', '/admin/ledger/payments', {
      session, body: linkedReceiptRequest(world),
    })
    assert.equal(saved.status, 201)
    const payment = ledgerEntrySchema.parse(await saved.json())
    // Created Nov 2, but receipt actually received Nov 9: the NOV 9 period
    // must show this order, not silently lose it by using registration date.
    const crossPeriod = await api(world.app, 'GET',
      '/admin/settlement/candidates?communityId=' + world.communityId +
      '&from=2026-11-09&to=2026-11-09', { session })
    assert.equal(crossPeriod.status, 200)
    const crossing = await crossPeriod.json() as {
      total: number; items: Array<{periodSource: string; periodAt: string}>;
      periodPolicy: string;
    }
    assert.equal(crossing.total, 1)
    assert.equal(crossing.items[0]?.periodSource, 'linked_receipt')
    assert.equal(crossing.periodPolicy, 'linked_receipt_else_order_registration')
    assert.equal(crossing.items[0]?.periodAt, '2026-11-09T01:00:00.000Z')
    const path = '/admin/settlement/candidates?communityId=' + world.communityId
    const before = await api(world.app, 'GET', path, { session })
    const pending = (await before.json() as { items: Array<{ blockingReasons: string[] }> }).items[0]
    assert.ok(pending?.blockingReasons.includes('attribution_pending'))
    assert.ok(pending?.blockingReasons.includes('receipt_unreconciled'))

    const confirmed = await api(world.app, 'POST', '/admin/ledger/attributions', {
      session, body: {
        entryId: payment.entryId, staffId: world.gridStaffId,
        note: '测试：推广记录及邀请来源交叉核验',
      },
    })
    assert.equal(confirmed.status, 201)
    syncLedgerFacts(world.db, adminActor(world), {
      from: '2026-11-01', to: '2026-11-10',
    }, { now: CLOCK })
    const batch = createBatch(world.db, adminActor(world), {
      periodFrom: '2026-11-01', periodTo: '2026-11-10',
    }, { now: CLOCK })
    const locked = lockBatch(world.db, adminActor(world), batch.batchId,
      { expectedUpdatedAt: batch.updatedAt },
      { now: new Date(CLOCK.getTime() + 60_000) })
    assert.equal(locked.status, 'locked')
    const after = await api(world.app, 'GET', path, { session })
    assert.equal(after.status, 200)
    const item = (await after.json() as { items: Array<{
      receipt: { amountCents: number; entryId: string };
      receiptReconciliationState: string; blockingReasons: string[];
      payableAmountCents: number | null; settlementAmountStatus: string;
    }>; summary: { recordedReceiptGrossCents: number } }).items[0]
    assert.equal(item?.receipt.entryId, payment.entryId)
    assert.equal(item?.receipt.amountCents, 900)
    assert.equal(item?.receiptReconciliationState, 'reconciled')
    assert.equal(item?.blockingReasons.includes('receipt_unreconciled'), false)
    assert.equal(item?.blockingReasons.includes('attribution_pending'), false)
    assert.ok(item?.blockingReasons.includes('missing_seller'))
    assert.ok(item?.blockingReasons.includes('missing_approved_rule'))
    assert.equal(item?.payableAmountCents, null)
    assert.equal(item?.settlementAmountStatus, 'pending_rule')

    const reversed = await api(world.app, 'POST',
      '/admin/ledger/payments/' + payment.entryId + '/reverse', {
        session, body: { staffId: world.operatorStaffId, reason: '测试：原凭据被证实无效' },
      })
    assert.equal(reversed.status, 201)
    const afterReverse = await api(world.app, 'GET', path, { session })
    const reversedItem = (await afterReverse.json() as {
      items: Array<{ blockingReasons: string[]; payableAmountCents: null }>;
      summary: { reversedReceiptCents: number; recordedReceiptGrossCents: number }
    })
    assert.ok(reversedItem.items[0]?.blockingReasons.includes('receipt_reversed'))
    assert.equal(reversedItem.summary.recordedReceiptGrossCents, 900,
      'gross registered money does not silently disappear')
    assert.equal(reversedItem.summary.reversedReceiptCents, 900)
    assert.equal(reversedItem.items[0]?.payableAmountCents, null)
  } finally {
    world.cleanup()
  }
})

test('settlement candidate role scope, pagination and malformed filters reject leakage', async () => {
  const world = await makeWorld()
  try {
    const session = await adminSession(world.app)
    const grid = await gridSession(world.app)
    assert.equal((await api(world.app, 'GET', '/admin/settlement/candidates',
      { session: grid })).status, 403)
    assert.equal((await api(world.app, 'GET', '/admin/settlement/candidates')).status, 401)
    const one = await api(world.app, 'GET',
      '/admin/settlement/candidates?page=1&pageSize=1', { session })
    const two = await api(world.app, 'GET',
      '/admin/settlement/candidates?page=2&pageSize=1', { session })
    assert.equal(one.status, 200)
    assert.equal(two.status, 200)
    assert.equal((await one.json() as { total: number; items: unknown[] }).total, 2)
    assert.equal((await two.json() as { total: number; items: unknown[] }).items.length, 1)
    const { listSettlementCandidates } =
      await import('../src/ledger/settlement-candidates.js')
    const operator = {
      userId: world.operatorUserId, staffId: world.operatorStaffId,
      role: 'operator' as const,
    }
    const scoped = listSettlementCandidates(world.db, operator, { page: 1, pageSize: 50 })
    assert.equal(scoped.total, 1)
    assert.equal(scoped.items[0]?.communityId, world.communityId)
    assert.throws(() => listSettlementCandidates(world.db, operator, {
      page: 1, pageSize: 50, communityId: world.otherCommunityId,
    }), /无权访问/)
    assert.equal((await api(world.app, 'GET',
      '/admin/settlement/candidates?pageSize=1000', { session })).status, 400)
  } finally {
    world.cleanup()
  }
})

test('settlement candidates consume a confirmed real merchant but still refuse fabricated payout', async () => {
  const world = await makeWorld()
  try {
    const session = await adminSession(world.app)
    markOrderVerified(world, world.localOrderId)
    const ids: Record<string, string> = {}
    for (const role of ['seller', 'sanchuang', 'guangdian']) {
      const r = await api(world.app, 'POST', '/admin/settlement/parties', {
        session, body: {
          role, legalName: '测试' + role, registryRef: 'TEST-REG-' + role,
          verificationRef: 'TEST-EVIDENCE-' + role,
        },
      })
      assert.equal(r.status, 201)
      ids[role] = (await r.json() as { id: string }).id
    }
    const product = world.sqlite.prepare('SELECT product_id AS id FROM local_orders WHERE id=?')
      .get(world.localOrderId) as { id: string }
    const map = await api(world.app, 'POST', '/admin/settlement/mappings', {
      session, body: {
        communityId: world.communityId, productId: product.id,
        sellerPartyId: ids.seller, sanchuangPartyId: ids.sanchuang,
        guangdianPartyId: ids.guangdian,
        agreementRef: 'TEST-MERCHANT-AGREEMENT',
        effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30',
      },
    })
    assert.equal(map.status, 201)
    const mappingId = (await map.json() as { id: string }).id
    const confirmed = await api(world.app, 'POST',
      '/admin/settlement/orders/' + world.localOrderId + '/party', {
        session, body: { mappingId, confirmationRef: 'TEST-HUMAN-CONFIRMATION' },
      })
    assert.equal(confirmed.status, 201)

    const response = await api(world.app, 'GET',
      '/admin/settlement/candidates?communityId=' + world.communityId, { session })
    assert.equal(response.status, 200)
    const data = await response.json() as {
      items: Array<{
        sellerStatus: string; orderParty: { sellerPartyId: string } | null;
        blockingReasons: string[]; payableAmountCents: number | null
      }>;
    }
    assert.equal(data.items[0]?.sellerStatus, 'verified')
    assert.equal(data.items[0]?.orderParty?.sellerPartyId, ids.seller)
    assert.equal(data.items[0]?.payableAmountCents, null)
    assert.ok(data.items[0]?.blockingReasons.includes('missing_approved_rule'),
      'even verified entities without approved rates must remain 待核定')
  } finally {
    world.cleanup()
  }
})


/* -------------------------------------------------------------------------- */
/* #185 · admin-attested immutable rules + integer-cent trial settlement       */
/* -------------------------------------------------------------------------- */

const TEST_TERMS_185 = {
  feeBase: 'actual_received' as const,
  processorFeeBps: 100,
  processorFeeOwner: 'seller' as const,
  ratesBps: { seller: 7000, sanchuang: 1000, guangdian: 2000 },
  roundingRecipient: 'seller' as const,
  roundingPolicy: 'floor_then_named_remainder' as const,
  processorFeeRounding: 'floor' as const,
  reversalPolicy: 'full_reversal_blocks' as const,
  partialRefundPolicy: 'unsupported_blocks' as const,
}

test('pure settlement calculator conserves every cent and rejects unapproved money assumptions', async () => {
  const { allocateSettlementCents } = await import('../src/ledger/settlement-calculator.js')
  const regular = allocateSettlementCents(900, TEST_TERMS_185)
  assert.deepEqual(regular, {
    blockingReason: null,
    allocation: {
      grossReceivedCents: 900,
      processorFeeCents: 9,
      sellerNetCents: 621,
      sanchuangNetCents: 90,
      guangdianNetCents: 180,
      totalNetCents: 891,
      conservedTotalCents: 900,
      roundingResidualCents: 0,
    },
  })
  const oneCent = allocateSettlementCents(1, {
    ...TEST_TERMS_185, processorFeeBps: 0, processorFeeOwner: 'none',
    ratesBps: { seller: 3333, sanchuang: 3333, guangdian: 3334 },
  })
  assert.equal(oneCent.allocation?.sellerNetCents, 1)
  assert.equal(oneCent.allocation?.roundingResidualCents, 1)
  assert.equal(oneCent.allocation?.conservedTotalCents, 1)
  const twoCents = allocateSettlementCents(2, {
    ...TEST_TERMS_185, processorFeeBps: 0, processorFeeOwner: 'none',
    ratesBps: { seller: 3333, sanchuang: 3333, guangdian: 3334 },
    roundingRecipient: 'guangdian',
  })
  assert.equal(twoCents.allocation?.guangdianNetCents, 2)
  assert.equal(twoCents.allocation?.roundingResidualCents, 2)

  const large = allocateSettlementCents(Number.MAX_SAFE_INTEGER, {
    ...TEST_TERMS_185, processorFeeBps: 0, processorFeeOwner: 'none',
  })
  assert.equal(large.allocation?.conservedTotalCents, Number.MAX_SAFE_INTEGER)
  assert.equal((large.allocation?.sellerNetCents ?? 0) +
    (large.allocation?.sanchuangNetCents ?? 0) +
    (large.allocation?.guangdianNetCents ?? 0),
    Number.MAX_SAFE_INTEGER)
  const impossibleFee = allocateSettlementCents(900, {
    ...TEST_TERMS_185, processorFeeBps: 5000,
    processorFeeOwner: 'sanchuang',
  })
  assert.equal(impossibleFee.allocation, null)
  assert.equal(impossibleFee.blockingReason, 'fee_exceeds_owner_share')
  assert.throws(() => allocateSettlementCents(0, TEST_TERMS_185), RangeError)
  assert.throws(() => allocateSettlementCents(-1, TEST_TERMS_185), RangeError)
  assert.throws(() => allocateSettlementCents(0.5, TEST_TERMS_185), RangeError)
  assert.throws(() => allocateSettlementCents(Number.MAX_SAFE_INTEGER + 1, TEST_TERMS_185), RangeError)
  assert.throws(() => allocateSettlementCents(900, {
    ...TEST_TERMS_185, ratesBps: { seller: 7000, sanchuang: 1000, guangdian: 1999 },
  }), RangeError)
})

async function ruleSetup185(world: World, receiptCents = 900) {
  const session = await adminSession(world.app)
  const parties: Record<string, string> = {}
  for (const role of ['seller', 'sanchuang', 'guangdian']) {
    const r = await api(world.app, 'POST', '/admin/settlement/parties', {
      session, body: {
        role, legalName: 'TEST 185 ' + role,
        registryRef: 'TEST-185-REG-' + role,
        verificationRef: 'TEST-185-VERIFIED-' + role,
      },
    })
    assert.equal(r.status, 201)
    parties[role] = (await r.json() as { id: string }).id
  }
  const productId = (world.sqlite.prepare('SELECT product_id AS id FROM local_orders WHERE id=?')
    .get(world.localOrderId) as { id: string }).id
  const mapping = await api(world.app, 'POST', '/admin/settlement/mappings', {
    session, body: {
      communityId: world.communityId, productId,
      sellerPartyId: parties.seller, sanchuangPartyId: parties.sanchuang,
      guangdianPartyId: parties.guangdian,
      agreementRef: 'TEST-185-THREE-PARTY-CONTRACT',
      effectiveFrom: '2026-11-01', effectiveTo: '2026-11-30',
    },
  })
  assert.equal(mapping.status, 201)
  const mappingId = (await mapping.json() as { id: string }).id
  markOrderVerified(world, world.localOrderId)
  const confirmation = await api(world.app, 'POST',
    '/admin/settlement/orders/' + world.localOrderId + '/party', {
      session, body: { mappingId, confirmationRef: 'TEST-185-HUMAN-IDENTITY-CHECK' },
    })
  assert.equal(confirmation.status, 201)
  const receipt = await api(world.app, 'POST', '/admin/ledger/payments', {
    session, body: linkedReceiptRequest(world, {
      evidenceRef: 'TEST-185-RECEIPT-001',
      sourceId: 'TEST-185-RECEIPT-SOURCE-001',
      amountCents: receiptCents,
    }),
  })
  assert.equal(receipt.status, 201)
  const payment = ledgerEntrySchema.parse(await receipt.json())
  const attribution = await api(world.app, 'POST', '/admin/ledger/attributions', {
    session, body: {
      entryId: payment.entryId,
      staffId: world.gridStaffId,
      note: '测试：网格员推广来源经业务核验确认',
    },
  })
  assert.equal(attribution.status, 201)
  syncLedgerFacts(world.db, adminActor(world),
    { from: '2026-11-01', to: '2026-11-10' }, { now: CLOCK })
  const batch = createBatch(world.db, adminActor(world),
    { periodFrom: '2026-11-01', periodTo: '2026-11-10' }, { now: CLOCK })
  const locked = lockBatch(world.db, adminActor(world), batch.batchId,
    { expectedUpdatedAt: batch.updatedAt },
    { now: new Date(CLOCK.getTime() + 60_000) })
  assert.equal(locked.status, 'locked')
  return { session, mappingId, paymentEntryId: payment.entryId }
}

function ruleInput185(mappingId: string) {
  return {
    mappingId,
    agreementRef: 'TEST-185-THREE-PARTY-CONTRACT',
    approvalEvidenceRef: 'TEST-185-CONTRACT-APPROVAL-V1',
    approvalOn: '2026-10-30',
    effectiveFrom: '2026-11-01', effectiveTo: '2026-11-10',
    ...TEST_TERMS_185,
  }
}

test('real Hono/SQLite approved rule: 0 defaults, locked verified receipt quote, immutable two versions', async () => {
  const world = await makeWorld()
  try {
    const { session, mappingId, paymentEntryId } = await ruleSetup185(world)
    const list = await api(world.app, 'GET', '/admin/settlement/rules', { session })
    assert.equal(list.status, 200)
    assert.deepEqual((await list.json() as { items: unknown[] }).items, [],
      'zero business rates in production database, never seed approved defaults')
    const quoteUrl = '/admin/settlement/quotes'
    const initial = await api(world.app, 'POST', quoteUrl, {
      session, body: { orderId: world.localOrderId },
    })
    assert.equal(initial.status, 200)
    const pending = await initial.json() as {
      status: string; allocation: unknown; rule: unknown; payableAmountCents: unknown
    }
    assert.equal(pending.status, 'pending_rule')
    assert.equal(pending.allocation, null)
    assert.equal(pending.rule, null)
    assert.equal(pending.payableAmountCents, null)

    const first = await api(world.app, 'POST', '/admin/settlement/rules', {
      session, body: ruleInput185(mappingId),
    })
    assert.equal(first.status, 201)
    const rule = await first.json() as {
      id: string; version: number; approvalStatus: string; approvedByUserId: string
    }
    assert.equal(rule.version, 1)
    assert.equal(rule.approvalStatus, 'admin_attested')
    assert.equal(rule.approvedByUserId, world.adminUserId)

    const simulated = await api(world.app, 'POST', quoteUrl, {
      session, body: { orderId: world.localOrderId },
    })
    assert.equal(simulated.status, 200)
    const result = await simulated.json() as {
      quoteOnly: boolean; status: string; payableAmountCents: null;
      receiptEntryId: string; rule: { id: string; version: number };
      allocation: { grossReceivedCents: number; processorFeeCents: number;
        sellerNetCents: number; sanchuangNetCents: number; guangdianNetCents: number;
        conservedTotalCents: number }
    }
    assert.equal(result.quoteOnly, true)
    assert.equal(result.status, 'calculated')
    assert.equal(result.payableAmountCents, null, 'quote never claims money is payable')
    assert.equal(result.receiptEntryId, paymentEntryId)
    assert.equal(result.rule.id, rule.id)
    assert.equal(result.allocation.grossReceivedCents, 900)
    assert.equal(result.allocation.sellerNetCents, 621)
    assert.equal(result.allocation.sanchuangNetCents, 90)
    assert.equal(result.allocation.guangdianNetCents, 180)
    assert.equal(result.allocation.processorFeeCents, 9)
    assert.equal(result.allocation.conservedTotalCents, 900)

    const samePeriod = await api(world.app, 'POST', '/admin/settlement/rules', {
      session, body: { ...ruleInput185(mappingId),
        approvalEvidenceRef: 'TEST-185-OVERLAPPING-APPROVAL', effectiveFrom: '2026-11-08' },
    })
    assert.equal(samePeriod.status, 409)
    const duplicate = await api(world.app, 'POST', '/admin/settlement/rules', {
      session, body: ruleInput185(mappingId),
    })
    assert.equal(duplicate.status, 409)
    const future = await api(world.app, 'POST', '/admin/settlement/rules', {
      session, body: {
        ...ruleInput185(mappingId),
        approvalEvidenceRef: 'TEST-185-CONTRACT-APPROVAL-V2',
        effectiveFrom: '2026-11-11', effectiveTo: '2026-11-30',
        processorFeeBps: 0, processorFeeOwner: 'none',
        ratesBps: { seller: 6000, sanchuang: 2000, guangdian: 2000 },
      },
    })
    assert.equal(future.status, 201)
    assert.equal((await future.json() as { version: number }).version, 2)
    const replay = await api(world.app, 'POST', quoteUrl, {
      session, body: { orderId: world.localOrderId },
    })
    assert.equal(replay.status, 200)
    const replayBody = await replay.json() as { rule: { id: string }; allocation: unknown }
    assert.equal(replayBody.rule.id, rule.id, 'future rule must not reinterpret historic receipt')
    assert.deepEqual(replayBody.allocation, result.allocation)
    assert.throws(() => world.sqlite.prepare(
      'UPDATE settlement_rule_versions SET seller_rate_bps=10000 WHERE id=?',
    ).run(rule.id), /immutable/)
    assert.throws(() => world.sqlite.prepare(
      'DELETE FROM settlement_rule_versions WHERE id=?',
    ).run(rule.id), /immutable/)

    const reversed = await api(world.app, 'POST',
      '/admin/ledger/payments/' + paymentEntryId + '/reverse', {
        session, body: { staffId: world.operatorStaffId, reason: '测试：凭据作废需拦截分成' },
      })
    assert.equal(reversed.status, 201)
    const blocked = await api(world.app, 'POST', quoteUrl, {
      session, body: { orderId: world.localOrderId },
    })
    assert.equal(blocked.status, 200)
    const blockedBody = await blocked.json() as {
      status: string; allocation: unknown; blockingReasons: string[] }
    assert.equal(blockedBody.status, 'blocked')
    assert.equal(blockedBody.allocation, null)
    assert.ok(blockedBody.blockingReasons.includes('receipt_reversed'))
    assert.equal((world.sqlite.prepare(
      'SELECT count(*) AS n FROM settlement_rule_versions',
    ).get() as { n: number }).n, 2)
  } finally { world.cleanup() }
})

test('approved rule HTTP rejects invalid terms, unverified mapping, unauthorized actor and forged origin', async () => {
  const world = await makeWorld()
  try {
    const { session, mappingId } = await ruleSetup185(world)
    const grid = await gridSession(world.app)
    const valid = ruleInput185(mappingId)
    for (const body of [
      { ...valid, approvalEvidenceRef: '' },
      { ...valid, ratesBps: { seller: 7000, sanchuang: 1000, guangdian: 1999 } },
      { ...valid, approvalOn: '2026-11-02' },
      { ...valid, effectiveFrom: '2026-02-31' },
      { ...valid, processorFeeBps: 100, processorFeeOwner: 'none' },
      { ...valid, feeBase: 'registered_order' },
    ]) {
      const rejected = await api(world.app, 'POST', '/admin/settlement/rules', {
        session, body,
      })
      assert.equal(rejected.status, 400, JSON.stringify(body))
    }
    const missingMapping = await api(world.app, 'POST', '/admin/settlement/rules', {
      session, body: { ...valid, mappingId: randomUUID() },
    })
    assert.equal(missingMapping.status, 404)
    const crossAgreement = await api(world.app, 'POST', '/admin/settlement/rules', {
      session, body: { ...valid, agreementRef: 'WRONG-CONTRACT' },
    })
    assert.equal(crossAgreement.status, 409)

    assert.equal((await api(world.app, 'GET', '/admin/settlement/rules', {
      session: grid,
    })).status, 403)
    assert.equal((await api(world.app, 'POST', '/admin/settlement/rules', {
      session: grid, body: valid,
    })).status, 403)
    assert.equal((await api(world.app, 'POST', '/admin/settlement/quotes', {
      session: grid, body: { orderId: world.localOrderId },
    })).status, 403)
    assert.equal((await api(world.app, 'GET', '/admin/settlement/rules')).status, 401)
    const noCsrf = await world.app.request('/admin/settlement/rules', {
      method: 'POST', headers: {
        cookie: session.cookies, origin: ADMIN_ORIGIN, 'content-type': 'application/json',
      }, body: JSON.stringify(valid),
    })
    assert.equal(noCsrf.status, 403)
    const hostile = await world.app.request('/admin/settlement/rules', {
      method: 'POST', headers: {
        cookie: session.cookies, 'x-csrf-token': session.csrfToken,
        origin: 'https://evil.example', 'content-type': 'application/json',
      }, body: JSON.stringify(valid),
    })
    assert.equal(hostile.status, 403)
    const { createSettlementRule, listSettlementRules, quoteSettlementOrder } =
      await import('../src/ledger/settlement-rules.js')
    assert.throws(() => createSettlementRule(world.db, adminActor(world), valid),
      /仅管理员/)
    assert.deepEqual(listSettlementRules(world.db, adminActor(world), world.communityId).items, [])
    assert.throws(() => listSettlementRules(world.db, adminActor(world),
      world.otherCommunityId), /无权访问/)
    assert.throws(() => quoteSettlementOrder(world.db, adminActor(world),
      world.otherOrderId), /无权访问/)
    assert.equal((world.sqlite.prepare('SELECT count(*) AS n FROM settlement_rule_versions')
      .get() as { n: number }).n, 0)
  } finally { world.cleanup() }
})

test('new 0019 settlement rule migration upgrades real populated 0018 DB without rewriting ledger facts', async () => {
  const { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } =
    await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'll-rule-upgrade-'))
  try {
    const oldDir = join(root, 'old')
    mkdirSync(join(oldDir, 'meta'), { recursive: true })
    for (const name of readdirSync(migrationsFolder)) {
      if (/^[0-9]{4}_.*\.sql$/u.test(name) && Number(name.slice(0,4)) < 19) {
        copyFileSync(join(migrationsFolder, name), join(oldDir, name))
      }
    }
    const current = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    assert.equal(current.entries.find(entry => entry.idx === 19)?.tag, '0019_settlement_rules')
    current.entries = current.entries.filter((entry) => entry.idx < 19)
    writeFileSync(join(oldDir, 'meta/_journal.json'), JSON.stringify(current))
    const dbFile = join(root, 'legacy.sqlite')
    const old = createDatabase(dbFile, oldDir)
    const communityId = randomUUID()
    old.db.insert(communities).values({
      id: communityId, name: '升级前 0018 社区',
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
    }).run()
    old.sqlite.close()
    const upgraded = createDatabase(dbFile, migrationsFolder)
    try {
      const prior = upgraded.sqlite.prepare(
        'SELECT name FROM communities WHERE id=?',
      ).get(communityId) as { name: string }
      assert.equal(prior.name, '升级前 0018 社区')
      const ruleTable = upgraded.sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='settlement_rule_versions'",
      ).get() as { name: string }
      assert.equal(ruleTable.name, 'settlement_rule_versions')
      assert.equal((upgraded.sqlite.prepare('SELECT count(*) AS n FROM settlement_rule_versions')
        .get() as { n: number }).n, 0, 'production migration seeds no fake contract')
    } finally { upgraded.sqlite.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('trial quote blocks mismatched receipts and processing fees larger than a party share', async () => {
  const mismatchWorld = await makeWorld()
  try {
    const { session, mappingId } = await ruleSetup185(mismatchWorld, 800)
    const rule = await api(mismatchWorld.app, 'POST', '/admin/settlement/rules', {
      session, body: ruleInput185(mappingId),
    })
    assert.equal(rule.status, 201)
    const q = await api(mismatchWorld.app, 'POST', '/admin/settlement/quotes', {
      session, body: { orderId: mismatchWorld.localOrderId },
    })
    assert.equal(q.status, 200)
    const bad = await q.json() as {
      status: string; allocation: unknown; blockingReasons: string[];
      payableAmountCents: null;
    }
    assert.equal(bad.status, 'blocked')
    assert.equal(bad.allocation, null)
    assert.equal(bad.payableAmountCents, null)
    assert.ok(bad.blockingReasons.includes('amount_mismatch'))
  } finally { mismatchWorld.cleanup() }

  const feeWorld = await makeWorld()
  try {
    const { session, mappingId } = await ruleSetup185(feeWorld)
    const feeRule = await api(feeWorld.app, 'POST', '/admin/settlement/rules', {
      session, body: {
        ...ruleInput185(mappingId),
        processorFeeBps: 5000,
        processorFeeOwner: 'sanchuang',
      },
    })
    assert.equal(feeRule.status, 201)
    const q = await api(feeWorld.app, 'POST', '/admin/settlement/quotes', {
      session, body: { orderId: feeWorld.localOrderId },
    })
    assert.equal(q.status, 200)
    const blocked = await q.json() as {
      status: string; allocation: unknown; blockingReasons: string[];
    }
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.allocation, null)
    assert.deepEqual(blocked.blockingReasons, ['fee_exceeds_owner_share'])
  } finally { feeWorld.cleanup() }
})


/* -------------------------------------------------------------------------- */
/* #186 · reproducible statement draft, independent review, lock and CSV       */
/* -------------------------------------------------------------------------- */

async function secondAdminSession186(world: World): Promise<Session> {
  const userId = randomUUID()
  const staffId = randomUUID()
  const when = new Date('2026-11-01T00:00:00.000Z')
  world.db.insert(users).values({
    id: userId, displayName: '独立管理员复核人', createdAt: when, updatedAt: when,
  }).run()
  world.db.insert(staffAccounts).values({
    id: staffId, userId, username: 'admin-reviewer-186',
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role: 'admin', status: 'active', createdAt: when, updatedAt: when,
  }).run()
  world.db.insert(staffCommunityAssignments).values({
    staffAccountId: staffId, communityId: world.communityId, createdAt: when,
  }).run()
  const state = await csrf(world.app)
  const response = await world.app.request('/auth/login', {
    method: 'POST', headers: {
      'content-type': 'application/json',
      cookie: state.cookie, 'x-csrf-token': state.token, origin: ADMIN_ORIGIN,
    },
    body: JSON.stringify({
      username: 'admin-reviewer-186', password: ADMIN_PASSWORD,
    }),
  })
  assert.equal(response.status, 200)
  const result = await response.json() as { csrfToken: string }
  return {
    cookies: `${cookiePair(response,'ll_session')}; ${cookiePair(response,'ll_csrf')}`,
    csrfToken: result.csrfToken,
  }
}
const statementBody186 = (world: World, from = '2026-11-09', to = '2026-11-09') => ({
  communityId: world.communityId, periodFrom: from, periodTo: to,
})
const statementUrl186 = '/admin/settlement/statements'
const reviewUrl186 = (id: string) => statementUrl186 + '/' + id + '/review'
const lockUrl186 = (id: string) => statementUrl186 + '/' + id + '/lock'
const entityUrl186 = (id: string) => statementUrl186 + '/' + id + '/entity.csv'
const gridUrl186 = (id: string) => statementUrl186 + '/' + id + '/performance.csv'

test('statement with no approved contract stays a reproducible pending CSV and cannot lock as payable', async () => {
  const world = await makeWorld()
  try {
    const { session, paymentEntryId } = await ruleSetup185(world)
    const draft = await api(world.app, 'POST', statementUrl186, {
      session, body: statementBody186(world),
    })
    assert.equal(draft.status, 201)
    const detail = await draft.json() as {
      statement: {
        id: string; generation: number; revision: number; status: string;
        summary: { lineCount:number; calculatedCount:number; blockedCount:number;
          eligibleDistributionCents: number|null }; paymentState:string;
      };
      lines: Array<{receiptEntryId:string;allocation:null;state:string;blockingReasons:string[]}>;
      events: Array<{kind:string;revision:number}>;
    }
    assert.equal(detail.statement.status, 'draft')
    assert.equal(detail.statement.generation, 1)
    assert.equal(detail.statement.summary.lineCount, 1)
    assert.equal(detail.statement.summary.calculatedCount, 0)
    assert.equal(detail.statement.summary.blockedCount, 1)
    assert.equal(detail.statement.summary.eligibleDistributionCents, null)
    assert.equal(detail.statement.paymentState, 'not_recorded')
    assert.equal(detail.lines[0]?.receiptEntryId, paymentEntryId)
    assert.equal(detail.lines[0]?.state, 'blocked')
    assert.equal(detail.lines[0]?.allocation, null)
    assert.ok(detail.lines[0]?.blockingReasons.includes('missing_approved_rule'))
    assert.deepEqual(detail.events.map(x=>x.kind), ['created'])

    const conflict = await api(world.app, 'POST', statementUrl186, {
      session, body: statementBody186(world),
    })
    assert.equal(conflict.status, 409, 'duplicate period must not create a second active draft')
    const entityCsv = await api(world.app, 'GET', entityUrl186(detail.statement.id),{session})
    assert.equal(entityCsv.status, 200)
    const text = await entityCsv.text()
    assert.ok(text.includes('草案-待复核'))
    assert.ok(text.includes('待核定'))
    assert.ok(text.includes(paymentEntryId))
    assert.ok(!text.includes('已结清'))
    const grid = await api(world.app, 'GET', gridUrl186(detail.statement.id), {
      session: await gridSession(world.app),
    })
    assert.equal(grid.status, 200)
    const perf = await grid.text()
    assert.ok(perf.includes(world.gridStaffId))
    assert.ok(perf.includes('确认业绩笔数'))
    assert.ok(!perf.includes(world.crmOrderId), 'single-day export cannot include earlier CRM facts')
    assert.ok(!perf.includes('商户净额分'))
    assert.ok(!perf.includes('"900"'), 'performance export cannot emit a cash amount')

    const ownReview = await api(world.app, 'POST', reviewUrl186(detail.statement.id), {
      session, body: { expectedRevision: 1, evidenceRef: 'TEST-SELF-REVIEW' },
    })
    assert.equal(ownReview.status, 403, 'original author cannot self-review')
    const reviewer = await secondAdminSession186(world)
    const verified = await api(world.app, 'POST', reviewUrl186(detail.statement.id), {
      session: reviewer,
      body: { expectedRevision: 1, evidenceRef: 'TEST-SECOND-ADMIN-REVIEW-001' },
    })
    assert.equal(verified.status, 200)
    const reviewed = await verified.json() as {
      statement: {revision:number;status:string};events:Array<{kind:string}>
    }
    assert.equal(reviewed.statement.status, 'reviewed')
    assert.equal(reviewed.statement.revision, 2)
    assert.deepEqual(reviewed.events.map(x=>x.kind),['created','reviewed'])
    const noPayable = await api(world.app, 'POST', lockUrl186(detail.statement.id), {
      session, body: { expectedRevision: 2, evidenceRef: 'TEST-LOCK-ATTEMPT' },
    })
    assert.equal(noPayable.status, 409, 'no approved rule means no locked amount')
    assert.equal((world.sqlite.prepare('SELECT count(*) AS n FROM settlement_receipt_claims')
      .get() as {n:number}).n,0)

    const replace = await api(world.app, 'POST', statementUrl186, {
      session, body: {
        ...statementBody186(world),replaceStatementId:detail.statement.id,
        expectedRevision:2,
      },
    })
    assert.equal(replace.status,201)
    const replacement = await replace.json() as {statement:{id:string;generation:number;status:string}}
    assert.equal(replacement.statement.generation,2)
    assert.equal(replacement.statement.status,'draft')
    const original = await api(world.app,'GET',statementUrl186+'/'+detail.statement.id,{session})
    assert.equal(original.status,200)
    assert.equal((await original.json() as {statement:{status:string}}).statement.status,'superseded')
    assert.equal((world.sqlite.prepare('SELECT count(*) AS n FROM settlement_statement_lines')
      .get() as {n:number}).n,2,'new generation retains old immutable lines')
  } finally { world.cleanup() }
})

test('approved settlement locks exact cents once, snapshots contract version and reports post-lock reversal', async () => {
  const world = await makeWorld()
  try {
    const { session, mappingId, paymentEntryId } = await ruleSetup185(world)
    const approved = await api(world.app,'POST','/admin/settlement/rules',{
      session,body:ruleInput185(mappingId),
    })
    assert.equal(approved.status,201)
    const rule = await approved.json() as {id:string;version:number}
    const draft = await api(world.app,'POST',statementUrl186,{
      session,body:statementBody186(world),
    })
    assert.equal(draft.status,201)
    const created=await draft.json() as {
      statement:{id:string;revision:number;snapshotDigest:string;status:string;
        summary:{eligibleGrossCents:number;calculatedCount:number;feeCents:number;
          sellerNetCents:number;sanchuangNetCents:number;guangdianNetCents:number;
          eligibleDistributionCents:number|null}};
      lines:Array<{id:string;state:string;ruleId:string;ruleVersion:number;
        receiptEntryId:string;operatingBatchId:string;allocation:{grossReceivedCents:number}}>;
    }
    assert.equal(created.statement.summary.eligibleGrossCents,900)
    assert.equal(created.statement.summary.calculatedCount,1)
    assert.equal(created.statement.summary.feeCents,9)
    assert.equal(created.statement.summary.sellerNetCents,621)
    assert.equal(created.statement.summary.sanchuangNetCents,90)
    assert.equal(created.statement.summary.guangdianNetCents,180)
    assert.equal(created.statement.summary.eligibleDistributionCents,891)
    assert.equal(created.lines[0]?.ruleId,rule.id)
    assert.equal(created.lines[0]?.ruleVersion,1)
    assert.equal(created.lines[0]?.receiptEntryId,paymentEntryId)
    assert.ok(created.lines[0]?.operatingBatchId)

    const second=await secondAdminSession186(world)
    const reviewed=await api(world.app,'POST',reviewUrl186(created.statement.id),{
      session:second,body:{expectedRevision:1,evidenceRef:'TEST-SECOND-ADMIN-REVIEW-186'},
    })
    assert.equal(reviewed.status,200)
    assert.equal((await reviewed.json() as {statement:{revision:number}}).statement.revision,2)
    const stale=await api(world.app,'POST',reviewUrl186(created.statement.id),{
      session:second,body:{expectedRevision:1,evidenceRef:'TEST-REPLAY'},
    })
    assert.equal(stale.status,409)

    const locked=await api(world.app,'POST',lockUrl186(created.statement.id),{
      session,body:{expectedRevision:2,evidenceRef:'TEST-FINANCE-LOCK-ACK-186'},
    })
    assert.equal(locked.status,200)
    const result=await locked.json() as {
      statement:{status:string;revision:number;paymentState:string;snapshotDigest:string;
        summary:{sellerNetCents:number}};
      lines:Array<{allocation:{sellerNetCents:number};sourceDigest:string}>;
      events:Array<{kind:string;revision:number}>;
      postLockDisputes:Array<{orderId:string}>;
    }
    assert.equal(result.statement.status,'locked')
    assert.equal(result.statement.revision,3)
    assert.equal(result.statement.snapshotDigest,created.statement.snapshotDigest)
    assert.equal(result.statement.paymentState,'awaiting_payment')
    assert.equal(result.lines[0]?.allocation.sellerNetCents,621)
    assert.deepEqual(result.events.map(x=>x.kind),['created','reviewed','locked'])
    assert.deepEqual(result.postLockDisputes,[])
    assert.equal((world.sqlite.prepare('SELECT count(*) AS n FROM settlement_receipt_claims')
      .get() as {n:number}).n,1)
    assert.equal((world.sqlite.prepare('SELECT count(*) AS n FROM settlement_statement_events')
      .get() as {n:number}).n,3)
    const replay=await api(world.app,'POST',lockUrl186(created.statement.id),{
      session,body:{expectedRevision:2,evidenceRef:'TEST-DUP-LOCK'},
    })
    assert.equal(replay.status,409)
    assert.throws(()=>world.sqlite.prepare(
      'UPDATE settlement_statement_lines SET registered_amount_cents=1 WHERE statement_id=?',
    ).run(created.statement.id),/immutable/)
    assert.throws(()=>world.sqlite.prepare(
      'UPDATE settlement_statements SET seller_net_cents=1 WHERE id=?',
    ).run(created.statement.id),/immutable/)
    assert.throws(()=>world.sqlite.prepare(
      'DELETE FROM settlement_statement_events WHERE statement_id=?',
    ).run(created.statement.id),/immutable/)

    const secondPeriod=await api(world.app,'POST',statementUrl186,{
      session,body:statementBody186(world,'2026-11-01','2026-11-10'),
    })
    assert.equal(secondPeriod.status,201)
    const secondDraft=await secondPeriod.json() as {
      statement:{id:string;summary:{eligibleGrossCents:number}};
      performance:Array<{sourceId:string;staffId:string;sourceDisplayNo:string}>;
    }
    assert.equal(secondDraft.statement.summary.eligibleGrossCents,900,
      'confirmed CRM business with no amount cannot inflate received revenue')
    assert.equal(secondDraft.performance.length,1,
      'confirmed CRM without a price must be snapshotted as WORKER performance')
    assert.equal(secondDraft.performance[0]?.sourceId,world.crmOrderId)
    assert.equal(secondDraft.performance[0]?.staffId,world.operatorStaffId)
    const organizationGridCsv=await api(world.app,'GET',
      gridUrl186(secondDraft.statement.id),{session})
    assert.equal(organizationGridCsv.status,200)
    assert.ok((await organizationGridCsv.text()).includes('GD-20261103-001'),
      'admin export must include confirmed CRM business in non-monetary performance')
    const workerGridCsv=await api(world.app,'GET',
      gridUrl186(secondDraft.statement.id),{session:await gridSession(world.app)})
    assert.equal(workerGridCsv.status,200)
    const workerText=await workerGridCsv.text()
    assert.ok(!workerText.includes(world.crmOrderId),
      'grid worker must not see another staff member\'s service performance')
    const secondReview=await api(world.app,'POST',reviewUrl186(secondDraft.statement.id),{
      session:second,body:{expectedRevision:1,evidenceRef:'TEST-DUP-REVIEW'},
    })
    assert.equal(secondReview.status,200)
    const duplicateClaim=await api(world.app,'POST',lockUrl186(secondDraft.statement.id),{
      session,body:{expectedRevision:2,evidenceRef:'TEST-DUP-CLAIM'},
    })
    assert.equal(duplicateClaim.status,409,'one receipt must never be priced twice')
    assert.equal((world.sqlite.prepare('SELECT count(*) AS n FROM settlement_receipt_claims')
      .get() as {n:number}).n,1)

    const entity=await api(world.app,'GET',entityUrl186(created.statement.id),{session})
    assert.equal(entity.status,200)
    const entityText=await entity.text()
    assert.ok(entityText.includes('已锁定'))
    assert.ok(entityText.includes('待付款'))
    assert.ok(entityText.includes(rule.id))
    assert.ok(entityText.includes(paymentEntryId))
    assert.ok(!entityText.includes('已结清'))
    assert.equal((await api(world.app,'GET',entityUrl186(created.statement.id),{
      session:await gridSession(world.app),
    })).status,403)

    const reversed=await api(world.app,'POST',
      '/admin/ledger/payments/'+paymentEntryId+'/reverse',{
        session,body:{staffId:world.operatorStaffId,reason:'TEST-POST-LOCK-REVERSAL'},
      })
    assert.equal(reversed.status,201)
    const frozen=await api(world.app,'GET',statementUrl186+'/'+created.statement.id,{session})
    assert.equal(frozen.status,200)
    const after=await frozen.json() as {
      statement:{status:string;summary:{sellerNetCents:number}};
      lines:Array<{allocation:{sellerNetCents:number}}>;
      postLockDisputes:Array<{orderId:string;reasons:string[]}>;
    }
    assert.equal(after.statement.status,'locked')
    assert.equal(after.statement.summary.sellerNetCents,621)
    assert.equal(after.lines[0]?.allocation.sellerNetCents,621)
    assert.equal(after.postLockDisputes[0]?.orderId,world.localOrderId)
    assert.ok(after.postLockDisputes[0]?.reasons.includes('receipt_reversed'))
    const newCsv=await api(world.app,'GET',entityUrl186(created.statement.id),{session})
    assert.ok((await newCsv.text()).includes('receipt_reversed'))
  } finally { world.cleanup() }
})

test('statement rejects unauthorized roles, bad dates, CSRF/origin and stale or changed evidence', async () => {
  const world=await makeWorld()
  try {
    const {session,mappingId,paymentEntryId}=await ruleSetup185(world)
    const reviewer=await secondAdminSession186(world)
    const grid=await gridSession(world.app)
    assert.equal((await api(world.app,'GET',statementUrl186)).status,401)
    assert.equal((await api(world.app,'GET',statementUrl186,{session:grid})).status,403)
    assert.equal((await api(world.app,'POST',statementUrl186,{
      session:grid,body:statementBody186(world),
    })).status,403)
    for (const invalid of [
      {...statementBody186(world),periodFrom:'2026-02-31'},
      {...statementBody186(world),periodFrom:'2026-11-30',periodTo:'2026-11-09'},
      {...statementBody186(world),replaceStatementId:randomUUID()},
    ]) {
      assert.equal((await api(world.app,'POST',statementUrl186,{
        session,body:invalid,
      })).status,400)
    }
    const noCsrf=await world.app.request(statementUrl186,{
      method:'POST',headers:{
        cookie:session.cookies,origin:ADMIN_ORIGIN,'content-type':'application/json',
      },body:JSON.stringify(statementBody186(world)),
    })
    assert.equal(noCsrf.status,403)
    const badOrigin=await world.app.request(statementUrl186,{
      method:'POST',headers:{
        cookie:session.cookies,origin:'https://evil.example',
        'x-csrf-token':session.csrfToken,'content-type':'application/json',
      },body:JSON.stringify(statementBody186(world)),
    })
    assert.equal(badOrigin.status,403)
    const outside=await api(world.app,'POST',statementUrl186,{
      session,body:{...statementBody186(world),communityId:world.otherCommunityId},
    })
    assert.equal(outside.status,201,'admin may work across communities')
    assert.equal((await api(world.app,'GET',
      statementUrl186+'?pageSize=1000',{session})).status,400)
    const {listSettlementStatements,createSettlementStatement}=
      await import('../src/ledger/settlement-statements.js')
    assert.throws(()=>createSettlementStatement(world.db,adminActor(world),{
      ...statementBody186(world),communityId:world.otherCommunityId,
    }),/无权访问/)
    assert.deepEqual(listSettlementStatements(world.db,adminActor(world),{
      communityId:world.communityId,page:1,pageSize:20,
    }).items,[])

    const rule=await api(world.app,'POST','/admin/settlement/rules',{
      session,body:ruleInput185(mappingId),
    })
    assert.equal(rule.status,201)
    const draft=await api(world.app,'POST',statementUrl186,{
      session,body:statementBody186(world),
    })
    assert.equal(draft.status,201)
    const row=await draft.json() as {statement:{id:string}}
    const changed=await api(world.app,'POST',
      '/admin/ledger/payments/'+paymentEntryId+'/reverse',{
        session,body:{staffId:world.operatorStaffId,reason:'TEST-BEFORE-LOCK-REVERSAL'},
      })
    assert.equal(changed.status,201)
    const notReviewable=await api(world.app,'POST',reviewUrl186(row.statement.id),{
      session:reviewer,body:{expectedRevision:1,evidenceRef:'TEST-CHECK-STALENESS'},
    })
    assert.equal(notReviewable.status,409,
      'review must detect reverse after draft and require regeneration')
    assert.equal((world.sqlite.prepare(
      "SELECT status FROM settlement_statements WHERE id=?",
    ).get(row.statement.id) as {status:string}).status,'draft')
  } finally { world.cleanup() }
})



/* -------------------------------------------------------------------------- */
/* #187 · offline proof registration, independent review and immutable events  */
/* -------------------------------------------------------------------------- */

const paymentsUrl187 = (statementId: string) =>
  statementUrl186 + '/' + statementId + '/payments'
const verifyPaymentUrl187 = (statementId: string, paymentId: string) =>
  paymentsUrl187(statementId) + '/' + paymentId + '/verify'

async function lockedStatement187(world: World) {
  const {session,mappingId}=await ruleSetup185(world)
  assert.equal((await api(world.app,'POST','/admin/settlement/rules',{
    session,body:ruleInput185(mappingId),
  })).status,201)
  const draft=await api(world.app,'POST',statementUrl186,{
    session,body:statementBody186(world),
  })
  assert.equal(draft.status,201)
  const created=await draft.json() as {
    statement:{id:string};
    lines:Array<{
      sellerPartyId:string;sanchuangPartyId:string;guangdianPartyId:string;
      allocation:{sellerNetCents:number;sanchuangNetCents:number;guangdianNetCents:number}
    }>
  }
  const reviewer=await secondAdminSession186(world)
  assert.equal((await api(world.app,'POST',reviewUrl186(created.statement.id),{
    session:reviewer,body:{expectedRevision:1,evidenceRef:'TEST-SET-007-STATEMENT-REVIEW'},
  })).status,200)
  assert.equal((await api(world.app,'POST',lockUrl186(created.statement.id),{
    session,body:{expectedRevision:2,evidenceRef:'TEST-SET-007-STATEMENT-LOCK'},
  })).status,200)
  return {session,reviewer,statementId:created.statement.id,line:created.lines[0]!}
}

test('offline payment proof stays partial until independently verified and never mutates ledger/statement facts',async()=>{
  const world=await makeWorld()
  try {
    const locked=await lockedStatement187(world)
    const beforeLedger=entryCount(world.sqlite)
    const beforeStatement=world.sqlite.prepare(
      'SELECT revision,snapshot_digest FROM settlement_statements WHERE id=?',
    ).get(locked.statementId) as {revision:number;snapshot_digest:string}

    const initial=await api(world.app,'GET',paymentsUrl187(locked.statementId),{
      session:locked.session,
    })
    assert.equal(initial.status,200)
    const empty=await initial.json() as {
      state:string;payableCents:number;records:unknown[];
      beneficiaries:Array<{partyId:string;payableCents:number;state:string}>
    }
    assert.equal(empty.state,'awaiting_payment')
    assert.equal(empty.records.length,0)
    assert.equal(empty.payableCents,
      locked.line.allocation.sellerNetCents+
      locked.line.allocation.sanchuangNetCents+
      locked.line.allocation.guangdianNetCents)

    const request={
      beneficiaryPartyId:locked.line.sellerPartyId,
      amountCents:300,
      paidAt:CLOCK.toISOString(),
      proofRefMasked:'TEST-BANK-RECEIPT-SET007-A-尾号1234',
      idempotencyKey:randomUUID(),
    }
    const recorded=await api(world.app,'POST',paymentsUrl187(locked.statementId),{
      session:locked.session,body:request,
    })
    assert.equal(recorded.status,201)
    const pending=await recorded.json() as {
      state:string;records:Array<{id:string;state:string;amountCents:number}>;
      beneficiaries:Array<{partyId:string;state:string;recordedCents:number;verifiedCents:number}>
    }
    assert.equal(pending.state,'pending_review')
    assert.equal(pending.records[0]?.state,'pending_review')
    assert.equal(pending.records[0]?.amountCents,300)
    const paymentId=pending.records[0]!.id

    const replay=await api(world.app,'POST',paymentsUrl187(locked.statementId),{
      session:locked.session,body:request,
    })
    assert.equal(replay.status,201)
    assert.equal((world.sqlite.prepare('SELECT count(*) AS n FROM settlement_payment_records')
      .get() as {n:number}).n,1,'same idempotency key must not duplicate payment evidence')

    const self=await api(world.app,'POST',verifyPaymentUrl187(locked.statementId,paymentId),{
      session:locked.session,body:{
        eventIdempotencyKey:randomUUID(),evidenceRef:'TEST-SELF-VERIFY-BLOCKED',
      },
    })
    assert.equal(self.status,403,'recorder cannot review own payment evidence')

    const verified=await api(world.app,'POST',verifyPaymentUrl187(locked.statementId,paymentId),{
      session:locked.reviewer,body:{
        eventIdempotencyKey:randomUUID(),evidenceRef:'TEST-INDEPENDENT-PAYMENT-REVIEW-A',
      },
    })
    assert.equal(verified.status,200)
    const partial=await verified.json() as {
      state:string;verifiedCents:number;
      records:Array<{state:string}>;
      beneficiaries:Array<{partyId:string;state:string;verifiedCents:number}>
    }
    assert.equal(partial.state,'partial')
    assert.equal(partial.verifiedCents,300)
    assert.equal(partial.records[0]?.state,'verified')
    const seller=partial.beneficiaries.find(x=>x.partyId===locked.line.sellerPartyId)
    assert.equal(seller?.state,'partial')
    assert.equal(seller?.verifiedCents,300)

    assert.equal(entryCount(world.sqlite),beforeLedger,'payment proof must not add or rewrite #64 ledger facts')
    const afterStatement=world.sqlite.prepare(
      'SELECT revision,snapshot_digest FROM settlement_statements WHERE id=?',
    ).get(locked.statementId) as {revision:number;snapshot_digest:string}
    assert.deepEqual(afterStatement,beforeStatement,'payment proof must not mutate locked statement snapshot')
    assert.throws(()=>world.sqlite.prepare(
      'UPDATE settlement_payment_records SET amount_cents=1 WHERE id=?',
    ).run(paymentId),/immutable/)
    assert.throws(()=>world.sqlite.prepare(
      'DELETE FROM settlement_payment_events WHERE payment_record_id=?',
    ).run(paymentId),/immutable/)

    const statement=await api(world.app,'GET',statementUrl186+'/'+locked.statementId,{
      session:locked.session,
    })
    assert.equal(statement.status,200)
    assert.equal((await statement.json() as {statement:{paymentState:string}})
      .statement.paymentState,'partial')
  } finally { world.cleanup() }
})

test('payment proof rejects duplicate proof, wrong beneficiary, overpay, unsafe refs, weak auth and concurrent verification replay',async()=>{
  const world=await makeWorld()
  try {
    const locked=await lockedStatement187(world)
    const sellerRequest={
      beneficiaryPartyId:locked.line.sellerPartyId,
      amountCents:100,
      paidAt:CLOCK.toISOString(),
      proofRefMasked:'PROOF-SET007-5678',
      idempotencyKey:randomUUID(),
    }
    const first=await api(world.app,'POST',paymentsUrl187(locked.statementId),{
      session:locked.session,body:sellerRequest,
    })
    assert.equal(first.status,201)
    const firstBody=await first.json() as {records:Array<{id:string}>}
    const sellerPaymentId=firstBody.records[0]!.id

    assert.equal((await api(world.app,'POST',paymentsUrl187(locked.statementId),{
      session:locked.session,body:{
        ...sellerRequest,
        beneficiaryPartyId:locked.line.sanchuangPartyId,
        proofRefMasked:'ＰＲＯＯＦ－ＳＥＴ００７－５６７８',
        idempotencyKey:randomUUID(),
      },
    })).status,409,'same external proof cannot move to another beneficiary')

    assert.equal((await api(world.app,'POST',paymentsUrl187(locked.statementId),{
      session:locked.session,body:{
        ...sellerRequest,
        beneficiaryPartyId:randomUUID(),
        proofRefMasked:'TEST-BANK-RECEIPT-SET007-WRONG-PARTY',
        idempotencyKey:randomUUID(),
      },
    })).status,409)

    assert.equal((await api(world.app,'POST',paymentsUrl187(locked.statementId),{
      session:locked.session,body:{
        ...sellerRequest,
        amountCents:locked.line.allocation.sellerNetCents,
        proofRefMasked:'TEST-BANK-RECEIPT-SET007-OVERPAY',
        idempotencyKey:randomUUID(),
      },
    })).status,409,'existing evidence plus new evidence cannot exceed locked beneficiary amount')

    assert.equal((await api(world.app,'POST',paymentsUrl187(locked.statementId),{
      session:locked.session,body:{
        ...sellerRequest,
        proofRefMasked:'银行卡 6222021234567890123',
        idempotencyKey:randomUUID(),
      },
    })).status,400,'full-looking account/card references must be rejected')

    assert.equal((await api(world.app,'POST',paymentsUrl187(locked.statementId),{
      session:locked.session,body:{
        ...sellerRequest,
        proofRefMasked:'',
        idempotencyKey:randomUUID(),
      },
    })).status,400,'missing payment proof cannot become a payment record')

    const grid=await gridSession(world.app)
    assert.equal((await api(world.app,'POST',paymentsUrl187(locked.statementId),{
      session:grid,body:{...sellerRequest,idempotencyKey:randomUUID(),
        proofRefMasked:'TEST-GRID-WRITE-BLOCKED'},
    })).status,403)

    const noCsrf=await world.app.request(paymentsUrl187(locked.statementId),{
      method:'POST',headers:{
        cookie:locked.session.cookies,origin:ADMIN_ORIGIN,'content-type':'application/json',
      },body:JSON.stringify({...sellerRequest,idempotencyKey:randomUUID(),
        proofRefMasked:'TEST-NO-CSRF-BLOCKED'}),
    })
    assert.equal(noCsrf.status,403)
    const badOrigin=await world.app.request(paymentsUrl187(locked.statementId),{
      method:'POST',headers:{
        cookie:locked.session.cookies,origin:'https://evil.example',
        'x-csrf-token':locked.session.csrfToken,'content-type':'application/json',
      },body:JSON.stringify({...sellerRequest,idempotencyKey:randomUUID(),
        proofRefMasked:'TEST-BAD-ORIGIN-BLOCKED'}),
    })
    assert.equal(badOrigin.status,403)

    const {recordSettlementPayment,getSettlementPaymentOverview}=
      await import('../src/ledger/settlement-payments.js')
    assert.throws(()=>getSettlementPaymentOverview(
      world.db,adminActor(world),locked.statementId,
    ),(error:unknown)=>error instanceof Error && 'status' in error &&
      (error as {status:number}).status===403,'operator must not read finance payment evidence')
    assert.throws(()=>recordSettlementPayment(world.db,adminActor(world),locked.statementId,{
      ...sellerRequest,idempotencyKey:randomUUID(),proofRefMasked:'TEST-OPERATOR-BLOCKED',
    },CLOCK),(error:unknown)=>error instanceof Error && 'status' in error &&
      (error as {status:number}).status===403,'operator service write must be rejected')

    const sanchuang=await api(world.app,'POST',paymentsUrl187(locked.statementId),{
      session:locked.session,body:{
        beneficiaryPartyId:locked.line.sanchuangPartyId,
        amountCents:locked.line.allocation.sanchuangNetCents,
        paidAt:CLOCK.toISOString(),
        proofRefMasked:'TEST-BANK-RECEIPT-SET007-CONCURRENT',
        idempotencyKey:randomUUID(),
      },
    })
    assert.equal(sanchuang.status,201)
    const body=await sanchuang.json() as {records:Array<{id:string;beneficiaryPartyId:string}>}
    const concurrentPayment=body.records.find(
      x=>x.beneficiaryPartyId===locked.line.sanchuangPartyId)!.id
    const responses=await Promise.all([
      api(world.app,'POST',verifyPaymentUrl187(locked.statementId,concurrentPayment),{
        session:locked.reviewer,body:{
          eventIdempotencyKey:randomUUID(),evidenceRef:'TEST-CONCURRENT-VERIFY-A',
        },
      }),
      api(world.app,'POST',verifyPaymentUrl187(locked.statementId,concurrentPayment),{
        session:locked.reviewer,body:{
          eventIdempotencyKey:randomUUID(),evidenceRef:'TEST-CONCURRENT-VERIFY-B',
        },
      }),
    ])
    assert.deepEqual(responses.map(r=>r.status).sort((a,b)=>a-b),[200,409],
      'simultaneous verification attempts must produce exactly one terminal verification')
    assert.equal((world.sqlite.prepare(
      "SELECT count(*) AS n FROM settlement_payment_events WHERE payment_record_id=? AND kind='verified'",
    ).get(concurrentPayment) as {n:number}).n,1)

    const disputeAfterVerify=await api(world.app,'POST',
      paymentsUrl187(locked.statementId)+'/'+sellerPaymentId+'/dispute',{
        session:locked.reviewer,body:{
          eventIdempotencyKey:randomUUID(),evidenceRef:'TEST-DISPUTE-PENDING-EVIDENCE',
        },
      })
    assert.equal(disputeAfterVerify.status,200)
    const disputed=await disputeAfterVerify.json() as {state:string}
    assert.equal(disputed.state,'disputed')
  } finally { world.cleanup() }
})


test('statement CSV neutralizes formulas and masks resident phones',async()=>{
  const {settlementCsvCell}=await import('../src/ledger/settlement-statement-csv.js')
  assert.equal(settlementCsvCell('=CMD()'),'"\'=CMD()"')
  assert.equal(settlementCsvCell('  +calc'),'"\'  +calc"')
  assert.equal(settlementCsvCell('@SUM(A1)'),'"\'@SUM(A1)"')
  assert.equal(settlementCsvCell('13800138000'),'"138****8000"')
  assert.equal(settlementCsvCell('a"b\r\nc'),'"a""b\r\nc"')
})

test('SQLite 0020→0021 migration preserves locked-settlement era facts and adds empty payment evidence tables',async()=>{
  const {copyFileSync,mkdirSync,readFileSync,readdirSync,writeFileSync}=
    await import('node:fs')
  const dir=mkdtempSync(join(tmpdir(),'ll-settlement-0021-'))
  try {
    const oldDir=join(dir,'legacy')
    mkdirSync(join(oldDir,'meta'),{recursive:true})
    for (const n of readdirSync(migrationsFolder)) {
      if (/^[0-9]{4}_.*\.sql$/u.test(n) && Number(n.slice(0,4))<21) {
        copyFileSync(join(migrationsFolder,n),join(oldDir,n))
      }
    }
    const journal=JSON.parse(readFileSync(join(migrationsFolder,'meta/_journal.json'),'utf8')) as {
      entries:Array<{idx:number;tag:string}>
    }
    assert.equal(journal.entries.find(x=>x.idx===21)?.tag,'0021_settlement_payment_evidence')
    journal.entries=journal.entries.filter(x=>x.idx<21)
    writeFileSync(join(oldDir,'meta/_journal.json'),JSON.stringify(journal))
    const file=join(dir,'prior.sqlite')
    const previous=createDatabase(file,oldDir)
    const id=randomUUID()
    const userId=randomUUID()
    const statementId=randomUUID()
    const createdAt=new Date('2026-11-01T00:00:00.000Z')
    previous.db.insert(communities).values({
      id,name:'0021迁移前社区',createdAt,
    }).run()
    previous.db.insert(users).values({
      id:userId,displayName:'迁移前制单人',createdAt,updatedAt:createdAt,
    }).run()
    previous.db.insert(settlementStatements).values({
      id:statementId,statementNo:'SET-UPGRADE-0020',communityId:id,
      periodFrom:'2026-11-01',periodTo:'2026-11-01',generation:1,revision:1,
      status:'draft',snapshotDigest:'0'.repeat(64),asOf:createdAt,
      lineCount:0,calculatedCount:0,blockedCount:0,eligibleGrossCents:0,feeCents:0,
      sellerNetCents:0,sanchuangNetCents:0,guangdianNetCents:0,
      createdByUserId:userId,createdAt,updatedAt:createdAt,
      reviewedByUserId:null,reviewEvidenceRef:null,reviewedAt:null,
      lockedByUserId:null,lockEvidenceRef:null,lockedAt:null,
    }).run()
    previous.sqlite.close()
    const current=createDatabase(file,migrationsFolder)
    try {
      assert.equal((current.sqlite.prepare('SELECT name FROM communities WHERE id=?')
        .get(id) as {name:string}).name,'0021迁移前社区')
      assert.ok(current.sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='settlement_statements'",
      ).get())
      assert.ok(current.sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='settlement_rule_versions'",
      ).get())
      assert.equal((current.sqlite.prepare('SELECT count(*) AS n FROM settlement_statements')
        .get() as {n:number}).n,1,'existing settlement snapshot survives payment migration')
      assert.equal((current.sqlite.prepare('SELECT count(*) AS n FROM settlement_payment_records')
        .get() as {n:number}).n,0,'upgrade must not fabricate paid evidence')
      assert.equal((current.sqlite.prepare('SELECT count(*) AS n FROM settlement_payment_events')
        .get() as {n:number}).n,0,'upgrade must not fabricate verification events')
    } finally {current.sqlite.close()}
  } finally {rmSync(dir,{recursive:true,force:true})}
})
