import { ChevronRight, Users } from 'lucide-react'
import { Link } from 'react-router'
import { PageHeader } from '../components/PageHeader'
import { DemoNote } from '../components/DemoNote'
import { PendingNotice } from '../components/PendingNotice'
import { usePendingNotice } from '../hooks/usePendingNotice'
import {
  communityActivityList,
  communityEntries,
  communityNotices,
} from '../mocks/community'

const toneStyles = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  peach: 'bg-[#fff3e6] text-[#c6925c]',
} as const

export function CommunityPage() {
  const { message, show, dismiss } = usePendingNotice()

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo="/"
        backLabel="返回首页"
        icon={Users}
        title="社区"
        subtitle="街坊日常生活入口"
      />

      <DemoNote>
        本页依据 V0.3 社区页迁移，消息、广播与活动均为演示数据，未接入真实社区服务。
      </DemoNote>

      <section className="mt-5">
        <h2 className="mb-3 text-[17px] font-semibold tracking-tight text-slate-900">社区入口</h2>
        <div className="grid grid-cols-2 gap-3">
          {communityEntries.map(({ id, label, badge, icon: Icon, tone, to, pendingNotice }) => {
            const className =
              'relative flex min-h-[96px] flex-col items-start rounded-[18px] border border-slate-100 bg-white p-4 text-left shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600'
            const content = (
              <>
                {badge ? (
                  <span className="absolute right-3 top-3 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                    {badge}
                  </span>
                ) : null}
                <span
                  className={`flex h-11 w-11 items-center justify-center rounded-[15px] ${toneStyles[tone]}`}
                  aria-hidden="true"
                >
                  <Icon size={22} strokeWidth={1.7} />
                </span>
                <strong className="mt-3 block text-[15px] font-semibold leading-5 text-slate-800">
                  {label}
                </strong>
              </>
            )

            return to ? (
              <Link key={id} to={to} className={className}>
                {content}
              </Link>
            ) : (
              <button
                key={id}
                type="button"
                onClick={() => pendingNotice && show(pendingNotice)}
                className={className}
              >
                {content}
              </button>
            )
          })}
        </div>
      </section>

      <section className="mt-6">
        <div className="mb-3 flex min-h-[36px] items-center justify-between gap-2">
          <h2 className="text-[17px] font-semibold tracking-tight text-slate-900">
            正在发生的社区活动
          </h2>
          <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-400">
            演示排期
          </span>
        </div>
        <div className="grid gap-3">
          {communityActivityList.map(({ id, title, meta, icon: Icon, tone, tags, to, pendingNotice }) => {
            const className =
              'flex w-full items-center gap-3 rounded-[18px] border border-slate-100 bg-white p-4 text-left shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600'
            const content = (
              <>
                <span
                  className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-[16px] ${toneStyles[tone]}`}
                  aria-hidden="true"
                >
                  <Icon size={24} strokeWidth={1.6} />
                </span>
                <span className="min-w-0 flex-1">
                  {tags && tags.length > 0 ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      {tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500"
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className="mt-1.5 block text-[15px] font-semibold leading-5 text-slate-800">
                    {title}
                  </span>
                  <span className="mt-1 block text-[11px] leading-4 text-slate-400">{meta}</span>
                </span>
                <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
              </>
            )

            return to ? (
              <Link key={id} to={to} className={className}>
                {content}
              </Link>
            ) : (
              <button
                key={id}
                type="button"
                onClick={() => pendingNotice && show(pendingNotice)}
                className={className}
              >
                {content}
              </button>
            )
          })}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="mb-3 text-[17px] font-semibold tracking-tight text-slate-900">社区通知</h2>
        <div className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {communityNotices.map((notice, index) => {
            const Icon = notice.icon
            return (
              <Link
                key={notice.id}
                to={`/community/notice/${notice.id}`}
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
                  <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">
                    {notice.meta}
                  </span>
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
              </Link>
            )
          })}
        </div>
      </section>

      <div className="mt-6">
        <DemoNote>
          演示内容：社区广播、活动与通知均未接入真实社区、政府或应急广播服务，任何报名、签到与积分都不会产生真实结果。
        </DemoNote>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
