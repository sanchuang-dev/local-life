import { relations, sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
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
  CheckinStatus,
  LedgerAnomalyKind,
  LedgerAnomalySeverity,
  LedgerAttributionBasis,
  LedgerAttributionState,
  LedgerEvidenceKind,
  LedgerFactKind,
  LedgerSourceSystem,
  ParticipationInviteSource,
  ParticipationRole,
  ParticipationTeamStatus,
  PhoneOtpPurpose,
  ReconciliationBatchStatus,
  RewardCredentialStatus,
  RewardDisputeDecision,
  RewardEventKind,
  RewardGrantStatus,
  RewardRecipientRole,
  SettlementAmountStatus,
  LocalOrderEventType,
  LocalOrderRecordSource,
  LocalOrderStatus,
  LocalProductStatus,
  WechatAccountType,
  WechatConfigStatus,
} from '@sanchuang-dev/local-life-contracts'
import { LOCAL_ORDER_EVENT_SOURCE_TYPE } from '@sanchuang-dev/local-life-contracts'

export type StaffRole = 'admin' | 'operator' | 'grid_worker'
export type StaffStatus = 'active' | 'disabled'

export const communities = sqliteTable('communities', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  address: text('address'),
  latitudeGcj02: real('latitude_gcj02'),
  longitudeGcj02: real('longitude_gcj02'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Browser-visible Tencent LBS key, admin-managed in SQLite (no environment snapshot). */
export const tencentMapConfigs = sqliteTable('tencent_map_configs', {
  id: text('id').primaryKey(),
  apiKey: text('api_key').notNull(),
  appName: text('app_name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
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
    /** Optional resident-consented profile fields; never copied to users.displayName. */
    nickname: text('nickname'),
    avatarUrl: text('avatar_url'),
    profileAuthorizedAt: integer('profile_authorized_at', { mode: 'timestamp_ms' }),
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

/**
 * Versioned WeChat public-account credentials for resident web OAuth (#113).
 *
 * Every save creates a new row; nothing is ever updated in place except the
 * lifecycle columns. That is what makes an in-flight OAuth attempt bindable to
 * the exact credentials it started with instead of silently consuming a code
 * with a newer AppSecret.
 *
 * Storage rules enforced on disk:
 * - the AppSecret exists only as AES-256-GCM `ciphertext`/`iv`/`tag` (base64).
 *   There is deliberately no plaintext secret column, so a schema mistake
 *   cannot quietly persist one.
 * - the IV is 12 bytes (16 base64 chars) and the GCM tag 16 bytes (24 base64
 *   chars); CHECK constraints reject any other shape.
 * - `wechat_oauth_configs_active_uq` is a partial unique index on `status`
 *   `WHERE status = 'active'`, so the database itself refuses a second active
 *   provider even if application code is bypassed.
 * - `key_id` names the master-key generation used to encrypt this row. Rotating
 *   the key never rewrites history; a row whose key id no longer matches fails
 *   closed at decryption time.
 * - the lifecycle CHECK keeps status and its timestamps consistent: `active`
 *   carries verified+activated stamps, `retired` always carries `retired_at`
 *   (and keeps the earlier stamps as history).
 */
export const wechatOauthConfigs = sqliteTable(
  'wechat_oauth_configs',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    accountType: text('account_type').$type<WechatAccountType>().notNull(),
    /** AES-256-GCM ciphertext, base64. Never a plaintext AppSecret. */
    appSecretCiphertext: text('app_secret_ciphertext').notNull(),
    appSecretIv: text('app_secret_iv').notNull(),
    appSecretTag: text('app_secret_tag').notNull(),
    keyId: text('key_id').notNull(),
    status: text('status').$type<WechatConfigStatus>().notNull(),
    /**
     * Redacted failure category (`wechatConfigFailureCodeSchema`). A raw WeChat
     * error payload / access token is never stored here.
     */
    lastErrorCode: text('last_error_code'),
    verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
    activatedAt: integer('activated_at', { mode: 'timestamp_ms' }),
    retiredAt: integer('retired_at', { mode: 'timestamp_ms' }),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    // The single runtime provider: a partial unique index, not a convention.
    uniqueIndex('wechat_oauth_configs_active_uq')
      .on(table.status)
      .where(sql`${table.status} = 'active'`),
    index('wechat_oauth_configs_status_created_idx').on(table.status, table.createdAt),
    index('wechat_oauth_configs_created_idx').on(table.createdAt),
    check(
      'wechat_oauth_configs_account_type_check',
      sql`${table.accountType} IN ('test', 'official')`,
    ),
    check(
      'wechat_oauth_configs_status_check',
      sql`${table.status} IN ('draft', 'verified', 'failed', 'active', 'retired')`,
    ),
    check(
      'wechat_oauth_configs_app_id_check',
      sql`length(${table.appId}) BETWEEN 6 AND 64
        AND ${table.appId} NOT GLOB '*[^A-Za-z0-9]*'`,
    ),
    check(
      'wechat_oauth_configs_iv_check',
      sql`length(${table.appSecretIv}) = 16
        AND ${table.appSecretIv} NOT GLOB '*[^A-Za-z0-9+/=]*'`,
    ),
    check(
      'wechat_oauth_configs_tag_check',
      sql`length(${table.appSecretTag}) = 24
        AND ${table.appSecretTag} NOT GLOB '*[^A-Za-z0-9+/=]*'`,
    ),
    check(
      'wechat_oauth_configs_ciphertext_check',
      sql`length(${table.appSecretCiphertext}) > 0
        AND ${table.appSecretCiphertext} NOT GLOB '*[^A-Za-z0-9+/=]*'`,
    ),
    check(
      'wechat_oauth_configs_key_id_check',
      sql`length(${table.keyId}) BETWEEN 1 AND 32
        AND ${table.keyId} NOT GLOB '*[^A-Za-z0-9._-]*'`,
    ),
    check(
      'wechat_oauth_configs_lifecycle_check',
      sql`(${table.status} = 'active'
          AND ${table.verifiedAt} IS NOT NULL
          AND ${table.activatedAt} IS NOT NULL
          AND ${table.retiredAt} IS NULL)
        OR (${table.status} = 'retired'
          AND ${table.retiredAt} IS NOT NULL)
        OR (${table.status} = 'verified'
          AND ${table.verifiedAt} IS NOT NULL
          AND ${table.activatedAt} IS NULL
          AND ${table.retiredAt} IS NULL)
        OR (${table.status} IN ('draft', 'failed')
          AND ${table.verifiedAt} IS NULL
          AND ${table.activatedAt} IS NULL
          AND ${table.retiredAt} IS NULL)`,
    ),
  ],
)

export const oauthStates = sqliteTable(
  'oauth_states',
  {
    id: text('id').primaryKey(),
    stateHash: text('state_hash').notNull(),
    nonceHash: text('nonce_hash').notNull(),
    communityId: text('community_id').references(() => communities.id, { onDelete: 'set null' }),
    /**
     * The exact WeChat config version this OAuth attempt started with (#113).
     * Nullable so every row written before the feature keeps working; SET NULL
     * so removing a version can never strand or mis-bind an in-flight attempt.
     */
    configId: text('config_id').references(() => wechatOauthConfigs.id, {
      onDelete: 'set null',
    }),
    /** Null on legacy rows, which remain ordinary login attempts. */
    purpose: text('purpose').$type<'login' | 'profile'>(),
    /** Present only for an explicitly user-consented profile authorization. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('oauth_state_hash_uq').on(table.stateHash),
    index('oauth_state_expiry_idx').on(table.expiresAt),
    index('oauth_state_config_idx').on(table.configId),
    index('oauth_state_user_purpose_idx').on(table.userId, table.purpose),
    check(
      'oauth_state_purpose_check',
      sql`${table.purpose} IS NULL OR ${table.purpose} IN ('login', 'profile')`,
    ),
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

/* -------------------------------------------------------------------------- */
/* Phone (SMS one-time code) resident identity (#93 LL-H5-002)                 */
/* -------------------------------------------------------------------------- */

/**
 * Verified phone -> platform user mapping. The platform UUID stays the single
 * business key: every participation, reward grant and session still points at
 * `users.id`, so verifying a phone can never move existing attribution.
 *
 * Two UNIQUE indexes carry the identity rules on disk:
 * - `phone` is unique, so one phone is at most one resident account. A second
 *   account claiming the same phone is rejected by the database, never merged.
 * - `user_id` is unique, so one resident account owns at most one verified
 *   phone (replacing it is a separate, audited operation, not a silent rebind).
 *
 * `phone` is the canonical 11-digit mainland form written by the API; the CHECK
 * constraint rejects any other shape even if application code is bypassed.
 */
export const residentPhoneIdentities = sqliteTable(
  'resident_phone_identities',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('resident_phone_identities_phone_uq').on(table.phone),
    uniqueIndex('resident_phone_identities_user_uq').on(table.userId),
    check(
      'resident_phone_identities_phone_check',
      sql`length(${table.phone}) = 11
        AND ${table.phone} NOT GLOB '*[^0-9]*'
        AND substr(${table.phone}, 1, 1) = '1'
        AND substr(${table.phone}, 2, 1) BETWEEN '3' AND '9'`,
    ),
  ],
)

/**
 * One-time verification codes. Only a salted SHA-256 hash is stored; the
 * plaintext exists in exactly one SMS payload and never in a response, log or
 * audit row.
 *
 * `attempts` is capped by `max_attempts` (CHECK), and consumption is a single
 * conditional UPDATE (`consumed_at IS NULL AND invalidated_at IS NULL`), so two
 * concurrent verifications can never both win. Codes are single-purpose:
 * a `login` code cannot bind and a `bind` code cannot log in.
 */
export const phoneVerificationCodes = sqliteTable(
  'phone_verification_codes',
  {
    id: text('id').primaryKey(),
    phone: text('phone').notNull(),
    purpose: text('purpose').$type<PhoneOtpPurpose>().notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    invalidatedAt: integer('invalidated_at', { mode: 'timestamp_ms' }),
    /** Hash of the requesting IP: frequency control must not store raw IPs. */
    requestIpHash: text('request_ip_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('phone_verification_codes_phone_purpose_idx').on(
      table.phone,
      table.purpose,
      table.createdAt,
    ),
    index('phone_verification_codes_expiry_idx').on(table.expiresAt),
    check(
      'phone_verification_codes_purpose_check',
      sql`${table.purpose} IN ('login', 'bind')`,
    ),
    check(
      'phone_verification_codes_hash_check',
      sql`length(${table.codeHash}) = 64 AND ${table.codeHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      'phone_verification_codes_attempts_check',
      sql`${table.attempts} >= 0
        AND ${table.maxAttempts} > 0
        AND ${table.attempts} <= ${table.maxAttempts}`,
    ),
    check(
      'phone_verification_codes_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
)

/**
 * Fixed-window request counters keyed by a hashed scope (`phone` or `IP`), so the
 * throttle table holds no phone number and no address. Windows are bucketed by
 * the clock; an expired bucket simply restarts at 1.
 */
export const phoneOtpRequestCounters = sqliteTable(
  'phone_otp_request_counters',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    windowStartedAt: integer('window_started_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    check('phone_otp_request_counters_count_check', sql`${table.count} >= 0`),
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
    /**
     * Mutable current copy of the prize fulfilment plan (LL-MVP-006). Only the
     * frozen copy inside a rule-version snapshot may drive fulfilment; this
     * column exists so a draft can be edited without a version, and is NULL for
     * every activity that has no plan.
     */
    rewardPlanJson: text('reward_plan_json'),
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
 * Append-only order timeline events.
 *
 * `sequence` is a per-order monotonically increasing revision that carries the
 * dedupe/uniqueness guarantee. `event_key` is only a readable stream label
 * (`order` for the order snapshot, `refund:<refund_no>` for a refund snapshot),
 * so a state that returns to an earlier combination (paid → refunding → paid)
 * still appends a new row instead of colliding with history. The adapter only
 * appends when the new complete snapshot differs from the latest event in the
 * same stream; SQLite triggers make UPDATE/DELETE impossible even for buggy code.
 */
export const crmebOrderEvents = sqliteTable(
  'crmeb_order_events',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => crmebOrders.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    eventKey: text('event_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    payloadJson: text('payload_json'),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('crmeb_order_events_order_sequence_uq').on(table.orderId, table.sequence),
    index('crmeb_order_events_order_event_idx').on(table.orderId, table.eventKey),
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


/* -------------------------------------------------------------------------- */
/* Check-in, team reward and prize fulfilment (LL-MVP-006, Issue #62)         */
/* -------------------------------------------------------------------------- */

/**
 * A real, on-site check-in. Only `status = 'valid'` with `verified_at` set counts
 * towards the three-check-in requirement; a revoked row stays behind as history
 * and stops counting. `(activity_id, user_id)` is unique among valid rows, so a
 * resident can never bank two live check-ins in one activity, while revoking one
 * still allows a later re-check-in.
 */
export const activityCheckins = sqliteTable(
  'activity_checkins',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Frozen at insert: the team the resident belonged to when checking in. */
    teamId: text('team_id').references(() => activityTeams.id, { onDelete: 'restrict' }),
    seatNo: integer('seat_no'),
    status: text('status').$type<CheckinStatus>().notNull(),
    note: text('note'),
    checkedInAt: integer('checked_in_at', { mode: 'timestamp_ms' }).notNull(),
    verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
    verifiedByStaffId: text('verified_by_staff_id').references(() => staffAccounts.id, {
      onDelete: 'restrict',
    }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    revokedByStaffId: text('revoked_by_staff_id').references(() => staffAccounts.id, {
      onDelete: 'restrict',
    }),
    revokeReason: text('revoke_reason'),
  },
  (table) => [
    // At most one *valid* check-in per resident per activity (partial index).
    uniqueIndex('activity_checkins_activity_user_valid_uq')
      .on(table.activityId, table.userId)
      .where(sql`${table.status} = 'valid'`),
    index('activity_checkins_activity_status_idx').on(table.activityId, table.status),
    index('activity_checkins_user_idx').on(table.userId),
    index('activity_checkins_team_idx').on(table.teamId),
    check('activity_checkins_status_check', sql`${table.status} IN ('valid', 'revoked')`),
    check(
      'activity_checkins_seat_no_check',
      sql`(${table.teamId} IS NULL AND ${table.seatNo} IS NULL)
        OR (${table.teamId} IS NOT NULL AND ${table.seatNo} BETWEEN 1 AND 3)`,
    ),
    // A revoked check-in must carry the full revocation stamp, a valid one none.
    check(
      'activity_checkins_revocation_check',
      sql`(${table.status} = 'revoked'
          AND ${table.revokedAt} IS NOT NULL
          AND ${table.revokedByStaffId} IS NOT NULL
          AND ${table.revokeReason} IS NOT NULL
          AND length(trim(${table.revokeReason})) >= 2)
        OR (${table.status} = 'valid'
          AND ${table.revokedAt} IS NULL
          AND ${table.revokedByStaffId} IS NULL
          AND ${table.revokeReason} IS NULL)`,
    ),
    // Verification stamp is all-or-nothing.
    check(
      'activity_checkins_verification_check',
      sql`(${table.verifiedAt} IS NULL AND ${table.verifiedByStaffId} IS NULL)
        OR (${table.verifiedAt} IS NOT NULL AND ${table.verifiedByStaffId} IS NOT NULL)`,
    ),
  ],
)

/**
 * Exactly one grant per (activity, frozen rule version, team). The unique key is
 * what makes "3 seats + 3 check-ins arrive concurrently" safe: the second claim
 * loses at the index, not in application code.
 *
 * `unit_cost_cents`, `quantity` and `prize_name` are copied from the frozen rule
 * version snapshot at grant time, so a later edit of the activity row can never
 * re-price an issued prize.
 */
export const activityRewardGrants = sqliteTable(
  'activity_reward_grants',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'restrict' }),
    ruleVersionId: text('rule_version_id')
      .notNull()
      .references(() => activityRuleVersions.id, { onDelete: 'restrict' }),
    teamId: text('team_id')
      .notNull()
      .references(() => activityTeams.id, { onDelete: 'restrict' }),
    prizeName: text('prize_name').notNull(),
    quantity: integer('quantity').notNull(),
    unitCostCents: integer('unit_cost_cents').notNull(),
    totalCostCents: integer('total_cost_cents').notNull(),
    status: text('status').$type<RewardGrantStatus>().notNull(),
    /** Who may present the credential: the leader or any team member. */
    recipientRole: text('recipient_role').$type<RewardRecipientRole>().notNull(),
    recipientUserId: text('recipient_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    grantedAt: integer('granted_at', { mode: 'timestamp_ms' }).notNull(),
    redeemedAt: integer('redeemed_at', { mode: 'timestamp_ms' }),
    redeemedByStaffId: text('redeemed_by_staff_id').references(() => staffAccounts.id, {
      onDelete: 'restrict',
    }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    revokedByStaffId: text('revoked_by_staff_id').references(() => staffAccounts.id, {
      onDelete: 'restrict',
    }),
    revokeReason: text('revoke_reason'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    // "One team, one activity, one prize" — deliberately NOT scoped to the rule
    // version: an edit bumps the version, and a version-scoped key let the same
    // team be granted a second physical prize after any rule change.
    // Partial on `status <> 'revoked'` so withdrawing an unredeemed grant frees
    // the slot for a corrected re-grant; every other status keeps it occupied.
    uniqueIndex('activity_reward_grants_activity_team_uq')
      .on(table.activityId, table.teamId)
      .where(sql`${table.status} <> 'revoked'`),
    index('activity_reward_grants_activity_status_idx').on(table.activityId, table.status),
    index('activity_reward_grants_team_idx').on(table.teamId),
    index('activity_reward_grants_recipient_idx').on(table.recipientUserId),
    check(
      'activity_reward_grants_status_check',
      sql`${table.status} IN ('granted', 'redeemed', 'revoked', 'expired', 'disputed', 'reversed')`,
    ),
    check('activity_reward_grants_quantity_check', sql`${table.quantity} > 0`),
    check('activity_reward_grants_unit_cost_check', sql`${table.unitCostCents} > 0`),
    check(
      'activity_reward_grants_total_cost_check',
      sql`${table.totalCostCents} = ${table.quantity} * ${table.unitCostCents}`,
    ),
    check(
      'activity_reward_grants_recipient_role_check',
      sql`${table.recipientRole} IN ('leader', 'member')`,
    ),
    check(
      'activity_reward_grants_revocation_check',
      sql`(${table.status} = 'revoked'
          AND ${table.revokedAt} IS NOT NULL
          AND ${table.revokedByStaffId} IS NOT NULL
          AND ${table.revokeReason} IS NOT NULL)
        OR (${table.status} <> 'revoked'
          AND ${table.revokedAt} IS NULL
          AND ${table.revokedByStaffId} IS NULL
          AND ${table.revokeReason} IS NULL)`,
    ),
    // A redeemed prize keeps its redemption stamp even when it is later disputed
    // or reversed: reversal is expressed by dispute/event rows, not by erasing
    // the redemption.
    check(
      'activity_reward_grants_redemption_check',
      sql`(${table.status} IN ('redeemed', 'disputed', 'reversed')
          AND ${table.redeemedAt} IS NOT NULL
          AND ${table.redeemedByStaffId} IS NOT NULL)
        OR (${table.status} IN ('granted', 'revoked', 'expired')
          AND ${table.redeemedAt} IS NULL
          AND ${table.redeemedByStaffId} IS NULL)`,
    ),
  ],
)

/**
 * One-time redemption credential. Only the sha256 hash is stored; the plaintext
 * code exists in exactly one API response. At most one credential per grant may
 * be `active` (partial unique index), and re-issuing supersedes the old row
 * instead of deleting or overwriting it.
 */
export const activityRewardCodes = sqliteTable(
  'activity_reward_codes',
  {
    id: text('id').primaryKey(),
    grantId: text('grant_id')
      .notNull()
      .references(() => activityRewardGrants.id, { onDelete: 'restrict' }),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'restrict' }),
    teamId: text('team_id')
      .notNull()
      .references(() => activityTeams.id, { onDelete: 'restrict' }),
    codeHash: text('code_hash').notNull(),
    /** Last four characters, so staff can confirm the paper slip. */
    codeSuffix: text('code_suffix').notNull(),
    prizeName: text('prize_name').notNull(),
    status: text('status').$type<RewardCredentialStatus>().notNull(),
    issuedAt: integer('issued_at', { mode: 'timestamp_ms' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    redeemedAt: integer('redeemed_at', { mode: 'timestamp_ms' }),
    redeemedByStaffId: text('redeemed_by_staff_id').references(() => staffAccounts.id, {
      onDelete: 'restrict',
    }),
    supersededAt: integer('superseded_at', { mode: 'timestamp_ms' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('activity_reward_codes_hash_uq').on(table.codeHash),
    // At most one live credential per grant.
    uniqueIndex('activity_reward_codes_grant_active_uq')
      .on(table.grantId)
      .where(sql`${table.status} = 'active'`),
    index('activity_reward_codes_activity_status_idx').on(table.activityId, table.status),
    index('activity_reward_codes_grant_idx').on(table.grantId),
    check(
      'activity_reward_codes_status_check',
      sql`${table.status} IN ('active', 'redeemed', 'superseded', 'expired', 'revoked')`,
    ),
    check(
      'activity_reward_codes_hash_check',
      sql`length(${table.codeHash}) = 64 AND ${table.codeHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      'activity_reward_codes_suffix_check',
      sql`length(${table.codeSuffix}) = 4 AND ${table.codeSuffix} NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'`,
    ),
    check(
      'activity_reward_codes_expiry_check',
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
    check(
      'activity_reward_codes_redemption_check',
      sql`(${table.status} = 'redeemed'
          AND ${table.redeemedAt} IS NOT NULL
          AND ${table.redeemedByStaffId} IS NOT NULL)
        OR (${table.status} <> 'redeemed'
          AND ${table.redeemedAt} IS NULL
          AND ${table.redeemedByStaffId} IS NULL)`,
    ),
    check(
      'activity_reward_codes_superseded_check',
      sql`(${table.status} = 'superseded' AND ${table.supersededAt} IS NOT NULL)
        OR (${table.status} <> 'superseded' AND ${table.supersededAt} IS NULL)`,
    ),
    check(
      'activity_reward_codes_revoked_check',
      sql`(${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)
        OR (${table.status} <> 'revoked' AND ${table.revokedAt} IS NULL)`,
    ),
  ],
)

/**
 * Stock and budget occupancy of one frozen rule version. `unit_cost_cents`,
 * `budget_cap_cents` and `total_quantity` are copied from the rule-version
 * snapshot, never read from the mutable activity row.
 *
 * `claimed_quantity` is the committed occupancy and `redeemed_quantity` the
 * handed-out count, so `claimed >= redeemed` always holds. Revoking an
 * unredeemed grant releases `claimed`; a reversed *redeemed* grant must NOT
 * lower `redeemed` (the reversal is expressed by the append-only dispute/event
 * rows), which keeps the ledger and the audit trail reconcilable.
 */
export const activityPrizeStocks = sqliteTable(
  'activity_prize_stocks',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'restrict' }),
    ruleVersionId: text('rule_version_id')
      .notNull()
      .references(() => activityRuleVersions.id, { onDelete: 'restrict' }),
    prizeName: text('prize_name').notNull(),
    unitCostCents: integer('unit_cost_cents').notNull(),
    totalQuantity: integer('total_quantity').notNull(),
    claimedQuantity: integer('claimed_quantity').notNull().default(0),
    redeemedQuantity: integer('redeemed_quantity').notNull().default(0),
    budgetCapCents: integer('budget_cap_cents').notNull(),
    committedBudgetCents: integer('committed_budget_cents').notNull().default(0),
    redeemedBudgetCents: integer('redeemed_budget_cents').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    // One ledger per activity and prize, NOT per rule version: a version-scoped
    // ledger let every new version start at `claimed_quantity = 0`, silently
    // multiplying total quantity and budget cap by the number of edits.
    // `rule_version_id` stays on the row as the price provenance only.
    uniqueIndex('activity_prize_stocks_activity_prize_uq').on(
      table.activityId,
      table.prizeName,
    ),
    index('activity_prize_stocks_activity_idx').on(table.activityId),
    check(
      'activity_prize_stocks_unit_cost_check',
      sql`${table.unitCostCents} > 0 AND ${table.totalQuantity} > 0 AND ${table.budgetCapCents} > 0`,
    ),
    check(
      'activity_prize_stocks_quantity_check',
      sql`${table.claimedQuantity} >= 0
        AND ${table.redeemedQuantity} >= 0
        AND ${table.claimedQuantity} <= ${table.totalQuantity}
        AND ${table.redeemedQuantity} <= ${table.claimedQuantity}`,
    ),
    check(
      'activity_prize_stocks_budget_check',
      sql`${table.committedBudgetCents} = ${table.claimedQuantity} * ${table.unitCostCents}
        AND ${table.redeemedBudgetCents} = ${table.redeemedQuantity} * ${table.unitCostCents}
        AND ${table.committedBudgetCents} <= ${table.budgetCapCents}`,
    ),
  ],
)

/**
 * Append-only fulfilment timeline per activity. `sequence` is monotonic inside
 * one activity, so two events written in the same millisecond still have a
 * deterministic order. UPDATE and DELETE are rejected by triggers in 0006.
 */
export const activityRewardEvents = sqliteTable(
  'activity_reward_events',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    kind: text('kind').$type<RewardEventKind>().notNull(),
    grantId: text('grant_id').references(() => activityRewardGrants.id, {
      onDelete: 'restrict',
    }),
    checkinId: text('checkin_id').references(() => activityCheckins.id, {
      onDelete: 'restrict',
    }),
    credentialId: text('credential_id').references(() => activityRewardCodes.id, {
      onDelete: 'restrict',
    }),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    actorStaffId: text('actor_staff_id').references(() => staffAccounts.id, {
      onDelete: 'restrict',
    }),
    detailJson: text('detail_json'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('activity_reward_events_activity_sequence_uq').on(
      table.activityId,
      table.sequence,
    ),
    index('activity_reward_events_activity_created_idx').on(table.activityId, table.createdAt),
    index('activity_reward_events_grant_idx').on(table.grantId),
    index('activity_reward_events_kind_idx').on(table.kind),
    check('activity_reward_events_sequence_check', sql`${table.sequence} > 0`),
    check(
      'activity_reward_events_kind_check',
      sql`${table.kind} IN ('checkin.verified', 'checkin.revoked', 'grant.created', 'grant.redeemed', 'grant.revoked', 'grant.expired', 'credential.issued', 'credential.superseded', 'dispute.opened', 'dispute.reversed', 'dispute.dismissed')`,
    ),
  ],
)

/**
 * Dispute / manual-reversal thread of one grant, expressed purely as appended
 * rows: `opened` first, then at most one terminal `reversed` or `dismissed`
 * entry. Nothing is ever updated or deleted, so the original decision stays
 * auditable even after a reversal.
 */
export const activityRewardDisputes = sqliteTable(
  'activity_reward_disputes',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'restrict' }),
    grantId: text('grant_id')
      .notNull()
      .references(() => activityRewardGrants.id, { onDelete: 'restrict' }),
    decision: text('decision').$type<RewardDisputeDecision>().notNull(),
    reason: text('reason').notNull(),
    note: text('note'),
    actorStaffId: text('actor_staff_id').references(() => staffAccounts.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('activity_reward_disputes_grant_created_idx').on(table.grantId, table.createdAt),
    index('activity_reward_disputes_activity_idx').on(table.activityId),
    check(
      'activity_reward_disputes_decision_check',
      sql`${table.decision} IN ('opened', 'reversed', 'dismissed')`,
    ),
    check(
      'activity_reward_disputes_reason_check',
      sql`length(trim(${table.reason})) >= 2`,
    ),
  ],
)

/* -------------------------------------------------------------------------- */
/* Local product catalogue & resident orders (#109 LL-MVP-010)                 */
/* -------------------------------------------------------------------------- */

/**
 * A *local* product: a real row owned by one community, priced in integer cents.
 *
 * This is not a CRMEB mirror row (`crmeb_orders` / `crmeb_identities` are
 * pull-only reflections of an external shop) and it has nothing to do with the
 * 广电 carrier orders in `crm_service_orders`. Taking a product off the shelf
 * only blocks *new* registrations: `local_orders` keeps its own frozen snapshot.
 */
export const localProducts = sqliteTable(
  'local_products',
  {
    id: text('id').primaryKey(),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    summary: text('summary'),
    description: text('description'),
    category: text('category'),
    unitPriceCents: integer('unit_price_cents').notNull(),
    imageUrl: text('image_url'),
    status: text('status').$type<LocalProductStatus>().notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('local_products_community_status_idx').on(table.communityId, table.status),
    index('local_products_community_updated_idx').on(table.communityId, table.updatedAt),
    check('local_products_price_check', sql`${table.unitPriceCents} >= 0`),
    check(
      'local_products_status_check',
      sql`${table.status} IN ('on_shelf', 'off_shelf')`,
    ),
  ],
)

/**
 * A resident's registration of intent for one local product.
 *
 * Every value the client could lie about is frozen here at insert time:
 * `product_name` / `unit_price_cents` / `quantity` / `total_cents` are a
 * server-computed snapshot, and `community_id` is the product's community, not
 * whatever the caller sent. `(community_id, resident_user_id, idempotency_key)`
 * is UNIQUE, so a replay — even a concurrent one — can only ever produce one row.
 *
 * `status = verified` means an operations human checked the fact. It is NOT
 * payment and NOT activation: there is deliberately no payment/activation column.
 */
export const localOrders = sqliteTable(
  'local_orders',
  {
    id: text('id').primaryKey(),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'restrict' }),
    productId: text('product_id')
      .notNull()
      .references(() => localProducts.id, { onDelete: 'restrict' }),
    residentUserId: text('resident_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').$type<LocalOrderStatus>().notNull(),
    recordSource: text('record_source').$type<LocalOrderRecordSource>().notNull(),
    // Frozen product snapshot: later catalogue edits must not rewrite this order.
    productName: text('product_name').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    quantity: integer('quantity').notNull(),
    totalCents: integer('total_cents').notNull(),
    note: text('note'),
    /** Staff member who recorded the order on behalf of the resident; null for self-service. */
    createdByStaffId: text('created_by_staff_id').references(() => staffAccounts.id, {
      onDelete: 'set null',
    }),
    /** Optional grid-worker attribution frozen at registration. */
    attributedStaffId: text('attributed_staff_id').references(() => staffAccounts.id, {
      onDelete: 'set null',
    }),
    sourceActivityId: text('source_activity_id').references(() => activities.id, {
      onDelete: 'restrict',
    }),
    verifiedByUserId: text('verified_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
    verificationNote: text('verification_note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('local_orders_idempotency_uq').on(
      table.communityId,
      table.residentUserId,
      table.idempotencyKey,
    ),
    index('local_orders_community_status_idx').on(table.communityId, table.status),
    index('local_orders_resident_created_idx').on(table.residentUserId, table.createdAt),
    index('local_orders_product_idx').on(table.productId),
    index('local_orders_created_by_staff_idx').on(table.createdByStaffId),
    check('local_orders_quantity_check', sql`${table.quantity} >= 1 AND ${table.quantity} <= 99`),
    check(
      'local_orders_total_check',
      sql`${table.totalCents} = ${table.unitPriceCents} * ${table.quantity}`,
    ),
    check(
      'local_orders_status_check',
      sql`${table.status} IN ('registered', 'processing', 'pending_review', 'verified', 'cancelled', 'rejected')`,
    ),
    check(
      'local_orders_record_source_check',
      sql`${table.recordSource} IN ('resident', 'staff_on_behalf')`,
    ),
  ],
)

/**
 * Append-only local-order timeline. `source_type` + `source_id` are the stable
 * consumption contract for downstream work (#64): a consumer must be able to
 * follow an order event without joining and guessing. UPDATE/DELETE are rejected
 * by triggers in migration 0009, like every other event table in this schema.
 */
export const localOrderEvents = sqliteTable(
  'local_order_events',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => localOrders.id, { onDelete: 'restrict' }),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorStaffId: text('actor_staff_id').references(() => staffAccounts.id, {
      onDelete: 'set null',
    }),
    event: text('event').$type<LocalOrderEventType>().notNull(),
    fromStatus: text('from_status').$type<LocalOrderStatus>(),
    toStatus: text('to_status').$type<LocalOrderStatus>(),
    note: text('note'),
    sourceType: text('source_type').$type<typeof LOCAL_ORDER_EVENT_SOURCE_TYPE>().notNull(),
    sourceId: text('source_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('local_order_events_order_created_idx').on(table.orderId, table.createdAt),
    index('local_order_events_source_idx').on(table.sourceType, table.sourceId),
    check(
      'local_order_events_source_type_check',
      sql`${table.sourceType} = 'local_order'`,
    ),
    check(
      'local_order_events_event_check',
      sql`${table.event} IN ('order.registered', 'order.created_on_behalf', 'order.status_changed', 'order.verified', 'order.rejected')`,
    ),
  ],
)

/* -------------------------------------------------------------------------- */
/* Unified operating ledger, bookkeeping & reconciliation (#64 LL-MVP-008)     */
/* -------------------------------------------------------------------------- */

/**
 * A reconciliation batch over an inclusive business-day period.
 *
 * `status` moves `open -> locked` exactly once and never back. `total_cents` is
 * the gross *recorded* amount of the batch, never a payable amount: this MVP has
 * no settlement rule (`settlement_amount_status` stays `pending_rule`), so a
 * batch can never produce a distribution figure. The one-way transition, the
 * "one open batch per period" rule and the immutability of a locked period are
 * enforced by triggers/partial unique index in migration 0010, not only here.
 */
export const reconciliationBatches = sqliteTable(
  'reconciliation_batches',
  {
    id: text('id').primaryKey(),
    batchNo: text('batch_no').notNull(),
    /** Business dates (`YYYY-MM-DD`, Asia/Shanghai), both ends inclusive. */
    periodFrom: text('period_from').notNull(),
    periodTo: text('period_to').notNull(),
    status: text('status').$type<ReconciliationBatchStatus>().notNull(),
    lockedAt: integer('locked_at', { mode: 'timestamp_ms' }),
    lockedByUserId: text('locked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lockedByStaffId: text('locked_by_staff_id').references(() => staffAccounts.id, {
      onDelete: 'set null',
    }),
    entryCount: integer('entry_count').notNull(),
    totalCents: integer('total_cents').notNull(),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('reconciliation_batches_no_uq').on(table.batchNo),
    // At most one OPEN batch per period: a period is either being reconciled or
    // frozen, never both. Locked batches are excluded so history stays readable.
    uniqueIndex('reconciliation_batches_open_period_uq')
      .on(table.periodFrom, table.periodTo)
      .where(sql`${table.status} = 'open'`),
    index('reconciliation_batches_period_idx').on(table.periodFrom, table.periodTo),
    index('reconciliation_batches_status_updated_idx').on(table.status, table.updatedAt),
    check('reconciliation_batches_status_check', sql`${table.status} IN ('open', 'locked')`),
    check(
      'reconciliation_batches_period_check',
      sql`${table.periodFrom} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND ${table.periodTo} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND ${table.periodTo} >= ${table.periodFrom}`,
    ),
    check(
      'reconciliation_batches_counts_check',
      sql`${table.entryCount} >= 0 AND ${table.totalCents} >= 0`,
    ),
    check(
      'reconciliation_batches_lock_check',
      sql`(${table.status} = 'locked'
          AND ${table.lockedAt} IS NOT NULL
          AND ${table.lockedByUserId} IS NOT NULL)
        OR (${table.status} = 'open'
          AND ${table.lockedAt} IS NULL
          AND ${table.lockedByUserId} IS NULL
          AND ${table.lockedByStaffId} IS NULL)`,
    ),
  ],
)

/**
 * Append-only ledger fact rows ("统一经营流水").
 *
 * Four money definitions live side by side and are never merged:
 * `order_registered` (订单登记金额), `order_verified` (已核验有效业绩),
 * `payment_received` / `payment_reversed` (人工收款与冲正), `reward_cost` /
 * `reward_reversed` (奖励成本与冲正).
 *
 * The CHECK constraints below are the part that must survive a service bug:
 * - 没有凭据不得计入实收：`payment_*` requires `evidence_ref`, a concrete
 *   `evidence_kind` and the handling `recorded_by_staff_id`;
 * - `attribution_state = 'attributed' => attributed_staff_id IS NOT NULL`, and a
 *   `pending` (待归属) row may not carry a staff id at all;
 * - a reversal row always points at the entry it reverses (`counter_entry_id`);
 * - `amount_cents >= 0`: a reversal is its own positive row, never a negative
 *   amount that would let a corrected number silently disappear.
 *
 * UPDATE/DELETE are rejected by triggers in migration 0010 (append-only).
 */
export const ledgerEntries = sqliteTable(
  'ledger_entries',
  {
    id: text('id').primaryKey(),
    factKind: text('fact_kind').$type<LedgerFactKind>().notNull(),
    sourceSystem: text('source_system').$type<LedgerSourceSystem>().notNull(),
    /** Machine key of the source row; deduped per (source_system, source_id, fact_kind). */
    sourceId: text('source_id').notNull(),
    /** Human reference of the source (order no, grant id, receipt no). */
    sourceDisplayNo: text('source_display_no').notNull(),
    communityId: text('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'restrict' }),
    /** Local product of an order fact; `null` for CRM / reward / manual facts. */
    productId: text('product_id').references(() => localProducts.id, {
      onDelete: 'restrict',
    }),
    /** Only an explicit/confirmed attribution may fill this; never the recorder. */
    attributedStaffId: text('attributed_staff_id').references(() => staffAccounts.id, {
      onDelete: 'set null',
    }),
    attributionState: text('attribution_state').$type<LedgerAttributionState>().notNull(),
    attributionBasis: text('attribution_basis').$type<LedgerAttributionBasis>().notNull(),
    amountCents: integer('amount_cents').notNull(),
    settlementAmountStatus: text('settlement_amount_status')
      .$type<SettlementAmountStatus>()
      .notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
    recordedByUserId: text('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Staff who handled the fact; mandatory for every `payment_*` row. */
    recordedByStaffId: text('recorded_by_staff_id').references(() => staffAccounts.id, {
      onDelete: 'set null',
    }),
    /** Reversal only: the entry this row reverses. */
    counterEntryId: text('counter_entry_id').references((): AnySQLiteColumn => ledgerEntries.id, {
      onDelete: 'restrict',
    }),
    evidenceRef: text('evidence_ref'),
    evidenceKind: text('evidence_kind').$type<LedgerEvidenceKind>().notNull(),
    batchId: text('batch_id').references(() => reconciliationBatches.id, {
      onDelete: 'restrict',
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('ledger_entries_community_occurred_idx').on(table.communityId, table.occurredAt),
    index('ledger_entries_attributed_occurred_idx').on(
      table.attributedStaffId,
      table.occurredAt,
    ),
    index('ledger_entries_fact_kind_occurred_idx').on(table.factKind, table.occurredAt),
    index('ledger_entries_batch_idx').on(table.batchId),
    index('ledger_entries_source_idx').on(table.sourceSystem, table.sourceId),
    index('ledger_entries_product_idx').on(table.productId),
    check(
      'ledger_entries_fact_kind_check',
      sql`${table.factKind} IN ('order_registered', 'order_verified', 'payment_received',
        'payment_reversed', 'reward_cost', 'reward_reversed')`,
    ),
    check(
      'ledger_entries_source_system_check',
      sql`${table.sourceSystem} IN ('local_order', 'crm_service_order', 'activity_reward_grant', 'manual')`,
    ),
    check(
      'ledger_entries_source_kind_check',
      sql`(${table.factKind} = 'order_registered' AND ${table.sourceSystem} = 'local_order')
        OR (${table.factKind} = 'order_verified'
          AND ${table.sourceSystem} IN ('local_order', 'crm_service_order'))
        OR (${table.factKind} IN ('payment_received', 'payment_reversed')
          AND ${table.sourceSystem} = 'manual')
        OR (${table.factKind} IN ('reward_cost', 'reward_reversed')
          AND ${table.sourceSystem} = 'activity_reward_grant')`,
    ),
    check(
      'ledger_entries_attribution_state_check',
      sql`${table.attributionState} IN ('attributed', 'pending')`,
    ),
    check(
      'ledger_entries_attribution_basis_check',
      sql`${table.attributionBasis} IN ('explicit_attribution', 'confirmed_fact',
        'no_explicit_attribution', 'source_missing')`,
    ),
    check(
      'ledger_entries_attribution_check',
      sql`(${table.attributionState} = 'attributed'
          AND ${table.attributedStaffId} IS NOT NULL
          AND ${table.attributionBasis} IN ('explicit_attribution', 'confirmed_fact'))
        OR (${table.attributionState} = 'pending'
          AND ${table.attributedStaffId} IS NULL
          AND ${table.attributionBasis} IN ('no_explicit_attribution', 'source_missing'))`,
    ),
    check('ledger_entries_amount_check', sql`${table.amountCents} >= 0`),
    check(
      'ledger_entries_settlement_status_check',
      sql`${table.settlementAmountStatus} IN ('pending_rule', 'estimated')`,
    ),
    check(
      'ledger_entries_evidence_kind_check',
      sql`${table.evidenceKind} IN ('manual_receipt', 'bank_transfer', 'crm_confirmation',
        'order_verification', 'reward_grant', 'none')`,
    ),
    // 没有凭据不得计入实收（DB 层硬拦）。
    check(
      'ledger_entries_payment_evidence_check',
      sql`${table.factKind} NOT IN ('payment_received', 'payment_reversed')
        OR (${table.evidenceRef} IS NOT NULL
          AND ${table.recordedByStaffId} IS NOT NULL
          AND ${table.evidenceKind} <> 'none')`,
    ),
    check(
      'ledger_entries_counter_entry_check',
      sql`(${table.factKind} IN ('payment_reversed', 'reward_reversed')
          AND ${table.counterEntryId} IS NOT NULL)
        OR (${table.factKind} NOT IN ('payment_reversed', 'reward_reversed')
          AND ${table.counterEntryId} IS NULL)`,
    ),
    check(
      'ledger_entries_verified_at_check',
      sql`(${table.factKind} = 'order_verified' AND ${table.verifiedAt} IS NOT NULL)
        OR (${table.factKind} <> 'order_verified' AND ${table.verifiedAt} IS NULL)`,
    ),
  ],
)

/**
 * Dedupe key of the ledger: one source fact may enter the ledger at most once
 * per fact kind. `(source_system, source_id, fact_kind)` is UNIQUE, so a
 * duplicate notification, a replayed import or a concurrent consumer can only
 * hit the existing entry — never produce a second row (and never a second SUM).
 */
export const ledgerEntrySources = sqliteTable(
  'ledger_entry_sources',
  {
    id: text('id').primaryKey(),
    sourceSystem: text('source_system').$type<LedgerSourceSystem>().notNull(),
    sourceId: text('source_id').notNull(),
    factKind: text('fact_kind').$type<LedgerFactKind>().notNull(),
    entryId: text('entry_id')
      .notNull()
      .references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('ledger_entry_sources_dedupe_uq').on(
      table.sourceSystem,
      table.sourceId,
      table.factKind,
    ),
    index('ledger_entry_sources_entry_idx').on(table.entryId),
    check(
      'ledger_entry_sources_fact_kind_check',
      sql`${table.factKind} IN ('order_registered', 'order_verified', 'payment_received',
        'payment_reversed', 'reward_cost', 'reward_reversed')`,
    ),
    check(
      'ledger_entry_sources_source_system_check',
      sql`${table.sourceSystem} IN ('local_order', 'crm_service_order', 'activity_reward_grant', 'manual')`,
    ),
  ],
)

/**
 * Anomalies flagged against an entry. The fact row itself stays immutable: an
 * anomaly can be resolved (a new observation) but never rewrites the money.
 * DELETE is rejected by a trigger in migration 0010.
 */
export const ledgerAnomalies = sqliteTable(
  'ledger_anomalies',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id')
      .notNull()
      .references(() => ledgerEntries.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<LedgerAnomalyKind>().notNull(),
    severity: text('severity').$type<LedgerAnomalySeverity>().notNull(),
    note: text('note'),
    flaggedByUserId: text('flagged_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('ledger_anomalies_entry_idx').on(table.entryId),
    index('ledger_anomalies_open_idx').on(table.resolvedAt, table.severity),
    check(
      'ledger_anomalies_kind_check',
      sql`${table.kind} IN ('amount_mismatch', 'attribution_conflict',
        'source_missing_evidence', 'duplicate_candidate', 'period_gap')`,
    ),
    check(
      'ledger_anomalies_severity_check',
      sql`${table.severity} IN ('low', 'medium', 'high')`,
    ),
  ],
)

export const userRelations = relations(users, ({ many }) => ({
  wechatIdentities: many(wechatIdentities),
  phoneIdentities: many(residentPhoneIdentities),
  residentCommunities: many(residentCommunityAssignments),
  sessions: many(sessions),
}))

export const staffRelations = relations(staffAccounts, ({ one, many }) => ({
  user: one(users, { fields: [staffAccounts.userId], references: [users.id] }),
  communities: many(staffCommunityAssignments),
}))


/**
 * Curated external platform promotions. Never a payable product or a reward.
 * An offer starts disabled; operators must verify the link before publication.
 */
export const externalOffers = sqliteTable(
  'external_offers',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    platform: text('platform').notNull(),
    category: text('category').notNull(),
    description: text('description'),
    url: text('url').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('external_offers_enabled_expiry_sort_idx').on(table.enabled, table.expiresAt, table.sortOrder),
    check('external_offers_enabled_check', sql.raw('enabled IN (0, 1)')),
  ],
)

export const schema = {
  communities,
  users,
  wechatIdentities,
  staffAccounts,
  staffCommunityAssignments,
  residentCommunityAssignments,
  sessions,
  wechatOauthConfigs,
  oauthStates,
  rateLimits,
  auditLogs,
  residentPhoneIdentities,
  phoneVerificationCodes,
  phoneOtpRequestCounters,
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
  activityCheckins,
  activityRewardGrants,
  activityRewardCodes,
  activityPrizeStocks,
  activityRewardEvents,
  activityRewardDisputes,
  localProducts,
  localOrders,
  localOrderEvents,
  reconciliationBatches,
  ledgerEntries,
  ledgerEntrySources,
  ledgerAnomalies,
  externalOffers,
}
