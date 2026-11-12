import {
  PURCHASE_REWARD_ROUTES,
  couponWalletResponseSchema,
  purchaseRewardProgressResponseSchema,
  type CouponWalletResponse,
  type PurchaseRewardProgressResponse,
} from '@sanchuang-dev/local-life-contracts'
import { API_PREFIX, fillRoute, requestLocal } from './localApi'

/**
 * Resident consumption-team reward transport (#210/#211).
 *
 * Both reads are session-scoped on the server: the caller never sends a resident
 * id, team id or order id. The progress response deliberately contains no order
 * or receipt identifiers, and the coupon wallet only contains the caller's own
 * coupons, so this module cannot widen either surface.
 */
export function getMyPurchaseRewardProgress(
  activityId: string,
  signal?: AbortSignal,
): Promise<PurchaseRewardProgressResponse> {
  return requestLocal(
    `${API_PREFIX}${fillRoute(
      PURCHASE_REWARD_ROUTES.myProgress,
      ':activityId',
      activityId,
    )}`,
    purchaseRewardProgressResponseSchema,
    '消费团进度',
    { signal },
  )
}

/**
 * GET /purchase-reward/coupons — every coupon the resident currently owns.
 *
 * This is a global wallet, not a per-activity lookup: it is the truthful source
 * for coupons whose activity is no longer in a shortened activity list.
 */
export function getMyCoupons(signal?: AbortSignal): Promise<CouponWalletResponse> {
  return requestLocal(
    `${API_PREFIX}${PURCHASE_REWARD_ROUTES.myCoupons}`,
    couponWalletResponseSchema,
    '消费券包',
    { signal },
  )
}
