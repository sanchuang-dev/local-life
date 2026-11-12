import {
  LOCAL_CATALOG_ROUTES,
  localProductDetailSchema,
  localProductListResponseSchema,
  type LocalProductDetail,
  type LocalProductListQuery,
  type LocalProductListResponse,
} from '@sanchuang-dev/local-life-contracts'
import { API_PREFIX, fillRoute, requestLocal, withQuery } from './localApi'

/**
 * Resident catalogue client for the *local* on-shelf products (#109).
 *
 * Read-only by design: residents have no product write route, so nothing here
 * builds a POST/PATCH. Both calls are session-free — looking at what a community
 * offers never requires signing in; the checkout-side gate lives in the order
 * registration service.
 */

/**
 * Filters the resident catalogue accepts.
 *
 * `page`/`pageSize` are optional because the API applies the contract defaults;
 * the client only sends what the visitor actually chose.
 */
export type LocalProductFilters = Partial<LocalProductListQuery>

/** GET /catalog/products — the public on-shelf catalogue of one community. */
export function listLocalProducts(
  query: LocalProductFilters = {},
  signal?: AbortSignal,
): Promise<LocalProductListResponse> {
  return requestLocal(
    `${API_PREFIX}${withQuery(LOCAL_CATALOG_ROUTES.products, {
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
      communityId: query.communityId,
      category: query.category,
      keyword: query.keyword,
    })}`,
    localProductListResponseSchema,
    '本地商品列表',
    { signal },
  )
}

/** GET /catalog/products/:productId — 404 when the product is off the shelf. */
export function getLocalProduct(
  productId: string,
  signal?: AbortSignal,
): Promise<LocalProductDetail> {
  return requestLocal(
    `${API_PREFIX}${fillRoute(LOCAL_CATALOG_ROUTES.productDetail, ':productId', productId)}`,
    localProductDetailSchema,
    '本地商品详情',
    { signal },
  )
}
