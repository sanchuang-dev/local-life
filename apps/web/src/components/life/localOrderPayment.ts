import type {
  LocalOrderDetail,
  LocalOrderPaymentSummary,
  LocalOrderSummary,
  PaymentCapabilities,
} from '@sanchuang-dev/local-life-contracts'
import {
  localOrderOnlineCompletionDescription,
  localOrderStatusDescriptions,
  localOrderStatusLabels,
  localOrderStatusTone,
} from './localOrderLabels.ts'

type PaymentOrder = Pick<LocalOrderSummary, 'status' | 'snapshot' | 'payment'>
type DetailOrder = Pick<LocalOrderDetail, 'status' | 'snapshot' | 'payment' | 'onlineCompletion'>

export type LocalOrderPaymentKind =
  | 'completed'
  | 'zero'
  | 'pending'
  | 'confirming'
  | 'failed'
  | 'closed'
  | 'manual'

export interface LocalOrderPaymentDisplay {
  kind: LocalOrderPaymentKind
  label: string
  tone: 'mint' | 'amber' | 'rose' | 'slate' | 'teal'
  description: string
  payment: LocalOrderPaymentSummary | null
}

const PAYABLE_STATUSES: ReadonlySet<string> = new Set([
  'registered',
  'processing',
  'pending_review',
])

/**
 * Presentation only. It never decides that a payment succeeded; completed is
 * derived from `online_completed` (the server's PAY-05 fact), and every other
 * state comes from the latest server-owned payment summary.
 */
export function localOrderPaymentDisplay(order: PaymentOrder): LocalOrderPaymentDisplay {
  if (order.status === 'online_completed') {
    const completion = (order as DetailOrder).onlineCompletion ?? null
    const payment = order.payment ?? null
    const description = completion
      ? localOrderOnlineCompletionDescription(completion)
      : payment?.simulated
        ? '隔离模拟支付已由服务端确认，订单交易完成；这不是微信真实扣款，也不代表银行到账。'
        : payment
          ? '支付渠道已由服务端可信确认，订单在线交易已完成；这不代表已结算到商户银行账户。'
          : '订单已完成在线交易；支付方式与实付金额以服务端交易明细为准。'
    return {
      kind: 'completed',
      label: '交易完成',
      tone: 'mint',
      description,
      payment,
    }
  }

  if (order.status === 'verified') {
    return {
      kind: 'manual',
      label: localOrderStatusLabels.verified,
      tone: localOrderStatusTone('verified'),
      description: localOrderStatusDescriptions.verified,
      payment: order.payment ?? null,
    }
  }

  const payment = order.payment ?? null
  // A paid/confirming channel fact is never presented as an order completion
  // until the order itself is online_completed. Even if the order is cancelled,
  // this stays a pending/manual-review message rather than a success claim.
  if (payment?.status === 'confirming' || payment?.status === 'paid') {
    return {
      kind: 'confirming',
      label: '支付确认中',
      tone: 'amber',
      description:
        payment.status === 'paid'
          ? '服务端已收到支付事实，正在同步订单完成状态；请稍后刷新，不要重复支付。'
          : '渠道操作已结束，支付结果仍在确认中；请稍后刷新，不要重复支付。',
      payment,
    }
  }
  if (payment?.status === 'failed') {
    return {
      kind: 'failed',
      label: '支付失败',
      tone: 'rose',
      description: payment.failureMessage?.trim()
        ? `支付未完成：${payment.failureMessage}`
        : '支付未完成。请刷新状态，确认服务端允许后再重新支付。',
      payment,
    }
  }
  if (payment?.status === 'closed') {
    return {
      kind: 'closed',
      label: '支付已关闭',
      tone: 'slate',
      description: '本次支付已关闭或超过支付单有效期；订单是否可重新支付以订单状态为准。',
      payment,
    }
  }

  if (PAYABLE_STATUSES.has(order.status) && order.snapshot.netPayableCents === 0) {
    // The server's zero-amount completion requires a full coupon snapshot. A
    // genuinely free product with no coupon is a manual follow-up, not a
    // channel/zero-payment action the resident can finish here.
    if (order.snapshot.couponDiscountCents <= 0) {
      return {
        kind: 'manual',
        label: '待处理',
        tone: 'slate',
        description: '商品应付金额为 ¥0.00，且没有全额消费券抵扣；无需在线支付，由工作人员跟进。',
        payment,
      }
    }
    return {
      kind: 'zero',
      label: '待兑换',
      tone: 'amber',
      description: '消费券已全额抵扣，实际支付 ¥0.00；请使用消费券完成兑换。',
      payment,
    }
  }

  if (payment?.status === 'pending') {
    return {
      kind: 'pending',
      label: '待支付',
      tone: 'amber',
      description: '订单已建立，尚未完成支付。',
      payment,
    }
  }

  if (PAYABLE_STATUSES.has(order.status)) {
    return {
      kind: 'pending',
      label: '待支付',
      tone: 'amber',
      description: '订单已建立，尚未完成支付。',
      payment,
    }
  }

  return {
    kind: 'manual',
    label: localOrderStatusLabels[order.status],
    tone: localOrderStatusTone(order.status),
    description: localOrderStatusDescriptions[order.status],
    payment,
  }
}

export function paymentActionLabel(
  capabilities: PaymentCapabilities,
  amountCents: number,
  inWechat: boolean,
): { label: string; disabledReason: string | null } {
  if (capabilities.mockAvailable) {
    return { label: `模拟支付 ¥${(amountCents / 100).toFixed(2)}（测试环境）`, disabledReason: null }
  }
  if (capabilities.wechatJsapiAvailable) {
    if (!inWechat) {
      return { label: '微信支付', disabledReason: '请在微信内打开后完成支付。' }
    }
    return { label: '微信支付', disabledReason: null }
  }
  return {
    label: '支付暂不可用',
    disabledReason:
      capabilities.wechatUnavailableReason === 'not_configured'
        ? '支付服务暂未配置，当前仅能登记订单。'
        : '当前支付能力不可用，请稍后再试。',
  }
}

/** Does this browser look like WeChat? Used only for a user-facing guard. */
export function isWechatBrowser(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /MicroMessenger/i.test(userAgent)
}
