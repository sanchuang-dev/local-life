import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  type CreateSettlementMappingRequest,
  type CreateSettlementPartyRequest,
  type SettlementMapping,
  type SettlementOrderPartySnapshot,
  type SettlementParty,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  localOrders,
  localProducts,
  settlementOrderPartySnapshots,
  settlementParties,
  settlementProductMappings,
} from '../db/schema.js'
import {
  LocalError,
  assertCommunityAccess,
  insertAudit,
  iso,
  mapConstraintError,
  scopeCommunityIds,
  type LocalActor,
} from '../local/shared.js'
import { toShanghaiBusinessDate } from './shared.js'

/**
 * #183 intentionally stores no financial amounts or contract rates.
 * Party versions, product mapping versions, and an explicitly confirmed order
 * snapshot are immutable. Historical orders are never automatically matched.
 */

function adminOnly(actor: LocalActor): void {
  if (actor.role !== 'admin') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '只有管理员能登记结算主体与销售商户')
  }
}

function requireReadScope(db: AppDatabase, actor: LocalActor, communityId?: string): void {
  if (!actor.role || actor.role === 'grid_worker') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '无权查看全局商户及合同关系')
  }
  if (actor.role !== 'admin' && !communityId) {
    throw new LocalError(400, API_ERROR_CODES.invalidRequest, '请选择有权社区')
  }
  if (communityId) assertCommunityAccess(db, actor, communityId)
}

const partyDto = (row: typeof settlementParties.$inferSelect): SettlementParty => ({
  ...row,
  verifiedAt: row.verifiedAt ? iso(row.verifiedAt) : null,
  createdAt: iso(row.createdAt),
})
const mappingDto = (row: typeof settlementProductMappings.$inferSelect): SettlementMapping => ({
  ...row,
  createdAt: iso(row.createdAt),
})
const snapshotDto = (row: typeof settlementOrderPartySnapshots.$inferSelect): SettlementOrderPartySnapshot => ({
  ...row,
  confirmedAt: iso(row.confirmedAt),
})

export function listSettlementParties(
  db: AppDatabase,
  actor: LocalActor,
  communityId?: string,
): { items: SettlementParty[] } {
  requireReadScope(db, actor, communityId)
  if (communityId) {
    // Operator cannot enumerate parties unrelated to a permitted community.
    const mapped = db.select().from(settlementProductMappings)
      .where(eq(settlementProductMappings.communityId, communityId)).all()
    const ids = [...new Set(mapped.flatMap((m) =>
      [m.sellerPartyId, m.sanchuangPartyId, m.guangdianPartyId].filter((id): id is string => id !== null)))]
    if (ids.length === 0) return { items: [] }
    return { items: db.select().from(settlementParties)
      .where(inArray(settlementParties.id, ids)).all().map(partyDto) }
  }
  return { items: db.select().from(settlementParties).all().map(partyDto) }
}

export function createSettlementParty(
  db: AppDatabase,
  actor: LocalActor,
  input: CreateSettlementPartyRequest,
  now = new Date(),
): SettlementParty {
  adminOnly(actor)
  const entry = {
    id: randomUUID(), role: input.role, legalName: input.legalName,
    registryRef: input.registryRef, verificationRef: input.verificationRef,
    verifiedAt: input.verificationRef ? now : null,
    createdByUserId: actor.userId, createdAt: now,
  }
  try {
    return db.transaction((tx) => {
      tx.insert(settlementParties).values(entry).run()
      insertAudit(tx, actor.userId, 'settlement.party.version_created', entry.id, now, {
        role: entry.role, registryRef: entry.registryRef,
        verified: String(entry.verifiedAt !== null),
      })
      return partyDto(entry)
    })
  } catch (error) {
    return mapConstraintError(error)
  }
}

export function listSettlementMappings(
  db: AppDatabase,
  actor: LocalActor,
  communityId?: string,
): { items: SettlementMapping[] } {
  requireReadScope(db, actor, communityId)
  const rows = communityId
    ? db.select().from(settlementProductMappings)
      .where(eq(settlementProductMappings.communityId, communityId)).all()
    : db.select().from(settlementProductMappings).all()
  return { items: rows.map(mappingDto) }
}

export function createSettlementMapping(
  db: AppDatabase,
  actor: LocalActor,
  input: CreateSettlementMappingRequest,
  now = new Date(),
): SettlementMapping {
  adminOnly(actor)
  const product = db.select({ communityId: localProducts.communityId })
    .from(localProducts).where(eq(localProducts.id, input.productId)).get()
  if (!product) throw new LocalError(404, API_ERROR_CODES.notFound, '商品不存在')
  if (product.communityId !== input.communityId) {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '商品与社区归属不一致')
  }
  // A party reference cannot be silently accepted from an unverified draft.
  for (const [id, role] of [
    [input.sellerPartyId, 'seller'],
    [input.sanchuangPartyId, 'sanchuang'],
    [input.guangdianPartyId, 'guangdian'],
  ] as const) {
    if (id === null) continue
    const party = db.select().from(settlementParties)
      .where(eq(settlementParties.id, id)).get()
    if (!party || party.role !== role || !party.verifiedAt) {
      throw new LocalError(409, API_ERROR_CODES.conflict, '指定主体尚未凭资料完成核验或类型不匹配')
    }
  }
  const entry = { ...input, id: randomUUID(), createdByUserId: actor.userId, createdAt: now }
  try {
    return db.transaction((tx) => {
      tx.insert(settlementProductMappings).values(entry).run()
      insertAudit(tx, actor.userId, 'settlement.seller_mapping.version_created', entry.id, now, {
        communityId: entry.communityId, productId: entry.productId, agreementRef: entry.agreementRef,
        effectiveFrom: entry.effectiveFrom, effectiveTo: entry.effectiveTo,
      })
      return mappingDto(entry)
    })
  } catch (error) {
    return mapConstraintError(error)
  }
}

export function readOrderPartySnapshot(
  db: AppDatabase,
  actor: LocalActor,
  orderId: string,
): { orderId: string; sellerStatus: 'missing_seller' | 'incomplete_parties' | 'verified'; snapshot: SettlementOrderPartySnapshot | null } {
  if (!actor.role || actor.role === 'grid_worker') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '无权读取销售商户归属')
  }
  const order = db.select({ communityId: localOrders.communityId })
    .from(localOrders).where(eq(localOrders.id, orderId)).get()
  if (!order) throw new LocalError(404, API_ERROR_CODES.notFound, '本地订单不存在')
  assertCommunityAccess(db, actor, order.communityId)
  const snapshot = db.select().from(settlementOrderPartySnapshots)
    .where(eq(settlementOrderPartySnapshots.orderId, orderId)).get()
  if (!snapshot) return { orderId, sellerStatus: 'missing_seller', snapshot: null }
  return {
    orderId,
    sellerStatus: snapshot.sanchuangPartyId && snapshot.guangdianPartyId ? 'verified' : 'incomplete_parties',
    snapshot: snapshotDto(snapshot),
  }
}

export function confirmOrderPartySnapshot(
  db: AppDatabase,
  actor: LocalActor,
  orderId: string,
  mappingId: string,
  confirmationRef: string,
  now = new Date(),
): SettlementOrderPartySnapshot {
  adminOnly(actor)
  const order = db.select().from(localOrders).where(eq(localOrders.id, orderId)).get()
  if (!order) throw new LocalError(404, API_ERROR_CODES.notFound, '订单不存在')
  if (order.status !== 'verified') {
    throw new LocalError(409, API_ERROR_CODES.conflict, '订单尚未业务核验，不允许确认商户归属')
  }
  const mapping = db.select().from(settlementProductMappings)
    .where(eq(settlementProductMappings.id, mappingId)).get()
  const businessDay = toShanghaiBusinessDate(order.createdAt)
  if (!mapping || mapping.productId !== order.productId ||
    mapping.communityId !== order.communityId ||
    businessDay < mapping.effectiveFrom || businessDay > mapping.effectiveTo) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '所选商户映射与原订单或业务日期不匹配')
  }
  const entry = {
    orderId, mappingId, sellerPartyId: mapping.sellerPartyId,
    sanchuangPartyId: mapping.sanchuangPartyId, guangdianPartyId: mapping.guangdianPartyId,
    agreementRef: mapping.agreementRef, confirmationRef,
    confirmedByUserId: actor.userId, confirmedAt: now,
  }
  try {
    return db.transaction((tx) => {
      tx.insert(settlementOrderPartySnapshots).values(entry).run()
      insertAudit(tx, actor.userId, 'settlement.order_party.confirmed', orderId, now, {
        mappingId, sellerPartyId: entry.sellerPartyId, confirmationRef,
      })
      return snapshotDto(entry)
    })
  } catch (error) {
    return mapConstraintError(error)
  }
}
