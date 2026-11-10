import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { request as nodeRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { serve } from '@hono/node-server'
import {
  API_ERROR_CODES,
  API_ROUTES,
  wechatJsSdkSignatureResponseSchema,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import { signWechatJsSdk, validatedWechatPageUrl } from '../src/wechat/js-sdk.js'
import {
  TEST_APP_ID, TEST_APP_ID_B, TEST_APP_SECRET, TEST_APP_SECRET_B,
  masterKeyEnv, seedWechatConfig,
} from './wechat-fixtures.js'

const MIGRATIONS = fileURLToPath(new URL('../db/migrations', import.meta.url))
const WEB = 'https://local.proto.3cgroup.cn'
const ADMIN = 'https://local-admin.proto.3cgroup.cn'
const PAGE = WEB + '/community/activity/silver-neighborhood?invite=some%20code'
const ROUTE = API_ROUTES.wechatJsSdkSignature
const START_TIME = 1_750_000_000_000

type Reply = { status: number; headers: Headers; body: Record<string, unknown>; raw: string }
type ProviderState = {
  calls: Array<{ endpoint: 'token' | 'ticket'; appId: string }>
  rejectNext: number | null
  rejectNextTicket: number | null
  tokenLifetime: number
  ticketLifetime: number
  waitTicketA: Promise<void> | null
  appATicketRequested: (() => void) | null
}

function makeHarness(options: { active?: boolean; masterKey?: boolean; provider?: Partial<ProviderState> } = {}) {
  const { db, sqlite } = createDatabase(':memory:', MIGRATIONS)
  const config = loadConfig({
    NODE_ENV: 'production',
    WEB_BASE_URL: WEB + '/',
    TRUSTED_ORIGINS: WEB + ',' + ADMIN,
    AUTH_DEV_ENABLED: 'false',
    ...(options.masterKey === false ? {} : masterKeyEnv()),
  })
  if (options.active !== false) seedWechatConfig(db)
  let clockMs = START_TIME
  const state: ProviderState = {
    calls: [],
    rejectNext: null,
    rejectNextTicket: null,
    tokenLifetime: 7200,
    ticketLifetime: 7200,
    waitTicketA: null,
    appATicketRequested: null,
    ...options.provider,
  }
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://api.weixin.qq.com')
    if (url.pathname === '/cgi-bin/token') {
      const appId = url.searchParams.get('appid') ?? ''
      const secret = url.searchParams.get('secret')
      assert.equal(url.searchParams.get('grant_type'), 'client_credential')
      assert.equal(secret, appId === TEST_APP_ID ? TEST_APP_SECRET : TEST_APP_SECRET_B)
      state.calls.push({ endpoint: 'token', appId })
      if (state.rejectNext !== null) {
        const error = state.rejectNext
        state.rejectNext = null
        return Response.json({ errcode: error, errmsg: 'upstream test secret=' + secret })
      }
      return Response.json({
        access_token: `token:${appId}:${state.calls.filter(c => c.endpoint === 'token').length}`,
        expires_in: state.tokenLifetime,
      })
    }
    if (url.pathname === '/cgi-bin/ticket/getticket') {
      assert.equal(url.searchParams.get('type'), 'jsapi')
      const token = url.searchParams.get('access_token') ?? ''
      const appId = token.split(':')[1] ?? ''
      assert.ok(appId === TEST_APP_ID || appId === TEST_APP_ID_B)
      state.calls.push({ endpoint: 'ticket', appId })
      if (state.rejectNextTicket !== null) {
        const error = state.rejectNextTicket
        state.rejectNextTicket = null
        return Response.json({ errcode: error, errmsg: 'upstream ticket=' + token })
      }
      if (appId === TEST_APP_ID && state.waitTicketA) {
        state.appATicketRequested?.()
        await state.waitTicketA
      }
      if (state.rejectNext !== null) {
        const error = state.rejectNext
        state.rejectNext = null
        return Response.json({ errcode: error, errmsg: 'upstream ticket=' + token })
      }
      return Response.json({
        errcode: 0,
        ticket: `ticket:${appId}:${state.calls.filter(c => c.endpoint === 'ticket').length}`,
        expires_in: state.ticketLifetime,
      })
    }
    throw new Error('unexpected WeChat fetch path')
  }) as typeof fetch
  const app = createApp({ db, config, fetcher, logRequests: false, now: () => new Date(clockMs) })
  let server: ReturnType<typeof serve> | undefined
  let base: string | undefined

  async function start() {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!server.listening) await once(server, 'listening')
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  }

  async function post(payload: unknown, origin: string | null = WEB, path: string = ROUTE) : Promise<Reply> {
    if (!base) throw new Error('server has not started')
    const body = JSON.stringify(payload)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    }
    if (origin !== null) headers.origin = origin
    // Real network HTTP on loopback, independent of workstation proxy settings.
    return new Promise((resolve, reject) => {
      const req = nodeRequest(base + path, { method: 'POST', headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode ?? 0,
            headers: new Headers(res.headers as Record<string, string>),
            body: JSON.parse(raw) as Record<string, unknown>,
            raw,
          })
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end(body)
    })
  }

  async function close() {
    if (server) await new Promise<void>((resolve, reject) =>
      server!.close((error) => error ? reject(error) : resolve()))
    sqlite.close()
  }

  return {
    db, config, state, start, post, close,
    setClockMs(value: number) { clockMs = value },
    advanceMs(ms: number) { clockMs += ms },
  }
}

async function rejectsWith(
  result: Reply,
  status: number,
  code: string,
  secrets: string[] = [TEST_APP_SECRET, TEST_APP_SECRET_B],
) {
  assert.equal(result.status, status, result.raw)
  const error = result.body.error as { code: string; message: string }
  assert.equal(error.code, code)
  for (const secret of secrets) assert.ok(!result.raw.includes(secret), 'secret leaked')
  assert.ok(!result.raw.includes('token:'), 'access token leaked')
  assert.ok(!result.raw.includes('ticket:'), 'jsapi_ticket leaked')
}

test('signature reference vector and hash-stripped resident URL validation', () => {
  const signature = signWechatJsSdk(
    'test-ticket',
    '00112233445566778899aabbccddeeff',
    1_500_000_000,
    WEB + '/community?activityId=abc%20def',
  )
  assert.equal(signature, 'ed31a3af9b1f0aa8b91a35f754c7b6a999d81fef')
  assert.equal(validatedWechatPageUrl(PAGE + '#/profile', WEB + '/'), PAGE)
  assert.equal(validatedWechatPageUrl(WEB + '/?x=%E4%B8%AD#/', WEB + '/'), WEB + '/?x=%E4%B8%AD')
  for (const rejected of [
    'https://evil.example.com/', ADMIN + '/', 'http://local.proto.3cgroup.cn/',
    'ftp://local.proto.3cgroup.cn/', WEB + '.evil.com/',
    'https://admin:password@local.proto.3cgroup.cn/', WEB + '/api/healthz',
    WEB + '/api', WEB + '/foo\\bar', WEB + '/\nprofile',
    '/relative', '//local.proto.3cgroup.cn/path', '', ' https://local.proto.3cgroup.cn/',
  ]) {
    assert.throws(() => validatedWechatPageUrl(rejected, WEB + '/'), { status: 400 })
  }
})

test('real TCP HTTP: no login needed, exact response fields, signature algorithm, reused cache and nonce', async () => {
  const h = makeHarness()
  try {
    await h.start()
    const one = await h.post({ url: PAGE + '#/my-list' })
    assert.equal(one.status, 200)
    const first = wechatJsSdkSignatureResponseSchema.parse(one.body)
    assert.equal(first.appId, TEST_APP_ID)
    assert.equal(first.timestamp, START_TIME / 1000)
    assert.equal(one.headers.get('cache-control'), 'no-store')
    const stringToSign = `jsapi_ticket=ticket:${TEST_APP_ID}:1&noncestr=${first.nonceStr}&timestamp=${first.timestamp}&url=${PAGE}`
    assert.equal(first.signature, createHash('sha1').update(stringToSign).digest('hex'))
    const two = await h.post({ url: PAGE + '#/something-else' })
    assert.equal(two.status, 200)
    assert.notEqual(two.body.nonceStr, one.body.nonceStr)
    assert.deepEqual(Object.keys(one.body).sort(), ['appId', 'timestamp', 'nonceStr', 'signature'].sort())
    assert.deepEqual(h.state.calls, [
      { endpoint: 'token', appId: TEST_APP_ID },
      { endpoint: 'ticket', appId: TEST_APP_ID },
    ])
    for (const value of [TEST_APP_SECRET, 'token:', 'ticket:', 'jsapi_ticket']) {
      assert.ok(!one.raw.includes(value), `sensitive field ${value} must not appear`)
    }
  } finally { await h.close() }
})

test('real TCP HTTP: URL, Origin, content and inactive provider reject before any WeChat fetch', async () => {
  const h = makeHarness({ active: false })
  try {
    await h.start()
    await rejectsWith(await h.post({ url: PAGE }), 503, API_ERROR_CODES.wechatJsSdkUnavailable)
    const invalidUrls = [
      ADMIN + '/', WEB.replace('https:', 'http:') + '/', WEB + '.evil/', 'bad-value',
      WEB + '/api/admin/communities', WEB + '/\\evil',
    ]
    for (const url of invalidUrls) {
      await rejectsWith(await h.post({ url }), 400, API_ERROR_CODES.invalidRequest)
    }
    for (const origin of [ADMIN, 'https://malicious.example', 'null', null]) {
      await rejectsWith(await h.post({ url: PAGE }, origin), 403, API_ERROR_CODES.forbidden)
    }
    await rejectsWith(await h.post({ url: PAGE, access_token: 'attempt' }), 400, API_ERROR_CODES.invalidRequest)
    await rejectsWith(await h.post({}), 400, API_ERROR_CODES.invalidRequest)
    assert.equal(h.state.calls.length, 0)
  } finally { await h.close() }
})

test('real TCP HTTP: concurrent signatures single-flight both remote calls', async () => {
  const h = makeHarness()
  try {
    await h.start()
    const results = await Promise.all(
      Array.from({ length: 24 }, () => h.post({ url: PAGE })),
    )
    const nonces = results.map(r => wechatJsSdkSignatureResponseSchema.parse(r.body).nonceStr)
    assert.ok(results.every(r => r.status === 200))
    assert.equal(new Set(nonces).size, 24)
    assert.deepEqual(h.state.calls.map(x => x.endpoint), ['token', 'ticket'])
  } finally { await h.close() }
})

test('real TCP HTTP: ticket refreshes early, token is reused until its own early expiry', async () => {
  const h = makeHarness({ provider: { ticketLifetime: 100, tokenLifetime: 7200 } })
  try {
    await h.start()
    assert.equal((await h.post({ url: PAGE })).status, 200)
    h.advanceMs(89_000)
    assert.equal((await h.post({ url: PAGE })).status, 200)
    assert.deepEqual(h.state.calls.map(x => x.endpoint), ['token', 'ticket'])
    h.advanceMs(2_000)
    assert.equal((await h.post({ url: PAGE })).status, 200)
    assert.deepEqual(h.state.calls.map(x => x.endpoint), ['token', 'ticket', 'ticket'])
    h.advanceMs(6_900_000)
    assert.equal((await h.post({ url: PAGE })).status, 200)
    assert.deepEqual(h.state.calls.map(x => x.endpoint), ['token', 'ticket', 'ticket', 'token', 'ticket'])
  } finally { await h.close() }
})

test('real TCP HTTP: hot config switch invalidates ticket/token cache; old in-flight result is rejected', async () => {
  let release!: () => void
  let requested!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const seen = new Promise<void>(resolve => { requested = resolve })
  const h = makeHarness({ provider: { waitTicketA: hold, appATicketRequested: requested } })
  try {
    await h.start()
    const pendingOld = h.post({ url: PAGE })
    await seen
    seedWechatConfig(h.db, { appId: TEST_APP_ID_B, appSecret: TEST_APP_SECRET_B })
    const next = await h.post({ url: PAGE })
    assert.equal(next.status, 200)
    assert.equal(next.body.appId, TEST_APP_ID_B)
    release()
    await rejectsWith(await pendingOld, 503, API_ERROR_CODES.wechatJsSdkUnavailable)
    assert.deepEqual(h.state.calls, [
      { endpoint: 'token', appId: TEST_APP_ID },
      { endpoint: 'ticket', appId: TEST_APP_ID },
      { endpoint: 'token', appId: TEST_APP_ID_B },
      { endpoint: 'ticket', appId: TEST_APP_ID_B },
    ])
    assert.equal((await h.post({ url: PAGE })).status, 200)
    assert.equal(h.state.calls.length, 4)
  } finally {
    release()
    await h.close()
  }
})

test('real TCP HTTP: provider errors are redacted, backoff suppresses retries, then recovers', async () => {
  const h = makeHarness()
  try {
    await h.start()
    h.state.rejectNext = 45009
    const rate = await h.post({ url: PAGE })
    await rejectsWith(rate, 429, API_ERROR_CODES.rateLimited)
    assert.equal(h.state.calls.length, 1)
    await rejectsWith(await h.post({ url: PAGE }), 429, API_ERROR_CODES.rateLimited)
    assert.equal(h.state.calls.length, 1, 'cooldown must avoid a second token fetch')
    h.advanceMs(15_001)
    assert.equal((await h.post({ url: PAGE })).status, 200)
    assert.equal(h.state.calls.length, 3)

    h.state.ticketLifetime = 1
    // Force a new configuration version so a fresh ticket is requested.
    seedWechatConfig(h.db, { appId: TEST_APP_ID_B, appSecret: TEST_APP_SECRET_B })
    h.state.rejectNext = 40001
    await rejectsWith(await h.post({ url: PAGE }), 503, API_ERROR_CODES.wechatJsSdkUnavailable)
    assert.equal((await h.post({ url: PAGE })).status, 503, 'backoff applies to credential errors too')
  } finally { await h.close() }
})

test('real TCP HTTP: ticket rate limit is redacted and refresh retries only after cooldown', async () => {
  const h = makeHarness()
  try {
    await h.start()
    h.state.rejectNextTicket = 45009
    await rejectsWith(await h.post({ url: PAGE }), 429, API_ERROR_CODES.rateLimited)
    assert.deepEqual(h.state.calls.map(c => c.endpoint), ['token', 'ticket'])
    await rejectsWith(await h.post({ url: PAGE }), 429, API_ERROR_CODES.rateLimited)
    assert.equal(h.state.calls.length, 2)
    h.advanceMs(15_001)
    assert.equal((await h.post({ url: PAGE })).status, 200)
    assert.deepEqual(h.state.calls.map(c => c.endpoint), ['token', 'ticket', 'token', 'ticket'])
  } finally { await h.close() }
})

test('real TCP HTTP: concurrent early refreshes request just one new token and ticket', async () => {
  const h = makeHarness()
  try {
    await h.start()
    assert.equal((await h.post({ url: PAGE })).status, 200)
    h.advanceMs(6_901_000)
    const results = await Promise.all(Array.from({ length: 16 }, () => h.post({ url: PAGE })))
    assert.ok(results.every(r => r.status === 200))
    assert.deepEqual(h.state.calls.map(c => c.endpoint), ['token', 'ticket', 'token', 'ticket'])
  } finally { await h.close() }
})

test('real TCP HTTP: missing or wrong master key fails closed without any upstream calls', async () => {
  const missing = makeHarness({ masterKey: false })
  const wrong = makeHarness()
  try {
    await missing.start()
    await rejectsWith(await missing.post({ url: PAGE }), 503, API_ERROR_CODES.wechatJsSdkUnavailable)
    assert.equal(missing.state.calls.length, 0)
    await wrong.start()
    // Mismatch between DB encryption key and runtime decryption key.
    wrong.config.wechatConfigMasterKey!.key.set(randomBytes(32))
    await rejectsWith(await wrong.post({ url: PAGE }), 503, API_ERROR_CODES.wechatJsSdkUnavailable)
    assert.equal(wrong.state.calls.length, 0)
  } finally {
    await missing.close()
    await wrong.close()
  }
})
