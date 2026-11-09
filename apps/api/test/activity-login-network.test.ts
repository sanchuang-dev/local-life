import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import type { ActivityStatus } from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/security.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activities,
  activityInvitations,
  activityParticipations,
  activityRewardGrants,
  activityTeams,
  communities,
  localOrders,
  residentCommunityAssignments,
  staffAccounts,
  users,
  wechatIdentities,
} from '../src/db/schema.js'
import { masterKeyEnv, seedWechatConfig, TEST_APP_ID } from './wechat-fixtures.js'

/**
 * Real-socket acceptance for #123.
 *
 * `app.request` exercises the real router but skips the wire. This file drives the
 * production Hono app over an actual TCP listener with a browser-style cookie jar,
 * so the `Set-Cookie` attributes that carry the OAuth attempt are proven to survive
 * real HTTP — that is the part a resident's WeChat browser depends on.
 *
 * The remote WeChat token endpoint is the only fake. Real WeChat authorization is
 * NOT exercised: no production AppID/secret is available to this repository, so
 * the resident never actually authorizes. Everything downstream of the code
 * exchange is production code.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const WEB_ORIGIN = 'https://local.proto.3cgroup.cn'
const ADMIN_ORIGIN = 'https://local-admin.proto.3cgroup.cn'
const ADMIN_PASSWORD = 'Test-Only-Admin-Strong-Password!'
const INVITE_CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const PUBLIC_RULES_JSON = JSON.stringify({
  eligibility: '本社区 60 岁以上居民',
  checkin: '到社区服务中心签到并领取参与卡',
  purchase: '现场购买指定套餐一份',
  prizeClaim: '凭核销码领取，每人限一次',
})

interface CookieJar {
  store: Map<string, string>
  apply(response: Response): void
  header(): string
}

/** Minimal browser cookie jar: honours the paths the API actually sets. */
function cookieJar(): CookieJar {
  const store = new Map<string, string>()
  return {
    store,
    apply(response) {
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';').map((part) => part.trim())
        const separator = pair?.indexOf('=') ?? -1
        if (!pair || separator < 0) continue
        const name = pair.slice(0, separator)
        const value = pair.slice(separator + 1)
        // An expired/cleared cookie must be removed, exactly like a browser.
        const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute))
        const path = attributes.find((attribute) => /^path=/i.test(attribute))?.slice(5) ?? '/'
        if (path !== '/') continue
        if (expired || value === '') store.delete(name)
        else store.set(name, value)
      }
    },
    header() {
      return [...store].map(([name, value]) => `${name}=${value}`).join('; ')
    },
  }
}

function seedCommunity(db: AppDatabase, name: string): string {
  const id = randomUUID()
  db.insert(communities).values({ id, name, createdAt: new Date() }).run()
  return id
}

function seedActivity(
  db: AppDatabase,
  communityId: string,
  creatorId: string,
  status: ActivityStatus = 'published',
): string {
  const now = new Date()
  const id = randomUUID()
  db.insert(activities)
    .values({
      id,
      communityId,
      title: '银发社区欢乐季',
      summary: '秋季社区敬老活动',
      description: '面向本社区 60 岁以上居民的线下活动',
      status,
      startsAt: new Date(now.getTime() - 60 * 60 * 1000),
      endsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      location: '幸福社区党群服务中心',
      budgetCapCents: 100_000,
      prizeQuantityCap: 100,
      publicRulesJson: PUBLIC_RULES_JSON,
      currentRuleVersionId: null,
      createdByUserId: creatorId,
      createdAt: now,
      updatedAt: now,
      publishedAt: status === 'draft' ? null : now,
      pausedAt: status === 'paused' ? now : null,
      endedAt: status === 'ended' ? now : null,
    })
    .run()
  return id
}

test('a real-socket activity login writes exactly one community residence and nothing else', async () => {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const tokenCalls: string[] = []
  const wechatBoundary = (async (input: string | URL) => {
    const url = input instanceof URL ? input : new URL(String(input))
    if (url.pathname === '/sns/oauth2/access_token') {
      tokenCalls.push(url.searchParams.get('appid') ?? '')
      return Response.json({ openid: 'network-resident-openid', unionid: 'network-unionid' })
    }
    throw new Error(`unexpected external request to ${url.pathname}`)
  }) as typeof fetch

  const config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    WEB_BASE_URL: `${WEB_ORIGIN}/`,
    TRUSTED_ORIGINS: [WEB_ORIGIN, ADMIN_ORIGIN].join(','),
    AUTH_DEV_ENABLED: 'false',
    ...masterKeyEnv(),
  })
  seedWechatConfig(db, { appId: TEST_APP_ID })

  const now = new Date()
  const creatorId = randomUUID()
  db.insert(users)
    .values({ id: creatorId, displayName: '活动运营', createdAt: now, updatedAt: now })
    .run()
  const adminId = randomUUID()
  db.insert(users)
    .values({ id: adminId, displayName: '验收管理员', createdAt: now, updatedAt: now })
    .run()
  db.insert(staffAccounts)
    .values({
      id: randomUUID(),
      userId: adminId,
      username: 'network.assignment.admin',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const communityA = seedCommunity(db, '线下活动社区')
  const communityB = seedCommunity(db, '无关社区')
  const activityId = seedActivity(db, communityA, creatorId)

  const app = createApp({ db, config, fetcher: wechatBoundary, logRequests: false })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  try {
    if (!server.listening) await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`

    const residentJar = cookieJar()
    const returnTo = `/community/activity/silver-neighborhood?activityId=${activityId}&invite=${INVITE_CODE}`

    // 1. The H5 starts the login with the activity it has loaded, over real HTTP.
    const start = await fetch(
      `${base}/auth/wechat/start?activityId=${activityId}&returnTo=${encodeURIComponent(returnTo)}`,
      { headers: { cookie: residentJar.header() }, redirect: 'manual' },
    )
    assert.equal(start.status, 302)
    residentJar.apply(start)
    const authorize = new URL(start.headers.get('location') ?? '')
    assert.equal(authorize.hostname, 'open.weixin.qq.com')
    assert.equal(authorize.searchParams.get('appid'), TEST_APP_ID)
    assert.equal(authorize.searchParams.get('redirect_uri'), `${WEB_ORIGIN}/api/auth/wechat/callback`)
    const state = authorize.searchParams.get('state')
    assert.ok(state)
    // The attempt cookies survive the wire with the attributes the flow needs.
    const setCookie = start.headers.getSetCookie().join('\n')
    assert.match(setCookie, /ll_oauth_nonce=[^;]+/)
    assert.match(setCookie, /HttpOnly/i)
    assert.equal(residentJar.store.has('ll_oauth_nonce'), true)
    assert.equal(residentJar.store.has('ll_oauth_return'), true)

    // 2. WeChat redirects back to the callback with the same jar.
    const callback = await fetch(`${base}/auth/wechat/callback?state=${state}&code=network-code`, {
      headers: { cookie: residentJar.header() },
      redirect: 'manual',
    })
    assert.equal(callback.status, 302)
    residentJar.apply(callback)
    assert.equal(
      callback.headers.get('location'),
      `${WEB_ORIGIN}${returnTo}&auth=success#`,
      'the resident lands back on the activity with its invite intact',
    )
    assert.equal(tokenCalls.length, 1, 'the code is exchanged exactly once')

    // 3. The durable outcome: one identity, one residence, one session — no more.
    const identity = db.select().from(wechatIdentities).get()
    assert.ok(identity)
    const residentId = identity.userId
    const assignments = db.select().from(residentCommunityAssignments).all()
    assert.equal(assignments.length, 1)
    assert.equal(assignments[0]?.userId, residentId)
    assert.equal(assignments[0]?.communityId, communityA)
    assert.equal(
      assignments.some((row) => row.communityId === communityB),
      false,
      'a community the resident never touched is never granted',
    )
    assert.equal(db.select().from(activityParticipations).all().length, 0)
    assert.equal(db.select().from(activityTeams).all().length, 0)
    assert.equal(db.select().from(activityInvitations).all().length, 0)
    assert.equal(db.select().from(activityRewardGrants).all().length, 0)
    assert.equal(db.select().from(localOrders).all().length, 0)
    assert.equal(residentJar.store.has('ll_session'), true, 'the resident is logged in')

    // 4. A second login (same resident, same activity) stays idempotent.
    const secondStart = await fetch(`${base}/auth/wechat/start?activityId=${activityId}`, {
      headers: { cookie: residentJar.header() },
      redirect: 'manual',
    })
    assert.equal(secondStart.status, 302)
    residentJar.apply(secondStart)
    const secondState = new URL(secondStart.headers.get('location')!).searchParams.get('state')
    const secondCallback = await fetch(
      `${base}/auth/wechat/callback?state=${secondState}&code=network-code-2`,
      { headers: { cookie: residentJar.header() }, redirect: 'manual' },
    )
    assert.equal(secondCallback.status, 302)
    assert.equal(db.select().from(residentCommunityAssignments).all().length, 1)
    assert.equal(db.select().from(users).all().length, 3, 'creator + admin + one resident')
    assert.equal(db.select().from(wechatIdentities).all().length, 1)

    // 5. The staff surface reads the resident back from community A only.
    const adminJar = cookieJar()
    const csrfResponse = await fetch(`${base}/auth/csrf`)
    adminJar.apply(csrfResponse)
    const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string }
    const loginResponse = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cookie': adminJar.header(),
        'x-csrf-token': csrfToken,
        'origin': ADMIN_ORIGIN,
      },
      body: JSON.stringify({ username: 'network.assignment.admin', password: ADMIN_PASSWORD }),
    })
    assert.equal(loginResponse.status, 200)
    adminJar.apply(loginResponse)

    const listA = await fetch(`${base}/crm/residents?communityId=${communityA}`, {
      headers: { cookie: adminJar.header() },
    })
    assert.equal(listA.status, 200)
    const residentsA = (await listA.json()) as { items: Array<{ id: string }> }
    assert.deepEqual(
      residentsA.items.map((item) => item.id),
      [residentId],
      'community A lists the resident that just logged in',
    )

    const listB = await fetch(`${base}/crm/residents?communityId=${communityB}`, {
      headers: { cookie: adminJar.header() },
    })
    assert.deepEqual(((await listB.json()) as { items: unknown[] }).items, [])

    // 6. The refused paths fail closed over the same real socket.
    const forged = await fetch(`${base}/auth/wechat/start?communityId=${communityB}`, {
      redirect: 'manual',
    })
    assert.equal(forged.status, 400)
    assert.equal(((await forged.json()) as { error: { code: string } }).error.code, 'invalid_request')

    const draftActivity = seedActivity(db, communityA, creatorId, 'draft')
    const draft = await fetch(`${base}/auth/wechat/start?activityId=${draftActivity}`, {
      redirect: 'manual',
    })
    assert.equal(draft.status, 400)

    const unknown = await fetch(`${base}/auth/wechat/start?activityId=${randomUUID()}`, {
      redirect: 'manual',
    })
    assert.equal(unknown.status, 400)

    // None of the refusals touched identity or attribution.
    assert.equal(db.select().from(residentCommunityAssignments).all().length, 1)
    assert.equal(db.select().from(wechatIdentities).all().length, 1)
    assert.equal(
      db
        .select()
        .from(activities)
        .where(eq(activities.id, draftActivity))
        .get()?.status,
      'draft',
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    sqlite.close()
  }
})

test('a real-socket login without activity context creates no residence', async () => {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const wechatBoundary = (async (input: string | URL) => {
    const url = input instanceof URL ? input : new URL(String(input))
    if (url.pathname === '/sns/oauth2/access_token') {
      return Response.json({ openid: 'plain-login-openid' })
    }
    throw new Error(`unexpected external request to ${url.pathname}`)
  }) as typeof fetch

  const config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    WEB_BASE_URL: `${WEB_ORIGIN}/`,
    TRUSTED_ORIGINS: WEB_ORIGIN,
    AUTH_DEV_ENABLED: 'false',
    ...masterKeyEnv(),
  })
  seedWechatConfig(db, { appId: TEST_APP_ID })

  const app = createApp({ db, config, fetcher: wechatBoundary, logRequests: false })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  try {
    if (!server.listening) await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const jar = cookieJar()

    const start = await fetch(`${base}/auth/wechat/start?returnTo=${encodeURIComponent('/me')}`, {
      headers: { cookie: jar.header() },
      redirect: 'manual',
    })
    assert.equal(start.status, 302)
    jar.apply(start)
    const state = new URL(start.headers.get('location')!).searchParams.get('state')
    const callback = await fetch(`${base}/auth/wechat/callback?state=${state}&code=plain-code`, {
      headers: { cookie: jar.header() },
      redirect: 'manual',
    })
    assert.equal(callback.status, 302)
    jar.apply(callback)
    assert.equal(callback.headers.get('location'), `${WEB_ORIGIN}/me?auth=success#`)

    assert.equal(db.select().from(wechatIdentities).all().length, 1, 'identity still exists')
    assert.equal(
      db.select().from(residentCommunityAssignments).all().length,
      0,
      'a plain login never invents a community',
    )
    assert.equal(db.select().from(activityParticipations).all().length, 0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    sqlite.close()
  }
})
