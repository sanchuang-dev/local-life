import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { ChevronRight, ClipboardList, Phone, Plus, UserRoundCheck } from 'lucide-react'
import type { CrmLeadSourceType, CrmLeadStatus, CrmLeadSummary } from '@sanchuang-dev/local-life-contracts'
import { useCrmApi, type LeadListFilters } from '../../hooks/useCrmApi'
import { useStaffSession } from '../../hooks/useStaffSession'
import { StaffGate, StaffIdentityCard } from '../../components/crm/StaffGate'
import { FilterChipRow } from '../../components/crm/FilterChips'
import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  StatusNotice,
  CrmBadge,
  TextLink,
  secondaryButtonClassName,
} from '../../components/crm/WorkbenchUi'
import {
  formatCrmDateTime,
  isNextContactOverdue,
  leadSourceLabels,
  leadSourceOptions,
  leadStatusDescriptions,
  leadStatusLabels,
  leadStatusOptions,
  nextContactLabel,
} from '../../components/crm/crmLabels'

const PAGE_SIZE = 20

const statusValues = leadStatusOptions.map((option) => option.value)
const sourceValues = leadSourceOptions.map((option) => option.value)

function readStatus(value: string | null): CrmLeadStatus | undefined {
  return value && (statusValues as string[]).includes(value) ? (value as CrmLeadStatus) : undefined
}

function readSource(value: string | null): CrmLeadSourceType | undefined {
  return value && (sourceValues as string[]).includes(value)
    ? (value as CrmLeadSourceType)
    : undefined
}

function statusTone(status: CrmLeadStatus) {
  if (status === 'converted') return 'mint' as const
  if (status === 'invalid') return 'rose' as const
  if (status === 'contacting') return 'amber' as const
  return 'slate' as const
}

function LeadCard({ lead, from }: { lead: CrmLeadSummary; from: string }) {
  const overdue = isNextContactOverdue(lead.nextContactAt)

  return (
    <Link
      to={`/workbench/leads/${lead.id}`}
      state={{ from }}
      className="block rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#e8f6f0] text-[#388b77]"
          aria-hidden="true"
        >
          <UserRoundCheck size={20} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-[15px] font-semibold text-slate-800">{lead.contactName}</p>
            <CrmBadge tone={statusTone(lead.status)}>{leadStatusLabels[lead.status]}</CrmBadge>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {lead.community.name} · {leadSourceLabels[lead.sourceType]}
            {lead.sourceActivity ? ` · ${lead.sourceActivity.title}` : ''}
            {lead.promotionStaff
              ? ` · 推广：${lead.promotionStaff.displayName ?? '网格员'}`
              : ''}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">{lead.contactPhoneMasked}</p>

          <div
            className={`mt-2.5 flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] ${
              overdue ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-500'
            }`}
          >
            <Phone size={12} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{nextContactLabel(lead.nextContactAt)}</span>
            {overdue ? <span className="shrink-0 font-semibold">需尽快联系</span> : null}
          </div>

          <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-slate-400">
            <span>
              跟进 {lead.followUpCount} 次
              {lead.lastContactedAt ? ` · 最近 ${formatCrmDateTime(lead.lastContactedAt)}` : ' · 尚未跟进'}
            </span>
            <ChevronRight size={15} className="shrink-0 text-slate-300" aria-hidden="true" />
          </div>
          <p className="sr-only">{leadStatusDescriptions[lead.status]}</p>
        </div>
      </div>
    </Link>
  )
}

function LeadsView() {
  const api = useCrmApi()
  const { session } = useStaffSession()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()

  const status = readStatus(searchParams.get('status'))
  const sourceType = readSource(searchParams.get('sourceType'))
  const communityParam = searchParams.get('communityId')
  const communities = session?.staff.communities ?? []
  const communityId =
    communityParam && communities.some((item) => item.id === communityParam)
      ? communityParam
      : undefined

  const [items, setItems] = useState<CrmLeadSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [viewState, setViewState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const requestVersion = useRef(0)

  const filters: LeadListFilters = { status, sourceType, communityId }
  const filterKey = `${status ?? ''}|${sourceType ?? ''}|${communityId ?? ''}|${reloadToken}`
  const from = `${location.pathname}${location.search}`

  useEffect(() => {
    const version = ++requestVersion.current
    const controller = new AbortController()
    setViewState('loading')
    setError(null)
    setLoadMoreError(null)

    api
      .listLeads(filters, 1, PAGE_SIZE, controller.signal)
      .then((response) => {
        if (version !== requestVersion.current) return
        setItems(response.items)
        setTotal(response.total)
        setPage(1)
        setViewState(response.items.length === 0 ? 'empty' : 'ready')
      })
      .catch((cause: unknown) => {
        if (version !== requestVersion.current || controller.signal.aborted) return
        setError(cause instanceof Error ? cause.message : '暂时无法获取线索')
        setViewState('error')
      })

    return () => controller.abort()
    // `filters` is intentionally represented by its primitive filterKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, filterKey])

  const updateFilter = useCallback(
    (key: 'status' | 'sourceType' | 'communityId', value: string) => {
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
      const response = await api.listLeads(filters, nextPage, PAGE_SIZE)
      setItems((previous) => [...previous, ...response.items])
      setTotal(response.total)
      setPage(nextPage)
    } catch (cause) {
      setLoadMoreError(cause instanceof Error ? cause.message : '加载更多失败')
    } finally {
      setLoadingMore(false)
    }
  }

  const hasFilters = Boolean(status || sourceType || communityId)

  return (
    <div className="px-4 pb-7 pt-4">
      <StaffIdentityCard />

      <div className="mt-4 flex items-center justify-between gap-2 rounded-[16px] bg-[#eef7f2] px-3.5 py-2.5">
        <p className="min-w-0 text-[12px] leading-5 text-[#52786c]">
          只显示服务端授权社区内、你有权处理的线索。
        </p>
        <Link
          to="/workbench/orders"
          className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-full bg-white px-3 text-[11px] font-semibold text-teal-700"
        >
          <ClipboardList size={13} aria-hidden="true" />
          受理单
        </Link>
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-slate-900">我的线索</h1>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {viewState === 'ready' || viewState === 'empty' ? `共 ${total} 条` : '正在读取…'}
          </p>
        </div>
        <Link
          to="/workbench/leads/new"
          state={{ from }}
          className="inline-flex min-h-10 items-center gap-1 rounded-full bg-[#138b79] px-3.5 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <Plus size={15} aria-hidden="true" />
          登记线索
        </Link>
      </div>

      <div className="mt-4 space-y-3">
        <FilterChipRow
          label="线索状态"
          options={leadStatusOptions}
          value={status ?? ''}
          onChange={(value) => updateFilter('status', value)}
        />
        <FilterChipRow
          label="线索来源"
          options={leadSourceOptions}
          value={sourceType ?? ''}
          onChange={(value) => updateFilter('sourceType', value)}
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
        {viewState === 'loading' ? <LoadingBlock label="正在加载我的线索…" /> : null}

        {viewState === 'error' ? (
          <ErrorBlock message={error ?? '暂时无法获取线索'} onRetry={() => setReloadToken((n) => n + 1)} />
        ) : null}

        {viewState === 'empty' ? (
          hasFilters ? (
            <EmptyBlock
              title="当前筛选下没有线索"
              description="可以更换状态或来源筛选，或清除筛选查看全部本人线索。"
              actionLabel="清除筛选"
              onAction={clearFilters}
            />
          ) : (
            <EmptyBlock
              title="还没有线索"
              description="登记第一条经居民明确告知的线索后，就可以开始跟进并创建广电业务受理单。"
              actionLabel="登记新线索"
              actionTo="/workbench/leads/new"
              actionState={{ from }}
            />
          )
        ) : null}

        {viewState === 'ready'
          ? items.map((lead) => <LeadCard key={lead.id} lead={lead} from={from} />)
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
        <p className="mt-4 text-center text-[11px] text-slate-400">已显示全部 {total} 条线索</p>
      ) : null}

      <div className="mt-5">
        <TextLink to="/workbench/orders">查看我的广电业务受理单</TextLink>
      </div>
    </div>
  )
}

export function WorkbenchLeadsPage() {
  return (
    <StaffGate>
      <LeadsView />
    </StaffGate>
  )
}
