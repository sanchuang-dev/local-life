import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Result,
  Row,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import {
  LEDGER_FACT_KINDS,
  type AdminCrmFilterOptionsResponse,
  type LedgerAnomaly,
  type LedgerEntry,
  type LedgerFactKind,
  type LedgerOverview,
  type LedgerSourceSystem,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import { DataPanel, type PanelFilter, type PanelQuery } from '../shared/components/DataPanel'
import type { DateRangeValue } from '../shared/components/DataPanel'
import { getAdminCrmFilterOptions } from '../services/crm'
import type { AuthenticatedSession } from '../services/auth'
import { describeLocalError, isLocalApiError } from '../services/localApi'
import {
  LEDGER_ANOMALY_KIND_LABELS,
  LEDGER_ANOMALY_SEVERITY_LABELS,
  LEDGER_ATTRIBUTION_BASIS_LABELS,
  LEDGER_ATTRIBUTION_STATE_LABELS,
  LEDGER_EVIDENCE_KIND_LABELS,
  LEDGER_FACT_KIND_LABELS,
  LEDGER_FACT_KIND_NOTES,
  LEDGER_RECONCILIATION_STATE_LABELS,
  LEDGER_SOURCE_SYSTEM_LABELS,
  SETTLEMENT_AMOUNT_STATUS_LABELS,
  formatCents,
  formatDateTime,
  getLedgerOverview,
  listLedgerAnomalies,
  listLedgerEntries,
  syncLedgerSourceFacts,
} from '../services/ledger'
import './ledger.css'

/**
 * 业绩看板 — the back-office view of the unified operating ledger (#64).
 *
 * Three rules shape this page, and every one of them is enforced by the contract
 * rather than by this file's good intentions:
 *
 * 1. **六类事实不合并。** `order_registered`（登记金额）, `order_verified`
 *    （已核验业绩）, `payment_received` / `payment_reversed`（人工实收 / 冲正）,
 *    `reward_cost` / `reward_reversed`（奖励成本 / 冲正）是四种不同的钱. 登记金额与
 *    已核验业绩常常描述同一笔业务，把它们相加只会得到一个没有业务含义的数字，
 *    所以本页**不展示「合计金额」**，只展示每一类的笔数与账面毛额。
 * 2. **没有结算规则就没有应付金额。** `amountStatus` 恒为 `pending_rule`，页面
 *    因此只写「待核定」，不计算应付、分账、打款或佣金——那些字段在契约里根本不存在。
 * 3. **数字只来自服务端聚合。** KPI 来自 `/admin/ledger/overview`，明细来自
 *    `/admin/ledger/entries` 的服务端分页；页面从不对当前这一页求和，也从不重排。
 *
 * 权限：`/admin/ledger/*` 拒绝网格员（服务端 403），所以网格员看到的是一个明确的
 * 无权限页，而不是一个空列表。运营员的社区范围由服务端裁剪，页面如实说明这一点。
 */

/** Structural shape of the option lists; only the fields rendered here are used. */
type CommunityRef = { id: string; name: string }
type StaffRef = { id: string; displayName: string | null; role: string }

interface LedgerFilters {
  /** Business-date range (`YYYY-MM-DD`), inclusive on both ends. */
  range?: DateRangeValue
  communityId?: string
  /** Attribution filter: the grid worker a fact belongs to, never the recorder. */
  staffId?: string
  factKind?: LedgerFactKind
  sourceSystem?: LedgerSourceSystem
  /** `'true'` = only entries with an unresolved anomaly; `undefined` = all. */
  anomalyOnly?: string
  keyword?: string
}

/** No server-side sort exists in the contract, so the panel gets no sort keys. */
type LedgerSortKey = never

const initialFilters: LedgerFilters = {
  range: undefined,
  communityId: undefined,
  staffId: undefined,
  factKind: undefined,
  sourceSystem: undefined,
  anomalyOnly: undefined,
  keyword: '',
}

const FACT_KIND_OPTIONS = LEDGER_FACT_KINDS.map((kind) => ({
  label: LEDGER_FACT_KIND_LABELS[kind],
  value: kind,
}))

const SOURCE_SYSTEM_OPTIONS = (
  ['local_order', 'crm_service_order', 'activity_reward_grant', 'manual'] as const
).map((system) => ({ label: LEDGER_SOURCE_SYSTEM_LABELS[system], value: system }))

/** Fact-kind tag colours: the four money kinds are never the same colour. */
const FACT_KIND_COLORS: Record<LedgerFactKind, string> = {
  order_registered: 'blue',
  order_verified: 'green',
  payment_received: 'gold',
  payment_reversed: 'volcano',
  reward_cost: 'purple',
  reward_reversed: 'magenta',
}

function listErrorTitle(error: Error | null): string {
  if (isLocalApiError(error)) {
    if (error.status === 401) return '登录状态已失效'
    if (error.status === 403) return '没有经营流水查看权限'
  }
  return '经营流水明细加载失败'
}

function overviewErrorTitle(error: Error | null): string {
  if (isLocalApiError(error)) {
    if (error.status === 401) return '登录状态已失效'
    if (error.status === 403) return '没有经营流水查看权限'
    if (error.status === 400) return '总览筛选条件不被支持'
  }
  return '经营总览加载失败'
}

export function PerformancePage() {
  const { session } = useAdminAuth()

  if (session.staff.role === 'grid_worker') {
    return (
      <div className="page">
        <PageHeader
          title="业绩看板"
          description="经营总览与流水明细仅对管理员与运营员开放。"
          status={<Tag>无权限</Tag>}
        />
        <div className="page-stack">
          <Result
            status="403"
            title="网格员没有后台业绩看板权限"
            subTitle="后台 /admin/ledger/* 拒绝网格员；即使直接访问该地址，服务端同样返回 403。你授权社区内的流水请通过移动端工作台查看。"
          />
        </div>
      </div>
    )
  }

  return <PerformanceConsole session={session} />
}

function PerformanceConsole({ session }: { session: AuthenticatedSession }) {
  const { message } = AntdApp.useApp()
  const isAdmin = session.staff.role === 'admin'
  const assigned = session.staff.communities

  /* --------------------------- filter option lists -------------------------- */

  const [communities, setCommunities] = useState<readonly CommunityRef[]>([])
  const [staff, setStaff] = useState<readonly StaffRef[]>([])
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [optionsToken, setOptionsToken] = useState(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setOptionsError(null)
    // The CRM filter-options endpoint is the one existing route that returns
    // communities *and* staff **already scoped by the server** for the caller's
    // role. The page must not build a permission list out of the session, so it
    // reuses that read instead of inventing a second one.
    getAdminCrmFilterOptions(controller.signal)
      .then((options: AdminCrmFilterOptionsResponse) => {
        if (!active) return
        setCommunities(options.communities)
        setStaff(options.staff)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setCommunities([])
        setStaff([])
        setOptionsError(describeLocalError(cause, '无法读取社区与网格员列表'))
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [optionsToken])

  /* ------------------------------- the query ------------------------------- */

  const [query, setQuery] = useState<PanelQuery<LedgerFilters, LedgerSortKey>>(() => ({
    filters: { ...initialFilters, communityId: isAdmin ? undefined : assigned[0]?.id },
    page: 1,
    pageSize: 20,
  }))

  /* ------------------------------- the report ------------------------------ */

  const [syncing, setSyncing] = useState(false)
  const [overview, setOverview] = useState<LedgerOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewError, setOverviewError] = useState<Error | null>(null)
  const [overviewToken, setOverviewToken] = useState(0)

  // The overview accepts only scope + time. Fact kind / source system / anomaly
  // flag / keyword narrow the *list*; the KPI block deliberately keeps reporting
  // the same population, and the note under it says so out loud.
  const reportFrom = query.filters.range?.start
  const reportTo = query.filters.range?.end
  const reportCommunityId = query.filters.communityId
  const reportStaffId = query.filters.staffId

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setOverviewLoading(true)
    setOverviewError(null)
    getLedgerOverview(
      {
        from: reportFrom,
        to: reportTo,
        communityId: reportCommunityId,
        staffId: reportStaffId,
      },
      controller.signal,
    )
      .then((result) => {
        if (active) setOverview(result)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setOverview(null)
        setOverviewError(cause instanceof Error ? cause : new Error('经营总览加载失败'))
      })
      .finally(() => {
        if (active) setOverviewLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [reportFrom, reportTo, reportCommunityId, reportStaffId, overviewToken])

  /* -------------------------------- the list ------------------------------- */

  const [rows, setRows] = useState<LedgerEntry[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<Error | null>(null)
  const [listToken, setListToken] = useState(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setListLoading(true)
    setListError(null)
    listLedgerEntries(
      {
        page: query.page,
        pageSize: query.pageSize,
        from: query.filters.range?.start,
        to: query.filters.range?.end,
        communityId: query.filters.communityId,
        staffId: query.filters.staffId,
        factKind: query.filters.factKind,
        sourceSystem: query.filters.sourceSystem,
        anomalyOnly: query.filters.anomalyOnly === 'true',
        keyword: query.filters.keyword?.trim() || undefined,
      },
      controller.signal,
    )
      .then((result) => {
        if (!active) return
        setRows(result.items)
        setTotal(result.total)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setRows([])
        setTotal(0)
        setListError(cause instanceof Error ? cause : new Error('经营流水明细加载失败'))
      })
      .finally(() => {
        if (active) setListLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [query, listToken])

  /* ------------------------------ the anomalies ---------------------------- */

  const [anomalies, setAnomalies] = useState<LedgerAnomaly[]>([])
  const [anomaliesError, setAnomaliesError] = useState<string | null>(null)
  const [anomaliesToken, setAnomaliesToken] = useState(0)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setAnomaliesError(null)
    listLedgerAnomalies(controller.signal)
      .then((items) => {
        if (active) setAnomalies(items)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setAnomalies([])
        setAnomaliesError(describeLocalError(cause, '无法读取未解决异常'))
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [anomaliesToken])

  const anomaliesByEntry = useMemo(() => {
    const grouped = new Map<string, LedgerAnomaly[]>()
    for (const anomaly of anomalies) {
      const list = grouped.get(anomaly.entryId)
      if (list) list.push(anomaly)
      else grouped.set(anomaly.entryId, [anomaly])
    }
    return grouped
  }, [anomalies])

  /* -------------------------------- the drawer ----------------------------- */

  const [entryOpen, setEntryOpen] = useState(false)
  const [entry, setEntry] = useState<LedgerEntry | null>(null)

  /* ------------------------------- lookups --------------------------------- */

  const communityName = (id: string | null | undefined): string => {
    if (!id) return '—'
    return communities.find((item) => item.id === id)?.name ?? `社区 ${id.slice(0, 8)}`
  }

  const staffName = (id: string | null | undefined): string => {
    if (!id) return '—'
    return staff.find((item) => item.id === id)?.displayName?.trim() || `网格员 ${id.slice(0, 8)}`
  }

  const communityOptions = useMemo(
    () => communities.map((item) => ({ label: item.name, value: item.id })),
    [communities],
  )

  const staffOptions = useMemo(
    () =>
      staff.map((item) => ({
        label: `${item.displayName?.trim() || item.id.slice(0, 8)}（${item.role === 'grid_worker' ? '网格员' : item.role === 'operator' ? '运营员' : '管理员'}）`,
        value: item.id,
      })),
    [staff],
  )

  /* ------------------------------- callbacks ------------------------------- */

  const refresh = () => {
    setListToken((value) => value + 1)
    setOverviewToken((value) => value + 1)
  }

  const syncSources = async () => {
    setSyncing(true)
    try {
      const result = await syncLedgerSourceFacts(session.csrfToken)
      refresh()
      setAnomaliesToken((value) => value + 1)
      message.success(`同步完成：新增 ${result.created} 条，已存在 ${result.skipped} 条（扫描 ${result.scanned} 条）。`)
    } catch (cause: unknown) {
      message.error(describeLocalError(cause, '同步来源事实失败'))
    } finally {
      setSyncing(false)
    }
  }

  const applyQuery = (next: PanelQuery<LedgerFilters, LedgerSortKey>): boolean => {
    const { range, communityId } = next.filters
    if (range?.start && range?.end && range.end < range.start) {
      message.error('结束日期不能早于开始日期。')
      return false
    }
    if (communityId && !isAdmin && !assigned.some((item) => item.id === communityId)) {
      message.error('只能查看管理员分配给当前账号的社区。')
      return false
    }
    setQuery(next)
    return true
  }

  const showOnlyAnomalies = () => {
    setQuery((current) => ({
      ...current,
      page: 1,
      filters: { ...current.filters, anomalyOnly: 'true' },
    }))
  }

  const openEntry = (row: LedgerEntry) => {
    setEntry(row)
    setEntryOpen(true)
  }

  const filterDefinitions: readonly PanelFilter<LedgerFilters>[] = [
    { key: 'range', label: '业务日期', kind: 'dateRange', format: 'YYYY-MM-DD' },
    { key: 'communityId', label: '社区', kind: 'select', options: communityOptions },
    { key: 'staffId', label: '业绩归属网格员', kind: 'select', options: staffOptions },
    { key: 'factKind', label: '事实类型', kind: 'select', options: FACT_KIND_OPTIONS },
    { key: 'sourceSystem', label: '来源系统', kind: 'select', options: SOURCE_SYSTEM_OPTIONS },
    {
      key: 'anomalyOnly',
      label: '未解决异常',
      kind: 'select',
      options: [{ label: '仅看有未解决异常的流水', value: 'true' }],
    },
    { key: 'keyword', label: '来源单号', kind: 'text', placeholder: '来源单号或事实标识' },
  ]

  const columns = [
    {
      key: 'fact',
      title: '事实',
      hideable: false,
      render: (_value: unknown, row: LedgerEntry) => (
        <Space orientation="vertical" size={2}>
          <Tag color={FACT_KIND_COLORS[row.factKind]}>{LEDGER_FACT_KIND_LABELS[row.factKind]}</Tag>
          <Typography.Text type="secondary" className="ledger-cell-mono">
            {row.sourceDisplayNo}
          </Typography.Text>
        </Space>
      ),
    },
    {
      key: 'amount',
      title: '账面毛额',
      render: (_value: unknown, row: LedgerEntry) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text strong>{formatCents(row.amountCents)}</Typography.Text>
          <Typography.Text type="secondary">
            {SETTLEMENT_AMOUNT_STATUS_LABELS[row.settlementAmountStatus]}
          </Typography.Text>
        </Space>
      ),
    },
    {
      key: 'source',
      title: '来源',
      render: (_value: unknown, row: LedgerEntry) => (
        <Space orientation="vertical" size={2}>
          <span>{LEDGER_SOURCE_SYSTEM_LABELS[row.sourceSystem]}</span>
          <Typography.Text type="secondary">
            {LEDGER_EVIDENCE_KIND_LABELS[row.evidence.kind]}
          </Typography.Text>
        </Space>
      ),
    },
    {
      key: 'community',
      title: '社区',
      render: (_value: unknown, row: LedgerEntry) => communityName(row.communityId),
    },
    {
      key: 'attribution',
      title: '业绩归属',
      render: (_value: unknown, row: LedgerEntry) => (
        <Space orientation="vertical" size={2}>
          {row.attribution.state === 'attributed' ? (
            <Tag color="green">
              {LEDGER_ATTRIBUTION_STATE_LABELS.attributed} · {staffName(row.attribution.staffId)}
            </Tag>
          ) : (
            <Tag color="orange">{LEDGER_ATTRIBUTION_STATE_LABELS.pending}</Tag>
          )}
          <Typography.Text type="secondary">
            {LEDGER_ATTRIBUTION_BASIS_LABELS[row.attribution.basis]}
          </Typography.Text>
        </Space>
      ),
    },
    {
      key: 'occurredAt',
      title: '业务时间',
      render: (_value: unknown, row: LedgerEntry) => (
        <Space orientation="vertical" size={2}>
          <span>{formatDateTime(row.occurredAt)}</span>
          <Typography.Text type="secondary">
            录入 {formatDateTime(row.createdAt)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      key: 'state',
      title: '对账状态',
      render: (_value: unknown, row: LedgerEntry) => (
        <Space orientation="vertical" size={2}>
          <span>{LEDGER_RECONCILIATION_STATE_LABELS[row.reconciliationState]}</span>
          {anomaliesByEntry.has(row.entryId) ? (
            <Tag color="red">
              未解决异常 {anomaliesByEntry.get(row.entryId)?.length ?? 0}
            </Tag>
          ) : null}
        </Space>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="业绩看板"
        description="统一经营流水的账面登记口径：登记金额、已核验业绩、人工实收与冲正、奖励成本与冲正分列呈现。本 MVP 没有结算规则，页面只报账面登记毛额，不计算应付、分账或打款。"
        status={<Tag color="green">真实数据</Tag>}
        extra={
          <Space wrap>
            <Button onClick={syncSources} loading={syncing}>同步来源事实</Button>
            <Button onClick={refresh} loading={listLoading || overviewLoading}>刷新</Button>
          </Space>
        }
      />

      <div className="page-stack">
        <Alert type="info" showIcon title="数据更新方式" description="经营台账读取已投影的真实订单、CRM 和奖励事实。来源发生变化后，请由运营人员点击「同步来源事实」再核对和锁定批次；当前不提供自动实时同步。" />
        {!isAdmin ? (
          <Alert
            type="info"
            showIcon
            title="运营员视图"
            description={
              assigned.length > 0
                ? `仅能查看管理员分配的社区（${assigned
                    .map((item) => item.name)
                    .join('、')}）流水；服务端同样按社区范围裁剪，前端筛选无法扩大可见范围。`
                : '当前账号尚未被分配社区，暂时无法查看流水，请联系管理员。'
            }
          />
        ) : null}

        {optionsError ? (
          <Alert
            type="warning"
            showIcon
            title="社区与网格员列表加载失败"
            description={optionsError}
            action={
              <Button size="small" onClick={() => setOptionsToken((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : null}

        {anomaliesError ? (
          <Alert
            type="warning"
            showIcon
            title="未解决异常清单加载失败"
            description={`${anomaliesError}（流水列表中的异常标记可能不完整，逐笔明细仍以服务端返回为准。）`}
            action={
              <Button size="small" onClick={() => setAnomaliesToken((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : null}

        {overviewError ? (
          <Alert
            type="error"
            showIcon
            title={overviewErrorTitle(overviewError)}
            description={overviewError.message}
            action={
              <Button size="small" onClick={() => setOverviewToken((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : (
          <LedgerReport
            overview={overview}
            loading={overviewLoading}
            onShowAnomalies={showOnlyAnomalies}
          />
        )}

        <div className="ledger-note" role="note" aria-label="口径说明">
          <Typography.Text strong>口径说明</Typography.Text>
          <ul>
            <li>
              上方总览只按<b>业务日期 / 社区 / 业绩归属网格员</b>汇总；事实类型、来源系统、
              未解决异常与来源单号只筛下方明细，不改变总览数字。
            </li>
            <li>
              六类事实不合并：登记金额与已核验业绩常常描述同一笔业务，相加没有业务含义，
              因此本页<b>不提供合计金额</b>，只报每类的笔数与账面毛额。
            </li>
            <li>
              人工实收只统计线下人工登记、且带凭据（收据 / 转账 / CRM 确认）的收款；本 MVP
              没有在线支付。冲正单独成行，不从实收里静默抵扣。
            </li>
            <li>
              归属只取来源事实上明确存在的归属；订单创建人或记录人不构成业绩归属，其余一律
              记为「待归属」，不计入任何人的业绩。
            </li>
            <li>
              <b>来源有效性</b>：本地订单取已登记订单，广电 CRM 只取<b>已核验</b>业务单，奖励
              成本取奖励履约事实，人工实收必须带凭据并记录登记人；四类来源各自成立，不互相
              背书，也不因金额相同就合并成一笔。
            </li>
            <li>
              活动维度筛选需服务端在 <code>ledgerListQuerySchema</code> 增加活动字段（来源{' '}
              <code>local_orders.source_activity_id</code>）后方可提供，当前未支持。
            </li>
          </ul>
        </div>

        <DataPanel<LedgerEntry, LedgerFilters, LedgerSortKey>
          id="ledger-entries"
          label="经营流水明细"
          rowKey={(row) => row.entryId}
          query={query}
          onQueryChange={applyQuery}
          initialFilters={initialFilters}
          data={{ rows, total, loading: listLoading, error: listError ?? undefined }}
          filters={filterDefinitions}
          columns={columns}
          onRefresh={refresh}
          errorTitle={listErrorTitle(listError)}
          emptyText={
            <div className="local-empty">
              <p>当前筛选条件下没有经营流水。</p>
              <p className="local-empty-hint">
                流水来自本地订单、已核验广电 CRM、奖励履约与人工收款登记；服务端分页，
                这里不会出现由前端拼接或汇总的行。
              </p>
            </div>
          }
          rowActions={(row) => [
            { key: 'detail', label: '详情', onClick: () => openEntry(row) },
          ]}
        />
      </div>

      <Drawer
        title={entry ? `流水详情 · ${LEDGER_FACT_KIND_LABELS[entry.factKind]}` : '流水详情'}
        size={620}
        open={entryOpen}
        onClose={() => setEntryOpen(false)}
        rootClassName="local-drawer"
        destroyOnHidden
      >
        {entry ? (
          <Space orientation="vertical" size={16} style={{ width: '100%' }}>
            <section className="local-section" aria-label="事实信息">
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="事实类型">
                  <Tag color={FACT_KIND_COLORS[entry.factKind]}>
                    {LEDGER_FACT_KIND_LABELS[entry.factKind]}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="金额">
                  <Space orientation="vertical" size={2}>
                    <Typography.Text strong>{formatCents(entry.amountCents)}</Typography.Text>
                    <Typography.Text type="secondary">
                      账面登记毛额 · {SETTLEMENT_AMOUNT_STATUS_LABELS[entry.settlementAmountStatus]}
                      （本 MVP 无结算规则，不据此计算应付）
                    </Typography.Text>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label="来源">
                  {LEDGER_SOURCE_SYSTEM_LABELS[entry.sourceSystem]} ·{' '}
                  <span className="ledger-cell-mono">{entry.sourceDisplayNo}</span>
                </Descriptions.Item>
                <Descriptions.Item label="社区">{communityName(entry.communityId)}</Descriptions.Item>
                <Descriptions.Item label="业务时间">
                  {formatDateTime(entry.occurredAt)}
                  {entry.verifiedAt ? ` · 核验于 ${formatDateTime(entry.verifiedAt)}` : ''}
                </Descriptions.Item>
                <Descriptions.Item label="录入时间">
                  {formatDateTime(entry.createdAt)}
                </Descriptions.Item>
              </Descriptions>
            </section>

            <section className="local-section" aria-label="归属与凭据">
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="业绩归属">
                  <Space orientation="vertical" size={2}>
                    <span>
                      {LEDGER_ATTRIBUTION_STATE_LABELS[entry.attribution.state]}
                      {entry.attribution.staffId
                        ? ` · ${staffName(entry.attribution.staffId)}`
                        : ''}
                    </span>
                    <Typography.Text type="secondary">
                      依据：{LEDGER_ATTRIBUTION_BASIS_LABELS[entry.attribution.basis]}
                    </Typography.Text>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label="凭据">
                  <Space orientation="vertical" size={2}>
                    <span>{LEDGER_EVIDENCE_KIND_LABELS[entry.evidence.kind]}</span>
                    {entry.evidence.ref ? (
                      <Typography.Text type="secondary" className="ledger-cell-mono">
                        {entry.evidence.ref}
                      </Typography.Text>
                    ) : (
                      <Typography.Text type="secondary">无凭据引用</Typography.Text>
                    )}
                  </Space>
                </Descriptions.Item>
                {entry.counterEntryId ? (
                  <Descriptions.Item label="冲正对象">
                    <span className="ledger-cell-mono">{entry.counterEntryId}</span>
                  </Descriptions.Item>
                ) : null}
              </Descriptions>
            </section>

            <section className="local-section" aria-label="对账状态">
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="对账状态">
                  {LEDGER_RECONCILIATION_STATE_LABELS[entry.reconciliationState]}
                </Descriptions.Item>
                <Descriptions.Item label="所属批次">
                  {entry.batchId ? (
                    <span className="ledger-cell-mono">{entry.batchId}</span>
                  ) : (
                    '未进入任何批次'
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="流水号">
                  <span className="ledger-cell-mono">{entry.entryId}</span>
                </Descriptions.Item>
              </Descriptions>
            </section>

            <section className="local-section" aria-label="未解决异常">
              <Typography.Text strong>未解决异常</Typography.Text>
              {(anomaliesByEntry.get(entry.entryId) ?? []).length === 0 ? (
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  该笔流水没有未解决异常。异常是复核提示，不会修改流水本身。
                </Typography.Paragraph>
              ) : (
                <Space orientation="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
                  {(anomaliesByEntry.get(entry.entryId) ?? []).map((anomaly) => (
                    <Card size="small" key={anomaly.anomalyId}>
                      <Space wrap>
                        <Tag color={anomaly.severity === 'high' ? 'red' : 'orange'}>
                          {LEDGER_ANOMALY_SEVERITY_LABELS[anomaly.severity]}
                        </Tag>
                        <span>{LEDGER_ANOMALY_KIND_LABELS[anomaly.kind]}</span>
                        <Typography.Text type="secondary">
                          {formatDateTime(anomaly.createdAt)}
                        </Typography.Text>
                      </Space>
                      {anomaly.note ? (
                        <Typography.Paragraph style={{ margin: '8px 0 0' }}>
                          {anomaly.note}
                        </Typography.Paragraph>
                      ) : null}
                    </Card>
                  ))}
                </Space>
              )}
            </section>
          </Space>
        ) : null}
      </Drawer>
    </div>
  )
}

/**
 * The KPI block. Every number here is rendered straight from the server's
 * per-fact-kind buckets — no cross-kind sum, no client-side total.
 */
function LedgerReport({
  overview,
  loading,
  onShowAnomalies,
}: {
  overview: LedgerOverview | null
  loading: boolean
  onShowAnomalies: () => void
}) {
  if (!overview) {
    return (
      <Card size="small">
        <Spin spinning={loading}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={loading ? '正在读取经营总览…' : '暂无经营总览数据'}
          />
        </Spin>
      </Card>
    )
  }

  const bucket = (kind: LedgerFactKind) =>
    overview.buckets.find((item) => item.factKind === kind) ?? {
      factKind: kind,
      entryCount: 0,
      grossAmountCents: 0,
    }

  const registered = bucket('order_registered')
  const verified = bucket('order_verified')
  const received = bucket('payment_received')
  const paymentReversed = bucket('payment_reversed')
  const rewardCost = bucket('reward_cost')
  const rewardReversed = bucket('reward_reversed')

  return (
    <Card
      size="small"
      title="经营总览"
      extra={
        <Space wrap size={8}>
          <Tag color={overview.amountStatus === 'pending_rule' ? 'orange' : 'blue'}>
            {SETTLEMENT_AMOUNT_STATUS_LABELS[overview.amountStatus]}
          </Tag>
          <Typography.Text type="secondary">
            数据截至 {formatDateTime(overview.asOf)}（{overview.timeZone}）· 服务端聚合
          </Typography.Text>
        </Space>
      }
    >
      <Row gutter={[12, 12]}>
        <Col xs={24} md={12} xl={8}>
          <Card size="small" className="ledger-kpi" data-fact-kind="order_registered">
            <Statistic
              title={LEDGER_FACT_KIND_LABELS.order_registered}
              value={registered.grossAmountCents / 100}
              precision={2}
              prefix="¥"
              suffix={`/ ${registered.entryCount} 笔`}
            />
            <Typography.Text type="secondary" className="ledger-kpi-note">
              {LEDGER_FACT_KIND_NOTES.order_registered}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Card size="small" className="ledger-kpi" data-fact-kind="order_verified">
            <Statistic
              title={LEDGER_FACT_KIND_LABELS.order_verified}
              value={verified.grossAmountCents / 100}
              precision={2}
              prefix="¥"
              suffix={`/ ${verified.entryCount} 笔`}
            />
            <Typography.Text type="secondary" className="ledger-kpi-note">
              {LEDGER_FACT_KIND_NOTES.order_verified}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Card size="small" className="ledger-kpi" data-fact-kind="payment_received">
            <Statistic
              title={LEDGER_FACT_KIND_LABELS.payment_received}
              value={received.grossAmountCents / 100}
              precision={2}
              prefix="¥"
              suffix={`/ ${received.entryCount} 笔`}
            />
            <Typography.Text type="secondary" className="ledger-kpi-note">
              {LEDGER_FACT_KIND_NOTES.payment_received}
            </Typography.Text>
            <div className="ledger-kpi-secondary">
              收款冲正 {formatCents(paymentReversed.grossAmountCents)}（{paymentReversed.entryCount}{' '}
              笔，单独成行，不抵扣实收）
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Card size="small" className="ledger-kpi" data-fact-kind="reward_cost">
            <Statistic
              title={LEDGER_FACT_KIND_LABELS.reward_cost}
              value={rewardCost.grossAmountCents / 100}
              precision={2}
              prefix="¥"
              suffix={`/ ${rewardCost.entryCount} 笔`}
            />
            <Typography.Text type="secondary" className="ledger-kpi-note">
              {LEDGER_FACT_KIND_NOTES.reward_cost}
            </Typography.Text>
            <div className="ledger-kpi-secondary">
              奖励冲正 {formatCents(rewardReversed.grossAmountCents)}（{rewardReversed.entryCount}{' '}
              笔，单独成行）
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Card size="small" className="ledger-kpi" data-testid="ledger-attribution">
            <Statistic
              title="业绩归属"
              value={overview.attributed.entryCount}
              suffix={`/ ${overview.totals.entryCount} 笔已归属`}
            />
            <Typography.Text type="secondary" className="ledger-kpi-note">
              已归属 {formatCents(overview.attributed.amountCents)}
            </Typography.Text>
            <div className="ledger-kpi-secondary">
              待归属 {overview.pendingAttribution.entryCount} 笔 ·{' '}
              {formatCents(overview.pendingAttribution.amountCents)}
              （没有明确归属，不计入任何人的业绩）
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12} xl={8}>
          <Card size="small" className="ledger-kpi" data-testid="ledger-anomalies">
            <Statistic
              title="流水与未解决异常"
              value={overview.totals.entryCount}
              suffix="笔流水"
            />
            <Typography.Text type="secondary" className="ledger-kpi-note">
              六类事实分别计数，不做跨类金额合计。
            </Typography.Text>
            <div className="ledger-kpi-secondary">
              未解决异常 {overview.openAnomalies.count} 条
              <Button type="link" size="small" onClick={onShowAnomalies}>
                只看异常明细
              </Button>
            </div>
          </Card>
        </Col>
      </Row>

      <Typography.Paragraph type="secondary" className="ledger-report-footnote">
        六类事实的金额都是账面登记毛额：登记金额与已核验业绩常描述同一笔业务，人工实收与
        奖励成本是另外两类钱，冲正各自单独成行。因此本页不提供「合计金额」，也不展示任何
        由金额推导出的应付、分账或打款数字（结算状态：{' '}
        {SETTLEMENT_AMOUNT_STATUS_LABELS[overview.amountStatus]}）
        {overview.totals.grossAmountCents > 0
          ? '。若需要口径明细，请看下方每一类事实的笔数与毛额。'
          : '。'}
      </Typography.Paragraph>
    </Card>
  )
}
