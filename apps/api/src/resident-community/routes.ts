import type { z } from 'zod'
import type { Hono } from 'hono'

import {
  API_ERROR_CODES,
  RESIDENT_COMMUNITY_ROUTES,
  confirmResidentCommunityRequestSchema,
  confirmResidentCommunityResponseSchema,
  residentCommunityStatusResponseSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'

import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import {
  ResidentCommunityError,
  confirmResidentCommunity,
  getResidentCommunityStatus,
} from './service.js'

export interface ResidentCommunityRouteDeps {
  db: AppDatabase
  config: ApiConfig
  fail: (c: AppContext, status: HttpErrorStatus, code: ApiErrorCode, message: string) => Response
  validCsrf: (c: AppContext, config: ApiConfig, session?: AuthSession | null) => boolean
  bodySchemaError: <T>(value: unknown, schema: z.ZodType<T>) => T | null
}

/**
 * Registers the resident permanent-community HTTP surface (#171 LL-IDENTITY-001).
 *
 * Two routes only, and deliberately no more:
 *   GET  /resident-community/status   → the one read behind 未绑定/已确认/待核查/冲突
 *   POST /resident-community/confirm  → the resident's one-shot explicit confirmation
 *
 * There is no update, rebind, unbind or delete route: a confirmed community is
 * permanent for the resident surface. Changing it is a separately approved,
 * audited compliance operation, not an H5 or everyday-admin API.
 *
 * The resident identity comes from the server-side session only. The confirm body
 * is a strict contract holding a single `communityId`, so a forged `userId`,
 * `source` or `confirmedAt` fails parsing instead of being silently ignored. The
 * `communityId` names the community the resident is looking at; it is never used
 * as an identity claim about the resident, and browsing does not change anything.
 */
export function registerResidentCommunityRoutes(
  app: Hono<AppBindings>,
  deps: ResidentCommunityRouteDeps,
): void {
  const { db, config, fail, validCsrf, bodySchemaError } = deps

  const failWithResidentCommunityError = (c: AppContext, error: unknown): Response => {
    if (error instanceof ResidentCommunityError) {
      return fail(c, error.status, error.code, error.message)
    }
    throw error
  }

  const requireSession = (c: AppContext): AuthSession | Response => {
    const session = c.get('authSession')
    if (!session) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录居民账户')
    }
    return session
  }

  app.get(RESIDENT_COMMUNITY_ROUTES.status, (c) => {
    const session = requireSession(c)
    if (session instanceof Response) return session
    try {
      return c.json(
        residentCommunityStatusResponseSchema.parse(
          getResidentCommunityStatus(db, session.userId, new Date()),
        ),
      )
    } catch (error) {
      return failWithResidentCommunityError(c, error)
    }
  })

  app.post(RESIDENT_COMMUNITY_ROUTES.confirm, async (c) => {
    const session = requireSession(c)
    if (session instanceof Response) return session
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败，请刷新页面后重试')
    }

    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      confirmResidentCommunityRequestSchema,
    )
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '请选择要确认的常驻社区')
    }

    try {
      const result = confirmResidentCommunity(db, {
        // Session identity only: never accept a userId from the request.
        userId: session.userId,
        communityId: body.communityId,
        now: new Date(),
      })
      return c.json(confirmResidentCommunityResponseSchema.parse({ status: 'confirmed', ...result }))
    } catch (error) {
      return failWithResidentCommunityError(c, error)
    }
  })
}
