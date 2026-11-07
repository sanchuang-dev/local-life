import { randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  createLocalProductRequestSchema,
  localProductDetailSchema,
  localProductListResponseSchema,
  localProductSummarySchema,
  type CreateLocalProductRequest,
  type LocalProductDetail,
  type LocalProductListQuery,
  type LocalProductListResponse,
  type LocalProductSummary,
  type LocalProductStatus,
  type UpdateLocalProductRequest,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import { communities, localProducts } from '../db/schema.js'
import {
  LocalError,
  assertCommunityAccess,
  assertExpectedUpdatedAt,
  combine,
  escapedLike,
  insertAudit,
  iso,
  mapConstraintError,
  nextUpdatedAt,
  scopeCommunityIds,
  type LocalActor,
} from './shared.js'

/* ------------------------------- Selections ------------------------------- */

const productSelection = {
  id: localProducts.id,
  communityId: localProducts.communityId,
  communityName: communities.name,
  name: localProducts.name,
  summary: localProducts.summary,
  description: localProducts.description,
  category: localProducts.category,
  unitPriceCents: localProducts.unitPriceCents,
  imageUrl: localProducts.imageUrl,
  status: localProducts.status,
  createdAt: localProducts.createdAt,
  updatedAt: localProducts.updatedAt,
}

export type ProductRow = {
  id: string
  communityId: string
  communityName: string
  name: string
  summary: string | null
  description: string | null
  category: string | null
  unitPriceCents: number
  imageUrl: string | null
  status: LocalProductStatus
  createdAt: Date
  updatedAt: Date
}

function productQuery(db: AppDatabase) {
  return db
    .select(productSelection)
    .from(localProducts)
    .innerJoin(communities, eq(localProducts.communityId, communities.id))
}

export function findProduct(db: AppDatabase, productId: string): ProductRow | undefined {
  return productQuery(db).where(eq(localProducts.id, productId)).get()
}

export function requireProduct(db: AppDatabase, productId: string): ProductRow {
  const row = findProduct(db, productId)
  if (!row) throw new LocalError(404, API_ERROR_CODES.notFound, '商品不存在')
  return row
}

/* --------------------------------- Mappers -------------------------------- */

export function toProductSummary(row: ProductRow): LocalProductSummary {
  return localProductSummarySchema.parse({
    id: row.id,
    community: { id: row.communityId, name: row.communityName },
    name: row.name,
    summary: row.summary,
    category: row.category,
    priceCents: row.unitPriceCents,
    imageUrl: row.imageUrl,
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  })
}

export function toProductDetail(row: ProductRow): LocalProductDetail {
  return localProductDetailSchema.parse({
    ...toProductSummary(row),
    description: row.description,
  })
}

function productDetailById(db: AppDatabase, productId: string): LocalProductDetail {
  return toProductDetail(requireProduct(db, productId))
}

/* -------------------------------- Catalogue -------------------------------- */

/**
 * Public catalogue list. Only `on_shelf` products are visible to a resident, and
 * an off-shelf product is a 404 on the detail route — the same "off shelf means
 * gone" precedent the CRMEB adapter already established.
 */
export function listPublicProducts(
  db: AppDatabase,
  query: LocalProductListQuery,
): LocalProductListResponse {
  const conditions: SQL<unknown>[] = [eq(localProducts.status, 'on_shelf')]
  if (query.communityId) conditions.push(eq(localProducts.communityId, query.communityId))
  if (query.category) conditions.push(eq(localProducts.category, query.category))
  if (query.keyword) {
    const pattern = escapedLike(query.keyword)
    conditions.push(
      or(
        sql`${localProducts.name} LIKE ${pattern} ESCAPE '\\'`,
        sql`${localProducts.summary} LIKE ${pattern} ESCAPE '\\'`,
      )!,
    )
  }
  const where = combine(conditions)
  const total = db.select({ value: count() }).from(localProducts).where(where).get()?.value ?? 0
  const rows = productQuery(db)
    .where(where)
    .orderBy(desc(localProducts.updatedAt), asc(localProducts.name))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all()
  return localProductListResponseSchema.parse({
    items: rows.map(toProductSummary),
    total,
    page: query.page,
    pageSize: query.pageSize,
  })
}

export function getPublicProduct(db: AppDatabase, productId: string): LocalProductDetail {
  const row = requireProduct(db, productId)
  if (row.status !== 'on_shelf') {
    // Deliberately 404: a resident must not be able to tell "never existed" from
    // "taken off the shelf", matching the CRMEB detail behaviour.
    throw new LocalError(404, API_ERROR_CODES.notFound, '商品不存在')
  }
  return toProductDetail(row)
}

export function listAdminProducts(
  db: AppDatabase,
  actor: LocalActor,
  query: LocalProductListQuery,
): LocalProductListResponse {
  const scope = scopeCommunityIds(db, actor)
  const conditions: SQL<unknown>[] = []
  if (scope !== null) {
    if (scope.length === 0) {
      return localProductListResponseSchema.parse({
        items: [],
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
      })
    }
    conditions.push(inArray(localProducts.communityId, scope))
  }
  if (query.communityId) {
    assertCommunityAccess(db, actor, query.communityId)
    conditions.push(eq(localProducts.communityId, query.communityId))
  }
  if (query.status) conditions.push(eq(localProducts.status, query.status))
  if (query.category) conditions.push(eq(localProducts.category, query.category))
  if (query.keyword) {
    const pattern = escapedLike(query.keyword)
    conditions.push(
      or(
        sql`${localProducts.name} LIKE ${pattern} ESCAPE '\\'`,
        sql`${localProducts.summary} LIKE ${pattern} ESCAPE '\\'`,
      )!,
    )
  }

  const where = combine(conditions)
  const total = db.select({ value: count() }).from(localProducts).where(where).get()?.value ?? 0
  const rows = productQuery(db)
    .where(where)
    .orderBy(desc(localProducts.updatedAt), asc(localProducts.name))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all()
  return localProductListResponseSchema.parse({
    items: rows.map(toProductSummary),
    total,
    page: query.page,
    pageSize: query.pageSize,
  })
}

// Kept local so the import list above stays limited to what is really used.
export function getAdminProduct(
  db: AppDatabase,
  actor: LocalActor,
  productId: string,
): LocalProductDetail {
  const row = requireProduct(db, productId)
  assertCommunityAccess(db, actor, row.communityId)
  return toProductDetail(row)
}

export function createProduct(
  db: AppDatabase,
  actor: LocalActor,
  body: CreateLocalProductRequest,
): LocalProductDetail {
  assertCommunityAccess(db, actor, body.communityId)
  const community = db
    .select({ id: communities.id })
    .from(communities)
    .where(eq(communities.id, body.communityId))
    .get()
  if (!community) throw new LocalError(404, API_ERROR_CODES.notFound, '社区不存在')

  // Re-validate through the shared schema so the stored row can never drift from
  // the request contract even if a caller reaches the service directly.
  const parsed = createLocalProductRequestSchema.parse(body)
  const now = new Date()
  const productId = randomUUID()
  try {
    db.transaction((tx) => {
      tx.insert(localProducts)
        .values({
          id: productId,
          communityId: parsed.communityId,
          name: parsed.name,
          summary: parsed.summary ?? null,
          description: parsed.description ?? null,
          category: parsed.category ?? null,
          unitPriceCents: parsed.priceCents,
          imageUrl: parsed.imageUrl ?? null,
          status: 'off_shelf',
          createdByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      insertAudit(tx, actor.userId, 'local_catalog.product.created', productId, now, {
        communityId: parsed.communityId,
        priceCents: String(parsed.priceCents),
        status: 'off_shelf',
      })
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return productDetailById(db, productId)
}

export function updateProduct(
  db: AppDatabase,
  actor: LocalActor,
  productId: string,
  body: UpdateLocalProductRequest,
): LocalProductDetail {
  const row = requireProduct(db, productId)
  assertCommunityAccess(db, actor, row.communityId)
  assertExpectedUpdatedAt(row.updatedAt, body.expectedUpdatedAt)

  const now = new Date()
  const updatedAt = nextUpdatedAt(row.updatedAt, now)
  const changes: Partial<typeof localProducts.$inferInsert> = { updatedAt }
  if (body.name !== undefined) changes.name = body.name
  if (body.summary !== undefined) changes.summary = body.summary
  if (body.description !== undefined) changes.description = body.description
  if (body.category !== undefined) changes.category = body.category
  if (body.priceCents !== undefined) changes.unitPriceCents = body.priceCents
  if (body.imageUrl !== undefined) changes.imageUrl = body.imageUrl

  try {
    db.transaction((tx) => {
      const result = tx
        .update(localProducts)
        .set(changes)
        .where(
          and(
            eq(localProducts.id, productId),
            eq(localProducts.updatedAt, row.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new LocalError(409, API_ERROR_CODES.conflict, '商品已被其他操作更新，请刷新后重试')
      }
      insertAudit(tx, actor.userId, 'local_catalog.product.updated', productId, now, {
        communityId: row.communityId,
        fields: Object.keys(changes)
          .filter((key) => key !== 'updatedAt')
          .sort()
          .join(','),
      })
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return productDetailById(db, productId)
}

/**
 * Put a product on / take it off the shelf. Idempotent by contract: asking for
 * the status the product already has is a no-op that still advances nothing and
 * writes no audit row, so a double click cannot inflate the trail.
 */
export function setProductShelf(
  db: AppDatabase,
  actor: LocalActor,
  productId: string,
  expectedUpdatedAt: string,
  status: LocalProductStatus,
): LocalProductDetail {
  const row = requireProduct(db, productId)
  assertCommunityAccess(db, actor, row.communityId)
  assertExpectedUpdatedAt(row.updatedAt, expectedUpdatedAt)
  if (row.status === status) {
    return toProductDetail(row)
  }

  const now = new Date()
  const updatedAt = nextUpdatedAt(row.updatedAt, now)
  try {
    db.transaction((tx) => {
      const result = tx
        .update(localProducts)
        .set({ status, updatedAt })
        .where(
          and(
            eq(localProducts.id, productId),
            eq(localProducts.status, row.status),
            eq(localProducts.updatedAt, row.updatedAt),
          ),
        )
        .run()
      if (result.changes !== 1) {
        throw new LocalError(409, API_ERROR_CODES.conflict, '商品已被其他操作更新，请刷新后重试')
      }
      insertAudit(tx, actor.userId, 'local_catalog.product.shelf_changed', productId, now, {
        communityId: row.communityId,
        fromStatus: row.status,
        toStatus: status,
      })
    })
  } catch (error) {
    mapConstraintError(error)
  }
  return productDetailById(db, productId)
}
