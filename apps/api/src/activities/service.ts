import { randomUUID } from 'node:crypto'
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  activityAuditEntryListResponseSchema,
  activityKeyRulesSchema,
  activityKeyRulesWriteSchema,
  findCheckinWindowIssues,
  activityPublicRulesSchema,
  activityRewardPlanSchema,
  activityRuleVersionListResponseSchema,
  adminActivityDetailSchema,
  adminActivityListResponseSchema,
  publicActivityDetailSchema,
  publicActivityListResponseSchema,
  type ActivityAuditEntryListResponse,
  type ActivityKeyRules,
  type ActivityPublicRules,
  type ActivityRewardPlan,
  type ActivityRuleVersionListResponse,
  type ActivityStatus,
  type AdminActivityDetail,
  type AdminActivityListResponse,
  type ApiErrorCode,
  type CreateActivityRequest,
  type PublicActivityDetail,
  type PublicActivityListResponse,
  type UpdateActivityRequest,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  activityRuleVersions,
  auditLogs,
  communities,
  staffCommunityAssignments,
  users,
} from '../db/schema.js'

const PUBLIC_STATUSES: ActivityStatus[] = ['published', 'paused', 'ended']

/** Staff roles allowed to operate the activity domain. grid_worker is rejected by the routes. */
export interface ActivityOperator {
  userId: string
  staffId: string
  role: 'admin' | 'operator'
}

/**
 * Domain error carrying the HTTP status and shared error code. Routes translate it
 * into the standard `{ error: { code, message, requestId } }` envelope.
 */
export class ActivityError extends Error {
  status: 400 | 403 | 404 | 409
  code: ApiErrorCode

  constructor(status: 400 | 403 | 404 | 409, code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'ActivityError'
    this.status = status
    this.code = code
  }
}

type ActivityTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]
type ActivityInsert = typeof activities.$inferInsert

const adminSelection = {
  id: activities.id,
  title: activities.title,
  summary: activities.summary,
  description: activities.description,
  status: activities.status,
  startsAt: activities.startsAt,
  endsAt: activities.endsAt,
  location: activities.location,
  budgetCapCents: activities.budgetCapCents,
  prizeQuantityCap: activities.prizeQuantityCap,
  publicRulesJson: activities.publicRulesJson,
  rewardPlanJson: activities.rewardPlanJson,
  currentRuleVersionId: activities.currentRuleVersionId,
  ruleVersion: activityRuleVersions.version,
  createdAt: activities.createdAt,
  updatedAt: activities.updatedAt,
  publishedAt: activities.publishedAt,
  pausedAt: activities.pausedAt,
  endedAt: activities.endedAt,
  communityId: communities.id,
  communityName: communities.name,
}

interface ActivityRow {
  id: string
  title: string
  summary: string | null
  description: string | null
  status: ActivityStatus
  startsAt: Date
  endsAt: Date
  location: string
  budgetCapCents: number
  prizeQuantityCap: number
  publicRulesJson: string
  rewardPlanJson: string | null
  currentRuleVersionId: string | null
  ruleVersion: number | null
  createdAt: Date
  updatedAt: Date
  publishedAt: Date | null
  pausedAt: Date | null
  endedAt: Date | null
  communityId: string
  communityName: string
}

function activityQuery(db: AppDatabase) {
  return db
    .select(adminSelection)
    .from(activities)
    .innerJoin(communities, eq(activities.communityId, communities.id))
    .leftJoin(
      activityRuleVersions,
      eq(activities.currentRuleVersionId, activityRuleVersions.id),
    )
}

function findActivity(db: AppDatabase, activityId: string): ActivityRow | undefined {
  return activityQuery(db).where(eq(activities.id, activityId)).get()
}

function requireActivity(db: AppDatabase, activityId: string): ActivityRow {
  const row = findActivity(db, activityId)
  if (!row) throw new ActivityError(404, API_ERROR_CODES.notFound, '活动不存在')
  return row
}

function assignedCommunityIds(db: AppDatabase, staffId: string): string[] {
  return db
    .select({ communityId: staffCommunityAssignments.communityId })
    .from(staffCommunityAssignments)
    .where(eq(staffCommunityAssignments.staffAccountId, staffId))
    .all()
    .map((row) => row.communityId)
}

function assertCommunityAccess(
  db: AppDatabase,
  actor: ActivityOperator,
  communityId: string,
): void {
  if (actor.role === 'admin') return
  const assignment = db
    .select({ communityId: staffCommunityAssignments.communityId })
    .from(staffCommunityAssignments)
    .where(
      and(
        eq(staffCommunityAssignments.staffAccountId, actor.staffId),
        eq(staffCommunityAssignments.communityId, communityId),
      ),
    )
    .get()
  if (!assignment) {
    throw new ActivityError(403, API_ERROR_CODES.forbidden, '无权访问该社区的活动')
  }
}

function iso(timestamp: Date): string {
  return timestamp.toISOString()
}

function isoOrNull(timestamp: Date | null): string | null {
  return timestamp === null ? null : timestamp.toISOString()
}

function parsePublicRules(publicRulesJson: string): ActivityPublicRules {
  const parsed: unknown = JSON.parse(publicRulesJson)
  return activityPublicRulesSchema.parse(parsed)
}

function parseRewardPlan(rewardPlanJson: string | null): ActivityRewardPlan | null {
  if (rewardPlanJson === null) return null
  const parsed: unknown = JSON.parse(rewardPlanJson)
  return activityRewardPlanSchema.parse(parsed)
}

/**
 * Rebuilds the current key rules from the activity row. The reward plan is
 * spread in only when one is configured, so an activity without a plan produces
 * exactly the pre-#62 shape (and therefore a byte-identical frozen snapshot).
 */
function currentKeyRules(row: ActivityRow): ActivityKeyRules {
  const rewardPlan = parseRewardPlan(row.rewardPlanJson)
  return activityKeyRulesSchema.parse({
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    location: row.location,
    budgetCapCents: row.budgetCapCents,
    prizeQuantityCap: row.prizeQuantityCap,
    publicRules: parsePublicRules(row.publicRulesJson),
    ...(rewardPlan === null ? {} : { rewardPlan }),
  })
}

/**
 * Merges an incoming key-rules payload with the activity's stored reward plan.
 *
 * Three cases, and they must stay distinct:
 *   - `rewardPlan` key ABSENT  -> inherit the stored plan (an ordinary edit that
 *     only touches, say, `location` must not drop the plan)
 *   - `rewardPlan: null`       -> clear it, deliberately
 *   - `rewardPlan: {...}`      -> replace it
 *
 * The result is what gets written to the activity row AND to the frozen rule
 * version snapshot. The snapshot half is the one that matters: fulfilment reads
 * only `activity_rule_versions.snapshot_json`, so preserving the column alone
 * would still lose the reward.
 */
function withEffectiveRewardPlan(
  incoming: ActivityKeyRules,
  current: ActivityRow,
): ActivityKeyRules {
  if ('rewardPlan' in incoming) {
    // Explicit null or a concrete plan: the caller decided, so this is new input
    // and the window cross-check applies in full.
    return activityKeyRulesWriteSchema.parse(incoming)
  }
  // The plan is inherited, not supplied. Parse with the lenient read schema and
  // then apply one narrow rule: an edit must not *introduce* an out-of-bounds
  // window. An activity whose stored plan was already out of bounds (any row
  // written before t13) stays editable, because otherwise the window can never
  // be repaired - the operator would be locked out of the very edit that fixes
  // it, and a published activity's plan cannot be changed at all.
  const storedPlan = parseRewardPlan(current.rewardPlanJson)
  const merged = activityKeyRulesSchema.parse({
    ...incoming,
    ...(storedPlan === null ? {} : { rewardPlan: storedPlan }),
  })
  if (merged.rewardPlan !== undefined && merged.rewardPlan !== null) {
    const wasOutOfBounds =
      storedPlan !== null &&
      (Date.parse(storedPlan.checkinWindow.opensAt) < current.startsAt.getTime() ||
        Date.parse(storedPlan.checkinWindow.closesAt) > current.endsAt.getTime())
    if (!wasOutOfBounds) {
      // Throw a domain error, not a ZodError: zod 4's ZodError is not an
      // `instanceof Error`, so Hono's error handling refuses to route it through
      // `onError` and the real server returns an empty-body 500 (no log, no
      // requestId) instead of the `400 invalidRequest` this deserves. Going
      // through ActivityError lands in `failWithActivityError` -> `fail()`.
      const issues = findCheckinWindowIssues(merged)
      if (issues.length > 0) {
        throw new ActivityError(400, API_ERROR_CODES.invalidRequest, issues[0]!.message)
      }
    }
  }
  return merged
}

/**
 * Deep equality for reward plans. Both sides are normalised through the schema
 * first, so an omitted optional key and an explicit default compare equal.
 */
function rewardPlansEqual(left: ActivityRewardPlan | null, right: ActivityRewardPlan | null): boolean {
  if (left === null || right === null) return left === right
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Statuses in which the reward plan is frozen. */
const REWARD_PLAN_FROZEN_STATUSES: ReadonlySet<ActivityStatus> = new Set(['published', 'paused'])

/**
 * Rejects a reward-plan change on an activity whose plan is already frozen.
 *
 * The prize ledger is keyed by `(activity_id, prize_name)`, so renaming the
 * prize does not merely relabel it: the next claim opens a *new* stock row with
 * `claimed_quantity = 0` and `total_quantity` taken from the new plan. That
 * resets the activity-wide quota and budget accounting — a silent quota refresh
 * and prize swap. Freezing the plan after publication closes that path.
 *
 * Only `rewardPlan` is locked. Every other rule field (location, dates, caps)
 * stays editable on a published activity and still creates a rule version.
 */
function assertRewardPlanUnchanged(
  current: ActivityRow,
  incoming: ActivityKeyRules,
): void {
  if (!REWARD_PLAN_FROZEN_STATUSES.has(current.status)) return
  // A missing key means "leave the plan alone", which is always allowed.
  if (!('rewardPlan' in incoming)) return
  const incomingPlan = incoming.rewardPlan ?? null
  const storedPlan = parseRewardPlan(current.rewardPlanJson)
  if (rewardPlansEqual(incomingPlan, storedPlan)) return
  throw new ActivityError(
    409,
    API_ERROR_CODES.rewardPlanLocked,
    '奖励计划发布后不可修改，如需调整请结束活动后新建',
  )
}

function keyRulesEqual(left: ActivityKeyRules, right: ActivityKeyRules): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function toAdminSummary(row: ActivityRow) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    community: { id: row.communityId, name: row.communityName },
    status: row.status,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    location: row.location,
    budgetCapCents: row.budgetCapCents,
    prizeQuantityCap: row.prizeQuantityCap,
    ruleVersion: row.ruleVersion ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    publishedAt: isoOrNull(row.publishedAt),
  }
}

function toAdminDetail(row: ActivityRow): AdminActivityDetail {
  return adminActivityDetailSchema.parse({
    ...toAdminSummary(row),
    description: row.description,
    publicRules: parsePublicRules(row.publicRulesJson),
    currentRuleVersionId: row.currentRuleVersionId,
    rewardPlan: parseRewardPlan(row.rewardPlanJson),
  })
}

function toPublicSummary(row: ActivityRow) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    community: { id: row.communityId, name: row.communityName },
    location: row.location,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    status: row.status,
    ruleVersion: row.ruleVersion ?? null,
    updatedAt: iso(row.updatedAt),
  }
}

function toPublicDetail(row: ActivityRow): PublicActivityDetail {
  return publicActivityDetailSchema.parse({
    ...toPublicSummary(row),
    description: row.description,
    publicRules: parsePublicRules(row.publicRulesJson),
    publishedAt: isoOrNull(row.publishedAt),
  })
}

function assertExpectedUpdatedAt(actual: Date, expectedUpdatedAt: string): void {
  if (actual.getTime() !== Date.parse(expectedUpdatedAt)) {
    throw new ActivityError(
      409,
      API_ERROR_CODES.conflict,
      '活动已被其他操作更新，请刷新后重试',
    )
  }
}

/** The optimistic-concurrency token must always advance, even within one millisecond. */
function nextUpdatedAt(previous: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1))
}

function insertAudit(
  tx: ActivityTransaction,
  actorUserId: string,
  event: string,
  targetId: string,
  createdAt: Date,
  metadata?: Record<string, string>,
): void {
  tx.insert(auditLogs)
    .values({
      id: randomUUID(),
      actorUserId,
      event,
      targetId,
      metadata: metadata ? JSON.stringify(metadata) : null,
      createdAt,
    })
    .run()
}

function insertRuleVersion(
  tx: ActivityTransaction,
  input: {
    id: string
    activityId: string
    version: number
    rules: ActivityKeyRules
    actorUserId: string
    createdAt: Date
  },
): void {
  const snapshot = activityKeyRulesSchema.parse(input.rules)
  tx.insert(activityRuleVersions)
    .values({
      id: input.id,
      activityId: input.activityId,
      version: input.version,
      snapshotJson: JSON.stringify(snapshot),
      createdByUserId: input.actorUserId,
      createdAt: input.createdAt,
    })
    .run()
}

function nextRuleVersion(tx: ActivityTransaction, activityId: string): number {
  const latest = tx
    .select({ version: activityRuleVersions.version })
    .from(activityRuleVersions)
    .where(eq(activityRuleVersions.activityId, activityId))
    .orderBy(desc(activityRuleVersions.version))
    .limit(1)
    .get()
  return (latest?.version ?? 0) + 1
}

function mapConstraintError(error: unknown): never {
  if (error instanceof ActivityError) throw error
  if (error instanceof Error && /UNIQUE constraint failed|constraint failed/iu.test(error.message)) {
    throw new ActivityError(
      409,
      API_ERROR_CODES.conflict,
      '并发更新冲突，请刷新后重试',
    )
  }
  throw error
}

/* ------------------------------- Public API ------------------------------- */

export interface PublicActivityListInput {
  communityId?: string
  limit: number
}

export function listPublicActivities(
  db: AppDatabase,
  input: PublicActivityListInput,
): PublicActivityListResponse {
  const conditions: SQL<unknown>[] = [inArray(activities.status, PUBLIC_STATUSES)]
  if (input.communityId) conditions.push(eq(activities.communityId, input.communityId))
  const rows = activityQuery(db)
    .where(and(...conditions))
    .orderBy(desc(activities.startsAt), desc(activities.createdAt))
    .limit(input.limit)
    .all()
  return publicActivityListResponseSchema.parse({
    items: rows.map((row) => toPublicSummary(row)),
  })
}

export function getPublicActivity(
  db: AppDatabase,
  activityId: string,
): PublicActivityDetail {
  const row = activityQuery(db)
    .where(and(eq(activities.id, activityId), inArray(activities.status, PUBLIC_STATUSES)))
    .get()
  if (!row) throw new ActivityError(404, API_ERROR_CODES.notFound, '活动不存在')
  return toPublicDetail(row)
}

/**
 * Community a resident login may be attributed to, derived from the activity
 * itself (#123).
 *
 * This is the *only* server-side bridge from "I was looking at this activity"
 * to "this resident belongs to that community". The caller supplies an opaque
 * activity id; the community comes from the row, and the visibility rule is the
 * same `PUBLIC_STATUSES` set the public read path uses, so a draft activity —
 * or one that does not exist — can never establish a residence. Keep the two
 * queries aligned: if public visibility changes, this function must change with
 * it rather than growing its own status whitelist.
 */
export function resolvePublicActivityCommunityId(
  db: AppDatabase,
  activityId: string,
): string | null {
  // UUID input is case-insensitive by contract, while SQLite TEXT equality is not.
  const canonicalActivityId = activityId.toLowerCase()
  const row = db
    .select({ communityId: activities.communityId })
    .from(activities)
    .where(and(eq(activities.id, canonicalActivityId), inArray(activities.status, PUBLIC_STATUSES)))
    .get()
  return row?.communityId ?? null
}

/* ------------------------------- Admin API -------------------------------- */

export interface AdminActivityListInput {
  page: number
  pageSize: number
  communityId?: string
  status?: ActivityStatus
  keyword?: string
}

export function listAdminActivities(
  db: AppDatabase,
  actor: ActivityOperator,
  input: AdminActivityListInput,
): AdminActivityListResponse {
  const conditions: SQL<unknown>[] = []
  if (input.communityId) conditions.push(eq(activities.communityId, input.communityId))
  if (input.status) conditions.push(eq(activities.status, input.status))
  if (input.keyword) {
    const escaped = input.keyword.replace(/[\\%_]/gu, '\\$&')
    conditions.push(
      sql`${activities.title} LIKE ${`%${escaped}%`} ESCAPE '\\'`,
    )
  }
  if (actor.role !== 'admin') {
    const communityIds = assignedCommunityIds(db, actor.staffId)
    if (communityIds.length === 0) {
      return adminActivityListResponseSchema.parse({
        items: [],
        total: 0,
        page: input.page,
        pageSize: input.pageSize,
      })
    }
    conditions.push(inArray(activities.communityId, communityIds))
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined
  const total = db
    .select({ value: count() })
    .from(activities)
    .where(where)
    .get()
  const rows = activityQuery(db)
    .where(where)
    .orderBy(desc(activities.updatedAt), desc(activities.createdAt))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize)
    .all()
  return adminActivityListResponseSchema.parse({
    items: rows.map((row) => toAdminSummary(row)),
    total: total?.value ?? 0,
    page: input.page,
    pageSize: input.pageSize,
  })
}

export function getAdminActivity(
  db: AppDatabase,
  actor: ActivityOperator,
  activityId: string,
): AdminActivityDetail {
  const row = requireActivity(db, activityId)
  assertCommunityAccess(db, actor, row.communityId)
  return toAdminDetail(row)
}

export function createActivity(
  db: AppDatabase,
  actor: ActivityOperator,
  body: CreateActivityRequest,
): AdminActivityDetail {
  const community = db
    .select({ id: communities.id })
    .from(communities)
    .where(eq(communities.id, body.communityId))
    .get()
  if (!community) throw new ActivityError(400, API_ERROR_CODES.invalidRequest, '社区不存在')
  assertCommunityAccess(db, actor, body.communityId)

  const now = new Date()
  const activityId = randomUUID()
  // Write path: the check-in window must sit inside the activity (t13). The
  // stored-data parser `activityKeyRulesSchema` deliberately does NOT carry this
  // rule, so a row written before the rule existed stays readable.
  const keyRules = activityKeyRulesWriteSchema.parse(body.keyRules)
  try {
    db.transaction((tx) => {
      tx.insert(activities)
        .values({
          id: activityId,
          communityId: body.communityId,
          title: body.title,
          summary: body.summary ?? null,
          description: body.description ?? null,
          status: 'draft',
          startsAt: new Date(keyRules.startsAt),
          endsAt: new Date(keyRules.endsAt),
          location: keyRules.location,
          budgetCapCents: keyRules.budgetCapCents,
          prizeQuantityCap: keyRules.prizeQuantityCap,
          publicRulesJson: JSON.stringify(keyRules.publicRules),
          rewardPlanJson:
            keyRules.rewardPlan === undefined || keyRules.rewardPlan === null
              ? null
              : JSON.stringify(keyRules.rewardPlan),
          currentRuleVersionId: null,
          createdByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
          publishedAt: null,
          pausedAt: null,
          endedAt: null,
        })
        .run()
      insertAudit(tx, actor.userId, 'activity.created', activityId, now, {
        status: 'draft',
      })
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return getAdminActivity(db, actor, activityId)
}

export function updateActivity(
  db: AppDatabase,
  actor: ActivityOperator,
  activityId: string,
  body: UpdateActivityRequest,
): AdminActivityDetail {
  const row = requireActivity(db, activityId)
  assertCommunityAccess(db, actor, row.communityId)
  if (row.status === 'ended') {
    throw new ActivityError(409, API_ERROR_CODES.conflict, '已结束的活动不可修改')
  }
  assertExpectedUpdatedAt(row.updatedAt, body.expectedUpdatedAt)

  const now = new Date()
  try {
    db.transaction((tx) => {
      const current = tx
        .select(adminSelection)
        .from(activities)
        .innerJoin(communities, eq(activities.communityId, communities.id))
        .leftJoin(
          activityRuleVersions,
          eq(activities.currentRuleVersionId, activityRuleVersions.id),
        )
        .where(eq(activities.id, activityId))
        .get()
      if (!current) throw new ActivityError(404, API_ERROR_CODES.notFound, '活动不存在')
      if (current.status === 'ended') {
        throw new ActivityError(409, API_ERROR_CODES.conflict, '已结束的活动不可修改')
      }
      assertExpectedUpdatedAt(current.updatedAt, body.expectedUpdatedAt)

      const updatedAt = nextUpdatedAt(current.updatedAt, now)
      const set: Partial<ActivityInsert> = { updatedAt }
      if (body.title !== undefined) set.title = body.title
      if (body.summary !== undefined) set.summary = body.summary
      if (body.description !== undefined) set.description = body.description

      let createdVersion: number | null = null
      // `rewardPlan` absent means "leave the plan as it is"; an explicit `null`
      // means "clear it". Collapsing the two would let any edit that omits the
      // optional field wipe a published activity's frozen plan.
      // Freeze check runs on the RAW payload (before inheritance) because it must
      // see "the caller actually sent a plan and it differs", not the merged
      // result. Runs before any write so a rejection leaves no trace.
      if (body.keyRules !== undefined) {
        // Write path, so the check-in window cross-check applies here too: an
        // edit must not be able to push the window outside the activity (t13).
        // Note the ordering - the window guard runs before the freeze check, so a
        // payload that is both out-of-bounds and a plan change reports the window
        // problem, which is the one the operator can actually act on.
        const incoming = activityKeyRulesWriteSchema.parse(body.keyRules)
        assertRewardPlanUnchanged(current, incoming)
      }
      const effectiveKeyRules =
        body.keyRules === undefined ? undefined : withEffectiveRewardPlan(body.keyRules, current)
      const keyRulesChanged =
        effectiveKeyRules !== undefined &&
        !keyRulesEqual(effectiveKeyRules, currentKeyRules(current))
      if (keyRulesChanged && effectiveKeyRules !== undefined) {
        const keyRules = effectiveKeyRules
        set.startsAt = new Date(keyRules.startsAt)
        set.endsAt = new Date(keyRules.endsAt)
        set.location = keyRules.location
        set.budgetCapCents = keyRules.budgetCapCents
        set.prizeQuantityCap = keyRules.prizeQuantityCap
        set.publicRulesJson = JSON.stringify(keyRules.publicRules)
        set.rewardPlanJson =
          keyRules.rewardPlan === undefined || keyRules.rewardPlan === null
            ? null
            : JSON.stringify(keyRules.rewardPlan)
        if (current.status !== 'draft') {
          const version = nextRuleVersion(tx, activityId)
          const versionId = randomUUID()
          insertRuleVersion(tx, {
            id: versionId,
            activityId,
            version,
            // The FROZEN snapshot must carry the effective plan, not the raw
            // request body: fulfilment reads only this snapshot.
            rules: keyRules,
            actorUserId: actor.userId,
            createdAt: now,
          })
          set.currentRuleVersionId = versionId
          createdVersion = version
          insertAudit(tx, actor.userId, 'activity.rule_version.created', activityId, now, {
            version: String(version),
          })
        }
      }

      const result = tx
        .update(activities)
        .set(set)
        .where(
          and(
            eq(activities.id, activityId),
            eq(activities.updatedAt, current.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new ActivityError(
          409,
          API_ERROR_CODES.conflict,
          '活动已被其他操作更新，请刷新后重试',
        )
      }
      insertAudit(
        tx,
        actor.userId,
        'activity.updated',
        activityId,
        now,
        createdVersion === null
          ? { status: current.status }
          : { status: current.status, ruleVersion: String(createdVersion) },
      )
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return getAdminActivity(db, actor, activityId)
}

export type ActivityTransitionAction = 'publish' | 'pause' | 'resume' | 'end'

interface TransitionSpec {
  from: ActivityStatus[]
  to: ActivityStatus
  event: string
}

const TRANSITIONS: Record<ActivityTransitionAction, TransitionSpec> = {
  publish: { from: ['draft'], to: 'published', event: 'activity.published' },
  pause: { from: ['published'], to: 'paused', event: 'activity.paused' },
  resume: { from: ['paused'], to: 'published', event: 'activity.resumed' },
  end: { from: ['published', 'paused'], to: 'ended', event: 'activity.ended' },
}

export function transitionActivity(
  db: AppDatabase,
  actor: ActivityOperator,
  activityId: string,
  action: ActivityTransitionAction,
  expectedUpdatedAt: string,
): AdminActivityDetail {
  const row = requireActivity(db, activityId)
  assertCommunityAccess(db, actor, row.communityId)
  const spec = TRANSITIONS[action]
  if (!spec.from.includes(row.status)) {
    throw new ActivityError(409, API_ERROR_CODES.conflict, '当前状态不允许该操作')
  }
  assertExpectedUpdatedAt(row.updatedAt, expectedUpdatedAt)

  const now = new Date()
  try {
    db.transaction((tx) => {
      const current = tx
        .select(adminSelection)
        .from(activities)
        .innerJoin(communities, eq(activities.communityId, communities.id))
        .leftJoin(
          activityRuleVersions,
          eq(activities.currentRuleVersionId, activityRuleVersions.id),
        )
        .where(eq(activities.id, activityId))
        .get()
      if (!current) throw new ActivityError(404, API_ERROR_CODES.notFound, '活动不存在')
      if (!spec.from.includes(current.status)) {
        throw new ActivityError(409, API_ERROR_CODES.conflict, '当前状态不允许该操作')
      }
      assertExpectedUpdatedAt(current.updatedAt, expectedUpdatedAt)

      const updatedAt = nextUpdatedAt(current.updatedAt, now)
      const set: Partial<ActivityInsert> = { status: spec.to, updatedAt }
      if (action === 'publish') {
        const version = nextRuleVersion(tx, activityId)
        const versionId = randomUUID()
        insertRuleVersion(tx, {
          id: versionId,
          activityId,
          version,
          rules: currentKeyRules(current),
          actorUserId: actor.userId,
          createdAt: now,
        })
        set.currentRuleVersionId = versionId
        set.publishedAt = now
        set.pausedAt = null
        insertAudit(tx, actor.userId, 'activity.rule_version.created', activityId, now, {
          version: String(version),
        })
      } else if (action === 'pause') {
        set.pausedAt = now
      } else if (action === 'resume') {
        set.pausedAt = null
      } else {
        set.endedAt = now
      }

      const result = tx
        .update(activities)
        .set(set)
        .where(
          and(
            eq(activities.id, activityId),
            eq(activities.status, current.status),
            eq(activities.updatedAt, current.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new ActivityError(
          409,
          API_ERROR_CODES.conflict,
          '活动已被其他操作更新，请刷新后重试',
        )
      }
      insertAudit(tx, actor.userId, spec.event, activityId, now, {
        status: spec.to,
      })
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return getAdminActivity(db, actor, activityId)
}

export function listActivityRuleVersions(
  db: AppDatabase,
  actor: ActivityOperator,
  activityId: string,
): ActivityRuleVersionListResponse {
  const row = requireActivity(db, activityId)
  assertCommunityAccess(db, actor, row.communityId)
  const versions = db
    .select()
    .from(activityRuleVersions)
    .where(eq(activityRuleVersions.activityId, activityId))
    .orderBy(desc(activityRuleVersions.version))
    .all()
  return activityRuleVersionListResponseSchema.parse({
    items: versions.map((version) => ({
      id: version.id,
      activityId: version.activityId,
      version: version.version,
      snapshot: activityKeyRulesSchema.parse(JSON.parse(version.snapshotJson)),
      createdByUserId: version.createdByUserId,
      createdAt: iso(version.createdAt),
    })),
  })
}

export function listActivityAudit(
  db: AppDatabase,
  actor: ActivityOperator,
  activityId: string,
  limit: number,
): ActivityAuditEntryListResponse {
  const row = requireActivity(db, activityId)
  assertCommunityAccess(db, actor, row.communityId)
  const entries = db
    .select({
      id: auditLogs.id,
      event: auditLogs.event,
      actorUserId: auditLogs.actorUserId,
      actorDisplayName: users.displayName,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.actorUserId, users.id))
    .where(eq(auditLogs.targetId, activityId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .all()
  return activityAuditEntryListResponseSchema.parse({
    items: entries.map((entry) => ({
      id: entry.id,
      event: entry.event,
      actorUserId: entry.actorUserId,
      actorDisplayName: entry.actorDisplayName,
      targetId: entry.targetId,
      metadata: parseAuditMetadata(entry.metadata),
      createdAt: iso(entry.createdAt),
    })),
  })
}

function parseAuditMetadata(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}
