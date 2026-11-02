import { Ticket } from 'lucide-react'
import { useState } from 'react'
import { DemoNote } from '../components/DemoNote'
import { LifeProductCard } from '../components/life/LifeProductCard'
import { PointsSummaryCard } from '../components/life/PointsSummaryCard'
import { PageHeader } from '../components/PageHeader'
import { useBackTarget } from '../hooks/useBackTarget'
import {
  lifeExchangeNote,
  lifeProductFilters,
  lifeProducts,
  type LifeProductFilter,
} from '../mocks/life'

export function ExchangePage() {
  const { backTo, backLabel } = useBackTarget('/life', '返回惠生活')
  const [filter, setFilter] = useState<LifeProductFilter>('全部')
  const visible =
    filter === '全部'
      ? lifeProducts
      : lifeProducts.filter((product) => product.category === filter)

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={Ticket}
        title="积分兑换"
        subtitle="好礼与权益列表 · 演示兑换"
      />

      <DemoNote>
        筛选只在本页切换示例商品；兑换不会真实扣减积分、生成订单或发放券码。
      </DemoNote>

      <div className="mt-4">
        <PointsSummaryCard from="/life/exchange" />
      </div>

      <div className="mt-4 flex flex-wrap gap-2" aria-label="兑换分类">
        {lifeProductFilters.map((item) => {
          const selected = item === filter
          return (
            <button
              key={item}
              type="button"
              aria-pressed={selected}
              onClick={() => setFilter(item)}
              className={`min-h-[36px] rounded-full border px-3.5 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${
                selected
                  ? 'border-teal-600 bg-teal-600 text-white'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-teal-200 hover:text-teal-700'
              }`}
            >
              {item}
            </button>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <div className="mt-4 rounded-[18px] border border-dashed border-slate-200 bg-white px-4 py-10 text-center">
          <p className="text-[13px] font-semibold text-slate-500">该分类暂无内容</p>
          <p className="mt-1.5 text-[11px] leading-5 text-slate-400">
            演示数据暂未提供「{filter}」商品，可切换其它分类查看。
          </p>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {visible.map((product) => (
            <LifeProductCard key={product.id} product={product} from="/life/exchange" />
          ))}
        </div>
      )}

      <div className="mt-6">
        <DemoNote>{lifeExchangeNote}</DemoNote>
      </div>
    </div>
  )
}
