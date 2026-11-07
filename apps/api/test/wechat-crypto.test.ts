import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConfigError, loadConfig } from '../src/config.js'
import {
  WECHAT_SECRET_IV_BYTES,
  WECHAT_SECRET_TAG_BYTES,
  WechatSecretError,
  decryptWechatSecret,
  encryptWechatSecret,
  wechatSecretAad,
  type EncryptedWechatSecret,
  type WechatSecretContext,
  type WechatSecretMasterKey,
} from '../src/wechat/crypto.js'

/**
 * AES-256-GCM envelope + master-key loading (#113 LL-SYS-001).
 *
 * Every key in this file is generated at runtime with `randomBytes`. No real or
 * reusable test key material is written into the repository, and no assertion
 * ever prints a key or a plaintext AppSecret.
 */

/** Clearly fake credential; it is never a real WeChat AppSecret. */
const FAKE_APP_SECRET = 'fake-wechat-app-secret-for-tests-only'

const CONTEXT: WechatSecretContext = {
  appId: 'wx0123456789abcdef',
  accountType: 'test',
}

function newMasterKey(keyId = 'v1'): WechatSecretMasterKey {
  return { key: randomBytes(32), keyId }
}

function expectSecretError(
  fn: () => unknown,
  code: WechatSecretError['code'],
): WechatSecretError {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof WechatSecretError, `expected WechatSecretError, got ${String(error)}`)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected WechatSecretError(${code})`)
}

function asBase64(bytes: Buffer): string {
  return bytes.toString('base64')
}

test('AES-256-GCM roundtrip stores only base64 and uses a random 12-byte IV / 16-byte tag', () => {
  const masterKey = newMasterKey()
  const encrypted = encryptWechatSecret(FAKE_APP_SECRET, CONTEXT, masterKey)

  // Only base64 text leaves the crypto module; the key id is a generation label.
  assert.equal(encrypted.keyId, 'v1')
  assert.match(encrypted.ciphertext, /^[A-Za-z0-9+/]+={0,2}$/)
  assert.match(encrypted.iv, /^[A-Za-z0-9+/]+={0,2}$/)
  assert.match(encrypted.tag, /^[A-Za-z0-9+/]+={0,2}$/)

  const iv = Buffer.from(encrypted.iv, 'base64')
  const tag = Buffer.from(encrypted.tag, 'base64')
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64')
  assert.equal(iv.length, WECHAT_SECRET_IV_BYTES)
  assert.equal(iv.length, 12)
  assert.equal(tag.length, WECHAT_SECRET_TAG_BYTES)
  assert.equal(tag.length, 16)
  assert.equal(ciphertext.length, Buffer.byteLength(FAKE_APP_SECRET, 'utf8'))
  // The stored ciphertext must not contain the plaintext.
  assert.equal(ciphertext.includes(Buffer.from(FAKE_APP_SECRET, 'utf8')), false)

  assert.equal(decryptWechatSecret(encrypted, CONTEXT, masterKey), FAKE_APP_SECRET)
})

test('the AAD is exactly appId:accountType', () => {
  assert.equal(wechatSecretAad(CONTEXT).toString('utf8'), 'wx0123456789abcdef:test')
  assert.equal(
    wechatSecretAad({ appId: 'wx9999999999999999', accountType: 'official' }).toString('utf8'),
    'wx9999999999999999:official',
  )
})

test('every encryption uses a fresh random IV (same secret never collides)', () => {
  const masterKey = newMasterKey()
  const first = encryptWechatSecret(FAKE_APP_SECRET, CONTEXT, masterKey)
  const second = encryptWechatSecret(FAKE_APP_SECRET, CONTEXT, masterKey)

  assert.notEqual(first.iv, second.iv)
  assert.notEqual(first.ciphertext, second.ciphertext)
  assert.equal(decryptWechatSecret(first, CONTEXT, masterKey), FAKE_APP_SECRET)
  assert.equal(decryptWechatSecret(second, CONTEXT, masterKey), FAKE_APP_SECRET)
})

test('tampered ciphertext, tag or IV fails closed', () => {
  const masterKey = newMasterKey()
  const encrypted = encryptWechatSecret(FAKE_APP_SECRET, CONTEXT, masterKey)

  const tamperedCiphertext = Buffer.from(encrypted.ciphertext, 'base64')
  tamperedCiphertext[0] = tamperedCiphertext[0] ^ 0x01
  const flipCiphertextError = expectSecretError(
    () =>
      decryptWechatSecret(
        { ...encrypted, ciphertext: asBase64(tamperedCiphertext) },
        CONTEXT,
        masterKey,
      ),
    'decrypt_failed',
  )
  assert.doesNotMatch(flipCiphertextError.message, new RegExp(FAKE_APP_SECRET))
  assert.doesNotMatch(flipCiphertextError.message, new RegExp(masterKey.key.toString('hex')))

  expectSecretError(
    () => decryptWechatSecret({ ...encrypted, tag: asBase64(randomBytes(16)) }, CONTEXT, masterKey),
    'decrypt_failed',
  )
  expectSecretError(
    () => decryptWechatSecret({ ...encrypted, iv: asBase64(randomBytes(12)) }, CONTEXT, masterKey),
    'decrypt_failed',
  )
})

test('a different master key or a different key id fails closed', () => {
  const masterKey = newMasterKey()
  const encrypted = encryptWechatSecret(FAKE_APP_SECRET, CONTEXT, masterKey)

  // Same key id, different key bytes: GCM authentication must fail.
  const wrongKey = { key: randomBytes(32), keyId: masterKey.keyId }
  expectSecretError(() => decryptWechatSecret(encrypted, CONTEXT, wrongKey), 'decrypt_failed')

  // Different key generation: rejected by key id before any decryption attempt.
  const rotatedKey: WechatSecretMasterKey = { key: randomBytes(32), keyId: 'v2' }
  const rotatedError = expectSecretError(
    () => decryptWechatSecret(encrypted, CONTEXT, rotatedKey),
    'key_id_mismatch',
  )
  assert.doesNotMatch(rotatedError.message, new RegExp(FAKE_APP_SECRET))
})

test('AAD mismatch (different appId or account type) fails closed', () => {
  const masterKey = newMasterKey()
  const encrypted = encryptWechatSecret(FAKE_APP_SECRET, CONTEXT, masterKey)

  expectSecretError(
    () =>
      decryptWechatSecret(encrypted, { ...CONTEXT, appId: 'wxffffffffffffffff' }, masterKey),
    'decrypt_failed',
  )
  expectSecretError(
    () => decryptWechatSecret(encrypted, { ...CONTEXT, accountType: 'official' }, masterKey),
    'decrypt_failed',
  )
})

test('malformed payloads and invalid key material are rejected before use', () => {
  const masterKey = newMasterKey()
  const encrypted = encryptWechatSecret(FAKE_APP_SECRET, CONTEXT, masterKey)

  const cases: Array<[string, EncryptedWechatSecret]> = [
    ['non-base64 ciphertext', { ...encrypted, ciphertext: 'not base64 !!' }],
    ['empty ciphertext', { ...encrypted, ciphertext: '' }],
    ['short iv', { ...encrypted, iv: asBase64(randomBytes(11)) }],
    ['long iv', { ...encrypted, iv: asBase64(randomBytes(13)) }],
    ['short tag', { ...encrypted, tag: asBase64(randomBytes(15)) }],
    ['non-base64 tag', { ...encrypted, tag: '!!!!' }],
    ['missing key id', { ...encrypted, keyId: '' }],
  ]
  for (const [, payload] of cases) {
    expectSecretError(() => decryptWechatSecret(payload, CONTEXT, masterKey), 'invalid_payload')
  }

  expectSecretError(
    () => decryptWechatSecret(encrypted, CONTEXT, { key: randomBytes(16), keyId: 'v1' }),
    'invalid_key',
  )
  expectSecretError(
    () => encryptWechatSecret('', CONTEXT, masterKey),
    'invalid_payload',
  )
})

/* ---------------------------- master-key loading --------------------------- */

test('missing master key is allowed and legacy env credentials are no longer loaded', () => {
  const bare = loadConfig({})
  assert.equal(bare.wechatConfigMasterKey, undefined)

  const legacy = loadConfig({
    WECHAT_APP_ID: 'wx0123456789abcdef',
    WECHAT_APP_SECRET: FAKE_APP_SECRET,
    WECHAT_REDIRECT_URI: 'https://local.example.test/api/auth/wechat/callback',
    WEB_BASE_URL: 'https://local.example.test/local-life/',
  })
  // #113 T3: the env provider snapshot is gone; leftover variables are ignored
  // (the API warns with their names only) instead of becoming a runtime source.
  assert.equal('wechat' in legacy, false)
  assert.equal(legacy.wechatConfigMasterKey, undefined)
})

test('base64 env master key loads with the default v1 key id, or an explicit id', () => {
  const raw = randomBytes(32)
  const defaulted = loadConfig({ WECHAT_CONFIG_MASTER_KEY: raw.toString('base64') })
  assert.ok(defaulted.wechatConfigMasterKey)
  assert.equal(defaulted.wechatConfigMasterKey.keyId, 'v1')
  assert.equal(defaulted.wechatConfigMasterKey.key.length, 32)
  assert.equal(defaulted.wechatConfigMasterKey.key.toString('hex'), raw.toString('hex'))

  const explicit = loadConfig({
    WECHAT_CONFIG_MASTER_KEY: raw.toString('base64'),
    WECHAT_CONFIG_KEY_ID: 'v7-rotation',
  })
  assert.equal(explicit.wechatConfigMasterKey?.keyId, 'v7-rotation')

  // An unpadded base64 value is accepted and yields the same 32 bytes.
  const unpadded = loadConfig({ WECHAT_CONFIG_MASTER_KEY: raw.toString('base64').replace(/=+$/u, '') })
  assert.equal(unpadded.wechatConfigMasterKey?.key.toString('hex'), raw.toString('hex'))
})

test('master key file is supported (base64 content, trailing newline tolerated)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'll-wechat-key-'))
  try {
    const raw = randomBytes(32)
    const filePath = join(directory, 'wechat-config-master-key')
    writeFileSync(filePath, `${raw.toString('base64')}\n`, { mode: 0o600 })

    const config = loadConfig({ WECHAT_CONFIG_MASTER_KEY_FILE: filePath })
    assert.ok(config.wechatConfigMasterKey)
    assert.equal(config.wechatConfigMasterKey.key.toString('hex'), raw.toString('hex'))
    assert.equal(config.wechatConfigMasterKey.keyId, 'v1')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('two key sources, malformed base64, wrong length or unreadable file are ConfigErrors', () => {
  const secrets: string[] = []
  const expectConfigError = (env: NodeJS.ProcessEnv, pattern: RegExp): void => {
    try {
      loadConfig(env)
    } catch (error) {
      assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`)
      assert.match(error.message, pattern)
      // The failure message must never echo any credential material.
      for (const secret of secrets) {
        assert.equal(error.message.includes(secret), false)
      }
      return
    }
    assert.fail('expected ConfigError')
  }

  const envKey = randomBytes(32).toString('base64')
  secrets.push(envKey)

  const directory = mkdtempSync(join(tmpdir(), 'll-wechat-key-'))
  try {
    const fileKey = randomBytes(32)
    const filePath = join(directory, 'key')
    writeFileSync(filePath, fileKey.toString('base64'), { mode: 0o600 })
    secrets.push(fileKey.toString('base64'))

    expectConfigError(
      { WECHAT_CONFIG_MASTER_KEY: envKey, WECHAT_CONFIG_MASTER_KEY_FILE: filePath },
      /mutually exclusive/u,
    )
    expectConfigError(
      { WECHAT_CONFIG_MASTER_KEY_FILE: join(directory, 'missing-key') },
      /could not be read/u,
    )
    expectConfigError(
      { WECHAT_CONFIG_MASTER_KEY_FILE: join(directory, 'missing-key'), WECHAT_CONFIG_KEY_ID: 'v1' },
      /WECHAT_CONFIG_MASTER_KEY_FILE/u,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }

  secrets.push('***not-base64***')
  expectConfigError({ WECHAT_CONFIG_MASTER_KEY: '***not-base64***' }, /base64/u)
  expectConfigError({ WECHAT_CONFIG_MASTER_KEY: randomBytes(16).toString('base64') }, /32 bytes/u)
  expectConfigError({ WECHAT_CONFIG_MASTER_KEY: envKey, WECHAT_CONFIG_KEY_ID: 'bad id!' }, /WECHAT_CONFIG_KEY_ID/u)
})
