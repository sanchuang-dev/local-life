import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WECHAT_TOKEN_ENDPOINT,
  WECHAT_VERIFY_TIMEOUT_MS,
  verifyWechatCredentials,
  wechatVerifyFailureMessage,
} from '../src/wechat/verify.js'

/**
 * Boundary tests for the REAL WeChat connection check (#113 T2).
 *
 * Only `fetch` is stubbed, exactly at the injection point `createApp` exposes.
 * Everything else — URL construction, timeout wiring, errcode mapping, message
 * wording and the rule that an `access_token` never escapes — is the production
 * code path.
 */

const APP_ID = 'wx1234567890abcdef'
const APP_SECRET = 'fake-app-secret-for-tests-0123456789'

interface Call {
  url: URL
  init?: RequestInit
}

function stub(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input))
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return { fetcher, calls }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('a successful token response proves the credentials without exposing the token', async () => {
  const { fetcher, calls } = stub(() =>
    json(200, { access_token: 'ACCESS-TOKEN-SHOULD-NEVER-ESCAPE', expires_in: 7200 }),
  )

  const outcome = await verifyWechatCredentials(fetcher, { appId: APP_ID, appSecret: APP_SECRET })

  assert.deepEqual(outcome, { ok: true })
  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.equal(call.url.origin + call.url.pathname, WECHAT_TOKEN_ENDPOINT)
  assert.equal(call.url.searchParams.get('grant_type'), 'client_credential')
  assert.equal(call.url.searchParams.get('appid'), APP_ID)
  // The secret is necessarily in the upstream query (WeChat's protocol), but it
  // must never appear in the outcome returned to callers.
  assert.equal(call.url.searchParams.get('secret'), APP_SECRET)
  assert.equal(JSON.stringify(outcome).includes(APP_SECRET), false)
  assert.equal(JSON.stringify(outcome).includes('ACCESS-TOKEN-SHOULD-NEVER-ESCAPE'), false)
})

test('the provider request carries the 10 s abort signal', async () => {
  const { fetcher, calls } = stub(() => json(200, { access_token: 'token' }))
  await verifyWechatCredentials(fetcher, { appId: APP_ID, appSecret: APP_SECRET })

  const signal = calls[0]?.init?.signal
  assert.ok(signal instanceof AbortSignal, 'verify must pass an AbortSignal')
  assert.equal(signal.aborted, false)
  // The constant is part of the contract with the admin UI; it must not drift.
  assert.equal(WECHAT_VERIFY_TIMEOUT_MS, 10_000)
})

const ERRCODE_CASES: Array<{ errcode: number; code: string; expected: RegExp }> = [
  { errcode: 40013, code: 'invalid_app_id', expected: /AppID/ },
  { errcode: 40125, code: 'invalid_app_secret', expected: /AppSecret/ },
  { errcode: 40164, code: 'api_forbidden', expected: /IP 白名单/ },
  { errcode: 45009, code: 'rate_limited', expected: /限/ },
  { errcode: 40001, code: 'invalid_credential', expected: /凭证无效/ },
]

for (const expected of ERRCODE_CASES) {
  test(`errcode ${expected.errcode} maps to the redacted code ${expected.code}`, async () => {
    const { fetcher } = stub(() => json(200, { errcode: expected.errcode, errmsg: 'upstream text' }))
    const outcome = await verifyWechatCredentials(fetcher, {
      appId: APP_ID,
      appSecret: APP_SECRET,
    })

    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.code, expected.code)
    assert.match(outcome.message, expected.expected)
    // Actionable messages may name the public error number but never the
    // credential, the request URL or the raw upstream errmsg.
    assert.equal(outcome.message.includes(APP_SECRET), false)
    assert.equal(outcome.message.includes('api.weixin.qq.com'), false)
    assert.equal(outcome.message.includes('upstream text'), false)
  })
}

test('an unknown WeChat errcode degrades to wechat_api_error', async () => {
  const { fetcher } = stub(() => json(200, { errcode: 45011, errmsg: 'api freq out of limit' }))
  const outcome = await verifyWechatCredentials(fetcher, { appId: APP_ID, appSecret: APP_SECRET })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.code, 'wechat_api_error')
})

test('a transport failure is network_error, not a fake success', async () => {
  const { fetcher } = stub(() => {
    const error = new TypeError('fetch failed')
    throw error
  })
  const outcome = await verifyWechatCredentials(fetcher, { appId: APP_ID, appSecret: APP_SECRET })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.equal(outcome.code, 'network_error')
    assert.match(outcome.message, /无法连接微信服务器/)
  }
})

test('an aborted request is reported as timeout', async () => {
  const { fetcher } = stub(() => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  })
  const outcome = await verifyWechatCredentials(fetcher, { appId: APP_ID, appSecret: APP_SECRET })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.equal(outcome.code, 'timeout')
    assert.match(outcome.message, /超时/)
  }
})

test('a non-2xx provider response is wechat_api_error', async () => {
  const { fetcher } = stub(() => new Response('upstream down', { status: 502 }))
  const outcome = await verifyWechatCredentials(fetcher, { appId: APP_ID, appSecret: APP_SECRET })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.code, 'wechat_api_error')
})

test('a non-JSON body is wechat_api_error', async () => {
  const { fetcher } = stub(() => new Response('<html>proxy error</html>', { status: 200 }))
  const outcome = await verifyWechatCredentials(fetcher, { appId: APP_ID, appSecret: APP_SECRET })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.code, 'wechat_api_error')
})

test('a 200 response without errcode and without access_token is not a success', async () => {
  const { fetcher } = stub(() => json(200, { expires_in: 7200 }))
  const outcome = await verifyWechatCredentials(fetcher, { appId: APP_ID, appSecret: APP_SECRET })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.code, 'wechat_api_error')
})

test('empty or non-string access_token values never produce success', async () => {
  for (const payload of [
    { access_token: '' },
    { access_token: 12345 },
    { access_token: null },
  ]) {
    const { fetcher } = stub(() => json(200, payload))
    const outcome = await verifyWechatCredentials(fetcher, {
      appId: APP_ID,
      appSecret: APP_SECRET,
    })
    assert.equal(outcome.ok, false, `payload ${JSON.stringify(payload)} must not be accepted`)
  }
})

test('every redacted code has a non-empty, credential-free Chinese message', () => {
  for (const code of [
    'invalid_app_id',
    'invalid_app_secret',
    'invalid_credential',
    'api_forbidden',
    'rate_limited',
    'wechat_api_error',
    'network_error',
    'timeout',
    'decrypt_failed',
    'master_key_unavailable',
    'unknown',
  ] as const) {
    const message = wechatVerifyFailureMessage(code)
    assert.ok(message.length > 0)
    assert.equal(/[\u4e00-\u9fff]/u.test(message), true, `${code} message should be Chinese`)
  }
})
