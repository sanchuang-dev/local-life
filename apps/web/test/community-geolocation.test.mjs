import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CommunityLocationError,
  createCommunityLocationRequester,
  requestBrowserLocation,
  requestWechatLocation,
} from '../src/lib/communityGeolocation.ts'

const pageUrl = 'https://local.proto.3cgroup.cn/community/discovery'
const signatureBody = {
  appId: 'wx1234567890abcdef',
  timestamp: 1730000000,
  nonceStr: 'abcd'.repeat(8),
  signature: 'a'.repeat(40),
}

function signatureFetcher() {
  return async () => new Response(JSON.stringify(signatureBody), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function createSdk({ getLocation, configError = false, notifyReady = true } = {}) {
  let readyCallback
  let errorCallback
  const sdk = {
    config(options) {
      sdk.configOptions = options
      if (configError) {
        errorCallback?.({ errMsg: 'config:invalid signature' })
        return
      }
      if (notifyReady) queueMicrotask(() => readyCallback?.())
    },
    ready(callback) { readyCallback = callback },
    error(callback) { errorCallback = callback },
    updateAppMessageShareData() {},
    updateTimelineShareData() {},
  }
  if (getLocation) sdk.getLocation = getLocation
  return sdk
}

function assertReason(reason) {
  return (error) => {
    assert.ok(error instanceof CommunityLocationError)
    assert.equal(error.reason, reason)
    return true
  }
}

test('WeChat success uses the signed getLocation result without a fake fallback', async () => {
  const sdk = createSdk({
    getLocation: (options) => options.success({ latitude: 24.8, longitude: 113.6 }),
  })
  const point = await requestWechatLocation({
    pageUrl,
    fetcher: signatureFetcher(),
    loadSdk: async () => sdk,
    timeoutMs: 100,
  })
  assert.deepEqual(point, { latitude: 24.8, longitude: 113.6 })
  assert.deepEqual(sdk.configOptions, {
    ...signatureBody,
    debug: false,
    jsApiList: ['getLocation'],
  })
})

test('WeChat permission refusal is distinct from JS-SDK configuration failure', async () => {
  const deniedSdk = createSdk({
    getLocation: (options) => options.fail({ errMsg: 'getLocation:fail:auth denied' }),
  })
  await assert.rejects(
    requestWechatLocation({ pageUrl, fetcher: signatureFetcher(), loadSdk: async () => deniedSdk, timeoutMs: 100 }),
    (error) => {
      assertReason('permission_denied')(error)
      assert.match(error.message, /授权被拒绝/)
      return true
    },
  )

  const misconfiguredSdk = createSdk({
    configError: true,
    getLocation: (options) => options.success({ latitude: 24.8, longitude: 113.6 }),
  })
  await assert.rejects(
    requestWechatLocation({ pageUrl, fetcher: signatureFetcher(), loadSdk: async () => misconfiguredSdk, timeoutMs: 100 }),
    (error) => {
      assertReason('sdk_config_failed')(error)
      assert.doesNotMatch(error.message, /授权被拒绝/)
      assert.match(error.message, /初始化失败/)
      return true
    },
  )
})

test('WeChat user cancel, missing getLocation and device failure have separate reasons', async () => {
  const cancelSdk = createSdk({ getLocation: (options) => options.cancel() })
  await assert.rejects(
    requestWechatLocation({ pageUrl, fetcher: signatureFetcher(), loadSdk: async () => cancelSdk, timeoutMs: 100 }),
    assertReason('wechat_cancelled'),
  )

  const unsupportedSdk = createSdk()
  await assert.rejects(
    requestWechatLocation({ pageUrl, fetcher: signatureFetcher(), loadSdk: async () => unsupportedSdk, timeoutMs: 100 }),
    assertReason('sdk_unsupported'),
  )

  const failedSdk = createSdk({
    getLocation: (options) => options.fail({ errMsg: 'getLocation:fail:ERROR_NOCELL&WIFI_LOCATIONSWITCHOFF' }),
  })
  await assert.rejects(
    requestWechatLocation({ pageUrl, fetcher: signatureFetcher(), loadSdk: async () => failedSdk, timeoutMs: 100 }),
    assertReason('wechat_failed'),
  )
})

test('WeChat ready timeout clears the request and rejects with timeout', async () => {
  const sdk = createSdk({ getLocation() {}, notifyReady: false })
  await assert.rejects(
    requestWechatLocation({ pageUrl, fetcher: signatureFetcher(), loadSdk: async () => sdk, timeoutMs: 5 }),
    assertReason('timeout'),
  )
})

test('signature HTTP, invalid response and SDK load failures stay distinct', async () => {
  const sdk = createSdk({ getLocation: (options) => options.success({ latitude: 1, longitude: 2 }) })

  await assert.rejects(
    requestWechatLocation({
      pageUrl,
      fetcher: async () => new Response('', { status: 503 }),
      loadSdk: async () => sdk,
    }),
    assertReason('signature_unavailable'),
  )

  await assert.rejects(
    requestWechatLocation({
      pageUrl,
      fetcher: async () => new Response('not json', { status: 200 }),
      loadSdk: async () => sdk,
    }),
    assertReason('signature_invalid'),
  )

  await assert.rejects(
    requestWechatLocation({
      pageUrl,
      fetcher: async () => new Response(JSON.stringify({ appId: 'only' }), { status: 200 }),
      loadSdk: async () => sdk,
    }),
    assertReason('signature_invalid'),
  )

  await assert.rejects(
    requestWechatLocation({
      pageUrl,
      fetcher: signatureFetcher(),
      loadSdk: async () => { throw new Error('script blocked') },
    }),
    assertReason('sdk_load_failed'),
  )
})

test('a stalled signature request times out instead of hanging', async () => {
  await assert.rejects(
    requestWechatLocation({
      pageUrl,
      timeoutMs: 20,
      fetcher: (_input, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
      loadSdk: async () => { throw new Error('must not run') },
    }),
    assertReason('timeout'),
  )
})

test('aborting a WeChat request rejects as cancelled instead of a location error', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    requestWechatLocation({
      pageUrl,
      signal: controller.signal,
      fetcher: async () => { throw new Error('must not run') },
      loadSdk: async () => { throw new Error('must not run') },
    }),
    assertReason('cancelled'),
  )

  const pendingController = new AbortController()
  const pendingSdk = createSdk({ getLocation() {}, notifyReady: false })
  const pending = requestWechatLocation({
    pageUrl,
    signal: pendingController.signal,
    fetcher: signatureFetcher(),
    loadSdk: async () => pendingSdk,
    timeoutMs: 1_000,
  })
  await Promise.resolve()
  pendingController.abort()
  await assert.rejects(pending, assertReason('cancelled'))
})

test('browser location success is converted to GCJ-02 without a fixed coordinate', async () => {
  const point = await requestBrowserLocation({
    geolocation: {
      getCurrentPosition(success) {
        success({ coords: { latitude: 24.8, longitude: 113.6 } })
      },
    },
  })
  assert.ok(Math.abs(point.latitude - 24.8) > 0.0001)
  assert.ok(Math.abs(point.longitude - 113.6) > 0.0001)
  assert.ok(Math.abs(point.latitude - 24.8) < 0.01)
})

test('browser refusal, timeout, unsupported and unavailable states stay distinct', async () => {
  const browserWithError = (code) => ({
    getCurrentPosition(_success, failure) { failure({ code, message: 'browser failure' }) },
  })

  await assert.rejects(
    requestBrowserLocation({ geolocation: browserWithError(1) }),
    (error) => {
      assertReason('permission_denied')(error)
      assert.match(error.message, /授权被拒绝/)
      return true
    },
  )
  await assert.rejects(requestBrowserLocation({ geolocation: browserWithError(3) }), assertReason('timeout'))
  await assert.rejects(requestBrowserLocation({ geolocation: browserWithError(2) }), assertReason('position_unavailable'))
  await assert.rejects(requestBrowserLocation({ geolocation: undefined }), assertReason('unsupported'))

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(requestBrowserLocation({ geolocation: browserWithError(1), signal: controller.signal }), assertReason('cancelled'))
})

test('rapid taps share one location request and a retry starts only after settling', async () => {
  let calls = 0
  let resolveRequest
  const requester = createCommunityLocationRequester(() => {
    calls += 1
    return new Promise((resolve) => { resolveRequest = resolve })
  })

  const first = requester.request()
  const second = requester.request()
  assert.equal(first, second)
  assert.equal(calls, 1)
  assert.equal(requester.pending, true)

  resolveRequest({ latitude: 24.8, longitude: 113.6 })
  assert.deepEqual(await first, { latitude: 24.8, longitude: 113.6 })
  await Promise.resolve()
  assert.equal(requester.pending, false)

  const third = requester.request()
  assert.equal(calls, 2)
  resolveRequest({ latitude: 24.9, longitude: 113.7 })
  await third
})

test('unmount cancellation aborts the active request and does not block a later retry', async () => {
  let calls = 0
  const requester = createCommunityLocationRequester((signal) => {
    calls += 1
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new CommunityLocationError('cancelled')), { once: true })
    })
  })

  const flight = requester.request()
  assert.equal(requester.pending, true)
  requester.cancel()
  assert.equal(requester.pending, false)
  await assert.rejects(flight, assertReason('cancelled'))

  const retry = requester.request()
  assert.equal(calls, 2)
  requester.cancel()
  requester.cancel()
  await assert.rejects(retry, assertReason('cancelled'))
})
