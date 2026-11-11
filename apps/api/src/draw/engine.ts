import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  residentDrawAttemptSchema,
  residentDrawHistorySchema,
  residentDrawStateSchema,
  drawStaffCredentialSchema,
  type DrawStaffCredential,
  type ResidentDrawAttempt,
  type ResidentDrawState,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  activityDrawAttempts,
  activityDrawCredentials,
  activityDrawFulfilmentEvents,
  activityDrawPools,
  activityDrawPrizes,
} from '../db/schema.js'
import { assertCommunityAccess, LocalError, type LocalActor, type LocalTransaction } from '../local/shared.js'
import {
  assertResidentOfConfirmedCommunity,
  hasConfirmedCommunity,
  readConfirmedBinding,
} from '../resident-community/service.js'
import { getPublicDrawPool } from './service.js'

type Db = AppDatabase | LocalTransaction
type Attempt = typeof activityDrawAttempts.$inferSelect
type Credential = typeof activityDrawCredentials.$inferSelect
const MAX_HISTORY = 200

/** Beijing calendar day, regardless of the API host timezone. China does not use DST. */
export function drawBeijingDay(now: Date): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** The database holds only SHA-256 hashes. A stable external secret permits safe re-display. */
function codeFor(secret: string, id: string): string {
  return 'DL-' + createHmac('sha256', secret).update('local-life.draw.v1:' + id).digest('hex').slice(0, 24).toUpperCase()
}
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}
function requireSecret(secret?: string): asserts secret is string {
  if (!secret) {
    throw new LocalError(409, API_ERROR_CODES.drawPoolNotConfigured, '抽奖核销密钥尚未配置，暂不开放抽奖')
  }
}

function requireActivity(db: Db, activityId: string) {
  const activity = db.select({
    id: activities.id,
    communityId: activities.communityId,
    startsAt: activities.startsAt,
    endsAt: activities.endsAt,
    status: activities.status,
  }).from(activities).where(eq(activities.id, activityId)).get()
  if (!activity) throw new LocalError(404, API_ERROR_CODES.notFound, '活动不存在')
  return activity
}

/**
 * Whether the resident may act on this community (#171 LL-IDENTITY-001).
 *
 * This used to read `resident_community_assignments`, i.e. the historical row the
 * retired #123 OAuth flow wrote automatically at login — so "logged in from an
 * activity link" silently granted every community-scoped write. The authority is
 * now the resident's own confirmed binding; the read path stays lenient (returns
 * `false` so the state endpoint can say "not assigned" instead of throwing), while
 * the write path in `enterDraw` uses the shared guard and refuses.
 */
function isMember(db: Db, userId: string, communityId: string): boolean {
  return hasConfirmedCommunity(db, userId)
    && readConfirmedBinding(db, userId)?.communityId === communityId
}
function findCredential(db: Db, attemptId: string): Credential | undefined {
  return db.select().from(activityDrawCredentials).where(eq(activityDrawCredentials.attemptId, attemptId)).get()
}
function toResident(db: Db, attempt: Attempt, secret?: string): ResidentDrawAttempt {
  const credential = findCredential(db, attempt.id)
  const issuedCode = credential?.status === 'active' && secret ? codeFor(secret, credential.id) : null
  return residentDrawAttemptSchema.parse({
    id: attempt.id,
    activityId: attempt.activityId,
    day: attempt.day,
    sequence: attempt.sequence,
    outcome: attempt.outcome,
    prize: attempt.outcome === 'won' ? { name: attempt.prizeName, imageUrl: attempt.prizeImageUrl } : null,
    credential: credential ? {
      id: credential.id,
      status: credential.status,
      codeSuffix: credential.codeSuffix,
      code: issuedCode,
    } : null,
    createdAt: attempt.createdAt.toISOString(),
  })
}

export function getMyDrawHistory(db: AppDatabase, activityId: string, userId: string, secret?: string) {
  requireActivity(db, activityId)
  const attempts = db.select().from(activityDrawAttempts)
    .where(and(eq(activityDrawAttempts.activityId, activityId), eq(activityDrawAttempts.userId, userId)))
    .orderBy(desc(activityDrawAttempts.createdAt))
    .limit(MAX_HISTORY)
    .all()
  // An active award must never disappear behind the recent-history cap.
  // Keep outstanding prize claims independent from the bounded attempt feed.
  const activeAwards = db.select().from(activityDrawAttempts)
    .innerJoin(activityDrawCredentials, eq(activityDrawCredentials.attemptId, activityDrawAttempts.id))
    .where(and(
      eq(activityDrawAttempts.activityId, activityId),
      eq(activityDrawAttempts.userId, userId),
      eq(activityDrawCredentials.status, 'active'),
    ))
    .orderBy(desc(activityDrawAttempts.createdAt))
    .all()
    .map(row => toResident(db, row.activity_draw_attempts, secret))
  return residentDrawHistorySchema.parse({
    attempts: attempts.map(a => toResident(db, a, secret)),
    activeAwards,
  })
}

export function getMyDrawState(db: AppDatabase, activityId: string, userId: string | null, secret?: string, now = new Date()): ResidentDrawState {
  const activity = requireActivity(db, activityId)
  const day = drawBeijingDay(now)
  const pool = db.select().from(activityDrawPools).where(eq(activityDrawPools.activityId, activityId)).get()
  const todayCount = userId ? db.select({ id: activityDrawAttempts.id }).from(activityDrawAttempts)
    .where(and(eq(activityDrawAttempts.activityId, activityId), eq(activityDrawAttempts.userId, userId), eq(activityDrawAttempts.day, day)))
    .all().length : 0
  const limit = pool?.dailyDrawLimitPerResident ?? 0
  const publicPool = getPublicDrawPool(db, activityId, now)
  const unavailableReason: ResidentDrawState['unavailableReason'] =
    !userId ? 'not_authenticated'
    : !secret ? 'draw_service_not_configured'
    : !isMember(db, userId, activity.communityId) ? 'not_assigned'
    : !publicPool.available
      ? publicPool.unavailableReason === 'draw_pool_not_configured' ? 'draw_pool_not_configured'
        : publicPool.unavailableReason === 'draw_pool_disabled' ? 'draw_pool_disabled'
        : publicPool.unavailableReason === 'no_prize_available' ? 'no_prize_available' : 'activity_unavailable'
      : todayCount >= limit ? 'daily_limit_reached' : null
  return residentDrawStateSchema.parse({
    activityId, authenticated: userId !== null,
    available: unavailableReason === null,
    unavailableReason, day, dailyLimit: limit, todayCount,
    remainingToday: Math.max(0, limit - todayCount),
  })
}

export interface EnterDrawInput {
  activityId: string
  userId: string
  idempotencyKey: string
  secret?: string
  now?: Date
  /** Only for deterministic service tests; HTTP never forwards an RNG. */
  pick?: (exclusiveMax: number) => number
}

/**
 * BEGIN IMMEDIATE serializes competing writers. Daily slot and idempotency UNIQUE
 * indexes are the second defence; conditional stock UPDATE prevents overselling.
 */
export function enterDailyDraw(db: AppDatabase, input: EnterDrawInput): ResidentDrawAttempt {
  requireSecret(input.secret)
  const credentialSecret = input.secret
  const now = input.now ?? new Date()
  const day = drawBeijingDay(now)
  try {
    return db.transaction((tx) => {
      const existing = tx.select().from(activityDrawAttempts).where(and(
        eq(activityDrawAttempts.activityId, input.activityId),
        eq(activityDrawAttempts.userId, input.userId),
        eq(activityDrawAttempts.idempotencyKey, input.idempotencyKey),
      )).get()
      // A retry returns the original result even if the pool was subsequently disabled.
      if (existing) return toResident(tx, existing, input.secret)

      const activity = requireActivity(tx, input.activityId)
      // #171 LL-IDENTITY-001: a draw is a community-scoped write, so the authority
      // is the resident's confirmed binding — not a historical assignment row.
      // `assertResidentOfConfirmedCommunity` throws the shared 403
      // `resident_community_not_bound` / `resident_community_conflict`, which the
      // route maps to the standard envelope.
      assertResidentOfConfirmedCommunity(tx, input.userId, activity.communityId)
      if (activity.status !== 'published' || activity.startsAt > now || activity.endsAt <= now) {
        throw new LocalError(409, API_ERROR_CODES.activityUnavailable, '活动未开放或已经结束')
      }
      const pool = tx.select().from(activityDrawPools).where(eq(activityDrawPools.activityId, input.activityId)).get()
      if (!pool?.enabled) throw new LocalError(409, API_ERROR_CODES.drawPoolNotReady, '今日抽奖尚未开放')
      const priorCount = tx.select({ id: activityDrawAttempts.id }).from(activityDrawAttempts)
        .where(and(eq(activityDrawAttempts.activityId, input.activityId), eq(activityDrawAttempts.userId, input.userId), eq(activityDrawAttempts.day, day))).all().length
      if (priorCount >= pool.dailyDrawLimitPerResident) {
        throw new LocalError(409, API_ERROR_CODES.drawDailyLimit, '今天的抽奖次数已用完')
      }
      const prizes = tx.select().from(activityDrawPrizes)
        .where(and(eq(activityDrawPrizes.poolId, pool.id), eq(activityDrawPrizes.enabled, true), sql`${activityDrawPrizes.remainingQuantity} > 0`, sql`${activityDrawPrizes.weight} > 0`)).all()
      const totalWeight = prizes.reduce((n, p) => n + p.weight, pool.noPrizeWeight)
      if (!prizes.length || totalWeight <= 0 || !Number.isSafeInteger(totalWeight) || totalWeight > 2 ** 48) {
        throw new LocalError(409, API_ERROR_CODES.drawPoolNotReady, '没有可抽取的真实奖品')
      }
      let roll = (input.pick ?? randomInt)(totalWeight)
      if (!Number.isInteger(roll) || roll < 0 || roll >= totalWeight) {
        throw new LocalError(400, API_ERROR_CODES.invalidRequest, '无效随机值')
      }
      let chosen: typeof prizes[number] | null = null
      for (const prize of prizes) {
        if (roll < prize.weight) { chosen = prize; break }
        roll -= prize.weight
      }
      // no-prize outcome occupies its actual configured weight.
      if (chosen) {
        const changed = tx.update(activityDrawPrizes).set({
          drawnQuantity: sql`${activityDrawPrizes.drawnQuantity} + 1`,
          remainingQuantity: sql`${activityDrawPrizes.remainingQuantity} - 1`,
        }).where(and(eq(activityDrawPrizes.id, chosen.id), sql`${activityDrawPrizes.remainingQuantity} > 0`)).run()
        if (changed.changes !== 1) throw new LocalError(409, API_ERROR_CODES.conflict, '奖品库存更新冲突，请重试')
      }
      const attemptId = randomUUID()
      const sequence = priorCount + 1
      tx.insert(activityDrawAttempts).values({
        id: attemptId, activityId: input.activityId, poolId: pool.id,
        userId: input.userId, day, sequence, idempotencyKey: input.idempotencyKey,
        outcome: chosen ? 'won' : 'missed',
        prizeId: chosen?.id ?? null, prizeName: chosen?.productName ?? null,
        prizeImageUrl: chosen?.productImageUrl ?? null, prizeCostCents: chosen?.costCents ?? null,
        createdAt: now,
      }).run()
      if (chosen) {
        const credentialId = randomUUID()
        const code = codeFor(credentialSecret, credentialId)
        tx.insert(activityDrawCredentials).values({
          id: credentialId, attemptId, activityId: input.activityId, userId: input.userId,
          prizeId: chosen.id, codeHash: hashCode(code), codeSuffix: code.slice(-4),
          status: 'active', createdAt: now,
        }).run()
        tx.insert(activityDrawFulfilmentEvents).values({
          id: randomUUID(), activityId: input.activityId, credentialId,
          kind: 'issued', actorUserId: input.userId, createdAt: now,
        }).run()
      }
      const result = tx.select().from(activityDrawAttempts).where(eq(activityDrawAttempts.id, attemptId)).get()
      if (!result) throw new LocalError(409, API_ERROR_CODES.conflict, '开奖结果保存失败')
      return toResident(tx, result, input.secret)
    }, { behavior: 'immediate' })
  } catch (error) {
    if (error instanceof LocalError) throw error
    if (error instanceof Error && /SQLITE_BUSY|UNIQUE constraint failed|constraint failed/iu.test(error.message)) {
      throw new LocalError(409, API_ERROR_CODES.conflict, '抽奖请求发生并发冲突，请使用原请求编号重试')
    }
    throw error
  }
}

function credentialScope(db: AppDatabase, actor: LocalActor, activityId: string): void {
  const activity = requireActivity(db, activityId)
  assertCommunityAccess(db, actor, activity.communityId)
}

function getStaffCredential(db: Db, activityId: string, credentialId: string): { row: Credential; attempt: Attempt } {
  const row = db.select().from(activityDrawCredentials)
    .where(and(eq(activityDrawCredentials.activityId, activityId), eq(activityDrawCredentials.id, credentialId))).get()
  if (!row) throw new LocalError(404, API_ERROR_CODES.drawCredentialInvalid, '核销凭据不存在')
  const attempt = db.select().from(activityDrawAttempts).where(eq(activityDrawAttempts.id, row.attemptId)).get()
  if (!attempt) throw new LocalError(404, API_ERROR_CODES.notFound, '中奖记录不存在')
  return { row, attempt }
}
function staffView(row: Credential, attempt: Attempt): DrawStaffCredential {
  return drawStaffCredentialSchema.parse({
    credentialId: row.id, attemptId: attempt.id,
    prizeName: attempt.prizeName, status: row.status,
    codeSuffix: row.codeSuffix, redeemedAt: row.redeemedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  })
}
function locateCode(db: Db, activityId: string, code: string) {
  const row = db.select().from(activityDrawCredentials)
    .where(and(eq(activityDrawCredentials.activityId, activityId), eq(activityDrawCredentials.codeHash, hashCode(code)))).get()
  if (!row) throw new LocalError(404, API_ERROR_CODES.drawCredentialInvalid, '核销码无效')
  return getStaffCredential(db, activityId, row.id)
}

export function verifyDrawCredential(db: AppDatabase, actor: LocalActor, activityId: string, code: string) {
  credentialScope(db, actor, activityId)
  const { row, attempt } = locateCode(db, activityId, code)
  return staffView(row, attempt)
}

export function redeemDrawCredential(db: AppDatabase, actor: LocalActor, activityId: string, code: string, now = new Date()) {
  credentialScope(db, actor, activityId)
  return db.transaction((tx) => {
    const { row, attempt } = locateCode(tx, activityId, code)
    if (row.status === 'redeemed') throw new LocalError(409, API_ERROR_CODES.drawAlreadyRedeemed, '该奖品已核销')
    if (row.status !== 'active') throw new LocalError(409, API_ERROR_CODES.drawCredentialInvalid, '该核销码已作废')
    const changed = tx.update(activityDrawCredentials).set({
      status: 'redeemed', redeemedAt: now, redeemedByStaffId: actor.staffId,
    }).where(and(eq(activityDrawCredentials.id, row.id), eq(activityDrawCredentials.status, 'active'))).run()
    if (changed.changes !== 1) throw new LocalError(409, API_ERROR_CODES.conflict, '奖品正在被核销')
    tx.insert(activityDrawFulfilmentEvents).values({
      id: randomUUID(), activityId, credentialId: row.id, kind: 'redeemed',
      actorUserId: actor.userId, staffId: actor.staffId, createdAt: now,
    }).run()
    return staffView({ ...row, status: 'redeemed', redeemedAt: now }, attempt)
  }, { behavior: 'immediate' })
}

/** Revocation never restores inventory; already-redeemed awards get an audit-only dispute. */
export function revokeDrawCredential(db: AppDatabase, actor: LocalActor, activityId: string, credentialId: string, reason: string, now = new Date()) {
  credentialScope(db, actor, activityId)
  return db.transaction((tx) => {
    const { row, attempt } = getStaffCredential(tx, activityId, credentialId)
    if (row.status === 'revoked') return staffView(row, attempt)
    if (row.status === 'active') {
      const changed = tx.update(activityDrawCredentials).set({
        status: 'revoked', revokedAt: now, revokedByStaffId: actor.staffId, revokeReason: reason,
      }).where(and(eq(activityDrawCredentials.id, row.id), eq(activityDrawCredentials.status, 'active'))).run()
      if (changed.changes !== 1) throw new LocalError(409, API_ERROR_CODES.conflict, '核销状态冲突')
    }
    tx.insert(activityDrawFulfilmentEvents).values({
      id: randomUUID(), activityId, credentialId, kind: row.status === 'redeemed' ? 'disputed' : 'revoked',
      actorUserId: actor.userId, staffId: actor.staffId, note: reason, createdAt: now,
    }).run()
    return staffView({ ...row, status: row.status === 'redeemed' ? 'redeemed' : 'revoked' }, attempt)
  }, { behavior: 'immediate' })
}
