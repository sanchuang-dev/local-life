import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { healthLecturePreview } from '../../mocks/health'
import { SectionHeading } from './SectionHeading'

const toneStyles = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  peach: 'bg-[#fff3e6] text-[#c6925c]',
} as const

/**
 * Home preview of the existing health-lecture fixtures. Every row opens the
 * lecture page, which owns the playback and booking notices; the home does not
 * pretend to stream audio or video.
 */
export function HomeHealthLectureSection() {
  return (
    <section className="mx-4 mt-7">
      <SectionHeading
        title="今天听一点健康"
        actionLabel="全部讲堂"
        actionTo="/health/lecture"
        actionState={{ from: '/' }}
      />
      <div className="grid gap-3">
        {healthLecturePreview.map(({ id, title, categories, format, meta, icon: Icon, tone }) => (
          <Link
            key={id}
            to="/health/lecture"
            state={{ from: '/' }}
            className="flex w-full items-center gap-3 rounded-[18px] border border-slate-100 bg-white p-4 text-left shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            <span
              className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-[16px] ${toneStyles[tone]}`}
              aria-hidden="true"
            >
              <Icon size={23} strokeWidth={1.6} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                {categories.map((category) => (
                  <span
                    key={category}
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500"
                  >
                    {category}
                  </span>
                ))}
                <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                  {format}
                </span>
              </span>
              <span className="mt-1.5 block text-[15px] font-semibold leading-5 text-slate-800">
                {title}
              </span>
              <span className="mt-1 block text-[11px] leading-4 text-slate-400">{meta}</span>
            </span>
            <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
          </Link>
        ))}
      </div>
      <p className="mt-2.5 text-[11px] leading-5 text-slate-400">
        演示：首页不播放音视频，进入讲堂可查看科普、商业内容与直播标识；内容不构成医疗建议。
      </p>
    </section>
  )
}
