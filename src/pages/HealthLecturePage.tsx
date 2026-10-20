import { BookOpen } from 'lucide-react'
import { useState } from 'react'
import { DemoNote } from '../components/DemoNote'
import { PageHeader } from '../components/PageHeader'
import { PendingNotice } from '../components/PendingNotice'
import { useBackTarget } from '../hooks/useBackTarget'
import { usePendingNotice } from '../hooks/usePendingNotice'
import {
  healthLectureFilters,
  healthLectureNote,
  healthLectures,
  type HealthLectureFilter,
} from '../mocks/health'

const toneStyles = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  peach: 'bg-[#fff3e6] text-[#c6925c]',
} as const

export function HealthLecturePage() {
  const { message, show, dismiss } = usePendingNotice()
  const { backTo, backLabel } = useBackTarget('/health', '返回健康服务')
  const [filter, setFilter] = useState<HealthLectureFilter>('全部')
  const visible =
    filter === '全部'
      ? healthLectures
      : healthLectures.filter((item) => item.categories.includes(filter))

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={BookOpen}
        title="健康讲堂"
        subtitle="科普内容 · 商业标识 · 演示播放"
      />

      <DemoNote>
        本页未接入视频、音频或直播播放；收听、预约与积分均为演示提示，不会产生真实播放或奖励。
      </DemoNote>

      <div className="mt-4 flex flex-wrap gap-2" aria-label="内容类型筛选">
        {healthLectureFilters.map((item) => {
          const selected = item === filter
          return (
            <button
              key={item}
              type="button"
              aria-pressed={selected}
              onClick={() => setFilter(item)}
              className={`min-h-[36px] rounded-full border px-3.5 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${
                selected
                  ? 'border-teal-600 bg-teal-600 text-white'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-teal-200 hover:text-teal-700'
              }`}
            >
              {item}
            </button>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <div className="mt-4 rounded-[18px] border border-dashed border-slate-200 bg-white px-4 py-10 text-center">
          <p className="text-[13px] font-semibold text-slate-500">该分类暂无内容</p>
          <p className="mt-1.5 text-[11px] leading-5 text-slate-400">
            演示数据暂未提供「{filter}」内容，可切换其它分类查看。
          </p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
          {visible.map(
            ({
              id,
              title,
              categories,
              format,
              meta,
              summary,
              progress,
              actionLabel,
              pendingNotice,
              icon: Icon,
              tone,
            }) => (
              <article
                key={id}
                className="rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-[16px] ${toneStyles[tone]}`}
                    aria-hidden="true"
                  >
                    <Icon size={25} strokeWidth={1.6} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {categories.map((category) => (
                        <span
                          key={category}
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            category === '商业内容'
                              ? 'bg-[#fdf0e4] text-[#a96b2f]'
                              : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {category}
                        </span>
                      ))}
                      {format === '直播' ? null : (
                        <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                          {format}
                        </span>
                      )}
                    </div>
                    <h2 className="mt-1.5 text-[16px] font-semibold leading-6 text-slate-800">
                      {title}
                    </h2>
                    <p className="mt-1 text-[11px] leading-4 text-slate-400">{meta}</p>
                  </div>
                </div>

                {progress ? (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="h-1.5 flex-1 rounded-full bg-slate-100" aria-hidden="true">
                      <span className="block h-full w-full rounded-full bg-teal-500" />
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-400">{progress}</span>
                  </div>
                ) : null}

                {summary ? (
                  <p className="mt-3 rounded-[12px] bg-[#fff7ec] px-3 py-2 text-[11px] leading-5 text-[#8a6132]">
                    {summary}
                  </p>
                ) : null}

                {actionLabel && pendingNotice ? (
                  <button
                    type="button"
                    onClick={() => show(pendingNotice)}
                    className={`mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${
                      categories.includes('商业内容')
                        ? 'border border-slate-200 text-slate-600 hover:border-teal-200 hover:text-teal-700'
                        : 'bg-teal-700 text-white hover:bg-teal-800'
                    }`}
                  >
                    {actionLabel} · 演示
                  </button>
                ) : null}
              </article>
            ),
          )}
        </div>
      )}

      <div className="mt-4">
        <DemoNote>{healthLectureNote}</DemoNote>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
