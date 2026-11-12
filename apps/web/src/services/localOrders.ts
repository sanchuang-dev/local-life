import {
  LOCAL_ORDER_ROUTES,
  createLocalOrderRequestSchema,
  localOrderDetailSchema,
  localOrderListResponseSchema,
  localOrderTeamOptionListResponseSchema,
  updateLocalOrderStatusRequestSchema,
  type CreateLocalOrderRequest,
  type LocalOrderDetail,
  type LocalOrderListQuery,
  type LocalOrderListResponse,
  type LocalOrderTeamOptionListResponse,
  type LocalOrderTransitionStatus,
} from '@sanchuang-dev/local-life-contracts'
import { API_PREFIX, fillRoute, requestLocal, withQuery, type SafelyParsable } from './localApi'

/**
 * Resident order-registration client (#109).
 *
 * The order domain is *registration only*: there is no payment, no cart and no
 * resident cancellation route in the contract. So this module exposes exactly
 * three calls — register, list my orders, read one of my orders — and never
 * invents a fourth.
 */

/** The POST answers `{ created, order }`; the surfaces only need the order. */
const createdOrderSchema: SafelyParsable<LocalOrderDetail> = {
  safeParse: (value: unknown) => {
    if (typeof value !== 'object' || value === null) return { success: false }
    return localOrderDetailSchema.safeParse((value as { order?: unknown }).order)
  },
}

/**
 * POST /local-orders — 「登记订单 / 提交办理意向」.
 *
 * `request.idempotencyKey` makes a retry/replay safe: the server returns the
 * existing order with `created: false` instead of registering a second one. The
 * body never carries a price, a total, a community or a resident id.
 */
export function registerLocalOrder(
  csrfToken: string,
  request: CreateLocalOrderRequest,
): Promise<LocalOrderDetail> {
  return requestLocal(
    `${API_PREFIX}${LOCAL_ORDER_ROUTES.myOrders}`,
    createdOrderSchema,
    '订单登记结果',
    { method: 'POST', csrfToken, body: createLocalOrderRequestSchema.parse(request) },
  )
}

/**
 * GET /local-orders/team-options — the signed-in resident's own eligible
 * consumption teams for one product's community (#209).
 *
 * Only the session identifies the resident; no resident id, roster or community
 * is sent. The list is advisory for the form: the create endpoint re-validates
 * the exact activity/team membership before freezing the order.
 */
export function listMyLocalOrderTeamOptions(
  productId: string,
  signal?: AbortSignal,
): Promise<LocalOrderTeamOptionListResponse> {
  return requestLocal(
    `${API_PREFIX}${withQuery(LOCAL_ORDER_ROUTES.myTeamOptions, { productId })}`,
    localOrderTeamOptionListResponseSchema,
    '消费团选项',
    { signal },
  )
}

/**
 * Filters the local-order lists accept.
 *
 * Paging is optional because the API applies the contract defaults; the client
 * only sends the filters the visitor actually chose.
 */
export type LocalOrderFilters = Partial<Omit<LocalOrderListQuery, 'residentUserId'>>

/** GET /local-orders — always the caller's own orders; the server never widens it. */
export function listMyLocalOrders(
  query: LocalOrderFilters = {},
  signal?: AbortSignal,
): Promise<LocalOrderListResponse> {
  return requestLocal(
    `${API_PREFIX}${withQuery(LOCAL_ORDER_ROUTES.myOrders, {
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
      status: query.status,
    })}`,
    localOrderListResponseSchema,
    '我的订单',
    { signal },
  )
}

/** GET /local-orders/:localOrderId — another resident's order is a 404, not a 403. */
export function getMyLocalOrder(
  orderId: string,
  signal?: AbortSignal,
): Promise<LocalOrderDetail> {
  return requestLocal(
    `${API_PREFIX}${fillRoute(LOCAL_ORDER_ROUTES.myOrderDetail, ':localOrderId', orderId)}`,
    localOrderDetailSchema,
    '订单详情',
    { signal },
  )
}

/**
 * The staff/back-office view of one order, used by the 网格员工作台.
 *
 * `/staff/local-orders` accepts all three roles and is scoped by the session's
 * assigned communities; an order outside that scope answers 404 and a call
 * without a staff session answers 401/403 — both are surfaced verbatim.
 */
export function listStaffLocalOrders(
  query: LocalOrderFilters = {},
  signal?: AbortSignal,
): Promise<LocalOrderListResponse> {
  return requestLocal(
    `${API_PREFIX}${withQuery(LOCAL_ORDER_ROUTES.staffOrders, {
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
      status: query.status,
      communityId: query.communityId,
      keyword: query.keyword,
    })}`,
    localOrderListResponseSchema,
    '社区订单列表',
    { signal },
  )
}

export function getStaffLocalOrder(
  orderId: string,
  signal?: AbortSignal,
): Promise<LocalOrderDetail> {
  return requestLocal(
    `${API_PREFIX}${fillRoute(LOCAL_ORDER_ROUTES.staffOrderDetail, ':localOrderId', orderId)}`,
    localOrderDetailSchema,
    '社区订单详情',
    { signal },
  )
}

/**
 * PATCH /staff/local-orders/:localOrderId/status — the worker's handling action.
 *
 * `status` is a `LocalOrderTransitionStatus`, which deliberately cannot be
 * `verified`: manual verification is the back-office operation's exclusive path.
 * `expectedUpdatedAt` is the shared optimistic-concurrency token; a stale value is
 * a 409 so two workers cannot silently overwrite each other.
 */
export function updateStaffLocalOrderStatus(
  csrfToken: string,
  orderId: string,
  expectedUpdatedAt: string,
  status: LocalOrderTransitionStatus,
  note?: string,
): Promise<LocalOrderDetail> {
  const body = updateLocalOrderStatusRequestSchema.parse({
    expectedUpdatedAt,
    status,
    ...(note && note.trim() ? { note: note.trim() } : {}),
  })
  return requestLocal(
    `${API_PREFIX}${fillRoute(LOCAL_ORDER_ROUTES.staffOrderStatus, ':localOrderId', orderId)}`,
    localOrderDetailSchema,
    '订单状态处理结果',
    { method: 'PATCH', csrfToken, body },
  )
}
