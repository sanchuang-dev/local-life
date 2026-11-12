import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  couponRewardDisputeListSchema,
  purchaseRewardPlanSchema,
  type CouponRewardDisputeList,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  activityRuleVersions,
  couponIssues,
  couponIssueEvents,
  couponRewardDisputes,
  couponTeamGrants,
  ledgerPaymentOrderLinks,
  localOrders,
} from '../db/schema.js'
import {
  LocalError,
  assertCommunityAccess,
  insertAudit,
  iso,
  type LocalActor,
  type LocalTransaction,
} from '../local/shared.js'
import { readTeamProgressForIssuance } from './service.js'

/**
 * Releasing an unpaid order is NOT a refund: no cash fact is written or erased.
 * The original order's coupon ID/discount snapshot survives, but the coupon's
 * active reservation can be reused by a later order. Its original expiry
 * remains immutable; an expired released coupon is still unusable.
 *
 * Call only after a terminal order-status transition, in the SAME write
 * transaction. "void" is deliberately not released: a source reward reversal
 * permanently invalidated that grant.
 */
export function releaseUnpaidOrderCoupon(
  tx: LocalTransaction,
  orderId: string,
  now: Date,
): 'released' | 'none' | 'void' {
  const order = tx.select({
    status: localOrders.status,
    couponId: localOrders.couponId,
  }).from(localOrders).where(eq(localOrders.id, orderId)).get()
  if (!order || (order.status !== 'cancelled' && order.status !== 'rejected')) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '只有已取消或拒绝的订单可以释放未付款消费券')
  }
  if (!order.couponId) return 'none'
  if (tx.select({ orderId: ledgerPaymentOrderLinks.orderId })
      .from(ledgerPaymentOrderLinks).where(eq(ledgerPaymentOrderLinks.orderId, orderId)).get()) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '已有实收关联的订单不得自动返券')
  }
  const coupon = tx.select({
    status: couponIssues.status,
    reservedOrderId: couponIssues.reservedOrderId,
  }).from(couponIssues).where(eq(couponIssues.id, order.couponId)).get()
  if (!coupon) throw new Error('Coupon referenced by order is missing')
  if (coupon.status === 'void') return 'void'
  if (coupon.status !== 'reserved' || coupon.reservedOrderId !== orderId) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '订单消费券已处理或状态异常，不得重复返券')
  }
  const updated = tx.update(couponIssues).set({
    status: 'available',
    reservedOrderId: null,
    reservedAt: null,
    updatedAt: now,
  }).where(and(
    eq(couponIssues.id, order.couponId),
    eq(couponIssues.status, 'reserved'),
    eq(couponIssues.reservedOrderId, orderId),
  )).run()
  if (updated.changes !== 1) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '消费券已被其他操作占用')
  }
  tx.insert(couponIssueEvents).values({
    id: randomUUID(), couponId: order.couponId, kind: 'released', orderId,
    createdAt: now,
  }).run()
  return 'released'
}

/** For a zero-cash order, do not let staff verify against a voided coupon. */
export function assertCouponStillReservedForOrder(
  tx: LocalTransaction,
  orderId: string,
): void {
  const order = tx.select({ couponId: localOrders.couponId })
    .from(localOrders).where(eq(localOrders.id, orderId)).get()
  if (!order?.couponId) return
  const coupon = tx.select({
    status: couponIssues.status,
    reservedOrderId: couponIssues.reservedOrderId,
  }).from(couponIssues).where(eq(couponIssues.id, order.couponId)).get()
  if (coupon?.status !== 'reserved' || coupon.reservedOrderId !== orderId) {
    throw new LocalError(409, API_ERROR_CODES.conflict,
      '原消费团奖励已冲正或该券不可用，订单需先人工核对，不得继续核验')
  }
}

function recordDispute(
  tx: LocalTransaction,
  input: {
    key: string
    kind: 'reward_eligibility_lost' | 'redeemed_payment_reversed'
    grantId: string
    couponId: string | null
    orderId: string
    reversalEntryId: string
    resolution: 'auto_void' | 'pending_manual'
    actorUserId: string
    now: Date
  },
): void {
  const previous = tx.select({ id: couponRewardDisputes.id })
    .from(couponRewardDisputes).where(eq(couponRewardDisputes.disputeKey, input.key)).get()
  if (previous) return
  const disputeId = randomUUID()
  tx.insert(couponRewardDisputes).values({
    id: disputeId,
    disputeKey: input.key,
    kind: input.kind,
    grantId: input.grantId,
    couponId: input.couponId,
    sourceOrderId: input.orderId,
    reversalEntryId: input.reversalEntryId,
    resolution: input.resolution,
    createdAt: input.now,
  }).run()
  insertAudit(tx, input.actorUserId, 'purchase_coupon.dispute_opened', disputeId, input.now, {
    kind: input.kind, grantId: input.grantId,
    sourceOrderId: input.orderId,
    reversalEntryId: input.reversalEntryId,
    resolution: input.resolution,
  })
}

/**
 * Run after appending the full reversal fact but BEFORE committing that fact.
 * Three distinct concepts are kept separate:
 *
 * 1. A redeemed coupon used on the reversed order is NOT minted back into a
 *    wallet. Its discount already belongs to immutable order history.
 * 2. An award-grant whose source team's effective net spend drops below the
 *    original threshold is invalidated. Available/reserved coupons become
 *    unusable, while redeemed coupons keep their history and create a dispute.
 * 3. The grant and its budget liability are never deleted/refunded by an
 *    automatic reversal. Requalifying later cannot silently grant new coupons.
 *
 * All changes (reversal, dispute, voids, events) are atomic and serialized by
 * the caller's SQLite BEGIN IMMEDIATE write transaction.
 */
export function reconcileCouponRewardsAfterFullReversal(
  tx: LocalTransaction,
  input: {
    receiptEntryId: string
    reversalEntryId: string
    actorUserId: string
    now: Date
  },
): void {
  const link = tx.select({ orderId: ledgerPaymentOrderLinks.orderId })
    .from(ledgerPaymentOrderLinks)
    .where(eq(ledgerPaymentOrderLinks.entryId, input.receiptEntryId)).get()
  if (!link) return // Legacy standalone manual receipt, not tied to an order.

  const order = tx.select({
    id: localOrders.id,
    couponId: localOrders.couponId,
    sourceActivityId: localOrders.sourceActivityId,
    sourceTeamId: localOrders.sourceTeamId,
  }).from(localOrders).where(eq(localOrders.id, link.orderId)).get()
  if (!order) throw new Error('Linked local order disappeared')

  // A redeemed coupon is NOT automatically recredited after cash is reversed.
  if (order.couponId) {
    const used = tx.select({
      id: couponIssues.id,
      grantId: couponIssues.grantId,
      status: couponIssues.status,
    }).from(couponIssues).where(eq(couponIssues.id, order.couponId)).get()
    if (!used || used.status !== 'redeemed') {
      throw new LocalError(409, API_ERROR_CODES.conflict,
        '原订单用券状态不一致，请人工核查，不得完成自动冲正')
    }
    recordDispute(tx, {
      key: `redeemed-order:${order.couponId}:${order.id}`,
      kind: 'redeemed_payment_reversed',
      grantId: used.grantId,
      couponId: used.id,
      orderId: order.id,
      reversalEntryId: input.reversalEntryId,
      resolution: 'pending_manual',
      actorUserId: input.actorUserId,
      now: input.now,
    })
  }

  if (!order.sourceActivityId || !order.sourceTeamId) return
  const grant = tx.select({
    id: couponTeamGrants.id,
    ruleVersionId: couponTeamGrants.ruleVersionId,
  }).from(couponTeamGrants)
    .where(and(
      eq(couponTeamGrants.activityId, order.sourceActivityId),
      eq(couponTeamGrants.teamId, order.sourceTeamId),
    )).get()
  if (!grant) return

  const prior = tx.select({ id: couponRewardDisputes.id }).from(couponRewardDisputes)
    .where(eq(couponRewardDisputes.disputeKey, `grant:${grant.id}:eligibility-lost`)).get()
  if (prior) return // Grant was already invalidated by another full reversal.

  const version = tx.select({ snapshotJson: activityRuleVersions.snapshotJson })
    .from(activityRuleVersions).where(eq(activityRuleVersions.id, grant.ruleVersionId)).get()
  if (!version) throw new Error('Frozen reward plan snapshot missing')
  const snapshot: unknown = JSON.parse(version.snapshotJson)
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new Error('Invalid frozen reward plan snapshot')
  }
  const plan = purchaseRewardPlanSchema.parse(
    (snapshot as { purchaseRewardPlan?: unknown }).purchaseRewardPlan,
  )
  const progress = readTeamProgressForIssuance(
    tx, order.sourceActivityId, order.sourceTeamId, plan,
  )
  if (progress?.eligible) return

  const issued = tx.select({
    id: couponIssues.id,
    status: couponIssues.status,
    reservedOrderId: couponIssues.reservedOrderId,
  }).from(couponIssues).where(eq(couponIssues.grantId, grant.id)).all()
  if (issued.length !== 3) throw new Error('Issued reward grant must contain exactly three coupons')
  const hasDownstreamOrder = issued.some(
    (coupon) => coupon.status === 'reserved' || coupon.status === 'redeemed',
  )
  recordDispute(tx, {
    key: `grant:${grant.id}:eligibility-lost`,
    kind: 'reward_eligibility_lost',
    grantId: grant.id,
    couponId: null,
    orderId: order.id,
    reversalEntryId: input.reversalEntryId,
    resolution: hasDownstreamOrder ? 'pending_manual' : 'auto_void',
    actorUserId: input.actorUserId,
    now: input.now,
  })

  for (const coupon of issued) {
    if (coupon.status === 'void' || coupon.status === 'redeemed') continue
    const updated = tx.update(couponIssues).set({
      status: 'void',
      voidedAt: input.now,
      updatedAt: input.now,
    }).where(and(
      eq(couponIssues.id, coupon.id),
      eq(couponIssues.status, coupon.status),
    )).run()
    if (updated.changes !== 1) throw new Error('Concurrent coupon invalidation refused')
    tx.insert(couponIssueEvents).values({
      id: randomUUID(),
      couponId: coupon.id,
      kind: 'voided',
      orderId: coupon.reservedOrderId,
      createdAt: input.now,
    }).run()
  }
}

/**
 * Minimal staff read surface for financial exception follow-up; no generic CRM.
 * Community access is checked server-side, not by a client-side filter.
 */
export function listCouponRewardDisputes(
  db: AppDatabase,
  actor: LocalActor,
  activityId: string,
  now: Date = new Date(),
): CouponRewardDisputeList {
  const activity = db.select({ communityId: activities.communityId })
    .from(activities).where(eq(activities.id, activityId)).get()
  if (!activity) throw new LocalError(404, API_ERROR_CODES.notFound, '活动不存在')
  assertCommunityAccess(db, actor, activity.communityId)
  const rows = db.select({
    id: couponRewardDisputes.id,
    kind: couponRewardDisputes.kind,
    grantId: couponRewardDisputes.grantId,
    couponId: couponRewardDisputes.couponId,
    sourceOrderId: couponRewardDisputes.sourceOrderId,
    reversalEntryId: couponRewardDisputes.reversalEntryId,
    resolution: couponRewardDisputes.resolution,
    createdAt: couponRewardDisputes.createdAt,
  }).from(couponRewardDisputes)
    .innerJoin(couponTeamGrants, eq(couponRewardDisputes.grantId, couponTeamGrants.id))
    .where(eq(couponTeamGrants.activityId, activityId)).all()
  return couponRewardDisputeListSchema.parse({
    items: rows.map(row => ({
      ...row,
      createdAt: iso(row.createdAt),
    })),
    asOf: iso(now),
  })
}
