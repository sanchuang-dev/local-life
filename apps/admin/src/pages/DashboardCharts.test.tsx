// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { LedgerOverview } from '@sanchuang-dev/local-life-contracts'
import { LedgerCompositionChart, LedgerTrendChart } from './DashboardCharts'
import { recentShanghaiBusinessDays } from './dashboardDates'

const kinds = [
  'order_registered', 'order_verified', 'payment_received',
  'payment_reversed', 'reward_cost', 'reward_reversed',
] as const

describe('Dashboard charts', () => {
  it('calculates 7 inclusive business dates in Shanghai across new year', () => {
    const dates = recentShanghaiBusinessDays(new Date('2025-12-31T16:15:00Z'))
    expect(dates).toEqual([
      '2025-12-26', '2025-12-27', '2025-12-28', '2025-12-29',
      '2025-12-30', '2025-12-31', '2026-01-01',
    ])
    expect(recentShanghaiBusinessDays(new Date('2026-01-01T15:59:59Z')).at(-1)).toBe('2026-01-01')
    expect(recentShanghaiBusinessDays(new Date('2026-01-01T16:00:00Z')).at(-1)).toBe('2026-01-02')
  })

  it('charts known receipts and reversals while leaving a failed date unplotted', () => {
    render(<LedgerTrendChart loading={false} points={[
      { day: '2026-11-11', receivedCents: 2500, reversedCents: 100 },
      { day: '2026-11-12', receivedCents: null, reversedCents: null },
      { day: '2026-11-13', receivedCents: 1300, reversedCents: 0 },
    ]}/>)
    const svg = screen.getByRole('img', { name: /最近七日登记实收与冲正趋势/ })
    expect(svg.getAttribute('aria-label')).toContain('2026-11-12 实收未知')
    expect(svg.getAttribute('aria-label')).toContain('2026-11-13 实收¥13')
    // No path is interpolated across the unknown November 12 data.
    const paths = svg.querySelectorAll('path')
    expect(paths[0]?.getAttribute('d')).toMatch(/^M [^L]+M /)
    expect(paths[1]?.getAttribute('d')).toMatch(/^M [^L]+M /)
  })

  it('shows unavailable state, not zero, when no daily result was loaded', () => {
    render(<LedgerTrendChart loading={false} points={[
      { day: '2026-11-13', receivedCents: null, reversedCents: null },
    ]}/>)
    expect(screen.getByRole('status').textContent).toContain('暂不可用')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows six separate ledger fact types rather than a conversion funnel', () => {
    const buckets = kinds.map((factKind, index) => ({
      factKind, entryCount: index + 1, grossAmountCents: 0,
    })) satisfies LedgerOverview['buckets']
    render(<LedgerCompositionChart buckets={buckets} loading={false}/>)
    const image = screen.getByRole('img', { name: /经营事实记录数/ })
    expect(image.getAttribute('aria-label')).toContain('订单登记1条')
    expect(image.getAttribute('aria-label')).toContain('奖励冲正6条')
    expect(within(screen.getByRole('region', { name: '经营事实分布' })).getByText(/不是转化漏斗/)).toBeTruthy()
  })
})
