import { RadioTower, Volume2 } from 'lucide-react'
import type {
  CommunityBroadcastContent,
  CommunityNotice,
} from '../../mocks/home'
import { SectionHeading } from './SectionHeading'

type CommunityMessageSectionProps = {
  broadcast: CommunityBroadcastContent
  notices: CommunityNotice[]
  onPending: (notice: string) => void
}

export function CommunityMessageSection({
  broadcast,
  notices,
  onPending,
}: CommunityMessageSectionProps) {
  return (
    <section className="mx-4 mt-7">
      <SectionHeading
        title="社区消息"
        actionLabel="全部消息"
        onAction={() => onPending('演示：社区广播与消息列表将在 C03 接入。')}
      />

      <article className="rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[#e8f6f0] text-[#388b77]"
            aria-hidden="true"
          >
            <RadioTower size={21} strokeWidth={1.7} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold leading-5 text-slate-800">{broadcast.title}</h3>
            <p className="mt-1 text-[11px] leading-5 text-slate-400">{broadcast.meta}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onPending(broadcast.pendingNotice)}
          className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl border border-teal-200/80 bg-teal-50/60 text-[12px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <Volume2 size={15} aria-hidden="true" />
          {broadcast.actionLabel}
          <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
            待接入
          </span>
        </button>
      </article>

      <div className="mt-3 overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
        {notices.map((notice, index) => {
          const Icon = notice.icon
          return (
            <button
              key={notice.id}
              type="button"
              onClick={() => onPending(notice.pendingNotice)}
              className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600 ${
                index > 0 ? 'border-t border-slate-100' : ''
              }`}
            >
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                  notice.tone === 'warn'
                    ? 'bg-[#fdf0e4] text-[#b97b3e]'
                    : 'bg-[#e8f6f0] text-[#388b77]'
                }`}
                aria-hidden="true"
              >
                <Icon size={18} strokeWidth={1.7} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-5 text-slate-700">
                  {notice.title}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">{notice.meta}</span>
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  notice.tone === 'warn'
                    ? 'bg-[#fdf0e4] text-[#a96b2f]'
                    : 'bg-slate-100 text-slate-500'
                }`}
              >
                {notice.tag}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
