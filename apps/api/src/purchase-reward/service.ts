import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  PURCHASE_REWARD_TEAM_SIZE,
  purchaseRewardPlanSchema,
  purchaseRewardProgressListResponseSchema,
  purchaseRewardProgressResponseSchema,
  purchaseRewardTeamProgressSchema,
  type ActivityStatus,
  type ParticipationRole,
  type ParticipationTeamStatus,
  type PurchaseRewardPlan,
  type PurchaseRewardProgressListResponse,
  type PurchaseRewardProgressResponse,
  type PurchaseRewardTeamProgress,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  activityParticipations,
  activityTeams,
  ledgerEntries,
  ledgerPaymentOrderLinks,
  localOrders,
  users,
} from '../db/schema.js'
import {
  LocalError,
  assertCommunityAccess,
  iso,
  type LocalActor,
} from '../local/shared.js'

/**
 * Read-only effective-paid projection for a consumption team (LL-PUR-005, #210).
 *
 * This module intentionally contains no writable state. It answers one question
 * from the facts that already exist:
 *
 *   "how much money did this current team actually pay, and is it eligible?"
 *
 * Money rules, in order of authority:
 * 1. only a business-verified local order may contribute (`status = 'verified'`;
 *    verification is not payment);
 * 2. the order must be frozen to this activity **and** this team, and must have
 *    been created no earlier than its buyer's join time;
 * 3. the amount comes from the one linked `payment_received` ledger entry, not
 *    from `local_orders.total_cents`; subtracting any append-only reversals of
 *    that entry;
 * 4. one order has exactly one team column and one receipt link, so the query can
 *    never count the same order or receipt twice;
 * 5. no reconciliation lock and no grid-worker attribution is required. Those are
 *    institutional settlement concerns, deliberately separate from a resident
 *    reward.
 *
 * The result is computed on every read. There is no cached "team paid" column to
 * drift away from the immutable facts, and no coupon issuance happens here.
 */

interface ActivityProjectionRow {
  id: string
  title: string
  communityId: string
  status: ActivityStatus
  purchaseRewardPlanJson: string | null
}

function findActivity(db: AppDatabase, activityId: string): ActivityProjectionRow | undefined {
  return db
    .select({
      id: activities.id,
      title: activities.title,
      communityId: activities.communityId,
      status: activities.status,
      purchaseRewardPlanJson: activities.purchaseRewardPlanJson,
    })
    .from(activities)
    .where(eq(activities.id, activityId))
    .get()
}

/**
 * The stored plan is the single rule source. A published activity cannot change
 * it (LL-PUR-001), so reading the current column is equivalent to its frozen
 * snapshot while still allowing an unpublished draft to be inspected.
 */
function readPlan(json: string | null): PurchaseRewardPlan | null {
  if (json === null) return null
  const parsed: unknown = JSON.parse(json)
  return purchaseRewardPlanSchema.parse(parsed)
}

function publicPlan(plan: PurchaseRewardPlan | null) {
  if (plan === null) return null
  return {
    thresholdCents: plan.thresholdCents,
    couponFaceValueCents: plan.couponFaceValueCents,
  }
}

function requireActivity(
  db: AppDatabase,
  activityId: string,
  options: { publicOnly: boolean },
): ActivityProjectionRow {
  const row = findActivity(db, activityId)
  // Drafts are invisible to residents, exactly like the public activity read.
  if (!row || (options.publicOnly && row.status === 'draft')) {
    throw new LocalError(404, API_ERROR_CODES.notFound, '活动不存在')
  }
  return row
}

interface ParticipationRow {
  teamId: string
  teamStatus: ParticipationTeamStatus
}

function findMyParticipation(
  db: AppDatabase,
  activityId: string,
  userId: string,
): ParticipationRow | undefined {
  return db
    .select({
      teamId: activityParticipations.teamId,
      teamStatus: activityTeams.status,
    })
    .from(activityParticipations)
    .innerJoin(activityTeams, eq(activityParticipations.teamId, activityTeams.id))
    .where(
      and(
        eq(activityParticipations.activityId, activityId),
        eq(activityParticipations.userId, userId),
      ),
    )
    .get()
}

interface TeamRow {
  id: string
  status: ParticipationTeamStatus
}

function listActivityTeams(db: AppDatabase, activityId: string): TeamRow[] {
  return db
    .select({ id: activityTeams.id, status: activityTeams.status })
    .from(activityTeams)
    .where(eq(activityTeams.activityId, activityId))
    .orderBy(asc(activityTeams.createdAt), asc(activityTeams.id))
    .all()
}

interface MemberRow {
  teamId: string
  userId: string
  displayName: string | null
  seatNo: number
  role: ParticipationRole
  joinedAt: Date
}

function listTeamMembers(db: AppDatabase, teamIds: string[]): Map<string, MemberRow[]> {
  const byTeam = new Map<string, MemberRow[]>()
  if (teamIds.length === 0) return byTeam
  const rows = db
    .select({
      teamId: activityParticipations.teamId,
      userId: activityParticipations.userId,
      displayName: users.displayName,
      seatNo: activityParticipations.seatNo,
      role: activityParticipations.role,
      joinedAt: activityParticipations.joinedAt,
    })
    .from(activityParticipations)
    .leftJoin(users, eq(activityParticipations.userId, users.id))
    .where(inArray(activityParticipations.teamId, teamIds))
    .orderBy(asc(activityParticipations.teamId), asc(activityParticipations.seatNo))
    .all()
  for (const row of rows) {
    const list = byTeam.get(row.teamId)
    if (list) list.push(row)
    else byTeam.set(row.teamId, [row])
  }
  return byTeam
}

/** Same display fallback the participation roster uses, so both views agree. */
function rosterDisplayName(displayName: string | null): string {
  const trimmed = displayName?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : '居民用户'
}

/**
 * Per-team, per-resident net effective paid amount.
 *
 * The join to `activity_participations` is what enforces "入团后消费": a purchase
 * created before that resident joined the team matches no participation row. The
 * join to `ledger_payment_order_links` is what enforces "明确一对一关联": an
 * order with no receipt contributes nothing.
 *
 * Reversals are their own positive rows pointing at the receipt
 * (`counterEntryId`), so the net amount is `receipt - reversed`. A full reversal
 * therefore nets to zero and drops out; the clamp keeps a malformed over-reversal
 * from ever producing a negative contribution.
 */
function readContributions(
  db: AppDatabase,
  activityId: string,
  teamIds: string[],
): Map<string, Map<string, number>> {
  const byTeam = new Map<string, Map<string, number>>()
  if (teamIds.length === 0) return byTeam

  const reversedCents = sql<number>`COALESCE((
    SELECT SUM(reversal.amount_cents)
    FROM ledger_entries AS reversal
    WHERE reversal.fact_kind = 'payment_reversed'
      AND reversal.counter_entry_id = ${ledgerEntries.id}
  ), 0)`
  const effectiveCents = sql<number>`MAX(${ledgerEntries.amountCents} - ${reversedCents}, 0)`

  const rows = db
    .select({
      teamId: localOrders.sourceTeamId,
      residentUserId: localOrders.residentUserId,
      contributionCents: sql<number>`SUM(${effectiveCents})`.mapWith(Number),
    })
    .from(localOrders)
    .innerJoin(
      activityParticipations,
      and(
        eq(activityParticipations.activityId, localOrders.sourceActivityId),
        eq(activityParticipations.teamId, localOrders.sourceTeamId),
        eq(activityParticipations.userId, localOrders.residentUserId),
        sql`${activityParticipations.joinedAt} <= ${localOrders.createdAt}`,
      ),
    )
    .innerJoin(ledgerPaymentOrderLinks, eq(ledgerPaymentOrderLinks.orderId, localOrders.id))
    .innerJoin(ledgerEntries, eq(ledgerEntries.id, ledgerPaymentOrderLinks.entryId))
    .where(
      and(
        eq(localOrders.sourceActivityId, activityId),
        inArray(localOrders.sourceTeamId, teamIds),
        eq(localOrders.status, 'verified'),
        eq(ledgerEntries.factKind, 'payment_received'),
        eq(ledgerEntries.sourceSystem, 'manual'),
      ),
    )
    .groupBy(localOrders.sourceTeamId, localOrders.residentUserId)
    .all()

  for (const row of rows) {
    if (row.teamId === null || row.contributionCents <= 0) continue
    const teamContributions = byTeam.get(row.teamId) ?? new Map<string, number>()
    teamContributions.set(row.residentUserId, row.contributionCents)
    byTeam.set(row.teamId, teamContributions)
  }
  return byTeam
}

function buildTeamProgress(
  team: TeamRow,
  members: MemberRow[],
  contributions: Map<string, number>,
  plan: PurchaseRewardPlan,
  viewerUserId: string,
): PurchaseRewardTeamProgress {
  const membersContributionCents = members.map((member) => ({
    seatNo: member.seatNo,
    displayName: rosterDisplayName(member.displayName),
    role: member.role,
    isSelf: member.userId === viewerUserId,
    joinedAt: iso(member.joinedAt),
    contributionCents: contributions.get(member.userId) ?? 0,
  }))
  const totalEffectivePaidCents = membersContributionCents.reduce(
    (total, member) => total + member.contributionCents,
    0,
  )
  const seatsFilled = membersContributionCents.length
  const teamFull = seatsFilled === PURCHASE_REWARD_TEAM_SIZE
  const thresholdCents = plan.thresholdCents
  const remainingCents = Math.max(0, thresholdCents - totalEffectivePaidCents)

  return purchaseRewardTeamProgressSchema.parse({
    teamId: team.id,
    teamStatus: team.status,
    seatsFilled,
    teamFull,
    membersContributionCents,
    totalEffectivePaidCents,
    thresholdCents,
    remainingCents,
    eligible: teamFull && totalEffectivePaidCents >= thresholdCents,
  })
}

function buildEmptyProgress(
  activity: ActivityProjectionRow,
  plan: PurchaseRewardPlan | null,
): PurchaseRewardProgressResponse {
  return purchaseRewardProgressResponseSchema.parse({
    activityId: activity.id,
    activityTitle: activity.title,
    plan: publicPlan(plan),
    progress: null,
  })
}

/**
 * The authenticated resident's own current team only.
 *
 * A resident without a participation receives `progress: null`, never a fabricated
 * zero team. A staff session reading this route still only sees the team it
 * belongs to as a resident, because the identity is the session user id.
 */
export function getMyPurchaseRewardProgress(
  db: AppDatabase,
  actor: LocalActor,
  activityId: string,
): PurchaseRewardProgressResponse {
  const activity = requireActivity(db, activityId, { publicOnly: true })
  const plan = readPlan(activity.purchaseRewardPlanJson)
  if (plan === null) return buildEmptyProgress(activity, null)

  const participation = findMyParticipation(db, activity.id, actor.userId)
  if (!participation) return buildEmptyProgress(activity, plan)

  const team: TeamRow = { id: participation.teamId, status: participation.teamStatus }
  const members = listTeamMembers(db, [team.id]).get(team.id) ?? []
  const contributions = readContributions(db, activity.id, [team.id]).get(team.id)
  const progress = buildTeamProgress(
    team,
    members,
    contributions ?? new Map(),
    plan,
    actor.userId,
  )
  return purchaseRewardProgressResponseSchema.parse({
    activityId: activity.id,
    activityTitle: activity.title,
    plan: publicPlan(plan),
    progress,
  })
}

/**
 * Staff read-only view of all current teams of one activity.
 *
 * Community scoping is enforced here, not in the UI: an operator/grid worker
 * assigned to another community gets the shared 403 and an empty body, while an
 * admin may read any community. Only team progress is returned - no resident ids,
 * no order ids and no receipt references.
 */
export function listStaffPurchaseRewardProgress(
  db: AppDatabase,
  actor: LocalActor,
  activityId: string,
  options: { now?: Date } = {},
): PurchaseRewardProgressListResponse {
  const activity = requireActivity(db, activityId, { publicOnly: false })
  assertCommunityAccess(db, actor, activity.communityId)
  const plan = readPlan(activity.purchaseRewardPlanJson)
  const asOf = iso(options.now ?? new Date())

  if (plan === null) {
    return purchaseRewardProgressListResponseSchema.parse({
      activityId: activity.id,
      activityTitle: activity.title,
      plan: null,
      items: [],
      asOf,
    })
  }

  const teams = listActivityTeams(db, activity.id)
  const teamIds = teams.map((team) => team.id)
  const membersByTeam = listTeamMembers(db, teamIds)
  const contributionsByTeam = readContributions(db, activity.id, teamIds)

  return purchaseRewardProgressListResponseSchema.parse({
    activityId: activity.id,
    activityTitle: activity.title,
    plan: publicPlan(plan),
    items: teams.map((team) =>
      buildTeamProgress(
        team,
        membersByTeam.get(team.id) ?? [],
        contributionsByTeam.get(team.id) ?? new Map(),
        plan,
        actor.userId,
      ),
    ),
    asOf,
  })
}
