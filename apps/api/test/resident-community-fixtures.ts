import assert from 'node:assert/strict'

import { RESIDENT_COMMUNITY_ROUTES } from '@sanchuang-dev/local-life-contracts'

import type { AppDatabase } from '../src/db/client.js'
import { residentCommunityAssignments } from '../src/db/schema.js'
import { confirmResidentCommunity } from '../src/resident-community/service.js'

/**
 * Shared fixtures for the #171 LL-IDENTITY-001 permanent community.
 *
 * The two helpers below are deliberately NOT interchangeable, and the names say
 * which is which:
 *
 * - `seedConfirmedCommunity` runs the production confirmation service, so the
 *   resident really *confirmed* the community: exactly the row
 *   `POST /resident-community/confirm` would create (binding + audit evidence in
 *   one transaction). Use it when a test needs a resident who is allowed to
 *   perform community-scoped writes.
 * - `seedLegacyAssignment` writes a row into the *historical*
 *   `resident_community_assignments` table only. That row means "a relation was
 *   observed" — the retired #123 login wrote such rows automatically — and it
 *   never authorizes anything. Use it only when a test is about historical
 *   facts, `pending_review` or migration preservation.
 *
 * Neither helper bypasses a guard, relaxes a check or writes a test-only flag.
 */

/** A session shaped the way the existing HTTP suites already hold one. */
export interface SessionLike {
  cookies: string
  csrfToken: string
}

/**
 * The subset of `app` these helpers need; keeps the helper free of app wiring.
 *
 * `request` is typed as `Response | Promise<Response>` on purpose: Hono's own
 * `request()` signature returns that union, so narrowing it to `Promise<Response>`
 * would make a real `App` structurally incompatible with this interface and force
 * every caller to cast.
 */
export interface Requestable {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>
}

/** Default trusted browser origin used by the API test suites. */
export const RESIDENT_ORIGIN = 'http://localhost:5173'

/**
 * Creates the resident's *confirmed* permanent community through the real
 * service. Throws (via the service) if the community does not exist, if the
 * resident already confirmed another one, or if the account carries two or more
 * historical relations — the same refusals a resident would meet over HTTP.
 */
export function seedConfirmedCommunity(
  db: AppDatabase,
  userId: string,
  communityId: string,
  now = new Date(),
): void {
  confirmResidentCommunity(db, { userId, communityId, now })
}

/**
 * Records a *historical* community relation for a resident.
 *
 * HISTORICAL FACT ONLY. This is the row the retired #123 flow wrote at login; it
 * is not a confirmation and does not satisfy `assertResidentOfConfirmedCommunity`.
 * It exists so tests can cover legacy history, `pending_review` and migration
 * preservation without pretending the resident confirmed anything.
 */
export function seedLegacyAssignment(
  db: AppDatabase,
  userId: string,
  communityId: string,
  createdAt = new Date(),
): void {
  db.insert(residentCommunityAssignments).values({ userId, communityId, createdAt }).run()
}

/** Convenience: seed several historical relations at once (multi-legacy accounts). */
export function seedLegacyAssignments(
  db: AppDatabase,
  userId: string,
  communityIds: readonly string[],
  createdAt = new Date(),
): void {
  for (const communityId of communityIds) {
    seedLegacyAssignment(db, userId, communityId, createdAt)
  }
}

/** Row counts for the three identity tables, for assertions that read the disk. */
export function residentCommunityCounts(
  sqlite: { prepare: (sql: string) => { get: () => unknown } },
  userId?: string,
): { assignments: number; bindings: number; candidates: number } {
  const count = (table: string): number => {
    const sql = userId
      ? `SELECT COUNT(*) AS value FROM ${table} WHERE user_id = ?`
      : `SELECT COUNT(*) AS value FROM ${table}`
    const statement = sqlite.prepare(sql)
    const row = (userId ? (statement as unknown as { get: (v: string) => unknown }).get(userId) : statement.get()) as
      | { value: number }
      | undefined
    return row?.value ?? 0
  }
  return {
    assignments: count('resident_community_assignments'),
    bindings: count('resident_community_bindings'),
    candidates: count('resident_community_binding_candidates'),
  }
}

/**
 * Performs the resident's real first confirmation over the app's HTTP surface:
 * real session cookie, real CSRF double-submit token, real trusted Origin.
 *
 * Returns the raw response so a caller can assert the status itself. `origin` is
 * a parameter because the suites use different trusted origins (H5 vs admin).
 */
export function confirmCommunityOverHttp(
  app: Requestable,
  session: SessionLike,
  communityId: string,
  origin: string = RESIDENT_ORIGIN,
  overrides: { csrfToken?: string | null; origin?: string | null } = {},
): Promise<Response> {
  const csrfToken =
    overrides.csrfToken === null ? undefined : (overrides.csrfToken ?? session.csrfToken)
  const requestOrigin = overrides.origin === undefined ? origin : overrides.origin
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    cookie: session.cookies,
    ...(csrfToken === undefined ? {} : { 'x-csrf-token': csrfToken }),
    ...(requestOrigin === null ? {} : { origin: requestOrigin }),
  }
  return Promise.resolve(
    app.request(RESIDENT_COMMUNITY_ROUTES.confirm, {
      method: 'POST',
      headers,
      body: JSON.stringify({ communityId }),
    }),
  )
}

/**
 * Confirms a community and asserts it succeeded. Helper for fixtures whose
 * intent is "this resident is an established resident of this community", not
 * "the confirmation endpoint works" (that is asserted in
 * `resident-community-http.test.ts` and `resident-community-guard.test.ts`).
 */
export async function confirmCommunityOrFail(
  app: Requestable,
  session: SessionLike,
  communityId: string,
  origin: string = RESIDENT_ORIGIN,
): Promise<void> {
  const response = await confirmCommunityOverHttp(app, session, communityId, origin)
  const raw = await response.clone().text()
  assert.equal(response.status, 200, `resident confirmation must succeed: ${raw}`)
}
