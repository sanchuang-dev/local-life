import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES,
  USER_DIRECTORY_ROUTES,
  userDirectoryQuerySchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'
import {
  UserDirectoryError,
  getUserDirectory,
  listUserDirectory,
  type UserDirectoryActor,
} from './service.js'

export interface UserDirectoryRouteDeps {
  db: AppDatabase
  fail: (
    c: AppContext,
    status: HttpErrorStatus,
    code: ApiErrorCode,
    message: string,
  ) => Response
}

const userIdSchema = z.string().uuid()

/**
 * Registers the back-office user directory (#153 LL-USER-001 T2).
 *
 * Session resolution, the shared error envelope and request ids all come from
 * `createApp`; this module never re-implements authentication. Both routes are
 * read-only GETs, so no CSRF token is involved. Responses are validated against
 * the single shared contract before they leave the API.
 */
export function registerUserDirectoryRoutes(
  app: Hono<AppBindings>,
  deps: UserDirectoryRouteDeps,
): void {
  const { db, fail } = deps

  const requireStaff = (c: AppContext): AuthSession | Response => {
    const session = c.get('authSession')
    if (!session?.staff) {
      return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    }
    return session
  }

  const actorOf = (session: AuthSession): UserDirectoryActor => ({
    staffId: session.staff!.id,
    role: session.staff!.role,
  })

  const failWithDirectoryError = (c: AppContext, error: unknown): Response => {
    if (error instanceof UserDirectoryError) {
      return fail(c, error.status, error.code, error.message)
    }
    throw error
  }

  // Empty query values (`keyword=`, `role=`) mean "no filter", exactly like the
  // rest of the admin API. The shared contract rejects whitespace-only input.
  const queryObject = (c: AppContext): Record<string, string> => {
    const cleaned: Record<string, string> = {}
    for (const [key, value] of Object.entries(c.req.query())) {
      if (value !== '' && value.trim() !== '') cleaned[key] = value
    }
    return cleaned
  }

  app.get(USER_DIRECTORY_ROUTES.list, (c) => {
    const session = requireStaff(c)
    if (session instanceof Response) return session
    const parsed = userDirectoryQuerySchema.safeParse(queryObject(c))
    if (!parsed.success) {
      return fail(c, 400, API_ERROR_CODES.invalidRequest, '页码、搜索或筛选条件无效')
    }
    try {
      return c.json(listUserDirectory(db, actorOf(session), parsed.data))
    } catch (error) {
      return failWithDirectoryError(c, error)
    }
  })

  app.get(USER_DIRECTORY_ROUTES.detail, (c) => {
    const session = requireStaff(c)
    if (session instanceof Response) return session
    const parsed = userIdSchema.safeParse(c.req.param('userId'))
    if (!parsed.success) {
      // A malformed id is indistinguishable from a missing one on purpose.
      return fail(c, 404, API_ERROR_CODES.notFound, '用户不存在')
    }
    try {
      return c.json(getUserDirectory(db, actorOf(session), parsed.data))
    } catch (error) {
      return failWithDirectoryError(c, error)
    }
  })
}
