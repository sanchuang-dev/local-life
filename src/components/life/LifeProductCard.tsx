import { Link } from 'react-router'
import type { LifeProduct } from '../../mocks/life'

const toneStyles = {
  mint: 'bg-gradient-to-br from-[#e8f6f0] to-[#d5ece1] text-[#388b77]',
  peach: 'bg-gradient-to-br from-[#fff3e6] to-[#f9e1c9] text-[#c6925c]',
} as const

/**
 * Goods tile shared by the life and exchange screens. Every tile links to its
 * own product id so a detail page does not substitute one product for another.
 */
export function LifeProductCard({ product }: { product: LifeProduct }) {
  const Icon = product.icon

  return (
    <Link
      to={`/life/product/${product.id}`}
      className="group flex min-w-0 flex-col overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
    >
      <span
        className={`flex aspect-[4/3] items-center justify-center ${toneStyles[product.tone]}`}
        aria-hidden="true"
      >
        <Icon size={38} strokeWidth={1.5} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col px-3 py-2.5">
        <span className="line-clamp-2 text-[14px] font-semibold leading-5 text-slate-800">
          {product.name}
        </span>
        <span className="mt-auto inline-flex items-baseline gap-0.5 pt-1.5 text-[13px] font-semibold text-[#a96b2f]">
          <span className="text-[10px] font-medium text-slate-400">积分</span>
          {product.points}
        </span>
      </span>
    </Link>
  )
}
