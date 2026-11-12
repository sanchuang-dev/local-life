import { z } from 'zod'

/**
 * Consumption team reward rules (LL-PUR-001, Issue #206).
 *
 * Product shape, frozen by the Issue contract:
 *
 * - one three-person team per activity reach a single spend threshold;
 * - the threshold is counted from the moment each member joined the team;
 * - every rewarded member receives a platform coupon of the same face value;
 * - an activity has exactly one threshold tier (`purchaseRewardPlan` is a single
 *   object, never an array), and the whole local-goods catalogue applies while
 *   the discounted shop stays frozen.
 *
 * This module owns only the *rule* contract. It deliberately does not model
 * spend aggregation, coupon issuance, balances or redemption - those are later
 * LL-PUR cards. Keeping it separate from `rewards.ts` also keeps the existing
 * check-in `rewardPlan` untouched.
 */

/**
 * Read-only progress routes (LL-PUR-005).
 *
 * The resident surface only ever describes the caller's own current team. The
 * staff surface describes every team of one activity, but the API still applies
 * the caller's `staff_community_assignments` before returning anything.
 */
export const PURCHASE_REWARD_ROUTES = {
  myProgress: '/activities/:activityId/purchase-reward/progress',
  staffProgress: '/staff/activities/:activityId/purchase-reward/progress',
  myCoupons: '/purchase-reward/coupons',
  staffCouponStock: '/staff/activities/:activityId/purchase-reward/stock',
  staffRewardDisputes: '/staff/activities/:activityId/purchase-reward/disputes',
} as const

/** A rewarded team is always the three-person team from LL-MVP-004. */
export const PURCHASE_REWARD_TEAM_SIZE = 3

/**
 * Hard ceiling for the total coupon liability of one activity
 * (`faceValue * 3 * maxRewardedTeams`).
 *
 * Same magnitude as the existing activity `budgetCapCents` ceiling: one million
 * yuan in cents. The bound exists so a mistyped `maxRewardedTeams` cannot make
 * an activity promise an unbounded number of coupons.
 */
export const PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS = 100_000_000

const cents = z.number().int().min(1)

/**
 * One consumption reward tier.
 *
 * `thresholdCents` and `couponFaceValueCents` are the only fields residents may
 * ever read. `maxRewardedTeams` is internal budget control and must not be
 * exposed on a public payload.
 */
export const purchaseRewardPlanSchema = z
  .strictObject({
    /** Team spend that must be reached for the team to qualify. */
    thresholdCents: cents.max(PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS),
    /** Face value of the coupon granted to each of the three members. */
    couponFaceValueCents: cents.max(PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS),
    /** Upper bound of rewarded teams; freezes the total coupon liability. */
    maxRewardedTeams: z.number().int().min(1).max(100_000),
  })
  .superRefine((plan, ctx) => {
    const liability = purchaseRewardTotalBudgetCents(plan)
    if (liability > PURCHASE_REWARD_MAX_TOTAL_BUDGET_CENTS) {
      ctx.addIssue({
        code: 'custom',
        message:
          'couponFaceValueCents * 3 * maxRewardedTeams must not exceed the activity purchase reward budget cap',
        path: ['maxRewardedTeams'],
      })
    }
  })

export type PurchaseRewardPlan = z.infer<typeof purchaseRewardPlanSchema>

/** Total coupon liability of a plan in cents: face value × 3 × rewarded teams. */
export function purchaseRewardTotalBudgetCents(
  plan: Pick<PurchaseRewardPlan, 'couponFaceValueCents' | 'maxRewardedTeams'>,
): number {
  return plan.couponFaceValueCents * PURCHASE_REWARD_TEAM_SIZE * plan.maxRewardedTeams
}

/**
 * The resident-facing projection of a purchase reward plan. Internal budget
 * control (`maxRewardedTeams`) is intentionally absent.
 */
export const publicPurchaseRewardSchema = z.strictObject({
  thresholdCents: z.number().int().min(1),
  couponFaceValueCents: z.number().int().min(1),
})

export type PublicPurchaseReward = z.infer<typeof publicPurchaseRewardSchema>

/* -------------------------------------------------------------------------- */
/* Single-use coupons and bounded reward inventory (LL-PUR-006)               */
/* -------------------------------------------------------------------------- */

/** Status `expired` is a read-time projection: stored `available` does not mutate on a timer. */
export const couponEffectiveStatusSchema = z.enum(['available', 'reserved', 'redeemed', 'void', 'expired'])
export type CouponEffectiveStatus = z.infer<typeof couponEffectiveStatusSchema>

export const couponWalletItemSchema = z.strictObject({
  id: z.string().uuid(),
  activityId: z.string().uuid(),
  teamId: z.string().uuid(),
  /** The activity's community, so the H5 can explain a cross-community coupon. */
  communityId: z.string().uuid(),
  faceValueCents: z.number().int().positive(),
  status: couponEffectiveStatusSchema,
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  reservedOrderId: z.string().uuid().nullable(),
})
export type CouponWalletItem = z.infer<typeof couponWalletItemSchema>

export const couponWalletResponseSchema = z.strictObject({
  items: z.array(couponWalletItemSchema),
  asOf: z.string().datetime({ offset: true }),
})
export type CouponWalletResponse = z.infer<typeof couponWalletResponseSchema>

/** Staff-only inventory, computed from immutable coupon team grants. */
export const couponStockResponseSchema = z.strictObject({
  activityId: z.string().uuid(),
  hasPlan: z.boolean(),
  issuedTeams: z.number().int().nonnegative(),
  maxRewardedTeams: z.number().int().nonnegative(),
  remainingTeams: z.number().int().nonnegative(),
  issuedValueCents: z.number().int().nonnegative(),
  totalBudgetCents: z.number().int().nonnegative(),
  asOf: z.string().datetime({ offset: true }),
}).superRefine((stock, ctx) => {
  if (stock.issuedTeams > stock.maxRewardedTeams ||
      stock.remainingTeams !== stock.maxRewardedTeams - stock.issuedTeams ||
      stock.issuedValueCents > stock.totalBudgetCents) {
    ctx.addIssue({ code: 'custom', path: ['issuedTeams'], message: 'coupon inventory exceeds its frozen plan budget' })
  }
})
export type CouponStockResponse = z.infer<typeof couponStockResponseSchema>


/** Durable, staff-scoped record of a financial exception, not an auto-refund. */
export const couponRewardDisputeSchema = z.strictObject({
  id: z.string().uuid(),
  kind: z.enum(['reward_eligibility_lost', 'redeemed_payment_reversed']),
  grantId: z.string().uuid(),
  couponId: z.string().uuid().nullable(),
  sourceOrderId: z.string().uuid(),
  reversalEntryId: z.string().uuid(),
  resolution: z.enum(['auto_void', 'pending_manual']),
  createdAt: z.string().datetime({ offset: true }),
})
export type CouponRewardDispute = z.infer<typeof couponRewardDisputeSchema>
export const couponRewardDisputeListSchema = z.strictObject({
  items: z.array(couponRewardDisputeSchema),
  asOf: z.string().datetime({ offset: true }),
})
export type CouponRewardDisputeList = z.infer<typeof couponRewardDisputeListSchema>
