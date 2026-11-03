import { relations } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { ActivityStatus } from '@sanchuang-dev/local-life-contracts'

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
}
