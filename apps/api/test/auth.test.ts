import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import {
  activities,
  communities,
  residentCommunityAssignments,
  staffAccounts,
  users,
  wechatIdentities,
} from '../src/db/schema.js'
import { hashPassword } from '../src/auth/security.js'
import { masterKeyEnv, seedWechatConfig, TEST_APP_ID } from './wechat-fixtures.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

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

async function csrf(app: ReturnType<typeof createApp>) {
  const response = await app.request('/auth/csrf')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { csrfToken: string }
  return { token: body.csrfToken, cookie: cookiePair(response, 'll_csrf') }
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

async function login(app: ReturnType<typeof createApp>, username: string, password: string) {
  const csrfState = await csrf(app)
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: postHeaders(csrfState.cookie, csrfState.token),
    body: JSON.stringify({ username, password }),
  })
  return { response, csrfToken: response.ok ? ((await response.clone().json()) as { csrfToken: string }).csrfToken : null }
}

function testContext(
  overrides: NodeJS.ProcessEnv = {},
  fetcher?: typeof fetch,
  options: { seedWechat?: boolean } = {},
) {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
    ...(options.seedWechat ? masterKeyEnv() : {}),
    ...overrides,
  })
  // The resident OAuth provider is now a database row, so the test seeds an
  // encrypted active version with the same master key the app loaded.
  if (options.seedWechat) seedWechatConfig(db, { appId: TEST_APP_ID })
  const app = createApp({ db, config, logRequests: false, fetcher })
  return { app, db, sqlite }
}

/** A published activity in `communityId`; #123 derives the community from it. */
function seedActivity(
  db: ReturnType<typeof createDatabase>['db'],
  communityId: string,
): { activityId: string; ownerId: string } {
  const now = new Date()
  const ownerId = randomUUID()
  db.insert(users)
    .values({ id: ownerId, displayName: '活动创建者', createdAt: now, updatedAt: now })
    .run()
  const activityId = randomUUID()
  db.insert(activities)
    .values({
      id: activityId,
      communityId,
      title: '微信授权活动',
      summary: null,
      description: null,
      status: 'published',
      startsAt: new Date(now.getTime() - 60 * 60 * 1000),
      endsAt: new Date(now.getTime() + 60 * 60 * 1000),
      location: '社区服务中心',
      budgetCapCents: 100_000,
      prizeQuantityCap: 100,
      publicRulesJson: JSON.stringify({
        eligibility: '本社区 60 岁以上居民',
        checkin: '到社区服务中心签到并领取参与卡',
        purchase: '现场购买指定套餐一份',
        prizeClaim: '凭核销码领取，每人限一次',
      }),
      currentRuleVersionId: null,
      createdByUserId: ownerId,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
      pausedAt: null,
      endedAt: null,
    })
    .run()
  return { activityId, ownerId }
}

async function createAdmin(db: ReturnType<typeof createDatabase>['db']) {
  const now = new Date()
  const userId = randomUUID()
  const staffId = randomUUID()
  const passwordHash = await hashPassword('Admin-Password-123!')
  db.insert(users)
    .values({ id: userId, displayName: '系统管理员', createdAt: now, updatedAt: now })
    .run()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId,
      username: 'admin',
      passwordHash,
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { userId, staffId }
}

test('staff login, account creation and community scope are enforced by the API', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)

    const adminLogin = await login(app, 'admin', 'Admin-Password-123!')
    assert.equal(adminLogin.response.status, 200)
    const adminBody = (await adminLogin.response.json()) as {
      authenticated: boolean
      staff: { role: string }
      csrfToken: string
    }
    assert.equal(adminBody.authenticated, true)
    assert.equal(adminBody.staff.role, 'admin')

    const adminCookies = cookieHeader(
      cookiePair(adminLogin.response, 'll_session'),
      cookiePair(adminLogin.response, 'll_csrf'),
    )
    const communityAResponse = await app.request('/admin/communities', {
      method: 'POST',
      headers: postHeaders(adminCookies, adminBody.csrfToken),
      body: JSON.stringify({ name: '幸福社区' }),
    })
    assert.equal(communityAResponse.status, 201)
    const communityA = (await communityAResponse.json()) as { id: string }

    const communityBResponse = await app.request('/admin/communities', {
      method: 'POST',
      headers: postHeaders(adminCookies, adminBody.csrfToken),
      body: JSON.stringify({ name: '阳光社区' }),
    })
    assert.equal(communityBResponse.status, 201)
    const communityB = (await communityBResponse.json()) as { id: string }

    const staffResponse = await app.request('/admin/staff', {
      method: 'POST',
      headers: postHeaders(adminCookies, adminBody.csrfToken),
      body: JSON.stringify({
        username: 'grid.001',
        displayName: '幸福社区网格员',
        password: 'Grid-Worker-Password-123!',
        role: 'grid_worker',
        communityIds: [communityA.id],
      }),
    })
    assert.equal(staffResponse.status, 201)
    const createdStaff = (await staffResponse.json()) as { id: string; passwordHash?: string }
    assert.ok(createdStaff.id)
    assert.equal('passwordHash' in createdStaff, false)

    const gridLogin = await login(app, 'grid.001', 'Grid-Worker-Password-123!')
    assert.equal(gridLogin.response.status, 200)
    const gridBody = (await gridLogin.response.json()) as {
      staff: { role: string; communities: Array<{ id: string }> }
      csrfToken: string
    }
    assert.equal(gridBody.staff.role, 'grid_worker')
    assert.deepEqual(gridBody.staff.communities.map((item) => item.id), [communityA.id])

    const gridCookies = cookieHeader(
      cookiePair(gridLogin.response, 'll_session'),
      cookiePair(gridLogin.response, 'll_csrf'),
    )
    const assignedRead = await app.request(`/crm/residents?communityId=${communityA.id}`, {
      headers: { cookie: gridCookies },
    })
    assert.equal(assignedRead.status, 200)

    const forbiddenRead = await app.request(`/crm/residents?communityId=${communityB.id}`, {
      headers: { cookie: gridCookies },
    })
    assert.equal(forbiddenRead.status, 403)

    const forbiddenAdminList = await app.request('/admin/staff', {
      headers: { cookie: gridCookies },
    })
    assert.equal(forbiddenAdminList.status, 403)

    const noCsrf = await app.request('/admin/communities', {
      method: 'POST',
      headers: { cookie: adminCookies, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '绕过 CSRF' }),
    })
    assert.equal(noCsrf.status, 403)

    const logout = await app.request('/auth/logout', {
      method: 'POST',
      headers: postHeaders(gridCookies, gridBody.csrfToken),
    })
    assert.equal(logout.status, 204)
    const afterLogout = await app.request('/auth/session', {
      headers: { cookie: gridCookies },
    })
    assert.deepEqual(await afterLogout.json(), { authenticated: false })
  } finally {
    sqlite.close()
  }
})

test('resident development login is isolated and never enabled in production', async () => {
  const dev = testContext()
  try {
    const csrfState = await csrf(dev.app)
    const response = await dev.app.request('/auth/dev/login', {
      method: 'POST',
      headers: postHeaders(csrfState.cookie, csrfState.token),
      body: JSON.stringify({ displayName: '测试居民' }),
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { authenticated: boolean; staff: unknown }
    assert.equal(body.authenticated, true)
    assert.equal(body.staff, null)
  } finally {
    dev.sqlite.close()
  }

  const production = testContext({ NODE_ENV: 'production', AUTH_DEV_ENABLED: 'false', WEB_BASE_URL: 'https://local-life.example.test', TRUSTED_ORIGINS: 'https://local-life.example.test' })
  try {
    const csrfState = await csrf(production.app)
    const response = await production.app.request('/auth/dev/login', {
      method: 'POST',
      headers: postHeaders(csrfState.cookie, csrfState.token),
      body: JSON.stringify({ displayName: '不应创建' }),
    })
    assert.equal(response.status, 404)
  } finally {
    production.sqlite.close()
  }
})

test('WeChat OAuth binds one stable resident identity, validates state/nonce and rejects replay', async () => {
  let providerCalls = 0
  const fetcher: typeof fetch = async () => {
    providerCalls += 1
    return new Response(JSON.stringify({ openid: 'wechat-openid-1', unionid: 'wechat-union-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const context = testContext(
    {
      WEB_BASE_URL: 'https://local-life.example.test',
      TRUSTED_ORIGINS: 'https://local-life.example.test',
    },
    fetcher,
    { seedWechat: true },
  )

  try {
    const communityId = randomUUID()
    context.db
      .insert(communities)
      .values({ id: communityId, name: '微信授权社区', createdAt: new Date() })
      .run()
    // #123: the H5 names the activity, never the community.
    const { activityId } = seedActivity(context.db, communityId)

    const start = await context.app.request(`/auth/wechat/start?activityId=${activityId}`)
    assert.equal(start.status, 302)
    const authorizeUrl = new URL(start.headers.get('location')!)
    const state = authorizeUrl.searchParams.get('state')
    assert.ok(state)
    assert.equal(authorizeUrl.searchParams.get('scope'), 'snsapi_base')
    // The AppID and callback URL come from the seeded database row and the
    // derived callback rule, never from an env snapshot.
    assert.equal(authorizeUrl.searchParams.get('appid'), TEST_APP_ID)
    assert.equal(
      authorizeUrl.searchParams.get('redirect_uri'),
      'https://local-life.example.test/api/auth/wechat/callback',
    )
    const nonceCookie = cookiePair(start, 'll_oauth_nonce')
    // The browser visits /api/auth/wechat/callback (proxy strips /api only on
    // the server). A cookie scoped to /auth/wechat would be silently omitted.
    const nonceSetCookie = start.headers.get('set-cookie') ?? ''
    assert.match(nonceSetCookie, /ll_oauth_nonce=[^;]+;/i)
    assert.match(nonceSetCookie, /;\s*Path=\/;/i)
    assert.match(nonceSetCookie, /HttpOnly/i)
    assert.match(nonceSetCookie, /SameSite=Lax/i)

    const wrongNonce = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      { headers: { cookie: 'll_oauth_nonce=wrong-nonce' } },
    )
    assert.equal(new URL(wrongNonce.headers.get('location')!).pathname, '/me')
    assert.equal(new URL(wrongNonce.headers.get('location')!).search, '?auth_error=wechat_state_invalid')
    assert.equal(providerCalls, 0)

    const callback = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      { headers: { cookie: nonceCookie } },
    )
    assert.equal(callback.status, 302)
    assert.equal(new URL(callback.headers.get('location')!).pathname, '/me')
    assert.equal(new URL(callback.headers.get('location')!).search, '?auth=success')
    assert.match(callback.headers.get('set-cookie') ?? '', /ll_oauth_nonce=;/i)
    assert.equal(providerCalls, 1)

    const sessionCookies = cookieHeader(
      cookiePair(callback, 'll_session'),
      cookiePair(callback, 'll_csrf'),
    )
    const session = await context.app.request('/auth/session', {
      headers: { cookie: sessionCookies },
    })
    const sessionBody = (await session.json()) as {
      authenticated: boolean
      user: { id: string; displayName: string }
      staff: unknown
    }
    assert.equal(sessionBody.authenticated, true)
    assert.equal(sessionBody.user.displayName, '微信用户')
    assert.equal(sessionBody.staff, null)

    const replay = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      { headers: { cookie: nonceCookie } },
    )
    assert.equal(new URL(replay.headers.get('location')!).pathname, '/me')
    assert.equal(new URL(replay.headers.get('location')!).search, '?auth_error=wechat_state_invalid')
    assert.equal(providerCalls, 1)

    const secondStart = await context.app.request(`/auth/wechat/start?activityId=${activityId}`)
    const secondState = new URL(secondStart.headers.get('location')!).searchParams.get('state')!
    const secondCallback = await context.app.request(
      `/auth/wechat/callback?state=${secondState}&code=oauth-code-2`,
      { headers: { cookie: cookiePair(secondStart, 'll_oauth_nonce') } },
    )
    assert.equal(secondCallback.status, 302)
    // Re-login reuses the identity: one WeChat identity, one resident, one
    // residence — the seeded activity owner is a staff fixture, not a resident.
    assert.equal(context.db.select().from(wechatIdentities).all().length, 1)
    assert.equal(
      context.db
        .select()
        .from(residentCommunityAssignments)
        .where(eq(residentCommunityAssignments.communityId, communityId))
        .all().length,
      1,
    )
  } finally {
    context.sqlite.close()
  }
})
