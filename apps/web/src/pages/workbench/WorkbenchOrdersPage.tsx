import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { ChevronRight, ClipboardList, Plus } from 'lucide-react'
import type {
  CrmBusinessType,
  CrmOrderSummary,
  CrmServiceOrderStatus,
} from '@sanchuang-dev/local-life-contracts'
import { useCrmApi, type OrderListFilters } from '../../hooks/useCrmApi'
import { useStaffSession } from '../../hooks/useStaffSession'
import { StaffGate, StaffIdentityCard } from '../../components/crm/StaffGate'
import { FilterChipRow } from '../../components/crm/FilterChips'
import {
  CrmBadge,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  StatusNotice,
  TextLink,
  secondaryButtonClassName,
} from '../../components/crm/WorkbenchUi'
import {
  businessTypeLabels,
  businessTypeOptions,
  formatCrmDateTime,
  orderStatusDescriptions,
  orderStatusLabels,
  orderStatusOptions,
} from '../../components/crm/crmLabels'

const PAGE_SIZE = 20
const businessValues = businessTypeOptions.map((option) => option.value)
const orderStatusValues = orderStatusOptions.map((option) => option.value)

function readBusinessType(value: string | null): CrmBusinessType | undefined {
  return value && (businessValues as string[]).includes(value)
    ? (value as CrmBusinessType)
    : undefined
}

function readOrderStatus(value: string | null): CrmServiceOrderStatus | undefined {
  return value && (orderStatusValues as string[]).includes(value)
    ? (value as CrmServiceOrderStatus)
    : undefined
}

function orderTone(status: CrmServiceOrderStatus) {
  if (status === 'confirmed') return 'mint' as const
  if (status === 'failed') return 'rose' as const
  if (status === 'processing' || status === 'pending_verification') return 'amber' as const
  if (status === 'cancelled') return 'slate' as const
  return 'slate' as const
}

function OrderCard({ order, from }: { order: CrmOrderSummary; from: string }) {
  return (
    <Link
      to={`/workbench/orders/${order.id}`}
      state={{ from }}
      className="block rounded-2xl border border-slate-100 bg-white p-4 shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#fff3e6] text-[#c6925c]"
          aria-hidden="true"
        >
          <ClipboardList size={20} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-[15px] font-semibold text-slate-800">{order.orderNo}</p>
            <CrmBadge tone={orderTone(order.status)}>{orderStatusLabels[order.status]}</CrmBadge>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {businessTypeLabels[order.businessType]} · {order.customerName} ·{' '}
            {order.contactPhoneMasked}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">
            {order.community.name} · 归属 {order.attributedStaff.displayName ?? '网格员'}
          </p>
          <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-slate-400">
            <span>
              创建 {formatCrmDateTime(order.createdAt)}
              {order.confirmedAt ? ` · 核验 ${formatCrmDateTime(order.confirmedAt)}` : ''}
            </span>
            <ChevronRight size={15} className="shrink-0 text-slate-300" aria-hidden="true" />
          </div>
          <p className="mt-1 text-[10px] leading-4 text-slate-400">
            {orderStatusDescriptions[order.status]}
          </p>
        </div>
      </div>
    </Link>
  )
}

function OrdersView() {
  const api = useCrmApi()
  const { session } = useStaffSession()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()

  const status = readOrderStatus(searchParams.get('status'))
  const businessType = readBusinessType(searchParams.get('businessType'))
  const communityParam = searchParams.get('communityId')
  const communities = session?.staff.communities ?? []
  const communityId =
    communityParam && communities.some((item) => item.id === communityParam)
      ? communityParam
      : undefined

  const [items, setItems] = useState<CrmOrderSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [viewState, setViewState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const requestVersion = useRef(0)

  const filters: OrderListFilters = { status, businessType, communityId }
  const filterKey = `${status ?? ''}|${businessType ?? ''}|${communityId ?? ''}|${reloadToken}`
  const from = `${location.pathname}${location.search}`

  useEffect(() => {
    const version = ++requestVersion.current
    const controller = new AbortController()
    setViewState('loading')
    setError(null)
    setLoadMoreError(null)

    api
      .listOrders(filters, 1, PAGE_SIZE, controller.signal)
      .then((response) => {
        if (version !== requestVersion.current) return
        setItems(response.items)
        setTotal(response.total)
        setPage(1)
        setViewState(response.items.length === 0 ? 'empty' : 'ready')
      })
      .catch((cause: unknown) => {
        if (version !== requestVersion.current || controller.signal.aborted) return
        setError(cause instanceof Error ? cause.message : '暂时无法获取业务单')
        setViewState('error')
      })

    return () => controller.abort()
    // `filters` is represented by its primitive filterKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filterKey])

  const updateFilter = useCallback(
    (key: 'status' | 'businessType' | 'communityId', value: string) => {
      const next = new URLSearchParams(searchParams)
      if (value) next.set(key, value)
      else next.delete(key)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const clearFilters = () => setSearchParams(new URLSearchParams(), { replace: true })

  const loadMore = async () => {
    if (loadingMore || items.length >= total) return
    setLoadingMore(true)
    setLoadMoreError(null)
    try {
      const nextPage = page + 1
      const response = await api.listOrders(filters, nextPage, PAGE_SIZE)
      setItems((previous) => [...previous, ...response.items])
      setTotal(response.total)
      setPage(nextPage)
    } catch (cause) {
      setLoadMoreError(cause instanceof Error ? cause.message : '加载更多失败')
    } finally {
      setLoadingMore(false)
    }
  }

  const hasFilters = Boolean(status || businessType || communityId)

  return (
    <div className="px-4 pb-7 pt-4">
      <StaffIdentityCard />

      <div className="mt-4 flex items-center justify-between gap-2">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-slate-900">我的受理单</h1>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {viewState === 'ready' || viewState === 'empty' ? `共 ${total} 条` : '正在读取…'}
          </p>
        </div>
        <Link
          to="/workbench/leads"
          className="inline-flex min-h-10 items-center gap-1 rounded-full bg-[#138b79] px-3.5 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <Plus size={15} aria-hidden="true" />
          从线索创建
        </Link>
      </div>

      <p className="mt-2 rounded-xl bg-[#fff7ec] px-3.5 py-2.5 text-[11px] leading-5 text-[#8a6132]">
        “待运营核验”不等于成交；只有运营人员人工核验后才会显示“有效成交（人工核验）”，也不代表运营商侧已完成业务处理。
      </p>

      <div className="mt-4 space-y-3">
        <FilterChipRow
          label="受理状态"
          options={orderStatusOptions}
          value={status ?? ''}
          onChange={(value) => updateFilter('status', value)}
        />
        <FilterChipRow
          label="业务类型"
          options={businessTypeOptions}
          value={businessType ?? ''}
          onChange={(value) => updateFilter('businessType', value)}
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
            onClick={clearFilters}
            className="inline-flex min-h-10 items-center rounded-full px-1 text-[11px] font-medium text-slate-400 underline underline-offset-2"
          >
            清除筛选
          </button>
        ) : null}
      </div>

      <div className="mt-3 space-y-3">
        {viewState === 'loading' ? <LoadingBlock label="正在加载我的受理单…" /> : null}

        {viewState === 'error' ? (
          <ErrorBlock message={error ?? '暂时无法获取业务单'} onRetry={() => setReloadToken((n) => n + 1)} />
        ) : null}

        {viewState === 'empty' ? (
          hasFilters ? (
            <EmptyBlock
              title="当前筛选下没有受理单"
              description="可以更换状态或业务类型筛选，或清除筛选查看全部本人受理单。"
              actionLabel="清除筛选"
              onAction={clearFilters}
            />
          ) : (
            <EmptyBlock
              title="还没有广电业务受理单"
              description="先在线索详情中登记受理单号与脱敏凭据引用；创建后进入“已提交受理”，等待运营核验。"
              actionLabel="前往我的线索"
              actionTo="/workbench/leads"
            />
          )
        ) : null}

        {viewState === 'ready'
          ? items.map((order) => <OrderCard key={order.id} order={order} from={from} />)
          : null}
      </div>

      {viewState === 'ready' && items.length < total ? (
        <div className="mt-4">
          {loadMoreError ? (
            <div className="mb-2">
              <StatusNotice tone="error">{loadMoreError}</StatusNotice>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className={`${secondaryButtonClassName} w-full`}
          >
            {loadingMore ? '加载中…' : `加载更多（已显示 ${items.length}/${total}）`}
          </button>
        </div>
      ) : null}

      {viewState === 'ready' && items.length >= total && items.length > 0 ? (
        <p className="mt-4 text-center text-[11px] text-slate-400">已显示全部 {total} 条受理单</p>
      ) : null}

      <div className="mt-5">
        <TextLink to="/workbench/leads">返回我的线索</TextLink>
      </div>
      <div>
        <TextLink to="/workbench/verify">前往现场核验核销</TextLink>
      </div>
    </div>
  )
}

export function WorkbenchOrdersPage() {
  return (
    <StaffGate>
      <OrdersView />
    </StaffGate>
  )
}
