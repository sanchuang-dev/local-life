import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, isNull, or } from 'drizzle-orm'
import { z } from 'zod'
import type { Hono } from 'hono'
import {
  API_ERROR_CODES, EXTERNAL_OFFER_ROUTES,
  createExternalOfferRequestSchema, externalOfferListSchema, externalOfferSchema,
  updateExternalOfferRequestSchema, type ExternalOffer,
} from '@sanchuang-dev/local-life-contracts'
import type { AppBindings, AppContext } from '../http.js'
import type { LocalRouteDeps } from '../local/routes.js'
import { externalOffers } from '../db/schema.js'
import { insertAudit } from '../local/shared.js'

const idSchema = z.string().uuid()

/** Pure external-link content: neither read nor click creates any business fact. */
export function registerExternalOfferRoutes(
  app: Hono<AppBindings>,
  { db, config, fail, validCsrf, bodySchemaError }: LocalRouteDeps,
  now: () => Date = () => new Date(),
): void {
  type Row = typeof externalOffers.$inferSelect
  const toOffer = (row: Row): ExternalOffer => externalOfferSchema.parse({
    id: row.id, kind: 'external_promotion', title: row.title,
    platform: row.platform, category: row.category, description: row.description,
    url: row.url, sortOrder: row.sortOrder, enabled: row.enabled,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  })
  const get = (id: string) => db.select().from(externalOffers).where(eq(externalOffers.id, id)).get()
  const order = [asc(externalOffers.sortOrder), asc(externalOffers.createdAt)]
  const guard = (c: AppContext, write: boolean): Response | { userId: string } => {
    const session = c.get('authSession')
    if (!session?.staff) return fail(c, 401, API_ERROR_CODES.unauthorized, '请先登录管理后台')
    if (session.staff.role !== 'admin' && session.staff.role !== 'operator') {
      return fail(c, 403, API_ERROR_CODES.forbidden, '无权管理第三方优惠')
    }
    if (write && !validCsrf(c, config, session)) {
      return fail(c, 403, API_ERROR_CODES.forbidden, 'CSRF 或来源校验失败')
    }
    return { userId: session.userId }
  }

  app.get(EXTERNAL_OFFER_ROUTES.publicList, (c) => {
    const items = db.select().from(externalOffers)
      .where(and(
        eq(externalOffers.enabled, true),
        or(isNull(externalOffers.expiresAt), gt(externalOffers.expiresAt, now())),
      )).orderBy(...order).all().map(toOffer)
    return c.json(externalOfferListSchema.parse({ items }))
  })

  app.get(EXTERNAL_OFFER_ROUTES.adminList, (c) => {
    const actor = guard(c, false)
    if (actor instanceof Response) return actor
    return c.json(externalOfferListSchema.parse({
      items: db.select().from(externalOffers).orderBy(...order).all().map(toOffer),
    }))
  })

  app.post(EXTERNAL_OFFER_ROUTES.adminList, async (c) => {
    const actor = guard(c, true)
    if (actor instanceof Response) return actor
    const input = bodySchemaError(await c.req.json().catch(() => null), createExternalOfferRequestSchema)
    if (!input) return fail(c, 400, API_ERROR_CODES.invalidRequest, '优惠内容或链接格式不正确')
    const id = randomUUID(), stamp = now()
    db.transaction((tx) => {
      tx.insert(externalOffers).values({
        ...input, id, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdAt: stamp, updatedAt: stamp, createdByUserId: actor.userId,
      }).run()
      insertAudit(tx, actor.userId, 'external_offer.created', id, stamp, {
        enabled: String(input.enabled),
      })
    })
    return c.json(toOffer(get(id)!), 201)
  })

  app.patch(EXTERNAL_OFFER_ROUTES.adminDetail, async (c) => {
    const actor = guard(c, true)
    if (actor instanceof Response) return actor
    const id = idSchema.safeParse(c.req.param('offerId'))
    if (!id.success) return fail(c, 404, API_ERROR_CODES.notFound, '优惠活动不存在')
    const input = bodySchemaError(await c.req.json().catch(() => null), updateExternalOfferRequestSchema)
    if (!input) return fail(c, 400, API_ERROR_CODES.invalidRequest, '优惠内容或链接格式不正确')
    const current = get(id.data)
    if (!current) return fail(c, 404, API_ERROR_CODES.notFound, '优惠活动不存在')
    if (current.updatedAt.toISOString() !== input.expectedUpdatedAt) {
      return fail(c, 409, API_ERROR_CODES.conflict, '优惠活动已变更，请刷新')
    }
    const stamp = new Date(Math.max(now().getTime(), current.updatedAt.getTime() + 1))
    const { expectedUpdatedAt: _token, ...changes } = input
    const updated = db.transaction((tx) => {
      const result = tx.update(externalOffers).set({
        ...changes, expiresAt: changes.expiresAt ? new Date(changes.expiresAt) : null,
        updatedAt: stamp,
      }).where(and(eq(externalOffers.id, id.data), eq(externalOffers.updatedAt, current.updatedAt))).run()
      if (result.changes !== 1) return false
      insertAudit(tx, actor.userId, 'external_offer.updated', id.data, stamp, {
        enabled: String(input.enabled),
      })
      return true
    })
    if (!updated) return fail(c, 409, API_ERROR_CODES.conflict, '优惠活动已变更，请刷新')
    return c.json(toOffer(get(id.data)!))
  })
}
