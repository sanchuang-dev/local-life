import { randomUUID } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import { API_ERROR_CODES } from '@sanchuang-dev/local-life-contracts'
import type { LocalTransaction } from '../local/shared.js'
import { LocalError } from '../local/shared.js'
import { activities, couponIssues, couponIssueEvents, localOrders } from '../db/schema.js'

/**
 * #212. A coupon is a single, indivisible discount, never a cash balance.
 * Call exclusively inside the same BEGIN IMMEDIATE transaction as the order
 * INSERT. The server, not the browser, supplies its immutable face value.
 */
export function readCouponForOrder(
  tx: LocalTransaction,
  input: { couponId: string; buyerUserId: string; communityId: string; grossCents: number; now: Date },
): number {
  const coupon = tx.select({
    userId: couponIssues.userId,
    status: couponIssues.status,
    faceValueCents: couponIssues.faceValueCents,
    expiresAt: couponIssues.expiresAt,
    communityId: activities.communityId,
  }).from(couponIssues)
    .innerJoin(activities, eq(couponIssues.activityId, activities.id))
    .where(eq(couponIssues.id, input.couponId)).get()
  if (!coupon ||
      coupon.userId !== input.buyerUserId ||
      coupon.communityId !== input.communityId ||
      coupon.status !== 'available' ||
      coupon.expiresAt.getTime() <= input.now.getTime()) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '消费券无效、已过期或已被使用')
  }
  if (coupon.faceValueCents > input.grossCents) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '整张消费券面额超过商品总额，不支持找零')
  }
  return coupon.faceValueCents
}

export function reserveCouponForOrder(
  tx: LocalTransaction,
  couponId: string,
  orderId: string,
  buyerUserId: string,
  now: Date,
): void {
  const claimed = tx.update(couponIssues).set({
    status: 'reserved',
    reservedOrderId: orderId,
    reservedAt: now,
    updatedAt: now,
  }).where(and(
    eq(couponIssues.id, couponId),
    eq(couponIssues.userId, buyerUserId),
    eq(couponIssues.status, 'available'),
    gt(couponIssues.expiresAt, now),
  )).run()
  if (claimed.changes !== 1) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '消费券已被其他订单占用，请刷新后重试')
  }
  tx.insert(couponIssueEvents).values({
    id: randomUUID(), couponId, kind: 'reserved', orderId, createdAt: now,
  }).run()
}

/**
 * A positive-net order becomes redeemed ONLY with its real linked receipt;
 * the zero-cash (fully subsidised) order becomes redeemed on explicit business
 * verification and never fabricates a payment_received fact.
 *
 * The caller owns the parent immediate transaction and must have verified
 * the receipt amount or the zero-cash verified status before this call.
 */
export function redeemCouponForOrder(
  tx: LocalTransaction,
  orderId: string,
  now: Date,
): void {
  const order = tx.select({
    id: localOrders.id,
    couponId: localOrders.couponId,
    discount: localOrders.couponDiscountCents,
  }).from(localOrders).where(eq(localOrders.id, orderId)).get()
  if (!order?.couponId) return
  const changed = tx.update(couponIssues).set({
    status: 'redeemed',
    redeemedAt: now,
    updatedAt: now,
  }).where(and(
    eq(couponIssues.id, order.couponId),
    eq(couponIssues.status, 'reserved'),
    eq(couponIssues.reservedOrderId, orderId),
    eq(couponIssues.faceValueCents, order.discount),
  )).run()
  if (changed.changes !== 1) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '订单消费券状态异常，禁止重复核销')
  }
  tx.insert(couponIssueEvents).values({
    id: randomUUID(), couponId: order.couponId, kind: 'redeemed', orderId, createdAt: now,
  }).run()
}
