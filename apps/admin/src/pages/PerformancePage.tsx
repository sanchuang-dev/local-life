import { PageInfoAlert } from '../components/PageInfoHelp'
import {
  Alert,
  Button,
  DatePicker,
  Empty,
  Select,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
} from 'antd'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import {
  type LedgerFactKind,
  type LedgerOverview,
} from '@sanchuang-dev/local-life-contracts'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import type { DateRangeValue } from '../shared/components/DataPanel'
import type { AuthenticatedSession } from '../services/auth'
import { isLocalApiError } from '../services/localApi'
import {
  LEDGER_FACT_KIND_LABELS,
  SETTLEMENT_AMOUNT_STATUS_LABELS,
  formatCents,
  formatDateTime,
  getLedgerOverview,
} from '../services/ledger'
import {
  communityOptionsOf,
  staffOptionsOf,
  useAdminFilterOptions,
} from './useAdminFilterOptions'
import './ledger.css'

/**
 * 业绩总览 — the aggregate view of the unified operating ledger (#64).
 *
 * Every number comes from `/admin/ledger/overview`; this page never adds the
 * six fact kinds together and never derives a payable amount. Querying,
 * paging and per-entry detail live on 经营流水 so the summary cannot be
 * confused with an order or receipt form.
 */

interface OverviewScope {
  /** Business-date range (`YYYY-MM-DD`), inclusive on both ends. */
  range?: DateRangeValue
  communityId?: string
  /** Attribution filter: the grid worker a fact belongs to. */
  staffId?: string
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
          title="业绩总览"
          description="经营总览仅对管理员与运营员开放。"
          status={<Tag>无权限</Tag>}
        />
        <div className="page-stack">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="网格员没有后台业绩总览权限；后台 /admin/ledger/* 对网格员返回 403。"
          />
        </div>
      </div>
    )
  }

  return <PerformanceConsole session={session} />
}

function PerformanceConsole({ session }: { session: AuthenticatedSession }) {
  const navigate = useNavigate()
  const isAdmin = session.staff.role === 'admin'
  const assigned = session.staff.communities
  const { communities, staff, error: optionsError, retry: retryOptions } = useAdminFilterOptions()

  const defaultCommunityId = isAdmin ? undefined : assigned[0]?.id
  const [scope, setScope] = useState<OverviewScope>(() => ({
    communityId: defaultCommunityId,
  }))

  const [overview, setOverview] = useState<LedgerOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [token, setToken] = useState(0)

  const from = scope.range?.start
  const to = scope.range?.end

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setOverview(null)
    setLoading(true)
    setError(null)
    getLedgerOverview(
      { from, to, communityId: scope.communityId, staffId: scope.staffId },
      controller.signal,
    )
      .then((result) => {
        if (active) setOverview(result)
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setOverview(null)
        setError(cause instanceof Error ? cause : new Error('经营总览加载失败'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [from, to, scope.communityId, scope.staffId, token])

  const communityOptions = useMemo(() => communityOptionsOf(communities), [communities])
  const staffOptions = useMemo(() => staffOptionsOf(staff), [staff])

  const isDefaultScope =
    scope.range === undefined &&
    scope.staffId === undefined &&
    scope.communityId === defaultCommunityId

  const rangeValue: [dayjs.Dayjs | null, dayjs.Dayjs | null] = [
    scope.range?.start ? dayjs(scope.range.start) : null,
    scope.range?.end ? dayjs(scope.range.end) : null,
  ]

  return (
    <div className="page">
      <PageHeader
        title="业绩总览"
        description="统一经营流水的账面汇总：登记金额、已核验业绩、人工实收与冲正、奖励成本与冲正分列，不计算应付或分账。"
        extra={<Button onClick={() => setToken((value) => value + 1)} loading={loading}>刷新</Button>}
      />

      <div className="page-stack">
        <PageInfoAlert
          type="info"
          showIcon
          title="口径说明"
          description={
            <ul className="ledger-info-list">
              <li>六类事实不合并：登记金额与已核验业绩常描述同一笔业务，因此不提供合计金额。</li>
              <li>人工实收只统计带凭据的线下收款；冲正单独成行，不减记实收。</li>
              <li>归属只取来源事实上明确存在的网格员，待归属不计入任何人的业绩。</li>
              <li>本页只按业务日期、社区与业绩归属汇总；事实类型、来源与异常筛选在「经营流水」页。</li>
              <li>来源事实需在「经营流水」页由运营人员显式同步，本页不做自动实时刷新。</li>
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
                ? `总览仅统计管理员分配的社区（${assigned
                    .map((item) => item.name)
                    .join('、')}）；服务端同样按社区范围裁剪，前端筛选无法扩大可见范围。`
                : '当前账号尚未被分配社区，暂时无法查看总览，请联系管理员。'
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

        <div className="ledger-overview-filters" role="group" aria-label="经营总览筛选">
          <label className="ledger-filter-field">
            <span>社区</span>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              aria-label="社区"
              placeholder="全部可见社区"
              value={scope.communityId}
              options={communityOptions}
              onChange={(value?: string) =>
                setScope((current) => ({ ...current, communityId: value }))
              }
            />
          </label>
          <label className="ledger-filter-field">
            <span>业务日期</span>
            <DatePicker.RangePicker
              allowEmpty={[true, true]}
              aria-label="业务日期"
              format="YYYY-MM-DD"
              placeholder={['开始日期', '结束日期']}
              value={rangeValue}
              onChange={(dates) => {
                const start = dates?.[0]?.format('YYYY-MM-DD')
                const end = dates?.[1]?.format('YYYY-MM-DD')
                setScope((current) => ({
                  ...current,
                  range: start || end ? { start, end } : undefined,
                }))
              }}
            />
          </label>
          <label className="ledger-filter-field">
            <span>业绩归属</span>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              aria-label="业绩归属"
              placeholder="全部网格员"
              value={scope.staffId}
              options={staffOptions}
              onChange={(value?: string) =>
                setScope((current) => ({ ...current, staffId: value }))
              }
            />
          </label>
          {!isDefaultScope ? (
            <Button
              type="link"
              className="ledger-filter-reset"
              onClick={() => setScope({ communityId: defaultCommunityId })}
            >
              重置筛选
            </Button>
          ) : null}
        </div>

        {error ? (
          <Alert
            type="error"
            showIcon
            title={overviewErrorTitle(error)}
            description={error.message}
            action={
              <Button size="small" onClick={() => setToken((value) => value + 1)}>
                重试
              </Button>
            }
          />
        ) : (
          <LedgerReport
            overview={overview}
            loading={loading}
            onShowAnomalies={() => navigate('/performance/ledger?anomalyOnly=true')}
          />
        )}
      </div>
    </div>
  )
}

function MetricCard({
  title,
  value,
  suffix,
  precision,
  prefix,
  secondary,
  factKind,
  testId,
}: {
  title: string
  value: number
  suffix: string
  precision?: number
  prefix?: string
  secondary?: ReactNode
  factKind?: LedgerFactKind
  testId?: string
}) {
  return (
    <section className="ledger-kpi" data-fact-kind={factKind} data-testid={testId}>
      <Statistic
        title={title}
        value={value}
        precision={precision}
        prefix={prefix}
        suffix={suffix}
      />
      {secondary ? <div className="ledger-kpi-secondary">{secondary}</div> : null}
    </section>
  )
}

/**
 * The KPI block. Every number is rendered straight from the server's
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
      <div className="ledger-report-state">
        <Spin spinning={loading}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={loading ? '正在读取经营总览…' : '暂无经营总览数据'}
          />
        </Spin>
      </div>
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
    <>
      <div className="ledger-report-meta">
        <Tag color={overview.amountStatus === 'pending_rule' ? 'orange' : 'blue'}>
          {SETTLEMENT_AMOUNT_STATUS_LABELS[overview.amountStatus]}
        </Tag>
        <Typography.Text type="secondary">
          数据截至 {formatDateTime(overview.asOf)}（{overview.timeZone}）· 服务端聚合
        </Typography.Text>
      </div>

      <div className="ledger-kpi-grid" aria-label="经营指标">
        <MetricCard
          title={LEDGER_FACT_KIND_LABELS.order_registered}
          value={registered.grossAmountCents / 100}
          precision={2}
          prefix="¥"
          suffix={`/ ${registered.entryCount} 笔`}
          factKind="order_registered"
        />
        <MetricCard
          title={LEDGER_FACT_KIND_LABELS.order_verified}
          value={verified.grossAmountCents / 100}
          precision={2}
          prefix="¥"
          suffix={`/ ${verified.entryCount} 笔`}
          factKind="order_verified"
        />
        <MetricCard
          title={LEDGER_FACT_KIND_LABELS.payment_received}
          value={received.grossAmountCents / 100}
          precision={2}
          prefix="¥"
          suffix={`/ ${received.entryCount} 笔`}
          factKind="payment_received"
          secondary={
            <>
              收款冲正 {formatCents(paymentReversed.grossAmountCents)}（
              {paymentReversed.entryCount} 笔，单独成行，不抵扣实收）
            </>
          }
        />
        <MetricCard
          title={LEDGER_FACT_KIND_LABELS.reward_cost}
          value={rewardCost.grossAmountCents / 100}
          precision={2}
          prefix="¥"
          suffix={`/ ${rewardCost.entryCount} 笔`}
          factKind="reward_cost"
          secondary={
            <>
              奖励冲正 {formatCents(rewardReversed.grossAmountCents)}（
              {rewardReversed.entryCount} 笔，单独成行）
            </>
          }
        />
        <MetricCard
          title="业绩归属"
          value={overview.attributed.entryCount}
          suffix={`/ ${overview.totals.entryCount} 笔已归属`}
          testId="ledger-attribution"
          secondary={
            <>
              已归属 {formatCents(overview.attributed.amountCents)} · 待归属{' '}
              {overview.pendingAttribution.entryCount} 笔 ·{' '}
              {formatCents(overview.pendingAttribution.amountCents)}
            </>
          }
        />
        <MetricCard
          title="未解决异常"
          value={overview.openAnomalies.count}
          suffix="条"
          testId="ledger-anomalies"
          secondary={
            <Space wrap size={4}>
              <span>共 {overview.totals.entryCount} 笔流水</span>
              <Button type="link" size="small" onClick={onShowAnomalies}>
                查看异常流水
              </Button>
            </Space>
          }
        />
      </div>
    </>
  )
}
