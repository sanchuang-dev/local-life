import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import type { WechatAccountType } from '@sanchuang-dev/local-life-contracts'

/**
 * Authenticated encryption for persisted WeChat AppSecrets (#113 LL-SYS-001).
 *
 * Design decisions that are part of the contract, not implementation detail:
 *
 * - **AES-256-GCM** with a fresh random **12-byte IV** per encryption. GCM's
 *   security collapses if an IV is reused under the same key, so the IV is never
 *   derived from the row id or from a counter.
 * - A **16-byte authentication tag** is stored separately and verified on every
 *   decryption. `decipher.final()` throws on any tampering, so a modified
 *   ciphertext/tag/IV cannot silently produce a different secret.
 * - The AAD binds `appId:accountType`. A ciphertext copied to a row with another
 *   AppID or account type therefore fails authentication instead of being
 *   accepted as a valid credential for the wrong account.
 * - `keyId` is checked *before* decryption. A row encrypted under a different
 *   master-key generation fails closed with a distinguishable reason; it is
 *   never decrypted with the current key "to see if it works".
 * - Only base64 text is persisted (`ciphertext`/`iv`/`tag`), matching the CHECK
 *   constraints in migration 0010.
 * - Errors never include the secret, the key or a prefix/suffix of either.
 */

export const WECHAT_SECRET_ALGORITHM = 'aes-256-gcm'
/** 32 bytes = AES-256. The loader guarantees this before we ever get here. */
export const WECHAT_SECRET_KEY_BYTES = 32
/** GCM standard IV length; base64 length 16. */
export const WECHAT_SECRET_IV_BYTES = 12
/** GCM authentication tag length; base64 length 24. */
export const WECHAT_SECRET_TAG_BYTES = 16

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/** Minimal key material: the raw key plus the generation label stored with it. */
export interface WechatSecretMasterKey {
  key: Buffer
  keyId: string
}

/** What may enter SQLite. Every field is base64 text or a non-secret label. */
export interface EncryptedWechatSecret {
  ciphertext: string
  iv: string
  tag: string
  keyId: string
}

/** The identity a ciphertext is bound to via AAD. */
export interface WechatSecretContext {
  appId: string
  accountType: WechatAccountType
}

/**
 * Discriminable failure reasons. Callers (admin API / OAuth runtime) map these
 * to their own error envelopes; `decrypt_failed` must never be treated as a
 * usable credential and never causes a fallback to a different key.
 */
export type WechatSecretErrorCode =
  | 'invalid_key'
  | 'invalid_payload'
  | 'key_id_mismatch'
  | 'decrypt_failed'

export class WechatSecretError extends Error {
  readonly code: WechatSecretErrorCode

  constructor(code: WechatSecretErrorCode, message: string) {
    super(message)
    this.name = 'WechatSecretError'
    this.code = code
  }
}

export function wechatSecretAad(context: WechatSecretContext): Buffer {
  // `appId` is restricted to alphanumerics by the DTO/DB CHECK, so ':' can never
  // be part of an id and the encoding is unambiguous.
  return Buffer.from(`${context.appId}:${context.accountType}`, 'utf8')
}

function assertMasterKey(masterKey: WechatSecretMasterKey): void {
  const key = masterKey.key
  if (!Buffer.isBuffer(key) || key.length !== WECHAT_SECRET_KEY_BYTES) {
    throw new WechatSecretError(
      'invalid_key',
      `WeChat config master key must be exactly ${WECHAT_SECRET_KEY_BYTES} bytes`,
    )
  }
  if (masterKey.keyId.length === 0) {
    throw new WechatSecretError('invalid_key', 'WeChat config master key id is missing')
  }
}

function decodeBase64(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_PATTERN.test(value)) {
    throw new WechatSecretError('invalid_payload', `WeChat AppSecret ${label} is not base64`)
  }
  return Buffer.from(value, 'base64')
}

function decodeExactBytes(value: unknown, expected: number, label: string): Buffer {
  const decoded = decodeBase64(value, label)
  if (decoded.length !== expected) {
    throw new WechatSecretError(
      'invalid_payload',
      `WeChat AppSecret ${label} must decode to ${expected} bytes`,
    )
  }
  return decoded
}

/**
 * Encrypt one AppSecret. The plaintext is never stored and never returned; the
 * caller persists exactly the base64 fields of the result.
 */
export function encryptWechatSecret(
  appSecret: string,
  context: WechatSecretContext,
  masterKey: WechatSecretMasterKey,
): EncryptedWechatSecret {
  assertMasterKey(masterKey)
  if (typeof appSecret !== 'string' || appSecret.length === 0) {
    throw new WechatSecretError('invalid_payload', 'WeChat AppSecret must not be empty')
  }

  const iv = randomBytes(WECHAT_SECRET_IV_BYTES)
  const cipher = createCipheriv(WECHAT_SECRET_ALGORITHM, masterKey.key, iv)
  cipher.setAAD(wechatSecretAad(context))
  const ciphertext = Buffer.concat([cipher.update(appSecret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  if (tag.length !== WECHAT_SECRET_TAG_BYTES) {
    // Defensive: GCM always returns 16 bytes; refuse to persist anything else.
    throw new WechatSecretError('decrypt_failed', 'Unexpected WeChat AppSecret auth tag length')
  }

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    keyId: masterKey.keyId,
  }
}

/**
 * Decrypt one stored AppSecret or fail closed.
 *
 * The only successful return is the plaintext secret; every mismatch (wrong
 * key, wrong key id, wrong AAD context, tampered ciphertext/iv/tag, malformed
 * base64) throws a {@link WechatSecretError}. It never returns `null`, never
 * falls back to the legacy env provider and never logs the payload.
 */
export function decryptWechatSecret(
  payload: EncryptedWechatSecret,
  context: WechatSecretContext,
  masterKey: WechatSecretMasterKey,
): string {
  assertMasterKey(masterKey)

  if (typeof payload.keyId !== 'string' || payload.keyId.length === 0) {
    throw new WechatSecretError('invalid_payload', 'WeChat AppSecret key id is missing')
  }
  if (!constantTimeTextEqual(payload.keyId, masterKey.keyId)) {
    throw new WechatSecretError(
      'key_id_mismatch',
      'WeChat AppSecret was encrypted with a different master key id',
    )
  }

  const iv = decodeExactBytes(payload.iv, WECHAT_SECRET_IV_BYTES, 'iv')
  const tag = decodeExactBytes(payload.tag, WECHAT_SECRET_TAG_BYTES, 'tag')
  const ciphertext = decodeBase64(payload.ciphertext, 'ciphertext')
  if (ciphertext.length === 0) {
    throw new WechatSecretError('invalid_payload', 'WeChat AppSecret ciphertext is empty')
  }

  try {
    const decipher = createDecipheriv(WECHAT_SECRET_ALGORITHM, masterKey.key, iv)
    decipher.setAAD(wechatSecretAad(context))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext.toString('utf8')
  } catch {
    // Includes auth-tag failures (tamper, wrong key, wrong AAD). The caught
    // error is deliberately discarded: it may contain library detail, and the
    // caller only needs the stable `decrypt_failed` reason.
    throw new WechatSecretError(
      'decrypt_failed',
      'WeChat AppSecret could not be decrypted with the configured master key',
    )
  }
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  if (leftBytes.length !== rightBytes.length) return false
  return timingSafeEqual(leftBytes, rightBytes)
}
