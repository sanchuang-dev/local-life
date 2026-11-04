import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type {
  AdminActivityDetail,
  CreateActivityRequest,
  PublicActivityDetail,
} from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig, type ApiConfig } from '../src/config.js'
import { createDatabase, type AppDatabase, type SqliteConnection } from '../src/db/client.js'
import { staffAccounts, users } from '../src/db/schema.js'
import { hashPassword } from '../src/auth/security.js'

const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))

export const ADMIN_PASSWORD = 'Admin-Password-123!'
export const OPERATOR_PASSWORD = 'Operator-Password-123!'
export const GRID_PASSWORD = 'Grid-Worker-Password-123!'

export type App = ReturnType<typeof createApp>

export interface Session {
  cookies: string
  csrfToken: string
}

export interface ErrorEnvelope {
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

export async function csrf(app: App) {
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

export interface AgentSession extends Session {
  userId: string
}

async function sessionFromLogin(
  app: App,
  path: string,
  body: unknown,
): Promise<{ response: Response; session: AgentSession | null }> {
  const state = await csrf(app)
  const response = await app.request(path, {
    method: 'POST',
    headers: writeHeaders(state.cookie, state.token),
    body: JSON.stringify(body),
  })
  if (!response.ok) return { response, session: null }
  const payload = (await response.clone().json()) as {
    csrfToken: string
    user: { id: string }
  }
  return {
    response,
    session: {
      cookies: cookieHeader(
        cookiePair(response, 'll_session'),
        cookiePair(response, 'll_csrf'),
      ),
      csrfToken: payload.csrfToken,
      userId: payload.user.id,
    },
  }
}

export async function staffSession(
  app: App,
  username: string,
  password: string,
): Promise<AgentSession> {
  const result = await sessionFromLogin(app, '/auth/login', { username, password })
  assert.equal(result.response.status, 200, `${username} should be able to log in`)
  assert.ok(result.session)
  return result.session
}

export async function residentSession(
  app: App,
  displayName = '测试居民',
  communityId?: string,
): Promise<AgentSession> {
  const result = await sessionFromLogin(app, '/auth/dev/login', {
    displayName,
    ...(communityId ? { communityId } : {}),
  })
  assert.equal(result.response.status, 200, 'development resident login should succeed')
  assert.ok(result.session)
  return result.session
}

export interface ApiOptions {
  session?: Session
  body?: unknown
  /** CSRF defaults to required for every non-GET request. */
  csrf?: boolean
}

export function api(app: App, method: string, path: string, options: ApiOptions = {}) {
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

export async function errorEnvelope(response: Response): Promise<ErrorEnvelope> {
  return (await response.json()) as ErrorEnvelope
}

export interface TestContextOptions {
  /** Enables the adapter with a simulated CRMEB base URL. */
  crmeb?: { baseUrl: string; h5BaseUrl?: string; timeoutMs?: number }
  /** Injectable fetch used by the CRMEB client (tests only). */
  fetcher?: typeof fetch
}

export interface TestContext {
  app: App
  db: AppDatabase
  sqlite: SqliteConnection
  config: ApiConfig
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const { db, sqlite } = createDatabase(':memory:', migrationsFolder)
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    AUTH_DEV_ENABLED: 'true',
  }
  if (options.crmeb) {
    env.CRMEB_BASE_URL = options.crmeb.baseUrl
    env.CRMEB_H5_BASE_URL = options.crmeb.h5BaseUrl ?? options.crmeb.baseUrl
    env.CRMEB_OUTAPI_APPID = 'simulatedappid'
    env.CRMEB_OUTAPI_APPSECRET = 'simulated-app-secret'
    env.CRMEB_TIMEOUT_MS = String(options.crmeb.timeoutMs ?? 2_000)
  }
  const config = loadConfig(env)
  const app = createApp({
    db,
    config,
    logRequests: false,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  })
  return { app, db, sqlite, config }
}

export async function seedAdmin(
  db: AppDatabase,
  username = 'admin',
  password = ADMIN_PASSWORD,
): Promise<{ userId: string; staffId: string }> {
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
      username,
      passwordHash: await hashPassword(password),
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { userId, staffId }
}

export async function createCommunity(
  app: App,
  admin: Session,
  name: string,
): Promise<string> {
  const response = await api(app, 'POST', '/admin/communities', {
    session: admin,
    body: { name },
  })
  assert.equal(response.status, 201)
  return ((await response.json()) as { id: string }).id
}

export interface StaffInput {
  username: string
  displayName: string
  password: string
  role: 'operator' | 'grid_worker'
  communityIds: string[]
}

export async function createStaffAccount(
  app: App,
  admin: Session,
  input: StaffInput,
): Promise<string> {
  const response = await api(app, 'POST', '/admin/staff', {
    session: admin,
    body: input,
  })
  assert.equal(response.status, 201, `creating staff ${input.username} must succeed`)
  return ((await response.json()) as { id: string }).id
}

const PUBLIC_RULES = {
  eligibility: '本社区 60 岁以上居民',
  checkin: '到社区服务中心签到',
  purchase: '在活动页购买指定套餐',
  prizeClaim: '凭核销码领取',
  notes: '活动最终解释权归社区所有',
} as const

export async function createDraftActivity(
  app: App,
  admin: Session,
  communityId: string,
  title = '银发社区欢乐季',
): Promise<AdminActivityDetail> {
  const payload: CreateActivityRequest = {
    communityId,
    title,
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
  }
  const created = await api(app, 'POST', '/admin/activities', {
    session: admin,
    body: payload,
  })
  assert.equal(created.status, 201, 'activity creation must succeed')
  return (await created.json()) as AdminActivityDetail
}

export async function createPublishedActivity(
  app: App,
  admin: Session,
  communityId: string,
  title = '银发社区欢乐季',
): Promise<string> {
  const draft = await createDraftActivity(app, admin, communityId, title)

  const transition = await api(app, 'POST', `/admin/activities/${draft.id}/publish`, {
    session: admin,
    body: { expectedUpdatedAt: draft.updatedAt },
  })
  assert.equal(transition.status, 200, 'activity publish must succeed')
  const published = (await transition.json()) as AdminActivityDetail
  assert.equal(published.status, 'published')
  return draft.id
}

export async function publicActivity(
  app: App,
  activityId: string,
): Promise<PublicActivityDetail> {
  const response = await app.request(`/activities/public/${activityId}`)
  assert.equal(response.status, 200)
  return (await response.json()) as PublicActivityDetail
}
