import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  WECHAT_ADMIN_ROUTES,
  wechatAdminActivatePath,
  wechatAdminVerifyPath,
  type WechatConfigSummary,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/security.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import { staffAccounts, users, wechatIdentities } from '../src/db/schema.js'
import { resolveWechatRuntimeConfig } from '../src/wechat/runtime.js'

/**
 * Independent network / durable-storage acceptance for #113.
 *
 * Uses real TCP HTTP (not app.request), production-like session/Cookie/Origin
 * rules, persisted migrated SQLite and an actual SQLite online backup.
 * Only the remote WeChat boundary is simulated; real WeChat OAuth is NOT
 * claimed here. No real credentials or production endpoints are called.
 */
const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ADMIN_ORIGIN = 'https://local-admin.proto.3cgroup.cn'
const WEB_ORIGIN = 'https://local.proto.3cgroup.cn'
const APP_A = 'wxaaaaaaaaaaaaaaaa'
const APP_B = 'wxbbbbbbbbbbbbbbbb'
const SECRET_A = 'fake-secret-A-for-network-acceptance'
const SECRET_B = 'fake-secret-B-for-network-acceptance'
const PASSWORD = 'Test-Only-Admin-Strong-Password!'
const MASTER = randomBytes(32)

interface Session {
  cookie: string
  csrfToken: string
}

function pair(response: Response, name: string): string {
  const value = response.headers.getSetCookie()
    .map((header) => header.split(';', 1)[0] ?? '')
    .find((cookie) => cookie.startsWith(name + '='))
  assert.ok(value, 'missing cookie ' + name)
  return value
}

async function errorCode(response: Response, status: number, code: string): Promise<void> {
  assert.equal(response.status, status)
  const body = (await response.json()) as { error?: { code: string } }
  assert.equal(body.error?.code, code)
}

test('real TCP admin HTTP, credential switch, in-flight OAuth and SQLite backup restore', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'll-wechat-network-'))
  const databasePath = join(directory, 'source.sqlite')
  const backupPath = join(directory, 'backup.sqlite')
  const connection = createDatabase(databasePath, migrationsFolder)
  const { db, sqlite } = connection
  const oauthRequests: Array<{ appId: string; secret: string }> = []
  const tokenRequests: string[] = []

  const wechatBoundary = (async (input: string | URL) => {
    const url = input instanceof URL ? input : new URL(String(input))
    if (url.pathname === '/cgi-bin/token') {
      const appId = url.searchParams.get('appid') ?? ''
      const secret = url.searchParams.get('secret') ?? ''
      tokenRequests.push(appId)
      const valid = (appId === APP_A && secret === SECRET_A) ||
        (appId === APP_B && secret === SECRET_B)
      return Response.json(valid
        ? { access_token: 'fake-provider-access-token', expires_in: 7200 }
        : { errcode: 40125, errmsg: 'fake credentials rejected' })
    }
    if (url.pathname === '/sns/oauth2/access_token') {
      const appId = url.searchParams.get('appid') ?? ''
      const secret = url.searchParams.get('secret') ?? ''
      oauthRequests.push({ appId, secret })
      assert.equal(appId, APP_A, 'in-flight OAuth must stay bound to its initial AppID')
      assert.equal(secret, SECRET_A, 'in-flight OAuth must not use the new secret')
      return Response.json({ openid: 'fake-old-provider-openid' })
    }
    throw new Error('unexpected external network request')
  }) as typeof fetch

  const config = loadConfig({
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    WEB_BASE_URL: WEB_ORIGIN + '/',
    TRUSTED_ORIGINS: [WEB_ORIGIN, ADMIN_ORIGIN].join(','),
    AUTH_DEV_ENABLED: 'false',
    WECHAT_CONFIG_MASTER_KEY: MASTER.toString('base64'),
    WECHAT_CONFIG_KEY_ID: 'v1',
  })

  const now = new Date()
  const adminId = randomUUID()
  const operatorId = randomUUID()
  const seedStaff = async (id: string, role: 'admin' | 'operator', username: string) => {
    db.insert(users).values({ id, displayName: username, createdAt: now, updatedAt: now }).run()
    db.insert(staffAccounts).values({
      id: randomUUID(), userId: id, username, role, status: 'active',
      passwordHash: await hashPassword(PASSWORD), createdAt: now, updatedAt: now,
    }).run()
  }

  let server: ReturnType<typeof serve> | undefined
  try {
    await seedStaff(adminId, 'admin', 'network.admin')
    await seedStaff(operatorId, 'operator', 'network.operator')

    const app = createApp({ db, config, fetcher: wechatBoundary, logRequests: false })
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!server.listening) await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = 'http://127.0.0.1:' + address.port

    const login = async (username: string): Promise<Session> => {
      const first = await fetch(base + '/auth/csrf')
      assert.equal(first.status, 200)
      const csrf = (await first.json()) as { csrfToken: string }
      const response = await fetch(base + '/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'origin': ADMIN_ORIGIN,
          'cookie': pair(first, 'll_csrf'), 'x-csrf-token': csrf.csrfToken,
        },
        body: JSON.stringify({ username, password: PASSWORD }),
      })
      assert.equal(response.status, 200)
      const body = (await response.json()) as { csrfToken: string }
      return {
        cookie: [pair(response, 'll_session'), pair(response, 'll_csrf')].join('; '),
        csrfToken: body.csrfToken,
      }
    }

    const admin = await login('network.admin')
    const operator = await login('network.operator')
    const send = (method: string, path: string, options: {
      session?: Session, body?: unknown, origin?: string, csrf?: string
    } = {}) => {
      const headers: Record<string, string> = {}
      if (options.session) {
        headers.cookie = options.session.cookie
        if (method !== 'GET') {
          headers.origin = options.origin ?? ADMIN_ORIGIN
          headers['x-csrf-token'] = options.csrf ?? options.session.csrfToken
        }
      }
      if (options.body !== undefined) headers['content-type'] = 'application/json'
      return fetch(base + path, {
        method, headers, redirect: 'manual',
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      })
    }

    await errorCode(
      await send('GET', WECHAT_ADMIN_ROUTES.config), 401, API_ERROR_CODES.unauthorized,
    )
    await errorCode(
      await send('GET', WECHAT_ADMIN_ROUTES.config, { session: operator }),
      403, API_ERROR_CODES.forbidden,
    )
    await errorCode(
      await send('POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
        session: admin, origin: 'https://attacker.invalid',
        body: { appId: APP_A, appSecret: SECRET_A, accountType: 'test' },
      }),
      403, API_ERROR_CODES.forbidden,
    )
    await errorCode(
      await send('POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
        session: admin, csrf: 'invalid-token',
        body: { appId: APP_A, appSecret: SECRET_A, accountType: 'test' },
      }),
      403, API_ERROR_CODES.forbidden,
    )

    async function saveAndVerify(appId: string, secret: string): Promise<WechatConfigSummary> {
      const saved = await send('POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
        session: admin, body: { appId, appSecret: secret, accountType: 'test' },
      })
      assert.equal(saved.status, 200)
      const savedText = await saved.text()
      assert.equal(savedText.includes(secret), false)
      const item = (JSON.parse(savedText) as { config: WechatConfigSummary }).config
      const verified = await send('POST', wechatAdminVerifyPath(item.id), {
        session: admin, body: { expectedUpdatedAt: item.updatedAt },
      })
      assert.equal(verified.status, 200)
      const verifiedText = await verified.text()
      assert.equal(verifiedText.includes(secret), false)
      assert.equal(verifiedText.includes('fake-provider-access-token'), false)
      return (JSON.parse(verifiedText) as { config: WechatConfigSummary }).config
    }

    async function activate(item: WechatConfigSummary): Promise<void> {
      const response = await send('POST', wechatAdminActivatePath(item.id), {
        session: admin,
        body: { expectedUpdatedAt: item.updatedAt, confirm: true },
      })
      assert.equal(response.status, 200)
    }

    const a = await saveAndVerify(APP_A, SECRET_A)
    await activate(a)
    const methodsBefore = await send('GET', '/auth/methods')
    assert.equal(methodsBefore.status, 200)
    assert.equal(((await methodsBefore.json()) as { wechat: boolean }).wechat, true)

    // Obtain an actual set-cookie header from the network server. Start is
    // intentionally before switching the active provider.
    const oauthStart = await send('GET', '/auth/wechat/start')
    assert.equal(oauthStart.status, 302)
    const authorization = new URL(oauthStart.headers.get('location') ?? '')
    assert.equal(authorization.hostname, 'open.weixin.qq.com')
    assert.equal(authorization.searchParams.get('appid'), APP_A)
    const state = authorization.searchParams.get('state')
    assert.ok(state)
    const nonce = pair(oauthStart, 'll_oauth_nonce')

    // A failed candidate must not disturb the existing active provider.
    const badSave = await send('POST', WECHAT_ADMIN_ROUTES.saveCandidate, {
      session: admin,
      body: { appId: APP_B, appSecret: 'intentionally-wrong-secret', accountType: 'test' },
    })
    assert.equal(badSave.status, 200)
    const bad = (await badSave.json()) as { config: WechatConfigSummary }
    await errorCode(await send('POST', wechatAdminVerifyPath(bad.config.id), {
      session: admin, body: { expectedUpdatedAt: bad.config.updatedAt },
    }), 409, API_ERROR_CODES.wechatConfigVerifyFailed)
    assert.equal((resolveWechatRuntimeConfig(db, config.wechatConfigMasterKey).ok), true)

    const b = await saveAndVerify(APP_B, SECRET_B)
    await activate(b)
    const current = resolveWechatRuntimeConfig(db, config.wechatConfigMasterKey)
    assert.ok(current.ok)
    if (current.ok) assert.equal(current.config.appId, APP_B)

    const callback = await fetch(base + '/auth/wechat/callback?state=' +
      encodeURIComponent(state) + '&code=old-code', {
        headers: { cookie: nonce }, redirect: 'manual',
      })
    assert.equal(callback.status, 302)
    assert.match(callback.headers.get('location') ?? '', /auth=success/)
    assert.equal(oauthRequests.length, 1)
    assert.equal(oauthRequests[0]?.appId, APP_A)
    assert.equal(tokenRequests.includes(APP_A), true)
    assert.equal(tokenRequests.includes(APP_B), true)

    const mapped = db.select().from(wechatIdentities)
      .where(eq(wechatIdentities.appId, APP_A)).all()
    assert.equal(mapped.length, 1)
    assert.equal(mapped[0]?.openId, 'fake-old-provider-openid')
    assert.equal(
      db.select().from(wechatIdentities).where(eq(wechatIdentities.appId, APP_B)).all().length,
      0,
    )

    // A one-time OAuth state can never be used to create a second identity.
    const replay = await fetch(base + '/auth/wechat/callback?state=' +
      encodeURIComponent(state) + '&code=old-code', {
        headers: { cookie: nonce }, redirect: 'manual',
      })
    assert.equal(replay.status, 302)
    assert.doesNotMatch(replay.headers.get('location') ?? '', /auth=success/)
    assert.equal(oauthRequests.length, 1)

    const raw = sqlite.prepare('SELECT app_secret_ciphertext FROM wechat_oauth_configs').all() as
      Array<{ app_secret_ciphertext: string }>
    assert.equal(raw.length >= 2, true)
    for (const row of raw) {
      assert.equal(row.app_secret_ciphertext.includes(SECRET_A), false)
      assert.equal(row.app_secret_ciphertext.includes(SECRET_B), false)
    }

    // Back up a live WAL-mode SQLite database, then open the backup as an
    // independent process would. Correct key restores the provider; wrong
    // key cannot decrypt even if its keyId string matches.
    await sqlite.backup(backupPath)
    const restored = createDatabase(backupPath, migrationsFolder)
    try {
      const healthy = resolveWechatRuntimeConfig(restored.db, config.wechatConfigMasterKey)
      assert.ok(healthy.ok)
      if (healthy.ok) assert.equal(healthy.config.appId, APP_B)
      const wrong = resolveWechatRuntimeConfig(restored.db, {
        key: randomBytes(32), keyId: 'v1',
      })
      assert.equal(wrong.ok, false)
      if (!wrong.ok) assert.equal(wrong.reason, 'decrypt_failed')
      assert.equal(restored.sqlite.pragma('quick_check', { simple: true }), 'ok')
    } finally {
      restored.sqlite.close()
    }
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve())
      })
    }
    sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
