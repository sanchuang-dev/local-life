import { ChevronRight, UserRound } from 'lucide-react'
import { Link } from 'react-router'
import { DemoNote } from '../components/DemoNote'
import { PendingNotice } from '../components/PendingNotice'
import { SectionHeading } from '../components/home/SectionHeading'
import { usePendingNotice } from '../hooks/usePendingNotice'
import {
  demoIndexGroups,
  meDemoNote,
  meProfile,
  meServices,
  meSettings,
  meStats,
  type MeServiceItem,
} from '../mocks/me'

const toneStyles = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  peach: 'bg-[#fff3e6] text-[#c6925c]',
} as const

function ServiceRow({
  item,
  onPending,
}: {
  item: MeServiceItem
  onPending: (notice: string) => void
}) {
  const Icon = item.icon
  const content = (
    <>
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${toneStyles[item.tone]}`}
        aria-hidden="true"
      >
        <Icon size={18} strokeWidth={1.7} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-slate-700">{item.label}</span>
        {item.meta ? (
          <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">{item.meta}</span>
        ) : null}
      </span>
      {item.to ? (
        <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
      ) : (
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-400">
          演示
        </span>
      )}
    </>
  )

  if (item.to) {
    return (
      <Link
        to={item.to}
        state={{ from: '/me' }}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600"
      >
        {content}
      </Link>
    )
  }

  return (
    <button
      type="button"
      onClick={() => item.pendingNotice && onPending(item.pendingNotice)}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600"
    >
      {content}
    </button>
  )
}

export function MePage() {
  const { message, show, dismiss } = usePendingNotice()

  return (
    <div className="px-4 pb-7 pt-4">
      <article className="rounded-[22px] border border-slate-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3.5">
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#e8f6f0] text-[#388b77]"
            aria-hidden="true"
          >
            <UserRound size={28} strokeWidth={1.6} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[19px] font-semibold tracking-tight text-slate-900">
              {meProfile.name}
            </h1>
            <p className="mt-0.5 text-[11px] leading-4 text-slate-400">{meProfile.community}</p>
          </div>
          <span className="shrink-0 rounded-full bg-[#fff3e6] px-2 py-1 text-[10px] font-medium text-[#a96b2f]">
            {meProfile.tag}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          {meStats.map((stat) => {
            const className = `flex min-h-[72px] min-w-0 flex-col items-center justify-center rounded-[16px] px-1 py-2 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${toneStyles[stat.tone]}`
            const content = (
              <>
                <span className="text-[22px] font-semibold leading-none tracking-tight">
                  {stat.value}
                </span>
                <span className="mt-1.5 text-[11px] font-medium">{stat.label}</span>
              </>
            )

            return stat.to ? (
              <Link key={stat.id} to={stat.to} state={{ from: '/me' }} className={className}>
                {content}
              </Link>
            ) : (
              <button
                key={stat.id}
                type="button"
                onClick={() => stat.pendingNotice && show(stat.pendingNotice)}
                className={className}
              >
                {content}
              </button>
            )
          })}
        </div>
      </article>

      <DemoNote>{meDemoNote}</DemoNote>

      <section className="mt-6">
        <SectionHeading title="我的服务" note="示例数据" />
        <div className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {meServices.map((item, index) => (
            <div key={item.id} className={index > 0 ? 'border-t border-slate-100' : ''}>
              <ServiceRow item={item} onPending={show} />
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <SectionHeading title="设置与帮助" note="部分待接入" />
        <div className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {meSettings.map((item, index) => (
            <div key={item.id} className={index > 0 ? 'border-t border-slate-100' : ''}>
              <ServiceRow item={item} onPending={show} />
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <SectionHeading title="原型演示导航" note="非产品导航" />
        <div className="rounded-[18px] border border-dashed border-teal-300/70 bg-[#f7fbf9] p-4">
          <p className="text-[11px] leading-5 text-[#52786c]">
            汇总 V0.3 已迁页面，仅用于浏览回归与产品减法讨论；首页/社区/健康/惠生活/我的五个历史模块不是新版信息架构定案。
          </p>
          <div className="mt-3 space-y-3">
            {demoIndexGroups.map((group) => (
              <div key={group.id}>
                <h3 className="text-[12px] font-semibold text-slate-600">{group.title}</h3>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {group.entries.map((entry) => (
                    <Link
                      key={entry.to}
                      to={entry.to}
                      className="inline-flex min-h-[40px] items-center rounded-full border border-teal-200/80 bg-white px-3 text-[11px] font-medium text-teal-700 transition-colors hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                    >
                      {entry.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-5 text-slate-400">
            「我的」即当前页；设备、积分与广电入口同时出现在上方“我的服务”中。
          </p>
        </div>
      </section>

      <div className="mt-6">
        <DemoNote tone="warn">
          所有账户、身份、积分、活动、优惠券、订单、收藏与客服能力均为演示占位，不产生真实身份认证、交易或个人数据存储。
        </DemoNote>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
