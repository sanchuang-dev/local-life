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
