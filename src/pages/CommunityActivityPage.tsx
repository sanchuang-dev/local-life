import { ArrowLeft, BellRing, CalendarDays, QrCode } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { DemoNote } from '../components/DemoNote'
import { PageHeader } from '../components/PageHeader'
import { PendingNotice } from '../components/PendingNotice'
import { useBackTarget } from '../hooks/useBackTarget'
import { usePendingNotice } from '../hooks/usePendingNotice'
import {
  communityActivityDetails,
  defaultCommunityActivityDetail,
} from '../mocks/community'

export function CommunityActivityPage() {
  const { activityId } = useParams()
  const { message, show, dismiss } = usePendingNotice()
  const { backTo, backLabel } = useBackTarget('/community', '返回社区')
  const detail = activityId
    ? communityActivityDetails.find((item) => item.id === activityId)
    : defaultCommunityActivityDetail

  if (!detail) {
    return (
      <div className="px-4 pb-7 pt-3">
        <Link
          to={backTo}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg text-[13px] font-medium text-slate-500 transition-colors hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {backLabel}
        </Link>
        <div className="mt-6 rounded-[18px] border border-dashed border-slate-200 bg-white px-4 py-12 text-center">
          <p className="text-[14px] font-semibold text-slate-500">活动不存在</p>
          <p className="mt-2 text-[11px] leading-5 text-slate-400">
            该活动可能已下线，或链接有误。
          </p>
          <div className="mt-4 flex flex-col items-center gap-2">
            <Link
              to="/community"
              className="inline-flex min-h-[44px] items-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800"
            >
              返回社区
            </Link>
            <Link
              to="/"
              className="inline-flex min-h-[44px] items-center px-2 text-[12px] font-medium text-teal-700 transition-colors hover:text-teal-800"
            >
              返回首页
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const { title, subtitle, tags, fields, programme, signInNotice, reminderNotice, footer } = detail

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={CalendarDays}
        title="活动详情"
        subtitle={subtitle}
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

      {programme ? (
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
      ) : null}

      {signInNotice || reminderNotice ? (
        <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
          <h2 className="text-[16px] font-semibold text-slate-800">参与与提醒</h2>
          {signInNotice ? (
            <button
              type="button"
              onClick={() => show(signInNotice)}
              className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl bg-teal-700 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <QrCode size={16} aria-hidden="true" />
              扫码签到 · 演示
            </button>
          ) : null}
          {reminderNotice ? (
            <button
              type="button"
              onClick={() => show(reminderNotice)}
              className="mt-2 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <BellRing size={16} aria-hidden="true" />
              设置活动提醒 · 演示
            </button>
          ) : null}
        </section>
      ) : null}

      <div className="mt-4">
        <DemoNote>{footer}</DemoNote>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
