import { Link } from 'react-router'
import { AlertTriangle, ChevronRight, MapPin, ShoppingBasket } from 'lucide-react'
import type { LocalProductSummary } from '@sanchuang-dev/local-life-contracts'
import { formatLocalPriceCents } from './localOrderLabels'
import { localProductHref } from './catalogLinks'

/**
 * One real local product.
 *
 * Every field comes from `/catalog/products`; the tile never invents a price, a
 * discount or a stock claim. The whole tile is a link so a 320px viewport has a
 * comfortable touch target instead of a small inline "查看" button.
 */
export function LocalProductCard({
  product,
  activityId = null,
}: {
  product: LocalProductSummary
  activityId?: string | null
}) {
  return (
    <Link
      to={localProductHref(product.id, activityId)}
      state={{ from: activityId ? `/life?activityId=${activityId}` : '/life' }}
      aria-label={`${product.name}，${formatLocalPriceCents(product.priceCents)}，查看本地商品详情`}
      className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
    >
      {product.imageUrl ? (
        <img
          src={product.imageUrl}
          alt={product.name}
          loading="lazy"
          className="aspect-[4/3] w-full object-cover"
        />
      ) : (
        <span
          className="flex aspect-[4/3] w-full items-center justify-center bg-[#eef7f2] text-[#388b77]"
          aria-hidden="true"
        >
          <ShoppingBasket size={30} strokeWidth={1.5} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col px-3 py-2.5">
        <span className="max-w-full truncate text-[10px] font-medium text-teal-700">
          {product.category ?? '本地商品'}
        </span>
        <span className="mt-1 line-clamp-2 break-words text-[13px] font-semibold leading-5 text-slate-800">
          {product.name}
        </span>
        {product.summary ? (
          <span className="mt-0.5 line-clamp-1 break-words text-[10px] leading-4 text-slate-400">
            {product.summary}
          </span>
        ) : null}
        <span className="mt-auto flex flex-wrap items-baseline gap-1.5 pt-2">
          <span className="text-[15px] font-semibold leading-none text-[#a96b2f]">
            {formatLocalPriceCents(product.priceCents)}
          </span>
          <span className="text-[10px] text-slate-400">登记后由工作人员办理</span>
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-0.5 text-[10px] text-slate-400">
          <MapPin size={11} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{product.community.name}</span>
          <ChevronRight size={12} className="ml-auto shrink-0 text-slate-300" aria-hidden="true" />
        </span>
      </span>
    </Link>
  )
}

/** Skeleton grid shown while the catalogue is read. */
export function LocalProductSkeletons() {
  return (
    <div className="grid grid-cols-2 gap-3" role="status" aria-live="polite">
      {[0, 1, 2, 3].map((item) => (
        <div
          key={item}
          className="h-[196px] animate-pulse rounded-2xl border border-slate-100 bg-white"
        />
      ))}
    </div>
  )
}

/** Inline failure with the server's own sentence and a real retry. */
export function LocalCatalogError({
  message,
  code,
  onRetry,
}: {
  message: string
  code?: string | null
  onRetry: () => void
}) {
  return (
    <section
      role="alert"
      className="rounded-2xl border border-rose-100 bg-white px-4 py-4 shadow-sm"
    >
      <p className="flex items-center gap-1.5 text-[13px] font-bold text-rose-700">
        <AlertTriangle size={15} className="shrink-0" aria-hidden="true" />
        本地商品读取失败
      </p>
      <p className="mt-1 break-words text-[12px] leading-5 text-slate-500">{message}</p>
      {code ? (
        <p className="mt-1 break-all font-mono text-[10px] text-slate-400">错误代码：{code}</p>
      ) : null}
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
      >
        重新读取
      </button>
    </section>
  )
}
