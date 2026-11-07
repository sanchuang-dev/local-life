import type { WechatConfigFailureCode } from '@sanchuang-dev/local-life-contracts'

/**
 * Real WeChat credential verification (#113 LL-SYS-001 T2).
 *
 * The admin "测试连接" button must prove that an AppID/AppSecret pair actually
 * works; nothing in this module fakes success. It calls the official
 * `cgi-bin/token` endpoint with `grant_type=client_credential`, the same pair the
 * OAuth runtime would use, and maps every outcome onto the closed, redacted
 * {@link WechatConfigFailureCode} set.
 *
 * Boundaries that matter for security:
 * - The request URL contains the AppSecret (WeChat requires it), so the URL is
 *   never logged, never returned and never attached to an error.
 * - The `access_token` returned on success is deliberately NOT part of the
 *   result type. It is read only far enough to prove a token was issued, then
 *   discarded: it is never stored, logged or returned to the admin client.
 * - Upstream `errmsg` text is discarded as well. WeChat's messages can echo the
 *   request or user identifiers; the mapped Chinese message is actionable
 *   without any upstream payload.
 * - A 10 s timeout keeps a hung provider from pinning an admin request open.
 */

export const WECHAT_TOKEN_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/token'
export const WECHAT_VERIFY_TIMEOUT_MS = 10_000

export interface WechatVerifyInput {
  appId: string
  /** Plaintext in memory only; never logged or persisted by this module. */
  appSecret: string
}

export type WechatVerifyOutcome =
  | { ok: true }
  | { ok: false; code: WechatConfigFailureCode; message: string }

/**
 * WeChat errcode -> redacted failure code. Only the codes an operator can act on
 * are named; everything else is a generic provider error. 40001 means the
 * credential pair is inconsistent (a reset secret, wrong account), 40013 a bad
 * AppID, 40125 a reset/wrong AppSecret, 40164 a missing IP allowlist entry and
 * 45009 provider rate limiting.
 */
const ERRCODE_FAILURES: Readonly<Record<number, WechatConfigFailureCode>> = {
  40001: 'invalid_credential',
  40013: 'invalid_app_id',
  40125: 'invalid_app_secret',
  40164: 'api_forbidden',
  45009: 'rate_limited',
}

/** Actionable, credential-free Chinese messages for every redacted code. */
const FAILURE_MESSAGES: Readonly<Record<WechatConfigFailureCode, string>> = {
  invalid_app_id: 'AppID 无效，请核对公众号后台的 AppID（微信返回 40013）',
  invalid_app_secret: 'AppSecret 无效或已重置，请填写最新密钥后重试（微信返回 40125）',
  invalid_credential: '公众号凭证无效，请确认 AppID 与 AppSecret 属于同一公众号（微信返回 40001）',
  api_forbidden: '服务器出口 IP 不在公众号的 IP 白名单内，请先在微信后台添加后重试（微信返回 40164）',
  rate_limited: '微信接口调用频率受限，请稍后重试（微信返回 45009）',
  wechat_api_error: '微信接口返回异常，请稍后重试；若持续失败请核对公众号状态',
  network_error: '无法连接微信服务器，请检查服务器网络后重试',
  timeout: '连接微信服务器超时，请稍后重试',
  decrypt_failed: '已保存的 AppSecret 无法解密，请重新保存凭证后再验证',
  master_key_unavailable: '服务端未配置加密主密钥，暂时无法验证公众号凭证',
  unknown: '微信公众号验证失败，请稍后重试',
}

export function wechatVerifyFailureMessage(code: WechatConfigFailureCode): string {
  return FAILURE_MESSAGES[code]
}

function failure(code: WechatConfigFailureCode): WechatVerifyOutcome {
  return { ok: false, code, message: FAILURE_MESSAGES[code] }
}

/**
 * Ask WeChat whether these credentials can mint an access token.
 *
 * `fetcher` is injected from `AppOptions` so tests exercise exactly the HTTP
 * boundary; production always passes the platform `fetch` and there is no mock
 * branch anywhere in the call path.
 */
export async function verifyWechatCredentials(
  fetcher: typeof fetch,
  input: WechatVerifyInput,
  options: { timeoutMs?: number } = {},
): Promise<WechatVerifyOutcome> {
  const url = new URL(WECHAT_TOKEN_ENDPOINT)
  url.search = new URLSearchParams({
    grant_type: 'client_credential',
    appid: input.appId,
    secret: input.appSecret,
  }).toString()

  let response: Response
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? WECHAT_VERIFY_TIMEOUT_MS),
    })
  } catch (error) {
    // `AbortSignal.timeout` rejects with a DOMException named TimeoutError;
    // other transport failures (DNS, TLS, connection reset) are network errors.
    const name = error instanceof Error ? error.name : ''
    return failure(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error')
  }

  if (!response.ok) {
    // HTTP status is not part of the contract; the caller only needs to know the
    // provider answered with something that is not a token response.
    return failure('wechat_api_error')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return failure('wechat_api_error')
  }

  if (!payload || typeof payload !== 'object') return failure('wechat_api_error')
  const body = payload as { errcode?: unknown; access_token?: unknown }

  if (typeof body.errcode === 'number') {
    const mapped = ERRCODE_FAILURES[body.errcode] ?? 'wechat_api_error'
    return failure(mapped)
  }
  if (typeof body.access_token === 'string' && body.access_token.length > 0) {
    // Success. The token is intentionally dropped here: it never reaches a
    // response, a log line, an audit row or SQLite.
    return { ok: true }
  }
  // A 200 without `errcode` and without a token is not a success; treat it as a
  // provider anomaly rather than inventing one.
  return failure('wechat_api_error')
}
