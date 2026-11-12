import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  CRMEB_ROUTES,
  crmebAdapterStatusSchema,
  crmebIdentityBindRequestSchema,
  crmebIdentityBindResponseSchema,
  crmebIdentityRevokeResponseSchema,
  crmebIdentityStatusResponseSchema,
  crmebOrderSyncRequestSchema,
  crmebProductDetailSchema,
  crmebProductListResponseSchema,
  crmebPurchaseLinkRequestSchema,
  crmebPurchaseLinkResponseSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import { logEvent } from '../log.js'
import { CrmebOutapiClient } from './client.js'
import { CrmebDomainError, toCrmebHttpFailure } from './errors.js'
import { createCrmebPurchaseLink } from './attribution.js'
import { ResidentCommunityError } from '../resident-community/service.js'
import {
  bindCrmebIdentity,
  getResidentCrmebIdentity,
  revokeCrmebIdentity,
} from './identity.js'
import { listCrmebProducts, getCrmebProduct } from './products.js'
import { runCrmebOrderSync } from './orders.js'

export interface CrmebRouteDeps {
  db: AppDatabase
  config: ApiConfig
  fetcher: typeof fetch
  fail: (
    c: AppContext,
    status: HttpErrorStatus,
    code: ApiErrorCode,
    message: string,
  ) => Response
  validCsrf: (c: AppContext, config: ApiConfig, session?: AuthSession | null) => boolean
  bodySchemaError: <T>(value: unknown, schema: z.ZodType<T>) => T | null
}

const optionalQueryString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).max(80).optional(),
)

const productListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  categoryId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  keyword: optionalQueryString,
})

const productIdSchema = z.coerce.number().int().positive().max(2_147_483_647)

interface ConfiguredCrmeb {
  client: CrmebOutapiClient
  baseUrl: string
  h5BaseUrl: string
}

/**
 * Registers the CRMEB adapter routes. Every upstream call goes through this
 * server-side adapter; browsers never receive the outapi token, appid or
 * appsecret. Missing configuration yields an explicit `not_configured` error.
 */
export function registerCrmebRoutes(
  app: Hono<AppBindings>,
  deps: CrmebRouteDeps,
): void {
  const { db, config, fetcher, fail, validCsrf, bodySchemaError } = deps
  const client = config.crmeb
    ? new CrmebOutapiClient({
        baseUrl: config.crmeb.baseUrl,
        appId: config.crmeb.appId,
        appSecret: config.crmeb.appSecret,
        timeoutMs: config.crmeb.timeoutMs,
        fetcher,
      })
    : null

  const configured = (): ConfiguredCrmeb | null =>
    client && config.crmeb
      ? { client, baseUrl: config.crmeb.baseUrl, h5BaseUrl: config.crmeb.h5BaseUrl }
      : null

  const failWithCrmebError = (c: AppContext, error: unknown): Response => {
    const failure = toCrmebHttpFailure(error)
    if (failure) return fail(c, failure.status, failure.code, failure.message)
    if (error instanceof CrmebDomainError) {
      return fail(c, error.status, error.code, error.message)
    }
    // #171 LL-IDENTITY-001: an activity-scoped purchase link is now authorized by
    // the resident's own confirmed binding, so the shared guard's 403/404 keeps
    // the standard envelope instead of surfacing as a 500.
    if (error instanceof ResidentCommunityError) {
      return fail(c, error.status, error.code, error.message)
    }
    throw error
  }

  const requireConfigured = (c: AppContext): ConfiguredCrmeb | Response => {
    const configState = configured()
    if (!configState) {
      return fail(
        c,
        503,
        API_ERROR_CODES.notConfigured,
        'CRMEB 商城未配置，真实商品、购买跳转与订单同步均不可用',
      )
    }
    return configState
  }

  /* -------------------------------- Public -------------------------------- */

  app.get(CRMEB_ROUTES.status, (c) => {
    return c.json(
      crmebAdapterStatusSchema.parse({
        configured: Boolean(config.crmeb),
        status: config.crmeb ? 'ready' : 'not_configured',
        h5EntryConfigured: Boolean(config.crmeb?.h5BaseUrl),
        orderReconciliation: 'outapi_pull',
        pushWebhook: false,
        detail: config.crmeb
          ? null
          : '未配置 CRMEB_BASE_URL、CRMEB_OUTAPI_APPID、CRMEB_OUTAPI_APPSECRET；不会返回任何模拟商品或订单',
      }),
    )
  })

  app.get(CRMEB_ROUTES.products, async (c) => {
    const state = requireConfigured(c)
    if (state instanceof Response) return state
    const query = productListQuerySchema.safeParse({
      page: c.req.query('page'),
      limit: c.req.query('limit'),
      categoryId: c.req.query('categoryId'),
      keyword: c.req.query('keyword'),
    })
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '商品查询参数不正确')
    }
    try {
      const response = await listCrmebProducts(state.client, state.baseUrl, query.data)
      return c.json(crmebProductListResponseSchema.parse(response))
    } catch (error) {
      return failWithCrmebError(c, error)
    }
  })

  app.get(CRMEB_ROUTES.productDetail, async (c) => {
    const state = requireConfigured(c)
    if (state instanceof Response) return state
    const productId = productIdSchema.safeParse(c.req.param('crmebProductId'))
    if (!productId.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '商品 id 必须是正整数')
    }
    try {
      const product = await getCrmebProduct(state.client, state.baseUrl, productId.data)
      return c.json(crmebProductDetailSchema.parse(product))
    } catch (error) {
      return failWithCrmebError(c, error)
    }
  })

  app.post(CRMEB_ROUTES.purchaseLink, async (c) => {
    const session = c.get('authSession')
    if (!session) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录居民账户')
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const state = requireConfigured(c)
    if (state instanceof Response) return state
    // `.strictObject` rejects `gridWorkerId`, `claimState`/`confirmed`, etc.
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      crmebPurchaseLinkRequestSchema,
    )
    if (!body) {
      return fail(
        c,
        400,
        API_ERROR_CODES.invalidRequest,
        '购买跳转参数不正确；活动来源可选，来源只能通过 referralCode 由服务端解析',
      )
    }
    try {
      const response = createCrmebPurchaseLink(db, session.userId, body, state.h5BaseUrl)
      return c.json(crmebPurchaseLinkResponseSchema.parse(response), 201)
    } catch (error) {
      return failWithCrmebError(c, error)
    }
  })

  app.get(CRMEB_ROUTES.identityMe, (c) => {
    const session = c.get('authSession')
    if (!session) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录居民账户')
    return c.json(
      crmebIdentityStatusResponseSchema.parse(
        getResidentCrmebIdentity(db, session.userId),
      ),
    )
  })

  /* -------------------------------- Admin --------------------------------- */

  app.post(CRMEB_ROUTES.adminIdentityBind, async (c) => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    if (session.staff.role !== 'admin') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '只有管理员可以绑定 CRMEB 身份')
    }
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      crmebIdentityBindRequestSchema,
    )
    if (!body) {
      return fail(
        c,
        400,
        API_ERROR_CODES.invalidRequest,
        '绑定参数不正确；crmeb uid 只能由管理员在服务端提交',
      )
    }
    try {
      const response = bindCrmebIdentity(db, session.userId, body)
      return c.json(crmebIdentityBindResponseSchema.parse(response), 201)
    } catch (error) {
      return failWithCrmebError(c, error)
    }
  })

  app.post(CRMEB_ROUTES.adminIdentityRevoke, async (c) => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    if (session.staff.role !== 'admin') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '只有管理员可以撤销 CRMEB 身份')
    }
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const platformUserId = z.string().uuid().safeParse(c.req.param('platformUserId'))
    if (!platformUserId.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '居民 id 不正确')
    }
    try {
      const response = revokeCrmebIdentity(db, session.userId, platformUserId.data)
      logEvent('crmeb.identity.revoke.requested', {
        actorRole: session.staff.role,
        platformUserId: platformUserId.data,
      })
      return c.json(crmebIdentityRevokeResponseSchema.parse(response))
    } catch (error) {
      return failWithCrmebError(c, error)
    }
  })

  app.post(CRMEB_ROUTES.adminOrderSync, async (c) => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    const actorRole = session.staff.role
    if (actorRole !== 'admin') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '只有管理员可以触发订单同步')
    }
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    const state = requireConfigured(c)
    if (state instanceof Response) return state
    const payload = await c.req.json().catch(() => null)
    const request = crmebOrderSyncRequestSchema.safeParse(payload ?? {})
    if (!request.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '同步参数不正确')
    }
    try {
      const result = await runCrmebOrderSync({
        db,
        client: state.client,
        actorUserId: session.userId,
        actorRole,
        request: request.data,
      })
      logEvent('crmeb.sync.requested', {
        staffRole: session.staff.role,
        runId: result.runId,
        status: result.status,
      })
      return c.json(result)
    } catch (error) {
      return failWithCrmebError(c, error)
    }
  })
}
