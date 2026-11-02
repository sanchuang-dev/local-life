import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import type { CommunityScene } from '../../mocks/community'

const sceneToneStyles = {
  mint: {
    cover: 'bg-gradient-to-br from-[#e3f2ea] to-[#c9e7d9]',
    icon: 'text-teal-600/75',
  },
  peach: {
    cover: 'bg-gradient-to-br from-[#fff4e8] to-[#f6dfc4]',
    icon: 'text-[#c6925c]',
  },
} as const

type CommunitySceneCardsProps = {
  scenes: CommunityScene[]
}

/**
 * The two life-scene entries at the top of `/community`. Each prompt opens the
 * matching existing activity detail and remembers community as its source.
 */
export function CommunitySceneCards({ scenes }: CommunitySceneCardsProps) {
  return (
    <section className="mt-5">
      <h2 className="mb-3 text-[17px] font-semibold tracking-tight text-slate-900">
        社区生活场景
      </h2>
      <div className="grid gap-3">
        {scenes.map(({ id, prompt, activityTitle, schedule, place, tags, to, icon: Icon, tone }) => {
          const style = sceneToneStyles[tone]

          return (
            <Link
              key={id}
              to={to}
              state={{ from: '/community' }}
              className="flex items-center gap-3.5 rounded-[20px] border border-slate-100 bg-white p-3.5 text-left shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <span
                className={`flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-[18px] ${style.cover}`}
                aria-hidden="true"
              >
                <Icon size={32} strokeWidth={1.5} className={style.icon} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[16px] font-semibold leading-5 text-slate-800">
                  {prompt}
                </span>
                <span className="mt-0.5 block text-[12px] font-medium leading-4 text-slate-600">
                  {activityTitle}
                </span>
                <span className="mt-1 block text-[11px] leading-4 text-slate-400">
                  {schedule}
                </span>
                <span className="block text-[11px] leading-4 text-slate-400">{place}</span>
                <span className="mt-1.5 flex flex-wrap items-center gap-1">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500"
                    >
                      {tag}
                    </span>
                  ))}
                </span>
              </span>
              <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
            </Link>
          )
        })}
      </div>
    </section>
  )
}
