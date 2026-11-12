import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import {
  communities,
  sessions,
  staffAccounts,
  users,
  wechatIdentities,
} from '../src/db/schema.js'
import { hashPassword, hashToken } from '../src/auth/security.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

function getCookie(response: Response, name: string): string {
  const header = response.headers.get('set-cookie') ?? ''
  const value = header
    .split(/,(?=[^;,]+=)/)
    .map((part) => part.split(';', 1)[0]?.trim() ?? '')
    .find((part) => part.startsWith(`${name}=`))
  assert.ok(value)
  return value
}

async function createFixture() {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'false' })
  const app = createApp({ db, config, logRequests: false })
  const now = new Date()
  const adminUserId = randomUUID()
  const adminId = randomUUID()
  const adminPassword = 'a'.repeat(24)

  db.insert(users)
    .values({ id: adminUserId, displayName: '管理员', createdAt: now, updatedAt: now })
    .run()
  db.insert(staffAccounts)
    .values({
      id: adminId,
      userId: adminUserId,
      username: 'root-admin',
      passwordHash: await hashPassword(adminPassword),
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const csrfResponse = await app.request('/auth/csrf')
  const csrfBody = (await csrfResponse.json()) as { csrfToken: string }
  const csrfCookie = getCookie(csrfResponse, 'll_csrf')
  const loginResponse = await app.request('/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: csrfCookie,
      'x-csrf-token': csrfBody.csrfToken,
      origin: 'http://localhost:5174',
    },
    body: JSON.stringify({ username: 'root-admin', password: adminPassword }),
  })
  assert.equal(loginResponse.status, 200)
  const loginBody = (await loginResponse.json()) as { csrfToken: string }
  const sessionCookie = getCookie(loginResponse, 'll_session')
  const sessionCsrfCookie = getCookie(loginResponse, 'll_csrf')
  return {
    app,
    db,
    sqlite,
    csrfToken: loginBody.csrfToken,
    cookie: `${sessionCookie}; ${sessionCsrfCookie}`,
  }
}

test('expired sessions are rejected and removed before protected routes run', async () => {
  const fixture = await createFixture()
  try {
    const sessionToken = fixture.cookie
      .split('; ')
      .find((part) => part.startsWith('ll_session='))!
      .slice('ll_session='.length)
    fixture.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hashToken(sessionToken)))
      .run()

    const current = await fixture.app.request('/auth/session', {
      headers: { cookie: fixture.cookie },
    })
    assert.deepEqual(await current.json(), { authenticated: false })

    const protectedRead = await fixture.app.request('/admin/communities', {
      headers: { cookie: fixture.cookie },
    })
    assert.equal(protectedRead.status, 401)
    assert.equal(fixture.db.select().from(sessions).all().length, 0)
  } finally {
    fixture.sqlite.close()
  }
})

test('administrator can attach a staff role to a verified resident without duplicating identity', async () => {
  const fixture = await createFixture()
  try {
    const now = new Date()
    const residentId = randomUUID()
    const communityId = randomUUID()
    fixture.db
      .insert(users)
      .values({ id: residentId, displayName: '微信居民', createdAt: now, updatedAt: now })
      .run()
    fixture.db
      .insert(wechatIdentities)
      .values({
        id: randomUUID(),
        userId: residentId,
        appId: 'wx-test-app',
        openId: 'resident-openid',
        unionId: null,
        createdAt: now,
      })
      .run()
    fixture.db
      .insert(communities)
      .values({ id: communityId, name: '居民所在社区', createdAt: now })
      .run()

    const request = (username: string) =>
      fixture.app.request('/admin/staff', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: fixture.cookie,
          'x-csrf-token': fixture.csrfToken,
          origin: 'http://localhost:5174',
        },
        body: JSON.stringify({
          username,
          displayName: '居民兼网格员',
          password: 'g'.repeat(24),
          role: 'grid_worker',
          communityIds: [communityId],
          userId: residentId,
        }),
      })

    const created = await request('resident-grid')
    assert.equal(created.status, 201)
    const createdBody = (await created.json()) as { userId: string }
    assert.equal(createdBody.userId, residentId)

    const duplicate = await request('resident-grid-duplicate')
    assert.equal(duplicate.status, 409)
    assert.equal(fixture.db.select().from(users).all().length, 2)
    assert.equal(fixture.db.select().from(wechatIdentities).all().length, 1)
  } finally {
    fixture.sqlite.close()
  }
})
