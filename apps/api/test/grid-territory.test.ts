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
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/security.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  auditLogs,
  communities,
  localOrders,
  localProducts,
  residentCommunityAssignments,
  staffAccounts,
  staffCommunityAssignments,
  users,
} from '../src/db/schema.js'

/**
 * One grid worker = one logical territory; one territory = one grid worker.
 *
 * These tests go through the real Hono app and the real migrated SQLite schema.
 * Operators keep many-to-many authorization; admins stay global. Historical
 * residents and orders are never moved or deleted by an assignment change.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ADMIN_PASSWORD = 'Admin-Password-123!'
const WORKER_PASSWORD = 'Grid-Worker-Password-123!'
const NOW = new Date('2026-11-15T02:00:00.000Z')

type App = ReturnType<typeof createApp>

interface Harness {
  app: App
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
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
  assert.ok(pair, `expected a ${name} cookie`)
  return pair
}

function cookieHeader(...pairs: string[]) {
  return pairs.join('; ')
}

function postHeaders(cookie: string, token: string) {
  return {
    'content-type': 'application/json',
    cookie,
    'x-csrf-token': token,
    origin: 'http://localhost:5174',
  }
}

async function csrf(app: App) {
  const response = await app.request('/auth/csrf')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { csrfToken: string }
  return { token: body.csrfToken, cookie: cookiePair(response, 'll_csrf') }
}

async function login(app: App, username: string, password: string) {
  const state = await csrf(app)
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: postHeaders(state.cookie, state.token),
    body: JSON.stringify({ username, password }),
  })
  return {
    response,
    csrfToken: response.ok
      ? ((await response.clone().json()) as { csrfToken: string }).csrfToken
      : null,
  }
}

function testContext(): Harness {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const app = createApp({ db, config, logRequests: false })
  return { app, db, sqlite }
}

async function createAdmin(db: AppDatabase) {
  const now = new Date()
  const userId = randomUUID()
  const staffId = randomUUID()
  db.insert(users).values({
    id: userId, displayName: '系统管理员', createdAt: now, updatedAt: now,
  }).run()
  db.insert(staffAccounts).values({
    id: staffId,
    userId,
    username: 'admin',
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }).run()
  return { userId, staffId }
}

async function adminSession(app: App) {
  const signedIn = await login(app, 'admin', ADMIN_PASSWORD)
  assert.equal(signedIn.response.status, 200)
  return {
    cookie: cookieHeader(
      cookiePair(signedIn.response, 'll_session'),
      cookiePair(signedIn.response, 'll_csrf'),
    ),
    token: signedIn.csrfToken!,
  }
}

async function createCommunity(
  app: App,
  admin: { cookie: string; token: string },
  name: string,
): Promise<string> {
  const response = await app.request('/admin/communities', {
    method: 'POST',
    headers: postHeaders(admin.cookie, admin.token),
    body: JSON.stringify({ name }),
  })
  assert.equal(response.status, 201)
  return ((await response.json()) as { id: string }).id
}

async function createStaff(
  app: App,
  admin: { cookie: string; token: string },
  input: { username: string; role: 'operator' | 'grid_worker'; communityIds: string[] },
) {
  return app.request('/admin/staff', {
    method: 'POST',
    headers: postHeaders(admin.cookie, admin.token),
    body: JSON.stringify({
      username: input.username,
      displayName: input.username,
      password: WORKER_PASSWORD,
      role: input.role,
      communityIds: input.communityIds,
    }),
  })
}

function seedHistory(
  db: AppDatabase,
  input: { communityId: string; residentId: string; gridWorkerId: string },
) {
  const productId = randomUUID()
  db.insert(residentCommunityAssignments).values({
    userId: input.residentId, communityId: input.communityId, createdAt: NOW,
  }).run()
  db.insert(localProducts).values({
    id: productId,
    communityId: input.communityId,
    name: '历史助农包',
    unitPriceCents: 1000,
    status: 'on_shelf',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  const orderId = randomUUID()
  db.insert(localOrders).values({
    id: orderId,
    communityId: input.communityId,
    productId,
    residentUserId: input.residentId,
    idempotencyKey: `history-${orderId}`,
    status: 'registered',
    recordSource: 'resident',
    productName: '历史助农包',
    unitPriceCents: 1000,
    quantity: 1,
    totalCents: 1000,
    couponDiscountCents: 0,
    attributedStaffId: input.gridWorkerId,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  return { productId, orderId }
}

test('grid workers are restricted to one territory while operators keep multi-community scope', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await adminSession(app)
    const communityA = await createCommunity(app, admin, '幸福片区')
    const communityB = await createCommunity(app, admin, '阳光片区')
    const communityC = await createCommunity(app, admin, '新城片区')

    const gridA = await createStaff(app, admin, {
      username: 'grid.a', role: 'grid_worker', communityIds: [communityA],
    })
    assert.equal(gridA.status, 201)
    const gridAId = ((await gridA.json()) as { id: string }).id
    const gridB = await createStaff(app, admin, {
      username: 'grid.b', role: 'grid_worker', communityIds: [communityB],
    })
    assert.equal(gridB.status, 201)
    const gridBId = ((await gridB.json()) as { id: string }).id

    // A second grid worker cannot take an occupied territory.
    const occupied = await createStaff(app, admin, {
      username: 'grid.c', role: 'grid_worker', communityIds: [communityA],
    })
    assert.equal(occupied.status, 409)

    // The contract rejects a grid worker with two communities before writes.
    const multiTerritory = await createStaff(app, admin, {
      username: 'grid.d', role: 'grid_worker', communityIds: [communityA, communityB],
    })
    assert.equal(multiTerritory.status, 400)

    // Operators keep the existing many-to-many authorization model.
    const operator = await createStaff(app, admin, {
      username: 'operator.multi', role: 'operator', communityIds: [communityA, communityB],
    })
    assert.equal(operator.status, 201)
    const operatorId = ((await operator.json()) as { id: string }).id
    const additional = await app.request(`/admin/communities/${communityC}/staff`, {
      method: 'POST',
      headers: postHeaders(admin.cookie, admin.token),
      body: JSON.stringify({ staffAccountId: operatorId }),
    })
    assert.equal(additional.status, 201)
    assert.equal(
      db.select().from(staffCommunityAssignments)
        .where(eq(staffCommunityAssignments.staffAccountId, operatorId)).all().length,
      3,
    )

    // A grid worker owning A cannot be assigned B through the generic link route.
    const crossTerritory = await app.request(`/admin/communities/${communityB}/staff`, {
      method: 'POST',
      headers: postHeaders(admin.cookie, admin.token),
      body: JSON.stringify({ staffAccountId: gridAId }),
    })
    assert.equal(crossTerritory.status, 409)

    const gridSession = await login(app, 'grid.a', WORKER_PASSWORD)
    assert.equal(gridSession.response.status, 200)
    const gridCookie = cookieHeader(
      cookiePair(gridSession.response, 'll_session'),
      cookiePair(gridSession.response, 'll_csrf'),
    )
    assert.equal((await app.request(`/crm/residents?communityId=${communityA}`, {
      headers: { cookie: gridCookie },
    })).status, 200)
    assert.equal((await app.request(`/crm/residents?communityId=${communityB}`, {
      headers: { cookie: gridCookie },
    })).status, 403)

    // Assignment changes stay admin-only and CSRF-protected.
    assert.equal((await app.request(
      `/admin/communities/${communityA}/staff/${gridAId}`,
      { method: 'DELETE', headers: { cookie: gridCookie } },
    )).status, 403)
    assert.equal((await app.request(
      `/admin/communities/${communityA}/staff/${gridAId}`,
      { method: 'DELETE', headers: { cookie: admin.cookie } },
    )).status, 403)

    const adminCommunitiesResponse = await app.request('/admin/communities', {
      headers: { cookie: admin.cookie },
    })
    const adminCommunities = (await adminCommunitiesResponse.json()) as {
      items: Array<{ id: string }>
    }
    assert.equal(adminCommunities.items.length, 3, 'admin keeps global community access')
    const adminStaffResponse = await app.request('/admin/staff', {
      headers: { cookie: admin.cookie },
    })
    const adminStaff = (await adminStaffResponse.json()) as { items: Array<{ id: string }> }
    assert.equal(adminStaff.items.length, 4, 'admin sees every back-office account')

    const gridRows = db.select().from(staffCommunityAssignments)
      .where(eq(staffCommunityAssignments.assignmentKind, 'grid_territory')).all()
    assert.equal(gridRows.length, 2)
    assert.deepEqual(
      gridRows.map((row) => row.staffAccountId).sort(),
      [gridAId, gridBId].sort(),
    )
  } finally {
    sqlite.close()
  }
})

test('replacing and unassigning a grid worker revokes access without moving history', async () => {
  const { app, db, sqlite } = testContext()
  try {
    const adminUser = await createAdmin(db)
    const admin = await adminSession(app)
    const communityA = await createCommunity(app, admin, '幸福片区')
    const communityB = await createCommunity(app, admin, '阳光片区')
    const communityC = await createCommunity(app, admin, '新城片区')

    const gridAId = ((await (await createStaff(app, admin, {
      username: 'grid.a', role: 'grid_worker', communityIds: [communityA],
    })).json()) as { id: string }).id
    const gridBId = ((await (await createStaff(app, admin, {
      username: 'grid.b', role: 'grid_worker', communityIds: [communityB],
    })).json()) as { id: string }).id

    const residentId = randomUUID()
    db.insert(users).values({
      id: residentId,
      displayName: '历史居民',
      createdAt: NOW,
      updatedAt: NOW,
    }).run()
    const history = seedHistory(db, {
      communityId: communityA,
      residentId,
      gridWorkerId: gridAId,
    })

    // B cannot take C while still owning B.
    const blocked = await app.request(`/admin/communities/${communityC}/grid-worker`, {
      method: 'PUT',
      headers: postHeaders(admin.cookie, admin.token),
      body: JSON.stringify({ staffAccountId: gridBId, expectedStaffAccountId: null }),
    })
    assert.equal(blocked.status, 409)

    // Unassign B, then move it to C.
    const removed = await app.request(
      `/admin/communities/${communityB}/staff/${gridBId}`,
      { method: 'DELETE', headers: postHeaders(admin.cookie, admin.token) },
    )
    assert.equal(removed.status, 204)
    const assigned = await app.request(`/admin/communities/${communityC}/grid-worker`, {
      method: 'PUT',
      headers: postHeaders(admin.cookie, admin.token),
      body: JSON.stringify({ staffAccountId: gridBId, expectedStaffAccountId: null }),
    })
    assert.equal(assigned.status, 200)

    // Replacing C's owner with A is blocked until A's old territory is freed.
    const replaceBlocked = await app.request(`/admin/communities/${communityC}/grid-worker`, {
      method: 'PUT',
      headers: postHeaders(admin.cookie, admin.token),
      body: JSON.stringify({ staffAccountId: gridAId, expectedStaffAccountId: gridBId }),
    })
    assert.equal(replaceBlocked.status, 409)
    await app.request(`/admin/communities/${communityA}/staff/${gridAId}`, {
      method: 'DELETE', headers: postHeaders(admin.cookie, admin.token),
    })
    const replaced = await app.request(`/admin/communities/${communityC}/grid-worker`, {
      method: 'PUT',
      headers: postHeaders(admin.cookie, admin.token),
      body: JSON.stringify({ staffAccountId: gridAId, expectedStaffAccountId: gridBId }),
    })
    assert.equal(replaced.status, 200)

    // Old worker lost C, new worker has it; A's own access was revoked too.
    const gridBLogin = await login(app, 'grid.b', WORKER_PASSWORD)
    const gridBCookie = cookieHeader(
      cookiePair(gridBLogin.response, 'll_session'),
      cookiePair(gridBLogin.response, 'll_csrf'),
    )
    assert.equal((await app.request(`/crm/residents?communityId=${communityC}`, {
      headers: { cookie: gridBCookie },
    })).status, 403)
    const gridALogin = await login(app, 'grid.a', WORKER_PASSWORD)
    const gridACookie = cookieHeader(
      cookiePair(gridALogin.response, 'll_session'),
      cookiePair(gridALogin.response, 'll_csrf'),
    )
    assert.equal((await app.request(`/crm/residents?communityId=${communityC}`, {
      headers: { cookie: gridACookie },
    })).status, 200)
    assert.equal((await app.request(`/crm/residents?communityId=${communityA}`, {
      headers: { cookie: gridACookie },
    })).status, 403)

    // Residents, orders and their original attribution are untouched.
    assert.equal(db.select().from(residentCommunityAssignments)
      .where(eq(residentCommunityAssignments.userId, residentId)).all().length, 1)
    const order = db.select().from(localOrders)
      .where(eq(localOrders.id, history.orderId)).get()
    assert.equal(order?.communityId, communityA)
    assert.equal(order?.attributedStaffId, gridAId)
    assert.equal(db.select().from(localProducts)
      .where(eq(localProducts.id, history.productId)).all().length, 1)

    const audits = db.select().from(auditLogs).all()
    assert.equal(
      audits.filter((row) => row.event === 'staff.community_unassigned').length,
      2,
    )
    assert.equal(
      audits.filter((row) => row.event === 'staff.grid_territory_reassigned').length,
      2,
    )
    assert.ok(audits.some((row) =>
      row.event === 'staff.grid_territory_reassigned' &&
      row.actorUserId === adminUser.userId))

    // A second grid row for C cannot bypass the unique territory index.
    const extraWorkerId = randomUUID()
    const extraUserId = randomUUID()
    db.insert(users).values({
      id: extraUserId, displayName: '额外网格员', createdAt: NOW, updatedAt: NOW,
    }).run()
    db.insert(staffAccounts).values({
      id: extraWorkerId,
      userId: extraUserId,
      username: 'grid.extra',
      passwordHash: 'not-a-real-hash',
      role: 'grid_worker',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    }).run()
    assert.throws(() => {
      db.insert(staffCommunityAssignments).values({
        staffAccountId: extraWorkerId,
        communityId: communityC,
        assignmentKind: 'grid_territory',
        createdAt: NOW,
      }).run()
    })
  } finally {
    sqlite.close()
  }
})

test('concurrent appointments cannot leave one territory with two grid workers', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await adminSession(app)
    const homeA = await createCommunity(app, admin, '甲片区')
    const homeB = await createCommunity(app, admin, '乙片区')
    const target = await createCommunity(app, admin, '目标片区')

    const gridAId = ((await (await createStaff(app, admin, {
      username: 'grid.a', role: 'grid_worker', communityIds: [homeA],
    })).json()) as { id: string }).id
    const gridBId = ((await (await createStaff(app, admin, {
      username: 'grid.b', role: 'grid_worker', communityIds: [homeB],
    })).json()) as { id: string }).id

    await app.request(`/admin/communities/${homeA}/staff/${gridAId}`, {
      method: 'DELETE', headers: postHeaders(admin.cookie, admin.token),
    })
    await app.request(`/admin/communities/${homeB}/staff/${gridBId}`, {
      method: 'DELETE', headers: postHeaders(admin.cookie, admin.token),
    })

    const attempts = await Promise.all([
      app.request(`/admin/communities/${target}/grid-worker`, {
        method: 'PUT',
        headers: postHeaders(admin.cookie, admin.token),
        body: JSON.stringify({ staffAccountId: gridAId, expectedStaffAccountId: null }),
      }),
      app.request(`/admin/communities/${target}/grid-worker`, {
        method: 'PUT',
        headers: postHeaders(admin.cookie, admin.token),
        body: JSON.stringify({ staffAccountId: gridBId, expectedStaffAccountId: null }),
      }),
    ])
    assert.deepEqual(attempts.map((response) => response.status).sort(), [200, 409])
    assert.equal(
      db.select().from(staffCommunityAssignments)
        .where(eq(staffCommunityAssignments.communityId, target)).all().length,
      1,
    )
  } finally {
    sqlite.close()
  }
})

test('migration backfills assignment kinds and keeps a pre-territory database usable', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-grid-upgrade-'))
  try {
    const staging = join(tempDir, 'migrations-before-territory')
    mkdirSync(join(staging, 'meta'), { recursive: true })
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: Array<{ idx: number; tag: string }> }
    const before = journal.entries.filter((entry) => entry.idx <= 29)
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
    const communityA = randomUUID()
    const communityB = randomUUID()
    const gridUser = randomUUID()
    const gridStaff = randomUUID()
    const operatorUser = randomUUID()
    const operatorStaff = randomUUID()
    try {
      legacy.sqlite.prepare(
        'INSERT INTO communities (id, name, created_at) VALUES (?, ?, ?)',
      ).run(communityA, '升级前网格片区', NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO communities (id, name, created_at) VALUES (?, ?, ?)',
      ).run(communityB, '升级前运营片区', NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run(gridUser, '升级前网格员', NOW.getTime(), NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run(operatorUser, '升级前运营员', NOW.getTime(), NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO staff_accounts (id, user_id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(gridStaff, gridUser, 'legacy.grid', 'x', 'grid_worker', 'active', NOW.getTime(), NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO staff_accounts (id, user_id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(operatorStaff, operatorUser, 'legacy.operator', 'x', 'operator', 'active', NOW.getTime(), NOW.getTime())
      // Old table had no assignment_kind. Grid: one territory. Operator: two.
      legacy.sqlite.prepare(
        'INSERT INTO staff_community_assignments (staff_account_id, community_id, created_at) VALUES (?, ?, ?)',
      ).run(gridStaff, communityA, NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO staff_community_assignments (staff_account_id, community_id, created_at) VALUES (?, ?, ?)',
      ).run(operatorStaff, communityA, NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO staff_community_assignments (staff_account_id, community_id, created_at) VALUES (?, ?, ?)',
      ).run(operatorStaff, communityB, NOW.getTime())
    } finally {
      legacy.sqlite.close()
    }

    const upgraded = createDatabase(databasePath, migrationsFolder)
    try {
      const rows = upgraded.db.select().from(staffCommunityAssignments).all()
      assert.equal(rows.length, 3)
      assert.equal(
        rows.find((row) => row.staffAccountId === gridStaff)?.assignmentKind,
        'grid_territory',
      )
      assert.deepEqual(
        rows
          .filter((row) => row.staffAccountId === operatorStaff)
          .map((row) => row.assignmentKind),
        ['operator_scope', 'operator_scope'],
      )
      assert.equal(
        upgraded.db.select().from(communities).all().length,
        2,
        'communities survive the migration',
      )
      assert.throws(() => {
        upgraded.db.insert(staffCommunityAssignments).values({
          staffAccountId: randomUUID(),
          communityId: communityA,
          assignmentKind: 'grid_territory',
          createdAt: NOW,
        }).run()
      })
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('migration refuses conflicting historical territories instead of choosing a winner', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'll-grid-conflict-'))
  try {
    const staging = join(tempDir, 'migrations-before-territory')
    mkdirSync(join(staging, 'meta'), { recursive: true })
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: Array<{ idx: number; tag: string }> }
    const before = journal.entries.filter((entry) => entry.idx <= 29)
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

    const databasePath = join(tempDir, 'conflict.sqlite')
    const legacy = createDatabase(databasePath, staging)
    const communityA = randomUUID()
    const communityB = randomUUID()
    const userId = randomUUID()
    const staffId = randomUUID()
    try {
      legacy.sqlite.prepare(
        'INSERT INTO communities (id, name, created_at) VALUES (?, ?, ?)',
      ).run(communityA, '冲突片区 A', NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO communities (id, name, created_at) VALUES (?, ?, ?)',
      ).run(communityB, '冲突片区 B', NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run(userId, '冲突网格员', NOW.getTime(), NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO staff_accounts (id, user_id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(staffId, userId, 'conflict.grid', 'x', 'grid_worker', 'active', NOW.getTime(), NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO staff_community_assignments (staff_account_id, community_id, created_at) VALUES (?, ?, ?)',
      ).run(staffId, communityA, NOW.getTime())
      legacy.sqlite.prepare(
        'INSERT INTO staff_community_assignments (staff_account_id, community_id, created_at) VALUES (?, ?, ?)',
      ).run(staffId, communityB, NOW.getTime())
    } finally {
      legacy.sqlite.close()
    }

    assert.throws(
      () => createDatabase(databasePath, migrationsFolder),
      (error: unknown) => {
        // Drizzle wraps the SQLite abort; the cause carries the readable guard.
        const cause = error instanceof Error && error.cause instanceof Error
          ? error.cause
          : error
        return cause instanceof Error && /grid territory conflict/u.test(cause.message)
      },
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
