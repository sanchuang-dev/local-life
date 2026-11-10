import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ClipboardList, RefreshCw } from 'lucide-react'
import type { LocalOrderStatus, LocalOrderSummary } from '@sanchuang-dev/local-life-contracts'
import { PageHeader } from '../components/PageHeader'
import { FilterChipRow } from '../components/crm/FilterChips'
import {
  formatLocalDateTime,
  formatLocalPriceCents,
  localOrderStatusDescriptions,
  localOrderStatusLabels,
  localOrderStatusOrder,
  localOrderStatusTone,
} from '../components/life/localOrderLabels'
import { useBackTarget } from '../hooks/useBackTarget'
import { useMyLocalOrders } from '../hooks/useLocalOrders'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { buildResidentLoginHref } from '../components/auth/residentLogin'

const toneStyles = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  amber: 'bg-[#fff3e6] text-[#a96b2f]',
  rose: 'bg-rose-50 text-rose-600',
  slate: 'bg-slate-100 text-slate-500',
  teal: 'bg-teal-50 text-teal-700',
} as const

const statusOptions = localOrderStatusOrder.map((status) => ({
  value: status,
  label: localOrderStatusLabels[status],
}))

function OrderRow({ order, from }: { order: LocalOrderSummary; from: string }) {
  const tone = localOrderStatusTone(order.status)
  return (
    <li>
      <Link
        to={`/me/orders/${order.id}`}
        state={{ from }}
        className="block rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
      >
        <div className="flex items-start gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#eef7f2] text-[#388b77]"
            aria-hidden="true"
          >
            <ClipboardList size={20} strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate text-[14px] font-semibold text-slate-800">
                {order.snapshot.productName}
              </p>
              <span
                className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${toneStyles[tone]}`}
              >
                {localOrderStatusLabels[order.status]}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {order.community.name} · 登记 {formatLocalDateTime(order.createdAt)}
            </p>
            <p className="mt-1 break-words text-[12px] leading-5 text-slate-500">
              {order.snapshot.quantity} 件 × {formatLocalPriceCents(order.snapshot.unitPriceCents)}
              <span className="ml-1.5 font-semibold text-[#8a6132]">
                合计 {formatLocalPriceCents(order.snapshot.totalCents)}
              </span>
            </p>
            <p className="mt-1 break-words text-[10px] leading-4 text-slate-400">
              {localOrderStatusDescriptions[order.status]}
            </p>
          </div>
        </div>
      </Link>
    </li>
  )
}

/**
 * `/me/orders` — 「我的」订单列表.
 *
 * Real own orders only: the endpoint is scoped to the session server-side and the
 * hook never sends a resident id. Four explicit states (loading / unauthenticated
 * / error / empty-or-ready) and a real refresh, so the page never shows a stale
 * list or a demo order.
 */
export function MyOrdersPage() {
  const { backTo, backLabel } = useBackTarget('/me', '返回我的')
  const auth = useResidentAuth()
  const [status, setStatus] = useState<LocalOrderStatus | ''>('')
  const { state, reload, loadMore, loadingMore, loadMoreError } = useMyLocalOrders({
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
    status: status === '' ? undefined : status,
  })

  const from = '/me/orders'
  const statusFilter = useMemo(
    () => !status && state.status === 'ready' ? state.items.length : null,
    [status, state],
  )

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={ClipboardList}
        title="我的订单"
        subtitle="本地商品 · 办理意向登记 · 处理进度"
      />

      <section
        className="mt-4 rounded-[18px] border border-teal-200/70 bg-[#eef7f2] px-3.5 py-3"
        aria-label="订单说明"
      >
        <p className="text-[12px] font-bold text-[#225c4c]">商品办理登记</p>
        <p className="mt-1 text-[11px] leading-[1.7] text-[#52786c]">
          这里记录的是办理意向，不代表已付款或办理完成。
        </p>
      </section>

      <div className="mt-4">
        <FilterChipRow
          label="订单状态"
          value={status}
          options={statusOptions}
          onChange={(value) => setStatus(value as LocalOrderStatus | '')}
          allLabel={statusFilter === null ? '全部' : `全部 ${statusFilter}`}
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-[11px] text-slate-400">
          {state.status === 'ready'
            ? `共 ${state.total} 条订单`
            : state.status === 'empty'
              ? '暂无订单'
              : '正在读取…'}
        </p>
        <button
          type="button"
          onClick={reload}
          className="inline-flex min-h-10 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-slate-500"
        >
          <RefreshCw size={13} aria-hidden="true" />
          刷新
        </button>
      </div>

      {state.status === 'loading' ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-4 flex items-center justify-center gap-2 text-[12px] font-medium text-slate-500"
        >
          <span
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-teal-700/25 border-t-teal-700"
            aria-hidden="true"
          />
          正在读取我的订单…
        </p>
      ) : null}

      {state.status === 'unauthenticated' ? (
        <section className="mt-4 rounded-[18px] bg-white p-4">
          <p className="text-[13px] font-medium text-slate-700">登录状态已失效，请重新登录。</p>
          <Link to={buildResidentLoginHref('/me/orders', { activityId: null, inviteCode: null, inviteInvalid: false })}
            className="mt-3 inline-flex min-h-[44px] items-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white">
            前往统一登录
          </Link>
        </section>
      ) : null}

      {state.status === 'error' ? (
        <section className="mt-4 rounded-[18px] border border-rose-100 bg-white p-4 shadow-sm">
          <p className="text-[13px] font-bold text-rose-700">我的订单读取失败</p>
          <p className="mt-1 break-words text-[12px] leading-5 text-slate-500">{state.message}</p>
          <button
            type="button"
            onClick={reload}
            className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white"
          >
            <RefreshCw size={14} aria-hidden="true" />
            重新读取
          </button>
        </section>
      ) : null}

      {state.status === 'empty' ? (
        <section className="mt-4 rounded-[18px] border border-dashed border-slate-200 bg-white px-5 py-8 text-center">
          <p className="text-[14px] font-semibold text-slate-700">
            {status ? '当前筛选下没有订单' : '还没有登记过订单'}
          </p>
          <p className="mx-auto mt-1.5 max-w-[280px] text-[12px] leading-5 text-slate-400">
            {status
              ? '可以切换订单状态筛选，或选择「全部」查看已登记的全部订单。'
              : '在「惠生活」的商品详情页可以登记订单、提交办理意向。'}
          </p>
          {status ? (
            <button
              type="button"
              onClick={() => setStatus('')}
              className="mt-3 inline-flex min-h-[44px] items-center rounded-xl border border-slate-200 px-4 text-[13px] font-semibold text-slate-600"
            >
              查看全部订单
            </button>
          ) : (
            <Link
              to="/life"
              state={{ from }}
              className="mt-3 inline-flex min-h-[44px] items-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white"
            >
              去惠生活看看本地商品
            </Link>
          )}
        </section>
      ) : null}

      {state.status === 'ready' ? (
        <>
          <ul className="mt-3 space-y-3">
            {state.items.map((order) => (
              <OrderRow key={order.id} order={order} from={from} />
            ))}
          </ul>

          {loadMoreError ? (
            <p role="alert" className="mt-3 break-words text-[11px] leading-5 text-rose-600">
              {loadMoreError}
            </p>
          ) : null}

          {state.hasMore ? (
            <button
              type="button"
              disabled={loadingMore}
              onClick={loadMore}
              className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl border border-slate-200 text-[13px] font-semibold text-slate-600 disabled:opacity-60"
            >
              {loadingMore
                ? '加载中…'
                : `加载更多（已显示 ${state.items.length}/${state.total}）`}
            </button>
          ) : (
            <p className="mt-4 text-center text-[11px] text-slate-400">
              已显示全部 {state.items.length} 条订单
            </p>
          )}
        </>
      ) : null}
    </div>
  )
}
