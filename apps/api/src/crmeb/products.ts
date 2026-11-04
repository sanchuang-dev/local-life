import {
  crmebProductDetailSchema,
  crmebProductListResponseSchema,
  crmebProductSkuSchema,
  crmebProductSummarySchema,
  type CrmebProductDetail,
  type CrmebProductListResponse,
  type CrmebProductSummary,
  type CrmebRawProduct,
} from '@sanchuang-dev/local-life-contracts'
import { CrmebClientError, type CrmebOutapiClient } from './client.js'
import { parseDecimalYuanToCents } from './money.js'

export interface CrmebProductListQuery {
  page: number
  limit: number
  categoryId?: number | undefined
  keyword?: string | undefined
}

function resolveAssetUrl(value: string, assetBaseUrl: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed, `${assetBaseUrl.replace(/\/+$/, '')}/`).toString()
  } catch {
    return null
  }
}

/**
 * `slider_image` is a Model getter (`json_decode`) so it is normally an array,
 * but the evidence marks the runtime type as unverified. Accept both an array
 * and a JSON/plain string instead of failing the whole product.
 */
function parseSliderImages(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string')
    }
  } catch {
    // Fall through: treat it as a single URL below.
  }
  return [value]
}

function parseIntegerList(
  value: Array<number | string> | string | null | undefined,
): number[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const result: number[] = []
  for (const entry of raw) {
    const parsed = Number(String(entry).trim())
    if (Number.isSafeInteger(parsed) && parsed >= 0) result.push(parsed)
  }
  return result
}

function parseCategoryNames(value: string | null | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

function requirePriceCents(raw: CrmebRawProduct): number {
  const cents = parseDecimalYuanToCents(raw.price)
  if (cents === null) {
    throw new CrmebClientError(
      'contract_mismatch',
      `CRMEB 商品 ${raw.id} 的 price 不是合法 decimal 金额`,
    )
  }
  return cents
}

function optionalPriceCents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  return parseDecimalYuanToCents(value)
}

function imagesOf(raw: CrmebRawProduct, assetBaseUrl: string): string[] {
  const urls = [raw.image ?? '', ...parseSliderImages(raw.slider_image)]
    .map((value) => resolveAssetUrl(value, assetBaseUrl))
    .filter((value): value is string => Boolean(value))
  return [...new Set(urls)]
}

export function normalizeCrmebProductSummary(
  raw: CrmebRawProduct,
  assetBaseUrl: string,
): CrmebProductSummary {
  const specType = Number(raw.spec_type) === 1 ? 1 : 0
  return crmebProductSummarySchema.parse({
    id: `crmeb:${raw.id}`,
    crmebProductId: raw.id,
    name: raw.store_name,
    summary: raw.store_info ?? '',
    images: imagesOf(raw, assetBaseUrl),
    priceCents: requirePriceCents(raw),
    originalPriceCents: optionalPriceCents(raw.ot_price),
    categoryIds: parseIntegerList(raw.cate_id),
    categoryNames: parseCategoryNames(raw.cate_name),
    // CRMEB detail does not validate is_show/is_del, so the adapter checks it
    // here for both list and detail payloads.
    onShelf: Number(raw.is_show) === 1,
    specType,
    stockKnown: false,
  })
}

export function normalizeCrmebProductDetail(
  raw: CrmebRawProduct,
  assetBaseUrl: string,
): CrmebProductDetail {
  const summary = normalizeCrmebProductSummary(raw, assetBaseUrl)
  const skus = (raw.attrs ?? []).map((attr, index) => {
    const priceCents =
      optionalPriceCents(attr.price) ?? summary.priceCents
    const specText = Array.isArray(attr.suk)
      ? attr.suk.join(' / ') || null
      : attr.suk?.trim() || null
    const skuKey = String(attr.unique ?? attr.id ?? `sku-${index}`)
    return crmebProductSkuSchema.parse({
      skuKey,
      priceCents,
      image: attr.image ? resolveAssetUrl(attr.image, assetBaseUrl) : null,
      specText,
    })
  })
  return crmebProductDetailSchema.parse({
    ...summary,
    detailHtml: raw.description ?? '',
    skus,
  })
}

/** Public product list: only on-shelf rows are ever exposed to residents. */
export async function listCrmebProducts(
  client: CrmebOutapiClient,
  assetBaseUrl: string,
  query: CrmebProductListQuery,
): Promise<CrmebProductListResponse> {
  const raw = await client.listProducts(query)
  const items = raw.list
    .map((product) => normalizeCrmebProductSummary(product, assetBaseUrl))
    .filter((product) => product.onShelf)
  const total = Math.max(0, Math.trunc(raw.count))
  return crmebProductListResponseSchema.parse({
    items,
    page: query.page,
    limit: query.limit,
    total,
    hasMore: query.page * query.limit < total,
    source: 'crmeb_outapi',
    fetchedAt: new Date().toISOString(),
  })
}

/**
 * Public product detail. CRMEB's detail endpoint returns off-shelf and even
 * soft-deleted products, so the adapter re-checks `is_show` and refuses to show
 * anything that is not actually on sale.
 */
export async function getCrmebProduct(
  client: CrmebOutapiClient,
  assetBaseUrl: string,
  productId: number,
): Promise<CrmebProductDetail> {
  const raw = await client.getProduct(productId)
  const detail = normalizeCrmebProductDetail(raw, assetBaseUrl)
  if (!detail.onShelf) {
    throw new CrmebClientError('not_found', `CRMEB 商品 ${productId} 已下架或不可售`)
  }
  return detail
}
