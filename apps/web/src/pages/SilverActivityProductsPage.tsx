import { useState } from 'react'
import {
  BadgeCheck, ChevronRight, CircleHelp, HeartPulse, House,
  Monitor, Radio, ScanFace, Settings2, ShieldCheck, Smartphone,
  Sparkles, Tv, Wifi, Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Link, useParams } from 'react-router'
import {
  silverActivityProducts, silverActivityProductCategories,
  type SilverActivityProduct,
  type SilverActivityProductCategory,
  type SilverActivityProductKind,
} from '../mocks/silverActivityProducts'

const activityPath = '/community/activity/silver-neighborhood'
const productsPath = activityPath + '/products'

const deviceIcons: Record<SilverActivityProductKind, LucideIcon> = {
  tv: Tv, box: Monitor, membership: BadgeCheck, broadband: Wifi,
  bundle: House, install: Wrench, 'smart-home': Settings2,
  screen: Smartphone, mirror: ScanFace, 'mirror-service': HeartPulse,
}
const productTones: Record<SilverActivityProductCategory, string> = {
  电视娱乐: 'from-[#d9eeeb] via-[#eff9f4] to-[#dcebf8] text-[#216b73]',
  家庭网络: 'from-[#e8f3fb] via-[#f0f9f8] to-[#d9eee9] text-[#3876a1]',
  智能硬件: 'from-[#f6e9d5] via-[#fff8ed] to-[#e5f0e5] text-[#a16c36]',
  魔镜体验: 'from-[#eae7fa] via-[#f5effc] to-[#e3edf4] text-[#7557a3]',
}

function ProductIllustration({ product, large = false }: { product: SilverActivityProduct; large?: boolean }) {
  const Icon = deviceIcons[product.kind]
  const sizeClass = large ? 'h-[150px] w-full rounded-[19px]' : 'h-[112px] w-full rounded-t-[17px]'
  return (
    <div className={'relative flex shrink-0 items-center justify-center overflow-hidden bg-gradient-to-br ' + productTones[product.category] + ' ' + sizeClass} aria-hidden="true">
      <span className="absolute -right-6 -top-9 h-28 w-28 rounded-full border-[14px] border-white/40" />
      <span className="absolute -bottom-10 -left-7 h-28 w-28 rounded-full bg-white/25" />
      <div className="relative flex h-[84px] w-[92px] items-center justify-center rounded-[22px] border border-white/70 bg-white/45 shadow-[0_9px_20px_rgba(38,72,68,0.1)]">
        <Icon size={large ? 58 : 48} strokeWidth={1.55} />
      </div>
      {product.category === '魔镜体验' ? <Sparkles className="absolute right-5 top-4 opacity-65" size={18} /> : null}
    </div>
  )
}

export function SilverActivityProductsPage() {
  const { productId } = useParams()
  const [category, setCategory] = useState<(typeof silverActivityProductCategories)[number]>('全部')
  const product = silverActivityProducts.find((item) => item.id === productId)
  const visibleProducts = category === '全部' ? silverActivityProducts : silverActivityProducts.filter((item) => item.category === category)

  if (productId) {
    return (
      <div className="px-4 pb-8 pt-4">
        {product ? (
          <article className="mt-3 overflow-hidden rounded-[22px] border border-slate-100 bg-white shadow-sm">
            <div className="p-3"><ProductIllustration product={product} large /></div>
            <div className="px-4 pb-5">
              <span className="inline-flex rounded-full bg-[#eaf5ed] px-2.5 py-1 text-[11px] font-medium text-teal-700">
                {product.category} · {product.tag}
              </span>
              <h1 className="mt-2 text-[21px] font-bold text-slate-900">{product.name}</h1>
              <p className="mt-1 text-[13px] text-slate-500">{product.short}</p>
              <p className="mt-3 text-[13px] leading-6 text-slate-600">{product.intro}</p>
              <h2 className="mt-4 border-t border-slate-100 pt-4 text-[15px] font-bold text-slate-800">内容与服务范围</h2>
              <ul className="mt-2 space-y-2">
                {product.includes.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-[13px] leading-5 text-slate-600">
                    <ShieldCheck size={16} className="mt-0.5 shrink-0 text-teal-700" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
              <div className="mt-4 rounded-[14px] bg-[#f2f8f5] p-3 text-[12px] leading-5 text-[#376958]">
                活动展示方案，非已上架商品。具体品牌、型号、价格、可购资格和服务范围待确认。
              </div>
              <Link to={product.relatedPath} state={{ from: productsPath + '/' + product.id }}
                className="mt-4 flex min-h-11 items-center justify-center gap-2 rounded-xl border border-teal-200 bg-white text-[13px] font-semibold text-teal-700">
                {product.category === '魔镜体验' ? '了解魔镜能力' : '了解广电服务'} <ChevronRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </article>
        ) : (
          <div className="mt-4 rounded-[18px] bg-white p-6 text-center text-[14px] text-slate-500">未找到该展示项目。</div>
        )}
        <Link to={activityPath} className="mt-4 flex min-h-11 items-center justify-center rounded-xl border border-teal-200 bg-white text-[13px] font-semibold text-teal-700">返回银发社区欢乐季</Link>
      </div>
    )
  }

  return (
    <div className="px-4 pb-8 pt-4">
      <div className="mt-2 flex items-center gap-2">
        <Radio className="text-teal-700" size={23} aria-hidden="true" />
        <h1 className="text-[21px] font-bold text-slate-900">参与活动的商品</h1>
      </div>
      <div className="relative mt-3 overflow-hidden rounded-[19px] bg-gradient-to-br from-[#176b59] to-[#2d8a7b] px-4 py-4 text-white">
        <div className="absolute -right-5 -bottom-8 opacity-20"><Tv size={125} strokeWidth={1} /></div>
        <p className="text-[11px] font-medium tracking-widest text-white/80">银发社区欢乐季 · 好物体验</p>
        <p className="relative mt-1 text-[19px] font-bold">大屏影音 · 智能生活</p>
        <p className="relative mt-1 max-w-[230px] text-[12px] leading-5 text-white/85">
          电视、家庭网络、智能硬件与魔镜体验，逛逛适合全家的服务方案。
        </p>
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-5 text-slate-500">
        <CircleHelp size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        当前为商品与服务概念展示，实际参与商品、型号及价格尚未配置。
      </p>
      <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 py-1" aria-label="商品分类筛选">
        {silverActivityProductCategories.map((item) => (
          <button key={item} type="button" onClick={() => setCategory(item)} aria-pressed={category === item}
            className={'min-h-10 shrink-0 rounded-full border px-3.5 text-[12px] font-semibold transition-colors ' +
              (category === item ? 'border-teal-700 bg-teal-700 text-white' : 'border-slate-200 bg-white text-slate-600')}>
            {item}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <h2 className="text-[16px] font-bold text-slate-800">{category === '全部' ? '精选商品与服务' : category}</h2>
        <span className="text-[12px] text-slate-500">共 {visibleProducts.length} 项</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {visibleProducts.map((item) => (
          <Link key={item.id} to={productsPath + '/' + item.id}
            className="group flex min-w-0 flex-col overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600">
            <ProductIllustration product={item} />
            <div className="flex flex-1 flex-col px-3 pb-3 pt-2.5">
              <span className="text-[10px] font-medium text-teal-700">{item.tag}</span>
              <h3 className="mt-1 text-[14px] font-bold leading-5 text-slate-900">{item.name}</h3>
              <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-slate-500">{item.short}</p>
              <span className="mt-auto inline-flex items-center gap-1 pt-3 text-[12px] font-semibold text-teal-700">
                查看详情 <ChevronRight size={14} aria-hidden="true" />
              </span>
            </div>
          </Link>
        ))}
      </div>
      <p className="mt-4 text-[12px] leading-5 text-slate-500">
        展示内容不代表已开售或实际购买成功，浏览不会改变消费组队进度。
      </p>
    </div>
  )
}
