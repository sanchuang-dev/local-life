import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  notInArray,
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
  type ResidentCommunityBindingSource,
  type StaffRole,
  type UserCommunityRelationSource,
  type UserDirectoryDetail,
  type UserDirectoryEntry,
  type UserDirectoryQuery,
  type UserDirectoryResponse,
  type UserResidentCommunityState,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import type { HttpErrorStatus } from '../http.js'
import {
  communities,
  residentCommunityAssignments,
  residentCommunityBindings,
  residentPhoneIdentities,
  staffAccounts,
  staffCommunityAssignments,
  users,
  wechatOauthConfigs,
} from '../db/schema.js'
import { getResidentCommunityStatus } from '../resident-community/service.js'

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

/**
 * The resident's own confirmed permanent community (#171), as read for the
 * directory. Only rows the caller is authorized for are ever selected.
 */
interface ConfirmedCommunityRow {
  userId: string
  communityId: string
  communityName: string
  confirmedAt: Date
  source: ResidentCommunityBindingSource
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
 * "This account is related to community X" (#171).
 *
 * Since migration 0018 a resident's permanent community lives in
 * `resident_community_bindings`, while `resident_community_assignments` holds the
 * historical relations. Both are relation facts about the account, so every
 * community-scoped read here treats them as a union — otherwise a resident who
 * confirmed a community after #171 (and therefore has no legacy row at all) would
 * be invisible to the very operators responsible for that community.
 *
 * Both arms are EXISTS subqueries, so the union can never duplicate an account
 * row or inflate `total`: one account is still exactly one row.
 */
function relatedToCommunity(communityId: string | SQL): SQL {
  return or(
    sql`EXISTS (
      SELECT 1 FROM resident_community_assignments rca
      WHERE rca.user_id = ${users.id} AND rca.community_id = ${communityId}
    )`,
    sql`EXISTS (
      SELECT 1 FROM resident_community_bindings rcb
      WHERE rcb.user_id = ${users.id} AND rcb.community_id = ${communityId}
    )`,
  )!
}

/**
 * Accounts a non-admin may see. `undefined` means "no restriction" (admin).
 * The two arms are intentionally account-level: they decide visibility once and
 * are then ANDed with every search/filter, so no filter can widen it.
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
        .from(residentCommunityBindings)
        .where(
          and(
            eq(residentCommunityBindings.userId, users.id),
            inArray(residentCommunityBindings.communityId, communityIds),
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
 * filter. `unassigned` means no resident community relation at all — neither a
 * confirmed binding nor a historical relation, because after #171 a confirmed
 * resident may have no legacy row at all and must not be reported as 未关联.
 */
function communityCondition(
  community: NonNullable<UserDirectoryQuery['community']>,
): SQL {
  if (community === 'unassigned') {
    return sql`NOT EXISTS (
      SELECT 1 FROM resident_community_assignments rca WHERE rca.user_id = ${users.id}
    ) AND NOT EXISTS (
      SELECT 1 FROM resident_community_bindings rcb WHERE rcb.user_id = ${users.id}
    )`
  }
  return relatedToCommunity(community)
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
  allowedCommunityIds?: string[],
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
    .where(and(
      inArray(residentCommunityAssignments.userId, userIds),
      allowedCommunityIds === undefined
        ? undefined
        : inArray(residentCommunityAssignments.communityId, allowedCommunityIds),
    ))
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

/**
 * The confirmed permanent binding per resident (#171), read from
 * `resident_community_bindings` only.
 *
 * This is deliberately a SEPARATE read from `residentMembershipMap`: the two
 * facts are never merged, so 「已确认常驻社区」 cannot be produced from a
 * historical relation. `allowedCommunityIds` applies here too — a non-admin
 * must not learn a resident's out-of-scope confirmed community just because the
 * account itself is visible through an authorized one.
 */
function confirmedCommunityMap(
  db: AppDatabase,
  userIds: string[],
  allowedCommunityIds?: string[],
): Map<string, ConfirmedCommunityRow> {
  const map = new Map<string, ConfirmedCommunityRow>()
  if (userIds.length === 0) return map
  const rows = db
    .select({
      userId: residentCommunityBindings.userId,
      communityId: residentCommunityBindings.communityId,
      communityName: communities.name,
      confirmedAt: residentCommunityBindings.confirmedAt,
      source: residentCommunityBindings.source,
    })
    .from(residentCommunityBindings)
    .innerJoin(communities, eq(communities.id, residentCommunityBindings.communityId))
    .where(and(
      inArray(residentCommunityBindings.userId, userIds),
      allowedCommunityIds === undefined
        ? undefined
        : inArray(residentCommunityBindings.communityId, allowedCommunityIds),
    ))
    .orderBy(asc(residentCommunityBindings.userId))
    .all()
  for (const row of rows) {
    map.set(row.userId, row)
  }
  return map
}

/**
 * Residents who DO have a confirmation the caller may not see.
 *
 * Only the account id crosses into the response (`communityRelationSource:
 * 'out_of_scope'`); the community id/name is never selected, so a scoped
 * operator learns "this resident already belongs to a community you are not
 * responsible for" — which prevents the harmful opposite claim 「未绑定」 —
 * without learning which community.
 */
function hiddenBindingUserIds(
  db: AppDatabase,
  userIds: string[],
  allowedCommunityIds?: string[],
): Set<string> {
  if (userIds.length === 0 || allowedCommunityIds === undefined) return new Set()
  const rows = db
    .select({ userId: residentCommunityBindings.userId })
    .from(residentCommunityBindings)
    .where(and(
      inArray(residentCommunityBindings.userId, userIds),
      allowedCommunityIds.length === 0
        ? undefined
        : notInArray(residentCommunityBindings.communityId, allowedCommunityIds),
    ))
    .all()
  return new Set(rows.map((row) => row.userId))
}

/**
 * The resident-facing #171 state, reused verbatim so an operator and the
 * resident can never disagree about 「未绑定 / 已确认 / 待核查 / 冲突」.
 *
 * Only an unrestricted caller (admin) gets it: the state is derived from every
 * historical relation, so computing it for a community-scoped operator would
 * leak relations outside that operator's authorization. `null` therefore means
 * precisely "not derivable for this caller", not "unbound".
 */
function residentCommunityStateFor(
  db: AppDatabase,
  actor: UserDirectoryActor,
  userIds: string[],
): Map<string, UserResidentCommunityState> {
  const map = new Map<string, UserResidentCommunityState>()
  if (actor.role !== 'admin') return map
  const now = new Date()
  for (const userId of userIds) {
    map.set(userId, getResidentCommunityStatus(db, userId, now).status)
  }
  return map
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
 *
 * #171: the confirmed permanent community and the historical relations are
 * emitted as two independent fields. `confirmedCommunity` comes exclusively from
 * the binding map, `residentCommunities` exclusively from the historical map, and
 * `communityRelationSource` states which fact is present — so no reader (UI,
 * export, operator) can promote history into a confirmation.
 */
function toEntry(
  row: DirectoryRow,
  memberships: ResidentMembership[],
  facts: {
    confirmed: ConfirmedCommunityRow | null
    /** A confirmation exists but its community is outside the caller's scope. */
    hiddenConfirmed: boolean
    state: UserResidentCommunityState | null
  },
): UserDirectoryEntry {
  const authorizedAt =
    row.profileAuthorizedAt === null ? null : new Date(row.profileAuthorizedAt).toISOString()
  const wechatNickname = authorizedAt === null ? null : row.wechatNickname
  const wechatAvatarUrl = authorizedAt === null ? null : row.wechatAvatarUrl
  const localDisplayName = row.localDisplayName
  const relationSource: UserCommunityRelationSource =
    facts.confirmed !== null
      ? 'confirmed_binding'
      : facts.hiddenConfirmed
        ? 'out_of_scope'
        : memberships.length > 0
          ? 'historical_assignment'
          : 'none'
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
    confirmedCommunity:
      facts.confirmed === null
        ? null
        : {
            id: facts.confirmed.communityId,
            name: facts.confirmed.communityName,
            confirmedAt: iso(facts.confirmed.confirmedAt),
            source: facts.confirmed.source,
          },
    communityRelationSource: relationSource,
    residentCommunityState: facts.state,
    createdAt: iso(row.createdAt),
  })
}

/**
 * Loads the #171 facts for one page (or one account) in three separate reads and
 * keeps them separate on the way out. Nothing here writes; nothing here is
 * derived from `residentMembershipMap`.
 */
function communityFacts(
  db: AppDatabase,
  actor: UserDirectoryActor,
  userIds: string[],
): (userId: string) => Parameters<typeof toEntry>[2] {
  const allowedCommunityIds =
    actor.role === 'admin' ? undefined : assignedCommunityIds(db, actor.staffId)
  const confirmed = confirmedCommunityMap(db, userIds, allowedCommunityIds)
  const hidden = hiddenBindingUserIds(db, userIds, allowedCommunityIds)
  const states = residentCommunityStateFor(db, actor, userIds)
  return (userId: string) => ({
    confirmed: confirmed.get(userId) ?? null,
    // Never both: a visible confirmation wins over the "withheld" hint.
    hiddenConfirmed: confirmed.has(userId) ? false : hidden.has(userId),
    state: states.get(userId) ?? null,
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

function staffCommunitiesOf(
  db: AppDatabase,
  staffAccountId: string,
  allowedCommunityIds?: string[],
) {
  return db
    .select({ id: communities.id, name: communities.name })
    .from(staffCommunityAssignments)
    .innerJoin(communities, eq(communities.id, staffCommunityAssignments.communityId))
    .where(and(
      eq(staffCommunityAssignments.staffAccountId, staffAccountId),
      allowedCommunityIds === undefined
        ? undefined
        : inArray(staffCommunityAssignments.communityId, allowedCommunityIds),
    ))
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
  // Do not expose out-of-scope community memberships, even for a user whose
  // account is visible through one authorized community.
  const allowedCommunityIds =
    actor.role === 'admin' ? undefined : assignedCommunityIds(db, actor.staffId)
  const memberships = residentMembershipMap(
    db,
    rows.map((row) => row.id),
    allowedCommunityIds,
  )
  const facts = communityFacts(
    db,
    actor,
    rows.map((row) => row.id),
  )
  return userDirectoryResponseSchema.parse({
    items: rows.map((row) =>
      toEntry(row, memberships.get(row.id) ?? [], facts(row.id)),
    ),
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

  const allowedCommunityIds =
    actor.role === 'admin' ? undefined : assignedCommunityIds(db, actor.staffId)
  const memberships = residentMembershipMap(db, [userId], allowedCommunityIds).get(userId) ?? []
  const entry = toEntry(row, memberships, communityFacts(db, actor, [userId])(userId))
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
          communities: staffCommunitiesOf(db, row.staffAccountId, allowedCommunityIds),
        }
  return userDirectoryDetailSchema.parse({
    ...entry,
    wechatLinkedIdentityCount: row.wechatIdentityCount,
    maskedPhone: phone ? maskDirectoryPhone(phone.phone) : null,
    staffAccount,
  })
}
