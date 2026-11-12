import { ChevronRight, Tv } from 'lucide-react'
import { Link } from 'react-router'
import type { GdQuickEntry } from '../../mocks/home'

type GdFeatureCardProps = {
  entries: GdQuickEntry[]
}

/**
 * Home feature card for the broadcasting-network services. Every shortcut
 * enters the one `/gd` display page that already exists in this slice.
 */
export function GdFeatureCard({ entries }: GdFeatureCardProps) {
  return (
    <article className="rounded-[20px] border border-teal-100/80 bg-white p-4 shadow-[0_8px_24px_rgba(15,52,44,0.05)]">
      <div className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[#e8f6f0] text-[#388b77]"
          aria-hidden="true"
        >
          <Tv size={22} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold leading-5 text-slate-800">广电服务</h2>
          <p className="mt-0.5 truncate text-[12px] text-slate-500">手机卡 · 宽带 · 电视 · 上门服务</p>
        </div>
        <Link
          to="/gd"
          className="inline-flex min-h-[44px] shrink-0 items-center gap-0.5 rounded-full px-2 text-[12px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          全部
          <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1 border-t border-slate-100 pt-2">
        {entries.map(({ id, label, icon: Icon }) => (
          <Link
            key={id}
            to="/gd"
            className="flex min-h-[62px] flex-col items-center justify-center gap-1.5 rounded-xl py-1 text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            <span
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#e8f6f0] text-[#388b77]"
              aria-hidden="true"
            >
              <Icon size={19} strokeWidth={1.7} />
            </span>
            <span className="text-[11px] font-medium leading-none">{label}</span>
          </Link>
        ))}
      </div>
    </article>
  )
}
