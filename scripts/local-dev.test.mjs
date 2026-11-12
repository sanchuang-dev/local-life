import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveLocalPorts, localTrustedOrigins, localVitePorts } from './local-ports.mjs'
import {
  assertLocalConfig,
  isolatedLocalEnvironment,
  localEnvTemplate,
  prepareLocalFiles,
} from './local-dev.mjs'

function withWorkspace(fn) {
  const root = mkdtempSync(join(tmpdir(), 'local-life-local-dev-'))
  try {
    mkdirSync(join(root, 'apps', 'api'), { recursive: true })
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('fresh setup creates a gitignored-style local env and durable in-project db path', () => {
  withWorkspace((root) => {
    const prepared = prepareLocalFiles(root)
    // `join()` yields native separators (backslashes on Windows), so normalise the
    // path before comparing against the POSIX-style suffix. The assertion strength
    // is unchanged: the db must still live in `<workspace>/.data/`.
    assert.ok(prepared.dbPath.replaceAll('\\', '/').endsWith('/.data/local-life-dev.sqlite'))
    assert.equal(readFileSync(prepared.envPath, 'utf8'), localEnvTemplate)
    assert.doesNotThrow(() => assertLocalConfig(localEnvTemplate))
  })
})

test('repeat setup does not overwrite local config or reset the existing db file', () => {
  withWorkspace((root) => {
    const first = prepareLocalFiles(root)
    const revised = readFileSync(first.envPath, 'utf8').replace(
      'AUTH_DEV_ENABLED=true',
      'AUTH_DEV_ENABLED=false',
    )
    writeFileSync(first.envPath, revised)
    writeFileSync(first.dbPath, 'preserve existing local data')
    const second = prepareLocalFiles(root)
    assert.equal(readFileSync(second.envPath, 'utf8'), revised)
    assert.equal(readFileSync(second.dbPath, 'utf8'), 'preserve existing local data')
  })
})

test('local mode refuses production environment and arbitrary database locations', () => {
  assert.throws(
    () => assertLocalConfig(localEnvTemplate.replace('NODE_ENV=development', 'NODE_ENV=production')),
    /NODE_ENV/,
  )
  assert.throws(
    () => assertLocalConfig(localEnvTemplate.replace('../../.data/local-life-dev.sqlite', '/tmp/other.sqlite')),
    /DATABASE_PATH/,
  )
  assert.throws(
    () => assertLocalConfig(localEnvTemplate.replace('PORT=4080', 'PORT=0')),
    /PORT/,
  )
})

test('local subprocesses do not inherit exported production secrets or settings', () => {
  const env = isolatedLocalEnvironment(
    {
      NODE_ENV: 'production',
      DATABASE_PATH: '/srv/prod.sqlite',
      WECHAT_APP_SECRET: 'must-not-leak',
      COOKIE_DOMAIN: '.example.com',
      AUTH_DEV_ENABLED: 'false',
      PATH: '/usr/bin',
      HOME: '/home/demo',
    },
    '/demo/apps/api/.env.local',
  )
  assert.equal(env.DOTENV_CONFIG_PATH, '/demo/apps/api/.env.local')
  assert.equal(env.DATABASE_PATH, undefined)
  assert.equal(env.WECHAT_APP_SECRET, undefined)
  assert.equal(env.COOKIE_DOMAIN, undefined)
  assert.equal(env.NODE_ENV, undefined)
  assert.equal(env.HOME, '/home/demo')
  assert.equal(env.PATH, '/usr/bin')
})

test('custom local ports drive API, both Vite listeners, proxies and derived origins', () => {
  const content = localEnvTemplate
    .replace('PORT=4080', 'PORT=4081')
    .replace('WEB_PORT=5173', 'WEB_PORT=5222')
    .replace('ADMIN_PORT=5174', 'ADMIN_PORT=5223')
  const ports = assertLocalConfig(content)
  assert.deepEqual(ports, { api: 4081, web: 5222, admin: 5223 })
  const env = isolatedLocalEnvironment({ PORT: '9999', WEB_BASE_URL: 'https://production.invalid' }, '/example/.env.local', ports)
  assert.equal(env.PORT, '4081')
  assert.equal(env.WEB_BASE_URL, 'http://localhost:5222/local-life/')
  assert.deepEqual(localVitePorts(env), ports)
  assert.equal(env.TRUSTED_ORIGINS, localTrustedOrigins(ports))
  assert.match(env.TRUSTED_ORIGINS, /localhost:5222/)
  assert.match(env.TRUSTED_ORIGINS, /localhost:5223/)
  assert.doesNotMatch(env.TRUSTED_ORIGINS, /localhost:5173/)
})

test('ports must be unique, numeric and within bounds', () => {
  assert.throws(() => resolveLocalPorts({ PORT: '5222', WEB_PORT: '5222' }), /不同/)
  assert.throws(() => resolveLocalPorts({ PORT: 'abc' }), /PORT/)
  assert.throws(() => resolveLocalPorts({ PORT: '65536' }), /PORT/)
  assert.throws(() => resolveLocalPorts({ PORT: '0' }), /PORT/)
  assert.throws(() => resolveLocalPorts({ WEB_PORT: '4096.4' }), /WEB_PORT/)
})

test('local config refuses missing individual port fields instead of secretly falling back', () => {
  assert.throws(
    () => assertLocalConfig(localEnvTemplate.replace('WEB_PORT=5173\n', '')),
    /WEB_PORT/,
  )
  assert.throws(
    () => assertLocalConfig(localEnvTemplate.replace('ADMIN_PORT=5174\n', '')),
    /ADMIN_PORT/,
  )
})
