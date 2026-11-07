import { Link } from 'react-router'
import { Info, ShoppingBasket } from 'lucide-react'
import { useLocalCatalog } from '../../hooks/useLocalCatalog'
import { SectionHeading } from '../home/SectionHeading'
import {
  LocalCatalogError,
  LocalProductCard,
  LocalProductSkeletons,
} from './LocalProductCard'

/**
 * 「本地好物」 — the real, local, on-shelf catalogue of this deployment.
 *
 * This is the primary product source of 惠生活: it reads
 * `GET /catalog/products` and renders exactly what the API returns. Five states
 * are explicit and none of them invents a product:
 *   loading → skeleton; error → server sentence + retry; empty → honest empty
 *   copy; ready → the real tiles.
 *
 * Registration happens on the detail page, where the login requirement and the
 * 「登记订单 / 提交办理意向」 CTA live. Browsing stays session-free.
 */
export function LocalCatalogSection() {
  const { state, reload } = useLocalCatalog()

  return (
    <section aria-labelledby="local-catalog-heading">
      <SectionHeading title="本地好物" note="社区上架商品" />

      <p id="local-catalog-heading" className="sr-only">
        本地好物：社区上架的本地商品目录
      </p>

      {state.status === 'loading' ? (
        <div className="mt-1">
          <LocalProductSkeletons />
          <p className="mt-2.5 text-[11px] leading-5 text-slate-400">
            正在读取本社区的已上架商品…
          </p>
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="mt-1">
          <LocalCatalogError message={state.message} code={state.code} onRetry={reload} />
        </div>
      ) : null}

      {state.status === 'empty' ? (
        <div className="mt-1 rounded-[20px] border border-dashed border-slate-200 bg-white px-5 py-8 text-center">
          <span
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-[18px] bg-[#eef7f2] text-[#388b77]"
            aria-hidden="true"
          >
            <ShoppingBasket size={26} strokeWidth={1.6} />
          </span>
          <p className="mt-3 text-[15px] font-semibold text-slate-700">当前没有已上架的本地商品</p>
          <p className="mx-auto mt-2 max-w-[300px] text-[12px] leading-6 text-slate-400">
            社区上架商品后会自动出现在这里。为避免误导，本页不会用示例商品或商城商品填充本地目录。
          </p>
          <button
            type="button"
            onClick={reload}
            className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 px-4 text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700"
          >
            重新读取
          </button>
        </div>
      ) : null}

      {state.status === 'ready' ? (
        <div className="mt-1">
          <div className="grid grid-cols-2 gap-3">
            {state.items.map((product) => (
              <LocalProductCard key={product.id} product={product} />
            ))}
          </div>
          <p className="mt-2.5 break-words text-[11px] leading-5 text-slate-400">
            共 {state.total} 件已上架商品
            {state.hasMore ? `，当前展示前 ${state.items.length} 件` : ''}。价格与商品名称由社区维护，
            登记订单时会冻结当时的快照。
          </p>
          <p className="mt-1 break-words text-[11px] leading-5 text-slate-400">
            本平台只登记办理意向，不收款、不代下单；具体交付以社区工作人员联系为准。
          </p>
        </div>
      ) : null}

      <div className="mt-3 flex items-start gap-1.5 rounded-[14px] bg-[#f4f8f6] px-3.5 py-2.5">
        <Info size={14} className="mt-0.5 shrink-0 text-[#388b77]" aria-hidden="true" />
        <p className="text-[11px] leading-5 text-[#52786c]">
          查看已登记的订单请到
          <Link
            to="/me/orders"
            state={{ from: '/life' }}
            className="mx-0.5 font-semibold text-teal-700 underline decoration-teal-300 underline-offset-4"
          >
            我的订单
          </Link>
          。
        </p>
      </div>
    </section>
  )
}
