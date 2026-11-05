import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  activityCheckinSchema,
  activityCheckinStateSchema,
  activityKeyRulesSchema,
  activityPrizeStockSchema,
  activityRewardCredentialSchema,
  activityRewardDisputeSchema,
  activityRewardDisputeThreadSchema,
  activityRewardGrantSchema,
  adminActivityCheckinListSchema,
  adminActivityRewardOverviewSchema,
  credentialCodeSchema,
  teamRewardStateSchema,
  type ActivityCheckin,
  type ActivityCheckinState,
  type ActivityPrizeStock,
  type ActivityRewardCredential,
  type RewardDisputeDecision,
  type ActivityRewardDisputeThread,
  type ActivityRewardGrant,
  type ActivityRewardPlan,
  type ActivityRewardClaimResponse,
  type ActivityStatus,
  type AdminActivityCheckinList,
  type AdminActivityRewardOverview,
  type ApiErrorCode,
  type CheckinAvailabilityReason,
  type RewardAvailabilityReason,
  type RewardEventKind,
  type RewardGrantStatus,
  type RewardRedeemResponse,
  type TeamRewardState,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  activityCheckins,
  activityParticipations,
  activityPrizeStocks,
  activityRewardCodes,
  activityRewardDisputes,
  activityRewardEvents,
  activityRewardGrants,
  activityRuleVersions,
  activityTeams,
  auditLogs,
  staffCommunityAssignments,
  users,
} from '../db/schema.js'

/**
 * Check-in, team-reward qualification and prize fulfilment service
 * (LL-MVP-006 / Issue #62).
 *
 * This module owns the ONLY write path into `activity_checkins`,
 * `activity_reward_grants`, `activity_reward_codes`, `activity_prize_stocks`,
 * `activity_reward_events` and `activity_reward_disputes`. It depends on the
 * database only: HTTP status translation, staff/resident sessions and CSRF
 * belong to the routes layer, which never supplies an actor id from a request
 * body.
 *
 * ## Invariants (all also enforced by migration 0006, so a bug here cannot
 * ## corrupt the ledger)
 *
 * 1. **Fulfilment reads the frozen snapshot only.** Every price, quantity,
 *    budget cap, check-in window and credential TTL comes from the
 *    `activity_rule_versions.snapshot_json` row referenced by
 *    `activities.current_rule_version_id`. When that snapshot has no
 *    `rewardPlan` (`snapshot.rewardPlan ?? null`), check-in, claim and
 *    redemption must fail with `reward_unavailable`. There is deliberately **no
 *    fallback to the mutable `activities` columns** (`reward_plan_json`,
 *    `budget_cap_cents`, `prize_quantity_cap`): reading them would let an
 *    operator retroactively re-price prizes that were already promised.
 * 2. **One resident, one valid check-in per activity** (partial unique index
 *    `WHERE status='valid'`). A revoked check-in stays as history and stops
 *    counting; re-checking-in afterwards is allowed.
 * 3. **Eligibility = 3 seats + 3 verified check-ins of the current members.**
 *    A self-reported check-in never counts; only `valid AND verified_at` does.
 * 4. **One grant per (activity, rule version, team)** (unique index). The
 *    quantity is `prizeQuantityPerTeam` for the *team*, never one prize per
 *    member.
 * 5. **Stock and budget are committed with a conditional UPDATE and
 *    `changes() === 1`**, inside the same `BEGIN IMMEDIATE` transaction that
 *    inserts the grant. A failed commit leaves no grant row and no consumed
 *    stock behind.
 * 6. **A credential is redeemable exactly once**: only the sha256 hash is
 *    stored, and redemption is `UPDATE ... WHERE status='active'` with
 *    `changes() === 1`. At most one `active` credential exists per grant.
 * 7. **Reversals never rewrite the past.** Revoking an *unredeemed* grant
 *    releases `claimed_quantity`; once a grant is redeemed, `redeemed_quantity`
 *    is monotonic and the reversal is expressed by appended
 *    `activity_reward_disputes` / `activity_reward_events` rows. Nothing in this
 *    module issues a DELETE against any of the six tables.
 *
 * See `docs/engineering/rewards-fulfillment.md` for the business boundaries
 * (一场活动 / 一类礼品 / 一次核销).
 */

const SEATS_REQUIRED = 3
const CHECKINS_REQUIRED = 3

/** Crockford base32 without the ambiguous `I`, `L`, `O`, `U`. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CREDENTIAL_CODE_LENGTH = 10

/** Domain error reasons the route layer may distinguish without string matching. */
export type RewardErrorReason =
  | 'activity_not_found'
  | 'reward_unavailable'
  | 'activity_not_published'
  | 'activity_ended'
  | 'checkin_window_not_open'
  | 'checkin_window_closed'
  | 'not_a_team_member'
  | 'team_missing'
  | 'team_incomplete'
  | 'checkin_incomplete'
  | 'checkin_not_found'
  | 'checkin_not_verified'
  | 'not_eligible'
  | 'not_recipient'
  | 'grant_not_found'
  | 'grant_already_redeemed'
  | 'code_invalid'
  | 'code_expired'
  | 'reward_already_redeemed'
  | 'stock_exhausted'
  | 'budget_exceeded'
  | 'dispute_not_open'
  | 'dispute_already_resolved'
  | 'concurrent_conflict'

/**
 * Domain error carrying the suggested HTTP status and the shared error code.
 * Routes translate it into `{ error: { code, message, requestId } }`, exactly
 * like `ParticipationError` and `ActivityError` do for their domains.
 */
export class RewardError extends Error {
  status: 400 | 403 | 404 | 409
  code: ApiErrorCode
  reason: RewardErrorReason

  constructor(
    status: 400 | 403 | 404 | 409,
    code: ApiErrorCode,
    reason: RewardErrorReason,
    message: string,
  ) {
    super(message)
    this.name = 'RewardError'
    this.status = status
    this.code = code
    this.reason = reason
  }
}

type RewardTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]

/** Reads may run on the pooled connection; writes always run inside the immediate transaction. */
type RewardExecutor = AppDatabase | RewardTransaction

/**
 * Staff identity of the operator performing a fulfilment action. `grid_worker`
 * is accepted here so the routes layer can pass any authenticated staff actor;
 * migration 0006 / this module only grant *write* powers to admin and operator,
 * so a grid worker reaching a write path is rejected by the routes layer.
 */
export interface RewardStaffActor {
  userId: string
  staffId: string
  role: 'admin' | 'operator' | 'grid_worker'
}

/** An actor that passed the write-permission gate. */
export type RewardOperator = RewardStaffActor

interface ActivityRow {
  id: string
  communityId: string
  status: ActivityStatus
  /** Authoritative end instant; past it the activity is over even if unswept. */
  endsAt: Date
  currentRuleVersionId: string | null
  updatedAt: Date
}

/**
 * The lifecycle verdicts, narrowed to the two reasons that are about the
 * activity's own state. Both schemas (`checkinAvailabilityReasonSchema` and
 * `rewardAvailabilityReasonSchema`) contain them, so one value serves every
 * surface.
 */
type LifecycleBlockReason = 'activity_not_published' | 'activity_ended'

interface FrozenPlan {
  ruleVersionId: string
  ruleVersion: number
  plan: ActivityRewardPlan
}

function iso(timestamp: Date): string {
  return timestamp.toISOString()
}

function parsePlanFromSnapshot(snapshotJson: string): ActivityRewardPlan | null {
  const rules = activityKeyRulesSchema.parse(JSON.parse(snapshotJson))
  // `.optional()` on the contract means an old (pre-#62) snapshot simply has no
  // key; normalise once here so every caller compares against `null` only.
  return rules.rewardPlan ?? null
}

/**
 * Resolves the frozen reward plan of an activity, or `null` when none is
 * configured. This is the single place the plan is read from — there is no code
 * path in this module that touches `activities.reward_plan_json`.
 */
function loadFrozenPlan(
  executor: RewardExecutor,
  activity: ActivityRow,
): FrozenPlan | null {
  if (activity.currentRuleVersionId === null) return null
  const version = executor
    .select({
      id: activityRuleVersions.id,
      version: activityRuleVersions.version,
      snapshotJson: activityRuleVersions.snapshotJson,
    })
    .from(activityRuleVersions)
    .where(eq(activityRuleVersions.id, activity.currentRuleVersionId))
    .get()
  if (!version) return null
  const plan = parsePlanFromSnapshot(version.snapshotJson)
  if (plan === null) return null
  return { ruleVersionId: version.id, ruleVersion: version.version, plan }
}

function requirePlan(executor: RewardExecutor, activity: ActivityRow): FrozenPlan {
  const frozen = loadFrozenPlan(executor, activity)
  if (frozen === null) {
    // Hard product rule: no snapshot plan means the formal reward entry is
    // closed. Never fall back to the mutable activity columns.
    throw new RewardError(
      409,
      API_ERROR_CODES.rewardUnavailable,
      'reward_unavailable',
      '该活动未配置奖励计划，正式奖励入口不可用',
    )
  }
  return frozen
}

function requireActivity(executor: RewardExecutor, activityId: string): ActivityRow {
  const row = executor
    .select({
      id: activities.id,
      communityId: activities.communityId,
      status: activities.status,
      endsAt: activities.endsAt,
      currentRuleVersionId: activities.currentRuleVersionId,
      updatedAt: activities.updatedAt,
    })
    .from(activities)
    .where(eq(activities.id, activityId))
    .get()
  if (!row) {
    throw new RewardError(404, API_ERROR_CODES.notFound, 'activity_not_found', '活动不存在')
  }
  return row
}

function hasCommunityScope(
  executor: RewardExecutor,
  operator: RewardStaffActor,
  communityId: string,
): boolean {
  if (operator.role === 'admin') return true
  const assignment = executor
    .select({ communityId: staffCommunityAssignments.communityId })
    .from(staffCommunityAssignments)
    .where(
      and(
        eq(staffCommunityAssignments.staffAccountId, operator.staffId),
        eq(staffCommunityAssignments.communityId, communityId),
      ),
    )
    .get()
  return assignment !== undefined
}

/**
 * Writes the denial evidence. Must be called on a connection that is NOT inside
 * the transaction being rolled back — otherwise SQLite discards the audit row
 * along with the refusal, and a probe leaves no trace at all.
 */
function recordAccessDenied(
  db: AppDatabase,
  operator: RewardStaffActor,
  communityId: string,
  activityId: string,
  now: Date,
): void {
  try {
    db.insert(auditLogs)
      .values({
        id: randomUUID(),
        actorUserId: operator.userId,
        event: 'reward.access_denied',
        targetId: activityId,
        metadata: JSON.stringify({
          staffId: operator.staffId,
          communityId,
          reason: 'community_out_of_scope',
        }),
        createdAt: now,
      })
      .run()
  } catch {
    // The audit write must never mask the authorization failure.
  }
}

/**
 * Scope gate for every staff surface, read-only or write.
 *
 * Always call this OUTSIDE a transaction. The denial audit is a durable fact, and
 * an audit row inserted inside a transaction that then throws would be rolled
 * back with the very refusal it documents — a probe would leave no trace at all.
 */
function requireStaffScope(
  db: AppDatabase,
  operator: RewardStaffActor,
  communityId: string,
  activityId: string,
  now: Date,
): void {
  if (hasCommunityScope(db, operator, communityId)) return
  recordAccessDenied(db, operator, communityId, activityId, now)
  throw new RewardError(403, API_ERROR_CODES.forbidden, 'activity_not_found', '无权访问该社区的活动')
}

/**
 * Public scope gate for the routes layer: resolves an activity and rejects a
 * staff actor outside its community (403 `forbidden`), leaving an audit trail.
 */
export function requireStaffActivityScope(
  db: AppDatabase,
  actor: RewardStaffActor,
  activityId: string,
): { activityId: string; communityId: string } {
  const activity = requireActivity(db, activityId)
  if (!hasCommunityScope(db, actor, activity.communityId)) {
    recordAccessDenied(db, actor, activity.communityId, activity.id, new Date())
    throw new RewardError(403, API_ERROR_CODES.forbidden, 'activity_not_found', '无权访问该社区的活动')
  }
  return { activityId: activity.id, communityId: activity.communityId }
}

/* -------------------------------------------------------------------------- */
/* Credential primitives                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mints a 10-character Crockford base32 code. Each byte is reduced modulo 32,
 * which is uniform here because 256 is an exact multiple of 32 — no modulo bias.
 */
export function generateCredentialCode(): string {
  const bytes = randomBytes(CREDENTIAL_CODE_LENGTH)
  let code = ''
  for (const byte of bytes) code += CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length]
  return code
}

/** Only this hash is persisted; the plaintext exists in one response only. */
export function hashCredentialCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

function maskCredentialCode(codeSuffix: string): string {
  return `${'*'.repeat(CREDENTIAL_CODE_LENGTH - 4)}${codeSuffix}`
}

/* -------------------------------------------------------------------------- */
/* Append-only event / audit helpers                                          */
/* -------------------------------------------------------------------------- */

function appendRewardEvent(
  tx: RewardTransaction,
  input: {
    activityId: string
    kind: RewardEventKind
    now: Date
    grantId?: string | null
    checkinId?: string | null
    credentialId?: string | null
    actorUserId?: string | null
    actorStaffId?: string | null
    detail?: Record<string, unknown> | null
  },
): void {
  const maxSequence = tx
    .select({ value: sql<number>`coalesce(max(${activityRewardEvents.sequence}), 0)` })
    .from(activityRewardEvents)
    .where(eq(activityRewardEvents.activityId, input.activityId))
    .get()
  tx.insert(activityRewardEvents)
    .values({
      id: randomUUID(),
      activityId: input.activityId,
      sequence: Number(maxSequence?.value ?? 0) + 1,
      kind: input.kind,
      grantId: input.grantId ?? null,
      checkinId: input.checkinId ?? null,
      credentialId: input.credentialId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorStaffId: input.actorStaffId ?? null,
      detailJson: input.detail ? JSON.stringify(input.detail) : null,
      createdAt: input.now,
    })
    .run()
}

/**
 * Audit rows never carry a credential code, a session token, an OpenID or any
 * other secret — only identifiers and enums.
 */
function appendAudit(
  tx: RewardTransaction,
  input: {
    actorUserId: string
    event: string
    activityId: string
    now: Date
    metadata: Record<string, string>
  },
): void {
  tx.insert(auditLogs)
    .values({
      id: randomUUID(),
      actorUserId: input.actorUserId,
      event: input.event,
      targetId: input.activityId,
      metadata: JSON.stringify(input.metadata),
      createdAt: input.now,
    })
    .run()
}

/* -------------------------------------------------------------------------- */
/* DTO builders                                                               */
/* -------------------------------------------------------------------------- */

interface CheckinRow {
  id: string
  activityId: string
  userId: string
  displayName: string | null
  teamId: string | null
  seatNo: number | null
  status: 'valid' | 'revoked'
  note: string | null
  checkedInAt: Date
  verifiedAt: Date | null
  verifiedByStaffId: string | null
  revokedAt: Date | null
  revokedByStaffId: string | null
  revokeReason: string | null
}

function buildCheckin(row: CheckinRow): ActivityCheckin {
  return activityCheckinSchema.parse({
    id: row.id,
    activityId: row.activityId,
    userId: row.userId,
    displayName: row.displayName ?? '居民',
    teamId: row.teamId,
    seatNo: row.seatNo,
    status: row.status,
    note: row.note,
    checkedInAt: iso(row.checkedInAt),
    verifiedAt: row.verifiedAt ? iso(row.verifiedAt) : null,
    verifiedByStaffId: row.verifiedByStaffId,
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
    revokedByStaffId: row.revokedByStaffId,
    revokeReason: row.revokeReason,
  })
}

function checkinSelection() {
  return {
    id: activityCheckins.id,
    activityId: activityCheckins.activityId,
    userId: activityCheckins.userId,
    displayName: users.displayName,
    teamId: activityCheckins.teamId,
    seatNo: activityCheckins.seatNo,
    status: activityCheckins.status,
    note: activityCheckins.note,
    checkedInAt: activityCheckins.checkedInAt,
    verifiedAt: activityCheckins.verifiedAt,
    verifiedByStaffId: activityCheckins.verifiedByStaffId,
    revokedAt: activityCheckins.revokedAt,
    revokedByStaffId: activityCheckins.revokedByStaffId,
    revokeReason: activityCheckins.revokeReason,
  }
}

interface CredentialRow {
  id: string
  grantId: string
  activityId: string
  teamId: string
  codeSuffix: string
  prizeName: string
  status: 'active' | 'redeemed' | 'superseded' | 'expired' | 'revoked'
  issuedAt: Date
  expiresAt: Date
  redeemedAt: Date | null
  redeemedByStaffId: string | null
  supersededAt: Date | null
}

function buildCredential(row: CredentialRow): ActivityRewardCredential {
  return activityRewardCredentialSchema.parse({
    id: row.id,
    grantId: row.grantId,
    activityId: row.activityId,
    teamId: row.teamId,
    prizeName: row.prizeName,
    status: row.status,
    maskedCode: maskCredentialCode(row.codeSuffix),
    issuedAt: iso(row.issuedAt),
    expiresAt: iso(row.expiresAt),
    redeemedAt: row.redeemedAt ? iso(row.redeemedAt) : null,
    redeemedByStaffId: row.redeemedByStaffId,
    supersededAt: row.supersededAt ? iso(row.supersededAt) : null,
  })
}

function credentialSelection() {
  return {
    id: activityRewardCodes.id,
    grantId: activityRewardCodes.grantId,
    activityId: activityRewardCodes.activityId,
    teamId: activityRewardCodes.teamId,
    codeSuffix: activityRewardCodes.codeSuffix,
    prizeName: activityRewardCodes.prizeName,
    status: activityRewardCodes.status,
    issuedAt: activityRewardCodes.issuedAt,
    expiresAt: activityRewardCodes.expiresAt,
    redeemedAt: activityRewardCodes.redeemedAt,
    redeemedByStaffId: activityRewardCodes.redeemedByStaffId,
    supersededAt: activityRewardCodes.supersededAt,
  }
}

interface GrantRow {
  id: string
  activityId: string
  ruleVersionId: string
  ruleVersion: number
  teamId: string
  prizeName: string
  quantity: number
  unitCostCents: number
  totalCostCents: number
  status: RewardGrantStatus
  recipientRole: 'leader' | 'member'
  recipientUserId: string | null
  recipientDisplayName: string | null
  grantedAt: Date
  redeemedAt: Date | null
  revokedAt: Date | null
}

function grantSelection() {
  return {
    id: activityRewardGrants.id,
    activityId: activityRewardGrants.activityId,
    ruleVersionId: activityRewardGrants.ruleVersionId,
    ruleVersion: activityRuleVersions.version,
    teamId: activityRewardGrants.teamId,
    prizeName: activityRewardGrants.prizeName,
    quantity: activityRewardGrants.quantity,
    unitCostCents: activityRewardGrants.unitCostCents,
    totalCostCents: activityRewardGrants.totalCostCents,
    status: activityRewardGrants.status,
    recipientRole: activityRewardGrants.recipientRole,
    recipientUserId: activityRewardGrants.recipientUserId,
    recipientDisplayName: users.displayName,
    grantedAt: activityRewardGrants.grantedAt,
    redeemedAt: activityRewardGrants.redeemedAt,
    revokedAt: activityRewardGrants.revokedAt,
  }
}

function selectGrant(executor: RewardExecutor, grantId: string): GrantRow | undefined {
  return executor
    .select(grantSelection())
    .from(activityRewardGrants)
    .innerJoin(activityRuleVersions, eq(activityRewardGrants.ruleVersionId, activityRuleVersions.id))
    .leftJoin(users, eq(activityRewardGrants.recipientUserId, users.id))
    .where(eq(activityRewardGrants.id, grantId))
    .get()
}

/** The still-redeemable credential of a grant, if any. */
function selectActiveCredential(
  executor: RewardExecutor,
  grantId: string,
): CredentialRow | undefined {
  return executor
    .select(credentialSelection())
    .from(activityRewardCodes)
    .where(and(eq(activityRewardCodes.grantId, grantId), eq(activityRewardCodes.status, 'active')))
    .get()
}

function selectLatestCredential(
  executor: RewardExecutor,
  grantId: string,
): CredentialRow | undefined {
  return executor
    .select(credentialSelection())
    .from(activityRewardCodes)
    .where(eq(activityRewardCodes.grantId, grantId))
    // `issued_at` can repeat within a millisecond; `id` is the deterministic
    // tie-break (Drizzle does not expose SQLite's implicit rowid).
    .orderBy(desc(activityRewardCodes.issuedAt), desc(activityRewardCodes.id))
    .get()
}

/** True when this grant already has any dispute thread entry (open or closed). */
function selectDisputeThreadExists(executor: RewardExecutor, grantId: string): boolean {
  const row = executor
    .select({ id: activityRewardDisputes.id })
    .from(activityRewardDisputes)
    .where(eq(activityRewardDisputes.grantId, grantId))
    .limit(1)
    .get()
  return row !== undefined
}

function selectOpenDisputeId(executor: RewardExecutor, grantId: string): string | null {
  const last = executor
    .select({ id: activityRewardDisputes.id, decision: activityRewardDisputes.decision })
    .from(activityRewardDisputes)
    .where(eq(activityRewardDisputes.grantId, grantId))
    .orderBy(desc(activityRewardDisputes.createdAt), desc(activityRewardDisputes.id))
    .get()
  return last && last.decision === 'opened' ? last.id : null
}

function buildGrant(executor: RewardExecutor, row: GrantRow): ActivityRewardGrant {
  const credential = selectLatestCredential(executor, row.id)
  return activityRewardGrantSchema.parse({
    id: row.id,
    activityId: row.activityId,
    ruleVersionId: row.ruleVersionId,
    ruleVersion: row.ruleVersion,
    teamId: row.teamId,
    prizeName: row.prizeName,
    quantity: row.quantity,
    unitCostCents: row.unitCostCents,
    totalCostCents: row.totalCostCents,
    status: row.status,
    recipientRole: row.recipientRole,
    recipientUserId: row.recipientUserId,
    recipientDisplayName: row.recipientDisplayName,
    grantedAt: iso(row.grantedAt),
    redeemedAt: row.redeemedAt ? iso(row.redeemedAt) : null,
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
    credentialExpiresAt: credential ? iso(credential.expiresAt) : null,
    openDisputeId: selectOpenDisputeId(executor, row.id),
  })
}

/* -------------------------------------------------------------------------- */
/* Stock ledger projection                                                    */
/* -------------------------------------------------------------------------- */

interface StockRow {
  id: string
  activityId: string
  ruleVersionId: string
  prizeName: string
  unitCostCents: number
  totalQuantity: number
  claimedQuantity: number
  redeemedQuantity: number
  budgetCapCents: number
  committedBudgetCents: number
  redeemedBudgetCents: number
  updatedAt: Date
}

/**
 * The activity's ledger row for one prize name.
 *
 * The row is deliberately activity-scoped, not rule-version-scoped: an edit
 * creates a new rule version, and a version-scoped ledger would give every new
 * version its own `claimed_quantity = 0`, silently multiplying the frozen
 * `total_prize_quantity` and `budget_cap_cents` by the number of edits.
 */
function selectStock(
  executor: RewardExecutor,
  activityId: string,
  prizeName: string,
): StockRow | undefined {
  return executor
    .select({
      id: activityPrizeStocks.id,
      activityId: activityPrizeStocks.activityId,
      ruleVersionId: activityPrizeStocks.ruleVersionId,
      prizeName: activityPrizeStocks.prizeName,
      unitCostCents: activityPrizeStocks.unitCostCents,
      totalQuantity: activityPrizeStocks.totalQuantity,
      claimedQuantity: activityPrizeStocks.claimedQuantity,
      redeemedQuantity: activityPrizeStocks.redeemedQuantity,
      budgetCapCents: activityPrizeStocks.budgetCapCents,
      committedBudgetCents: activityPrizeStocks.committedBudgetCents,
      redeemedBudgetCents: activityPrizeStocks.redeemedBudgetCents,
      updatedAt: activityPrizeStocks.updatedAt,
    })
    .from(activityPrizeStocks)
    .where(
      and(
        eq(activityPrizeStocks.activityId, activityId),
        eq(activityPrizeStocks.prizeName, prizeName),
      ),
    )
    .get()
}

/**
 * Projects a stock row for the API. When the ledger row has not been
 * materialised yet (nothing has been claimed), the plan's full availability is
 * reported instead of writing during a read — GET must stay side-effect free.
 */
function projectStock(
  frozen: FrozenPlan,
  row: StockRow | undefined,
  activityId: string,
  updatedAt: Date,
): ActivityPrizeStock {
  const claimedQuantity = row?.claimedQuantity ?? 0
  const redeemedQuantity = row?.redeemedQuantity ?? 0
  const unitCostCents = row?.unitCostCents ?? frozen.plan.prizeUnitCostCents
  const totalQuantity = row?.totalQuantity ?? frozen.plan.totalPrizeQuantity
  const budgetCapCents = row?.budgetCapCents ?? frozen.plan.budgetCapCents
  return activityPrizeStockSchema.parse({
    activityId,
    ruleVersionId: frozen.ruleVersionId,
    ruleVersion: frozen.ruleVersion,
    prizeName: row?.prizeName ?? frozen.plan.prizeName,
    unitCostCents,
    totalQuantity,
    claimedQuantity,
    redeemedQuantity,
    budgetCapCents,
    committedBudgetCents: claimedQuantity * unitCostCents,
    redeemedBudgetCents: redeemedQuantity * unitCostCents,
    availableQuantity: totalQuantity - claimedQuantity,
    remainingBudgetCents: budgetCapCents - claimedQuantity * unitCostCents,
    updatedAt: iso(row?.updatedAt ?? updatedAt),
  })
}

/**
 * Materialises the activity's ledger row for its prize on first use.
 *
 * There is exactly one row per `(activity_id, prize_name)` — enforced by the
 * `activity_prize_stocks_activity_prize_uq` index — so a rule edit that creates a
 * new version reuses the existing row, its counters and its frozen prices. When
 * the row already exists the snapshot's numbers are deliberately ignored: the
 * caps of an activity are frozen at the first claim and a later edit cannot
 * enlarge them.
 *
 * On creation the values are copied from the snapshot; migration 0006's
 * `frozen_plan_guard` trigger independently re-checks them against that same
 * snapshot, so this function cannot invent a cheaper prize.
 */
function ensureStockRow(
  tx: RewardTransaction,
  frozen: FrozenPlan,
  activityId: string,
  now: Date,
): StockRow {
  const existing = selectStock(tx, activityId, frozen.plan.prizeName)
  if (existing) return existing
  const id = randomUUID()
  tx.insert(activityPrizeStocks)
    .values({
      id,
      activityId,
      ruleVersionId: frozen.ruleVersionId,
      prizeName: frozen.plan.prizeName,
      unitCostCents: frozen.plan.prizeUnitCostCents,
      totalQuantity: frozen.plan.totalPrizeQuantity,
      claimedQuantity: 0,
      redeemedQuantity: 0,
      budgetCapCents: frozen.plan.budgetCapCents,
      committedBudgetCents: 0,
      redeemedBudgetCents: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  const created = selectStock(tx, activityId, frozen.plan.prizeName)
  if (!created) {
    throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '库存台账创建失败')
  }
  return created
}

/* -------------------------------------------------------------------------- */
/* Team qualification                                                         */
/* -------------------------------------------------------------------------- */

interface TeamContext {
  teamId: string
  leaderUserId: string
  seatsFilled: number
  /** The caller's seat, or `null` when the caller is not a member of the team. */
  mySeatNo: number | null
  memberUserIds: string[]
  checkinsValid: number
}

function loadTeamContext(
  executor: RewardExecutor,
  activityId: string,
  userId: string,
): TeamContext | null {
  const participation = executor
    .select({ teamId: activityParticipations.teamId, seatNo: activityParticipations.seatNo })
    .from(activityParticipations)
    .where(
      and(
        eq(activityParticipations.activityId, activityId),
        eq(activityParticipations.userId, userId),
      ),
    )
    .get()
  if (!participation) return null

  const team = executor
    .select({ id: activityTeams.id, leaderUserId: activityTeams.leaderUserId })
    .from(activityTeams)
    .where(and(eq(activityTeams.id, participation.teamId), eq(activityTeams.activityId, activityId)))
    .get()
  if (!team) return null

  const seats = executor
    .select({ userId: activityParticipations.userId, seatNo: activityParticipations.seatNo })
    .from(activityParticipations)
    .where(eq(activityParticipations.teamId, team.id))
    .all()

  // Only verified, still-valid check-ins of the team's *current* members count,
  // so a revoked check-in or a departed member cannot keep a team qualified.
  const memberUserIds = seats.map((seat) => seat.userId)
  // Membership is enforced by the `where` clause above (activity + team +
  // valid + verified); the seats are only consulted so an empty team counts as
  // zero. A previous `filter((row) => memberUserIds.includes(row.id) === false)`
  // compared a check-in row id against user ids, so it was always true and
  // filtered nothing — removed to stop it looking like a real guard.
  const checkinsValid = memberUserIds.length
    ? executor
        .select({ id: activityCheckins.id })
        .from(activityCheckins)
        .where(
          and(
            eq(activityCheckins.activityId, activityId),
            eq(activityCheckins.teamId, team.id),
            eq(activityCheckins.status, 'valid'),
            sql`${activityCheckins.verifiedAt} IS NOT NULL`,
          ),
        )
        .all().length
    : 0

  return {
    teamId: team.id,
    leaderUserId: team.leaderUserId,
    seatsFilled: seats.length,
    mySeatNo: seats.find((seat) => seat.userId === userId)?.seatNo ?? null,
    memberUserIds,
    checkinsValid,
  }
}

/**
 * THE single source of truth for "does the activity's prize ledger still have
 * room for one more team?".
 *
 * Two callers, deliberately sharing this one predicate:
 *   - `buildTeamRewardState` projects it into `unavailableReason`/`eligible`;
 *   - `claimTeamReward` turns it into the 409 that staff see.
 *
 * They used to reason separately, and the projection silently disagreed with the
 * guard: exhausted stock left `eligible: true` beside
 * `unavailableReason: 'stock_exhausted'`, which the contract rejects → HTTP 500.
 * Any future change to the quota rule belongs here and nowhere else.
 *
 * The authoritative *enforcement* is still the conditional UPDATE in
 * `claimTeamReward` (`WHERE claimed + n <= total AND committed + n*cost <= cap`
 * with `changes() === 1`) — this predicate only predicts its outcome.
 */
function redemptionAvailable(
  frozen: FrozenPlan,
  stock: StockRow | undefined,
): RewardAvailabilityReason | null {
  const claimed = stock?.claimedQuantity ?? 0
  const total = stock?.totalQuantity ?? frozen.plan.totalPrizeQuantity
  const committed = stock?.committedBudgetCents ?? 0
  const cap = stock?.budgetCapCents ?? frozen.plan.budgetCapCents
  const perTeam = frozen.plan.prizeQuantityPerTeam
  // An existing ledger row keeps the price it was opened with (its
  // `committed = claimed * unit_cost` CHECK depends on it), so the availability
  // projection must use the row's unit cost too — otherwise a re-priced plan
  // would forecast "budget exhausted" while the claim would still succeed.
  const unitCost = stock?.unitCostCents ?? frozen.plan.prizeUnitCostCents
  if (claimed + perTeam > total) return 'stock_exhausted'
  if (committed + perTeam * unitCost > cap) return 'budget_exhausted'
  return null
}

/* -------------------------------------------------------------------------- */
/* Check-in                                                                   */
/* -------------------------------------------------------------------------- */

function loadCheckin(executor: RewardExecutor, checkinId: string): CheckinRow | undefined {
  return executor
    .select(checkinSelection())
    .from(activityCheckins)
    .leftJoin(users, eq(activityCheckins.userId, users.id))
    .where(eq(activityCheckins.id, checkinId))
    .get()
}

export interface CheckinStateInput {
  activityId: string
  userId: string
  /** Injectable clock so window boundaries are testable and deterministic. */
  now?: Date
}

/**
 * Read-only view of the resident's own check-in. Never writes: the resident's
 * eligibility to check in right now is derived, not stored.
 */
export function getCheckinState(
  db: AppDatabase,
  input: CheckinStateInput,
): ActivityCheckinState {
  const now = input.now ?? new Date()
  const activity = requireActivity(db, input.activityId)
  const frozen = loadFrozenPlan(db, activity)
  const existing = db
    .select(checkinSelection())
    .from(activityCheckins)
    .leftJoin(users, eq(activityCheckins.userId, users.id))
    .where(
      and(
        eq(activityCheckins.activityId, activity.id),
        eq(activityCheckins.userId, input.userId),
        eq(activityCheckins.status, 'valid'),
      ),
    )
    .get()

  const reason = checkinBlockReason(db, activity, frozen, input.userId, now, existing)
  return activityCheckinStateSchema.parse({
    activityId: activity.id,
    checkinWindow: frozen ? frozen.plan.checkinWindow : null,
    available: reason === null,
    unavailableReason: reason,
    checkin: existing ? buildCheckin(existing) : null,
    countsForReward: existing ? existing.verifiedAt !== null : false,
  })
}

/**
 * The single lifecycle verdict shared by check-in, claim and redemption.
 *
 * Keeping one function is the whole point: check-in, claim and redemption used
 * to each decide for themselves, which is how "check-in is closed but the claim
 * and the redemption are still open" became possible on a paused or ended
 * activity. Every resident/staff write path must consult this and nothing else.
 *
 * `ended` outranks `paused` outranks `draft` in specificity, so the client gets
 * the most accurate reason rather than a generic one.
 */
function lifecycleBlockReason(
  activity: ActivityRow,
  now: Date,
): LifecycleBlockReason | null {
  if (activity.status === 'draft') return 'activity_not_published'
  if (activity.status === 'ended') return 'activity_ended'
  // `paused` is deliberately reported as "not published": the activity is
  // temporarily closed, not finished, and that is what residents already see on
  // the check-in surface. `ended` keeps its own reason.
  if (activity.status !== 'published') return 'activity_not_published'
  if (now.getTime() >= activity.endsAt.getTime()) return 'activity_ended'
  return null
}

function checkinBlockReason(
  executor: RewardExecutor,
  activity: ActivityRow,
  frozen: FrozenPlan | null,
  userId: string,
  now: Date,
  existing: CheckinRow | undefined,
): CheckinAvailabilityReason | null {
  // Lifecycle first: a draft has no frozen rule version at all, so reporting
  // "no plan configured" would misdescribe a normal pre-publish state.
  const lifecycle = lifecycleBlockReason(activity, now)
  if (lifecycle !== null) return lifecycle
  if (frozen === null) return 'reward_plan_not_configured'
  const opensAt = Date.parse(frozen.plan.checkinWindow.opensAt)
  const closesAt = Date.parse(frozen.plan.checkinWindow.closesAt)
  if (now.getTime() < opensAt) return 'checkin_window_not_open'
  if (now.getTime() > closesAt) return 'checkin_window_closed'
  if (existing) return 'already_checked_in'
  const team = loadTeamContext(executor, activity.id, userId)
  if (!team || team.mySeatNo === null) return 'not_a_team_member'
  return null
}

export interface RecordCheckinInput {
  activityId: string
  /** The resident being checked in. For a self check-in this is the session user. */
  userId: string
  /**
   * Staff recording the check-in on site, or `null` for the resident's own
   * self-reported check-in. A staff-recorded check-in is verified immediately
   * (the staff member is physically present); a self-reported one stays
   * unverified and does not count towards a reward until `verifyCheckin` runs.
   */
  operator?: RewardStaffActor | null
  note?: string
  now?: Date
}

export interface RecordCheckinResult {
  created: boolean
  checkin: ActivityCheckin
  state: ActivityCheckinState
}

/**
 * Records a real check-in. Idempotent: re-submitting returns the existing valid
 * check-in with `created: false` and never adds a row or a team member.
 *
 * The insert runs inside `BEGIN IMMEDIATE`, so two concurrent submissions of the
 * same resident serialize; the loser sees the winner's row and takes the
 * idempotent branch instead of hitting the partial unique index.
 */
export function recordCheckin(db: AppDatabase, input: RecordCheckinInput): RecordCheckinResult {
  const now = input.now ?? new Date()
  const operator = input.operator ?? null
  // Scope is decided before the transaction opens, so the denial audit survives
  // the rollback that the denial itself triggers.
  if (operator) {
    const scopeActivity = requireActivity(db, input.activityId)
    requireStaffScope(db, operator, scopeActivity.communityId, scopeActivity.id, now)
  }
  try {
    return db.transaction(
      (tx) => {
        const activity = requireActivity(tx, input.activityId)
        const frozen = requirePlan(tx, activity)

        const existing = tx
          .select(checkinSelection())
          .from(activityCheckins)
          .leftJoin(users, eq(activityCheckins.userId, users.id))
          .where(
            and(
              eq(activityCheckins.activityId, activity.id),
              eq(activityCheckins.userId, input.userId),
              eq(activityCheckins.status, 'valid'),
            ),
          )
          .get()
        if (existing) {
          return {
            created: false,
            checkin: buildCheckin(existing),
            state: readCheckinState(tx, activity, frozen, input.userId, now),
          }
        }

        const blocked = checkinBlockReason(tx, activity, frozen, input.userId, now, undefined)
        if (blocked === 'not_a_team_member') {
          throw new RewardError(
            409,
            API_ERROR_CODES.rewardUnavailable,
            'not_a_team_member',
            '只有该团队内的参与者可以签到',
          )
        }
        if (blocked !== null) throw checkinBlockedError(blocked)

        const team = loadTeamContext(tx, activity.id, input.userId)
        if (!team || team.mySeatNo === null) {
          throw new RewardError(
            409,
            API_ERROR_CODES.rewardUnavailable,
            'not_a_team_member',
            '只有该团队内的参与者可以签到',
          )
        }

        const checkinId = randomUUID()
        tx.insert(activityCheckins)
          .values({
            id: checkinId,
            activityId: activity.id,
            userId: input.userId,
            teamId: team.teamId,
            seatNo: team.mySeatNo,
            status: 'valid',
            note: input.note ?? null,
            checkedInAt: now,
            // The team/seat attribution is frozen at insert; migration 0006
            // makes these columns immutable and forbids deleting the row.
            verifiedAt: operator ? now : null,
            verifiedByStaffId: operator ? operator.staffId : null,
            revokedAt: null,
            revokedByStaffId: null,
            revokeReason: null,
          })
          .run()

        if (operator) {
          appendRewardEvent(tx, {
            activityId: activity.id,
            kind: 'checkin.verified',
            checkinId,
            actorUserId: input.userId,
            actorStaffId: operator.staffId,
            now,
            detail: { teamId: team.teamId, seatNo: team.mySeatNo, recordedByStaff: true },
          })
          appendAudit(tx, {
            actorUserId: operator.userId,
            event: 'reward.checkin.recorded',
            activityId: activity.id,
            now,
            metadata: {
              checkinId,
              residentUserId: input.userId,
              teamId: team.teamId,
              seatNo: String(team.mySeatNo),
            },
          })
        }

        const created = loadCheckin(tx, checkinId)
        if (!created) {
          throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '签到写入失败')
        }
        return {
          created: true,
          checkin: buildCheckin(created),
          state: readCheckinState(tx, activity, frozen, input.userId, now),
        }
      },
      { behavior: 'immediate' },
    )
  } catch (error) {
    throw mapRewardConstraint(error)
  }
}

function readCheckinState(
  executor: RewardExecutor,
  activity: ActivityRow,
  frozen: FrozenPlan | null,
  userId: string,
  now: Date,
): ActivityCheckinState {
  const existing = executor
    .select(checkinSelection())
    .from(activityCheckins)
    .leftJoin(users, eq(activityCheckins.userId, users.id))
    .where(
      and(
        eq(activityCheckins.activityId, activity.id),
        eq(activityCheckins.userId, userId),
        eq(activityCheckins.status, 'valid'),
      ),
    )
    .get()
  const reason = checkinBlockReason(executor, activity, frozen, userId, now, existing)
  return activityCheckinStateSchema.parse({
    activityId: activity.id,
    checkinWindow: frozen ? frozen.plan.checkinWindow : null,
    available: reason === null,
    unavailableReason: reason,
    checkin: existing ? buildCheckin(existing) : null,
    countsForReward: existing ? existing.verifiedAt !== null : false,
  })
}

function checkinBlockedError(reason: CheckinAvailabilityReason): RewardError {
  switch (reason) {
    case 'reward_plan_not_configured':
      return new RewardError(
        409,
        API_ERROR_CODES.rewardUnavailable,
        'reward_unavailable',
        '该活动未配置奖励计划，正式奖励入口不可用',
      )
    case 'checkin_window_not_open':
      return new RewardError(
        409,
        API_ERROR_CODES.rewardUnavailable,
        'checkin_window_not_open',
        '签到尚未开始',
      )
    case 'checkin_window_closed':
      return new RewardError(
        409,
        API_ERROR_CODES.rewardUnavailable,
        'checkin_window_closed',
        '签到已结束',
      )
    case 'activity_ended':
      // Was previously reported as `activity_not_published`, so a client could
      // not branch on the code and had to string-match the message.
      return new RewardError(
        409,
        API_ERROR_CODES.rewardUnavailable,
        'activity_ended',
        '活动已结束，无法签到',
      )
    case 'not_a_team_member':
      return new RewardError(
        409,
        API_ERROR_CODES.rewardUnavailable,
        'not_a_team_member',
        '只有该团队内的参与者可以签到',
      )
    case 'already_checked_in':
      return new RewardError(
        409,
        API_ERROR_CODES.checkinDuplicate,
        'concurrent_conflict',
        '该居民已在本活动签到',
      )
    default:
      return new RewardError(
        409,
        API_ERROR_CODES.rewardUnavailable,
        'activity_not_published',
        '活动当前不可签到',
      )
  }
}

export interface VerifyCheckinInput {
  activityId: string
  checkinId: string
  note?: string
  now?: Date
}

/**
 * Verifies a self-reported check-in. Stakeholder evidence stays intact: the
 * verification stamp is write-once (migration 0006 trigger), so it can never be
 * undone afterwards — a mistaken verification is corrected by revoking the
 * check-in, not by clearing the stamp.
 */
export function verifyCheckin(
  db: AppDatabase,
  actor: RewardStaffActor,
  input: VerifyCheckinInput,
): ActivityCheckin {
  const now = input.now ?? new Date()
  {
    const scopeActivity = requireActivity(db, input.activityId)
    requireStaffScope(db, actor, scopeActivity.communityId, scopeActivity.id, now)
  }
  try {
    return db.transaction(
      (tx) => {
        const activity = requireActivity(tx, input.activityId)
        requirePlan(tx, activity)

        const checkin = loadCheckin(tx, input.checkinId)
        if (!checkin || checkin.activityId !== activity.id) {
          throw new RewardError(404, API_ERROR_CODES.notFound, 'checkin_not_found', '签到记录不存在')
        }
        if (checkin.status !== 'valid') {
          throw new RewardError(409, API_ERROR_CODES.conflict, 'checkin_not_verified', '已作废的签到不能核验')
        }
        // Verification is write-once (0006 trigger): a repeat call returns the
        // already-verified row unchanged instead of failing.
        if (checkin.verifiedAt !== null) return buildCheckin(checkin)

        const updated = tx
          .update(activityCheckins)
          .set({ verifiedAt: now, verifiedByStaffId: actor.staffId })
          .where(and(eq(activityCheckins.id, checkin.id), sql`${activityCheckins.verifiedAt} IS NULL`))
          .run()
        if (updated.changes !== 1) {
          throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '签到已被他人核验')
        }

        appendRewardEvent(tx, {
          activityId: activity.id,
          kind: 'checkin.verified',
          checkinId: checkin.id,
          actorUserId: checkin.userId,
          actorStaffId: actor.staffId,
          now,
          detail: { teamId: checkin.teamId, seatNo: checkin.seatNo },
        })
        appendAudit(tx, {
          actorUserId: actor.userId,
          event: 'reward.checkin.verified',
          activityId: activity.id,
          now,
          metadata: { checkinId: checkin.id, residentUserId: checkin.userId },
        })

        const verified = loadCheckin(tx, checkin.id)
        if (!verified) {
          throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '签到核验失败')
        }
        return buildCheckin(verified)
      },
      { behavior: 'immediate' },
    )
  } catch (error) {
    throw mapRewardConstraint(error)
  }
}

export interface RevokeCheckinInput {
  activityId: string
  checkinId: string
  reason: string
  now?: Date
}

/** Side effect of a revocation, reported for the audit trail and tests. */
export interface RevokeCheckinConsequence {
  grantId: string | null
  revoked: boolean
  disputed: boolean
}

/**
 * Revokes a check-in. History is never deleted: the row keeps its original
 * `checked_in_at`, `verified_at` and team attribution, and gains the revocation
 * stamp required by migration 0006.
 *
 * If the revocation drops the team below three verified check-ins, the already
 * issued grant must not silently stay valid:
 * - an **unredeemed** grant is revoked and its stock/budget claim is released;
 * - an **already redeemed** grant becomes `disputed` via an appended
 *   `opened` dispute row, and the redeemed stock counters are left untouched.
 */
export function revokeCheckin(
  db: AppDatabase,
  actor: RewardStaffActor,
  input: RevokeCheckinInput,
): ActivityCheckin {
  return revokeCheckinInternal(db, actor, input).checkin
}

/**
 * Same write path, additionally returning which grant changed. Revocation is not
 * a pure function of the check-in — it may revoke or dispute the team's grant —
 * and callers that report on it (tests, future admin responses) need that fact.
 * The consequence is returned, never stashed in module state, so concurrent
 * calls cannot observe each other's result.
 */
export function revokeCheckinWithConsequence(
  db: AppDatabase,
  actor: RewardStaffActor,
  input: RevokeCheckinInput,
): { checkin: ActivityCheckin; consequence: RevokeCheckinConsequence } {
  return revokeCheckinInternal(db, actor, input)
}

function revokeCheckinInternal(
  db: AppDatabase,
  actor: RewardStaffActor,
  input: RevokeCheckinInput,
): { checkin: ActivityCheckin; consequence: RevokeCheckinConsequence } {
  const now = input.now ?? new Date()
  {
    const scopeActivity = requireActivity(db, input.activityId)
    requireStaffScope(db, actor, scopeActivity.communityId, scopeActivity.id, now)
  }
  try {
    return db.transaction(
      (tx) => {
        const activity = requireActivity(tx, input.activityId)

        const checkin = loadCheckin(tx, input.checkinId)
        if (!checkin || checkin.activityId !== activity.id) {
          throw new RewardError(404, API_ERROR_CODES.notFound, 'checkin_not_found', '签到记录不存在')
        }
        if (checkin.status === 'revoked') {
          // Revocation is not idempotent-replayable: the reason of the first
          // revocation is the authoritative one and must not be overwritten.
          throw new RewardError(409, API_ERROR_CODES.conflict, 'checkin_not_found', '该签到已作废')
        }

        const updated = tx
          .update(activityCheckins)
          .set({
            status: 'revoked',
            revokedAt: now,
            revokedByStaffId: actor.staffId,
            revokeReason: input.reason,
          })
          .where(and(eq(activityCheckins.id, checkin.id), eq(activityCheckins.status, 'valid')))
          .run()
        if (updated.changes !== 1) {
          throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '签到已被他人作废')
        }

        appendRewardEvent(tx, {
          activityId: activity.id,
          kind: 'checkin.revoked',
          checkinId: checkin.id,
          actorUserId: checkin.userId,
          actorStaffId: actor.staffId,
          now,
          detail: { teamId: checkin.teamId, reason: input.reason },
        })
        appendAudit(tx, {
          actorUserId: actor.userId,
          event: 'reward.checkin.revoked',
          activityId: activity.id,
          now,
          metadata: { checkinId: checkin.id, residentUserId: checkin.userId },
        })

        const consequence = applyRevocationConsequence(tx, activity, checkin, {
          operator: actor,
          reason: input.reason,
        }, now)
        const revoked = loadCheckin(tx, checkin.id)
        if (!revoked) {
          throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '签到作废失败')
        }
        return { checkin: buildCheckin(revoked), consequence }
      },
      { behavior: 'immediate' },
    )
  } catch (error) {
    throw mapRewardConstraint(error)
  }
}

/**
 * Re-evaluates the grant of a team after one of its check-ins changed, and
 * applies the only two legal consequences. Called inside the caller's
 * transaction so the check-in and the grant can never disagree.
 */
function applyRevocationConsequence(
  tx: RewardTransaction,
  activity: ActivityRow,
  checkin: CheckinRow,
  input: { operator: RewardStaffActor; reason: string },
  now: Date,
): RevokeCheckinConsequence {
  if (checkin.teamId === null) return { grantId: null, revoked: false, disputed: false }
  const frozen = loadFrozenPlan(tx, activity)
  if (frozen === null) return { grantId: null, revoked: false, disputed: false }

  const team = loadTeamContext(tx, activity.id, checkin.userId)
  const teamId = team?.teamId ?? checkin.teamId
  if (team && team.checkinsValid >= CHECKINS_REQUIRED) {
    return { grantId: null, revoked: false, disputed: false }
  }

  // Activity-scoped like every other grant lookup: a grant priced by version 1
  // must still be found after an edit bumps the activity to version 2, otherwise
  // revoking a check-in would silently leave an unearned prize live.
  const grant = tx
    .select(grantSelection())
    .from(activityRewardGrants)
    .innerJoin(activityRuleVersions, eq(activityRewardGrants.ruleVersionId, activityRuleVersions.id))
    .leftJoin(users, eq(activityRewardGrants.recipientUserId, users.id))
    .where(
      and(
        eq(activityRewardGrants.activityId, activity.id),
        eq(activityRewardGrants.teamId, teamId),
        ne(activityRewardGrants.status, 'revoked'),
      ),
    )
    .get()
  if (!grant) return { grantId: null, revoked: false, disputed: false }

  if (grant.status === 'granted') {
    const released = tx
      .update(activityRewardGrants)
      .set({
        status: 'revoked',
        revokedAt: now,
        revokedByStaffId: input.operator.staffId,
        revokeReason: input.reason,
        updatedAt: now,
      })
      .where(and(eq(activityRewardGrants.id, grant.id), eq(activityRewardGrants.status, 'granted')))
      .run()
    if (released.changes !== 1) {
      return { grantId: grant.id, revoked: false, disputed: false }
    }
    // Only an *unredeemed* grant releases its claim; the CHECK constraints keep
    // `redeemed <= claimed` and the budget identity intact.
    tx.update(activityPrizeStocks)
      .set({
        claimedQuantity: sql`${activityPrizeStocks.claimedQuantity} - ${grant.quantity}`,
        committedBudgetCents: sql`${activityPrizeStocks.committedBudgetCents} - ${grant.totalCostCents}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(activityPrizeStocks.activityId, activity.id),
          eq(activityPrizeStocks.prizeName, grant.prizeName),
          sql`${activityPrizeStocks.claimedQuantity} >= ${grant.quantity}`,
        ),
      )
      .run()
    // A still-live credential of a revoked grant must never stay redeemable.
    const activeCode = selectActiveCredential(tx, grant.id)
    if (activeCode) {
      tx.update(activityRewardCodes)
        .set({ status: 'revoked', revokedAt: now })
        .where(and(eq(activityRewardCodes.id, activeCode.id), eq(activityRewardCodes.status, 'active')))
        .run()
    }
    appendRewardEvent(tx, {
      activityId: activity.id,
      kind: 'grant.revoked',
      grantId: grant.id,
      credentialId: activeCode?.id ?? null,
      actorUserId: checkin.userId,
      actorStaffId: input.operator.staffId,
      now,
      detail: { reason: input.reason, cause: 'checkin_revoked' },
    })
    appendAudit(tx, {
      actorUserId: input.operator.userId,
      event: 'reward.grant.revoked',
      activityId: activity.id,
      now,
      metadata: { grantId: grant.id, teamId: grant.teamId, cause: 'checkin_revoked' },
    })
    return { grantId: grant.id, revoked: true, disputed: false }
  }

  if (grant.status === 'redeemed') {
    const disputed = tx
      .update(activityRewardGrants)
      .set({ status: 'disputed', updatedAt: now })
      .where(and(eq(activityRewardGrants.id, grant.id), eq(activityRewardGrants.status, 'redeemed')))
      .run()
    if (disputed.changes !== 1) return { grantId: grant.id, revoked: false, disputed: false }
    tx.insert(activityRewardDisputes)
      .values({
        id: randomUUID(),
        activityId: activity.id,
        grantId: grant.id,
        decision: 'opened',
        reason: input.reason,
        note: '签到撤销后团队不再达标，已核销奖励进入争议',
        actorStaffId: input.operator.staffId,
        createdAt: now,
      })
      .run()
    appendRewardEvent(tx, {
      activityId: activity.id,
      kind: 'dispute.opened',
      grantId: grant.id,
      actorUserId: checkin.userId,
      actorStaffId: input.operator.staffId,
      now,
      detail: { reason: input.reason, cause: 'checkin_revoked' },
    })
    appendAudit(tx, {
      actorUserId: input.operator.userId,
      event: 'reward.dispute.opened',
      activityId: activity.id,
      now,
      metadata: { grantId: grant.id, teamId: grant.teamId, cause: 'checkin_revoked' },
    })
    return { grantId: grant.id, revoked: false, disputed: true }
  }

  return { grantId: grant.id, revoked: false, disputed: false }
}

export function listActivityCheckins(
  db: AppDatabase,
  actor: RewardStaffActor,
  activityId: string,
): AdminActivityCheckinList {
  const activity = requireActivity(db, activityId)
  requireStaffScope(db, actor, activity.communityId, activity.id, new Date())

  const items = db
    .select(checkinSelection())
    .from(activityCheckins)
    .leftJoin(users, eq(activityCheckins.userId, users.id))
    .where(eq(activityCheckins.activityId, activity.id))
    .orderBy(asc(activityCheckins.checkedInAt), asc(activityCheckins.id))
    .limit(500)
    .all()
    .map(buildCheckin)

  const valid = items.filter((item) => item.status === 'valid')
  const verified = items.filter((item) => item.status === 'valid' && item.verifiedAt !== null)
  return adminActivityCheckinListSchema.parse({
    activityId: activity.id,
    items,
    counts: {
      valid: valid.length,
      verified: verified.length,
      pendingVerification: valid.length - verified.length,
      revoked: items.length - valid.length,
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Team reward state and claim                                                */
/* -------------------------------------------------------------------------- */

export interface TeamRewardStateInput {
  activityId: string
  userId: string
  now?: Date
}

function buildTeamRewardState(
  executor: RewardExecutor,
  activity: ActivityRow,
  userId: string,
  now: Date,
): TeamRewardState {
  const frozen = loadFrozenPlan(executor, activity)
  const team = loadTeamContext(executor, activity.id, userId)
  if (!team || team.mySeatNo === null) {
    throw new RewardError(
      409,
      API_ERROR_CODES.rewardUnavailable,
      'team_missing',
      '该居民尚未参与本活动的团队',
    )
  }

  const plan = frozen?.plan ?? null
  const stock = frozen ? selectStock(executor, activity.id, frozen.plan.prizeName) : undefined
  const grantRow = frozen
    ? executor
        .select(grantSelection())
        .from(activityRewardGrants)
        .innerJoin(
          activityRuleVersions,
          eq(activityRewardGrants.ruleVersionId, activityRuleVersions.id),
        )
        .leftJoin(users, eq(activityRewardGrants.recipientUserId, users.id))
        .where(
          and(
            eq(activityRewardGrants.activityId, activity.id),
            eq(activityRewardGrants.teamId, team.teamId),
            ne(activityRewardGrants.status, 'revoked'),
          ),
        )
        .get()
    : undefined

  const seatsSatisfied = team.seatsFilled === SEATS_REQUIRED
  const checkinsSatisfied = team.checkinsValid === CHECKINS_REQUIRED
  const alreadyGranted = grantRow !== undefined

  // Same lifecycle verdict as check-in, so the resident never sees "claimable"
  // next to a closed check-in surface.
  const lifecycle = lifecycleBlockReason(activity, now)
  // Computed once and reused: recomputing here and in `eligible` is exactly how
  // the two answers drifted apart (stock/budget exhaustion used to leave
  // `eligible: true` next to `unavailableReason: 'stock_exhausted'`, which the
  // contract's superRefine rejects with a ZodError → HTTP 500).
  const redemption = frozen === null ? null : redemptionAvailable(frozen, stock)

  let unavailableReason: RewardAvailabilityReason | null = null
  if (frozen === null) unavailableReason = 'reward_plan_not_configured'
  else if (lifecycle !== null) unavailableReason = lifecycle
  else if (!seatsSatisfied) unavailableReason = 'team_incomplete'
  else if (!checkinsSatisfied) unavailableReason = 'checkin_incomplete'
  else if (alreadyGranted) unavailableReason = null
  else unavailableReason = redemption

  // Derived from the reason rather than computed independently: the contract
  // requires `eligible === (unavailableReason === null)` for a team that does
  // not already own the prize, and a projection that can contradict itself is
  // a 500 waiting for the right stock level.
  const eligible =
    frozen !== null &&
    lifecycle === null &&
    seatsSatisfied &&
    checkinsSatisfied &&
    !alreadyGranted &&
    redemption === null

  let claimableByMe = false
  if (eligible && frozen) {
    claimableByMe =
      frozen.plan.claimRecipient === 'leader'
        ? team.leaderUserId === userId
        : team.mySeatNo !== null
  }

  const credentialRow = grantRow ? selectLatestCredential(executor, grantRow.id) : undefined
  const state = teamRewardStateSchema.parse({
    activityId: activity.id,
    teamId: team.teamId,
    ruleVersion: frozen ? frozen.ruleVersion : null,
    planConfigured: plan !== null,
    reward:
      plan === null
        ? null
        : {
            prizeName: plan.prizeName,
            prizeUnitCostCents: plan.prizeUnitCostCents,
            prizeQuantityPerTeam: plan.prizeQuantityPerTeam,
            claimRecipient: plan.claimRecipient,
            redemptionValidHours: plan.redemptionValidHours,
            checkinWindow: plan.checkinWindow,
          },
    requirement: {
      seatsRequired: 3,
      seatsFilled: team.seatsFilled,
      seatsSatisfied,
      checkinsRequired: 3,
      checkinsValid: team.checkinsValid,
      checkinsSatisfied,
    },
    eligible,
    claimableByMe,
    unavailableReason,
    grant: grantRow ? buildGrant(executor, grantRow) : null,
    credential: credentialRow ? buildCredential(credentialRow) : null,
  })
  // `now` is accepted for symmetry with the write paths and future expiry
  // handling; the read path itself is time-independent today.
  void now
  return state
}

export function getTeamRewardState(
  db: AppDatabase,
  input: TeamRewardStateInput,
): TeamRewardState {
  const now = input.now ?? new Date()
  const activity = requireActivity(db, input.activityId)
  return buildTeamRewardState(db, activity, input.userId, now)
}

export interface ClaimTeamRewardInput {
  activityId: string
  userId: string
  now?: Date
}

/**
 * Claims the team prize.
 *
 * Everything happens inside ONE `BEGIN IMMEDIATE` transaction, in this order:
 * 1. resolve the frozen plan (no plan -> `reward_unavailable`, never a fallback);
 * 2. verify 3 seats and 3 verified check-ins of the current members;
 * 3. honour `claimRecipient` and bind the recipient on the first claim only;
 * 4. conditionally occupy stock + budget with `changes() === 1`;
 * 5. insert the grant and mint the credential.
 *
 * Because the stock UPDATE comes before the grant INSERT, a failed occupancy
 * cannot leave a grant behind. `BEGIN IMMEDIATE` plus the
 * `(activity, rule_version, team)` unique index make a concurrent double claim
 * collapse into exactly one grant: the loser re-reads, finds the winner's row
 * and returns `created: false`.
 *
 * Re-claiming an existing grant does not create a second grant. If the existing
 * credential is still `active` it is superseded and a fresh code is minted, so
 * at most one code is ever redeemable and the resident can always obtain the
 * plaintext again (it is not recoverable from the stored hash).
 */
export function claimTeamReward(
  db: AppDatabase,
  input: ClaimTeamRewardInput,
): ActivityRewardClaimResponse {
  const now = input.now ?? new Date()
  try {
    return db.transaction(
      (tx) => {
        const activity = requireActivity(tx, input.activityId)
        const frozen = requirePlan(tx, activity)
        const team = loadTeamContext(tx, activity.id, input.userId)
        if (!team || team.mySeatNo === null) {
          throw new RewardError(
            409,
            API_ERROR_CODES.rewardUnavailable,
            'team_missing',
            '该居民尚未参与本活动的团队',
          )
        }
        // Same verdict as check-in and redemption. This used to test `draft`
        // alone, which let a paused or ended activity keep paying out while its
        // check-in surface was already closed.
        const lifecycle = lifecycleBlockReason(activity, now)
        if (lifecycle !== null) {
          throw new RewardError(
            409,
            API_ERROR_CODES.rewardUnavailable,
            lifecycle,
            lifecycle === 'activity_ended'
              ? '活动已结束，无法领取奖励'
              : '活动未发布，无法领取奖励',
          )
        }

        // Activity-scoped, NOT rule-version-scoped: a published activity can gain
        // new rule versions from ordinary edits, and looking the grant up per
        // version is exactly what let the same team be handed a second prize.
        // Only a `revoked` grant frees the team's slot (mirrors the partial
        // unique index `activity_reward_grants_activity_team_uq`); `expired`,
        // `disputed` and `reversed` all keep it occupied, so the idempotent
        // branch below reports the real state instead of re-issuing.
        const existingGrant = tx
          .select(grantSelection())
          .from(activityRewardGrants)
          .innerJoin(
            activityRuleVersions,
            eq(activityRewardGrants.ruleVersionId, activityRuleVersions.id),
          )
          .leftJoin(users, eq(activityRewardGrants.recipientUserId, users.id))
          .where(
            and(
              eq(activityRewardGrants.activityId, activity.id),
              eq(activityRewardGrants.teamId, team.teamId),
              ne(activityRewardGrants.status, 'revoked'),
            ),
          )
          .get()
        if (existingGrant) {
          // The recipient is bound for the life of the grant. Letting anybody
          // else through here would let a teammate rotate the real recipient's
          // credential: `issueForExistingGrant` supersedes the active code, so
          // the recipient's slip dies and the caller walks away with a working
          // one. That is both a prize handover and a denial-of-service on the
          // recipient's code. `any_member` binds the first member to claim and
          // must stay bound to *that* member afterwards — the mode chooses who
          // may become the recipient, not who may rotate an existing one.
          assertGrantRecipient(existingGrant, input.userId)
          return issueForExistingGrant(tx, activity, frozen, existingGrant, input.userId, now)
        }

        if (team.seatsFilled !== SEATS_REQUIRED) {
          throw new RewardError(
            409,
            API_ERROR_CODES.rewardUnavailable,
            'team_incomplete',
            '团队未满 3 席，暂不满足奖励条件',
          )
        }
        if (team.checkinsValid < CHECKINS_REQUIRED) {
          throw new RewardError(
            409,
            API_ERROR_CODES.rewardUnavailable,
            'checkin_incomplete',
            '团队有效签到不足 3 条，暂不满足奖励条件',
          )
        }
        // `any_member` lets the first member to arrive bind the recipient; the
        // leader rule restricts the claim to the team leader. This is the only
        // place the *plan mode* chooses the recipient; afterwards the bound
        // `recipientUserId` governs (see `assertGrantRecipient`).
        if (frozen.plan.claimRecipient === 'leader' && team.leaderUserId !== input.userId) {
          throw notRecipientError('该奖励仅团队发起人可领取')
        }

        const stock = ensureStockRow(tx, frozen, activity.id, now)
        // Predict with the same predicate the read path projects, so a client
        // that saw `eligible: false / stock_exhausted` gets the matching 409
        // rather than a differently-worded one. The conditional UPDATE further
        // down stays the atomic authority (this check can race).
        assertRedemptionAvailable(frozen, stock)
        const perTeam = frozen.plan.prizeQuantityPerTeam
        // The grant is priced from the frozen snapshot (never relaxed), but the
        // ledger keeps the price it was opened with. They coincide unless an
        // edit re-priced the plan after the first claim, and the ledger's
        // `committed = claimed * unit_cost` CHECK means the money moved must
        // use the row's own unit cost, not the snapshot's.
        const committedCost = perTeam * frozen.plan.prizeUnitCostCents
        const occupied = tx
          .update(activityPrizeStocks)
          .set({
            claimedQuantity: sql`${activityPrizeStocks.claimedQuantity} + ${perTeam}`,
            committedBudgetCents: sql`${activityPrizeStocks.committedBudgetCents} + ${perTeam} * ${activityPrizeStocks.unitCostCents}`,
            updatedAt: now,
          })
          .where(
            and(
              eq(activityPrizeStocks.id, stock.id),
              sql`${activityPrizeStocks.claimedQuantity} + ${perTeam} <= ${activityPrizeStocks.totalQuantity}`,
              sql`${activityPrizeStocks.committedBudgetCents} + ${perTeam} * ${activityPrizeStocks.unitCostCents} <= ${activityPrizeStocks.budgetCapCents}`,
            ),
          )
          .run()
        if (occupied.changes !== 1) {
          // Distinguish "no prize left" from "no money left" so the operator
          // knows whether to buy more prizes or raise the budget.
          const current = selectStock(tx, activity.id, frozen.plan.prizeName)
          if (
            current &&
            current.committedBudgetCents + perTeam * current.unitCostCents > current.budgetCapCents &&
            current.claimedQuantity + perTeam <= current.totalQuantity
          ) {
            throw new RewardError(
              409,
              API_ERROR_CODES.budgetExceeded,
              'budget_exceeded',
              '活动奖励预算不足以再发放一份礼品',
            )
          }
          throw new RewardError(
            409,
            API_ERROR_CODES.prizeStockExhausted,
            'stock_exhausted',
            '奖品库存已发完',
          )
        }

        const grantId = randomUUID()
        tx.insert(activityRewardGrants)
          .values({
            id: grantId,
            activityId: activity.id,
            ruleVersionId: frozen.ruleVersionId,
            teamId: team.teamId,
            // Copied from the frozen snapshot; the trigger re-checks these
            // three values against the same snapshot.
            prizeName: frozen.plan.prizeName,
            quantity: perTeam,
            unitCostCents: frozen.plan.prizeUnitCostCents,
            totalCostCents: committedCost,
            status: 'granted',
            recipientRole: frozen.plan.claimRecipient === 'leader' ? 'leader' : 'member',
            recipientUserId: input.userId,
            grantedAt: now,
            redeemedAt: null,
            redeemedByStaffId: null,
            revokedAt: null,
            revokedByStaffId: null,
            revokeReason: null,
            createdAt: now,
            updatedAt: now,
          })
          .run()

        appendRewardEvent(tx, {
          activityId: activity.id,
          kind: 'grant.created',
          grantId,
          actorUserId: input.userId,
          now,
          detail: {
            teamId: team.teamId,
            ruleVersionId: frozen.ruleVersionId,
            quantity: perTeam,
            totalCostCents: committedCost,
          },
        })
        appendAudit(tx, {
          actorUserId: input.userId,
          event: 'reward.grant.created',
          activityId: activity.id,
          now,
          metadata: {
            grantId,
            teamId: team.teamId,
            ruleVersionId: frozen.ruleVersionId,
            quantity: String(perTeam),
          },
        })

        const { credential, code } = issueCredential(tx, activity, frozen, {
          grantId,
          teamId: team.teamId,
          now,
          actorUserId: input.userId,
        })
        const grantRow = selectGrant(tx, grantId)
        if (!grantRow) {
          throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '奖励创建失败')
        }
        return {
          created: true,
          grant: buildGrant(tx, grantRow),
          credential,
          code,
        }
      },
      { behavior: 'immediate' },
    )
  } catch (error) {
    throw mapRewardConstraint(error)
  }
}

/**
 * Turns the shared availability verdict into the claim-path error. Mirrors the
 * taxonomy the conditional UPDATE already produced, so callers cannot tell
 * which of the two rejected them — they mean the same thing.
 */
function assertRedemptionAvailable(frozen: FrozenPlan, stock: StockRow | undefined): void {
  const reason = redemptionAvailable(frozen, stock)
  if (reason === null) return
  if (reason === 'budget_exhausted') {
    throw new RewardError(
      409,
      API_ERROR_CODES.budgetExceeded,
      'budget_exceeded',
      '活动奖励预算不足以再发放一份礼品',
    )
  }
  throw new RewardError(
    409,
    API_ERROR_CODES.prizeStockExhausted,
    'stock_exhausted',
    '奖品库存已发完',
  )
}

function notRecipientError(message: string): RewardError {
  return new RewardError(403, API_ERROR_CODES.forbidden, 'not_recipient', message)
}

/**
 * The recipient bound to a grant is stable for the grant's lifetime.
 *
 * Applies to both `claimRecipient` modes. `leader` binds the team leader and
 * `any_member` binds whichever member claimed first; in either case a different
 * member must never be able to re-issue (and thereby invalidate) the recipient's
 * credential.
 */
function assertGrantRecipient(grant: GrantRow, userId: string): void {
  if (grant.recipientUserId === null) return
  if (grant.recipientUserId === userId) return
  throw notRecipientError('该奖励已由团队其他成员领取，凭据只发给受领人本人')
}

function issueForExistingGrant(
  tx: RewardTransaction,
  activity: ActivityRow,
  frozen: FrozenPlan,
  grant: GrantRow,
  userId: string,
  now: Date,
): ActivityRewardClaimResponse {
  if (grant.status !== 'granted' && grant.status !== 'redeemed') {
    throw new RewardError(
      409,
      API_ERROR_CODES.rewardUnavailable,
      'not_eligible',
      '该团队的奖励已作废或进入争议，请联系工作人员',
    )
  }
  if (grant.status === 'redeemed') {
    // Re-issuing here used to mint an `active` code that could never be
    // redeemed (`redeemCredential` answers 409 `reward_already_redeemed`), and
    // the admin overview counted it as an in-flight credential. The prize is
    // already gone; say so plainly instead of handing out a dead code.
    throw new RewardError(
      409,
      API_ERROR_CODES.rewardAlreadyRedeemed,
      'reward_already_redeemed',
      '该奖励已核销，无法再次领取',
    )
  }
  const active = selectActiveCredential(tx, grant.id)
  const { credential, code } = issueCredential(tx, activity, frozen, {
    grantId: grant.id,
    teamId: grant.teamId,
    now,
    actorUserId: userId,
    supersede: active,
  })
  const refreshed = selectGrant(tx, grant.id)
  return {
    created: false,
    grant: buildGrant(tx, refreshed ?? grant),
    credential,
    code,
  }
}

/**
 * Mints a credential and returns its plaintext exactly once. Any still-active
 * previous code of the same grant is superseded first, so the partial unique
 * index `(grant_id) WHERE status='active'` always sees at most one live row.
 */
function issueCredential(
  tx: RewardTransaction,
  activity: ActivityRow,
  frozen: FrozenPlan,
  input: {
    grantId: string
    teamId: string
    now: Date
    actorUserId: string
    supersede?: CredentialRow
  },
): { credential: ActivityRewardCredential; code: string } {
  if (input.supersede) {
    const superseded = tx
      .update(activityRewardCodes)
      .set({ status: 'superseded', supersededAt: input.now })
      .where(
        and(eq(activityRewardCodes.id, input.supersede.id), eq(activityRewardCodes.status, 'active')),
      )
      .run()
    if (superseded.changes !== 1) {
      throw new RewardError(
        409,
        API_ERROR_CODES.conflict,
        'concurrent_conflict',
        '凭据换发冲突，请重试',
      )
    }
    appendRewardEvent(tx, {
      activityId: activity.id,
      kind: 'credential.superseded',
      grantId: input.grantId,
      credentialId: input.supersede.id,
      actorUserId: input.actorUserId,
      now: input.now,
    })
  }

  const credentialId = randomUUID()
  const code = generateCredentialCode()
  const codeSuffix = code.slice(-4)
  const expiresAt = new Date(input.now.getTime() + frozen.plan.redemptionValidHours * 3_600_000)
  tx.insert(activityRewardCodes)
    .values({
      id: credentialId,
      grantId: input.grantId,
      activityId: activity.id,
      teamId: input.teamId,
      // Only the hash is persisted; the plaintext lives in this response only.
      codeHash: hashCredentialCode(code),
      codeSuffix,
      prizeName: frozen.plan.prizeName,
      status: 'active',
      issuedAt: input.now,
      expiresAt,
      redeemedAt: null,
      redeemedByStaffId: null,
      supersededAt: null,
      revokedAt: null,
    })
    .run()
  appendRewardEvent(tx, {
    activityId: activity.id,
    kind: 'credential.issued',
    grantId: input.grantId,
    credentialId,
    actorUserId: input.actorUserId,
    now: input.now,
    detail: { expiresAt: expiresAt.toISOString() },
  })
  appendAudit(tx, {
    actorUserId: input.actorUserId,
    event: 'reward.credential.issued',
    activityId: activity.id,
    now: input.now,
    metadata: { grantId: input.grantId, credentialId },
  })

  const row = tx
    .select(credentialSelection())
    .from(activityRewardCodes)
    .where(eq(activityRewardCodes.id, credentialId))
    .get()
  if (!row) {
    throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '凭据签发失败')
  }
  return { credential: buildCredential(row), code }
}

export interface TeamCredentialInput {
  activityId: string
  userId: string
}

/**
 * Metadata of the resident's own credential. The plaintext is unrecoverable by
 * design, so this never returns a usable code.
 */
export function getMyCredential(
  db: AppDatabase,
  input: TeamCredentialInput,
): ActivityRewardCredential | null {
  const activity = requireActivity(db, input.activityId)
  const frozen = loadFrozenPlan(db, activity)
  if (frozen === null) return null
  const team = loadTeamContext(db, activity.id, input.userId)
  if (!team || team.mySeatNo === null) return null
  const grant = db
    .select({ id: activityRewardGrants.id })
    .from(activityRewardGrants)
    .where(
      and(
        eq(activityRewardGrants.activityId, activity.id),
        eq(activityRewardGrants.teamId, team.teamId),
        ne(activityRewardGrants.status, 'revoked'),
      ),
    )
    .get()
  if (!grant) return null
  const credential = selectLatestCredential(db, grant.id)
  return credential ? buildCredential(credential) : null
}

/* -------------------------------------------------------------------------- */
/* Redemption                                                                 */
/* -------------------------------------------------------------------------- */

export interface RedeemCredentialInput {
  code: string
  note?: string
  now?: Date
}

/**
 * Redeems a credential exactly once.
 *
 * The one-time guarantee is the conditional `UPDATE ... WHERE status='active'`
 * with `changes() === 1`, not a read-then-write check: two staff phones scanning
 * the same slip at the same moment produce exactly one redemption and one
 * `reward_already_redeemed` (or a safe conflict) for the loser.
 *
 * Failure taxonomy is deliberately explicit so staff can act:
 * - unknown/malformed/superseded/revoked code -> 404 `redemption_code_invalid`
 * - code of another community -> 403 `forbidden`
 * - code whose TTL has passed -> the row is moved to `expired` and
 *   `redemption_code_expired` is returned (400); an already-expired row keeps
 *   answering the same way, so the verdict for one code never changes
 * - code already redeemed -> 409 `reward_already_redeemed`
 */
export function redeemCredential(
  db: AppDatabase,
  actor: RewardStaffActor,
  input: RedeemCredentialInput,
): RewardRedeemResponse {
  const now = input.now ?? new Date()
  const parsed = credentialCodeSchema.safeParse(input.code)
  if (!parsed.success) {
    throw new RewardError(
      400,
      API_ERROR_CODES.redemptionCodeInvalid,
      'code_invalid',
      '核销码格式不正确',
    )
  }
  const codeHash = hashCredentialCode(parsed.data)
  /**
   * Expiry is a durable fact, so the `expired` marker must survive the rejection.
   * Throwing from inside the transaction would roll the marker back, so the
   * transaction returns this sentinel and the error is raised after it commits.
   */
  const EXPIRED = Symbol('credential_expired')

  // The activity is only known via the code hash, so resolve it read-only first:
  // the scope decision (and its durable audit row) must happen outside the
  // transaction that the 403 will roll back. An unknown code is left to the
  // transaction, which reports 404 without needing a scope decision.
  const located = db
    .select({ activityId: activityRewardCodes.activityId })
    .from(activityRewardCodes)
    .where(eq(activityRewardCodes.codeHash, codeHash))
    .get()
  if (located) {
    const scopeActivity = requireActivity(db, located.activityId)
    requireStaffScope(db, actor, scopeActivity.communityId, scopeActivity.id, now)
  }

  try {
    const outcome = db.transaction(
      (tx): RewardRedeemResponse | typeof EXPIRED => {
        const row = tx
          .select({
            id: activityRewardCodes.id,
            grantId: activityRewardCodes.grantId,
            activityId: activityRewardCodes.activityId,
            status: activityRewardCodes.status,
            expiresAt: activityRewardCodes.expiresAt,
          })
          .from(activityRewardCodes)
          .where(eq(activityRewardCodes.codeHash, codeHash))
          .get()
        if (!row) {
          // Agreed contract with the routes layer: an unknown or forged code is
          // a 404 `redemption_code_invalid`, not a 400. Nothing about the
          // credential's existence may leak through the status code.
          throw new RewardError(
            404,
            API_ERROR_CODES.redemptionCodeInvalid,
            'code_invalid',
            '核销码无效',
          )
        }

        // Scope was already enforced before the transaction; a foreign-community
        // actor never reaches this point, and the grant below carries its own
        // activity scope from the 0006 `grant_scope` trigger.
        if (row.status === 'redeemed') {
          throw new RewardError(
            409,
            API_ERROR_CODES.rewardAlreadyRedeemed,
            'reward_already_redeemed',
            '该核销码已被核销',
          )
        }
        if (row.status !== 'active') {
          // An expired code always answers "expired", never a generic "invalid":
          // the holder has a real slip that ran out of time, and repeating the
          // call must not downgrade the message into something staff would read
          // as "this code was never ours". It leaks nothing usable either — the
          // code is worthless once its TTL has passed.
          if (row.status === 'expired') return EXPIRED
          // A superseded/revoked code is reported exactly like an unknown one
          // (404, same code) so a stranger holding an old slip cannot probe which
          // codes ever existed. The message still helps the real holder.
          throw new RewardError(
            404,
            API_ERROR_CODES.redemptionCodeInvalid,
            'code_invalid',
            row.status === 'superseded' ? '核销码已失效，请使用最新凭据' : '核销码已作废',
          )
        }
        // Lifecycle gate. A paused or ended activity must not honour a
        // credential: paying out after the activity closed is a fake
        // fulfilment. It is reported as 409 `reward_unavailable` rather than a
        // 404 "invalid code", because the code is genuine and staff need to
        // understand the activity is closed, not that the resident was handed
        // a bad slip.
        const activity = requireActivity(tx, row.activityId)
        const lifecycle = lifecycleBlockReason(activity, now)
        if (lifecycle !== null) {
          throw new RewardError(
            409,
            API_ERROR_CODES.rewardUnavailable,
            lifecycle,
            lifecycle === 'activity_ended'
              ? '活动已结束，无法核销奖励'
              : '活动未发布或已暂停，无法核销奖励',
          )
        }
        if (row.expiresAt.getTime() <= now.getTime()) {
          tx.update(activityRewardCodes)
            .set({ status: 'expired' })
            .where(and(eq(activityRewardCodes.id, row.id), eq(activityRewardCodes.status, 'active')))
            .run()
          return EXPIRED
        }

        const codeRedeemed = tx
          .update(activityRewardCodes)
          .set({ status: 'redeemed', redeemedAt: now, redeemedByStaffId: actor.staffId })
          .where(and(eq(activityRewardCodes.id, row.id), eq(activityRewardCodes.status, 'active')))
          .run()
        if (codeRedeemed.changes !== 1) {
          throw new RewardError(
            409,
            API_ERROR_CODES.rewardAlreadyRedeemed,
            'reward_already_redeemed',
            '该核销码已被核销',
          )
        }

        const grant = selectGrant(tx, row.grantId)
        if (!grant) {
          throw new RewardError(404, API_ERROR_CODES.notFound, 'grant_not_found', '奖励记录不存在')
        }
        const grantRedeemed = tx
          .update(activityRewardGrants)
          .set({
            status: 'redeemed',
            redeemedAt: now,
            redeemedByStaffId: actor.staffId,
            updatedAt: now,
          })
          .where(
            and(eq(activityRewardGrants.id, grant.id), eq(activityRewardGrants.status, 'granted')),
          )
          .run()
        if (grantRedeemed.changes !== 1) {
          throw new RewardError(
            409,
            API_ERROR_CODES.rewardAlreadyRedeemed,
            'reward_already_redeemed',
            '该奖励已被核销',
          )
        }

        // `redeemed` is monotonic: it may only grow, and never past `claimed`.
        const stockUpdated = tx
          .update(activityPrizeStocks)
          .set({
            redeemedQuantity: sql`${activityPrizeStocks.redeemedQuantity} + ${grant.quantity}`,
            redeemedBudgetCents: sql`${activityPrizeStocks.redeemedBudgetCents} + ${grant.totalCostCents}`,
            updatedAt: now,
          })
          .where(
            and(
              eq(activityPrizeStocks.activityId, grant.activityId),
              eq(activityPrizeStocks.prizeName, grant.prizeName),
              sql`${activityPrizeStocks.redeemedQuantity} + ${grant.quantity} <= ${activityPrizeStocks.claimedQuantity}`,
            ),
          )
          .run()
        if (stockUpdated.changes !== 1) {
          throw new RewardError(
            409,
            API_ERROR_CODES.conflict,
            'concurrent_conflict',
            '库存台账与奖励不一致，请刷新后重试',
          )
        }

        appendRewardEvent(tx, {
          activityId: grant.activityId,
          kind: 'grant.redeemed',
          grantId: grant.id,
          credentialId: row.id,
          actorStaffId: actor.staffId,
          now,
          detail: {
            quantity: grant.quantity,
            totalCostCents: grant.totalCostCents,
            ...(input.note ? { note: input.note } : {}),
          },
        })
        appendAudit(tx, {
          actorUserId: actor.userId,
          event: 'reward.grant.redeemed',
          activityId: grant.activityId,
          now,
          metadata: { grantId: grant.id, credentialId: row.id, teamId: grant.teamId },
        })

        const refreshedGrant = selectGrant(tx, grant.id)
        const refreshedCode = tx
          .select(credentialSelection())
          .from(activityRewardCodes)
          .where(eq(activityRewardCodes.id, row.id))
          .get()
        if (!refreshedGrant || !refreshedCode) {
          throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '核销失败')
        }
        return {
          redeemed: true,
          grant: buildGrant(tx, refreshedGrant),
          credential: buildCredential(refreshedCode),
        }
      },
      { behavior: 'immediate' },
    )
    if (outcome === EXPIRED) {
      throw new RewardError(
        400,
        API_ERROR_CODES.redemptionCodeExpired,
        'code_expired',
        '核销码已过期',
      )
    }
    return outcome
  } catch (error) {
    throw mapRewardConstraint(error)
  }
}

/* -------------------------------------------------------------------------- */
/* Manual revocation and disputes (append-only)                               */
/* -------------------------------------------------------------------------- */

export interface RevokeGrantInput {
  activityId: string
  grantId: string
  reason: string
  now?: Date
}

/**
 * Revokes an *unredeemed* grant and releases its stock/budget claim. A redeemed
 * grant cannot be revoked — that would silently erase a prize someone already
 * holds — so it must go through the dispute thread instead.
 */
export function revokeGrant(
  db: AppDatabase,
  actor: RewardStaffActor,
  input: RevokeGrantInput,
): ActivityRewardGrant {
  const now = input.now ?? new Date()
  {
    const scopeActivity = requireActivity(db, input.activityId)
    requireStaffScope(db, actor, scopeActivity.communityId, scopeActivity.id, now)
  }
  try {
    return db.transaction(
      (tx) => {
        const activity = requireActivity(tx, input.activityId)
        const grant = selectGrant(tx, input.grantId)
        if (!grant || grant.activityId !== activity.id) {
          throw new RewardError(404, API_ERROR_CODES.notFound, 'grant_not_found', '奖励记录不存在')
        }
        if (grant.status === 'redeemed' || grant.status === 'disputed' || grant.status === 'reversed') {
          throw new RewardError(
            409,
            API_ERROR_CODES.rewardAlreadyRedeemed,
            'grant_already_redeemed',
            '已核销的奖励只能通过争议流程冲正，不能直接作废',
          )
        }
        if (grant.status === 'revoked') {
          throw new RewardError(409, API_ERROR_CODES.conflict, 'grant_not_found', '该奖励已作废')
        }

        const revoked = tx
          .update(activityRewardGrants)
          .set({
            status: 'revoked',
            revokedAt: now,
            revokedByStaffId: actor.staffId,
            revokeReason: input.reason,
            updatedAt: now,
          })
          .where(
            and(
              eq(activityRewardGrants.id, grant.id),
              sql`${activityRewardGrants.status} IN ('granted', 'expired')`,
            ),
          )
          .run()
        if (revoked.changes !== 1) {
          throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '奖励已被他人处理')
        }

        tx.update(activityPrizeStocks)
          .set({
            claimedQuantity: sql`${activityPrizeStocks.claimedQuantity} - ${grant.quantity}`,
            committedBudgetCents: sql`${activityPrizeStocks.committedBudgetCents} - ${grant.totalCostCents}`,
            updatedAt: now,
          })
          .where(
            and(
              eq(activityPrizeStocks.activityId, grant.activityId),
              eq(activityPrizeStocks.prizeName, grant.prizeName),
              sql`${activityPrizeStocks.claimedQuantity} >= ${grant.quantity}`,
            ),
          )
          .run()

        const activeCode = selectActiveCredential(tx, grant.id)
        if (activeCode) {
          tx.update(activityRewardCodes)
            .set({ status: 'revoked', revokedAt: now })
            .where(
              and(eq(activityRewardCodes.id, activeCode.id), eq(activityRewardCodes.status, 'active')),
            )
            .run()
        }

        appendRewardEvent(tx, {
          activityId: grant.activityId,
          kind: 'grant.revoked',
          grantId: grant.id,
          credentialId: activeCode?.id ?? null,
          actorStaffId: actor.staffId,
          now,
          detail: { reason: input.reason },
        })
        appendAudit(tx, {
          actorUserId: actor.userId,
          event: 'reward.grant.revoked',
          activityId: grant.activityId,
          now,
          metadata: { grantId: grant.id, teamId: grant.teamId },
        })

        const refreshed = selectGrant(tx, grant.id)
        if (!refreshed) {
          throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '奖励作废失败')
        }
        return buildGrant(tx, refreshed)
      },
      { behavior: 'immediate' },
    )
  } catch (error) {
    throw mapRewardConstraint(error)
  }
}

export interface AppendGrantDisputeInput {
  activityId: string
  grantId: string
  decision: RewardDisputeDecision
  reason: string
  note?: string
  now?: Date
}

/**
 * Appends one entry to the dispute thread of a grant.
 *
 * `opened` moves a `redeemed` grant to `disputed`; `reversed` moves it to
 * `reversed`; `dismissed` moves it back to `redeemed` (t17). None of them touch
 * the redeemed stock counters, so the ledger and the audit trail always agree:
 * a reversal is a new fact, never a deletion of the old one.
 *
 * `disputed -> redeemed` was added in migration 0007. Before it, a dismissed
 * dispute closed the thread while leaving the grant flagged `disputed` forever,
 * which made `stock.redeemed_quantity` and `counts.grantsRedeemed` disagree by
 * one permanently. The thread itself is still append-only and never rewritten -
 * dismissing restores a status flag; it does not re-redeem, and the redemption
 * marks stay exactly as they were.
 */
export function appendGrantDispute(
  db: AppDatabase,
  actor: RewardStaffActor,
  input: AppendGrantDisputeInput,
): ActivityRewardDisputeThread {
  const now = input.now ?? new Date()
  {
    const scopeActivity = requireActivity(db, input.activityId)
    requireStaffScope(db, actor, scopeActivity.communityId, scopeActivity.id, now)
  }
  try {
    return db.transaction(
      (tx) => {
        const activity = requireActivity(tx, input.activityId)
        const grant = selectGrant(tx, input.grantId)
        if (!grant || grant.activityId !== activity.id) {
          throw new RewardError(404, API_ERROR_CODES.notFound, 'grant_not_found', '奖励记录不存在')
        }

        const openDisputeId = selectOpenDisputeId(tx, grant.id)
        if (input.decision === 'opened') {
          if (grant.status !== 'redeemed') {
            throw new RewardError(
              409,
              API_ERROR_CODES.conflict,
              'dispute_not_open',
              '只有已核销的奖励可以发起争议',
            )
          }
          if (openDisputeId !== null) {
            throw new RewardError(409, API_ERROR_CODES.conflict, 'dispute_not_open', '该奖励已有进行中的争议')
          }
          // The `activity_reward_disputes_open_first` trigger allows at most one
          // `opened` entry per grant, so a thread that has already been closed
          // (dismissed or reversed) can never be re-litigated. Checked here so the
          // caller gets a structured 409 instead of a raw SQLite abort escaping
          // `mapRewardConstraint` - restoring the grant to `redeemed` in t17 made
          // this reachable, where before the `grant.status !== 'disputed'` guard refused first.
          if (selectDisputeThreadExists(tx, grant.id)) {
            throw new RewardError(
              409,
              API_ERROR_CODES.conflict,
              'dispute_already_resolved',
              '该奖励的争议已裁定，不能再发起新的争议',
            )
          }
          const moved = tx
            .update(activityRewardGrants)
            .set({ status: 'disputed', updatedAt: now })
            .where(
              and(eq(activityRewardGrants.id, grant.id), eq(activityRewardGrants.status, 'redeemed')),
            )
            .run()
          if (moved.changes !== 1) {
            throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '奖励状态已变更')
          }
        } else {
          if (grant.status !== 'disputed' || openDisputeId === null) {
            throw new RewardError(
              409,
              API_ERROR_CODES.conflict,
              'dispute_not_open',
              '没有进行中的争议可以裁定',
            )
          }
          if (input.decision === 'reversed') {
            const moved = tx
              .update(activityRewardGrants)
              .set({ status: 'reversed', updatedAt: now })
              .where(
                and(eq(activityRewardGrants.id, grant.id), eq(activityRewardGrants.status, 'disputed')),
              )
              .run()
            if (moved.changes !== 1) {
              throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '奖励状态已变更')
            }
          } else {
            // `dismissed` means the prize was handed over correctly, so the grant
            // returns to `redeemed`. Leaving it `disputed` (the pre-t17 behaviour)
            // stranded it permanently: every recovery path answered 409, and the
            // stock ledger (`redeemed_quantity`) then disagreed with
            // `counts.grantsRedeemed` for good, while the resident surface kept
            // telling the resident a dispute was still in progress.
            // The redemption marks (`redeemed_at` / `redeemed_by_staff_id`) are
            // untouched - this restores a flag, it does not re-redeem anything.
            const moved = tx
              .update(activityRewardGrants)
              .set({ status: 'redeemed', updatedAt: now })
              .where(
                and(eq(activityRewardGrants.id, grant.id), eq(activityRewardGrants.status, 'disputed')),
              )
              .run()
            if (moved.changes !== 1) {
              throw new RewardError(409, API_ERROR_CODES.conflict, 'concurrent_conflict', '奖励状态已变更')
            }
          }
        }

        tx.insert(activityRewardDisputes)
          .values({
            id: randomUUID(),
            activityId: grant.activityId,
            grantId: grant.id,
            decision: input.decision,
            reason: input.reason,
            note: input.note ?? null,
            actorStaffId: actor.staffId,
            createdAt: now,
          })
          .run()

        const kind: RewardEventKind =
          input.decision === 'opened'
            ? 'dispute.opened'
            : input.decision === 'reversed'
              ? 'dispute.reversed'
              : 'dispute.dismissed'
        appendRewardEvent(tx, {
          activityId: grant.activityId,
          kind,
          grantId: grant.id,
          actorStaffId: actor.staffId,
          now,
          detail: { decision: input.decision, reason: input.reason },
        })
        appendAudit(tx, {
          actorUserId: actor.userId,
          event: `reward.${kind}`,
          activityId: grant.activityId,
          now,
          metadata: { grantId: grant.id, teamId: grant.teamId },
        })

        return buildDisputeThread(tx, grant.id)
      },
      { behavior: 'immediate' },
    )
  } catch (error) {
    throw mapRewardConstraint(error)
  }
}

function buildDisputeThread(
  executor: RewardExecutor,
  grantId: string,
): ActivityRewardDisputeThread {
  const entries = executor
    .select({
      id: activityRewardDisputes.id,
      activityId: activityRewardDisputes.activityId,
      grantId: activityRewardDisputes.grantId,
      decision: activityRewardDisputes.decision,
      reason: activityRewardDisputes.reason,
      note: activityRewardDisputes.note,
      actorStaffId: activityRewardDisputes.actorStaffId,
      createdAt: activityRewardDisputes.createdAt,
    })
    .from(activityRewardDisputes)
    .where(eq(activityRewardDisputes.grantId, grantId))
    .orderBy(asc(activityRewardDisputes.createdAt), asc(activityRewardDisputes.id))
    .limit(100)
    .all()
    .map((row) =>
      activityRewardDisputeSchema.parse({
        id: row.id,
        activityId: row.activityId,
        grantId: row.grantId,
        decision: row.decision,
        reason: row.reason,
        note: row.note,
        actorStaffId: row.actorStaffId,
        createdAt: iso(row.createdAt),
      }),
    )
  // The thread contract requires a non-empty list; a grant without a dispute has
  // no thread at all, which the caller must render as "no dispute".
  if (entries.length === 0) {
    throw new RewardError(404, API_ERROR_CODES.notFound, 'grant_not_found', '该奖励没有争议记录')
  }
  const last = entries[entries.length - 1]
  return activityRewardDisputeThreadSchema.parse({
    grantId,
    open: last?.decision === 'opened',
    entries,
  })
}


/**
 * Admin overview of one activity's fulfilment. `planSource` is always
 * `rule_version_snapshot` when a plan exists — there is no code path that
 * reports the mutable activity columns as a plan source.
 */
export function getAdminRewardOverview(
  db: AppDatabase,
  actor: RewardStaffActor,
  activityId: string,
): AdminActivityRewardOverview {
  const activity = requireActivity(db, activityId)
  requireStaffScope(db, actor, activity.communityId, activity.id, new Date())
  const frozen = loadFrozenPlan(db, activity)

  const checkins = db
    .select({ status: activityCheckins.status, verifiedAt: activityCheckins.verifiedAt })
    .from(activityCheckins)
    .where(eq(activityCheckins.activityId, activity.id))
    .all()
  const validCheckins = checkins.filter((row) => row.status === 'valid')
  const verifiedCheckins = validCheckins.filter((row) => row.verifiedAt !== null)

  // Every grant of the activity, across all rule versions: a grant keeps the
  // version it was priced by (provenance), and filtering by the *current*
  // version would hide real grants as soon as an edit bumps it — the projection
  // would claim `grantsTotal = 1` while the ledger held two.
  const grantRows = db
    .select(grantSelection())
    .from(activityRewardGrants)
    .innerJoin(
      activityRuleVersions,
      eq(activityRewardGrants.ruleVersionId, activityRuleVersions.id),
    )
    .leftJoin(users, eq(activityRewardGrants.recipientUserId, users.id))
    .where(eq(activityRewardGrants.activityId, activity.id))
    .orderBy(desc(activityRewardGrants.grantedAt), desc(activityRewardGrants.id))
    .limit(500)
    .all()

  const codes = db
    .select({
      status: activityRewardCodes.status,
      // The grant status decides whether an `active` code can actually be
      // honoured: a redeemed grant leaves behind a code nothing will accept.
      grantStatus: activityRewardGrants.status,
    })
    .from(activityRewardCodes)
    .innerJoin(activityRewardGrants, eq(activityRewardCodes.grantId, activityRewardGrants.id))
    .where(eq(activityRewardCodes.activityId, activity.id))
    .all()

  const grants = grantRows.map((row) => {
    const credential = selectLatestCredential(db, row.id)
    const openDispute = selectOpenDisputeId(db, row.id) !== null
    return {
      grant: buildGrant(db, row),
      credentialStatus: credential ? credential.status : null,
      credentialMaskedCode: credential ? maskCredentialCode(credential.codeSuffix) : null,
      credentialIssuedAt: credential ? iso(credential.issuedAt) : null,
      credentialExpiresAt: credential ? iso(credential.expiresAt) : null,
      openDispute,
    }
  })

  const countByStatus = (status: RewardGrantStatus) =>
    grantRows.filter((row) => row.status === status).length

  return adminActivityRewardOverviewSchema.parse({
    activityId: activity.id,
    activityStatus: activity.status,
    ruleVersion: frozen ? frozen.ruleVersion : null,
    planSource: frozen ? 'rule_version_snapshot' : 'none',
    planConfigured: frozen !== null,
    plan: frozen ? frozen.plan : null,
    stock: frozen
      ? projectStock(
          frozen,
          selectStock(db, activity.id, frozen.plan.prizeName),
          activity.id,
          activity.updatedAt,
        )
      : null,
    counts: {
      checkinsValid: validCheckins.length,
      checkinsVerified: verifiedCheckins.length,
      checkinsPendingVerification: validCheckins.length - verifiedCheckins.length,
      checkinsRevoked: checkins.length - validCheckins.length,
      grantsTotal: grantRows.length,
      grantsGranted: countByStatus('granted'),
      grantsRedeemed: countByStatus('redeemed'),
      grantsRevoked: countByStatus('revoked'),
      grantsDisputed: countByStatus('disputed'),
      grantsReversed: countByStatus('reversed'),
      // A code on a redeemed/revoked grant is not in flight, whatever its own
      // status says. Counting it would advertise a credential that redemption
      // can only refuse.
      codesActive: codes.filter(
        (row) => row.status === 'active' && row.grantStatus === 'granted',
      ).length,
      codesRedeemed: codes.filter((row) => row.status === 'redeemed').length,
    },
    grants,
  })
}

/* -------------------------------------------------------------------------- */
/* Constraint mapping                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Translates the database's last-line-of-defence failures into domain errors so
 * a route never leaks a raw SqliteError. Migration 0006's triggers raise
 * descriptive messages; the two that a legitimate code path can provoke are
 * mapped explicitly, everything else becomes a retryable conflict.
 */
function mapRewardConstraint(error: unknown): RewardError {
  if (error instanceof RewardError) return error
  if (error instanceof Error) {
    if (/check-in is outside the frozen check-in window/u.test(error.message)) {
      return new RewardError(
        409,
        API_ERROR_CODES.rewardUnavailable,
        'checkin_window_closed',
        '签到时间不在活动签到窗口内',
      )
    }
    if (/check-in team must belong to the same activity/u.test(error.message)) {
      return new RewardError(
        409,
        API_ERROR_CODES.rewardUnavailable,
        'not_a_team_member',
        '签到归属团队与活动不一致',
      )
    }
    if (/UNIQUE constraint failed|constraint failed/u.test(error.message)) {
      return new RewardError(
        409,
        API_ERROR_CODES.conflict,
        'concurrent_conflict',
        '并发操作冲突，请刷新后重试',
      )
    }
  }
  throw error
}
