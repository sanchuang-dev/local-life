import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import {
  API_ERROR_CODES,
  USER_DIRECTORY_FALLBACK_DISPLAY_NAME,
  userDirectoryDetailSchema,
  userDirectoryEntrySchema,
  userDirectoryResponseSchema,
  type ApiErrorCode,
  type StaffRole,
  type UserDirectoryDetail,
  type UserDirectoryEntry,
  type UserDirectoryQuery,
  type UserDirectoryResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import type { HttpErrorStatus } from '../http.js'
import {
  communities,
  residentCommunityAssignments,
  residentPhoneIdentities,
  staffAccounts,
  staffCommunityAssignments,
  users,
  wechatOauthConfigs,
} from '../db/schema.js'

/**
 * Back-office user directory (#153 LL-USER-001 T2).
 *
 * The directory is rooted at the platform `users` table, deliberately NOT at
 * `resident_community_assignments` like the legacy `GET /crm/residents`
 * directory: a real account that never joined a community must still be
 * visible (to an administrator, at least). Every query is read-only; nothing
 * here writes communities, participation, orders, rewards or sessions.
 *
 * Permission is resolved before counting or searching. `admin` sees every
 * account; `operator`/`grid_worker` see only accounts linked to one of their
 * server-authorized communities, where "linked" means either a resident
 * community membership or a staff authorization on that community. An account
 * with no such link is administrator-only. A direct detail id is filtered by
 * the same condition, so it cannot be used to probe accounts outside scope.
 */

export class UserDirectoryError extends Error {
  readonly status: HttpErrorStatus
  readonly code: ApiErrorCode

  constructor(status: HttpErrorStatus, code: ApiErrorCode, message: string) {
    super(message)
    this.status = status
    this.code = code
    this.name = 'UserDirectoryError'
  }
}

export interface UserDirectoryActor {
  staffId: string
  role: StaffRole
}

/** One row of the contract's resident-community list. */
interface ResidentMembership {
  id: string
  name: string
  joinedAt: Date
}

interface DirectoryRow {
  id: string
  localDisplayName: string | null
  createdAt: Date
  wechatNickname: string | null
  wechatAvatarUrl: string | null
  profileAuthorizedAt: number | null
  wechatIdentityCount: number
  phoneIdentityCount: number
  staffRole: StaffRole | null
  staffAccountId: string | null
  staffUsername: string | null
  staffStatus: 'active' | 'disabled' | null
}

function iso(timestamp: Date): string {
  return timestamp.toISOString()
}

/** The currently active public account; a different AppID must never leak. */
function activeWechatAppId(db: AppDatabase): string | null {
  return db
    .select({ appId: wechatOauthConfigs.appId })
    .from(wechatOauthConfigs)
    .where(eq(wechatOauthConfigs.status, 'active'))
    .get()?.appId ?? null
}

function assignedCommunityIds(db: AppDatabase, staffId: string): string[] {
  return db
    .select({ communityId: staffCommunityAssignments.communityId })
    .from(staffCommunityAssignments)
    .where(eq(staffCommunityAssignments.staffAccountId, staffId))
    .all()
    .map((row) => row.communityId)
}

/**
 * Accounts a non-admin may see. `undefined` means "no restriction" (admin).
 * The two EXISTS arms are intentionally account-level: they decide visibility
 * once and are then ANDed with every search/filter, so no filter can widen it.
 */
function visibleAccountCondition(
  db: AppDatabase,
  actor: UserDirectoryActor,
): SQL | undefined {
  if (actor.role === 'admin') return undefined
  const communityIds = assignedCommunityIds(db, actor.staffId)
  if (communityIds.length === 0) return sql`0`
  return or(
    exists(
      db
        .select({ one: sql`1` })
        .from(residentCommunityAssignments)
        .where(
          and(
            eq(residentCommunityAssignments.userId, users.id),
            inArray(residentCommunityAssignments.communityId, communityIds),
          ),
        ),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(staffAccounts)
        .innerJoin(
          staffCommunityAssignments,
          eq(staffCommunityAssignments.staffAccountId, staffAccounts.id),
        )
        .where(
          and(
            eq(staffAccounts.userId, users.id),
            inArray(staffCommunityAssignments.communityId, communityIds),
          ),
        ),
    ),
  )!
}

/** LIKE is literal: %, _ and backslash in the keyword must not become wildcards. */
function escapedLike(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/gu, '\\$&')}%`
}

function keywordCondition(appId: string | null, keyword: string): SQL {
  const pattern = escapedLike(keyword)
  return or(
    sql`${users.id} LIKE ${pattern} ESCAPE ${'\\'}`,
    sql`${users.displayName} LIKE ${pattern} ESCAPE ${'\\'}`,
    // Only the current public account's explicitly authorized profile is
    // searchable. When no provider is active the app_id comparison is NULL
    // and matches nothing — other accounts' nicknames never leak.
    sql`EXISTS (
      SELECT 1 FROM wechat_identities wi
      WHERE wi.user_id = ${users.id}
        AND wi.app_id = ${appId}
        AND wi.profile_authorized_at IS NOT NULL
        AND wi.nickname LIKE ${pattern} ESCAPE ${'\\'}
    )`,
  )!
}

function roleCondition(role: NonNullable<UserDirectoryQuery['role']>): SQL {
  if (role === 'resident') {
    return sql`NOT EXISTS (
      SELECT 1 FROM staff_accounts sa WHERE sa.user_id = ${users.id}
    )`
  }
  return sql`EXISTS (
    SELECT 1 FROM staff_accounts sa
    WHERE sa.user_id = ${users.id} AND sa.role = ${role}
  )`
}

/**
 * Community filter. This filters on the resident relation only (matching the
 * contract wording); staff authorization is part of *visibility*, not of this
 * filter. `unassigned` means zero resident community memberships.
 */
function communityCondition(
  community: NonNullable<UserDirectoryQuery['community']>,
): SQL {
  if (community === 'unassigned') {
    return sql`NOT EXISTS (
      SELECT 1 FROM resident_community_assignments rca WHERE rca.user_id = ${users.id}
    )`
  }
  return sql`EXISTS (
    SELECT 1 FROM resident_community_assignments rca
    WHERE rca.user_id = ${users.id} AND rca.community_id = ${community}
  )`
}

/** Profile scalar subqueries: only the active AppID and only explicit consent. */
function profileSelection(appId: string | null) {
  const profileWhere = sql`wi.user_id = ${users.id}
    AND wi.app_id = ${appId}
    AND wi.profile_authorized_at IS NOT NULL`
  return {
    wechatNickname: sql<string | null>`(
      SELECT wi.nickname FROM wechat_identities wi
      WHERE ${profileWhere}
      ORDER BY wi.profile_authorized_at DESC, wi.id ASC LIMIT 1
    )`,
    wechatAvatarUrl: sql<string | null>`(
      SELECT wi.avatar_url FROM wechat_identities wi
      WHERE ${profileWhere}
      ORDER BY wi.profile_authorized_at DESC, wi.id ASC LIMIT 1
    )`,
    profileAuthorizedAt: sql<number | null>`(
      SELECT wi.profile_authorized_at FROM wechat_identities wi
      WHERE ${profileWhere}
      ORDER BY wi.profile_authorized_at DESC, wi.id ASC LIMIT 1
    )`,
  }
}

function directorySelection(appId: string | null) {
  return {
    id: users.id,
    localDisplayName: users.displayName,
    createdAt: users.createdAt,
    ...profileSelection(appId),
    // Counts/existence flags only; no openid, no unionid, no phone value here.
    wechatIdentityCount: sql<number>`(
      SELECT COUNT(*) FROM wechat_identities wi WHERE wi.user_id = ${users.id}
    )`,
    phoneIdentityCount: sql<number>`(
      SELECT COUNT(*) FROM resident_phone_identities rpi WHERE rpi.user_id = ${users.id}
    )`,
    staffRole: staffAccounts.role,
    staffAccountId: staffAccounts.id,
    staffUsername: staffAccounts.username,
    staffStatus: staffAccounts.status,
  }
}

function directoryQuery(db: AppDatabase, appId: string | null) {
  return db
    .select(directorySelection(appId))
    .from(users)
    .leftJoin(staffAccounts, eq(staffAccounts.userId, users.id))
}

function residentMembershipMap(
  db: AppDatabase,
  userIds: string[],
): Map<string, ResidentMembership[]> {
  const map = new Map<string, ResidentMembership[]>()
  if (userIds.length === 0) return map
  const rows = db
    .select({
      userId: residentCommunityAssignments.userId,
      id: communities.id,
      name: communities.name,
      joinedAt: residentCommunityAssignments.createdAt,
    })
    .from(residentCommunityAssignments)
    .innerJoin(communities, eq(communities.id, residentCommunityAssignments.communityId))
    .where(inArray(residentCommunityAssignments.userId, userIds))
    .orderBy(asc(residentCommunityAssignments.userId), asc(communities.id))
    .all()
  for (const row of rows) {
    const list = map.get(row.userId) ?? []
    list.push({ id: row.id, name: row.name, joinedAt: row.joinedAt })
    map.set(row.userId, list)
  }
  return map
}

function residentCommunities(list: ResidentMembership[]) {
  return list.map((membership) => ({
    id: membership.id,
    name: membership.name,
    joinedAt: iso(membership.joinedAt),
  }))
}

function identityMethodsOf(row: DirectoryRow) {
  const methods: Array<'wechat' | 'phone' | 'staff'> = []
  if (row.wechatIdentityCount > 0) methods.push('wechat')
  if (row.phoneIdentityCount > 0) methods.push('phone')
  if (row.staffRole !== null) methods.push('staff')
  return methods
}

/**
 * Authorized profile values are nulled unless the current public account has a
 * recorded consent, so the stable fallback chain (consented WeChat nickname >
 * local name > shared placeholder) is enforced in one place for list + detail.
 */
function toEntry(
  row: DirectoryRow,
  memberships: ResidentMembership[],
): UserDirectoryEntry {
  const authorizedAt =
    row.profileAuthorizedAt === null ? null : new Date(row.profileAuthorizedAt).toISOString()
  const wechatNickname = authorizedAt === null ? null : row.wechatNickname
  const wechatAvatarUrl = authorizedAt === null ? null : row.wechatAvatarUrl
  const localDisplayName = row.localDisplayName
  return userDirectoryEntrySchema.parse({
    id: row.id,
    displayName:
      wechatNickname?.trim() || localDisplayName?.trim() || USER_DIRECTORY_FALLBACK_DISPLAY_NAME,
    localDisplayName,
    wechatNickname,
    wechatAvatarUrl,
    wechatProfileAuthorizedAt: authorizedAt,
    identityMethods: identityMethodsOf(row),
    staffRole: row.staffRole,
    residentCommunities: residentCommunities(memberships),
    createdAt: iso(row.createdAt),
  })
}

/**
 * `138****8000` is the only phone shape the API returns. The database CHECK
 * guarantees an 11-digit mainland number, so an unexpected shape is a hard
 * failure rather than a silent plaintext fallback.
 */
export function maskDirectoryPhone(phone: string): string {
  const compact = phone.trim()
  if (!/^1\d{10}$/u.test(compact)) {
    throw new Error('resident phone identity is not a canonical mainland number')
  }
  return `${compact.slice(0, 3)}****${compact.slice(7)}`
}

function staffCommunitiesOf(db: AppDatabase, staffAccountId: string) {
  return db
    .select({ id: communities.id, name: communities.name })
    .from(staffCommunityAssignments)
    .innerJoin(communities, eq(communities.id, staffCommunityAssignments.communityId))
    .where(eq(staffCommunityAssignments.staffAccountId, staffAccountId))
    .orderBy(asc(communities.id))
    .all()
}

export function listUserDirectory(
  db: AppDatabase,
  actor: UserDirectoryActor,
  query: UserDirectoryQuery,
): UserDirectoryResponse {
  // Contract: non-admin staff have no unassigned accounts in scope.
  if (actor.role !== 'admin' && query.community === 'unassigned') {
    return userDirectoryResponseSchema.parse({
      items: [],
      total: 0,
      page: query.page,
      pageSize: query.pageSize,
    })
  }
  // An explicit community filter may only name a community the caller is
  // authorized for. The check happens before count/search so neither the total
  // nor a keyword can be used to probe an out-of-scope community.
  if (
    actor.role !== 'admin' &&
    query.community !== undefined &&
    !assignedCommunityIds(db, actor.staffId).includes(query.community)
  ) {
    throw new UserDirectoryError(
      403,
      API_ERROR_CODES.forbidden,
      '无权查看该社区的用户',
    )
  }

  const appId = activeWechatAppId(db)
  const conditions: SQL[] = []
  const visible = visibleAccountCondition(db, actor)
  if (visible) conditions.push(visible)
  if (query.role) conditions.push(roleCondition(query.role))
  if (query.community) conditions.push(communityCondition(query.community))
  if (query.keyword) {
    conditions.push(keywordCondition(appId, query.keyword))
  }
  const where = conditions.length === 0 ? undefined : and(...conditions)

  const total = db.select({ value: count() }).from(users).where(where).get()?.value ?? 0
  const rows = directoryQuery(db, appId)
    .where(where)
    .orderBy(desc(users.createdAt), asc(users.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all()
  const memberships = residentMembershipMap(
    db,
    rows.map((row) => row.id),
  )
  return userDirectoryResponseSchema.parse({
    items: rows.map((row) => toEntry(row, memberships.get(row.id) ?? [])),
    total,
    page: query.page,
    pageSize: query.pageSize,
  })
}

export function getUserDirectory(
  db: AppDatabase,
  actor: UserDirectoryActor,
  userId: string,
): UserDirectoryDetail {
  const visible = visibleAccountCondition(db, actor)
  const row = directoryQuery(db, activeWechatAppId(db))
    .where(visible ? and(eq(users.id, userId), visible) : eq(users.id, userId))
    .get()
  // Out-of-scope and non-existent accounts share the same 404: a detail id
  // must not become an existence probe across communities.
  if (!row) {
    throw new UserDirectoryError(404, API_ERROR_CODES.notFound, '用户不存在')
  }

  const entry = toEntry(row, residentMembershipMap(db, [userId]).get(userId) ?? [])
  const phone = db
    .select({ phone: residentPhoneIdentities.phone })
    .from(residentPhoneIdentities)
    .where(eq(residentPhoneIdentities.userId, userId))
    .get()
  const staffAccount =
    row.staffAccountId === null || row.staffUsername === null || row.staffStatus === null
      ? null
      : {
          username: row.staffUsername,
          status: row.staffStatus,
          communities: staffCommunitiesOf(db, row.staffAccountId),
        }
  return userDirectoryDetailSchema.parse({
    ...entry,
    wechatLinkedIdentityCount: row.wechatIdentityCount,
    maskedPhone: phone ? maskDirectoryPhone(phone.phone) : null,
    staffAccount,
  })
}
