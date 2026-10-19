import { Coins } from 'lucide-react'
import { Link } from 'react-router'
import { DemoNote } from '../components/DemoNote'
import { PageHeader } from '../components/PageHeader'
import { SectionHeading } from '../components/home/SectionHeading'
import { useBackTarget } from '../hooks/useBackTarget'
import {
  lifePoints,
  pointsRules,
  pointsTasks,
  pointsTransactions,
} from '../mocks/life'

const toneStyles = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  peach: 'bg-[#fff3e6] text-[#c6925c]',
} as const

export function PointsPage() {
  const { backTo, backLabel } = useBackTarget('/life', '返回惠生活')

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={Coins}
        title="我的积分"
        subtitle="余额 · 获取任务 · 明细与规则"
      />

      <article className="mt-4 rounded-[20px] border border-[#e8d2a8] bg-[#fff7ec] p-4">
        <span className="text-[10px] font-semibold tracking-[0.16em] text-[#a96b2f]">
          RESIDENT POINTS
        </span>
        <div className="mt-1.5 flex items-end justify-between gap-3">
          <div>
            <p className="flex items-baseline gap-1">
              <span className="text-[38px] font-semibold leading-none tracking-tight text-[#8a6132]">
                {lifePoints.current}
              </span>
              <span className="text-[12px] font-medium text-[#a96b2f]">积分</span>
            </p>
            <p className="mt-1.5 text-[11px] text-[#a96b2f]/80">当前积分 · 演示余额</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[22px] font-semibold leading-none text-[#8a6132]">
              +{lifePoints.earnableToday}
            </p>
            <p className="mt-1.5 text-[11px] text-[#a96b2f]/80">今日还可获得</p>
          </div>
        </div>
        <Link
          to="/life/exchange"
          className="mt-4 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-teal-700 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          去兑换好礼
        </Link>
      </article>

      <section className="mt-6">
        <SectionHeading title="积分获取" note="任务示例" />
        <div className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {pointsTasks.map(({ id, title, meta, award, icon: Icon, tone, state, to, actionLabel }, index) => {
            const content = (
              <>
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${toneStyles[tone]}`}
                  aria-hidden="true"
                >
                  <Icon size={18} strokeWidth={1.7} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold leading-5 text-slate-700">
                    {title}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">{meta}</span>
                </span>
                {state === '已领' ? (
                  <span className="shrink-0 text-[12px] font-semibold text-[#a96b2f]">已领</span>
                ) : to && actionLabel ? (
                  <span className="shrink-0 rounded-lg border border-teal-200/80 bg-teal-50/60 px-2.5 py-1.5 text-[11px] font-semibold text-teal-700">
                    {actionLabel}
                  </span>
                ) : (
                  <span className="shrink-0 text-[12px] font-semibold text-[#a96b2f]">{award}</span>
                )}
              </>
            )
            const className = `flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600 ${
              index > 0 ? 'border-t border-slate-100' : ''
            }`

            return to ? (
              <Link key={id} to={to} className={`${className} hover:bg-slate-50`}>
                {content}
              </Link>
            ) : (
              <div key={id} className={className}>
                {content}
              </div>
            )
          })}
        </div>
        <p className="mt-2.5 text-[11px] leading-5 text-slate-400">
          任务跳转仅用于浏览对应演示页面，完成、签到与绑定都不会真实发放积分。
        </p>
      </section>

      <section className="mt-6">
        <SectionHeading title="积分明细" note="示例数据" />
        <ul className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {pointsTransactions.map(({ id, title, meta, amount }, index) => (
            <li
              key={id}
              className={`flex items-center gap-3 px-4 py-3.5 ${
                index > 0 ? 'border-t border-slate-100' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold leading-5 text-slate-700">{title}</p>
                <p className="mt-0.5 text-[11px] leading-4 text-slate-400">{meta}</p>
              </div>
              <span
                className={`shrink-0 text-[14px] font-semibold ${
                  amount > 0 ? 'text-[#a96b2f]' : 'text-slate-600'
                }`}
              >
                {amount > 0 ? '+' : ''}
                {amount}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <SectionHeading title="积分规则" />
        <div className="rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
          <ul className="space-y-3">
            {pointsRules.map((rule) => (
              <li key={rule} className="flex gap-2.5 text-[12px] leading-6 text-slate-500">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-500" aria-hidden="true" />
                <span className="min-w-0 flex-1">{rule}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="mt-6">
        <DemoNote tone="warn">
          余额、任务、明细与规则均为 V0.3 迁移的静态演示；未接入账户体系、积分发放或核销服务。
        </DemoNote>
      </div>
    </div>
  )
}
