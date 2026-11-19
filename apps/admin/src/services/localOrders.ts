import {
  LOCAL_ORDER_ROUTES,
  adminLocalOrderDetailSchema,
  localOrderEventListResponseSchema,
  localOrderListResponseSchema,
  localOrderVerifyRequestSchema,
  updateLocalOrderStatusRequestSchema,
  type AdminLocalOrderDetail,
  type AdminLocalOrderListQuery,
  type LocalOrderEvent,
  type LocalOrderListResponse,
  type LocalOrderTransitionStatus,
  type LocalOrderVerifyRequest,
} from '@sanchuang-dev/local-life-contracts'
import { fillRoute, parsePayload, requestLocalJson, withQuery } from './localApi'

/**
 * Back-office transport for *local* resident orders (#109).
 *
 * These are **not** the 广电 CRM acceptance orders in `services/crm.ts`: a local
 * order is a resident registration against a community product row, and the only
 * terminal success state is `verified` — a manual operations fact check. The
 * contract has no payment or activation field, so no screen may present one.
 *
 * Both `/admin/local-orders` and `/staff/local-orders` exist; the two consoles
 * differ only in who may call them: the web workbench (all staff roles) uses the
 * staff routes, this console uses the admin routes.
 */

/**
 * GET /admin/local-orders — community-scoped by the server, never by the client.
 *
 * PAY-08 adds payment-fact filters (merchant order no, provider transaction id,
 * payment status/channel, simulated vs real, order date range). They are sent as
 * ordinary query parameters and executed by SQLite; the console never filters a
 * page client-side.
 */
export async function listAdminLocalOrders(
  query: AdminLocalOrderListQuery,
  signal?: AbortSignal,
): Promise<LocalOrderListResponse> {
  const payload = await requestLocalJson(
    withQuery(`/api${LOCAL_ORDER_ROUTES.adminOrders}`, {
      page: query.page,
      pageSize: query.pageSize,
      communityId: query.communityId,
      status: query.status,
      productId: query.productId,
      residentUserId: query.residentUserId,
      keyword: query.keyword,
      orderId: query.orderId,
      merchantOrderNo: query.merchantOrderNo,
      providerTransactionId: query.providerTransactionId,
      paymentStatus: query.paymentStatus,
      paymentChannel: query.paymentChannel,
      paymentMode: query.paymentMode,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
    }),
    { signal },
  )
  return parsePayload(localOrderListResponseSchema, payload, '本地订单列表')
}

/**
 * GET /admin/local-orders/:id — summary + verification + append-only events +
 * the PAY-08 read-only payment section (intents/attempts/completion/ledger
 * receipts/exceptions). The section is projected from the existing truth
 * sources; it is not a second payment state.
 */
export async function getAdminLocalOrder(
  orderId: string,
  signal?: AbortSignal,
): Promise<AdminLocalOrderDetail> {
  const payload = await requestLocalJson(
    `/api${fillRoute(LOCAL_ORDER_ROUTES.adminOrderDetail, ':localOrderId', orderId)}`,
    { signal },
  )
  return parsePayload(adminLocalOrderDetailSchema, payload, '本地订单详情')
}

/**
 * PATCH /admin/local-orders/:id/status — ordinary workflow transition.
 *
 * `verified` is deliberately not reachable here: it only comes from the manual
 * verification endpoint below, so a status change can never look like a payment
 * confirmation.
 */
export async function updateAdminLocalOrderStatus(
  csrfToken: string,
  orderId: string,
  expectedUpdatedAt: string,
  status: LocalOrderTransitionStatus,
  note?: string,
): Promise<AdminLocalOrderDetail> {
  const body = updateLocalOrderStatusRequestSchema.parse({
    expectedUpdatedAt,
    status,
    ...(note === undefined ? {} : { note }),
  })
  const payload = await requestLocalJson(
    `/api${fillRoute(LOCAL_ORDER_ROUTES.adminOrderStatus, ':localOrderId', orderId)}`,
    { method: 'PATCH', csrfToken, body },
  )
  return parsePayload(adminLocalOrderDetailSchema, payload, '本地订单状态结果')
}

/**
 * POST /admin/local-orders/:id/verify — operations manual verification
 * (admin / operator only). `verify` records the reviewer and note; an already
 * verified order answers 409 `order_already_verified`.
 */
export async function verifyAdminLocalOrder(
  csrfToken: string,
  orderId: string,
  request: LocalOrderVerifyRequest,
): Promise<AdminLocalOrderDetail> {
  const body = localOrderVerifyRequestSchema.parse(request)
  const payload = await requestLocalJson(
    `/api${fillRoute(LOCAL_ORDER_ROUTES.adminOrderVerify, ':localOrderId', orderId)}`,
    { method: 'POST', csrfToken, body },
  )
  return parsePayload(adminLocalOrderDetailSchema, payload, '本地订单核验结果')
}

/** GET /admin/local-orders/:id/events — the append-only handling trail. */
export async function listAdminLocalOrderEvents(
  orderId: string,
  signal?: AbortSignal,
): Promise<LocalOrderEvent[]> {
  const payload = await requestLocalJson(
    `/api${fillRoute(LOCAL_ORDER_ROUTES.adminOrderEvents, ':localOrderId', orderId)}`,
    { signal },
  )
  return parsePayload(localOrderEventListResponseSchema, payload, '本地订单事件').items
}
