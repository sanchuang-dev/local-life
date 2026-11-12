import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import {
  EXTERNAL_OFFER_ROUTES, externalOfferListSchema, externalOfferSchema,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/security.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  auditLogs, externalOffers, ledgerEntries, localOrders,
  activityRewardGrants, staffAccounts, users,
} from '../src/db/schema.js'

const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url))
const origin = 'http://localhost:5174'
const password = 'Test-Password-123!'
const frozen = new Date('2026-11-10T12:00:00.000Z')
const valid = {
  title: '真实外部优惠测试', platform: '美团', category: '外卖',
  description: '第三方页面为准', url: 'https://www.meituan.com/promo?ref=abc',
  sortOrder: 2, enabled: false, expiresAt: null,
}

type App = ReturnType<typeof createApp>
type Session = { cookies: string; csrfToken: string }

function cookie(response: Response, name: string): string {
  const parts = (response.headers.get('set-cookie') ?? '').split(/,(?=[^;,]+=)/)
  const match = parts.map((part) => part.split(';')[0]?.trim())
    .find((part) => part?.startsWith(name + '='))
  assert.ok(match, 'required cookie ' + name)
  return match
}

async function addStaff(db: AppDatabase, role: 'admin' | 'operator' | 'grid_worker', username: string) {
  const now = new Date()
  const userId = randomUUID()
  db.insert(users).values({ id: userId, displayName: username, createdAt: now, updatedAt: now }).run()
  db.insert(staffAccounts).values({
    id: randomUUID(), userId, username, role, status: 'active',
    passwordHash: await hashPassword(password), createdAt: now, updatedAt: now,
  }).run()
}

async function login(app: App, username: string): Promise<Session> {
  const pre = await app.request('/auth/csrf')
  assert.equal(pre.status, 200)
  const csrfToken = ((await pre.json()) as { csrfToken: string }).csrfToken
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie(pre, 'll_csrf'),
      'x-csrf-token': csrfToken, origin },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(res.status, 200)
  return {
    cookies: cookie(res, 'll_session') + '; ' + cookie(res, 'll_csrf'),
    csrfToken: ((await res.json()) as { csrfToken: string }).csrfToken,
  }
}

function request(app: App, method: string, path: string, data?: unknown, session?: Session,
  withCsrf = true, from = origin) {
  return app.request(path, {
    method,
    headers: {
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session ? { cookie: session.cookies } : {}),
      ...(session && withCsrf ? { 'x-csrf-token': session.csrfToken } : {}),
      origin: from,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
}

test('external offers: real auth/CSRF, publication, expiry, audit and no transaction facts', async () => {
  const { db, sqlite } = createDatabase(':memory:', migrations)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const app = createApp({ db, config, logRequests: false, now: () => frozen })
  try {
    await addStaff(db, 'admin', 'admin')
    await addStaff(db, 'operator', 'operator')
    await addStaff(db, 'grid_worker', 'grid')
    const admin = await login(app, 'admin')
    const operator = await login(app, 'operator')
    const grid = await login(app, 'grid')

    const empty = await request(app, 'GET', EXTERNAL_OFFER_ROUTES.publicList)
    assert.equal(empty.status, 200)
    assert.deepEqual(externalOfferListSchema.parse(await empty.json()).items, [])
    assert.equal((await request(app, 'POST', EXTERNAL_OFFER_ROUTES.adminList, valid)).status, 401)
    assert.equal((await request(app, 'GET', EXTERNAL_OFFER_ROUTES.adminList, undefined, grid)).status, 403)
    assert.equal((await request(app, 'POST', EXTERNAL_OFFER_ROUTES.adminList, valid, grid)).status, 403)
    assert.equal((await request(app, 'POST', EXTERNAL_OFFER_ROUTES.adminList, valid, admin, false)).status, 403)
    assert.equal((await request(app, 'POST', EXTERNAL_OFFER_ROUTES.adminList, valid, admin, true, 'https://attacker.example')).status, 403)

    for (const url of ['http://example.com', 'tbopen://shop', 'javascript:alert(1)',
      '/pages/index', '//evil.com', 'https://127.0.0.1/admin',
      'https://example.com@evil.com/', 'https://example.com:444/path',
      'https://example.com\\@evil.com']) {
      const res = await request(app, 'POST', EXTERNAL_OFFER_ROUTES.adminList, { ...valid, url }, admin)
      assert.equal(res.status, 400, 'dangerous URL must be rejected: ' + url)
    }
    assert.equal(db.select().from(externalOffers).all().length, 0)

    const created = await request(app, 'POST', EXTERNAL_OFFER_ROUTES.adminList, valid, admin)
    assert.equal(created.status, 201)
    const entry = externalOfferSchema.parse(await created.json())
    assert.equal(entry.enabled, false)
    assert.equal(entry.kind, 'external_promotion')
    assert.equal(externalOfferListSchema.parse(await (
      await request(app, 'GET', EXTERNAL_OFFER_ROUTES.publicList)
    ).json()).items.length, 0)
    assert.equal(externalOfferListSchema.parse(await (
      await request(app, 'GET', EXTERNAL_OFFER_ROUTES.adminList, undefined, operator)
    ).json()).items.length, 1)

    const detail = EXTERNAL_OFFER_ROUTES.adminDetail.replace(':offerId', entry.id)
    const enabled = await request(app, 'PATCH', detail,
      { ...valid, enabled: true, expectedUpdatedAt: entry.updatedAt }, operator)
    assert.equal(enabled.status, 200)
    const revision = externalOfferSchema.parse(await enabled.json())
    assert.equal(revision.enabled, true)
    assert.equal(externalOfferListSchema.parse(await (
      await request(app, 'GET', EXTERNAL_OFFER_ROUTES.publicList)
    ).json()).items.length, 1)

    assert.equal((await request(app, 'PATCH', detail, {
      ...valid, enabled: false, expectedUpdatedAt: entry.updatedAt,
    }, admin)).status, 409)
    const expired = await request(app, 'PATCH', detail, {
      ...valid, enabled: true, expiresAt: '2026-11-09T00:00:00.000Z',
      expectedUpdatedAt: revision.updatedAt,
    }, admin)
    assert.equal(expired.status, 200)
    const lastRevision = externalOfferSchema.parse(await expired.json())
    assert.deepEqual(externalOfferListSchema.parse(await (
      await request(app, 'GET', EXTERNAL_OFFER_ROUTES.publicList)
    ).json()).items, [])

    assert.equal((await request(app, 'PATCH', detail, {
      ...valid, enabled: true, expectedUpdatedAt: lastRevision.updatedAt,
    }, grid)).status, 403)
    assert.equal((await request(app, 'PATCH', detail, {
      ...valid, enabled: true, expectedUpdatedAt: lastRevision.updatedAt,
    }, admin, false)).status, 403)
    assert.equal(db.select().from(auditLogs).where(eq(auditLogs.targetId, entry.id)).all().length, 3)
    assert.equal(db.select().from(localOrders).all().length, 0)
    assert.equal(db.select().from(activityRewardGrants).all().length, 0)
    assert.equal(db.select().from(ledgerEntries).all().length, 0)
  } finally {
    sqlite.close()
  }
})

test('external offers bulk import: atomic validation, CSRF, draft-only and idempotency', async () => {
  const { db, sqlite } = createDatabase(':memory:', migrations)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const app = createApp({ db, config, logRequests: false, now: () => frozen })
  try {
    await addStaff(db, 'admin', 'importadmin')
    await addStaff(db, 'operator', 'importoperator')
    await addStaff(db, 'grid_worker', 'importgrid')
    const admin = await login(app, 'importadmin')
    const operator = await login(app, 'importoperator')
    const grid = await login(app, 'importgrid')
    const path = EXTERNAL_OFFER_ROUTES.importBatch
    const first = { title: '外卖红包', platform: '美团', category: '外卖',
      description: null, url: 'https://example.com/coupon-a', sortOrder: 10, expiresAt: null }
    const second = { ...first, title: '即时零售', url: 'https://example.com/coupon-b', sortOrder: 20 }
    const items = { items: [first, second] }
    assert.equal((await request(app, 'POST', path, items)).status, 401)
    assert.equal((await request(app, 'POST', path, items, grid)).status, 403)
    assert.equal((await request(app, 'POST', path, items, admin, false)).status, 403)
    assert.equal((await request(app, 'POST', path, items, admin, true, 'https://evil.example')).status, 403)
    assert.equal((await request(app, 'POST', path,
      { items: [first, { ...second, url: 'http://unsafe.example' }] }, admin)).status, 400)
    assert.equal((await request(app, 'POST', path,
      { items: [{ ...first, enabled: true }] }, admin)).status, 400)
    assert.equal((await request(app, 'POST', path, { items: [] }, admin)).status, 400)
    assert.equal(db.select().from(externalOffers).all().length, 0)

    const created = await request(app, 'POST', path, items, operator)
    assert.equal(created.status, 201)
    assert.deepEqual(await created.json(), { imported: 2, skipped: 0 })
    const stored = db.select().from(externalOffers).all()
    assert.equal(stored.length, 2)
    assert.ok(stored.every((row) => row.enabled === false))
    assert.deepEqual(externalOfferListSchema.parse(await (
      await request(app, 'GET', EXTERNAL_OFFER_ROUTES.publicList)
    ).json()).items, [])

    const repeated = await request(app, 'POST', path, items, admin)
    assert.equal(repeated.status, 201)
    assert.deepEqual(await repeated.json(), { imported: 0, skipped: 2 })
    const withinBatch = await request(app, 'POST', path, {
      items: [second, { ...second, title: '同链接另一个标题' }],
    }, admin)
    assert.equal(withinBatch.status, 201)
    assert.deepEqual(await withinBatch.json(), { imported: 0, skipped: 2 })
    assert.equal(db.select().from(externalOffers).all().length, 2)
    assert.equal(db.select().from(localOrders).all().length, 0)
    assert.equal(db.select().from(activityRewardGrants).all().length, 0)
    assert.equal(db.select().from(ledgerEntries).all().length, 0)
    assert.ok(db.select().from(auditLogs).all().some((row) => row.event === 'external_offer.imported'))
  } finally {
    sqlite.close()
  }
})

test('0014 migration persists external offers over SQLite restart without seeding any promotions', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-offer-'))
  const path = join(root, 'offers.sqlite')
  try {
    const first = createDatabase(path, migrations)
    assert.equal(first.db.select().from(externalOffers).all().length, 0)
    first.db.insert(externalOffers).values({
      id: randomUUID(), title: '测试下架', platform: '淘宝', category: '闪购',
      description: null, url: 'https://www.taobao.com/', sortOrder: 0,
      enabled: false, expiresAt: null,
      createdAt: frozen, updatedAt: frozen,
    }).run()
    first.sqlite.close()
    const second = createDatabase(path, migrations)
    assert.equal(second.db.select().from(externalOffers).all().length, 1)
    second.sqlite.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an already-populated 0012 database upgrades through 0014 with its users intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-offer-upgrade-'))
  const prior = join(root, 'prior')
  const dbPath = join(root, 'before.sqlite')
  try {
    mkdirSync(join(prior, 'meta'), { recursive: true })
    const originalJournal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[]
    }
    const oldJournal = { ...originalJournal, entries: originalJournal.entries.filter((row) => row.idx <= 12) }
    writeFileSync(join(prior, 'meta', '_journal.json'), JSON.stringify(oldJournal))
    for (const entry of oldJournal.entries) {
      copyFileSync(join(migrations, entry.tag + '.sql'), join(prior, entry.tag + '.sql'))
    }
    const before = createDatabase(dbPath, prior)
    const userId = randomUUID()
    before.db.insert(users).values({
      id: userId, displayName: '升级前居民', createdAt: frozen, updatedAt: frozen,
    }).run()
    before.sqlite.close()
    const after = createDatabase(dbPath, migrations)
    assert.equal(after.db.select().from(users).where(eq(users.id, userId)).get()?.displayName, '升级前居民')
    assert.deepEqual(after.db.select().from(externalOffers).all(), [])
    after.sqlite.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
