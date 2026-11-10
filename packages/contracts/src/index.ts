import { z } from 'zod'

import { activityRewardPlanSchema } from './rewards.js'
import { activityStatusSchema, authCommunitySchema, staffRoleSchema } from './identity.js'

/** Route identifiers shared by the API and every client that calls it. */
export const API_ROUTES = {
  health: '/healthz',
  authMethods: '/auth/methods',
  authCsrf: '/auth/csrf',
  authSession: '/auth/session',
  authLogin: '/auth/login',
  authLogout: '/auth/logout',
  authWechatStart: '/auth/wechat/start',
  authWechatProfile: '/auth/wechat/profile',
  authWechatProfileStart: '/auth/wechat/profile/start',
  /** Residents' same-origin JS-SDK configuration (no browser secrets). */
  wechatJsSdkSignature: '/wechat/js-sdk/signature',
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
  activityUnavailable: 'activity_unavailable',
  teamFull: 'team_full',
  inviteInvalid: 'invite_invalid',
  crmebUpstreamError: 'crmeb_upstream_error',
  crmebTimeout: 'crmeb_timeout',
  crmebContractMismatch: 'crmeb_contract_mismatch',
  crmebSyncInProgress: 'crmeb_sync_in_progress',
  rewardUnavailable: 'reward_unavailable',
  checkinDuplicate: 'checkin_duplicate',
  checkinNotVerified: 'checkin_not_verified',
  rewardAlreadyRedeemed: 'reward_already_redeemed',
  redemptionCodeInvalid: 'redemption_code_invalid',
  redemptionCodeExpired: 'redemption_code_expired',
  prizeStockExhausted: 'prize_stock_exhausted',
  budgetExceeded: 'budget_exceeded',
  /**
   * A published/paused activity may not have its reward plan changed. The prize
   * ledger is keyed by `(activity_id, prize_name)`, so renaming the prize would
   * open a fresh stock row and silently reset the activity-wide quantity and
   * budget accounting.
   */
  rewardPlanLocked: 'reward_plan_locked',
  /**
   * Phone (SMS one-time code) identity, Issue #93. This card ships the server
   * state machine only: no SMS provider is bundled, so a production deployment
   * without an injected sender fails closed with `not_configured` instead of
   * pretending that public phone login works.
   */
  phoneInvalid: 'phone_invalid',
  otpInvalid: 'otp_invalid',
  otpExpired: 'otp_expired',
  otpAttemptsExceeded: 'otp_attempts_exceeded',
  otpCooldown: 'otp_cooldown',
  otpRequestLimit: 'otp_request_limit',
  phoneAlreadyBound: 'phone_already_bound',
  phoneInUse: 'phone_in_use',
  smsDeliveryFailed: 'sms_delivery_failed',
  /**
   * Real "today's draw" prize pool (LL-LOT-001). `draw_pool_not_ready` blocks
   * enabling a pool without a real, in-stock, weighted prize; `draw_pool_not_configured`
   * means a prize cannot be added before the base rule was saved.
   */
  drawPoolNotReady: 'draw_pool_not_ready',
  drawPoolNotConfigured: 'draw_pool_not_configured',
  /**
   * Local catalogue (#109): an off-shelf product refuses *new* registrations.
   * Existing orders keep their frozen snapshot and are unaffected.
   */
  productOffShelf: 'product_off_shelf',
  /**
   * Local order (#109): an operator tried to verify an order that is already
   * `verified`. Rejecting is explicit on purpose — a silent success would read
   * like "成交了两次".
   */
  orderAlreadyVerified: 'order_already_verified',
  /**
   * Local order (#109): the idempotency key already produced an order with a
   * different product/quantity. A key identifies one intent, so the second
   * submission is a conflict, never an overwrite.
   */
  orderIdempotencyConflict: 'order_idempotency_conflict',
  /**
   * Ledger (LL-MVP-008, Issue #64). Every one of these is a *refusal*: the ledger
   * prefers an explicit "cannot do that" over a silently corrected number.
   */
  ledgerBatchLocked: 'ledger_batch_locked',
  ledgerEntryImmutable: 'ledger_entry_immutable',
  ledgerPaymentEvidenceRequired: 'ledger_payment_evidence_required',
  ledgerAttributionUnresolved: 'ledger_attribution_unresolved',
  ledgerSourceDuplicate: 'ledger_source_duplicate',
  /**
   * WeChat public-account admin config (#113). Every failure is explicit: an
   * unreadable/absent master key or an undecryptable row must never be treated
   * as a usable OAuth provider.
   */
  wechatConfigInvalid: 'wechat_config_invalid',
  wechatConfigNotVerified: 'wechat_config_not_verified',
  wechatConfigVerifyFailed: 'wechat_config_verify_failed',
  wechatConfigMasterKeyUnavailable: 'wechat_config_master_key_unavailable',
  wechatConfigDecryptFailed: 'wechat_config_decrypt_failed',
  wechatProfileIdentityMismatch: 'wechat_profile_identity_mismatch',
  wechatJsSdkUnavailable: 'wechat_js_sdk_unavailable',
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

/** The H5 supplies its *current* absolute URL; the server pins the origin. */
export const wechatJsSdkSignatureRequestSchema = z.strictObject({
  url: z.string().min(1).max(4096),
})

/** Exact safe JS-SDK config fields, without access token, ticket or secret. */
export const wechatJsSdkSignatureResponseSchema = z.strictObject({
  appId: z.string().min(1),
  timestamp: z.number().int().positive(),
  nonceStr: z.string().regex(/^[a-f0-9]{32}$/),
  signature: z.string().regex(/^[a-f0-9]{40}$/),
})
export type WechatJsSdkSignatureRequest = z.infer<typeof wechatJsSdkSignatureRequestSchema>
export type WechatJsSdkSignatureResponse = z.infer<typeof wechatJsSdkSignatureResponseSchema>

/** Structured error envelope. Clients must be able to distinguish real errors from demo states. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1).optional(),
  }),
})

export type ApiError = z.infer<typeof apiErrorSchema>

export const staffLoginRequestSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(1).max(128),
})

/** Tencent's location-picker returns GCJ-02. Keep that coordinate system explicit. */
export const communityLocationSchema = z.strictObject({
  address: z.string().trim().min(1).max(200),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
})
export type CommunityLocation = z.infer<typeof communityLocationSchema>

/** Residents can browse these public service-point records without login. */
export const PUBLIC_COMMUNITY_ROUTE = '/communities/public' as const
const optionalCoordinate = (min: number, max: number) =>
  z.preprocess(
    (value) => value === undefined || value === '' ? undefined : Number(value),
    z.number().finite().min(min).max(max).optional(),
  )
export const publicCommunityQuerySchema = z.object({
  q: z.string().trim().max(60).optional(),
  latitude: optionalCoordinate(-90, 90),
  longitude: optionalCoordinate(-180, 180),
}).superRefine((value, ctx) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)) {
    ctx.addIssue({ code: 'custom', message: '经纬度必须成对提供', path: ['latitude'] })
  }
})
export type PublicCommunityQuery = z.infer<typeof publicCommunityQuerySchema>
export const publicCommunitySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  address: z.string().nullable(),
  distanceMeters: z.number().int().nonnegative().nullable(),
  nearby: z.boolean(),
})
export const publicCommunityListSchema = z.object({
  items: z.array(publicCommunitySchema),
})
export type PublicCommunity = z.infer<typeof publicCommunitySchema>
export type PublicCommunityList = z.infer<typeof publicCommunityListSchema>

/** Admin-only Tencent map configuration; saved Key is never included in status responses. */
export const TENCENT_MAP_ADMIN_ROUTES = {
  config: '/admin/tencent-map/config',
  enabled: '/admin/tencent-map/config/enabled',
  pickerConfig: '/admin/map-picker-config',
} as const

export const tencentMapKeySchema = z.string().trim().regex(/^[A-Za-z0-9_-]{8,128}$/u)
export const saveTencentMapConfigRequestSchema = z.strictObject({
  key: tencentMapKeySchema,
  appName: z.string().trim().min(1).max(64),
})
export const setTencentMapEnabledRequestSchema = z.strictObject({
  enabled: z.boolean(),
})
export const tencentMapConfigStatusSchema = z.strictObject({
  configured: z.boolean(),
  enabled: z.boolean(),
  keyHint: z.string().nullable(),
  appName: z.string().nullable(),
  updatedAt: z.string().nullable(),
})
export type TencentMapConfigStatus = z.infer<typeof tencentMapConfigStatusSchema>
export const tencentMapPickerConfigSchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(false) }),
  z.strictObject({ available: z.literal(true), key: tencentMapKeySchema, appName: z.string().min(1) }),
])
export type TencentMapPickerConfig = z.infer<typeof tencentMapPickerConfigSchema>

export const createCommunityRequestSchema = z.strictObject({
  name: z.string().trim().min(2).max(60),
  location: communityLocationSchema.optional(),
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

/**
 * Resident-consented WeChat profile state. The response intentionally contains
 * no OpenID, access token, AppID, or provider credential.
 */
export const wechatProfileStatusSchema = z.union([
  z.object({
    available: z.literal(false),
    reason: z.enum(['not_configured', 'configuration_unavailable', 'identity_not_bound']),
  }),
  z.object({
    available: z.literal(true),
    authorized: z.literal(false),
  }),
  z.object({
    available: z.literal(true),
    authorized: z.literal(true),
    nickname: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    authorizedAt: isoTimestamp,
  }),
])

export type WechatProfileStatusResponse = z.infer<typeof wechatProfileStatusSchema>

export const wechatProfileStartResponseSchema = z.object({
  authorizationUrl: z.string().url(),
})

export type WechatProfileStartResponse = z.infer<typeof wechatProfileStartResponseSchema>

/* -------------------------------------------------------------------------- */
/* Resident login return target (#92)                                         */
/* -------------------------------------------------------------------------- */

/**
 * WeChat web authorization leaves the SPA entirely; the API then decides which
 * URL the resident lands on afterwards. That decision must never be driven by
 * unvalidated client input, otherwise the OAuth callback becomes an open
 * redirect. Both the API (authority) and the H5 client (early feedback before a
 * round trip) apply the same rules from here instead of keeping two copies.
 *
 * Validation is deliberately string-level and runtime-neutral (no `URL`, no
 * Node/DOM types): this package is imported by the browser bundle, the API and
 * plain Node tests. The API additionally resolves the accepted value with
 * `new URL()` before using it, which is where origin equality is double-checked.
 *
 * A valid target is:
 * - a relative absolute-path URL: exactly one leading `/`, never `//host`, so
 *   it can never name another origin;
 * - ASCII only and percent-encoded where needed. Backslashes, whitespace,
 *   control characters and `#` are rejected because URL parsers silently
 *   reinterpret them (`/\evil.test` parses as host `evil.test`);
 * - free of `.` / `..` segments, which browsers would collapse into a different
 *   path than the one that was allowlisted;
 * - inside the resident H5 allowlist below, so a resident login can never be
 *   bounced into the back office or an arbitrary page.
 */

/** App surfaces a resident login may return to. Keep in sync with `App.tsx`. */
export const RESIDENT_RETURN_TO_PREFIXES = [
  '/', // New resident activity home; exact root only (never '//').
  '/community',
  '/me',
  '/life',
  '/health',
  '/points',
  '/gd',
] as const

/** Upper bound: share links carry `activityId` (36) and an invite code (32). */
export const RETURN_TO_MAX_LENGTH = 512

/**
 * Printable ASCII path/query characters. Every other byte must be
 * percent-encoded, which keeps the value free of spaces, `\`, `#` and control
 * characters without relying on a URL parser.
 */
const SAFE_RETURN_TO_PATTERN = /^\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@%/?])*$/

const ENCODED_DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i

export type ReturnToRejection = 'invalid_shape' | 'not_allowed_path'

export type ReturnToValidation =
  | { ok: true; returnTo: string | null }
  | { ok: false; reason: ReturnToRejection }

/** Prefix match with a path boundary, so `/community-evil` is not accepted. */
export function isResidentReturnPath(pathname: string): boolean {
  return RESIDENT_RETURN_TO_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

function hasDotPathSegment(pathname: string): boolean {
  return pathname.split('/').some((segment) => {
    if (ENCODED_DOT_SEGMENT.test(segment)) return true
    try {
      return ENCODED_DOT_SEGMENT.test(decodeURIComponent(segment))
    } catch {
      // Malformed percent-encoding cannot be a valid target.
      return true
    }
  })
}

/**
 * Validate one return target. `null` / `''` / `undefined` mean "no target was
 * supplied" and resolve to `returnTo: null`, letting the caller keep its default
 * landing page.
 */
export function validateReturnTo(raw: unknown): ReturnToValidation {
  if (raw === undefined || raw === null || raw === '') return { ok: true, returnTo: null }
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_shape' }
  if (raw !== raw.trim() || raw.length > RETURN_TO_MAX_LENGTH) {
    return { ok: false, reason: 'invalid_shape' }
  }
  if (!SAFE_RETURN_TO_PATTERN.test(raw)) return { ok: false, reason: 'invalid_shape' }
  if (raw.startsWith('//')) return { ok: false, reason: 'invalid_shape' }

  const pathname = raw.split('?', 1)[0] ?? ''
  if (hasDotPathSegment(pathname)) return { ok: false, reason: 'invalid_shape' }
  if (!isResidentReturnPath(pathname)) return { ok: false, reason: 'not_allowed_path' }

  return { ok: true, returnTo: raw }
}

/* -------------------------------------------------------------------------- */
/* One-off login result markers (#92)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Markers the WeChat OAuth callback appends to the returned H5 URL. They are
 * read exactly once and then stripped, so they never become part of a re-issued
 * return target or of a shared link.
 */
export const LOGIN_RESULT_QUERY_PARAMS = ['auth', 'auth_error'] as const

export type LoginResultMarker = 'success' | 'error' | null

/**
 * Remove the one-off login markers from a `/path?query` route while keeping
 * every other parameter untouched, in the order it arrived: `activityId`,
 * `invite` and any campaign parameter must survive the cleanup byte-for-byte.
 */
export function stripLoginResultParams(route: string): string {
  const queryIndex = route.indexOf('?')
  if (queryIndex === -1) return route
  const pathname = route.slice(0, queryIndex)
  const kept = route
    .slice(queryIndex + 1)
    .split('&')
    .filter((segment) => {
      if (!segment) return false
      const key = segment.split('=', 1)[0] ?? ''
      return !(LOGIN_RESULT_QUERY_PARAMS as readonly string[]).includes(key)
    })
  return kept.length > 0 ? `${pathname}?${kept.join('&')}` : pathname
}

/**
 * Whether a one-off login marker may be presented, and as what.
 *
 * `?auth=success` is plain client-visible input: it records what the callback
 * *reported*, not that this browser holds a session. Rendering the success state
 * without a server-confirmed session is exactly the fake success a recipient of
 * the URL would see, so success requires `authenticated`. A failed authorization
 * leaves no session and stays presentable (the resident is offered a retry).
 * While the session is still loading, nothing is presented.
 */
export function presentLoginMarker(
  marker: LoginResultMarker,
  authenticated: boolean,
  loading: boolean,
): LoginResultMarker {
  if (loading || marker === null) return null
  if (marker === 'success') return authenticated ? 'success' : null
  return 'error'
}

/* -------------------------------------------------------------------------- */
/* Resident WeChat OAuth start query (#123)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Context the H5 may hand to `GET /auth/wechat/start`.
 *
 * `activityId` is *context*, never an authorization claim: the API loads that
 * activity row and derives its community itself. A client-supplied
 * `communityId` is deliberately not part of this contract — "the resident is in
 * this community" is an attribution claim that only server-side data can
 * support, so accepting it would let anyone mint an arbitrary community
 * residence by picking a UUID that happens to exist.
 */
export interface WechatStartRequest {
  /** Explicit public-activity entry context; `null` for ordinary entry points. */
  activityId?: string | null
  /** Already-validated same-origin resident return target, or `null`. */
  returnTo?: string | null
}

const ACTIVITY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Shape check only: an activity UUID that *looks* right says nothing about
 * whether the activity exists or is publicly visible. Both callers still treat
 * the value as untrusted input and let the API decide.
 */
export function isActivityId(value: unknown): value is string {
  return typeof value === 'string' && ACTIVITY_ID_PATTERN.test(value)
}

/**
 * Query string (leading `?`, or `''`) for `GET /auth/wechat/start`.
 *
 * Both inputs are re-validated here instead of trusted: `activityId` must be a
 * UUID shape and `returnTo` must survive the shared allowlist *unchanged*.
 * Invalid input throws, so a caller bug can never be shipped as a silently
 * dropped parameter — the login would otherwise look successful while the
 * resident never gets attributed.
 */
export function buildWechatStartQuery(request: WechatStartRequest): string {
  const parts: string[] = []

  const activityId = request.activityId ?? null
  if (activityId !== null) {
    if (typeof activityId !== 'string' || !ACTIVITY_ID_PATTERN.test(activityId)) {
      throw new RangeError('invalid activityId')
    }
    parts.push(`activityId=${encodeURIComponent(activityId)}`)
  }

  const returnTo = request.returnTo ?? null
  if (returnTo !== null) {
    const validation = validateReturnTo(returnTo)
    if (!validation.ok || validation.returnTo !== returnTo) {
      throw new RangeError('invalid returnTo')
    }
    parts.push(`returnTo=${encodeURIComponent(returnTo)}`)
  }

  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

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

/**
 * Lifecycle state of an activity. Only staff can change it, through explicit
 * transitions. The schema itself lives in `identity.ts` so domain modules can
 * import it without a circular dependency; it is re-exported from here.
 */
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
    /**
     * Prize fulfilment plan (LL-MVP-006). Optional *and* nullable on purpose:
     * rule snapshots frozen before #62 carry no `rewardPlan` key at all and must
     * keep parsing byte-identically, while a plan that was explicitly cleared is
     * stored as `null`. Consumers must normalise with `snapshot.rewardPlan ?? null`
     * and must never fall back to the mutable `activities` columns.
     */
    rewardPlan: activityRewardPlanSchema.nullable().optional(),
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

/** One violation of the check-in-window-inside-activity rule. */
export interface CheckinWindowIssue {
  message: string
  path: (string | number)[]
}

/**
 * Finds check-in-window violations; never throws.
 *
 * Exported standalone so the service layer can apply exactly this rule to the
 * merged (inherited-plan) key rules without re-running the write schema, and so
 * the read schema can stay lenient.
 *
 * Returns an array rather than throwing, on purpose. An earlier version threw a
 * raw `z.ZodError` when called without a refinement `ctx`, and zod 4's
 * `ZodError` does **not** satisfy `instanceof Error`. Hono's `#handleError`
 * guards with `instanceof Error`, so it refused to run the app's `onError` and
 * re-threw instead; under the real `@hono/node-server` entry point that surfaced
 * as a **500 with an empty body**, no `request.failed` log and no requestId.
 * A contract-legal request (omitting `rewardPlan`, which is `.optional()` and
 * documented as "inherit the stored plan") therefore got a non-standard failure.
 * Returning data keeps every caller on the normal `ActivityError` -> `fail()`
 * path, which is what actually maps to `400 invalidRequest`.
 */
export function findCheckinWindowIssues(value: ActivityKeyRules): CheckinWindowIssue[] {
  const plan = value.rewardPlan
  if (plan === undefined || plan === null) return [] // no plan, no window to bound
  const startsAt = Date.parse(value.startsAt)
  const endsAt = Date.parse(value.endsAt)
  const issues: CheckinWindowIssue[] = []
  if (Date.parse(plan.checkinWindow.opensAt) < startsAt) {
    issues.push({
      message: 'checkinWindow.opensAt must not be earlier than startsAt',
      path: ['rewardPlan', 'checkinWindow', 'opensAt'],
    })
  }
  if (Date.parse(plan.checkinWindow.closesAt) > endsAt) {
    issues.push({
      message: 'checkinWindow.closesAt must not be later than endsAt',
      path: ['rewardPlan', 'checkinWindow', 'closesAt'],
    })
  }
  return issues
}

/**
 * Zod refinement for the write schema: reports window violations as issues.
 *
 * Kept as a refinement (rather than a boolean check) so the issue path points at
 * the offending field and the API returns `400 invalidRequest` with a message
 * the operator can act on.
 */
export function assertCheckinWindowInsideActivity(
  value: ActivityKeyRules,
  ctx: Pick<z.RefinementCtx, 'addIssue'>,
): void {
  for (const issue of findCheckinWindowIssues(value)) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path })
  }
}

/**
 * The cross-check from `activityKeyRulesSchema` that MUST NOT live in that schema.
 *
 * A check-in window outside the activity window is not merely untidy: it lets a
 * plan authorise check-ins - and therefore claims and redemptions - before the
 * activity starts, i.e. hand out a prize for an event nobody has attended yet.
 * `lifecycleBlockReason` gates only draft/paused/ended, so "published but not
 * started yet" is not caught there. The guard is therefore mandatory on write.
 *
 * It is a separate schema rather than a `superRefine` on
 * `activityKeyRulesSchema` because that schema is *also* the parser for
 * already-stored data: every frozen `activity_rule_versions.snapshot_json` and
 * every `activity_reward_*` read path re-parses through it. Folding this rule
 * in would make any row written before the rule existed unreadable - the admin
 * detail, the rule-version list, the check-in state and the reward overview
 * would all throw, and an operator could not even repair the offending row
 * because the update path re-validates the stored plan. Rejecting bad NEW input
 * and refusing to read OLD rows are different jobs; only the former belongs
 * here.
 *
 * Use this for every value that is about to be written (create/update). Do not
 * use it to read stored rows.
 */
export const activityKeyRulesWriteSchema = activityKeyRulesSchema.superRefine((value, ctx) => {
  assertCheckinWindowInsideActivity(value, ctx)
})

export type ActivityKeyRulesWrite = z.infer<typeof activityKeyRulesWriteSchema>

export const createActivityRequestSchema = z.object({
  communityId: z.string().uuid(),
  title: z.string().trim().min(2).max(80),
  summary: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  // Write path: applies the check-in-window cross-check (see the comment on
  // `activityKeyRulesWriteSchema` for why it is not on the read schema).
  keyRules: activityKeyRulesWriteSchema,
})

export type CreateActivityRequest = z.infer<typeof createActivityRequestSchema>

export const updateActivityRequestSchema = z
  .object({
    expectedUpdatedAt: isoTimestamp,
    title: z.string().trim().min(2).max(80).optional(),
    summary: z.string().trim().max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    // Write path only: an edit must not be able to move the window out of bounds.
    keyRules: activityKeyRulesWriteSchema.optional(),
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
  /**
   * The reward plan stored on the activity, exposed so an admin form can read
   * back what was configured before re-submitting an edit. Without this a client
   * has no way to round-trip the plan (a draft has no rule version yet), and
   * every edit would silently drop it.
   */
  rewardPlan: activityRewardPlanSchema.nullable(),
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

/* -------------------------------------------------------------------------- */
/* Resident directory (#125 LL-MVP-013)                                        */
/* -------------------------------------------------------------------------- */

/** Queries are server-scoped to one authorized community, never global. */
export const residentDirectoryQuerySchema = z.strictObject({
  communityId: z.string().uuid(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().min(1).max(80).optional(),
})

export const residentDirectoryEntrySchema = z.strictObject({
  id: z.string().uuid(),
  /** Display-only precedence: consented WeChat > local name > 微信用户. */
  displayName: z.string().min(1),
  localDisplayName: z.string().nullable(),
  wechatNickname: z.string().nullable(),
  wechatAvatarUrl: z.string().nullable(),
  profileAuthorizedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  joinedAt: z.string().datetime(),
})
export const residentDirectoryResponseSchema = z.strictObject({
  items: z.array(residentDirectoryEntrySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
})
export type ResidentDirectoryEntry = z.infer<typeof residentDirectoryEntrySchema>
export type ResidentDirectoryResponse = z.infer<typeof residentDirectoryResponseSchema>

/* -------------------------------------------------------------------------- */
/* CRM domain (#61 LL-MVP-005)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Route identifiers for the community CRM. Grid-worker (mobile H5) endpoints live
 * under `/crm/*`; back-office review endpoints live under `/admin/crm/*`. Every
 * client must build URLs from these constants.
 *
 * GET + POST share the list paths (`leadList`, `orderList`) for query and creation.
 * Creation is guarded by the unique lead/order constraints rather than an
 * optimistic-concurrency token; every update, status transition, transfer, review
 * and follow-up write carries `expectedUpdatedAt`.
 */
export const CRM_ROUTES = {
  // Grid worker / H5
  leadList: '/crm/leads',
  leadDetail: '/crm/leads/:leadId',
  leadStatus: '/crm/leads/:leadId/status',
  leadTransfer: '/crm/leads/:leadId/transfer',
  leadFollowUps: '/crm/leads/:leadId/follow-ups',
  leadAudit: '/crm/leads/:leadId/audit',
  orderList: '/crm/orders',
  orderDetail: '/crm/orders/:orderId',
  orderStatus: '/crm/orders/:orderId/status',
  orderAudit: '/crm/orders/:orderId/audit',
  // Back office
  residentList: '/crm/residents',
  adminLeadList: '/admin/crm/leads',
  adminLeadDetail: '/admin/crm/leads/:leadId',
  adminLeadAudit: '/admin/crm/leads/:leadId/audit',
  adminOrderList: '/admin/crm/orders',
  adminOrderDetail: '/admin/crm/orders/:orderId',
  adminOrderAudit: '/admin/crm/orders/:orderId/audit',
  adminOrderReview: '/admin/crm/orders/:orderId/review',
  adminFilterOptions: '/admin/crm/filter-options',
} as const

/**
 * Lead provenance. The three lead origins are deliberately separate columns
 * (`sourceActivityId` / `promotionStaffId`) instead of one free-text field so
 * attribution stays queryable and auditable.
 */
export const crmLeadSourceTypeSchema = z.enum([
  'activity',
  'grid_promotion',
  'walk_in',
  'resident_referral',
])
export type CrmLeadSourceType = z.infer<typeof crmLeadSourceTypeSchema>

/**
 * `converted` is system-only: it may be set only when a service order of this
 * lead reaches `confirmed` through manual back-office verification. Humans can
 * move a lead to `contacting` / `invalid` only (see `CRM_LEAD_STATUS_TRANSITIONS`).
 */
export const crmLeadStatusSchema = z.enum(['new', 'contacting', 'converted', 'invalid'])
export type CrmLeadStatus = z.infer<typeof crmLeadStatusSchema>

export const crmLeadManualStatusSchema = z.enum(['contacting', 'invalid'])
export type CrmLeadManualStatus = z.infer<typeof crmLeadManualStatusSchema>

export const crmBusinessTypeSchema = z.enum(['gd_mobile', 'gd_tv'])
export type CrmBusinessType = z.infer<typeof crmBusinessTypeSchema>

/**
 * Service-order lifecycle. `confirmed` means "有效成交 verified by a human
 * operator", never "开通/激活". There is intentionally no activation status or
 * activation timestamp in this contract.
 */
export const crmServiceOrderStatusSchema = z.enum([
  'submitted',
  'processing',
  'pending_verification',
  'confirmed',
  'failed',
  'cancelled',
])
export type CrmServiceOrderStatus = z.infer<typeof crmServiceOrderStatusSchema>

/** Grid workers may submit these targets; only an operator review may `confirm`. */
export const crmOrderTransitionStatusSchema = z.enum([
  'processing',
  'pending_verification',
  'failed',
  'cancelled',
])
export type CrmOrderTransitionStatus = z.infer<typeof crmOrderTransitionStatusSchema>

export const crmOrderReviewDecisionSchema = z.enum(['confirm', 'reject'])
export type CrmOrderReviewDecision = z.infer<typeof crmOrderReviewDecisionSchema>

/**
 * The only source of a `confirmed` order. There is no carrier activation API, so
 * the API must always write this literal when an operator confirms after manual
 * verification (phone call / carrier portal screenshot reference).
 */
export const CRM_ACTIVATION_SOURCE = 'manual_verification' as const
export const crmActivationSourceSchema = z.literal(CRM_ACTIVATION_SOURCE)
export type CrmActivationSource = z.infer<typeof crmActivationSourceSchema>

/**
 * Frozen state machines. The API enforces these server-side; clients may use the
 * tables for UI affordances but must never be the authority.
 */
export const CRM_LEAD_STATUS_TRANSITIONS: Record<CrmLeadStatus, readonly CrmLeadStatus[]> = {
  new: ['contacting', 'invalid'],
  contacting: ['invalid', 'converted'],
  invalid: ['contacting'],
  converted: [],
}

export const CRM_ORDER_STATUS_TRANSITIONS: Record<
  CrmServiceOrderStatus,
  readonly CrmServiceOrderStatus[]
> = {
  submitted: ['processing', 'cancelled'],
  processing: ['pending_verification', 'failed', 'cancelled'],
  pending_verification: ['confirmed', 'failed', 'cancelled'],
  confirmed: [],
  failed: [],
  cancelled: [],
}

/** Optional free-text event names; clients should display unknown events verbatim. */
export const crmLeadEventTypeSchema = z.enum([
  'lead.created',
  'lead.status_changed',
  'lead.transferred',
  'lead.follow_up_added',
])
export type CrmLeadEventType = z.infer<typeof crmLeadEventTypeSchema>

export const crmOrderEventTypeSchema = z.enum([
  'order.created',
  'order.status_changed',
  'order.reviewed',
])
export type CrmOrderEventType = z.infer<typeof crmOrderEventTypeSchema>

/** Minimum-necessary contact phone. Full numbers are only returned in detail payloads. */
export const crmContactPhoneSchema = z
  .string()
  .trim()
  .regex(/^[0-9+\-() ]{5,20}$/, 'must be a contact phone number')

export const crmStaffRefSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().nullable(),
})
export type CrmStaffRef = z.infer<typeof crmStaffRefSchema>

export const crmActivityRefSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
})
export type CrmActivityRef = z.infer<typeof crmActivityRefSchema>

export const crmUserRefSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().nullable(),
})
export type CrmUserRef = z.infer<typeof crmUserRefSchema>

/* ---------------------------------- Leads --------------------------------- */

export const crmLeadSummarySchema = z.object({
  id: z.string().uuid(),
  community: authCommunitySchema,
  ownerStaff: crmStaffRefSchema,
  contactName: z.string().min(1),
  /** List payloads never expose the full phone; open the detail to call the resident. */
  contactPhoneMasked: z.string().min(1),
  sourceType: crmLeadSourceTypeSchema,
  sourceActivity: crmActivityRefSchema.nullable(),
  promotionStaff: crmStaffRefSchema.nullable(),
  status: crmLeadStatusSchema,
  followUpCount: z.number().int().nonnegative(),
  nextContactAt: isoTimestamp.nullable(),
  lastContactedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
})
export type CrmLeadSummary = z.infer<typeof crmLeadSummarySchema>

export const crmLeadDetailSchema = crmLeadSummarySchema.extend({
  contactPhone: crmContactPhoneSchema,
  residentUserId: z.string().uuid().nullable(),
  createdByStaff: crmStaffRefSchema,
})
export type CrmLeadDetail = z.infer<typeof crmLeadDetailSchema>

/**
 * Lead creation. Cross-field source rules are enforced here and again server-side:
 * `activity` requires `sourceActivityId`; only `grid_promotion` may carry
 * `promotionStaffId` (the API defaults it to the current owner when omitted).
 */
export const createCrmLeadRequestSchema = z
  .object({
    communityId: z.string().uuid(),
    /** Admin/operator only; grid workers always own what they create. */
    ownerStaffId: z.string().uuid().optional(),
    contactName: z.string().trim().min(1).max(40),
    contactPhone: crmContactPhoneSchema,
    sourceType: crmLeadSourceTypeSchema,
    sourceActivityId: z.string().uuid().optional(),
    promotionStaffId: z.string().uuid().optional(),
    residentUserId: z.string().uuid().optional(),
    nextContactAt: isoTimestamp.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sourceType === 'activity' && !value.sourceActivityId) {
      ctx.addIssue({
        code: 'custom',
        message: 'activity leads require sourceActivityId',
        path: ['sourceActivityId'],
      })
    }
    if (value.sourceType !== 'activity' && value.sourceActivityId) {
      ctx.addIssue({
        code: 'custom',
        message: 'sourceActivityId is only allowed for activity leads',
        path: ['sourceActivityId'],
      })
    }
    if (value.sourceType !== 'grid_promotion' && value.promotionStaffId) {
      ctx.addIssue({
        code: 'custom',
        message: 'promotionStaffId is only allowed for grid_promotion leads',
        path: ['promotionStaffId'],
      })
    }
  })
export type CreateCrmLeadRequest = z.infer<typeof createCrmLeadRequestSchema>

export const updateCrmLeadStatusRequestSchema = z.object({
  expectedUpdatedAt: isoTimestamp,
  status: crmLeadManualStatusSchema,
  note: z.string().trim().max(500).optional(),
})
export type UpdateCrmLeadStatusRequest = z.infer<typeof updateCrmLeadStatusRequestSchema>

/**
 * Transfer keeps history: the old owner stays on the previous event and on every
 * service order it already created. Only `ownerStaffId` on the lead changes.
 */
export const transferCrmLeadRequestSchema = z.object({
  expectedUpdatedAt: isoTimestamp,
  toOwnerStaffId: z.string().uuid(),
  reason: z.string().trim().min(2).max(200),
})
export type TransferCrmLeadRequest = z.infer<typeof transferCrmLeadRequestSchema>

export const crmFollowUpSchema = z.object({
  id: z.string().uuid(),
  leadId: z.string().uuid(),
  staff: crmStaffRefSchema,
  content: z.string().min(1),
  nextContactAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
})
export type CrmFollowUp = z.infer<typeof crmFollowUpSchema>

/** Follow-ups also bump the lead's `updatedAt`, so the concurrency token applies. */
export const createCrmFollowUpRequestSchema = z.object({
  expectedUpdatedAt: isoTimestamp,
  content: z.string().trim().min(1).max(1000),
  /** Omit to keep the current reminder; send null to clear it. */
  nextContactAt: isoTimestamp.nullable().optional(),
})
export type CreateCrmFollowUpRequest = z.infer<typeof createCrmFollowUpRequestSchema>

export const crmFollowUpListResponseSchema = z.object({
  items: z.array(crmFollowUpSchema),
})
export type CrmFollowUpListResponse = z.infer<typeof crmFollowUpListResponseSchema>

/**
 * Creating a follow-up returns the new record plus the refreshed lead detail so
 * the client can render the new `updatedAt` concurrency token without a refetch.
 */
export const createCrmFollowUpResponseSchema = z.object({
  followUp: crmFollowUpSchema,
  lead: crmLeadDetailSchema,
})
export type CreateCrmFollowUpResponse = z.infer<typeof createCrmFollowUpResponseSchema>

export const crmLeadEventSchema = z.object({
  id: z.string().uuid(),
  leadId: z.string().uuid(),
  event: crmLeadEventTypeSchema,
  fromStatus: crmLeadStatusSchema.nullable(),
  toStatus: crmLeadStatusSchema.nullable(),
  fromOwnerStaff: crmStaffRefSchema.nullable(),
  toOwnerStaff: crmStaffRefSchema.nullable(),
  actor: crmUserRefSchema.nullable(),
  note: z.string().nullable(),
  createdAt: isoTimestamp,
})
export type CrmLeadEvent = z.infer<typeof crmLeadEventSchema>

export const crmLeadEventListResponseSchema = z.object({
  items: z.array(crmLeadEventSchema),
})
export type CrmLeadEventListResponse = z.infer<typeof crmLeadEventListResponseSchema>

/**
 * Server-side pagination and filtering. The API must always scope results to the
 * caller's communities; `communityId`/`staffId` only narrow that scope.
 */
export const crmLeadListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  communityId: z.string().uuid().optional(),
  staffId: z.string().uuid().optional(),
  status: crmLeadStatusSchema.optional(),
  sourceType: crmLeadSourceTypeSchema.optional(),
  keyword: z.string().trim().min(1).max(80).optional(),
})
export type CrmLeadListQuery = z.infer<typeof crmLeadListQuerySchema>

export const crmLeadListResponseSchema = z.object({
  items: z.array(crmLeadSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
})
export type CrmLeadListResponse = z.infer<typeof crmLeadListResponseSchema>

/* ------------------------------ Service orders ----------------------------- */

export const crmOrderSummarySchema = z.object({
  id: z.string().uuid(),
  community: authCommunitySchema,
  leadId: z.string().uuid(),
  orderNo: z.string().min(1),
  businessType: crmBusinessTypeSchema,
  status: crmServiceOrderStatusSchema,
  customerName: z.string().min(1),
  contactPhoneMasked: z.string().min(1),
  /** Frozen at creation: later lead transfers must not re-attribute this order. */
  attributedStaff: crmStaffRefSchema,
  sourceActivity: crmActivityRefSchema.nullable(),
  promotionStaff: crmStaffRefSchema.nullable(),
  /** Reviewer shown in the back-office list; null until a manual confirmation. */
  confirmedBy: crmUserRefSchema.nullable(),
  confirmedAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
})
export type CrmOrderSummary = z.infer<typeof crmOrderSummarySchema>

export const crmOrderEventSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  event: crmOrderEventTypeSchema,
  fromStatus: crmServiceOrderStatusSchema.nullable(),
  toStatus: crmServiceOrderStatusSchema.nullable(),
  actor: crmUserRefSchema.nullable(),
  note: z.string().nullable(),
  createdAt: isoTimestamp,
})
export type CrmOrderEvent = z.infer<typeof crmOrderEventSchema>

/**
 * Order detail. `confirmation` exists only after an operator review; a `confirmed`
 * order must carry `activationSource = manual_verification`. The contract refuses
 * any other combination so "已提交受理" can never be rendered as "已开通".
 */
export const crmOrderDetailSchema = crmOrderSummarySchema
  .extend({
    contactPhone: crmContactPhoneSchema,
    evidenceRef: z.string().nullable(),
    notes: z.string().nullable(),
    createdByStaff: crmStaffRefSchema,
    confirmation: z
      .object({
        confirmedBy: crmUserRefSchema.nullable(),
        confirmedAt: isoTimestamp,
        note: z.string().nullable(),
      })
      .nullable(),
    failureReason: z.string().nullable(),
    activationSource: crmActivationSourceSchema.nullable(),
    events: z.array(crmOrderEventSchema),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'confirmed') {
      if (value.activationSource !== CRM_ACTIVATION_SOURCE) {
        ctx.addIssue({
          code: 'custom',
          message: 'confirmed orders require activationSource=manual_verification',
          path: ['activationSource'],
        })
      }
      if (!value.confirmation) {
        ctx.addIssue({
          code: 'custom',
          message: 'confirmed orders require confirmation details',
          path: ['confirmation'],
        })
      }
    } else if (value.activationSource !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'activationSource is only allowed on confirmed orders',
        path: ['activationSource'],
      })
    }
  })
export type CrmOrderDetail = z.infer<typeof crmOrderDetailSchema>

/**
 * Create an acceptance order for an existing lead. `orderNo` is the carrier's
 * acceptance number, unique per community. Customer name/phone default to the
 * lead snapshot when omitted. `evidenceRef` is a redacted reference (e.g.
 * "工单截图 2026-11-04 #3"), never a full ID card or carrier password.
 */
export const createCrmServiceOrderRequestSchema = z.object({
  leadId: z.string().uuid(),
  orderNo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{4,64}$/, 'orderNo must be 4-64 letters, digits, _ or -'),
  businessType: crmBusinessTypeSchema,
  customerName: z.string().trim().min(1).max(40).optional(),
  contactPhone: crmContactPhoneSchema.optional(),
  evidenceRef: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(500).optional(),
})
export type CreateCrmServiceOrderRequest = z.infer<typeof createCrmServiceOrderRequestSchema>

export const updateCrmOrderStatusRequestSchema = z
  .object({
    expectedUpdatedAt: isoTimestamp,
    status: crmOrderTransitionStatusSchema,
    note: z.string().trim().max(500).optional(),
    failureReason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'failed' && !value.failureReason) {
      ctx.addIssue({
        code: 'custom',
        message: 'failureReason is required when marking an order failed',
        path: ['failureReason'],
      })
    }
  })
export type UpdateCrmOrderStatusRequest = z.infer<typeof updateCrmOrderStatusRequestSchema>

/**
 * Operator review. `confirm` is the only path to `confirmed`; it always sets
 * activationSource=manual_verification. `reject` moves the order to `failed` and
 * stores the note as `failureReason`. A note is mandatory for both decisions.
 */
export const crmOrderReviewRequestSchema = z.object({
  expectedUpdatedAt: isoTimestamp,
  decision: crmOrderReviewDecisionSchema,
  note: z.string().trim().min(2).max(500),
})
export type CrmOrderReviewRequest = z.infer<typeof crmOrderReviewRequestSchema>

export const crmOrderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  communityId: z.string().uuid().optional(),
  staffId: z.string().uuid().optional(),
  businessType: crmBusinessTypeSchema.optional(),
  status: crmServiceOrderStatusSchema.optional(),
  keyword: z.string().trim().min(1).max(80).optional(),
})
export type CrmOrderListQuery = z.infer<typeof crmOrderListQuerySchema>

export const crmOrderListResponseSchema = z.object({
  items: z.array(crmOrderSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
})
export type CrmOrderListResponse = z.infer<typeof crmOrderListResponseSchema>

export const crmOrderEventListResponseSchema = z.object({
  items: z.array(crmOrderEventSchema),
})
export type CrmOrderEventListResponse = z.infer<typeof crmOrderEventListResponseSchema>

/* -------------------------------- Back office ------------------------------ */

export const adminCrmLeadListResponseSchema = crmLeadListResponseSchema
export type AdminCrmLeadListResponse = CrmLeadListResponse

export const adminCrmOrderListResponseSchema = crmOrderListResponseSchema
export type AdminCrmOrderListResponse = CrmOrderListResponse

export const crmStaffOptionSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().nullable(),
  role: staffRoleSchema,
  communities: z.array(authCommunitySchema),
})
export type CrmStaffOption = z.infer<typeof crmStaffOptionSchema>

/** Filter options are scoped server-side to the caller's communities. */
export const adminCrmFilterOptionsResponseSchema = z.object({
  communities: z.array(authCommunitySchema),
  staff: z.array(crmStaffOptionSchema),
  leadStatuses: z.array(crmLeadStatusSchema),
  leadSourceTypes: z.array(crmLeadSourceTypeSchema),
  businessTypes: z.array(crmBusinessTypeSchema),
  orderStatuses: z.array(crmServiceOrderStatusSchema),
})
export type AdminCrmFilterOptionsResponse = z.infer<
  typeof adminCrmFilterOptionsResponseSchema
>

/* -------------------------------------------------------------------------- */
/* Local product catalogue & resident orders (#109 LL-MVP-010)                 */
/* -------------------------------------------------------------------------- */

/**
 * Route identifiers for the *local* catalogue and the *local* resident order.
 *
 * This is a deliberately separate domain from the CRMEB mirror (`CRMEB_ROUTES`)
 * and from the 广电 carrier acceptance orders (`CRM_ROUTES.orderList`). A local
 * product is a real row in this system, not a mirrored e-commerce item, and a
 * local order is a resident's registration of intent, not a paid purchase.
 *
 * GET and POST share the list paths (`products`, `myOrders`, `staffOrders`), the
 * same convention the CRM domain uses for query + creation.
 */
export const LOCAL_CATALOG_ROUTES = {
  /** Public, session-free read of the on-shelf catalogue (H5 惠生活). */
  products: '/catalog/products',
  productDetail: '/catalog/products/:productId',
  /** Back office: admin/operator only. `grid_worker` is rejected. */
  adminProducts: '/admin/catalog/products',
  adminProductDetail: '/admin/catalog/products/:productId',
  adminProductShelf: '/admin/catalog/products/:productId/shelf',
} as const

export const LOCAL_ORDER_ROUTES = {
  /** Resident: session identity only; the body never names the resident. */
  myOrders: '/local-orders',
  myOrderDetail: '/local-orders/:localOrderId',
  /**
   * Staff surface (all three roles, community-scoped). It exists separately from
   * `/admin/*` because `/admin/*` rejects grid workers by convention, while the
   * grid worker must be able to process orders for their assigned communities.
   */
  staffOrders: '/staff/local-orders',
  staffOrderDetail: '/staff/local-orders/:localOrderId',
  staffOrderStatus: '/staff/local-orders/:localOrderId/status',
  /** Back office: admin/operator only. */
  adminOrders: '/admin/local-orders',
  adminOrderDetail: '/admin/local-orders/:localOrderId',
  adminOrderStatus: '/admin/local-orders/:localOrderId/status',
  adminOrderVerify: '/admin/local-orders/:localOrderId/verify',
  adminOrderEvents: '/admin/local-orders/:localOrderId/events',
} as const

/**
 * Stock state of a local product. `off_shelf` refuses *new* registrations; the
 * snapshot already frozen on an existing order is never rewritten.
 */
export const localProductStatusSchema = z.enum(['on_shelf', 'off_shelf'])
export type LocalProductStatus = z.infer<typeof localProductStatusSchema>

/** Product lifecycle changes are one endpoint, so both directions are idempotent. */
export const localProductShelfRequestSchema = z.strictObject({
  expectedUpdatedAt: isoTimestamp,
  status: localProductStatusSchema,
})
export type LocalProductShelfRequest = z.infer<typeof localProductShelfRequestSchema>

const localProductImageUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^https?:\/\//, 'must be an http(s) URL')

const localProductCategorySchema = z.string().trim().min(1).max(40)

export const localProductSummarySchema = z.object({
  id: z.string().uuid(),
  community: authCommunitySchema,
  name: z.string().min(1).max(60),
  summary: z.string().nullable(),
  category: z.string().nullable(),
  /** Integer cents. Never a float, never a client-supplied value. */
  priceCents: z.number().int().nonnegative(),
  imageUrl: z.string().nullable(),
  status: localProductStatusSchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
})
export type LocalProductSummary = z.infer<typeof localProductSummarySchema>

/** `description` is plain text shown as text; the H5 never injects raw HTML. */
export const localProductDetailSchema = localProductSummarySchema.extend({
  description: z.string().nullable(),
})
export type LocalProductDetail = z.infer<typeof localProductDetailSchema>

export const localProductListResponseSchema = z.object({
  items: z.array(localProductSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
})
export type LocalProductListResponse = z.infer<typeof localProductListResponseSchema>

export const localProductListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  communityId: z.string().uuid().optional(),
  status: localProductStatusSchema.optional(),
  category: z.string().trim().min(1).max(40).optional(),
  keyword: z.string().trim().min(1).max(80).optional(),
})
export type LocalProductListQuery = z.infer<typeof localProductListQuerySchema>

/**
 * Create a local product. `priceCents` is the only price in the system: the
 * server stores it as an integer number of cents and copies it into every order
 * snapshot at registration time.
 */
export const createLocalProductRequestSchema = z.strictObject({
  communityId: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  summary: z.string().trim().max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  category: localProductCategorySchema.optional(),
  priceCents: z.number().int().min(0).max(10_000_000),
  imageUrl: localProductImageUrlSchema.optional(),
})
export type CreateLocalProductRequest = z.infer<typeof createLocalProductRequestSchema>

/**
 * Edit a local product. Every field is optional, but at least one must be sent.
 * Nullable text fields accept `null` to clear them. `expectedUpdatedAt` is the
 * shared optimistic-concurrency token; a stale value is a 409, never a silent
 * overwrite of a concurrent edit.
 */
export const updateLocalProductRequestSchema = z
  .strictObject({
    expectedUpdatedAt: isoTimestamp,
    name: z.string().trim().min(1).max(60).optional(),
    summary: z.string().trim().max(120).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    category: localProductCategorySchema.nullable().optional(),
    priceCents: z.number().int().min(0).max(10_000_000).optional(),
    imageUrl: localProductImageUrlSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const { expectedUpdatedAt: _token, ...changes } = value
    if (Object.keys(changes).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'at least one product field must be changed',
        path: ['name'],
      })
    }
  })
export type UpdateLocalProductRequest = z.infer<typeof updateLocalProductRequestSchema>

/* ------------------------------- Local orders ------------------------------ */

/**
 * The resident-facing lifecycle of a local order.
 *
 * `registered`   resident registered intent (no payment happened)
 * `processing`   a staff member is handling it
 * `pending_review` waiting for the operations manual verification
 * `verified`     operations manually verified the *fact* — NOT paid, NOT activated
 * `cancelled`    withdrawn
 * `rejected`     refused, with a reason
 *
 * The names deliberately differ from the carrier order names (`confirmed` means a
 * verified carrier deal) so neither domain can leak into the other.
 */
export const localOrderStatusSchema = z.enum([
  'registered',
  'processing',
  'pending_review',
  'verified',
  'cancelled',
  'rejected',
])
export type LocalOrderStatus = z.infer<typeof localOrderStatusSchema>

/**
 * Frozen state machine. The server is the authority; clients may only use this
 * table for affordances. `verified` is reachable *exclusively* through the
 * operations verification endpoint, which is why it is absent from
 * `localOrderTransitionStatusSchema`.
 */
export const LOCAL_ORDER_STATUS_TRANSITIONS: Record<
  LocalOrderStatus,
  readonly LocalOrderStatus[]
> = {
  registered: ['processing', 'cancelled', 'rejected'],
  processing: ['pending_review', 'cancelled', 'rejected'],
  pending_review: ['verified', 'rejected'],
  verified: [],
  cancelled: [],
  rejected: [],
}

/** Statuses a staff member may set directly; `verified` is operator-review only. */
export const localOrderTransitionStatusSchema = z.enum([
  'processing',
  'pending_review',
  'cancelled',
  'rejected',
])
export type LocalOrderTransitionStatus = z.infer<typeof localOrderTransitionStatusSchema>

/** Who recorded the order: the resident, or a staff member acting for them. */
export const localOrderRecordSourceSchema = z.enum(['resident', 'staff_on_behalf'])
export type LocalOrderRecordSource = z.infer<typeof localOrderRecordSourceSchema>

/** Stable event source for downstream consumers (#64): always this pair. */
export const LOCAL_ORDER_EVENT_SOURCE_TYPE = 'local_order' as const
export const localOrderEventSourceTypeSchema = z.literal(LOCAL_ORDER_EVENT_SOURCE_TYPE)

export const localOrderEventTypeSchema = z.enum([
  'order.registered',
  'order.created_on_behalf',
  'order.status_changed',
  'order.verified',
  'order.rejected',
])
export type LocalOrderEventType = z.infer<typeof localOrderEventTypeSchema>

/**
 * Frozen order snapshot. The client never supplies any of these values: the API
 * copies the product name and unit price at registration time and computes the
 * total itself, so a later price edit cannot rewrite history.
 */
export const localOrderSnapshotSchema = z
  .object({
    productId: z.string().uuid(),
    productName: z.string().min(1),
    unitPriceCents: z.number().int().nonnegative(),
    quantity: z.number().int().min(1).max(99),
    totalCents: z.number().int().nonnegative(),
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.totalCents !== snapshot.unitPriceCents * snapshot.quantity) {
      ctx.addIssue({
        code: 'custom',
        message: 'totalCents must equal unitPriceCents * quantity',
        path: ['totalCents'],
      })
    }
  })
export type LocalOrderSnapshot = z.infer<typeof localOrderSnapshotSchema>

export const localOrderSummarySchema = z.object({
  id: z.string().uuid(),
  community: authCommunitySchema,
  resident: crmUserRefSchema,
  snapshot: localOrderSnapshotSchema,
  status: localOrderStatusSchema,
  recordSource: localOrderRecordSourceSchema,
  /** The staff member who recorded the order; null for a resident self-service order. */
  createdByStaff: crmStaffRefSchema.nullable(),
  /** Optional grid-worker attribution / activity source frozen at registration. */
  attributedStaff: crmStaffRefSchema.nullable(),
  sourceActivity: crmActivityRefSchema.nullable(),
  note: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
})
export type LocalOrderSummary = z.infer<typeof localOrderSummarySchema>

export const localOrderEventSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  event: localOrderEventTypeSchema,
  fromStatus: localOrderStatusSchema.nullable(),
  toStatus: localOrderStatusSchema.nullable(),
  /** Server-resolved actor; null only if the account was removed. */
  actor: crmUserRefSchema.nullable(),
  actorStaff: crmStaffRefSchema.nullable(),
  note: z.string().nullable(),
  /** Stable consumption contract for #64: sourceType + sourceId. */
  sourceType: localOrderEventSourceTypeSchema,
  sourceId: z.string().uuid(),
  createdAt: isoTimestamp,
})
export type LocalOrderEvent = z.infer<typeof localOrderEventSchema>

/**
 * Order detail. `verification` exists only after an operations review, and the
 * contract has no payment/activation field at all: `verified` is a manual fact
 * check by a human operator, never "已付款" or "已开通".
 */
export const localOrderDetailSchema = localOrderSummarySchema
  .extend({
    verification: z
      .object({
        verifiedBy: crmUserRefSchema.nullable(),
        verifiedAt: isoTimestamp,
        note: z.string().min(2).max(500),
      })
      .nullable(),
    /**
     * Note of the most recent *status change* (derived from the append-only
     * timeline, not a mutable column). This is where a rejection reason stays
     * readable without inventing a second writable field.
     */
    statusNote: z.string().nullable(),
    events: z.array(localOrderEventSchema),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'verified' && !value.verification) {
      ctx.addIssue({
        code: 'custom',
        message: 'verified orders require verification details',
        path: ['verification'],
      })
    }
    if (value.status !== 'verified' && value.verification !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'verification is only allowed on verified orders',
        path: ['verification'],
      })
    }
  })
export type LocalOrderDetail = z.infer<typeof localOrderDetailSchema>

/**
 * Resident registration. Strict on purpose: the resident comes from the session,
 * the price/community/currency come from the server product row. A client-sent
 * `priceCents`, `totalCents`, `communityId` or `residentUserId` fails parsing
 * instead of being silently ignored.
 */
export const createLocalOrderRequestSchema = z.strictObject({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99),
  note: z.string().trim().max(200).optional(),
  /** Optional activity attribution; the activity must belong to the product's community. */
  sourceActivityId: z.string().uuid().optional(),
  /** Client-generated UUID; a replay returns the same order instead of a second one. */
  idempotencyKey: z.string().uuid(),
})
export type CreateLocalOrderRequest = z.infer<typeof createLocalOrderRequestSchema>

/**
 * Staff recording on behalf of an existing resident account. The target resident
 * must belong to the product's community and the acting staff must be assigned
 * to that community; the acting staff id and the delegation source are recorded
 * server-side, never taken from the body.
 */
export const createLocalOrderOnBehalfRequestSchema = createLocalOrderRequestSchema.extend({
  residentUserId: z.string().uuid(),
})
export type CreateLocalOrderOnBehalfRequest = z.infer<
  typeof createLocalOrderOnBehalfRequestSchema
>

export const localOrderCreateResponseSchema = z.object({
  /** `false` means the idempotency key was replayed and this is the existing order. */
  created: z.boolean(),
  order: localOrderDetailSchema,
})
export type LocalOrderCreateResponse = z.infer<typeof localOrderCreateResponseSchema>

export const updateLocalOrderStatusRequestSchema = z
  .strictObject({
    expectedUpdatedAt: isoTimestamp,
    status: localOrderTransitionStatusSchema,
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'rejected' && !value.note) {
      ctx.addIssue({
        code: 'custom',
        message: 'note is required when rejecting an order',
        path: ['note'],
      })
    }
  })
export type UpdateLocalOrderStatusRequest = z.infer<
  typeof updateLocalOrderStatusRequestSchema
>

/**
 * Operations verification. `verify` is the only path to `verified` and always
 * records the reviewer and a note; `reject` moves the order to `rejected`.
 * Re-verifying an already verified order is an explicit 409
 * `order_already_verified`, never a silent second success.
 */
export const localOrderVerifyRequestSchema = z.strictObject({
  expectedUpdatedAt: isoTimestamp,
  decision: z.enum(['verify', 'reject']),
  note: z.string().trim().min(2).max(500),
})
export type LocalOrderVerifyRequest = z.infer<typeof localOrderVerifyRequestSchema>

export const localOrderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  communityId: z.string().uuid().optional(),
  status: localOrderStatusSchema.optional(),
  productId: z.string().uuid().optional(),
  /** Staff/back-office filter only; the resident route ignores it and never widens scope. */
  residentUserId: z.string().uuid().optional(),
  keyword: z.string().trim().min(1).max(80).optional(),
})
export type LocalOrderListQuery = z.infer<typeof localOrderListQuerySchema>

export const localOrderListResponseSchema = z.object({
  items: z.array(localOrderSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
})
export type LocalOrderListResponse = z.infer<typeof localOrderListResponseSchema>

export const localOrderEventListResponseSchema = z.object({
  items: z.array(localOrderEventSchema),
})
export type LocalOrderEventListResponse = z.infer<typeof localOrderEventListResponseSchema>

/* -------------------------------------------------------------------------- */
/* Resident participation & three-person team domain (#60 LL-MVP-004)         */
/* -------------------------------------------------------------------------- */

/**
 * Route identifiers for a resident's participation in one activity. `state` is
 * read with GET and `confirm` is written with POST; both address the same
 * per-activity participation of the authenticated resident, so the URL matches.
 * The resident identity always comes from the server session, never from a body.
 */
export const PARTICIPATION_ROUTES = {
  state: '/activities/:activityId/participation',
  confirm: '/activities/:activityId/participation',
} as const

/** Why the resident cannot join right now. `null` means no blocking reason. */
export const participationUnavailableReasonSchema = z.enum([
  'activity_not_published',
  'activity_ended',
])

export type ParticipationUnavailableReason = z.infer<
  typeof participationUnavailableReasonSchema
>

export const participationRoleSchema = z.enum(['leader', 'member'])
export type ParticipationRole = z.infer<typeof participationRoleSchema>

/**
 * How this activity's attribution was frozen: joining on one's own (`self`) or
 * accepting an invitation (`invite`). Later link opens never change it, and it is
 * deliberately separate from any community grid-worker promotion attribution.
 */
export const participationInviteSourceSchema = z.enum(['self', 'invite'])
export type ParticipationInviteSource = z.infer<typeof participationInviteSourceSchema>

export const participationTeamStatusSchema = z.enum(['open', 'locked'])
export type ParticipationTeamStatus = z.infer<typeof participationTeamStatusSchema>

/**
 * Invite codes are opaque 32-character lowercase hex tokens minted by the API.
 * The same shape is returned on an open team and accepted by the confirm request,
 * so clients can round-trip the code without reformatting it.
 */
export const participationInviteCodeSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/, 'must be a 32-character lowercase hex invite code')

export type ParticipationInviteCode = z.infer<typeof participationInviteCodeSchema>

/** A seat holder shown in the team roster. There are never more than three. */
export const participationTeamMemberSchema = z.object({
  seatNo: z.number().int().min(1).max(3),
  displayName: z.string().min(1),
  role: participationRoleSchema,
  isSelf: z.boolean(),
  joinedAt: isoTimestamp,
})

export type ParticipationTeamMember = z.infer<typeof participationTeamMemberSchema>

/**
 * The resident's current team for one activity. `seatsTotal` is a literal 3
 * because this contract only supports a three-person team. A team that reached
 * 3/3 is locked and must stop exposing an invite code, otherwise a fourth
 * resident could be invited into a full team.
 */
export const participationTeamSchema = z
  .object({
    id: z.string().uuid(),
    status: participationTeamStatusSchema,
    seatsTotal: z.literal(3),
    seatsFilled: z.number().int().min(0).max(3),
    inviteCode: participationInviteCodeSchema.nullable(),
    members: z.array(participationTeamMemberSchema).max(3),
  })
  .superRefine((team, ctx) => {
    if (team.seatsFilled !== team.members.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'seatsFilled must equal the number of listed members',
        path: ['seatsFilled'],
      })
    }
    if (team.status === 'locked') {
      if (team.seatsFilled !== 3) {
        ctx.addIssue({
          code: 'custom',
          message: 'a locked team must be full (3/3)',
          path: ['seatsFilled'],
        })
      }
      if (team.inviteCode !== null) {
        ctx.addIssue({
          code: 'custom',
          message: 'a locked team must not expose an invite code',
          path: ['inviteCode'],
        })
      }
    }
    const usedSeats = new Set<number>()
    team.members.forEach((member, index) => {
      if (usedSeats.has(member.seatNo)) {
        ctx.addIssue({
          code: 'custom',
          message: 'seatNo must be unique inside a team',
          path: ['members', index, 'seatNo'],
        })
      }
      usedSeats.add(member.seatNo)
    })
  })

export type ParticipationTeam = z.infer<typeof participationTeamSchema>

/**
 * The authenticated resident's participation. There is at most one of these per
 * activity and resident, which is why the state exposes a single nullable item
 * instead of a list.
 */
export const activityParticipationSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  seatNo: z.number().int().min(1).max(3),
  role: participationRoleSchema,
  inviteSource: participationInviteSourceSchema,
  invitationId: z.string().uuid().nullable(),
  inviterDisplayName: z.string().nullable(),
  joinedAt: isoTimestamp,
})

export type ActivityParticipation = z.infer<typeof activityParticipationSchema>

/**
 * Response of `GET /activities/:activityId/participation`. `joinable` reflects
 * whether this resident may confirm now; `unavailableReason` explains only the
 * activity lifecycle blockers defined by this contract.
 *
 * Invitation attribution and grid-worker sales attribution are separate records.
 * Keeping sales attribution out of this DTO is intentional: no field here may be
 * used to pay or credit invitation bonuses.
 */
export const activityParticipationStateSchema = z
  .object({
    activityId: z.string().uuid(),
    activityStatus: activityPublicStatusSchema,
    joinable: z.boolean(),
    unavailableReason: participationUnavailableReasonSchema.nullable(),
    participation: activityParticipationSchema.nullable(),
    team: participationTeamSchema.nullable(),
  })
  .superRefine((state, ctx) => {
    if (state.joinable && state.unavailableReason !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'unavailableReason must be null when joinable is true',
        path: ['unavailableReason'],
      })
    }
    if (state.participation && state.team && state.participation.teamId !== state.team.id) {
      ctx.addIssue({
        code: 'custom',
        message: 'participation.teamId must match team.id',
        path: ['participation', 'teamId'],
      })
    }
  })

export type ActivityParticipationState = z.infer<typeof activityParticipationStateSchema>

/**
 * Body of `POST /activities/:activityId/participation`. Strict on purpose: the
 * resident is identified by the session cookie only. A forged `userId` (or any
 * other unknown field) must fail parsing instead of being silently ignored.
 */
export const activityParticipationConfirmRequestSchema = z.strictObject({
  inviteCode: participationInviteCodeSchema.optional(),
})

export type ActivityParticipationConfirmRequest = z.infer<
  typeof activityParticipationConfirmRequestSchema
>

export const activityParticipationConfirmResponseSchema = z.object({
  created: z.boolean(),
  state: activityParticipationStateSchema,
})

export type ActivityParticipationConfirmResponse = z.infer<
  typeof activityParticipationConfirmResponseSchema
>

export * from './identity.js'
export * from './crmeb.js'
export * from './rewards.js'
export * from './ledger.js'
export * from './user-directory.js'
export * from './draw.js'

/* -------------------------------------------------------------------------- */
/* Phone (SMS one-time code) resident identity (#93 LL-H5-002)                 */
/* -------------------------------------------------------------------------- */

/**
 * Routes of the phone identity surface. Kept in their own constant (like the
 * activity/CRM reward domains) so the H5 client never hard-codes a path.
 *
 * - `POST otp`    request a 6-digit one-time code
 * - `POST login`  exchange phone + code for a resident session
 * - `POST bind`   bind a verified phone to the *current* resident session
 * - `GET  status` report whether a sender is configured and which phone is bound
 */
export const PHONE_AUTH_ROUTES = {
  status: '/auth/phone/status',
  requestOtp: '/auth/phone/otp',
  login: '/auth/phone/login',
  bind: '/auth/phone/bind',
} as const

/** Mainland China mobile numbers only: `1` + `3-9` + 9 digits. */
export const MAINLAND_MOBILE_PATTERN = /^1[3-9]\d{9}$/

/**
 * Canonicalizes a resident-typed mainland mobile number, or returns `null`.
 *
 * Residents paste numbers from WeChat, contacts and paper forms, so spaces,
 * hyphens, parentheses and a `+86`/`86` country prefix are formatting, not
 * identity. Everything else (short codes, landlines, foreign numbers, letters)
 * is rejected instead of being coerced: the normalized 11-digit string is the
 * UNIQUE identity key, so a lenient parse would merge distinct people.
 */
export function normalizeMainlandPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const compact = raw.trim().replace(/[\s()\-]/g, '')
  if (!compact) return null
  const digits = compact.startsWith('+86')
    ? compact.slice(3)
    : compact.startsWith('86') && compact.length > 11
      ? compact.slice(2)
      : compact
  return MAINLAND_MOBILE_PATTERN.test(digits) ? digits : null
}

/** `13800138000` -> `138****8000`. The only phone shape the H5 ever displays. */
export function maskMainlandPhone(phone: string): string {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

/**
 * Request body validator. It accepts the raw typed value and only guarantees
 * that {@link normalizeMainlandPhone} can canonicalize it; the API normalizes
 * once more before touching the database, so the stored key is always the
 * 11-digit form.
 */
export const mainlandPhoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine((value) => normalizeMainlandPhone(value) !== null, {
    message: '请输入有效的中国大陆手机号（11 位，1 开头）',
  })

export const phoneOtpPurposeSchema = z.enum(['login', 'bind'])
export type PhoneOtpPurpose = z.infer<typeof phoneOtpPurposeSchema>

/**
 * Strict on purpose: the resident is identified by the session cookie (bind) or
 * by the verified phone (login). A forged `userId` must fail parsing instead of
 * being silently ignored, following the participation contract precedent.
 */
export const phoneOtpRequestSchema = z.strictObject({
  phone: mainlandPhoneSchema,
  purpose: phoneOtpPurposeSchema,
})

export type PhoneOtpRequest = z.infer<typeof phoneOtpRequestSchema>

/**
 * Response of a successful code request. It never contains the code itself and
 * never reveals whether the phone is already bound to an account: enumeration
 * is answered identically for known and unknown numbers.
 */
export const phoneOtpRequestResponseSchema = z.object({
  accepted: z.literal(true),
  expiresInSeconds: z.number().int().positive(),
  retryAfterSeconds: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
})

export type PhoneOtpRequestResponse = z.infer<typeof phoneOtpRequestResponseSchema>

export const phoneOtpVerifyRequestSchema = z.strictObject({
  phone: mainlandPhoneSchema,
  code: z.string().regex(/^\d{6}$/, '验证码为 6 位数字'),
})

export type PhoneOtpVerifyRequest = z.infer<typeof phoneOtpVerifyRequestSchema>

/** Result of binding a verified phone to the current resident session. */
export const phoneBindResponseSchema = z.object({
  bound: z.literal(true),
  /** `true` when this account already owned the same verified phone. */
  alreadyBound: z.boolean(),
  maskedPhone: z.string().min(7),
})

export type PhoneBindResponse = z.infer<typeof phoneBindResponseSchema>

/**
 * Account panel state. `configured: false` means the deployment has no SMS
 * sender, so the H5 must present the login method as unavailable instead of a
 * button that can only fail.
 */
export const phoneAuthStatusResponseSchema = z.object({
  configured: z.boolean(),
  authenticated: z.boolean(),
  maskedPhone: z.string().min(7).nullable(),
})

export type PhoneAuthStatusResponse = z.infer<typeof phoneAuthStatusResponseSchema>

/* -------------------------------------------------------------------------- */
/* WeChat public-account admin config (#113 LL-SYS-001)                       */
/* -------------------------------------------------------------------------- */

/**
 * Route identifiers for the admin-only WeChat public-account configuration.
 *
 * This is the ONLY definition of these paths: the Hono routes, the admin client
 * and the tests all build URLs from here, so a renamed endpoint cannot drift.
 * Every endpoint reuses the existing staff session + Origin/CSRF checks and is
 * restricted to `role = admin`; `/admin/wechat/*` is inside the back-office
 * surface, so operators and grid workers must never reach it.
 *
 * - `GET  config`             current state + summaries (never an AppSecret)
 * - `POST saveCandidate`      encrypt + store a new candidate version
 * - `POST verify`             call the real WeChat API for one stored version
 * - `POST activate`           switch the runtime provider with confirmation
 */
export const WECHAT_ADMIN_ROUTES = {
  config: '/admin/wechat/config',
  saveCandidate: '/admin/wechat/config/candidates',
  verify: '/admin/wechat/config/:configId/verify',
  activate: '/admin/wechat/config/:configId/activate',
} as const

/** The callback path the deployment exposes next to the resident H5. */
export const WECHAT_OAUTH_CALLBACK_PATH = '/api/auth/wechat/callback'

export function wechatAdminVerifyPath(configId: string): string {
  return WECHAT_ADMIN_ROUTES.verify.replace(':configId', encodeURIComponent(configId))
}

export function wechatAdminActivatePath(configId: string): string {
  return WECHAT_ADMIN_ROUTES.activate.replace(':configId', encodeURIComponent(configId))
}

/**
 * Display-only distinction between the WeChat interface test account and the
 * official public account. It never changes the OAuth protocol or the stored
 * credentials; it only tells an operator which account a row belongs to.
 */
export const wechatAccountTypeSchema = z.enum(['test', 'official'])
export type WechatAccountType = z.infer<typeof wechatAccountTypeSchema>

/**
 * Persisted lifecycle of one configuration version.
 *
 * `draft`     saved candidate, not verified yet
 * `verified`  a real WeChat API call proved the credentials work
 * `failed`    the latest verification failed; the row is unusable
 * `active`    the single runtime provider (partial unique index on disk)
 * `retired`   superseded by a newer candidate or by an activation switch
 */
export const wechatConfigStatusSchema = z.enum([
  'draft',
  'verified',
  'failed',
  'active',
  'retired',
])
export type WechatConfigStatus = z.infer<typeof wechatConfigStatusSchema>

/**
 * The overall state the admin screen shows. It is derived from "is there an
 * active row / a current candidate", not stored, so it cannot disagree with the
 * rows the same response returns.
 */
export const wechatAdminConfigStateSchema = z.enum([
  'unconfigured',
  'draft',
  'verified',
  'failed',
  'active',
])
export type WechatAdminConfigState = z.infer<typeof wechatAdminConfigStateSchema>

/**
 * One shared derivation for the API response and the admin UI. `active` wins:
 * a working account stays reported as 已启用 even while an unverified candidate
 * is being prepared. Without an active row the newest candidate decides.
 */
export function resolveWechatAdminConfigState(
  active: Pick<WechatConfigSummary, 'status'> | null,
  candidate: Pick<WechatConfigSummary, 'status'> | null,
): WechatAdminConfigState {
  if (active && active.status === 'active') return 'active'
  switch (candidate?.status) {
    case 'verified':
      return 'verified'
    case 'failed':
      return 'failed'
    case 'draft':
      return 'draft'
    default:
      return 'unconfigured'
  }
}

/**
 * Redacted failure categories. A WeChat error code, HTTP status or transport
 * error is mapped onto this closed set before it is stored or shown, so no raw
 * upstream payload, access token or credential can leak through an error field.
 */
export const wechatConfigFailureCodeSchema = z.enum([
  'invalid_app_id',
  'invalid_app_secret',
  'invalid_credential',
  'api_forbidden',
  'rate_limited',
  'wechat_api_error',
  'network_error',
  'timeout',
  'decrypt_failed',
  'master_key_unavailable',
  'unknown',
])
export type WechatConfigFailureCode = z.infer<typeof wechatConfigFailureCodeSchema>

/**
 * Admin-visible summary of one configuration version. It deliberately has no
 * ciphertext/iv/tag/key field and no AppSecret field: the server never returns
 * key material, and the admin client has no way to render it accidentally.
 */
export const wechatConfigSummarySchema = z.object({
  id: z.string().uuid(),
  appId: z.string().min(1),
  accountType: wechatAccountTypeSchema,
  status: wechatConfigStatusSchema,
  /** Which master-key generation encrypted this row (never the key itself). */
  keyId: z.string().min(1),
  lastErrorCode: wechatConfigFailureCodeSchema.nullable(),
  verifiedAt: isoTimestamp.nullable(),
  activatedAt: isoTimestamp.nullable(),
  retiredAt: isoTimestamp.nullable(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
})

export type WechatConfigSummary = z.infer<typeof wechatConfigSummarySchema>

/**
 * `GET /admin/wechat/config`. `masterKeyAvailable: false` means the server
 * cannot decrypt or store credentials at all, so the UI must present the whole
 * feature as unavailable instead of offering a button that can only fail.
 */
export const wechatAdminConfigResponseSchema = z.object({
  state: wechatAdminConfigStateSchema,
  /** The single runtime provider, or null when no version is active. */
  active: wechatConfigSummarySchema.nullable(),
  /** Newest `draft`/`verified`/`failed` version, or null. */
  candidate: wechatConfigSummarySchema.nullable(),
  /** Newest versions first, including retired history; never key material. */
  recent: z.array(wechatConfigSummarySchema).max(50),
  masterKeyAvailable: z.boolean(),
  /** Configured master-key generation id; a non-secret label. */
  keyId: z.string().min(1),
  /** Read-only full callback URL derived from the approved resident web origin. */
  redirectUri: z.string().min(1),
})

export type WechatAdminConfigResponse = z.infer<typeof wechatAdminConfigResponseSchema>

/**
 * Save a new candidate version. The AppSecret is accepted exactly as typed
 * (never trimmed/reformatted) and is encrypted before it reaches SQLite; it is
 * never echoed by any response. Storing a candidate never changes the active
 * provider, so a typo cannot break a working OAuth deployment.
 */
export const saveWechatConfigRequestSchema = z.strictObject({
  appId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{6,64}$/, 'AppID 必须是 6-64 位字母或数字'),
  appSecret: z
    .string()
    .min(8)
    .max(128),
  accountType: wechatAccountTypeSchema,
})

export type SaveWechatConfigRequest = z.infer<typeof saveWechatConfigRequestSchema>

export const saveWechatConfigResponseSchema = z.object({
  config: wechatConfigSummarySchema,
})

export type SaveWechatConfigResponse = z.infer<typeof saveWechatConfigResponseSchema>

/**
 * Verify one stored candidate. Verification is a real WeChat API call; a
 * failure is reported as the standard `wechat_config_verify_failed` error
 * envelope and the previous `active` provider is left untouched.
 */
export const verifyWechatConfigRequestSchema = z.strictObject({
  expectedUpdatedAt: isoTimestamp,
})

export type VerifyWechatConfigRequest = z.infer<typeof verifyWechatConfigRequestSchema>

/** Only a real successful call may produce this response. */
export const verifyWechatConfigResponseSchema = z.object({
  verified: z.literal(true),
  config: wechatConfigSummarySchema,
})

export type VerifyWechatConfigResponse = z.infer<typeof verifyWechatConfigResponseSchema>

/**
 * Activate a verified version. `confirm: true` is required so a mis-click can
 * never swap the live OAuth provider; the response reports the previous active
 * version so the UI can show exactly what was retired.
 */
export const activateWechatConfigRequestSchema = z.strictObject({
  expectedUpdatedAt: isoTimestamp,
  confirm: z.literal(true),
})

export type ActivateWechatConfigRequest = z.infer<typeof activateWechatConfigRequestSchema>

export const activateWechatConfigResponseSchema = z.object({
  active: wechatConfigSummarySchema,
  previous: wechatConfigSummarySchema.nullable(),
})

export type ActivateWechatConfigResponse = z.infer<typeof activateWechatConfigResponseSchema>

/* -------------------------------------------------------------------------- */
/* External promotions: third-party links only (#144 LL-H5-007)               */
/* -------------------------------------------------------------------------- */

/** No payment, stock, award, claim, or redemption occurs in this domain. */
export const EXTERNAL_OFFER_ROUTES = {
  publicList: '/external-offers',
  adminList: '/admin/external-offers',
  adminDetail: '/admin/external-offers/:offerId',
  importBatch: '/admin/external-offers/import',
} as const

/** Reject non-web schemes, local destinations, credentials, and parser ambiguities. */
export const externalOfferUrlSchema = z.string().trim().min(12).max(2048).refine((value) =>
  /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#][^\s\\\u0000-\u001f]*)?$/i.test(value),
  '只接受有效的外部 HTTPS 网页链接')

export const externalOfferSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal('external_promotion'),
  title: z.string().min(1).max(80),
  platform: z.string().min(1).max(40),
  category: z.string().min(1).max(40),
  description: z.string().nullable(),
  url: externalOfferUrlSchema,
  sortOrder: z.number().int().min(0),
  enabled: z.boolean(),
  expiresAt: isoTimestamp.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
})
export type ExternalOffer = z.infer<typeof externalOfferSchema>
export const externalOfferListSchema = z.object({ items: z.array(externalOfferSchema) })

export const createExternalOfferRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(80),
  platform: z.string().trim().min(1).max(40),
  category: z.string().trim().min(1).max(40),
  description: z.string().trim().max(300).nullable(),
  url: externalOfferUrlSchema,
  sortOrder: z.number().int().min(0).max(10000),
  enabled: z.boolean(),
  expiresAt: isoTimestamp.nullable(),
})
export type CreateExternalOfferRequest = z.infer<typeof createExternalOfferRequestSchema>

export const updateExternalOfferRequestSchema =
  createExternalOfferRequestSchema.extend({ expectedUpdatedAt: isoTimestamp })
export type UpdateExternalOfferRequest = z.infer<typeof updateExternalOfferRequestSchema>

/**
 * Spreadsheet import writes *drafts only*. Never let a spreadsheet choose
 * enabled=true or create reward, order, stock or finance records.
 */
export const externalOfferImportItemSchema =
  createExternalOfferRequestSchema.omit({ enabled: true })
export type ExternalOfferImportItem = z.infer<typeof externalOfferImportItemSchema>

export const externalOfferImportRequestSchema = z.strictObject({
  items: z.array(externalOfferImportItemSchema).min(1).max(100),
})
export type ExternalOfferImportRequest = z.infer<typeof externalOfferImportRequestSchema>

export const externalOfferImportResponseSchema = z.strictObject({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
})
export type ExternalOfferImportResponse = z.infer<typeof externalOfferImportResponseSchema>

