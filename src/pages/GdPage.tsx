import { ArrowLeft, ChevronRight, CircleHelp, House, Info, Tv } from 'lucide-react'
import { Link } from 'react-router'
import { PendingNotice } from '../components/PendingNotice'
import { useBackTarget } from '../hooks/useBackTarget'
import { usePendingNotice } from '../hooks/usePendingNotice'
import { gdMyServices, gdPackage, gdServices } from '../mocks/gd'

export function GdPage() {
  const { message, show, dismiss } = usePendingNotice()
  const { backTo, backLabel } = useBackTarget('/', '返回首页')

  return (
    <div className="px-4 pb-7 pt-3">
      <Link
        to={backTo}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg text-[13px] font-medium text-slate-500 transition-colors hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        {backLabel}
      </Link>

      <div className="mt-1 flex items-center gap-3">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] bg-[#e8f6f0] text-[#388b77]"
          aria-hidden="true"
        >
          <Tv size={24} strokeWidth={1.7} />
        </span>
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">广电服务</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">手机卡 · 宽带 · 电视 · 上门服务</p>
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2.5 rounded-[16px] bg-[#fff7ec] px-3.5 py-3 text-[12px] leading-5 text-[#8a6132]">
        <Info size={16} className="mt-0.5 shrink-0 text-[#b97b3e]" aria-hidden="true" />
        <p>
          <span className="mr-1 rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] font-semibold text-[#a96b2f]">
            筹备接入
          </span>
          手机卡、宽带、电视与装维数据将在合作接口确认后接入。
        </p>
      </div>

      <section className="mt-5">
        <h2 className="mb-3 text-[17px] font-semibold tracking-tight text-slate-900">服务入口</h2>
        <div className="grid grid-cols-2 gap-3">
          {gdServices.map(({ id, label, description, icon: Icon, pendingNotice }) => (
            <button
              key={id}
              type="button"
              onClick={() => show(pendingNotice)}
              className="relative flex h-full flex-col rounded-[18px] border border-slate-100 bg-white p-4 text-left shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <span className="absolute right-3 top-3 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                待接入
              </span>
              <span
                className="flex h-11 w-11 items-center justify-center rounded-[15px] bg-[#fff3e6] text-[#c6925c]"
                aria-hidden="true"
              >
                <Icon size={22} strokeWidth={1.7} />
              </span>
              <strong className="mt-3 block text-[15px] font-semibold text-slate-800">{label}</strong>
              <span className="mt-1 block text-[11px] leading-5 text-slate-400">{description}</span>
            </button>
          ))}
        </div>
      </section>

      <article className="mt-6 rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[15px] bg-[#e8f6f0] text-[#388b77]"
            aria-hidden="true"
          >
            <House size={21} strokeWidth={1.7} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold leading-5 text-slate-800">{gdPackage.title}</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">{gdPackage.subtitle}</p>
          </div>
          <span className="shrink-0 rounded-full bg-[#fff3e6] px-2 py-1 text-[10px] font-medium text-[#a96b2f]">
            {gdPackage.status}
          </span>
        </div>

        <dl className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
          {gdPackage.features.map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between gap-3 py-2.5">
              <dt className="text-[12px] text-slate-500">{label}</dt>
              <dd className="text-right text-[12px] font-medium text-slate-600">{value}</dd>
            </div>
          ))}
        </dl>

        <button
          type="button"
          onClick={() => show(gdPackage.pendingNotice)}
          className="mt-2 min-h-[44px] w-full rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          {gdPackage.actionLabel} · 待接入
        </button>
      </article>

      <section className="mt-6">
        <h2 className="mb-3 text-[17px] font-semibold tracking-tight text-slate-900">我的服务</h2>
        <div className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {gdMyServices.map(({ id, label, meta, icon: Icon, pendingNotice }, index) => (
            <button
              key={id}
              type="button"
              onClick={() => show(pendingNotice)}
              className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600 ${
                index > 0 ? 'border-t border-slate-100' : ''
              }`}
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#fff3e6] text-[#c6925c]"
                aria-hidden="true"
              >
                <Icon size={18} strokeWidth={1.7} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-slate-700">{label}</span>
                <span className="mt-0.5 block text-[11px] text-slate-400">{meta}</span>
              </span>
              <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      <section className="mt-6 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-800">社区广播联动</h2>
        <p className="mt-2 text-[12px] leading-6 text-slate-500">
          社区广播承担公共触达；规划中由小程序提供广播文字回看与后续服务，音频重听尚未接入。公共广播不作为商业广告渠道。
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5" aria-hidden="true">
          {['广播', '通知', '活动', '服务'].map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500"
            >
              {tag}
            </span>
          ))}
        </div>
        <Link
          to="/community/broadcast"
          state={{ from: '/gd' }}
          className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl border border-teal-200/80 bg-teal-50/60 text-[13px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          查看社区广播
        </Link>
        <p className="mt-2 text-[11px] leading-5 text-slate-400">
          广播列表与文字详情已可浏览；音频重听仍未接入。
        </p>
      </section>

      <div className="mt-6 flex gap-3 rounded-[16px] border border-dashed border-teal-300/70 bg-[#eef7f2] p-4 text-[#52786c]">
        <CircleHelp size={19} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <p className="text-[12px] font-semibold">仅作界面展示</p>
          <p className="mt-1 text-[11px] leading-[1.7]">
            本页迁自 V0.3 广电服务页，未接入运营商接口、订单或支付；办理与权益按钮都会明确提示待接入。
          </p>
        </div>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
