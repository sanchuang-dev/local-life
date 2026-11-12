import { AlertTriangle, RefreshCcw, ShoppingBag, Store } from 'lucide-react'
import { useActivitySource, useShopProducts } from '../../hooks/useShopProducts'
import { ActivitySourceNote } from './ActivitySourceNote'
import { ShopProductCard } from './ShopProductCard'

/** CRMEB products, preserving real adapter states and trusted activity deep links. */
export function ShopDealsSection({ activityId }: { activityId: string | null }) {
  const { state, retry } = useShopProducts()
  const activitySource = useActivitySource(activityId)

  return (
    <section
      id="life-deals"
      aria-labelledby="life-deals-title"
      className={'life-shelf-card life-shelf-card--deals' + (state.status === 'ready' ? ' life-shelf-card--expanded' : '')}
    >
      <header className="life-shelf-card__header">
        <span className="life-shelf-card__icon" aria-hidden="true"><Store size={23} strokeWidth={1.9} /></span>
        <div className="life-shelf-card__heading">
          <h3 id="life-deals-title">优惠购</h3>
          <p>合作商城商品</p>
        </div>
      </header>

      <div className="life-shelf-card__body">
        {activityId && (
          <ActivitySourceNote
            activityId={activityId}
            state={activitySource.state}
            onRetry={activitySource.retry}
          />
        )}
        {state.status === 'loading' && (
          <div role="status" className="life-shelf-card__body">
            <span className="life-shelf-card__illustration" aria-hidden="true"><ShoppingBag size={46} strokeWidth={1.45} /></span>
            <p className="life-shelf-card__status">正在读取商城…</p>
          </div>
        )}
        {state.status === 'not_configured' && (
          <div className="life-shelf-card__body">
            <span className="life-shelf-card__illustration" aria-hidden="true"><Store size={46} strokeWidth={1.45} /></span>
            <p className="life-shelf-card__status">优惠购暂未开放</p>
            <p className="life-shelf-card__detail">{state.message}</p>
            <button type="button" className="life-shelf-card__action" onClick={retry}>
              <RefreshCcw size={15} aria-hidden="true" /> 重新加载
            </button>
          </div>
        )}
        {state.status === 'empty' && (
          <div className="life-shelf-card__body">
            <span className="life-shelf-card__illustration" aria-hidden="true"><ShoppingBag size={46} strokeWidth={1.45} /></span>
            <p className="life-shelf-card__status">商城暂无商品</p>
            <p className="life-shelf-card__detail">暂未查询到上架商品</p>
            <button type="button" className="life-shelf-card__action" onClick={retry}>
              <RefreshCcw size={15} aria-hidden="true" /> 重新读取
            </button>
          </div>
        )}
        {state.status === 'error' && (
          <div role="alert" className="life-shelf-card__body">
            <span className="life-shelf-card__illustration" aria-hidden="true"><AlertTriangle size={42} strokeWidth={1.45} /></span>
            <p className="life-shelf-card__status">商城读取失败</p>
            <p className="life-shelf-card__message">{state.message}</p>
            {state.code && <p className="life-shelf-card__detail">错误代码：{state.code}</p>}
            <button type="button" className="life-shelf-card__action" onClick={retry}>
              <RefreshCcw size={15} aria-hidden="true" /> 重新读取
            </button>
          </div>
        )}
        {state.status === 'ready' && (
          <>
            <p className="life-shelf-card__label">商品由合作商城提供，实际价格和库存以商城为准。</p>
            <div className="life-shelf-card__product-grid">
              {state.data.items.map((product) => (
                <ShopProductCard key={product.crmebProductId} product={product} activityId={activityId} />
              ))}
            </div>
            {state.data.hasMore && (
              <p className="life-shelf-card__footer">
                当前展示前 {state.data.items.length} 件，更多以商城页面为准。
              </p>
            )}
          </>
        )}
      </div>
      <p className="life-shelf-card__footer">商品与可购状态以合作商城为准，本站不代下单或支付。</p>
    </section>
  )
}
