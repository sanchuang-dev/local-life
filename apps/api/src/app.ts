import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { and, eq, gt, inArray, isNull, lt } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  API_ERROR_CODES,
  API_ROUTES,
  SERVICE_NAME,
  authSessionResponseSchema,
  createCommunityRequestSchema,
  createStaffAccountRequestSchema,
  healthResponseSchema,
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
  oauthStates,
  rateLimits,
  residentCommunityAssignments,
  sessions,
  staffAccounts,
  staffCommunityAssignments,
  users,
  wechatIdentities,
} from './db/schema.js'
import { constantTimeTextEqual, hashPassword, hashToken, randomToken, verifyPassword } from './auth/security.js'
import { logEvent } from './log.js'
import { registerActivityRoutes } from './activities/routes.js'
import { registerCrmRoutes } from './crm/routes.js'
import { registerParticipationRoutes } from './participation/routes.js'
import { registerCrmebRoutes } from './crmeb/routes.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from './http.js'

export interface AppOptions {
  version?: string
  startedAt?: number
  logRequests?: boolean
  db?: AppDatabase
  config?: ApiConfig
  fetcher?: typeof fetch
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

function redirectToWeb(
  c: AppContext,
  config: ApiConfig,
  result: string,
) {
  const destination = new URL(config.webBaseUrl)
  destination.hash = result === 'success' ? '/me?auth=success' : `/me?auth_error=${encodeURIComponent(result)}`
  return c.redirect(destination.toString(), 302)
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

  app.get('/auth/methods', (c) =>
    c.json({
      wechat: Boolean(config.wechat),
      developmentResidentLogin: config.nodeEnv !== 'production' && config.authDevEnabled,
    }),
  )

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
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      z.object({
        displayName: z.string().trim().min(1).max(40),
        communityId: z.string().uuid().optional(),
      }),
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '测试登录信息不正确')
    if (body.communityId && !db.select().from(communities).where(eq(communities.id, body.communityId)).get()) {
      return fail(c, 404, API_ERROR_CODES.notFound, '社区不存在')
    }

    const now = new Date()
    const userId = randomUUID()
    db.insert(users).values({ id: userId, displayName: body.displayName, createdAt: now, updatedAt: now }).run()
    if (body.communityId) {
      db.insert(residentCommunityAssignments)
        .values({ userId, communityId: body.communityId, createdAt: now })
        .run()
    }
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

  app.get('/auth/wechat/start', (c) => {
    if (!config.wechat) {
      return fail(c, 503, API_ERROR_CODES.notConfigured, '微信网页授权未配置公众号 AppID、AppSecret 和回调地址')
    }
    const communityId = c.req.query('communityId')
    if (communityId && (!/^[0-9a-f-]{36}$/i.test(communityId) ||
      !db.select().from(communities).where(eq(communities.id, communityId)).get())) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '社区参数无效')
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
        communityId: communityId ?? null,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
        consumedAt: null,
        createdAt: now,
      })
      .run()

    setCookie(c, OAUTH_NONCE_COOKIE, nonce, {
      ...cookieOptions(config, 10 * 60),
      path: OAUTH_NONCE_COOKIE_PATH,
    })
    const authorizeUrl = new URL('https://open.weixin.qq.com/connect/oauth2/authorize')
    authorizeUrl.search = new URLSearchParams({
      appid: config.wechat.appId,
      redirect_uri: config.wechat.redirectUri,
      response_type: 'code',
      scope: 'snsapi_base',
      state,
    }).toString()
    authorizeUrl.hash = 'wechat_redirect'
    return c.redirect(authorizeUrl.toString(), 302)
  })

  app.get('/auth/wechat/callback', async (c) => {
    const nonce = getCookie(c, OAUTH_NONCE_COOKIE)
    const state = c.req.query('state')
    const code = c.req.query('code')
    const oauthError = c.req.query('errcode')
    if (!config.wechat) return redirectToWeb(c, config, 'wechat_not_configured')
    if (oauthError || !state || !code || !nonce) return redirectToWeb(c, config, 'wechat_authorization_failed')

    const now = new Date()
    const stateRecord = db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, hashToken(state)))
      .get()
    if (
      !stateRecord ||
      stateRecord.consumedAt ||
      stateRecord.expiresAt.getTime() <= now.getTime() ||
      !constantTimeTextEqual(stateRecord.nonceHash, hashToken(nonce))
    ) {
      return redirectToWeb(c, config, 'wechat_state_invalid')
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
    if (consumed.changes !== 1) return redirectToWeb(c, config, 'wechat_state_replayed')

    try {
      const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
      tokenUrl.search = new URLSearchParams({
        appid: config.wechat.appId,
        secret: config.wechat.appSecret,
        code,
        grant_type: 'authorization_code',
      }).toString()
      const response = await fetcher(tokenUrl, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return redirectToWeb(c, config, 'wechat_provider_unavailable')
      const tokenPayload = (await response.json()) as {
        openid?: string
        unionid?: string
        errcode?: number
      }
      if (!tokenPayload.openid || tokenPayload.errcode) {
        return redirectToWeb(c, config, 'wechat_identity_unavailable')
      }

      const userId = db.transaction((tx) => {
        const identity = tx
          .select({ userId: wechatIdentities.userId })
          .from(wechatIdentities)
          .where(
            and(
              eq(wechatIdentities.appId, config.wechat!.appId),
              eq(wechatIdentities.openId, tokenPayload.openid!),
            ),
          )
          .get()

        let resolvedUserId = identity?.userId
        if (!resolvedUserId) {
          resolvedUserId = randomUUID()
          tx.insert(users)
            .values({
              id: resolvedUserId,
              displayName: '微信用户',
              createdAt: now,
              updatedAt: now,
            })
            .run()
          tx.insert(wechatIdentities)
            .values({
              id: randomUUID(),
              userId: resolvedUserId,
              appId: config.wechat!.appId,
              openId: tokenPayload.openid!,
              unionId: tokenPayload.unionid ?? null,
              createdAt: now,
            })
            .run()
        }
        if (stateRecord.communityId) {
          tx.insert(residentCommunityAssignments)
            .values({ userId: resolvedUserId, communityId: stateRecord.communityId, createdAt: now })
            .onConflictDoNothing()
            .run()
        }
        return resolvedUserId
      })

      const created = createSession(db, config, userId, null)
      setSessionCookies(c, config, created.token, created.csrfToken)
      deleteCookie(c, OAUTH_NONCE_COOKIE, {
        path: OAUTH_NONCE_COOKIE_PATH,
        secure: config.cookieSecure,
        sameSite: 'Lax',
        ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
      })
      return redirectToWeb(c, config, 'success')
    } catch (error) {
      logEvent('wechat.oauth.failed', {
        requestId: c.get('requestId'),
        errorType: error instanceof Error ? error.name : 'unknown',
      })
      return redirectToWeb(c, config, 'wechat_provider_unavailable')
    }
  })

  app.get('/admin/communities', (c) => {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    const result =
      session.staff.role === 'admin'
        ? db.select({ id: communities.id, name: communities.name }).from(communities).all()
        : staffCommunities(db, session.staff.id)
    return c.json({ items: result })
  })

  app.post('/admin/communities', async (c) => {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    if (session.staff.role !== 'admin') return fail(c, 403, API_ERROR_CODES.forbidden, '只有管理员可以创建社区')
    if (!validCsrf(c, config, session)) return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    const body = bodySchemaError(await c.req.json().catch(() => null), createCommunityRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '社区名称不正确')

    const id = randomUUID()
    db.insert(communities).values({ id, name: body.name, createdAt: new Date() }).run()
    recordAudit(db, session.userId, 'community.created', id)
    return c.json({ id, name: body.name }, 201)
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

  app.get('/crm/residents', (c) => {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    const communityId = c.req.query('communityId')
    if (!communityId) return fail(c, 400, API_ERROR_CODES.invalidRequest, '必须指定社区')

    if (session.staff.role !== 'admin') {
      const assignment = db
        .select()
        .from(staffCommunityAssignments)
        .where(
          and(
            eq(staffCommunityAssignments.staffAccountId, session.staff.id),
            eq(staffCommunityAssignments.communityId, communityId),
          ),
        )
        .get()
      if (!assignment) return fail(c, 403, API_ERROR_CODES.forbidden, '无权查看该社区居民')
    } else if (!db.select().from(communities).where(eq(communities.id, communityId)).get()) {
      return fail(c, 404, API_ERROR_CODES.notFound, '社区不存在')
    }

    const items = db
      .select({
        id: users.id,
        displayName: users.displayName,
        createdAt: users.createdAt,
      })
      .from(residentCommunityAssignments)
      .innerJoin(users, eq(residentCommunityAssignments.userId, users.id))
      .where(eq(residentCommunityAssignments.communityId, communityId))
      .limit(100)
      .all()
      .map((resident) => ({
        ...resident,
        createdAt: resident.createdAt.toISOString(),
      }))
    return c.json({ items })
  })

  registerActivityRoutes(app, {
    db,
    config,
    fail,
    validCsrf,
    bodySchemaError,
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

  registerCrmebRoutes(app, {
    db,
    config,
    fetcher,
    fail,
    validCsrf,
    bodySchemaError,
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
