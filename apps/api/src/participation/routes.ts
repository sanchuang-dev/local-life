import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  PARTICIPATION_ROUTES,
  activityParticipationConfirmRequestSchema,
  activityParticipationConfirmResponseSchema,
  activityParticipationStateSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import {
  ParticipationError,
  confirmParticipation,
  getParticipationState,
} from './service.js'

export interface ParticipationRouteDeps {
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

const activityIdSchema = z.string().uuid()

/**
 * Registers the resident participation HTTP surface (#60 LL-MVP-004).
 *
 * The resident identity always comes from the server-side session created by
 * `createApp`. Nothing in the URL, query string, headers or body may name the
 * resident: the confirm body is a strict contract that only accepts an invite
 * code, so a forged `userId` fails parsing instead of being silently ignored.
 *
 * Responses are parsed with the shared contracts schemas before they are sent.
 * A service bug that drifts from the frozen contract therefore surfaces as a
 * server error instead of leaking an unvalidated payload to the H5.
 */
export function registerParticipationRoutes(
  app: Hono<AppBindings>,
  deps: ParticipationRouteDeps,
): void {
  const { db, config, fail, validCsrf, bodySchemaError } = deps

  const failWithParticipationError = (c: AppContext, error: unknown): Response => {
    if (error instanceof ParticipationError) {
      return fail(c, error.status, error.code, error.message)
    }
    throw error
  }

  /** Residents authenticate with the session cookie; a staff session is a user too. */
  const requireSession = (c: AppContext): AuthSession | Response => {
    const session = c.get('authSession')
    if (!session) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录居民账户')
    }
    return session
  }

  const requireActivityId = (c: AppContext): string | Response => {
    const parsed = activityIdSchema.safeParse(c.req.param('activityId'))
    if (!parsed.success) {
      return fail(c, 404, API_ERROR_CODES.notFound, '活动不存在')
    }
    return parsed.data
  }

  app.get(PARTICIPATION_ROUTES.state, (c) => {
    const session = requireSession(c)
    if (session instanceof Response) return session
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId

    try {
      const state = activityParticipationStateSchema.parse(
        getParticipationState(db, { activityId, userId: session.userId }),
      )
      return c.json(state)
    } catch (error) {
      return failWithParticipationError(c, error)
    }
  })

  app.post(PARTICIPATION_ROUTES.confirm, async (c) => {
    const session = requireSession(c)
    if (session instanceof Response) return session
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败，请刷新页面后重试')
    }
    const activityId = requireActivityId(c)
    if (activityId instanceof Response) return activityId

    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      activityParticipationConfirmRequestSchema,
    )
    if (!body) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '参与信息不正确')
    }

    try {
      const result = activityParticipationConfirmResponseSchema.parse(
        confirmParticipation(db, {
          activityId,
          // Session identity only: never accept a userId from the request.
          userId: session.userId,
          ...(body.inviteCode === undefined ? {} : { inviteCode: body.inviteCode }),
        }),
      )
      return c.json(result)
    } catch (error) {
      return failWithParticipationError(c, error)
    }
  })
}
