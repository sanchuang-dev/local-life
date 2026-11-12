import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  PURCHASE_REWARD_ROUTES,
  purchaseRewardProgressListResponseSchema,
  purchaseRewardProgressResponseSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, HttpErrorStatus } from '../http.js'
import { LocalError, type LocalActor } from '../local/shared.js'
import {
  getMyPurchaseRewardProgress,
  listStaffPurchaseRewardProgress,
} from './service.js'

export interface PurchaseRewardRouteDeps {
  db: AppDatabase
  fail: (
    c: AppContext,
    status: HttpErrorStatus,
    code: ApiErrorCode,
    message: string,
  ) => Response
  /** Injectable clock so the staff `asOf` is deterministic in tests. */
  now?: () => Date
}

const activityIdSchema = z.string().uuid()

/**
 * Read-only consumption-team progress (LL-PUR-005, #210).
 *
 * Two surfaces share the same projection:
 * - `/activities/:activityId/purchase-reward/progress` is the resident's own team;
 * - `/staff/activities/:activityId/purchase-reward/progress` lists every team but
 *   is guarded by the server-side staff session and the caller's community scope.
 *
 * Neither surface writes anything. Coupon issuance and settlement stay in later
 * cards; this module only reports facts that already exist.
 */
export function registerPurchaseRewardRoutes(
  app: Hono<AppBindings>,
  deps: PurchaseRewardRouteDeps,
): void {
  const { db, fail, now: injectedNow } = deps

  const failWithPurchaseRewardError = (c: AppContext, error: unknown): Response => {
    if (error instanceof LocalError) {
      return fail(c, error.status, error.code, error.message)
    }
    throw error
  }

  const requireActivityId = (c: AppContext): string | Response => {
    const parsed = activityIdSchema.safeParse(c.req.param('activityId'))
    if (!parsed.success) {
      return fail(c, 404, API_ERROR_CODES.notFound, '活动不存在')
    }
    return parsed.data
  }

  app.get(PURCHASE_REWARD_ROUTES.myProgress, (c) => {
    const session = c.get('authSession')
    if (!session) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录居民账户')
    }
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId

    const actor: LocalActor = {
      userId: session.userId,
      staffId: session.staff?.id ?? null,
      role: session.staff?.role ?? null,
    }
    try {
      return c.json(
        purchaseRewardProgressResponseSchema.parse(
          getMyPurchaseRewardProgress(db, actor, activityId),
        ),
      )
    } catch (error) {
      return failWithPurchaseRewardError(c, error)
    }
  })

  app.get(PURCHASE_REWARD_ROUTES.staffProgress, (c) => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId

    const actor: LocalActor = {
      userId: session.userId,
      staffId: session.staff.id,
      role: session.staff.role,
    }
    try {
      return c.json(
        purchaseRewardProgressListResponseSchema.parse(
          listStaffPurchaseRewardProgress(db, actor, activityId, {
            ...(injectedNow === undefined ? {} : { now: injectedNow() }),
          }),
        ),
      )
    } catch (error) {
      return failWithPurchaseRewardError(c, error)
    }
  })
}
