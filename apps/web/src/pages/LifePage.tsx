import { ArrowRight, CalendarDays, ClipboardList, Gift, ShoppingBasket, Sparkles, Store, Tag } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { LocalCatalogSection } from '../components/life/LocalCatalogSection'
import { ExternalOffersSection } from '../components/life/ExternalOffersSection'
import { ShopDealsSection } from '../components/life/ShopDealsSection'
import './LifePage.css'

/**
 * 惠生活：只重排已有的真实货架。
 * 所有入口要么滚动到真实数据区，要么进入已存在的应用路由。
 * 不制作虚构商品、优惠券、搜索或支付入口。
 */
export function LifePage() {
  const [searchParams] = useSearchParams()
  const activityId = searchParams.get('activityId')?.trim() || null
  const requestedSection = searchParams.get('tab')
  const unavailableSection =
    requestedSection === 'points' ? '积分兑换' : requestedSection === 'local' ? '本地生活门店' : null

  function jumpTo(id: string) {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(id)?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'start',
    })
  }

  return (
    <div className="life-market">
      <header className="life-market__hero" style={{ backgroundImage: `url(${import.meta.env.BASE_URL}images/life-market-hero.webp)` }}>
        <div className="life-market__hero-content">
          <span className="life-market__eyebrow"><Sparkles size={13} aria-hidden="true" /> 社区好物 · 邻里优惠</span>
          <h1>惠生活</h1>
          <p>家门口的好物与优惠，慢慢逛</p>
          <div className="life-market__hero-tabs" aria-label="惠生活与社区活动">
            <span aria-current="page">惠生活</span>
            <Link to="/" aria-label="前往社区活动">社区活动 <ArrowRight size={14} aria-hidden="true" /></Link>
          </div>
        </div>
      </header>

      <nav className="life-market__shortcuts" aria-label="惠生活快捷入口">
        <button type="button" onClick={() => jumpTo('life-local')}>
          <span className="life-market__shortcut-icon life-market__shortcut-icon--green"><ShoppingBasket size={23} aria-hidden="true" /></span>
          <span>本地好物</span>
        </button>
        <button type="button" onClick={() => jumpTo('life-offers')}>
          <span className="life-market__shortcut-icon life-market__shortcut-icon--coral"><Tag size={23} aria-hidden="true" /></span>
          <span>精选优惠</span>
        </button>
        <button type="button" onClick={() => jumpTo('life-deals')}>
          <span className="life-market__shortcut-icon life-market__shortcut-icon--orange"><Store size={23} aria-hidden="true" /></span>
          <span>优惠购</span>
        </button>
        <Link to="/me/orders" state={{ from: '/life' }}>
          <span className="life-market__shortcut-icon life-market__shortcut-icon--blue"><ClipboardList size={23} aria-hidden="true" /></span>
          <span>我的订单</span>
        </Link>
        <Link to="/">
          <span className="life-market__shortcut-icon life-market__shortcut-icon--pink"><CalendarDays size={23} aria-hidden="true" /></span>
          <span>社区活动</span>
        </Link>
      </nav>

      {unavailableSection && (
        <p role="status" className="life-market__unavailable">
          {unavailableSection}暂未开放，先看看已上线的服务吧。
        </p>
      )}

      <div className="life-market__content">
        <div className="life-market__section-title">
          <h2>逛逛惠生活</h2>
          <span>好物与优惠</span>
        </div>

        <div className="life-market__grid" aria-label="惠生活分类货架">
          <LocalCatalogSection activityId={activityId} />
          <ExternalOffersSection />
          <ShopDealsSection activityId={activityId} />
          <Link to="/me/orders" state={{ from: '/life' }} className="life-market__order-tile" aria-label="前往我的订单查询登记状态">
            <span className="life-market__order-kicker"><Gift size={14} aria-hidden="true" /> 便捷入口</span>
            <span className="life-market__order-title">登记过的好物</span>
            <span className="life-market__order-subtitle">在「我的订单」中查看办理进度</span>
            <span className="life-market__order-illustration" aria-hidden="true"><ClipboardList size={64} strokeWidth={1.35} /></span>
            <span className="life-market__order-action">查看我的订单 <ArrowRight size={16} aria-hidden="true" /></span>
          </Link>
        </div>

        <p className="life-market__footnote">商品、优惠及办理状态以实际平台信息为准；本地商品由社区工作人员跟进，不在本页付款。</p>
      </div>
    </div>
  )
}
