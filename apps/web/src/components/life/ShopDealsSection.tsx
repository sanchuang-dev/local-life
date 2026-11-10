import { AlertTriangle, ShoppingBag, Store } from 'lucide-react'
import { useActivitySource, useShopProducts } from '../../hooks/useShopProducts'
import { SectionHeading } from '../home/SectionHeading'
import { ActivitySourceNote } from './ActivitySourceNote'
import { ShopProductCard } from './ShopProductCard'
import { ShopStateCard } from './ShopStateCard'

/**
 * The resident "优惠购" section backed by the real CRMEB adapter.
 *
 * Loading, empty, error, not-configured and ready are distinct, explicit states.
 * No branch falls back to `mocks/life.ts`: demo goods stay in the points section.
 */
export function ShopDealsSection({ activityId }: { activityId: string | null }) {
  const { state, retry } = useShopProducts()
  const activitySource = useActivitySource(activityId)

  return (
    <section>
      <SectionHeading title="优惠购" />

      <ActivitySourceNote
        activityId={activityId}
        state={activitySource.state}
        onRetry={activitySource.retry}
      />

      {state.status === 'loading' ? (
        <div role="status" aria-live="polite" className="mt-3">
          <div className="grid grid-cols-2 gap-3">
            {[0, 1, 2, 3].map((item) => (
              <div
                key={item}
                className="h-[196px] animate-pulse rounded-[18px] border border-slate-100 bg-white"
              />
            ))}
          </div>
          <p className="mt-2.5 text-[11px] leading-5 text-slate-400">
            正在读取 CRMEB 商城商品…
          </p>
        </div>
      ) : null}

      {state.status === 'not_configured' ? (
        <div className="mt-3">
          <ShopStateCard
            icon={Store}
            tone="warn"
            title="优惠购暂未开放"
            description="优惠购暂未开放，请稍后再试。"
            onRetry={retry}
            retryLabel="重新加载"
          />
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="mt-3">
          <ShopStateCard
            icon={AlertTriangle}
            tone="error"
            title="商品加载失败"
            description={state.message}
            code={state.code}
            onRetry={retry}
          />
        </div>
      ) : null}

      {state.status === 'empty' ? (
        <div className="mt-3">
          <ShopStateCard
            icon={ShoppingBag}
            title="商城暂无可购商品"
            description="暂无上架商品，稍后再来看看。"
            onRetry={retry}
          />
        </div>
      ) : null}

      {state.status === 'ready' ? (
        <div className="mt-3">
          <div className="grid grid-cols-2 gap-3">
            {state.data.items.map((product) => (
              <ShopProductCard
                key={product.id}
                product={product}
                activityId={activityId}
              />
            ))}
          </div>
          <p className="mt-1 break-words text-[11px] leading-5 text-slate-400">
            平台不代下单、不代支付，库存与可售状态以商城为准。
          </p>
          {state.data.hasMore ? (
            <p className="mt-1 break-words text-[11px] leading-5 text-slate-400">
              当前仅展示前 {state.data.items.length} 件，更多商品请以商城页面为准。
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
