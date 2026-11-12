import { useEffect, useState } from 'react'
import { ExternalLink, Gift, RefreshCcw } from 'lucide-react'
import { EXTERNAL_OFFER_ROUTES, externalOfferListSchema, type ExternalOffer } from '@sanchuang-dev/local-life-contracts'
import { API_PREFIX, requestLocal } from '../../services/localApi'
import { SectionHeading } from '../home/SectionHeading'

type OffersState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error' }
  | { status: 'ready'; items: ExternalOffer[] }

/** Read-only third-party editorial content. Never logs in or creates a redemption. */
export function ExternalOffersSection() {
  const [state, setState] = useState<OffersState>({ status: 'loading' })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
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
    <section aria-label="第三方精选优惠">
      <SectionHeading title="精选优惠" note="第三方活动" />
      {state.status === 'loading' && (
        <p role="status" className="mt-3 text-xs text-slate-500">正在读取精选优惠…</p>
      )}
      {state.status === 'empty' && (
        <p className="mt-3 rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-5 text-xs text-slate-500">
          暂无已确认可用的第三方优惠，欢迎稍后再来看看。
        </p>
      )}
      {state.status === 'error' && (
        <div role="alert" className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
          优惠活动暂时无法加载。
          <button type="button" className="ml-2 inline-flex items-center gap-1 font-semibold underline"
            onClick={() => setVersion((n) => n + 1)}>
            <RefreshCcw size={13} /> 重试
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {state.items.map((offer) => (
            <article key={offer.id} className="flex min-w-0 flex-col rounded-[18px] border border-slate-100 bg-white p-3.5 shadow-sm">
              <span className="flex items-center gap-1.5 text-[11px] text-teal-700">
                <Gift size={13} aria-hidden="true" /> {offer.platform} · {offer.category}
              </span>
              <h3 className="mt-2 break-words text-sm font-semibold leading-5 text-slate-900">{offer.title}</h3>
              {offer.description && <p className="mt-1 break-words text-xs leading-5 text-slate-500">{offer.description}</p>}
              <a className="mt-auto flex min-h-[44px] items-center justify-center gap-1 pt-3 text-xs font-semibold text-teal-700"
                href={offer.url} target="_blank" rel="noopener noreferrer"
                aria-label={'前往' + offer.platform + '查看活动：' + offer.title}>
                查看活动 <ExternalLink size={13} aria-hidden="true" />
              </a>
            </article>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11px] leading-5 text-slate-500">
        第三方优惠以实际活动页面为准，可能受地区、时间及平台规则限制；本站不代发券、不保证领取成功。
      </p>
    </section>
  )
}
