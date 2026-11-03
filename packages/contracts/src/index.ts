import { z } from 'zod'

/** Route identifiers shared by the API and every client that calls it. */
export const API_ROUTES = {
  health: '/healthz',
  authMethods: '/auth/methods',
  authCsrf: '/auth/csrf',
  authSession: '/auth/session',
  authLogin: '/auth/login',
  authLogout: '/auth/logout',
  authWechatStart: '/auth/wechat/start',
} as const

export const SERVICE_NAME = 'local-life-api' as const

export const API_ERROR_CODES = {
  notFound: 'not_found',
  internal: 'internal_error',
  invalidRequest: 'invalid_request',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  conflict: 'conflict',
  rateLimited: 'rate_limited',
  notConfigured: 'not_configured',
} as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]

const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be an ISO-8601 UTC timestamp')

/** `GET /healthz` contract. The API validates its own response with this schema. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal(SERVICE_NAME),
  version: z.string().min(1),
  uptimeSeconds: z.number().int().nonnegative(),
  timestamp: isoTimestamp,
})

export type HealthResponse = z.infer<typeof healthResponseSchema>

/** Structured error envelope. Clients must be able to distinguish real errors from demo states. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1).optional(),
  }),
})

export type ApiError = z.infer<typeof apiErrorSchema>

export const staffRoleSchema = z.enum(['admin', 'operator', 'grid_worker'])
export type StaffRole = z.infer<typeof staffRoleSchema>

export const staffLoginRequestSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(1).max(128),
})

export const createCommunityRequestSchema = z.object({
  name: z.string().trim().min(2).max(60),
})

export const createStaffAccountRequestSchema = z.object({
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,32}$/),
  displayName: z.string().trim().min(1).max(40),
  password: z.string().min(12).max(128),
  role: z.enum(['operator', 'grid_worker']),
  userId: z.preprocess(
    (value) => (value === '' || value == null ? undefined : value),
    z.string().uuid().optional(),
  ),
  communityIds: z.array(z.string().uuid()).min(1).max(20),
})

export const authUserSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().nullable(),
})

export const authCommunitySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
})

export const authStaffSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  role: staffRoleSchema,
  communities: z.array(authCommunitySchema),
})

export const authSessionResponseSchema = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(false) }),
  z.object({
    authenticated: z.literal(true),
    user: authUserSchema,
    staff: authStaffSchema.nullable(),
    csrfToken: z.string().min(20),
  }),
])

export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>

/* -------------------------------------------------------------------------- */
/* Activity domain (#59 LL-MVP-003)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Route identifiers for the activity domain. Clients must build URLs from these
 * constants instead of hard-coded strings so the API and every client stay in sync.
 */
export const ACTIVITY_ROUTES = {
  publicList: '/activities/public',
  publicDetail: '/activities/public/:activityId',
  adminList: '/admin/activities',
  adminDetail: '/admin/activities/:activityId',
  adminPublish: '/admin/activities/:activityId/publish',
  adminPause: '/admin/activities/:activityId/pause',
  adminResume: '/admin/activities/:activityId/resume',
  adminEnd: '/admin/activities/:activityId/end',
  adminRuleVersions: '/admin/activities/:activityId/rule-versions',
  adminAudit: '/admin/activities/:activityId/audit',
} as const

/** Lifecycle state of an activity. Only staff can change it, through explicit transitions. */
export const activityStatusSchema = z.enum(['draft', 'published', 'paused', 'ended'])
export type ActivityStatus = z.infer<typeof activityStatusSchema>

/** Status values that may be exposed to residents; drafts are never public. */
export const activityPublicStatusSchema = z.enum(['published', 'paused', 'ended'])
export type ActivityPublicStatus = z.infer<typeof activityPublicStatusSchema>

/** Rules that residents are allowed to read. */
export const activityPublicRulesSchema = z.object({
  eligibility: z.string().trim().min(1).max(500),
  checkin: z.string().trim().min(1).max(500),
  purchase: z.string().trim().min(1).max(500),
  prizeClaim: z.string().trim().min(1).max(500),
  notes: z.string().trim().max(500).optional(),
})

export type ActivityPublicRules = z.infer<typeof activityPublicRulesSchema>

/**
 * The immutable rule snapshot of an activity. Changing it creates a new rule version,
 * so published activities always keep the rules they were published with.
 */
export const activityKeyRulesSchema = z
  .object({
    startsAt: isoTimestamp,
    endsAt: isoTimestamp,
    location: z.string().trim().min(2).max(120),
    budgetCapCents: z.number().int().min(0).max(100_000_000),
    prizeQuantityCap: z.number().int().min(0).max(100_000),
    publicRules: activityPublicRulesSchema,
  })
  .superRefine((value, ctx) => {
    if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
      ctx.addIssue({
        code: 'custom',
        message: 'endsAt must be later than startsAt',
        path: ['endsAt'],
      })
    }
  })

export type ActivityKeyRules = z.infer<typeof activityKeyRulesSchema>

export const createActivityRequestSchema = z.object({
  communityId: z.string().uuid(),
  title: z.string().trim().min(2).max(80),
  summary: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  keyRules: activityKeyRulesSchema,
})

export type CreateActivityRequest = z.infer<typeof createActivityRequestSchema>

export const updateActivityRequestSchema = z
  .object({
    expectedUpdatedAt: isoTimestamp,
    title: z.string().trim().min(2).max(80).optional(),
    summary: z.string().trim().max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    keyRules: activityKeyRulesSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.title === undefined &&
      value.summary === undefined &&
      value.description === undefined &&
      value.keyRules === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'at least one field must be provided',
        path: [],
      })
    }
  })

export type UpdateActivityRequest = z.infer<typeof updateActivityRequestSchema>

/**
 * Publish / pause / resume / end all require the optimistic-concurrency token so a
 * stale admin tab cannot overwrite a newer transition.
 */
export const activityTransitionRequestSchema = z.object({
  expectedUpdatedAt: isoTimestamp,
})

export type ActivityTransitionRequest = z.infer<typeof activityTransitionRequestSchema>

/** Community reference shared with the public and admin activity payloads. */
export const activityCommunityRefSchema = authCommunitySchema
export type ActivityCommunityRef = z.infer<typeof activityCommunityRefSchema>

/**
 * Public payloads deliberately exclude budgets, prize caps, rule-version ownership
 * and audit entries. Unknown keys are stripped by zod so internal fields can never
 * leak into a public response even if a caller passes a wider object.
 */
export const publicActivitySummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  summary: z.string().nullable(),
  community: activityCommunityRefSchema,
  location: z.string().min(1),
  startsAt: isoTimestamp,
  endsAt: isoTimestamp,
  status: activityPublicStatusSchema,
  ruleVersion: z.number().int().nullable(),
  updatedAt: isoTimestamp,
})

export type PublicActivitySummary = z.infer<typeof publicActivitySummarySchema>

export const publicActivityDetailSchema = publicActivitySummarySchema.extend({
  description: z.string().nullable(),
  publicRules: activityPublicRulesSchema,
  publishedAt: isoTimestamp.nullable(),
})

export type PublicActivityDetail = z.infer<typeof publicActivityDetailSchema>

export const publicActivityListResponseSchema = z.object({
  items: z.array(publicActivitySummarySchema),
})

export type PublicActivityListResponse = z.infer<typeof publicActivityListResponseSchema>

/* ------------------------------- Admin side ------------------------------- */

export const adminActivitySummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  summary: z.string().nullable(),
  community: activityCommunityRefSchema,
  status: activityStatusSchema,
  startsAt: isoTimestamp,
  endsAt: isoTimestamp,
  location: z.string().min(1),
  budgetCapCents: z.number().int().min(0),
  prizeQuantityCap: z.number().int().min(0),
  ruleVersion: z.number().int().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  publishedAt: isoTimestamp.nullable(),
})

export type AdminActivitySummary = z.infer<typeof adminActivitySummarySchema>

export const adminActivityDetailSchema = adminActivitySummarySchema.extend({
  description: z.string().nullable(),
  publicRules: activityPublicRulesSchema,
  currentRuleVersionId: z.string().uuid().nullable(),
})

export type AdminActivityDetail = z.infer<typeof adminActivityDetailSchema>

export const adminActivityListResponseSchema = z.object({
  items: z.array(adminActivitySummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
})

export type AdminActivityListResponse = z.infer<typeof adminActivityListResponseSchema>

/** Immutable snapshot recorded on every rule change. */
export const activityRuleVersionSchema = z.object({
  id: z.string().uuid(),
  activityId: z.string().uuid(),
  version: z.number().int().min(1),
  snapshot: activityKeyRulesSchema,
  createdByUserId: z.string().uuid(),
  createdAt: isoTimestamp,
})

export type ActivityRuleVersion = z.infer<typeof activityRuleVersionSchema>

export const activityRuleVersionListResponseSchema = z.object({
  items: z.array(activityRuleVersionSchema),
})

export type ActivityRuleVersionListResponse = z.infer<
  typeof activityRuleVersionListResponseSchema
>

/**
 * Audit entries are staff-only. `metadata` carries extra structured detail and must
 * never contain credentials, OAuth codes/tokens, openid, cookies or password hashes.
 */
export const activityAuditEntrySchema = z.object({
  id: z.string().uuid(),
  event: z.string().min(1),
  actorUserId: z.string().uuid().nullable(),
  actorDisplayName: z.string().nullable(),
  targetId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: isoTimestamp,
})

export type ActivityAuditEntry = z.infer<typeof activityAuditEntrySchema>

export const activityAuditEntryListResponseSchema = z.object({
  items: z.array(activityAuditEntrySchema),
})

export type ActivityAuditEntryListResponse = z.infer<
  typeof activityAuditEntryListResponseSchema
>
