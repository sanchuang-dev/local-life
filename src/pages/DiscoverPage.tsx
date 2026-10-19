import {
  ChevronRight,
  Compass,
  Gift,
  HeartPulse,
  House,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { Link } from 'react-router'
import { DemoNote } from '../components/DemoNote'
import { demoIndexGroups } from '../mocks/me'

const groupIcons: Record<string, LucideIcon> = {
  home: House,
  community: Users,
  health: HeartPulse,
  life: Gift,
  me: UserRound,
}

/**
 * Discover is a temporary, operable index of the pages that already exist.
 * It replaces the former empty scaffold without claiming a final product tab.
 */
export function DiscoverPage() {
  return (
    <div className="px-4 pb-7 pt-4">
      <section className="rounded-[22px] border border-slate-100 bg-white p-5 shadow-sm">
        <span
          className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-[#e4f4ed] text-teal-700"
          aria-hidden="true"
        >
          <Compass size={29} strokeWidth={1.7} />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">发现</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          从现有演示页面继续浏览社区、健康、惠生活等服务。
        </p>
        <span className="mt-4 inline-flex rounded-full bg-amber-50 px-3 py-1.5 text-[11px] font-medium text-amber-700">
          示例服务导览 · 非正式导航定稿
        </span>
      </section>

      <DemoNote>
        本页只汇总已迁演示页面，方便继续浏览和回归检查；底部三个 Tab 的名称、数量与信息架构仍待产品确认。
      </DemoNote>

      <div className="mt-5 grid gap-3">
        {demoIndexGroups.map((group) => {
          const Icon = groupIcons[group.id] ?? Compass
          return (
            <section
              key={group.id}
              className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm"
            >
              <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#e8f6f0] text-[#388b77]"
                  aria-hidden="true"
                >
                  <Icon size={17} strokeWidth={1.7} />
                </span>
                <h2 className="text-[14px] font-semibold text-slate-800">{group.title}</h2>
              </div>
              <div>
                {group.entries.map((entry, index) => (
                  <Link
                    key={entry.to}
                    to={entry.to}
                    className={`flex min-h-[48px] w-full items-center gap-3 px-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600 ${
                      index > 0 ? 'border-t border-slate-100' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1 text-[13px] font-medium text-slate-600">
                      {entry.label}
                    </span>
                    <ChevronRight size={16} className="shrink-0 text-slate-300" aria-hidden="true" />
                  </Link>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <div className="mt-5">
        <DemoNote tone="warn">
          导览中的页面、活动与数据均为演示内容，未接入真实社区、健康、广电或交易服务。
        </DemoNote>
      </div>
    </div>
  )
}
