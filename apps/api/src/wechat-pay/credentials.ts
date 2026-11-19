import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

/**
 * PAY-10 single-merchant WeChat Pay credentials.
 *
 * Design boundaries (these are contract, not implementation detail):
 *
 * - The merchant API private key is read from a server-controlled file at
 *   startup and kept only as a `KeyObject`. It is never written to SQLite, never
 *   returned by an HTTP route, never put into a log line and never serialized
 *   into the API config JSON (`JSON.stringify(new KeyObject)` cannot emit PEM).
 * - The WeChat Pay platform *public* key (recommended by the current official
 *   docs) or a platform *certificate* is the only trust anchor for verifying
 *   WeChat's HTTP responses. The APIv3 key is deliberately absent: it decrypts
 *   callback resources, which belongs to PAY-11, not to outbound signing.
 * - All-or-nothing configuration: a partially supplied merchant group fails
 *   startup instead of silently advertising a channel that cannot work.
 * - Errors name the variable and the expected shape, never key material, its
 *   prefix/suffix or the file contents.
 */

export interface WechatPayEnvInput {
  WECHAT_PAY_MCHID?: string
  WECHAT_PAY_APPID?: string
  WECHAT_PAY_MERCHANT_SERIAL_NO?: string
  WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE?: string
  WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE?: string
  WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID?: string
  WECHAT_PAY_PLATFORM_CERTIFICATE_FILE?: string
  WECHAT_PAY_NOTIFY_URL?: string
  WECHAT_PAY_API_BASE_URL?: string
  WECHAT_PAY_TIMEOUT_MS?: number
}

export interface WechatPayRuntimeConfig {
  mchid: string
  appId: string
  /** Merchant API certificate serial number declared in `Authorization.serial_no`. */
  merchantSerialNo: string
  merchantPrivateKey: KeyObject
  /** Trust anchor for `Wechatpay-Signature`; never sent to a client. */
  platformPublicKey: KeyObject
  /** `Wechatpay-Serial` value this deployment trusts. */
  platformKeyId: string
  platformKeyMode: 'public_key' | 'platform_certificate'
  notifyUrl: string
  apiBaseUrl: string
  timeoutMs: number
}

export class WechatPayConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WechatPayConfigError'
  }
}

export const WECHAT_PAY_DEFAULT_API_BASE_URL = 'https://api.mch.weixin.qq.com'
const MAX_KEY_FILE_BYTES = 64 * 1024

const REQUIRED_GROUP = [
  'WECHAT_PAY_MCHID',
  'WECHAT_PAY_APPID',
  'WECHAT_PAY_MERCHANT_SERIAL_NO',
  'WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE',
  'WECHAT_PAY_NOTIFY_URL',
] as const

function readKeyFile(path: string, variable: string): string {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) {
      throw new WechatPayConfigError(`${variable} must point to a regular file`)
    }
    // Refuse a file another local principal can rewrite. Deployments should
    // mount the key read-only; this check keeps an accidentally world-writable
    // copy from being accepted silently. Windows ACLs are not represented by
    // POSIX mode bits, so the operational read-only mount note still applies.
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
      throw new WechatPayConfigError(
        `${variable} must not be writable by group or others; mount it read-only`,
      )
    }
    if (stat.size > MAX_KEY_FILE_BYTES) {
      throw new WechatPayConfigError(`${variable} is unexpectedly large for a PEM credential`)
    }
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof WechatPayConfigError) throw error
    const code =
      error instanceof Error && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : 'unknown'
    throw new WechatPayConfigError(`${variable} could not be read (${code})`)
  }
}

function loadMerchantPrivateKey(path: string): KeyObject {
  const contents = readKeyFile(path, 'WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE')
  if (!contents.includes('PRIVATE KEY')) {
    throw new WechatPayConfigError(
      'WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE does not contain a PEM private key',
    )
  }
  if (contents.includes('ENCRYPTED PRIVATE KEY')) {
    throw new WechatPayConfigError(
      'WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE must not be passphrase protected',
    )
  }
  let key: KeyObject
  try {
    key = createPrivateKey({ key: contents, format: 'pem' })
  } catch {
    throw new WechatPayConfigError(
      'WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE is not a valid PEM private key',
    )
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new WechatPayConfigError(
      'WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE must contain an RSA private key',
    )
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (modulusLength < 2048) {
    throw new WechatPayConfigError(
      'WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE must be an RSA key of at least 2048 bits',
    )
  }
  return key
}

function loadPlatformPublicKey(
  value: WechatPayEnvInput,
): { key: KeyObject; keyId: string; mode: 'public_key' | 'platform_certificate' } {
  const certificateFile = value.WECHAT_PAY_PLATFORM_CERTIFICATE_FILE?.trim()
  const publicKeyFile = value.WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE?.trim()
  if (Boolean(certificateFile) === Boolean(publicKeyFile)) {
    throw new WechatPayConfigError(
      'Configure exactly one of WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE or WECHAT_PAY_PLATFORM_CERTIFICATE_FILE',
    )
  }

  if (publicKeyFile) {
    const keyId = value.WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID?.trim()
    if (!keyId) {
      throw new WechatPayConfigError(
        'WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID is required when WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE is configured',
      )
    }
    const contents = readKeyFile(publicKeyFile, 'WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE')
    let key: KeyObject
    try {
      key = createPublicKey({ key: contents, format: 'pem' })
    } catch {
      throw new WechatPayConfigError(
        'WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE is not a valid PEM public key',
      )
    }
    if (key.asymmetricKeyType !== 'rsa') {
      throw new WechatPayConfigError(
        'WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE must contain an RSA public key',
      )
    }
    const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0
    if (modulusLength < 2048) {
      throw new WechatPayConfigError(
        'WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE must be an RSA key of at least 2048 bits',
      )
    }
    return { key, keyId, mode: 'public_key' }
  }

  if (value.WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID?.trim()) {
    throw new WechatPayConfigError(
      'WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID is only valid with WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE',
    )
  }
  const contents = readKeyFile(certificateFile!, 'WECHAT_PAY_PLATFORM_CERTIFICATE_FILE')
  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(contents)
  } catch {
    throw new WechatPayConfigError(
      'WECHAT_PAY_PLATFORM_CERTIFICATE_FILE is not a valid PEM certificate',
    )
  }
  const now = Date.now()
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) < now) {
    throw new WechatPayConfigError(
      'WECHAT_PAY_PLATFORM_CERTIFICATE_FILE is not currently valid; rotate the platform certificate',
    )
  }
  const key = certificate.publicKey
  if (key.asymmetricKeyType !== 'rsa') {
    throw new WechatPayConfigError(
      'WECHAT_PAY_PLATFORM_CERTIFICATE_FILE must contain an RSA public key',
    )
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (modulusLength < 2048) {
    throw new WechatPayConfigError(
      'WECHAT_PAY_PLATFORM_CERTIFICATE_FILE must use an RSA key of at least 2048 bits',
    )
  }
  return {
    key,
    keyId: certificate.serialNumber.toUpperCase(),
    mode: 'platform_certificate',
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
}

function assertHttpUrl(value: string, variable: string, nodeEnv: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WechatPayConfigError(`${variable} must be a valid absolute URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WechatPayConfigError(`${variable} must use http or https`)
  }
  if (url.username || url.password) {
    throw new WechatPayConfigError(`${variable} must not contain embedded credentials`)
  }
  if (nodeEnv === 'production' && url.protocol !== 'https:') {
    throw new WechatPayConfigError(`${variable} must use https in production`)
  }
  return url
}

/**
 * Resolve the optional single-merchant runtime. `undefined` means "not
 * configured": the capability endpoint then reports `wechatJsapiAvailable=false`
 * and both intent creation and prepay fail closed with 503. Any partially or
 * incorrectly supplied group throws and fails startup.
 */
export function loadWechatPayRuntime(
  value: WechatPayEnvInput,
  nodeEnv: string,
): WechatPayRuntimeConfig | undefined {
  const supplied = [
    ...REQUIRED_GROUP,
    'WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE',
    'WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID',
    'WECHAT_PAY_PLATFORM_CERTIFICATE_FILE',
  ].some((name) => Boolean(value[name as keyof WechatPayEnvInput]))

  if (!supplied) return undefined

  const missing = REQUIRED_GROUP.filter((name) => !value[name])
  if (missing.length > 0) {
    throw new WechatPayConfigError(
      `${missing.join(', ')} required when WeChat Pay is configured`,
    )
  }

  const mchid = value.WECHAT_PAY_MCHID!.trim()
  const appId = value.WECHAT_PAY_APPID!.trim()
  const merchantSerialNo = value.WECHAT_PAY_MERCHANT_SERIAL_NO!.trim().toUpperCase()
  const notifyUrl = value.WECHAT_PAY_NOTIFY_URL!.trim()
  const notify = assertHttpUrl(notifyUrl, 'WECHAT_PAY_NOTIFY_URL', nodeEnv)
  if (notify.protocol !== 'https:') {
    throw new WechatPayConfigError('WECHAT_PAY_NOTIFY_URL must use https')
  }

  const apiBaseUrl = (value.WECHAT_PAY_API_BASE_URL ?? WECHAT_PAY_DEFAULT_API_BASE_URL)
    .trim()
    .replace(/\/+$/u, '')
  const apiBase = assertHttpUrl(apiBaseUrl, 'WECHAT_PAY_API_BASE_URL', nodeEnv)
  if (apiBase.protocol !== 'https:' && !isLoopbackHostname(apiBase.hostname)) {
    throw new WechatPayConfigError(
      'WECHAT_PAY_API_BASE_URL may use http only for a loopback test server',
    )
  }

  const timeoutMs = value.WECHAT_PAY_TIMEOUT_MS ?? 10_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new WechatPayConfigError('WECHAT_PAY_TIMEOUT_MS must be an integer between 1000 and 30000')
  }

  const merchantPrivateKey = loadMerchantPrivateKey(
    value.WECHAT_PAY_MERCHANT_PRIVATE_KEY_FILE!.trim(),
  )
  const platform = loadPlatformPublicKey(value)

  return {
    mchid,
    appId,
    merchantSerialNo,
    merchantPrivateKey,
    platformPublicKey: platform.key,
    platformKeyId: platform.keyId,
    platformKeyMode: platform.mode,
    notifyUrl: notifyUrl,
    apiBaseUrl,
    timeoutMs,
  }
}
