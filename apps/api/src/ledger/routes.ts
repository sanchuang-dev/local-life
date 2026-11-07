import type { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  LEDGER_ROUTES,
  ledgerAnomalyListResponseSchema,
  ledgerAnomalySchema,
  ledgerEntrySchema,
  ledgerListQuerySchema,
  ledgerListResponseSchema,
  ledgerOverviewQuerySchema,
  ledgerOverviewSchema,
  reconciliationBatchListResponseSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import {
  LocalError,
  getLedgerOverview,
  listLedgerEntries,
  listReconciliationBatches,
  type LedgerActor,
} from './shared.js'
import {
  flagAnomaly,
  flagAnomalyRequestSchema,
  getLedgerEntry,
  listAnomalies,
  listAnomaliesQuerySchema,
  recordPayment,
  recordPaymentRequestSchema,
  resolveAttribution,
  resolveAttributionRequestSchema,
  reversePayment,
  reversePaymentRequestSchema,
} from './service.js'

export interface LedgerRouteDeps {
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
  /** Injectable clock so `asOf` is deterministic in tests. Defaults to `new Date()`. */
  now?: () => Date
}

interface StaffGuard {
  session: AuthSession
  staff: NonNullable<AuthSession['staff']>
}

/**
 * Registers the ledger routes (LL-MVP-008, Issue #64).
 *
 * Read side: the three `/staff/ledger/*` and three `/admin/ledger/*` GET endpoints
 * plus the reconciliation batch list. Write side: manual receipts and their
 * reversals, attribution confirmation and anomaly flags — every one of them a
 * *back-office* action that appends a row instead of changing one.
 *
 * Guards:
 * - `/staff/ledger/*`       任意 staff 角色（含 grid_worker），按
 *                           `staff_community_assignments` 裁剪。
 * - `/admin/ledger/*` 与
 *   `/admin/reconciliation/*` 拒绝 `grid_worker`（403），与 `/admin/local-orders`
 *                           的既有约定一致。
 *
 * Session, CSRF double-submit + trusted Origin and the error envelope all come
 * from `createApp`; this module never builds a second auth implementation. Every
 * write requires the CSRF token *and* the trusted Origin, exactly like login.
 */
export function registerLedgerRoutes(app: Hono<AppBindings>, deps: LedgerRouteDeps): void {
  const { db, config, fail, validCsrf, now: injectedNow } = deps

  const now = (): Date => (injectedNow ? injectedNow() : new Date())

  const failWithLedgerError = (c: AppContext, error: unknown): Response => {
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

  /**
   * Back-office side. `grid_worker` is rejected here on purpose: 网格员 sees the
   * same facts through `/staff/ledger/*`, which is community-scoped, while the
   * admin surfaces drive verification, payment recording and batch locking.
   */
  const requireAdminSide = (c: AppContext): StaffGuard | Response => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    if (guard.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权访问经营流水管理接口')
    }
    return guard
  }

  const actorOf = (guard: StaffGuard): LedgerActor => ({
    userId: guard.session.userId,
    staffId: guard.staff.id,
    role: guard.staff.role,
  })

  /** CSRF double-submit + trusted Origin; the same helper `createApp` uses. */
  const requireCsrf = (c: AppContext, session: AuthSession): Response | null => {
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败，请刷新页面后重试')
    }
    return null
  }

  const queryObject = (c: AppContext): Record<string, string> => {
    const cleaned: Record<string, string> = {}
    for (const [key, value] of Object.entries(c.req.query())) {
      if (value !== '') cleaned[key] = value
    }
    return cleaned
  }

  /** Parse + validate before responding: the client must never see a bad shape. */
  const respond = <T>(c: AppContext, schema: z.ZodType<T>, value: unknown, status?: 201) => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      throw new Error(`ledger response failed its own contract: ${parsed.error.message}`)
    }
    return status === undefined ? c.json(parsed.data) : c.json(parsed.data, status)
  }

  /** One shared 400 for a body that does not match the write contract. */
  const invalidBody = (c: AppContext, message: string) =>
    fail(c, 400, API_ERROR_CODES.invalidRequest, message)

  /**
   * The overview accepts the same scope/time narrowings as the list, so the KPI
   * card and the detail table of one screen can never describe different facts.
   * An unknown or unsupported filter is a 400, never a silently ignored one.
   */
  const overviewHandler = (c: AppContext, guard: StaffGuard) => {
    const query = ledgerOverviewQuerySchema.safeParse(queryObject(c))
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return respond(
        c,
        ledgerOverviewSchema,
        getLedgerOverview(db, actorOf(guard), now(), query.data),
      )
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  }

  /* ------------------------------- Staff ----------------------------------- */

  // Read-only for every staff role, always community-scoped.
  const staffOverview = (c: AppContext) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    return overviewHandler(c, guard)
  }

  const staffEntries = (c: AppContext) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const query = ledgerListQuerySchema.safeParse(queryObject(c))
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return respond(
        c,
        ledgerListResponseSchema,
        listLedgerEntries(db, actorOf(guard), query.data, now()),
      )
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  }

  const staffAnomalies = (c: AppContext) => {
    const guard = requireStaff(c)
    if (guard instanceof Response) return guard
    const query = listAnomaliesQuerySchema.safeParse(queryObject(c))
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return respond(
        c,
        ledgerAnomalyListResponseSchema,
        listAnomalies(db, actorOf(guard), query.data, { now: now() }),
      )
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  }

  app.get(LEDGER_ROUTES.staffOverview, staffOverview)
  app.get(LEDGER_ROUTES.staffEntries, staffEntries)
  app.get(LEDGER_ROUTES.staffAnomalies, staffAnomalies)

  /* ------------------------------- Admin ----------------------------------- */

  app.get(LEDGER_ROUTES.adminOverview, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    return overviewHandler(c, guard)
  })

  app.get(LEDGER_ROUTES.adminEntries, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const query = ledgerListQuerySchema.safeParse(queryObject(c))
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return respond(
        c,
        ledgerListResponseSchema,
        listLedgerEntries(db, actorOf(guard), query.data, now()),
      )
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  app.get(LEDGER_ROUTES.adminAnomalies, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const query = listAnomaliesQuerySchema.safeParse(queryObject(c))
    if (!query.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '查询参数不正确')
    }
    try {
      return respond(c, ledgerAnomalyListResponseSchema, listAnomalies(db, actorOf(guard), query.data, { now: now() }))
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  /* ------------------------------ Fact detail ------------------------------ */

  /**
   * One fact by id. Reads are scoped, so a grid worker asking for another
   * community's entry gets a `403` — an empty body would read like "no such fact".
   */
  app.get('/admin/ledger/entries/:entryId', (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const entryId = c.req.param('entryId')
    if (!entryId) return fail(c, 404, API_ERROR_CODES.notFound, '流水条目不存在')
    try {
      return respond(c, ledgerEntrySchema, getLedgerEntry(db, actorOf(guard), entryId))
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  /* --------------------------- Manual receipts ----------------------------- */

  /**
   * Records one manual receipt. There is no online payment in this MVP, so this is
   * the **only** way 实收进入流水；`evidenceRef`、`receivedAt`、`amountCents` 与经办
   * staff 缺一不可，缺任一都是 400 且不落库。
   */
  app.post('/admin/ledger/payments', async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const body = recordPaymentRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return invalidBody(c, '收款参数不正确：金额、凭据、到账时间和经办人员缺一不可')
    }
    try {
      return respond(c, ledgerEntrySchema, recordPayment(db, actorOf(guard), body.data, { now: now() }), 201)
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  /**
   * Reverses one receipt by appending `payment_reversed`. The original row is kept
   * (it cannot be touched), so the net 实收 stays reproducible arithmetic.
   */
  app.post('/admin/ledger/payments/:entryId/reverse', async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const entryId = c.req.param('entryId')
    if (!entryId) return fail(c, 404, API_ERROR_CODES.notFound, '流水条目不存在')
    const body = reversePaymentRequestSchema.safeParse((await c.req.json().catch(() => null)) ?? {})
    if (!body.success) return invalidBody(c, '冲正参数不正确')
    try {
      return respond(c, ledgerEntrySchema, reversePayment(db, actorOf(guard), entryId, body.data, { now: now() }), 201)
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  /* ----------------------------- Attribution ------------------------------- */

  /**
   * Confirms the owner of a 待归属 fact. Append-only: the fact row keeps its
   * `pending` state, the confirmation is a new record, and reads layer the two.
   */
  app.post('/admin/ledger/attributions', async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const body = resolveAttributionRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return invalidBody(c, '归属确认参数不正确')
    try {
      return respond(c, ledgerEntrySchema, resolveAttribution(db, actorOf(guard), body.data, { now: now() }), 201)
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  /* ------------------------------- Anomalies ------------------------------- */

  /** Flags one fact. Anomalies are append-only review hints, never money edits. */
  app.post('/admin/ledger/anomalies', async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const body = flagAnomalyRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return invalidBody(c, '异常标记参数不正确')
    try {
      return respond(c, ledgerAnomalySchema, flagAnomaly(db, actorOf(guard), body.data, { now: now() }), 201)
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  /* --------------------------- Reconciliation ------------------------------ */

  // Reconciliation periods are global (one statement for the whole operation),
  // so this list is back-office only and not community-scoped.
  app.get(LEDGER_ROUTES.adminBatches, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    try {
      return respond(c, reconciliationBatchListResponseSchema, listReconciliationBatches(db, now()))
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  // Writing a batch / locking it requires CSRF + optimistic concurrency; those
  // handlers live in `reconciliation-routes.ts` and are registered by their own
  // card. Registering nothing here is deliberate: an unimplemented write must 404,
  // never pretend to succeed.
}
