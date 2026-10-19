import { Link } from 'react-router'
import type { CommunityActivity } from '../../mocks/community'
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
}

/**
 * Home "今天社区有什么" cards. These entries lead into the C03 community
 * pages rather than a pending notice, so the home behaviour stays honest.
 */
export function CommunityActivitySection({ activities }: CommunityActivitySectionProps) {
  return (
    <section className="mx-4 mt-7">
      <SectionHeading title="今天社区有什么" actionLabel="查看全部" actionTo="/community" />
      <div className="grid grid-cols-2 gap-3">
        {activities.map(({ id, title, meta, icon: Icon, tone, to }) => {
          const style = toneStyles[tone]
          const card = (
            <>
              <span
                className={`relative flex h-[92px] items-center justify-center ${style.cover}`}
                aria-hidden="true"
              >
                <Icon size={34} strokeWidth={1.5} className={style.icon} />
              </span>
              <span className="block px-3 pb-3 pt-2.5">
                <span className="block truncate text-[14px] font-semibold text-slate-800">{title}</span>
                <span className="mt-1 block text-[11px] leading-4 text-slate-400">{meta}</span>
              </span>
            </>
          )

          const cardClass =
            'overflow-hidden rounded-[18px] border border-slate-100 bg-white text-left shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600'

          return to ? (
            <Link key={id} to={to} className={cardClass}>
              {card}
            </Link>
          ) : (
            <div key={id} className={cardClass}>
              {card}
            </div>
          )
        })}
      </div>
    </section>
  )
}
