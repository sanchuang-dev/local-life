import { apiErrorSchema } from '@sanchuang-dev/local-life-contracts'

/**
 * Shared transport for the *local* catalogue and local-order surfaces (#109).
 *
 * Two rules shape it:
 *  - every path comes from `LOCAL_*_ROUTES` in `packages/contracts`, never a
 *    hand-written string, so the H5 cannot drift from the server;
 *  - identity, price, community and totals are never sent by the client. The
 *    body of a registration carries only the product, the quantity, an optional
 *    note and an idempotency key.
 */

/** The browser always talks to the same-origin `/api` prefix (Vite proxy or reverse proxy). */
export const API_PREFIX = '/api'

export class LocalApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly requestId: string | null

  constructor(message: string, status: number, code: string | null, requestId: string | null) {
    super(message)
    this.name = 'LocalApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export function isLocalApiError(cause: unknown): cause is LocalApiError {
  return cause instanceof LocalApiError
}

/**
 * Structural view of a zod schema, so the H5 needs no direct zod dependency and
 * still validates every payload against the shared contract.
 */
export interface SafelyParsable<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false }
}

interface LocalRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH'
  csrfToken?: string
  body?: unknown
  signal?: AbortSignal
}

function parsePayload<T>(schema: SafelyParsable<T>, payload: unknown, label: string): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new LocalApiError(
      `${label}数据格式与契约不一致，无法安全展示。`,
      200,
      'invalid_response',
      null,
    )
  }
  return parsed.data
}

/**
 * One JSON request against the same-origin API.
 *
 * `path` is a contract route (already prefixed with `/api`). A write requires a
 * real session CSRF token; without one the request is refused locally with a 401
 * instead of being sent and guessed at.
 */
export async function requestLocal<T>(
  path: string,
  schema: SafelyParsable<T>,
  label: string,
  options: LocalRequestOptions = {},
): Promise<T> {
  const { method = 'GET', csrfToken, body, signal } = options
  const headers = new Headers({ accept: 'application/json' })
  if (body !== undefined) headers.set('content-type', 'application/json')
  if (method !== 'GET') {
    if (!csrfToken) {
      throw new LocalApiError('登录状态已失效，请重新登录', 401, 'unauthorized', null)
    }
    headers.set('x-csrf-token', csrfToken)
  }

  let response: Response
  try {
    response = await fetch(path, {
      method,
      signal,
      credentials: 'include',
      cache: 'no-store',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new LocalApiError(
      '暂时无法连接服务，请检查网络后重试。',
      0,
      'network_error',
      null,
    )
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null)
    const parsed = apiErrorSchema.safeParse(payload)
    throw new LocalApiError(
      parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）`,
      response.status,
      parsed.success ? parsed.data.error.code : null,
      parsed.success ? (parsed.data.error.requestId ?? null) : null,
    )
  }

  return parsePayload(schema, await response.json().catch(() => null), label)
}

/** Build `?a=1&b=2`, dropping empty values so no filter is sent as `""`. */
export function withQuery(
  path: string,
  query: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue
    params.set(key, String(value))
  }
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

/** Fill a contract route placeholder, e.g. `:localOrderId`. */
export function fillRoute(template: string, placeholder: string, id: string): string {
  return template.replace(placeholder, encodeURIComponent(id))
}

/** A UUID for the idempotency key, with a non-secure-context fallback. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Only reached in older embedded webviews; keeps the request well-formed.
  const bytes = new Uint8Array(16)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** A user-facing sentence for a real failure, without inventing a friendlier cause. */
export function describeLocalError(cause: unknown, fallback: string): string {
  if (isLocalApiError(cause)) {
    if (cause.status === 401) return '登录状态已失效，请重新登录后再试。'
    if (cause.status === 403) return `没有权限：${cause.message}`
    if (cause.status === 404) return `数据不存在或已下线：${cause.message}`
    if (cause.status === 409) return `数据已被更新：${cause.message}`
    if (cause.status === 400) return `提交内容未被接受：${cause.message}`
    return cause.message
  }
  return cause instanceof Error ? cause.message : fallback
}
