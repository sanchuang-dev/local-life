import type { LedgerOverview } from '@sanchuang-dev/local-life-contracts'

/** A missing daily aggregate stays unknown; a confirmed zero remains a zero. */
import type { DailyLedgerPoint } from './dashboardDates'

function yuan(cents: number) {
  return '¥' + (cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function chartAxis(cents: number) {
  const value = cents / 100
  return '¥' + (value >= 10_000
    ? (value / 10_000).toFixed(1) + '万'
    : value >= 1_000 ? (value / 1_000).toFixed(1) + '千'
    : Number(value.toFixed(2)).toString())
}

/** Counts of separate business facts, NOT a funnel or an order-to-payment conversion rate. */
const FACT_LABELS: ReadonlyArray<{ kind: LedgerOverview['buckets'][number]['factKind']; label: string }> = [
  { kind: 'order_registered', label: '订单登记' },
  { kind: 'order_verified', label: '人工核验' },
  { kind: 'payment_received', label: '实收凭据' },
  { kind: 'payment_reversed', label: '收款冲正' },
  { kind: 'reward_cost', label: '奖励成本' },
  { kind: 'reward_reversed', label: '奖励冲正' },
]

export function LedgerTrendChart({ points, loading }: {
  points: DailyLedgerPoint[] | null
  loading: boolean
}) {
  const known = points?.some((item) => item.receivedCents !== null || item.reversedCents !== null) ?? false
  const values = (points ?? []).flatMap((item) => [item.receivedCents, item.reversedCents])
    .filter((value): value is number => value !== null)
  const max = Math.max(100, ...values)
  const axisMaximum = Math.ceil(max / 100) * 100
  const left = 62
  const top = 20
  const bottom = 214
  const span = 610
  const x = (index: number) => left + span * index / 6
  const y = (cents: number) => bottom - cents / axisMaximum * (bottom - top)
  const linePath = (kind: 'receivedCents' | 'reversedCents') => {
    let drawing = false
    return (points ?? []).map((item, index) => {
      const cents = item[kind]
      if (cents === null) { drawing = false; return '' }
      const path = `${drawing ? 'L' : 'M'} ${x(index)} ${y(cents)}`
      drawing = true
      return path
    }).join(' ')
  }

  return (
    <section className="dashboard-chart-panel" aria-labelledby="dashboard-trend">
      <div className="dashboard-chart-panel__heading">
        <div><h3 id="dashboard-trend">近 7 日实收走势</h3><p>北京时间 · 人工登记收款，按业务日聚合</p></div>
        <div className="dashboard-chart-legend"><span className="dashboard-chart-legend__received">实收毛额</span><span className="dashboard-chart-legend__reversed">冲正毛额</span></div>
      </div>
      {loading ? <div className="dashboard-chart-state" role="status">正在读取最近 7 天的经营流水…</div> :
        !known ? <div className="dashboard-chart-state" role="status">趋势数据暂不可用</div> : (
          <svg className="dashboard-trend-svg" viewBox="0 0 700 256" role="img"
            aria-label={'最近七日登记实收与冲正趋势：' + (points ?? []).map((p) =>
              p.day + ' 实收' + (p.receivedCents === null ? '未知' : yuan(p.receivedCents)) +
              ' 冲正' + (p.reversedCents === null ? '未知' : yuan(p.reversedCents))).join('，')}>
            {[0, 1, 2, 3, 4].map((i) => {
              const cents = axisMaximum * (4 - i) / 4
              const yy = top + (bottom - top) * i / 4
              return <g key={i}>
                <line x1={left} x2={left + span} y1={yy} y2={yy} stroke="#eaf0ed" strokeDasharray={i === 4 ? undefined : '4 5'}/>
                <text x={left - 12} y={yy + 4} textAnchor="end" fill="#8a9991" fontSize="11">{chartAxis(cents)}</text>
              </g>
            })}
            {points?.map((point, index) => (
              <text key={point.day} x={x(index)} y="244" textAnchor="middle" fill="#88968f" fontSize="11">{point.day.slice(5).replace('-', '/')}</text>
            ))}
            <path d={linePath('receivedCents')} fill="none" stroke="#208367" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/>
            <path d={linePath('reversedCents')} fill="none" stroke="#d29a41" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
            {points?.map((point, index) => (
              <g key={point.day}>
                {point.receivedCents !== null && <circle cx={x(index)} cy={y(point.receivedCents)} r="4.5"
                  fill="#fff" stroke="#208367" strokeWidth="2.5">
                  <title>{point.day} · 实收 {yuan(point.receivedCents)}</title>
                </circle>}
                {point.reversedCents !== null && <circle cx={x(index)} cy={y(point.reversedCents)} r="3.5"
                  fill="#fff" stroke="#d29a41" strokeWidth="2">
                  <title>{point.day} · 冲正 {yuan(point.reversedCents)}</title>
                </circle>}
              </g>
            ))}
          </svg>
        )}
      <p className="dashboard-chart-note">实际收款与冲正分别展示，不合并为净额；断档日期不补零。</p>
    </section>
  )
}

export function LedgerCompositionChart({ buckets, loading }: {
  buckets: LedgerOverview['buckets'] | null
  loading: boolean
}) {
  const max = Math.max(1, ...(buckets ?? []).map((item) => item.entryCount))
  const available = buckets !== null
  return (
    <section className="dashboard-chart-panel" aria-labelledby="dashboard-composition">
      <div className="dashboard-chart-panel__heading">
        <div><h3 id="dashboard-composition">经营事实分布</h3><p>全部可见期间 · 按事实记录条数</p></div>
      </div>
      {loading ? <div className="dashboard-chart-state" role="status">正在读取经营事实…</div> :
        !available ? <div className="dashboard-chart-state" role="status">构成数据暂不可用</div> :
        (buckets ?? []).every((bucket) => bucket.entryCount === 0)
          ? <div className="dashboard-chart-state" role="status">当前还没有经营事实记录</div> :
          <div className="dashboard-composition" role="img" aria-label={'经营事实记录数：' + FACT_LABELS.map((item) => {
            const count = buckets?.find((bucket) => bucket.factKind === item.kind)?.entryCount ?? 0
            return item.label + count + '条'
          }).join('，')}>
            {FACT_LABELS.map(({ kind, label }) => {
              const value = buckets?.find((item) => item.factKind === kind)?.entryCount ?? 0
              return (
                <div className="dashboard-composition__row" key={kind}>
                  <span className="dashboard-composition__label">{label}</span>
                  <div className="dashboard-composition__track">
                    <div className={'dashboard-composition__bar dashboard-composition__bar--' + kind}
                      style={{ width: (value / max * 100) + '%' }}/>
                  </div>
                  <strong>{value.toLocaleString('zh-CN')}</strong>
                </div>
              )
            })}
          </div>
      }
      <p className="dashboard-chart-note">每类记录独立计数；登记、核验、收款不是转化漏斗，也不能相加算成交。</p>
    </section>
  )
}
