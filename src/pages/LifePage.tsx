import { ChevronRight, Gift } from 'lucide-react'
import { DemoNote } from '../components/DemoNote'
import { LifeProductCard } from '../components/life/LifeProductCard'
import { PointsSummaryCard } from '../components/life/PointsSummaryCard'
import { PageHeader } from '../components/PageHeader'
import { PendingNotice } from '../components/PendingNotice'
import { SectionHeading } from '../components/home/SectionHeading'
import { usePendingNotice } from '../hooks/usePendingNotice'
import {
  lifeConceptNote,
  lifeMapNotice,
  lifeProducts,
  lifeStores,
} from '../mocks/life'

const toneStyles = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  peach: 'bg-[#fff3e6] text-[#c6925c]',
} as const

export function LifePage() {
  const { message, show, dismiss } = usePendingNotice()

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo="/"
        backLabel="返回首页"
        icon={Gift}
        title="惠生活"
        subtitle="居民权益 · 积分好礼 · 本地服务"
      />

      <DemoNote>
        本页依据 V0.3 惠生活页迁移，商品、库存、积分与门店均为示例数据；不接入支付、订单或发券后台。
      </DemoNote>

      <div className="mt-5">
        <PointsSummaryCard />
      </div>

      <section className="mt-6">
        <SectionHeading
          title="积分好礼"
          note="示例商品"
          actionLabel="全部"
          actionTo="/life/exchange"
        />
        <div className="grid grid-cols-2 gap-3">
          {lifeProducts.map((product) => (
            <LifeProductCard key={product.id} product={product} />
          ))}
        </div>
        <p className="mt-2.5 text-[11px] leading-5 text-slate-400">
          商品、库存与积分价格均为示例数据，兑换不会真实扣分或发券。
        </p>
      </section>

      <section className="mt-6">
        <SectionHeading
          title="附近可到店核销"
          actionLabel="地图"
          onAction={() => show(lifeMapNotice)}
        />
        <div className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {lifeStores.map(({ id, name, meta, tag, icon: Icon, tone, pendingNotice }, index) => (
            <button
              key={id}
              type="button"
              onClick={() => show(pendingNotice)}
              className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600 ${
                index > 0 ? 'border-t border-slate-100' : ''
              }`}
            >
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${toneStyles[tone]}`}
                aria-hidden="true"
              >
                <Icon size={18} strokeWidth={1.7} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-slate-700">{name}</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">{meta}</span>
              </span>
              {tag ? (
                <span className="shrink-0 rounded-full bg-[#fff3e6] px-2 py-0.5 text-[10px] font-medium text-[#a96b2f]">
                  {tag}
                </span>
              ) : (
                <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      </section>

      <div className="mt-6">
        <DemoNote>{lifeConceptNote}</DemoNote>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
