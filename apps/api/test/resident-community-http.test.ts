import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as nodeRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { serve } from '@hono/node-server'
import { eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  RESIDENT_COMMUNITY_ROUTES,
  confirmResidentCommunityResponseSchema,
  residentCommunityStatusResponseSchema,
  type ResidentCommunityStatusResponse,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  communities,
  residentCommunityAssignments,
  residentCommunityBindingCandidates,
  residentCommunityBindings,
  users,
} from '../src/db/schema.js'
import { masterKeyEnv } from './wechat-fixtures.js'

/**
 * Real HTTP acceptance for #171 LL-IDENTITY-001.
 *
 * Every request below crosses a real TCP socket into the real Hono app backed by a
 * real migrated SQLite file, with real session cookies, the real CSRF
 * double-submit check and the real trusted-Origin check. Nothing is stubbed, so
 * the assertions are about observable behaviour rather than about how the route
 * happens to be wired.
 *
 * What must hold, and is therefore asserted:
 *  - an unbound resident can read `unbound` and confirm exactly once;
 *  - repeating the same community is idempotent (200, same `confirmedAt`);
 *  - a different community is an explicit 409 and the binding is unchanged;
 *  - two confirmations racing over two sockets produce exactly one binding;
 *  - an unknown community is 404; multi-legacy accounts are 409 pending_review;
 *  - login alone never creates a binding (the retired #123 behaviour is gone);
 *  - CSRF, Origin and session are all required for the write.
 */

const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url))
const WEB_ORIGIN = 'http://localhost:5173'
const NOW = new Date('2026-11-11T04:00:00.000Z')

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const communityA = uuid(9001)
const communityB = uuid(9002)

type App = ReturnType<typeof createApp>

interface Reply {
  status: number
  raw: string
  body: Record<string, unknown>
  headers: IncomingHttpHeaders
}

interface Fixture {
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
  base: string
  send: (
    method: string,
    path: string,
    options?: {
      body?: unknown
      cookies?: string[]
      csrfToken?: string
      origin?: string | null
      contentType?: string
    },
  ) => Promise<Reply>
  /** Real dev login; returns the cookies plus the CSRF token it issued. */
  login: (displayName: string) => Promise<{ cookies: string[]; csrfToken: string; userId: string }>
  close: () => Promise<void>
}

function setCookies(headers: IncomingHttpHeaders): string[] {
  const raw = headers['set-cookie']
  if (!raw) return []
  return raw.map((value) => value.split(';', 1)[0]!.trim()).filter(Boolean)
}

async function fixture(): Promise<Fixture> {
  const { db, sqlite } = createDatabase(':memory:', migrations)
  db.insert(communities)
    .values([
      { id: communityA, name: '阳光社区', address: '阳光路 1 号', createdAt: NOW },
      { id: communityB, name: '和平社区', address: null, createdAt: NOW },
    ])
    .run()
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
    WEB_BASE_URL: WEB_ORIGIN,
    TRUSTED_ORIGINS: WEB_ORIGIN,
    ...masterKeyEnv(),
  })
  const app: App = createApp({ db, config, logRequests: false })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port

  const send: Fixture['send'] = (method, path, options = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const headers: Record<string, string> = {}
      if (options.cookies?.length) headers.cookie = options.cookies.join('; ')
      if (options.csrfToken) headers['x-csrf-token'] = options.csrfToken
      if (options.origin !== null) headers.origin = options.origin ?? WEB_ORIGIN
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
      if (payload !== undefined) headers['content-type'] = options.contentType ?? 'application/json'
      const request = nodeRequest(new URL(path, base), { method, headers }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: response.statusCode ?? 0,
            raw,
            headers: response.headers,
            body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
          })
        })
      })
      request.on('error', reject)
      if (payload !== undefined) request.write(payload)
      request.end()
    })

  const login: Fixture['login'] = async (displayName) => {
    const csrf = await send('GET', '/auth/csrf')
    assert.equal(csrf.status, 200)
    const csrfCookies = setCookies(csrf.headers)
    const response = await send('POST', '/auth/dev/login', {
      body: { displayName },
      cookies: csrfCookies,
      csrfToken: (csrf.body as { csrfToken: string }).csrfToken,
    })
    assert.equal(response.status, 200, response.raw)
    const body = response.body as { user: { id: string }; csrfToken: string }
    return {
      cookies: setCookies(response.headers),
      csrfToken: body.csrfToken,
      userId: body.user.id,
    }
  }

  const close = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    sqlite.close()
  }

  return { db, sqlite, base, send, login, close }
}

function status(reply: Reply): ResidentCommunityStatusResponse {
  assert.equal(reply.status, 200, reply.raw)
  return residentCommunityStatusResponseSchema.parse(reply.body)
}

function errorCode(reply: Reply): string {
  return (reply.body.error as { code: string; message: string }).code
}

function errorMessage(reply: Reply): string {
  return (reply.body.error as { code: string; message: string }).message
}

function getStatus(f: Fixture, session: { cookies: string[] }) {
  return f.send('GET', RESIDENT_COMMUNITY_ROUTES.status, { cookies: session.cookies })
}

function confirm(
  f: Fixture,
  session: { cookies: string[]; csrfToken: string },
  body: unknown,
  overrides: { csrfToken?: string | null; origin?: string | null; cookies?: string[] } = {},
) {
  const csrfToken = overrides.csrfToken === null ? undefined : (overrides.csrfToken ?? session.csrfToken)
  return f.send('POST', RESIDENT_COMMUNITY_ROUTES.confirm, {
    body,
    cookies: overrides.cookies ?? session.cookies,
    ...(csrfToken === undefined ? {} : { csrfToken }),
    ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
  })
}

function countRows(sqlite: Fixture['sqlite'], table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }).value
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

test('GET status requires a session and reports 未绑定 for a fresh account', async () => {
  const f = await fixture()
  try {
    const anonymous = await f.send('GET', RESIDENT_COMMUNITY_ROUTES.status)
    assert.equal(anonymous.status, 401)
    assert.equal(errorCode(anonymous), API_ERROR_CODES.unauthorized)

    const session = await f.login('新居民')
    const body = status(await getStatus(f, session))
    assert.equal(body.status, 'unbound')
    assert.equal(body.binding, null)
    assert.equal(body.candidate, null)
    assert.equal(body.canConfirm, true)
    assert.equal(body.confirmBlockedReason, null)
    assert.deepEqual(body.legacyHistory, { assignmentCount: 0, pendingReview: false, assignments: [] })
    // Reading never writes.
    assert.equal(countRows(f.sqlite, 'resident_community_bindings'), 0)
    assert.equal(countRows(f.sqlite, 'resident_community_binding_candidates'), 0)
  } finally {
    await f.close()
  }
})

test('login alone never binds, even when the resident opened an activity community', async () => {
  const f = await fixture()
  try {
    const session = await f.login('浏览型居民')
    assert.equal(countRows(f.sqlite, 'resident_community_bindings'), 0)
    assert.equal(countRows(f.sqlite, 'resident_community_assignments'), 0)
    // Browsing another community (query parameter) must not bind either.
    const browsed = await f.send('GET', `${RESIDENT_COMMUNITY_ROUTES.status}?communityId=${communityB}`, {
      cookies: session.cookies,
    })
    const body = status(browsed)
    assert.equal(body.status, 'unbound')
    assert.equal(body.binding, null)
    assert.equal(countRows(f.sqlite, 'resident_community_bindings'), 0)
  } finally {
    await f.close()
  }
})

test('a single historical relation is surfaced as a confirmable candidate', async () => {
  const f = await fixture()
  try {
    const session = await f.login('历史居民')
    f.db
      .insert(residentCommunityAssignments)
      .values({ userId: session.userId, communityId: communityA, createdAt: NOW })
      .run()
    const body = status(await getStatus(f, session))
    assert.equal(body.status, 'unbound')
    assert.equal(body.canConfirm, true)
    assert.equal(body.candidate?.community.name, '阳光社区')
    assert.equal(body.candidate?.source, 'legacy_single_assignment_candidate')
    assert.equal(body.legacyHistory.assignmentCount, 1)
    assert.equal(body.legacyHistory.pendingReview, false)
  } finally {
    await f.close()
  }
})

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

test('POST confirm requires session, CSRF and a trusted Origin', async () => {
  const f = await fixture()
  try {
    // No session.
    const anonymous = await confirm(f, { cookies: [], csrfToken: 'x' }, { communityId: communityA }, { cookies: [] })
    assert.equal(anonymous.status, 401)

    const session = await f.login('守卫居民')
    // Wrong/missing CSRF.
    const noCsrf = await confirm(f, session, { communityId: communityA }, { csrfToken: null })
    assert.equal(noCsrf.status, 403)
    assert.equal(errorCode(noCsrf), API_ERROR_CODES.forbidden)
    // Foreign Origin.
    const badOrigin = await confirm(f, session, { communityId: communityA }, { origin: 'https://evil.example' })
    assert.equal(badOrigin.status, 403)
    // Malformed body.
    for (const body of [{}, { communityId: 'not-a-uuid' }, { communityId: communityA, source: 'resident_h5_confirmed' }, { communityId: communityA, userId: uuid(1) }]) {
      const invalid = await confirm(f, session, body)
      assert.equal(invalid.status, 400, JSON.stringify(body))
      assert.equal(errorCode(invalid), API_ERROR_CODES.invalidRequest)
    }
    assert.equal(countRows(f.sqlite, 'resident_community_bindings'), 0)
    assert.equal(countRows(f.sqlite, 'audit_logs'), 0)
  } finally {
    await f.close()
  }
})

test('first confirmation succeeds once and is idempotent on replay', async () => {
  const f = await fixture()
  try {
    const session = await f.login('确认居民')
    const first = await confirm(f, session, { communityId: communityA })
    assert.equal(first.status, 200, first.raw)
    const created = confirmResidentCommunityResponseSchema.parse(first.body)
    assert.equal(created.status, 'confirmed')
    assert.equal(created.idempotent, false)
    assert.equal(created.binding.community.name, '阳光社区')
    assert.equal(created.binding.community.serviceAddress, '阳光路 1 号')
    assert.equal(created.binding.source, 'resident_h5_confirmed')

    const body = status(await getStatus(f, session))
    assert.equal(body.status, 'confirmed')
    assert.equal(body.binding?.community.id, communityA)
    assert.equal(body.canConfirm, false)
    assert.equal(body.confirmBlockedReason, 'already_confirmed')

    const second = await confirm(f, session, { communityId: communityA })
    assert.equal(second.status, 200, second.raw)
    const replay = confirmResidentCommunityResponseSchema.parse(second.body)
    assert.equal(replay.idempotent, true)
    // The confirmation instant is not re-dated by a replay.
    assert.equal(replay.binding.confirmedAt, created.binding.confirmedAt)
    assert.equal(countRows(f.sqlite, 'resident_community_bindings'), 1)
    // The audit row records the confirmation, without any credential.
    const audit = f.sqlite
      .prepare('SELECT event, metadata FROM audit_logs WHERE event = ?')
      .all('resident_community.bound') as Array<{ event: string; metadata: string }>
    assert.equal(audit.length, 1)
    assert.deepEqual(JSON.parse(audit[0]!.metadata), {
      source: 'resident_h5_confirmed',
      communityId: communityA,
    })
  } finally {
    await f.close()
  }
})

test('confirming another community is an explicit 409 and keeps the original binding', async () => {
  const f = await fixture()
  try {
    const session = await f.login('冲突居民')
    assert.equal((await confirm(f, session, { communityId: communityA })).status, 200)

    const conflict = await confirm(f, session, { communityId: communityB })
    assert.equal(conflict.status, 409, conflict.raw)
    assert.equal(errorCode(conflict), API_ERROR_CODES.residentCommunityConflict)
    // The message names the confirmed community so the H5 can show it directly.
    assert.match(errorMessage(conflict), /阳光社区/)

    const body = status(await getStatus(f, session))
    assert.equal(body.status, 'confirmed')
    assert.equal(body.binding?.community.id, communityA)
    assert.equal(countRows(f.sqlite, 'resident_community_bindings'), 1)
  } finally {
    await f.close()
  }
})

test('two confirmations racing over separate sockets produce exactly one binding', async () => {
  const f = await fixture()
  try {
    const session = await f.login('并发居民')
    const [one, two] = await Promise.all([
      confirm(f, session, { communityId: communityA }),
      confirm(f, session, { communityId: communityB }),
    ])
    const statuses = [one.status, two.status].sort()
    // Exactly one winner, or both the same community (both 200) — never 200+200
    // with two different bindings, and never a 500.
    assert.ok(
      (statuses[0] === 200 && statuses[1] === 409) || (statuses[0] === 200 && statuses[1] === 200),
      JSON.stringify([one.raw, two.raw]),
    )
    assert.equal(countRows(f.sqlite, 'resident_community_bindings'), 1)
    const bound = status(await getStatus(f, session))
    assert.equal(bound.status, 'confirmed')
    assert.ok([communityA, communityB].includes(bound.binding!.community.id))
  } finally {
    await f.close()
  }
})

test('unknown community is 404 and pending_review accounts are refused', async () => {
  const f = await fixture()
  try {
    const unknown = await f.login('未知社区居民')
    const notFound = await confirm(f, unknown, { communityId: uuid(7777) })
    assert.equal(notFound.status, 404, notFound.raw)
    assert.equal(errorCode(notFound), API_ERROR_CODES.residentCommunityNotFound)
    assert.equal(countRows(f.sqlite, 'resident_community_bindings'), 0)

    const multi = await f.login('双归属居民')
    f.db
      .insert(residentCommunityAssignments)
      .values([
        { userId: multi.userId, communityId: communityA, createdAt: NOW },
        { userId: multi.userId, communityId: communityB, createdAt: new Date(NOW.getTime() + 1000) },
      ])
      .run()
    const pending = status(await getStatus(f, multi))
    assert.equal(pending.status, 'pending_review')
    assert.equal(pending.canConfirm, false)
    assert.equal(pending.confirmBlockedReason, 'pending_review')
    assert.equal(pending.candidate, null, 'never pick the earliest/latest relation')

    const refused = await confirm(f, multi, { communityId: communityA })
    assert.equal(refused.status, 409, refused.raw)
    assert.equal(errorCode(refused), API_ERROR_CODES.residentCommunityPendingReview)
    assert.equal(countRows(f.sqlite, 'resident_community_bindings'), 0)
  } finally {
    await f.close()
  }
})

test('an expired server candidate is ignored by the status read', async () => {
  const f = await fixture()
  try {
    const session = await f.login('过期候选居民')
    f.db
      .insert(residentCommunityBindingCandidates)
      .values({
        userId: session.userId,
        communityId: communityB,
        source: 'activity_oauth_candidate',
        suggestedAt: new Date(NOW.getTime() - 1000),
        expiresAt: new Date(NOW.getTime() - 500),
        createdAt: new Date(NOW.getTime() - 1000),
      })
      .run()
    const body = status(await getStatus(f, session))
    assert.equal(body.status, 'unbound')
    assert.equal(body.candidate, null)
    assert.equal(body.canConfirm, true)
  } finally {
    await f.close()
  }
})

test('a resident cannot bind, rebind or unbind through any other route', async () => {
  const f = await fixture()
  try {
    const session = await f.login('越权居民')
    assert.equal((await confirm(f, session, { communityId: communityA })).status, 200)
    for (const [method, path] of [
      ['PUT', RESIDENT_COMMUNITY_ROUTES.confirm],
      ['DELETE', RESIDENT_COMMUNITY_ROUTES.confirm],
      ['PATCH', RESIDENT_COMMUNITY_ROUTES.status],
      ['POST', RESIDENT_COMMUNITY_ROUTES.status],
      ['DELETE', RESIDENT_COMMUNITY_ROUTES.status],
    ] as const) {
      const reply = await f.send(method, path, { cookies: session.cookies, csrfToken: session.csrfToken })
      assert.ok(reply.status === 404 || reply.status === 405, `${method} ${path} -> ${reply.status}`)
    }
    // The binding survives the attempted mutations, and the legacy table is clean.
    const bound = f.db.select().from(residentCommunityBindings).all()
    assert.equal(bound.length, 1)
    assert.equal(bound[0]!.communityId, communityA)
    assert.equal(countRows(f.sqlite, 'resident_community_assignments'), 0)
    assert.equal(
      f.db.select().from(users).where(eq(users.id, session.userId)).all().length,
      1,
      'the resident row itself is untouched',
    )
  } finally {
    await f.close()
  }
})

test('confirming does not write orders, rewards or CRM rows', async () => {
  const f = await fixture()
  try {
    const session = await f.login('零副作用居民')
    const before = new Map(
      ['local_orders', 'local_order_events', 'activity_reward_grants', 'crmeb_orders', 'crm_service_orders', 'ledger_entries']
        .map((table) => [table, countRows(f.sqlite, table)] as const),
    )
    assert.equal((await confirm(f, session, { communityId: communityA })).status, 200)
    for (const [table, count] of before) {
      assert.equal(countRows(f.sqlite, table), count, `${table} must not change`)
    }
    // Also no phantom legacy assignment was created as a side effect.
    assert.equal(countRows(f.sqlite, 'resident_community_assignments'), 0)
  } finally {
    await f.close()
  }
})
