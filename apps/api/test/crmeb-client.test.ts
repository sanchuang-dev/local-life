import assert from 'node:assert/strict'
import test from 'node:test'
import { CrmebClientError, CrmebOutapiClient } from '../src/crmeb/client.js'
import { parseDecimalYuanToCents } from '../src/crmeb/money.js'
import { ConfigError, loadConfig } from '../src/config.js'
import { SIMULATED_PRODUCTS } from './crmeb-fixtures.js'
import { startSimulatedCrmeb } from './crmeb-simulated-server.js'

function clientFor(baseUrl: string, options: { timeoutMs?: number; fetcher?: typeof fetch } = {}) {
  return new CrmebOutapiClient({
    baseUrl,
    appId: 'simulatedappid',
    appSecret: 'simulated-app-secret',
    timeoutMs: options.timeoutMs ?? 2_000,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  })
}

test('decimal yuan strings convert to integer cents without float rounding', () => {
  assert.equal(parseDecimalYuanToCents('12.30'), 1_230)
  assert.equal(parseDecimalYuanToCents('12'), 1_200)
  assert.equal(parseDecimalYuanToCents('0.30'), 30)
  assert.equal(parseDecimalYuanToCents('0.29'), 29)
  assert.equal(parseDecimalYuanToCents('0.1'), 10)
  assert.equal(parseDecimalYuanToCents('9999999999.99'), 999_999_999_999)
  // 0.1 + 0.2 style artifacts are only accepted when they are exactly a cent.
  assert.equal(parseDecimalYuanToCents(0.1 + 0.2), 30)
  assert.equal(parseDecimalYuanToCents(12.3), 1_230)
  // Anything that cannot be represented exactly in cents is rejected, never rounded.
  assert.equal(parseDecimalYuanToCents('12.345'), null)
  assert.equal(parseDecimalYuanToCents('1e3'), null)
  assert.equal(parseDecimalYuanToCents('-1.00'), null)
  assert.equal(parseDecimalYuanToCents('abc'), null)
  assert.equal(parseDecimalYuanToCents(''), null)
  assert.equal(parseDecimalYuanToCents(null), null)
  assert.equal(parseDecimalYuanToCents(undefined), null)
  assert.equal(parseDecimalYuanToCents(12.345), null)
})

test('CRMEB config is all-or-nothing and rejects malformed values at startup', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' }).crmeb, undefined)
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', CRMEB_BASE_URL: 'not-a-url' }),
    ConfigError,
  )
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'test',
        CRMEB_OUTAPI_APPID: 'simulatedappid',
      }),
    ConfigError,
  )
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'test',
        CRMEB_BASE_URL: 'https://mall.example.com',
        CRMEB_OUTAPI_APPID: 'bad appid!',
        CRMEB_OUTAPI_APPSECRET: 'secret',
        CRMEB_H5_BASE_URL: 'https://mall.example.com',
      }),
    ConfigError,
  )
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'test',
        CRMEB_BASE_URL: 'https://mall.example.com',
        CRMEB_OUTAPI_APPID: 'simulatedappid',
        CRMEB_OUTAPI_APPSECRET: 'secret',
        CRMEB_H5_BASE_URL: 'https://mall.example.com',
        CRMEB_TIMEOUT_MS: 'abc',
      }),
    ConfigError,
  )
  const valid = loadConfig({
    NODE_ENV: 'test',
    CRMEB_BASE_URL: 'https://mall.example.com/',
    CRMEB_OUTAPI_APPID: 'simulatedappid',
    CRMEB_OUTAPI_APPSECRET: 'secret',
    CRMEB_H5_BASE_URL: 'https://h5.example.com',
    CRMEB_TIMEOUT_MS: '5000',
  })
  assert.deepEqual(valid.crmeb, {
    baseUrl: 'https://mall.example.com',
    appId: 'simulatedappid',
    appSecret: 'secret',
    h5BaseUrl: 'https://h5.example.com',
    timeoutMs: 5_000,
  })
  // H5_BASE_URL is optional and falls back to the CRMEB site root.
  const withoutH5 = loadConfig({
    NODE_ENV: 'test',
    CRMEB_BASE_URL: 'https://mall.example.com',
    CRMEB_OUTAPI_APPID: 'simulatedappid',
    CRMEB_OUTAPI_APPSECRET: 'secret',
  })
  assert.equal(withoutH5.crmeb?.h5BaseUrl, 'https://mall.example.com')
  // An H5-only override is not a valid configuration.
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', CRMEB_H5_BASE_URL: 'https://h5.example.com' }),
    ConfigError,
  )
})

test('outapi token is cached and reused across requests', async () => {
  const simulated = await startSimulatedCrmeb({ products: SIMULATED_PRODUCTS })
  try {
    const client = clientFor(simulated.baseUrl)
    const first = await client.listProducts({ page: 1, limit: 20 })
    const second = await client.listProducts({ page: 1, limit: 20 })
    assert.equal(first.count, 3)
    assert.equal(second.count, 3)
    assert.deepEqual(simulated.tokenRequests, ['access'])
    assert.equal(simulated.requests.filter((r) => r.path === '/outapi/product/list').length, 2)
    // The outapi token travels in a header, never in the URL.
    const productCalls = simulated.requests.filter(
      (request) => request.path === '/outapi/product/list',
    )
    for (const call of productCalls) {
      assert.ok(!call.search.toLowerCase().includes('token'))
      assert.equal(call.authorization?.split(' ')[0], 'simulated-access-token-0001')
    }
    for (const request of simulated.requests) {
      assert.ok(!request.search.includes('simulated-app-secret'))
    }
  } finally {
    await simulated.close()
  }
})

test('a token close to exp_time is refreshed early via refresh_token', async () => {
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    tokenTtlSeconds: 30,
  })
  try {
    const client = clientFor(simulated.baseUrl)
    await client.listProducts({ page: 1, limit: 20 })
    await client.listProducts({ page: 1, limit: 20 })
    await client.listProducts({ page: 1, limit: 20 })
    assert.deepEqual(simulated.tokenRequests, ['access', 'refresh', 'refresh'])
  } finally {
    await simulated.close()
  }
})

test('a single 401 triggers exactly one token re-acquisition and retry', async () => {
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    unauthorizedResponses: 1,
  })
  try {
    const client = clientFor(simulated.baseUrl)
    const list = await client.listProducts({ page: 1, limit: 20 })
    assert.equal(list.count, 3)
    assert.deepEqual(simulated.tokenRequests, ['access', 'access'])
    assert.equal(simulated.requests.filter((r) => r.path === '/outapi/product/list').length, 2)
  } finally {
    await simulated.close()
  }
})

test('repeated 401 is surfaced explicitly after one retry, without looping', async () => {
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    alwaysUnauthorized: true,
  })
  try {
    const client = clientFor(simulated.baseUrl)
    await assert.rejects(
      client.listProducts({ page: 1, limit: 20 }),
      (error: unknown) =>
        error instanceof CrmebClientError &&
        error.kind === 'unauthorized' &&
        simulated.tokenRequests.length === 2 &&
        simulated.requests.filter((r) => r.path === '/outapi/product/list').length === 2,
    )
  } finally {
    await simulated.close()
  }
})

test('upstream contract drift is a typed error, not a pass-through', async () => {
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    driftProductList: true,
  })
  try {
    const client = clientFor(simulated.baseUrl)
    await assert.rejects(
      client.listProducts({ page: 1, limit: 20 }),
      (error: unknown) =>
        error instanceof CrmebClientError && error.kind === 'contract_mismatch',
    )
  } finally {
    await simulated.close()
  }
})

test('outapi tokens and the appsecret never appear in structured logs', async () => {
  const simulated = await startSimulatedCrmeb({ products: SIMULATED_PRODUCTS })
  const captured: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    captured.push(args.map((value) => String(value)).join(' '))
  }
  try {
    const client = clientFor(simulated.baseUrl)
    await client.listProducts({ page: 1, limit: 20 })
    const token = simulated.requests.find(
      (request) => request.path === '/outapi/product/list',
    )?.authorization
    assert.ok(token)
    const logText = captured.join('\n')
    assert.ok(!logText.includes('simulated-app-secret'))
    assert.ok(!logText.includes(token))
  } finally {
    console.log = original
    await simulated.close()
  }
})

test('a hanging outapi call is aborted by the configured timeout', async () => {
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })

  const client = clientFor('http://127.0.0.1:9', {
    timeoutMs: 100,
    fetcher: hangingFetch,
  })
  // AbortSignal.timeout uses an unref'ed timer; keep the event loop alive so the
  // test observes the timeout instead of being cancelled.
  const keepAlive = setTimeout(() => {}, 1_000)
  try {
    await assert.rejects(
      client.listProducts({ page: 1, limit: 20 }),
      (error: unknown) => error instanceof CrmebClientError && error.kind === 'timeout',
    )
  } finally {
    clearTimeout(keepAlive)
  }
})
