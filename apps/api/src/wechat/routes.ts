import type { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  WECHAT_ADMIN_ROUTES,
  activateWechatConfigRequestSchema,
  activateWechatConfigResponseSchema,
  saveWechatConfigRequestSchema,
  saveWechatConfigResponseSchema,
  verifyWechatConfigRequestSchema,
  verifyWechatConfigResponseSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import type { WechatRuntimeOptions, WechatRuntimeResolution } from './runtime.js'
import {
  activateWechatCandidate,
  buildWechatAdminConfig,
  saveWechatCandidate,
  WechatAdminError,
  verifyWechatCandidate,
  type WechatAdminServiceDeps,
} from './service.js'

/**
 * Admin-only HTTP surface for the WeChat public-account configuration (#113 T2).
 *
 * Every route reuses the existing staff session, CSRF double-submit token and
 * Origin allowlist. `/admin/wechat/*` is back-office-only: a missing session is
 * 401, a non-admin staff session is 403, and every write additionally needs a
 * matching CSRF token from a trusted Origin.
 *
 * No route accepts or returns the AppSecret. The save response is a summary
 * projection from the repository; verification returns only a status summary.
 */
export interface WechatAdminRouteDeps {
  db: AppDatabase
  config: ApiConfig
  fetcher: typeof fetch
  /** Runtime reader built once in `createApp`; never a startup snapshot. */
  resolveRuntime: (options?: WechatRuntimeOptions) => WechatRuntimeResolution
  fail: (
    c: AppContext,
    status: HttpErrorStatus,
    code: ApiErrorCode,
    message: string,
  ) => Response
  validCsrf: (c: AppContext, config: ApiConfig, session?: AuthSession | null) => boolean
  bodySchemaError: <T>(value: unknown, schema: z.ZodType<T>) => T | null
  now?: () => Date
}

interface AdminGuard {
  session: AuthSession
}

export function registerWechatAdminRoutes(
  app: Hono<AppBindings>,
  deps: WechatAdminRouteDeps,
): void {
  const { db, config, fetcher, fail, validCsrf, bodySchemaError } = deps
  const service: WechatAdminServiceDeps = {
    db,
    config,
    fetcher,
    resolveRuntime: deps.resolveRuntime,
    ...(deps.now ? { now: deps.now } : {}),
  }

  /**
   * 401 when nobody is signed in, 403 for an authenticated non-admin. The role
   * is read from the server-side session only; a client can never claim it.
   */
  const requireAdmin = (c: AppContext): AdminGuard | Response => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    if (session.staff.role !== 'admin') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '只有管理员可以管理微信公众号配置')
    }
    return { session }
  }

  const requireCsrf = (c: AppContext, session: AuthSession): Response | null => {
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败，请刷新页面后重试')
    }
    return null
  }

  const failWithAdminError = (c: AppContext, error: unknown): Response => {
    if (error instanceof WechatAdminError) {
      return fail(c, error.status, error.code, error.message)
    }
    throw error
  }

  /* ------------------------------ Read state ------------------------------ */

  app.get(WECHAT_ADMIN_ROUTES.config, (c) => {
    const guard = requireAdmin(c)
    if (guard instanceof Response) return guard
    try {
      return c.json(buildWechatAdminConfig(service))
    } catch (error) {
      return failWithAdminError(c, error)
    }
  })

  /* ---------------------------- Save candidate ---------------------------- */

  app.post(WECHAT_ADMIN_ROUTES.saveCandidate, async (c) => {
    const guard = requireAdmin(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure

    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      saveWechatConfigRequestSchema,
    )
    if (!body) {
      return fail(
        c,
        400,
        API_ERROR_CODES.invalidRequest,
        'AppID、AppSecret 或账号类型格式不正确',
      )
    }

    try {
      const summary = saveWechatCandidate(service, body, guard.session.userId)
      return c.json(saveWechatConfigResponseSchema.parse({ config: summary }))
    } catch (error) {
      return failWithAdminError(c, error)
    }
  })

  /* ------------------------------- Verify --------------------------------- */

  app.post(WECHAT_ADMIN_ROUTES.verify, async (c) => {
    const guard = requireAdmin(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure

    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      verifyWechatConfigRequestSchema,
    )
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '请求参数不正确，请刷新后重试')
    }

    try {
      const summary = await verifyWechatCandidate(
        service,
        c.req.param('configId') ?? '',
        body.expectedUpdatedAt,
        guard.session.userId,
      )
      return c.json(verifyWechatConfigResponseSchema.parse({ verified: true, config: summary }))
    } catch (error) {
      return failWithAdminError(c, error)
    }
  })

  /* ------------------------------- Activate ------------------------------- */

  app.post(WECHAT_ADMIN_ROUTES.activate, async (c) => {
    const guard = requireAdmin(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure

    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      activateWechatConfigRequestSchema,
    )
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '请求参数不正确，请刷新后重试')
    }

    try {
      const result = activateWechatCandidate(
        service,
        c.req.param('configId') ?? '',
        body.expectedUpdatedAt,
        guard.session.userId,
      )
      return c.json(activateWechatConfigResponseSchema.parse(result))
    } catch (error) {
      return failWithAdminError(c, error)
    }
  })
}
