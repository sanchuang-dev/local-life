import { Gift, Info } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { DemoNote } from '../components/DemoNote'
import { PageHeader } from '../components/PageHeader'
import { ShopDealsSection } from '../components/life/ShopDealsSection'

/**
 * 惠生活 — resident benefits.
 *
 * The only resident benefit connected to a real service is the CRMEB shop
 * (read-only catalogue with a purchase hand-off). Points exchange and the
 * local-merchant map are not connected, so the demonstration points balance,
 * example goods and invented stores are no longer rendered here; the page states
 * the gap instead. The fixture modules are kept for the pages that still
 * declare themselves as demos, but nothing on this page depends on them.
 */
export function LifePage() {
  const [searchParams] = useSearchParams()
  // `?activityId=` is the trusted deep link from an activity purchase entry; it
  // is only used to display the real activity source above the catalogue.
  const activityId = searchParams.get('activityId')?.trim() || null
  const requestedSection = searchParams.get('tab')
  const unavailableSection =
    requestedSection === 'points' ? '积分兑换' : requestedSection === 'local' ? '本地生活门店' : null

  return (
    <div className="px-4 pb-7 pt-4">
      <PageHeader icon={Gift} title="惠生活" subtitle="真实商城商品 · 居民权益" />

      <DemoNote>
        优惠购接入真实 CRMEB 商城商品（只读展示与购买跳转，平台不代下单、不代支付）。
        未配置商城时如实提示，不展示模拟商品。
      </DemoNote>

      {unavailableSection ? (
        <div
          role="status"
          className="mt-3 rounded-[16px] border border-[#f2dcc0] bg-[#fff7ec] px-3.5 py-3 text-[12px] leading-5 text-[#8a6132]"
        >
          {unavailableSection} 尚未接入真实服务，本页不再展示示例积分、示例兑换商品或虚构门店；
          接入后会在同一入口开放。
        </div>
      ) : null}

      <div className="mt-4">
        <ShopDealsSection activityId={activityId} />
      </div>

      <section
        className="mt-5 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm"
        aria-labelledby="life-benefits-heading"
      >
        <h2
          id="life-benefits-heading"
          className="flex items-center gap-1.5 text-[15px] font-bold text-slate-800"
        >
          <Info size={16} className="shrink-0 text-teal-700" aria-hidden="true" />
          积分与本地门店
        </h2>
        <p className="mt-1.5 text-[12px] leading-5 text-slate-500">
          社区居民权益积分、积分兑换与到店核销门店均尚未接入真实服务，因此本页不再展示示例积分余额、
          示例兑换商品与虚构门店。接入后会在这里开放，并通过服务端记录真实兑换与核销。
        </p>
        <p className="mt-1.5 text-[11px] leading-[1.7] text-slate-400">
          当前商城商品、价格与图片由 CRMEB 商城（outapi）提供；库存与可售状态以商城为准。
        </p>
      </section>
    </div>
  )
}
