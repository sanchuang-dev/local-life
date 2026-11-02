import { ChevronRight, Gift, ShoppingBag } from 'lucide-react'
import { type KeyboardEvent, useState } from 'react'
import { DemoNote } from '../components/DemoNote'
import { LifeProductCard } from '../components/life/LifeProductCard'
import { PointsSummaryCard } from '../components/life/PointsSummaryCard'
import { PageHeader } from '../components/PageHeader'
import { PendingNotice } from '../components/PendingNotice'
import { SectionHeading } from '../components/home/SectionHeading'
import { usePendingNotice } from '../hooks/usePendingNotice'
import {
  lifeConceptNote,
  lifeMapNotice,
  lifeProducts,
  lifeStores,
} from '../mocks/life'

const lifeSections = [
  { id: 'points', label: '积分兑换' },
  { id: 'deals', label: '优惠购' },
  { id: 'local', label: '本地生活' },
] as const

type LifeSection = (typeof lifeSections)[number]['id']

const toneStyles = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  peach: 'bg-[#fff3e6] text-[#c6925c]',
} as const

export function LifePage() {
  const { message, show, dismiss } = usePendingNotice()
  const [activeSection, setActiveSection] = useState<LifeSection>('points')

  const selectSection = (section: LifeSection) => {
    setActiveSection(section)
    dismiss()
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const lastIndex = lifeSections.length - 1
    let nextIndex: number

    switch (event.key) {
      case 'ArrowRight':
        nextIndex = index === lastIndex ? 0 : index + 1
        break
      case 'ArrowLeft':
        nextIndex = index === 0 ? lastIndex : index - 1
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = lastIndex
        break
      default:
        return
    }

    event.preventDefault()
    const nextSection = lifeSections[nextIndex]
    selectSection(nextSection.id)
    document.getElementById(`life-tab-${nextSection.id}`)?.focus()
  }

  return (
    <div className="px-4 pb-7 pt-4">
      <PageHeader
        icon={Gift}
        title="惠生活"
        subtitle="居民权益 · 积分好礼 · 本地服务"
      />

      <DemoNote>
        本页按积分兑换、优惠购、本地生活三个演示分类展示；商品、库存、积分与门店均为示例数据，不接入支付、订单或发券后台。
      </DemoNote>

      <div
        role="tablist"
        aria-label="惠生活分类"
        className="mt-4 grid grid-cols-3 gap-1 rounded-[18px] border border-slate-100 bg-white p-1 shadow-sm"
      >
        {lifeSections.map(({ id, label }, index) => {
          const selected = id === activeSection
          return (
            <button
              key={id}
              id={`life-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`life-panel-${id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectSection(id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl px-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600 ${
                selected
                  ? 'bg-teal-700 font-semibold text-white shadow-sm'
                  : 'font-medium text-slate-500 hover:bg-slate-50 hover:text-teal-700'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  selected ? 'bg-white' : 'bg-slate-300'
                }`}
                aria-hidden="true"
              />
              {label}
            </button>
          )
        })}
      </div>

      <div
        id="life-panel-points"
        role="tabpanel"
        aria-labelledby="life-tab-points"
        hidden={activeSection !== 'points'}
        className="mt-4"
      >
        <PointsSummaryCard />

        <section className="mt-5">
          <SectionHeading
            title="积分好礼"
            note="示例商品"
            actionLabel="全部好礼"
            actionTo="/life/exchange"
          />
          <div className="grid grid-cols-2 gap-3">
            {lifeProducts.map((product) => (
              <LifeProductCard key={product.id} product={product} from="/life" />
            ))}
          </div>
          <p className="mt-2.5 text-[11px] leading-5 text-slate-400">
            商品、库存与积分价格均为示例数据，兑换不会真实扣分或发券。
          </p>
        </section>

        <div className="mt-4">
          <DemoNote>{lifeConceptNote}</DemoNote>
        </div>
      </div>

      <div
        id="life-panel-deals"
        role="tabpanel"
        aria-labelledby="life-tab-deals"
        hidden={activeSection !== 'deals'}
        className="mt-4"
      >
        <section className="rounded-[20px] border border-dashed border-slate-200 bg-white px-5 py-8 text-center shadow-sm">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[18px] bg-[#fff3e6] text-[#c6925c]">
            <ShoppingBag size={26} strokeWidth={1.6} aria-hidden="true" />
          </span>
          <span className="mt-3 inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-500">
            功能待接入
          </span>
          <h2 className="mt-2.5 text-[16px] font-semibold text-slate-800">
            暂无可演示的优惠商品
          </h2>
          <p className="mx-auto mt-2 max-w-[280px] text-[12px] leading-6 text-slate-500">
            原型尚未接入真实商品、价格、折扣与支付数据。为避免误导，这里不展示虚构优惠，也不会模拟下单成功。
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => selectSection('points')}
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-teal-700 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              去看看积分兑换
            </button>
            <button
              type="button"
              onClick={() => selectSection('local')}
              className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-slate-200 bg-white text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              浏览本地生活
            </button>
          </div>
        </section>

        <div className="mt-4">
          <DemoNote tone="warn">
            优惠购需要真实商品、价格与支付能力，当前原型没有可证明的数据，因此保持空态。
          </DemoNote>
        </div>
      </div>

      <div
        id="life-panel-local"
        role="tabpanel"
        aria-labelledby="life-tab-local"
        hidden={activeSection !== 'local'}
        className="mt-4"
      >
        <section>
          <SectionHeading
            title="附近可到店核销"
            note="示例门店"
            actionLabel="地图"
            onAction={() => show(lifeMapNotice)}
          />
          <div className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
            {lifeStores.map(({ id, name, meta, tag, icon: Icon, tone, pendingNotice }, index) => (
              <button
                key={id}
                type="button"
                onClick={() => show(pendingNotice)}
                className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600 ${
                  index > 0 ? 'border-t border-slate-100' : ''
                }`}
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${toneStyles[tone]}`}
                  aria-hidden="true"
                >
                  <Icon size={18} strokeWidth={1.7} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-slate-700">{name}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">{meta}</span>
                </span>
                {tag ? (
                  <span className="shrink-0 rounded-full bg-[#fff3e6] px-2 py-0.5 text-[10px] font-medium text-[#a96b2f]">
                    {tag}
                  </span>
                ) : (
                  <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          <p className="mt-2.5 text-[11px] leading-5 text-slate-400">
            门店位置、营业状态与核销券码均为示例，点击门店只展示演示提示。
          </p>
        </section>

        <div className="mt-4">
          <DemoNote>{lifeMapNotice}</DemoNote>
        </div>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
