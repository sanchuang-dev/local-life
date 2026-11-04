import {
  adminCrmFilterOptionsResponseSchema,
  adminCrmLeadListResponseSchema,
  adminCrmOrderListResponseSchema,
  apiErrorSchema,
  crmFollowUpListResponseSchema,
  crmLeadDetailSchema,
  crmLeadEventListResponseSchema,
  crmOrderDetailSchema,
  CRM_ROUTES,
  type AdminCrmFilterOptionsResponse,
  type AdminCrmLeadListResponse,
  type AdminCrmOrderListResponse,
  type CrmBusinessType,
  type CrmFollowUpListResponse,
  type CrmLeadDetail,
  type CrmLeadEventListResponse,
  type CrmLeadSourceType,
  type CrmLeadStatus,
  type CrmOrderDetail,
  type CrmOrderReviewRequest,
  type CrmServiceOrderStatus,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Real CRM transport for the back-office console.
 *
 * Every call goes through the same-origin `/api` prefix, builds its URL from the
 * shared `CRM_ROUTES` contract and validates the response with the shared zod
 * schema. A failed or malformed response is thrown as a `CrmApiError` carrying
 * the real HTTP status so pages can render the server message instead of a
 * success-looking placeholder.
 */

export class CrmApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'CrmApiError'
    this.status = status
    this.code = code
  }
}

export function isCrmApiError(cause: unknown): cause is CrmApiError {
  return cause instanceof CrmApiError
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
    throw new CrmApiError(200, 'invalid_response', `${label}与共享契约不一致：${detail}`)
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
    throw new CrmApiError(0, 'network_error', '无法连接管理后台 API，请确认 API 已启动或稍后重试。')
  }

  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload)
    throw new CrmApiError(
      response.status,
      parsed.success ? parsed.data.error.code : 'http_error',
      parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）`,
    )
  }
  if (payload === null) {
    throw new CrmApiError(response.status, 'invalid_response', '服务返回了无法解析的响应。')
  }
  return payload
}

function pathWithId(route: string, placeholder: ':leadId' | ':orderId', id: string): string {
  return `/api${route.replace(placeholder, encodeURIComponent(id))}`
}

export interface CrmLeadQuery {
  page: number
  pageSize: number
  communityId?: string
  staffId?: string
  status?: CrmLeadStatus
  sourceType?: CrmLeadSourceType
  keyword?: string
}

/**
 * GET /admin/crm/leads — server-side paging and filters. Sorting is frozen in
 * the contract (next contact first, then last update), so no sort parameter is
 * sent from the browser.
 */
export async function listAdminCrmLeads(
  query: CrmLeadQuery,
  signal?: AbortSignal,
): Promise<AdminCrmLeadListResponse> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  })
  if (query.communityId) params.set('communityId', query.communityId)
  if (query.staffId) params.set('staffId', query.staffId)
  if (query.status) params.set('status', query.status)
  if (query.sourceType) params.set('sourceType', query.sourceType)
  const keyword = query.keyword?.trim()
  if (keyword) params.set('keyword', keyword)

  const payload = await requestJson(`/api${CRM_ROUTES.adminLeadList}?${params.toString()}`, {
    signal,
  })
  return parsePayload(adminCrmLeadListResponseSchema, payload, '客户线索列表')
}

/** GET /admin/crm/leads/:leadId — detail with the full contact phone. */
export async function getAdminCrmLead(
  leadId: string,
  signal?: AbortSignal,
): Promise<CrmLeadDetail> {
  const payload = await requestJson(pathWithId(CRM_ROUTES.adminLeadDetail, ':leadId', leadId), {
    signal,
  })
  return parsePayload(crmLeadDetailSchema, payload, '客户线索详情')
}

/**
 * GET /crm/leads/:leadId/follow-ups — admin/operator may read follow-ups for
 * leads in their communities (grid workers only for leads they own). The list
 * is ordered oldest first by the server.
 */
export async function listCrmLeadFollowUps(
  leadId: string,
  signal?: AbortSignal,
): Promise<CrmFollowUpListResponse> {
  const payload = await requestJson(pathWithId(CRM_ROUTES.leadFollowUps, ':leadId', leadId), {
    signal,
  })
  return parsePayload(crmFollowUpListResponseSchema, payload, '客户线索跟进记录')
}

/** GET /admin/crm/leads/:leadId/audit — staff-only lead event trail. */
export async function listAdminCrmLeadAudit(
  leadId: string,
  signal?: AbortSignal,
): Promise<CrmLeadEventListResponse> {
  const payload = await requestJson(pathWithId(CRM_ROUTES.adminLeadAudit, ':leadId', leadId), {
    signal,
  })
  return parsePayload(crmLeadEventListResponseSchema, payload, '客户线索跟进时间线')
}

export interface CrmOrderQuery {
  page: number
  pageSize: number
  communityId?: string
  staffId?: string
  businessType?: CrmBusinessType
  status?: CrmServiceOrderStatus
  keyword?: string
}

/** GET /admin/crm/orders — server-side paging and filters. */
export async function listAdminCrmOrders(
  query: CrmOrderQuery,
  signal?: AbortSignal,
): Promise<AdminCrmOrderListResponse> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  })
  if (query.communityId) params.set('communityId', query.communityId)
  if (query.staffId) params.set('staffId', query.staffId)
  if (query.businessType) params.set('businessType', query.businessType)
  if (query.status) params.set('status', query.status)
  const keyword = query.keyword?.trim()
  if (keyword) params.set('keyword', keyword)

  const payload = await requestJson(`/api${CRM_ROUTES.adminOrderList}?${params.toString()}`, {
    signal,
  })
  return parsePayload(adminCrmOrderListResponseSchema, payload, '业务受理单列表')
}

/** GET /admin/crm/orders/:orderId — detail plus the server event timeline. */
export async function getAdminCrmOrder(
  orderId: string,
  signal?: AbortSignal,
): Promise<CrmOrderDetail> {
  const payload = await requestJson(pathWithId(CRM_ROUTES.adminOrderDetail, ':orderId', orderId), {
    signal,
  })
  return parsePayload(crmOrderDetailSchema, payload, '业务受理单详情')
}

/**
 * POST /admin/crm/orders/:orderId/review — the only path from
 * `pending_verification` to `confirmed`. The note is mandatory for both
 * decisions and `expectedUpdatedAt` prevents a stale tab from double-reviewing.
 */
export async function reviewAdminCrmOrder(
  csrfToken: string,
  orderId: string,
  request: CrmOrderReviewRequest,
): Promise<CrmOrderDetail> {
  const payload = await requestJson(pathWithId(CRM_ROUTES.adminOrderReview, ':orderId', orderId), {
    method: 'POST',
    csrfToken,
    body: request,
  })
  return parsePayload(crmOrderDetailSchema, payload, '业务受理单审核结果')
}

/**
 * GET /admin/crm/filter-options — communities, staff and enum options already
 * scoped to the caller's communities by the server. The page never builds its
 * own permission list from the session.
 */
export async function getAdminCrmFilterOptions(
  signal?: AbortSignal,
): Promise<AdminCrmFilterOptionsResponse> {
  const payload = await requestJson(`/api${CRM_ROUTES.adminFilterOptions}`, { signal })
  return parsePayload(adminCrmFilterOptionsResponseSchema, payload, 'CRM 筛选选项')
}
