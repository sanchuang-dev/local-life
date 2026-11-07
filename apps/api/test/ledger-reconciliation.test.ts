import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  API_ERROR_CODES,
  LEDGER_ROUTES,
  type ReconciliationBatch,
  type ReconciliationBatchEntriesResponse,
  type ReconciliationDiff,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/security.js'
import { loadConfig, type ApiConfig } from '../src/config.js'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import {
  auditLogs,
  communities,
  ledgerAnomalies,
  ledgerEntries,
  reconciliationBatches,
  staffAccounts,
  staffCommunityAssignments,
  users,
} from '../src/db/schema.js'

/**
 * Real HTTP tests of the reconciliation + export routes (LL-MVP-008, Issue #64).
 *
 * Every test drives the **real** `createApp` (real auth, real session cookies,
 * real CSRF double-submit, real error envelope), the **real** SQLite database
 * with migration 0010 (the triggers are what make a locked statement immutable)
 * and the **real** route module under test. Nothing is stubbed, because the
 * guarantees under test — 403 for 网格员, 409 on a second lock, an aborted direct
 * `UPDATE` after locking, a BOM-prefixed CSV and its audit row — all live in the
 * database, the middleware or the HTTP layer.
 *
 * `createApp` does not register these routes yet: the registration line in
 * `apps/api/src/app.ts` belongs to the integration card (t6), which exists so two
 * cards never edit the same file. This suite therefore **self-registers** the
 * module, exactly the way `app.ts` will. The three injected helpers (`fail`,
 * `validCsrf`, `bodySchemaError`) are private to `app.ts`; the small mirrors below
 * reproduce them verbatim so the routes are exercised with production-shaped
 * dependencies instead of permissive fakes.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ADMIN_ORIGIN = 'http://localhost:5174'
const UNTRUSTED_ORIGIN = 'http://evil.example'
const ADMIN_PASSWORD = 'Admin-Password-123!'
const OPERATOR_PASSWORD = 'Operator-Password-123!'
const GRID_PASSWORD = 'Grid-Worker-Password-123!'

const DAY_START = new Date('2026-11-01T00:00:00.000+08:00')
/**
 * A single injected clock for every ledger call. Deterministic `asOf`, a stable
 * export filename, and — the part that matters — a lock instant that is
 * unambiguous relative to the seeded facts.
 */
const CLOCK = new Date('2026-11-08T10:00:00.000+08:00')
/** Later than `CLOCK`: a fact recorded *after* the statement was frozen. */
const AFTER_LOCK = new Date('2026-11-09T09:00:00.000+08:00')

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
  userId: string
  staffId: string
}

interface World {
  app: App
  db: AppDatabase
  sqlite: SqliteConnection
  config: ApiConfig
  communityId: string
  otherCommunityId: string
  admin: Session
  operator: Session
  grid: Session
}

/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

async function login(app: App, username: string, password: string): Promise<Session> {
  const csrfResponse = await app.request('/auth/csrf')
  assert.equal(csrfResponse.status, 200)
  const { csrfToken: preToken } = (await csrfResponse.json()) as { csrfToken: string }
  const preCookie = csrfResponse.headers
    .get('set-cookie')
    ?.split(/,(?=[^;,]+=)/)
    .map((part) => part.split(';', 1)[0]?.trim() ?? '')
    .find((part) => part.startsWith('ll_csrf='))
  assert.ok(preCookie, 'expected a csrf cookie')

  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: preCookie,
      'x-csrf-token': preToken,
      origin: ADMIN_ORIGIN,
    },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(response.status, 200, `${username} should be able to log in`)
  const body = (await response.json()) as {
    user: { id: string }
    csrfToken: string
    staff?: { id: string } | null
  }
  const setCookie = response.headers.get('set-cookie') ?? ''
  const pairs = setCookie
    .split(/,(?=[^;,]+=)/)
    .map((part) => part.split(';', 1)[0]?.trim() ?? '')
    .filter(Boolean)
  const sessionCookie = pairs.find((pair) => pair.startsWith('ll_session='))
  const csrfCookie = pairs.find((pair) => pair.startsWith('ll_csrf='))
  assert.ok(sessionCookie, 'expected a session cookie')
  assert.ok(csrfCookie, 'expected a csrf cookie')
  return {
    cookies: `${sessionCookie}; ${csrfCookie}`,
    csrfToken: body.csrfToken,
    userId: body.user.id,
    staffId: body.staff?.id ?? '',
  }
}

async function makeWorld(): Promise<World> {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test' })
  // `createApp` installs the real session/CSRF middleware and, since the
  // integration card wired the module in, the reconciliation routes as well.
  // `now` is injected so the frozen clock below is the one every `asOf` uses.
  const app = createApp({ db, config, logRequests: false, now: () => CLOCK })
  // The routes are now also reachable through `createApp`; re-registering them
  // here would shadow that wiring with a copy, so this suite relies on the
  // production registration.

  const communityId = randomUUID()
  const otherCommunityId = randomUUID()
  db.insert(communities)
    .values([
      { id: communityId, name: '幸福社区', createdAt: DAY_START },
      { id: otherCommunityId, name: '和平社区', createdAt: DAY_START },
    ])
    .run()

  const addStaff = async (
    displayName: string,
    username: string,
    password: string,
    role: 'admin' | 'operator' | 'grid_worker',
    scoped: string[],
  ): Promise<Session> => {
    const userId = randomUUID()
    const staffId = randomUUID()
    db.insert(users)
      .values({ id: userId, displayName, createdAt: DAY_START, updatedAt: DAY_START })
      .run()
    db.insert(staffAccounts)
      .values({
        id: staffId,
        userId,
        username,
        passwordHash: await hashPassword(password),
        role,
        status: 'active',
        createdAt: DAY_START,
        updatedAt: DAY_START,
      })
      .run()
    for (const community of scoped) {
      db.insert(staffCommunityAssignments)
        .values({ staffAccountId: staffId, communityId: community, createdAt: DAY_START })
        .run()
    }
    const session = await login(app, username, password)
    assert.equal(session.staffId, staffId)
    return session
  }

  const admin = await addStaff('系统管理员', 'admin', ADMIN_PASSWORD, 'admin', [])
  const operator = await addStaff('运营小王', 'operator', OPERATOR_PASSWORD, 'operator', [
    communityId,
  ])
  const grid = await addStaff('网格员小王', 'grid', GRID_PASSWORD, 'grid_worker', [communityId])

  return { app, db, sqlite, config, communityId, otherCommunityId, admin, operator, grid }
}

interface EntryInput {
  factKind:
    | 'order_registered'
    | 'order_verified'
    | 'payment_received'
    | 'payment_reversed'
    | 'reward_cost'
    | 'reward_reversed'
  sourceSystem?: 'local_order' | 'crm_service_order' | 'activity_reward_grant' | 'manual'
  communityId: string
  amountCents: number
  occurredAt?: Date
  createdAt?: Date
  attributedStaffId?: string | null
  evidenceRef?: string | null
  evidenceKind?: 'manual_receipt' | 'bank_transfer' | 'crm_confirmation' | 'order_verification' | 'reward_grant' | 'none'
}

/**
 * Inserts one fact the way the ingestion path must: every cross-column invariant
 * of migration 0010 holds (verified_at for `order_verified`, evidence + recorder
 * for payments, source system per fact kind), so a rejection here is a real
 * contract violation rather than a fixture bug.
 */
function insertEntry(world: World, input: EntryInput): string {
  const id = randomUUID()
  const attributedStaffId = input.attributedStaffId ?? null
  const occurredAt = input.occurredAt ?? new Date('2026-11-03T10:30:00.000+08:00')
  const isPayment =
    input.factKind === 'payment_received' || input.factKind === 'payment_reversed'
  const isVerified = input.factKind === 'order_verified'
  const evidenceKind =
    input.evidenceKind ??
    (isPayment
      ? 'manual_receipt'
      : isVerified
        ? 'order_verification'
        : input.factKind.startsWith('reward_')
          ? 'reward_grant'
          : 'none')
  // `evidence.kind — none` requires a reference (contract superRefine): a concrete
  // evidence kind without a ref would be an unverifiable claim, so it never
  // passes the schema — including here.
  const evidenceRef =
    input.evidenceRef ?? (evidenceKind === 'none' ? null : `凭据-${id.slice(0, 8)}`)
  world.db
    .insert(ledgerEntries)
    .values({
      id,
      factKind: input.factKind,
      sourceSystem:
        input.sourceSystem ??
        (isPayment
          ? 'manual'
          : isVerified
            ? 'crm_service_order'
            : input.factKind.startsWith('reward_')
              ? 'activity_reward_grant'
              : 'local_order'),
      sourceId: randomUUID(),
      sourceDisplayNo: `SRC-${id.slice(0, 8)}`,
      communityId: input.communityId,
      productId: null,
      attributedStaffId,
      attributionState: attributedStaffId === null ? 'pending' : 'attributed',
      attributionBasis:
        attributedStaffId === null ? 'no_explicit_attribution' : 'explicit_attribution',
      amountCents: input.amountCents,
      settlementAmountStatus: 'pending_rule',
      occurredAt,
      verifiedAt: isVerified ? occurredAt : null,
      recordedByUserId: isPayment ? world.operator.userId : null,
      recordedByStaffId: isPayment ? world.operator.staffId : null,
      counterEntryId: null,
      evidenceRef,
      evidenceKind,
      batchId: null,
      createdAt: input.createdAt ?? occurredAt,
    })
    .run()
  return id
}

/* -------------------------------------------------------------------------- */
/* Request helpers                                                            */
/* -------------------------------------------------------------------------- */

function writeHeaders(session: Session, extra: Record<string, string> = {}) {
  return {
    'content-type': 'application/json',
    cookie: session.cookies,
    'x-csrf-token': session.csrfToken,
    origin: ADMIN_ORIGIN,
    ...extra,
  }
}

function readHeaders(session: Session) {
  return { cookie: session.cookies }
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function createBatch(
  world: World,
  session: Session,
  body: Record<string, unknown> = { periodFrom: '2026-11-01', periodTo: '2026-11-07' },
): Promise<ReconciliationBatch> {
  const response = await world.app.request(LEDGER_ROUTES.adminBatches, {
    method: 'POST',
    headers: writeHeaders(session),
    body: JSON.stringify(body),
  })
  // Read once, then assert: a `response.text()` inside the assertion message
  // would consume the body even when the call succeeded.
  const payload = await readJson<ReconciliationBatch | { error: { code: string; message: string } }>(
    response,
  )
  assert.equal(
    response.status,
    201,
    `create batch failed: ${JSON.stringify(payload)}`,
  )
  return payload as ReconciliationBatch
}

async function lockBatch(
  world: World,
  session: Session,
  batchId: string,
  expectedUpdatedAt: string,
): Promise<Response> {
  return world.app.request(`/admin/reconciliation/batches/${batchId}/lock`, {
    method: 'POST',
    headers: writeHeaders(session),
    body: JSON.stringify({ expectedUpdatedAt }),
  })
}

/* -------------------------------------------------------------------------- */
/* 1. The six routes are reachable and answer with contract-valid JSON         */
/* -------------------------------------------------------------------------- */

test('the six reconciliation routes are reachable and answer contract-valid JSON', async () => {
  const world = await makeWorld()
  try {
    insertEntry(world, {
      factKind: 'order_verified',
      sourceSystem: 'crm_service_order',
      communityId: world.communityId,
      amountCents: 20_000,
      attributedStaffId: world.grid.staffId,
    })
    insertEntry(world, {
      factKind: 'order_registered',
      communityId: world.communityId,
      amountCents: 5_000,
      attributedStaffId: world.grid.staffId,
      occurredAt: new Date('2026-11-05T09:00:00.000+08:00'),
    })

    // 1) POST /admin/reconciliation/batches -> 201 + a full batch DTO.
    const created = await createBatch(world, world.admin)
    assert.equal(created.status, 'open')
    assert.equal(created.periodFrom, '2026-11-01')
    assert.equal(created.periodTo, '2026-11-07')
    assert.equal(created.entryCount, 2, 'the open batch derives its totals from the facts')
    assert.equal(created.totalCents, 25_000)
    assert.equal(created.lockedAt, null)

    // 2) GET /admin/reconciliation/batches/:batchId -> the same row.
    const detail = await world.app.request(
      `/admin/reconciliation/batches/${created.batchId}`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(detail.status, 200)
    assert.deepEqual(await readJson<ReconciliationBatch>(detail), created)

    // 3) GET .../batches/:batchId/entries -> paged members, echoed paging.
    const entries = await world.app.request(
      `/admin/reconciliation/batches/${created.batchId}/entries?page=1&pageSize=1000`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(entries.status, 200)
    const entriesBody = await readJson<ReconciliationBatchEntriesResponse>(entries)
    assert.equal(entriesBody.batchId, created.batchId)
    assert.equal(entriesBody.total, 2)
    assert.equal(entriesBody.items.length, 2)
    assert.equal(entriesBody.page, 1)
    assert.equal(entriesBody.pageSize, 100, 'pageSize is capped and the applied value echoed')
    assert.equal(entriesBody.asOf, CLOCK.toISOString())
    assert.deepEqual(
      entriesBody.items.map((item) => item.reconciliationState),
      ['batched', 'batched'],
      'an open batch is batched, not reconciled',
    )

    // 4) GET /admin/reconciliation/diff?batchId=... -> findings + drill-down.
    const diff = await world.app.request(
      `${LEDGER_ROUTES.adminDiff}?batchId=${created.batchId}`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(diff.status, 200)
    const diffBody = await readJson<ReconciliationDiff>(diff)
    assert.equal(diffBody.batchId, created.batchId)
    assert.equal(diffBody.status, 'open')
    assert.equal(diffBody.computed.entryCount, 2)
    assert.equal(diffBody.summary.total, diffBody.items.length)
    assert.equal(diffBody.unbatchedCount, 2, 'an open period is still un-reconciled')

    // 5) GET /admin/reconciliation/diff?periodFrom=&periodTo= -> ad-hoc period.
    const periodDiff = await world.app.request(
      `${LEDGER_ROUTES.adminDiff}?periodFrom=2026-11-01&periodTo=2026-11-07`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(periodDiff.status, 200)
    const periodDiffBody = await readJson<ReconciliationDiff>(periodDiff)
    assert.equal(periodDiffBody.batchId, null)
    assert.equal(periodDiffBody.stored, null, 'an ad-hoc period has no stored statement')

    // 6) POST .../lock -> locked; then GET the export of the frozen statement.
    const locked = await lockBatch(world, world.admin, created.batchId, created.updatedAt)
    assert.equal(locked.status, 200)
    const lockedBody = await readJson<ReconciliationBatch>(locked)
    assert.equal(lockedBody.status, 'locked')
    assert.equal(lockedBody.entryCount, 2)
    assert.equal(lockedBody.totalCents, 25_000)

    const exportResponse = await world.app.request(
      `${LEDGER_ROUTES.adminExportCsv}?batchId=${created.batchId}`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(exportResponse.status, 200)
    assert.equal(exportResponse.headers.get('content-type'), 'text/csv; charset=utf-8')

    // The batch list still comes from the read-only skeleton, not from a copy.
    const list = await world.app.request(LEDGER_ROUTES.adminBatches, {
      headers: readHeaders(world.admin),
    })
    assert.equal(list.status, 200)
    const listBody = await readJson<{ items: ReconciliationBatch[] }>(list)
    assert.equal(listBody.items.length, 1)
    assert.equal(listBody.items[0]?.batchId, created.batchId)
  } finally {
    world.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 2. Permissions: 401, 403 for grid_worker, 403 without CSRF                  */
/* -------------------------------------------------------------------------- */

test('unauthenticated callers get 401 and grid_worker gets 403 on every reconciliation route', async () => {
  const world = await makeWorld()
  try {
    const created = await createBatch(world, world.admin)
    const batchId = created.batchId

    const routes: Array<{ method: 'GET' | 'POST'; path: string; body?: string }> = [
      { method: 'POST', path: LEDGER_ROUTES.adminBatches, body: JSON.stringify({ periodFrom: '2026-11-08', periodTo: '2026-11-14' }) },
      { method: 'GET', path: `/admin/reconciliation/batches/${batchId}` },
      { method: 'GET', path: `/admin/reconciliation/batches/${batchId}/entries` },
      { method: 'POST', path: `/admin/reconciliation/batches/${batchId}/lock`, body: JSON.stringify({ expectedUpdatedAt: created.updatedAt }) },
      { method: 'GET', path: `${LEDGER_ROUTES.adminDiff}?batchId=${batchId}` },
      { method: 'GET', path: `${LEDGER_ROUTES.adminExportCsv}?batchId=${batchId}` },
    ]

    for (const route of routes) {
      // Unauthenticated: 401, and never a body that leaks data.
      const anonymous = await world.app.request(route.path, {
        method: route.method,
        ...(route.body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN },
              body: route.body,
            }),
      })
      assert.equal(anonymous.status, 401, `${route.method} ${route.path} must require a session`)
      const anonymousBody = await readJson<{ error: { code: string } }>(anonymous)
      assert.equal(anonymousBody.error.code, API_ERROR_CODES.unauthorized)

      // grid_worker: 403 — the guard runs before the body/param is even read.
      const asGrid = await world.app.request(route.path, {
        method: route.method,
        headers:
          route.body === undefined
            ? { cookie: world.grid.cookies }
            : {
                'content-type': 'application/json',
                cookie: world.grid.cookies,
                'x-csrf-token': world.grid.csrfToken,
                origin: ADMIN_ORIGIN,
              },
        ...(route.body === undefined ? {} : { body: route.body }),
      })
      assert.equal(asGrid.status, 403, `${route.method} ${route.path} must refuse 网格员`)
      const gridBody = await readJson<{ error: { code: string } }>(asGrid)
      assert.equal(gridBody.error.code, API_ERROR_CODES.forbidden)
    }

    // Nothing a refused caller did may have changed the world: still 1 batch.
    assert.equal(world.db.select().from(reconciliationBatches).all().length, 1)
    assert.equal(
      world.db.select().from(reconciliationBatches).all()[0]?.status,
      'open',
      '网格员 must not be able to lock a statement',
    )
  } finally {
    world.sqlite.close()
  }
})

test('a write without CSRF is 403 and creates nothing', async () => {
  const world = await makeWorld()
  try {
    const body = JSON.stringify({ periodFrom: '2026-11-01', periodTo: '2026-11-07' })

    // (a) no CSRF header at all.
    const noToken = await world.app.request(LEDGER_ROUTES.adminBatches, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: world.admin.cookies, origin: ADMIN_ORIGIN },
      body,
    })
    assert.equal(noToken.status, 403)
    assert.equal((await readJson<{ error: { code: string } }>(noToken)).error.code, API_ERROR_CODES.forbidden)

    // (b) CSRF header + cookie, but an untrusted Origin: still refused.
    const badOrigin = await world.app.request(LEDGER_ROUTES.adminBatches, {
      method: 'POST',
      headers: writeHeaders(world.admin, { origin: UNTRUSTED_ORIGIN }),
      body,
    })
    assert.equal(badOrigin.status, 403)

    // (c) a mismatched token (cookie says one thing, header another).
    const mismatched = await world.app.request(LEDGER_ROUTES.adminBatches, {
      method: 'POST',
      headers: writeHeaders(world.admin, { 'x-csrf-token': 'not-the-token' }),
      body,
    })
    assert.equal(mismatched.status, 403)

    assert.equal(
      world.db.select().from(reconciliationBatches).all().length,
      0,
      'a refused write must not create a batch',
    )
    assert.equal(
      world.db.select().from(auditLogs).all().filter((row) => row.event.startsWith('ledger.')).length,
      0,
      'a refused write must not leave an audit trail claiming it happened',
    )
  } finally {
    world.sqlite.close()
  }
})

test('an operator may read and lock; an operator outside the community still sees the batch', async () => {
  const world = await makeWorld()
  try {
    insertEntry(world, {
      factKind: 'order_registered',
      communityId: world.communityId,
      amountCents: 3_300,
      attributedStaffId: world.grid.staffId,
    })
    const created = await createBatch(world, world.operator)
    const locked = await lockBatch(world, world.operator, created.batchId, created.updatedAt)
    assert.equal(locked.status, 200)
    const lockedBody = await readJson<ReconciliationBatch>(locked)
    assert.equal(lockedBody.status, 'locked')
    assert.equal(lockedBody.lockedByUserId, world.operator.userId)
    assert.equal(lockedBody.lockedByStaffId, world.operator.staffId)
  } finally {
    world.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 3. Lock semantics: second lock 409, direct SQL blocked by the triggers      */
/* -------------------------------------------------------------------------- */

test('create -> lock -> second lock is 409, and the frozen statement resists direct SQL', async () => {
  const world = await makeWorld()
  try {
    insertEntry(world, {
      factKind: 'order_verified',
      sourceSystem: 'crm_service_order',
      communityId: world.communityId,
      amountCents: 20_000,
      attributedStaffId: world.grid.staffId,
    })
    const created = await createBatch(world, world.admin)

    // A stale optimistic token is a conflict, never a silent lock.
    const stale = await lockBatch(world, world.admin, created.batchId, new Date(0).toISOString())
    assert.equal(stale.status, 409)
    assert.equal((await readJson<{ error: { code: string } }>(stale)).error.code, API_ERROR_CODES.conflict)

    const locked = await lockBatch(world, world.admin, created.batchId, created.updatedAt)
    assert.equal(locked.status, 200)
    const lockedBody = await readJson<ReconciliationBatch>(locked)

    // Locking twice is a named refusal, not a second success.
    const second = await lockBatch(world, world.admin, created.batchId, lockedBody.updatedAt)
    assert.equal(second.status, 409)
    assert.equal(
      (await readJson<{ error: { code: string } }>(second)).error.code,
      API_ERROR_CODES.ledgerBatchLocked,
    )

    // Re-creating a locked period is refused by name, not silently allowed.
    const recreate = await world.app.request(LEDGER_ROUTES.adminBatches, {
      method: 'POST',
      headers: writeHeaders(world.admin),
      body: JSON.stringify({ periodFrom: '2026-11-01', periodTo: '2026-11-07' }),
    })
    assert.equal(recreate.status, 409)
    assert.equal(
      (await readJson<{ error: { code: string } }>(recreate)).error.code,
      API_ERROR_CODES.ledgerBatchLocked,
    )

    // The database — not the service — is the last line of defence: a hand-written
    // amount change on the frozen statement aborts.
    assert.throws(
      () =>
        world.sqlite
          .prepare('UPDATE reconciliation_batches SET total_cents = 1 WHERE id = ?')
          .run(created.batchId),
      /immutable/iu,
    )
    assert.throws(
      () =>
        world.sqlite
          .prepare('UPDATE reconciliation_batches SET status = ? WHERE id = ?')
          .run('open', created.batchId),
      /immutable|open to locked/iu,
    )
    assert.throws(
      () => world.sqlite.prepare('UPDATE ledger_entries SET amount_cents = 1').run(),
      /immutable/iu,
    )
    assert.throws(
      () => world.sqlite.prepare('DELETE FROM ledger_entries').run(),
      /immutable/iu,
    )

    // The statement still reads exactly what it froze.
    const reread = await world.app.request(`/admin/reconciliation/batches/${created.batchId}`, {
      headers: readHeaders(world.admin),
    })
    const rereadBody = await readJson<ReconciliationBatch>(reread)
    assert.equal(rereadBody.totalCents, 20_000)
    assert.equal(rereadBody.status, 'locked')

    // And the diff still shows the drift/summary pair the page renders.
    const diff = await world.app.request(`${LEDGER_ROUTES.adminDiff}?batchId=${created.batchId}`, {
      headers: readHeaders(world.admin),
    })
    const diffBody = await readJson<ReconciliationDiff>(diff)
    assert.equal(diffBody.status, 'locked')
    assert.deepEqual(diffBody.stored, { entryCount: 1, totalCents: 20_000 })
    assert.deepEqual(diffBody.computed, { entryCount: 1, totalCents: 20_000 })
    assert.equal(
      diffBody.items.some((item) => item.reason === 'batch_totals_drift'),
      false,
      'a consistent locked batch must never be reported as drift',
    )
  } finally {
    world.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 4. Export: headers, BOM, ASCII filename, late-recorded echo                 */
/* -------------------------------------------------------------------------- */

test('the export answers 200 with a BOM, an ASCII filename and the late-recorded counts', async () => {
  const world = await makeWorld()
  try {
    insertEntry(world, {
      factKind: 'payment_received',
      sourceSystem: 'manual',
      communityId: world.communityId,
      amountCents: 12_800,
      attributedStaffId: world.grid.staffId,
      evidenceRef: '收据 13800138000',
    })
    const created = await createBatch(world, world.admin)
    const locked = await readJson<ReconciliationBatch>(
      await lockBatch(world, world.admin, created.batchId, created.updatedAt),
    )

    // A fact recorded after the lock: it cannot join the frozen statement, so the
    // export must announce it instead of letting it vanish (L2).
    insertEntry(world, {
      factKind: 'order_registered',
      communityId: world.communityId,
      amountCents: 7_700,
      attributedStaffId: world.grid.staffId,
      occurredAt: new Date('2026-11-05T12:00:00.000+08:00'),
      createdAt: AFTER_LOCK,
    })

    const response = await world.app.request(
      `${LEDGER_ROUTES.adminExportCsv}?batchId=${created.batchId}`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')

    const disposition = response.headers.get('content-disposition') ?? ''
    assert.match(disposition, /^attachment; filename="[^"]+\.csv"$/u)
    assert.ok(disposition.includes('attachment; filename='))
    // ASCII only: a Chinese filename is decoded differently by every browser and
    // loses its extension in several.
    assert.match(disposition, /^[\x20-\x7e]+$/u, 'the filename must be ASCII')
    assert.ok(disposition.includes(locked.batchNo), 'the filename carries the batch number')

    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.equal(bytes[0], 0xef, 'first byte of the UTF-8 BOM')
    assert.equal(bytes[1], 0xbb)
    assert.equal(bytes[2], 0xbf)

    // Decode the bytes we already buffered: a `Response` body can only be read
    // once. `ignoreBOM: true` keeps the BOM in the text so it can be asserted,
    // instead of letting TextDecoder silently strip the very byte Excel needs.
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    assert.ok(text.startsWith('﻿流水号'), 'the header row is Chinese and Excel-readable')
    assert.ok(text.includes('\r\n'), 'CRLF line endings')
    assert.ok(!text.includes('13800138000'), 'a phone number must never leave in a cell')
    assert.ok(text.includes('138****8000'), 'it is masked instead')

    // The file is the statement (1 row), while the period holds 2 facts.
    assert.equal(response.headers.get('x-ledger-row-count'), '1')
    assert.equal(response.headers.get('x-ledger-late-recorded-count'), '1')
    assert.equal(response.headers.get('x-ledger-late-recorded-total-cents'), '7700')
    assert.match(
      response.headers.get('access-control-expose-headers') ?? '',
      /X-Ledger-Row-Count/iu,
    )
  } finally {
    world.sqlite.close()
  }
})

test('an unknown batch, a half period and a misspelled filter are JSON errors, never a broken file', async () => {
  const world = await makeWorld()
  try {
    // Unknown batch id -> 404 JSON envelope (not an empty CSV).
    const missing = await world.app.request(
      `${LEDGER_ROUTES.adminExportCsv}?batchId=${randomUUID()}`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('content-type')?.startsWith('application/json'), true)
    assert.equal((await readJson<{ error: { code: string } }>(missing)).error.code, API_ERROR_CODES.notFound)

    // Half a period -> 400: "unknown period" must not read as "no facts".
    const halfPeriod = await world.app.request(
      `${LEDGER_ROUTES.adminExportCsv}?periodFrom=2026-11-01`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(halfPeriod.status, 400)
    assert.equal(
      (await readJson<{ error: { code: string } }>(halfPeriod)).error.code,
      API_ERROR_CODES.invalidRequest,
    )

    // A misspelled filter -> 400 instead of silently exporting every community.
    const typo = await world.app.request(
      `${LEDGER_ROUTES.adminExportCsv}?communtyId=${world.communityId}`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(typo.status, 400)

    // The diff needs a batch or a whole period; a bare call is a 400.
    const bareDiff = await world.app.request(LEDGER_ROUTES.adminDiff, {
      headers: readHeaders(world.admin),
    })
    assert.equal(bareDiff.status, 400)

    // The same 404 is answered by the batch detail route.
    const missingDetail = await world.app.request(`/admin/reconciliation/batches/${randomUUID()}`, {
      headers: readHeaders(world.admin),
    })
    assert.equal(missingDetail.status, 404)
  } finally {
    world.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 5. Every export writes exactly one audit row with rows + actor              */
/* -------------------------------------------------------------------------- */

test('every export writes one ledger.export.csv audit row with the row count and the actor', async () => {
  const world = await makeWorld()
  try {
    insertEntry(world, {
      factKind: 'order_registered',
      communityId: world.communityId,
      amountCents: 4_200,
      attributedStaffId: world.grid.staffId,
    })
    insertEntry(world, {
      factKind: 'order_verified',
      sourceSystem: 'crm_service_order',
      communityId: world.communityId,
      amountCents: 9_900,
      attributedStaffId: world.grid.staffId,
      occurredAt: new Date('2026-11-06T11:00:00.000+08:00'),
    })
    const created = await createBatch(world, world.admin)

    const first = await world.app.request(
      `${LEDGER_ROUTES.adminExportCsv}?batchId=${created.batchId}`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(first.status, 200)

    const audits = world.db
      .select()
      .from(auditLogs)
      .all()
      .filter((row) => row.event === 'ledger.export.csv')
    assert.equal(audits.length, 1, 'exactly one audit row per export')
    const audit = audits[0]!
    assert.equal(audit.actorUserId, world.admin.userId, 'the export is attributable to a person')
    assert.equal(audit.targetId, created.batchId)
    assert.equal(audit.createdAt.getTime(), CLOCK.getTime())
    const metadata = JSON.parse(audit.metadata ?? '{}') as Record<string, string>
    assert.equal(metadata.rows, '2')
    assert.equal(metadata.lateRecordedCount, '0')
    assert.equal(metadata.lateRecordedTotalCents, '0')
    assert.equal(metadata.filters, JSON.stringify({ batchId: created.batchId }))

    // A second export is a second audit row — never a silent overwrite.
    const second = await world.app.request(
      `${LEDGER_ROUTES.adminExportCsv}?batchId=${created.batchId}`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(second.status, 200)
    assert.equal(
      world.db.select().from(auditLogs).all().filter((row) => row.event === 'ledger.export.csv').length,
      2,
    )
  } finally {
    world.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 6. Scope: 网格员 is refused, but an operator never exports other communities */
/* -------------------------------------------------------------------------- */

test('an operator cannot export a community outside their assignment', async () => {
  const world = await makeWorld()
  try {
    insertEntry(world, {
      factKind: 'order_registered',
      communityId: world.otherCommunityId,
      amountCents: 6_600,
      attributedStaffId: null,
    })
    const response = await world.app.request(
      `${LEDGER_ROUTES.adminExportCsv}?communityId=${world.otherCommunityId}`,
      { headers: readHeaders(world.operator) },
    )
    assert.equal(response.status, 403)
    assert.equal(
      (await readJson<{ error: { code: string } }>(response)).error.code,
      API_ERROR_CODES.forbidden,
    )
    assert.equal(
      world.db.select().from(auditLogs).all().filter((row) => row.event === 'ledger.export.csv').length,
      0,
      'a refused export must not be audited as if it happened',
    )
  } finally {
    world.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 7. Late-recorded facts stay visible in the diff of a locked period          */
/* -------------------------------------------------------------------------- */

test('a fact recorded after the lock surfaces in the diff and in the entry count story', async () => {
  const world = await makeWorld()
  try {
    insertEntry(world, {
      factKind: 'order_registered',
      communityId: world.communityId,
      amountCents: 5_000,
      attributedStaffId: world.grid.staffId,
    })
    const created = await createBatch(world, world.admin)
    await lockBatch(world, world.admin, created.batchId, created.updatedAt)

    const late = insertEntry(world, {
      factKind: 'order_registered',
      communityId: world.communityId,
      amountCents: 7_700,
      attributedStaffId: world.grid.staffId,
      occurredAt: new Date('2026-11-05T12:00:00.000+08:00'),
      createdAt: AFTER_LOCK,
    })
    world.db
      .insert(ledgerAnomalies)
      .values({
        id: randomUUID(),
        entryId: late,
        kind: 'source_missing_evidence',
        severity: 'high',
        note: '缺少凭据',
        flaggedByUserId: world.admin.userId,
        resolvedAt: null,
        createdAt: AFTER_LOCK,
      })
      .run()

    const response = await world.app.request(
      `${LEDGER_ROUTES.adminDiff}?batchId=${created.batchId}`,
      { headers: readHeaders(world.admin) },
    )
    assert.equal(response.status, 200)
    const diff = await readJson<ReconciliationDiff>(response)

    assert.equal(diff.status, 'locked')
    assert.equal(diff.lateRecordedCount, 1)
    assert.equal(diff.lateRecordedTotalCents, 7_700)
    const lateItem = diff.items.find((item) => item.reason === 'late_recorded_after_lock')
    assert.ok(lateItem, 'a late fact must be itemised, never silently dropped')
    assert.equal(lateItem.entryId, late)

    // The frozen statement does not move ...
    assert.deepEqual(diff.stored, { entryCount: 1, totalCents: 5_000 })
    assert.deepEqual(diff.computed, { entryCount: 1, totalCents: 5_000 })

    // ... and a locked period is *covered*, so nothing in it is "unbatched".
    // 「未纳入」and 「锁后补录」are disjoint by construction: the period total is
    // statement + late, never double-counted and never silently dropped.
    assert.equal(diff.unbatchedCount, 0, 'a locked period is covered, not un-reconciled')
    assert.equal(
      diff.computed.entryCount + diff.lateRecordedCount,
      2,
      'the period total is statement + late-recorded',
    )

    // The anomaly of the late fact is drilled down as a real row.
    assert.equal(diff.openAnomalies?.length, 1)
    assert.equal(diff.openAnomalies?.[0]?.entryId, late)
    assert.equal(diff.openAnomalies?.[0]?.resolvedAt, null)
    assert.equal(diff.openAnomalies?.[0]?.severity, 'high')

    // The statement page agrees with the frozen numbers.
    const entries = await readJson<ReconciliationBatchEntriesResponse>(
      await world.app.request(`/admin/reconciliation/batches/${created.batchId}/entries`, {
        headers: readHeaders(world.admin),
      }),
    )
    assert.equal(entries.total, 1, 'a locked page never absorbs a late fact')
    assert.equal(entries.items[0]?.amountCents, 5_000)
  } finally {
    world.sqlite.close()
  }
})
