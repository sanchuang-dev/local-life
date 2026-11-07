import type { z } from 'zod'
import { z as zod } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  LEDGER_ROUTES,
  createBatchRequestSchema,
  lockBatchRequestSchema,
  reconciliationBatchEntriesResponseSchema,
  reconciliationBatchSchema,
  reconciliationDiffSchema,
} from '@sanchuang-dev/local-life-contracts'
import type { AppBindings, AppContext, AuthSession } from '../http.js'
import { LocalError, type LedgerActor } from './shared.js'
import {
  batchEntriesResponse,
  csvDisposition,
  diffResponse,
  exportCsv,
  resolveDiffQuery,
} from './reconciliation.js'
import { createBatch, getBatch, lockBatch } from './reconciliation-service.js'
import type { LedgerRouteDeps } from './routes.js'

/**
 * Reconciliation + export routes (LL-MVP-008, Issue #64 — R3b-1b).
 *
 * Six endpoints, all `/admin/reconciliation/*`, all 管理员/运营员 only:
 *
 * | method | path                                        | what                         |
 * | ------ | ------------------------------------------- | ---------------------------- |
 * | POST   | `/admin/reconciliation/batches`             | 建批次 (open)                |
 * | GET    | `/admin/reconciliation/batches/:batchId`    | 批次详情                     |
 * | GET    | `/admin/reconciliation/batches/:id/entries` | 批次流水（分页）             |
 * | POST   | `/admin/reconciliation/batches/:id/lock`    | 锁定（open -> locked）       |
 * | GET    | `/admin/reconciliation/diff`                | 差异清单 + 下钻明细          |
 * | GET    | `/admin/reconciliation/export.csv`          | 中文 CSV 下载（脱敏 + 审计） |
 *
 * The batch **list** (`GET /admin/reconciliation/batches`) is not registered
 * here: it already lives in `routes.ts` as part of the read-only skeleton, and a
 * second registration of the same method+path would shadow it with a copy.
 *
 * ## Why this is a separate module
 *
 * `reconciliation-service.ts` owns the domain rules and is Hono-free; this module
 * owns HTTP: guards, CSRF, query parsing, status codes, headers and the one
 * response in the whole API that is not JSON. Keeping them apart is what lets the
 * service be unit-tested without an HTTP server while the routes still cannot
 * re-derive a number.
 *
 * ## Guards
 *
 * - `grid_worker` → 403 on **every** route here (`requireAdminSide`), before the
 *   body is even read: 网格员 sees its own community's facts through
 *   `/staff/ledger/*`, while locking a statement is a back-office act.
 * - unauthenticated → 401.
 * - `POST` additionally requires the CSRF double-submit token + a trusted
 *   `Origin`; a write without it is 403 and touches nothing.
 *
 * Concurrency: creating and locking both rely on the service's `BEGIN IMMEDIATE`
 * transaction plus the partial unique index on open periods, so "one open batch
 * per period" holds even if two operators click at once. Nothing here implements
 * a distributed lock — SQLite is single-writer and that is the whole mechanism
 * (see `docs/engineering/ll-mvp-008-ledger-reconciliation.md`).
 */

/* -------------------------------------------------------------------------- */
/* Query contracts                                                            */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD` business date. Ledger periods are business days, not instants. */
const businessDateQuery = zod
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'must be a YYYY-MM-DD business date')

const positiveIntQuery = zod
  .string()
  .regex(/^\d+$/u, 'must be a positive integer')
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value) && value >= 1, 'must be a positive integer')

/**
 * Paging of the batch detail page. `pageSize` is capped in the adapter, and the
 * **applied** value is echoed back, so a client that asks for 1000 learns what it
 * actually got instead of quietly showing 20 of 1000 rows and calling it all.
 */
const batchEntriesQuerySchema = zod.strictObject({
  page: positiveIntQuery.default(1),
  pageSize: positiveIntQuery.default(20),
})

/**
 * Export narrowing. Everything is optional: no parameters at all means "the whole
 * ledger within my scope", which is legal but bounded by
 * `RECONCILIATION_CSV_MAX_ROWS` (beyond it the answer is `400`, never a truncated
 * file that looks complete).
 *
 * `strictObject` on purpose — a misspelled filter must be a `400`, not silently
 * ignored. An ignored `communityId` would hand an operator every community's
 * money while their screen still says "my community".
 */
const exportQuerySchema = zod
  .strictObject({
    batchId: zod.string().uuid().optional(),
    periodFrom: businessDateQuery.optional(),
    periodTo: businessDateQuery.optional(),
    communityId: zod.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    const hasFrom = value.periodFrom !== undefined
    const hasTo = value.periodTo !== undefined
    if (hasFrom !== hasTo) {
      ctx.addIssue({
        code: 'custom',
        path: [hasFrom ? 'periodTo' : 'periodFrom'],
        message: '期间开始与结束必须同时指定',
      })
    }
    if (value.batchId !== undefined && hasFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['batchId'],
        message: '批次与期间不能同时指定',
      })
    }
  })

const diffQuerySchema = zod
  .strictObject({
    batchId: zod.string().uuid().optional(),
    periodFrom: businessDateQuery.optional(),
    periodTo: businessDateQuery.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.batchId !== undefined) return
    if (value.periodFrom !== undefined && value.periodTo !== undefined) return
    ctx.addIssue({
      code: 'custom',
      path: ['batchId'],
      message: '必须指定对账批次，或同时指定期间开始与结束日期',
    })
  })

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

export function registerReconciliationRoutes(app: Hono<AppBindings>, deps: LedgerRouteDeps): void {
  const { db, config, fail, validCsrf, bodySchemaError, now: injectedNow } = deps

  const now = (): Date => (injectedNow ? injectedNow() : new Date())

  const failWithLedgerError = (c: AppContext, error: unknown): Response => {
    if (error instanceof LocalError) {
      return fail(c, error.status, error.code, error.message)
    }
    throw error
  }

  interface BackOfficeGuard {
    session: AuthSession
    actor: LedgerActor
  }

  /**
   * 管理员 / 运营员 only. `grid_worker` is refused here rather than by hiding a
   * menu item: 网格员 has its own community-scoped read surface under
   * `/staff/ledger/*`, and freezing a company-wide statement is not their act.
   */
  const requireAdminSide = (c: AppContext): BackOfficeGuard | Response => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    if (session.staff.role === 'grid_worker') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '网格员无权访问对账管理接口')
    }
    return {
      session,
      actor: {
        userId: session.userId,
        staffId: session.staff.id,
        role: session.staff.role,
      },
    }
  }

  /** CSRF double-submit + trusted Origin; same helper `createApp` uses for login. */
  const requireCsrf = (c: AppContext, session: AuthSession): Response | null => {
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败，请刷新页面后重试')
    }
    return null
  }

  /** Parse + validate before responding: the client must never see a bad shape. */
  const respond = <T>(c: AppContext, schema: z.ZodType<T>, value: unknown, status?: 201) => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      throw new Error(`reconciliation response failed its own contract: ${parsed.error.message}`)
    }
    return status === undefined ? c.json(parsed.data) : c.json(parsed.data, status)
  }

  /** Drops empty query values so `?batchId=` means "absent", not "empty id". */
  const queryObject = (c: AppContext): Record<string, string> => {
    const cleaned: Record<string, string> = {}
    for (const [key, value] of Object.entries(c.req.query())) {
      if (value !== '') cleaned[key] = value
    }
    return cleaned
  }

  const requireBatchId = (c: AppContext): string | Response => {
    const batchId = c.req.param('batchId')
    if (!batchId) return fail(c, 404, API_ERROR_CODES.notFound, '对账批次不存在')
    return batchId
  }

  /** One shared 400 for every query-shape violation; the schema holds the detail. */
  const invalidQuery = (c: AppContext, message: string) =>
    fail(c, 400, API_ERROR_CODES.invalidRequest, message)

  /* ------------------------------- Create ---------------------------------- */

  /**
   * Creates an `open` batch for a business-day period.
   *
   * The body never carries an entry count or a total: the server derives both
   * from the immutable facts, so a client can neither pre-seed a fake statement
   * nor widen the period. `201` (not `200`) is what tells the operator UI that a
   * new resource exists; together with the `conflict` reply for a period that
   * already has an open batch, it keeps a double submit from silently creating
   * two statements for one week.
   */
  app.post(LEDGER_ROUTES.adminBatches, async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const body = bodySchemaError(await c.req.json().catch(() => null), createBatchRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '对账批次参数不正确')
    try {
      const batch = createBatch(db, guard.actor, body, { now: now() })
      return respond(c, reconciliationBatchSchema, batch, 201)
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  /* -------------------------------- Detail --------------------------------- */

  app.get(LEDGER_ROUTES.adminBatchDetail, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const batchId = requireBatchId(c)
    if (batchId instanceof Response) return batchId
    try {
      return respond(c, reconciliationBatchSchema, getBatch(db, batchId))
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  /* -------------------------------- Entries -------------------------------- */

  /**
   * The frozen members of one batch, paged.
   *
   * The page is a slice of the statement the service derived, never a fresh query
   * with its own WHERE clause: `total`, the order and the rows all come from one
   * derivation, so 「共 N 条」cannot disagree with what is pageable. `items` is the
   * statement, not the period — facts recorded after the lock are reported by the
   * diff as `lateRecorded*`, never smuggled into a frozen page.
   */
  app.get(LEDGER_ROUTES.adminBatchEntries, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const batchId = requireBatchId(c)
    if (batchId instanceof Response) return batchId
    const query = batchEntriesQuerySchema.safeParse(queryObject(c))
    if (!query.success) return invalidQuery(c, '分页参数不正确')
    try {
      return respond(
        c,
        reconciliationBatchEntriesResponseSchema,
        batchEntriesResponse(db, guard.actor, batchId, query.data, now()),
      )
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  /* --------------------------------- Lock ---------------------------------- */

  /**
   * Locks a batch: `open -> locked`, one way.
   *
   * Two distinct refusals, both `409` and both meaningful to an operator:
   * - `ledger_batch_locked` — already frozen; re-locking would rewrite a
   *   statement someone may already have exported;
   * - `conflict` — the `expectedUpdatedAt` token is stale, i.e. the statement
   *   changed since it was displayed; look again before freezing it.
   */
  app.post(LEDGER_ROUTES.adminBatchLock, async (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const csrfFailure = requireCsrf(c, guard.session)
    if (csrfFailure) return csrfFailure
    const batchId = requireBatchId(c)
    if (batchId instanceof Response) return batchId
    const body = bodySchemaError(await c.req.json().catch(() => null), lockBatchRequestSchema)
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '锁定参数不正确')
    try {
      return respond(c, reconciliationBatchSchema, lockBatch(db, guard.actor, batchId, body, { now: now() }))
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  /* --------------------------------- Diff ---------------------------------- */

  /**
   * What still needs a human, for a batch or an arbitrary period.
   *
   * `?batchId=` is the primary form (the statement screen always knows its batch);
   * `?periodFrom=&periodTo=` answers the pre-lock question "this week, what is
   * left?". Half a period is a `400`, never an empty report — "the period you
   * asked for is unknown" must not be rendered as "this period has nothing to
   * reconcile". A misspelled parameter is a `400` for the same reason.
   */
  app.get(LEDGER_ROUTES.adminDiff, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const query = diffQuerySchema.safeParse(queryObject(c))
    if (!query.success) return invalidQuery(c, '必须指定对账批次，或同时指定期间开始与结束日期')
    try {
      return respond(
        c,
        reconciliationDiffSchema,
        diffResponse(db, guard.actor, resolveDiffQuery(query.data), now()),
      )
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })

  /* --------------------------------- CSV ----------------------------------- */

  /**
   * The reconciliation CSV — **the only non-JSON response in the API**.
   *
   * Every other endpoint ends in `c.json(schema.parse(...))` so the contract is
   * enforced on the way out. A CSV cannot be validated by a zod response schema,
   * so this handler deliberately does **not** use `c.json`: it builds a `Response`
   * around the text (UTF-8 BOM + CRLF, so Excel on Windows opens it as UTF-8
   * instead of GBK) and sets the headers itself.
   *
   * Three details that are cheap to get wrong and expensive to live with:
   * - **errors are still JSON.** A failed export answers the normal
   *   `{ error: { code, message, requestId } }` envelope with a real status; it
   *   never writes a half-built file. That is why the whole build runs inside
   *   `try` and the `Response` is only constructed after it succeeds.
   * - **the filename is ASCII only.** A Chinese filename in `Content-Disposition`
   *   is decoded differently by every browser and loses its extension in several,
   *   so the file is named after the machine batch number (or `all`); the
   *   human-readable Chinese statement lives *inside* the file.
   * - **`Cache-Control: no-store`.** A statement download must never be served
   *   from a shared cache to a different operator.
   *
   * The row count and the late-recorded pair are echoed as `X-Ledger-*` headers so
   * the operator UI can say "导出了 N 行，另有 M 笔锁后补录未计入" without parsing
   * the file, and they are listed in `Access-Control-Expose-Headers` because a
   * custom header is otherwise unreadable to JavaScript on a cross-origin call.
   */
  app.get(LEDGER_ROUTES.adminExportCsv, (c) => {
    const guard = requireAdminSide(c)
    if (guard instanceof Response) return guard
    const query = exportQuerySchema.safeParse(queryObject(c))
    if (!query.success) return invalidQuery(c, '导出参数不正确，请指定批次或完整期间')
    try {
      const csv = exportCsv(db, guard.actor, { ...query.data, now: now() })
      return new Response(csv.body, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': csvDisposition(csv),
          'cache-control': 'no-store',
          'x-ledger-row-count': String(csv.rowCount),
          'x-ledger-late-recorded-count': String(csv.lateRecordedCount),
          'x-ledger-late-recorded-total-cents': String(csv.lateRecordedTotalCents),
          'access-control-expose-headers':
            'Content-Disposition, X-Ledger-Row-Count, X-Ledger-Late-Recorded-Count, X-Ledger-Late-Recorded-Total-Cents',
        },
      })
    } catch (error) {
      return failWithLedgerError(c, error)
    }
  })
}
