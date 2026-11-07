import {
  WECHAT_ADMIN_ROUTES,
  activateWechatConfigResponseSchema,
  apiErrorSchema,
  saveWechatConfigResponseSchema,
  verifyWechatConfigResponseSchema,
  wechatAdminActivatePath,
  wechatAdminConfigResponseSchema,
  wechatAdminVerifyPath,
  type ActivateWechatConfigResponse,
  type SaveWechatConfigRequest,
  type SaveWechatConfigResponse,
  type VerifyWechatConfigResponse,
  type WechatAdminConfigResponse,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Real transport for the admin WeChat public-account configuration (#113 T4).
 *
 * Every call is same-origin under `/api`, mirrors the shared `WECHAT_ADMIN_ROUTES`
 * contract and validates the response with the shared zod schema. #113 froze the
 * contract as:
 *
 * - `GET  /admin/wechat/config`
 * - `POST /admin/wechat/config/candidates`             `{ appId, appSecret, accountType }`
 * - `POST /admin/wechat/config/:id/verify`             `{ expectedUpdatedAt }`
 * - `POST /admin/wechat/config/:id/activate`           `{ expectedUpdatedAt, confirm: true }`
 *
 * The AppSecret only ever travels inside the save request body: no response
 * schema has a secret field, and this module never logs or stores it.
 */

/** An API error carrying the HTTP status and shared envelope code. */
export class WechatAdminApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'WechatAdminApiError'
    this.status = status
    this.code = code
  }
}

export function isWechatAdminApiError(cause: unknown): cause is WechatAdminApiError {
  return cause instanceof WechatAdminApiError
}

/** Structural view of a zod schema so this package needs no direct zod import. */
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
    throw new WechatAdminApiError(
      200,
      'invalid_response',
      `${label}与共享契约不一致：${detail}`,
    )
  }
  return result.data
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  csrfToken?: string
  body?: unknown
  signal?: AbortSignal
}

async function requestJson(path: string, options: RequestOptions = {}): Promise<unknown> {
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
    throw new WechatAdminApiError(
      0,
      'network_error',
      '无法连接管理后台 API，请确认 API 已启动或稍后重试。',
    )
  }

  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload)
    throw new WechatAdminApiError(
      response.status,
      parsed.success ? parsed.data.error.code : 'http_error',
      parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）`,
    )
  }
  if (payload === null) {
    throw new WechatAdminApiError(response.status, 'invalid_response', '服务返回了无法解析的响应。')
  }
  return payload
}

/** `GET /admin/wechat/config` — real state, never key material or a secret. */
export async function fetchWechatAdminConfig(
  signal?: AbortSignal,
): Promise<WechatAdminConfigResponse> {
  const payload = await requestJson(`/api${WECHAT_ADMIN_ROUTES.config}`, { signal })
  return parsePayload(wechatAdminConfigResponseSchema, payload, '公众号配置状态')
}

/**
 * `POST /admin/wechat/config/candidates` — encrypts and stores a new candidate
 * version. The response is a summary projection; the secret is never echoed.
 */
export async function saveWechatCandidate(
  csrfToken: string,
  request: SaveWechatConfigRequest,
): Promise<SaveWechatConfigResponse> {
  const payload = await requestJson(`/api${WECHAT_ADMIN_ROUTES.saveCandidate}`, {
    method: 'POST',
    csrfToken,
    body: request,
  })
  return parsePayload(saveWechatConfigResponseSchema, payload, '保存公众号配置结果')
}

/**
 * `POST /admin/wechat/config/:configId/verify` — performs a real WeChat token
 * call on the server. A failed verification is an error envelope, not a success.
 */
export async function verifyWechatCandidate(
  csrfToken: string,
  configId: string,
  expectedUpdatedAt: string,
): Promise<VerifyWechatConfigResponse> {
  const payload = await requestJson(`/api${wechatAdminVerifyPath(configId)}`, {
    method: 'POST',
    csrfToken,
    body: { expectedUpdatedAt },
  })
  return parsePayload(verifyWechatConfigResponseSchema, payload, '测试连接结果')
}

/**
 * `POST /admin/wechat/config/:configId/activate` — the explicit `confirm: true`
 * flag is part of the frozen contract, so this call can only happen after the
 * UI's own confirmation dialog. The response reports what was retired.
 */
export async function activateWechatCandidate(
  csrfToken: string,
  configId: string,
  expectedUpdatedAt: string,
): Promise<ActivateWechatConfigResponse> {
  const payload = await requestJson(`/api${wechatAdminActivatePath(configId)}`, {
    method: 'POST',
    csrfToken,
    body: { expectedUpdatedAt, confirm: true },
  })
  return parsePayload(activateWechatConfigResponseSchema, payload, '启用公众号配置结果')
}
