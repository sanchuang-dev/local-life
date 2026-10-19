import { ArrowLeft, Gift } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { DemoNote } from '../components/DemoNote'
import { PageHeader } from '../components/PageHeader'
import { PendingNotice } from '../components/PendingNotice'
import { usePendingNotice } from '../hooks/usePendingNotice'
import {
  lifePoints,
  lifeProducts,
  lifeRedemptionNotice,
} from '../mocks/life'

const toneStyles = {
  mint: 'bg-gradient-to-br from-[#e8f6f0] to-[#d5ece1] text-[#388b77]',
  peach: 'bg-gradient-to-br from-[#fff3e6] to-[#f9e1c9] text-[#c6925c]',
} as const

export function ProductPage() {
  const { productId } = useParams()
  const { message, show, dismiss } = usePendingNotice()
  const product = lifeProducts.find((item) => item.id === productId)

  if (!product) {
    return (
      <div className="px-4 pb-7 pt-3">
        <Link
          to="/life"
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg text-[13px] font-medium text-slate-500 transition-colors hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          返回惠生活
        </Link>
        <div className="mt-6 rounded-[18px] border border-dashed border-slate-200 bg-white px-4 py-12 text-center">
          <p className="text-[14px] font-semibold text-slate-500">商品不存在</p>
          <p className="mt-2 text-[11px] leading-5 text-slate-400">
            该示例商品可能已下线，或链接有误。
          </p>
          <Link
            to="/life"
            className="mt-4 inline-flex min-h-[44px] items-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800"
          >
            返回惠生活
          </Link>
        </div>
      </div>
    )
  }

  const { icon: Icon, tone } = product
  const fields = [
    { label: '兑换方式', value: product.exchangeMode },
    { label: '核销地点', value: product.location },
    { label: '配送', value: '暂不支持配送，首批仅到店自提' },
    { label: '有效期', value: product.validity },
    { label: '兑换限制', value: product.limit },
  ]

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo="/life"
        backLabel="返回惠生活"
        icon={Gift}
        title={product.name}
        subtitle={`${product.category} · 示例商品`}
      />

      <article className="mt-4 overflow-hidden rounded-[20px] border border-slate-100 bg-white shadow-sm">
        <div
          className={`flex aspect-[4/3] items-center justify-center ${toneStyles[tone]}`}
          aria-hidden="true"
        >
          <Icon size={64} strokeWidth={1.3} />
        </div>
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
              {product.category}
            </span>
            <span className="rounded-full bg-[#fff3e6] px-2 py-0.5 text-[10px] font-medium text-[#a96b2f]">
              示例商品
            </span>
          </div>

          <p className="mt-2.5 text-[12px] leading-6 text-slate-500">{product.summary}</p>

          <div className="mt-3 flex items-baseline gap-1.5">
            <span className="text-[28px] font-semibold leading-none tracking-tight text-[#8a6132]">
              {product.points}
            </span>
            <span className="text-[12px] text-slate-400">积分 · 到店核销</span>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">
            {product.stock} · {product.limit}
          </p>

          <button
            type="button"
            onClick={() => show(lifeRedemptionNotice)}
            className="mt-4 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-teal-700 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            模拟兑换 · 不扣积分
          </button>
          <p className="mt-2 text-center text-[11px] leading-5 text-slate-400">
            兑换需 {product.points} 积分，演示余额 {lifePoints.current} 积分（不会扣减）
          </p>
        </div>
      </article>

      <div className="mt-4">
        <DemoNote tone="warn">{lifeRedemptionNotice}</DemoNote>
      </div>

      <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-800">兑换与核销说明</h2>
        <dl className="mt-2 divide-y divide-slate-100 border-t border-slate-100">
          {fields.map(({ label, value }) => (
            <div key={label} className="flex items-start justify-between gap-3 py-2.5">
              <dt className="shrink-0 text-[12px] text-slate-400">{label}</dt>
              <dd className="text-right text-[12px] font-medium leading-5 text-slate-600">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 rounded-[14px] bg-slate-50 px-3.5 py-3 text-[12px] leading-5 text-slate-500">
          {product.note}
        </p>
      </section>

      <div className="mt-4">
        <Link
          to="/life/exchange"
          className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          查看其它积分好礼
        </Link>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
