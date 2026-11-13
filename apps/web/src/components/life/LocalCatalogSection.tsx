import { Link } from 'react-router'
import { ArrowRight, RefreshCcw, ShoppingBasket } from 'lucide-react'
import { useLocalCatalog } from '../../hooks/useLocalCatalog'
import { LocalProductCard } from './LocalProductCard'

/**
 * Real local catalogue. Empty/error/loading are honest category cards;
 * the card expands to a full-width, two-column shelf when products exist.
 * Registration and activity attribution stay in LocalProductCard/detail route.
 */
export function LocalCatalogSection({ activityId = null }: { activityId?: string | null }) {
  const { state, reload } = useLocalCatalog()

  return (
    <section
      id="life-local"
      aria-labelledby="life-local-title"
      className={'life-shelf-card life-shelf-card--local' + (state.status === 'ready' ? ' life-shelf-card--expanded' : '')}
    >
      <header className="life-shelf-card__header">
        <span className="life-shelf-card__icon" aria-hidden="true"><ShoppingBasket size={23} strokeWidth={1.9} /></span>
        <div className="life-shelf-card__heading">
          <h3 id="life-local-title">本地好物</h3>
          <p>社区上架商品</p>
        </div>
      </header>

      <div className="life-shelf-card__body">
        {state.status === 'loading' && (
          <div role="status" className="life-shelf-card__body">
            <span className="life-shelf-card__illustration" aria-hidden="true"><ShoppingBasket size={49} strokeWidth={1.45} /></span>
            <p className="life-shelf-card__status">正在读取商品…</p>
          </div>
        )}
        {state.status === 'empty' && (
          <div className="life-shelf-card__body">
            <span className="life-shelf-card__illustration" aria-hidden="true"><ShoppingBasket size={49} strokeWidth={1.45} /></span>
            <p className="life-shelf-card__status">暂时没有上架商品</p>
            <button type="button" onClick={reload} className="life-shelf-card__action">
              <RefreshCcw size={15} aria-hidden="true" /> 重新读取
            </button>
          </div>
        )}
        {state.status === 'error' && (
          <div role="alert" className="life-shelf-card__body">
            <span className="life-shelf-card__illustration" aria-hidden="true"><ShoppingBasket size={46} strokeWidth={1.45} /></span>
            <p className="life-shelf-card__status">商品读取失败</p>
            <p className="life-shelf-card__message">{state.message}</p>
            {state.code && <p className="life-shelf-card__detail">错误代码：{state.code}</p>}
            <button type="button" onClick={reload} className="life-shelf-card__action">
              <RefreshCcw size={15} aria-hidden="true" /> 重试
            </button>
          </div>
        )}
        {state.status === 'ready' && (
          <>
            <p className="life-shelf-card__label">
              共 {state.total} 件已上架商品{state.hasMore ? ' · 当前展示前 ' + state.items.length + ' 件' : ''}
            </p>
            <div className="life-shelf-card__product-grid">
              {state.items.map((product) => (
                <LocalProductCard key={product.id} product={product} activityId={activityId} />
              ))}
            </div>
            <p className="life-shelf-card__footer">
              平台只登记办理意向，不直接收款；商品交付由社区工作人员跟进。
            </p>
          </>
        )}
      </div>

      <Link className="life-shelf-card__footer" to="/me/orders" state={{ from: '/life' }}>
        我的订单 <ArrowRight size={12} className="inline" aria-hidden="true" />
      </Link>
    </section>
  )
}
