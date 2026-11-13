import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { loadConfig, type ApiConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activities,
  activityParticipations,
  communities,
  oauthStates,
  residentCommunityAssignments,
  residentCommunityBindingCandidates,
  residentCommunityBindings,
  users,
  wechatIdentities,
  wechatOauthConfigs,
} from '../src/db/schema.js'
import {
  TEST_APP_ID,
  TEST_APP_ID_B,
  TEST_APP_SECRET,
  TEST_APP_SECRET_B,
  TEST_MASTER_KEY,
  masterKeyEnv,
  seedWechatConfig,
} from './wechat-fixtures.js'

/**
 * Real HTTP coverage for the single WeChat runtime source (#113 T3).
 *
 * The Hono app, SQLite schema, AES-GCM encryption, cookies and OAuth state
 * machine are the production ones. Only the WeChat token endpoint is stubbed at
 * the injected `fetch` boundary. Each test states whether the provider row is
 * seeded (admin-activated) or absent; none of them represents a real WeChat
 * login or a real account verification.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ORIGIN = 'https://local-life.example.test'
const SECRET_FRAGMENTS = [TEST_APP_SECRET, TEST_APP_SECRET_B]

/* ------------------------------- helpers --------------------------------- */

function cookiePairs(response: Response): string[] {
  const value = response.headers.get('set-cookie') ?? ''
  return value
    .split(/,(?=[^;,]+=)/)
    .map((part) => part.split(';', 1)[0]?.trim() ?? '')
    .filter(Boolean)
}

function cookiePair(response: Response, name: string): string {
  const pair = cookiePairs(response).find((value) => value.startsWith(`${name}=`))
  assert.ok(pair, `expected a ${name} cookie in ${response.headers.get('set-cookie') ?? '<none>'}`)
  return pair
}

function cookieValue(response: Response, name: string): string | null {
  const pair = cookiePairs(response).find((value) => value.startsWith(`${name}=`))
  return pair ? pair.slice(name.length + 1) : null
}

function stateOf(start: Response): string {
  const location = start.headers.get('location')
  assert.ok(location, 'start must redirect')
  const state = new URL(location).searchParams.get('state')
  assert.ok(state, 'start must mint a state')
  return state
}

function redirectError(response: Response): string | null {
  const location = response.headers.get('location')
  assert.ok(location, 'callback must redirect')
  return new URL(location).searchParams.get('auth_error')
}

interface Provider {
  fetcher: typeof fetch
  calls: URL[]
  /** OpenID returned by the stub; the same value is reused across AppIDs. */
  setOpenId(openId: string): void
  failNext(): void
}

function createProvider(): Provider {
  const calls: URL[] = []
  let openId = 'wechat-openid-shared'
  let fail = false
  const fetcher = (async (input: string | URL) => {
    const url = new URL(String(input))
    calls.push(url)
    if (fail) {
      fail = false
      return new Response('provider down', { status: 502 })
    }
    if (url.pathname === '/sns/oauth2/access_token') {
      return Response.json({
        access_token: 'wechat-profile-access',
        openid: openId,
        unionid: 'wechat-union-shared',
      })
    }
    if (url.pathname === '/sns/userinfo') {
      return Response.json({
        openid: openId,
        nickname: 'Runtime 微信用户',
        sex: 1,
        province: '广东',
        city: '广州',
        country: '中国',
        headimgurl: 'https://wx.example.test/avatar/runtime',
        privilege: [],
      })
    }
    throw new Error('unexpected provider request: ' + url.pathname)
  }) as typeof fetch
  return {
    fetcher,
    calls,
    setOpenId: (value) => {
      openId = value
    },
    failNext: () => {
      fail = true
    },
  }
}

interface Harness {
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  config: ApiConfig
  app: ReturnType<typeof createApp>
  provider: Provider
  webBaseUrl: string
  active: ReturnType<typeof seedWechatConfig> | null
}

interface HarnessOptions {
  webBaseUrl?: string
  withWechat?: boolean
  withMasterKey?: boolean
}

function createHarness(options: HarnessOptions = {}): Harness {
  const webBaseUrl = options.webBaseUrl ?? ORIGIN
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({
    NODE_ENV: 'test',
    WEB_BASE_URL: webBaseUrl,
    TRUSTED_ORIGINS: new URL(webBaseUrl).origin,
    ...(options.withMasterKey === false ? {} : masterKeyEnv()),
  })
  // The fixture encrypts with TEST_MASTER_KEY regardless of what the app loaded:
  // a harness without the key intentionally leaves an undecryptable row behind.
  const active = options.withWechat === false ? null : seedWechatConfig(db)
  const provider = createProvider()
  const app = createApp({ db, config, logRequests: false, fetcher: provider.fetcher })
  return { db, sqlite, config, app, provider, webBaseUrl, active }
}

function appWith(harness: Harness, config: ApiConfig) {
  return createApp({ db: harness.db, config, logRequests: false, fetcher: harness.provider.fetcher })
}

async function beginLogin(
  app: ReturnType<typeof createApp>,
  query = '',
): Promise<Response> {
  return app.request(`/auth/wechat/start${query}`)
}

async function finishLogin(
  app: ReturnType<typeof createApp>,
  start: Response,
  options: { code?: string; nonce?: string; state?: string } = {},
): Promise<Response> {
  const state = options.state ?? stateOf(start)
  const nonce = options.nonce ?? cookiePair(start, 'll_oauth_nonce')
  const returnCookie = cookiePairs(start).find((value) => value.startsWith('ll_oauth_return='))
  const cookie = returnCookie ? `${nonce}; ${returnCookie}` : nonce
  const code = options.code ?? 'oauth-code'
  return app.request(
    `/auth/wechat/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    { headers: { cookie } },
  )
}

async function methods(app: ReturnType<typeof createApp>): Promise<{
  wechat: boolean
  wechatUnavailableReason: string | null
  developmentResidentLogin: boolean
}> {
  const response = await app.request('/auth/methods')
  assert.equal(response.status, 200)
  return (await response.json()) as {
    wechat: boolean
    wechatUnavailableReason: string | null
    developmentResidentLogin: boolean
  }
}

function activeRow(db: AppDatabase) {
  return db.select().from(wechatOauthConfigs).where(eq(wechatOauthConfigs.status, 'active')).get()
}

const PUBLIC_RULES_JSON = JSON.stringify({
  eligibility: '本社区 60 岁以上居民',
  checkin: '到社区服务中心签到并领取参与卡',
  purchase: '现场购买指定套餐一份',
  prizeClaim: '凭核销码领取，每人限一次',
})

/**
 * Minimal published activity in `communityId`. #123 derives attribution from a
 * real activity row, so an OAuth test that wants a residence has to seed one
 * rather than pass a community id in the query.
 */
function seedActivity(db: AppDatabase, communityId: string): string {
  const ownerId = randomUUID()
  const now = new Date()
  db.insert(users)
    .values({ id: ownerId, displayName: '活动创建者', createdAt: now, updatedAt: now })
    .run()
  const activityId = randomUUID()
  db.insert(activities)
    .values({
      id: activityId,
      communityId,
      title: '切换期活动',
      summary: null,
      description: null,
      status: 'published',
      startsAt: new Date(now.getTime() - 60 * 60 * 1000),
      endsAt: new Date(now.getTime() + 60 * 60 * 1000),
      location: '社区服务中心',
      budgetCapCents: 100_000,
      prizeQuantityCap: 100,
      publicRulesJson: PUBLIC_RULES_JSON,
      currentRuleVersionId: null,
      createdByUserId: ownerId,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
      pausedAt: null,
      endedAt: null,
    })
    .run()
  return activityId
}

/* -------------------------------- tests ---------------------------------- */

test('an unconfigured deployment reports not_configured everywhere and never fakes login', async () => {
  const harness = createHarness({ withWechat: false, withMasterKey: false })

  try {
    const availability = await methods(harness.app)
    assert.equal(availability.wechat, false)
    assert.equal(availability.wechatUnavailableReason, 'not_configured')

    const start = await beginLogin(harness.app)
    assert.equal(start.status, 503)
    assert.equal(((await start.json()) as { error: { code: string } }).error.code, 'not_configured')

    const callback = await harness.app.request('/auth/wechat/callback?state=x&code=y')
    assert.equal(redirectError(callback), 'wechat_not_configured')

    assert.equal(harness.db.select().from(users).all().length, 0)
    assert.equal(harness.db.select().from(oauthStates).all().length, 0)
    assert.equal(harness.provider.calls.length, 0)
  } finally {
    harness.sqlite.close()
  }
})

test('legacy env credentials never become a runtime provider', async () => {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({
    NODE_ENV: 'test',
    WEB_BASE_URL: ORIGIN,
    TRUSTED_ORIGINS: ORIGIN,
    // Present in the environment, but deliberately ignored since T3.
    WECHAT_APP_ID: TEST_APP_ID,
    WECHAT_APP_SECRET: TEST_APP_SECRET,
    WECHAT_REDIRECT_URI: `${ORIGIN}/api/auth/wechat/callback`,
  })
  const provider = createProvider()
  const app = createApp({ db, config, logRequests: false, fetcher: provider.fetcher })

  try {
    const availability = await methods(app)
    assert.equal(availability.wechat, false)
    assert.equal(availability.wechatUnavailableReason, 'not_configured')

    const start = await beginLogin(app)
    assert.equal(start.status, 503)
    assert.equal(((await start.json()) as { error: { code: string } }).error.code, 'not_configured')

    const callback = await app.request('/auth/wechat/callback?state=x&code=y')
    assert.equal(redirectError(callback), 'wechat_not_configured')
    assert.equal(provider.calls.length, 0)
    assert.equal(db.select().from(users).all().length, 0)
  } finally {
    sqlite.close()
  }
})

test('the seeded database row drives /auth/methods, start and callback, and start binds its id', async () => {
  const harness = createHarness()
  assert.ok(harness.active)

  try {
    const availability = await methods(harness.app)
    assert.equal(availability.wechat, true)
    assert.equal(availability.wechatUnavailableReason, null)
    // The public availability probe must not leak the row id, key id or secret.
    const methodsText = JSON.stringify(availability)
    assert.equal(methodsText.includes(harness.active.id), false)
    assert.equal(methodsText.includes(TEST_MASTER_KEY.keyId), false)
    for (const fragment of SECRET_FRAGMENTS) {
      assert.equal(methodsText.includes(fragment), false)
    }

    const start = await beginLogin(harness.app)
    assert.equal(start.status, 302)
    const authorize = new URL(start.headers.get('location')!)
    assert.equal(
      authorize.origin + authorize.pathname,
      'https://open.weixin.qq.com/connect/oauth2/authorize',
    )
    assert.equal(authorize.searchParams.get('appid'), TEST_APP_ID)
    // Derived from WEB_BASE_URL's origin plus the shared callback path.
    assert.equal(
      authorize.searchParams.get('redirect_uri'),
      `${ORIGIN}/api/auth/wechat/callback`,
    )
    assert.equal(authorize.searchParams.get('scope'), 'snsapi_userinfo')

    // The attempt is bound to the exact provider version.
    assert.equal(harness.db.select().from(oauthStates).all().length, 1)
    assert.equal(harness.db.select().from(oauthStates).all()[0]?.configId, harness.active.id)

    const callback = await finishLogin(harness.app, start)
    assert.equal(callback.status, 302)
    assert.equal(new URL(callback.headers.get('location')!).search, '?auth=success')

    // The token exchange uses the pinned AppID + decrypted secret. The second
    // call is snsapi_userinfo and carries only the short-lived profile token.
    assert.equal(harness.provider.calls.length, 2)
    const tokenCall = harness.provider.calls[0]!
    assert.equal(tokenCall.searchParams.get('appid'), TEST_APP_ID)
    assert.equal(tokenCall.searchParams.get('secret'), TEST_APP_SECRET)
    assert.equal(tokenCall.searchParams.get('grant_type'), 'authorization_code')
    const profileCall = harness.provider.calls[1]!
    assert.equal(profileCall.pathname, '/sns/userinfo')
    assert.equal(profileCall.searchParams.get('openid'), 'wechat-openid-shared')
    assert.equal(profileCall.searchParams.has('secret'), false)

    assert.ok(cookiePair(callback, 'll_session'))
    assert.equal(harness.db.select().from(users).all().length, 1)
    const identity = harness.db.select().from(wechatIdentities).get()
    assert.equal(identity?.appId, TEST_APP_ID)
    assert.equal(identity?.openId, 'wechat-openid-shared')

    // Replay is still rejected: the state was consumed exactly once.
    const replay = await finishLogin(harness.app, start)
    assert.equal(redirectError(replay), 'wechat_state_invalid')
    assert.equal(harness.provider.calls.length, 2)
    assert.equal(await sessionCount(harness.app, callback), 1)
  } finally {
    harness.sqlite.close()
  }
})

async function sessionCount(
  app: ReturnType<typeof createApp>,
  callback: Response,
): Promise<number> {
  const response = await app.request('/auth/session', {
    headers: { cookie: cookiePair(callback, 'll_session') },
  })
  return ((await response.json()) as { authenticated: boolean }).authenticated ? 1 : 0
}

test('the callback URL is derived from WEB_BASE_URL, including the deployed base path', async () => {
  const harness = createHarness({ webBaseUrl: `${ORIGIN}/local-life/` })
  try {
    const start = await beginLogin(harness.app)
    const authorize = new URL(start.headers.get('location')!)
    assert.equal(
      authorize.searchParams.get('redirect_uri'),
      `${ORIGIN}/api/auth/wechat/callback`,
    )
  } finally {
    harness.sqlite.close()
  }
})

test('activating another version takes effect on the same app instance without a restart', async () => {
  const harness = createHarness()
  const first = harness.active!
  try {
    const before = await beginLogin(harness.app)
    assert.equal(new URL(before.headers.get('location')!).searchParams.get('appid'), TEST_APP_ID)

    // Exactly what POST /admin/wechat/config/:id/activate does, without restarting.
    const second = seedWechatConfig(harness.db, {
      appId: TEST_APP_ID_B,
      appSecret: TEST_APP_SECRET_B,
    })
    assert.notEqual(second.id, first.id)

    const availability = await methods(harness.app)
    assert.equal(availability.wechat, true)

    const after = await beginLogin(harness.app)
    assert.equal(new URL(after.headers.get('location')!).searchParams.get('appid'), TEST_APP_ID_B)
    const latestState = harness.db.select().from(oauthStates).all().at(-1)
    assert.equal(latestState?.configId, second.id)

    // The previous version is retired, not deleted, so in-flight attempts can
    // still resolve it by id.
    const retired = harness.db
      .select()
      .from(wechatOauthConfigs)
      .where(eq(wechatOauthConfigs.id, first.id))
      .get()
    assert.equal(retired?.status, 'retired')
    assert.equal(activeRow(harness.db)?.id, second.id)
  } finally {
    harness.sqlite.close()
  }
})

test('a failed candidate never disturbs the active provider', async () => {
  const harness = createHarness()
  const first = harness.active!
  try {
    // Save + fail a candidate exactly like a real bad AppSecret verification.
    seedWechatConfig(harness.db, {
      appId: TEST_APP_ID_B,
      appSecret: TEST_APP_SECRET_B,
      status: 'failed',
    })

    assert.equal(activeRow(harness.db)?.id, first.id)
    const availability = await methods(harness.app)
    assert.equal(availability.wechat, true)

    const start = await beginLogin(harness.app)
    assert.equal(new URL(start.headers.get('location')!).searchParams.get('appid'), TEST_APP_ID)
    const callback = await finishLogin(harness.app, start)
    assert.equal(new URL(callback.headers.get('location')!).search, '?auth=success')
    assert.equal(harness.provider.calls[0]?.searchParams.get('secret'), TEST_APP_SECRET)
  } finally {
    harness.sqlite.close()
  }
})

test('an in-flight callback completes with the version it started with, after a switch', async () => {
  const harness = createHarness()
  const first = harness.active!
  try {
    const startA = await beginLogin(harness.app)
    assert.equal(
      harness.db
        .select()
        .from(oauthStates)
        .where(eq(oauthStates.configId, first.id))
        .all().length,
      1,
    )

    // Switch to B while A's browser is still at WeChat.
    const second = seedWechatConfig(harness.db, {
      appId: TEST_APP_ID_B,
      appSecret: TEST_APP_SECRET_B,
    })
    assert.equal(activeRow(harness.db)?.id, second.id)

    // A's callback must use A's AppID and secret; using B's secret would fail
    // at WeChat and, worse, could map the code to the wrong account.
    const callbackA = await finishLogin(harness.app, startA, { code: 'code-from-a' })
    assert.equal(new URL(callbackA.headers.get('location')!).search, '?auth=success')
    const callA = harness.provider.calls.find(
      (url) => url.pathname === '/sns/oauth2/access_token' && url.searchParams.get('code') === 'code-from-a',
    )
    assert.ok(callA)
    assert.equal(callA.searchParams.get('appid'), TEST_APP_ID)
    assert.equal(callA.searchParams.get('secret'), TEST_APP_SECRET)
    assert.equal(callA.searchParams.get('code'), 'code-from-a')
    assert.equal(
      harness.db.select().from(wechatIdentities).get()?.appId,
      TEST_APP_ID,
    )

    // A new start after the switch uses B and stays a separate identity even
    // though the provider returns the same OpenID.
    const startB = await beginLogin(harness.app)
    assert.equal(new URL(startB.headers.get('location')!).searchParams.get('appid'), TEST_APP_ID_B)
    const callbackB = await finishLogin(harness.app, startB, { code: 'code-from-b' })
    assert.equal(new URL(callbackB.headers.get('location')!).search, '?auth=success')
    const callB = harness.provider.calls.find(
      (url) => url.pathname === '/sns/oauth2/access_token' && url.searchParams.get('code') === 'code-from-b',
    )
    assert.ok(callB)
    assert.equal(callB.searchParams.get('appid'), TEST_APP_ID_B)
    assert.equal(callB.searchParams.get('secret'), TEST_APP_SECRET_B)

    assert.equal(harness.db.select().from(users).all().length, 2)
    const identities = harness.db
      .select()
      .from(wechatIdentities)
      .all()
      .sort((a, b) => a.appId.localeCompare(b.appId))
    assert.deepEqual(
      identities.map((row) => [row.appId, row.openId]),
      [
        [TEST_APP_ID, 'wechat-openid-shared'],
        [TEST_APP_ID_B, 'wechat-openid-shared'],
      ],
    )
    assert.notEqual(identities[0]?.userId, identities[1]?.userId)

    // Switching back to A still resolves A's resident, never B's.
    seedWechatConfig(harness.db, { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET })
    const restartA = await beginLogin(harness.app)
    const callbackA2 = await finishLogin(harness.app, restartA, { code: 'code-a-again' })
    assert.equal(new URL(callbackA2.headers.get('location')!).search, '?auth=success')
    assert.equal(harness.db.select().from(users).all().length, 2)
    const aIdentities = harness.db
      .select()
      .from(wechatIdentities)
      .where(eq(wechatIdentities.appId, TEST_APP_ID))
      .all()
    assert.equal(aIdentities.length, 1)
  } finally {
    harness.sqlite.close()
  }
})

test('a missing master key fails methods/start/callback closed for an existing row', async () => {
  const harness = createHarness()
  try {
    const startA = await beginLogin(harness.app)
    assert.equal(startA.status, 302)

    const noKeyConfig = loadConfig({
      NODE_ENV: 'test',
      WEB_BASE_URL: harness.webBaseUrl,
      TRUSTED_ORIGINS: new URL(harness.webBaseUrl).origin,
    })
    const noKeyApp = appWith(harness, noKeyConfig)

    const availability = await methods(noKeyApp)
    assert.equal(availability.wechat, false)
    assert.equal(availability.wechatUnavailableReason, 'wechat_config_unavailable')

    const start = await beginLogin(noKeyApp)
    assert.equal(start.status, 503)

    const callback = await finishLogin(noKeyApp, startA)
    assert.equal(redirectError(callback), 'wechat_config_unavailable')
    // Clear the attempt cookies, and never call WeChat or create a resident.
    assert.equal(cookieValue(callback, 'll_oauth_nonce'), '')
    assert.equal(harness.provider.calls.length, 0)
    assert.equal(harness.db.select().from(users).all().length, 0)
  } finally {
    harness.sqlite.close()
  }
})

test('a tampered active ciphertext fails closed instead of borrowing another secret', async () => {
  const harness = createHarness()
  const active = harness.active!
  try {
    const startA = await beginLogin(harness.app)
    assert.equal(startA.status, 302)

    harness.db
      .update(wechatOauthConfigs)
      .set({ appSecretCiphertext: Buffer.from('tampered-ciphertext').toString('base64') })
      .where(eq(wechatOauthConfigs.id, active.id))
      .run()

    const availability = await methods(harness.app)
    assert.equal(availability.wechat, false)
    assert.equal(availability.wechatUnavailableReason, 'wechat_config_unavailable')

    const start = await beginLogin(harness.app)
    assert.equal(start.status, 503)

    const callback = await finishLogin(harness.app, startA)
    assert.equal(redirectError(callback), 'wechat_config_unavailable')
    assert.equal(cookieValue(callback, 'll_oauth_nonce'), '')
    assert.equal(harness.provider.calls.length, 0)
    assert.equal(harness.db.select().from(users).all().length, 0)
  } finally {
    harness.sqlite.close()
  }
})

test('state replay, wrong nonce and expiry are still rejected before any provider call', async () => {
  const harness = createHarness()
  try {
    // Wrong nonce: the state is not consumed, so the same attempt can recover.
    const start = await beginLogin(harness.app)
    const wrongNonce = await finishLogin(harness.app, start, { nonce: 'll_oauth_nonce=wrong' })
    assert.equal(redirectError(wrongNonce), 'wechat_state_invalid')
    assert.equal(harness.provider.calls.length, 0)
    assert.equal(
      harness.db.select().from(oauthStates).all()[0]?.consumedAt,
      null,
    )

    // Correct nonce then succeeds exactly once.
    const success = await finishLogin(harness.app, start)
    assert.equal(new URL(success.headers.get('location')!).search, '?auth=success')
    assert.equal(harness.provider.calls.length, 2)

    // Replay of the consumed state.
    const replay = await finishLogin(harness.app, start)
    assert.equal(redirectError(replay), 'wechat_state_invalid')
    assert.equal(harness.provider.calls.length, 2)

    // Expired attempt.
    const expired = await beginLogin(harness.app)
    harness.db
      .update(oauthStates)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .run()
    const expiredCallback = await finishLogin(harness.app, expired)
    assert.equal(redirectError(expiredCallback), 'wechat_state_invalid')
    assert.equal(harness.provider.calls.length, 2)
  } finally {
    harness.sqlite.close()
  }
})

test('a pre-#113 state without a bound configId fails as state_invalid', async () => {
  const harness = createHarness()
  try {
    const start = await beginLogin(harness.app)
    harness.db.update(oauthStates).set({ configId: null }).run()

    const callback = await finishLogin(harness.app, start)
    assert.equal(redirectError(callback), 'wechat_state_invalid')
    assert.equal(cookieValue(callback, 'll_oauth_nonce'), '')
    assert.equal(harness.provider.calls.length, 0)
    assert.equal(harness.db.select().from(users).all().length, 0)
  } finally {
    harness.sqlite.close()
  }
})

test('a provider failure is reported as provider_unavailable without creating a resident', async () => {
  const harness = createHarness()
  try {
    const start = await beginLogin(harness.app)
    harness.provider.failNext()
    const callback = await finishLogin(harness.app, start)
    assert.equal(redirectError(callback), 'wechat_provider_unavailable')
    assert.equal(cookieValue(callback, 'll_oauth_nonce'), '')
    assert.equal(harness.db.select().from(users).all().length, 0)
    // The state was consumed before the provider call: one code, one attempt.
    assert.notEqual(harness.db.select().from(oauthStates).all()[0]?.consumedAt, null)
  } finally {
    harness.sqlite.close()
  }
})

test('an activity-scoped attempt still associates the resident after a switch', async () => {
  const harness = createHarness()
  try {
    const communityId = randomUUID()
    harness.db
      .insert(communities)
      .values({ id: communityId, name: '切换测试社区', createdAt: new Date() })
      .run()
    // The community still rides on the activity, never on a client-sent value.
    // #171 LL-IDENTITY-001: after login it is a SUGGESTION the resident must
    // confirm, not an auto-written residence. The derivation itself — including
    // the surviving state across a config switch — is what this test guards.
    const activityId = seedActivity(harness.db, communityId)
    const start = await beginLogin(harness.app, `?activityId=${activityId}`)
    seedWechatConfig(harness.db, { appId: TEST_APP_ID_B, appSecret: TEST_APP_SECRET_B })
    const callback = await finishLogin(harness.app, start)
    assert.equal(new URL(callback.headers.get('location')!).search, '?auth=success')
    // `users` also holds the seeded activity owner; the resident is the one the
    // callback bound a WeChat identity to.
    const resident = harness.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(wechatIdentities, eq(wechatIdentities.userId, users.id))
      .get()
    assert.ok(resident)
    // No permanent community and no historical relation — only one suggestion.
    assert.equal(
      harness.db
        .select()
        .from(residentCommunityAssignments)
        .where(eq(residentCommunityAssignments.userId, resident.id))
        .all().length,
      0,
      'login must not write a historical attribution',
    )
    assert.equal(
      harness.db
        .select()
        .from(residentCommunityBindings)
        .where(eq(residentCommunityBindings.userId, resident.id))
        .all().length,
      0,
      'login must not confirm a permanent community',
    )
    const candidates = harness.db
      .select()
      .from(residentCommunityBindingCandidates)
      .where(eq(residentCommunityBindingCandidates.userId, resident.id))
      .all()
    assert.equal(candidates.length, 1, 'exactly one server-derived suggestion')
    assert.equal(candidates[0]?.communityId, communityId)
    assert.equal(candidates[0]?.source, 'activity_oauth_candidate')
    assert.equal(harness.db.select().from(activityParticipations).all().length, 0)
  } finally {
    harness.sqlite.close()
  }
})

test('a client-supplied communityId is refused by start', async () => {
  const harness = createHarness()
  try {
    const communityId = randomUUID()
    harness.db
      .insert(communities)
      .values({ id: communityId, name: '客户端社区', createdAt: new Date() })
      .run()
    const start = await beginLogin(harness.app, `?communityId=${communityId}`)
    assert.equal(start.status, 400)
    const body = (await start.json()) as { error?: { code?: string } }
    assert.equal(body.error?.code, 'invalid_request')
    assert.equal(harness.db.select().from(oauthStates).all().length, 0)
  } finally {
    harness.sqlite.close()
  }
})

