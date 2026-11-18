import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConfigError, loadConfig } from '../src/config.js'
import {
  buildWechatPayJsapiPaySignMessage,
  buildWechatPayRequestSignatureMessage,
  buildWechatPayResponseSignatureMessage,
  createNonceStr,
  createWechatJsapiInvocation,
  signWechatPayRequest,
  verifyWechatPayResponseSignature,
} from '../src/wechat-pay/signing.js'
import {
  TEST_APPID,
  TEST_FIXED_VECTOR_PUBLIC_KEY,
  TEST_MCHID,
  TEST_MERCHANT_PRIVATE_KEY,
  TEST_MERCHANT_PRIVATE_KEY_PEM,
  TEST_MERCHANT_PUBLIC_KEY_PEM,
  TEST_MERCHANT_SERIAL,
  TEST_OFFICIAL_PUBLIC_PAGE_KEY,
  TEST_PLATFORM_KEY_ID,
  TEST_PLATFORM_PUBLIC_KEY_PEM,
} from './fixtures/wechat-pay-test-support.js'

/**
 * Official known-answer vectors (WeChat Pay documentation, checked 2026-11-18):
 * - request signing example: /doc/v3/merchant/4012365334
 * - JSAPI invocation signing example: /doc/v3/merchant/4012365339
 *
 * Response verification examples:
 * - 4013053420 (平台证书页) signature verifies with that page's published
 *   platform public key -> used as the official KAT below;
 * - 4013053249 (微信支付公钥页) republishes the same signature with a different
 *   public key that does NOT verify it -> used as an explicit negative vector.
 * The local FIXED_RESPONSE vector stays as a deterministic unit vector.
 */
const OFFICIAL_REQUEST_SIGNATURE =
  'Lc9VXxmeonkdV8Xk9tmigQFLhl0vRWTerdmoRu01aAnYwIrD/5nsSwE1WlmZGLRlAFTNQ3QsMa0+VRDlJp1Wp5p0nO8EK68b5sJBbjouxaFciIfq1zfDWWz+jqhcMoKXI1A6dPm1AW7D4d30WsMTNzp6g23OXakIsh9LO3lUmwvTuE0BY8ncf6tNGk4wKmvXwERd/ZpoQY3MAVKz+Nakwc+2XBmzT66KcUehU5kr4IvGa/lEU5RZb/q00zP9VLdBhC/jQSX3X1UcJLCtEc4gTmib4tnmAT+bHF/e17ZAuxDNcx6rqT8gNEXqaJGG+1OflMSTU2tpyG65G4dMKdFcoA=='

const OFFICIAL_PAY_SIGN =
  'mI35pfNEQV6777ke/1T+LJLQDNTm7yeoUJH+j/adPGhmCCi0PbgkvYQTRcXH0uibcLVtvFLdGLpmoYO9FV6lBBsTAjuhh5YOvQi0e2g3e0yytitiNET9FEuqM0pjnKfRW4K6LIZDdbWJv9KhZUx3DrJa5TL7OJ7VdADVivxVySIlPVKjGwuCXzuXSJes0UcILgWQUMyha5/3nYofuHtS7r+KYyMuxD+oJ9VM1Qdxk4UIG59CP5Y3wtYIFybyF3bdu1caHTRRX+DLyMXyYA/IrTmiW01c4RPjpHBX5Dk1sZyY1zVsWNsvMHr2e1NTWtBxKJ+qk5N61J7caYoepHFaxw=='

// Fixed local response verification vector produced by the test platform key.
const FIXED_RESPONSE = {
  timestamp: '1794901141',
  nonce: 'A1B2C3D4E5F60718293A4B5C6D7E8F90',
  body: '{"prepay_id":"wx1234567890abcdef1234567890abcdef"}',
  signature:
    'FmrSIDlT9o2cx9YDo7zbm7w1y5jx5ihYxf1dywtkX3KH0FVlWqa+SkR19wutIxRGJ1yweWlYjg3WirS5+ROVaEQ63Qod2WCnU5shmnE2PyFnyfm7wthXLrv+/CPArtax3Uadfr1Hyx/a3BSaJfCDBDfcUlyHl99bud7tRDX1TkM7L3chWepcXAW9Vs6icwv9sicT4XRItztGJnlqQUAgDH9blA5JIpipZXAeoz4ss/MbDdvDQVNXlSCCw7vWSE36tp+r1W6nory28XXfYrEO6/wKPh8XqaJ1SFgiQJ7LyDG0WxTYO1vA3xSTIX0e/rEvJsFjDF5np5XU6vqnU7TSDw==',
} as const

// Official 4013053420 (平台证书验签页) example vector: same signature/body as
// the 4013053249 page, but paired with the public key published on this page.
const OFFICIAL_CERT_PAGE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwXNI6sdlknHBnK8Fu2U6
Cwor9qY747jP8KAfeBMeveEt1TqaHkLfaSD07trZLhGpfs8/AHqjhgSMO1O10YQW
OrrJ4hjIWPKqxbgrYMkBQc+mwdiWp4W3ByCqxBRagCveCXRWCmuJYovl9H/bsDI0
iGbpVtEOghJtfciisYSgxcLufUDTRkvwxjIBK1pCRjk33jJ5YTBWTHMRtMAOcFLN
F6hdEYdX8SPsgHHeLZ5Lv2T/686w1xtgCHef/sd4uSfWmyzsalQdHG/e4IyYmrhx
+O3VBoNDzE3nx23bFeV/RVNCG7cV6VhmYokJNHa/erIPkEmEFID6A5wQOXuxUkmJ
WwIDAQAB
-----END PUBLIC KEY-----`

const OFFICIAL_CERT_PAGE_RESPONSE = {
  timestamp: '1722850421',
  nonce: 'd824f2e086d3c1df967785d13fcd22ef',
  body: '{"code_url":"weixin://wxpay/bizpayurl?pr=JyC91EIz1"}',
  signature:
    'mfI1CPqvBrgcXfgXMFjdNIhBf27ACE2YyeWsWV9ZI7T7RU0vHvbQpu9Z32ogzc+k8ZC5n3kz7h70eWKjgqNdKQF0eRp8mVKlmfzMLBVHbssB9jEZEDXThOX1XFqX7s7ymia1hoHQxQagPGzkdWxtlZPZ4ZPvr1RiqkgAu6Is8MZgXXrRoBKqjmSdrP1N7uxzJ/cjfSiis9FiLjuADoqmQ1P7p2N876YPAol7Rn0+GswwAwxldbdLrmVSjfytfSBJFqTMHn4itojgxSWWN1byuckQt8hSTEv/Lg97QoeGniYP17T80pJeQyL3b+295FPHSO2AtvCgyIbKMZ0BALilAA==',
} as const

test('PAY-10 request signing matches the official WeChat test vector', () => {
  const signed = signWechatPayRequest({
    method: 'GET',
    urlPath: '/v3/refund/domestic/refunds/123123123123',
    timestamp: '1554208460',
    nonceStr: '593BEC0C930BF1AFEB40B4A08C8FB242',
    body: '',
    mchid: TEST_MCHID,
    merchantSerialNo: TEST_MERCHANT_SERIAL,
    merchantPrivateKey: TEST_MERCHANT_PRIVATE_KEY,
  })
  assert.equal(
    buildWechatPayRequestSignatureMessage(
      'GET',
      '/v3/refund/domestic/refunds/123123123123',
      '1554208460',
      '593BEC0C930BF1AFEB40B4A08C8FB242',
      '',
    ),
    'GET\n/v3/refund/domestic/refunds/123123123123\n1554208460\n593BEC0C930BF1AFEB40B4A08C8FB242\n\n',
  )
  assert.equal(signed.signature, OFFICIAL_REQUEST_SIGNATURE)
  assert.equal(
    signed.authorization,
    `WECHATPAY2-SHA256-RSA2048 mchid="${TEST_MCHID}",nonce_str="593BEC0C930BF1AFEB40B4A08C8FB242",signature="${OFFICIAL_REQUEST_SIGNATURE}",timestamp="1554208460",serial_no="${TEST_MERCHANT_SERIAL}"`,
  )
})

test('PAY-10 request signature negatives: missing trailing newline or changed fields', () => {
  const withoutTrailingNewline = signWechatPayRequest({
    method: 'GET',
    urlPath: '/v3/refund/domestic/refunds/123123123123',
    timestamp: '1554208460',
    nonceStr: '593BEC0C930BF1AFEB40B4A08C8FB242',
    body: 'x',
    mchid: TEST_MCHID,
    merchantSerialNo: TEST_MERCHANT_SERIAL,
    merchantPrivateKey: TEST_MERCHANT_PRIVATE_KEY,
  })
  assert.notEqual(withoutTrailingNewline.signature, OFFICIAL_REQUEST_SIGNATURE)

  const changedPath = signWechatPayRequest({
    method: 'GET',
    urlPath: '/v3/refund/domestic/refunds/123123123124',
    timestamp: '1554208460',
    nonceStr: '593BEC0C930BF1AFEB40B4A08C8FB242',
    body: '',
    mchid: TEST_MCHID,
    merchantSerialNo: TEST_MERCHANT_SERIAL,
    merchantPrivateKey: TEST_MERCHANT_PRIVATE_KEY,
  })
  assert.notEqual(changedPath.signature, OFFICIAL_REQUEST_SIGNATURE)

  assert.notEqual(
    buildWechatPayRequestSignatureMessage('POST', '/v3/pay/transactions/jsapi', '1', 'N', '{}'),
    buildWechatPayRequestSignatureMessage('POST', '/v3/pay/transactions/jsapi', '1', 'N', '{} '),
  )
})

test('PAY-10 JSAPI paySign matches the official WeChat test vector', () => {
  assert.equal(
    buildWechatPayJsapiPaySignMessage(
      TEST_APPID,
      '1554208460',
      '593BEC0C930BF1AFEB40B4A08C8FB242',
      'prepay_id=wx201410272009395522657a690389285100',
    ),
    'wx2421b1c4370ec43b\n1554208460\n593BEC0C930BF1AFEB40B4A08C8FB242\nprepay_id=wx201410272009395522657a690389285100\n',
  )
  const invocation = createWechatJsapiInvocation({
    appId: TEST_APPID,
    prepayId: 'wx201410272009395522657a690389285100',
    merchantPrivateKey: TEST_MERCHANT_PRIVATE_KEY,
    now: new Date(1_554_208_460_000),
    nonceStr: '593BEC0C930BF1AFEB40B4A08C8FB242',
  })
  assert.deepEqual(invocation, {
    appId: TEST_APPID,
    timeStamp: '1554208460',
    nonceStr: '593BEC0C930BF1AFEB40B4A08C8FB242',
    package: 'prepay_id=wx201410272009395522657a690389285100',
    signType: 'RSA',
    paySign: OFFICIAL_PAY_SIGN,
  })

  // The official docs exclude signType from the signed string; including it
  // must not accidentally match the vector.
  const wrongMessage =
    'wx2421b1c4370ec43b\n1554208460\n593BEC0C930BF1AFEB40B4A08C8FB242\nprepay_id=wx201410272009395522657a690389285100\nRSA\n'
  assert.notEqual(
    wrongMessage,
    buildWechatPayJsapiPaySignMessage(
      TEST_APPID,
      '1554208460',
      '593BEC0C930BF1AFEB40B4A08C8FB242',
      'prepay_id=wx201410272009395522657a690389285100',
    ),
  )
})

test('PAY-10 response verification accepts only the configured trust anchor', () => {
  const base = {
    signature: FIXED_RESPONSE.signature,
    timestamp: FIXED_RESPONSE.timestamp,
    nonceStr: FIXED_RESPONSE.nonce,
    serial: TEST_PLATFORM_KEY_ID,
    body: FIXED_RESPONSE.body,
    platformPublicKey: TEST_FIXED_VECTOR_PUBLIC_KEY,
    expectedSerial: TEST_PLATFORM_KEY_ID,
    now: new Date(Number(FIXED_RESPONSE.timestamp) * 1_000 + 30_000),
  }
  assert.deepEqual(verifyWechatPayResponseSignature(base), { ok: true })
  assert.equal(
    buildWechatPayResponseSignatureMessage(
      FIXED_RESPONSE.timestamp,
      FIXED_RESPONSE.nonce,
      FIXED_RESPONSE.body,
    ),
    `${FIXED_RESPONSE.timestamp}\n${FIXED_RESPONSE.nonce}\n${FIXED_RESPONSE.body}\n`,
  )

  assert.deepEqual(
    verifyWechatPayResponseSignature({ ...base, serial: 'PUB_KEY_ID_OTHER' }),
    { ok: false, reason: 'serial_mismatch' },
  )
  assert.deepEqual(
    verifyWechatPayResponseSignature({ ...base, body: `${base.body} ` }),
    { ok: false, reason: 'invalid_signature' },
  )
  assert.deepEqual(
    verifyWechatPayResponseSignature({
      ...base,
      now: new Date(Number(FIXED_RESPONSE.timestamp) * 1_000 + 301_000),
    }),
    { ok: false, reason: 'timestamp_out_of_tolerance' },
  )
  assert.deepEqual(
    verifyWechatPayResponseSignature({ ...base, timestamp: undefined }),
    { ok: false, reason: 'missing_headers' },
  )
  assert.deepEqual(
    verifyWechatPayResponseSignature({ ...base, timestamp: 'not-a-number' }),
    { ok: false, reason: 'invalid_timestamp' },
  )
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
  assert.deepEqual(
    verifyWechatPayResponseSignature({ ...base, platformPublicKey: other }),
    { ok: false, reason: 'invalid_signature' },
  )
})

test('PAY-10 official 4013053420 platform-certificate vector verifies; 4013053249 key does not', () => {
  const certPageKey = createPublicKey({
    key: OFFICIAL_CERT_PAGE_PUBLIC_KEY_PEM,
    format: 'pem',
  })
  const base = {
    signature: OFFICIAL_CERT_PAGE_RESPONSE.signature,
    timestamp: OFFICIAL_CERT_PAGE_RESPONSE.timestamp,
    nonceStr: OFFICIAL_CERT_PAGE_RESPONSE.nonce,
    serial: '4DF076AC5A7D968D4A8B0B9C59A74CB4CF8EE8A',
    body: OFFICIAL_CERT_PAGE_RESPONSE.body,
    expectedSerial: '4DF076AC5A7D968D4A8B0B9C59A74CB4CF8EE8A',
    now: new Date(Number(OFFICIAL_CERT_PAGE_RESPONSE.timestamp) * 1_000 + 30_000),
  }
  assert.deepEqual(
    verifyWechatPayResponseSignature({ ...base, platformPublicKey: certPageKey }),
    { ok: true },
  )
  // The 4013053249 public-key page republishes this signature with a different
  // key; it must fail. This is the precise finding, not "all official examples
  // are unpaired".
  assert.deepEqual(
    verifyWechatPayResponseSignature({
      ...base,
      serial: 'PUB_KEY_ID_0000000000000024101100397200000006',
      expectedSerial: 'PUB_KEY_ID_0000000000000024101100397200000006',
      platformPublicKey: TEST_OFFICIAL_PUBLIC_PAGE_KEY,
    }),
    { ok: false, reason: 'invalid_signature' },
  )
})

test('PAY-10 nonces are 32-character uppercase hex and not repeated', () => {
  const first = createNonceStr()
  const second = createNonceStr()
  assert.match(first, /^[0-9A-F]{32}$/u)
  assert.match(second, /^[0-9A-F]{32}$/u)
  assert.notEqual(first, second)
})

test('PAY-10 merchant configuration fails closed and never exposes key material', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pay-10-config-'))
  const merchantKeyPath = join(directory, 'merchant-key.pem')
  const platformKeyPath = join(directory, 'platform-key.pem')
  writeFileSync(merchantKeyPath, TEST_MERCHANT_PRIVATE_KEY_PEM)
  writeFileSync(platformKeyPath, TEST_PLATFORM_PUBLIC_KEY_PEM)

  const complete: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    WECHAT_PAY_MCHID: TEST_MCHID,
    WECHAT_PAY_APPID: TEST_APPID,
    WECHAT_PAY_MERCHANT_SERIAL_NO: TEST_MERCHANT_SERIAL,
    WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE: merchantKeyPath,
    WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE: platformKeyPath,
    WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID: TEST_PLATFORM_KEY_ID,
    WECHAT_PAY_NOTIFY_URL: 'https://local-life.example.test/api/payments/wechat/notify',
    WECHAT_PAY_API_BASE_URL: 'http://127.0.0.1:59999',
  }

  try {
    const absent = loadConfig({ NODE_ENV: 'test' })
    assert.equal(absent.wechatPay, undefined)

    const configured = loadConfig(complete)
    assert.ok(configured.wechatPay)
    assert.equal(configured.wechatPay.mchid, TEST_MCHID)
    assert.equal(configured.wechatPay.appId, TEST_APPID)
    assert.equal(configured.wechatPay.merchantSerialNo, TEST_MERCHANT_SERIAL)
    assert.equal(configured.wechatPay.platformKeyMode, 'public_key')
    assert.equal(configured.wechatPay.platformKeyId, TEST_PLATFORM_KEY_ID)
    assert.equal(configured.wechatPay.timeoutMs, 10_000)
    assert.equal(configured.wechatPay.merchantPrivateKey.asymmetricKeyType, 'rsa')
    // KeyObject is not serializable to PEM, so a logged config object cannot
    // leak the private key.
    assert.equal(JSON.stringify(configured).includes('PRIVATE KEY'), false)
    assert.equal(JSON.stringify(configured.wechatPay).includes('BEGIN'), false)
    assert.ok(TEST_MERCHANT_PUBLIC_KEY_PEM.includes('PUBLIC KEY'))

    const partial = { ...complete }
    delete partial.WECHAT_PAY_MCHID
    assert.throws(() => loadConfig(partial), (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.match(error.message, /WECHAT_PAY_MCHID/u)
      return true
    })

    const withoutPlatform = { ...complete }
    delete withoutPlatform.WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE
    assert.throws(() => loadConfig(withoutPlatform), /exactly one of/u)

    const withoutKeyId = { ...complete }
    delete withoutKeyId.WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID
    assert.throws(() => loadConfig(withoutKeyId), /WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID/u)

    const invalidKeyPath = join(directory, 'invalid-key.pem')
    writeFileSync(invalidKeyPath, 'not-a-key-material')
    assert.throws(
      () => loadConfig({ ...complete, WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE: invalidKeyPath }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.match(error.message, /does not contain a PEM private key/u)
        assert.equal(error.message.includes('not-a-key-material'), false)
        return true
      },
    )

    const { privateKey: smallKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
    const smallKeyPath = join(directory, 'small-key.pem')
    writeFileSync(smallKeyPath, smallKey.export({ format: 'pem', type: 'pkcs8' }).toString())
    assert.throws(
      () => loadConfig({ ...complete, WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE: smallKeyPath }),
      /at least 2048 bits/u,
    )

    assert.throws(
      () => loadConfig({ ...complete, WECHAT_PAY_NOTIFY_URL: 'http://local-life.example.test/notify' }),
      /must use https/u,
    )
    assert.throws(
      () => loadConfig({ ...complete, WECHAT_PAY_APPID: 'not-an-appid' }),
      /WECHAT_PAY_APPID/u,
    )
    assert.throws(
      () => loadConfig({ ...complete, WECHAT_PAY_TIMEOUT_MS: '10' }),
      /WECHAT_PAY_TIMEOUT_MS/u,
    )
    assert.throws(
      () => loadConfig({ ...complete, WECHAT_PAY_API_BASE_URL: 'http://api.example.test' }),
      /loopback/u,
    )

    const production: NodeJS.ProcessEnv = {
      ...complete,
      NODE_ENV: 'production',
      WEB_BASE_URL: 'https://local-life.example.test/',
    }
    delete production.WECHAT_PAY_API_BASE_URL
    assert.ok(loadConfig(production).wechatPay)
    assert.throws(
      () =>
        loadConfig({
          ...production,
          WECHAT_PAY_API_BASE_URL: 'http://api.example.test',
        }),
      /https in production/u,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
