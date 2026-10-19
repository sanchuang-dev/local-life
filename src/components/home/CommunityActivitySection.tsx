import type { CommunityActivity } from '../../mocks/home'
import { SectionHeading } from './SectionHeading'

const toneStyles = {
  mint: {
    cover: 'bg-gradient-to-br from-[#e3f2ea] to-[#c9e7d9]',
    icon: 'text-teal-600/75',
  },
  peach: {
    cover: 'bg-gradient-to-br from-[#fff4e8] to-[#f6dfc4]',
    icon: 'text-[#c6925c]',
  },
} as const

type CommunityActivitySectionProps = {
  activities: CommunityActivity[]
  onPending: (notice: string) => void
}

export function CommunityActivitySection({ activities, onPending }: CommunityActivitySectionProps) {
  return (
    <section className="mx-4 mt-7">
      <SectionHeading
        title="今天社区有什么"
        actionLabel="查看全部"
        onAction={() => onPending('演示：社区活动列表将在 C03 接入。')}
      />
      <div className="grid grid-cols-2 gap-3">
        {activities.map(({ id, title, meta, icon: Icon, tone, pendingNotice }) => {
          const style = toneStyles[tone]
          return (
            <button
              key={id}
              type="button"
              onClick={() => onPending(pendingNotice)}
              className="overflow-hidden rounded-[18px] border border-slate-100 bg-white text-left shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <span
                className={`relative flex h-[92px] items-center justify-center ${style.cover}`}
                aria-hidden="true"
              >
                <Icon size={34} strokeWidth={1.5} className={style.icon} />
                <span className="absolute right-2 top-2 rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 backdrop-blur-sm">
                  待接入
                </span>
              </span>
              <span className="block px-3 pb-3 pt-2.5">
                <span className="block truncate text-[14px] font-semibold text-slate-800">{title}</span>
                <span className="mt-1 block text-[11px] leading-4 text-slate-400">{meta}</span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
