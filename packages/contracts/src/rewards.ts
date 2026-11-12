import { z } from 'zod'

/**
 * Check-in, team reward and prize fulfilment contracts (LL-MVP-006, Issue #62).
 *
 * Business boundaries (see `docs/engineering/rewards-fulfillment.md`):
 *
 * - 一场活动 / 一类礼品 / 一次核销：one activity has at most one prize kind, one
 *   stock row per frozen rule version, and one credential per granted prize.
 * - 奖励资格来自「冻结快照 + 3 人 3 签到」：eligibility is computed from the
 *   immutable rule snapshot and the verified check-in rows, never from mutable
 *   activity columns.
 * - 核销凭据只以哈希落库，明文只在签发响应里出现一次。
 *
 * Every request body below is a `z.strictObject`, so an unknown field fails
 * parsing instead of being silently dropped.
 */

const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be an ISO-8601 UTC timestamp')

const count = z.number().int().min(0)
const cents = z.number().int().min(0)

/** Route identifiers shared by the API and its clients. */
export const REWARD_ROUTES = {
  /** Resident: read own check-in state for one activity. */
  checkinState: '/activities/:activityId/checkin',
  /** Resident: record today's real check-in. */
  checkin: '/activities/:activityId/checkin',
  /** Staff: list the check-ins of one activity. */
  adminCheckins: '/admin/activities/:activityId/checkins',
  /** Staff: verify an on-site check-in (only verified check-ins count). */
  adminCheckinVerify: '/admin/activities/:activityId/checkins/:checkinId/verify',
  /** Staff: revoke a check-in that turned out to be invalid. */
  adminCheckinRevoke: '/admin/activities/:activityId/checkins/:checkinId/revoke',
  /** Resident: read own team reward qualification, grant and credential. */
  teamReward: '/activities/:activityId/rewards',
  /** Resident: claim the team prize (idempotent, at most one grant per team). */
  claim: '/activities/:activityId/rewards/claim',
  /** Resident: read the credential metadata (never the plaintext code again). */
  credential: '/activities/:activityId/rewards/credential',
  /** Staff: reward overview of one activity (stock, budget, grants, disputes). */
  adminRewards: '/admin/activities/:activityId/rewards',
  /** Staff: append an audited revocation for one grant. */
  adminGrantRevoke: '/admin/activities/:activityId/rewards/grants/:grantId/revoke',
  /** Staff: append a dispute entry (`opened` / `reversed` / `dismissed`). */
  adminGrantDisputes: '/admin/activities/:activityId/rewards/grants/:grantId/disputes',
  /** Staff: redeem a credential code exactly once. */
  redeem: '/rewards/redeem',
} as const

/* -------------------------------------------------------------------------- */
/* Reward plan (frozen into the rule snapshot)                                */
/* -------------------------------------------------------------------------- */

/**
 * The reward plan of one activity. It is part of `activityKeyRulesSchema`, so it
 * is frozen into `activity_rule_versions.snapshot_json` at publish time and
 * every later fulfilment decision must read it from that snapshot.
 *
 * `prizeQuantityPerTeam` defaults to 1 because "一场活动 3 人成团得 1 份礼品" is
 * the only supported MVP shape; a larger value must be spelled out explicitly.
 */
export const activityRewardPlanSchema = z
  .strictObject({
    prizeName: z.string().trim().min(1).max(60),
    /** Unit cost in cents; the stock/budget arithmetic is `quantity * unit`. */
    prizeUnitCostCents: z.number().int().min(1).max(10_000_000),
    prizeQuantityPerTeam: z.number().int().min(1).max(100).default(1),
    /** Prize pool of the whole activity, independent of the budget cap. */
    totalPrizeQuantity: z.number().int().min(1).max(100_000),
    /** Hard money ceiling of the activity; a claim above it is rejected. */
    budgetCapCents: z.number().int().min(1).max(100_000_000),
    /** Who may claim for the team once it qualifies. */
    claimRecipient: z.enum(['leader', 'any_member']),
    /** Real check-ins are only accepted inside this window. */
    checkinWindow: z.strictObject({
      opensAt: isoTimestamp,
      closesAt: isoTimestamp,
    }),
    /** Credential TTL in hours, counted from issuance. */
    redemptionValidHours: z.number().int().min(1).max(720),
    notes: z.string().trim().max(500).optional(),
  })
  .superRefine((plan, ctx) => {
    if (Date.parse(plan.checkinWindow.closesAt) <= Date.parse(plan.checkinWindow.opensAt)) {
      ctx.addIssue({
        code: 'custom',
        message: 'checkinWindow.closesAt must be later than checkinWindow.opensAt',
        path: ['checkinWindow', 'closesAt'],
      })
    }
    if (plan.totalPrizeQuantity < plan.prizeQuantityPerTeam) {
      ctx.addIssue({
        code: 'custom',
        message: 'totalPrizeQuantity must cover at least one team prize',
        path: ['totalPrizeQuantity'],
      })
    }
    // A plan that cannot afford a single team must be rejected at configuration
    // time: otherwise the first eligible team would always hit budget_exceeded.
    if (plan.budgetCapCents < plan.prizeUnitCostCents * plan.prizeQuantityPerTeam) {
      ctx.addIssue({
        code: 'custom',
        message: 'budgetCapCents must cover at least one team prize',
        path: ['budgetCapCents'],
      })
    }
  })

export type ActivityRewardPlan = z.infer<typeof activityRewardPlanSchema>

/**
 * Why a check-in, a claim or a redemption is not possible right now.
 *
 * `reward_plan_not_configured` is the only reason a client may show as
 * "正式奖励入口未开放": without a frozen `rewardPlan` the API must answer this
 * code and must NOT fall back to mutable activity columns.
 */
export const rewardAvailabilityReasonSchema = z.enum([
  'reward_plan_not_configured',
  'activity_not_published',
  'activity_ended',
  'team_missing',
  'team_incomplete',
  'checkin_incomplete',
  'stock_exhausted',
  'budget_exhausted',
])

export type RewardAvailabilityReason = z.infer<typeof rewardAvailabilityReasonSchema>

export const checkinAvailabilityReasonSchema = z.enum([
  'reward_plan_not_configured',
  'activity_not_published',
  'activity_ended',
  'checkin_window_not_open',
  'checkin_window_closed',
  'not_a_team_member',
  'already_checked_in',
])

export type CheckinAvailabilityReason = z.infer<typeof checkinAvailabilityReasonSchema>

/* -------------------------------------------------------------------------- */
/* Check-in                                                                   */
/* -------------------------------------------------------------------------- */

/** `revoked` check-ins stay in the table as history and stop counting. */
export const checkinStatusSchema = z.enum(['valid', 'revoked'])
export type CheckinStatus = z.infer<typeof checkinStatusSchema>

export const rewardRecipientRoleSchema = z.enum(['leader', 'member'])
export type RewardRecipientRole = z.infer<typeof rewardRecipientRoleSchema>

/**
 * One real check-in. Only `status = valid` AND `verifiedAt != null` counts
 * towards the three-check-in requirement, so a self-reported check-in can never
 * unlock a prize on its own.
 */
export const activityCheckinSchema = z
  .strictObject({
    id: z.string().uuid(),
    activityId: z.string().uuid(),
    userId: z.string().uuid(),
    displayName: z.string().min(1),
    teamId: z.string().uuid().nullable(),
    seatNo: z.number().int().min(1).max(3).nullable(),
    status: checkinStatusSchema,
    note: z.string().nullable(),
    checkedInAt: isoTimestamp,
    verifiedAt: isoTimestamp.nullable(),
    verifiedByStaffId: z.string().uuid().nullable(),
    revokedAt: isoTimestamp.nullable(),
    revokedByStaffId: z.string().uuid().nullable(),
    revokeReason: z.string().nullable(),
  })
  .superRefine((checkin, ctx) => {
    if (checkin.status === 'revoked') {
      if (checkin.revokedAt === null || checkin.revokedByStaffId === null || !checkin.revokeReason) {
        ctx.addIssue({
          code: 'custom',
          message: 'a revoked check-in must record revokedAt, revokedByStaffId and revokeReason',
          path: ['status'],
        })
      }
      return
    }
    if (checkin.revokedAt !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a valid check-in must not carry revokedAt',
        path: ['revokedAt'],
      })
    }
  })

export type ActivityCheckin = z.infer<typeof activityCheckinSchema>

/** Body of `POST /activities/:activityId/checkin`. No user id: session only. */
export const activityCheckinRequestSchema = z.strictObject({
  note: z.string().trim().max(200).optional(),
})

export type ActivityCheckinRequest = z.infer<typeof activityCheckinRequestSchema>

export const activityCheckinVerifyRequestSchema = z.strictObject({
  note: z.string().trim().max(200).optional(),
})

export type ActivityCheckinVerifyRequest = z.infer<typeof activityCheckinVerifyRequestSchema>

export const activityCheckinRevokeRequestSchema = z.strictObject({
  reason: z.string().trim().min(2).max(200),
})

export type ActivityCheckinRevokeRequest = z.infer<typeof activityCheckinRevokeRequestSchema>

/** `GET /activities/:activityId/checkin` — the resident's own view. */
export const activityCheckinStateSchema = z
  .strictObject({
    activityId: z.string().uuid(),
    /** Copied from the frozen plan; `null` when no plan is configured. */
    checkinWindow: z
      .strictObject({ opensAt: isoTimestamp, closesAt: isoTimestamp })
      .nullable(),
    available: z.boolean(),
    unavailableReason: checkinAvailabilityReasonSchema.nullable(),
    checkin: activityCheckinSchema.nullable(),
    countsForReward: z.boolean(),
  })
  .superRefine((state, ctx) => {
    if (state.available && state.unavailableReason !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'unavailableReason must be null when available is true',
        path: ['unavailableReason'],
      })
    }
    if (!state.available && state.unavailableReason === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'unavailableReason is required when available is false',
        path: ['unavailableReason'],
      })
    }
    if (state.checkinWindow === null && state.available) {
      ctx.addIssue({
        code: 'custom',
        message: 'a check-in window is required when check-in is available',
        path: ['checkinWindow'],
      })
    }
  })

export type ActivityCheckinState = z.infer<typeof activityCheckinStateSchema>

/** `GET /admin/activities/:activityId/checkins`. */
export const adminActivityCheckinListSchema = z
  .strictObject({
    activityId: z.string().uuid(),
    items: z.array(activityCheckinSchema).max(500),
    counts: z.strictObject({
      valid: count,
      verified: count,
      pendingVerification: count,
      revoked: count,
    }),
  })
  .superRefine((list, ctx) => {
    const { valid, verified, pendingVerification, revoked } = list.counts
    if (verified + pendingVerification !== valid) {
      ctx.addIssue({
        code: 'custom',
        message: 'counts.valid must equal verified + pendingVerification',
        path: ['counts', 'valid'],
      })
    }
    if (valid + revoked !== list.items.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'counts.valid + counts.revoked must equal the number of listed check-ins',
        path: ['counts', 'revoked'],
      })
    }
  })

export type AdminActivityCheckinList = z.infer<typeof adminActivityCheckinListSchema>

/* -------------------------------------------------------------------------- */
/* Team reward qualification                                                  */
/* -------------------------------------------------------------------------- */

/** The three-person, three-check-in requirement of one team. */
export const teamRewardRequirementSchema = z
  .strictObject({
    seatsRequired: z.literal(3),
    seatsFilled: z.number().int().min(0).max(3),
    seatsSatisfied: z.boolean(),
    checkinsRequired: z.literal(3),
    /** Verified, non-revoked check-ins of the team's current members. */
    checkinsValid: z.number().int().min(0).max(3),
    checkinsSatisfied: z.boolean(),
  })
  .superRefine((requirement, ctx) => {
    if (requirement.seatsSatisfied !== (requirement.seatsFilled === 3)) {
      ctx.addIssue({
        code: 'custom',
        message: 'seatsSatisfied must be true exactly when all three seats are filled',
        path: ['seatsSatisfied'],
      })
    }
    if (requirement.checkinsSatisfied !== (requirement.checkinsValid === 3)) {
      ctx.addIssue({
        code: 'custom',
        message: 'checkinsSatisfied must be true exactly when three check-ins are valid',
        path: ['checkinsSatisfied'],
      })
    }
  })

export type TeamRewardRequirement = z.infer<typeof teamRewardRequirementSchema>

/**
 * Reward state of the resident's team. `eligible` is the single boolean the
 * client may use to enable the claim button; every other field explains it.
 */
export const teamRewardStateSchema = z
  .strictObject({
    activityId: z.string().uuid(),
    teamId: z.string().uuid(),
    /** Version number of the frozen snapshot the plan was read from. */
    ruleVersion: z.number().int().min(1).nullable(),
    planConfigured: z.boolean(),
    reward: z
      .strictObject({
        prizeName: z.string().min(1),
        prizeUnitCostCents: cents,
        prizeQuantityPerTeam: z.number().int().min(1),
        claimRecipient: z.enum(['leader', 'any_member']),
        redemptionValidHours: z.number().int().min(1),
        checkinWindow: z.strictObject({ opensAt: isoTimestamp, closesAt: isoTimestamp }),
      })
      .nullable(),
    requirement: teamRewardRequirementSchema,
    eligible: z.boolean(),
    /** `true` only for a session allowed to claim for this team. */
    claimableByMe: z.boolean(),
    unavailableReason: rewardAvailabilityReasonSchema.nullable(),
    grant: z.lazy(() => activityRewardGrantSchema).nullable(),
    credential: z.lazy(() => activityRewardCredentialSchema).nullable(),
  })
  .superRefine((state, ctx) => {
    if (state.planConfigured !== (state.reward !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'planConfigured must be true exactly when the frozen plan is present',
        path: ['planConfigured'],
      })
    }
    if (state.eligible && state.unavailableReason !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'unavailableReason must be null when the team is eligible',
        path: ['unavailableReason'],
      })
    }
    if (state.eligible && state.credential !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'an eligible team that already owns a credential must not claim again',
        path: ['eligible'],
      })
    }
    if (state.claimableByMe && !state.eligible) {
      ctx.addIssue({
        code: 'custom',
        message: 'claimableByMe requires eligible',
        path: ['claimableByMe'],
      })
    }
  })

export type TeamRewardState = z.infer<typeof teamRewardStateSchema>

/* -------------------------------------------------------------------------- */
/* Grants and one-time credentials                                            */
/* -------------------------------------------------------------------------- */

/**
 * Grant lifecycle. `disputed` and `reversed` are the only states reachable from
 * `redeemed`; a reversal never "un-redeems" the stock counters, it is expressed
 * by the append-only dispute/event rows instead.
 */
export const rewardGrantStatusSchema = z.enum([
  'granted',
  'redeemed',
  'revoked',
  'expired',
  'disputed',
  'reversed',
])

export type RewardGrantStatus = z.infer<typeof rewardGrantStatusSchema>

export const activityRewardGrantSchema = z
  .strictObject({
    id: z.string().uuid(),
    activityId: z.string().uuid(),
    /** UUID of the frozen `activity_rule_versions` row this grant was priced by. */
    ruleVersionId: z.string().uuid(),
    ruleVersion: z.number().int().min(1),
    teamId: z.string().uuid(),
    prizeName: z.string().min(1),
    quantity: z.number().int().min(1),
    unitCostCents: cents,
    totalCostCents: cents,
    status: rewardGrantStatusSchema,
    recipientRole: rewardRecipientRoleSchema,
    recipientUserId: z.string().uuid().nullable(),
    recipientDisplayName: z.string().nullable(),
    grantedAt: isoTimestamp,
    redeemedAt: isoTimestamp.nullable(),
    revokedAt: isoTimestamp.nullable(),
    /** Issuance time + `redemptionValidHours`; `null` before a code exists. */
    credentialExpiresAt: isoTimestamp.nullable(),
    openDisputeId: z.string().uuid().nullable(),
  })
  .superRefine((grant, ctx) => {
    if (grant.totalCostCents !== grant.quantity * grant.unitCostCents) {
      ctx.addIssue({
        code: 'custom',
        message: 'totalCostCents must equal quantity * unitCostCents',
        path: ['totalCostCents'],
      })
    }
    if (grant.recipientRole === 'leader' && grant.recipientUserId === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a leader grant must name its recipient',
        path: ['recipientUserId'],
      })
    }
    const redeemed = grant.redeemedAt !== null
    if (redeemed !== (grant.status === 'redeemed' || grant.status === 'disputed' || grant.status === 'reversed')) {
      ctx.addIssue({
        code: 'custom',
        message: 'redeemedAt must be set exactly for redeemed/disputed/reversed grants',
        path: ['redeemedAt'],
      })
    }
    if (grant.status === 'revoked' && grant.revokedAt === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a revoked grant must record revokedAt',
        path: ['revokedAt'],
      })
    }
    if (grant.openDisputeId !== null && grant.status !== 'disputed') {
      ctx.addIssue({
        code: 'custom',
        message: 'openDisputeId must be null unless the grant is disputed',
        path: ['openDisputeId'],
      })
    }
  })

export type ActivityRewardGrant = z.infer<typeof activityRewardGrantSchema>

/**
 * The credential code format: 10 characters of Crockford base32 without the
 * ambiguous `I`, `L`, `O`, `U`. Fixed shape on purpose — staff may read it out
 * loud, and any other shape must fail parsing instead of being "normalised".
 */
export const credentialCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9A-HJKMNP-TV-Z]{10}$/, 'must be a 10-character Crockford base32 code')

export type CredentialCode = z.infer<typeof credentialCodeSchema>

export const rewardCredentialStatusSchema = z.enum([
  'active',
  'redeemed',
  'superseded',
  'expired',
  'revoked',
])

export type RewardCredentialStatus = z.infer<typeof rewardCredentialStatusSchema>

/**
 * Credential metadata. The plaintext code is stored as a sha256 hash only, so
 * it appears exactly once: in the issue/claim response. Every read afterwards
 * returns this record with `maskedCode`.
 */
export const activityRewardCredentialSchema = z
  .strictObject({
    id: z.string().uuid(),
    grantId: z.string().uuid(),
    activityId: z.string().uuid(),
    teamId: z.string().uuid(),
    prizeName: z.string().min(1),
    status: rewardCredentialStatusSchema,
    /** Last four characters only, for staff to confirm the right slip. */
    maskedCode: z.string().regex(/^\*{6}[0-9A-HJKMNP-TV-Z]{4}$/, 'must be a masked credential code'),
    issuedAt: isoTimestamp,
    expiresAt: isoTimestamp,
    redeemedAt: isoTimestamp.nullable(),
    redeemedByStaffId: z.string().uuid().nullable(),
    supersededAt: isoTimestamp.nullable(),
  })
  .superRefine((credential, ctx) => {
    if (Date.parse(credential.expiresAt) <= Date.parse(credential.issuedAt)) {
      ctx.addIssue({
        code: 'custom',
        message: 'expiresAt must be later than issuedAt',
        path: ['expiresAt'],
      })
    }
    const redeemed = credential.redeemedAt !== null
    if (redeemed !== (credential.status === 'redeemed')) {
      ctx.addIssue({
        code: 'custom',
        message: 'redeemedAt must be set exactly for a redeemed credential',
        path: ['redeemedAt'],
      })
    }
    if (credential.status === 'superseded' && credential.supersededAt === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a superseded credential must record supersededAt',
        path: ['supersededAt'],
      })
    }
  })

export type ActivityRewardCredential = z.infer<typeof activityRewardCredentialSchema>

/** Body of `POST /activities/:activityId/rewards/claim`: session only. */
export const activityRewardClaimRequestSchema = z.strictObject({})

export type ActivityRewardClaimRequest = z.infer<typeof activityRewardClaimRequestSchema>

/**
 * Claim response. `code` is the only place the plaintext credential ever
 * appears; `created = false` means an existing grant/credential was returned
 * unchanged (a credential is never re-issued here, because that would invalidate
 * a slip the resident may already hold).
 */
export const activityRewardClaimResponseSchema = z.object({
  created: z.boolean(),
  grant: activityRewardGrantSchema,
  credential: activityRewardCredentialSchema,
  code: credentialCodeSchema,
})

export type ActivityRewardClaimResponse = z.infer<typeof activityRewardClaimResponseSchema>

/** Body of `POST /rewards/redeem` (staff only). */
export const rewardRedeemRequestSchema = z.strictObject({
  code: credentialCodeSchema,
  note: z.string().trim().max(200).optional(),
})

export type RewardRedeemRequest = z.infer<typeof rewardRedeemRequestSchema>

export const rewardRedeemResponseSchema = z.strictObject({
  /** `true` only for the call that performed the one-time redemption. */
  redeemed: z.boolean(),
  grant: activityRewardGrantSchema,
  credential: activityRewardCredentialSchema,
})

export type RewardRedeemResponse = z.infer<typeof rewardRedeemResponseSchema>

/* -------------------------------------------------------------------------- */
/* Disputes and manual reversals (append-only)                                */
/* -------------------------------------------------------------------------- */

/**
 * Every dispute action is a new row. `opened` is the first entry, and only the
 * last entry may be a decision; `reversed`/`dismissed` are terminal.
 */
export const rewardDisputeDecisionSchema = z.enum(['opened', 'reversed', 'dismissed'])
export type RewardDisputeDecision = z.infer<typeof rewardDisputeDecisionSchema>

export const activityRewardDisputeSchema = z.strictObject({
  id: z.string().uuid(),
  activityId: z.string().uuid(),
  grantId: z.string().uuid(),
  decision: rewardDisputeDecisionSchema,
  reason: z.string().min(1),
  note: z.string().nullable(),
  actorStaffId: z.string().uuid().nullable(),
  createdAt: isoTimestamp,
})

export type ActivityRewardDispute = z.infer<typeof activityRewardDisputeSchema>

/** Body of `POST /admin/activities/:activityId/rewards/grants/:grantId/disputes`. */
export const activityRewardDisputeRequestSchema = z.strictObject({
  decision: rewardDisputeDecisionSchema,
  reason: z.string().trim().min(2).max(500),
  note: z.string().trim().max(500).optional(),
})

export type ActivityRewardDisputeRequest = z.infer<typeof activityRewardDisputeRequestSchema>

export const activityRewardDisputeThreadSchema = z
  .strictObject({
    grantId: z.string().uuid(),
    open: z.boolean(),
    entries: z.array(activityRewardDisputeSchema).min(1).max(100),
  })
  .superRefine((thread, ctx) => {
    const [first] = thread.entries
    if (first?.decision !== 'opened') {
      ctx.addIssue({
        code: 'custom',
        message: 'the first dispute entry must be "opened"',
        path: ['entries', 0, 'decision'],
      })
    }
    thread.entries.forEach((entry, index) => {
      const last = index === thread.entries.length - 1
      if (entry.grantId !== thread.grantId) {
        ctx.addIssue({
          code: 'custom',
          message: 'every entry must belong to grantId',
          path: ['entries', index, 'grantId'],
        })
      }
      if (!last && entry.decision !== 'opened') {
        ctx.addIssue({
          code: 'custom',
          message: 'a decision must be the last entry of the thread',
          path: ['entries', index, 'decision'],
        })
      }
    })
    const lastDecision = thread.entries[thread.entries.length - 1]?.decision
    if (thread.open !== (lastDecision === 'opened')) {
      ctx.addIssue({
        code: 'custom',
        message: 'open must be true exactly when the last entry is still "opened"',
        path: ['open'],
      })
    }
  })

export type ActivityRewardDisputeThread = z.infer<typeof activityRewardDisputeThreadSchema>

/** Body of `POST /admin/activities/:activityId/rewards/grants/:grantId/revoke`. */
export const activityRewardGrantRevokeRequestSchema = z.strictObject({
  reason: z.string().trim().min(2).max(500),
})

export type ActivityRewardGrantRevokeRequest = z.infer<
  typeof activityRewardGrantRevokeRequestSchema
>

/* -------------------------------------------------------------------------- */
/* Append-only audit trail                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every fulfilment step is an appended event, never an in-place edit. `sequence`
 * is monotonic per activity so two events in the same millisecond still have a
 * deterministic order.
 */
export const rewardEventKindSchema = z.enum([
  'checkin.verified',
  'checkin.revoked',
  'grant.created',
  'grant.redeemed',
  'grant.revoked',
  'grant.expired',
  'credential.issued',
  'credential.superseded',
  'dispute.opened',
  'dispute.reversed',
  'dispute.dismissed',
])

export type RewardEventKind = z.infer<typeof rewardEventKindSchema>

export const activityRewardEventSchema = z.strictObject({
  id: z.string().uuid(),
  activityId: z.string().uuid(),
  sequence: z.number().int().min(1),
  kind: rewardEventKindSchema,
  grantId: z.string().uuid().nullable(),
  checkinId: z.string().uuid().nullable(),
  credentialId: z.string().uuid().nullable(),
  actorUserId: z.string().uuid().nullable(),
  actorStaffId: z.string().uuid().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  createdAt: isoTimestamp,
})

export type ActivityRewardEvent = z.infer<typeof activityRewardEventSchema>

/* -------------------------------------------------------------------------- */
/* Stock and budget accounting                                                */
/* -------------------------------------------------------------------------- */

/**
 * Occupancy of the prize pool and the money budget for one activity.
 *
 * `claimedQuantity` is the committed (occupied) quantity and `redeemedQuantity`
 * the actually handed-out quantity, so `claimedQuantity >= redeemedQuantity`
 * always holds. Revoking an unredeemed grant releases `claimedQuantity`; a
 * reversed *redeemed* grant must NOT lower `redeemedQuantity` — the reversal is
 * recorded in the append-only dispute/event rows so the stock ledger and the
 * audit trail can never disagree.
 */
export const activityPrizeStockSchema = z
  .strictObject({
    activityId: z.string().uuid(),
    ruleVersionId: z.string().uuid(),
    ruleVersion: z.number().int().min(1),
    prizeName: z.string().min(1),
    unitCostCents: cents,
    totalQuantity: z.number().int().min(0),
    claimedQuantity: z.number().int().min(0),
    redeemedQuantity: z.number().int().min(0),
    budgetCapCents: cents,
    committedBudgetCents: cents,
    redeemedBudgetCents: cents,
    availableQuantity: z.number().int().min(0),
    remainingBudgetCents: cents,
    updatedAt: isoTimestamp,
  })
  .superRefine((stock, ctx) => {
    if (stock.claimedQuantity > stock.totalQuantity) {
      ctx.addIssue({
        code: 'custom',
        message: 'claimedQuantity must not exceed totalQuantity',
        path: ['claimedQuantity'],
      })
    }
    if (stock.redeemedQuantity > stock.claimedQuantity) {
      ctx.addIssue({
        code: 'custom',
        message: 'redeemedQuantity must not exceed claimedQuantity',
        path: ['redeemedQuantity'],
      })
    }
    if (stock.availableQuantity !== stock.totalQuantity - stock.claimedQuantity) {
      ctx.addIssue({
        code: 'custom',
        message: 'availableQuantity must equal totalQuantity - claimedQuantity',
        path: ['availableQuantity'],
      })
    }
    if (stock.committedBudgetCents !== stock.claimedQuantity * stock.unitCostCents) {
      ctx.addIssue({
        code: 'custom',
        message: 'committedBudgetCents must equal claimedQuantity * unitCostCents',
        path: ['committedBudgetCents'],
      })
    }
    if (stock.redeemedBudgetCents !== stock.redeemedQuantity * stock.unitCostCents) {
      ctx.addIssue({
        code: 'custom',
        message: 'redeemedBudgetCents must equal redeemedQuantity * unitCostCents',
        path: ['redeemedBudgetCents'],
      })
    }
    if (stock.remainingBudgetCents !== stock.budgetCapCents - stock.committedBudgetCents) {
      ctx.addIssue({
        code: 'custom',
        message: 'remainingBudgetCents must equal budgetCapCents - committedBudgetCents',
        path: ['remainingBudgetCents'],
      })
    }
  })

export type ActivityPrizeStock = z.infer<typeof activityPrizeStockSchema>

/* -------------------------------------------------------------------------- */
/* Admin overview                                                             */
/* -------------------------------------------------------------------------- */

/** One row of the admin grant table: grant + current credential status. */
export const adminActivityRewardGrantRowSchema = z.strictObject({
  grant: activityRewardGrantSchema,
  credentialStatus: rewardCredentialStatusSchema.nullable(),
  credentialMaskedCode: z.string().nullable(),
  credentialIssuedAt: isoTimestamp.nullable(),
  credentialExpiresAt: isoTimestamp.nullable(),
  openDispute: z.boolean(),
})

export type AdminActivityRewardGrantRow = z.infer<typeof adminActivityRewardGrantRowSchema>

/**
 * `GET /admin/activities/:activityId/rewards`. `planConfigured = false` means the
 * frozen snapshot has no reward plan, so the whole reward module is formally
 * unavailable for this activity — the UI must say so instead of showing zeros.
 */
export const adminActivityRewardOverviewSchema = z
  .strictObject({
    activityId: z.string().uuid(),
    activityStatus: z.enum(['draft', 'published', 'paused', 'ended']),
    ruleVersion: z.number().int().min(1).nullable(),
    /** Where the plan came from: the frozen snapshot, never the activity row. */
    planSource: z.enum(['rule_version_snapshot', 'none']),
    planConfigured: z.boolean(),
    plan: activityRewardPlanSchema.nullable(),
    stock: activityPrizeStockSchema.nullable(),
    counts: z.strictObject({
      checkinsValid: count,
      checkinsVerified: count,
      checkinsPendingVerification: count,
      checkinsRevoked: count,
      grantsTotal: count,
      grantsGranted: count,
      grantsRedeemed: count,
      grantsRevoked: count,
      grantsDisputed: count,
      grantsReversed: count,
      codesActive: count,
      codesRedeemed: count,
    }),
    grants: z.array(adminActivityRewardGrantRowSchema).max(500),
  })
  .superRefine((overview, ctx) => {
    if (overview.planConfigured !== (overview.plan !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'planConfigured must be true exactly when plan is present',
        path: ['planConfigured'],
      })
    }
    if (overview.planConfigured !== (overview.planSource === 'rule_version_snapshot')) {
      ctx.addIssue({
        code: 'custom',
        message: 'planSource must be rule_version_snapshot exactly when a plan is configured',
        path: ['planSource'],
      })
    }
    if (overview.plan === null && overview.stock !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'stock must be null when no plan is configured',
        path: ['stock'],
      })
    }
    if (overview.plan !== null && overview.stock === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a configured plan must have its stock row',
        path: ['stock'],
      })
    }
    const counts = overview.counts
    if (
      counts.grantsTotal !==
      counts.grantsGranted +
        counts.grantsRedeemed +
        counts.grantsRevoked +
        counts.grantsDisputed +
        counts.grantsReversed
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'grantsTotal must equal the sum of the per-status grant counts',
        path: ['counts', 'grantsTotal'],
      })
    }
    if (counts.grantsTotal !== overview.grants.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'grantsTotal must equal the number of listed grants',
        path: ['counts', 'grantsTotal'],
      })
    }
  })

export type AdminActivityRewardOverview = z.infer<typeof adminActivityRewardOverviewSchema>
