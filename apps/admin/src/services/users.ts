import {
  apiErrorSchema,
  userDirectoryDetailPath,
  userDirectoryDetailSchema,
  userDirectoryResponseSchema,
  USER_DIRECTORY_ROUTES,
  type UserDirectoryDetail,
  type UserDirectoryQuery,
  type UserDirectoryResponse,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Real transport for the unified platform user directory (#153 / #154).
 *
 * The browser never filters or paginates a local copy: every page, keyword,
 * role and community filter is sent to `/admin/users` and the response is
 * validated with the shared contract. A malformed or failed response is thrown
 * with its real HTTP status so the page can render the server message and clear
 * stale rows instead of pretending a request succeeded.
 */

export class UserDirectoryApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'UserDirectoryApiError'
    this.status = status
    this.code = code
  }
}

export function isUserDirectoryApiError(cause: unknown): cause is UserDirectoryApiError {
  return cause instanceof UserDirectoryApiError
}

/** Structural view of a zod schema so this app needs no direct zod dependency. */
interface SafelyParsable<T> {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }
}

function parsePayload<T>(schema: SafelyParsable<T>, payload: unknown, label: string): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new UserDirectoryApiError(200, 'invalid_response', `${label}与共享契约不一致：${detail}`)
  }
  return result.data
}

async function requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'include',
      signal,
      headers: { accept: 'application/json' },
    })
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new UserDirectoryApiError(0, 'network_error', '无法连接管理后台 API，请确认服务已启动或稍后重试。')
  }

  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload)
    throw new UserDirectoryApiError(
      response.status,
      parsed.success ? parsed.data.error.code : 'http_error',
      parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）`,
    )
  }
  if (payload === null) {
    throw new UserDirectoryApiError(response.status, 'invalid_response', '服务返回了无法解析的响应。')
  }
  return payload
}

/**
 * GET /admin/users — server-side pagination, keyword, role and community.
 * The query shape is the shared `UserDirectoryQuery` contract, never a local
 * copy of its fields.
 */
export async function listUserDirectory(
  query: UserDirectoryQuery,
  signal?: AbortSignal,
): Promise<UserDirectoryResponse> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  })
  const keyword = query.keyword?.trim()
  if (keyword) params.set('keyword', keyword)
  if (query.role) params.set('role', query.role)
  if (query.community) params.set('community', query.community)

  const payload = await requestJson(
    `/api${USER_DIRECTORY_ROUTES.list}?${params.toString()}`,
    signal,
  )
  return parsePayload(userDirectoryResponseSchema, payload, '用户目录列表')
}

/** GET /admin/users/:userId — read-only account detail. */
export async function getUserDirectoryEntry(
  userId: string,
  signal?: AbortSignal,
): Promise<UserDirectoryDetail> {
  const payload = await requestJson(`/api${userDirectoryDetailPath(userId)}`, signal)
  return parsePayload(userDirectoryDetailSchema, payload, '用户详情')
}
