import {
  paymentDifferenceSchema,
  paymentRecoveryCheckSchema,
  type PaymentRecoveryCheck,
  paymentDifferencesResponseSchema,
  paymentReconciliationRoutes,
  adminLocalOrderDetailSchema,
  apiErrorSchema,
  type PaymentDifference,
  type PaymentDifferencesQuery,
  type PaymentDifferencesResponse,
  type AdminLocalOrderDetail,
} from '@sanchuang-dev/local-life-contracts'
import { LocalApiError, parsePayload, requestLocalJson, withQuery } from './localApi'
import { filenameFromDisposition, saveBlob } from './ledger'

export type PaymentDifferenceFilters = PaymentDifferencesQuery

function queryUrl(path: string, query: PaymentDifferenceFilters): string {
  return withQuery('/api' + path, {
    page: query.page, pageSize: query.pageSize, from: query.from, to: query.to,
    communityId: query.communityId, status: query.status, reason: query.reason,
    source: query.source,
  })
}

export async function listPaymentReconciliation(
  query: PaymentDifferenceFilters, signal?: AbortSignal,
): Promise<PaymentDifferencesResponse> {
  const payload = await requestLocalJson(queryUrl(paymentReconciliationRoutes.list, query), { signal })
  return parsePayload(paymentDifferencesResponseSchema, payload, '支付差异清单')
}

export interface PaymentDifferenceDetail extends PaymentDifference {
  asOf: string
  order: AdminLocalOrderDetail
  recoveryChecks: PaymentRecoveryCheck[]
}

export async function getPaymentReconciliationDetail(
  intentId: string, signal?: AbortSignal,
): Promise<PaymentDifferenceDetail> {
  const path = paymentReconciliationRoutes.detail.replace(':intentId', encodeURIComponent(intentId))
  const payload = await requestLocalJson('/api' + path, { signal })
  if (!payload || typeof payload !== 'object' || !('order' in payload)) {
    throw new LocalApiError(200, 'invalid_response', '支付差异详情缺少原订单')
  }
  const record = payload as Record<string, unknown>
  const { order: rawOrder, asOf, recoveryChecks: rawChecks, ...rawItem } = record
  const item = parsePayload(paymentDifferenceSchema, rawItem, '支付差异详情')
  const recoveryChecks = Array.isArray(rawChecks)
    ? rawChecks.map((v) => parsePayload(paymentRecoveryCheckSchema, v, '微信支付恢复核查'))
    : []
  const order = parsePayload(adminLocalOrderDetailSchema, rawOrder, '支付订单详情')
  if (typeof asOf !== 'string') throw new LocalApiError(200, 'invalid_response', '支付差异详情时间不正确')
  return { ...item, order, asOf, recoveryChecks }
}

export async function downloadPaymentReconciliation(
  query: PaymentDifferenceFilters,
  options: { save?: (blob: Blob, filename: string) => void; signal?: AbortSignal } = {},
): Promise<{ filename: string; rows: number | null }> {
  let response: Response
  try {
    response = await fetch(queryUrl(paymentReconciliationRoutes.exportCsv, query), {
      credentials: 'include',
      headers: { accept: 'text/csv' },
      signal: options.signal,
    })
  } catch (cause) {
    if (options.signal?.aborted) throw cause
    throw new LocalApiError(0, 'network_error', '支付差异 CSV 下载失败，请检查网络')
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok || !/text\/csv/iu.test(contentType)) {
    const payload: unknown = await response.json().catch(() => null)
    const error = apiErrorSchema.safeParse(payload)
    throw error.success
      ? new LocalApiError(response.status, error.data.error.code, error.data.error.message)
      : new LocalApiError(response.status, 'http_error', '支付差异 CSV 下载失败')
  }
  const blob = await response.blob()
  const filename = filenameFromDisposition(response.headers.get('content-disposition')) ?? 'payment-reconciliation.csv'
  ;(options.save ?? saveBlob)(blob, filename)
  const rawRows = response.headers.get('x-payment-row-count')
  const rows = rawRows !== null && /^\d+$/u.test(rawRows) ? Number(rawRows) : null
  return { filename, rows }
}
