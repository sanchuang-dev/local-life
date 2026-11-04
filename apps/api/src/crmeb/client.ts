import type { z } from 'zod'
import {
  crmebOutapiEnvelopeSchema,
  crmebOutapiTokenDataSchema,
  crmebRawOrderListSchema,
  crmebRawOrderSchema,
  crmebRawProductListSchema,
  crmebRawProductSchema,
  crmebRawRefundListSchema,
  type CrmebRawOrder,
  type CrmebRawOrderList,
  type CrmebRawProduct,
  type CrmebRawProductList,
  type CrmebRawRefundList,
} from '@sanchuang-dev/local-life-contracts'
import { logEvent } from '../log.js'

/**
 * Number of milliseconds before `exp_time` at which the cached token is
 * refreshed. CRMEB's outapi token is a JWT valid for up to 30 days, but the
 * adapter refreshes early so a long sync never starts with an almost-dead token.
 */
const TOKEN_REFRESH_SKEW_MS = 60_000

export type CrmebErrorKind =
  | 'not_configured'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'contract_mismatch'
  | 'timeout'
  | 'upstream_error'

export class CrmebClientError extends Error {
  readonly kind: CrmebErrorKind
  readonly upstreamStatus: number | undefined

  constructor(
    kind: CrmebErrorKind,
    message: string,
    options: { upstreamStatus?: number } = {},
  ) {
    super(message)
    this.name = 'CrmebClientError'
    this.kind = kind
    this.upstreamStatus = options.upstreamStatus
  }
}

export interface CrmebClientOptions {
  baseUrl: string
  appId: string
  appSecret: string
  timeoutMs: number
  fetcher?: typeof fetch
  now?: () => number
}

interface CrmebProductQuery {
  page: number
  limit: number
  categoryId?: number | undefined
  keyword?: string | undefined
}

interface CrmebOrderQuery {
  page: number
  limit: number
  /** CRMEB `data` window in its `YYYY/MM/DD HH:mm:ss-YYYY/MM/DD HH:mm:ss` form. */
  dataWindow?: string | undefined
}

interface CrmebRefundQuery {
  page: number
  limit: number
}

interface UpstreamCall {
  authExpired?: boolean
  status: number
  data?: unknown
  error?: CrmebClientError
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      (error as { code?: string }).code === 'ABORT_ERR')
  )
}

/**
 * Minimal CRMEB outapi client. It is the only component that ever sees the
 * appsecret or the outapi access token; neither is logged nor returned to a
 * browser. `fetcher` and `now` are injectable for tests.
 */
export class CrmebOutapiClient {
  private token: { value: string; expiresAtMs: number } | null = null
  private tokenPromise: Promise<string> | null = null
  private readonly options: CrmebClientOptions
  private readonly fetcher: typeof fetch

  constructor(options: CrmebClientOptions) {
    this.options = options
    this.fetcher = options.fetcher ?? fetch
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  async listProducts(query: CrmebProductQuery): Promise<CrmebRawProductList> {
    return this.request('GET', '/outapi/product/list', crmebRawProductListSchema, {
      query: {
        page: query.page,
        limit: query.limit,
        cate_id: query.categoryId,
        store_name: query.keyword,
        // Evidence §4.1: only `type=1` adds the `is_show=1` condition, and the
        // controller itself does not force it. The service still filters on
        // `is_show` defensively because a caller could otherwise see off-shelf rows.
        type: 1,
      },
    })
  }

  async getProduct(productId: number): Promise<CrmebRawProduct> {
    return this.request('GET', `/outapi/product/${productId}`, crmebRawProductSchema)
  }

  async listOrders(query: CrmebOrderQuery): Promise<CrmebRawOrderList> {
    return this.request('GET', '/outapi/order/list', crmebRawOrderListSchema, {
      query: {
        page: query.page,
        limit: query.limit,
        data: query.dataWindow,
      },
    })
  }

  /**
   * Order detail is the only outapi response that carries `refund_status`.
   * `refund_type` is unset by `OutStoreOrderServices`, so it is never read here.
   */
  async getOrderDetail(orderNo: string): Promise<CrmebRawOrder> {
    return this.request(
      'GET',
      `/outapi/order/${encodeURIComponent(orderNo)}`,
      crmebRawOrderSchema,
    )
  }

  async listRefunds(query: CrmebRefundQuery): Promise<CrmebRawRefundList> {
    return this.request('GET', '/outapi/refund/list', crmebRawRefundListSchema, {
      query: { page: query.page, limit: query.limit, refund_type: 0 },
    })
  }

  private async request<T>(
    method: 'GET',
    path: string,
    schema: z.ZodType<T>,
    options: { query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query)
    let token = await this.ensureToken(false)
    let call = await this.call(method, url, token)

    if (call.authExpired) {
      // A single re-acquisition + retry. A second 401 is surfaced explicitly
      // instead of looping.
      this.token = null
      token = await this.ensureToken(true)
      call = await this.call(method, url, token)
      if (call.authExpired) {
        throw new CrmebClientError(
          'unauthorized',
          'CRMEB outapi 令牌失效，重新获取后仍被拒绝；请检查 appid/appsecret 与接口授权',
        )
      }
    }

    if (call.error) throw call.error
    if (!('data' in call)) {
      throw new CrmebClientError('contract_mismatch', 'CRMEB outapi 响应缺少 data')
    }

    const parsed = schema.safeParse(call.data)
    if (!parsed.success) {
      throw new CrmebClientError(
        'contract_mismatch',
        `CRMEB outapi 响应与证据契约不一致：${parsed.error.issues[0]?.path.join('.') || 'data'}`,
      )
    }
    return parsed.data
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): URL {
    const url = new URL(`${this.options.baseUrl.replace(/\/+$/, '')}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    return url
  }

  private async call(method: 'GET', url: URL, token: string): Promise<UpstreamCall> {
    const startedAt = performance.now()
    let response: Response
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          accept: 'application/json',
          'Authori-zation': token,
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error) {
      logEvent('crmeb.outapi.call', {
        method,
        path: url.pathname,
        outcome: isAbortError(error) ? 'timeout' : 'network_error',
        durationMs: Math.round(performance.now() - startedAt),
      })
      if (isAbortError(error)) {
        throw new CrmebClientError('timeout', 'CRMEB outapi 请求超时')
      }
      throw new CrmebClientError('upstream_error', 'CRMEB outapi 网络不可用')
    }

    if (response.status === 401) {
      logEvent('crmeb.outapi.call', {
        method,
        path: url.pathname,
        httpStatus: 401,
        outcome: 'auth_expired',
        durationMs: Math.round(performance.now() - startedAt),
      })
      return { authExpired: true, status: 401 }
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      logEvent('crmeb.outapi.call', {
        method,
        path: url.pathname,
        httpStatus: response.status,
        outcome: 'invalid_json',
        durationMs: Math.round(performance.now() - startedAt),
      })
      throw new CrmebClientError('contract_mismatch', 'CRMEB outapi 返回了非 JSON 响应')
    }

    const envelope = crmebOutapiEnvelopeSchema.safeParse(body)
    if (!envelope.success) {
      throw new CrmebClientError('contract_mismatch', 'CRMEB outapi 响应不符合包络结构')
    }

    logEvent('crmeb.outapi.call', {
      method,
      path: url.pathname,
      httpStatus: response.status,
      upstreamStatus: envelope.data.status,
      durationMs: Math.round(performance.now() - startedAt),
      outcome: envelope.data.status === 200 ? 'ok' : 'upstream_error',
    })

    if (envelope.data.status === 401) return { authExpired: true, status: 200 }
    if (envelope.data.status !== 200) {
      return {
        status: envelope.data.status,
        error: this.mapUpstreamError(envelope.data.status),
      }
    }
    return { status: 200, data: envelope.data.data }
  }

  private mapUpstreamError(status: number): CrmebClientError {
    if (status === 403) {
      return new CrmebClientError(
        'forbidden',
        'CRMEB outapi 无访问权限：请在商城后台「对外接口」账号中勾选所需接口',
        { upstreamStatus: status },
      )
    }
    if (status === 404) {
      return new CrmebClientError('not_found', 'CRMEB 资源不存在', {
        upstreamStatus: status,
      })
    }
    if (status === 429) {
      return new CrmebClientError('rate_limited', 'CRMEB outapi 限流，请稍后重试', {
        upstreamStatus: status,
      })
    }
    return new CrmebClientError(
      'upstream_error',
      `CRMEB outapi 返回错误状态 ${status}`,
      { upstreamStatus: status },
    )
  }

  private async ensureToken(force: boolean): Promise<string> {
    const now = this.now()
    if (!force && this.token && this.token.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
      return this.token.value
    }
    if (this.tokenPromise) return this.tokenPromise

    this.tokenPromise = this.acquireToken(Boolean(this.token))
    try {
      return await this.tokenPromise
    } finally {
      this.tokenPromise = null
    }
  }

  /**
   * Refreshes with `refresh_token` when a token already exists (CRMEB deletes
   * the old token on refresh), but falls back to `access_token` when the refresh
   * route is not authorized. 401 handling clears the cache first, so it always
   * performs a full `access_token` exchange.
   */
  private async acquireToken(preferRefresh: boolean): Promise<string> {
    if (preferRefresh && this.token) {
      try {
        return await this.fetchToken('refresh', this.token.value)
      } catch (error) {
        if (
          error instanceof CrmebClientError &&
          (error.kind === 'timeout' || error.kind === 'contract_mismatch')
        ) {
          throw error
        }
        this.token = null
      }
    }
    return await this.fetchToken('access')
  }

  private async fetchToken(
    mode: 'access' | 'refresh',
    currentToken?: string,
  ): Promise<string> {
    const path = mode === 'access' ? '/outapi/access_token' : '/outapi/refresh_token'
    const body =
      mode === 'access'
        ? { appid: this.options.appId, appsecret: this.options.appSecret }
        : { access_token: currentToken }
    const url = this.buildUrl(path)
    const startedAt = performance.now()

    let response: Response
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error) {
      logEvent('crmeb.outapi.token', {
        mode,
        outcome: isAbortError(error) ? 'timeout' : 'network_error',
        durationMs: Math.round(performance.now() - startedAt),
      })
      if (isAbortError(error)) {
        throw new CrmebClientError('timeout', 'CRMEB outapi 获取令牌超时')
      }
      throw new CrmebClientError('upstream_error', 'CRMEB outapi 网络不可用')
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new CrmebClientError('contract_mismatch', 'CRMEB 令牌接口返回了非 JSON 响应')
    }

    const envelope = crmebOutapiEnvelopeSchema.safeParse(payload)
    if (!envelope.success) {
      throw new CrmebClientError('contract_mismatch', 'CRMEB 令牌接口响应不符合包络结构')
    }
    logEvent('crmeb.outapi.token', {
      mode,
      httpStatus: response.status,
      upstreamStatus: envelope.data.status,
      durationMs: Math.round(performance.now() - startedAt),
      outcome: envelope.data.status === 200 ? 'ok' : 'upstream_error',
    })
    if (response.status === 401 || envelope.data.status === 401) {
      throw new CrmebClientError(
        'unauthorized',
        'CRMEB outapi 拒绝了 appid/appsecret',
        { upstreamStatus: envelope.data.status },
      )
    }
    if (envelope.data.status !== 200) {
      throw this.mapUpstreamError(envelope.data.status)
    }

    const tokenData = crmebOutapiTokenDataSchema.safeParse(envelope.data.data)
    if (!tokenData.success) {
      throw new CrmebClientError('contract_mismatch', 'CRMEB 令牌响应缺少 access_token/exp_time')
    }
    this.token = {
      value: tokenData.data.access_token,
      expiresAtMs: tokenData.data.exp_time * 1000,
    }
    return this.token.value
  }
}
