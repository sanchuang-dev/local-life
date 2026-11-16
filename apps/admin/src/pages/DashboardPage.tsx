import {
  ArrowRightOutlined, CalendarOutlined, ClockCircleOutlined, EnvironmentOutlined,
  ReloadOutlined, TeamOutlined,
} from '@ant-design/icons'
import { Button } from 'antd'
import type { LedgerOverview } from '@sanchuang-dev/local-life-contracts'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { useAdminAuth } from '../app/auth-context'
import { PageHeader } from '../components/PageHeader'
import { LedgerCompositionChart, LedgerTrendChart } from './DashboardCharts'
import { recentShanghaiBusinessDays, type DailyLedgerPoint } from './dashboardDates'
import { listActivities, listAdminCommunities } from '../services/activities'
import { getLedgerOverview } from '../services/ledger'
import { listAdminLocalOrders } from '../services/localOrders'
import { listUserDirectory } from '../services/users'
import './dashboard.css'

type Metrics = {
  published: number | null
  pending: number | null
  residents: number | null
  communities: number | null
  buckets: LedgerOverview['buckets'] | null
}
const EMPTY_METRICS: Metrics = {
  published: null, pending: null, residents: null, communities: null,
  buckets: null,
}

function countText(value: number | null, loading: boolean) {
  return loading ? '···' : value === null ? '—' : value.toLocaleString('zh-CN')
}

function Metric({
  label, value, loading, icon, detail, onClick, emphasize,
}: {
  label: string
  value: number | null
  loading: boolean
  icon: ReactNode
  detail: string
  onClick: () => void
  emphasize?: boolean
}) {
  return (
    <button className={'dashboard-metric' + (emphasize ? ' dashboard-metric--focus' : '')}
      type="button" onClick={onClick} aria-label={label + '，查看详情'}>
      <span className="dashboard-metric__top"><span>{label}</span><span className="dashboard-metric__icon">{icon}</span></span>
      <span className="dashboard-metric__value" aria-busy={loading}>{countText(value, loading)}</span>
      <span className="dashboard-metric__detail">
        {loading ? '正在读取' : value === null ? '数据暂不可用' : detail}
        <ArrowRightOutlined aria-hidden="true"/>
      </span>
    </button>
  )
}

/**
 * Read-only operating cockpit. Every KPI comes from the server's scoped
 * total/overview (never from a page of rows); failures remain unknown, not 0.
 */
export function DashboardPage() {
  const { session } = useAdminAuth()
  const navigate = useNavigate()
  const role = session.staff.role
  const canOperate = role === 'admin' || role === 'operator'
  const [refresh, setRefresh] = useState(0)
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS)
  const [metricsScope, setMetricsScope] = useState('')
  const [loading, setLoading] = useState(true)
  const [dailyTrend, setDailyTrend] = useState<DailyLedgerPoint[] | null>(null)
  const [trendScope, setTrendScope] = useState('')
  const [trendLoading, setTrendLoading] = useState(true)
  const communities = session.staff.communities
  // Never display a previous staff identity's totals during a session switch.
  const scopeKey = [session.staff.id, role, communities.map((item) => item.id).join(',')].join('|')
  const currentMetrics = metricsScope === scopeKey ? metrics : EMPTY_METRICS
  const currentLoading = loading || metricsScope !== scopeKey
  const currentTrend = trendScope === scopeKey ? dailyTrend : null
  const currentTrendLoading = trendLoading || trendScope !== scopeKey

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const signal = controller.signal

    const load = async () => {
      // The server scopes every listing/aggregate; grid workers do not call
      // the operator-only activity, order or ledger endpoints.
      const results = await Promise.allSettled([
        listUserDirectory({ page: 1, pageSize: 1 }, signal),
        role === 'admin'
          ? listAdminCommunities(signal)
          : Promise.resolve(communities),
        canOperate
          ? listActivities({ page: 1, pageSize: 1, status: 'published' }, signal)
          : Promise.resolve(null),
        canOperate
          ? listAdminLocalOrders({ page: 1, pageSize: 1, status: 'pending_review' }, signal)
          : Promise.resolve(null),
        canOperate ? getLedgerOverview({}, signal) : Promise.resolve(null),
      ] as const)
      if (!active) return
      const [users, scope, activities, orders, ledger] = results
      setMetrics({
        residents: users.status === 'fulfilled' ? users.value.total : null,
        communities: scope.status === 'fulfilled' ? scope.value.length : null,
        published: activities.status === 'fulfilled' ? activities.value?.total ?? null : null,
        pending: orders.status === 'fulfilled' ? orders.value?.total ?? null : null,
        buckets: ledger.status === 'fulfilled' ? ledger.value?.buckets ?? null : null,
      })
      setMetricsScope(scopeKey)
      setLoading(false)
    }
    // Revisions invalidate all prior snapshots immediately, rather than
    // displaying old totals under a new refresh label.
    void load()
    return () => { active = false; controller.abort() }
  }, [role, canOperate, communities, scopeKey, refresh])

  useEffect(() => {
    if (!canOperate) return
    const controller = new AbortController()
    let active = true
    const days = recentShanghaiBusinessDays()
    // Seven date-scoped server aggregates, not an incomplete page of raw rows.
    // Each failed day remains null, so the line is broken rather than filled with 0.
    void Promise.allSettled(days.map((day) =>
      getLedgerOverview({ from: day, to: day }, controller.signal),
    )).then((results) => {
      if (!active) return
      setDailyTrend(days.map((day, index) => {
        const result = results[index]
        return {
          day,
          receivedCents: result.status === 'fulfilled' ? result.value.payment.receivedCents : null,
          reversedCents: result.status === 'fulfilled' ? result.value.payment.reversedCents : null,
        }
      }))
      setTrendScope(scopeKey)
      setTrendLoading(false)
    })
    return () => { active = false; controller.abort() }
  }, [canOperate, scopeKey, refresh])

  const refreshMetrics = () => {
    setMetrics(EMPTY_METRICS)
    setLoading(true)
    setDailyTrend(null)
    setTrendLoading(true)
    setTrendScope('')
    setRefresh((value) => value + 1)
  }

  return (
    <div className="page dashboard-page">
      <PageHeader
        title="经营工作台"
        description="社区经营数据与趋势，一眼掌握当前状况"
        extra={<Button icon={<ReloadOutlined/>} onClick={refreshMetrics} loading={currentLoading}>刷新数据</Button>}
      />
      <div className="dashboard-body">
        <section className="dashboard-section" aria-label="业务指标">
          <div className="dashboard-metrics">
            {canOperate && <>
              <Metric label="已发布活动" value={currentMetrics.published} loading={currentLoading}
                detail="当前已发布" icon={<CalendarOutlined/>} onClick={() => navigate('/activities')}/>
              <Metric label="待人工核验订单" value={currentMetrics.pending} loading={currentLoading}
                detail="需要运营处理" icon={<ClockCircleOutlined/>} emphasize onClick={() => navigate('/orders')}/>
            </>}
            <Metric label={role === 'admin' ? '平台用户账户' : '可见用户账户'} value={currentMetrics.residents} loading={currentLoading}
              detail="当前可见账户" icon={<TeamOutlined/>} onClick={() => navigate('/users')}/>
            <Metric label={role === 'admin' ? '平台社区' : '授权社区'} value={currentMetrics.communities}
              loading={currentLoading} detail="当前服务范围" icon={<EnvironmentOutlined/>} onClick={() => navigate('/communities')}/>
          </div>
        </section>

        {canOperate && (
          <div className="dashboard-charts">
            <LedgerTrendChart points={currentTrend} loading={currentTrendLoading}/>
            <LedgerCompositionChart buckets={currentMetrics.buckets} loading={currentLoading}/>
          </div>
        )}

      </div>
    </div>
  )
}
