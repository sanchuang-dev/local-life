import { z } from 'zod'

import { activityStatusSchema } from './identity.js'
import { authCommunitySchema } from './identity.js'

/**
 * Real "today's draw" prize pool (LL-LOT-001, Issue #173).
 *
 * This contract deliberately does **not** reuse `activity_prize_stocks`: that
 * ledger is the team-reward fulfilment (#62) and must keep its own one-prize,
 * one-credential semantics. A draw prize references a real `local_products` row
 * but keeps its own snapshot (name / image / cost) and its own independent
 * inventory, so changing the catalogue never rewrites an issued promise.
 *
 * The pool is *configuration only*. No draw is executed here, no random result
 * is produced and no resident-facing draw UI is opened by this card. The public
 * read below is the "verified read-only pool": it answers unavailable unless a
 * real, enabled, in-stock prize exists.
 */

const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be an ISO-8601 UTC timestamp')

/** Upper bounds keep weights and quantities far away from integer overflow. */
export const ACTIVITY_DRAW_MAX_WEIGHT = 1_000_000
export const ACTIVITY_DRAW_MAX_QUANTITY = 100_000
export const ACTIVITY_DRAW_MAX_DAILY_LIMIT = 100

export const ACTIVITY_DRAW_ROUTES = {
  /** Resident: read the validated, enabled prize pool of a published activity. */
  publicPool: '/activities/public/:activityId/draw-pool',
  state: '/activities/:activityId/draw-state',
  enter: '/activities/:activityId/draw',
  history: '/activities/:activityId/draw-history',
  adminVerify: '/admin/activities/:activityId/draw-verify',
  adminRedeem: '/admin/activities/:activityId/draw-redeem',
  adminRevoke: '/admin/activities/:activityId/draw-revoke',
  /** Staff: read the activity's draw pool (or the honest "not configured" state). */
  adminPool: '/admin/activities/:activityId/draw-pool',
  /** Staff: create or update the per-activity daily rule (idempotent upsert). */
  adminSavePool: '/admin/activities/:activityId/draw-pool',
  /** Staff: add a real product to the pool. */
  adminCreatePrize: '/admin/activities/:activityId/draw-prizes',
  /** Staff: change quantity / weight / enablement of one prize. */
  adminPrize: '/admin/activities/:activityId/draw-prizes/:prizeId',
} as const

const quantity = z.number().int().min(1).max(ACTIVITY_DRAW_MAX_QUANTITY)
const weight = z.number().int().min(0).max(ACTIVITY_DRAW_MAX_WEIGHT)

/** The snapshot fields are copied at configuration time and never re-read from the catalogue. */
export const activityDrawPrizeSchema = z.strictObject({
  id: z.string().uuid(),
  activityId: z.string().uuid(),
  productId: z.string().uuid(),
  /** Snapshot of the product name at configuration time. */
  productName: z.string().min(1),
  /** Snapshot of the product image at configuration time. */
  productImageUrl: z.string().nullable(),
  /**
   * Explicit per-unit fulfilment cost entered by operations when configuring the prize.
   * Never inferred from the product's selling price; the snapshot is immutable after award.
   */
  costCents: z.number().int().nonnegative(),
  /** The product's *current* catalogue shelf state, shown for operator awareness only. */
  productStatus: z.enum(['on_shelf', 'off_shelf']),
  totalQuantity: quantity,
  remainingQuantity: z.number().int().min(0).max(ACTIVITY_DRAW_MAX_QUANTITY),
  /**
   * How many prizes have already been awarded. This card never increments it;
   * #LOT-002 owns drawing. Once positive, the snapshot fields are immutable.
   */
  drawnQuantity: z.number().int().min(0).max(ACTIVITY_DRAW_MAX_QUANTITY),
  weight,
  enabled: z.boolean(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
})

export type ActivityDrawPrize = z.infer<typeof activityDrawPrizeSchema>

export const activityDrawTotalsSchema = z.object({
  totalQuantity: z.number().int().nonnegative(),
  remainingQuantity: z.number().int().nonnegative(),
  drawnQuantity: z.number().int().nonnegative(),
  enabledPrizeCount: z.number().int().nonnegative(),
})

export type ActivityDrawTotals = z.infer<typeof activityDrawTotalsSchema>

/**
 * `configured: false` is a real state, not a demo row: no pool row exists yet.
 * `dailyDrawLimitPerResident = 0` is only possible in that state.
 */
export const activityDrawPoolSchema = z
  .strictObject({
    activityId: z.string().uuid(),
    activityStatus: activityStatusSchema,
    community: authCommunitySchema,
    configured: z.boolean(),
    enabled: z.boolean(),
    /** Per resident per Asia/Shanghai calendar day. Enforced by #LOT-002. */
    dailyDrawLimitPerResident: z.number().int().min(0).max(ACTIVITY_DRAW_MAX_DAILY_LIMIT),
    /** Weight of the explicit "no prize" outcome; 0 means every draw must hit a prize. */
    noPrizeWeight: weight,
    prizes: z.array(activityDrawPrizeSchema),
    totals: activityDrawTotalsSchema,
    updatedAt: isoTimestamp.nullable(),
  })
  .superRefine((pool, ctx) => {
    if (pool.configured && pool.dailyDrawLimitPerResident < 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'a configured pool must set a positive daily draw limit',
        path: ['dailyDrawLimitPerResident'],
      })
    }
    const totals = pool.prizes.reduce(
      (acc, prize) => ({
        total: acc.total + prize.totalQuantity,
        remaining: acc.remaining + prize.remainingQuantity,
        drawn: acc.drawn + prize.drawnQuantity,
      }),
      { total: 0, remaining: 0, drawn: 0 },
    )
    if (
      totals.total !== pool.totals.totalQuantity ||
      totals.remaining !== pool.totals.remainingQuantity ||
      totals.drawn !== pool.totals.drawnQuantity
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'pool totals must equal the sum of the prize rows',
        path: ['totals'],
      })
    }
  })

export type ActivityDrawPool = z.infer<typeof activityDrawPoolSchema>

export const saveActivityDrawPoolRequestSchema = z.strictObject({
  /** `null` creates the pool; a timestamp updates the row it belongs to. */
  expectedUpdatedAt: isoTimestamp.nullable(),
  enabled: z.boolean(),
  dailyDrawLimitPerResident: z.number().int().min(1).max(ACTIVITY_DRAW_MAX_DAILY_LIMIT),
  noPrizeWeight: weight,
})

export type SaveActivityDrawPoolRequest = z.infer<typeof saveActivityDrawPoolRequestSchema>

export const createActivityDrawPrizeRequestSchema = z.strictObject({
  productId: z.string().uuid(),
  /** Explicit fulfilment cost in cents; zero is allowed for a confirmed free gift. */
  costCents: z.number().int().min(0).max(1_000_000_000),
  totalQuantity: quantity,
  weight,
  enabled: z.boolean(),
})

export type CreateActivityDrawPrizeRequest = z.infer<
  typeof createActivityDrawPrizeRequestSchema
>

export const updateActivityDrawPrizeRequestSchema = z
  .strictObject({
    expectedUpdatedAt: isoTimestamp,
    totalQuantity: quantity.optional(),
    weight: weight.optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const { expectedUpdatedAt: _token, ...changes } = value
    if (Object.keys(changes).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'at least one prize field must be changed',
        path: ['weight'],
      })
    }
  })

export type UpdateActivityDrawPrizeRequest = z.infer<
  typeof updateActivityDrawPrizeRequestSchema
>

/* -------------------------------------------------------------------------- */
/* Public, resident-facing read                                               */
/* -------------------------------------------------------------------------- */

export const drawUnavailableReasonSchema = z.enum([
  'activity_not_published',
  'activity_ended',
  'draw_pool_not_configured',
  'draw_pool_disabled',
  'no_prize_available',
])

export type DrawUnavailableReason = z.infer<typeof drawUnavailableReasonSchema>

/**
 * Only the fields a resident may see: no weights, no cost basis, no inventory
 * administration. The name/image are the frozen prize snapshot.
 */
export const publicDrawPrizeSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1),
  imageUrl: z.string().nullable(),
  remainingQuantity: z.number().int().min(0),
})

export type PublicDrawPrize = z.infer<typeof publicDrawPrizeSchema>

export const publicActivityDrawPoolSchema = z
  .strictObject({
    activityId: z.string().uuid(),
    available: z.boolean(),
    unavailableReason: drawUnavailableReasonSchema.nullable(),
    dailyDrawLimitPerResident: z.number().int().min(1).max(ACTIVITY_DRAW_MAX_DAILY_LIMIT).nullable(),
    prizes: z.array(publicDrawPrizeSchema),
  })
  .superRefine((pool, ctx) => {
    if (pool.available) {
      if (pool.unavailableReason !== null) {
        ctx.addIssue({
          code: 'custom',
          message: 'an available pool must not carry an unavailable reason',
          path: ['unavailableReason'],
        })
      }
      if (pool.dailyDrawLimitPerResident === null || pool.prizes.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'an available pool must have a daily limit and at least one prize',
          path: ['prizes'],
        })
      }
      return
    }
    if (pool.unavailableReason === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'an unavailable pool must say why',
        path: ['unavailableReason'],
      })
    }
    if (pool.prizes.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'an unavailable pool must not expose prize rows',
        path: ['prizes'],
      })
    }
  })

export type PublicActivityDrawPool = z.infer<typeof publicActivityDrawPoolSchema>

/* LL-LOT-002: resident draw outcomes and one-use fulfilment, separate from team rewards. */
const drawDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const drawAttemptRequestSchema = z.strictObject({
  idempotencyKey: z.string().uuid(),
})
export const drawCodeSchema = z.string().regex(/^DL-[0-9A-F]{24}$/)
export const drawCredentialSchema = z.strictObject({
  id: z.string().uuid(),
  status: z.enum(['active', 'redeemed', 'revoked']),
  codeSuffix: z.string().length(4),
  /** Deterministic HMAC derivation (key only on server). Never persisted as plaintext. */
  code: drawCodeSchema.nullable(),
})
export const residentDrawAttemptSchema = z.strictObject({
  id: z.string().uuid(),
  activityId: z.string().uuid(),
  day: drawDay,
  sequence: z.number().int().positive(),
  outcome: z.enum(['won', 'missed']),
  prize: z.strictObject({
    name: z.string(),
    imageUrl: z.string().nullable(),
  }).nullable(),
  credential: drawCredentialSchema.nullable(),
  createdAt: isoTimestamp,
})
export const residentDrawStateSchema = z.strictObject({
  activityId: z.string().uuid(),
  authenticated: z.boolean(),
  available: z.boolean(),
  unavailableReason: z.enum([
    'not_authenticated', 'not_assigned', 'activity_unavailable',
    'draw_pool_not_configured', 'draw_pool_disabled', 'no_prize_available',
    'draw_service_not_configured', 'daily_limit_reached',
  ]).nullable(),
  dailyLimit: z.number().int().nonnegative(),
  todayCount: z.number().int().nonnegative(),
  remainingToday: z.number().int().nonnegative(),
  day: drawDay,
})
export const residentDrawHistorySchema = z.strictObject({
  attempts: z.array(residentDrawAttemptSchema),
})
export const drawStaffCodeRequestSchema = z.strictObject({
  code: drawCodeSchema,
})
export const drawStaffRevokeRequestSchema = z.strictObject({
  credentialId: z.string().uuid(),
  reason: z.string().trim().min(2).max(200),
})
export const drawStaffCredentialSchema = z.strictObject({
  credentialId: z.string().uuid(),
  attemptId: z.string().uuid(),
  prizeName: z.string(),
  status: z.enum(['active', 'redeemed', 'revoked']),
  codeSuffix: z.string().length(4),
  redeemedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
})
export type ResidentDrawState = z.infer<typeof residentDrawStateSchema>
export type ResidentDrawAttempt = z.infer<typeof residentDrawAttemptSchema>
export type DrawStaffCredential = z.infer<typeof drawStaffCredentialSchema>
