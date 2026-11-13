import { randomUUID } from 'node:crypto'
import { and, count, desc, eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  PURCHASE_REWARD_TEAM_SIZE,
  purchaseRewardPlanSchema,
  purchaseRewardTotalBudgetCents,
  couponWalletResponseSchema,
  couponStockResponseSchema,
  type PurchaseRewardPlan,
  type CouponWalletResponse,
  type CouponStockResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  activityRuleVersions,
  activityParticipations,
  couponTeamGrants,
  couponIssues,
  couponIssueEvents,
  auditLogs,
} from '../db/schema.js'
import { LocalError, assertCommunityAccess, iso, type LocalActor, type LocalTransaction } from '../local/shared.js'
import { readTeamProgressForIssuance } from './service.js'

/** Issued face value expires 30 calendar days after the atomic grant, never extended later. */
export const COUPON_LIFETIME_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
type PurchaseExecutor = AppDatabase | LocalTransaction
export type CouponIssueOutcome = 'issued' | 'already_issued' | 'not_eligible' | 'exhausted' | 'unavailable'

/**
 * Published rule version is authoritative, not the activity's mutable draft
 * column. The version id and face value are frozen into the durable grant.
 */
function frozenPlan(
  db: PurchaseExecutor,
  activityId: string,
): { ruleVersionId: string; plan: PurchaseRewardPlan } | null {
  const activity = db.select({
    status: activities.status,
    versionId: activities.currentRuleVersionId,
  }).from(activities).where(eq(activities.id, activityId)).get()
  if (!activity || activity.status === 'draft' || !activity.versionId) return null
  const version = db.select({
    activityId: activityRuleVersions.activityId,
    snapshot: activityRuleVersions.snapshotJson,
  }).from(activityRuleVersions).where(eq(activityRuleVersions.id, activity.versionId)).get()
  if (!version || version.activityId !== activityId) return null
  const snapshot: unknown = JSON.parse(version.snapshot)
  if (typeof snapshot !== 'object' || snapshot === null) {
    throw new Error('Invalid frozen activity rule snapshot')
  }
  const rawPlan = (snapshot as { purchaseRewardPlan?: unknown }).purchaseRewardPlan
  if (rawPlan === undefined || rawPlan === null) return null
  return { ruleVersionId: activity.versionId, plan: purchaseRewardPlanSchema.parse(rawPlan) }
}

/**
 * Must be invoked INSIDE the same BEGIN IMMEDIATE transaction that writes the
 * third team membership or links the verified receipt. Never start a second
 * transaction here. A full budget is a normal business outcome: preserve the
 * underlying join/payment and do not create any partial coupons.
 */
export function tryIssueEligibleTeamCoupons(
  tx: LocalTransaction,
  activityId: string,
  teamId: string,
  now: Date = new Date(),
): CouponIssueOutcome {
  const already = tx.select({ id: couponTeamGrants.id }).from(couponTeamGrants)
    .where(and(eq(couponTeamGrants.activityId, activityId), eq(couponTeamGrants.teamId, teamId))).get()
  if (already) return 'already_issued'

  const frozen = frozenPlan(tx, activityId)
  if (!frozen) return 'unavailable'

  const progress = readTeamProgressForIssuance(tx, activityId, teamId, frozen.plan)
  if (!progress?.eligible) return 'not_eligible'

  const members = tx.select({
    userId: activityParticipations.userId,
    seatNo: activityParticipations.seatNo,
  }).from(activityParticipations)
    .where(and(eq(activityParticipations.activityId, activityId), eq(activityParticipations.teamId, teamId)))
    .orderBy(activityParticipations.seatNo).all()
  if (members.length !== PURCHASE_REWARD_TEAM_SIZE ||
      new Set(members.map((member) => member.userId)).size !== PURCHASE_REWARD_TEAM_SIZE) {
    throw new Error('Qualified team does not contain three distinct current members')
  }

  const issuedTeamCount = tx.select({ value: count() }).from(couponTeamGrants)
    .where(eq(couponTeamGrants.activityId, activityId)).get()?.value ?? 0
  const teamValue = frozen.plan.couponFaceValueCents * PURCHASE_REWARD_TEAM_SIZE
  const totalBudget = purchaseRewardTotalBudgetCents(frozen.plan)
  if (issuedTeamCount >= frozen.plan.maxRewardedTeams ||
      (issuedTeamCount + 1) * teamValue > totalBudget) {
    return 'exhausted'
  }

  const grantId = randomUUID()
  const expiresAt = new Date(now.getTime() + COUPON_LIFETIME_DAYS * DAY_MS)
  tx.insert(couponTeamGrants).values({
    id: grantId,
    activityId,
    teamId,
    ruleVersionId: frozen.ruleVersionId,
    faceValueCents: frozen.plan.couponFaceValueCents,
    totalValueCents: teamValue,
    grantedAt: now,
  }).run()

  for (const member of members) {
    const couponId = randomUUID()
    tx.insert(couponIssues).values({
      id: couponId,
      grantId,
      activityId,
      teamId,
      userId: member.userId,
      seatNo: member.seatNo,
      faceValueCents: frozen.plan.couponFaceValueCents,
      status: 'available',
      issuedAt: now,
      expiresAt,
      reservedOrderId: null,
      reservedAt: null,
      redeemedAt: null,
      voidedAt: null,
      updatedAt: now,
    }).run()
    tx.insert(couponIssueEvents).values({
      id: randomUUID(),
      couponId,
      kind: 'issued',
      orderId: null,
      createdAt: now,
    }).run()
  }
  tx.insert(auditLogs).values({
    id: randomUUID(),
    actorUserId: null,
    event: 'purchase_coupon.team_issued',
    targetId: grantId,
    metadata: JSON.stringify({
      activityId,
      teamId,
      ruleVersionId: frozen.ruleVersionId,
      memberCount: PURCHASE_REWARD_TEAM_SIZE,
      totalValueCents: teamValue,
    }),
    createdAt: now,
  }).run()
  return 'issued'
}

/** Recovery-safe entry point for a maintainer and for real SQLite replay tests. */
export function issueEligibleTeamCoupons(
  db: AppDatabase,
  activityId: string,
  teamId: string,
  now: Date = new Date(),
): CouponIssueOutcome {
  return db.transaction((tx) => tryIssueEligibleTeamCoupons(tx, activityId, teamId, now), {
    behavior: 'immediate',
  })
}

/** Only the authenticated owner can see their coupons. Expiry is computed, not back-dated. */
export function getMyCoupons(
  db: AppDatabase,
  userId: string,
  now: Date = new Date(),
): CouponWalletResponse {
  const rows = db.select({
    id: couponIssues.id,
    activityId: couponIssues.activityId,
    teamId: couponIssues.teamId,
    communityId: activities.communityId,
    faceValueCents: couponIssues.faceValueCents,
    status: couponIssues.status,
    issuedAt: couponIssues.issuedAt,
    expiresAt: couponIssues.expiresAt,
    reservedOrderId: couponIssues.reservedOrderId,
  }).from(couponIssues)
    .innerJoin(activities, eq(couponIssues.activityId, activities.id))
    .where(eq(couponIssues.userId, userId))
    .orderBy(desc(couponIssues.issuedAt), desc(couponIssues.id)).all()
  return couponWalletResponseSchema.parse({
    items: rows.map((row) => ({
      id: row.id,
      activityId: row.activityId,
      teamId: row.teamId,
      communityId: row.communityId,
      faceValueCents: row.faceValueCents,
      status: row.status === 'available' && row.expiresAt.getTime() <= now.getTime()
        ? 'expired' : row.status,
      issuedAt: iso(row.issuedAt),
      expiresAt: iso(row.expiresAt),
      reservedOrderId: row.reservedOrderId,
    })),
    asOf: iso(now),
  })
}

/** Staff only, with the same server-side community boundary as the #210 progress API. */
export function getCouponStock(
  db: AppDatabase,
  actor: LocalActor,
  activityId: string,
  now: Date = new Date(),
): CouponStockResponse {
  const activity = db.select({ communityId: activities.communityId }).from(activities)
    .where(eq(activities.id, activityId)).get()
  if (!activity) throw new LocalError(404, API_ERROR_CODES.notFound, '活动不存在')
  assertCommunityAccess(db, actor, activity.communityId)
  const frozen = frozenPlan(db, activityId)
  const issuedTeams = db.select({ value: count() }).from(couponTeamGrants)
    .where(eq(couponTeamGrants.activityId, activityId)).get()?.value ?? 0
  const maxTeams = frozen?.plan.maxRewardedTeams ?? 0
  const teamCost = (frozen?.plan.couponFaceValueCents ?? 0) * PURCHASE_REWARD_TEAM_SIZE
  return couponStockResponseSchema.parse({
    activityId,
    hasPlan: frozen !== null,
    issuedTeams,
    maxRewardedTeams: maxTeams,
    remainingTeams: Math.max(0, maxTeams - issuedTeams),
    issuedValueCents: issuedTeams * teamCost,
    totalBudgetCents: frozen ? purchaseRewardTotalBudgetCents(frozen.plan) : 0,
    asOf: iso(now),
  })
}
