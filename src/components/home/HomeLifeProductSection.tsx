import { LifeProductCard } from '../life/LifeProductCard'
import { lifeProducts } from '../../mocks/life'
import { SectionHeading } from './SectionHeading'

/** Home recommendations use the same product fixtures and detail page as `/life`. */
export function HomeLifeProductSection() {
  return (
    <section className="mx-4 mt-7">
      <SectionHeading
        title="惠生活"
        note="积分好礼"
        actionLabel="进入惠生活"
        actionTo="/life"
      />
      <div className="grid grid-cols-2 gap-3">
        {lifeProducts.slice(0, 2).map((product) => (
          <LifeProductCard key={product.id} product={product} from="/" />
        ))}
      </div>
      <p className="mt-2.5 text-[11px] leading-5 text-slate-400">
        商品、库存与积分价格均为示例数据，兑换不会真实扣分或发券。
      </p>
    </section>
  )
}
