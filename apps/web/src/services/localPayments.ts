import {
  LOCAL_ORDER_ROUTES,
  PAYMENT_ROUTES,
  createPaymentIntentRequestSchema,
  localOrderOnlineCompletionResponseSchema,
  mockPaymentActionRequestSchema,
  paymentCapabilitiesSchema,
  paymentConfirmationResponseSchema,
  paymentIntentCreateResponseSchema,
  type LocalOrderDetail,
  type MockPaymentAction,
  type PaymentCapabilities,
  type PaymentChannel,
  type PaymentConfirmationResponse,
  type PaymentIntentCreateResponse,
} from '@sanchuang-dev/local-life-contracts'
import { API_PREFIX, fillRoute, requestLocal } from './localApi'

/**
 * Resident payment transport. The server decides capabilities and truth; this
 * module only calls the shared PAY-02/PAY-04/PAY-05 routes and parses their DTOs.
 * No amount, merchant, transaction id or "paid" flag is ever sent.
 */
export function getPaymentCapabilities(signal?: AbortSignal): Promise<PaymentCapabilities> {
  return requestLocal(
    `${API_PREFIX}${PAYMENT_ROUTES.capabilities}`,
    paymentCapabilitiesSchema,
    '支付能力',
    { signal },
  )
}

export function createMyPaymentIntent(
  csrfToken: string,
  input: { localOrderId: string; channel: PaymentChannel; idempotencyKey: string },
): Promise<PaymentIntentCreateResponse> {
  return requestLocal(
    `${API_PREFIX}${PAYMENT_ROUTES.createIntent}`,
    paymentIntentCreateResponseSchema,
    '支付单创建结果',
    {
      method: 'POST',
      csrfToken,
      body: createPaymentIntentRequestSchema.parse(input),
    },
  )
}

export function executeMyMockPayment(
  csrfToken: string,
  paymentIntentId: string,
  action: MockPaymentAction,
  source: 'notification' | 'query' = 'notification',
): Promise<PaymentConfirmationResponse> {
  return requestLocal(
    `${API_PREFIX}${fillRoute(PAYMENT_ROUTES.mockAction, ':paymentIntentId', paymentIntentId)}`,
    paymentConfirmationResponseSchema,
    '模拟支付结果',
    {
      method: 'POST',
      csrfToken,
      body: mockPaymentActionRequestSchema.parse({ action, source }),
    },
  )
}

/** The PAY-05 zero-amount path: no channel, no cash fact, idempotent per order. */
export function completeMyZeroAmountOrder(
  csrfToken: string,
  localOrderId: string,
): Promise<LocalOrderDetail> {
  return requestLocal<LocalOrderDetail>(
    `${API_PREFIX}${fillRoute(LOCAL_ORDER_ROUTES.myZeroAmountCompletion, ':localOrderId', localOrderId)}`,
    {
      safeParse: (value: unknown) => {
        const parsed = localOrderOnlineCompletionResponseSchema.safeParse(value)
        return parsed.success
          ? { success: true as const, data: parsed.data.order }
          : { success: false as const }
      },
    },
    '零元订单完成结果',
    { method: 'POST', csrfToken },
  )
}
