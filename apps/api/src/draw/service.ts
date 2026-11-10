import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  activityDrawPoolSchema,
  activityDrawPrizeSchema,
  createActivityDrawPrizeRequestSchema,
  publicActivityDrawPoolSchema,
  saveActivityDrawPoolRequestSchema,
  updateActivityDrawPrizeRequestSchema,
  type ActivityDrawPool,
  type ActivityDrawPrize,
  type ActivityStatus,
  type CreateActivityDrawPrizeRequest,
  type PublicActivityDrawPool,
  type SaveActivityDrawPoolRequest,
  type UpdateActivityDrawPrizeRequest,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  activityDrawEvents,
  activityDrawPools,
  activityDrawPrizes,
  communities,
  localProducts,
} from '../db/schema.js'
import {
  LocalError,
  assertCommunityAccess,
  assertExpectedUpdatedAt,
  iso,
  nextUpdatedAt,
  type LocalActor,
  type LocalTransaction,
} from '../local/shared.js'

/**
 * Real "today's draw" prize pool (LL-LOT-001, Issue #173).
 *
 * Scope boundary: configuration + a validated read-only resident view. No draw,
 * no random result, no credential and no resident draw POST. Everything here is
 * a separate domain from the team-reward ledger (`activity_prize_stocks`).
 */

interface ActivityRow {
  id: string
  communityId: string
  communityName: string
  status: ActivityStatus
  startsAt: Date
  endsAt: Date
}

function requireActivity(db: AppDatabase, activityId: string): ActivityRow {
  const row = db
    .select({
      id: activities.id,
      communityId: activities.communityId,
      communityName: communities.name,
      status: activities.status,
      startsAt: activities.startsAt,
      endsAt: activities.endsAt,
    })
    .from(activities)
    .innerJoin(communities, eq(activities.communityId, communities.id))
    .where(eq(activities.id, activityId))
    .get()
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '活动不存在')
  return row as ActivityRow
}

function assertWritable(activity: ActivityRow): void {
  if (activity.status === 'ended') {
    throw new LocalError(
      409,
      API_ERROR_CODES.activityUnavailable,
      '活动已结束，抽奖配置不可再修改',
    )
  }
}

function assertDrawManager(actor: LocalActor): void {
  if (actor.role === 'grid_worker') {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '网格员无权管理抽奖奖品池')
  }
}

type PoolRow = typeof activityDrawPools.$inferSelect

const prizeSelection = {
  id: activityDrawPrizes.id,
  poolId: activityDrawPrizes.poolId,
  activityId: activityDrawPrizes.activityId,
  communityId: activityDrawPrizes.communityId,
  productId: activityDrawPrizes.productId,
  productName: activityDrawPrizes.productName,
  productImageUrl: activityDrawPrizes.productImageUrl,
  costCents: activityDrawPrizes.costCents,
  totalQuantity: activityDrawPrizes.totalQuantity,
  drawnQuantity: activityDrawPrizes.drawnQuantity,
  remainingQuantity: activityDrawPrizes.remainingQuantity,
  weight: activityDrawPrizes.weight,
  enabled: activityDrawPrizes.enabled,
  createdAt: activityDrawPrizes.createdAt,
  updatedAt: activityDrawPrizes.updatedAt,
  productStatus: localProducts.status,
}

function listPrizeRows(db: AppDatabase, activityId: string) {
  return db
    .select(prizeSelection)
    .from(activityDrawPrizes)
    .innerJoin(localProducts, eq(activityDrawPrizes.productId, localProducts.id))
    .where(eq(activityDrawPrizes.activityId, activityId))
    .orderBy(asc(activityDrawPrizes.createdAt), asc(activityDrawPrizes.id))
    .all()
}

type PrizeRow = ReturnType<typeof listPrizeRows>[number]

function toPrize(row: PrizeRow): ActivityDrawPrize {
  return activityDrawPrizeSchema.parse({
    id: row.id,
    activityId: row.activityId,
    productId: row.productId,
    productName: row.productName,
    productImageUrl: row.productImageUrl,
    costCents: row.costCents,
    productStatus: row.productStatus,
    totalQuantity: row.totalQuantity,
    remainingQuantity: row.remainingQuantity,
    drawnQuantity: row.drawnQuantity,
    weight: row.weight,
    enabled: row.enabled,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

function toOverview(
  activity: ActivityRow,
  pool: PoolRow | undefined,
  prizes: PrizeRow[],
): ActivityDrawPool {
  const mapped = prizes.map(toPrize)
  return activityDrawPoolSchema.parse({
    activityId: activity.id,
    activityStatus: activity.status,
    community: { id: activity.communityId, name: activity.communityName },
    configured: pool !== undefined,
    enabled: pool?.enabled ?? false,
    dailyDrawLimitPerResident: pool?.dailyDrawLimitPerResident ?? 0,
    noPrizeWeight: pool?.noPrizeWeight ?? 0,
    prizes: mapped,
    totals: {
      totalQuantity: mapped.reduce((total, prize) => total + prize.totalQuantity, 0),
      remainingQuantity: mapped.reduce((total, prize) => total + prize.remainingQuantity, 0),
      drawnQuantity: mapped.reduce((total, prize) => total + prize.drawnQuantity, 0),
      enabledPrizeCount: mapped.filter((prize) => prize.enabled).length,
    },
    updatedAt: pool ? iso(pool.updatedAt) : null,
  })
}

function poolOf(db: AppDatabase, activityId: string): PoolRow | undefined {
  return db
    .select()
    .from(activityDrawPools)
    .where(eq(activityDrawPools.activityId, activityId))
    .get()
}

export function getAdminDrawPool(
  db: AppDatabase,
  actor: LocalActor,
  activityId: string,
): ActivityDrawPool {
  assertDrawManager(actor)
  const activity = requireActivity(db, activityId)
  assertCommunityAccess(db, actor, activity.communityId)
  return toOverview(activity, poolOf(db, activityId), listPrizeRows(db, activityId))
}

function insertEvent(
  tx: LocalTransaction,
  activityId: string,
  prizeId: string | null,
  kind:
    | 'draw_pool.created'
    | 'draw_pool.updated'
    | 'draw_pool.enabled'
    | 'draw_pool.disabled'
    | 'draw_prize.created'
    | 'draw_prize.updated'
    | 'draw_prize.enabled'
    | 'draw_prize.disabled',
  actorUserId: string,
  now: Date,
  metadata?: Record<string, string | number | boolean>,
): void {
  tx.insert(activityDrawEvents)
    .values({
      id: randomUUID(),
      activityId,
      prizeId,
      kind,
      actorUserId,
      metadataJson: metadata ? JSON.stringify(metadata) : null,
      createdAt: now,
    })
    .run()
}

/**
 * Enabling a pool is only meaningful when at least one real prize can actually
 * be drawn right now: enabled, positive weight and positive remaining stock.
 * This blocks the "enabled but empty" state that residents must never see.
 */
function assertPoolCanEnable(prizes: PrizeRow[]): void {
  const drawable = prizes.some(
    (prize) => prize.enabled && prize.weight > 0 && prize.remainingQuantity > 0,
  )
  if (!drawable) {
    throw new LocalError(
      409,
      API_ERROR_CODES.drawPoolNotReady,
      '启用抽奖前，请至少配置一个已启用、有剩余库存且概率权重大于 0 的真实商品奖品',
    )
  }
}

export function saveDrawPool(
  db: AppDatabase,
  actor: LocalActor,
  activityId: string,
  body: SaveActivityDrawPoolRequest,
): ActivityDrawPool {
  assertDrawManager(actor)
  const parsed = saveActivityDrawPoolRequestSchema.parse(body)
  const activity = requireActivity(db, activityId)
  assertCommunityAccess(db, actor, activity.communityId)
  assertWritable(activity)

  const existing = poolOf(db, activityId)
  if (existing) {
    if (parsed.expectedUpdatedAt === null) {
      throw new LocalError(
        409,
        API_ERROR_CODES.conflict,
        '抽奖奖品池已存在，请刷新后重试',
      )
    }
    assertExpectedUpdatedAt(existing.updatedAt, parsed.expectedUpdatedAt)
  } else if (parsed.expectedUpdatedAt !== null) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '抽奖奖品池尚未创建，请刷新后重试')
  }

  const prizes = listPrizeRows(db, activityId)
  if (parsed.enabled) assertPoolCanEnable(prizes)

  const now = new Date()
  const updatedAt = nextUpdatedAt(existing?.updatedAt ?? now, now)
  const eventKind = !existing
    ? 'draw_pool.created'
    : parsed.enabled !== existing.enabled
      ? parsed.enabled
        ? 'draw_pool.enabled'
        : 'draw_pool.disabled'
      : 'draw_pool.updated'

  try {
    db.transaction((tx) => {
      if (existing) {
        const result = tx
          .update(activityDrawPools)
          .set({
            enabled: parsed.enabled,
            dailyDrawLimitPerResident: parsed.dailyDrawLimitPerResident,
            noPrizeWeight: parsed.noPrizeWeight,
            updatedByUserId: actor.userId,
            updatedAt,
          })
          .where(
            and(
              eq(activityDrawPools.id, existing.id),
              eq(activityDrawPools.updatedAt, existing.updatedAt),
            ),
          )
          .run()
        if (result.changes !== 1) {
          throw new LocalError(409, API_ERROR_CODES.conflict, '抽奖配置已被其他操作更新，请刷新后重试')
        }
        insertEvent(tx, activityId, null, eventKind, actor.userId, now, {
          enabled: parsed.enabled,
          dailyDrawLimitPerResident: parsed.dailyDrawLimitPerResident,
          noPrizeWeight: parsed.noPrizeWeight,
        })
        return
      }

      tx.insert(activityDrawPools)
        .values({
          id: randomUUID(),
          activityId,
          communityId: activity.communityId,
          enabled: parsed.enabled,
          dailyDrawLimitPerResident: parsed.dailyDrawLimitPerResident,
          noPrizeWeight: parsed.noPrizeWeight,
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
          createdAt: now,
          updatedAt,
        })
        .run()
      insertEvent(tx, activityId, null, eventKind, actor.userId, now, {
        enabled: parsed.enabled,
        dailyDrawLimitPerResident: parsed.dailyDrawLimitPerResident,
        noPrizeWeight: parsed.noPrizeWeight,
      })
    })
  } catch (error) {
    if (error instanceof LocalError) throw error
    if (error instanceof Error && /UNIQUE constraint failed|constraint failed/iu.test(error.message)) {
      throw new LocalError(409, API_ERROR_CODES.conflict, '抽奖配置冲突，请刷新后重试')
    }
    throw error
  }

  return toOverview(activity, poolOf(db, activityId), listPrizeRows(db, activityId))
}

export function createDrawPrize(
  db: AppDatabase,
  actor: LocalActor,
  activityId: string,
  body: CreateActivityDrawPrizeRequest,
): ActivityDrawPrize {
  assertDrawManager(actor)
  const parsed = createActivityDrawPrizeRequestSchema.parse(body)
  const activity = requireActivity(db, activityId)
  assertCommunityAccess(db, actor, activity.communityId)
  assertWritable(activity)

  const pool = poolOf(db, activityId)
  if (!pool) {
    throw new LocalError(
      409,
      API_ERROR_CODES.drawPoolNotConfigured,
      '请先保存抽奖基础配置，再添加奖品',
    )
  }

  const product = db
    .select({
      id: localProducts.id,
      communityId: localProducts.communityId,
      name: localProducts.name,
      imageUrl: localProducts.imageUrl,
      unitPriceCents: localProducts.unitPriceCents,
    })
    .from(localProducts)
    .where(eq(localProducts.id, parsed.productId))
    .get()
  if (!product) throw new LocalError(404, API_ERROR_CODES.notFound, '商品不存在')
  if (product.communityId !== activity.communityId) {
    throw new LocalError(
      400,
      API_ERROR_CODES.invalidRequest,
      '所选商品与活动不属于同一社区，不能作为该活动的奖品',
    )
  }

  const now = new Date()
  const prizeId = randomUUID()
  try {
    db.transaction((tx) => {
      tx.insert(activityDrawPrizes)
        .values({
          id: prizeId,
          poolId: pool.id,
          activityId,
          communityId: activity.communityId,
          productId: product.id,
          productName: product.name,
          productImageUrl: product.imageUrl,
          costCents: product.unitPriceCents,
          totalQuantity: parsed.totalQuantity,
          drawnQuantity: 0,
          remainingQuantity: parsed.totalQuantity,
          weight: parsed.weight,
          enabled: parsed.enabled,
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      insertEvent(tx, activityId, prizeId, 'draw_prize.created', actor.userId, now, {
        productId: product.id,
        totalQuantity: parsed.totalQuantity,
        weight: parsed.weight,
        enabled: parsed.enabled,
      })
    })
  } catch (error) {
    if (error instanceof LocalError) throw error
    if (error instanceof Error && /UNIQUE constraint failed|constraint failed/iu.test(error.message)) {
      throw new LocalError(409, API_ERROR_CODES.conflict, '该商品已在此活动的奖品池中')
    }
    throw error
  }

  const row = db
    .select(prizeSelection)
    .from(activityDrawPrizes)
    .innerJoin(localProducts, eq(activityDrawPrizes.productId, localProducts.id))
    .where(eq(activityDrawPrizes.id, prizeId))
    .get()
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '奖品不存在')
  return toPrize(row as PrizeRow)
}

export function updateDrawPrize(
  db: AppDatabase,
  actor: LocalActor,
  activityId: string,
  prizeId: string,
  body: UpdateActivityDrawPrizeRequest,
): ActivityDrawPrize {
  assertDrawManager(actor)
  const parsed = updateActivityDrawPrizeRequestSchema.parse(body)
  const activity = requireActivity(db, activityId)
  assertCommunityAccess(db, actor, activity.communityId)
  assertWritable(activity)

  const existing = db
    .select()
    .from(activityDrawPrizes)
    .where(
      and(
        eq(activityDrawPrizes.id, prizeId),
        eq(activityDrawPrizes.activityId, activityId),
      ),
    )
    .get()
  if (!existing) throw new LocalError(404, API_ERROR_CODES.notFound, '奖品不存在')
  assertExpectedUpdatedAt(existing.updatedAt, parsed.expectedUpdatedAt)

  // Inventory changes must never re-inflate already drawn stock: the remaining
  // amount is recomputed from the new total minus the immutable drawn count.
  const newTotal = parsed.totalQuantity ?? existing.totalQuantity
  if (newTotal < existing.drawnQuantity) {
    throw new LocalError(
      400,
      API_ERROR_CODES.invalidRequest,
      `奖品总量不能小于已抽取数量 ${existing.drawnQuantity}`,
    )
  }
  const newEnabled = parsed.enabled ?? existing.enabled
  const newWeight = parsed.weight ?? existing.weight
  const newRemaining = newTotal - existing.drawnQuantity
  if (newEnabled && newRemaining > 0 && newWeight === 0) {
    // Weight 0 is allowed while disabled, but an enabled prize needs a chance.
    throw new LocalError(
      400,
      API_ERROR_CODES.invalidRequest,
      '已启用且有库存的奖品，概率权重必须大于 0',
    )
  }

  const now = new Date()
  const updatedAt = nextUpdatedAt(existing.updatedAt, now)
  const eventKind =
    newEnabled !== existing.enabled
      ? newEnabled
        ? 'draw_prize.enabled'
        : 'draw_prize.disabled'
      : 'draw_prize.updated'

  try {
    db.transaction((tx) => {
      const result = tx
        .update(activityDrawPrizes)
        .set({
          totalQuantity: newTotal,
          remainingQuantity: newRemaining,
          weight: newWeight,
          enabled: newEnabled,
          updatedByUserId: actor.userId,
          updatedAt,
        })
        .where(
          and(
            eq(activityDrawPrizes.id, prizeId),
            eq(activityDrawPrizes.updatedAt, existing.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new LocalError(409, API_ERROR_CODES.conflict, '奖品已被其他操作更新，请刷新后重试')
      }
      insertEvent(tx, activityId, prizeId, eventKind, actor.userId, now, {
        totalQuantity: newTotal,
        remainingQuantity: newRemaining,
        weight: newWeight,
        enabled: newEnabled,
      })
    })
  } catch (error) {
    if (error instanceof LocalError) throw error
    if (error instanceof Error && /constraint failed/iu.test(error.message)) {
      throw new LocalError(409, API_ERROR_CODES.conflict, '奖品配置冲突，请刷新后重试')
    }
    throw error
  }

  const row = db
    .select(prizeSelection)
    .from(activityDrawPrizes)
    .innerJoin(localProducts, eq(activityDrawPrizes.productId, localProducts.id))
    .where(eq(activityDrawPrizes.id, prizeId))
    .get()
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '奖品不存在')
  return toPrize(row as PrizeRow)
}

/**
 * The resident-facing, read-only pool. It is either a list of real drawable
 * prizes or an explicit "not available" answer; it never fills the gap with a
 * demo prize, a zero-stock row or a disabled configuration.
 */
export function getPublicDrawPool(
  db: AppDatabase,
  activityId: string,
  now: Date = new Date(),
): PublicActivityDrawPool {
  const activity = requireActivity(db, activityId)

  const unavailable = (reason: PublicActivityDrawPool['unavailableReason']) =>
    publicActivityDrawPoolSchema.parse({
      activityId: activity.id,
      available: false,
      unavailableReason: reason,
      dailyDrawLimitPerResident: null,
      prizes: [],
    })

  if (activity.status === 'ended' || activity.endsAt.getTime() <= now.getTime()) {
    return unavailable('activity_ended')
  }
  if (activity.status !== 'published' || activity.startsAt.getTime() > now.getTime()) {
    return unavailable('activity_not_published')
  }

  const pool = poolOf(db, activityId)
  if (!pool) return unavailable('draw_pool_not_configured')
  if (!pool.enabled) return unavailable('draw_pool_disabled')

  const drawable = listPrizeRows(db, activityId).filter(
    (prize) => prize.enabled && prize.weight > 0 && prize.remainingQuantity > 0,
  )
  if (drawable.length === 0) return unavailable('no_prize_available')

  return publicActivityDrawPoolSchema.parse({
    activityId: activity.id,
    available: true,
    unavailableReason: null,
    dailyDrawLimitPerResident: pool.dailyDrawLimitPerResident,
    prizes: drawable.map((prize) => ({
      id: prize.id,
      name: prize.productName,
      imageUrl: prize.productImageUrl,
      remainingQuantity: prize.remainingQuantity,
    })),
  })
}
