import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import test from 'node:test'
import {
  type ActivityAuditEntryListResponse,
  type ActivityKeyRules,
  type ActivityRuleVersionListResponse,
  type AdminActivityDetail,
  type AdminActivityListResponse,
  type CreateActivityRequest,
  type PublicActivityDetail,
  type PublicActivityListResponse,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activities,
  activityRuleVersions,
  auditLogs,
  communities,
  staffAccounts,
  users,
} from '../src/db/schema.js'
import { hashPassword } from '../src/auth/security.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
const ADMIN_PASSWORD = 'Admin-Password-123!'
const OPERATOR_PASSWORD = 'Operator-Password-123!'
const GRID_PASSWORD = 'Grid-Worker-Password-123!'

type App = ReturnType<typeof createApp>

interface Session {
  cookies: string
  csrfToken: string
}

interface ErrorEnvelope {
  error: { code: string; message: string }
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
  assert.ok(pair, `expected ${name} cookie`)
  return pair
}

async function csrf(app: App) {
  const response = await app.request('/auth/csrf')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { csrfToken: string }
  return { token: body.csrfToken, cookie: cookiePair(response, 'll_csrf') }
}

function cookieHeader(...pairs: string[]) {
  return pairs.join('; ')
}

function writeHeaders(cookie: string, token: string) {
  return {
    'content-type': 'application/json',
    cookie,
    'x-csrf-token': token,
    origin: 'http://localhost:5174',
  }
}

async function login(app: App, username: string, password: string) {
  const csrfState = await csrf(app)
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: writeHeaders(csrfState.cookie, csrfState.token),
    body: JSON.stringify({ username, password }),
  })
  return {
    response,
    csrfToken: response.ok
      ? ((await response.clone().json()) as { csrfToken: string }).csrfToken
      : null,
  }
}

async function staffSession(app: App, username: string, password: string): Promise<Session> {
  const result = await login(app, username, password)
  assert.equal(result.response.status, 200, `${username} should be able to log in`)
  assert.ok(result.csrfToken)
  return {
    cookies: cookieHeader(
      cookiePair(result.response, 'll_session'),
      cookiePair(result.response, 'll_csrf'),
    ),
    csrfToken: result.csrfToken,
  }
}

interface ApiOptions {
  session?: Session
  body?: unknown
  /** CSRF defaults to required for every non-GET request. */
  csrf?: boolean
}

function api(app: App, method: string, path: string, options: ApiOptions = {}) {
  const { session, body, csrf: withCsrf = method !== 'GET' } = options
  const headers: Record<string, string> = {}
  if (session) headers.cookie = session.cookies
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (session && withCsrf) {
    headers['x-csrf-token'] = session.csrfToken
    headers.origin = 'http://localhost:5174'
  }
  return app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  return (await response.json()) as ErrorEnvelope
}

function testContext() {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const app = createApp({ db, config, logRequests: false })
  return { app, db, sqlite }
}

async function createAdmin(db: AppDatabase) {
  const now = new Date()
  const userId = randomUUID()
  const staffId = randomUUID()
  db.insert(users)
    .values({ id: userId, displayName: '系统管理员', createdAt: now, updatedAt: now })
    .run()
  db.insert(staffAccounts)
    .values({
      id: staffId,
      userId,
      username: 'admin',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { userId, staffId }
}

async function createCommunity(app: App, admin: Session, name: string): Promise<string> {
  const response = await api(app, 'POST', '/admin/communities', { session: admin, body: { name } })
  assert.equal(response.status, 201)
  return ((await response.json()) as { id: string }).id
}

interface StaffInput {
  username: string
  displayName: string
  password: string
  role: 'operator' | 'grid_worker'
  communityIds: string[]
}

async function createStaffAccount(app: App, admin: Session, input: StaffInput): Promise<string> {
  const response = await api(app, 'POST', '/admin/staff', { session: admin, body: input })
  assert.equal(response.status, 201, `creating staff ${input.username} must succeed`)
  return ((await response.json()) as { id: string }).id
}

const PUBLIC_RULES = {
  eligibility: '本社区 60 岁以上居民',
  checkin: '到社区服务中心签到并领取参与卡',
  purchase: '现场购买指定套餐一份',
  prizeClaim: '凭核销码领取，每人限一次',
  notes: '活动最终解释权归社区所有',
} as const

function activityPayload(
  communityId: string,
  overrides: Partial<CreateActivityRequest> = {},
): CreateActivityRequest {
  return {
    communityId,
    title: '银发社区欢乐季',
    summary: '秋季社区敬老活动',
    description: '面向本社区 60 岁以上居民的线下活动',
    keyRules: {
      startsAt: '2026-12-01T02:00:00.000Z',
      endsAt: '2026-12-01T10:00:00.000Z',
      location: '幸福社区党群服务中心',
      budgetCapCents: 987_654,
      prizeQuantityCap: 4_321,
      publicRules: { ...PUBLIC_RULES },
    },
    ...overrides,
  }
}

async function createActivity(
  app: App,
  session: Session,
  payload: CreateActivityRequest,
): Promise<AdminActivityDetail> {
  const response = await api(app, 'POST', '/admin/activities', { session, body: payload })
  assert.equal(response.status, 201, 'activity creation must succeed')
  return (await response.json()) as AdminActivityDetail
}

async function adminDetail(app: App, session: Session, activityId: string) {
  const response = await api(app, 'GET', `/admin/activities/${activityId}`, { session })
  assert.equal(response.status, 200)
  return (await response.json()) as AdminActivityDetail
}

/** Rebuilds the frozen key-rule payload from an admin detail response. */
function keyRulesOf(detail: AdminActivityDetail): ActivityKeyRules {
  return {
    startsAt: detail.startsAt,
    endsAt: detail.endsAt,
    location: detail.location,
    budgetCapCents: detail.budgetCapCents,
    prizeQuantityCap: detail.prizeQuantityCap,
    publicRules: detail.publicRules,
  }
}

function transition(
  app: App,
  session: Session,
  activityId: string,
  action: 'publish' | 'pause' | 'resume' | 'end',
  expectedUpdatedAt: string,
) {
  return api(app, 'POST', `/admin/activities/${activityId}/${action}`, {
    session,
    body: { expectedUpdatedAt },
  })
}

async function publish(app: App, session: Session, activityId: string) {
  const detail = await adminDetail(app, session, activityId)
  const response = await transition(app, session, activityId, 'publish', detail.updatedAt)
  assert.equal(response.status, 200, 'publish must succeed')
  return (await response.json()) as AdminActivityDetail
}

async function publicList(app: App, query = '') {
  const response = await app.request(`/activities/public${query}`)
  assert.equal(response.status, 200)
  return (await response.json()) as PublicActivityListResponse
}

function publicDetail(app: App, activityId: string) {
  return app.request(`/activities/public/${activityId}`)
}

async function ruleVersions(app: App, session: Session, activityId: string) {
  const response = await api(app, 'GET', `/admin/activities/${activityId}/rule-versions`, {
    session,
  })
  assert.equal(response.status, 200)
  return (await response.json()) as ActivityRuleVersionListResponse
}

async function auditTrail(app: App, session: Session, activityId: string, query = '') {
  const response = await api(app, 'GET', `/admin/activities/${activityId}/audit${query}`, {
    session,
  })
  assert.equal(response.status, 200)
  return (await response.json()) as ActivityAuditEntryListResponse
}

async function adminList(app: App, session: Session, query = '') {
  const response = await api(app, 'GET', `/admin/activities${query}`, { session })
  assert.equal(response.status, 200)
  return (await response.json()) as AdminActivityListResponse
}

function withTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('activity data persists across a real file reopen and the public detail is byte-identical', async () => {
  const temp = withTempDir('ll-activity-persist-')
  const databasePath = join(temp.dir, 'activity-persist.sqlite')
  const config = loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' })
  const first = createDatabase(databasePath, migrationsFolder)
  try {
    await createAdmin(first.db)
    const app = createApp({ db: first.db, config, logRequests: false })
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '持久化验证社区')
    const draft = await createActivity(app, admin, activityPayload(communityId))
    const published = await publish(app, admin, draft.id)
    assert.equal(published.status, 'published')
    assert.equal(published.ruleVersion, 1)

    const beforeResponse = await publicDetail(app, draft.id)
    assert.equal(beforeResponse.status, 200)
    const before = (await beforeResponse.json()) as PublicActivityDetail

    // Close the connection the way a process restart would.
    first.sqlite.close()

    const second = createDatabase(databasePath, migrationsFolder)
    try {
      const restarted = createApp({ db: second.db, config, logRequests: false })
      const afterResponse = await publicDetail(restarted, draft.id)
      assert.equal(afterResponse.status, 200)
      const after = (await afterResponse.json()) as PublicActivityDetail
      assert.deepEqual(after, before, 'reopen must return exactly the same public activity')

      const list = await publicList(restarted, `?communityId=${communityId}`)
      assert.deepEqual(
        list.items.map((item) => item.id),
        [draft.id],
      )

      // The session itself is persisted, so a browser reload also stays signed in.
      const persistedList = await adminList(restarted, admin)
      assert.equal(persistedList.total, 1)
      assert.equal(persistedList.items[0]?.id, draft.id)
    } finally {
      second.sqlite.close()
    }
  } finally {
    try {
      first.sqlite.close()
    } catch {
      // Already closed above; better-sqlite3 throws on a second close.
    }
    temp.cleanup()
  }
})

test('a pre-activity database upgrades in place and keeps existing community rows', async () => {
  const temp = withTempDir('ll-activity-upgrade-')
  try {
    const stagingFolder = join(temp.dir, 'migrations-before-activity')
    mkdirSync(join(stagingFolder, 'meta'), { recursive: true })
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: Array<{ tag: string }> }
    copyFileSync(
      join(migrationsFolder, '0000_freezing_micromax.sql'),
      join(stagingFolder, '0000_freezing_micromax.sql'),
    )
    writeFileSync(
      join(stagingFolder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
    )

    const databasePath = join(temp.dir, 'upgrade.sqlite')
    const legacy = createDatabase(databasePath, stagingFolder)
    const legacyCommunityId = randomUUID()
    try {
      const hasActivities = legacy.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'activities'")
        .get()
      assert.equal(hasActivities, undefined, 'the pre-activity database has no activities table')
      legacy.db
        .insert(communities)
        .values({ id: legacyCommunityId, name: '升级前社区', createdAt: new Date() })
        .run()
    } finally {
      legacy.sqlite.close()
    }

    const upgraded = createDatabase(databasePath, migrationsFolder)
    try {
      const preserved = upgraded.db
        .select()
        .from(communities)
        .where(eq(communities.id, legacyCommunityId))
        .get()
      assert.equal(preserved?.name, '升级前社区')

      await createAdmin(upgraded.db)
      const app = createApp({
        db: upgraded.db,
        config: loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' }),
        logRequests: false,
      })
      const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
      const activity = await createActivity(app, admin, activityPayload(legacyCommunityId))
      const published = await publish(app, admin, activity.id)
      assert.equal(published.status, 'published')

      const detail = await publicDetail(app, activity.id)
      assert.equal(detail.status, 200)
      assert.equal(((await detail.json()) as PublicActivityDetail).community.id, legacyCommunityId)
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    temp.cleanup()
  }
})

test('lifecycle state machine locks illegal transitions and hides drafts from the public API', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '状态机社区')
    const draft = await createActivity(app, admin, activityPayload(communityId))
    assert.equal(draft.status, 'draft')
    assert.equal(draft.ruleVersion, null)
    assert.equal(draft.currentRuleVersionId, null)

    // A draft is never public.
    assert.deepEqual((await publicList(app)).items, [])
    const draftPublic = await publicDetail(app, draft.id)
    assert.equal(draftPublic.status, 404)
    assert.equal((await errorEnvelope(draftPublic)).error.code, 'not_found')

    // Publishing without CSRF is rejected before any state change.
    const noCsrfPublish = await api(app, 'POST', `/admin/activities/${draft.id}/publish`, {
      session: admin,
      body: { expectedUpdatedAt: draft.updatedAt },
      csrf: false,
    })
    assert.equal(noCsrfPublish.status, 403)
    assert.equal((await adminDetail(app, admin, draft.id)).status, 'draft')

    const published = await publish(app, admin, draft.id)
    assert.equal(published.status, 'published')
    assert.equal(published.ruleVersion, 1)
    assert.ok(published.publishedAt)
    const publicPublished = (await (await publicDetail(app, draft.id)).json()) as PublicActivityDetail
    assert.equal(publicPublished.status, 'published')
    assert.deepEqual(publicPublished.publicRules, PUBLIC_RULES)

    const republish = await transition(app, admin, draft.id, 'publish', published.updatedAt)
    assert.equal(republish.status, 409)
    assert.equal((await errorEnvelope(republish)).error.code, 'conflict')

    const pausedResponse = await transition(app, admin, draft.id, 'pause', published.updatedAt)
    assert.equal(pausedResponse.status, 200)
    const paused = (await pausedResponse.json()) as AdminActivityDetail
    assert.equal(paused.status, 'paused')
    assert.equal(
      ((await (await publicDetail(app, draft.id)).json()) as PublicActivityDetail).status,
      'paused',
    )

    const doublePause = await transition(app, admin, draft.id, 'pause', paused.updatedAt)
    assert.equal(doublePause.status, 409)

    const resumedResponse = await transition(app, admin, draft.id, 'resume', paused.updatedAt)
    assert.equal(resumedResponse.status, 200)
    const resumed = (await resumedResponse.json()) as AdminActivityDetail
    assert.equal(resumed.status, 'published')

    const doubleResume = await transition(app, admin, draft.id, 'resume', resumed.updatedAt)
    assert.equal(doubleResume.status, 409)

    const endedResponse = await transition(app, admin, draft.id, 'end', resumed.updatedAt)
    assert.equal(endedResponse.status, 200)
    const ended = (await endedResponse.json()) as AdminActivityDetail
    assert.equal(ended.status, 'ended')
    // Ended activities stay publicly readable as ended.
    assert.equal(
      ((await (await publicDetail(app, draft.id)).json()) as PublicActivityDetail).status,
      'ended',
    )

    const doubleEnd = await transition(app, admin, draft.id, 'end', ended.updatedAt)
    assert.equal(doubleEnd.status, 409)

    const editEnded = await api(app, 'PATCH', `/admin/activities/${draft.id}`, {
      session: admin,
      body: { expectedUpdatedAt: ended.updatedAt, title: '已结束后改名' },
    })
    assert.equal(editEnded.status, 409)

    const publishEnded = await transition(app, admin, draft.id, 'publish', ended.updatedAt)
    assert.equal(publishEnded.status, 409)

    const missing = await transition(app, admin, randomUUID(), 'publish', ended.updatedAt)
    assert.equal(missing.status, 404)
  } finally {
    sqlite.close()
  }
})

test('publish freezes v1 and published rule changes append v2 without rewriting history', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '规则版本社区')
    const draft = await createActivity(app, admin, activityPayload(communityId))
    const published = await publish(app, admin, draft.id)
    assert.equal(published.ruleVersion, 1)

    const versionsAfterPublish = await ruleVersions(app, admin, draft.id)
    assert.equal(versionsAfterPublish.items.length, 1)
    const v1 = versionsAfterPublish.items[0]!
    assert.equal(v1.version, 1)
    const frozenRulesV1 = keyRulesOf(draft)
    assert.deepEqual(v1.snapshot, frozenRulesV1)

    // Changing the published rules appends v2.
    const nextRules: ActivityKeyRules = {
      ...frozenRulesV1,
      location: '幸福社区文化广场',
      publicRules: { ...frozenRulesV1.publicRules, notes: '更新后的规则备注' },
    }
    const updateResponse = await api(app, 'PATCH', `/admin/activities/${draft.id}`, {
      session: admin,
      body: { expectedUpdatedAt: published.updatedAt, keyRules: nextRules },
    })
    assert.equal(updateResponse.status, 200)
    const updated = (await updateResponse.json()) as AdminActivityDetail
    assert.equal(updated.ruleVersion, 2)
    assert.equal(updated.location, '幸福社区文化广场')

    const versionsAfterUpdate = await ruleVersions(app, admin, draft.id)
    assert.deepEqual(
      versionsAfterUpdate.items.map((item) => item.version),
      [2, 1],
    )
    assert.deepEqual(
      versionsAfterUpdate.items.find((item) => item.version === 1)?.snapshot,
      frozenRulesV1,
      'the v1 snapshot must stay byte-identical after v2 is written',
    )
    assert.deepEqual(
      versionsAfterUpdate.items.find((item) => item.version === 2)?.snapshot,
      nextRules,
    )

    // A title-only change does not create a new rule version.
    const titleResponse = await api(app, 'PATCH', `/admin/activities/${draft.id}`, {
      session: admin,
      body: { expectedUpdatedAt: updated.updatedAt, title: '银发社区欢乐季（秋季场）' },
    })
    assert.equal(titleResponse.status, 200)
    const renamed = (await titleResponse.json()) as AdminActivityDetail
    assert.equal(renamed.ruleVersion, 2)
    assert.equal((await ruleVersions(app, admin, draft.id)).items.length, 2)

    // Re-submitting identical key rules is a no-op for versioning.
    const identicalResponse = await api(app, 'PATCH', `/admin/activities/${draft.id}`, {
      session: admin,
      body: { expectedUpdatedAt: renamed.updatedAt, keyRules: nextRules },
    })
    assert.equal(identicalResponse.status, 200)
    assert.equal((await ruleVersions(app, admin, draft.id)).items.length, 2)

    // There is no API surface to mutate or delete a frozen version.
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const attempt = await api(app, method, `/admin/activities/${draft.id}/rule-versions`, {
        session: admin,
        body: method === 'DELETE' ? undefined : { version: 99 },
      })
      assert.equal(attempt.status, 404, `${method} must not be routed`)
    }

    // Even a direct SQL statement cannot rewrite history thanks to the triggers.
    const stored = db
      .select()
      .from(activityRuleVersions)
      .where(eq(activityRuleVersions.activityId, draft.id))
      .all()
      .find((row) => row.version === 1)
    assert.ok(stored)
    assert.throws(
      () =>
        sqlite
          .prepare('UPDATE activity_rule_versions SET snapshot_json = ? WHERE id = ?')
          .run(JSON.stringify({ hijacked: true }), stored.id),
      /immutable/,
    )
    assert.throws(
      () => sqlite.prepare('DELETE FROM activity_rule_versions WHERE id = ?').run(stored.id),
      /immutable/,
    )

    const untouched = await ruleVersions(app, admin, draft.id)
    assert.deepEqual(
      untouched.items.find((item) => item.version === 1)?.snapshot,
      frozenRulesV1,
      'failed SQL writes must leave the frozen snapshot intact',
    )
  } finally {
    sqlite.close()
  }
})

test('stale optimistic tokens return 409 and repeated rule changes never duplicate a version', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '并发冲突社区')
    const draft = await createActivity(app, admin, activityPayload(communityId))
    const published = await publish(app, admin, draft.id)

    const staleTitle = await api(app, 'PATCH', `/admin/activities/${draft.id}`, {
      session: admin,
      body: {
        expectedUpdatedAt: new Date(Date.parse(published.updatedAt) - 60_000).toISOString(),
        title: '过期令牌写入',
      },
    })
    assert.equal(staleTitle.status, 409)
    assert.equal((await errorEnvelope(staleTitle)).error.code, 'conflict')

    const currentRules = keyRulesOf(draft)
    const changedRules: ActivityKeyRules = {
      ...currentRules,
      budgetCapCents: 1_234_567,
      publicRules: {
        ...currentRules.publicRules,
        prizeClaim: '凭核销码领取，每人限两次',
      },
    }
    const firstChange = await api(app, 'PATCH', `/admin/activities/${draft.id}`, {
      session: admin,
      body: { expectedUpdatedAt: published.updatedAt, keyRules: changedRules },
    })
    assert.equal(firstChange.status, 200)
    const afterFirst = (await firstChange.json()) as AdminActivityDetail
    assert.equal(afterFirst.ruleVersion, 2)

    // The same stale token cannot replay the same key-rule change.
    const replay = await api(app, 'PATCH', `/admin/activities/${draft.id}`, {
      session: admin,
      body: { expectedUpdatedAt: published.updatedAt, keyRules: changedRules },
    })
    assert.equal(replay.status, 409)
    assert.deepEqual(
      (await ruleVersions(app, admin, draft.id)).items.map((item) => item.version),
      [2, 1],
    )

    // Two in-flight writers with the same expected token: exactly one wins.
    const [left, right] = await Promise.all([
      api(app, 'PATCH', `/admin/activities/${draft.id}`, {
        session: admin,
        body: {
          expectedUpdatedAt: afterFirst.updatedAt,
          keyRules: { ...changedRules, prizeQuantityCap: 5_000 },
        },
      }),
      api(app, 'PATCH', `/admin/activities/${draft.id}`, {
        session: admin,
        body: {
          expectedUpdatedAt: afterFirst.updatedAt,
          keyRules: { ...changedRules, prizeQuantityCap: 5_000 },
        },
      }),
    ])
    assert.deepEqual(
      [left.status, right.status].sort((a, b) => a - b),
      [200, 409],
    )
    const finalVersions = await ruleVersions(app, admin, draft.id)
    assert.deepEqual(
      finalVersions.items.map((item) => item.version),
      [3, 2, 1],
    )
    assert.equal(
      new Set(finalVersions.items.map((item) => item.version)).size,
      finalVersions.items.length,
    )

    // The UNIQUE(activity_id, version) index is the last line of defence.
    assert.throws(
      () =>
        sqlite
          .prepare(
            'INSERT INTO activity_rule_versions (id, activity_id, version, snapshot_json, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            randomUUID(),
            draft.id,
            finalVersions.items[0]!.version,
            JSON.stringify(changedRules),
            afterFirst.createdAt,
            Date.now(),
          ),
      /UNIQUE constraint failed/,
    )
  } finally {
    sqlite.close()
  }
})

test('authentication, CSRF, grid-worker lockout and cross-community scope are enforced', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityA = await createCommunity(app, admin, '幸福社区')
    const communityB = await createCommunity(app, admin, '阳光社区')
    await createStaffAccount(app, admin, {
      username: 'operator.a',
      displayName: '幸福社区运营员',
      password: OPERATOR_PASSWORD,
      role: 'operator',
      communityIds: [communityA],
    })
    await createStaffAccount(app, admin, {
      username: 'grid.a',
      displayName: '幸福社区网格员',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityA],
    })

    const activityA = await createActivity(app, admin, activityPayload(communityA))
    const activityB = await createActivity(app, admin, activityPayload(communityB, {
      title: '阳光社区欢乐季',
    }))
    await publish(app, admin, activityA.id)
    await publish(app, admin, activityB.id)

    // Unauthenticated callers never reach the admin surface.
    assert.equal((await app.request('/admin/activities')).status, 401)
    const anonymousCreate = await app.request('/admin/activities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(activityPayload(communityA)),
    })
    assert.equal(anonymousCreate.status, 401)

    // A logged-in staff session without the CSRF header is rejected.
    const noCsrf = await api(app, 'POST', '/admin/activities', {
      session: admin,
      body: activityPayload(communityA),
      csrf: false,
    })
    assert.equal(noCsrf.status, 403)
    assert.equal((await errorEnvelope(noCsrf)).error.code, 'forbidden')

    const operator = await staffSession(app, 'operator.a', OPERATOR_PASSWORD)
    const operatorList = await adminList(app, operator)
    assert.ok(operatorList.total >= 1)
    assert.deepEqual(
      [...new Set(operatorList.items.map((item) => item.community.id))],
      [communityA],
      'an operator only sees the assigned community',
    )

    // Filtering by another community must not leak anything.
    const foreignFilter = await adminList(app, operator, `?communityId=${communityB}`)
    assert.equal(foreignFilter.total, 0)
    assert.deepEqual(foreignFilter.items, [])

    assert.equal(
      (await api(app, 'GET', `/admin/activities/${activityB.id}`, { session: operator })).status,
      403,
    )
    assert.equal(
      (
        await api(app, 'PATCH', `/admin/activities/${activityB.id}`, {
          session: operator,
          body: { expectedUpdatedAt: activityB.updatedAt, title: '越权改名' },
        })
      ).status,
      403,
    )
    assert.equal(
      (await transition(app, operator, activityB.id, 'pause', activityB.updatedAt)).status,
      403,
    )
    assert.equal(
      (await api(app, 'GET', `/admin/activities/${activityB.id}/rule-versions`, { session: operator }))
        .status,
      403,
    )
    assert.equal(
      (await api(app, 'GET', `/admin/activities/${activityB.id}/audit`, { session: operator }))
        .status,
      403,
    )
    const crossCreate = await api(app, 'POST', '/admin/activities', {
      session: operator,
      body: activityPayload(communityB),
    })
    assert.equal(crossCreate.status, 403)

    // The assigned community stays fully operable for the operator.
    const ownCreate = await api(app, 'POST', '/admin/activities', {
      session: operator,
      body: activityPayload(communityA, { title: '运营员自建活动' }),
    })
    assert.equal(ownCreate.status, 201)
    const ownActivity = (await ownCreate.json()) as AdminActivityDetail
    assert.equal(ownActivity.community.id, communityA)
    const ownPublish = await transition(app, operator, ownActivity.id, 'publish', ownActivity.updatedAt)
    assert.equal(ownPublish.status, 200)
    assert.equal((await adminDetail(app, operator, ownActivity.id)).status, 'published')

    // Grid workers are locked out of the whole activity admin surface.
    const grid = await staffSession(app, 'grid.a', GRID_PASSWORD)
    assert.equal(
      (await api(app, 'GET', '/admin/activities', { session: grid })).status,
      403,
    )
    assert.equal(
      (await api(app, 'GET', `/admin/activities/${activityA.id}`, { session: grid })).status,
      403,
    )
    assert.equal(
      (await api(app, 'POST', '/admin/activities', { session: grid, body: activityPayload(communityA) }))
        .status,
      403,
    )
    assert.equal(
      (await transition(app, grid, activityA.id, 'publish', activityA.updatedAt)).status,
      403,
    )
    assert.equal(
      (await api(app, 'GET', `/admin/activities/${activityA.id}/rule-versions`, { session: grid }))
        .status,
      403,
    )
    assert.equal(
      (await api(app, 'GET', `/admin/activities/${activityA.id}/audit`, { session: grid })).status,
      403,
    )

    // An admin keeps full cross-community access.
    const adminListResponse = await adminList(app, admin)
    assert.ok(adminListResponse.total >= 2)
    const adminCrossRead = await adminDetail(app, admin, activityB.id)
    assert.equal(adminCrossRead.community.id, communityB)
    const adminCrossCreate = await api(app, 'POST', '/admin/activities', {
      session: admin,
      body: activityPayload(communityB, { title: '管理员跨社区活动' }),
    })
    assert.equal(adminCrossCreate.status, 201)

    // The resident-facing endpoints require no session at all.
    assert.equal((await app.request('/activities/public')).status, 200)
    assert.equal((await app.request(`/activities/public/${activityA.id}`)).status, 200)
  } finally {
    sqlite.close()
  }
})

test('public payloads never leak budgets, caps, creator identity or audit data', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '隐私验证社区')
    const publishedDraft = await createActivity(app, admin, activityPayload(communityId, {
      title: '隐私验证已发布活动',
    }))
    const published = await publish(app, admin, publishedDraft.id)
    const hiddenDraft = await createActivity(app, admin, activityPayload(communityId, {
      title: '隐私验证草稿活动',
    }))

    const listResponse = await app.request('/activities/public')
    assert.equal(listResponse.status, 200)
    const listText = await listResponse.text()
    const list = JSON.parse(listText) as PublicActivityListResponse
    assert.equal(list.items.length, 1)
    assert.equal(list.items[0]?.id, published.id)
    assert.equal(
      list.items.some((item) => item.id === hiddenDraft.id),
      false,
    )

    const detailResponse = await publicDetail(app, published.id)
    assert.equal(detailResponse.status, 200)
    const detailText = await detailResponse.text()
    const detail = JSON.parse(detailText) as PublicActivityDetail

    for (const forbidden of [
      'budgetCapCents',
      'prizeQuantityCap',
      'createdByUserId',
      'currentRuleVersionId',
      'audit',
      'metadata',
      '987654',
      '4321',
    ]) {
      assert.equal(listText.includes(forbidden), false, `public list leaked ${forbidden}`)
      assert.equal(detailText.includes(forbidden), false, `public detail leaked ${forbidden}`)
    }

    assert.deepEqual(Object.keys(detail).sort(), [
      'community',
      'description',
      'endsAt',
      'id',
      'location',
      'publicRules',
      'publishedAt',
      'ruleVersion',
      'startsAt',
      'status',
      'summary',
      'title',
      'updatedAt',
    ])
    assert.deepEqual(Object.keys(list.items[0]!).sort(), [
      'community',
      'endsAt',
      'id',
      'location',
      'ruleVersion',
      'startsAt',
      'status',
      'summary',
      'title',
      'updatedAt',
    ])

    // The admin payload is the internal control: it must still carry them.
    const internal = await adminDetail(app, admin, published.id)
    assert.equal(internal.budgetCapCents, 987_654)
    assert.equal(internal.prizeQuantityCap, 4_321)
    assert.ok(internal.currentRuleVersionId)

    // Drafts stay invisible and non-enumerable even with a direct id.
    const draftDetail = await publicDetail(app, hiddenDraft.id)
    assert.equal(draftDetail.status, 404)
    const draftList = await publicList(app)
    assert.equal(
      draftList.items.some((item) => item.title === '隐私验证草稿活动'),
      false,
    )
    const unknown = await publicDetail(app, randomUUID())
    assert.equal(unknown.status, 404)
  } finally {
    sqlite.close()
  }
})

test('every lifecycle write is auditable, tracked by target and free of budget figures', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '审计验证社区')
    const draft = await createActivity(app, admin, activityPayload(communityId))
    const other = await createActivity(app, admin, activityPayload(communityId, {
      title: '另一个审计活动',
    }))

    const renamed = await api(app, 'PATCH', `/admin/activities/${draft.id}`, {
      session: admin,
      body: { expectedUpdatedAt: draft.updatedAt, title: '审计验证活动' },
    })
    assert.equal(renamed.status, 200)
    assert.equal(((await renamed.json()) as AdminActivityDetail).title, '审计验证活动')
    const published = await publish(app, admin, draft.id)
    assert.equal(published.ruleVersion, 1)

    const ruleChange = await api(app, 'PATCH', `/admin/activities/${draft.id}`, {
      session: admin,
      body: {
        expectedUpdatedAt: published.updatedAt,
        keyRules: { ...keyRulesOf(draft), budgetCapCents: 1_111_111 },
      },
    })
    assert.equal(ruleChange.status, 200)
    const afterRuleChange = (await ruleChange.json()) as AdminActivityDetail
    assert.equal(afterRuleChange.ruleVersion, 2)

    const pausedResponse = await transition(app, admin, draft.id, 'pause', afterRuleChange.updatedAt)
    assert.equal(pausedResponse.status, 200)
    const paused = (await pausedResponse.json()) as AdminActivityDetail
    const resumedResponse = await transition(app, admin, draft.id, 'resume', paused.updatedAt)
    assert.equal(resumedResponse.status, 200)
    const resumed = (await resumedResponse.json()) as AdminActivityDetail
    const endedResponse = await transition(app, admin, draft.id, 'end', resumed.updatedAt)
    assert.equal(endedResponse.status, 200)

    const trail = await auditTrail(app, admin, draft.id)
    const events = trail.items.map((entry) => entry.event)
    for (const expected of [
      'activity.created',
      'activity.updated',
      'activity.published',
      'activity.rule_version.created',
      'activity.paused',
      'activity.resumed',
      'activity.ended',
    ]) {
      assert.ok(events.includes(expected), `audit trail must contain ${expected}`)
    }
    assert.equal(events.filter((event) => event === 'activity.updated').length, 2)
    assert.equal(events.filter((event) => event === 'activity.rule_version.created').length, 2)

    const stored = db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, draft.id))
      .all()
    assert.ok(stored.length >= 8, 'every write inserts a durable audit_logs row')

    for (const entry of trail.items) {
      assert.equal(entry.targetId, draft.id)
      assert.equal(entry.actorDisplayName, '系统管理员')
      if (!entry.metadata) continue
      const raw = JSON.stringify(entry.metadata)
      assert.equal(raw.includes('budget'), false, 'metadata must not mention budgets')
      assert.equal(raw.includes('1111111'), false, 'metadata must not embed the budget value')
      for (const key of Object.keys(entry.metadata)) {
        assert.ok(
          ['status', 'version', 'ruleVersion'].includes(key),
          `unexpected audit metadata key ${key}`,
        )
      }
    }

    // Audit is scoped to the requested activity, not the whole table.
    const otherTrail = await auditTrail(app, admin, other.id)
    assert.ok(otherTrail.items.length >= 1)
    assert.equal(
      otherTrail.items.some((entry) => entry.targetId === draft.id),
      false,
    )

    const limited = await auditTrail(app, admin, draft.id, '?limit=2')
    assert.equal(limited.items.length, 2)
    const invalidLimit = await api(app, 'GET', `/admin/activities/${draft.id}/audit?limit=0`, {
      session: admin,
    })
    assert.equal(invalidLimit.status, 400)
  } finally {
    sqlite.close()
  }
})

test('admin list filters and paginates on the server', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '分页验证社区')
    for (const title of ['秋季活动一', '秋季活动二', '冬季活动三']) {
      await createActivity(app, admin, activityPayload(communityId, { title }))
    }
    const firstPage = await adminList(app, admin, `?page=1&pageSize=2`)
    assert.equal(firstPage.total, 3)
    assert.equal(firstPage.items.length, 2)
    assert.equal(firstPage.page, 1)
    assert.equal(firstPage.pageSize, 2)
    const secondPage = await adminList(app, admin, `?page=2&pageSize=2`)
    assert.equal(secondPage.items.length, 1)
    assert.equal(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size,
      3,
    )

    const keyword = await adminList(app, admin, `?keyword=${encodeURIComponent('冬季')}`)
    assert.equal(keyword.total, 1)
    assert.equal(keyword.items[0]?.title, '冬季活动三')

    const byStatus = await adminList(app, admin, '?status=draft')
    assert.equal(byStatus.total, 3)
    const byPublished = await adminList(app, admin, '?status=published')
    assert.equal(byPublished.total, 0)

    const invalidStatus = await api(app, 'GET', '/admin/activities?status=unknown', {
      session: admin,
    })
    assert.equal(invalidStatus.status, 400)
  } finally {
    sqlite.close()
  }
})

test('activities are never hard-deleted by the domain and the trigger protects snapshots on disk', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '持久化规则社区')
    const draft = await createActivity(app, admin, activityPayload(communityId))
    await publish(app, admin, draft.id)

    const stored = db
      .select()
      .from(activities)
      .where(eq(activities.id, draft.id))
      .get()
    assert.ok(stored)
    assert.equal(stored.status, 'published')
    assert.equal(
      db.select().from(activityRuleVersions).all().length,
      1,
      'publishing writes exactly one frozen version',
    )

    // The API exposes no delete route for activities either.
    const deleteAttempt = await api(app, 'DELETE', `/admin/activities/${draft.id}`, {
      session: admin,
    })
    assert.equal(deleteAttempt.status, 404)
  } finally {
    sqlite.close()
  }
})
