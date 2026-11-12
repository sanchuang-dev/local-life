import {
  and,
  eq,
  inArray,
  type SQL,
} from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import {
  API_ERROR_CODES,
  type ApiErrorCode,
  type StaffRole,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import { auditLogs, staffCommunityAssignments } from '../db/schema.js'

/**
 * Server-resolved caller identity for the local catalogue / local order domain.
 *
 * `staffId` is null for a pure resident session; `role` mirrors the resolved
 * staff account and is never taken from the request.
 */
export interface LocalActor {
  userId: string
  staffId: string | null
  role: StaffRole | null
}

/**
 * Domain error carrying the HTTP status and a shared error code. Routes translate
 * it into the standard `{ error: { code, message, requestId } }` envelope, exactly
 * like `CrmError`/`ParticipationError` do.
 */
export class LocalError extends Error {
  status: 400 | 401 | 403 | 404 | 409
  code: ApiErrorCode

  constructor(status: 400 | 401 | 403 | 404 | 409, code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'LocalError'
    this.status = status
    this.code = code
  }
}

export type LocalTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]

export function iso(timestamp: Date): string {
  return timestamp.toISOString()
}

export function isoOrNull(timestamp: Date | null): string | null {
  return timestamp === null ? null : timestamp.toISOString()
}

export function assertExpectedUpdatedAt(actual: Date, expectedUpdatedAt: string): void {
  if (actual.getTime() !== Date.parse(expectedUpdatedAt)) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '数据已被其他操作更新，请刷新后重试')
  }
}

/** The optimistic-concurrency token must always advance, even inside one millisecond. */
export function nextUpdatedAt(previous: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1))
}

export function mapConstraintError(error: unknown): never {
  if (error instanceof LocalError) throw error
  if (error instanceof Error && /UNIQUE constraint failed|constraint failed/iu.test(error.message)) {
    throw new LocalError(409, API_ERROR_CODES.conflict, '数据冲突，请刷新后重试')
  }
  throw error
}

export function escapedLike(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/gu, '\\$&')}%`
}

export function assignedCommunityIds(db: AppDatabase, staffId: string): string[] {
  return db
    .select({ communityId: staffCommunityAssignments.communityId })
    .from(staffCommunityAssignments)
    .where(eq(staffCommunityAssignments.staffAccountId, staffId))
    .all()
    .map((row) => row.communityId)
}

/**
 * Communities the caller may act on. `admin` is unscoped (`null` means "all"),
 * everyone else is limited to `staff_community_assignments`.
 */
export function scopeCommunityIds(
  db: AppDatabase,
  actor: LocalActor,
): string[] | null {
  if (actor.role === 'admin') return null
  if (!actor.staffId) return []
  return assignedCommunityIds(db, actor.staffId)
}

export function assertCommunityAccess(
  db: AppDatabase,
  actor: LocalActor,
  communityId: string,
): void {
  if (actor.role === 'admin') return
  if (!actor.staffId || !assignedCommunityIds(db, actor.staffId).includes(communityId)) {
    throw new LocalError(403, API_ERROR_CODES.forbidden, '无权访问该社区的数据')
  }
}

/**
 * Applies the caller's community scope to a list query. Returns `false` when the
 * caller has no community at all, so the caller can answer with an empty page
 * instead of leaking every row (the CRM list precedent).
 */
export function applyCommunityScope(
  scoped: string[] | null,
  column: Parameters<typeof inArray>[0],
  conditions: SQL<unknown>[],
): boolean {
  if (scoped === null) return true
  if (scoped.length === 0) return false
  conditions.push(inArray(column, scoped))
  return true
}

export function combine(conditions: SQL<unknown>[]): SQL<unknown> | undefined {
  if (conditions.length === 0) return undefined
  return conditions.length === 1 ? conditions[0] : and(...conditions)
}

/**
 * Audit rows reuse the shared `audit_logs` table (one audit source of truth for
 * the back office) but always with a `local_*` event prefix so they can never be
 * read as `crm.order.*`/`crmeb.*` events.
 */
export function insertAudit(
  tx: LocalTransaction,
  actorUserId: string | null,
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
