import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import test from 'node:test'
import {
  WECHAT_PAY_JSAPI_PATH,
  buildWechatPayJsapiRequest,
  computePrepayExpiresAt,
  executeWechatPayJsapiRequest,
  formatWechatTimeExpire,
  sha256Hex,
  type WechatPayJsapiPrepayInput,
} from '../src/wechat-pay/provider.js'
import type { WechatPayRuntimeConfig } from '../src/wechat-pay/credentials.js'
import { buildWechatPayRequestSignatureMessage } from '../src/wechat-pay/signing.js'
import {
  TEST_APPID,
  TEST_MCHID,
  TEST_MERCHANT_PRIVATE_KEY,
  TEST_MERCHANT_PUBLIC_KEY_PEM,
  TEST_MERCHANT_SERIAL,
  TEST_PLATFORM_KEY_ID,
  TEST_PLATFORM_PUBLIC_KEY,
  authorizationFields,
  startFakeWechatServer,
  type FakeWechatServer,
} from './fixtures/wechat-pay-test-support.js'

const NOW = new Date('2026-11-18T07:00:00.000Z')
const NONCE = '593BEC0C930BF1AFEB40B4A08C8FB242'
const INPUT: WechatPayJsapiPrepayInput = {
  appId: TEST_APPID,
  mchid: TEST_MCHID,
  description: '本地生活订单测试商品',
  outTradeNo: 'PAY-0123456789ABCDEF0123456789AB',
  timeExpire: new Date('2026-11-18T07:10:00.000Z'),
  notifyUrl: 'https://local-life.example.test/api/payments/wechat/notify',
  amountTotalCents: 3_480,
  openid: 'o-test-openid-123',
}

function runtimeFor(server: FakeWechatServer, overrides: Partial<WechatPayRuntimeConfig> = {}) {
  return {
    mchid: TEST_MCHID,
    appId: TEST_APPID,
    merchantSerialNo: TEST_MERCHANT_SERIAL,
    merchantPrivateKey: TEST_MERCHANT_PRIVATE_KEY,
    platformPublicKey: TEST_PLATFORM_PUBLIC_KEY,
    platformKeyId: TEST_PLATFORM_KEY_ID,
    platformKeyMode: 'public_key' as const,
    notifyUrl: INPUT.notifyUrl,
    apiBaseUrl: server.baseUrl,
    timeoutMs: 1_000,
    ...overrides,
  } satisfies WechatPayRuntimeConfig
}

function expectedBody(input: WechatPayJsapiPrepayInput = INPUT): string {
  return JSON.stringify({
    appid: input.appId,
    mchid: input.mchid,
    description: input.description,
    out_trade_no: input.outTradeNo,
    time_expire: formatWechatTimeExpire(input.timeExpire),
    notify_url: input.notifyUrl,
    amount: { total: input.amountTotalCents, currency: 'CNY' },
    payer: { openid: input.openid },
  })
}

test('PAY-10 provider sends the exact signed APIv3 JSAPI request', async (t) => {
  const responseBody = '{"prepay_id":"wx1234567890abcdef1234567890abcdef"}'
  const server = await startFakeWechatServer(() => ({ status: 200, body: responseBody }))
  t.after(() => server.close())
  const runtime = runtimeFor(server)
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: new Date() })

  assert.equal(server.requests.length, 1)
  const captured = server.requests[0]!
  assert.equal(captured.method, 'POST')
  assert.equal(captured.url, WECHAT_PAY_JSAPI_PATH)
  assert.equal(captured.headers['content-type'], 'application/json')
  assert.equal(captured.headers.accept, 'application/json')
  assert.equal(captured.body, expectedBody())
  assert.equal(request.body, captured.body)
  assert.equal(request.bodySha256, sha256Hex(captured.body))
  assert.equal(request.fingerprint, sha256Hex(`POST\n${WECHAT_PAY_JSAPI_PATH}\n${captured.body}`))
  // The audit copy must not duplicate the payer OpenID.
  assert.equal(request.redactedBodyJson.includes(INPUT.openid), false)
  assert.match(request.redactedBodyJson, /"openid":"sha256:[0-9a-f]{64}"/u)

  const authorization = String(captured.headers.authorization)
  assert.match(authorization, /^WECHATPAY2-SHA256-RSA2048 /u)
  const fields = authorizationFields(authorization)
  assert.equal(fields.mchid, TEST_MCHID)
  assert.equal(fields.serial_no, TEST_MERCHANT_SERIAL)
  assert.equal(fields.nonce_str, NONCE)
  assert.equal(fields.timestamp, String(Math.floor(NOW.getTime() / 1_000)))
  const message = buildWechatPayRequestSignatureMessage(
    'POST',
    WECHAT_PAY_JSAPI_PATH,
    fields.timestamp!,
    fields.nonce_str!,
    captured.body,
  )
  assert.equal(
    verify(
      'sha256',
      Buffer.from(message, 'utf8'),
      createPublicKey({ key: TEST_MERCHANT_PUBLIC_KEY_PEM, format: 'pem' }),
      Buffer.from(fields.signature!, 'base64'),
    ),
    true,
  )

  assert.equal(outcome.kind, 'prepay')
  if (outcome.kind !== 'prepay') return
  assert.equal(outcome.prepayId, 'wx1234567890abcdef1234567890abcdef')
  assert.equal(outcome.responseStatus, 200)
  assert.equal(outcome.requestId, 'fake-request-0')
  assert.equal(outcome.responseBodySha256, sha256Hex(responseBody))
})

test('PAY-10 provider rejects a response with a bad signature', async (t) => {
  const responseBody = '{"prepay_id":"wx1234567890abcdef1234567890abcdef"}'
  const server = await startFakeWechatServer(() => ({
    status: 200,
    body: responseBody,
    signBody: `${responseBody} `,
  }))
  t.after(() => server.close())
  const runtime = runtimeFor(server)
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: new Date() })
  assert.equal(outcome.kind, 'uncertain')
  if (outcome.kind !== 'uncertain') return
  assert.equal(outcome.failureCode, 'signature_invalid')
  assert.equal(outcome.responseStatus, 200)
  assert.equal(outcome.responseBodySha256, sha256Hex(responseBody))
})

test('PAY-10 provider rejects a response with missing signature headers', async (t) => {
  const server = await startFakeWechatServer(() => ({
    status: 200,
    body: '{"prepay_id":"wx1234567890abcdef1234567890abcdef"}',
    omitSignatureHeaders: true,
  }))
  t.after(() => server.close())
  const runtime = runtimeFor(server)
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: new Date() })
  assert.equal(outcome.kind, 'uncertain')
  if (outcome.kind !== 'uncertain') return
  assert.equal(outcome.failureCode, 'signature_missing')
})

test('PAY-10 provider classifies timeout as uncertain, not failure', async (t) => {
  const server = await startFakeWechatServer(() => ({
    status: 200,
    body: '{"prepay_id":"wx1234567890abcdef1234567890abcdef"}',
    delayMs: 300,
  }))
  t.after(() => server.close())
  const runtime = runtimeFor(server, { timeoutMs: 50 })
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: new Date() })
  assert.equal(outcome.kind, 'uncertain')
  if (outcome.kind !== 'uncertain') return
  assert.equal(outcome.failureCode, 'timeout')
  assert.equal(outcome.responseStatus, null)
})

test('PAY-10 provider rejects malformed signed JSON as uncertain', async (t) => {
  const server = await startFakeWechatServer(() => ({ status: 200, body: 'not-json' }))
  t.after(() => server.close())
  const runtime = runtimeFor(server)
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: new Date() })
  assert.equal(outcome.kind, 'uncertain')
  if (outcome.kind !== 'uncertain') return
  assert.equal(outcome.failureCode, 'unparseable_response')
})

test('PAY-10 provider accepts a verified deterministic 4xx rejection', async (t) => {
  const errorBody = '{"code":"PARAM_ERROR","message":"参数错误"}'
  const server = await startFakeWechatServer(() => ({ status: 400, body: errorBody }))
  t.after(() => server.close())
  const runtime = runtimeFor(server)
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: new Date() })
  assert.equal(outcome.kind, 'rejected')
  if (outcome.kind !== 'rejected') return
  assert.equal(outcome.code, 'PARAM_ERROR')
  assert.equal(outcome.message, '参数错误')
  assert.equal(outcome.responseStatus, 400)
})

test('PAY-10 provider rejects a WeChat error even on HTTP 200', async (t) => {
  const server = await startFakeWechatServer(() => ({
    status: 200,
    body: '{"code":"SYSTEM_ERROR","message":"系统错误"}',
  }))
  t.after(() => server.close())
  const runtime = runtimeFor(server)
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: new Date() })
  assert.equal(outcome.kind, 'rejected')
  if (outcome.kind !== 'rejected') return
  assert.equal(outcome.code, 'SYSTEM_ERROR')
})

test('PAY-10 provider classifies verified 5xx as uncertain', async (t) => {
  const server = await startFakeWechatServer(() => ({
    status: 500,
    body: '{"code":"SYSTEM_ERROR","message":"系统错误"}',
  }))
  t.after(() => server.close())
  const runtime = runtimeFor(server)
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: new Date() })
  assert.equal(outcome.kind, 'uncertain')
  if (outcome.kind !== 'uncertain') return
  assert.equal(outcome.failureCode, 'provider_server_error')
})

test('PAY-10 provider classifies network errors as uncertain', async () => {
  const server = await startFakeWechatServer(() => ({ status: 200, body: '{}' }))
  const runtime = runtimeFor(server, { apiBaseUrl: server.baseUrl })
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({
    request,
    runtime,
    now: NOW,
    fetcher: (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch,
  })
  await server.close()
  assert.equal(outcome.kind, 'uncertain')
  if (outcome.kind !== 'uncertain') return
  assert.equal(outcome.failureCode, 'network_error')
})

test('PAY-10 provider rejects a signed response without prepay_id', async (t) => {
  const server = await startFakeWechatServer(() => ({ status: 200, body: '{}' }))
  t.after(() => server.close())
  const runtime = runtimeFor(server)
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: new Date() })
  assert.equal(outcome.kind, 'uncertain')
  if (outcome.kind !== 'uncertain') return
  assert.equal(outcome.failureCode, 'unexpected_payload')
})

test('PAY-10 provider rejects a response serial that is not the trust anchor', async (t) => {
  const server = await startFakeWechatServer((captured) => ({
    status: 200,
    body: '{"prepay_id":"wx1234567890abcdef1234567890abcdef"}',
    serial: 'PUB_KEY_ID_OTHER0000000000000000000001',
    nonce: captured.headers['wechatpay-nonce'] as string | undefined,
  }))
  t.after(() => server.close())
  const runtime = runtimeFor(server)
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: new Date() })
  assert.equal(outcome.kind, 'uncertain')
  if (outcome.kind !== 'uncertain') return
  assert.equal(outcome.failureCode, 'signature_serial_mismatch')
})

test('PAY-10 provider rejects an expired signed response timestamp', async (t) => {
  const expiredTimestamp = String(Math.floor(NOW.getTime() / 1_000) - 301)
  const server = await startFakeWechatServer(() => ({
    status: 200,
    body: '{"prepay_id":"wx1234567890abcdef1234567890abcdef"}',
    timestamp: expiredTimestamp,
  }))
  t.after(() => server.close())
  const runtime = runtimeFor(server)
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: NOW })
  assert.equal(outcome.kind, 'uncertain')
  if (outcome.kind !== 'uncertain') return
  assert.equal(outcome.failureCode, 'signature_timestamp_expired')
})

test('PAY-10 provider outcomes never contain key or Authorization material', async (t) => {
  const server = await startFakeWechatServer(() => ({
    status: 200,
    body: '{"prepay_id":"wx1234567890abcdef1234567890abcdef"}',
  }))
  t.after(() => server.close())
  const runtime = runtimeFor(server)
  const request = buildWechatPayJsapiRequest(runtime, INPUT, { now: NOW, nonceStr: NONCE })
  const outcome = await executeWechatPayJsapiRequest({ request, runtime, now: new Date() })
  const serialized = JSON.stringify(outcome)
  assert.equal(serialized.includes('PRIVATE KEY'), false)
  assert.equal(serialized.includes(request.authorization), false)
  assert.equal(serialized.includes(String(server.requests[0]?.headers.authorization)), false)
})

test('PAY-10 formats WeChat time_expire and caps prepay validity', () => {
  assert.equal(
    formatWechatTimeExpire(new Date('2026-11-18T07:10:00.000Z')),
    '2026-11-18T15:10:00+08:00',
  )
  // Official prepay validity (2h) capped by the intent deadline.
  assert.equal(
    computePrepayExpiresAt(NOW, new Date('2026-11-18T07:10:00.000Z')).toISOString(),
    '2026-11-18T07:10:00.000Z',
  )
  assert.equal(
    computePrepayExpiresAt(NOW, new Date('2026-11-18T12:00:00.000Z')).toISOString(),
    '2026-11-18T09:00:00.000Z',
  )
})
