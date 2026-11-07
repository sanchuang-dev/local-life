import assert from 'node:assert/strict'
import test from 'node:test'
import {
  API_ERROR_CODES,
  API_ROUTES,
  apiErrorSchema,
  healthResponseSchema,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import {
  ConfigError,
  LEGACY_WECHAT_ENV_VARS,
  legacyWechatEnvVars,
  loadConfig,
} from '../src/config.js'

function testApp() {
  return createApp({ version: 'test-suite', logRequests: false })
}

test('GET /healthz returns a contract-valid payload and a request id', async () => {
  const response = await testApp().request(API_ROUTES.health)

  assert.equal(response.status, 200)
  assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/)

  const body = healthResponseSchema.parse(await response.json())
  assert.equal(body.status, 'ok')
  assert.equal(body.service, 'local-life-api')
  assert.equal(body.version, 'test-suite')
  assert.ok(body.uptimeSeconds >= 0)
})

test('unknown route returns the shared structured error envelope', async () => {
  const response = await testApp().request('/missing-route')

  assert.equal(response.status, 404)

  const body = apiErrorSchema.parse(await response.json())
  assert.equal(body.error.code, API_ERROR_CODES.notFound)
  assert.match(body.error.requestId ?? '', /^[0-9a-f-]{36}$/)
})

test('loadConfig fails loudly on invalid input', () => {
  assert.throws(() => loadConfig({ PORT: 'not-a-port' }), ConfigError)
  assert.throws(() => loadConfig({ NODE_ENV: 'staging' }), ConfigError)
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', AUTH_DEV_ENABLED: 'true' }),
    ConfigError,
  )
  assert.throws(() => loadConfig({ TRUSTED_ORIGINS: 'not-a-url' }), ConfigError)
})

test('legacy WeChat env variables are ignored; only their names are reported', () => {
  // #113: the resident provider is the database active row, so leftover pre-#113
  // variables must neither fail startup nor be read into the config snapshot.
  const config = loadConfig({
    WECHAT_APP_ID: 'wx-app-id',
    WECHAT_APP_SECRET: 'legacy-secret-must-not-be-read',
    WECHAT_REDIRECT_URI: 'https://legacy.example.test/api/auth/wechat/callback',
  })
  assert.equal('wechat' in config, false)
  assert.equal(config.wechatConfigMasterKey, undefined)

  assert.deepEqual(
    legacyWechatEnvVars({
      WECHAT_APP_ID: 'present',
      WECHAT_APP_SECRET: '   ',
      WECHAT_REDIRECT_URI: 'present',
    }),
    ['WECHAT_APP_ID', 'WECHAT_REDIRECT_URI'],
  )
  assert.deepEqual(legacyWechatEnvVars({}), [])
  assert.deepEqual([...LEGACY_WECHAT_ENV_VARS], [
    'WECHAT_APP_ID',
    'WECHAT_APP_SECRET',
    'WECHAT_REDIRECT_URI',
  ])
})

test('loadConfig applies explicit local defaults and keeps dev login disabled', () => {
  assert.deepEqual(loadConfig({}), {
    nodeEnv: 'development',
    host: '127.0.0.1',
    port: 4080,
    databasePath: '../../.data/local-life.sqlite',
    sessionTtlSeconds: 7 * 24 * 60 * 60,
    cookieSecure: false,
    trustedOrigins: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ],
    webBaseUrl: 'http://localhost:5173/local-life/',
    authDevEnabled: false,
  })
})
