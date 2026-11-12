import assert from 'node:assert/strict'
import test from 'node:test'
import {
  API_ERROR_CODES,
  crmebAdapterStatusSchema,
  crmebProductDetailSchema,
  crmebProductListResponseSchema,
  healthResponseSchema,
} from '@sanchuang-dev/local-life-contracts'
import { errorEnvelope, createTestContext } from './crmeb-test-helpers.js'
import {
  SIMULATED_PRODUCTS,
  SIMULATED_PRODUCT_DETAILS,
} from './crmeb-fixtures.js'
import { startSimulatedCrmeb } from './crmeb-simulated-server.js'

test('without CRMEB configuration public product routes fail explicitly and healthz stays ok', async () => {
  const context = createTestContext()
  try {
    const status = await context.app.request('/integrations/crmeb/status')
    assert.equal(status.status, 200)
    const adapter = crmebAdapterStatusSchema.parse(await status.json())
    assert.equal(adapter.configured, false)
    assert.equal(adapter.status, 'not_configured')
    assert.equal(adapter.pushWebhook, false)
    assert.equal(adapter.orderReconciliation, 'outapi_pull')

    const products = await context.app.request('/integrations/crmeb/products')
    assert.equal(products.status, 503)
    assert.equal((await errorEnvelope(products)).error.code, API_ERROR_CODES.notConfigured)

    const detail = await context.app.request('/integrations/crmeb/products/101')
    assert.equal(detail.status, 503)
    assert.equal((await errorEnvelope(detail)).error.code, API_ERROR_CODES.notConfigured)

    const health = await context.app.request('/healthz')
    assert.equal(health.status, 200)
    assert.equal(healthResponseSchema.parse(await health.json()).status, 'ok')
  } finally {
    context.sqlite.close()
  }
})

test('public product list normalises CRMEB outapi data, filters off-shelf rows and reports its source', async () => {
  const simulated = await startSimulatedCrmeb({ products: SIMULATED_PRODUCTS })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  try {
    const response = await context.app.request(
      '/integrations/crmeb/products?page=1&limit=20&categoryId=3',
    )
    assert.equal(response.status, 200)
    const responseText = await response.text()
    assert.ok(!responseText.includes('simulated-app-secret'))
    assert.ok(!responseText.includes('simulated-token'))
    const body = crmebProductListResponseSchema.parse(JSON.parse(responseText))

    assert.equal(body.source, 'crmeb_outapi')
    assert.equal(body.page, 1)
    assert.equal(body.limit, 20)
    assert.equal(body.total, 3)
    assert.equal(body.hasMore, false)
    assert.deepEqual(
      body.items.map((item) => item.crmebProductId),
      [101, 103],
    )

    const gift = body.items[0]!
    assert.equal(gift.id, 'crmeb:101')
    assert.equal(gift.name, '有机蔬菜礼盒')
    assert.equal(gift.summary, '当季直采')
    assert.equal(gift.priceCents, 1_230)
    assert.equal(gift.originalPriceCents, 1_990)
    assert.deepEqual(gift.categoryIds, [3, 4])
    assert.deepEqual(gift.categoryNames, ['食品', '生鲜'])
    assert.equal(gift.stockKnown, false)
    assert.deepEqual(gift.images, [
      `${simulated.baseUrl}/uploads/products/101-main.png`,
      `${simulated.baseUrl}/uploads/products/101-a.png`,
      'https://cdn.example.com/101-b.png',
    ])

    // The request carried the documented filters, including forcing type=1.
    const upstream = simulated.requests.find((entry) => entry.path === '/outapi/product/list')
    assert.ok(upstream)
    const query = new URLSearchParams(upstream.search)
    assert.equal(query.get('page'), '1')
    assert.equal(query.get('limit'), '20')
    assert.equal(query.get('cate_id'), '3')
    assert.equal(query.get('type'), '1')
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('product list works with only defaults and reports the ready adapter state', async () => {
  const simulated = await startSimulatedCrmeb({ products: SIMULATED_PRODUCTS })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  try {
    const status = await context.app.request('/integrations/crmeb/status')
    assert.equal(status.status, 200)
    const adapter = crmebAdapterStatusSchema.parse(await status.json())
    assert.equal(adapter.configured, true)
    assert.equal(adapter.status, 'ready')
    assert.equal(adapter.h5EntryConfigured, true)

    const response = await context.app.request('/integrations/crmeb/products')
    assert.equal(response.status, 200)
    const body = crmebProductListResponseSchema.parse(await response.json())
    assert.equal(body.page, 1)
    assert.equal(body.limit, 20)
    assert.equal(body.items.length, 2)

    const upstream = simulated.requests.find((entry) => entry.path === '/outapi/product/list')
    assert.ok(upstream)
    const query = new URLSearchParams(upstream.search)
    assert.equal(query.has('cate_id'), false)
    assert.equal(query.has('store_name'), false)
    assert.equal(query.get('type'), '1')
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('product list rejects invalid pagination instead of forwarding it', async () => {
  const simulated = await startSimulatedCrmeb({ products: SIMULATED_PRODUCTS })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  try {
    for (const query of ['?limit=0', '?page=0', '?limit=101', '?page=abc']) {
      const response = await context.app.request(`/integrations/crmeb/products${query}`)
      assert.equal(response.status, 400, query)
      assert.equal((await errorEnvelope(response)).error.code, API_ERROR_CODES.invalidRequest)
    }
    assert.equal(
      simulated.requests.filter((entry) => entry.path === '/outapi/product/list').length,
      0,
      'invalid queries must not reach CRMEB',
    )
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('product detail re-checks on-shelf state and never forwards stock', async () => {
  const simulated = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    productDetails: SIMULATED_PRODUCT_DETAILS,
  })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  try {
    const response = await context.app.request('/integrations/crmeb/products/101')
    assert.equal(response.status, 200)
    const detail = crmebProductDetailSchema.parse(await response.json())
    assert.equal(detail.onShelf, true)
    assert.equal(detail.stockKnown, false)
    assert.equal(detail.detailHtml, '<p>基地直采</p>')
    assert.equal(detail.skus.length, 2)
    assert.equal(detail.skus[0]?.skuKey, 'sku-501')
    assert.equal(detail.skus[0]?.priceCents, 1_230)
    assert.equal(detail.skus[0]?.specText, '规格:小份')
    assert.equal(detail.skus[1]?.priceCents, 1_300)
    assert.equal(
      Object.hasOwn(detail.skus[0] as object, 'stock'),
      false,
      'CRMEB stock must not leak into the DTO',
    )

    // The detail endpoint in CRMEB does not check is_show; the adapter must.
    const offShelf = await context.app.request('/integrations/crmeb/products/102')
    assert.equal(offShelf.status, 404)
    assert.equal((await errorEnvelope(offShelf)).error.code, API_ERROR_CODES.notFound)

    const invalid = await context.app.request('/integrations/crmeb/products/not-a-number')
    assert.equal(invalid.status, 400)

    const missing = await context.app.request('/integrations/crmeb/products/999')
    assert.equal(missing.status, 404)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('an unresponsive CRMEB is reported as crmeb_timeout instead of hanging the request', async () => {
  const simulated = await startSimulatedCrmeb({ products: SIMULATED_PRODUCTS })
  const hangingFetch: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  const context = createTestContext({
    crmeb: { baseUrl: simulated.baseUrl, timeoutMs: 100 },
    fetcher: hangingFetch,
  })
  // AbortSignal.timeout uses an unref'ed timer; keep the loop alive for the test.
  const keepAlive = setTimeout(() => {}, 1_000)
  try {
    const response = await context.app.request('/integrations/crmeb/products')
    assert.equal(response.status, 503)
    assert.equal((await errorEnvelope(response)).error.code, API_ERROR_CODES.crmebTimeout)
  } finally {
    clearTimeout(keepAlive)
    await simulated.close()
    context.sqlite.close()
  }
})

test('upstream permission errors and contract drift map to explicit 503 errors', async () => {
  const forbidden = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    productListFailureStatus: 403,
  })
  const forbiddenContext = createTestContext({ crmeb: { baseUrl: forbidden.baseUrl } })
  try {
    const response = await forbiddenContext.app.request('/integrations/crmeb/products')
    assert.equal(response.status, 503)
    const body = await errorEnvelope(response)
    assert.equal(body.error.code, API_ERROR_CODES.crmebUpstreamError)
    assert.match(body.error.message, /对外接口/)
  } finally {
    await forbidden.close()
    forbiddenContext.sqlite.close()
  }

  const drift = await startSimulatedCrmeb({
    products: SIMULATED_PRODUCTS,
    driftProductList: true,
  })
  const driftContext = createTestContext({ crmeb: { baseUrl: drift.baseUrl } })
  try {
    const response = await driftContext.app.request('/integrations/crmeb/products')
    assert.equal(response.status, 503)
    assert.equal(
      (await errorEnvelope(response)).error.code,
      API_ERROR_CODES.crmebContractMismatch,
    )
  } finally {
    await drift.close()
    driftContext.sqlite.close()
  }
})
