import { createHash, randomBytes } from 'node:crypto'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  API_ROUTES,
  wechatJsSdkSignatureRequestSchema,
  wechatJsSdkSignatureResponseSchema,
  type ApiErrorCode,
  type WechatJsSdkSignatureResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppBindings, AppContext, HttpErrorStatus } from '../http.js'
import type { WechatRuntimeConfig, WechatRuntimeResolution } from './runtime.js'

/**
 * Public-account JS-SDK signing (#122).
 *
 * Only the remote WeChat fetch is injected. The crypto, active-config lookup,
 * single-flight cache and validation are the same in tests and production.
 * Access tokens and tickets live solely in the API process, never in SQLite,
 * API responses, audit events or logs.
 */
const WECHAT_TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token'
const WECHAT_TICKET_URL = 'https://api.weixin.qq.com/cgi-bin/ticket/getticket'
const FETCH_TIMEOUT_MS = 10_000
const FAILURE_BACKOFF_MS = 15_000
const REFRESH_EARLY_MS = 5 * 60_000

export class WechatJsSdkError extends Error {
  readonly status: HttpErrorStatus
  readonly code: ApiErrorCode

  constructor(status: HttpErrorStatus, code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'WechatJsSdkError'
    this.status = status
    this.code = code
  }
}

function unavailable(message = '微信 JS-SDK 服务暂不可用，请稍后重试'): WechatJsSdkError {
  return new WechatJsSdkError(503, API_ERROR_CODES.wechatJsSdkUnavailable, message)
}

function providerFailure(rateLimited: boolean): WechatJsSdkError {
  return rateLimited
    ? new WechatJsSdkError(429, API_ERROR_CODES.rateLimited, '微信接口调用过于频繁，请稍后重试')
    : unavailable('获取微信 JS-SDK 票据失败，请稍后重试')
}

/**
 * Sign precisely the string required by the WeChat JS-SDK:
 * jsapi_ticket=...&noncestr=...&timestamp=...&url=<URL without #fragment>
 */
export function signWechatJsSdk(
  ticket: string,
  nonceStr: string,
  timestamp: number,
  pageUrl: string,
): string {
  return createHash('sha1')
    .update(`jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${pageUrl}`, 'utf8')
    .digest('hex')
}

/**
 * The only signable site is the configured resident H5, not another value in
 * TRUSTED_ORIGINS (which also includes the separate admin domain).
 * The input may contain a hash for HashRouter interoperability; it is dropped.
 */
export function validatedWechatPageUrl(input: string, webBaseUrl: string): string {
  const bad = () => new WechatJsSdkError(400, API_ERROR_CODES.invalidRequest, '页面 URL 无效或不属于居民站点')
  if (
    input.length === 0 ||
    input.length > 4096 ||
    input !== input.trim() ||
    /[\\\u0000-\u001f\u007f]/u.test(input)
  ) throw bad()

  let url: URL
  let base: URL
  try {
    url = new URL(input)
    base = new URL(webBaseUrl)
  } catch {
    throw bad()
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.protocol !== base.protocol ||
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/')
  ) throw bad()
  url.hash = ''
  return url.toString()
}

interface CachedSecret {
  value: string
  refreshAtMs: number
}

interface ProviderSlot {
  key: string
  token: CachedSecret | null
  ticket: CachedSecret | null
  tokenFlight: Promise<string> | null
  ticketFlight: Promise<string> | null
  blockedUntilMs: number
  failure: WechatJsSdkError | null
}

function cacheEntry(value: string, expiresInSeconds: number, nowMs: number): CachedSecret {
  // Never trust an implausibly long provider lifetime to pin credentials.
  const duration = Math.min(expiresInSeconds, 7200) * 1000
  return {
    value,
    refreshAtMs: nowMs + duration - Math.min(REFRESH_EARLY_MS, duration / 10),
  }
}

function keyFor(config: WechatRuntimeConfig): string {
  return `${config.configId}:${config.revision}:${config.appId}`
}

export class WechatJsSdkSigner {
  private slot: ProviderSlot | null = null

  private readonly resolveRuntime: () => WechatRuntimeResolution
  private readonly fetcher: typeof fetch
  private readonly nowMs: () => number

  constructor(
    resolveRuntime: () => WechatRuntimeResolution,
    fetcher: typeof fetch,
    nowMs: () => number = () => Date.now(),
  ) {
    this.resolveRuntime = resolveRuntime
    this.fetcher = fetcher
    this.nowMs = nowMs
  }

  private active(): { config: WechatRuntimeConfig; slot: ProviderSlot } {
    const result = this.resolveRuntime()
    if (!result.ok) {
      // A missing, retired or undecryptable provider must not leave a usable
      // cache behind. No plaintext details are returned to the caller.
      this.slot = null
      throw unavailable(
        result.reason === 'not_configured'
          ? '尚未启用微信公众号，暂不能使用微信 JS-SDK'
          : '微信公众号配置当前不可用，请联系管理员',
      )
    }
    const key = keyFor(result.config)
    if (!this.slot || this.slot.key !== key) {
      // Config switch invalidates both token and ticket (and in-flight work).
      // Old flights only mutate their captured, detached ProviderSlot object.
      this.slot = {
        key, token: null, ticket: null, tokenFlight: null, ticketFlight: null,
        blockedUntilMs: 0, failure: null,
      }
    }
    return { config: result.config, slot: this.slot }
  }

  async sign(pageUrl: string): Promise<WechatJsSdkSignatureResponse> {
    const { config, slot } = this.active()
    if (slot.failure && this.nowMs() < slot.blockedUntilMs) throw slot.failure
    const ticket = await this.ticket(slot, config)

    // Never sign with the old AppID when the provider changed during either
    // remote fetch. A new request can safely retry under the current version.
    const current = this.resolveRuntime()
    if (!current.ok || keyFor(current.config) !== slot.key) {
      this.slot = this.slot === slot ? null : this.slot
      throw unavailable('微信公众号配置已切换，请重试签名')
    }

    const timestamp = Math.floor(this.nowMs() / 1000)
    const nonceStr = randomBytes(16).toString('hex')
    return wechatJsSdkSignatureResponseSchema.parse({
      appId: config.appId,
      timestamp,
      nonceStr,
      signature: signWechatJsSdk(ticket, nonceStr, timestamp, pageUrl),
    })
  }

  private async fetchJson(url: URL): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch {
      // Never throw the original error (it may contain a URL with AppSecret).
      throw providerFailure(false)
    }
    if (!response.ok) throw providerFailure(response.status === 429)
    let data: unknown
    try {
      data = await response.json()
    } catch {
      throw providerFailure(false)
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw providerFailure(false)
    const payload = data as Record<string, unknown>
    if (payload.errcode !== undefined && payload.errcode !== 0) {
      throw providerFailure(payload.errcode === 45009)
    }
    return payload
  }

  private async token(slot: ProviderSlot, config: WechatRuntimeConfig): Promise<string> {
    if (slot.token && this.nowMs() < slot.token.refreshAtMs) return slot.token.value
    if (slot.tokenFlight) return slot.tokenFlight
    const flight = (async () => {
      const url = new URL(WECHAT_TOKEN_URL)
      url.search = new URLSearchParams({
        grant_type: 'client_credential', appid: config.appId, secret: config.appSecret,
      }).toString()
      const data = await this.fetchJson(url)
      if (
        typeof data.access_token !== 'string' || data.access_token.length === 0 ||
        !Number.isInteger(data.expires_in) || (data.expires_in as number) <= 0
      ) throw providerFailure(false)
      const entry = cacheEntry(data.access_token, data.expires_in as number, this.nowMs())
      slot.token = entry
      return entry.value
    })()
    slot.tokenFlight = flight
    try {
      return await flight
    } finally {
      if (slot.tokenFlight === flight) slot.tokenFlight = null
    }
  }

  private async ticket(slot: ProviderSlot, config: WechatRuntimeConfig): Promise<string> {
    if (slot.ticket && this.nowMs() < slot.ticket.refreshAtMs) return slot.ticket.value
    if (slot.ticketFlight) return slot.ticketFlight
    const flight = (async () => {
      try {
        const token = await this.token(slot, config)
        const url = new URL(WECHAT_TICKET_URL)
        url.search = new URLSearchParams({ access_token: token, type: 'jsapi' }).toString()
        const data = await this.fetchJson(url)
        if (
          data.errcode !== 0 ||
          typeof data.ticket !== 'string' || data.ticket.length === 0 ||
          !Number.isInteger(data.expires_in) || (data.expires_in as number) <= 0
        ) throw providerFailure(false)
        const entry = cacheEntry(data.ticket, data.expires_in as number, this.nowMs())
        slot.ticket = entry
        slot.failure = null
        slot.blockedUntilMs = 0
        return entry.value
      } catch (cause) {
        // No cached failure contains tokens or upstream error text. Backoff
        // prevents repeated failed browser initializations hammering WeChat.
        const error = cause instanceof WechatJsSdkError ? cause : providerFailure(false)
        slot.failure = error
        slot.blockedUntilMs = this.nowMs() + FAILURE_BACKOFF_MS
        slot.token = null
        slot.ticket = null
        throw error
      }
    })()
    slot.ticketFlight = flight
    try {
      return await flight
    } finally {
      if (slot.ticketFlight === flight) slot.ticketFlight = null
    }
  }
}

export interface WechatJsSdkRouteDeps {
  config: ApiConfig
  fetcher: typeof fetch
  resolveRuntime: () => WechatRuntimeResolution
  fail: (c: AppContext, status: HttpErrorStatus, code: ApiErrorCode, message: string) => Response
  nowMs?: () => number
}

export function registerWechatJsSdkRoutes(
  app: Hono<AppBindings>,
  deps: WechatJsSdkRouteDeps,
): void {
  // Construct once per app, not per request; DB provider is resolved fresh for
  // each signature, so admin hot activation works without restarting.
  const signer = new WechatJsSdkSigner(deps.resolveRuntime, deps.fetcher, deps.nowMs)
  const residentOrigin = new URL(deps.config.webBaseUrl).origin

  app.post(API_ROUTES.wechatJsSdkSignature, async (c) => {
    c.header('Cache-Control', 'no-store')
    // Browsers send Origin for same-origin JSON POSTs; do not let the admin
    // Origin or an arbitrary third party invoke this public H5 endpoint.
    if (c.req.header('origin') !== residentOrigin) {
      return deps.fail(c, 403, API_ERROR_CODES.forbidden, '仅允许居民站点申请微信签名')
    }
    const length = Number(c.req.header('content-length') ?? 0)
    if (length > 8192) {
      return deps.fail(c, 400, API_ERROR_CODES.invalidRequest, '请求体过大')
    }
    const parsed = wechatJsSdkSignatureRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!parsed.success) {
      return deps.fail(c, 400, API_ERROR_CODES.invalidRequest, '页面 URL 参数无效')
    }
    try {
      const url = validatedWechatPageUrl(parsed.data.url, deps.config.webBaseUrl)
      const result = await signer.sign(url)
      return c.json(wechatJsSdkSignatureResponseSchema.parse(result))
    } catch (cause) {
      const error = cause instanceof WechatJsSdkError
        ? cause
        : unavailable()
      return deps.fail(c, error.status, error.code, error.message)
    }
  })
}
