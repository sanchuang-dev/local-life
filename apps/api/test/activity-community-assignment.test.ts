import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { and, desc, eq } from 'drizzle-orm'
import test from 'node:test'
import type { ActivityStatus } from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { hashPassword } from '../src/auth/security.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activities,
  activityCheckins,
  activityInvitations,
  activityParticipations,
  activityRewardGrants,
  activityTeams,
  communities,
  crmebOrders,
  crmServiceOrders,
  localOrders,
  oauthStates,
  residentCommunityAssignments,
  staffAccounts,
  users,
  wechatIdentities,
} from '../src/db/schema.js'
import { masterKeyEnv, seedWechatConfig, TEST_APP_ID } from './wechat-fixtures.js'

/**
 * Independent acceptance for #123 — activity-driven community attribution.
 *
 * Every step below is the real Hono app over real HTTP (`app.request`), the real
 * migrated SQLite schema, real cookies and the real OAuth state machine. Only the
 * remote WeChat token endpoint is faked, and only at the `fetch` boundary; real
 * WeChat authorization is NOT exercised here (no credentials available).
 *
 * What this file is allowed to claim, and therefore asserts explicitly:
 *  - the community is derived from the stored activity row, never from the query;
 *  - the public-visibility rule is the same one the public activity read applies;
 *  - a client-supplied `communityId` is refused even when that community exists;
 *  - logging in writes an assignment and nothing else — no participation, team,
 *    invitation, order, check-in or reward row;
 *  - duplicate logins are idempotent thanks to the `(user_id, community_id)` PK;
 *  - the admin `GET /crm/residents` list reads the new resident back.
 */

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const WEB_ORIGIN = 'https://local-life.example.test'
const ADMIN_PASSWORD = 'Admin-Password-123!'
const INVITE_CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const NOW = new Date('2026-01-01T00:00:00.000Z')

const PUBLIC_RULES_JSON = JSON.stringify({
  eligibility: '本社区 60 岁以上居民',
  checkin: '到社区服务中心签到并领取参与卡',
  purchase: '现场购买指定套餐一份',
  prizeClaim: '凭核销码领取，每人限一次',
})

type App = ReturnType<typeof createApp>

interface Harness {
  app: App
  db: AppDatabase
  sqlite: ReturnType<typeof createDatabase>['sqlite']
}

function cookiePairs(response: Response): string[] {
  const value = response.headers.get('set-cookie') ?? ''
  return value
    .split(/,(?=[^;,]+=)/)
    .map((part) => part.split(';', 1)[0]?.trim() ?? '')
    .filter(Boolean)
}

function cookiePair(response: Response, name: string): string {
  const pair = cookiePairs(response).find((value) => value.startsWith(`${name}=`))
  assert.ok(pair, `expected a ${name} cookie in ${response.headers.get('set-cookie') ?? '<none>'}`)
  return pair
}

function countingProvider(openid = 'wechat-openid-123') {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ openid, unionid: 'wechat-union-123' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetcher, calls }
}

function harness(): Harness {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({
    NODE_ENV: 'test',
    WEB_BASE_URL: WEB_ORIGIN,
    TRUSTED_ORIGINS: new URL(WEB_ORIGIN).origin,
    ...masterKeyEnv(),
  })
  seedWechatConfig(db, { appId: TEST_APP_ID })
  const app = createApp({ db, config, logRequests: false, fetcher: countingProvider().fetcher })
  return { app, db, sqlite }
}

/** Real seeded community row, so a forged id can be proven to exist yet be refused. */
function addCommunity(db: AppDatabase, name: string): string {
  const id = randomUUID()
  db.insert(communities).values({ id, name, createdAt: NOW }).run()
  return id
}

function addActivity(
  db: AppDatabase,
  communityId: string,
  createdByUserId: string,
  status: ActivityStatus = 'published',
): string {
  const id = randomUUID()
  db.insert(activities)
    .values({
      id,
      communityId,
      title: '银发社区欢乐季',
      summary: '秋季社区敬老活动',
      description: '面向本社区 60 岁以上居民的线下活动',
      status,
      startsAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      endsAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
      location: '幸福社区党群服务中心',
      budgetCapCents: 100_000,
      prizeQuantityCap: 100,
      publicRulesJson: PUBLIC_RULES_JSON,
      currentRuleVersionId: null,
      createdByUserId,
      createdAt: NOW,
      updatedAt: NOW,
      publishedAt: status === 'draft' ? null : NOW,
      pausedAt: status === 'paused' ? NOW : null,
      endedAt: status === 'ended' ? NOW : null,
    })
    .run()
  return id
}

function addStaffUser(db: AppDatabase): string {
  const id = randomUUID()
  db.insert(users)
    .values({ id, displayName: '验收管理员', createdAt: NOW, updatedAt: NOW })
    .run()
  return id
}

async function addAdmin(db: AppDatabase): Promise<{ username: string; password: string }> {
  const userId = addStaffUser(db)
  const password = ADMIN_PASSWORD
  db.insert(staffAccounts)
    .values({
      id: randomUUID(),
      userId,
      username: 'assign.admin',
      passwordHash: await hashPassword(password),
      role: 'admin',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
  return { username: 'assign.admin', password }
}

function activityReturnTo(activityId: string): string {
  return `/community/activity/silver-neighborhood?activityId=${activityId}&invite=${INVITE_CODE}`
}

/** One full start request; `query` is the raw query string including `?`. */
function start(app: App, query: string) {
  return app.request(`/auth/wechat/start${query}`)
}

/** Complete the attempt the way a browser would: state from the redirect, nonce + return cookie. */
async function finish(app: App, startResponse: Response, code = 'oauth-code') {
  const state = new URL(startResponse.headers.get('location')!).searchParams.get('state')!
  const cookies = [cookiePair(startResponse, 'll_oauth_nonce')]
  const returnCookie = cookiePairs(startResponse).find((value) =>
    value.startsWith('ll_oauth_return='),
  )
  if (returnCookie) cookies.push(returnCookie)
  return app.request(`/auth/wechat/callback?state=${state}&code=${code}`, {
    headers: { cookie: cookies.join('; ') },
  })
}

/** Nothing outside identity may be written by a login. */
function assertNoActivityWrites(db: AppDatabase): void {
  assert.equal(db.select().from(activityParticipations).all().length, 0, 'no participation')
  assert.equal(db.select().from(activityTeams).all().length, 0, 'no team')
  assert.equal(db.select().from(activityInvitations).all().length, 0, 'no invitation')
  assert.equal(db.select().from(activityCheckins).all().length, 0, 'no check-in')
  assert.equal(db.select().from(activityRewardGrants).all().length, 0, 'no reward')
  assert.equal(db.select().from(localOrders).all().length, 0, 'no local order')
  assert.equal(db.select().from(crmServiceOrders).all().length, 0, 'no carrier order')
  assert.equal(db.select().from(crmebOrders).all().length, 0, 'no CRMEB order mirror')
}

function assignmentsOf(db: AppDatabase, userId: string) {
  return db
    .select()
    .from(residentCommunityAssignments)
    .where(eq(residentCommunityAssignments.userId, userId))
    .all()
}

/**
 * The resident created by the OAuth callback, identified through its WeChat
 * identity. `users` is shared with staff accounts, so counting that table would
 * also count the fixtures — the identity row is the honest "one resident" proxy.
 */
function residentUserIds(db: AppDatabase): string[] {
  return db
    .select({ userId: wechatIdentities.userId })
    .from(wechatIdentities)
    .all()
    .map((row) => row.userId)
}

function onlyResident(db: AppDatabase): string {
  const ids = residentUserIds(db)
  assert.equal(ids.length, 1, 'exactly one resident identity')
  return ids[0]!
}

function countResidents(db: AppDatabase): number {
  return residentUserIds(db).length
}

test('a published activity derives its community server-side and the resident list reads it back', async () => {
  const { app, db, sqlite } = harness()
  try {
    const ownerId = addStaffUser(db)
    const communityA = addCommunity(db, '社区 A')
    const communityB = addCommunity(db, '社区 B')
    const activityId = addActivity(db, communityA, ownerId)

    const started = await start(app, `?activityId=${activityId}&returnTo=${encodeURIComponent(activityReturnTo(activityId))}`)
    assert.equal(started.status, 302, await started.clone().text())

    // The state, not the request, carries the derivation.
    const states = db.select().from(oauthStates).all()
    assert.equal(states.length, 1)
    assert.equal(states[0]?.communityId, communityA, 'community comes from the activity row')

    const callback = await finish(app, started)
    assert.equal(callback.status, 302)
    assert.equal(
      callback.headers.get('location'),
      `${WEB_ORIGIN}${activityReturnTo(activityId)}&auth=success#`,
      'activityId, invite and the return target survive the round trip',
    )

    assert.equal(countResidents(db), 1)
    assert.equal(db.select().from(wechatIdentities).all().length, 1)
    const residentId = onlyResident(db)
    const assignments = assignmentsOf(db, residentId)
    assert.equal(assignments.length, 1)
    assert.equal(assignments[0]?.communityId, communityA)
    assert.equal(
      assignments.some((row) => row.communityId === communityB),
      false,
      'the sibling community is never granted',
    )
    assertNoActivityWrites(db)

    // The admin-facing list is the acceptance surface: community A sees the
    // resident, community B must not.
    const admin = await addAdmin(db)
    const csrfResponse = await app.request('/auth/csrf')
    const csrfCookie = cookiePair(csrfResponse, 'll_csrf')
    const csrfToken = ((await csrfResponse.json()) as { csrfToken: string }).csrfToken
    const loginResponse = await app.request('/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: csrfCookie,
        'x-csrf-token': csrfToken,
        origin: new URL(WEB_ORIGIN).origin,
      },
      body: JSON.stringify(admin),
    })
    assert.equal(loginResponse.status, 200)
    const staffCookies = `${cookiePair(loginResponse, 'll_session')}; ${cookiePair(loginResponse, 'll_csrf')}`

    const listA = await app.request(`/crm/residents?communityId=${communityA}`, {
      headers: { cookie: staffCookies },
    })
    assert.equal(listA.status, 200)
    const bodyA = (await listA.json()) as { items: Array<{ id: string; displayName: string }> }
    assert.deepEqual(
      bodyA.items.map((item) => item.id),
      [residentId],
      'community A resident list contains exactly the logged-in resident',
    )

    const listB = await app.request(`/crm/residents?communityId=${communityB}`, {
      headers: { cookie: staffCookies },
    })
    assert.equal(listB.status, 200)
    assert.deepEqual(((await listB.json()) as { items: unknown[] }).items, [])
  } finally {
    sqlite.close()
  }
})

test('the public-visibility boundary decides attribution: paused and ended still resolve, draft does not', async () => {
  const { app, db, sqlite } = harness()
  try {
    const ownerId = addStaffUser(db)
    const communityId = addCommunity(db, '边界社区')

    for (const status of ['paused', 'ended'] as const) {
      const activityId = addActivity(db, communityId, ownerId, status)
      const started = await start(app, `?activityId=${activityId}`)
      assert.equal(started.status, 302, `${status} activity must be attributable`)
      const record = db
        .select()
        .from(oauthStates)
        .orderBy(desc(oauthStates.createdAt))
        .get()
      assert.equal(
        record?.communityId,
        communityId,
        `${status} activity stored its derived community on the attempt`,
      )
      // Reset so the next iteration cannot read a previous attempt's row.
      db.delete(oauthStates).run()
    }

    const draftId = addActivity(db, communityId, ownerId, 'draft')
    const draftStart = await start(app, `?activityId=${draftId}`)
    assert.equal(draftStart.status, 400)
    assert.equal(
      ((await draftStart.json()) as { error: { code: string } }).error.code,
      'invalid_request',
    )
    assert.equal(db.select().from(oauthStates).all().length, 0, 'a refused start mints no state')
    assert.equal(db.select().from(residentCommunityAssignments).all().length, 0)
  } finally {
    sqlite.close()
  }
})

test('invalid, unknown and malformed activity ids are refused instead of degrading', async () => {
  const { app, db, sqlite } = harness()
  try {
    for (const query of [
      `?activityId=${randomUUID()}`,
      '?activityId=not-a-uuid',
      '?activityId=',
    ]) {
      const response = await start(app, query)
      assert.equal(response.status, 400, `${query} must be refused`)
    }
    assert.equal(db.select().from(oauthStates).all().length, 0, 'a refused activity never mints state')
    assert.equal(countResidents(db), 0)
  } finally {
    sqlite.close()
  }
})

test('a client-supplied communityId is refused even when that community really exists', async () => {
  const { app, db, sqlite } = harness()
  try {
    const ownerId = addStaffUser(db)
    const activityCommunity = addCommunity(db, '活动所属社区')
    const forgedCommunity = addCommunity(db, '客户端伪造社区')
    const activityId = addActivity(db, activityCommunity, ownerId)

    const forged = await start(app, `?communityId=${forgedCommunity}`)
    assert.equal(forged.status, 400, 'existence is not authorization')
    assert.equal(
      ((await forged.json()) as { error: { code: string } }).error.code,
      'invalid_request',
    )

    // Mixing a forged community with a real activity must not be "fixed" either:
    // the parameter is rejected, never merged or preferred.
    const mixed = await start(app, `?activityId=${activityId}&communityId=${forgedCommunity}`)
    assert.equal(mixed.status, 400)
    assert.equal(db.select().from(oauthStates).all().length, 0)
    assert.equal(db.select().from(residentCommunityAssignments).all().length, 0)
  } finally {
    sqlite.close()
  }
})

test('a login without activity context creates no community residence at all', async () => {
  const { app, db, sqlite } = harness()
  try {
    const started = await start(app, `?returnTo=${encodeURIComponent('/me')}`)
    assert.equal(started.status, 302)
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!
    assert.equal(state.length > 0, true)
    assert.equal(db.select().from(oauthStates).all()[0]?.communityId, null)

    const callback = await finish(app, started)
    assert.equal(callback.status, 302)
    assert.equal(countResidents(db), 1, 'identity is still established')
    assert.equal(
      db.select().from(residentCommunityAssignments).all().length,
      0,
      'no activity context, no residence',
    )
    assertNoActivityWrites(db)
  } finally {
    sqlite.close()
  }
})

test('duplicate logins keep exactly one residence and re-login from another activity adds only that one', async () => {
  const { app, db, sqlite } = harness()
  try {
    const ownerId = addStaffUser(db)
    const communityA = addCommunity(db, '社区 A')
    const communityB = addCommunity(db, '社区 B')
    const activityA = addActivity(db, communityA, ownerId)
    const activityB = addActivity(db, communityB, ownerId)

    const first = await finish(app, await start(app, `?activityId=${activityA}`))
    assert.equal(first.status, 302)
    const residentId = onlyResident(db)
    assert.equal(assignmentsOf(db, residentId).length, 1)

    // Same activity again, and a plain retry: still exactly one row for A.
    for (const query of [`?activityId=${activityA}`, `?activityId=${activityA}`]) {
      const again = await finish(app, await start(app, query))
      assert.equal(again.status, 302)
    }
    assert.equal(countResidents(db), 1, 'no duplicate resident')
    assert.equal(db.select().from(wechatIdentities).all().length, 1)
    const afterRetries = assignmentsOf(db, residentId)
    assert.equal(afterRetries.length, 1, 'duplicate logins are idempotent')
    assert.equal(afterRetries[0]?.communityId, communityA)

    // A second activity in a different community is a second legitimate
    // residence, still one row per (user, community).
    const other = await finish(app, await start(app, `?activityId=${activityB}`))
    assert.equal(other.status, 302)
    const both = assignmentsOf(db, residentId)
    assert.equal(both.length, 2)
    assert.deepEqual(
      both.map((row) => row.communityId).sort(),
      [communityA, communityB].sort(),
    )
    assertNoActivityWrites(db)
  } finally {
    sqlite.close()
  }
})

test('the callback consumes the stored community even if the activity stops being public afterwards', async () => {
  const { app, db, sqlite } = harness()
  try {
    const ownerId = addStaffUser(db)
    const communityId = addCommunity(db, '在途社区')
    const activityId = addActivity(db, communityId, ownerId)

    const started = await start(app, `?activityId=${activityId}`)
    assert.equal(started.status, 302)

    // The visible activity set can change between start and callback; the
    // verified state is the authority for the attempt that is already in flight.
    db.update(activities).set({ status: 'draft' }).where(eq(activities.id, activityId)).run()

    const callback = await finish(app, started)
    assert.equal(callback.status, 302)
    const residentId = onlyResident(db)
    const rows = db
      .select()
      .from(residentCommunityAssignments)
      .where(
        and(
          eq(residentCommunityAssignments.userId, residentId),
          eq(residentCommunityAssignments.communityId, communityId),
        ),
      )
      .all()
    assert.equal(rows.length, 1)
    assertNoActivityWrites(db)
  } finally {
    sqlite.close()
  }
})
