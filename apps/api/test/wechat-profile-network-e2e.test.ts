import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { and, eq } from 'drizzle-orm'
import { API_ROUTES } from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { hashToken } from '../src/auth/security.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import { oauthStates, sessions, users, wechatIdentities } from '../src/db/schema.js'
import {
  masterKeyEnv,
  seedWechatConfig,
  TEST_APP_ID,
  TEST_APP_ID_B,
  TEST_APP_SECRET,
  TEST_APP_SECRET_B,
} from './wechat-fixtures.js'

const WEB_ORIGIN = 'https://local.proto.3cgroup.cn'
const PROFILE_OPENID = 'openid-profile-owner'
const OTHER_OPENID = 'openid-other-owner'
const PROFILE_ACCESS_TOKEN = 'fake-profile-access-token'
const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

function cookiePair(response: Response, name: string): string {
  const value = response.headers.getSetCookie()
    .map((header) => header.split(';', 1)[0] ?? '')
    .find((cookie) => cookie.startsWith(name + '='))
  assert.ok(value, 'missing cookie ' + name)
  return value
}

function cookieValue(pair: string): string {
  return pair.slice(pair.indexOf('=') + 1)
}

function cookieHeader(...pairs: string[]): string {
  return pairs.map((pair) => pair.split(';', 1)[0]).join('; ')
}

function redirectLocation(response: Response): URL {
  const value = response.headers.get('location')
  assert.ok(value, 'missing redirect location')
  return new URL(value)
}

test('real HTTP + SQLite keep base login and resident-consented WeChat profile authorization separate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'local-life-wechat-profile-'))
  const databasePath = join(directory, 'profile.sqlite')
  const { db, sqlite } = createDatabase(databasePath, migrationsFolder)
  const initialConfig = seedWechatConfig(db)
  const tokenCalls: Array<{ appId: string | null; secret: string | null; code: string | null }> = []
  const userInfoCalls: Array<{ openId: string | null; accessToken: string | null }> = []

  const fetcher = (async (input: string | URL | Request) => {
    const url = input instanceof URL ? input : new URL(String(input))
    if (url.pathname === '/sns/oauth2/access_token') {
      const code = url.searchParams.get('code')
      tokenCalls.push({
        appId: url.searchParams.get('appid'),
        secret: url.searchParams.get('secret'),
        code,
      })
      return Response.json({
        access_token:
          code === 'login-code'
            ? 'base-only-access-token'
            : code === 'userinfo-error-code'
              ? 'profile-error-token'
              : code === 'userinfo-mismatch-code'
                ? 'profile-mismatch-token'
                : PROFILE_ACCESS_TOKEN,
        openid:
          code === 'mismatch-code'
            ? OTHER_OPENID
            : code === 'unbound-code'
              ? 'openid-never-bound'
              : PROFILE_OPENID,
        expires_in: 7200,
      })
    }
    if (url.pathname === '/sns/userinfo') {
      const accessToken = url.searchParams.get('access_token')
      userInfoCalls.push({
        openId: url.searchParams.get('openid'),
        accessToken,
      })
      if (accessToken === 'profile-error-token') {
        return Response.json({ errcode: 40003, errmsg: 'invalid openid' })
      }
      return Response.json({
        openid: accessToken === 'profile-mismatch-token' ? OTHER_OPENID : url.searchParams.get('openid'),
        nickname: '街坊的微信昵称',
        headimgurl: 'https://thirdwx.qlogo.cn/mmopen/profile-avatar.png',
        // These unrelated fields deliberately exist at the provider boundary.
        // The application must ignore them and persist only nickname/avatar/time.
        sex: 1,
        province: '广东',
        city: '韶关',
        country: '中国',
      })
    }
    throw new Error('unexpected WeChat provider request: ' + url.pathname)
  }) as typeof fetch

  const config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    WEB_BASE_URL: WEB_ORIGIN + '/',
    TRUSTED_ORIGINS: WEB_ORIGIN,
    AUTH_DEV_ENABLED: 'true',
    ...masterKeyEnv(),
  })
  const app = createApp({ db, config, fetcher, logRequests: false })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = 'http://127.0.0.1:' + address.port

  try {
    // Default resident login continues to request only snsapi_base. It creates
    // the existing identity/session but never calls the profile endpoint.
    const loginStart = await fetch(base + API_ROUTES.authWechatStart, { redirect: 'manual' })
    assert.equal(loginStart.status, 302)
    const loginAuthorize = redirectLocation(loginStart)
    assert.equal(loginAuthorize.searchParams.get('scope'), 'snsapi_base')
    const loginState = loginAuthorize.searchParams.get('state')
    assert.ok(loginState)
    const loginStateRow = db.select().from(oauthStates)
      .where(eq(oauthStates.stateHash, hashToken(loginState))).get()
    assert.equal(loginStateRow?.purpose, 'login')
    assert.equal(loginStateRow?.userId, null)
    const loginNonce = cookiePair(loginStart, 'll_oauth_nonce')
    const loginCallback = await fetch(
      base + '/auth/wechat/callback?state=' + encodeURIComponent(loginState) + '&code=login-code',
      { headers: { cookie: cookieHeader(loginNonce) }, redirect: 'manual' },
    )
    assert.equal(loginCallback.status, 302)
    assert.equal(redirectLocation(loginCallback).searchParams.get('auth'), 'success')
    assert.equal(userInfoCalls.length, 0)

    const sessionCookie = cookiePair(loginCallback, 'll_session')
    const csrfCookie = cookiePair(loginCallback, 'll_csrf')
    const csrfToken = cookieValue(csrfCookie)
    const resident = db
      .select({ id: users.id })
      .from(users)
      .innerJoin(wechatIdentities, eq(wechatIdentities.openId, PROFILE_OPENID))
      .get()
    assert.ok(resident)
    db.update(users).set({ displayName: '居民自己设置的平台昵称' }).where(eq(users.id, resident.id)).run()

    // Reading profile status is passive: no implicit userinfo request.
    const beforeStatus = await fetch(base + API_ROUTES.authWechatProfile, {
      headers: { cookie: cookieHeader(sessionCookie, csrfCookie) },
    })
    assert.equal(beforeStatus.status, 200)
    assert.deepEqual(await beforeStatus.json(), { available: true, authorized: false })
    assert.equal(userInfoCalls.length, 0)

    const unauthenticatedStart = await fetch(base + API_ROUTES.authWechatProfileStart, {
      method: 'POST',
      redirect: 'manual',
    })
    assert.equal(unauthenticatedStart.status, 401)

    const badCsrfStart = await fetch(base + API_ROUTES.authWechatProfileStart, {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        cookie: cookieHeader(sessionCookie, csrfCookie),
        'x-csrf-token': 'not-the-session-token',
      },
      redirect: 'manual',
    })
    assert.equal(badCsrfStart.status, 403)

    const profileStart = await fetch(base + API_ROUTES.authWechatProfileStart, {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        cookie: cookieHeader(sessionCookie, csrfCookie),
        'x-csrf-token': csrfToken,
      },
      redirect: 'manual',
    })
    assert.equal(profileStart.status, 200)
    const profileStartText = await profileStart.text()
    assert.doesNotMatch(profileStartText, /openid|access_token|secret/i)
    const profileStartBody = JSON.parse(profileStartText) as { authorizationUrl: string }
    const profileAuthorize = new URL(profileStartBody.authorizationUrl)
    assert.equal(profileAuthorize.searchParams.get('scope'), 'snsapi_userinfo')
    assert.equal(profileAuthorize.searchParams.get('appid'), TEST_APP_ID)
    const profileState = profileAuthorize.searchParams.get('state')
    assert.ok(profileState)
    const profileNonce = cookiePair(profileStart, 'll_oauth_nonce')
    const profileReturn = cookiePair(profileStart, 'll_oauth_return')
    const stateRow = db.select().from(oauthStates)
      .where(eq(oauthStates.stateHash, hashToken(profileState))).get()
    assert.equal(stateRow?.purpose, 'profile')
    assert.equal(stateRow?.userId, resident.id)
    assert.equal(stateRow?.configId, initialConfig.id)

    // Pinning is tested with a real config switch between start and callback:
    // the old state must use AppID/Secret A, not the newly active B.
    const sessionCountBefore = db.select().from(sessions).all().length
    seedWechatConfig(db, { appId: TEST_APP_ID_B, appSecret: TEST_APP_SECRET_B })
    const profileCallback = await fetch(
      base + '/auth/wechat/callback?state=' + encodeURIComponent(profileState) + '&code=profile-code',
      {
        headers: { cookie: cookieHeader(sessionCookie, csrfCookie, profileNonce, profileReturn) },
        redirect: 'manual',
      },
    )
    assert.equal(profileCallback.status, 302)
    assert.equal(redirectLocation(profileCallback).searchParams.get('wechat_profile'), 'success')
    assert.equal(tokenCalls.at(-1)?.appId, TEST_APP_ID)
    assert.equal(tokenCalls.at(-1)?.secret, TEST_APP_SECRET)
    assert.equal(userInfoCalls.length, 1)
    assert.equal(userInfoCalls[0]?.openId, PROFILE_OPENID)
    assert.equal(userInfoCalls[0]?.accessToken, PROFILE_ACCESS_TOKEN)
    assert.equal(db.select().from(sessions).all().length, sessionCountBefore)
    assert.equal(profileCallback.headers.getSetCookie().some((header) => header.startsWith('ll_session=')), false)

    const savedIdentity = db.select().from(wechatIdentities)
      .where(and(
        eq(wechatIdentities.userId, resident.id),
        eq(wechatIdentities.appId, TEST_APP_ID),
        eq(wechatIdentities.openId, PROFILE_OPENID),
      ))
      .get()
    assert.equal(savedIdentity?.nickname, '街坊的微信昵称')
    assert.equal(savedIdentity?.avatarUrl, 'https://thirdwx.qlogo.cn/mmopen/profile-avatar.png')
    assert.ok(savedIdentity?.profileAuthorizedAt instanceof Date)
    assert.equal(
      db.select({ displayName: users.displayName }).from(users).where(eq(users.id, resident.id)).get()?.displayName,
      '居民自己设置的平台昵称',
    )

    // Restore an active config with the same AppID and prove refresh reads the
    // durable profile. The API response contains no OpenID, token or Secret.
    seedWechatConfig(db)
    const afterStatus = await fetch(base + API_ROUTES.authWechatProfile, {
      headers: { cookie: cookieHeader(sessionCookie, csrfCookie) },
    })
    const afterStatusText = await afterStatus.text()
    assert.equal(afterStatus.status, 200)
    assert.match(afterStatusText, /街坊的微信昵称/)
    assert.match(afterStatusText, /thirdwx\.qlogo\.cn/)
    assert.doesNotMatch(afterStatusText, /openid|access_token|secret|fake-profile-access-token/i)
    assert.equal(userInfoCalls.length, 1)

    // A different OpenID already owned by another platform user is refused
    // before sns/userinfo. It neither updates nor merges that other identity.
    const otherUserId = randomUUID()
    const now = new Date()
    db.insert(users).values({
      id: otherUserId,
      displayName: '另一个居民',
      createdAt: now,
      updatedAt: now,
    }).run()
    db.insert(wechatIdentities).values({
      id: randomUUID(),
      userId: otherUserId,
      appId: TEST_APP_ID,
      openId: OTHER_OPENID,
      unionId: null,
      nickname: null,
      avatarUrl: null,
      profileAuthorizedAt: null,
      createdAt: now,
    }).run()

    const mismatchStart = await fetch(base + API_ROUTES.authWechatProfileStart, {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        cookie: cookieHeader(sessionCookie, csrfCookie),
        'x-csrf-token': csrfToken,
      },
      redirect: 'manual',
    })
    assert.equal(mismatchStart.status, 200)
    const mismatchUrl = new URL(((await mismatchStart.json()) as { authorizationUrl: string }).authorizationUrl)
    const mismatchNonce = cookiePair(mismatchStart, 'll_oauth_nonce')
    const mismatchReturn = cookiePair(mismatchStart, 'll_oauth_return')
    const mismatchCallback = await fetch(
      base + '/auth/wechat/callback?state=' + encodeURIComponent(mismatchUrl.searchParams.get('state')!) + '&code=mismatch-code',
      {
        headers: { cookie: cookieHeader(sessionCookie, csrfCookie, mismatchNonce, mismatchReturn) },
        redirect: 'manual',
      },
    )
    assert.equal(redirectLocation(mismatchCallback).searchParams.get('wechat_profile'), 'identity_mismatch')
    assert.equal(userInfoCalls.length, 1)
    const otherIdentity = db.select().from(wechatIdentities).where(eq(wechatIdentities.userId, otherUserId)).get()
    assert.equal(otherIdentity?.nickname, null)
    assert.equal(otherIdentity?.profileAuthorizedAt, null)

    // An OpenID that belongs to nobody is also refused. Profile consent is
    // never an implicit first-time account-binding operation.
    const unboundStart = await fetch(base + API_ROUTES.authWechatProfileStart, {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        cookie: cookieHeader(sessionCookie, csrfCookie),
        'x-csrf-token': csrfToken,
      },
      redirect: 'manual',
    })
    const unboundUrl = new URL(((await unboundStart.json()) as { authorizationUrl: string }).authorizationUrl)
    const unboundCallback = await fetch(
      base + '/auth/wechat/callback?state=' + encodeURIComponent(unboundUrl.searchParams.get('state')!) + '&code=unbound-code',
      {
        headers: {
          cookie: cookieHeader(sessionCookie, csrfCookie, cookiePair(unboundStart, 'll_oauth_nonce'), cookiePair(unboundStart, 'll_oauth_return')),
        },
        redirect: 'manual',
      },
    )
    assert.equal(redirectLocation(unboundCallback).searchParams.get('wechat_profile'), 'identity_mismatch')
    assert.equal(userInfoCalls.length, 1)
    assert.equal(
      db.select().from(wechatIdentities).where(eq(wechatIdentities.openId, 'openid-never-bound')).get(),
      undefined,
    )

    // Even when the token exchange OpenID belongs to the current resident,
    // sns/userinfo must return the same OpenID before any profile is saved.
    const userInfoMismatchStart = await fetch(base + API_ROUTES.authWechatProfileStart, {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        cookie: cookieHeader(sessionCookie, csrfCookie),
        'x-csrf-token': csrfToken,
      },
      redirect: 'manual',
    })
    const userInfoMismatchUrl = new URL(((await userInfoMismatchStart.json()) as { authorizationUrl: string }).authorizationUrl)
    const userInfoMismatchCallback = await fetch(
      base + '/auth/wechat/callback?state=' + encodeURIComponent(userInfoMismatchUrl.searchParams.get('state')!) + '&code=userinfo-mismatch-code',
      {
        headers: {
          cookie: cookieHeader(
            sessionCookie,
            csrfCookie,
            cookiePair(userInfoMismatchStart, 'll_oauth_nonce'),
            cookiePair(userInfoMismatchStart, 'll_oauth_return'),
          ),
        },
        redirect: 'manual',
      },
    )
    assert.equal(redirectLocation(userInfoMismatchCallback).searchParams.get('wechat_profile'), 'identity_mismatch')
    assert.equal(userInfoCalls.at(-1)?.accessToken, 'profile-mismatch-token')
    const unchangedAfterUserInfoMismatch = db.select().from(wechatIdentities)
      .where(and(
        eq(wechatIdentities.userId, resident.id),
        eq(wechatIdentities.appId, TEST_APP_ID),
        eq(wechatIdentities.openId, PROFILE_OPENID),
      )).get()
    assert.equal(unchangedAfterUserInfoMismatch?.nickname, '街坊的微信昵称')

    // A provider error is not misreported as an identity mismatch and cannot
    // erase the profile that was already saved by an earlier consent.
    const userInfoErrorStart = await fetch(base + API_ROUTES.authWechatProfileStart, {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        cookie: cookieHeader(sessionCookie, csrfCookie),
        'x-csrf-token': csrfToken,
      },
      redirect: 'manual',
    })
    const userInfoErrorUrl = new URL(((await userInfoErrorStart.json()) as { authorizationUrl: string }).authorizationUrl)
    const userInfoErrorCallback = await fetch(
      base + '/auth/wechat/callback?state=' + encodeURIComponent(userInfoErrorUrl.searchParams.get('state')!) + '&code=userinfo-error-code',
      {
        headers: {
          cookie: cookieHeader(
            sessionCookie,
            csrfCookie,
            cookiePair(userInfoErrorStart, 'll_oauth_nonce'),
            cookiePair(userInfoErrorStart, 'll_oauth_return'),
          ),
        },
        redirect: 'manual',
      },
    )
    assert.equal(redirectLocation(userInfoErrorCallback).searchParams.get('wechat_profile'), 'provider_unavailable')
    assert.equal(userInfoCalls.at(-1)?.accessToken, 'profile-error-token')
    const unchangedAfterProviderError = db.select().from(wechatIdentities)
      .where(and(
        eq(wechatIdentities.userId, resident.id),
        eq(wechatIdentities.appId, TEST_APP_ID),
        eq(wechatIdentities.openId, PROFILE_OPENID),
      )).get()
    assert.equal(unchangedAfterProviderError?.nickname, '街坊的微信昵称')

    // Cancellation consumes only this OAuth attempt; the existing session and
    // previously saved profile remain untouched.
    const cancelStart = await fetch(base + API_ROUTES.authWechatProfileStart, {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        cookie: cookieHeader(sessionCookie, csrfCookie),
        'x-csrf-token': csrfToken,
      },
      redirect: 'manual',
    })
    const cancelUrl = new URL(((await cancelStart.json()) as { authorizationUrl: string }).authorizationUrl)
    const cancelState = cancelUrl.searchParams.get('state')!
    const cancelNonce = cookiePair(cancelStart, 'll_oauth_nonce')
    const cancelReturn = cookiePair(cancelStart, 'll_oauth_return')
    const cancelCallback = await fetch(
      base + '/auth/wechat/callback?state=' + encodeURIComponent(cancelUrl.searchParams.get('state')!),
      {
        headers: { cookie: cookieHeader(sessionCookie, csrfCookie, cancelNonce, cancelReturn) },
        redirect: 'manual',
      },
    )
    assert.equal(redirectLocation(cancelCallback).searchParams.get('wechat_profile'), 'cancelled')
    assert.equal(cancelCallback.headers.getSetCookie().some((header) => header.startsWith('ll_session=')), false)
    assert.ok(db.select().from(oauthStates)
      .where(eq(oauthStates.stateHash, hashToken(cancelState))).get()?.consumedAt)
    assert.equal(userInfoCalls.length, 3)
    const unchangedAfterCancel = db.select().from(wechatIdentities)
      .where(and(
        eq(wechatIdentities.userId, resident.id),
        eq(wechatIdentities.appId, TEST_APP_ID),
        eq(wechatIdentities.openId, PROFILE_OPENID),
      )).get()
    assert.equal(unchangedAfterCancel?.nickname, '街坊的微信昵称')

    // A state for user A cannot be completed with user B's current session.
    const switchStart = await fetch(base + API_ROUTES.authWechatProfileStart, {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        cookie: cookieHeader(sessionCookie, csrfCookie),
        'x-csrf-token': csrfToken,
      },
      redirect: 'manual',
    })
    const switchUrl = new URL(((await switchStart.json()) as { authorizationUrl: string }).authorizationUrl)
    const switchNonce = cookiePair(switchStart, 'll_oauth_nonce')
    const switchReturn = cookiePair(switchStart, 'll_oauth_return')
    const devCsrfResponse = await fetch(base + API_ROUTES.authCsrf)
    const devCsrfCookie = cookiePair(devCsrfResponse, 'll_csrf')
    const devCsrfBody = (await devCsrfResponse.json()) as { csrfToken: string }
    const secondLogin = await fetch(base + '/auth/dev/login', {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        cookie: cookieHeader(devCsrfCookie),
        'x-csrf-token': devCsrfBody.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ displayName: '切换后的账户' }),
      redirect: 'manual',
    })
    assert.equal(secondLogin.status, 200)
    const secondSession = cookiePair(secondLogin, 'll_session')
    const secondCsrf = cookiePair(secondLogin, 'll_csrf')
    const stateCountBeforeUnboundAccountStart = db.select().from(oauthStates).all().length
    const unboundAccountStart = await fetch(base + API_ROUTES.authWechatProfileStart, {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        cookie: cookieHeader(secondSession, secondCsrf),
        'x-csrf-token': cookieValue(secondCsrf),
      },
      redirect: 'manual',
    })
    assert.equal(unboundAccountStart.status, 409)
    assert.equal(
      db.select().from(oauthStates).all().length,
      stateCountBeforeUnboundAccountStart,
      'a phone-only account cannot create a profile-consent OAuth state',
    )
    const callsBeforeSwitchedCallback = tokenCalls.length
    const switchedCallback = await fetch(
      base + '/auth/wechat/callback?state=' + encodeURIComponent(switchUrl.searchParams.get('state')!) + '&code=profile-code',
      {
        headers: { cookie: cookieHeader(secondSession, secondCsrf, switchNonce, switchReturn) },
        redirect: 'manual',
      },
    )
    assert.equal(redirectLocation(switchedCallback).searchParams.get('wechat_profile'), 'session_mismatch')
    assert.equal(tokenCalls.length, callsBeforeSwitchedCallback)

    // Expired and replayed profile states are rejected before provider calls.
    const expiredStart = await fetch(base + API_ROUTES.authWechatProfileStart, {
      method: 'POST',
      headers: {
        origin: WEB_ORIGIN,
        cookie: cookieHeader(sessionCookie, csrfCookie),
        'x-csrf-token': csrfToken,
      },
      redirect: 'manual',
    })
    const expiredUrl = new URL(((await expiredStart.json()) as { authorizationUrl: string }).authorizationUrl)
    const expiredState = expiredUrl.searchParams.get('state')!
    const expiredNonce = cookiePair(expiredStart, 'll_oauth_nonce')
    const expiredReturn = cookiePair(expiredStart, 'll_oauth_return')
    db.update(oauthStates)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(oauthStates.stateHash, hashToken(expiredState)))
      .run()
    const callsBeforeExpiredCallback = tokenCalls.length
    const expiredCallback = await fetch(
      base + '/auth/wechat/callback?state=' + encodeURIComponent(expiredState) + '&code=profile-code',
      {
        headers: { cookie: cookieHeader(sessionCookie, csrfCookie, expiredNonce, expiredReturn) },
        redirect: 'manual',
      },
    )
    assert.equal(redirectLocation(expiredCallback).searchParams.get('wechat_profile'), 'state_invalid')
    assert.equal(tokenCalls.length, callsBeforeExpiredCallback)

    const replayCallback = await fetch(
      base + '/auth/wechat/callback?state=' + encodeURIComponent(profileState) + '&code=profile-code',
      {
        headers: { cookie: cookieHeader(sessionCookie, csrfCookie, profileNonce, profileReturn) },
        redirect: 'manual',
      },
    )
    assert.equal(redirectLocation(replayCallback).searchParams.get('wechat_profile'), 'state_invalid')
    assert.equal(userInfoCalls.length, 3)

    const finalStatus = await fetch(base + API_ROUTES.authWechatProfile, {
      headers: { cookie: cookieHeader(sessionCookie, csrfCookie) },
    })
    const finalStatusText = await finalStatus.text()
    assert.equal(finalStatus.status, 200)
    assert.doesNotMatch(finalStatusText, /openid|access_token|secret/i)

    // The pre-existing identity mapping still owns its OpenID; this feature
    // adds no token/Secret storage and does not persist sex/region/location.
    const identityColumns = sqlite.prepare('PRAGMA table_info(wechat_identities)').all() as Array<{ name: string }>
    assert.equal(identityColumns.some((column) => ['sex', 'province', 'city', 'country', 'location'].includes(column.name)), false)
    const databaseBytes = readFileSync(databasePath)
    assert.equal(databaseBytes.includes(Buffer.from(TEST_APP_SECRET)), false)
    assert.equal(databaseBytes.includes(Buffer.from(TEST_APP_SECRET_B)), false)
    assert.equal(databaseBytes.includes(Buffer.from(PROFILE_ACCESS_TOKEN)), false)
    assert.equal(databaseBytes.includes(Buffer.from('base-only-access-token')), false)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
