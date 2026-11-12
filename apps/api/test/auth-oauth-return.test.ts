import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import {
  activities,
  activityParticipations,
  activityTeams,
  communities,
  oauthStates,
  sessions,
  users,
  wechatIdentities,
} from '../src/db/schema.js'
import { masterKeyEnv, seedWechatConfig, TEST_APP_ID } from './wechat-fixtures.js'

/**
 * Real HTTP coverage for the resident WeChat login return path (#92).
 *
 * The OAuth provider is faked at the `fetch` boundary only; every other step is
 * the production Hono app, its SQLite schema and its real cookie handling. That
 * is enough to prove the security properties that matter here: one-time state,
 * nonce binding, expiry, replay, tampered/forged return targets, cross-origin
 * returnTo refusal, and "login never writes a participation".
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const WECHAT_RETURN_URI = 'https://local-life.example.test/api/auth/wechat/callback'
const INVITE_CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

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

function hasSessionCookie(response: Response): boolean {
  return cookiePairs(response).some((value) => value.startsWith('ll_session='))
}

function oauthContext(
  webBaseUrl: string,
  fetcher: typeof fetch,
  options: { withWechat?: boolean } = {},
) {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const withWechat = options.withWechat !== false
  const config = loadConfig({
    NODE_ENV: 'test',
    WEB_BASE_URL: webBaseUrl,
    TRUSTED_ORIGINS: new URL(webBaseUrl).origin,
    ...(withWechat ? masterKeyEnv() : {}),
  })
  // The provider is a database row now; seed one active encrypted version with
  // the master key the config just loaded (except in the unconfigured case).
  if (withWechat) seedWechatConfig(db, { appId: TEST_APP_ID })
  const app = createApp({ db, config, logRequests: false, fetcher })
  return { app, db, sqlite, config }
}

function countingProvider(openid = 'wechat-openid-1') {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ openid, unionid: 'wechat-union-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetcher, calls }
}

async function startOauth(
  app: ReturnType<typeof createApp>,
  returnTo: string | null,
) {
  const suffix = returnTo === null ? '' : `?returnTo=${encodeURIComponent(returnTo)}`
  return app.request(`/auth/wechat/start${suffix}`)
}

function activityReturnTo(activityId: string): string {
  return `/community/activity/silver-neighborhood?activityId=${activityId}&invite=${INVITE_CODE}`
}

/** A published activity; #123 derives the resident's community from this row. */
function seedActivity(db: ReturnType<typeof createDatabase>['db'], communityId: string): string {
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
      title: '回跳活动',
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
  return activityId
}

test('WeChat login returns to the activity invite link and never auto-joins it', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://local-life.example.test', provider.fetcher)
  const activityId = randomUUID()

  try {
    const start = await startOauth(context.app, activityReturnTo(activityId))
    assert.equal(start.status, 302)
    const authorizeUrl = new URL(start.headers.get('location')!)
    assert.equal(authorizeUrl.origin + authorizeUrl.pathname, 'https://open.weixin.qq.com/connect/oauth2/authorize')
    const state = authorizeUrl.searchParams.get('state')
    assert.ok(state)
    assert.equal(authorizeUrl.searchParams.get('scope'), 'snsapi_base')
    assert.equal(authorizeUrl.searchParams.get('appid'), TEST_APP_ID)
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), WECHAT_RETURN_URI)

    // The attempt cookies are readable by the callback path only because they are
    // root-scoped; they must stay HttpOnly so page scripts cannot mint a target.
    const startCookies = start.headers.get('set-cookie') ?? ''
    assert.match(startCookies, /ll_oauth_nonce=[^;]+;/)
    assert.match(startCookies, /ll_oauth_return=[^;]+;/)
    assert.match(startCookies, /HttpOnly/i)
    assert.match(startCookies, /Path=\//i)
    const nonceCookie = cookiePair(start, 'll_oauth_nonce')
    const returnCookie = cookiePair(start, 'll_oauth_return')
    assert.ok(
      cookieValue(start, 'll_oauth_return')!.startsWith(`${state}.`),
      'the return target cookie is bound to this attempt state',
    )
    assert.equal(context.db.select().from(oauthStates).all().length, 1)

    const callback = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      { headers: { cookie: `${nonceCookie}; ${returnCookie}` } },
    )
    assert.equal(callback.status, 302)
    const callbackLocation = callback.headers.get('location')!
    assert.equal(
      callbackLocation,
      `https://local-life.example.test${activityReturnTo(activityId)}&auth=success#`,
    )
    // Clean history path: BrowserRouter (base `/`) must not receive a `/#/` hash.
    // The explicit empty fragment is what stops the browser from keeping WeChat's
    // `#wechat_redirect` (a redirect without a fragment inherits the old one).
    assert.equal(new URL(callbackLocation).hash, '')
    assert.ok(callbackLocation.endsWith('#'))
    assert.equal(new URL(callbackLocation).searchParams.get('invite'), INVITE_CODE)
    assert.ok(hasSessionCookie(callback))
    // Both attempt cookies are burned together with the state.
    assert.equal(cookieValue(callback, 'll_oauth_nonce'), '')
    assert.equal(cookieValue(callback, 'll_oauth_return'), '')
    assert.equal(provider.calls.length, 1)

    const session = await context.app.request('/auth/session', {
      headers: { cookie: cookiePair(callback, 'll_session') },
    })
    assert.equal(((await session.json()) as { authenticated: boolean }).authenticated, true)
    assert.equal(context.db.select().from(users).all().length, 1)
    assert.equal(context.db.select().from(wechatIdentities).all().length, 1)

    // Logging in identifies the resident; joining stays an explicit confirm step.
    assert.equal(context.db.select().from(activityParticipations).all().length, 0)
    assert.equal(context.db.select().from(activityTeams).all().length, 0)
  } finally {
    context.sqlite.close()
  }
})

test('start refuses every return target that is not a same-origin resident path', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://local-life.example.test', provider.fetcher)

  try {
    const rejected = [
      'https://evil.example/community/activity/silver-neighborhood',
      '//evil.example/community/activity/silver-neighborhood',
      '\\\\evil.example/community',
      '/\\evil.example/community',
      '/%2f%2fevil.example/community',
      'javascript:alert(1)',
      'community/activity/silver-neighborhood',
      ' /community',
      '/community ',
      '/community\n/activity',
      '/community/activity/silver-neighborhood#fragment',
      '/community/../admin/communities',
      '/community/%2e%2e/admin/communities',
      '/admin/communities',
      '/community-evil',
      '/api/auth/wechat/callback',
      `/${'a'.repeat(600)}`,
    ]

    for (const returnTo of rejected) {
      const response = await startOauth(context.app, returnTo)
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(returnTo)}`)
      const body = (await response.json()) as { error: { code: string } }
      assert.equal(body.error.code, 'invalid_request')
      // A rejected target must not mint an attempt at all.
      assert.equal(context.db.select().from(oauthStates).all().length, 0)
    }
    assert.equal(provider.calls.length, 0)
  } finally {
    context.sqlite.close()
  }
})

test('callback fails on missing nonce, tampered state and expired state without writing identity', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://local-life.example.test', provider.fetcher)
  const activityId = randomUUID()

  try {
    const start = await startOauth(context.app, activityReturnTo(activityId))
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const nonceCookie = cookiePair(start, 'll_oauth_nonce')
    const returnCookie = cookiePair(start, 'll_oauth_return')

    // Missing / wrong nonce: the browser is not the one that started the attempt.
    const missingNonce = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      { headers: { cookie: returnCookie } },
    )
    assert.equal(
      missingNonce.headers.get('location'),
      `https://local-life.example.test${activityReturnTo(activityId)}&auth_error=wechat_state_invalid#`,
    )
    const wrongNonce = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      { headers: { cookie: `ll_oauth_nonce=not-the-nonce; ${returnCookie}` } },
    )
    assert.equal(
      wrongNonce.headers.get('location'),
      `https://local-life.example.test${activityReturnTo(activityId)}&auth_error=wechat_state_invalid#`,
    )

    // Tampered state: it no longer hashes to the stored record, and the cookie is
    // bound to a state that was never issued, so the target is not trusted either.
    const tamperedState = `${state.slice(0, -1)}${state.endsWith('a') ? 'b' : 'a'}`
    const tampered = await context.app.request(
      `/auth/wechat/callback?state=${tamperedState}&code=oauth-code`,
      { headers: { cookie: `${nonceCookie}; ${returnCookie}` } },
    )
    assert.equal(
      tampered.headers.get('location'),
      'https://local-life.example.test/me?auth_error=wechat_state_invalid#',
    )

    // Expired state.
    context.db.update(oauthStates).set({ expiresAt: new Date(Date.now() - 1_000) }).run()
    const expired = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      { headers: { cookie: `${nonceCookie}; ${returnCookie}` } },
    )
    assert.equal(
      expired.headers.get('location'),
      `https://local-life.example.test${activityReturnTo(activityId)}&auth_error=wechat_state_invalid#`,
    )

    for (const response of [missingNonce, wrongNonce, tampered, expired]) {
      assert.equal(hasSessionCookie(response), false)
      assert.equal(cookieValue(response, 'll_oauth_nonce'), '')
      assert.equal(cookieValue(response, 'll_oauth_return'), '')
    }
    assert.equal(provider.calls.length, 0)
    assert.equal(context.db.select().from(users).all().length, 0)
    assert.equal(context.db.select().from(wechatIdentities).all().length, 0)
    assert.equal(context.db.select().from(sessions).all().length, 0)
  } finally {
    context.sqlite.close()
  }
})

test('a consumed state cannot be replayed and the second callback gets no session', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://local-life.example.test', provider.fetcher)
  const activityId = randomUUID()

  try {
    const start = await startOauth(context.app, activityReturnTo(activityId))
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const cookies = `${cookiePair(start, 'll_oauth_nonce')}; ${cookiePair(start, 'll_oauth_return')}`

    const first = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      { headers: { cookie: cookies } },
    )
    assert.ok(hasSessionCookie(first))
    assert.equal(provider.calls.length, 1)

    const replay = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      { headers: { cookie: cookies } },
    )
    assert.equal(
      replay.headers.get('location'),
      `https://local-life.example.test${activityReturnTo(activityId)}&auth_error=wechat_state_invalid#`,
    )
    assert.equal(hasSessionCookie(replay), false)
    // The provider is never asked twice for the same code.
    assert.equal(provider.calls.length, 1)
    assert.equal(context.db.select().from(users).all().length, 1)
    assert.equal(context.db.select().from(activityParticipations).all().length, 0)
  } finally {
    context.sqlite.close()
  }
})

test('a forged or stale return cookie falls back to the default page, never off-origin', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://local-life.example.test', provider.fetcher)

  try {
    for (const forgedTarget of [
      '/\\evil.example/community',
      '//evil.example/community',
      'https://evil.example/community',
      '/admin/communities',
      '/community/../admin/communities',
    ]) {
      // Every forged target gets its own attempt: a consumed state would mask the
      // property under test (a valid login returning to an unvalidated target).
      const start = await startOauth(context.app, activityReturnTo(randomUUID()))
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!
      const nonceCookie = cookiePair(start, 'll_oauth_nonce')
      const forgedCookie = `ll_oauth_return=${state}.${Buffer.from(forgedTarget, 'utf8').toString('base64url')}`

      const response = await context.app.request(
        `/auth/wechat/callback?state=${state}&code=oauth-code`,
        { headers: { cookie: `${nonceCookie}; ${forgedCookie}` } },
      )
      const location = response.headers.get('location')!
      assert.equal(location, 'https://local-life.example.test/me?auth=success#')
      assert.equal(location.includes('evil.example'), false)
      assert.ok(hasSessionCookie(response))
    }

    // A cookie bound to a different attempt state is ignored as well.
    const first = await startOauth(context.app, activityReturnTo(randomUUID()))
    const state = new URL(first.headers.get('location')!).searchParams.get('state')!
    const nonceCookie = cookiePair(first, 'll_oauth_nonce')
    const second = await startOauth(context.app, activityReturnTo(randomUUID()))
    const otherState = new URL(second.headers.get('location')!).searchParams.get('state')!
    const mismatched = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      {
        headers: {
          cookie: `${nonceCookie}; ll_oauth_return=${otherState}.${Buffer.from(
            '/community/activity/silver-neighborhood',
            'utf8',
          ).toString('base64url')}`,
        },
      },
    )
    assert.equal(
      mismatched.headers.get('location'),
      'https://local-life.example.test/me?auth=success#',
    )
  } finally {
    context.sqlite.close()
  }
})

test('denying the authorization returns to the activity with a retryable error and no identity', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://local-life.example.test', provider.fetcher)
  const activityId = randomUUID()

  try {
    const start = await startOauth(context.app, activityReturnTo(activityId))
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const cookies = `${cookiePair(start, 'll_oauth_nonce')}; ${cookiePair(start, 'll_oauth_return')}`

    const denied = await context.app.request(
      `/auth/wechat/callback?state=${state}&errcode=1001&errmsg=user+denied`,
      { headers: { cookie: cookies } },
    )
    assert.equal(
      denied.headers.get('location'),
      `https://local-life.example.test${activityReturnTo(activityId)}&auth_error=wechat_authorization_failed#`,
    )
    assert.equal(hasSessionCookie(denied), false)
    assert.equal(cookieValue(denied, 'll_oauth_nonce'), '')
    assert.equal(cookieValue(denied, 'll_oauth_return'), '')
    assert.equal(provider.calls.length, 0)
    // The attempt was not consumed, so the resident can simply retry.
    assert.equal(
      context.db.select().from(oauthStates).all().filter((row) => row.consumedAt !== null).length,
      0,
    )
    assert.equal(context.db.select().from(users).all().length, 0)
  } finally {
    context.sqlite.close()
  }
})

test('without a returnTo the online BrowserRouter defaults to clean /me', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://local-life.example.test', provider.fetcher)

  try {
    const start = await startOauth(context.app, null)
    // A new attempt without a target must not inherit an older target.
    assert.equal(cookieValue(start, 'll_oauth_return'), '')
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const callback = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      { headers: { cookie: cookiePair(start, 'll_oauth_nonce') } },
    )
    assert.equal(callback.headers.get('location'), 'https://local-life.example.test/me?auth=success#')

    const missingState = await context.app.request('/auth/wechat/callback?code=oauth-code')
    assert.equal(
      missingState.headers.get('location'),
      'https://local-life.example.test/me?auth_error=wechat_state_invalid#',
    )
  } finally {
    context.sqlite.close()
  }
})

test('the root activity invite survives OAuth without auto-joining a team', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://local-life.example.test', provider.fetcher)
  const returnTo = `/?activityId=${randomUUID()}&invite=INVITE123`

  try {
    const start = await startOauth(context.app, returnTo)
    assert.equal(start.status, 302)
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const callback = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      {
        headers: {
          cookie: `${cookiePair(start, 'll_oauth_nonce')}; ${cookiePair(start, 'll_oauth_return')}`,
        },
      },
    )
    assert.equal(callback.status, 302)
    assert.equal(
      callback.headers.get('location'),
      `https://local-life.example.test${returnTo}&auth=success#`,
    )
    assert.ok(cookiePair(callback, 'll_session'))
  } finally {
    context.sqlite.close()
  }
})

test('the GitHub Pages hash router keeps the activity route in the hash with its query', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://sanchuang-dev.github.io/local-life/', provider.fetcher)
  const activityId = randomUUID()

  try {
    const returnTo = activityReturnTo(activityId)
    const start = await startOauth(context.app, returnTo)
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const callback = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      {
        headers: {
          cookie: `${cookiePair(start, 'll_oauth_nonce')}; ${cookiePair(start, 'll_oauth_return')}`,
        },
      },
    )
    const destination = new URL(callback.headers.get('location')!)
    assert.equal(destination.origin, 'https://sanchuang-dev.github.io')
    assert.equal(destination.pathname, '/local-life/')
    assert.equal(destination.hash, `#${returnTo}&auth=success`)
    // A hash target already owns the fragment, so it needs no extra empty one.
    assert.equal(destination.href.endsWith('&auth=success#'), false)
    assert.ok(cookiePair(callback, 'll_session'))
  } finally {
    context.sqlite.close()
  }
})

test('a clean-path return target ends with an explicit empty fragment', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://local-life.example.test', provider.fetcher)
  const activityId = randomUUID()

  try {
    // WeChat returns the browser to our callback with `#wechat_redirect` in the
    // URL. A 302 whose Location has no fragment keeps the previous fragment, so
    // the clean-path target must carry an explicit empty one to replace it.
    const start = await startOauth(context.app, activityReturnTo(activityId))
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const callback = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      {
        headers: {
          cookie: `${cookiePair(start, 'll_oauth_nonce')}; ${cookiePair(start, 'll_oauth_return')}`,
        },
      },
    )
    const location = callback.headers.get('location')!
    assert.ok(location.endsWith('&auth=success#'))
    assert.equal(new URL(location).hash, '')
    assert.equal(new URL(location).href.endsWith('#'), true)

    // Without a target the default `/me` page is also a clean path;
    // the explicit empty fragment prevents `#wechat_redirect` inheritance.
    const noTarget = await startOauth(context.app, null)
    const noTargetState = new URL(noTarget.headers.get('location')!).searchParams.get('state')!
    const fallback = await context.app.request(
      `/auth/wechat/callback?state=${noTargetState}&code=oauth-code`,
      { headers: { cookie: cookiePair(noTarget, 'll_oauth_nonce') } },
    )
    assert.equal(fallback.headers.get('location'), 'https://local-life.example.test/me?auth=success#')
  } finally {
    context.sqlite.close()
  }
})

test('an unconfigured WeChat account is reported as unavailable instead of faked', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://local-life.example.test', provider.fetcher, {
    withWechat: false,
  })

  try {
    const methods = await context.app.request('/auth/methods')
    const body = (await methods.json()) as {
      wechat: boolean
      wechatUnavailableReason: string | null
      developmentResidentLogin: boolean
    }
    assert.equal(body.wechat, false)
    assert.equal(body.wechatUnavailableReason, 'not_configured')
    assert.equal(body.developmentResidentLogin, false)

    const start = await startOauth(context.app, activityReturnTo(randomUUID()))
    assert.equal(start.status, 503)
    const startBody = (await start.json()) as { error: { code: string } }
    assert.equal(startBody.error.code, 'not_configured')
    assert.equal(hasSessionCookie(start), false)

    const callback = await context.app.request('/auth/wechat/callback?state=x&code=y')
    assert.equal(callback.headers.get('location'), 'https://local-life.example.test/me?auth_error=wechat_not_configured#')
    assert.equal(context.db.select().from(users).all().length, 0)
  } finally {
    context.sqlite.close()
  }
})

test('a valid activity scope still round-trips through the return flow', async () => {
  const provider = countingProvider()
  const context = oauthContext('https://local-life.example.test', provider.fetcher)
  const communityId = randomUUID()

  try {
    context.db
      .insert(communities)
      .values({ id: communityId, name: '回跳社区', createdAt: new Date() })
      .run()
    // #123: the community is derived from this activity, not sent by the H5.
    const activityId = seedActivity(context.db, communityId)

    const start = await context.app.request(
      `/auth/wechat/start?activityId=${activityId}&returnTo=${encodeURIComponent(
        activityReturnTo(activityId),
      )}`,
    )
    assert.equal(start.status, 302)
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const callback = await context.app.request(
      `/auth/wechat/callback?state=${state}&code=oauth-code`,
      {
        headers: {
          cookie: `${cookiePair(start, 'll_oauth_nonce')}; ${cookiePair(start, 'll_oauth_return')}`,
        },
      },
    )
    assert.equal(
      callback.headers.get('location'),
      `https://local-life.example.test${activityReturnTo(activityId)}&auth=success#`,
    )
    // Community residence is identity context; it must not create participation.
    assert.equal(context.db.select().from(activityParticipations).all().length, 0)
  } finally {
    context.sqlite.close()
  }
})
