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
  API_ERROR_CODES,
  ACTIVITY_DRAW_ROUTES,
  activityDrawPoolSchema,
  activityDrawPrizeSchema,
  publicActivityDrawPoolSchema,
  type ActivityDrawPool,
  type PublicActivityDrawPool,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activityDrawEvents,
  activityDrawPrizes,
  activityDrawAttempts,
  activityDrawCredentials,
  activityDrawFulfilmentEvents,
  communities,
  localProducts,
  staffAccounts,
  staffCommunityAssignments,
  users,
} from '../src/db/schema.js'
import { hashPassword } from '../src/auth/security.js'
import { drawBeijingDay, enterDailyDraw } from '../src/draw/engine.js'
import { seedConfirmedCommunity } from './resident-community-fixtures.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ADMIN_ORIGIN = 'http://localhost:5174'
const ADMIN_PASSWORD = 'Admin-Password-123!'
const OPERATOR_PASSWORD = 'Operator-Password-123!'
const GRID_PASSWORD = 'Grid-Worker-Password-123!'
const NOW = new Date()
const DRAW_SECRET = 'll-test-only-not-a-real-deployment-key-123456789'

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
}

interface Fixture {
  app: App
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  communityId: string
  otherCommunityId: string
  admin: Session
  operator: Session
  grid: Session
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

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

function cookieHeader(...pairs: string[]) {
  return pairs.join('; ')
}

async function csrf(app: App) {
  const response = await app.request('/auth/csrf')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { csrfToken: string }
  return { token: body.csrfToken, cookie: cookiePair(response, 'll_csrf') }
}

interface ApiOptions {
  session?: Session
  body?: unknown
  csrf?: boolean
  origin?: string | null
}

function api(app: App, method: string, path: string, options: ApiOptions = {}) {
  const { session, body, csrf: withCsrf = method !== 'GET', origin } = options
  const headers: Record<string, string> = {}
  if (session) headers.cookie = session.cookies
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (session && withCsrf) {
    headers['x-csrf-token'] = session.csrfToken
    if (origin !== null) headers.origin = origin ?? ADMIN_ORIGIN
  } else if (origin) {
    headers.origin = origin
  }
  return app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string; message: string } }
  return body.error.code
}

async function login(app: App, username: string, password: string): Promise<Session> {
  const csrfState = await csrf(app)
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: csrfState.cookie,
      'x-csrf-token': csrfState.token,
      origin: ADMIN_ORIGIN,
    },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(response.status, 200, `${username} should be able to log in`)
  const body = (await response.json()) as { csrfToken: string }
  return {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: body.csrfToken,
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

async function seedStaff(
  db: AppDatabase,
  input: {
    username: string
    password: string
    role: 'admin' | 'operator' | 'grid_worker'
    communityIds?: string[]
  },
): Promise<void> {
  const now = new Date()
  const userId = randomUUID()
  const staffId = randomUUID()
  db.insert(users)
    .values({ id: userId, displayName: input.username, createdAt: now, updatedAt: now })
    .run()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId,
      username: input.username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  for (const communityId of input.communityIds ?? []) {
    db.insert(staffCommunityAssignments)
      .values({
        staffAccountId: staffId,
        communityId,
        assignmentKind: input.role === 'grid_worker' ? 'grid_territory' : 'operator_scope',
        createdAt: now,
      })
      .run()
  }
}

async function createFixture(databasePath = ':memory:'): Promise<Fixture> {
  const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true', DRAW_CREDENTIAL_SECRET: DRAW_SECRET })
  const app = createApp({ db, config, logRequests: false })

  const communityId = randomUUID()
  const otherCommunityId = randomUUID()
  const now = new Date()
  db.insert(communities)
    .values([
      { id: communityId, name: '幸福社区', createdAt: now },
      { id: otherCommunityId, name: '邻家社区', createdAt: now },
    ])
    .run()

  await seedStaff(db, { username: 'admin', password: ADMIN_PASSWORD, role: 'admin' })
  await seedStaff(db, {
    username: 'operator.a',
    password: OPERATOR_PASSWORD,
    role: 'operator',
    communityIds: [communityId],
  })
  await seedStaff(db, {
    username: 'grid.a',
    password: GRID_PASSWORD,
    role: 'grid_worker',
    communityIds: [communityId],
  })

  return {
    app,
    db,
    sqlite,
    communityId,
    otherCommunityId,
    admin: await login(app, 'admin', ADMIN_PASSWORD),
    operator: await login(app, 'operator.a', OPERATOR_PASSWORD),
    grid: await login(app, 'grid.a', GRID_PASSWORD),
  }
}

async function createActivity(
  fixture: Fixture,
  options: { communityId?: string; publish?: boolean } = {},
): Promise<string> {
  const startsAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)
  const endsAt = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000)
  const response = await api(fixture.app, 'POST', '/admin/activities', {
    session: fixture.admin,
    body: {
      communityId: options.communityId ?? fixture.communityId,
      title: '真实今日抽奖活动',
      keyRules: {
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        location: '幸福社区党群服务中心',
        budgetCapCents: 100_000,
        prizeQuantityCap: 50,
        publicRules: {
          eligibility: '本社区 60 岁以上居民',
          checkin: '现场签到',
          purchase: '无消费门槛',
          prizeClaim: '现场领取',
        },
      },
    },
  })
  assert.equal(response.status, 201, 'activity creation must succeed')
  const activityId = ((await response.json()) as { id: string }).id
  if (options.publish ?? true) {
    const detailResponse = await api(fixture.app, 'GET', `/admin/activities/${activityId}`, {
      session: fixture.admin,
    })
    assert.equal(detailResponse.status, 200)
    const detail = (await detailResponse.json()) as { updatedAt: string }
    const publishResponse = await api(
      fixture.app,
      'POST',
      `/admin/activities/${activityId}/publish`,
      { session: fixture.admin, body: { expectedUpdatedAt: detail.updatedAt } },
    )
    assert.equal(publishResponse.status, 200, 'activity publish must succeed')
  }
  return activityId
}

async function createProduct(
  fixture: Fixture,
  input: { communityId?: string; name?: string; priceCents?: number } = {},
): Promise<string> {
  const response = await api(fixture.app, 'POST', '/admin/catalog/products', {
    session: fixture.admin,
    body: {
      communityId: input.communityId ?? fixture.communityId,
      name: input.name ?? '有机杂粮礼盒',
      priceCents: input.priceCents ?? 4_500,
    },
  })
  assert.equal(response.status, 201, 'product creation must succeed')
  return ((await response.json()) as { id: string }).id
}

function path(route: string, activityId: string, prizeId?: string): string {
  return route
    .replace(':activityId', activityId)
    .replace(':prizeId', prizeId ?? ':prizeId')
}

async function getPool(fixture: Fixture, activityId: string): Promise<ActivityDrawPool> {
  const response = await api(fixture.app, 'GET', path(ACTIVITY_DRAW_ROUTES.adminPool, activityId), {
    session: fixture.admin,
  })
  assert.equal(response.status, 200)
  return activityDrawPoolSchema.parse(await response.json())
}

async function savePool(
  fixture: Fixture,
  activityId: string,
  body: {
    expectedUpdatedAt: string | null
    enabled: boolean
    dailyDrawLimitPerResident: number
    noPrizeWeight: number
  },
  session = fixture.admin,
) {
  return api(fixture.app, 'POST', path(ACTIVITY_DRAW_ROUTES.adminSavePool, activityId), {
    session,
    body,
  })
}

async function addPrize(
  fixture: Fixture,
  activityId: string,
  body: { productId: string; costCents: number; totalQuantity: number; weight: number; enabled: boolean },
) {
  return api(fixture.app, 'POST', path(ACTIVITY_DRAW_ROUTES.adminCreatePrize, activityId), {
    session: fixture.admin,
    body,
  })
}

async function updatePrize(
  fixture: Fixture,
  activityId: string,
  prizeId: string,
  body: Record<string, unknown>,
) {
  return api(fixture.app, 'PATCH', path(ACTIVITY_DRAW_ROUTES.adminPrize, activityId, prizeId), {
    session: fixture.admin,
    body,
  })
}

async function getPublicPool(
  fixture: Fixture,
  activityId: string,
): Promise<PublicActivityDrawPool> {
  const response = await api(fixture.app, 'GET', path(ACTIVITY_DRAW_ROUTES.publicPool, activityId))
  assert.equal(response.status, 200)
  return publicActivityDrawPoolSchema.parse(await response.json())
}

/** Seed a ready pool: base config + one enabled prize with real stock. */
async function seedReadyPool(fixture: Fixture, activityId: string, productId: string) {
  const saved = await savePool(fixture, activityId, {
    expectedUpdatedAt: null,
    enabled: false,
    dailyDrawLimitPerResident: 3,
    noPrizeWeight: 20,
  })
  assert.equal(saved.status, 200)
  const added = await addPrize(fixture, activityId, {
    productId,
    costCents: 2_345,
    totalQuantity: 5,
    weight: 80,
    enabled: true,
  })
  assert.equal(added.status, 201)
  const prize = activityDrawPrizeSchema.parse(await added.json())
  const current = await getPool(fixture, activityId)
  const enabled = await savePool(fixture, activityId, {
    expectedUpdatedAt: current.updatedAt,
    enabled: true,
    dailyDrawLimitPerResident: 3,
    noPrizeWeight: 20,
  })
  assert.equal(enabled.status, 200)
  return prize
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

test('a fresh activity has an honest empty pool and no resident draw', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const pool = await getPool(fixture, activityId)
    assert.equal(pool.configured, false)
    assert.equal(pool.enabled, false)
    assert.equal(pool.dailyDrawLimitPerResident, 0)
    assert.deepEqual(pool.prizes, [])
    assert.deepEqual(pool.totals, {
      totalQuantity: 0,
      remainingQuantity: 0,
      drawnQuantity: 0,
      enabledPrizeCount: 0,
    })

    const publicPool = await getPublicPool(fixture, activityId)
    assert.equal(publicPool.available, false)
    assert.equal(publicPool.unavailableReason, 'draw_pool_not_configured')
    assert.deepEqual(publicPool.prizes, [])
  } finally {
    fixture.sqlite.close()
  }
})

test('a published pool persists real product snapshots and survives a restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'll-draw-persist-'))
  const databasePath = join(directory, 'draw.sqlite')
  const first = await createFixture(databasePath)
  let activityId = ''
  let productId = ''
  try {
    activityId = await createActivity(first)
    productId = await createProduct(first, { name: '真实抽奖礼盒', priceCents: 8_888 })
    const prize = await seedReadyPool(first, activityId, productId)
    assert.equal(prize.productName, '真实抽奖礼盒')
    assert.equal(prize.costCents, 2_345, 'fulfilment cost is not the product retail price')
    assert.equal(prize.remainingQuantity, 5)
    assert.equal(prize.enabled, true)

    // The catalogue may change later; the prize snapshot must not follow it.
    const productRow = first.db
      .select()
      .from(localProducts)
      .where(eq(localProducts.id, productId))
      .get()
    assert.ok(productRow)
    first.db
      .update(localProducts)
      .set({ name: '改名后的商品', unitPriceCents: 1 })
      .where(eq(localProducts.id, productId))
      .run()

    const publicPool = await getPublicPool(first, activityId)
    assert.equal(publicPool.available, true)
    assert.equal(publicPool.dailyDrawLimitPerResident, 3)
    assert.equal(publicPool.prizes.length, 1)
    assert.equal(publicPool.prizes[0]?.name, '真实抽奖礼盒')
  } finally {
    first.sqlite.close()
  }

  const reopened = createDatabase(databasePath, migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true', DRAW_CREDENTIAL_SECRET: DRAW_SECRET })
  const app = createApp({ db: reopened.db, config, logRequests: false })
  try {
    const admin = await login(app, 'admin', ADMIN_PASSWORD)
    const response = await api(app, 'GET', path(ACTIVITY_DRAW_ROUTES.adminPool, activityId), {
      session: admin,
    })
    assert.equal(response.status, 200)
    const pool = activityDrawPoolSchema.parse(await response.json())
    assert.equal(pool.configured, true)
    assert.equal(pool.enabled, true)
    assert.equal(pool.prizes.length, 1)
    assert.equal(pool.prizes[0]?.productName, '真实抽奖礼盒')
    assert.equal(pool.prizes[0]?.costCents, 2_345)

    const events = reopened.db
      .select()
      .from(activityDrawEvents)
      .where(eq(activityDrawEvents.activityId, activityId))
      .all()
    assert.ok(events.some((event) => event.kind === 'draw_pool.created'))
    assert.ok(events.some((event) => event.kind === 'draw_prize.created'))
    assert.ok(events.some((event) => event.kind === 'draw_pool.enabled'))
  } finally {
    reopened.sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('enabling requires a real, in-stock, weighted prize', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const productId = await createProduct(fixture)

    const created = await savePool(fixture, activityId, {
      expectedUpdatedAt: null,
      enabled: false,
      dailyDrawLimitPerResident: 2,
      noPrizeWeight: 10,
    })
    assert.equal(created.status, 200)
    const emptyPool = activityDrawPoolSchema.parse(await created.json())
    assert.equal(emptyPool.configured, true)
    assert.equal(emptyPool.enabled, false)

    // Enable with no prize at all => rejected, and nothing is turned on.
    const notReady = await savePool(fixture, activityId, {
      expectedUpdatedAt: emptyPool.updatedAt,
      enabled: true,
      dailyDrawLimitPerResident: 2,
      noPrizeWeight: 10,
    })
    assert.equal(notReady.status, 409)
    assert.equal(await errorCode(notReady), API_ERROR_CODES.drawPoolNotReady)

    const zeroWeight = await addPrize(fixture, activityId, {
      productId,
      costCents: 2_345,
      totalQuantity: 2,
      weight: 0,
      enabled: true,
    })
    assert.equal(zeroWeight.status, 201)
    const stillNotReady = await savePool(fixture, activityId, {
      expectedUpdatedAt: (await getPool(fixture, activityId)).updatedAt,
      enabled: true,
      dailyDrawLimitPerResident: 2,
      noPrizeWeight: 10,
    })
    assert.equal(stillNotReady.status, 409)
    assert.equal(await errorCode(stillNotReady), API_ERROR_CODES.drawPoolNotReady)

    const prize = activityDrawPrizeSchema.parse(await zeroWeight.json())
    const weighted = await updatePrize(fixture, activityId, prize.id, {
      expectedUpdatedAt: prize.updatedAt,
      weight: 60,
    })
    assert.equal(weighted.status, 200)

    const enabled = await savePool(fixture, activityId, {
      expectedUpdatedAt: (await getPool(fixture, activityId)).updatedAt,
      enabled: true,
      dailyDrawLimitPerResident: 2,
      noPrizeWeight: 10,
    })
    assert.equal(enabled.status, 200)
    assert.equal(activityDrawPoolSchema.parse(await enabled.json()).enabled, true)

    const publicPool = await getPublicPool(fixture, activityId)
    assert.equal(publicPool.available, true)
    assert.equal(publicPool.prizes[0]?.remainingQuantity, 2)
  } finally {
    fixture.sqlite.close()
  }
})

test('unavailable states never leak a fake prize', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture, { publish: false })
    const draft = await getPublicPool(fixture, activityId)
    assert.equal(draft.available, false)
    assert.equal(draft.unavailableReason, 'activity_not_published')
    assert.deepEqual(draft.prizes, [])

    // A pool that exists but is disabled is explicitly unavailable.
    const productId = await createProduct(fixture)
    const created = await savePool(fixture, activityId, {
      expectedUpdatedAt: null,
      enabled: false,
      dailyDrawLimitPerResident: 1,
      noPrizeWeight: 0,
    })
    assert.equal(created.status, 200)
    const added = await addPrize(fixture, activityId, {
      productId,
      costCents: 2_345,
      totalQuantity: 1,
      weight: 10,
      enabled: true,
    })
    assert.equal(added.status, 201)

    const detailResponse = await api(
      fixture.app,
      'GET',
      `/admin/activities/${activityId}`,
      { session: fixture.admin },
    )
    const detail = (await detailResponse.json()) as { updatedAt: string }
    const publish = await api(fixture.app, 'POST', `/admin/activities/${activityId}/publish`, {
      session: fixture.admin,
      body: { expectedUpdatedAt: detail.updatedAt },
    })
    assert.equal(publish.status, 200)

    const disabled = await getPublicPool(fixture, activityId)
    assert.equal(disabled.available, false)
    assert.equal(disabled.unavailableReason, 'draw_pool_disabled')
    assert.deepEqual(disabled.prizes, [])
  } finally {
    fixture.sqlite.close()
  }
})

test('community scope, role, session and CSRF are enforced on real HTTP', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const productId = await createProduct(fixture)

    const anonymous = await api(fixture.app, 'GET', path(ACTIVITY_DRAW_ROUTES.adminPool, activityId))
    assert.equal(anonymous.status, 401)

    const grid = await api(fixture.app, 'GET', path(ACTIVITY_DRAW_ROUTES.adminPool, activityId), {
      session: fixture.grid,
    })
    assert.equal(grid.status, 403)

    const operatorPool = await api(
      fixture.app,
      'GET',
      path(ACTIVITY_DRAW_ROUTES.adminPool, activityId),
      { session: fixture.operator },
    )
    assert.equal(operatorPool.status, 200, 'assigned operator may read its community pool')

    const operatorWrite = await savePool(
      fixture,
      activityId,
      {
        expectedUpdatedAt: null,
        enabled: false,
        dailyDrawLimitPerResident: 1,
        noPrizeWeight: 0,
      },
      fixture.operator,
    )
    assert.equal(operatorWrite.status, 200, 'assigned operator may configure its community pool')

    // Operator for community A cannot touch a community B activity.
    const otherActivity = await createActivity(fixture, { communityId: fixture.otherCommunityId })
    const crossRead = await api(
      fixture.app,
      'GET',
      path(ACTIVITY_DRAW_ROUTES.adminPool, otherActivity),
      { session: fixture.operator },
    )
    assert.equal(crossRead.status, 403)
    const crossWrite = await savePool(
      fixture,
      otherActivity,
      {
        expectedUpdatedAt: null,
        enabled: false,
        dailyDrawLimitPerResident: 1,
        noPrizeWeight: 0,
      },
      fixture.operator,
    )
    assert.equal(crossWrite.status, 403)

    // A product from another community cannot back this activity's prize.
    const otherProduct = await createProduct(fixture, {
      communityId: fixture.otherCommunityId,
      name: '别的社区商品',
    })
    const mismatch = await addPrize(fixture, activityId, {
      productId: otherProduct,
      costCents: 2_345,
      totalQuantity: 1,
      weight: 10,
      enabled: true,
    })
    assert.equal(mismatch.status, 400)
    assert.equal(await errorCode(mismatch), API_ERROR_CODES.invalidRequest)

    const noCsrf = await api(
      fixture.app,
      'POST',
      path(ACTIVITY_DRAW_ROUTES.adminSavePool, activityId),
      {
        session: fixture.admin,
        body: {
          expectedUpdatedAt: (await getPool(fixture, activityId)).updatedAt,
          enabled: false,
          dailyDrawLimitPerResident: 1,
          noPrizeWeight: 0,
        },
        csrf: false,
      },
    )
    assert.equal(noCsrf.status, 403)

    // Product and activity must still be a real pair; a missing product is 404.
    const missing = await addPrize(fixture, activityId, {
      productId: randomUUID(),
      costCents: 2_345,
      totalQuantity: 1,
      weight: 10,
      enabled: true,
    })
    assert.equal(missing.status, 404)
    assert.ok(productId)
  } finally {
    fixture.sqlite.close()
  }
})

test('bad parameters, duplicates and inventory bounds are rejected', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const productId = await createProduct(fixture)

    const negative = await savePool(fixture, activityId, {
      expectedUpdatedAt: null,
      enabled: false,
      dailyDrawLimitPerResident: 0,
      noPrizeWeight: -1,
    })
    assert.equal(negative.status, 400)

    const created = await savePool(fixture, activityId, {
      expectedUpdatedAt: null,
      enabled: false,
      dailyDrawLimitPerResident: 2,
      noPrizeWeight: 5,
    })
    assert.equal(created.status, 200)
    const pool = activityDrawPoolSchema.parse(await created.json())

    const missingCost = await api(
      fixture.app,
      'POST',
      path(ACTIVITY_DRAW_ROUTES.adminCreatePrize, activityId),
      { session: fixture.admin, body: { productId, totalQuantity: 1, weight: 10, enabled: true } },
    )
    assert.equal(missingCost.status, 400, 'cost must be supplied explicitly')

    const negativeCost = await addPrize(fixture, activityId, {
      productId,
      costCents: -1,
      totalQuantity: 1,
      weight: 10,
      enabled: true,
    })
    assert.equal(negativeCost.status, 400)

    const zeroStock = await addPrize(fixture, activityId, {
      productId,
      costCents: 2_345,
      totalQuantity: 0,
      weight: 10,
      enabled: true,
    })
    assert.equal(zeroStock.status, 400)

    const overflow = await addPrize(fixture, activityId, {
      productId,
      costCents: 2_345,
      totalQuantity: 100_001,
      weight: 10,
      enabled: true,
    })
    assert.equal(overflow.status, 400)

    const overflowWeight = await addPrize(fixture, activityId, {
      productId,
      costCents: 2_345,
      totalQuantity: 1,
      weight: 1_000_001,
      enabled: true,
    })
    assert.equal(overflowWeight.status, 400)

    const added = await addPrize(fixture, activityId, {
      productId,
      costCents: 2_345,
      totalQuantity: 4,
      weight: 10,
      enabled: true,
    })
    assert.equal(added.status, 201)
    const prize = activityDrawPrizeSchema.parse(await added.json())
    assert.equal(prize.costCents, 2_345)

    const duplicate = await addPrize(fixture, activityId, {
      productId,
      costCents: 2_345,
      totalQuantity: 1,
      weight: 1,
      enabled: true,
    })
    assert.equal(duplicate.status, 409)

    // Simulate #LOT-002 having drawn three prizes. Total changes must respect
    // the drawn count and must not re-inflate remaining stock.
    fixture.db
      .update(activityDrawPrizes)
      .set({ drawnQuantity: 3, remainingQuantity: 1 })
      .where(eq(activityDrawPrizes.id, prize.id))
      .run()
    const drawn = fixture.db
      .select()
      .from(activityDrawPrizes)
      .where(eq(activityDrawPrizes.id, prize.id))
      .get()
    assert.ok(drawn)

    const shrinkBelowDrawn = await updatePrize(fixture, activityId, prize.id, {
      expectedUpdatedAt: drawn.updatedAt.toISOString(),
      totalQuantity: 2,
    })
    assert.equal(shrinkBelowDrawn.status, 400)

    const grow = await updatePrize(fixture, activityId, prize.id, {
      expectedUpdatedAt: drawn.updatedAt.toISOString(),
      totalQuantity: 10,
    })
    assert.equal(grow.status, 200)
    const grown = activityDrawPrizeSchema.parse(await grow.json())
    assert.equal(grown.totalQuantity, 10)
    assert.equal(grown.drawnQuantity, 3)
    assert.equal(grown.remainingQuantity, 7, 'stock grows by the delta, not by a reset')

    const stale = await updatePrize(fixture, activityId, prize.id, {
      expectedUpdatedAt: drawn.updatedAt.toISOString(),
      weight: 99,
    })
    assert.equal(stale.status, 409)

    // The database itself refuses a negative remaining amount.
    assert.throws(
      () =>
        fixture.sqlite
          .prepare('UPDATE activity_draw_prizes SET remaining_quantity=-1 WHERE id=?')
          .run(prize.id),
      /activity_draw_prizes_quantity_check/,
    )
    assert.equal(pool.configured, true)
  } finally {
    fixture.sqlite.close()
  }
})

test('awarded prize snapshots, drawn stock, delete and audit rows are immutable', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const productId = await createProduct(fixture)
    const prize = await seedReadyPool(fixture, activityId, productId)

    fixture.db
      .update(activityDrawPrizes)
      .set({ drawnQuantity: 1, remainingQuantity: 4 })
      .where(eq(activityDrawPrizes.id, prize.id))
      .run()

    assert.throws(
      () =>
        fixture.sqlite
          .prepare("UPDATE activity_draw_prizes SET product_name='改名奖品' WHERE id=?")
          .run(prize.id),
      /activity_draw_prize_snapshot_locked/,
    )
    assert.throws(
      () =>
        fixture.sqlite
          .prepare('UPDATE activity_draw_prizes SET cost_cents=1 WHERE id=?')
          .run(prize.id),
      /activity_draw_prize_snapshot_locked/,
    )
    assert.throws(
      () =>
        fixture.sqlite
          .prepare('UPDATE activity_draw_prizes SET drawn_quantity=0 WHERE id=?')
          .run(prize.id),
      /activity_draw_prize_drawn_decreased/,
    )
    assert.throws(
      () => fixture.sqlite.prepare('DELETE FROM activity_draw_prizes WHERE id=?').run(prize.id),
      /activity_draw_prize_delete_forbidden/,
    )
    assert.throws(
      () => fixture.sqlite.prepare('DELETE FROM activity_draw_pools').run(),
      /activity_draw_pool_delete_forbidden/,
    )
    assert.throws(
      () => fixture.sqlite.prepare("UPDATE activity_draw_events SET kind='draw_pool.updated'").run(),
      /activity_draw_events_append_only/,
    )
    assert.throws(
      () => fixture.sqlite.prepare('DELETE FROM activity_draw_events').run(),
      /activity_draw_events_append_only/,
    )

    // Disabling after an award is allowed: it only stops future draws and keeps
    // the already-awarded snapshot intact.
    const current = await getPool(fixture, activityId)
    const disabled = await updatePrize(fixture, activityId, prize.id, {
      expectedUpdatedAt: current.prizes[0]?.updatedAt,
      enabled: false,
    })
    assert.equal(disabled.status, 200)
    assert.equal(activityDrawPrizeSchema.parse(await disabled.json()).enabled, false)
  } finally {
    fixture.sqlite.close()
  }
})

test('an ended activity cannot have its draw configuration changed', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const productId = await createProduct(fixture)
    const prize = await seedReadyPool(fixture, activityId, productId)

    const detailResponse = await api(
      fixture.app,
      'GET',
      `/admin/activities/${activityId}`,
      { session: fixture.admin },
    )
    const detail = (await detailResponse.json()) as { updatedAt: string }
    const ended = await api(fixture.app, 'POST', `/admin/activities/${activityId}/end`, {
      session: fixture.admin,
      body: { expectedUpdatedAt: detail.updatedAt },
    })
    assert.equal(ended.status, 200)

    const current = await getPool(fixture, activityId)
    const rejected = await savePool(fixture, activityId, {
      expectedUpdatedAt: current.updatedAt,
      enabled: false,
      dailyDrawLimitPerResident: 1,
      noPrizeWeight: 0,
    })
    assert.equal(rejected.status, 409)
    assert.equal(await errorCode(rejected), API_ERROR_CODES.activityUnavailable)

    const publicPool = await getPublicPool(fixture, activityId)
    assert.equal(publicPool.available, false)
    assert.equal(publicPool.unavailableReason, 'activity_ended')
    assert.ok(prize)
  } finally {
    fixture.sqlite.close()
  }
})

test('migration 0015 upgrades an older database in place and keeps its data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'll-0015-upgrade-'))
  try {
    const staged = join(directory, 'migrations-before-0015')
    // Copy the journal and every migration; only the journal is truncated.
    rmSync(staged, { recursive: true, force: true })
    const sourceJournal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> }
    const legacyTags = sourceJournal.entries.filter((entry) => entry.idx <= 14)
    assert.equal(legacyTags.length, 15, 'the 0000..0014 prefix must exist')
    mkdirp(staged)
    copyFileSync(
      join(migrationsFolder, 'meta', '_journal.json'),
      join(staged, 'meta', '_journal.json'),
    )
    for (const entry of legacyTags) {
      copyFileSync(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(staged, `${entry.tag}.sql`),
      )
      copyFileSync(
        join(migrationsFolder, 'meta', `${String(entry.idx).padStart(4, '0')}_snapshot.json`),
        join(staged, 'meta', `${String(entry.idx).padStart(4, '0')}_snapshot.json`),
      )
    }
    writeFileSync(
      join(staged, 'meta', '_journal.json'),
      JSON.stringify({ ...sourceJournal, entries: legacyTags }),
    )

    const databasePath = join(directory, 'upgrade.sqlite')
    const legacy = createDatabase(databasePath, staged)
    const legacyCommunityId = randomUUID()
    const legacyActivityId = randomUUID()
    const legacyUserId = randomUUID()
    try {
      legacy.sqlite
        .prepare('INSERT INTO communities (id, name, created_at) VALUES (?,?,?)')
        .run(legacyCommunityId, '旧库社区', NOW.getTime())
      legacy.sqlite
        .prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?,?,?,?)')
        .run(legacyUserId, '旧库居民', NOW.getTime(), NOW.getTime())
      legacy.sqlite
        .prepare(
          `INSERT INTO activities
             (id, community_id, title, status, starts_at, ends_at, location, budget_cap_cents,
              prize_quantity_cap, public_rules_json, created_by_user_id, created_at, updated_at)
           VALUES (?,?,?,'published',?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          legacyActivityId,
          legacyCommunityId,
          '旧抽奖活动',
          NOW.getTime(),
          NOW.getTime() + 86_400_000,
          '社区广场',
          9_876_543,
          4_321,
          JSON.stringify({
            eligibility: '本社区居民',
            checkin: '签到',
            purchase: '无',
            prizeClaim: '现场领取',
          }),
          legacyUserId,
          NOW.getTime(),
          NOW.getTime(),
        )
      const tables = legacy.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'activity_draw_%'",
        )
        .all() as Array<{ name: string }>
      assert.deepEqual(tables, [], 'the legacy database has no draw tables')
    } finally {
      legacy.sqlite.close()
    }

    const upgraded = createDatabase(databasePath, migrationsFolder)
    try {
      const row = upgraded.sqlite
        .prepare('SELECT title, budget_cap_cents FROM activities WHERE id=?')
        .get(legacyActivityId) as { title: string; budget_cap_cents: number }
      assert.equal(row.title, '旧抽奖活动')
      assert.equal(row.budget_cap_cents, 9_876_543)

      const tables = upgraded.sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN
             ('activity_draw_pools','activity_draw_prizes','activity_draw_events')
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
      assert.deepEqual(
        tables.map((table) => table.name),
        ['activity_draw_events', 'activity_draw_pools', 'activity_draw_prizes'],
      )

      // The new pool row can immediately reference the preserved activity.
      upgraded.sqlite
        .prepare(
          `INSERT INTO activity_draw_pools
             (id, activity_id, community_id, enabled, daily_draw_limit_per_resident,
              no_prize_weight, created_at, updated_at)
           VALUES (?,?,?,0,1,0,?,?)`,
        )
        .run(randomUUID(), legacyActivityId, legacyCommunityId, NOW.getTime(), NOW.getTime())
      assert.equal(
        (upgraded.sqlite.prepare('SELECT COUNT(*) AS count FROM activity_draw_pools').get() as {
          count: number
        }).count,
        1,
      )
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})



/**
 * Makes the staff account's user a resident of `communityId` by *confirming* it,
 * which is what #171 requires before a community-scoped write such as a draw.
 *
 * HISTORICAL NOTE: this helper used to insert a `resident_community_assignments`
 * row — exactly the auto-attribution #123 performed at login. That row no longer
 * authorizes anything (see `resident-community-guard.test.ts`), so the fixture now
 * performs the resident's real first confirmation through the production service
 * rather than the guard being relaxed for tests.
 */
async function confirmStaffResident(
  fixture: Fixture,
  username: string,
  communityId = fixture.communityId,
): Promise<string> {
  const staff = fixture.db.select().from(staffAccounts).where(eq(staffAccounts.username, username)).get()
  assert.ok(staff)
  seedConfirmedCommunity(fixture.db, staff.userId, communityId, new Date())
  return staff.userId
}

test('LL-LOT-002: authenticated HTTP draw is persisted, idempotent, quota-bound and redeemed once', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const productId = await createProduct(fixture, { priceCents: 12_345 })
    const prize = await seedReadyPool(fixture, activityId, productId)
    const userId = await confirmStaffResident(fixture, 'admin')
    // Force an actual award: no-prize weight is zero, never a mocked win.
    const enabled = await getPool(fixture, activityId)
    const configResponse = await savePool(fixture, activityId, {
      expectedUpdatedAt: enabled.updatedAt, enabled: true,
      dailyDrawLimitPerResident: 1, noPrizeWeight: 0,
    })
    assert.equal(configResponse.status, 200)

    const drawPath = path(ACTIVITY_DRAW_ROUTES.enter, activityId)
    const key = randomUUID()
    const drawn = await api(fixture.app, 'POST', drawPath, {
      session: fixture.admin, body: { idempotencyKey: key },
    })
    assert.equal(drawn.status, 200)
    const win = await drawn.json() as {
      id: string; outcome: string; credential: { code: string; codeSuffix: string; id: string }
    }
    assert.equal(win.outcome, 'won')
    assert.match(win.credential.code, /^DL-[0-9A-F]{24}$/)
    const same = await api(fixture.app, 'POST', drawPath, {
      session: fixture.admin, body: { idempotencyKey: key },
    })
    assert.equal(same.status, 200)
    assert.deepEqual(await same.json(), win, 'replay returns same result and code')
    const extra = await api(fixture.app, 'POST', drawPath, {
      session: fixture.admin, body: { idempotencyKey: randomUUID() },
    })
    assert.equal(extra.status, 409)
    assert.equal(await errorCode(extra), API_ERROR_CODES.drawDailyLimit)
    const spoofed = await api(fixture.app, 'POST', drawPath, {
      session: fixture.admin, body: { idempotencyKey: randomUUID(), userId },
    })
    assert.equal(spoofed.status, 400)
    const noCsrf = await api(fixture.app, 'POST', drawPath, {
      session: fixture.admin, csrf: false, body: { idempotencyKey: randomUUID() },
    })
    assert.equal(noCsrf.status, 403)
    const unauth = await api(fixture.app, 'POST', drawPath, {
      body: { idempotencyKey: randomUUID() },
    })
    assert.equal(unauth.status, 401)

    const dbCredential = fixture.db.select().from(activityDrawCredentials)
      .where(eq(activityDrawCredentials.attemptId, win.id)).get()
    assert.ok(dbCredential)
    assert.equal(dbCredential.codeSuffix, win.credential.codeSuffix)
    assert.equal(dbCredential.codeHash.length, 64)
    assert.equal(JSON.stringify(dbCredential).includes(win.credential.code), false, 'plaintext never persisted')
    const remaining = fixture.db.select().from(activityDrawPrizes)
      .where(eq(activityDrawPrizes.id, prize.id)).get()
    assert.equal(remaining?.drawnQuantity, 1)
    assert.equal(remaining?.remainingQuantity, 4)

    const history = await api(fixture.app, 'GET', path(ACTIVITY_DRAW_ROUTES.history, activityId), { session: fixture.admin })
    assert.equal(history.status, 200)
    const saved = await history.json() as { attempts: Array<{ credential: { code: string } }> }
    assert.equal(saved.attempts.length, 1)
    assert.equal(saved.attempts[0]?.credential.code, win.credential.code)

    const verifyPath = path(ACTIVITY_DRAW_ROUTES.adminVerify, activityId)
    const redeemPath = path(ACTIVITY_DRAW_ROUTES.adminRedeem, activityId)
    const verified = await api(fixture.app, 'POST', verifyPath, { session: fixture.operator, body: { code: win.credential.code } })
    assert.equal(verified.status, 200)
    const redeemed = await api(fixture.app, 'POST', redeemPath, { session: fixture.operator, body: { code: win.credential.code } })
    assert.equal(redeemed.status, 200)
    assert.equal((await redeemed.json() as { status: string }).status, 'redeemed')
    const replayRedeem = await api(fixture.app, 'POST', redeemPath, { session: fixture.operator, body: { code: win.credential.code } })
    assert.equal(replayRedeem.status, 409)
    assert.equal(await errorCode(replayRedeem), API_ERROR_CODES.drawAlreadyRedeemed)
    const after = await api(fixture.app, 'GET', path(ACTIVITY_DRAW_ROUTES.history, activityId), { session: fixture.admin })
    const postHistory = await after.json() as { attempts: Array<{ credential: { code: string | null; status: string } }> }
    assert.equal(postHistory.attempts[0]?.credential.code, null)
    assert.equal(postHistory.attempts[0]?.credential.status, 'redeemed')
    const events = fixture.db.select().from(activityDrawFulfilmentEvents).all()
    assert.deepEqual(events.map(e => e.kind).sort(), ['issued', 'redeemed'])
  } finally { fixture.sqlite.close() }
})

test('LL-LOT-002: disabled pool, missing community and cross-community staff are rejected', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const productId = await createProduct(fixture)
    await seedReadyPool(fixture, activityId, productId)
    const userId = fixture.db.select().from(staffAccounts).where(eq(staffAccounts.username, 'admin')).get()?.userId
    assert.ok(userId)
    const missingMembership = await api(fixture.app, 'POST', path(ACTIVITY_DRAW_ROUTES.enter, activityId), {
      session: fixture.admin, body: { idempotencyKey: randomUUID() },
    })
    assert.equal(missingMembership.status, 403)
    await confirmStaffResident(fixture, 'admin')
    const pool = await getPool(fixture, activityId)
    const closed = await savePool(fixture, activityId, {
      expectedUpdatedAt: pool.updatedAt, enabled: false,
      dailyDrawLimitPerResident: 1, noPrizeWeight: 0,
    })
    assert.equal(closed.status, 200)
    const disabled = await api(fixture.app, 'POST', path(ACTIVITY_DRAW_ROUTES.enter, activityId), {
      session: fixture.admin, body: { idempotencyKey: randomUUID() },
    })
    assert.equal(disabled.status, 409)
    const status = await api(fixture.app, 'GET', path(ACTIVITY_DRAW_ROUTES.state, activityId), { session: fixture.admin })
    assert.equal(status.status, 200)
    assert.equal((await status.json() as { available: boolean }).available, false)
    assert.equal(fixture.db.select().from(activityDrawAttempts).all().length, 0)
    const otherActivity = await createActivity(fixture, { communityId: fixture.otherCommunityId })
    const scope = await api(fixture.app, 'POST', path(ACTIVITY_DRAW_ROUTES.adminVerify, otherActivity), {
      session: fixture.operator, body: { code: 'DL-' + 'A'.repeat(24) },
    })
    assert.equal(scope.status, 403)
  } finally { fixture.sqlite.close() }
})

test('LL-LOT-002: cryptographic weighted miss, Shanghai day boundary, atomic last stock and revoked audit', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const productId = await createProduct(fixture)
    const prize = await seedReadyPool(fixture, activityId, productId)
    const userId = await confirmStaffResident(fixture, 'admin')
    // Choose the next Beijing midnight relative to test execution time.
    // Fixed 2026 dates would make this regression test fail in future years.
    const currentDay = drawBeijingDay(NOW)
    const boundary = new Date(currentDay + 'T16:00:00.000Z')
    const before = new Date(boundary.getTime() - 10_000)
    const after = new Date(boundary.getTime() + 5_000)
    const noWin = enterDailyDraw(fixture.db, {
      activityId, userId, idempotencyKey: randomUUID(), secret: DRAW_SECRET,
      now: before, pick: max => max - 1,
    })
    assert.equal(noWin.outcome, 'missed')
    assert.equal(noWin.credential, null)
    assert.notEqual(drawBeijingDay(before), drawBeijingDay(after))
    const nextDay = enterDailyDraw(fixture.db, {
      activityId, userId, idempotencyKey: randomUUID(), secret: DRAW_SECRET,
      now: after, pick: () => 0,
    })
    assert.equal(nextDay.outcome, 'won')
    const prizeStock = fixture.db.select().from(activityDrawPrizes).where(eq(activityDrawPrizes.id, prize.id)).get()
    assert.equal(prizeStock?.drawnQuantity, 1)
    const revoked = await api(fixture.app, 'POST', path(ACTIVITY_DRAW_ROUTES.adminRevoke, activityId), {
      session: fixture.admin, body: { credentialId: nextDay.credential?.id, reason: '奖品损坏需要人工处理' },
    })
    assert.equal(revoked.status, 200)
    const events = fixture.db.select().from(activityDrawFulfilmentEvents).all()
    assert.ok(events.some(e => e.kind === 'revoked'))
    assert.throws(() => fixture.sqlite.prepare('DELETE FROM activity_draw_attempts').run(), /immutable/)
    assert.throws(() => fixture.sqlite.prepare('DELETE FROM activity_draw_fulfilment_events').run(), /immutable/)
  } finally { fixture.sqlite.close() }
})



test('LL-LOT-002: two residents compete for the last real prize and exactly one wins', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const productId = await createProduct(fixture)
    const prize = await seedReadyPool(fixture, activityId, productId)
    await confirmStaffResident(fixture, 'admin')
    await confirmStaffResident(fixture, 'operator.a')
    const reduced = await updatePrize(fixture, activityId, prize.id, {
      expectedUpdatedAt: prize.updatedAt,
      totalQuantity: 1,
    })
    assert.equal(reduced.status, 200)
    const pool = await getPool(fixture, activityId)
    const config = await savePool(fixture, activityId, {
      expectedUpdatedAt: pool.updatedAt, enabled: true, dailyDrawLimitPerResident: 1, noPrizeWeight: 0,
    })
    assert.equal(config.status, 200)
    const url = path(ACTIVITY_DRAW_ROUTES.enter, activityId)
    const idempotency1 = randomUUID()
    const idempotency2 = randomUUID()
    const results = await Promise.all([
      api(fixture.app, 'POST', url, { session: fixture.admin, body: { idempotencyKey: idempotency1 } }),
      api(fixture.app, 'POST', url, { session: fixture.operator, body: { idempotencyKey: idempotency2 } }),
    ])
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
    const stock = fixture.db.select().from(activityDrawPrizes).where(eq(activityDrawPrizes.id, prize.id)).get()
    assert.equal(stock?.drawnQuantity, 1)
    assert.equal(stock?.remainingQuantity, 0)
    assert.equal(fixture.db.select().from(activityDrawAttempts).all().length, 1)
    assert.equal(fixture.db.select().from(activityDrawCredentials).all().length, 1)
  } finally { fixture.sqlite.close() }
})

test('LL-LOT-002: missing credential secret refuses awards without consuming stock', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const productId = await createProduct(fixture)
    const prize = await seedReadyPool(fixture, activityId, productId)
    const adminUserId = await confirmStaffResident(fixture, 'admin')
    const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
    const withoutSecret = createApp({ db: fixture.db, config, logRequests: false })
    const blocked = await api(withoutSecret, 'POST', path(ACTIVITY_DRAW_ROUTES.enter, activityId), {
      session: fixture.admin, body: { idempotencyKey: randomUUID() },
    })
    assert.equal(blocked.status, 409)
    assert.equal(await errorCode(blocked), API_ERROR_CODES.drawPoolNotConfigured)
    assert.equal(fixture.db.select().from(activityDrawPrizes).where(eq(activityDrawPrizes.id, prize.id)).get()?.drawnQuantity, 0)
    assert.equal(fixture.db.select().from(activityDrawAttempts).all().length, 0)
    assert.ok(adminUserId)
  } finally { fixture.sqlite.close() }
})


test('LL-LOT-002: outstanding winner stays accessible beyond 200 recent attempts', async () => {
  const fixture = await createFixture()
  try {
    const activityId = await createActivity(fixture)
    const productId = await createProduct(fixture)
    await seedReadyPool(fixture, activityId, productId)
    const userId = await confirmStaffResident(fixture, 'admin')
    const prize = enterDailyDraw(fixture.db, {
      activityId, userId, secret: DRAW_SECRET, idempotencyKey: randomUUID(),
      pick: () => 0,
    })
    assert.equal(prize.outcome, 'won')
    const pool = fixture.sqlite.prepare('SELECT id FROM activity_draw_pools WHERE activity_id = ?')
      .get(activityId) as { id: string }
    const insert = fixture.sqlite.prepare(
      'INSERT INTO activity_draw_attempts (id,activity_id,pool_id,user_id,day,sequence,idempotency_key,outcome,created_at) VALUES (?,?,?,?,?,?,?,\'missed\',?)',
    )
    // Seed a long historical feed directly: unlike a real draw, this avoids
    // 201 separate fake public requests while exercising the real SQLite index.
    const now = Date.now()
    for (let index = 1; index <= 201; index += 1) {
      insert.run(randomUUID(), activityId, pool.id, userId, drawBeijingDay(new Date(now)),
        index + 1, randomUUID(), now + index * 1000)
    }
    const history = await api(fixture.app, 'GET', path(ACTIVITY_DRAW_ROUTES.history, activityId), {
      session: fixture.admin,
    })
    assert.equal(history.status, 200)
    const data = await history.json() as {
      attempts: Array<{ id: string }>
      activeAwards: Array<{ id: string; credential: { code: string | null } | null }>
    }
    assert.equal(data.attempts.length, 200)
    assert.equal(data.attempts.some(a => a.id === prize.id), false)
    assert.equal(data.activeAwards.length, 1)
    assert.equal(data.activeAwards[0]?.id, prize.id)
    assert.equal(data.activeAwards[0]?.credential?.code, prize.credential?.code)
    const operatorHistory = await api(fixture.app, 'GET', path(ACTIVITY_DRAW_ROUTES.history, activityId), {
      session: fixture.operator,
    })
    assert.equal(operatorHistory.status, 200)
    assert.equal((await operatorHistory.json() as { activeAwards: unknown[] }).activeAwards.length, 0)
  } finally { fixture.sqlite.close() }
})

/** Minimal recursive mkdir without importing more fs surface than needed. */
function mkdirp(target: string): void {
  mkdirSync(target, { recursive: true })
  mkdirSync(join(target, 'meta'), { recursive: true })
}
