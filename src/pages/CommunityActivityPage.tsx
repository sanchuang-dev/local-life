import { CalendarDays, QrCode, BellRing } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { DemoNote } from '../components/DemoNote'
import { PendingNotice } from '../components/PendingNotice'
import { usePendingNotice } from '../hooks/usePendingNotice'
import { communityActivityDetail } from '../mocks/community'

export function CommunityActivityPage() {
  const { message, show, dismiss } = usePendingNotice()
  const { title, tags, fields, programme, signInNotice, reminderNotice, footer } =
    communityActivityDetail

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo="/community"
        backLabel="返回社区"
        icon={CalendarDays}
        title="活动详情"
        subtitle="社区活动时间、地点与节目安排"
      />

      <article className="mt-4 overflow-hidden rounded-[20px] border border-slate-100 bg-white shadow-sm">
        <div
          className="flex h-32 items-center justify-center bg-gradient-to-br from-[#e3f2ea] to-[#c9e7d9]"
          aria-hidden="true"
        >
          <CalendarDays size={46} strokeWidth={1.4} className="text-teal-600/75" />
        </div>
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500"
              >
                {tag}
              </span>
            ))}
          </div>
          <h2 className="mt-2.5 text-[22px] font-semibold leading-[1.35] tracking-tight text-slate-900">
            {title}
          </h2>

          <dl className="mt-3.5 divide-y divide-slate-100 border-t border-slate-100">
            {fields.map(({ label, value }) => (
              <div key={label} className="flex items-start justify-between gap-3 py-2.5">
                <dt className="shrink-0 text-[12px] text-slate-400">{label}</dt>
                <dd className="text-right text-[12px] font-medium leading-5 text-slate-600">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </article>

      <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-800">节目单</h2>
        <ol className="mt-2 divide-y divide-slate-100">
          {programme.map((item) => (
            <li key={item.time} className="flex items-start gap-3 py-3">
              <span className="w-12 shrink-0 text-[12px] font-semibold text-teal-700">{item.time}</span>
              <span className="min-w-0 flex-1 text-[14px] font-medium text-slate-700">{item.title}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-800">到场签到</h2>
        <p className="mt-1.5 text-[12px] leading-5 text-slate-500">
          旧版原型在到场后扫描签到码并计入「我的活动」，此处只保留演示按钮。
        </p>
        <button
          type="button"
          onClick={() => show(signInNotice)}
          className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl bg-teal-700 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <QrCode size={16} aria-hidden="true" />
          扫码签到 · 演示
        </button>
        <button
          type="button"
          onClick={() => show(reminderNotice)}
          className="mt-2 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <BellRing size={16} aria-hidden="true" />
          设置活动提醒 · 演示
        </button>
      </section>

      <div className="mt-4">
        <DemoNote>{footer}</DemoNote>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
