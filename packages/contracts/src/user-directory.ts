import { z } from 'zod'

import { authCommunitySchema, staffRoleSchema } from './identity.js'

/**
 * Administrator user directory (#153 LL-USER-001).
 *
 * This is the single DTO source for the back-office 「用户管理」 surface. The
 * directory is queried from the platform `users` table, NOT from
 * `resident_community_assignments`: an account that never joined a community is
 * still a real account and must be listable (marked by an empty
 * `residentCommunities` array). One platform user is always one row, no matter
 * how many WeChat identities or community memberships it owns.
 *
 * Permission rules are server-side only and are therefore not expressible in
 * this contract: admins may see every account including unassigned ones, while
 * operators/grid workers may only see accounts inside their server-authorized
 * communities and must not be able to widen scope with `role`, `keyword`,
 * `community` or a direct detail ID.
 *
 * Minimum-necessary data only. These DTOs deliberately have no OpenID/unionid,
 * no plaintext phone, no AppSecret/token/session/cookie, no password hash and
 * no fabricated login history. The masked phone is the only phone shape that
 * ever leaves the API.
 */

const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be an ISO-8601 UTC timestamp')

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Back-office user directory routes. `GET list` answers the paginated directory
 * and `GET detail` answers one account. Clients must build URLs from these
 * constants instead of hard-coding paths.
 */
export const USER_DIRECTORY_ROUTES = {
  list: '/admin/users',
  detail: '/admin/users/:userId',
} as const

/** Build the concrete detail URL for one platform user id. */
export function userDirectoryDetailPath(userId: string): string {
  return USER_DIRECTORY_ROUTES.detail.replace(':userId', encodeURIComponent(userId))
}

/**
 * Display fallback used by both the API and the admin UI when an account has
 * neither an authorized WeChat nickname nor a local display name. It is a
 * constant so the list cannot drift from the detail page.
 */
export const USER_DIRECTORY_FALLBACK_DISPLAY_NAME = '未命名用户' as const

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How an account can be identified. The array in a DTO is ordered by this enum
 * (`wechat`, `phone`, `staff`) and is never empty: every `users` row exists for
 * at least one of these reasons.
 */
export const userIdentityMethodSchema = z.enum(['wechat', 'phone', 'staff'])
export type UserIdentityMethod = z.infer<typeof userIdentityMethodSchema>

/**
 * Account-role filter. `admin`/`operator`/`grid_worker` match the back-office
 * `staff_accounts.role`; `resident` means the account has no staff row at all.
 * It is intentionally not a fourth staff role.
 */
export const userDirectoryRoleFilterSchema = z.enum([
  'admin',
  'operator',
  'grid_worker',
  'resident',
])
export type UserDirectoryRoleFilter = z.infer<typeof userDirectoryRoleFilterSchema>

/**
 * Community filter. A UUID narrows to accounts assigned to that resident
 * community; the literal `unassigned` narrows to accounts with zero resident
 * community assignments. `unassigned` is the filter the legacy
 * `GET /crm/residents` directory cannot express. Non-admin staff have no
 * unassigned accounts in their scope, so `unassigned` yields zero items for them.
 */
export const userDirectoryCommunityFilterSchema = z.union([
  z.string().uuid(),
  z.literal('unassigned'),
])
export type UserDirectoryCommunityFilter = z.infer<typeof userDirectoryCommunityFilterSchema>

/** Staff account lifecycle, surfaced on the detail page only. */
export const userStaffStatusSchema = z.enum(['active', 'disabled'])
export type UserStaffStatus = z.infer<typeof userStaffStatusSchema>

/* -------------------------------------------------------------------------- */
/* Query                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Paginated directory query. Pagination is always server-side and `total` is the
 * real number of visible accounts, not the size of one page.
 *
 * `keyword` is a literal (non-wildcard) substring search over the platform UUID,
 * the resident-authorized WeChat nickname of the *currently active* public
 * account, and the local display name. It must never widen permission scope.
 */
export const userDirectoryQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().min(1).max(80).optional(),
  role: userDirectoryRoleFilterSchema.optional(),
  community: userDirectoryCommunityFilterSchema.optional(),
})
export type UserDirectoryQuery = z.infer<typeof userDirectoryQuerySchema>

/* -------------------------------------------------------------------------- */
/* Shared value objects                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Resident community membership. This is the account's own resident community
 * relation (`resident_community_assignments`) — never the staff authorization a
 * back-office account holds over a community.
 */
export const userResidentCommunitySchema = authCommunitySchema.extend({
  joinedAt: isoTimestamp,
})
export type UserResidentCommunity = z.infer<typeof userResidentCommunitySchema>

/**
 * Back-office staff account attached to a platform user. `username` is the login
 * name, never a credential; no password hash, session or token is part of it.
 * The authorized community list here is staff authority, semantically distinct
 * from `residentCommunities`.
 */
export const userStaffAccountSchema = z.strictObject({
  username: z.string().min(1),
  status: userStaffStatusSchema,
  /** Communities this staff account may operate on. Never resident membership. */
  communities: z.array(authCommunitySchema),
})
export type UserStaffAccount = z.infer<typeof userStaffAccountSchema>

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One row of the directory.
 *
 * `displayName` precedence (computed by the API, shared with the admin UI):
 * authorized WeChat nickname of the current public account > local display name
 * > {@link USER_DIRECTORY_FALLBACK_DISPLAY_NAME}.
 *
 * `wechatNickname`/`wechatAvatarUrl` are non-null only when the resident
 * explicitly authorized `snsapi_userinfo` under the currently active public
 * account; the schema refuses a nickname/avatar without
 * `wechatProfileAuthorizedAt`.
 */
const userDirectoryBaseSchema = z.strictObject({
  /** Platform user UUID — the only stable account id. */
  id: z.string().uuid(),
  displayName: z.string().min(1),
  /** `users.display_name`; `null` when the account never set one. */
  localDisplayName: z.string().nullable(),
  wechatNickname: z.string().nullable(),
  wechatAvatarUrl: z.string().nullable(),
  /** Consent time under the current public account; `null` when not authorized. */
  wechatProfileAuthorizedAt: isoTimestamp.nullable(),
  /** Ordered `wechat`, `phone`, `staff`; at least one entry, no duplicates. */
  identityMethods: z.array(userIdentityMethodSchema).min(1).max(3),
  /** Back-office role, or `null` for a pure resident account. */
  staffRole: staffRoleSchema.nullable(),
  /**
   * Resident community memberships, ordered by community id. An empty array is
   * the explicit 「未关联社区」 state — it is not an error and not hidden.
   */
  residentCommunities: z.array(userResidentCommunitySchema),
  /** Platform account registration time. */
  createdAt: isoTimestamp,
})

type EntryLike = {
  wechatNickname: string | null
  wechatAvatarUrl: string | null
  wechatProfileAuthorizedAt: string | null
  identityMethods: readonly string[]
  staffRole: string | null
}

function addEntryIssues(value: EntryLike, ctx: z.core.$RefinementCtx): void {
  if (
    value.wechatProfileAuthorizedAt === null &&
    (value.wechatNickname !== null || value.wechatAvatarUrl !== null)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: '微信昵称/头像只能在当前公众号已记录授权时返回',
      path: ['wechatNickname'],
    })
  }
  if (new Set(value.identityMethods).size !== value.identityMethods.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'identityMethods 不得重复',
      path: ['identityMethods'],
    })
  }
  if (value.identityMethods.includes('staff') !== (value.staffRole !== null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'staff 身份方式与 staffRole 必须同时存在或同时为空',
      path: ['staffRole'],
    })
  }
}

export const userDirectoryEntrySchema = userDirectoryBaseSchema.superRefine(addEntryIssues)
export type UserDirectoryEntry = z.infer<typeof userDirectoryEntrySchema>

/**
 * List response. `items` is one stable page; the same ordering must be used for
 * every page so concatenated pages contain each visible account exactly once.
 */
export const userDirectoryResponseSchema = z.strictObject({
  items: z.array(userDirectoryEntrySchema),
  /** Real number of accounts visible to the caller, ignoring pagination. */
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
})
export type UserDirectoryResponse = z.infer<typeof userDirectoryResponseSchema>

/* -------------------------------------------------------------------------- */
/* Detail                                                                     */
/* -------------------------------------------------------------------------- */

const userDirectoryDetailBaseSchema = userDirectoryBaseSchema.extend({
  /**
   * Number of WeChat identities mapped to this platform user. It is a count,
   * never an identifier: no OpenID/unionid is exposed anywhere in this DTO.
   */
  wechatLinkedIdentityCount: z.number().int().nonnegative(),
  /** `138****8000`; the only phone shape the API returns. */
  maskedPhone: z
    .string()
    .regex(/^1\d{2}\*{4}\d{4}$/, 'must be a masked mainland phone like 138****8000')
    .nullable(),
  /** Back-office account attached to this platform user, or `null`. */
  staffAccount: userStaffAccountSchema.nullable(),
})

/**
 * One account detail. `residentCommunities` (resident membership) and
 * `staffAccount.communities` (staff authorization) are separate lists on
 * purpose: staff authority must never be rendered as resident belonging.
 *
 * The response is read-only; there is no update DTO here. Account mutation,
 * merging, forced community membership and exports are explicit non-goals.
 */
export const userDirectoryDetailSchema = userDirectoryDetailBaseSchema.superRefine(
  (value, ctx) => {
    addEntryIssues(value, ctx)
    if ((value.staffAccount === null) !== (value.staffRole === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'staffAccount 与 staffRole 必须同时存在或同时为空',
        path: ['staffAccount'],
      })
    }
    if (value.identityMethods.includes('phone') !== (value.maskedPhone !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'phone 身份方式与 maskedPhone 必须同时存在或同时为空',
        path: ['maskedPhone'],
      })
    }
    if (value.identityMethods.includes('wechat') !== (value.wechatLinkedIdentityCount > 0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'wechat 身份方式与 wechatLinkedIdentityCount 必须一致',
        path: ['wechatLinkedIdentityCount'],
      })
    }
  },
)
export type UserDirectoryDetail = z.infer<typeof userDirectoryDetailSchema>
