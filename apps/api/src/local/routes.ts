import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  LOCAL_CATALOG_ROUTES,
  createLocalProductRequestSchema,
  localProductListQuerySchema,
  localProductShelfRequestSchema,
  updateLocalProductRequestSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import {
  createProduct,
  getAdminProduct,
  getPublicProduct,
  listAdminProducts,
  listPublicProducts,
  setProductShelf,
  updateProduct,
} from './products.js'
import { LocalError, type LocalActor } from './shared.js'

export interface LocalRouteDeps {
  db: AppDatabase
  config: ApiConfig
  fail: (
    c: AppContext,
    status: HttpErrorStatus,
    code: ApiErrorCode,
    message: string,
  ) => Response
  validCsrf: (c: AppContext, config: ApiConfig, session?: AuthSession | null) => boolean
  bodySchemaError: <T>(value: unknown, schema: z.ZodType<T>) => T | null
}

const idSchema = z.string().uuid()

interface StaffGuard {
  session: AuthSession
  staff: NonNullable<AuthSession['staff']>
}

/**
 * Registers the local catalogue (#109 LL-MVP-010) routes.
 *
 * Everything shared — session resolution, the CSRF double-submit + trusted Origin
 * check, the error envelope, response validation — comes from `createApp`; this
 * module never builds a second auth stack. The catalogue is deliberately not
 * gated on CRMEB configuration: a deployment without the CRMEB adapter still has
 * local products.
 */
export function registerLocalCatalogRoutes(app: Hono<AppBindings>, deps: LocalRouteDeps): void {
  const { db, config, fail, validCsrf, bodySchemaError } = deps

  const failWithLocalError = (c: AppContext, error: unknown): Response => {
    if (error instanceof LocalError) {
      return fail(c, error.status, error.code, error.message)
    }
    throw error
  }

  const requireStaff = (c: AppContext): StaffGuard | Response => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    return { session, staff: session.staff }
  }

  const requireAdminSide = (c: AppContext): StaffGuard | Response => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权管理本地商品目录')
    }
    return guard
  }

  const actorOf = (guard: StaffGuard): LocalActor => ({
    userId: guard.session.userId,
    staffId: guard.staff.id,
    role: guard.staff.role,
  })

  const requireCsrf = (c: AppContext, guard: StaffGuard): Response | null => {
    if (!validCsrf(c, config, guard.session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败')
    }
    return null
  }

  const requireParam = (c: AppContext, key: 'productId'): string | Response => {
    const parsed = idSchema.safeParse(c.req.param(key))
    if (!parsed.success) {
      return fail(c, 404, API_ERROR_CODES.notFound, '商品不存在')
    }
    return parsed.data
  }

  // Empty optional query values are dropped so `?status=` still means "no filter".
  const queryObject = (c: AppContext): Record<string, string> => {
    const cleaned: Record<string, string> = {}
    for (const [key, value] of Object.entries(c.req.query())) {
      if (value !== '') cleaned[key] = value
    }
    return cleaned
  }

  /* --------------------------------- Public -------------------------------- */

  app.get(LOCAL_CATALOG_ROUTES.products, (c) => {
    const query = localProductListQuerySchema.safeParse(queryObject(c))
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listPublicProducts(db, query.data))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.get(LOCAL_CATALOG_ROUTES.productDetail, (c) => {
    const productId = requireParam(c, 'productId')
    if (productId instanceof Response) return productId
    try {
      return c.json(getPublicProduct(db, productId))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  /* ------------------------------- Back office ------------------------------ */

  app.get(LOCAL_CATALOG_ROUTES.adminProducts, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const query = localProductListQuerySchema.safeParse(queryObject(c))
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return c.json(listAdminProducts(db, actorOf(guard), query.data))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.post(LOCAL_CATALOG_ROUTES.adminProducts, async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      createLocalProductRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '商品信息不正确')
    try {
      return c.json(createProduct(db, actorOf(guard), body), 201)
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.get(LOCAL_CATALOG_ROUTES.adminProductDetail, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const productId = requireParam(c, 'productId')
    if (productId instanceof Response) return productId
    try {
      return c.json(getAdminProduct(db, actorOf(guard), productId))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.patch(LOCAL_CATALOG_ROUTES.adminProductDetail, async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const productId = requireParam(c, 'productId')
    if (productId instanceof Response) return productId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      updateLocalProductRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '商品信息不正确')
    try {
      return c.json(updateProduct(db, actorOf(guard), productId, body))
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })

  app.post(LOCAL_CATALOG_ROUTES.adminProductShelf, async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard)
    if (csrfFailure) return csrfFailure
    const productId = requireParam(c, 'productId')
    if (productId instanceof Response) return productId
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      localProductShelfRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '上下架信息不正确')
    try {
      return c.json(
        setProductShelf(db, actorOf(guard), productId, body.expectedUpdatedAt, body.status),
      )
    } catch (error) {
      return failWithLocalError(c, error)
    }
  })
}
