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
  CrmBusinessType,
  CrmLeadSourceType,
  CrmLeadStatus,
  CrmServiceOrderStatus,
  CrmebAttributionClaimState,
  CrmebIdentityVerificationMethod,
  CrmebOrderStatus,
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
 * Community CRM (#61 LL-MVP-005). A lead belongs to exactly one community and has
 * exactly one current owner; history lives in `crm_lead_events` (append-only).
 * `contact_phone` is the minimum necessary contact field and must never be copied
 * into audit metadata or payment/commission records.
 */
export const crmLeads = sqliteTable(
  'crm_leads',
  {
    id: text('id').primaryKey(),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'restrict' }),
    ownerStaffId: text('owner_staff_id')
      .notNull()
      .references(() => staffAccounts.id, { onDelete: 'restrict' }),
    residentUserId: text('resident_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    contactName: text('contact_name').notNull(),
    contactPhone: text('contact_phone').notNull(),
    sourceType: text('source_type').$type<CrmLeadSourceType>().notNull(),
    sourceActivityId: text('source_activity_id').references(() => activities.id, {
      onDelete: 'restrict',
    }),
    promotionStaffId: text('promotion_staff_id').references(() => staffAccounts.id, {
      onDelete: 'set null',
    }),
    createdByStaffId: text('created_by_staff_id')
      .notNull()
      .references(() => staffAccounts.id, { onDelete: 'restrict' }),
    status: text('status').$type<CrmLeadStatus>().notNull(),
    nextContactAt: integer('next_contact_at', { mode: 'timestamp_ms' }),
    lastContactedAt: integer('last_contacted_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('crm_leads_community_owner_status_idx').on(
      table.communityId,
      table.ownerStaffId,
      table.status,
    ),
    index('crm_leads_next_contact_idx').on(table.nextContactAt),
    index('crm_leads_source_activity_idx').on(table.sourceActivityId),
    index('crm_leads_promotion_staff_idx').on(table.promotionStaffId),
  ],
)

/**
 * Append-only lead timeline (created / status changes / transfers / follow-ups).
 * The migration adds SQLite triggers that ABORT UPDATE and DELETE, following the
 * `activity_rule_versions` precedent, so even a buggy query cannot rewrite history.
 */
export const crmLeadEvents = sqliteTable(
  'crm_lead_events',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id')
      .notNull()
      .references(() => crmLeads.id, { onDelete: 'restrict' }),
    actorUserId: text('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    event: text('event').notNull(),
    fromStatus: text('from_status').$type<CrmLeadStatus>(),
    toStatus: text('to_status').$type<CrmLeadStatus>(),
    fromOwnerStaffId: text('from_owner_staff_id').references(() => staffAccounts.id, {
      onDelete: 'set null',
    }),
    toOwnerStaffId: text('to_owner_staff_id').references(() => staffAccounts.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('crm_lead_events_lead_created_idx').on(table.leadId, table.createdAt),
  ],
)

/**
 * Follow-up records are append-only. `next_contact_at` is copied onto the lead as
 * the current reminder when the follow-up is written.
 */
export const crmFollowUps = sqliteTable(
  'crm_follow_ups',
  {
    id: text('id').primaryKey(),
    leadId: text('lead_id')
      .notNull()
      .references(() => crmLeads.id, { onDelete: 'restrict' }),
    staffId: text('staff_id')
      .notNull()
      .references(() => staffAccounts.id, { onDelete: 'restrict' }),
    content: text('content').notNull(),
    nextContactAt: integer('next_contact_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('crm_follow_ups_lead_created_idx').on(table.leadId, table.createdAt),
    index('crm_follow_ups_staff_created_idx').on(table.staffId, table.createdAt),
  ],
)

/**
 * Carrier acceptance orders for 广电手机卡/电视. Attribution and source are frozen
 * at creation (`attributed_staff_id`, `source_activity_id`, `promotion_staff_id`);
 * transferring the lead later must not move this order.
 *
 * `status = confirmed` means an operator manually verified a real deal; it is not
 * carrier activation. No activation API/commission automation exists in this MVP.
 */
export const crmServiceOrders = sqliteTable(
  'crm_service_orders',
  {
    id: text('id').primaryKey(),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'restrict' }),
    leadId: text('lead_id')
      .notNull()
      .references(() => crmLeads.id, { onDelete: 'restrict' }),
    orderNo: text('order_no').notNull(),
    businessType: text('business_type').$type<CrmBusinessType>().notNull(),
    status: text('status').$type<CrmServiceOrderStatus>().notNull(),
    customerName: text('customer_name').notNull(),
    contactPhone: text('contact_phone').notNull(),
    evidenceRef: text('evidence_ref'),
    notes: text('notes'),
    createdByStaffId: text('created_by_staff_id')
      .notNull()
      .references(() => staffAccounts.id, { onDelete: 'restrict' }),
    attributedStaffId: text('attributed_staff_id')
      .notNull()
      .references(() => staffAccounts.id, { onDelete: 'restrict' }),
    sourceActivityId: text('source_activity_id').references(() => activities.id, {
      onDelete: 'restrict',
    }),
    promotionStaffId: text('promotion_staff_id').references(() => staffAccounts.id, {
      onDelete: 'set null',
    }),
    confirmedByUserId: text('confirmed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    confirmedAt: integer('confirmed_at', { mode: 'timestamp_ms' }),
    confirmationNote: text('confirmation_note'),
    failureReason: text('failure_reason'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('crm_service_orders_community_order_no_uq').on(
      table.communityId,
      table.orderNo,
    ),
    index('crm_service_orders_community_status_idx').on(table.communityId, table.status),
    index('crm_service_orders_lead_idx').on(table.leadId),
    index('crm_service_orders_attributed_staff_idx').on(table.attributedStaffId),
    index('crm_service_orders_business_type_idx').on(table.businessType),
  ],
)

/** Append-only order timeline; same UPDATE/DELETE ABORT triggers as lead events. */
export const crmOrderEvents = sqliteTable(
  'crm_order_events',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => crmServiceOrders.id, { onDelete: 'restrict' }),
    actorUserId: text('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    event: text('event').notNull(),
    fromStatus: text('from_status').$type<CrmServiceOrderStatus>(),
    toStatus: text('to_status').$type<CrmServiceOrderStatus>(),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('crm_order_events_order_created_idx').on(table.orderId, table.createdAt),
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

/* -------------------------------------------------------------------------- */
/* CRMEB adapter domain (LL-MVP-007, Issue #63)                               */
/* -------------------------------------------------------------------------- */

/**
 * Platform UUID -> CRMEB uid mapping. CRMEB exposes no signed identity
 * assertion, so the only accepted verification is a staff member manually
 * checking the link. Browsers can never write this table directly; only the
 * audited admin endpoint inserts rows.
 */
export const crmebIdentities = sqliteTable(
  'crmeb_identities',
  {
    id: text('id').primaryKey(),
    platformUserId: text('platform_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    crmebUid: integer('crmeb_uid').notNull(),
    status: text('status').$type<'active' | 'revoked'>().notNull(),
    verificationMethod: text('verification_method')
      .$type<CrmebIdentityVerificationMethod>()
      .notNull(),
    verificationNote: text('verification_note'),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('crmeb_identities_platform_user_uq').on(table.platformUserId),
    uniqueIndex('crmeb_identities_crmeb_uid_uq').on(table.crmebUid),
    index('crmeb_identities_created_by_idx').on(table.createdByUserId),
  ],
)

/**
 * Pull-based order mirror. CRMEB's numeric `id` is the stable identity
 * (`channel, external_order_id` unique). `order_id` is the human-facing business
 * number: it is indexed for lookup/collision detection but NOT the key, so a
 * reused `order_id` can never silently overwrite the row owned by another id.
 */
export const crmebOrders = sqliteTable(
  'crmeb_orders',
  {
    id: text('id').primaryKey(),
    channel: text('channel').$type<'crmeb'>().notNull(),
    externalOrderId: integer('external_order_id').notNull(),
    externalOrderNo: text('external_order_no').notNull(),
    crmebUid: integer('crmeb_uid'),
    platformUserId: text('platform_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    payType: text('pay_type'),
    payAmountCents: integer('pay_amount_cents').notNull(),
    paid: integer('paid', { mode: 'boolean' }).notNull(),
    status: text('status').$type<CrmebOrderStatus>().notNull(),
    /** Raw CRMEB `status` integer; kept for audit, never used as an enum. */
    rawStatus: integer('raw_status').notNull(),
    refundStatus: integer('refund_status'),
    validTransaction: integer('valid_transaction', { mode: 'boolean' }).notNull(),
    rawHash: text('raw_hash').notNull(),
    itemsJson: text('items_json'),
    orderedAt: integer('ordered_at', { mode: 'timestamp_ms' }),
    paidAt: integer('paid_at', { mode: 'timestamp_ms' }),
    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('crmeb_orders_channel_order_no_idx').on(table.channel, table.externalOrderNo),
    uniqueIndex('crmeb_orders_channel_order_id_uq').on(table.channel, table.externalOrderId),
    index('crmeb_orders_crmeb_uid_idx').on(table.crmebUid),
    index('crmeb_orders_platform_user_idx').on(table.platformUserId),
    index('crmeb_orders_valid_transaction_idx').on(table.validTransaction),
  ],
)

/**
 * Append-only order state events. The unique `(order_id, event_key)` pair is the
 * dedupe key; SQLite triggers make UPDATE/DELETE impossible even for buggy code.
 */
export const crmebOrderEvents = sqliteTable(
  'crmeb_order_events',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => crmebOrders.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    payloadJson: text('payload_json'),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('crmeb_order_events_order_event_uq').on(table.orderId, table.eventKey),
    index('crmeb_order_events_order_idx').on(table.orderId),
    index('crmeb_order_events_occurred_idx').on(table.occurredAt),
  ],
)

/**
 * Refund/after-sale mirror (`GET /outapi/refund/list`). Refund numbers are
 * independent from order numbers: `store_order_id` points at `crmeb_orders.id`
 * while the refund's own `order_id` becomes `external_refund_no`.
 */
export const crmebRefunds = sqliteTable(
  'crmeb_refunds',
  {
    id: text('id').primaryKey(),
    channel: text('channel').$type<'crmeb'>().notNull(),
    externalRefundId: integer('external_refund_id').notNull(),
    externalRefundNo: text('external_refund_no').notNull(),
    externalOrderId: integer('external_order_id').notNull(),
    refundType: integer('refund_type').notNull(),
    refundAmountCents: integer('refund_amount_cents').notNull(),
    refundedAmountCents: integer('refunded_amount_cents').notNull(),
    refundedAt: integer('refunded_at', { mode: 'timestamp_ms' }),
    addTime: integer('add_time', { mode: 'timestamp_ms' }),
    rawHash: text('raw_hash').notNull(),
    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('crmeb_refunds_channel_refund_no_uq').on(
      table.channel,
      table.externalRefundNo,
    ),
    uniqueIndex('crmeb_refunds_channel_refund_id_uq').on(
      table.channel,
      table.externalRefundId,
    ),
    index('crmeb_refunds_order_idx').on(table.externalOrderId),
  ],
)

/**
 * Click/attribution claim. The browser may only supply an activity id, product
 * id and an opaque referral code; the server resolves the staff, checks the
 * community assignment and writes `claimed`/`unconfirmed`. `confirmed` is
 * reserved for a future audited verification path and is never written here.
 */
export const crmebClickAttributions = sqliteTable(
  'crmeb_click_attributions',
  {
    id: text('id').primaryKey(),
    clickId: text('click_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Null for natural purchases that carry no activity context.
    activityId: text('activity_id').references(() => activities.id, {
      onDelete: 'restrict',
    }),
    crmebProductId: integer('crmeb_product_id').notNull(),
    claimedStaffId: text('claimed_staff_id').references(() => staffAccounts.id, {
      onDelete: 'set null',
    }),
    claimState: text('claim_state').$type<CrmebAttributionClaimState>().notNull(),
    referralCodeHash: text('referral_code_hash'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('crmeb_click_attributions_click_uq').on(table.clickId),
    index('crmeb_click_attributions_user_idx').on(table.userId),
    index('crmeb_click_attributions_activity_idx').on(table.activityId),
    index('crmeb_click_attributions_staff_idx').on(table.claimedStaffId),
    // A staff id must never be attached to an unconfirmed/revoked claim.
    check(
      'crmeb_click_attributions_staff_claim_check',
      sql`${table.claimedStaffId} IS NULL OR ${table.claimState} = 'claimed'`,
    ),
  ],
)

/** Audit trail for each pull-sync run: window, counts, cursor, errors. */
export const crmebSyncRuns = sqliteTable(
  'crmeb_sync_runs',
  {
    id: text('id').primaryKey(),
    status: text('status').$type<'running' | 'succeeded' | 'failed'>().notNull(),
    trigger: text('trigger').$type<'admin_manual'>().notNull(),
    /** Real role of the triggering staff session, audited next to its user id. */
    actorRole: text('actor_role').$type<'admin'>().notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    scopeJson: text('scope_json').notNull(),
    cursorJson: text('cursor_json'),
    ordersScanned: integer('orders_scanned').notNull().default(0),
    ordersCreated: integer('orders_created').notNull().default(0),
    ordersUpdated: integer('orders_updated').notNull().default(0),
    ordersUnchanged: integer('orders_unchanged').notNull().default(0),
    ordersFailed: integer('orders_failed').notNull().default(0),
    refundsScanned: integer('refunds_scanned').notNull().default(0),
    refundsCreated: integer('refunds_created').notNull().default(0),
    refundsUpdated: integer('refunds_updated').notNull().default(0),
    refundsUnchanged: integer('refunds_unchanged').notNull().default(0),
    refundsUnmatched: integer('refunds_unmatched').notNull().default(0),
    validTransactions: integer('valid_transactions').notNull().default(0),
    eventsAppended: integer('events_appended').notNull().default(0),
    errorsJson: text('errors_json'),
    errorMessage: text('error_message'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('crmeb_sync_runs_started_idx').on(table.startedAt),
    index('crmeb_sync_runs_status_idx').on(table.status),
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
  crmLeads,
  crmLeadEvents,
  crmFollowUps,
  crmServiceOrders,
  crmOrderEvents,
  activityTeams,
  activityInvitations,
  activityParticipations,
  crmebIdentities,
  crmebOrders,
  crmebOrderEvents,
  crmebRefunds,
  crmebClickAttributions,
  crmebSyncRuns,
}
