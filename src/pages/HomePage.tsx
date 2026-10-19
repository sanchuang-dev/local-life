import { CircleHelp } from 'lucide-react'
import { PendingNotice } from '../components/PendingNotice'
import { CommunityActivitySection } from '../components/home/CommunityActivitySection'
import { CommunityMessageSection } from '../components/home/CommunityMessageSection'
import { GdFeatureCard } from '../components/home/GdFeatureCard'
import { HomeBanner } from '../components/home/HomeBanner'
import { SectionHeading } from '../components/home/SectionHeading'
import { ServiceEntryGrid } from '../components/home/ServiceEntryGrid'
import { usePendingNotice } from '../hooks/usePendingNotice'
import {
  communityBroadcastSummary,
  homeCommunityActivities,
  homeCommunityNotices,
} from '../mocks/community'
import {
  homeBanner,
  homeGdEntries,
  homeMoreServices,
  homeQuickEntries,
} from '../mocks/home'

export function HomePage() {
  const { message, show, dismiss } = usePendingNotice()

  return (
    <div className="pb-6">
      <HomeBanner banner={homeBanner} onAction={() => show(homeBanner.pendingNotice)} />

      <section className="relative z-[1] mx-4 -mt-[49px] rounded-[20px] border border-slate-100 bg-white px-4 pb-5 pt-5 shadow-[0_12px_36px_rgba(15,52,44,0.08)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-slate-800">常用服务</h2>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-400">
            部分待接入
          </span>
        </div>
        <ServiceEntryGrid entries={homeQuickEntries} onPending={show} />
      </section>

      <div className="mx-4 mt-4">
        <GdFeatureCard entries={homeGdEntries} />
      </div>

      <section className="mx-4 mt-7">
        <SectionHeading title="更多服务" note="示例配置" />
        <div className="rounded-[20px] border border-slate-100 bg-white p-4 shadow-sm">
          <ServiceEntryGrid entries={homeMoreServices} onPending={show} />
        </div>
      </section>

      <CommunityMessageSection
        broadcast={communityBroadcastSummary}
        notices={homeCommunityNotices}
      />

      <CommunityActivitySection activities={homeCommunityActivities} />

      <div className="mx-4 mt-7 flex gap-3 rounded-[16px] border border-dashed border-teal-300/70 bg-[#eef7f2] p-4 text-[#52786c]">
        <CircleHelp size={19} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <p className="text-[12px] font-semibold">演示内容 · 未接入真实服务</p>
          <p className="mt-1 text-[11px] leading-[1.7]">
            首页内容依据 V0.3 原型迁移，未迁入页面以“待接入”提示说明；广电展示页不办理真实业务，
            也不产生订单或支付。
          </p>
        </div>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
