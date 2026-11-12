import { Gift } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { PageHeader } from '../components/PageHeader'
import { LocalCatalogSection } from '../components/life/LocalCatalogSection'
import { ExternalOffersSection } from '../components/life/ExternalOffersSection'
import { ShopDealsSection } from '../components/life/ShopDealsSection'

/**
 * 惠生活 — resident benefits.
 *
 * 本地好物 is now the primary product source: it reads the deployment's own
 * on-shelf catalogue (`/catalog/products`), so the page shows real local products
 * and a real order-registration entry even when the CRMEB adapter is not
 * configured. The 优惠购 (CRMEB read-only) section is kept below it as a secondary
 * channel — its adapter, hooks and copy are untouched, it simply is no longer the
 * only source. Points exchange and the local-merchant map are still not connected,
 * so no demo points, demo goods or invented stores are rendered.
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
      <PageHeader icon={Gift} title="惠生活" subtitle="社区本地商品 · 登记办理意向" />

      {unavailableSection ? (
        <div
          role="status"
          className="mt-3 rounded-[16px] border border-[#f2dcc0] bg-[#fff7ec] px-3.5 py-3 text-[12px] leading-5 text-[#8a6132]"
        >
          {unavailableSection} 暂未开放。
        </div>
      ) : null}

      <div className="mt-5">
        <LocalCatalogSection activityId={activityId} />
      </div>

      <div className="mt-6 border-t border-slate-100 pt-5">
        <ExternalOffersSection />
      </div>

      <div className="mt-6 border-t border-slate-100 pt-5">
        <ShopDealsSection activityId={activityId} />
      </div>

    </div>
  )
}
