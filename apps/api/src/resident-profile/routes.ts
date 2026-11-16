import type { z } from 'zod'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  RESIDENT_PROFILE_ROUTES,
  maskMainlandPhone,
  residentProfileResponseSchema,
  updateResidentProfileRequestSchema,
  type ApiErrorCode,
} from '@sanchuang-dev/local-life-contracts'

import type { ApiConfig } from '../config.js'
import type { AppDatabase } from '../db/client.js'
import { residentPhoneIdentities, residentProfiles, users, wechatIdentities } from '../db/schema.js'
import type { AppBindings, AppContext, AuthSession, HttpErrorStatus } from '../http.js'

export interface ResidentProfileRouteDeps {
  db: AppDatabase
  config: ApiConfig
  fail: (c: AppContext, status: HttpErrorStatus, code: ApiErrorCode, message: string) => Response
  validCsrf: (c: AppContext, config: ApiConfig, session?: AuthSession | null) => boolean
  bodySchemaError: <T>(value: unknown, schema: z.ZodType<T>) => T | null
  now?: () => Date
}

function residentProfilePayload(db: AppDatabase, userId: string) {
  const user = db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).get()
  const profile = db.select().from(residentProfiles).where(eq(residentProfiles.userId, userId)).get()
  const phone = db
    .select({ phone: residentPhoneIdentities.phone })
    .from(residentPhoneIdentities)
    .where(eq(residentPhoneIdentities.userId, userId))
    .get()
  const wechat = db
    .select({
      nickname: wechatIdentities.nickname,
      avatarUrl: wechatIdentities.avatarUrl,
      profileAuthorizedAt: wechatIdentities.profileAuthorizedAt,
      profileUpdatedAt: wechatIdentities.profileUpdatedAt,
      createdAt: wechatIdentities.createdAt,
    })
    .from(wechatIdentities)
    .where(eq(wechatIdentities.userId, userId))
    .all()
    .filter((identity) => identity.profileAuthorizedAt !== null)
    .sort((a, b) =>
      (b.profileUpdatedAt?.getTime() ?? b.profileAuthorizedAt?.getTime() ?? b.createdAt.getTime())
      - (a.profileUpdatedAt?.getTime() ?? a.profileAuthorizedAt?.getTime() ?? a.createdAt.getTime()),
    )[0] ?? null

  return residentProfileResponseSchema.parse({
    userId,
    displayName: user?.displayName ?? null,
    wechat: wechat ? {
      nickname: wechat.nickname,
      avatarUrl: wechat.avatarUrl,
      profileUpdatedAt: (wechat.profileUpdatedAt ?? wechat.profileAuthorizedAt)?.toISOString() ?? null,
    } : null,
    phone: {
      maskedPhone: phone ? maskMainlandPhone(phone.phone) : null,
    },
    contactAddress: profile?.contactAddress ?? null,
    updatedAt: profile?.updatedAt.toISOString() ?? null,
  })
}

export function registerResidentProfileRoutes(
  app: Hono<AppBindings>,
  deps: ResidentProfileRouteDeps,
): void {
  const { db, config, fail, validCsrf, bodySchemaError } = deps
  const now = deps.now ?? (() => new Date())

  const requireResident = (c: AppContext): AuthSession | Response => {
    const session = c.get('authSession')
    if (!session) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录居民账户')
    if (session.staff) return fail(c, 403, API_ERROR_CODES.forbidden, '工作人员账户请使用管理后台')
    return session
  }

  app.get(RESIDENT_PROFILE_ROUTES.profile, (c) => {
    const session = requireResident(c)
    if (session instanceof Response) return session
    c.header('Cache-Control', 'no-store')
    return c.json(residentProfilePayload(db, session.userId))
  })

  app.patch(RESIDENT_PROFILE_ROUTES.profile, async (c) => {
    const session = requireResident(c)
    if (session instanceof Response) return session
    if (!validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 校验失败，请刷新页面后重试')
    }
    const body = bodySchemaError(
      await c.req.json().catch(() => null),
      updateResidentProfileRequestSchema,
    )
    if (!body) return fail(c, 400, API_ERROR_CODES.invalidRequest, '联系地址格式不正确')

    const current = now()
    const existing = db.select().from(residentProfiles).where(eq(residentProfiles.userId, session.userId)).get()
    if (existing) {
      db.update(residentProfiles)
        .set({ contactAddress: body.contactAddress, updatedAt: current })
        .where(eq(residentProfiles.userId, session.userId))
        .run()
    } else if (body.contactAddress !== null) {
      db.insert(residentProfiles).values({
        userId: session.userId,
        contactAddress: body.contactAddress,
        createdAt: current,
        updatedAt: current,
      }).run()
    }

    c.header('Cache-Control', 'no-store')
    return c.json(residentProfilePayload(db, session.userId))
  })
}
