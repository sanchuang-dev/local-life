import { useEffect, useState } from 'react'
import { ExternalLink, Gift, RefreshCcw, Tag } from 'lucide-react'
import { EXTERNAL_OFFER_ROUTES, externalOfferListSchema, type ExternalOffer } from '@sanchuang-dev/local-life-contracts'
import { API_PREFIX, requestLocal } from '../../services/localApi'

type OffersState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error' }
  | { status: 'ready'; items: ExternalOffer[] }

/** Real, read-only third-party activities. No claim of coupons being issued by this app. */
export function ExternalOffersSection() {
  const [state, setState] = useState<OffersState>({ status: 'loading' })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    requestLocal(
      API_PREFIX + EXTERNAL_OFFER_ROUTES.publicList, externalOfferListSchema,
      '第三方优惠活动', { signal: controller.signal },
    ).then(({ items }) => {
      if (!controller.signal.aborted) {
        setState(items.length ? { status: 'ready', items } : { status: 'empty' })
      }
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: 'error' })
    })
    return () => controller.abort()
  }, [version])

  return (
    <section
      id="life-offers"
      aria-labelledby="life-offers-title"
      className={'life-shelf-card life-shelf-card--offers' + (state.status === 'ready' ? ' life-shelf-card--expanded' : '')}
    >
      <header className="life-shelf-card__header">
        <span className="life-shelf-card__icon" aria-hidden="true"><Tag size={23} strokeWidth={1.9} /></span>
        <div className="life-shelf-card__heading">
          <h3 id="life-offers-title">精选优惠</h3>
          <p>第三方活动</p>
        </div>
      </header>

      <div className="life-shelf-card__body">
        {state.status === 'loading' && (
          <div role="status" className="life-shelf-card__body">
            <span className="life-shelf-card__illustration" aria-hidden="true"><Gift size={47} strokeWidth={1.45} /></span>
            <p className="life-shelf-card__status">正在读取优惠…</p>
          </div>
        )}
        {state.status === 'empty' && (
          <div className="life-shelf-card__body">
            <span className="life-shelf-card__illustration" aria-hidden="true"><Gift size={47} strokeWidth={1.45} /></span>
            <p className="life-shelf-card__status">暂无精选优惠</p>
            <p className="life-shelf-card__detail">稍后再来看看</p>
          </div>
        )}
        {state.status === 'error' && (
          <div role="alert" className="life-shelf-card__body">
            <span className="life-shelf-card__illustration" aria-hidden="true"><Gift size={47} strokeWidth={1.45} /></span>
            <p className="life-shelf-card__status">优惠读取失败</p>
            <button type="button" className="life-shelf-card__action" onClick={() => { setState({ status: 'loading' }); setVersion((n) => n + 1) }}>
              <RefreshCcw size={15} aria-hidden="true" /> 重试
            </button>
          </div>
        )}
        {state.status === 'ready' && (
          <>
            <p className="life-shelf-card__label">活动由第三方平台提供，详情以原平台展示为准。</p>
            <div className="life-shelf-card__product-grid">
              {state.items.map((offer) => (
                <article key={offer.id} className="life-market__offer">
                  <span className="life-market__offer-tag"><Tag size={12} aria-hidden="true" />{offer.platform} · {offer.category}</span>
                  <h4>{offer.title}</h4>
                  {offer.description && <p>{offer.description}</p>}
                  <a href={offer.url} target="_blank" rel="noopener noreferrer"
                    aria-label={'前往' + offer.platform + '查看活动：' + offer.title}>
                    查看活动 <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </article>
              ))}
            </div>
          </>
        )}
      </div>
      <p className="life-shelf-card__footer">优惠以第三方实际规则为准，本站不代发券。</p>
    </section>
  )
}
