import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  API_ERROR_CODES,
  API_ROUTES,
  CRM_ROUTES,
  residentDirectoryQuerySchema,
  residentDirectoryResponseSchema,
  SERVICE_NAME,
  authSessionResponseSchema,
  wechatProfileStartResponseSchema,
  wechatProfileStatusSchema,
  createCommunityRequestSchema,
  communityLocationSchema,
  PUBLIC_COMMUNITY_ROUTE,
  publicCommunityQuerySchema,
  TENCENT_MAP_ADMIN_ROUTES,
  saveTencentMapConfigRequestSchema,
  setTencentMapEnabledRequestSchema,
  tencentMapConfigStatusSchema,
  tencentMapPickerConfigSchema,
  createStaffAccountRequestSchema,
  healthResponseSchema,
  isActivityId,
  staffLoginRequestSchema,
  type ApiError,
  type ApiErrorCode,
  type AuthSessionResponse,
  type HealthResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from './config.js'
import { createDatabase, type AppDatabase } from './db/client.js'
import {
  auditLogs,
  communities,
  tencentMapConfigs,
  oauthStates,
  rateLimits,
  sessions,
  staffAccounts,
  staffCommunityAssignments,
  users,
  wechatIdentities,
  wechatOauthConfigs,
} from './db/schema.js'
import { constantTimeTextEqual, hashPassword, hashToken, randomToken, verifyPassword } from './auth/security.js'
import {
  OAUTH_RETURN_COOKIE,
  OAUTH_RETURN_COOKIE_PATH,
  OAUTH_STATE_TTL_SECONDS,
  bindReturnToCookie,
  oauthResultDestination,
  readBoundReturnTo,
  resolveReturnTo,
  wechatCallbackUrl,
  wechatProfileResultDestination,
} from './auth/oauth-return.js'
import { registerPhoneAuthRoutes } from './auth/phone-routes.js'
import type { SmsSender } from './auth/phone.js'
import { logEvent } from './log.js'
import { registerActivityRoutes } from './activities/routes.js'
import { listPublicCommunities } from './communities/discovery.js'
import { resolvePublicActivityCommunityId } from './activities/service.js'
import { registerCrmRoutes } from './crm/routes.js'
import { registerLocalCatalogRoutes } from './local/routes.js'
import { registerExternalOfferRoutes } from './external-offers/routes.js'
import { registerLocalOrderRoutes } from './local/order-routes.js'
import { registerLedgerRouteGroup } from './routes/ledger-route-group.js'
import { registerParticipationRoutes } from './participation/routes.js'
import { registerPurchaseRewardRoutes } from './purchase-reward/routes.js'
import { registerRewardRoutes } from './rewards/routes.js'
import { registerDrawRoutes } from './draw/routes.js'
import { registerUserDirectoryRoutes } from './users/routes.js'
// #171 LL-IDENTITY-001: resident permanent-community read + explicit confirmation.
import { registerResidentCommunityRoutes } from './resident-community/routes.js'
import { registerResidentProfileRoutes } from './resident-profile/routes.js'
// A login may leave one server-derived candidate; nothing is ever auto-confirmed.
import { recordBindingCandidate } from './resident-community/service.js'
import { registerCrmebRoutes } from './crmeb/routes.js'
import { registerWechatAdminRoutes } from './wechat/routes.js'
import { registerWechatJsSdkRoutes } from './wechat/js-sdk.js'
import { resolveWechatRuntimeConfig, type WechatRuntimeOptions } from './wechat/runtime.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from './http.js'

export interface AppOptions {
  version?: string
  startedAt?: number
  logRequests?: boolean
  db?: AppDatabase
  config?: ApiConfig
  fetcher?: typeof fetch
  /**
   * SMS delivery for phone verification codes (#93). No provider is bundled:
   * without an injected sender the phone endpoints answer 503 `not_configured`.
   * The test suite injects a capturing fake; production passes nothing.
   */
  smsSender?: SmsSender
  /** Injectable clock so OTP expiry/throttle windows are testable. */
  now?: () => Date
}

const SESSION_COOKIE = 'll_session'
const CSRF_COOKIE = 'll_csrf'
const OAUTH_NONCE_COOKIE = 'll_oauth_nonce'
// The browser uses /api/auth/wechat/*; Vite and the production reverse proxy
// strip /api only AFTER the browser has selected which cookies to send.
// Root scope lets both /auth/* (direct API) and /api/auth/* receive the nonce.
const OAUTH_NONCE_COOKIE_PATH = '/'
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT_MAX_ATTEMPTS = 8

function errorBody(code: ApiErrorCode, message: string, requestId?: string): ApiError {
  return requestId ? { error: { code, message, requestId } } : { error: { code, message } }
}

function fail(
  c: AppContext,
  status: HttpErrorStatus,
  code: ApiErrorCode,
  message: string,
) {
  return c.json(errorBody(code, message, c.get('requestId')), status)
}

function cookieOptions(config: ApiConfig, maxAge: number) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax' as const,
    maxAge,
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  }
}

function setSessionCookies(
  c: AppContext,
  config: ApiConfig,
  token: string,
  csrfToken: string,
) {
  setCookie(c, SESSION_COOKIE, token, cookieOptions(config, config.sessionTtlSeconds))
  setCookie(c, CSRF_COOKIE, csrfToken, {
    ...cookieOptions(config, config.sessionTtlSeconds),
    httpOnly: false,
  })
}

function clearSessionCookies(
  c: AppContext,
  config: ApiConfig,
) {
  const options = {
    path: '/',
    secure: config.cookieSecure,
    sameSite: 'Lax' as const,
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  }
  deleteCookie(c, SESSION_COOKIE, options)
  deleteCookie(c, CSRF_COOKIE, options)
}

function trustedOrigin(c: AppContext, config: ApiConfig) {
  const origin = c.req.header('origin')
  if (!origin) return true
  try {
    const normalized = new URL(origin).origin
    return config.trustedOrigins.includes(normalized)
  } catch {
    return false
  }
}

function validCsrf(
  c: AppContext,
  config: ApiConfig,
  session?: AuthSession | null,
): boolean {
  if (!trustedOrigin(c, config)) return false
  const cookieToken = getCookie(c, CSRF_COOKIE)
  const headerToken = c.req.header('x-csrf-token')
  if (!cookieToken || !headerToken || !constantTimeTextEqual(cookieToken, headerToken)) return false
  return session ? constantTimeTextEqual(hashToken(headerToken), session.csrfHash) : true
}

function createSession(
  db: AppDatabase,
  config: ApiConfig,
  userId: string,
  staffAccountId: string | null,
) {
  const token = randomToken()
  const csrfToken = randomToken()
  const now = new Date()
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run()
  db.insert(sessions)
    .values({
      id: randomUUID(),
      userId,
      staffAccountId,
      tokenHash: hashToken(token),
      csrfHash: hashToken(csrfToken),
      expiresAt: new Date(now.getTime() + config.sessionTtlSeconds * 1000),
      createdAt: now,
      lastSeenAt: now,
    })
    .run()
  return { token, csrfToken }
}

function readAuthSession(db: AppDatabase, token: string | undefined): AuthSession | null {
  if (!token) return null
  const record = db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      displayName: users.displayName,
      csrfHash: sessions.csrfHash,
      expiresAt: sessions.expiresAt,
      staffId: staffAccounts.id,
      username: staffAccounts.username,
      role: staffAccounts.role,
      staffStatus: staffAccounts.status,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .leftJoin(staffAccounts, eq(sessions.staffAccountId, staffAccounts.id))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .get()

  if (!record) return null
  if (record.expiresAt.getTime() <= Date.now() || (record.staffId && record.staffStatus !== 'active')) {
    db.delete(sessions).where(eq(sessions.id, record.sessionId)).run()
    return null
  }

  return {
    sessionId: record.sessionId,
    userId: record.userId,
    displayName: record.displayName,
    csrfHash: record.csrfHash,
    expiresAt: record.expiresAt,
    staff:
      record.staffId && record.username && record.role
        ? {
            id: record.staffId,
            username: record.username,
            role: record.role,
            status: record.staffStatus ?? 'disabled',
          }
        : null,
  }
}

function staffCommunities(db: AppDatabase, staffAccountId: string) {
  return db
    .select({ id: communities.id, name: communities.name })
    .from(staffCommunityAssignments)
    .innerJoin(communities, eq(staffCommunityAssignments.communityId, communities.id))
    .where(eq(staffCommunityAssignments.staffAccountId, staffAccountId))
    .all()
}

function sessionResponse(
  db: AppDatabase,
  session: AuthSession,
  csrfToken: string,
): AuthSessionResponse {
  return authSessionResponseSchema.parse({
    authenticated: true,
    user: { id: session.userId, displayName: session.displayName },
    staff: session.staff
      ? {
          id: session.staff.id,
          username: session.staff.username,
          role: session.staff.role,
          communities: staffCommunities(db, session.staff.id),
        }
      : null,
    csrfToken,
  })
}

function recordAudit(
  db: AppDatabase,
  actorUserId: string | null,
  event: string,
  targetId: string | null,
  metadata?: Record<string, string>,
) {
  db.insert(auditLogs)
    .values({
      id: randomUUID(),
      actorUserId,
      event,
      targetId,
      metadata: metadata ? JSON.stringify(metadata) : null,
      createdAt: new Date(),
    })
    .run()
}

function rateLimitKey(username: string): string {
  return hashToken(`staff-login:${username.trim().toLowerCase()}`)
}

function isRateLimited(db: AppDatabase, key: string, now: Date): boolean {
  const row = db.select().from(rateLimits).where(eq(rateLimits.key, key)).get()
  return Boolean(row?.blockedUntil && row.blockedUntil.getTime() > now.getTime())
}

function recordFailedLogin(db: AppDatabase, key: string, now: Date) {
  db.delete(rateLimits).where(lt(rateLimits.windowStartedAt, new Date(now.getTime() - 24 * 60 * 60 * 1000))).run()
  const row = db.select().from(rateLimits).where(eq(rateLimits.key, key)).get()
  if (!row || now.getTime() - row.windowStartedAt.getTime() > RATE_LIMIT_WINDOW_MS) {
    db.insert(rateLimits)
      .values({ key, attempts: 1, windowStartedAt: now, blockedUntil: null })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: { attempts: 1, windowStartedAt: now, blockedUntil: null },
      })
      .run()
    return
  }

  const attempts = row.attempts + 1
  db.update(rateLimits)
    .set({
      attempts,
      blockedUntil:
        attempts >= RATE_LIMIT_MAX_ATTEMPTS
          ? new Date(now.getTime() + RATE_LIMIT_WINDOW_MS)
          : null,
    })
    .where(eq(rateLimits.key, key))
    .run()
}

function clearFailedLogins(db: AppDatabase, key: string) {
  db.delete(rateLimits).where(eq(rateLimits.key, key)).run()
}

function oauthCookieOptions(config: ApiConfig, maxAge: number) {
  return {
    ...cookieOptions(config, maxAge),
    path: OAUTH_NONCE_COOKIE_PATH,
  }
}

/**
 * Drop both OAuth-attempt cookies. Called on every terminal callback path, so a
 * failed attempt cannot leave a nonce or a bound return target behind for a
 * later replay.
 */
function clearOauthCookies(c: AppContext, config: ApiConfig) {
  const options = {
    path: OAUTH_NONCE_COOKIE_PATH,
    secure: config.cookieSecure,
    sameSite: 'Lax' as const,
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  }
  deleteCookie(c, OAUTH_NONCE_COOKIE, options)
  deleteCookie(c, OAUTH_RETURN_COOKIE, options)
}

function redirectToWeb(
  c: AppContext,
  config: ApiConfig,
  result: string,
  returnTo: string | null = null,
) {
  return c.redirect(oauthResultDestination(config.webBaseUrl, result, returnTo), 302)
}

function redirectWechatProfileResult(
  c: AppContext,
  config: ApiConfig,
  result: string,
  returnTo: string | null = null,
) {
  return c.redirect(wechatProfileResultDestination(config.webBaseUrl, result, returnTo), 302)
}

function normalizeWechatNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 0x1f && codePoint !== 0x7f
    })
    .join('')
    .trim()
  return normalized ? Array.from(normalized).slice(0, 128).join('') : null
}

function normalizeWechatAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      !url.hostname ||
      url.username ||
      url.password
    ) return null
    return url.toString()
  } catch {
    return null
  }
}

function normalizeWechatProfileText(value: unknown, maxLength = 128): string | null {
  if (typeof value !== 'string') return null
  const normalized = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 0x1f && codePoint !== 0x7f
    })
    .join('')
    .trim()
  return normalized ? Array.from(normalized).slice(0, maxLength).join('') : null
}

function normalizeWechatSex(value: unknown): 0 | 1 | 2 | null {
  return value === 0 || value === 1 || value === 2 ? value : null
}

function normalizeWechatOpaqueId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= 255 ? normalized : null
}

function normalizeWechatPrivilege(value: unknown): string {
  const items = Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => normalizeWechatProfileText(item, 128))
        .filter((item): item is string => item !== null)
        .slice(0, 32)
    : []
  return JSON.stringify(items)
}

function bodySchemaError<T>(
  value: unknown,
  schema: z.ZodType<T>,
): T | null {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Builds the real HTTP app without binding a port. Tests inject an isolated
 * migrated database; production passes the persistent SQLite connection.
 */
export function createApp(options: AppOptions = {}): Hono<AppBindings> {
  const config = options.config ?? defaultTestConfig()
  const migrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url))
  const database = options.db ? null : createDatabase(':memory:', migrationsFolder)
  const db = options.db ?? database!.db
  const startedAt = options.startedAt ?? Date.now()
  const logRequests = options.logRequests ?? true
  const fetcher = options.fetcher ?? fetch
  /**
   * The single runtime reader for the persisted WeChat provider, shared by the
   * admin API and the resident OAuth flow (#113). It is built once per app
   * instance but resolves from the database on every call — never from a
   * startup snapshot — so an activation takes effect without a restart.
   */
  const wechatRuntime = (runtimeOptions: WechatRuntimeOptions = {}) =>
    resolveWechatRuntimeConfig(db, config.wechatConfigMasterKey, runtimeOptions)
  const app = new Hono<AppBindings>()

  app.use('*', async (c, next) => {
    const requestId = randomUUID()
    c.set('requestId', requestId)
    c.set('authSession', readAuthSession(db, getCookie(c, SESSION_COOKIE)))
    c.header('x-request-id', requestId)
    const requestStartedAt = performance.now()
    await next()
    if (logRequests) {
      logEvent('request.completed', {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(performance.now() - requestStartedAt),
      })
    }
  })

  app.get(API_ROUTES.health, (c) => {
    const payload: HealthResponse = {
      status: 'ok',
      service: SERVICE_NAME,
      version: options.version ?? process.env.npm_package_version ?? '0.0.0',
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      timestamp: new Date().toISOString(),
    }
    return c.json(healthResponseSchema.parse(payload))
  })

  app.get('/auth/methods', (c) => {
    // Same runtime reader as start/callback: the database active row, decrypted
    // with the master key. `not_configured` means no row is enabled yet; any
    // other failure means a row exists but cannot be used right now (missing or
    // wrong key, tampered ciphertext), which the H5 must not present as a
    // working login button. Neither branch leaks an id, key id or secret.
    const resolution = wechatRuntime()
    return c.json({
      wechat: resolution.ok,
      // Additive, untyped field: the H5 renders an explicit "unavailable plus
      // reason" state instead of a button that can never work.
      wechatUnavailableReason: resolution.ok
        ? null
        : resolution.reason === 'not_configured'
          ? API_ERROR_CODES.notConfigured
          : 'wechat_config_unavailable',
      developmentResidentLogin: config.nodeEnv !== 'production' && config.authDevEnabled,
    })
  })

  app.get('/auth/csrf', (c) => {
    const session = c.get('authSession')
    const current = getCookie(c, CSRF_COOKIE)
    const token = session && current && hashToken(current) === session.csrfHash ? current : randomToken()
    if (!session || token !== current) {
      if (session) {
        db.update(sessions)
          .set({ csrfHash: hashToken(token) })
          .where(eq(sessions.id, session.sessionId))
          .run()
      }
      setCookie(c, CSRF_COOKIE, token, {
        ...cookieOptions(config, config.sessionTtlSeconds),
        httpOnly: false,
      })
    }
    return c.json({ csrfToken: token })
  })

  app.get('/auth/session', (c) => {
    const session = c.get('authSession')
    if (!session) return c.json({ authenticated: false })
    const cookieToken = getCookie(c, CSRF_COOKIE)
    const csrfToken =
      cookieToken && hashToken(cookieToken) === session.csrfHash ? cookieToken : randomToken()
    if (csrfToken !== cookieToken) {
      db.update(sessions)
        .set({ csrfHash: hashToken(csrfToken) })
        .where(eq(sessions.id, session.sessionId))
        .run()
      setCookie(c, CSRF_COOKIE, csrfToken, {
        ...cookieOptions(config, config.sessionTtlSeconds),
        httpOnly: false,
      })
    }
    return c.json(sessionResponse(db, session, csrfToken))
  })

  app.post('/auth/login', async (c) => {
    if (!validCsrf(c, config)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败，请刷新页面后重试')
    }
    const body = bodySchemaError(await c.req.json().catch(() => null), staffLoginRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '用户名或密码格式不正确')

    const key = rateLimitKey(body.username)
    const now = new Date()
    if (isRateLimited(db, key, now)) {
      return fail(c, 429, API_ERROR_CODES.rateLimited, '登录尝试过多，请 15 分钟后重试')
    }

    const account = db
      .select({
        id: staffAccounts.id,
        userId: users.id,
        username: staffAccounts.username,
        passwordHash: staffAccounts.passwordHash,
        role: staffAccounts.role,
        status: staffAccounts.status,
        displayName: users.displayName,
      })
      .from(staffAccounts)
      .innerJoin(users, eq(staffAccounts.userId, users.id))
      .where(eq(staffAccounts.username, body.username.toLowerCase()))
      .get()

    const passwordValid = await verifyPassword(body.password, account?.passwordHash ?? '')
    if (!account || account.status !== 'active' || !passwordValid) {
      recordFailedLogin(db, key, now)
      return fail(c, 401, API_ERROR_CODES.unauthorized, '用户名或密码错误')
    }

    clearFailedLogins(db, key)
    const created = createSession(db, config, account.userId, account.id)
    recordAudit(db, account.userId, 'staff.login', account.id, { role: account.role })
    setSessionCookies(c, config, created.token, created.csrfToken)

    const response = {
      authenticated: true as const,
      user: { id: account.userId, displayName: account.displayName },
      staff: {
        id: account.id,
        username: account.username,
        role: account.role,
        communities: staffCommunities(db, account.id),
      },
      csrfToken: created.csrfToken,
    }
    return c.json(authSessionResponseSchema.parse(response))
  })

  app.post('/auth/logout', (c) => {
    const session = c.get('authSession')
    if (!session) {
      clearSessionCookies(c, config)
      return c.body(null, 204)
    }
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    db.delete(sessions).where(eq(sessions.id, session.sessionId)).run()
    recordAudit(db, session.userId, 'auth.logout', session.sessionId)
    clearSessionCookies(c, config)
    return c.body(null, 204)
  })

  app.post('/auth/dev/login', async (c) => {
    if (config.nodeEnv === 'production' || !config.authDevEnabled) {
      return fail(c, 404, API_ERROR_CODES.notFound, 'Not found')
    }
    if (!validCsrf(c, config)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    // #171 LL-IDENTITY-001: the development login creates an identity and a
    // session, nothing else. It used to accept `communityId` and insert a
    // residence row, which meant the test-only entry point could create exactly
    // the permanent attribution the product now forbids — and it made local tests
    // pass against behaviour production does not have. A caller that needs a
    // resident community must perform the same explicit
    // `POST /resident-community/confirm` a real resident does.
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      z.strictObject({
        displayName: z.string().trim().min(1).max(40),
      }),
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '测试登录信息不正确')

    const now = new Date()
    const userId = randomUUID()
    db.insert(users).values({ id: userId, displayName: body.displayName, createdAt: now, updatedAt: now }).run()
    const created = createSession(db, config, userId, null)
    setSessionCookies(c, config, created.token, created.csrfToken)
    return c.json(
      authSessionResponseSchema.parse({
        authenticated: true,
        user: { id: userId, displayName: body.displayName },
        staff: null,
        csrfToken: created.csrfToken,
      }),
    )
  })

  app.get('/auth/wechat/profile', (c) => {
    const session = c.get('authSession')
    if (!session) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录居民账户')
    if (session.staff) return fail(c, 403, API_ERROR_CODES.forbidden, '仅居民账户可以读取微信资料')

    const resolution = wechatRuntime()
    if (!resolution.ok) {
      return c.json(wechatProfileStatusSchema.parse({
        available: false,
        reason: resolution.reason === 'not_configured' ? 'not_configured' : 'configuration_unavailable',
      }))
    }

    const identity = db
      .select({
        nickname: wechatIdentities.nickname,
        avatarUrl: wechatIdentities.avatarUrl,
        profileAuthorizedAt: wechatIdentities.profileAuthorizedAt,
      })
      .from(wechatIdentities)
      .where(and(
        eq(wechatIdentities.userId, session.userId),
        eq(wechatIdentities.appId, resolution.config.appId),
      ))
      .get()

    if (!identity) {
      return c.json(wechatProfileStatusSchema.parse({
        available: false,
        reason: 'identity_not_bound',
      }))
    }
    if (!identity.profileAuthorizedAt) {
      return c.json(wechatProfileStatusSchema.parse({ available: true, authorized: false }))
    }
    return c.json(wechatProfileStatusSchema.parse({
      available: true,
      authorized: true,
      nickname: identity.nickname,
      avatarUrl: identity.avatarUrl,
      authorizedAt: identity.profileAuthorizedAt.toISOString(),
    }))
  })

  /**
   * Legacy #121 compatibility endpoint. New H5 builds never call this: complete
   * snsapi_userinfo consent is part of the normal WeChat login now. Keep the
   * endpoint temporarily so an older deployed H5 cannot strand a signed-in user;
   * the callback remains user-bound and cannot create or switch identities.
   */
  app.post('/auth/wechat/profile/start', (c) => {
    const session = c.get('authSession')
    if (!session) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录居民账户')
    if (session.staff) return fail(c, 403, API_ERROR_CODES.forbidden, '仅居民账户可以授权微信资料')
    if (!validCsrf(c, config, session)) return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 或来源校验失败')

    const resolution = wechatRuntime()
    if (!resolution.ok) {
      const code =
        resolution.reason === 'not_configured'
          ? API_ERROR_CODES.notConfigured
          : resolution.reason === 'master_key_unavailable'
            ? API_ERROR_CODES.wechatConfigMasterKeyUnavailable
            : resolution.reason === 'master_key_invalid'
              ? API_ERROR_CODES.wechatConfigMasterKeyUnavailable
              : API_ERROR_CODES.wechatConfigDecryptFailed
      return fail(c, 503, code, '微信资料授权配置当前不可用，请联系运营人员')
    }

    // A phone-only account or an account belonging to another AppID must not
    // acquire a new WeChat identity through the profile-consent path.
    const identity = db
      .select({ id: wechatIdentities.id })
      .from(wechatIdentities)
      .where(and(
        eq(wechatIdentities.userId, session.userId),
        eq(wechatIdentities.appId, resolution.config.appId),
      ))
      .get()
    if (!identity) {
      return fail(
        c,
        409,
        API_ERROR_CODES.wechatProfileIdentityMismatch,
        '当前账户未绑定此公众号微信身份，不能在资料授权时自动绑定其他微信账户',
      )
    }

    const now = new Date()
    const state = randomToken()
    const nonce = randomToken()
    db.delete(oauthStates).where(lt(oauthStates.expiresAt, now)).run()
    db.insert(oauthStates).values({
      id: randomUUID(),
      stateHash: hashToken(state),
      nonceHash: hashToken(nonce),
      communityId: null,
      configId: resolution.config.configId,
      purpose: 'profile',
      userId: session.userId,
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1_000),
      consumedAt: null,
      createdAt: now,
    }).run()

    const cookieOptionsForAttempt = oauthCookieOptions(config, OAUTH_STATE_TTL_SECONDS)
    setCookie(c, OAUTH_NONCE_COOKIE, nonce, cookieOptionsForAttempt)
    const returnCookie = bindReturnToCookie(state, '/me')
    if (returnCookie) {
      setCookie(c, OAUTH_RETURN_COOKIE, returnCookie, {
        ...cookieOptionsForAttempt,
        path: OAUTH_RETURN_COOKIE_PATH,
      })
    }

    const authorizeUrl = new URL('https://open.weixin.qq.com/connect/oauth2/authorize')
    authorizeUrl.search = new URLSearchParams({
      appid: resolution.config.appId,
      redirect_uri: wechatCallbackUrl(config.webBaseUrl),
      response_type: 'code',
      scope: 'snsapi_userinfo',
      state,
    }).toString()
    authorizeUrl.hash = 'wechat_redirect'
    return c.json(wechatProfileStartResponseSchema.parse({
      authorizationUrl: authorizeUrl.toString(),
    }))
  })

  app.get('/auth/wechat/start', (c) => {
    // The provider is resolved from the database on every request (no startup
    // snapshot), so activating a new version takes effect for the next start
    // without a restart. An unusable row fails closed with 503; a legacy env
    // provider can never silently take over.
    const resolution = wechatRuntime()
    if (!resolution.ok) {
      const message =
        resolution.reason === 'not_configured'
          ? '微信网页授权未配置：请管理员在后台启用公众号配置'
          : '微信网页授权配置当前不可用，请联系管理员'
      const code =
        resolution.reason === 'not_configured'
          ? API_ERROR_CODES.notConfigured
          : resolution.reason === 'master_key_unavailable'
            ? API_ERROR_CODES.wechatConfigMasterKeyUnavailable
            : API_ERROR_CODES.wechatConfigDecryptFailed
      return fail(c, 503, code, message)
    }
    const provider = resolution.config
    // Community attribution is derived, never accepted (#123). A client-supplied
    // `communityId` used to be honoured after an existence check, which meant any
    // caller could mint a residence in an arbitrary community by pasting a UUID
    // that happens to exist. It is now an explicit 400: silently ignoring it
    // would let a stale H5 look successful while attributing nothing.
    if (c.req.query('communityId') !== undefined) {
      return fail(
        c,
        400,
        API_ERROR_CODES.invalidRequest,
        '社区归属只能由活动上下文推导，请传入 activityId',
      )
    }
    let communityId: string | null = null
    const requestedActivityId = c.req.query('activityId')
    if (requestedActivityId !== undefined) {
      if (!isActivityId(requestedActivityId)) {
        return fail(c, 400, API_ERROR_CODES.invalidRequest, '活动参数无效')
      }
      // Same public-visibility rule as `GET /activities/public/:activityId`;
      // a draft, unknown or deleted activity resolves to nothing and is refused
      // rather than degraded, so an unusable activity id can never silently
      // produce an unattributed login.
      communityId = resolvePublicActivityCommunityId(db, requestedActivityId)
      if (!communityId) {
        return fail(c, 400, API_ERROR_CODES.invalidRequest, '活动不存在或不可公开访问')
      }
    }
    // A target that is present but not a same-origin resident path is a caller
    // bug or an attack, never something to silently ignore: fail before a state
    // is minted so no OAuth attempt exists that could land anywhere unexpected.
    const returnToCheck = resolveReturnTo(c.req.query('returnTo'), config.webBaseUrl)
    if (!returnToCheck.ok) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '回跳地址无效，只能回到本站居民页面')
    }

    const state = randomToken()
    const nonce = randomToken()
    const now = new Date()
    db.delete(oauthStates).where(lt(oauthStates.expiresAt, now)).run()
    db.insert(oauthStates)
      .values({
        id: randomUUID(),
        stateHash: hashToken(state),
        nonceHash: hashToken(nonce),
        communityId: communityId,
        // Pin the exact provider version this attempt started with. The callback
        // must use this row even if a newer one became active meanwhile.
        configId: provider.configId,
        purpose: 'login',
        userId: null,
        expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000),
        consumedAt: null,
        createdAt: now,
      })
      .run()

    setCookie(c, OAUTH_NONCE_COOKIE, nonce, oauthCookieOptions(config, OAUTH_STATE_TTL_SECONDS))
    const boundReturnTo = bindReturnToCookie(state, returnToCheck.returnTo)
    if (boundReturnTo) {
      setCookie(
        c,
        OAUTH_RETURN_COOKIE,
        boundReturnTo,
        oauthCookieOptions(config, OAUTH_STATE_TTL_SECONDS),
      )
    } else {
      // A fresh attempt without a target must not inherit an older target.
      deleteCookie(c, OAUTH_RETURN_COOKIE, {
        path: OAUTH_RETURN_COOKIE_PATH,
        secure: config.cookieSecure,
        sameSite: 'Lax',
        ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
      })
    }
    const authorizeUrl = new URL('https://open.weixin.qq.com/connect/oauth2/authorize')
    authorizeUrl.search = new URLSearchParams({
      appid: provider.appId,
      // Derived, never configured: the same value the admin page shows as the
      // read-only redirect URI and the one registered in the WeChat console.
      redirect_uri: wechatCallbackUrl(config.webBaseUrl),
      response_type: 'code',
      scope: 'snsapi_userinfo',
      state,
    }).toString()
    authorizeUrl.hash = 'wechat_redirect'
    return c.redirect(authorizeUrl.toString(), 302)
  })

  app.get('/auth/wechat/callback', async (c) => {
    const nonce = getCookie(c, OAUTH_NONCE_COOKIE)
    const state = c.req.query('state') ?? null
    const code = c.req.query('code')
    const oauthError = c.req.query('errcode')
    // No provider has ever been enabled: nothing can be exchanged, and the H5
    // has a dedicated readable message for this case. This is the only early
    // exit — once a provider exists the attempt itself decides, including when
    // the currently active version has since become unusable.
    const activeResolution = wechatRuntime()
    // Only the target minted together with this attempt is honoured, and only
    // after re-validating it. Anything else falls back to the default page.
    const boundReturnTo = readBoundReturnTo(
      getCookie(c, OAUTH_RETURN_COOKIE),
      state,
      config.webBaseUrl,
    )

    const now = new Date()
    const stateRecord = state
      ? db
          .select()
          .from(oauthStates)
          .where(eq(oauthStates.stateHash, hashToken(state)))
          .get()
      : null
    const isProfileState = stateRecord?.purpose === 'profile'
    // Preserve the established login-cancellation contract: login denial does
    // not consume the attempt. Profile consent is different and is consumed
    // below, after its user-bound state and current session are validated.
    if (!isProfileState && (oauthError || !code)) {
      clearOauthCookies(c, config)
      return redirectToWeb(c, config, 'wechat_authorization_failed', boundReturnTo)
    }
    if (!activeResolution.ok && activeResolution.reason === 'not_configured' && !stateRecord) {
      clearOauthCookies(c, config)
      return redirectToWeb(c, config, 'wechat_not_configured', boundReturnTo)
    }

    if (!state || !nonce) {
      clearOauthCookies(c, config)
      return isProfileState
        ? redirectWechatProfileResult(c, config, 'state_invalid', boundReturnTo)
        : redirectToWeb(c, config, 'wechat_state_invalid', boundReturnTo)
    }
    if (
      !stateRecord ||
      stateRecord.consumedAt ||
      stateRecord.expiresAt.getTime() <= now.getTime() ||
      !constantTimeTextEqual(stateRecord.nonceHash, hashToken(nonce))
    ) {
      clearOauthCookies(c, config)
      return isProfileState
        ? redirectWechatProfileResult(c, config, 'state_invalid', boundReturnTo)
        : redirectToWeb(c, config, 'wechat_state_invalid', boundReturnTo)
    }

    const consumed = db
      .update(oauthStates)
      .set({ consumedAt: now })
      .where(
        and(
          eq(oauthStates.id, stateRecord.id),
          isNull(oauthStates.consumedAt),
          gt(oauthStates.expiresAt, now),
        ),
      )
      .run()
    if (consumed.changes !== 1) {
      clearOauthCookies(c, config)
      return isProfileState
        ? redirectWechatProfileResult(c, config, 'state_replayed', boundReturnTo)
        : redirectToWeb(c, config, 'wechat_state_replayed', boundReturnTo)
    }

    if (isProfileState) {
      const currentSession = c.get('authSession')
      if (
        !stateRecord.userId ||
        !currentSession ||
        currentSession.userId !== stateRecord.userId ||
        currentSession.staff
      ) {
        clearOauthCookies(c, config)
        return redirectWechatProfileResult(c, config, 'session_mismatch', boundReturnTo)
      }
    }

    if (isProfileState && (oauthError || !code)) {
      clearOauthCookies(c, config)
      return redirectWechatProfileResult(
        c,
        config,
        (!code || oauthError === 'authdeny') ? 'cancelled' : 'authorization_failed',
        boundReturnTo,
      )
    }
    if (!code) {
      clearOauthCookies(c, config)
      return redirectToWeb(c, config, 'wechat_authorization_failed', boundReturnTo)
    }

    // The state is consumed before any provider call, so a retry can never use
    // the code twice. Resolve the EXACT version this attempt started with — an
    // active or retired row — never whatever is active now. A pre-#113 state has
    // no `configId`; a row that is gone or cannot be decrypted must fail closed
    // instead of borrowing another account's secret.
    const boundConfigId = stateRecord.configId
    if (!boundConfigId) {
      clearOauthCookies(c, config)
      return isProfileState
        ? redirectWechatProfileResult(c, config, 'state_invalid', boundReturnTo)
        : redirectToWeb(c, config, 'wechat_state_invalid', boundReturnTo)
    }
    const boundResolution = wechatRuntime({ configId: boundConfigId })
    if (
      !boundResolution.ok ||
      (boundResolution.config.status !== 'active' &&
        boundResolution.config.status !== 'retired')
    ) {
      clearOauthCookies(c, config)
      return isProfileState
        ? redirectWechatProfileResult(c, config, 'configuration_unavailable', boundReturnTo)
        : redirectToWeb(c, config, 'wechat_config_unavailable', boundReturnTo)
    }
    const provider = boundResolution.config

    try {
      const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
      tokenUrl.search = new URLSearchParams({
        appid: provider.appId,
        secret: provider.appSecret,
        code,
        grant_type: 'authorization_code',
      }).toString()
      const response = await fetcher(tokenUrl, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) {
        clearOauthCookies(c, config)
        return isProfileState
          ? redirectWechatProfileResult(c, config, 'provider_unavailable', boundReturnTo)
          : redirectToWeb(c, config, 'wechat_provider_unavailable', boundReturnTo)
      }
      const tokenPayload = (await response.json()) as {
        access_token?: string
        openid?: string
        unionid?: string
        errcode?: number | string
      }
      if (!tokenPayload.openid || tokenPayload.errcode) {
        clearOauthCookies(c, config)
        return isProfileState
          ? redirectWechatProfileResult(c, config, 'provider_unavailable', boundReturnTo)
          : redirectToWeb(c, config, 'wechat_identity_unavailable', boundReturnTo)
      }
      if (!tokenPayload.access_token) {
        // snsapi_userinfo login is not complete until a profile access token is
        // present; never create an OpenID-only resident as a fallback.
        clearOauthCookies(c, config)
        return isProfileState
          ? redirectWechatProfileResult(c, config, 'provider_unavailable', boundReturnTo)
          : redirectToWeb(c, config, 'wechat_provider_unavailable', boundReturnTo)
      }

      let profileIdentity: { id: string; userId: string; unionId: string | null } | null = null
      if (isProfileState) {
        const boundUserId = stateRecord.userId
        if (!boundUserId) {
          clearOauthCookies(c, config)
          return redirectWechatProfileResult(c, config, 'provider_unavailable', boundReturnTo)
        }
        // Legacy profile-consent attempts remain bound to the exact account that
        // minted the state. This branch exists only for older H5/in-flight states.
        profileIdentity = db
          .select({
            id: wechatIdentities.id,
            userId: wechatIdentities.userId,
            unionId: wechatIdentities.unionId,
          })
          .from(wechatIdentities)
          .where(and(
            eq(wechatIdentities.appId, provider.appId),
            eq(wechatIdentities.openId, tokenPayload.openid),
          ))
          .get() ?? null
        if (!profileIdentity || profileIdentity.userId !== boundUserId) {
          clearOauthCookies(c, config)
          return redirectWechatProfileResult(c, config, 'identity_mismatch', boundReturnTo)
        }
      }

      // #256: every successful WeChat login is a complete profile authorization.
      // Fetch before any identity/user write so provider failure can never leave a
      // half-created "微信用户" row behind.
      const userInfoUrl = new URL('https://api.weixin.qq.com/sns/userinfo')
      userInfoUrl.search = new URLSearchParams({
        access_token: tokenPayload.access_token,
        openid: tokenPayload.openid,
        lang: 'zh_CN',
      }).toString()
      const userInfoResponse = await fetcher(userInfoUrl, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!userInfoResponse.ok) {
        clearOauthCookies(c, config)
        return isProfileState
          ? redirectWechatProfileResult(c, config, 'provider_unavailable', boundReturnTo)
          : redirectToWeb(c, config, 'wechat_provider_unavailable', boundReturnTo)
      }
      const userInfoPayload = (await userInfoResponse.json()) as {
        openid?: string
        unionid?: string
        nickname?: string
        sex?: number
        province?: string
        city?: string
        country?: string
        headimgurl?: string
        privilege?: unknown
        errcode?: number | string
      }
      if (userInfoPayload.errcode) {
        clearOauthCookies(c, config)
        return isProfileState
          ? redirectWechatProfileResult(c, config, 'provider_unavailable', boundReturnTo)
          : redirectToWeb(c, config, 'wechat_provider_unavailable', boundReturnTo)
      }
      if (!userInfoPayload.openid || userInfoPayload.openid !== tokenPayload.openid) {
        clearOauthCookies(c, config)
        return isProfileState
          ? redirectWechatProfileResult(c, config, 'identity_mismatch', boundReturnTo)
          : redirectToWeb(c, config, 'wechat_identity_unavailable', boundReturnTo)
      }

      const nickname = normalizeWechatNickname(userInfoPayload.nickname)
      const avatarUrl = normalizeWechatAvatarUrl(userInfoPayload.headimgurl)
      const sex = normalizeWechatSex(userInfoPayload.sex)
      const province = normalizeWechatProfileText(userInfoPayload.province)
      const city = normalizeWechatProfileText(userInfoPayload.city)
      const country = normalizeWechatProfileText(userInfoPayload.country)
      const privilegeJson = normalizeWechatPrivilege(userInfoPayload.privilege)
      const unionId =
        normalizeWechatOpaqueId(tokenPayload.unionid) ??
        normalizeWechatOpaqueId(userInfoPayload.unionid)
      const profileValues = {
        nickname,
        avatarUrl,
        sex,
        province,
        city,
        country,
        privilegeJson,
        profileAuthorizedAt: now,
        profileUpdatedAt: now,
      }

      if (isProfileState) {
        const boundUserId = stateRecord.userId!
        const saved = db.transaction((tx) => {
          const currentIdentity = tx
            .select({
              id: wechatIdentities.id,
              userId: wechatIdentities.userId,
              unionId: wechatIdentities.unionId,
            })
            .from(wechatIdentities)
            .where(and(
              eq(wechatIdentities.id, profileIdentity!.id),
              eq(wechatIdentities.appId, provider.appId),
              eq(wechatIdentities.openId, tokenPayload.openid!),
            ))
            .get()
          if (!currentIdentity || currentIdentity.userId !== boundUserId) return false
          const updated = tx
            .update(wechatIdentities)
            .set({
              ...profileValues,
              unionId: unionId ?? currentIdentity.unionId,
            })
            .where(and(
              eq(wechatIdentities.id, currentIdentity.id),
              eq(wechatIdentities.userId, boundUserId),
            ))
            .run()
          return updated.changes === 1
        })
        if (!saved) {
          clearOauthCookies(c, config)
          return redirectWechatProfileResult(c, config, 'identity_mismatch', boundReturnTo)
        }

        clearOauthCookies(c, config)
        return redirectWechatProfileResult(c, config, 'success', boundReturnTo)
      }

      const userId = db.transaction((tx) => {
        const identity = tx
          .select({
            id: wechatIdentities.id,
            userId: wechatIdentities.userId,
            unionId: wechatIdentities.unionId,
          })
          .from(wechatIdentities)
          .where(
            and(
              eq(wechatIdentities.appId, provider.appId),
              eq(wechatIdentities.openId, tokenPayload.openid!),
            ),
          )
          .get()

        if (identity) {
          tx.update(wechatIdentities)
            .set({
              ...profileValues,
              unionId: unionId ?? identity.unionId,
            })
            .where(eq(wechatIdentities.id, identity.id))
            .run()

          // Historical pre-#256 accounts often still carry the generated
          // "微信用户" placeholder. Upgrade only that sentinel/null value;
          // a resident's real platform display name is never overwritten.
          const currentUser = tx
            .select({ displayName: users.displayName })
            .from(users)
            .where(eq(users.id, identity.userId))
            .get()
          if (
            nickname &&
            currentUser &&
            (currentUser.displayName === null || currentUser.displayName === '微信用户')
          ) {
            tx.update(users)
              .set({ displayName: nickname, updatedAt: now })
              .where(eq(users.id, identity.userId))
              .run()
          }
          return identity.userId
        }

        const resolvedUserId = randomUUID()
        tx.insert(users)
          .values({
            id: resolvedUserId,
            displayName: nickname ?? '微信用户',
            createdAt: now,
            updatedAt: now,
          })
          .run()
        tx.insert(wechatIdentities)
          .values({
            id: randomUUID(),
            userId: resolvedUserId,
            appId: provider.appId,
            openId: tokenPayload.openid!,
            unionId,
            ...profileValues,
            createdAt: now,
          })
          .run()
        // #171 LL-IDENTITY-001: login authenticates identity only. The activity
        // community remains a candidate requiring explicit resident confirmation.
        return resolvedUserId
      })

      // A successful login may leave the resident ONE server-derived suggestion:
      // the community the activityId resolved to. It is never a permanent bind.
      if (stateRecord.communityId) {
        recordBindingCandidate(db, {
          userId,
          communityId: stateRecord.communityId,
          source: 'activity_oauth_candidate',
          now,
        })
      }
      const created = createSession(db, config, userId, null)
      setSessionCookies(c, config, created.token, created.csrfToken)
      clearOauthCookies(c, config)
      return redirectToWeb(c, config, 'success', boundReturnTo)
    } catch (error) {
      logEvent('wechat.oauth.failed', {
        requestId: c.get('requestId'),
        errorType: error instanceof Error ? error.name : 'unknown',
      })
      clearOauthCookies(c, config)
      return isProfileState
        ? redirectWechatProfileResult(c, config, 'provider_unavailable', boundReturnTo)
        : redirectToWeb(c, config, 'wechat_provider_unavailable', boundReturnTo)
    }
  })

  /** Public community search is browse-only; location never changes resident identity. */
  app.get(PUBLIC_COMMUNITY_ROUTE, (c) => {
    const input = publicCommunityQuerySchema.safeParse({
      q: c.req.query('q'),
      latitude: c.req.query('latitude'),
      longitude: c.req.query('longitude'),
    })
    if (!input.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '社区查询参数不正确')
    }
    c.header('Cache-Control', 'no-store')
    return c.json(listPublicCommunities(db, input.data))
  })

  app.get('/admin/communities', (c) => {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    const selection = {
      id: communities.id,
      name: communities.name,
      address: communities.address,
      latitudeGcj02: communities.latitudeGcj02,
      longitudeGcj02: communities.longitudeGcj02,
    }
    const result =
      session.staff.role === 'admin'
        ? db.select(selection).from(communities).all()
        : db.select(selection).from(communities)
          .innerJoin(staffCommunityAssignments, eq(staffCommunityAssignments.communityId, communities.id))
          .where(eq(staffCommunityAssignments.staffAccountId, session.staff.id)).all()
    return c.json({ items: result })
  })

  // Tencent map picker keys are browser-visible identifiers, not AppSecrets.
  // SQLite is the sole runtime source; admin changes are effective without restart.
  const getTencentMapConfig = () => db.select().from(tencentMapConfigs)
    .where(eq(tencentMapConfigs.id, 'default')).get()
  const mapSummary = () => {
    const current = getTencentMapConfig()
    return tencentMapConfigStatusSchema.parse({
      configured: Boolean(current),
      enabled: current?.enabled ?? false,
      keyHint: current ? `••••${current.apiKey.slice(-4)}` : null,
      appName: current?.appName ?? null,
      updatedAt: current?.updatedAt.toISOString() ?? null,
    })
  }
  const requireMapAdmin = (c: AppContext): Response | null => {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    if (session.staff.role !== 'admin') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '只有管理员可以配置腾讯地图')
    }
    return null
  }

  app.get(TENCENT_MAP_ADMIN_ROUTES.config, (c) => {
    const denied = requireMapAdmin(c)
    if (denied) return denied
    c.header('Cache-Control', 'no-store')
    return c.json(mapSummary())
  })

  app.put(TENCENT_MAP_ADMIN_ROUTES.config, async (c) => {
    const denied = requireMapAdmin(c)
    if (denied) return denied
    const session = c.get('authSession')!
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const body = bodySchemaError(await c.req.json().catch(() => null), saveTencentMapConfigRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '地图 Key 格式不正确')
    const now = new Date()
    db.insert(tencentMapConfigs).values({
      id: 'default', apiKey: body.key, appName: body.appName, enabled: true, updatedAt: now,
    }).onConflictDoUpdate({
      target: tencentMapConfigs.id,
      set: { apiKey: body.key, appName: body.appName, enabled: true, updatedAt: now },
    }).run()
    recordAudit(db, session.userId, 'tencent_map.config_saved', 'default')
    c.header('Cache-Control', 'no-store')
    return c.json(mapSummary())
  })

  app.patch(TENCENT_MAP_ADMIN_ROUTES.enabled, async (c) => {
    const denied = requireMapAdmin(c)
    if (denied) return denied
    const session = c.get('authSession')!
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const body = bodySchemaError(await c.req.json().catch(() => null), setTencentMapEnabledRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '地图配置状态不正确')
    if (!getTencentMapConfig()) return fail(c, 409, API_ERROR_CODES.conflict, '请先保存腾讯地图 Key')
    db.update(tencentMapConfigs).set({
      enabled: body.enabled,
      updatedAt: new Date(),
    }).where(eq(tencentMapConfigs.id, 'default')).run()
    recordAudit(db, session.userId, body.enabled
      ? 'tencent_map.enabled' : 'tencent_map.disabled', 'default')
    c.header('Cache-Control', 'no-store')
    return c.json(mapSummary())
  })

  app.get(TENCENT_MAP_ADMIN_ROUTES.pickerConfig, (c) => {
    const denied = requireMapAdmin(c)
    if (denied) return denied
    c.header('Cache-Control', 'no-store')
    const current = getTencentMapConfig()
    return c.json(tencentMapPickerConfigSchema.parse(
      current?.enabled ? { available: true, key: current.apiKey, appName: current.appName } : { available: false },
    ))
  })

  app.post('/admin/communities', async (c) => {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    if (session.staff.role !== 'admin') return fail(c, 403, API_ERROR_CODES.forbidden, '只有管理员可以创建社区')
    if (!validCsrf(c, config, session)) return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    const body = bodySchemaError(await c.req.json().catch(() => null), createCommunityRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '社区信息不正确')

    const id = randomUUID()
    db.insert(communities).values({
      id,
      name: body.name,
      address: body.location?.address ?? null,
      latitudeGcj02: body.location?.latitude ?? null,
      longitudeGcj02: body.location?.longitude ?? null,
      createdAt: new Date(),
    }).run()
    recordAudit(db, session.userId, 'community.created', id)
    return c.json({ id, name: body.name }, 201)
  })

  app.patch('/admin/communities/:communityId/location', async (c) => {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    if (session.staff.role !== 'admin') return fail(c, 403, API_ERROR_CODES.forbidden, '只有管理员可以管理社区位置')
    if (!validCsrf(c, config, session)) return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    const communityId = c.req.param('communityId')
    const current = db.select({ id: communities.id }).from(communities)
      .where(eq(communities.id, communityId)).get()
    if (!current) return fail(c, 404, API_ERROR_CODES.notFound, '社区不存在')
    const location = bodySchemaError(await c.req.json().catch(() => null), communityLocationSchema)
    if (!location) return fail(c, 400, API_ERROR_CODES.invalidRequest, '社区位置不正确')
    db.update(communities).set({
      address: location.address,
      latitudeGcj02: location.latitude,
      longitudeGcj02: location.longitude,
    }).where(eq(communities.id, communityId)).run()
    recordAudit(db, session.userId, 'community.location_updated', communityId)
    return c.json({ id: communityId, location })
  })

  app.get('/admin/staff', (c) => {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    if (session.staff.role !== 'admin') return fail(c, 403, API_ERROR_CODES.forbidden, '只有管理员可以管理后台账户')

    const staff = db
      .select({
        id: staffAccounts.id,
        userId: users.id,
        username: staffAccounts.username,
        displayName: users.displayName,
        role: staffAccounts.role,
        status: staffAccounts.status,
      })
      .from(staffAccounts)
      .innerJoin(users, eq(staffAccounts.userId, users.id))
      .all()
      .map((account) => ({
        ...account,
        communities: staffCommunities(db, account.id),
      }))
    return c.json({ items: staff })
  })

  app.post('/admin/staff', async (c) => {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    if (session.staff.role !== 'admin') return fail(c, 403, API_ERROR_CODES.forbidden, '只有管理员可以创建后台账户')
    if (!validCsrf(c, config, session)) return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    const body = bodySchemaError(await c.req.json().catch(() => null), createStaffAccountRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '账户信息不正确')

    const communityRows = db
      .select({ id: communities.id })
      .from(communities)
      .where(inArray(communities.id, body.communityIds))
      .all()
    if (new Set(body.communityIds).size !== body.communityIds.length || communityRows.length !== body.communityIds.length) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '所选社区不存在或重复')
    }
    if (db.select().from(staffAccounts).where(eq(staffAccounts.username, body.username.toLowerCase())).get()) {
      return fail(c, 409, API_ERROR_CODES.conflict, '登录账号已存在')
    }

    const existingUser = body.userId
      ? db.select().from(users).where(eq(users.id, body.userId)).get()
      : null
    if (body.userId && !existingUser) {
      return fail(c, 404, API_ERROR_CODES.notFound, '要关联的居民账户不存在')
    }
    if (
      body.userId &&
      !db.select().from(wechatIdentities).where(eq(wechatIdentities.userId, body.userId)).get()
    ) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '只能关联已完成微信授权的居民账户')
    }
    if (
      body.userId &&
      db.select().from(staffAccounts).where(eq(staffAccounts.userId, body.userId)).get()
    ) {
      return fail(c, 409, API_ERROR_CODES.conflict, '该居民账户已经关联后台身份')
    }

    const now = new Date()
    const userId = body.userId ?? randomUUID()
    const displayName = existingUser?.displayName || body.displayName
    const staffId = randomUUID()
    const passwordHash = await hashPassword(body.password)
    try {
      db.transaction((tx) => {
        if (!body.userId) {
          tx.insert(users)
            .values({ id: userId, displayName, createdAt: now, updatedAt: now })
            .run()
        } else if (!existingUser?.displayName) {
          tx.update(users).set({ displayName, updatedAt: now }).where(eq(users.id, userId)).run()
        }
        tx.insert(staffAccounts)
          .values({
            id: staffId,
            userId,
            username: body.username.toLowerCase(),
            passwordHash,
            role: body.role,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          })
          .run()
        tx.insert(staffCommunityAssignments)
          .values(body.communityIds.map((communityId) => ({
            staffAccountId: staffId,
            communityId,
            createdAt: now,
          })))
          .run()
        tx.insert(auditLogs)
          .values({
            id: randomUUID(),
            actorUserId: session.userId,
            event: 'staff.created',
            targetId: staffId,
            metadata: JSON.stringify({ role: body.role }),
            createdAt: now,
          })
          .run()
      })
    } catch (error) {
      if (error instanceof Error && /unique/i.test(error.message)) {
        return fail(c, 409, API_ERROR_CODES.conflict, '登录账号已存在')
      }
      throw error
    }

    return c.json(
      {
        id: staffId,
        userId,
        username: body.username.toLowerCase(),
        displayName,
        role: body.role,
        status: 'active',
        communities: staffCommunities(db, staffId),
      },
      201,
    )
  })

  app.get(CRM_ROUTES.residentList, (c) => {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')

    const parsed = residentDirectoryQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    )
    if (!parsed.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '社区、页码或搜索条件无效')
    }
    const { communityId, page, pageSize, keyword } = parsed.data

    // Permission checking must happen before any directory count, search or
    // profile join. Never broaden the requested community for staff users.
    if (session.staff.role !== 'admin') {
      const assignment = db
        .select({ staffAccountId: staffCommunityAssignments.staffAccountId })
        .from(staffCommunityAssignments)
        .where(and(
          eq(staffCommunityAssignments.staffAccountId, session.staff.id),
          eq(staffCommunityAssignments.communityId, communityId),
        ))
        .get()
      if (!assignment) return fail(c, 403, API_ERROR_CODES.forbidden, '无权查看该社区居民')
    } else if (!db.select({ id: communities.id }).from(communities).where(eq(communities.id, communityId)).get()) {
      return fail(c, 404, API_ERROR_CODES.notFound, '社区不存在')
    }

    // #121 consents to profiles for a specific public-account identity. Show
    // only the currently active AppID, consistent with /auth/wechat/profile.
    // Scalar subqueries avoid multiplying residents when a user has multiple
    // identities; (user_id) already has a SQLite index.
    const activeAppId = db
      .select({ appId: wechatOauthConfigs.appId })
      .from(wechatOauthConfigs)
      .where(eq(wechatOauthConfigs.status, 'active'))
      .get()?.appId ?? null
    const profileWhere = sql`wi.user_id = ${users.id} AND wi.app_id = ${activeAppId}
      AND wi.profile_authorized_at IS NOT NULL`
    const nickname = sql<string | null>`(
      SELECT wi.nickname FROM wechat_identities wi WHERE ${profileWhere}
      ORDER BY wi.profile_authorized_at DESC, wi.id ASC LIMIT 1
    )`
    const avatarUrl = sql<string | null>`(
      SELECT wi.avatar_url FROM wechat_identities wi WHERE ${profileWhere}
      ORDER BY wi.profile_authorized_at DESC, wi.id ASC LIMIT 1
    )`
    const authorizedAt = sql<number | null>`(
      SELECT wi.profile_authorized_at FROM wechat_identities wi WHERE ${profileWhere}
      ORDER BY wi.profile_authorized_at DESC, wi.id ASC LIMIT 1
    )`

    // LIKE is a literal substring search: %, _ and backslash in the user
    // keyword must not become wildcards. All values are parameter-bound.
    const escaped = keyword?.replace(/[\\%_]/g, (char) => String.fromCharCode(92) + char)
    const pattern = escaped ? `%${escaped}%` : null
    const search = pattern
      ? or(
          sql`${users.id} LIKE ${pattern} ESCAPE ${'\\'}`,
          sql`${users.displayName} LIKE ${pattern} ESCAPE ${'\\'}`,
          sql`EXISTS (
            SELECT 1 FROM wechat_identities wi
            WHERE ${profileWhere} AND wi.nickname LIKE ${pattern} ESCAPE ${'\\'}
          )`,
        )
      : undefined
    // #171 LL-IDENTITY-001: this directory must not present a historical relation
    // as a confirmed permanent community. A resident is listed for a community
    // either because they confirmed it themself (the binding table, the single
    // source of truth) or because a historical `resident_community_assignments`
    // row exists (an observation, including the rows the retired #123 login wrote
    // automatically). Each item therefore carries `communityRelationSource` plus
    // the timestamp of *that* relation, so the back office can tell the two apart
    // and never shows "已确认" for a legacy row.
    const confirmedAt = sql<number | null>`(
      SELECT b.confirmed_at FROM resident_community_bindings b
      WHERE b.user_id = ${users.id} AND b.community_id = ${communityId}
      LIMIT 1
    )`
    const legacyAt = sql<number | null>`(
      SELECT a.created_at FROM resident_community_assignments a
      WHERE a.user_id = ${users.id} AND a.community_id = ${communityId}
      LIMIT 1
    )`
    const relationAt = sql<number>`COALESCE(${confirmedAt}, ${legacyAt})`
    const relationSource = sql<'confirmed_binding' | 'historical_assignment'>`(
      CASE WHEN ${confirmedAt} IS NOT NULL THEN 'confirmed_binding'
           ELSE 'historical_assignment' END
    )`
    const relationFilter = or(sql`${confirmedAt} IS NOT NULL`, sql`${legacyAt} IS NOT NULL`)

    const scope = and(relationFilter, search)
    const total = db.select({ total: count() })
      .from(users)
      .where(scope)
      .get()?.total ?? 0
    const rows = db.select({
        id: users.id,
        localDisplayName: users.displayName,
        createdAt: users.createdAt,
        relationAt,
        communityRelationSource: relationSource,
        wechatNickname: nickname,
        wechatAvatarUrl: avatarUrl,
        profileAuthorizedAt: authorizedAt,
      })
      .from(users)
      .where(scope)
      .orderBy(desc(relationAt), asc(users.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all()
    return c.json(residentDirectoryResponseSchema.parse({
      items: rows.map((resident) => ({
        id: resident.id,
        localDisplayName: resident.localDisplayName,
        displayName: resident.wechatNickname?.trim()
          || resident.localDisplayName?.trim() || '微信用户',
        // Do not display a profile unless the resident authorized it.
        wechatNickname: resident.profileAuthorizedAt ? resident.wechatNickname : null,
        wechatAvatarUrl: resident.profileAuthorizedAt ? resident.wechatAvatarUrl : null,
        profileAuthorizedAt: resident.profileAuthorizedAt
          ? new Date(resident.profileAuthorizedAt).toISOString() : null,
        createdAt: resident.createdAt.toISOString(),
        joinedAt: new Date(resident.relationAt).toISOString(),
        communityRelationSource: resident.communityRelationSource,
      })),
      total,
      page,
      pageSize,
    }))
  })

  registerActivityRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
  })

  // Back-office user directory (#153 LL-USER-001): a users-table-rooted read
  // surface next to the legacy, community-rooted `/crm/residents` directory.
  registerUserDirectoryRoutes(app, {
    db,
    fail,
  })

  registerCrmRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
  })

  registerParticipationRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
  })

  // Read-only consumption-team effective-paid progress (#210 LL-PUR-005).
  // No writes, no coupon state: both surfaces recompute from verified orders and
  // their linked manual receipts.
  registerPurchaseRewardRoutes(app, {
    db,
    fail,
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  // Resident permanent community (#171 LL-IDENTITY-001): the one read behind
  // 未绑定/已确认/待核查/冲突 plus the resident's explicit first confirmation.
  // No rebind/unbind route exists; see `resident-community` contract docs.
  registerResidentProfileRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
    now: options.now ?? (() => new Date()),
  })

  registerResidentCommunityRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
  })

  registerLocalCatalogRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
  })

  registerExternalOfferRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
  }, options.now ? () => options.now!() : undefined)

  registerLocalOrderRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
  })

  // Ledger + settlement (LL-MVP-008, Issue #64 and follow-ups) is mounted after
  // the local order routes, since its facts are derived from them. The group
  // additionally registers reconciliation **before** the read-only ledger
  // skeleton because Hono matches in registration order and the skeleton owns
  // read-only GETs of some of the same paths; see `routes/ledger-route-group.ts`.
  registerLedgerRouteGroup(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
    now: options.now,
  })

  registerRewardRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
  })

  registerDrawRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
  })

  registerCrmebRoutes(app, {
    db,
    config,
    fetcher,
    fail,
    validCsrf,
    bodySchemaError,
  })

  registerWechatAdminRoutes(app, {
    db,
    config,
    fetcher,
    resolveRuntime: wechatRuntime,
    fail,
    validCsrf,
    bodySchemaError,
    now: options.now ?? (() => new Date()),
  })

  registerWechatJsSdkRoutes(app, {
    config,
    fetcher,
    resolveRuntime: wechatRuntime,
    fail,
    nowMs: options.now ? () => options.now!().getTime() : () => Date.now(),
  })

  registerPhoneAuthRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
    createSession,
    setSessionCookies,
    smsSender: options.smsSender,
    now: options.now ?? (() => new Date()),
  })

  app.notFound((c) =>
    c.json(errorBody(API_ERROR_CODES.notFound, `No route for ${c.req.method} ${c.req.path}`, c.get('requestId')), 404),
  )

  app.onError((error, c) => {
    logEvent('request.failed', {
      requestId: c.get('requestId'),
      path: c.req.path,
      errorType: error instanceof Error ? error.name : 'unknown',
    })
    return c.json(
      errorBody(API_ERROR_CODES.internal, 'Internal server error', c.get('requestId')),
      500,
    )
  })

  return app
}

function defaultTestConfig(): ApiConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 4080,
    databasePath: ':memory:',
    sessionTtlSeconds: 7 * 24 * 60 * 60,
    cookieSecure: false,
    trustedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174'],
    webBaseUrl: 'http://localhost:5173',
    authDevEnabled: false,
  }
}
