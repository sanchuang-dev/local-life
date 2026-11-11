import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'

import {
  API_ERROR_CODES,
  residentCommunityStatusResponseSchema,
  type ApiErrorCode,
  type ResidentCommunityBinding,
  type ResidentCommunityBindingSource,
  type ResidentCommunityCandidate,
  type ResidentCommunityCandidateSource,
  type ResidentCommunityConfirmBlockedReason,
  type ResidentCommunityRef,
  type ResidentCommunityStatusResponse,
  type ResidentCommunityStoredCandidateSource,
} from '@sanchuang-dev/local-life-contracts'

import type { AppDatabase } from '../db/client.js'
import type { HttpErrorStatus } from '../http.js'
import {
  auditLogs,
  communities,
  residentCommunityAssignments,
  residentCommunityBindingCandidates,
  residentCommunityBindings,
} from '../db/schema.js'
import type { LocalTransaction } from '../local/shared.js'

/**
 * Permanent resident community binding service (#171 LL-IDENTITY-001).
 *
 * The rules this module owns, and nothing above it may bypass:
 *
 * 1. A binding is created only by `confirmResidentCommunity`, called from the
 *    resident's explicit confirmation over their own session. No OAuth callback,
 *    login, browse action, admin page or client-supplied id creates one.
 * 2. At most one binding per resident. The guarantee lives in the database
 *    (`resident_community_bindings_user_confirmed_uq`); the service additionally
 *    checks first so the ordinary path returns a clear 409 instead of a raw
 *    constraint error, while a genuine race still fails closed at the storage
 *    layer.
 * 3. A candidate is a suggestion derived from trusted server data and stored
 *    server-side. `recordBindingCandidate` is the only writer and it re-reads the
 *    community row itself — a client cannot inject a candidate to steer a
 *    confirmation.
 * 4. Historical `resident_community_assignments` rows are read as history only.
 *    Exactly one such row is surfaced as a confirmable suggestion; two or more
 *    are `pending_review` and cannot be self-confirmed, because choosing one of
 *    them automatically is precisely the "random earliest/newest" behaviour the
 *    issue forbids.
 */

/** How long an activity-derived suggestion stays valid. */
export const RESIDENT_COMMUNITY_CANDIDATE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const BIND_EVENT = 'resident_community.bound'
const CANDIDATE_EVENT = 'resident_community.candidate_recorded'

export type ResidentCommunityDb = AppDatabase | LocalTransaction

/** Domain failure with the HTTP status and shared error code the route returns. */
export class ResidentCommunityError extends Error {
  readonly status: HttpErrorStatus
  readonly code: ApiErrorCode

  constructor(status: HttpErrorStatus, code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'ResidentCommunityError'
    this.status = status
    this.code = code
  }
}

/** Internal row shape: the binding plus the community it points at. */
export interface ConfirmedBinding {
  id: string
  userId: string
  communityId: string
  confirmedAt: Date
  source: ResidentCommunityBindingSource
  evidenceRef: string
}

export interface ConfirmResidentCommunityResult {
  binding: ResidentCommunityBinding
  /** `true` when the same community was submitted again and nothing was written. */
  idempotent: boolean
}

function communityRef(db: ResidentCommunityDb, communityId: string): ResidentCommunityRef | null {
  const row = db
    .select({
      id: communities.id,
      name: communities.name,
      address: communities.address,
    })
    .from(communities)
    .where(eq(communities.id, communityId))
    .get()
  if (!row) return null
  return { id: row.id, name: row.name, serviceAddress: row.address }
}

/** The one confirmed binding for a resident, or `null`. Read-only. */
export function readConfirmedBinding(
  db: ResidentCommunityDb,
  userId: string,
): ConfirmedBinding | null {
  return (
    db
      .select({
        id: residentCommunityBindings.id,
        userId: residentCommunityBindings.userId,
        communityId: residentCommunityBindings.communityId,
        confirmedAt: residentCommunityBindings.confirmedAt,
        source: residentCommunityBindings.source,
        evidenceRef: residentCommunityBindings.evidenceRef,
      })
      .from(residentCommunityBindings)
      .where(eq(residentCommunityBindings.userId, userId))
      .get() ?? null
  )
}

/* -------------------------------------------------------------------------- */
/* Candidate                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Records (or replaces) the single server-derived candidate for a resident.
 *
 * Called from the OAuth start flow with the community resolved from the activity
 * row — never with a `communityId` taken from the request. Behaviour:
 * - an unknown community is ignored (no row, no error): a stale activity link
 *   must not break a login, and a candidate is not a security decision;
 * - a resident who ALREADY has a permanent binding gets no candidate at all: once
 *   the resident confirmed, no later activity/browse may write a candidate row, so
 *   a confirmed account can never be shown another confirmation prompt and the
 *   candidate table can never contradict the binding. Read-only disagreement
 *   between the binding and the *historical* assignments is still surfaced by
 *   `getResidentCommunityStatus` as `conflict`;
 * - an existing candidate is overwritten, so the newest trusted suggestion wins.
 *
 * Returns `true` when a candidate row exists afterwards.
 */
export function recordBindingCandidate(
  db: AppDatabase,
  input: {
    userId: string
    communityId: string
    source: ResidentCommunityStoredCandidateSource
    now: Date
    ttlMs?: number
  },
): boolean {
  if (!communityRef(db, input.communityId)) return false
  if (readConfirmedBinding(db, input.userId)) return false
  const ttl = input.ttlMs ?? RESIDENT_COMMUNITY_CANDIDATE_TTL_MS
  const expiresAt = new Date(input.now.getTime() + ttl)
  db.insert(residentCommunityBindingCandidates)
    .values({
      userId: input.userId,
      communityId: input.communityId,
      source: input.source,
      suggestedAt: input.now,
      expiresAt,
      createdAt: input.now,
    })
    .onConflictDoUpdate({
      target: residentCommunityBindingCandidates.userId,
      set: {
        communityId: input.communityId,
        source: input.source,
        suggestedAt: input.now,
        expiresAt,
        createdAt: input.now,
      },
    })
    .run()
  appendAudit(db, {
    id: randomUUID(),
    actorUserId: input.userId,
    event: CANDIDATE_EVENT,
    targetId: input.communityId,
    createdAt: input.now,
    metadata: { source: input.source },
  })
  return true
}

/** Drops the candidate, e.g. once the resident confirmed a community. */
export function clearBindingCandidate(db: ResidentCommunityDb, userId: string): void {
  db.delete(residentCommunityBindingCandidates)
    .where(eq(residentCommunityBindingCandidates.userId, userId))
    .run()
}

/** A stored candidate that has not expired, or `null`. */
function storedCandidate(
  db: ResidentCommunityDb,
  userId: string,
  now: Date,
): { ref: ResidentCommunityRef; source: ResidentCommunityCandidateSource; suggestedAt: Date; expiresAt: Date | null } | null {
  const row = db
    .select()
    .from(residentCommunityBindingCandidates)
    .where(eq(residentCommunityBindingCandidates.userId, userId))
    .get()
  if (!row) return null
  if (row.expiresAt.getTime() <= now.getTime()) return null
  const ref = communityRef(db, row.communityId)
  if (!ref) return null
  return { ref, source: row.source, suggestedAt: row.suggestedAt, expiresAt: row.expiresAt }
}

/** Every historical relation, ordered by community id so the payload is stable. */
function legacyAssignments(
  db: ResidentCommunityDb,
  userId: string,
): Array<{ community: ResidentCommunityRef; assignedAt: Date }> {
  const rows = db
    .select({
      communityId: residentCommunityAssignments.communityId,
      createdAt: residentCommunityAssignments.createdAt,
    })
    .from(residentCommunityAssignments)
    .where(eq(residentCommunityAssignments.userId, userId))
    .orderBy(asc(residentCommunityAssignments.communityId))
    .all()
  const result: Array<{ community: ResidentCommunityRef; assignedAt: Date }> = []
  for (const row of rows) {
    const ref = communityRef(db, row.communityId)
    if (!ref) continue
    result.push({ community: ref, assignedAt: row.createdAt })
  }
  return result
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The single read behind 「未绑定 / 已确认常驻社区 / 历史归属待核查 / 冲突」.
 *
 * Reads only; it never creates a binding or a candidate. `pendingReview` is
 * derived from the historical row count (>= 2) so an account with several legacy
 * relations is reported for a human decision without the API picking one.
 */
export function getResidentCommunityStatus(
  db: ResidentCommunityDb,
  userId: string,
  now: Date,
): ResidentCommunityStatusResponse {
  const binding = readConfirmedBinding(db, userId)
  const history = legacyAssignments(db, userId)
  const pendingReview = history.length > 1

  let candidate: ResidentCommunityCandidate | null = null
  // A stored suggestion is only ever written while the resident is unbound
  // (`recordBindingCandidate` refuses afterwards), so a bound resident reads no
  // stored candidate here.
  const stored = storedCandidate(db, userId, now)
  if (stored) {
    candidate = {
      community: stored.ref,
      source: stored.source,
      suggestedAt: stored.suggestedAt.toISOString(),
      expiresAt: stored.expiresAt ? stored.expiresAt.toISOString() : null,
    }
  } else if (history.length === 1) {
    // Exactly one historical relation is a suggestion the resident must confirm,
    // not a binding. It has no expiry: it is a standing fact about the account.
    // When the resident is already bound elsewhere this is what makes the status
    // `conflict` — read-only evidence that history disagrees with the binding,
    // never an invitation to change it.
    candidate = {
      community: history[0]!.community,
      source: 'legacy_single_assignment_candidate',
      suggestedAt: history[0]!.assignedAt.toISOString(),
      expiresAt: null,
    }
  }

  let status: ResidentCommunityStatusResponse['status']
  let blocked: ResidentCommunityConfirmBlockedReason | null = null

  if (binding && candidate && candidate.community.id !== binding.communityId) {
    status = 'conflict'
    blocked = 'candidate_conflict'
  } else if (binding) {
    // No candidate, or a suggestion that matches the binding: nothing to reconcile.
    candidate = null
    status = 'confirmed'
    blocked = 'already_confirmed'
  } else if (pendingReview) {
    status = 'pending_review'
    blocked = 'pending_review'
  } else {
    status = 'unbound'
  }

  const bindingRef = binding ? communityRef(db, binding.communityId) : null
  return residentCommunityStatusResponseSchema.parse({
    status,
    binding:
      binding && bindingRef
        ? {
            community: bindingRef,
            confirmedAt: binding.confirmedAt.toISOString(),
            source: binding.source,
          }
        : null,
    candidate,
    legacyHistory: {
      assignmentCount: history.length,
      pendingReview,
      assignments: history.map((row) => ({
        community: row.community,
        assignedAt: row.assignedAt.toISOString(),
      })),
    },
    canConfirm: status === 'unbound',
    confirmBlockedReason: status === 'unbound' ? null : blocked,
  })
}

/* -------------------------------------------------------------------------- */
/* Confirmation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Creates the resident's one permanent community binding.
 *
 * Failure modes are explicit and leave the database untouched:
 * - unknown community -> 404 `resident_community_not_found`;
 * - already bound to the same community -> success with `idempotent: true`
 *   (no second row, no new audit row, `confirmedAt` unchanged);
 * - already bound to another community -> 409 `resident_community_conflict`, the
 *   existing binding is never touched;
 * - two or more historical relations -> 409 `resident_community_pending_review`,
 *   because a human must decide first.
 *
 * Success writes the binding and its audit row in ONE transaction and stores the
 * audit id as `evidence_ref`; the acting resident is recorded as the confirmant.
 * No credential (openid/token/cookie/session) is ever written to the audit row.
 */
export function confirmResidentCommunity(
  db: AppDatabase,
  input: {
    userId: string
    communityId: string
    now: Date
    source?: ResidentCommunityBindingSource
  },
): ConfirmResidentCommunityResult {
  const source = input.source ?? 'resident_h5_confirmed'
  const ref = communityRef(db, input.communityId)
  if (!ref) {
    throw new ResidentCommunityError(
      404,
      API_ERROR_CODES.residentCommunityNotFound,
      '社区不存在或已下线，无法绑定',
    )
  }

  const existing = readConfirmedBinding(db, input.userId)
  if (existing) {
    if (existing.communityId === input.communityId) {
      return {
        binding: {
          community: ref,
          confirmedAt: existing.confirmedAt.toISOString(),
          source: existing.source,
        },
        idempotent: true,
      }
    }
    const bound = communityRef(db, existing.communityId)
    throw new ResidentCommunityError(
      409,
      API_ERROR_CODES.residentCommunityConflict,
      `你已绑定常驻社区「${bound?.name ?? existing.communityId}」，不可修改`,
    )
  }

  if (legacyAssignments(db, input.userId).length > 1) {
    throw new ResidentCommunityError(
      409,
      API_ERROR_CODES.residentCommunityPendingReview,
      '该账户存在多条历史社区归属，需人工核查后才能绑定常驻社区',
    )
  }

  const bindingId = randomUUID()
  const confirmedAt = input.now

  return db.transaction(
    (tx) => {
      const auditId = randomUUID()
      appendAudit(tx, {
        id: auditId,
        actorUserId: input.userId,
        event: BIND_EVENT,
        targetId: bindingId,
        createdAt: confirmedAt,
        metadata: { source, communityId: input.communityId },
      })
      tx.insert(residentCommunityBindings)
        .values({
          id: bindingId,
          userId: input.userId,
          communityId: input.communityId,
          confirmedAt,
          source,
          confirmedByUserId: input.userId,
          evidenceRef: auditId,
          createdAt: confirmedAt,
        })
        .run()
      // The suggestion has served its purpose; keep the tables consistent so a
      // later read cannot show a confirmation prompt next to a binding.
      tx.delete(residentCommunityBindingCandidates)
        .where(eq(residentCommunityBindingCandidates.userId, input.userId))
        .run()
      return {
        binding: {
          community: ref,
          confirmedAt: confirmedAt.toISOString(),
          source,
        },
        idempotent: false,
      }
    },
    { behavior: 'immediate' },
  )
}

/* -------------------------------------------------------------------------- */
/* Community-scoped write guard                                               */
/* -------------------------------------------------------------------------- */

/**
 * Guard for community-scoped resident writes (participation, teams, local
 * orders, today's draw, …).
 *
 * `Lead` wires this into those services; it deliberately does not know about any
 * of them:
 * - no binding -> 403 `resident_community_not_bound` ("confirm a community first");
 * - bound to A, writing to B -> 403 `resident_community_conflict`, and the message
 *   names the bound community so the resident understands why;
 * - bound to A, writing to A -> allowed.
 *
 * It also confirms the community exists, so a forgeable UUID cannot become a
 * write target merely because a caller skipped its own existence check.
 * A legacy `resident_community_assignments` row never satisfies this guard.
 */
export function assertResidentOfConfirmedCommunity(
  db: ResidentCommunityDb,
  userId: string,
  communityId: string,
): void {
  if (!communityRef(db, communityId)) {
    throw new ResidentCommunityError(
      404,
      API_ERROR_CODES.residentCommunityNotFound,
      '社区不存在或已下线',
    )
  }
  const binding = readConfirmedBinding(db, userId)
  if (!binding) {
    throw new ResidentCommunityError(
      403,
      API_ERROR_CODES.residentCommunityNotBound,
      '请先在「我的」中确认常驻社区，再进行本操作',
    )
  }
  if (binding.communityId !== communityId) {
    const bound = communityRef(db, binding.communityId)
    throw new ResidentCommunityError(
      403,
      API_ERROR_CODES.residentCommunityConflict,
      `你的常驻社区是「${bound?.name ?? binding.communityId}」，不能在该社区操作`,
    )
  }
}

/** `true` when the resident has a confirmed binding — convenience for read paths. */
export function hasConfirmedCommunity(db: ResidentCommunityDb, userId: string): boolean {
  return (
    db
      .select({ userId: residentCommunityBindings.userId })
      .from(residentCommunityBindings)
      .where(eq(residentCommunityBindings.userId, userId))
      .get() !== undefined
  )
}

/**
 * Appends one `audit_logs` row, the single audit source of truth shared with the
 * back office. `metadata` is limited to non-credential facts (source, community);
 * openid/unionid/token/cookie/phone never reach this function.
 */
function appendAudit(
  db: ResidentCommunityDb,
  values: {
    id: string
    actorUserId: string | null
    event: string
    targetId: string | null
    createdAt: Date
    metadata?: Record<string, string>
  },
): string {
  db.insert(auditLogs)
    .values({
      id: values.id,
      actorUserId: values.actorUserId,
      event: values.event,
      targetId: values.targetId,
      metadata: values.metadata ? JSON.stringify(values.metadata) : null,
      createdAt: values.createdAt,
    })
    .run()
  return values.id
}
