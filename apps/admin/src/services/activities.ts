import {
  ACTIVITY_ROUTES,
  activityAuditEntryListResponseSchema,
  activityRuleVersionListResponseSchema,
  adminActivityDetailSchema,
  adminActivityListResponseSchema,
  apiErrorSchema,
  authCommunitySchema,
  type ActivityAuditEntryListResponse,
  type ActivityRuleVersionListResponse,
  type ActivityStatus,
  type AdminActivityDetail,
  type AdminActivityListResponse,
  type CreateActivityRequest,
  type UpdateActivityRequest,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Real activity-domain transport for the admin console.
 *
 * Every call goes through the same-origin `/api` prefix, mirrors the shared
 * `ACTIVITY_ROUTES` contract and validates the response with the shared zod
 * schema. A failed or malformed response is thrown as an `ActivityApiError` so
 * pages can render the actual server message instead of a success-looking
 * placeholder.
 */

/** Status/code carried through from the API error envelope. */
export class ActivityApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ActivityApiError'
    this.status = status
    this.code = code
  }
}

export function isActivityApiError(cause: unknown): cause is ActivityApiError {
  return cause instanceof ActivityApiError
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
    throw new ActivityApiError(
      200,
      'invalid_response',
      `${label}与共享契约不一致：${detail}`,
    )
  }
  return result.data
}

function pathWithId(route: string, activityId: string): string {
  return `/api${route.replace(':activityId', encodeURIComponent(activityId))}`
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH'
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
    throw new ActivityApiError(
      0,
      'network_error',
      '无法连接管理后台 API，请确认 API 已启动或稍后重试。',
    )
  }

  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload)
    throw new ActivityApiError(
      response.status,
      parsed.success ? parsed.data.error.code : 'http_error',
      parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）`,
    )
  }
  if (payload === null) {
    throw new ActivityApiError(response.status, 'invalid_response', '服务返回了无法解析的响应。')
  }
  return payload
}

export interface ActivityListQuery {
  page: number
  pageSize: number
  communityId?: string
  status?: ActivityStatus
  keyword?: string
}

/** GET /admin/activities — server-side paging and filters. */
export async function listActivities(
  query: ActivityListQuery,
  signal?: AbortSignal,
): Promise<AdminActivityListResponse> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  })
  if (query.communityId) params.set('communityId', query.communityId)
  if (query.status) params.set('status', query.status)
  const keyword = query.keyword?.trim()
  if (keyword) params.set('keyword', keyword)

  const payload = await requestJson(`/api${ACTIVITY_ROUTES.adminList}?${params.toString()}`, {
    signal,
  })
  return parsePayload(adminActivityListResponseSchema, payload, '活动列表')
}

/** GET /admin/activities/:activityId — full internal detail for editing. */
export async function getActivity(
  activityId: string,
  signal?: AbortSignal,
): Promise<AdminActivityDetail> {
  const payload = await requestJson(pathWithId(ACTIVITY_ROUTES.adminDetail, activityId), { signal })
  return parsePayload(adminActivityDetailSchema, payload, '活动详情')
}

/** POST /admin/activities — creates a draft. */
export async function createActivity(
  csrfToken: string,
  request: CreateActivityRequest,
): Promise<AdminActivityDetail> {
  const payload = await requestJson(`/api${ACTIVITY_ROUTES.adminList}`, {
    method: 'POST',
    csrfToken,
    body: request,
  })
  return parsePayload(adminActivityDetailSchema, payload, '创建活动结果')
}

/** PATCH /admin/activities/:activityId — optimistic concurrency via expectedUpdatedAt. */
export async function updateActivity(
  csrfToken: string,
  activityId: string,
  request: UpdateActivityRequest,
): Promise<AdminActivityDetail> {
  const payload = await requestJson(pathWithId(ACTIVITY_ROUTES.adminDetail, activityId), {
    method: 'PATCH',
    csrfToken,
    body: request,
  })
  return parsePayload(adminActivityDetailSchema, payload, '保存活动结果')
}

export type ActivityTransition = 'publish' | 'pause' | 'resume' | 'end'

const TRANSITION_ROUTES: Record<ActivityTransition, string> = {
  publish: ACTIVITY_ROUTES.adminPublish,
  pause: ACTIVITY_ROUTES.adminPause,
  resume: ACTIVITY_ROUTES.adminResume,
  end: ACTIVITY_ROUTES.adminEnd,
}

/** POST publish/pause/resume/end; the server enforces the legal state machine. */
export async function transitionActivity(
  csrfToken: string,
  transition: ActivityTransition,
  activityId: string,
  expectedUpdatedAt: string,
): Promise<AdminActivityDetail> {
  const payload = await requestJson(pathWithId(TRANSITION_ROUTES[transition], activityId), {
    method: 'POST',
    csrfToken,
    body: { expectedUpdatedAt },
  })
  return parsePayload(adminActivityDetailSchema, payload, '活动状态变更结果')
}

/** GET /admin/activities/:activityId/rule-versions — read-only immutable snapshots. */
export async function listActivityRuleVersions(
  activityId: string,
  signal?: AbortSignal,
): Promise<ActivityRuleVersionListResponse> {
  const payload = await requestJson(pathWithId(ACTIVITY_ROUTES.adminRuleVersions, activityId), {
    signal,
  })
  return parsePayload(activityRuleVersionListResponseSchema, payload, '规则版本列表')
}

/** GET /admin/activities/:activityId/audit — staff-only audit trail. */
export async function listActivityAudit(
  activityId: string,
  signal?: AbortSignal,
): Promise<ActivityAuditEntryListResponse> {
  const payload = await requestJson(pathWithId(ACTIVITY_ROUTES.adminAudit, activityId), { signal })
  return parsePayload(activityAuditEntryListResponseSchema, payload, '活动审计记录')
}

/**
 * GET /admin/communities — the existing registry endpoint. Admin receives every
 * community; operator/grid_worker receive only their assigned scope, so this
 * page never builds its own community permission list.
 */
export async function listAdminCommunities(signal?: AbortSignal) {
  const payload = await requestJson('/api/admin/communities', { signal })
  const items =
    typeof payload === 'object' && payload !== null && 'items' in payload
      ? (payload as { items: unknown }).items
      : null
  return parsePayload(authCommunitySchema.array(), items, '社区列表')
}
