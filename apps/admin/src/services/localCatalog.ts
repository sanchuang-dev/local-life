import {
  LOCAL_CATALOG_ROUTES,
  createLocalProductRequestSchema,
  localProductDetailSchema,
  localProductListResponseSchema,
  updateLocalProductRequestSchema,
  type CreateLocalProductRequest,
  type LocalProductDetail,
  type LocalProductListQuery,
  type LocalProductListResponse,
  type LocalProductStatus,
  type UpdateLocalProductRequest,
} from '@sanchuang-dev/local-life-contracts'
import {
  fillRoute,
  parsePayload,
  requestLocalJson,
  withQuery,
} from './localApi'

/**
 * Back-office transport for the *local* product catalogue (#109).
 *
 * Every URL comes from `LOCAL_CATALOG_ROUTES` and every payload is validated by
 * the shared contract. `grid_worker` must never reach these calls — the API
 * answers 403; the page also refuses to issue them (see ProductsPage).
 */

export interface ProductListFilters {
  communityId?: string
  status?: LocalProductStatus
  category?: string
  keyword?: string
}

export async function listAdminProducts(
  query: LocalProductListQuery,
  signal?: AbortSignal,
): Promise<LocalProductListResponse> {
  const payload = await requestLocalJson(
    withQuery(`/api${LOCAL_CATALOG_ROUTES.adminProducts}`, {
      page: query.page,
      pageSize: query.pageSize,
      communityId: query.communityId,
      status: query.status,
      category: query.category,
      keyword: query.keyword,
    }),
    { signal },
  )
  return parsePayload(localProductListResponseSchema, payload, '本地商品列表')
}

export async function getAdminProduct(
  productId: string,
  signal?: AbortSignal,
): Promise<LocalProductDetail> {
  const payload = await requestLocalJson(
    `/api${fillRoute(LOCAL_CATALOG_ROUTES.adminProductDetail, ':productId', productId)}`,
    { signal },
  )
  return parsePayload(localProductDetailSchema, payload, '本地商品详情')
}

export async function createAdminProduct(
  csrfToken: string,
  request: CreateLocalProductRequest,
): Promise<LocalProductDetail> {
  // Re-validate locally so an out-of-range form value is reported before a round
  // trip; the server validates again regardless.
  const body = createLocalProductRequestSchema.parse(request)
  const payload = await requestLocalJson(`/api${LOCAL_CATALOG_ROUTES.adminProducts}`, {
    method: 'POST',
    csrfToken,
    body,
  })
  return parsePayload(localProductDetailSchema, payload, '新建本地商品结果')
}

export async function updateAdminProduct(
  csrfToken: string,
  productId: string,
  request: UpdateLocalProductRequest,
): Promise<LocalProductDetail> {
  const body = updateLocalProductRequestSchema.parse(request)
  const payload = await requestLocalJson(
    `/api${fillRoute(LOCAL_CATALOG_ROUTES.adminProductDetail, ':productId', productId)}`,
    { method: 'PATCH', csrfToken, body },
  )
  return parsePayload(localProductDetailSchema, payload, '保存本地商品结果')
}

/**
 * Put a product on / off the shelf. The contract is idempotent, so a double
 * click cannot inflate the audit trail; `expectedUpdatedAt` still protects a
 * concurrent edit from being silently overwritten.
 */
export async function setAdminProductShelf(
  csrfToken: string,
  productId: string,
  expectedUpdatedAt: string,
  status: LocalProductStatus,
): Promise<LocalProductDetail> {
  const payload = await requestLocalJson(
    `/api${fillRoute(LOCAL_CATALOG_ROUTES.adminProductShelf, ':productId', productId)}`,
    { method: 'POST', csrfToken, body: { expectedUpdatedAt, status } },
  )
  return parsePayload(localProductDetailSchema, payload, '本地商品上下架结果')
}
