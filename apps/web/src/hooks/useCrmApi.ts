import { useCallback, useMemo } from 'react'
import {
  ACTIVITY_ROUTES,
  CRM_ROUTES,
  createCrmFollowUpResponseSchema,
  crmFollowUpListResponseSchema,
  crmLeadDetailSchema,
  crmLeadEventListResponseSchema,
  crmLeadListResponseSchema,
  crmOrderDetailSchema,
  crmOrderListResponseSchema,
  publicActivityListResponseSchema,
  type CreateCrmFollowUpRequest,
  type CreateCrmLeadRequest,
  type CreateCrmServiceOrderRequest,
  type CrmBusinessType,
  type CrmLeadSourceType,
  type CrmLeadStatus,
  type CrmServiceOrderStatus,
  type UpdateCrmLeadStatusRequest,
  type UpdateCrmOrderStatusRequest,
} from '@sanchuang-dev/local-life-contracts'
import { useStaffSession } from './useStaffSession'
import { CrmApiError, apiErrorFromResponse } from './apiError'

type QueryValue = string | number | undefined

function withQuery(path: string, query: Record<string, QueryValue>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue
    params.set(key, String(value))
  }
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

function leadPath(template: string, leadId: string): string {
  return template.replace(':leadId', encodeURIComponent(leadId))
}

function orderPath(template: string, orderId: string): string {
  return template.replace(':orderId', encodeURIComponent(orderId))
}

export type LeadListFilters = {
  status?: CrmLeadStatus
  sourceType?: CrmLeadSourceType
  communityId?: string
  keyword?: string
}

export type OrderListFilters = {
  status?: CrmServiceOrderStatus
  businessType?: CrmBusinessType
  communityId?: string
  keyword?: string
}

/**
 * Authenticated CRM client for the mobile workbench.
 *
 * Every path/response comes from `packages/contracts`; every write sends the
 * real session CSRF token. Errors are thrown with the server message intact so
 * pages can render real 401/403/409/400 states instead of a fake success.
 */
export function useCrmApi() {
  const { session } = useStaffSession()

  const request = useCallback(
    async <T,>(
      path: string,
      init: RequestInit,
      parse: (value: unknown) => T,
    ): Promise<T> => {
      const method = (init.method ?? 'GET').toUpperCase()
      const headers = new Headers(init.headers)
      if (init.body !== undefined) headers.set('content-type', 'application/json')
      if (method !== 'GET' && method !== 'HEAD') {
        if (!session) {
          throw new CrmApiError('登录状态已失效，请重新登录', 401, 'unauthorized', null)
        }
        headers.set('x-csrf-token', session.csrfToken)
      }

      const response = await fetch(`/api${path}`, {
        ...init,
        headers,
        credentials: 'include',
        cache: 'no-store',
      })
      if (!response.ok) throw await apiErrorFromResponse(response, '请求失败')

      if (response.status === 204) {
        throw new CrmApiError('接口未返回数据', 204, null, null)
      }
      const payload: unknown = await response.json().catch(() => null)
      try {
        return parse(payload)
      } catch {
        throw new CrmApiError('接口返回数据格式异常，无法安全展示', response.status, null, null)
      }
    },
    [session],
  )

  return useMemo(() => {
    const jsonBody = (value: unknown) => JSON.stringify(value)

    return {
      listLeads: async (
        filters: LeadListFilters,
        page: number,
        pageSize: number,
        signal?: AbortSignal,
      ) =>
        request(
          withQuery(CRM_ROUTES.leadList, { ...filters, page, pageSize }),
          { signal },
          (value) => crmLeadListResponseSchema.parse(value),
        ),

      getLead: async (leadId: string, signal?: AbortSignal) =>
        request(leadPath(CRM_ROUTES.leadDetail, leadId), { signal }, (value) =>
          crmLeadDetailSchema.parse(value),
        ),

      createLead: async (input: CreateCrmLeadRequest) =>
        request(
          CRM_ROUTES.leadList,
          { method: 'POST', body: jsonBody(input) },
          (value) => crmLeadDetailSchema.parse(value),
        ),

      updateLeadStatus: async (leadId: string, input: UpdateCrmLeadStatusRequest) =>
        request(
          leadPath(CRM_ROUTES.leadStatus, leadId),
          { method: 'PATCH', body: jsonBody(input) },
          (value) => crmLeadDetailSchema.parse(value),
        ),

      listFollowUps: async (leadId: string, signal?: AbortSignal) =>
        request(leadPath(CRM_ROUTES.leadFollowUps, leadId), { signal }, (value) =>
          crmFollowUpListResponseSchema.parse(value),
        ),

      createFollowUp: async (leadId: string, input: CreateCrmFollowUpRequest) =>
        request(
          leadPath(CRM_ROUTES.leadFollowUps, leadId),
          { method: 'POST', body: jsonBody(input) },
          (value) => createCrmFollowUpResponseSchema.parse(value),
        ),

      listLeadEvents: async (leadId: string, signal?: AbortSignal) =>
        request(leadPath(CRM_ROUTES.leadAudit, leadId), { signal }, (value) =>
          crmLeadEventListResponseSchema.parse(value),
        ),

      listOrders: async (
        filters: OrderListFilters,
        page: number,
        pageSize: number,
        signal?: AbortSignal,
      ) =>
        request(
          withQuery(CRM_ROUTES.orderList, { ...filters, page, pageSize }),
          { signal },
          (value) => crmOrderListResponseSchema.parse(value),
        ),

      getOrder: async (orderId: string, signal?: AbortSignal) =>
        request(orderPath(CRM_ROUTES.orderDetail, orderId), { signal }, (value) =>
          crmOrderDetailSchema.parse(value),
        ),

      createOrder: async (input: CreateCrmServiceOrderRequest) =>
        request(
          CRM_ROUTES.orderList,
          { method: 'POST', body: jsonBody(input) },
          (value) => crmOrderDetailSchema.parse(value),
        ),

      updateOrderStatus: async (orderId: string, input: UpdateCrmOrderStatusRequest) =>
        request(
          orderPath(CRM_ROUTES.orderStatus, orderId),
          { method: 'PATCH', body: jsonBody(input) },
          (value) => crmOrderDetailSchema.parse(value),
        ),

      /** Published activities used only as a lead-source picker. */
      listPublicActivities: async (signal?: AbortSignal) =>
        request(ACTIVITY_ROUTES.publicList, { signal }, (value) =>
          publicActivityListResponseSchema.parse(value),
        ),
    }
  }, [request])
}
