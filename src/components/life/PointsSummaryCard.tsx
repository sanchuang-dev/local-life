import { ChevronRight, Coins } from 'lucide-react'
import { Link } from 'react-router'
import { lifePoints } from '../../mocks/life'

/**
 * The resident-points balance block shared by the life and exchange screens.
 * The balance is static fixture data, never a real account value.
 */
export function PointsSummaryCard() {
  return (
    <article className="rounded-[20px] border border-[#e8d2a8] bg-[#fff7ec] p-4">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[#a96b2f]">
            <Coins size={14} aria-hidden="true" />
            社区居民权益积分
          </span>
          <p className="mt-1.5 flex items-baseline gap-1">
            <span className="text-[34px] font-semibold leading-none tracking-tight text-[#8a6132]">
              {lifePoints.current}
            </span>
            <span className="text-[12px] font-medium text-[#a96b2f]">积分</span>
          </p>
          <p className="mt-1 text-[11px] text-[#a96b2f]/80">可用积分 · 演示余额</p>
        </div>
        <Link
          to="/points"
          className="inline-flex min-h-[44px] shrink-0 items-center gap-0.5 rounded-xl border border-[#e8d2a8] bg-white px-3 text-[12px] font-semibold text-[#8a6132] transition-colors hover:bg-[#fffdf8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          积分明细
          <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </article>
  )
}
