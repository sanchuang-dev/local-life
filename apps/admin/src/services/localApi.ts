import { apiErrorSchema } from '@sanchuang-dev/local-life-contracts'

/**
 * Shared transport for the *local* catalogue + resident-order domain (#109).
 *
 * It is deliberately a separate module from `services/crm.ts`: the local domain
 * has its own error codes (`product_off_shelf`, `order_already_verified`, …) and
 * its own routes, and nothing here may be reused for the 广电 carrier orders.
 *
 * Every response is validated with the shared zod schema from
 * `@sanchuang-dev/local-life-contracts` before a page sees it, and a failure
 * keeps the real HTTP status + server message so the UI can render 401/403/409
 * states instead of a success-looking placeholder.
 */

export class LocalApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LocalApiError'
    this.status = status
    this.code = code
  }
}

export function isLocalApiError(cause: unknown): cause is LocalApiError {
  return cause instanceof LocalApiError
}

/** Structural view of a zod schema so the console needs no direct zod dependency. */
interface SafelyParsable<T> {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }
}

export function parsePayload<T>(
  schema: SafelyParsable<T>,
  payload: unknown,
  label: string,
): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new LocalApiError(200, 'invalid_response', `${label}与共享契约不一致：${detail}`)
  }
  return result.data
}

export interface LocalRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH'
  csrfToken?: string
  body?: unknown
  signal?: AbortSignal
}

export async function requestLocalJson(
  path: string,
  options: LocalRequestOptions = {},
): Promise<unknown> {
  const { method = 'GET', csrfToken, body, signal } = options
  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'include',
      signal,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new LocalApiError(0, 'network_error', '无法连接管理后台 API，请确认 API 已启动或稍后重试。')
  }

  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload)
    throw new LocalApiError(
      response.status,
      parsed.success ? parsed.data.error.code : 'http_error',
      parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）`,
    )
  }
  if (payload === null) {
    throw new LocalApiError(response.status, 'invalid_response', '服务返回了无法解析的响应。')
  }
  return payload
}

/** Replaces a single `:name` placeholder in a contracted route template. */
export function fillRoute(route: string, placeholder: string, id: string): string {
  return route.replace(placeholder, encodeURIComponent(id))
}

export type QueryValue = string | number | undefined

export function withQuery(path: string, query: Record<string, QueryValue>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue
    params.set(key, String(value))
  }
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

/** Turns any thrown value into the sentence a page should show. */
export function describeLocalError(cause: unknown, fallback: string): string {
  if (isLocalApiError(cause)) {
    switch (cause.status) {
      case 401:
        return `登录状态已失效：${cause.message}。请重新登录后重试。`
      case 403:
        return `没有权限：${cause.message}`
      case 404:
        return `数据不存在或已下线：${cause.message}`
      case 409:
        return `数据已被更新：${cause.message}。请刷新后重试。`
      case 400:
        return `请求不合法：${cause.message}`
      default:
        return cause.message || fallback
    }
  }
  return cause instanceof Error ? cause.message : fallback
}
