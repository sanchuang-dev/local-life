import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
  LEDGER_ROUTES,
  LOCAL_ORDER_STATUS_TRANSITIONS,
  ledgerOverviewSchema,
  localOrderDetailSchema,
  localOrderEventListResponseSchema,
  localOrderListResponseSchema,
  localProductDetailSchema,
  localProductListResponseSchema,
  type LocalOrderDetail,
  type LocalProductDetail,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  auditLogs,
  communities,
  localOrderEvents,
  localOrders,
  localProducts,
  residentCommunityAssignments,
  staffAccounts,
  users,
} from '../src/db/schema.js'
import { hashPassword } from '../src/auth/security.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ADMIN_PASSWORD = 'Admin-Password-123!'
const OPERATOR_PASSWORD = 'Operator-Password-123!'
const GRID_PASSWORD = 'Grid-Worker-Password-123!'
const RESIDENT_ORIGIN = 'http://localhost:5173'
const ADMIN_ORIGIN = 'http://localhost:5174'

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
}

interface ResidentSession extends Session {
  userId: string
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers (mirrors the CRM suite so reviewers can diff them)            */
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

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function testContext() {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const app = createApp({ db, config, logRequests: false })
  return { app, db, sqlite, config }
}

async function createAdmin(db: AppDatabase) {
  const now = new Date()
  const userId = randomUUID()
  const staffId = randomUUID()
  db.insert(users)
    .values({ id: userId, displayName: '系统管理员', createdAt: now, updatedAt: now })
    .run()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId,
      username: 'admin',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { userId, staffId }
}

async function staffSession(app: App, username: string, password: string): Promise<Session> {
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

/**
 * A real resident account + session through the documented dev login. It is the
 * same legal path every other suite uses: gated on NODE_ENV/AUTH_DEV_ENABLED and
 * it can only ever create a `staff: null` resident session.
 */
async function residentSession(
  app: App,
  displayName: string,
  communityId: string,
): Promise<ResidentSession> {
  const csrfState = await csrf(app)
  const response = await app.request('/auth/dev/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: csrfState.cookie,
      'x-csrf-token': csrfState.token,
      origin: RESIDENT_ORIGIN,
    },
    body: JSON.stringify({ displayName, communityId }),
  })
  assert.equal(response.status, 200, 'resident dev login must succeed')
  const body = (await response.json()) as {
    user: { id: string }
    csrfToken: string
  }
  return {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: body.csrfToken,
    userId: body.user.id,
  }
}

async function createCommunity(app: App, admin: Session, name: string): Promise<string> {
  const response = await api(app, 'POST', '/admin/communities', { session: admin, body: { name } })
  assert.equal(response.status, 201, 'community creation must succeed')
  return ((await response.json()) as { id: string }).id
}

async function createStaffAccount(
  app: App,
  admin: Session,
  input: {
    username: string
    displayName: string
    password: string
    role: 'operator' | 'grid_worker'
    communityIds: string[]
  },
): Promise<string> {
  const response = await api(app, 'POST', '/admin/staff', { session: admin, body: input })
  assert.equal(response.status, 201, `creating staff ${input.username} must succeed`)
  return ((await response.json()) as { id: string }).id
}

async function createProduct(
  app: App,
  session: Session,
  input: {
    communityId: string
    name?: string
    priceCents?: number
    summary?: string
    description?: string
    category?: string
  },
): Promise<LocalProductDetail> {
  const response = await api(app, 'POST', '/admin/catalog/products', {
    session,
    body: {
      communityId: input.communityId,
      name: input.name ?? '本地青菜',
      priceCents: input.priceCents ?? 450,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.category === undefined ? {} : { category: input.category }),
    },
  })
  assert.equal(response.status, 201, 'product creation must succeed')
  return localProductDetailSchema.parse(await response.json())
}

async function shelfProduct(
  app: App,
  session: Session,
  product: LocalProductDetail,
  status: 'on_shelf' | 'off_shelf',
): Promise<LocalProductDetail> {
  const response = await api(app, 'POST', `/admin/catalog/products/${product.id}/shelf`, {
    session,
    body: { expectedUpdatedAt: product.updatedAt, status },
  })
  assert.equal(response.status, 200, `shelf change to ${status} must succeed`)
  return localProductDetailSchema.parse(await response.json())
}

async function createOnShelfProduct(
  app: App,
  session: Session,
  input: { communityId: string; name?: string; priceCents?: number },
): Promise<LocalProductDetail> {
  const created = await createProduct(app, session, input)
  return shelfProduct(app, session, created, 'on_shelf')
}

async function register(
  app: App,
  session: ResidentSession,
  input: {
    productId: string
    quantity?: number
    idempotencyKey?: string
    note?: string
    sourceActivityId?: string
  },
) {
  return api(app, 'POST', '/local-orders', {
    session,
    origin: RESIDENT_ORIGIN,
    body: {
      productId: input.productId,
      quantity: input.quantity ?? 1,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.sourceActivityId === undefined
        ? {}
        : { sourceActivityId: input.sourceActivityId }),
    },
  })
}

async function orderDetail(response: Response): Promise<LocalOrderDetail> {
  const text = await response.text()
  assert.ok(response.ok, `expected a successful order response, got ${response.status}: ${text}`)
  return localOrderDetailSchema.parse(JSON.parse(text))
}

/** Registration answers with the `{ created, order }` envelope; unwrap and validate it. */
async function orderFromRegister(response: Response): Promise<LocalOrderDetail> {
  const text = await response.text()
  assert.ok(
    response.status === 201 || response.status === 200,
    `expected a registration response, got ${response.status}: ${text}`,
  )
  const body = JSON.parse(text) as { created: boolean; order: unknown }
  return localOrderDetailSchema.parse(body.order)
}

async function transition(
  app: App,
  session: Session,
  order: LocalOrderDetail,
  status: 'processing' | 'pending_review' | 'cancelled' | 'rejected',
  note?: string,
  path?: string,
) {
  return api(app, 'PATCH', path ?? `/staff/local-orders/${order.id}/status`, {
    session,
    body: {
      expectedUpdatedAt: order.updatedAt,
      status,
      ...(note === undefined ? {} : { note }),
    },
  })
}

async function verify(
  app: App,
  session: Session,
  order: LocalOrderDetail,
  decision: 'verify' | 'reject',
  note = '已电话核实登记内容',
) {
  return api(app, 'POST', `/admin/local-orders/${order.id}/verify`, {
    session,
    body: { expectedUpdatedAt: order.updatedAt, decision, note },
  })
}

/** A fully wired community with one resident, one operator and one grid worker. */
async function localWorld() {
  const context = testContext()
  const { app, db } = context
  await createAdmin(db)
  const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
  const communityId = await createCommunity(app, admin, '本地生活社区')
  const operatorId = await createStaffAccount(app, admin, {
    username: 'operator',
    displayName: '运营小王',
    password: OPERATOR_PASSWORD,
    role: 'operator',
    communityIds: [communityId],
  })
  const gridId = await createStaffAccount(app, admin, {
    username: 'grid',
    displayName: '网格员小李',
    password: GRID_PASSWORD,
    role: 'grid_worker',
    communityIds: [communityId],
  })
  const operator = await staffSession(app, 'operator', OPERATOR_PASSWORD)
  const grid = await staffSession(app, 'grid', GRID_PASSWORD)
  const resident = await residentSession(app, '居民甲', communityId)
  return {
    ...context,
    admin,
    operator,
    grid,
    resident,
    communityId,
    operatorId,
    gridId,
  }
}

function withTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    /**
     * Windows can still hold a SQLite/journal handle for a moment after close, so
     * cleanup must never turn a green suite red (that is the known 8-test EPERM
     * baseline, which this card does not attempt to fix).
     */
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Deliberately ignored: leftover temp dirs are harmless, a false red is not.
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Full happy path                                                         */
/* -------------------------------------------------------------------------- */

test('catalogue -> registration -> staff handling -> operations verification end to end', async () => {
  const world = await localWorld()
  try {
    const { app, db, admin, operator, grid, resident, communityId } = world

    // --- catalogue: created off-shelf, listed on-shelf, priced in integer cents
    const created = await createProduct(app, admin, {
      communityId,
      name: '社区直供青菜',
      priceCents: 450,
      summary: '当日到货',
      description: '本地农户直供，按份登记',
      category: '蔬菜',
    })
    assert.equal(created.status, 'off_shelf', 'a new product starts off the shelf')
    assert.equal(created.priceCents, 450)

    const publicBefore = await api(app, 'GET', '/catalog/products')
    assert.equal(publicBefore.status, 200)
    assert.equal(
      localProductListResponseSchema.parse(await publicBefore.json()).total,
      0,
      'an off-shelf product is not in the public catalogue',
    )

    const onShelf = await shelfProduct(app, admin, created, 'on_shelf')
    assert.equal(onShelf.status, 'on_shelf')

    const publicAfter = localProductListResponseSchema.parse(
      await (await api(app, 'GET', `/catalog/products?communityId=${communityId}`)).json(),
    )
    assert.equal(publicAfter.total, 1)
    assert.equal(publicAfter.items[0]?.priceCents, 450)

    // --- resident registration (price/community come from the server)
    const registerResponse = await register(app, resident, { productId: onShelf.id, quantity: 3 })
    assert.equal(registerResponse.status, 201)
    const registered = await orderFromRegister(registerResponse)
    assert.equal(registered.status, 'registered')
    assert.equal(registered.recordSource, 'resident')
    assert.equal(registered.createdByStaff, null)
    assert.equal(registered.community.id, communityId, 'order community is the product community')
    assert.deepEqual(registered.snapshot, {
      productId: onShelf.id,
      productName: '社区直供青菜',
      unitPriceCents: 450,
      quantity: 3,
      totalCents: 1350,
    })
    assert.equal(registered.verification, null, 'nothing is verified yet')
    assert.equal(registered.events.length, 1)
    assert.equal(registered.events[0]?.event, 'order.registered')
    assert.equal(registered.events[0]?.sourceType, 'local_order')
    assert.equal(registered.events[0]?.sourceId, registered.id)

    // --- resident reads only their own order
    const mine = localOrderListResponseSchema.parse(
      await (await api(app, 'GET', '/local-orders', { session: resident })).json(),
    )
    assert.equal(mine.total, 1)
    assert.equal(mine.items[0]?.id, registered.id)
    const mineDetail = await api(app, 'GET', `/local-orders/${registered.id}`, {
      session: resident,
    })
    assert.equal(mineDetail.status, 200)

    // --- grid worker (assigned community) handles it
    const gridList = localOrderListResponseSchema.parse(
      await (await api(app, 'GET', '/staff/local-orders', { session: grid })).json(),
    )
    assert.equal(gridList.total, 1)

    const processingResponse = await transition(app, grid, registered, 'processing')
    assert.equal(processingResponse.status, 200)
    const processing = await orderDetail(processingResponse)
    assert.equal(processing.status, 'processing')
    assert.equal(processing.attributedStaff, null)
    assert.equal(processing.events.at(-1)?.event, 'order.status_changed')
    assert.equal(processing.events.at(-1)?.actor?.id, await sessionUserId(app, grid))

    const reviewResponse = await transition(app, operator, processing, 'pending_review')
    assert.equal(reviewResponse.status, 200)
    const pendingReview = await orderDetail(reviewResponse)
    assert.equal(pendingReview.status, 'pending_review')

    // --- operations verification is admin/operator only and records the fact
    const verifiedResponse = await verify(app, operator, pendingReview, 'verify', '现场核对已登记')
    assert.equal(verifiedResponse.status, 200)
    const verified = await orderDetail(verifiedResponse)
    assert.equal(verified.status, 'verified')
    assert.equal(verified.verification?.note, '现场核对已登记')
    assert.equal(verified.verification?.verifiedBy?.id, await sessionUserId(app, operator))
    assert.equal(verified.verification?.verifiedAt.length > 0, true)
    // The contract has no payment/activation concept at all.
    assert.equal('paid' in verified, false)
    assert.equal('activatedAt' in verified, false)

    // --- append-only timeline + stable source ids
    const eventsResponse = await api(app, 'GET', `/admin/local-orders/${verified.id}/events`, {
      session: admin,
    })
    assert.equal(eventsResponse.status, 200)
    const events = localOrderEventListResponseSchema.parse(await eventsResponse.json()).items
    assert.deepEqual(
      events.map((event) => event.event),
      ['order.registered', 'order.status_changed', 'order.status_changed', 'order.verified'],
    )
    assert.deepEqual(
      events.map((event) => event.toStatus),
      ['registered', 'processing', 'pending_review', 'verified'],
    )
    for (const event of events) {
      assert.equal(event.sourceType, 'local_order')
      assert.equal(event.sourceId, verified.id)
    }
    assert.equal(events.at(-1)?.note, '现场核对已登记')

    // --- audit rows are written with local_* prefixes only
    const auditEvents = db
      .select()
      .from(auditLogs)
      .all()
      .map((row) => row.event)
      .filter((event) => event.startsWith('local_'))
    assert.deepEqual(
      auditEvents.sort(),
      [
        'local_catalog.product.created',
        'local_catalog.product.shelf_changed',
        'local_order.registered',
        'local_order.status_changed',
        'local_order.status_changed',
        'local_order.verified',
      ].sort(),
    )
    assert.equal(
      auditEvents.some((event) => event.startsWith('crm.') || event.startsWith('crmeb.')),
      false,
    )
  } finally {
    world.sqlite.close()
  }
})

/** Resolves the `users.id` behind a session through the real session endpoint. */
async function sessionUserId(app: App, session: Session): Promise<string> {
  const response = await api(app, 'GET', '/auth/session', { session })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { user: { id: string } }
  return body.user.id
}

/* -------------------------------------------------------------------------- */
/* 2. Idempotency                                                             */
/* -------------------------------------------------------------------------- */

test('the same idempotency key only ever produces one order', async () => {
  const world = await localWorld()
  try {
    const { app, db, admin, resident, communityId } = world
    const product = await createOnShelfProduct(app, admin, { communityId })
    const idempotencyKey = randomUUID()

    const first = await register(app, resident, { productId: product.id, idempotencyKey })
    assert.equal(first.status, 201)
    const firstOrder = await orderFromRegister(first)

    const second = await register(app, resident, { productId: product.id, idempotencyKey })
    assert.equal(second.status, 200, 'a replay is not a new creation')
    const secondBody = (await second.json()) as { created: boolean; order: LocalOrderDetail }
    assert.equal(secondBody.created, false)
    assert.equal(secondBody.order.id, firstOrder.id)

    assert.equal(db.select().from(localOrders).all().length, 1)

    // The same key pointed at different content is a conflict, never an overwrite.
    const conflicting = await register(app, resident, {
      productId: product.id,
      quantity: 2,
      idempotencyKey,
    })
    assert.equal(conflicting.status, 409)
    assert.equal(await errorCode(conflicting), API_ERROR_CODES.orderIdempotencyConflict)
    assert.equal(db.select().from(localOrders).all().length, 1)
  } finally {
    world.sqlite.close()
  }
})

test('two processes racing on one idempotency key produce exactly one order', async () => {
  const temp = withTempDir('ll-local-race-')
  const databasePath = join(temp.dir, 'race.sqlite')
  const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
  const children: ReturnType<typeof spawn>[] = []
  try {
    const adminUserId = randomUUID()
    const adminStaffId = randomUUID()
    const now = new Date()
    const communityId = randomUUID()
    const residentUserId = randomUUID()
    const productId = randomUUID()
    db.insert(communities).values({ id: communityId, name: '并发社区', createdAt: now }).run()
    db.insert(users)
      .values({ id: adminUserId, displayName: '管理员', createdAt: now, updatedAt: now })
      .run()
    db.insert(staffAccounts)
      .values({
        id: adminStaffId,
        userId: adminUserId,
        username: 'race-admin',
        passwordHash: 'x',
        role: 'admin',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(users)
      .values({ id: residentUserId, displayName: '并发居民', createdAt: now, updatedAt: now })
      .run()
    db.insert(residentCommunityAssignments)
      .values({ userId: residentUserId, communityId, createdAt: now })
      .run()
    db.insert(localProducts)
      .values({
        id: productId,
        communityId,
        name: '并发商品',
        summary: null,
        description: null,
        category: null,
        unitPriceCents: 100,
        imageUrl: null,
        status: 'on_shelf',
        createdByUserId: adminUserId,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const idempotencyKey = randomUUID()
    const scriptPath = join(temp.dir, 'register-child.mjs')
    writeFileSync(
      scriptPath,
      `
import { createInterface } from 'node:readline'
import { createDatabase } from ${JSON.stringify(new URL('../src/db/client.ts', import.meta.url).href)}
import { registerResidentOrder } from ${JSON.stringify(new URL('../src/local/orders.ts', import.meta.url).href)}

const [databasePath, migrationsFolder, productId, userId, idempotencyKey] = process.argv.slice(2)
const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
const rl = createInterface({ input: process.stdin })
rl.once('line', () => {
  process.stdout.write('attempting\\n')
  const startedAt = Date.now()
  let payload
  try {
    const result = registerResidentOrder(
      db,
      { userId, staffId: null, role: null },
      { productId, quantity: 1, idempotencyKey },
    )
    payload = { ok: true, created: result.created, orderId: result.order.id, callMs: Date.now() - startedAt }
  } catch (error) {
    payload = { ok: false, code: error?.code ?? null, message: String(error?.message ?? error) }
  }
  process.stdout.write(JSON.stringify(payload) + '\\n', () => {
    try { sqlite.close() } catch {}
    rl.close()
    process.exit(0)
  })
})
process.stdout.write('ready\\n')
`,
    )

    const spawnChild = () => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', scriptPath, databasePath, migrationsFolder, productId, residentUserId, idempotencyKey],
        { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] },
      )
      let stdout = ''
      let stderr = ''
      let markReady: () => void = () => {}
      let markAttempting: () => void = () => {}
      const ready = new Promise<void>((resolve) => {
        markReady = resolve
      })
      const attempting = new Promise<void>((resolve) => {
        markAttempting = resolve
      })
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (chunk: string) => {
        stdout += chunk
        if (stdout.includes('ready')) markReady()
        if (stdout.includes('attempting')) markAttempting()
      })
      child.stderr!.setEncoding('utf8')
      child.stderr!.on('data', (chunk: string) => {
        stderr += chunk
      })
      const result = new Promise<{ ok: boolean; created?: boolean; orderId?: string; code?: string }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new Error(`race child timed out\nstdout: ${stdout}\nstderr: ${stderr}`))
          }, 30_000)
          child.on('close', (code) => {
            clearTimeout(timer)
            const payload = stdout
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.startsWith('{'))
              .at(-1)
            if (code !== 0 || payload === undefined) {
              reject(new Error(`race child exited with ${code}\nstdout: ${stdout}\nstderr: ${stderr}`))
              return
            }
            resolve(JSON.parse(payload))
          })
        },
      )
      void result.catch(() => {})
      return { child, ready, attempting, go: () => child.stdin!.write('go\n'), result }
    }

    const one = spawnChild()
    const two = spawnChild()
    children.push(one.child, two.child)
    await Promise.all([one.ready, two.ready])

    // Hold SQLite's write lock so both children block at their INSERT: the
    // loser then meets the UNIQUE index instead of merely losing a timing race.
    sqlite.prepare('BEGIN IMMEDIATE').run()
    one.go()
    two.go()
    await Promise.all([one.attempting, two.attempting])
    await new Promise((resolve) => setTimeout(resolve, 600))
    sqlite.prepare('COMMIT').run()

    const [resultOne, resultTwo] = await Promise.all([one.result, two.result])
    const rows = db.select().from(localOrders).all()
    assert.equal(
      rows.length,
      1,
      `exactly one order survives the race (children: ${JSON.stringify([resultOne, resultTwo])})`,
    )
    assert.equal(rows[0]?.idempotencyKey, idempotencyKey)

    const created = [resultOne, resultTwo].filter((result) => result.created === true)
    assert.equal(created.length, 1, 'exactly one submission reports a creation')
    // The other one is a clean replay of the same order, not an error.
    const replay = [resultOne, resultTwo].find((result) => result.created === false)
    assert.equal(replay?.orderId, rows[0]?.id)
  } finally {
    for (const child of children) {
      if (!child.killed) child.kill('SIGKILL')
    }
    sqlite.close()
    temp.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* 3. Session / CSRF / Origin / roles                                         */
/* -------------------------------------------------------------------------- */

test('every local route rejects an anonymous caller and writes need CSRF + trusted Origin', async () => {
  const world = await localWorld()
  try {
    const { app, admin, resident, communityId } = world
    const product = await createOnShelfProduct(app, admin, { communityId })
    const sampleOrderId = randomUUID()

    // The resident H5 catalogue is intentionally public (recon §4.1: 居民 H5 无需登录即可读上架目录).
    for (const path of ['/catalog/products', `/catalog/products/${product.id}`]) {
      const response = await api(app, 'GET', path)
      assert.equal(response.status, 200, `GET ${path} stays readable without a session`)
    }

    const anonymousPaths: Array<[string, string]> = [
      ['GET', '/local-orders'],
      ['GET', `/local-orders/${sampleOrderId}`],
      ['GET', '/staff/local-orders'],
      ['GET', `/staff/local-orders/${sampleOrderId}`],
      ['GET', '/admin/catalog/products'],
      ['GET', `/admin/catalog/products/${product.id}`],
      ['GET', '/admin/local-orders'],
      ['GET', `/admin/local-orders/${sampleOrderId}`],
      ['GET', `/admin/local-orders/${sampleOrderId}/events`],
    ]
    for (const [method, path] of anonymousPaths) {
      const response = await api(app, method, path)
      assert.equal(response.status, 401, `${method} ${path} must require a session`)
      assert.equal(await errorCode(response), 'unauthorized')
    }

    // Write without a CSRF token (cookie/header pair missing).
    const noCsrf = await api(app, 'POST', '/local-orders', {
      session: resident,
      csrf: false,
      body: { productId: product.id, quantity: 1, idempotencyKey: randomUUID() },
    })
    assert.equal(noCsrf.status, 403)
    assert.equal(await errorCode(noCsrf), 'forbidden')

    // Write from an untrusted Origin.
    const badOrigin = await api(app, 'POST', '/local-orders', {
      session: resident,
      origin: 'https://evil.example',
      body: { productId: product.id, quantity: 1, idempotencyKey: randomUUID() },
    })
    assert.equal(badOrigin.status, 403)

    // Admin writes are equally guarded.
    const adminNoCsrf = await api(app, 'POST', '/admin/catalog/products', {
      session: admin,
      csrf: false,
      body: { communityId, name: '无 CSRF 商品', priceCents: 100 },
    })
    assert.equal(adminNoCsrf.status, 403)
  } finally {
    world.sqlite.close()
  }
})

test('role boundaries: grid workers cannot manage the catalogue or verify orders', async () => {
  const world = await localWorld()
  try {
    const { app, admin, grid, operator, resident, communityId } = world
    const product = await createOnShelfProduct(app, admin, { communityId })

    // grid_worker: no catalogue administration
    const gridCreate = await api(app, 'POST', '/admin/catalog/products', {
      session: grid,
      body: { communityId, name: '网格员建的商品', priceCents: 100 },
    })
    assert.equal(gridCreate.status, 403)
    assert.equal(await errorCode(gridCreate), 'forbidden')

    const gridList = await api(app, 'GET', '/admin/catalog/products', { session: grid })
    assert.equal(gridList.status, 403)

    // operator is allowed to manage the catalogue
    const operatorProduct = await createProduct(app, operator, {
      communityId,
      name: '运营建的商品',
      priceCents: 200,
    })
    assert.equal(operatorProduct.status, 'off_shelf')

    // grid_worker can handle an order but must never verify it
    const registered = await orderFromRegister(await register(app, resident, { productId: product.id }),
    )
    const processing = await orderDetail(
      await transition(app, grid, registered, 'processing'),
    )
    const pending = await orderDetail(await transition(app, grid, processing, 'pending_review'))

    const gridVerify = await verify(app, grid, pending, 'verify')
    assert.equal(gridVerify.status, 403, 'grid workers may not verify')

    const residentVerify = await api(app, 'POST', `/admin/local-orders/${pending.id}/verify`, {
      session: resident,
      body: { expectedUpdatedAt: pending.updatedAt, decision: 'verify', note: '居民自证' },
    })
    assert.equal(residentVerify.status, 401, 'a resident session is not a staff session')
  } finally {
    world.sqlite.close()
  }
})

test('cross-community isolation: scoped staff cannot read or touch another community', async () => {
  const world = await localWorld()
  try {
    const { app, admin, grid, operator } = world
    const otherCommunityId = await createCommunity(app, admin, '隔壁社区')
    await createStaffAccount(app, admin, {
      username: 'other_operator',
      displayName: '隔壁运营',
      password: OPERATOR_PASSWORD,
      role: 'operator',
      communityIds: [otherCommunityId],
    })

    const otherProduct = await createOnShelfProduct(app, admin, {
      communityId: otherCommunityId,
      name: '隔壁商品',
    })
    const otherResident = await residentSession(app, '隔壁居民', otherCommunityId)
    const otherOrder = await orderFromRegister(await register(app, otherResident, { productId: otherProduct.id }),
    )

    // Reading someone else's order: 403 for staff of another community.
    const gridRead = await api(app, 'GET', `/staff/local-orders/${otherOrder.id}`, {
      session: grid,
    })
    assert.equal(gridRead.status, 403)
    assert.equal(await errorCode(gridRead), 'forbidden')

    const operatorRead = await api(app, 'GET', `/admin/local-orders/${otherOrder.id}`, {
      session: operator,
    })
    assert.equal(operatorRead.status, 403)

    // Lists are scoped, not just filtered after the fact.
    const gridList = localOrderListResponseSchema.parse(
      await (await api(app, 'GET', '/staff/local-orders', { session: grid })).json(),
    )
    assert.equal(gridList.total, 0)
    const adminList = localOrderListResponseSchema.parse(
      await (await api(app, 'GET', '/admin/local-orders', { session: admin })).json(),
    )
    assert.equal(adminList.total, 1, 'admin sees across communities')

    // Status changes are equally scoped.
    const gridTransition = await transition(app, grid, otherOrder, 'processing')
    assert.equal(gridTransition.status, 403)

    // A resident cannot read another resident's order, and gets 404 not 403.
    const residentRead = await api(app, 'GET', `/local-orders/${otherOrder.id}`, {
      session: world.resident,
    })
    assert.equal(residentRead.status, 404)

    // A resident cannot register a product of a community they do not belong to.
    const foreignRegister = await register(app, world.resident, { productId: otherProduct.id })
    assert.equal(foreignRegister.status, 403)

    // On-behalf recording is confined to the actor's assigned community too.
    const onBehalf = await api(app, 'POST', '/staff/local-orders', {
      session: grid,
      body: {
        residentUserId: otherResident.userId,
        productId: otherProduct.id,
        quantity: 1,
        idempotencyKey: randomUUID(),
      },
    })
    assert.equal(onBehalf.status, 403)
  } finally {
    world.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 4. Server-side truth: shelf, price, quantity                              */
/* -------------------------------------------------------------------------- */

test('an off-shelf product refuses new registrations but keeps existing orders intact', async () => {
  const world = await localWorld()
  try {
    const { app, admin, resident, communityId } = world
    const product = await createOnShelfProduct(app, admin, {
      communityId,
      name: '限时团购米',
      priceCents: 2999,
    })
    const order = await orderFromRegister(await register(app, resident, { productId: product.id, quantity: 2 }),
    )

    const offShelf = await shelfProduct(app, admin, product, 'off_shelf')
    assert.equal(offShelf.status, 'off_shelf')

    const rejected = await register(app, resident, {
      productId: product.id,
      quantity: 1,
      idempotencyKey: randomUUID(),
    })
    assert.equal(rejected.status, 409)
    assert.equal(await errorCode(rejected), API_ERROR_CODES.productOffShelf)

    // The public detail hides the product, the existing order keeps its snapshot.
    const publicDetail = await api(app, 'GET', `/catalog/products/${product.id}`)
    assert.equal(publicDetail.status, 404)
    const stored = await orderDetail(
      await api(app, 'GET', `/local-orders/${order.id}`, { session: resident }),
    )
    assert.equal(stored.snapshot.productName, '限时团购米')
    assert.equal(stored.snapshot.totalCents, 5998)

    // Re-shelving brings it back (the same endpoint, both directions).
    const back = await shelfProduct(app, admin, offShelf, 'on_shelf')
    assert.equal(back.status, 'on_shelf')
  } finally {
    world.sqlite.close()
  }
})

test('a client cannot inject price, total, community or resident', async () => {
  const world = await localWorld()
  try {
    const { app, admin, resident, communityId } = world
    const product = await createOnShelfProduct(app, admin, {
      communityId,
      name: '防篡改商品',
      priceCents: 500,
    })
    const otherCommunityId = await createCommunity(app, admin, '别处社区')

    // Strict body: any extra field fails parsing instead of being dropped.
    for (const injected of [
      { priceCents: 1 },
      { unitPriceCents: 1 },
      { totalCents: 1 },
      { communityId: otherCommunityId },
      { residentUserId: randomUUID() },
      { status: 'verified' },
      { recordSource: 'staff_on_behalf' },
    ]) {
      const response = await api(app, 'POST', '/local-orders', {
        session: resident,
        body: {
          productId: product.id,
          quantity: 1,
          idempotencyKey: randomUUID(),
          ...injected,
        },
      })
      assert.equal(response.status, 400, `injected ${Object.keys(injected)[0]} must be rejected`)
      assert.equal(await errorCode(response), 'invalid_request')
    }

    // A legitimate registration always uses the server price.
    const order = await orderFromRegister(await register(app, resident, { productId: product.id }))
    assert.equal(order.snapshot.unitPriceCents, 500)
    assert.equal(order.snapshot.totalCents, 500)

    // A later price edit must not rewrite history.
    const edited = await api(app, 'PATCH', `/admin/catalog/products/${product.id}`, {
      session: admin,
      body: { expectedUpdatedAt: product.updatedAt, priceCents: 900, name: '涨价后的商品' },
    })
    assert.equal(edited.status, 200)
    const afterEdit = localProductDetailSchema.parse(await edited.json())
    assert.equal(afterEdit.priceCents, 900)

    const stored = (await (
      await api(app, 'GET', `/local-orders/${order.id}`, { session: resident })
    ).json()) as LocalOrderDetail
    const reparsed = localOrderDetailSchema.parse(stored)
    assert.equal(reparsed.snapshot.unitPriceCents, 500, 'the snapshot keeps the old price')
    assert.equal(reparsed.snapshot.productName, '防篡改商品', 'and the old name')

    // A new order for the same product uses the new price.
    const second = await orderFromRegister(await register(app, resident, { productId: product.id }))
    assert.equal(second.snapshot.unitPriceCents, 900)
  } finally {
    world.sqlite.close()
  }
})

test('invalid quantities and unsupported transitions are rejected', async () => {
  const world = await localWorld()
  try {
    const { app, admin, resident, grid, communityId } = world
    const product = await createOnShelfProduct(app, admin, { communityId })

    for (const quantity of [0, -1, 100, 1.5]) {
      const response = await api(app, 'POST', '/local-orders', {
        session: resident,
        body: { productId: product.id, quantity, idempotencyKey: randomUUID() },
      })
      assert.equal(response.status, 400, `quantity ${quantity} must be rejected`)
    }

    const order = await orderFromRegister(await register(app, resident, { productId: product.id }))

    // registered -> pending_review skips a step and must be refused.
    const skip = await transition(app, grid, order, 'pending_review')
    assert.equal(skip.status, 409)
    assert.equal(await errorCode(skip), 'conflict')

    // Rejecting requires a reason.
    const noReason = await transition(app, grid, order, 'rejected')
    assert.equal(noReason.status, 400)

    // A stale optimistic token is a 409, not a silent overwrite.
    const stale = await api(app, 'PATCH', `/staff/local-orders/${order.id}/status`, {
      session: grid,
      body: {
        expectedUpdatedAt: new Date(Date.parse(order.updatedAt) - 1000).toISOString(),
        status: 'processing',
      },
    })
    assert.equal(stale.status, 409)
  } finally {
    world.sqlite.close()
  }
})

test('a resident may cancel, and a cancelled order is final', async () => {
  const world = await localWorld()
  try {
    const { app, admin, grid, resident, communityId } = world
    const product = await createOnShelfProduct(app, admin, { communityId })
    const order = await orderFromRegister(await register(app, resident, { productId: product.id }))

    // Residents may not drive the staff state machine themselves.
    const selfCancel = await api(app, 'PATCH', `/staff/local-orders/${order.id}/status`, {
      session: resident,
      body: { expectedUpdatedAt: order.updatedAt, status: 'cancelled' },
    })
    assert.equal(selfCancel.status, 401)

    const cancelled = await orderDetail(
      await transition(app, grid, order, 'cancelled', '居民来电取消'),
    )
    assert.equal(cancelled.status, 'cancelled')
    assert.deepEqual(LOCAL_ORDER_STATUS_TRANSITIONS.cancelled, [])

    const afterCancel = await transition(app, grid, cancelled, 'processing')
    assert.equal(afterCancel.status, 409)

    const events = localOrderEventListResponseSchema.parse(
      await (
        await api(app, 'GET', `/admin/local-orders/${cancelled.id}/events`, { session: admin })
      ).json(),
    ).items
    assert.equal(events.at(-1)?.toStatus, 'cancelled')
    assert.equal(events.at(-1)?.note, '居民来电取消')
  } finally {
    world.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 5. Verification semantics                                                  */
/* -------------------------------------------------------------------------- */

test('verification is explicit, idempotent-by-rejection, and never implies payment', async () => {
  const world = await localWorld()
  try {
    const { app, admin, operator, grid, resident, communityId } = world
    const product = await createOnShelfProduct(app, admin, { communityId })
    const registered = await orderFromRegister(await register(app, resident, { productId: product.id }),
    )

    // Only pending_review orders may be verified.
    const tooEarly = await verify(app, operator, registered, 'verify')
    assert.equal(tooEarly.status, 409)

    const processing = await orderDetail(await transition(app, grid, registered, 'processing'))
    const pending = await orderDetail(await transition(app, grid, processing, 'pending_review'))

    const verified = await orderDetail(
      await verify(app, operator, pending, 'verify', '已与居民电话确认'),
    )
    assert.equal(verified.status, 'verified')

    // A second verification is an explicit 409 with a dedicated code.
    const again = await verify(app, operator, verified, 'verify')
    assert.equal(again.status, 409)
    assert.equal(await errorCode(again), API_ERROR_CODES.orderAlreadyVerified)

    // A verified order may not be moved back by the status endpoint either.
    const reopen = await transition(app, grid, verified, 'processing')
    assert.equal(reopen.status, 409)
    assert.equal(await errorCode(reopen), API_ERROR_CODES.orderAlreadyVerified)

    // Its verification block is a manual fact record with a note, nothing else.
    assert.equal(verified.verification?.note, '已与居民电话确认')
    assert.equal(JSON.stringify(verified).includes('paid'), false)
    assert.equal(JSON.stringify(verified).includes('payment'), false)
  } finally {
    world.sqlite.close()
  }
})

test('rejecting a pending order records the reason in the append-only timeline', async () => {
  const world = await localWorld()
  try {
    const { app, admin, operator, grid, resident, communityId } = world
    const product = await createOnShelfProduct(app, admin, { communityId })
    const registered = await orderFromRegister(await register(app, resident, { productId: product.id }),
    )
    const processing = await orderDetail(await transition(app, grid, registered, 'processing'))
    const pending = await orderDetail(await transition(app, grid, processing, 'pending_review'))

    const rejected = await orderDetail(
      await verify(app, operator, pending, 'reject', '商品当日缺货，请居民改日再登记'),
    )
    assert.equal(rejected.status, 'rejected')
    assert.equal(rejected.verification, null)
    assert.equal(rejected.statusNote, '商品当日缺货，请居民改日再登记')
    assert.equal(rejected.events.at(-1)?.event, 'order.rejected')
  } finally {
    world.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 6. Staff on-behalf recording                                              */
/* -------------------------------------------------------------------------- */

test('staff can record on behalf of an existing resident and the trail names both parties', async () => {
  const world = await localWorld()
  try {
    const { app, admin, grid, resident, communityId, gridId } = world
    const product = await createOnShelfProduct(app, admin, {
      communityId,
      name: '代录商品',
      priceCents: 780,
    })

    const response = await api(app, 'POST', '/staff/local-orders', {
      session: grid,
      body: {
        residentUserId: resident.userId,
        productId: product.id,
        quantity: 2,
        note: '居民电话委托',
        idempotencyKey: randomUUID(),
      },
    })
    assert.equal(response.status, 201)
    const created = (await response.json()) as { created: boolean; order: LocalOrderDetail }
    assert.equal(created.created, true)
    const order = localOrderDetailSchema.parse(created.order)

    assert.equal(order.recordSource, 'staff_on_behalf')
    assert.equal(order.resident.id, resident.userId)
    assert.equal(order.createdByStaff?.id, gridId)
    assert.equal(order.attributedStaff?.id, gridId)
    assert.equal(order.note, '居民电话委托')
    assert.equal(order.snapshot.totalCents, 1560)
    assert.equal(order.events[0]?.event, 'order.created_on_behalf')
    assert.equal(order.events[0]?.actorStaff?.id, gridId)

    const audit = world.db
      .select()
      .from(auditLogs)
      .all()
      .find((row) => row.event === 'local_order.created_on_behalf')
    assert.ok(audit, 'the on-behalf recording is audited')
    const metadata = JSON.parse(audit.metadata ?? '{}') as Record<string, string>
    assert.equal(metadata.recordSource, 'staff_on_behalf')
    assert.equal(metadata.residentUserId, resident.userId)

    // The resident can see the order a staff member recorded for them.
    const mine = localOrderListResponseSchema.parse(
      await (await api(app, 'GET', '/local-orders', { session: resident })).json(),
    )
    assert.equal(mine.total, 1)

    // A resident session cannot use the staff on-behalf endpoint.
    const asResident = await api(app, 'POST', '/staff/local-orders', {
      session: resident,
      body: {
        residentUserId: resident.userId,
        productId: product.id,
        quantity: 1,
        idempotencyKey: randomUUID(),
      },
    })
    assert.equal(asResident.status, 401)

    // A non-existent target account is a 404, never a ghost order.
    const ghost = await api(app, 'POST', '/staff/local-orders', {
      session: grid,
      body: {
        residentUserId: randomUUID(),
        productId: product.id,
        quantity: 1,
        idempotencyKey: randomUUID(),
      },
    })
    assert.equal(ghost.status, 404)
  } finally {
    world.sqlite.close()
  }
})

/* -------------------------------------------------------------------------- */
/* 7. Schema / migration facts                                                */
/* -------------------------------------------------------------------------- */

test('0009 creates the three local tables with foreign keys, unique key and triggers', async () => {
  const { sqlite } = createDatabase(':memory:', migrationsFolder)
  try {
    const tableNames = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const table of ['local_products', 'local_orders', 'local_order_events']) {
      assert.ok(tableNames.includes(table), `${table} must exist`)
    }
    // The carrier / CRMEB tables must stay untouched by this migration.
    assert.equal(
      tableNames.filter((name) => name.startsWith('crm_')).length,
      5,
      'the CRM (广电) tables are unchanged',
    )

    const indexNames = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => (row as { name: string }).name)
    for (const indexName of [
      'local_orders_idempotency_uq',
      'local_orders_community_status_idx',
      'local_orders_resident_created_idx',
      'local_orders_product_idx',
      'local_orders_created_by_staff_idx',
      'local_products_community_status_idx',
      'local_products_community_updated_idx',
      'local_order_events_order_created_idx',
      'local_order_events_source_idx',
    ]) {
      assert.ok(indexNames.includes(indexName), `${indexName} must exist`)
    }

    const triggerNames = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((row) => (row as { name: string }).name)
    assert.ok(triggerNames.includes('local_order_events_no_update'))
    assert.ok(triggerNames.includes('local_order_events_no_delete'))

    const orderForeignKeys = sqlite
      .prepare("PRAGMA foreign_key_list('local_orders')")
      .all() as Array<{ table: string; on_delete: string }>
    const byTable = new Map(orderForeignKeys.map((fk) => [fk.table, fk.on_delete]))
    assert.equal(byTable.get('communities'), 'RESTRICT')
    assert.equal(byTable.get('local_products'), 'RESTRICT', 'deleting a product must not delete orders')
    assert.equal(byTable.get('users'), 'RESTRICT')
    assert.equal(byTable.get('staff_accounts'), 'SET NULL')
    assert.equal(byTable.get('activities'), 'RESTRICT')

    const productForeignKeys = sqlite
      .prepare("PRAGMA foreign_key_list('local_products')")
      .all() as Array<{ table: string; on_delete: string }>
    assert.equal(productForeignKeys.find((fk) => fk.table === 'communities')?.on_delete, 'RESTRICT')

    const eventForeignKeys = sqlite
      .prepare("PRAGMA foreign_key_list('local_order_events')")
      .all() as Array<{ table: string; on_delete: string }>
    assert.equal(eventForeignKeys.find((fk) => fk.table === 'local_orders')?.on_delete, 'RESTRICT')

    // The append-only guarantee is on disk, not in the service layer.
    sqlite
      .prepare(
        `INSERT INTO communities (id, name, created_at) VALUES ('c1', '社区', 0)`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('u1', '居民', 0, 0)`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO local_products (id, community_id, name, unit_price_cents, status, created_at, updated_at)
         VALUES ('p1', 'c1', '商品', 100, 'on_shelf', 0, 0)`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO local_orders (id, community_id, product_id, resident_user_id, idempotency_key,
           status, record_source, product_name, unit_price_cents, quantity, total_cents, created_at, updated_at)
         VALUES ('o1', 'c1', 'p1', 'u1', 'k1', 'registered', 'resident', '商品', 100, 1, 100, 0, 0)`,
      )
      .run()

    // The CHECK constraint keeps the arithmetic honest even for raw SQL.
    assert.throws(
      () =>
        sqlite
          .prepare(
            `INSERT INTO local_orders (id, community_id, product_id, resident_user_id, idempotency_key,
               status, record_source, product_name, unit_price_cents, quantity, total_cents, created_at, updated_at)
             VALUES ('o2', 'c1', 'p1', 'u1', 'k2', 'registered', 'resident', '商品', 100, 2, 100, 0, 0)`,
          )
          .run(),
      /CHECK constraint failed/u,
    )

    // ... and so does the idempotency unique index.
    assert.throws(
      () =>
        sqlite
          .prepare(
            `INSERT INTO local_orders (id, community_id, product_id, resident_user_id, idempotency_key,
               status, record_source, product_name, unit_price_cents, quantity, total_cents, created_at, updated_at)
             VALUES ('o3', 'c1', 'p1', 'u1', 'k1', 'registered', 'resident', '商品', 100, 1, 100, 0, 0)`,
          )
          .run(),
      /UNIQUE constraint failed/u,
    )

    sqlite
      .prepare(
        `INSERT INTO local_order_events (id, order_id, event, source_type, source_id, created_at)
         VALUES ('e1', 'o1', 'order.registered', 'local_order', 'o1', 0)`,
      )
      .run()
    assert.throws(
      () => sqlite.prepare(`UPDATE local_order_events SET note = 'x' WHERE id = 'e1'`).run(),
      /immutable/u,
    )
    assert.throws(
      () => sqlite.prepare(`DELETE FROM local_order_events WHERE id = 'e1'`).run(),
      /immutable/u,
    )
  } finally {
    sqlite.close()
  }
})

test('a pre-0010 database upgrades in place, keeps its rows and becomes usable', async () => {
  const temp = withTempDir('ll-local-upgrade-')
  try {
    const stagingFolder = join(temp.dir, 'migrations-before-0010')
    mkdirSync(join(stagingFolder, 'meta'), { recursive: true })
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: Array<{ tag: string }> }
    assert.equal(journal.entries.length, 11, 'journal must describe exactly 0000..0010')

    // Stage everything before 0010: the local tables exist, the ledger does not.
    for (const entry of journal.entries.slice(0, 10)) {
      copyFileSync(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(stagingFolder, `${entry.tag}.sql`),
      )
    }
    writeFileSync(
      join(stagingFolder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 10) }),
    )

    const databasePath = join(temp.dir, 'upgrade.sqlite')
    const legacy = createDatabase(databasePath, stagingFolder)
    const legacyCommunityId = randomUUID()
    const legacyUserId = randomUUID()
    const now = new Date()
    try {
      const legacyTables = legacy.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name)
      assert.equal(
        legacyTables.filter((name) => name.startsWith('local_')).length,
        3,
        'the pre-0010 database already has the three local tables',
      )
      assert.equal(
        legacyTables.filter((name) => name.startsWith('ledger_')).length,
        0,
        'the pre-0010 database has no ledger tables',
      )
      assert.ok(
        !legacyTables.includes('reconciliation_batches'),
        'the pre-0010 database has no reconciliation batch table',
      )
      legacy.db
        .insert(communities)
        .values({ id: legacyCommunityId, name: '升级前社区', createdAt: now })
        .run()
      legacy.db
        .insert(users)
        .values({ id: legacyUserId, displayName: '升级前居民', createdAt: now, updatedAt: now })
        .run()
    } finally {
      legacy.sqlite.close()
    }

    const upgraded = createDatabase(databasePath, migrationsFolder)
    try {
      // The pre-existing rows survive the upgrade.
      const preserved = upgraded.db
        .select()
        .from(communities)
        .where(eq(communities.id, legacyCommunityId))
        .get()
      assert.equal(preserved?.name, '升级前社区')

      const upgradedTables = upgraded.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name)
      assert.equal(
        upgradedTables.filter((name) => name.startsWith('local_')).length,
        3,
        'the local tables are untouched by 0010',
      )
      for (const table of [
        'ledger_entries',
        'ledger_entry_sources',
        'ledger_anomalies',
        'reconciliation_batches',
      ]) {
        assert.ok(upgradedTables.includes(table), `${table} must be created by 0010`)
      }

      // And the upgraded database is immediately usable through real HTTP.
      await createAdmin(upgraded.db)
      const app = createApp({
        db: upgraded.db,
        config: loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' }),
        logRequests: false,
      })
      const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
      const upgradeOperatorId = await createStaffAccount(app, admin, {
        username: 'upgrade-operator',
        displayName: '升级运营',
        password: OPERATOR_PASSWORD,
        role: 'operator',
        communityIds: [legacyCommunityId],
      })
      assert.ok(upgradeOperatorId)
      const operator = await staffSession(app, 'upgrade-operator', OPERATOR_PASSWORD)
      const resident = await residentSession(app, '升级居民', legacyCommunityId)
      const product = await createOnShelfProduct(app, operator, {
        communityId: legacyCommunityId,
        name: '升级后商品',
        priceCents: 1200,
      })
      const order = await orderFromRegister(await register(app, resident, { productId: product.id, quantity: 2 }),
      )
      assert.equal(order.status, 'registered')
      assert.equal(order.snapshot.totalCents, 2400)

      // The freshly created ledger surface answers with a real (empty) report.
      const overview = await api(app, 'GET', LEDGER_ROUTES.adminOverview, { session: operator })
      assert.equal(overview.status, 200)
      const report = ledgerOverviewSchema.parse(await overview.json())
      assert.equal(report.totals.entryCount, 0)
      assert.equal(report.amountStatus, 'pending_rule')
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    temp.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* 8. File database restart                                                  */
/* -------------------------------------------------------------------------- */

test('orders, snapshots and events survive a real database restart', async () => {
  const temp = withTempDir('ll-local-persist-')
  const databasePath = join(temp.dir, 'local.sqlite')
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const first = createDatabase(databasePath, migrationsFolder)
  let orderId = ''
  let resident: ResidentSession
  let admin: Session
  try {
    await createAdmin(first.db)
    let app = createApp({ db: first.db, config, logRequests: false })
    admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '持久化社区')
    const gridId = await createStaffAccount(app, admin, {
      username: 'persist-grid',
      displayName: '持久化网格员',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityId],
    })
    const grid = await staffSession(app, 'persist-grid', GRID_PASSWORD)
    resident = await residentSession(app, '持久化居民', communityId)
    const product = await createOnShelfProduct(app, admin, {
      communityId,
      name: '持久化商品',
      priceCents: 330,
    })
    const order = await orderFromRegister(await register(app, resident, { productId: product.id, quantity: 3 }),
    )
    orderId = order.id
    const processing = await orderDetail(await transition(app, grid, order, 'processing'))
    assert.equal(processing.status, 'processing')
    assert.equal(processing.events.length, 2)
    void gridId
  } finally {
    // Close the way a process restart would.
    first.sqlite.close()
  }

  const second = createDatabase(databasePath, migrationsFolder)
  try {
    const app = createApp({ db: second.db, config, logRequests: false })
    // Same cookie: sessions are persisted, so nothing needs re-authenticating.
    const detail = await api(app, 'GET', `/local-orders/${orderId}`, { session: resident })
    assert.equal(detail.status, 200)
    const restored = localOrderDetailSchema.parse(await detail.json())
    assert.equal(restored.snapshot.productName, '持久化商品')
    assert.equal(restored.snapshot.unitPriceCents, 330)
    assert.equal(restored.snapshot.totalCents, 990)
    assert.equal(restored.status, 'processing')
    assert.deepEqual(
      restored.events.map((event) => event.event),
      ['order.registered', 'order.status_changed'],
    )

    // The catalogue survived too, and the product is still on the shelf.
    const products = localProductListResponseSchema.parse(
      await (await api(app, 'GET', '/catalog/products')).json(),
    )
    assert.equal(products.total, 1)

    // And it stays usable: the persisted order can still be pushed forward.
    const processed = await transition(
      app,
      await staffSession(app, 'persist-grid', GRID_PASSWORD),
      restored,
      'pending_review',
    )
    assert.equal(processed.status, 200)

    const auditCount = second.db.select().from(auditLogs).all().length
    assert.ok(auditCount >= 5, 'local audit rows persisted')
    const eventRowsCount = second.db.select().from(localOrderEvents).all().length
    assert.equal(eventRowsCount, 3)
  } finally {
    second.sqlite.close()
    void admin
    temp.cleanup()
  }
})

/* -------------------------------------------------------------------------- */
/* 9. Public catalogue contract                                              */
/* -------------------------------------------------------------------------- */

test('the public catalogue only exposes on-shelf products and never leaks admin fields', async () => {
  const world = await localWorld()
  try {
    const { app, admin, communityId } = world
    const onShelf = await createOnShelfProduct(app, admin, {
      communityId,
      name: '已上架商品',
      priceCents: 199,
    })
    await createProduct(app, admin, { communityId, name: '未上架商品', priceCents: 299 })

    const listResponse = await api(app, 'GET', '/catalog/products')
    assert.equal(listResponse.status, 200)
    const list = localProductListResponseSchema.parse(await listResponse.json())
    assert.equal(list.total, 1)
    assert.equal(list.items[0]?.name, '已上架商品')

    const detailResponse = await api(app, 'GET', `/catalog/products/${onShelf.id}`)
    assert.equal(detailResponse.status, 200)
    const detail = localProductDetailSchema.parse(await detailResponse.json())
    assert.equal(detail.priceCents, 199)
    assert.equal('createdByUserId' in detail, false, 'internal columns stay internal')

    // Unknown / malformed ids answer the same 404 (no enumeration signal).
    for (const productId of [randomUUID(), 'not-a-uuid']) {
      const response = await api(app, 'GET', `/catalog/products/${productId}`)
      assert.equal(response.status, 404)
    }

    // Keyword search is escaped, not injected.
    const search = localProductListResponseSchema.parse(
      await (await api(app, 'GET', '/catalog/products?keyword=%25')).json(),
    )
    assert.equal(search.total, 0)
  } finally {
    world.sqlite.close()
  }
})
