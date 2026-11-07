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
