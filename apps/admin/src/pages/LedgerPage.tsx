import { PageInfoAlert } from '../components/PageInfoHelp'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Drawer,
  Result,
  Space,
  Tag,
  Typography,
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import {
  LEDGER_FACT_KINDS,
  type LedgerAnomaly,
  type LedgerEntry,
  type LedgerFactKind,
  type LedgerOrderEvidence,
  type LedgerSourceSystem,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import { DataPanel, type PanelFilter, type PanelQuery } from '../shared/components/DataPanel'
import type { DateRangeValue } from '../shared/components/DataPanel'
import type { AuthenticatedSession } from '../services/auth'
import { describeLocalError, isLocalApiError } from '../services/localApi'
import {
  LEDGER_ANOMALY_KIND_LABELS,
  LEDGER_ANOMALY_SEVERITY_LABELS,
  LEDGER_ATTRIBUTION_BASIS_LABELS,
  LEDGER_ATTRIBUTION_STATE_LABELS,
  LEDGER_EVIDENCE_KIND_LABELS,
  LEDGER_FACT_KIND_LABELS,
  LEDGER_RECONCILIATION_STATE_LABELS,
  LEDGER_SOURCE_SYSTEM_LABELS,
  SETTLEMENT_AMOUNT_STATUS_LABELS,
  formatCents,
  formatDateTime,
  getLedgerEntryOrderEvidence,
  getLedgerOrderEvidence,
  listLedgerAnomalies,
  listLedgerEntries,
  syncLedgerSourceFacts,
} from '../services/ledger'
import {
  communityOptionsOf,
  staffOptionsOf,
  useAdminFilterOptions,
} from './useAdminFilterOptions'
import './ledger.css'

/**
 * 经营流水 — the list and audit surface of the unified operating ledger (#64).
 *
 * The page reports facts exactly as the server projected them: six fact kinds
 * are never merged, a reversal is its own positive row, attribution only comes
 * from an explicit source fact, and every amount is a 账面登记毛额. The
 * 业绩总览 page owns the aggregates; this page owns server-side querying,
 * paging, anomaly flags and the immutable entry detail.
 */

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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

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

export function LedgerPage() {
  const { session } = useAdminAuth()

  if (session.staff.role === 'grid_worker') {
    return (
      <div className="page">
        <PageHeader
          title="经营流水"
          description="经营流水明细仅对管理员与运营员开放。"
          status={<Tag>无权限</Tag>}
        />
        <div className="page-stack">
          <Result
            status="403"
            title="网格员没有后台经营流水权限"
            subTitle="后台 /admin/ledger/* 拒绝网格员；即使直接访问该地址，服务端同样返回 403。你授权社区内的流水请通过移动端工作台查看。"
          />
        </div>
      </div>
    )
  }

  return <LedgerConsole session={session} />
}

function LedgerConsole({ session }: { session: AuthenticatedSession }) {
  const { message } = AntdApp.useApp()
  const [searchParams] = useSearchParams()
  const isAdmin = session.staff.role === 'admin'
  const assigned = session.staff.communities
  const { communities, staff, error: optionsError, retry: retryOptions } = useAdminFilterOptions()

  /* ------------------------------- the query ------------------------------- */

  const [query, setQuery] = useState<PanelQuery<LedgerFilters, LedgerSortKey>>(() => {
    // 业绩总览 links here with its current scope. Parse defensively: a crafted
    // community id must not widen an operator's scope, and malformed dates or
    // ids would otherwise reach the server as a 400.
    const requestedCommunityId = searchParams.get('communityId')
    const requestedStaffId = searchParams.get('staffId')
    const rawFrom = searchParams.get('from')
    const rawTo = searchParams.get('to')
    const from = rawFrom && BUSINESS_DATE_PATTERN.test(rawFrom) ? rawFrom : undefined
    const to = rawTo && BUSINESS_DATE_PATTERN.test(rawTo) ? rawTo : undefined
    const range = from && to && to < from ? undefined : from || to ? { start: from, end: to } : undefined
    const candidateCommunityId =
      requestedCommunityId && UUID_PATTERN.test(requestedCommunityId)
        ? requestedCommunityId
        : undefined
    const communityId = isAdmin
      ? candidateCommunityId
      : assigned.some((item) => item.id === candidateCommunityId)
        ? candidateCommunityId
        : assigned[0]?.id

    return {
      filters: {
        ...initialFilters,
        communityId,
        staffId:
          requestedStaffId && UUID_PATTERN.test(requestedStaffId) ? requestedStaffId : undefined,
        range,
        anomalyOnly: searchParams.get('anomalyOnly') === 'true' ? 'true' : undefined,
      },
      page: 1,
      pageSize: 20,
    }
  })

  /* ------------------------------- the list -------------------------------- */

  const [rows, setRows] = useState<LedgerEntry[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<Error | null>(null)
  const [listToken, setListToken] = useState(0)
  const [syncing, setSyncing] = useState(false)

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
  const [entryOrder, setEntryOrder] = useState<LedgerOrderEvidence | null>(null)
  const [entryOrderError, setEntryOrderError] = useState<string | null>(null)

  // Orders and receipts are linked only by a persisted backend relation.
  // Never infer a match from equal amounts or the account that entered them.
  useEffect(() => {
    if (!entryOpen || !entry) return
    let active = true
    const controller = new AbortController()
    setEntryOrder(null)
    setEntryOrderError(null)
    const lookup = entry.sourceSystem === 'local_order'
      ? getLedgerOrderEvidence(entry.sourceId, controller.signal)
      : entry.factKind === 'payment_received' || entry.factKind === 'payment_reversed'
        ? getLedgerEntryOrderEvidence(entry.counterEntryId ?? entry.entryId, controller.signal)
        : Promise.resolve(null)
    lookup.then((result) => {
      if (active) setEntryOrder(result)
    }).catch((cause: unknown) => {
      if (active && !controller.signal.aborted) {
        setEntryOrderError(describeLocalError(cause, '未能读取订单关联信息'))
      }
    })
    return () => { active = false; controller.abort() }
  }, [entryOpen, entry, listToken])

  /* ------------------------------- lookups --------------------------------- */

  const communityName = (id: string | null | undefined): string => {
    if (!id) return '—'
    return communities.find((item) => item.id === id)?.name ?? `社区 ${id.slice(0, 8)}`
  }

  const staffName = (id: string | null | undefined): string => {
    if (!id) return '—'
    return staff.find((item) => item.id === id)?.displayName?.trim() || `网格员 ${id.slice(0, 8)}`
  }

  const communityOptions = useMemo(() => communityOptionsOf(communities), [communities])
  const staffOptions = useMemo(() => staffOptionsOf(staff), [staff])

  /* ------------------------------- callbacks ------------------------------- */

  const refresh = () => {
    setListToken((value) => value + 1)
  }

  const syncSources = async () => {
    setSyncing(true)
    try {
      const result = await syncLedgerSourceFacts(session.csrfToken)
      refresh()
      setAnomaliesToken((value) => value + 1)
      message.success(
        `同步完成：新增 ${result.created} 条，已存在 ${result.skipped} 条（扫描 ${result.scanned} 条）。`,
      )
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
        title="经营流水"
        description="按社区、业绩归属、事实类型与异常筛选服务端分页流水；每笔都保留来源、凭据、归属和对账状态。"
        extra={
          <Space wrap>
            <Button onClick={syncSources} loading={syncing}>同步来源事实</Button>
            <Button onClick={refresh} loading={listLoading}>刷新</Button>
          </Space>
        }
      />

      <div className="page-stack">
        <PageInfoAlert
          type="info"
          showIcon
          title="流水口径"
          description={
            <ul className="ledger-info-list">
              <li>六类事实不合并：登记金额与已核验业绩常描述同一笔业务，不提供合计金额。</li>
              <li>人工实收只统计带凭据的线下收款；冲正单独成行，不减记实收。</li>
              <li>归属只取来源事实上明确存在的网格员，其余记为「待归属」。</li>
              <li>来源事实需由运营人员显式「同步来源事实」，本页不做自动实时同步。</li>
              <li>活动维度筛选尚无服务端字段，本轮不提供。</li>
            </ul>
          }
        />
        {!isAdmin ? (
          <PageInfoAlert
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
            action={<Button size="small" onClick={retryOptions}>重试</Button>}
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
                <Descriptions.Item label="关联本地订单">
                  {entryOrder ? (
                    <Space orientation="vertical" size={2}>
                      <Typography.Text strong>
                        {entryOrder.orderDisplayNo} · {entryOrder.productName}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        登记 {formatCents(entryOrder.registeredAmountCents)}（非实收）；
                        {entryOrder.payment
                          ? `凭据实收 ${formatCents(entryOrder.payment.amountCents)}`
                          : '尚无实收证明'}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {entryOrder.blockingReasons.join('；') || '收款证据已有记录，非结算凭证'}
                      </Typography.Text>
                    </Space>
                  ) : (entryOrderError ? entryOrderError : '未关联本地订单（历史流水不自动匹配）')}
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
