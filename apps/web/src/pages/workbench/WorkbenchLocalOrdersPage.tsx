import { useCallback, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { ChevronRight, PackageSearch, RefreshCw } from 'lucide-react'
import type { LocalOrderStatus } from '@sanchuang-dev/local-life-contracts'
import { StaffGate, StaffIdentityCard } from '../../components/crm/StaffGate'
import { FilterChipRow } from '../../components/crm/FilterChips'
import {
  CrmBadge,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  StatusNotice,
} from '../../components/crm/WorkbenchUi'
import {
  formatLocalDateTime,
  formatLocalPriceCents,
  localOrderStatusDescriptions,
  localOrderStatusLabels,
  localOrderStatusOrder,
  localOrderStatusTone,
} from '../../components/life/localOrderLabels'
import { useStaffSession } from '../../hooks/useStaffSession'
import { useStaffLocalOrders } from '../../hooks/useStaffLocalOrders'

const statusValues = localOrderStatusOrder as string[]

function readStatus(value: string | null): LocalOrderStatus | undefined {
  return value && statusValues.includes(value) ? (value as LocalOrderStatus) : undefined
}

/**
 * `/workbench/local-orders` — the 网格员工作台 view of local order registrations.
 *
 * It reads `/staff/local-orders`, the route that accepts all three staff roles and
 * scopes results by the session's assigned communities. The page therefore only
 * ever shows orders the signed-in worker is authorized to handle: there is no
 * community picker that could widen the scope, and a 401/403 is shown as a real
 * permission state instead of an empty list.
 */
function LocalOrdersView() {
  const { session } = useStaffSession()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [reloadToken, setReloadToken] = useState(0)

  const status = readStatus(searchParams.get('status'))
  const communities = session?.staff.communities ?? []
  const communityParam = searchParams.get('communityId')
  const communityId =
    communityParam && communities.some((item) => item.id === communityParam)
      ? communityParam
      : undefined

  const { state, reload, loadMore, loadingMore, loadMoreError } = useStaffLocalOrders({
    enabled: Boolean(session),
    communityId,
    status,
  })

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1)
    reload()
  }, [reload])

  const from = `${location.pathname}${location.search}`

  const updateFilter = (key: 'status' | 'communityId', value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value)
    else next.delete(key)
    setSearchParams(next, { replace: true })
  }

  const hasFilters = Boolean(status || communityId)

  return (
    <div className="px-4 pb-7 pt-4" key={reloadToken}>
      <StaffIdentityCard />

      <div className="mt-4 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight text-slate-900">社区订单</h1>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {state.status === 'ready'
              ? `共 ${state.total} 条`
              : state.status === 'empty'
                ? '暂无订单'
                : '正在读取…'}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex min-h-10 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-slate-500"
        >
          <RefreshCw size={13} aria-hidden="true" />
          刷新
        </button>
      </div>

      <p className="mt-2 rounded-xl bg-[#fff7ec] px-3.5 py-2.5 text-[11px] leading-5 text-[#8a6132]">
        仅显示你负责社区的登记订单。人工核验由运营人员完成。
      </p>

      <div className="mt-4 space-y-3">
        <FilterChipRow
          label="订单状态"
          options={localOrderStatusOrder.map((value) => ({
            value,
            label: localOrderStatusLabels[value],
          }))}
          value={status ?? ''}
          onChange={(value) => updateFilter('status', value)}
        />
        {communities.length > 1 ? (
          <FilterChipRow
            label="社区"
            options={communities.map((item) => ({ value: item.id, label: item.name }))}
            value={communityId ?? ''}
            onChange={(value) => updateFilter('communityId', value)}
          />
        ) : null}
        {hasFilters ? (
          <button
            type="button"
            onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}
            className="inline-flex min-h-10 items-center rounded-full px-1 text-[11px] font-medium text-slate-400 underline underline-offset-2"
          >
            清除筛选
          </button>
        ) : null}
      </div>

      <div className="mt-3 space-y-3">
        {state.status === 'loading' ? <LoadingBlock label="正在读取社区订单…" /> : null}

        {state.status === 'error' ? (
          state.forbidden ? (
            <section
              role="alert"
              className="rounded-2xl border border-rose-100 bg-white px-4 py-4 shadow-sm"
            >
              <p className="text-[14px] font-semibold text-rose-700">没有权限查看社区订单</p>
              <p className="mt-1 break-words text-[12px] leading-5 text-slate-500">
                {state.message}
              </p>
              <p className="mt-1 text-[11px] leading-5 text-slate-400">
                只能处理管理员分配给该账号的社区订单；如需调整授权社区，请联系社区运营负责人。
              </p>
            </section>
          ) : (
            <ErrorBlock message={state.message} onRetry={refresh} />
          )
        ) : null}

        {state.status === 'empty' ? (
          hasFilters ? (
            <EmptyBlock
              title="当前筛选下没有订单"
              description="可以更换订单状态或社区筛选，或清除筛选查看授权社区内的全部订单。"
              actionLabel="清除筛选"
              onAction={() => setSearchParams(new URLSearchParams(), { replace: true })}
            />
          ) : (
            <EmptyBlock
              title="授权社区内还没有登记订单"
              description="居民在「惠生活」登记订单后会出现在这里。工作台不会补造订单或显示其他社区的订单。"
              actionLabel="刷新"
              onAction={refresh}
            />
          )
        ) : null}

        {state.status === 'ready'
          ? state.items.map((order) => (
              <Link
                key={order.id}
                to={`/workbench/local-orders/${order.id}`}
                state={{ from }}
                className="block rounded-2xl border border-slate-100 bg-white p-4 shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                <div className="flex items-start gap-3">
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#eef7f2] text-[#388b77]"
                    aria-hidden="true"
                  >
                    <PackageSearch size={20} strokeWidth={1.8} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate text-[14px] font-semibold text-slate-800">
                        {order.snapshot.productName}
                      </p>
                      <CrmBadge tone={localOrderStatusTone(order.status)}>
                        {localOrderStatusLabels[order.status]}
                      </CrmBadge>
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      {order.community.name} ·{' '}
                      {order.resident.displayName ?? '未命名居民'} · 登记{' '}
                      {formatLocalDateTime(order.createdAt)}
                    </p>
                    <p className="mt-1 text-[12px] leading-5 text-slate-500">
                      {order.snapshot.quantity} 件 ×{' '}
                      {formatLocalPriceCents(order.snapshot.unitPriceCents)}
                      <span className="ml-1.5 font-semibold text-[#8a6132]">
                        合计 {formatLocalPriceCents(order.snapshot.totalCents)}
                      </span>
                    </p>
                    <div className="mt-1.5 flex items-start justify-between gap-2">
                      <p className="min-w-0 break-words text-[10px] leading-4 text-slate-400">
                        {localOrderStatusDescriptions[order.status]}
                      </p>
                      <ChevronRight
                        size={15}
                        className="mt-0.5 shrink-0 text-slate-300"
                        aria-hidden="true"
                      />
                    </div>
                  </div>
                </div>
              </Link>
            ))
          : null}
      </div>

      {state.status === 'ready' ? (
        <>
          {loadMoreError ? (
            <div className="mt-3">
              <StatusNotice tone="error">{loadMoreError}</StatusNotice>
            </div>
          ) : null}
          {state.hasMore ? (
            <button
              type="button"
              disabled={loadingMore}
              onClick={loadMore}
              className="mt-4 flex min-h-[44px] w-full items-center justify-center rounded-xl border border-slate-200 bg-white text-[13px] font-semibold text-slate-600 disabled:opacity-60"
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

      <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1">
        <Link
          to="/workbench/leads"
          className="inline-flex min-h-11 items-center text-[12px] font-semibold text-teal-700"
        >
          返回我的线索
        </Link>
        <Link
          to="/workbench/orders"
          className="inline-flex min-h-11 items-center text-[12px] font-semibold text-teal-700"
        >
          广电业务受理单
        </Link>
      </div>
    </div>
  )
}

export function WorkbenchLocalOrdersPage() {
  return (
    <StaffGate>
      <LocalOrdersView />
    </StaffGate>
  )
}
