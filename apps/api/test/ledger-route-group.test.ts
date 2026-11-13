import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { LEDGER_ROUTES } from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/security.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import { staffAccounts, users } from '../src/db/schema.js'

/**
 * Regression cover for the ledger/settlement route group extracted by LL-HY-002.
 *
 * The extraction is behaviour-preserving, so these tests deliberately assert the
 * externally visible wiring, not the new module shape:
 *
 * - every surface in the group is still registered and still answers 401 before
 *   anything else when unauthenticated;
 * - the admin/grid_worker split and the CSRF gate still run in the same order;
 * - registration order is unchanged — reconciliation before the read-only ledger
 *   skeleton, and the whole group still mounted between the local order routes
 *   and the reward routes.
 *
 * Authentication, sessions and CSRF are the real middleware from `createApp`;
 * only the staff rows are seeded directly.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ADMIN_ORIGIN = 'http://localhost:5174'
const PASSWORD = 'Route-Group-Password-123!'

type App = ReturnType<typeof createApp>

interface Session {
  cookie: string
  csrfToken: string
}

function cookiePair(response: Response, name: string): string {
  const header = response.headers.get('set-cookie') ?? ''
  const pair = header
    .split(/,(?=[^;,]+=)/)
    .map((part) => part.split(';', 1)[0]?.trim() ?? '')
    .find((part) => part.startsWith(`${name}=`))
  assert.ok(pair, `expected a ${name} cookie`)
  return pair
}

async function login(app: App, username: string): Promise<Session> {
  const csrfResponse = await app.request('/auth/csrf')
  const { csrfToken: preToken } = (await csrfResponse.json()) as { csrfToken: string }
  const preCookie = cookiePair(csrfResponse, 'll_csrf')
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: preCookie,
      'x-csrf-token': preToken,
      origin: ADMIN_ORIGIN,
    },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  assert.equal(response.status, 200, `${username} should log in`)
  const body = (await response.json()) as { csrfToken: string }
  return {
    cookie: `${cookiePair(response, 'll_session')}; ${cookiePair(response, 'll_csrf')}`,
    csrfToken: body.csrfToken,
  }
}

async function addStaff(
  app: App,
  db: ReturnType<typeof createDatabase>['db'],
  username: string,
  role: 'admin' | 'grid_worker',
): Promise<Session> {
  const now = new Date()
  const userId = randomUUID()
  db.insert(users)
    .values({ id: userId, displayName: username, createdAt: now, updatedAt: now })
    .run()
  db.insert(staffAccounts)
    .values({
      id: randomUUID(),
      userId,
      username,
      passwordHash: await hashPassword(PASSWORD),
      role,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return login(app, username)
}

async function makeFixture() {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const app = createApp({ db, config: loadConfig({ NODE_ENV: 'test' }), logRequests: false })
  const admin = await addStaff(app, db, 'route-admin', 'admin')
  const grid = await addStaff(app, db, 'route-grid', 'grid_worker')
  return { app, db, sqlite, admin, grid }
}

/** One representative surface per composed module, in its advertised method. */
const GROUP_SURFACES: Array<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'GET', path: LEDGER_ROUTES.adminBatches }, // ledger skeleton read
  { method: 'POST', path: LEDGER_ROUTES.adminBatches }, // reconciliation create
  { method: 'GET', path: LEDGER_ROUTES.adminOverview }, // ledger skeleton
  { method: 'GET', path: LEDGER_ROUTES.adminSettlementParties }, // settlement parties
  { method: 'GET', path: LEDGER_ROUTES.adminSettlementCandidates }, // settlement candidates
  { method: 'GET', path: LEDGER_ROUTES.adminSettlementRules }, // contract rules
  { method: 'GET', path: LEDGER_ROUTES.adminSettlementStatements }, // statements
]

test('ledger route group: every surface stays registered and anonymous requests are 401', async () => {
  const { app, sqlite } = await makeFixture()
  try {
    for (const surface of GROUP_SURFACES) {
      const response = await app.request(surface.path, { method: surface.method })
      assert.equal(
        response.status,
        401,
        `${surface.method} ${surface.path} must still be registered and reject anonymous callers`,
      )
      const body = (await response.json()) as { error?: { code?: string } }
      assert.equal(body.error?.code, 'unauthorized')
    }

    // Control: an unregistered path is still a 404, so the assertions above are
    // not passing because every request would fail the same way.
    const missing = await app.request('/admin/settlement/not-a-route')
    assert.equal(missing.status, 404)
  } finally {
    sqlite.close()
  }
})

test('ledger route group: admin/grid_worker split and CSRF order are unchanged', async () => {
  const { app, sqlite, admin, grid } = await makeFixture()
  try {
    // Reads that legitimately answer 200 for an administrator.
    for (const path of [
      LEDGER_ROUTES.adminOverview,
      LEDGER_ROUTES.adminBatches,
      LEDGER_ROUTES.adminSettlementParties,
    ]) {
      const response = await app.request(path, { headers: { cookie: admin.cookie } })
      assert.equal(response.status, 200, `GET ${path} should still be served`)
    }

    // The same back-office surfaces remain 403 for a grid worker.
    for (const path of [
      LEDGER_ROUTES.adminOverview,
      LEDGER_ROUTES.adminBatches,
      LEDGER_ROUTES.adminSettlementParties,
      LEDGER_ROUTES.adminSettlementCandidates,
      LEDGER_ROUTES.adminSettlementRules,
      LEDGER_ROUTES.adminSettlementStatements,
    ]) {
      const response = await app.request(path, { headers: { cookie: grid.cookie } })
      assert.equal(response.status, 403, `GET ${path} must still refuse grid_worker`)
    }

    // Auth first, then CSRF: an authenticated admin write without the
    // double-submit header is a 403 and never reaches the body parser.
    const noCsrf = await app.request(LEDGER_ROUTES.adminBatches, {
      method: 'POST',
      headers: {
        cookie: admin.cookie,
        origin: ADMIN_ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    assert.equal(noCsrf.status, 403)
    const noCsrfBody = (await noCsrf.json()) as { error?: { code?: string } }
    assert.equal(noCsrfBody.error?.code, 'forbidden')
  } finally {
    sqlite.close()
  }
})

test('ledger route group: registration order is preserved', async () => {
  const { app, sqlite } = await makeFixture()
  try {
    const indexOf = (method: string, path: string): number => {
      const index = app.routes.findIndex((route) => route.method === method && route.path === path)
      assert.notEqual(index, -1, `${method} ${path} should be registered`)
      return index
    }

    const localOrders = indexOf('GET', '/local-orders')
    const reconciliationCreate = indexOf('POST', LEDGER_ROUTES.adminBatches)
    const ledgerSkeletonList = indexOf('GET', LEDGER_ROUTES.adminBatches)
    const ledgerOverview = indexOf('GET', LEDGER_ROUTES.adminOverview)
    const settlementParties = indexOf('GET', LEDGER_ROUTES.adminSettlementParties)
    const rewards = indexOf('GET', '/activities/:activityId/checkin')

    // Mounted at the same position in `createApp`: after the local order routes
    // whose facts the ledger derives from, before the reward routes.
    assert.ok(localOrders < reconciliationCreate, 'ledger group must follow the local order routes')
    assert.ok(rewards > settlementParties, 'ledger group must precede the reward routes')

    // Inside the group: reconciliation is registered before the read-only
    // skeleton so its concrete handlers are never shadowed.
    assert.ok(
      reconciliationCreate < ledgerSkeletonList,
      'reconciliation must be registered before the ledger skeleton',
    )
    assert.ok(ledgerSkeletonList < settlementParties, 'settlement routes follow the skeleton')
    assert.ok(ledgerOverview < settlementParties, 'settlement routes follow the ledger skeleton')
  } finally {
    sqlite.close()
  }
})
