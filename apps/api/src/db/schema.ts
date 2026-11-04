import { relations, sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type {
  ActivityStatus,
  ParticipationInviteSource,
  ParticipationRole,
  ParticipationTeamStatus,
} from '@sanchuang-dev/local-life-contracts'

export type StaffRole = 'admin' | 'operator' | 'grid_worker'
export type StaffStatus = 'active' | 'disabled'

export const communities = sqliteTable('communities', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const wechatIdentities = sqliteTable(
  'wechat_identities',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    appId: text('app_id').notNull(),
    openId: text('open_id').notNull(),
    unionId: text('union_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('wechat_identity_app_openid_uq').on(table.appId, table.openId),
    index('wechat_identity_user_idx').on(table.userId),
  ],
)

export const staffAccounts = sqliteTable(
  'staff_accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').$type<StaffRole>().notNull(),
    status: text('status').$type<StaffStatus>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [uniqueIndex('staff_username_uq').on(table.username)],
)

export const staffCommunityAssignments = sqliteTable(
  'staff_community_assignments',
  {
    staffAccountId: text('staff_account_id')
      .notNull()
      .references(() => staffAccounts.id, { onDelete: 'cascade' }),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.staffAccountId, table.communityId] }),
    index('staff_community_community_idx').on(table.communityId),
  ],
)

export const residentCommunityAssignments = sqliteTable(
  'resident_community_assignments',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    communityId: text('community_id').notNull().references(() => communities.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.communityId] }),
    index('resident_community_community_idx').on(table.communityId),
  ],
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    staffAccountId: text('staff_account_id').references(() => staffAccounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    csrfHash: text('csrf_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_uq').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
    index('sessions_expiry_idx').on(table.expiresAt),
  ],
)

export const oauthStates = sqliteTable(
  'oauth_states',
  {
    id: text('id').primaryKey(),
    stateHash: text('state_hash').notNull(),
    nonceHash: text('nonce_hash').notNull(),
    communityId: text('community_id').references(() => communities.id, { onDelete: 'set null' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('oauth_state_hash_uq').on(table.stateHash),
    index('oauth_state_expiry_idx').on(table.expiresAt),
  ],
)

export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey(),
  attempts: integer('attempts').notNull(),
  windowStartedAt: integer('window_started_at', { mode: 'timestamp_ms' }).notNull(),
  blockedUntil: integer('blocked_until', { mode: 'timestamp_ms' }),
})

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    event: text('event').notNull(),
    targetId: text('target_id'),
    metadata: text('metadata'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('audit_logs_created_idx').on(table.createdAt),
    index('audit_logs_target_idx').on(table.targetId),
  ],
)

/**
 * Activity operations domain (#59). Key rules are stored twice on purpose:
 * the mutable current values live on the activity row (so drafts can be edited
 * without a version), and every publish/rule change freezes an immutable
 * snapshot in `activity_rule_versions`.
 */
export const activities = sqliteTable(
  'activities',
  {
    id: text('id').primaryKey(),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    summary: text('summary'),
    description: text('description'),
    status: text('status').$type<ActivityStatus>().notNull(),
    startsAt: integer('starts_at', { mode: 'timestamp_ms' }).notNull(),
    endsAt: integer('ends_at', { mode: 'timestamp_ms' }).notNull(),
    location: text('location').notNull(),
    budgetCapCents: integer('budget_cap_cents').notNull(),
    prizeQuantityCap: integer('prize_quantity_cap').notNull(),
    publicRulesJson: text('public_rules_json').notNull(),
    currentRuleVersionId: text('current_rule_version_id').references(
      () => activityRuleVersions.id,
      { onDelete: 'set null' },
    ),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
    pausedAt: integer('paused_at', { mode: 'timestamp_ms' }),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('activities_community_idx').on(table.communityId),
    index('activities_status_idx').on(table.status),
    index('activities_starts_at_idx').on(table.startsAt),
  ],
)

/**
 * Immutable rule snapshots. Rows are INSERT-only; a SQLite trigger raises
 * ABORT on UPDATE/DELETE so even a buggy query cannot rewrite published rules.
 */
export const activityRuleVersions = sqliteTable(
  'activity_rule_versions',
  {
    id: text('id').primaryKey(),
    // Kept as a plain column to avoid a circular Drizzle/TypeScript reference with
    // `activities.current_rule_version_id` (which owns the FK). The API only inserts
    // versions for an activity it just read in the same transaction.
    activityId: text('activity_id').notNull(),
    version: integer('version').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('activity_rule_versions_activity_version_uq').on(
      table.activityId,
      table.version,
    ),
    index('activity_rule_versions_activity_idx').on(table.activityId),
  ],
)

/**
 * Three-person team for one activity (#60). A team is created by the resident
 * who confirms first (the leader owns seat 1) and is shared by at most three
 * residents. `unique(activity_id, leader_user_id)` keeps a resident from
 * leading two teams in the same activity even if a bug bypasses the service.
 *
 * A team is INSERT-only apart from the one-way `open -> locked` transition when
 * the third seat is taken; triggers in migration 0002 enforce that on disk.
 */
export const activityTeams = sqliteTable(
  'activity_teams',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'restrict' }),
    leaderUserId: text('leader_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').$type<ParticipationTeamStatus>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    lockedAt: integer('locked_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('activity_teams_activity_leader_uq').on(table.activityId, table.leaderUserId),
    index('activity_teams_activity_idx').on(table.activityId),
    index('activity_teams_leader_idx').on(table.leaderUserId),
    check('activity_teams_status_check', sql`${table.status} IN ('open', 'locked')`),
    // A locked team is exactly the team whose third seat was taken in the same
    // transaction, so the lock flag and its timestamp can never disagree.
    check(
      'activity_teams_locked_at_check',
      sql`(${table.status} = 'locked' AND ${table.lockedAt} IS NOT NULL)
        OR (${table.status} = 'open' AND ${table.lockedAt} IS NULL)`,
    ),
  ],
)

/**
 * One invite code per open team. The code is opaque, minted by the API, and
 * belongs to the *team*, never to a single invitee: invitation attribution is
 * frozen on the participation row when an invitee confirms. This table carries
 * no grid-worker / sales attribution columns on purpose (see
 * docs/engineering/participation-teams.md).
 */
export const activityInvitations = sqliteTable(
  'activity_invitations',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'restrict' }),
    teamId: text('team_id')
      .notNull()
      .references(() => activityTeams.id, { onDelete: 'restrict' }),
    inviterUserId: text('inviter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('activity_invitations_code_uq').on(table.code),
    uniqueIndex('activity_invitations_team_uq').on(table.teamId),
    index('activity_invitations_activity_idx').on(table.activityId),
    check(
      'activity_invitations_code_check',
      sql`length(${table.code}) = 32 AND ${table.code} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
)

/**
 * A resident's participation in one activity. `unique(activity_id, user_id)` is
 * the durable "one valid team per resident per activity" rule; `unique(team_id,
 * seat_no)` makes a duplicated seat impossible. Attribution columns
 * (`invite_source`, `invitation_id`) are frozen at insert time and immutable
 * afterwards via triggers, so opening another share link can never rewrite the
 * first effective attribution.
 */
export const activityParticipations = sqliteTable(
  'activity_participations',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'restrict' }),
    teamId: text('team_id')
      .notNull()
      .references(() => activityTeams.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    seatNo: integer('seat_no').notNull(),
    role: text('role').$type<ParticipationRole>().notNull(),
    inviteSource: text('invite_source').$type<ParticipationInviteSource>().notNull(),
    invitationId: text('invitation_id').references(() => activityInvitations.id, {
      onDelete: 'restrict',
    }),
    joinedAt: integer('joined_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('activity_participations_activity_user_uq').on(table.activityId, table.userId),
    uniqueIndex('activity_participations_team_seat_uq').on(table.teamId, table.seatNo),
    index('activity_participations_user_idx').on(table.userId),
    check('activity_participations_seat_no_check', sql`${table.seatNo} BETWEEN 1 AND 3`),
    // Seat 1 is always the self-confirmed leader and seats 2/3 are always
    // invitation-sourced members: the roster shape is data, not a convention.
    check(
      'activity_participations_role_source_check',
      sql`(${table.role} = 'leader' AND ${table.seatNo} = 1 AND ${table.inviteSource} = 'self' AND ${table.invitationId} IS NULL)
        OR (${table.role} = 'member' AND ${table.seatNo} BETWEEN 2 AND 3 AND ${table.inviteSource} = 'invite' AND ${table.invitationId} IS NOT NULL)`,
    ),
  ],
)

export const userRelations = relations(users, ({ many }) => ({
  wechatIdentities: many(wechatIdentities),
  residentCommunities: many(residentCommunityAssignments),
  sessions: many(sessions),
}))

export const staffRelations = relations(staffAccounts, ({ one, many }) => ({
  user: one(users, { fields: [staffAccounts.userId], references: [users.id] }),
  communities: many(staffCommunityAssignments),
}))

export const schema = {
  communities,
  users,
  wechatIdentities,
  staffAccounts,
  staffCommunityAssignments,
  residentCommunityAssignments,
  sessions,
  oauthStates,
  rateLimits,
  auditLogs,
  activities,
  activityRuleVersions,
  activityTeams,
  activityInvitations,
  activityParticipations,
}
