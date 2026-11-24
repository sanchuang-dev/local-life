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
  type ActivityRuleVersionListResponse,
  type AdminActivityDetail,
  type CreateActivityRequest,
  type PublicActivityDetail,
  type PublicActivityListResponse,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase, type AppDatabase } from '../src/db/client.js'
import {
  activities,
  staffAccounts,
  users,
} from '../src/db/schema.js'
import { hashPassword } from '../src/auth/security.js'
import { getPublicActivity } from '../src/activities/service.js'

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

const PUBLIC_RULES = {
  eligibility: '本社区 60 岁以上居民',
  checkin: '到社区服务中心签到并领取参与卡',
  purchase: '现场购买指定套餐一份',
  prizeClaim: '凭核销码领取，每人限一次',
  notes: '活动最终解释权归社区所有',
} as const

const VISUAL_CONFIG = {
  themeKey: 'festival-red' as const,
  heroImageUrl: 'https://cdn.example.com/activity/hero.webp',
  promoTitle: '重阳敬老周',
  promoSubtitle: '三人成团，现场有礼',
  posterImageUrl: 'https://cdn.example.com/activity/poster.webp',
}

const DEFAULT_VISUAL = {
  themeKey: 'community-green',
  heroImageUrl: null,
  promoTitle: null,
  promoSubtitle: null,
  posterImageUrl: null,
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

async function staffSession(app: App, username: string, password: string): Promise<Session> {
  const csrfState = await csrf(app)
  const response = await app.request('/auth/login', {
    method: 'POST',
    headers: writeHeaders(csrfState.cookie, csrfState.token),
    body: JSON.stringify({ username, password }),
  })
  assert.equal(response.status, 200, `${username} should be able to log in`)
  const loginBody = (await response.clone().json()) as { csrfToken: string }
  return {
    cookies: cookieHeader(cookiePair(response, 'll_session'), cookiePair(response, 'll_csrf')),
    csrfToken: loginBody.csrfToken,
  }
}

interface ApiOptions {
  session?: Session
  body?: unknown
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

async function createStaffAccount(
  app: App,
  admin: Session,
  input: {
    username: string
    displayName: string
    password: string
    role: 'operator' | 'grid_worker'
    communityIds: string[]
  },
): Promise<string> {
  const response = await api(app, 'POST', '/admin/staff', { session: admin, body: input })
  assert.equal(response.status, 201, `creating staff ${input.username} must succeed`)
  return ((await response.json()) as { id: string }).id
}

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

function publicDetail(app: App, activityId: string) {
  return app.request(`/activities/public/${activityId}`)
}

async function ruleVersions(
  app: App,
  session: Session,
  activityId: string,
): Promise<ActivityRuleVersionListResponse> {
  const response = await api(app, 'GET', `/admin/activities/${activityId}/rule-versions`, {
    session,
  })
  assert.equal(response.status, 200)
  return (await response.json()) as ActivityRuleVersionListResponse
}

function withTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('0042 migration adds green/default visual columns without rewriting historical activities', async () => {
  const temp = withTempDir('ll-activity-visual-migration-')
  try {
    // Build the pre-#309 schema from the real migration history (everything up
    // to and including 0040; this branch has no 0041).
    const legacyFolder = join(temp.dir, 'migrations-before-visual')
    mkdirSync(join(legacyFolder, 'meta'), { recursive: true })
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as {
      version: string
      dialect: string
      entries: Array<{ idx: number; tag: string }>
    }
    const legacyEntries = journal.entries.filter((entry) => entry.idx <= 40)
    for (const entry of legacyEntries) {
      copyFileSync(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(legacyFolder, `${entry.tag}.sql`),
      )
    }
    writeFileSync(
      join(legacyFolder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: legacyEntries }),
    )

    const databasePath = join(temp.dir, 'visual-upgrade.sqlite')
    const now = Date.now()
    const userId = randomUUID()
    const communityId = randomUUID()
    const activityId = randomUUID()

    const legacy = createDatabase(databasePath, legacyFolder)
    try {
      legacy.sqlite
        .prepare('INSERT INTO communities (id, name, created_at) VALUES (?, ?, ?)')
        .run(communityId, '升级前社区', now)
      legacy.sqlite
        .prepare(
          'INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(userId, '历史运营员', now, now)
      legacy.sqlite
        .prepare(
          `INSERT INTO activities (
            id, community_id, title, summary, description, status,
            starts_at, ends_at, location, budget_cap_cents, prize_quantity_cap,
            public_rules_json, current_rule_version_id, created_by_user_id,
            created_at, updated_at, published_at, paused_at, ended_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          activityId,
          communityId,
          '银发社区欢乐季',
          '历史活动摘要',
          '历史活动描述',
          'published',
          now,
          now + 3_600_000,
          '幸福社区党群服务中心',
          100_000,
          100,
          JSON.stringify(PUBLIC_RULES),
          null,
          userId,
          now,
          now,
          now,
          null,
          null,
        )
    } finally {
      legacy.sqlite.close()
    }

    const upgraded = createDatabase(databasePath, migrationsFolder)
    try {
      const row = upgraded.db
        .select()
        .from(activities)
        .where(eq(activities.id, activityId))
        .get()
      assert.ok(row, 'historical activity must survive the upgrade')
      assert.equal(row.themeKey, 'community-green')
      assert.equal(row.heroImageUrl, null)
      assert.equal(row.promoTitle, null, 'migration must not invent promo copy')
      assert.equal(row.promoSubtitle, null)
      assert.equal(row.posterImageUrl, null)
      assert.equal(row.title, '银发社区欢乐季')
      assert.equal(row.summary, '历史活动摘要')

      // The real read path must keep the old activity publicly readable with the
      // default visual projection, i.e. the H5 can fall back to its own artwork.
      const publicActivity = getPublicActivity(upgraded.db, activityId)
      assert.deepEqual(publicActivity.visualConfig, DEFAULT_VISUAL)
      assert.equal(publicActivity.title, '银发社区欢乐季')
    } finally {
      upgraded.sqlite.close()
    }
  } finally {
    temp.cleanup()
  }
})

test('create defaults and full visual config round-trip through admin and public payloads', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '视觉配置社区')

    const legacyStyle = await createActivity(app, admin, activityPayload(communityId))
    assert.deepEqual(legacyStyle.visualConfig, DEFAULT_VISUAL)

    const configuredPayload = activityPayload(communityId, {
      title: '重阳敬老活动',
      visualConfig: {
        ...VISUAL_CONFIG,
        internalNote: 'do-not-leak',
      } as CreateActivityRequest['visualConfig'],
    })
    const configured = await createActivity(app, admin, configuredPayload)
    assert.deepEqual(configured.visualConfig, VISUAL_CONFIG)
    assert.equal(JSON.stringify(configured).includes('internalNote'), false)

    const published = await publish(app, admin, configured.id)
    assert.equal(published.status, 'published')
    assert.deepEqual(published.visualConfig, VISUAL_CONFIG)

    const listResponse = await app.request(`/activities/public?communityId=${communityId}`)
    assert.equal(listResponse.status, 200)
    const list = (await listResponse.json()) as PublicActivityListResponse
    const listed = list.items.find((item) => item.id === configured.id)
    assert.ok(listed)
    assert.deepEqual(listed.visualConfig, VISUAL_CONFIG)

    const detailResponse = await publicDetail(app, configured.id)
    assert.equal(detailResponse.status, 200)
    const detailText = await detailResponse.text()
    const detail = JSON.parse(detailText) as PublicActivityDetail
    assert.deepEqual(detail.visualConfig, VISUAL_CONFIG)
    assert.deepEqual(Object.keys(detail.visualConfig).sort(), [
      'heroImageUrl',
      'posterImageUrl',
      'promoSubtitle',
      'promoTitle',
      'themeKey',
    ])
    for (const forbidden of ['internalNote', 'do-not-leak', 'createdByUserId', 'budget']) {
      assert.equal(detailText.includes(forbidden), false, `public detail leaked ${forbidden}`)
    }

    // Defaults stay readable on the public projection too.
    const defaultPublished = await publish(app, admin, legacyStyle.id)
    assert.deepEqual(defaultPublished.visualConfig, DEFAULT_VISUAL)
    const defaultPublic = (await (await publicDetail(app, legacyStyle.id)).json()) as PublicActivityDetail
    assert.deepEqual(defaultPublic.visualConfig, DEFAULT_VISUAL)
  } finally {
    sqlite.close()
  }
})

test('update preserves omitted visuals, patches single fields and clears with null or blank', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '视觉更新社区')
    const created = await createActivity(
      app,
      admin,
      activityPayload(communityId, { visualConfig: VISUAL_CONFIG }),
    )

    // 1. An old client that knows nothing about visuals renames the activity:
    //    every visual field must stay untouched.
    const renamedResponse = await api(app, 'PATCH', `/admin/activities/${created.id}`, {
      session: admin,
      body: { expectedUpdatedAt: created.updatedAt, title: '重阳敬老活动（改名）' },
    })
    assert.equal(renamedResponse.status, 200)
    const renamed = (await renamedResponse.json()) as AdminActivityDetail
    assert.equal(renamed.title, '重阳敬老活动（改名）')
    assert.deepEqual(renamed.visualConfig, VISUAL_CONFIG)
    assert.ok(Date.parse(renamed.updatedAt) > Date.parse(created.updatedAt))

    // 2. A partial visual patch leaves the other fields alone.
    const partialResponse = await api(app, 'PATCH', `/admin/activities/${created.id}`, {
      session: admin,
      body: {
        expectedUpdatedAt: renamed.updatedAt,
        visualConfig: { themeKey: 'health-blue', promoTitle: '健康敬老周' },
      },
    })
    assert.equal(partialResponse.status, 200)
    const partial = (await partialResponse.json()) as AdminActivityDetail
    assert.deepEqual(partial.visualConfig, {
      ...VISUAL_CONFIG,
      themeKey: 'health-blue',
      promoTitle: '健康敬老周',
    })

    // 3. Explicit null and blank both clear only the field they belong to.
    const clearFieldsResponse = await api(app, 'PATCH', `/admin/activities/${created.id}`, {
      session: admin,
      body: {
        expectedUpdatedAt: partial.updatedAt,
        visualConfig: { heroImageUrl: null, posterImageUrl: '   ' },
      },
    })
    assert.equal(clearFieldsResponse.status, 200)
    const clearedFields = (await clearFieldsResponse.json()) as AdminActivityDetail
    assert.deepEqual(clearedFields.visualConfig, {
      themeKey: 'health-blue',
      heroImageUrl: null,
      promoTitle: '健康敬老周',
      promoSubtitle: VISUAL_CONFIG.promoSubtitle,
      posterImageUrl: null,
    })

    // 4. `visualConfig: null` clears everything and restores the default theme.
    const clearAllResponse = await api(app, 'PATCH', `/admin/activities/${created.id}`, {
      session: admin,
      body: { expectedUpdatedAt: clearedFields.updatedAt, visualConfig: null },
    })
    assert.equal(clearAllResponse.status, 200)
    const clearedAll = (await clearAllResponse.json()) as AdminActivityDetail
    assert.deepEqual(clearedAll.visualConfig, DEFAULT_VISUAL)
    assert.equal(clearedAll.ruleVersion, null)
  } finally {
    sqlite.close()
  }
})

test('invalid themes, URLs and overlong copy are rejected without mutating the activity', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '视觉校验社区')

    const invalidCreates: Array<Record<string, unknown>> = [
      { visualConfig: { themeKey: 'neon-pink' } },
      { visualConfig: { heroImageUrl: 'javascript:alert(1)' } },
      { visualConfig: { posterImageUrl: 'data:image/png;base64,AAAA' } },
      { visualConfig: { heroImageUrl: '//cdn.example.com/hero.webp' } },
      { visualConfig: { heroImageUrl: `https://cdn.example.com/${'a'.repeat(2100)}.webp` } },
      { visualConfig: { promoTitle: 'a'.repeat(41) } },
      { visualConfig: { promoSubtitle: 'a'.repeat(81) } },
    ]
    for (const overrides of invalidCreates) {
      const response = await api(app, 'POST', '/admin/activities', {
        session: admin,
        body: activityPayload(communityId, overrides as Partial<CreateActivityRequest>),
      })
      assert.equal(response.status, 400, `invalid visual config must be rejected: ${JSON.stringify(overrides)}`)
      assert.equal((await errorEnvelope(response)).error.code, 'invalid_request')
    }

    const created = await createActivity(app, admin, activityPayload(communityId))
    const invalidUpdates: Array<Record<string, unknown>> = [
      { expectedUpdatedAt: created.updatedAt, visualConfig: { themeKey: 'neon-pink' } },
      { expectedUpdatedAt: created.updatedAt, visualConfig: { posterImageUrl: 'data:image/png;base64,AAAA' } },
      { expectedUpdatedAt: created.updatedAt, visualConfig: {} },
      { expectedUpdatedAt: created.updatedAt },
    ]
    for (const body of invalidUpdates) {
      const response = await api(app, 'PATCH', `/admin/activities/${created.id}`, {
        session: admin,
        body,
      })
      assert.equal(response.status, 400, `invalid update must be rejected: ${JSON.stringify(body)}`)
    }
    assert.deepEqual((await adminDetail(app, admin, created.id)).visualConfig, DEFAULT_VISUAL)

    // Plain http is accepted (local/CDN deployments may not be https yet).
    const httpResponse = await api(app, 'PATCH', `/admin/activities/${created.id}`, {
      session: admin,
      body: {
        expectedUpdatedAt: created.updatedAt,
        visualConfig: { heroImageUrl: 'http://localhost:5173/images/activity.webp' },
      },
    })
    assert.equal(httpResponse.status, 200)
    assert.equal(
      ((await httpResponse.json()) as AdminActivityDetail).visualConfig.heroImageUrl,
      'http://localhost:5173/images/activity.webp',
    )
  } finally {
    sqlite.close()
  }
})

test('published visual-only edits create no rule version and leave frozen rules and plans untouched', async () => {
  const { app, db, sqlite } = testContext()
  try {
    await createAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '发布后视觉社区')

    const base = activityPayload(communityId, { visualConfig: VISUAL_CONFIG })
    const rewardPlan = {
      prizeName: '敬老礼包',
      prizeUnitCostCents: 1_000,
      prizeQuantityPerTeam: 1,
      totalPrizeQuantity: 10,
      budgetCapCents: 10_000,
      claimRecipient: 'leader' as const,
      checkinWindow: {
        opensAt: base.keyRules.startsAt,
        closesAt: base.keyRules.endsAt,
      },
      redemptionValidHours: 24,
      notes: '发布后仅调整视觉，奖励规则不得变化',
    }
    const purchaseRewardPlan = {
      thresholdCents: 10_000,
      couponFaceValueCents: 1_000,
      maxRewardedTeams: 3,
    }
    const created = await createActivity(app, admin, {
      ...base,
      keyRules: { ...base.keyRules, rewardPlan, purchaseRewardPlan },
    })
    const published = await publish(app, admin, created.id)
    assert.equal(published.status, 'published')
    assert.equal(published.ruleVersion, 1)
    assert.deepEqual(published.rewardPlan, {
      ...rewardPlan,
      prizeQuantityPerTeam: 1,
    })
    assert.deepEqual(published.purchaseRewardPlan, purchaseRewardPlan)

    const beforeVersions = await ruleVersions(app, admin, created.id)
    assert.equal(beforeVersions.items.length, 1)

    const response = await api(app, 'PATCH', `/admin/activities/${created.id}`, {
      session: admin,
      body: {
        expectedUpdatedAt: published.updatedAt,
        visualConfig: {
          themeKey: 'warm-gold',
          heroImageUrl: 'https://cdn.example.com/activity/new-hero.webp',
          promoTitle: '暖冬敬老周',
          promoSubtitle: '好礼继续',
          posterImageUrl: 'https://cdn.example.com/activity/new-poster.webp',
        },
      },
    })
    assert.equal(response.status, 200)
    const updated = (await response.json()) as AdminActivityDetail

    assert.equal(updated.status, 'published')
    assert.equal(updated.ruleVersion, 1)
    assert.equal(updated.currentRuleVersionId, published.currentRuleVersionId)
    assert.equal(updated.publishedAt, published.publishedAt)
    assert.equal(updated.startsAt, published.startsAt)
    assert.equal(updated.endsAt, published.endsAt)
    assert.equal(updated.location, published.location)
    assert.equal(updated.budgetCapCents, published.budgetCapCents)
    assert.equal(updated.prizeQuantityCap, published.prizeQuantityCap)
    assert.deepEqual(updated.publicRules, published.publicRules)
    assert.deepEqual(updated.rewardPlan, published.rewardPlan)
    assert.deepEqual(updated.purchaseRewardPlan, published.purchaseRewardPlan)
    assert.deepEqual(updated.visualConfig, {
      themeKey: 'warm-gold',
      heroImageUrl: 'https://cdn.example.com/activity/new-hero.webp',
      promoTitle: '暖冬敬老周',
      promoSubtitle: '好礼继续',
      posterImageUrl: 'https://cdn.example.com/activity/new-poster.webp',
    })

    const afterVersions = await ruleVersions(app, admin, created.id)
    assert.equal(afterVersions.items.length, 1, 'visual edits must not create a rule version')

    // The resident read path sees the new visuals immediately.
    const publicActivity = (await (await publicDetail(app, created.id)).json()) as PublicActivityDetail
    assert.deepEqual(publicActivity.visualConfig, updated.visualConfig)
    assert.equal(publicActivity.ruleVersion, 1)

    // A second visual-only edit still does not bump the rule version.
    const second = await api(app, 'PATCH', `/admin/activities/${created.id}`, {
      session: admin,
      body: {
        expectedUpdatedAt: updated.updatedAt,
        visualConfig: { promoSubtitle: '第二次调整' },
      },
    })
    assert.equal(second.status, 200)
    assert.equal(((await second.json()) as AdminActivityDetail).ruleVersion, 1)
    assert.equal((await ruleVersions(app, admin, created.id)).items.length, 1)
  } finally {
    sqlite.close()
  }
})

test('auth, community scope, CSRF and expectedUpdatedAt still guard visual edits', async () => {
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

    // Unauthenticated access is rejected.
    assert.equal((await app.request(`/admin/activities/${activityA.id}`)).status, 401)

    // Grid workers cannot manage activities at all.
    const grid = await staffSession(app, 'grid.a', GRID_PASSWORD)
    const gridResponse = await api(app, 'PATCH', `/admin/activities/${activityA.id}`, {
      session: grid,
      body: { expectedUpdatedAt: (await adminDetail(app, admin, activityA.id)).updatedAt, visualConfig: { promoTitle: '越权' } },
    })
    assert.equal(gridResponse.status, 403)

    const operator = await staffSession(app, 'operator.a', OPERATOR_PASSWORD)
    const foreignGet = await api(app, 'GET', `/admin/activities/${activityB.id}`, {
      session: operator,
    })
    assert.equal(foreignGet.status, 403)
    const foreignPatch = await api(app, 'PATCH', `/admin/activities/${activityB.id}`, {
      session: operator,
      body: {
        expectedUpdatedAt: activityB.updatedAt,
        visualConfig: { promoTitle: '越权海报' },
      },
    })
    assert.equal(foreignPatch.status, 403)
    assert.equal(
      (await api(app, 'POST', '/admin/activities', {
        session: operator,
        body: activityPayload(communityB),
      })).status,
      403,
    )

    // The assigned operator may edit visuals in their own community...
    const ownDetail = await adminDetail(app, admin, activityA.id)
    const ownResponse = await api(app, 'PATCH', `/admin/activities/${activityA.id}`, {
      session: operator,
      body: {
        expectedUpdatedAt: ownDetail.updatedAt,
        visualConfig: { promoTitle: '运营员调整的标题' },
      },
    })
    assert.equal(ownResponse.status, 200)
    assert.equal(
      ((await ownResponse.json()) as AdminActivityDetail).visualConfig.promoTitle,
      '运营员调整的标题',
    )

    // ...but CSRF is still mandatory.
    const latest = await adminDetail(app, admin, activityA.id)
    const noCsrf = await api(app, 'PATCH', `/admin/activities/${activityA.id}`, {
      session: operator,
      body: { expectedUpdatedAt: latest.updatedAt, visualConfig: { promoTitle: '无 CSRF' } },
      csrf: false,
    })
    assert.equal(noCsrf.status, 403)
    assert.equal((await errorEnvelope(noCsrf)).error.code, 'forbidden')

    // Optimistic concurrency: the second writer using the stale token loses.
    const staleToken = latest.updatedAt
    const first = await api(app, 'PATCH', `/admin/activities/${activityA.id}`, {
      session: admin,
      body: { expectedUpdatedAt: staleToken, visualConfig: { promoTitle: '第一次写入' } },
    })
    assert.equal(first.status, 200)
    const conflict = await api(app, 'PATCH', `/admin/activities/${activityA.id}`, {
      session: admin,
      body: { expectedUpdatedAt: staleToken, visualConfig: { promoTitle: '过期写入' } },
    })
    assert.equal(conflict.status, 409)
    assert.equal((await errorEnvelope(conflict)).error.code, 'conflict')
    assert.equal(
      (await adminDetail(app, admin, activityA.id)).visualConfig.promoTitle,
      '第一次写入',
    )
  } finally {
    sqlite.close()
  }
})
