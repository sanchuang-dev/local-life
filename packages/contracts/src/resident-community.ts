import { z } from 'zod'

/**
 * Resident permanent community (#171 LL-IDENTITY-001).
 *
 * Product decision: one resident platform account may confirm exactly one
 * *permanent* community, once, by the resident themself. Browsing any other
 * community stays free, and browsing never changes the binding.
 *
 * The single source of truth is the append-only `resident_community_bindings`
 * table, NOT `resident_community_assignments`. The legacy assignments table only
 * holds historical relations (some of them created by the retired #123
 * "log in and get attributed automatically" flow) and is never treated as proof
 * that the resident confirmed anything. A legacy single assignment is therefore
 * only a *candidate* the resident may confirm; a legacy multi-assignment account
 * is `pending_review` and needs a human decision — never an automatic pick of
 * the earliest or newest row.
 *
 * Derived state machine (`status` is computed per query, never stored as a
 * mutable flag):
 *
 *   unbound        no confirmed binding, at most one legacy relation
 *   confirmed      exactly one confirmed binding, no conflicting candidate
 *   conflict       confirmed binding A exists AND a server-derived candidate for
 *                  community B is pending; A is unchanged and B must be refused
 *   pending_review no confirmed binding, legacy relations >= 2 (human review)
 *
 * `confirmed` is terminal for the resident surface: this contract deliberately
 * has no update/rebind/delete DTO. A compliance correction is a separate,
 * audited back-office operation, not a resident or everyday-admin API.
 *
 * These DTOs carry no OpenID, unionid, token, session, cookie or phone field;
 * `evidenceRef` is a redacted, server-generated reference and never a credential.
 */

const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be an ISO-8601 UTC timestamp')

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resident routes. `status` is one read that answers both "where am I bound" and
 * "do I have a pending server-derived candidate"; `confirm` is the one-shot
 * explicit confirmation. Clients must build URLs from these constants.
 */
export const RESIDENT_COMMUNITY_ROUTES = {
  status: '/resident-community/status',
  confirm: '/resident-community/confirm',
} as const

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/** The four states a resident may be shown. See the module docs for the rules. */
export const residentCommunityStatusSchema = z.enum([
  'unbound',
  'confirmed',
  'pending_review',
  'conflict',
])
export type ResidentCommunityStatus = z.infer<typeof residentCommunityStatusSchema>

/**
 * Why a confirmed binding exists. Both values are written only by the API from a
 * server-verified action; a client never supplies `source`.
 *
 * - `resident_h5_confirmed`: the resident tapped the explicit confirmation.
 * - `admin_compliance_correction`: reserved for the separately approved,
 *   audited compliance/identity-dispute correction path (not a resident or
 *   everyday-admin surface).
 */
export const RESIDENT_COMMUNITY_BINDING_SOURCES = [
  'resident_h5_confirmed',
  'admin_compliance_correction',
] as const

export const residentCommunityBindingSourceSchema = z.enum(RESIDENT_COMMUNITY_BINDING_SOURCES)
export type ResidentCommunityBindingSource = z.infer<
  typeof residentCommunityBindingSourceSchema
>

/**
 * Where a *candidate* came from. Candidates are derived server-side only — an
 * activity the resident demonstrably opened (its community was resolved from the
 * activity row, never from a client-supplied communityId). A client-supplied
 * communityId is never accepted as a candidate source.
 */
export const RESIDENT_COMMUNITY_CANDIDATE_SOURCES = ['activity_oauth_candidate'] as const
export const residentCommunityCandidateSourceSchema = z.enum(
  RESIDENT_COMMUNITY_CANDIDATE_SOURCES,
)
export type ResidentCommunityCandidateSource = z.infer<
  typeof residentCommunityCandidateSourceSchema
>

/** Why the resident cannot confirm right now. `null` when confirmation is open. */
export const residentCommunityConfirmBlockedReasonSchema = z.enum([
  'already_confirmed',
  'pending_review',
  'candidate_conflict',
])
export type ResidentCommunityConfirmBlockedReason = z.infer<
  typeof residentCommunityConfirmBlockedReasonSchema
>

/* -------------------------------------------------------------------------- */
/* Value objects                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Community as a resident needs to read it before confirming: name plus the
 * service-point address. No coordinates, no internal counters, no staff scope.
 */
export const residentCommunityRefSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1),
  /** `communities.address`; `null` when the service point has no address yet. */
  serviceAddress: z.string().nullable(),
})
export type ResidentCommunityRef = z.infer<typeof residentCommunityRefSchema>

/** The resident's confirmed permanent community. Immutable once created. */
export const residentCommunityBindingSchema = z.strictObject({
  community: residentCommunityRefSchema,
  confirmedAt: isoTimestamp,
  source: residentCommunityBindingSourceSchema,
})
export type ResidentCommunityBinding = z.infer<typeof residentCommunityBindingSchema>

/**
 * A server-derived, expiring candidate. It is a suggestion for the resident to
 * review, never a binding: confirming is still an explicit action, and the
 * candidate disappears once a binding exists.
 */
export const residentCommunityCandidateSchema = z.strictObject({
  community: residentCommunityRefSchema,
  source: residentCommunityCandidateSourceSchema,
  suggestedAt: isoTimestamp,
  expiresAt: isoTimestamp,
})
export type ResidentCommunityCandidate = z.infer<typeof residentCommunityCandidateSchema>

/**
 * One historical `resident_community_assignments` row, as a read-only fact. It
 * proves a relation existed; it never proves the resident confirmed it.
 */
export const residentLegacyAssignmentSchema = z.strictObject({
  community: residentCommunityRefSchema,
  assignedAt: isoTimestamp,
})
export type ResidentLegacyAssignment = z.infer<typeof residentLegacyAssignmentSchema>

/**
 * Historical relations for this account. `pendingReview` is `true` only when the
 * account carries two or more historical communities, which must be decided by a
 * human — the API never picks one of them.
 */
export const residentLegacyHistorySchema = z.strictObject({
  assignmentCount: z.number().int().nonnegative(),
  pendingReview: z.boolean(),
  /** Ordered by community id so the payload is stable across requests. */
  assignments: z.array(residentLegacyAssignmentSchema),
})
export type ResidentLegacyHistory = z.infer<typeof residentLegacyHistorySchema>

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

const residentCommunityStatusResponseBaseSchema = z.strictObject({
  status: residentCommunityStatusSchema,
  /** Present exactly for `confirmed` and `conflict`; never a legacy guess. */
  binding: residentCommunityBindingSchema.nullable(),
  /** Pending candidate for this account, if any (expired candidates are omitted). */
  candidate: residentCommunityCandidateSchema.nullable(),
  /** Always present, even when empty: 未绑定 must be visible, not silently absent. */
  legacyHistory: residentLegacyHistorySchema,
  /** `true` only when the resident may POST a confirmation right now. */
  canConfirm: z.boolean(),
  /** Why confirmation is closed, or `null` when `canConfirm` is `true`. */
  confirmBlockedReason: residentCommunityConfirmBlockedReasonSchema.nullable(),
})

/**
 * One query answers both resident questions: "what is my permanent community"
 * and "is there a candidate/conflict I should see". Cross-field rules are pinned
 * here so the API and the H5 cannot drift into an impossible combination
 * (for example `confirmed` without a binding, or `conflict` pointing at the same
 * community as the binding).
 */
export const residentCommunityStatusResponseSchema =
  residentCommunityStatusResponseBaseSchema.superRefine((value, ctx) => {
    const confirmed = value.status === 'confirmed' || value.status === 'conflict'
    if (confirmed && value.binding === null) {
      ctx.addIssue({
        code: 'custom',
        message: `${value.status} 必须携带已确认常驻社区`,
        path: ['binding'],
      })
    }
    if (!confirmed && value.binding !== null) {
      ctx.addIssue({
        code: 'custom',
        message: `${value.status} 不得携带已确认常驻社区`,
        path: ['binding'],
      })
    }
    if (value.status === 'conflict') {
      if (value.candidate === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'conflict 必须携带候选社区',
          path: ['candidate'],
        })
      } else if (value.binding !== null && value.candidate.community.id === value.binding.community.id) {
        ctx.addIssue({
          code: 'custom',
          message: 'conflict 的候选社区必须与已确认社区不同',
          path: ['candidate'],
        })
      }
    }
    if (value.status === 'pending_review' && !value.legacyHistory.pendingReview) {
      ctx.addIssue({
        code: 'custom',
        message: 'pending_review 必须对应多条历史归属',
        path: ['legacyHistory'],
      })
    }
    if (value.legacyHistory.pendingReview !== (value.legacyHistory.assignmentCount > 1)) {
      ctx.addIssue({
        code: 'custom',
        message: 'pendingReview 必须与历史归属条数一致',
        path: ['legacyHistory', 'pendingReview'],
      })
    }
    if (value.legacyHistory.assignments.length !== value.legacyHistory.assignmentCount) {
      ctx.addIssue({
        code: 'custom',
        message: 'assignments 长度必须等于 assignmentCount',
        path: ['legacyHistory', 'assignments'],
      })
    }
    if (value.canConfirm !== (value.confirmBlockedReason === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'canConfirm 与 confirmBlockedReason 必须互为反义',
        path: ['confirmBlockedReason'],
      })
    }
    if (value.canConfirm && value.status !== 'unbound') {
      ctx.addIssue({
        code: 'custom',
        message: '只有 unbound 状态可以发起确认',
        path: ['status'],
      })
    }
    if (value.confirmBlockedReason === 'already_confirmed' && value.binding === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'already_confirmed 必须携带已确认社区',
        path: ['confirmBlockedReason'],
      })
    }
  })

export type ResidentCommunityStatusResponse = z.infer<
  typeof residentCommunityStatusResponseSchema
>

/* -------------------------------------------------------------------------- */
/* First confirmation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The resident's explicit first confirmation. `communityId` must be the real
 * community the resident is looking at; the API re-reads it from `communities`
 * and ignores any browser-side community context (localStorage is a browsing
 * choice, never an identity claim). A confirmation request carries nothing else:
 * in particular the client cannot choose a `source`, `confirmedAt` or user id.
 */
export const confirmResidentCommunityRequestSchema = z.strictObject({
  communityId: z.string().uuid(),
})
export type ConfirmResidentCommunityRequest = z.infer<
  typeof confirmResidentCommunityRequestSchema
>

/**
 * Successful confirmation. `idempotent` is `true` for a repeat submission of the
 * already-confirmed community (same binding, same `confirmedAt`); a different
 * community is never a success — it answers `409 resident_community_conflict`
 * and leaves the binding untouched.
 */
export const confirmResidentCommunityResponseSchema = z.strictObject({
  status: z.literal('confirmed'),
  binding: residentCommunityBindingSchema,
  idempotent: z.boolean(),
})
export type ConfirmResidentCommunityResponse = z.infer<
  typeof confirmResidentCommunityResponseSchema
>
