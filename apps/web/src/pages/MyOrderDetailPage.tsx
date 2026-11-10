import { Link, useParams } from 'react-router'
import { AlertTriangle, ClipboardList, Clock, RefreshCw } from 'lucide-react'
import type { LocalOrderDetail, LocalOrderEvent } from '@sanchuang-dev/local-life-contracts'
import { PageHeader } from '../components/PageHeader'
import {
  formatLocalDateTime,
  formatLocalPriceCents,
  localOrderStatusDescriptions,
  localOrderStatusLabels,
  localOrderStatusTone,
} from '../components/life/localOrderLabels'
import { useBackTarget } from '../hooks/useBackTarget'
import { useMyLocalOrder } from '../hooks/useLocalOrders'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { buildResidentLoginHref } from '../components/auth/residentLogin'

const eventLabels: Record<LocalOrderEvent['event'], string> = {
  'order.registered': '登记订单',
  'order.created_on_behalf': '工作人员代录',
  'order.status_changed': '处理状态变更',
  'order.verified': '运营人工核验通过',
  'order.rejected': '未通过',
}

function StatusPill({ order }: { order: LocalOrderDetail }) {
  const tone = localOrderStatusTone(order.status)
  const classes = {
    mint: 'bg-[#e8f6f0] text-[#388b77]',
    amber: 'bg-[#fff3e6] text-[#a96b2f]',
    rose: 'bg-rose-50 text-rose-600',
    slate: 'bg-slate-100 text-slate-500',
    teal: 'bg-teal-50 text-teal-700',
  }[tone]
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${classes}`}
    >
      {localOrderStatusLabels[order.status]}
    </span>
  )
}

function OrderDetailBody({ order }: { order: LocalOrderDetail }) {
  const facts = [
    { label: '商品', value: order.snapshot.productName },
    { label: '单价', value: formatLocalPriceCents(order.snapshot.unitPriceCents) },
    { label: '数量', value: `${order.snapshot.quantity} 件` },
    { label: '参考合计', value: formatLocalPriceCents(order.snapshot.totalCents) },
    { label: '社区', value: order.community.name },
    { label: '登记时间', value: formatLocalDateTime(order.createdAt) },
    { label: '最后更新', value: formatLocalDateTime(order.updatedAt) },
    {
      label: '登记方式',
      value: order.recordSource === 'resident' ? '居民自助登记' : '工作人员代录',
    },
  ]

  return (
    <>
      <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-slate-800">订单状态</h2>
          <StatusPill order={order} />
        </div>
        <p className="mt-2 break-words text-[12px] leading-5 text-slate-500">
          {localOrderStatusDescriptions[order.status]}
        </p>
        {order.statusNote ? (
          <p className="mt-2 break-words rounded-[12px] bg-[#fff7ec] px-3 py-2 text-[11px] leading-5 text-[#8a6132]">
            处理备注：{order.statusNote}
          </p>
        ) : null}
        <p className="mt-2 text-[11px] leading-5 text-slate-400">
          订单编号 {order.id.slice(0, 8)}…（完整编号仅用于工作人员核对）
        </p>
      </section>

      <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[15px] font-semibold text-slate-800">商品快照</h2>
        <p className="mt-1 text-[11px] leading-5 text-slate-400">
          快照在登记时冻结，商品后续改价或下架都不会改写这笔订单。
        </p>
        <dl className="mt-2 divide-y divide-slate-100 border-t border-slate-100">
          {facts.map(({ label, value }) => (
            <div key={label} className="flex items-start justify-between gap-3 py-2.5">
              <dt className="shrink-0 text-[12px] text-slate-400">{label}</dt>
              <dd className="min-w-0 break-words text-right text-[12px] font-medium leading-5 text-slate-600">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {order.note ? (
          <p className="mt-2 break-words rounded-[12px] bg-slate-50 px-3 py-2.5 text-[12px] leading-5 text-slate-500">
            我的备注：{order.note}
          </p>
        ) : null}
      </section>

      {order.verification ? (
        <section className="mt-4 rounded-[18px] border border-teal-200/70 bg-[#eef7f2] p-4">
          <h2 className="text-[15px] font-semibold text-[#225c4c]">运营人工核验</h2>
          <dl className="mt-2 space-y-1.5 text-[12px] leading-5 text-[#52786c]">
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0">核验人</dt>
              <dd className="min-w-0 break-words text-right font-medium">
                {order.verification.verifiedBy?.displayName ?? '运营人员'}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0">核验时间</dt>
              <dd className="text-right font-medium">
                {formatLocalDateTime(order.verification.verifiedAt)}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0">核验备注</dt>
              <dd className="min-w-0 break-words text-right font-medium">
                {order.verification.note}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] leading-5 text-[#52786c]">
            该结论只是运营人员对订单事实的人工确认，不代表已收款、已成交或业务已开通。
          </p>
        </section>
      ) : null}

      <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
        <h2 className="text-[15px] font-semibold text-slate-800">处理时间线</h2>
        <ol className="mt-2.5">
          {order.events.map((event) => (
            <li key={event.id} className="relative pb-4 pl-4 last:pb-0">
              <span
                className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-teal-500 ring-2 ring-white"
                aria-hidden="true"
              />
              <p className="text-[12px] font-semibold text-slate-700">
                {eventLabels[event.event]}
              </p>
              <p className="mt-0.5 text-[10px] text-slate-400">
                {formatLocalDateTime(event.createdAt)}
                {event.toStatus ? ` · ${localOrderStatusLabels[event.toStatus]}` : ''}
                {event.actor?.displayName ? ` · ${event.actor.displayName}` : ''}
              </p>
              {event.note ? (
                <p className="mt-1 break-words text-[11px] leading-5 text-slate-500">
                  {event.note}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </>
  )
}

/**
 * `/me/orders/:localOrderId` — one of the resident's own orders.
 *
 * Read-only on purpose: the contract has no resident cancel or edit route, so
 * this page offers none. A 404 (including another resident's order) is shown as
 * "订单不存在或无权查看" instead of implying the order might exist elsewhere.
 */
export function MyOrderDetailPage() {
  const { localOrderId } = useParams()
  const { backTo, backLabel } = useBackTarget('/me/orders', '返回我的订单')
  const auth = useResidentAuth()
  const { state, reload } = useMyLocalOrder({
    orderId: localOrderId ?? null,
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={ClipboardList}
        title="订单详情"
        subtitle="本地商品登记 · 处理进度"
      />

      {state.status === 'loading' ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-6 flex items-center justify-center gap-2 text-[12px] font-medium text-slate-500"
        >
          <Clock size={15} className="animate-pulse text-teal-600" aria-hidden="true" />
          正在读取订单详情…
        </p>
      ) : null}

      {state.status === 'unauthenticated' ? (
        <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
          <p className="text-[14px] font-bold text-slate-800">登录后查看订单详情</p>
          <p className="mt-1 text-[12px] leading-5 text-slate-500">
            订单绑定居民账户，登录后才能读取这笔订单。
          </p>
          <Link
            to={buildResidentLoginHref(
              `/me/orders/${encodeURIComponent(localOrderId ?? '')}`,
              { activityId: null, inviteCode: null, inviteInvalid: false },
            )}
            className="mt-3 inline-flex min-h-[44px] items-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white"
          >
            去登录
          </Link>
        </section>
      ) : null}

      {state.status === 'error' ? (
        <section
          role="alert"
          className="mt-4 rounded-[18px] border border-rose-100 bg-white px-4 py-4 shadow-sm"
        >
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-rose-700">
            <AlertTriangle size={15} className="shrink-0" aria-hidden="true" />
            {state.notFound ? '订单不存在或无权查看' : '订单详情读取失败'}
          </p>
          <p className="mt-1 break-words text-[12px] leading-5 text-slate-500">{state.message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {state.notFound ? null : (
              <button
                type="button"
                onClick={reload}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white"
              >
                <RefreshCw size={14} aria-hidden="true" />
                重新读取
              </button>
            )}
            <Link
              to="/me/orders"
              className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-200 px-4 text-[13px] font-semibold text-slate-600"
            >
              返回我的订单
            </Link>
          </div>
        </section>
      ) : null}

      {state.status === 'ready' ? (
        <>
          <OrderDetailBody order={state.order} />
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={reload}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-4 text-[13px] font-semibold text-slate-600"
            >
              <RefreshCw size={14} aria-hidden="true" />
              刷新状态
            </button>
            <Link
              to="/life"
              state={{ from: backTo }}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white"
            >
              继续逛惠生活
            </Link>
          </div>
        </>
      ) : null}
    </div>
  )
}
