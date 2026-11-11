import { randomBytes, randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  activityParticipationStateSchema,
  type ActivityParticipationState,
  type ActivityStatus,
  type ApiErrorCode,
  type ParticipationInviteSource,
  type ParticipationRole,
  type ParticipationTeamStatus,
  type ParticipationUnavailableReason,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  activityInvitations,
  activityParticipations,
  activityTeams,
  auditLogs,
  users,
} from '../db/schema.js'
import { assertResidentOfConfirmedCommunity } from '../resident-community/service.js'

/**
 * SQLite + Drizzle participation service (Issue #60 / LL-MVP-004).
 *
 * This module owns the ONLY write path into `activity_teams`,
 * `activity_participations` and `activity_invitations`. It deliberately depends
 * on the database only: HTTP status translation and resident-session identity
 * belong to the routes layer, which never supplies a `userId` from the request
 * body.
 *
 * Invariants (also enforced in migration 0002 by UNIQUE indexes, CHECK
 * constraints and triggers, so a bug here cannot corrupt the team):
 * 1. One resident has at most one participation per activity
 *    (`unique(activity_id, user_id)`), and one team per activity is led by one
 *    resident (`unique(activity_id, leader_user_id)`).
 * 2. A team has never more than three seats (`unique(team_id, seat_no)` plus
 *    `seat_no BETWEEN 1 AND 3`). Seat 1 is the leading resident; seats 2 and 3
 *    are invitation-sourced members.
 * 3. Attribution (`invite_source`, `invitation_id`) is written once when the
 *    resident first confirms and is immutable afterwards, so later share links
 *    can never rewrite the first effective attribution.
 * 4. A team becomes `locked` in the same transaction that fills seat 3, and it
 *    can never be unlocked or deleted.
 *
 * Invitation attribution and grid-worker sales attribution are different
 * domains. Nothing in this schema or service records, derives or reads a
 * grid-worker/sales owner; the two must never be joined to pay invitation
 * bonuses. See docs/engineering/participation-teams.md.
 */

/** Domain error reasons the route layer may distinguish without string matching. */
export type ParticipationErrorReason =
  | 'activity_not_found'
  | 'activity_draft'
  | 'activity_unavailable'
  | 'invite_invalid'
  | 'team_full'
  | 'concurrent_conflict'

/**
 * Domain error carrying the suggested HTTP status and the shared error code.
 * Routes translate it into `{ error: { code, message, requestId } }`, exactly
 * like `ActivityError` does for the activity domain.
 */
export class ParticipationError extends Error {
  status: 400 | 404 | 409
  code: ApiErrorCode
  reason: ParticipationErrorReason

  constructor(
    status: 400 | 404 | 409,
    code: ApiErrorCode,
    reason: ParticipationErrorReason,
    message: string,
  ) {
    super(message)
    this.name = 'ParticipationError'
    this.status = status
    this.code = code
    this.reason = reason
  }
}

type ParticipationTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]

/** Reads may run on the pooled connection; writes always run inside the immediate transaction. */
type ParticipationExecutor = AppDatabase | ParticipationTransaction

export interface ParticipationActivitySnapshot {
  id: string
  status: ActivityStatus
  endsAt: Date
  /**
   * The community the activity belongs to (#171 LL-IDENTITY-001). Joining is a
   * community-scoped write, so the authority is the resident's confirmed binding
   * for this community — never a historical assignment row.
   */
  communityId: string
}

export interface ParticipationStateInput {
  activityId: string
  userId: string
  /** Injectable clock so lifecycle boundaries are testable and deterministic. */
  now?: Date
}

export interface ConfirmParticipationInput extends ParticipationStateInput {
  /**
   * Opaque code from the share link. Only the invitation row it resolves to can
   * create attribution; a query-string "inviter" is never trusted as evidence.
   */
  inviteCode?: string
}

export interface ConfirmParticipationResult {
  created: boolean
  state: ActivityParticipationState
}

const SEATS_TOTAL = 3

/**
 * Looks up the activity without throwing, so a route can decide between 404
 * (missing) and 404 (draft) before it calls into the service. The service keeps
 * its own discrimination in `ParticipationError.reason` for callers that skip
 * this helper.
 */
export function findParticipationActivity(
  db: AppDatabase,
  activityId: string,
): ParticipationActivitySnapshot | undefined {
  return db
    .select({
      id: activities.id,
      status: activities.status,
      endsAt: activities.endsAt,
      communityId: activities.communityId,
    })
    .from(activities)
    .where(eq(activities.id, activityId))
    .get()
}

function loadParticipationActivity(
  executor: ParticipationExecutor,
  activityId: string,
): ParticipationActivitySnapshot | undefined {
  return executor
    .select({
      id: activities.id,
      status: activities.status,
      endsAt: activities.endsAt,
      communityId: activities.communityId,
    })
    .from(activities)
    .where(eq(activities.id, activityId))
    .get()
}

/** A draft is not public yet: the route must answer 404, not "not joinable". */
function activityDraftError(): ParticipationError {
  return new ParticipationError(
    404,
    API_ERROR_CODES.notFound,
    'activity_draft',
    '活动不存在或尚未发布',
  )
}

function activityNotFoundError(): ParticipationError {
  return new ParticipationError(404, API_ERROR_CODES.notFound, 'activity_not_found', '活动不存在')
}

function requireActivity(
  executor: ParticipationExecutor,
  activityId: string,
): ParticipationActivitySnapshot {
  const activity = loadParticipationActivity(executor, activityId)
  if (!activity) throw activityNotFoundError()
  if (activity.status === 'draft') throw activityDraftError()
  return activity
}

/**
 * Reasons a resident cannot confirm a new participation. Publishing is the gate:
 * a paused/ended activity, or a published one whose `ends_at` has passed, is
 * unavailable. Pre-registration between publish and `starts_at` is allowed.
 */
function lifecycleBlock(
  activity: ParticipationActivitySnapshot,
  now: Date,
): ParticipationUnavailableReason | null {
  if (activity.status === 'paused') return 'activity_not_published'
  if (activity.status === 'ended') return 'activity_ended'
  if (activity.status === 'published') {
    return now.getTime() <= activity.endsAt.getTime() ? null : 'activity_ended'
  }
  // Drafts never reach here (requireActivity throws first); fail closed if they do.
  return 'activity_not_published'
}

function activityUnavailableError(reason: ParticipationUnavailableReason): ParticipationError {
  return new ParticipationError(
    409,
    API_ERROR_CODES.activityUnavailable,
    'activity_unavailable',
    reason === 'activity_ended' ? '活动已结束，无法参与' : '活动当前不可参与',
  )
}

function publicStatus(status: ActivityStatus): 'published' | 'paused' | 'ended' {
  if (status === 'draft') throw activityDraftError()
  return status
}

interface ParticipationRow {
  id: string
  teamId: string
  seatNo: number
  role: ParticipationRole
  inviteSource: ParticipationInviteSource
  invitationId: string | null
  joinedAt: Date
  teamStatus: ParticipationTeamStatus
  inviteCode: string | null
}

function findParticipation(
  executor: ParticipationExecutor,
  activityId: string,
  userId: string,
): ParticipationRow | undefined {
  return executor
    .select({
      id: activityParticipations.id,
      teamId: activityParticipations.teamId,
      seatNo: activityParticipations.seatNo,
      role: activityParticipations.role,
      inviteSource: activityParticipations.inviteSource,
      invitationId: activityParticipations.invitationId,
      joinedAt: activityParticipations.joinedAt,
      teamStatus: activityTeams.status,
      inviteCode: activityInvitations.code,
    })
    .from(activityParticipations)
    .innerJoin(activityTeams, eq(activityParticipations.teamId, activityTeams.id))
    .leftJoin(activityInvitations, eq(activityInvitations.teamId, activityTeams.id))
    .where(
      and(
        eq(activityParticipations.activityId, activityId),
        eq(activityParticipations.userId, userId),
      ),
    )
    .get()
}

/** Residents have a nullable display name; the roster still needs a stable label. */
function rosterDisplayName(displayName: string | null): string {
  const trimmed = displayName?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : '居民用户'
}

interface TeamMemberRow {
  userId: string
  displayName: string | null
  seatNo: number
  role: ParticipationRole
  joinedAt: Date
}

function teamMembers(
  executor: ParticipationExecutor,
  teamId: string,
): TeamMemberRow[] {
  return executor
    .select({
      userId: activityParticipations.userId,
      displayName: users.displayName,
      seatNo: activityParticipations.seatNo,
      role: activityParticipations.role,
      joinedAt: activityParticipations.joinedAt,
    })
    .from(activityParticipations)
    .leftJoin(users, eq(activityParticipations.userId, users.id))
    .where(eq(activityParticipations.teamId, teamId))
    .orderBy(asc(activityParticipations.seatNo))
    .all()
}

function inviterDisplayName(
  executor: ParticipationExecutor,
  invitationId: string | null,
): string | null {
  if (invitationId === null) return null
  const row = executor
    .select({ displayName: users.displayName })
    .from(activityInvitations)
    .innerJoin(users, eq(activityInvitations.inviterUserId, users.id))
    .where(eq(activityInvitations.id, invitationId))
    .get()
  if (!row) return null
  const trimmed = row.displayName?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

function buildState(
  executor: ParticipationExecutor,
  activity: ParticipationActivitySnapshot,
  userId: string,
  now: Date,
): ActivityParticipationState {
  const row = findParticipation(executor, activity.id, userId)
  const reason = lifecycleBlock(activity, now)
  const members = row ? teamMembers(executor, row.teamId) : []
  const parsed = activityParticipationStateSchema.parse({
    activityId: activity.id,
    activityStatus: publicStatus(activity.status),
    joinable: reason === null && row === undefined,
    unavailableReason: reason,
    participation:
      row === undefined
        ? null
        : {
            id: row.id,
            teamId: row.teamId,
            seatNo: row.seatNo,
            role: row.role,
            inviteSource: row.inviteSource,
            invitationId: row.invitationId,
            inviterDisplayName: inviterDisplayName(executor, row.invitationId),
            joinedAt: row.joinedAt.toISOString(),
          },
    team:
      row === undefined
        ? null
        : {
            id: row.teamId,
            status: row.teamStatus,
            seatsTotal: SEATS_TOTAL,
            seatsFilled: members.length,
            // A locked (3/3) team must never expose a code, or a fourth resident
            // could be invited into a full team.
            inviteCode: row.teamStatus === 'locked' ? null : row.inviteCode,
            members: members.map((member) => ({
              seatNo: member.seatNo,
              displayName: rosterDisplayName(member.displayName),
              role: member.role,
              isSelf: member.userId === userId,
              joinedAt: member.joinedAt.toISOString(),
            })),
          },
  })
  return parsed
}

function insertAudit(
  tx: ParticipationTransaction,
  actorUserId: string,
  event: string,
  activityId: string,
  createdAt: Date,
  metadata: Record<string, string>,
): void {
  tx.insert(auditLogs)
    .values({
      id: randomUUID(),
      actorUserId,
      event,
      targetId: activityId,
      // Never store invite codes, session tokens, OpenID or any other credential.
      metadata: JSON.stringify(metadata),
      createdAt,
    })
    .run()
}

function insertTeam(
  tx: ParticipationTransaction,
  input: {
    id: string
    activityId: string
    leaderUserId: string
    createdAt: Date
  },
): void {
  tx.insert(activityTeams)
    .values({
      id: input.id,
      activityId: input.activityId,
      leaderUserId: input.leaderUserId,
      status: 'open',
      createdAt: input.createdAt,
      lockedAt: null,
    })
    .run()
}

function insertInvitation(
  tx: ParticipationTransaction,
  input: {
    activityId: string
    teamId: string
    inviterUserId: string
    createdAt: Date
  },
): string {
  // 16 random bytes render as exactly the 32 lowercase hex characters the shared
  // contract accepts, so a client can round-trip the code unchanged.
  const code = randomBytes(16).toString('hex')
  tx.insert(activityInvitations)
    .values({
      id: randomUUID(),
      code,
      activityId: input.activityId,
      teamId: input.teamId,
      inviterUserId: input.inviterUserId,
      createdAt: input.createdAt,
    })
    .run()
  return code
}

function insertParticipation(
  tx: ParticipationTransaction,
  input: {
    activityId: string
    teamId: string
    userId: string
    seatNo: number
    role: ParticipationRole
    inviteSource: ParticipationInviteSource
    invitationId: string | null
    joinedAt: Date
  },
): string {
  const id = randomUUID()
  tx.insert(activityParticipations)
    .values({ id, ...input })
    .run()
  return id
}

function mapConstraintError(error: unknown): never {
  if (error instanceof ParticipationError) throw error
  if (error instanceof Error && /UNIQUE constraint failed|constraint failed/iu.test(error.message)) {
    throw new ParticipationError(
      409,
      API_ERROR_CODES.conflict,
      'concurrent_conflict',
      '并发参与冲突，请刷新后重试',
    )
  }
  throw error
}

/** A flat read of the resident's participation state for one activity. */
export function getParticipationState(
  db: AppDatabase,
  input: ParticipationStateInput,
): ActivityParticipationState {
  const now = input.now ?? new Date()
  const activity = requireActivity(db, input.activityId)
  return buildState(db, activity, input.userId, now)
}

/**
 * Confirms the resident's participation, atomically.
 *
 * The whole decision (re-read activity, check existing participation, pick the
 * next seat, insert, lock a full team, write audit) runs inside ONE
 * `behavior: 'immediate'` transaction. `BEGIN IMMEDIATE` takes SQLite's write
 * lock before the first read, so two processes cannot both observe "seat 3 is
 * free" and insert: the loser re-reads after the winner commits, sees a locked
 * team, and gets `team_full`. There is no check-then-insert race window, and the
 * UNIQUE indexes / triggers are the last line of defence.
 *
 * Ordering of decisions:
 * 1. missing activity -> 404 `activity_not_found`; draft -> 404 `activity_draft`
 *    (both are invisible to residents, but the reasons stay distinguishable);
 * 2. paused/ended/past-`ends_at` -> `activity_unavailable`, before any write;
 * 3. already participating -> idempotent `created: false`, same team/seat;
 * 4. with an invite code -> join that same-activity open team's next seat and
 *    freeze `invitation_id` + `invite_source = 'invite'`;
 * 5. without a code -> create a team, seat 1 as leader, `invite_source = 'self'`.
 */
export function confirmParticipation(
  db: AppDatabase,
  input: ConfirmParticipationInput,
): ConfirmParticipationResult {
  const now = input.now ?? new Date()
  try {
    return db.transaction(
      (tx) => {
        const activity = requireActivity(tx, input.activityId)
        const blocked = lifecycleBlock(activity, now)
        if (blocked !== null) throw activityUnavailableError(blocked)

        const existing = findParticipation(tx, activity.id, input.userId)
        if (existing) {
          return { created: false, state: buildState(tx, activity, input.userId, now) }
        }

        // #171 LL-IDENTITY-001: joining an activity is a community-scoped write.
        // The retired #123 flow gave every logged-in resident a historical
        // assignment row, which looked like permission; now only the resident's
        // own confirmed binding authorizes a join. An existing participation is
        // returned above unchanged, so history stays readable and re-reads are
        // never blocked by a missing binding.
        assertResidentOfConfirmedCommunity(tx, input.userId, activity.communityId)

        if (input.inviteCode !== undefined) {
          joinTeamByInvite(tx, activity, input.userId, input.inviteCode, now)
        } else {
          startTeam(tx, activity, input.userId, now)
        }

        return { created: true, state: buildState(tx, activity, input.userId, now) }
      },
      { behavior: 'immediate' },
    )
  } catch (error) {
    mapConstraintError(error)
  }
}

function joinTeamByInvite(
  tx: ParticipationTransaction,
  activity: ParticipationActivitySnapshot,
  userId: string,
  inviteCode: string,
  now: Date,
): void {
  const invitation = tx
    .select({
      id: activityInvitations.id,
      activityId: activityInvitations.activityId,
      teamId: activityInvitations.teamId,
    })
    .from(activityInvitations)
    .where(eq(activityInvitations.code, inviteCode))
    .get()

  // Unknown codes and codes minted for another activity are deliberately
  // indistinguishable: a resident must not learn whether a code exists elsewhere.
  if (!invitation || invitation.activityId !== activity.id) {
    throw new ParticipationError(
      400,
      API_ERROR_CODES.inviteInvalid,
      'invite_invalid',
      '邀请码无效或不属于本活动',
    )
  }

  const team = tx
    .select({
      id: activityTeams.id,
      activityId: activityTeams.activityId,
      status: activityTeams.status,
    })
    .from(activityTeams)
    .where(eq(activityTeams.id, invitation.teamId))
    .get()
  if (!team || team.activityId !== activity.id) {
    throw new ParticipationError(
      400,
      API_ERROR_CODES.inviteInvalid,
      'invite_invalid',
      '邀请码无效或不属于本活动',
    )
  }

  const seats = tx
    .select({ seatNo: activityParticipations.seatNo })
    .from(activityParticipations)
    .where(eq(activityParticipations.teamId, team.id))
    .all()
  if (team.status !== 'open' || seats.length >= SEATS_TOTAL) {
    throw new ParticipationError(409, API_ERROR_CODES.teamFull, 'team_full', '该三人团已满 3 人')
  }

  const usedSeats = new Set(seats.map((seat) => seat.seatNo))
  const seatNo = [1, 2, 3].find((candidate) => !usedSeats.has(candidate))
  if (seatNo === undefined || seatNo === 1) {
    // Seat 1 belongs to the leader; reaching this branch means the roster is
    // already inconsistent, so fail closed instead of writing a bad row.
    throw new ParticipationError(409, API_ERROR_CODES.teamFull, 'team_full', '该三人团已满 3 人')
  }

  insertParticipation(tx, {
    activityId: activity.id,
    teamId: team.id,
    userId,
    seatNo,
    role: 'member',
    inviteSource: 'invite',
    invitationId: invitation.id,
    joinedAt: now,
  })
  insertAudit(tx, userId, 'participation.created', activity.id, now, {
    teamId: team.id,
    seatNo: String(seatNo),
    role: 'member',
    inviteSource: 'invite',
  })

  if (seats.length + 1 === SEATS_TOTAL) {
    lockTeam(tx, { activityId: activity.id, teamId: team.id, actorUserId: userId, now })
  }
}

function lockTeam(
  tx: ParticipationTransaction,
  input: { activityId: string; teamId: string; actorUserId: string; now: Date },
): void {
  // One-way transition: the WHERE clause makes a concurrent second lock update
  // touch zero rows instead of silently rewriting `locked_at`.
  const result = tx
    .update(activityTeams)
    .set({ status: 'locked', lockedAt: input.now })
    .where(and(eq(activityTeams.id, input.teamId), eq(activityTeams.status, 'open')))
    .run()
  if (result.changes !== 1) {
    throw new ParticipationError(
      409,
      API_ERROR_CODES.conflict,
      'concurrent_conflict',
      '并发参与冲突，请刷新后重试',
    )
  }
  // The resident who took seat 3 caused the lock; audit records that actor.
  insertAudit(tx, input.actorUserId, 'team.locked', input.activityId, input.now, {
    teamId: input.teamId,
    seatsFilled: String(SEATS_TOTAL),
  })
}

function startTeam(
  tx: ParticipationTransaction,
  activity: ParticipationActivitySnapshot,
  userId: string,
  now: Date,
): void {
  // The leader already leading a team (but without a participation row) cannot
  // happen through this service; UNIQUE(activity_id, leader_user_id) would reject
  // it rather than silently reuse another resident's team.
  const teamId = randomUUID()
  insertTeam(tx, {
    id: teamId,
    activityId: activity.id,
    leaderUserId: userId,
    createdAt: now,
  })
  insertInvitation(tx, {
    activityId: activity.id,
    teamId,
    inviterUserId: userId,
    createdAt: now,
  })
  insertParticipation(tx, {
    activityId: activity.id,
    teamId,
    userId,
    seatNo: 1,
    role: 'leader',
    inviteSource: 'self',
    invitationId: null,
    joinedAt: now,
  })
  insertAudit(tx, userId, 'participation.created', activity.id, now, {
    teamId,
    seatNo: '1',
    role: 'leader',
    inviteSource: 'self',
  })
}
