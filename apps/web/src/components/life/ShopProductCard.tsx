import { Link } from 'react-router'
import type { CrmebProductSummary } from '@sanchuang-dev/local-life-contracts'
import { ShopProductImage } from './ShopProductImage'
import { formatPriceCents, primaryCategory } from './shop'

/**
 * Real CRMEB product tile for the "优惠购" section.
 *
 * Every field comes from the shared product summary contract. The tile links to
 * that exact `crmebProductId`; it never substitutes one product for another, and
 * it carries the trusted activity deep-link id forward for attribution.
 */
export function ShopProductCard({
  product,
  activityId,
}: {
  product: CrmebProductSummary
  activityId: string | null
}) {
  const productSearch = activityId ? `?activityId=${encodeURIComponent(activityId)}` : ''
  const from = `/life?tab=deals${
    activityId ? `&activityId=${encodeURIComponent(activityId)}` : ''
  }`

  return (
    <Link
      to={{ pathname: `/life/product/${product.crmebProductId}`, search: productSearch }}
      state={{ from }}
      aria-label={`${product.name}，${formatPriceCents(product.priceCents)}，查看商品详情`}
      className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
    >
      <ShopProductImage
        src={product.images[0]}
        alt={product.name}
        className="aspect-square w-full object-cover"
      />
      <span className="flex min-w-0 flex-1 flex-col px-3 py-2.5">
        <span className="max-w-full truncate text-[10px] font-medium text-teal-700">
          {primaryCategory(product.categoryNames)}
        </span>
        <span className="mt-1 line-clamp-2 break-words text-[13px] font-semibold leading-5 text-slate-800">
          {product.name}
        </span>
        <span className="mt-auto flex flex-wrap items-baseline gap-1.5 pt-2">
          <span className="text-[15px] font-semibold leading-none text-[#a96b2f]">
            {formatPriceCents(product.priceCents)}
          </span>
          {product.originalPriceCents !== null &&
          product.originalPriceCents > product.priceCents ? (
            <span className="text-[10px] text-slate-400 line-through">
              {formatPriceCents(product.originalPriceCents)}
            </span>
          ) : null}
        </span>
      </span>
    </Link>
  )
}
