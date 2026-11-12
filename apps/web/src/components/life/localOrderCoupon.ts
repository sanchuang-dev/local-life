import type { CouponWalletItem } from '@sanchuang-dev/local-life-contracts'
import { formatLocalPriceCents } from './localOrderLabels.ts'

/**
 * One-coupon selection for a resident local order (LL-PUR-010, #215).
 *
 * The wallet endpoint is already scoped to the signed-in resident, so this module
 * never has to filter another account's coupons. It only mirrors the server's
 * single-coupon rules for display: whole-face discount, same community, unexpired
 * status and no change. The server remains the authority and re-reads the face
 * value from SQLite when the order is written.
 */

export interface LocalOrderCouponOption {
  coupon: CouponWalletItem
  usable: boolean
  /** Null only when the coupon can be selected for this order. */
  unavailableReason: string | null
}

export interface LocalOrderCouponContext {
  grossCents: number
  communityId: string
}

/**
 * Why one wallet coupon cannot discount this order, or `null` when it can.
 *
 * The order and status checks precede the amount check so a reserved coupon is
 * never described as "too large", which would suggest retrying a smaller order.
 */
export function couponUnavailableReason(
  coupon: Pick<CouponWalletItem, 'status' | 'faceValueCents' | 'communityId'>,
  context: LocalOrderCouponContext,
): string | null {
  if (coupon.status === 'reserved') return '该券已被其他订单占用'
  if (coupon.status === 'redeemed') return '该券已使用'
  if (coupon.status === 'void') return '该券已作废'
  if (coupon.status === 'expired') return '该券已过期'
  if (coupon.communityId !== context.communityId) return '该券不属于本商品所在社区'
  if (coupon.faceValueCents > context.grossCents) {
    return `券面额 ${formatLocalPriceCents(coupon.faceValueCents)} 高于商品总额 ${formatLocalPriceCents(context.grossCents)}，不支持找零`
  }
  return null
}

/** Every wallet item stays visible, with its real reason when it cannot be used. */
export function buildLocalOrderCouponOptions(
  coupons: readonly CouponWalletItem[],
  context: LocalOrderCouponContext,
): LocalOrderCouponOption[] {
  return coupons.map((coupon) => {
    const unavailableReason = couponUnavailableReason(coupon, context)
    return { coupon, usable: unavailableReason === null, unavailableReason }
  })
}

/**
 * The one usable coupon the current form state stands for.
 *
 * A stale or now-unusable id resolves to `null` instead of another coupon, so a
 * refreshed wallet or a quantity change can never silently switch the discount.
 */
export function chooseUsableCoupon(
  options: readonly LocalOrderCouponOption[],
  selectedCouponId: string | null,
): LocalOrderCouponOption | null {
  if (!selectedCouponId) return null
  return options.find((option) => option.coupon.id === selectedCouponId && option.usable) ?? null
}

export type LocalOrderAmountLabel = '商品总额' | '券抵扣' | '待实际支付'

export interface LocalOrderAmountLine {
  label: LocalOrderAmountLabel
  cents: number
  text: string
}

/**
 * The three amounts the resident must always see. The caller passes the values
 * from the server snapshot after submission; the form only uses it as a preview.
 */
export function localOrderAmountLines(amounts: {
  totalCents: number
  couponDiscountCents: number
  netPayableCents: number
}): LocalOrderAmountLine[] {
  return [
    {
      label: '商品总额',
      cents: amounts.totalCents,
      text: formatLocalPriceCents(amounts.totalCents),
    },
    {
      label: '券抵扣',
      cents: amounts.couponDiscountCents,
      text:
        amounts.couponDiscountCents > 0
          ? `-${formatLocalPriceCents(amounts.couponDiscountCents)}`
          : '未使用',
    },
    {
      label: '待实际支付',
      cents: amounts.netPayableCents,
      text: formatLocalPriceCents(amounts.netPayableCents),
    },
  ]
}

/** Shorten a coupon UUID for display; the full id stays on the frozen order. */
export function shortCouponId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}
