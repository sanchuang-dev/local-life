// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mockHealthFetch, renderAdmin, setViewportWidth } from '../test/render-admin'
import { resetWorkTabs } from '../shared/lib/work-tabs'
import { listActivities, listAdminCommunities } from '../services/activities'
import { listAdminLocalOrders } from '../services/localOrders'
import { listUserDirectory } from '../services/users'
import { getLedgerOverview } from '../services/ledger'

vi.mock('../services/activities', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/activities')>(),
  listActivities: vi.fn(),
  listAdminCommunities: vi.fn(),
}))
vi.mock('../services/localOrders', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/localOrders')>(),
  listAdminLocalOrders: vi.fn(),
}))
vi.mock('../services/users', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/users')>(),
  listUserDirectory: vi.fn(),
}))
vi.mock('../services/ledger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/ledger')>(),
  getLedgerOverview: vi.fn(),
}))

function mockOperatingMetrics() {
  vi.mocked(listAdminCommunities).mockResolvedValue([])
  vi.mocked(listUserDirectory).mockResolvedValue({ items: [], total: 216, page: 1, pageSize: 1 })
  vi.mocked(listActivities).mockResolvedValue({ items: [], total: 8, page: 1, pageSize: 1 })
  vi.mocked(listAdminLocalOrders).mockResolvedValue({ items: [], total: 3, page: 1, pageSize: 1 })
  vi.mocked(getLedgerOverview).mockResolvedValue({
    payment: { receivedCents: 12600, reversedCents: 250 },
    openAnomalies: { count: 2 },
  } as Awaited<ReturnType<typeof getLedgerOverview>>)
}

describe('DashboardPage read-only operating cockpit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setViewportWidth(1024)
    mockHealthFetch()
    mockOperatingMetrics()
  })

  afterEach(() => {
    resetWorkTabs()
    vi.unstubAllGlobals()
    setViewportWidth(1024)
  })

  it('reads server-scoped totals and ledger facts without manufacturing metrics', async () => {
    renderAdmin('/')

    expect(await screen.findByRole('heading', { name: '经营工作台' })).toBeTruthy()
    expect(screen.queryByText('已验证身份')).toBeNull()
    await waitFor(() => expect(screen.getByText('216')).toBeTruthy())
    expect(screen.getByText('8')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '近 7 日实收走势' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '经营事实分布' })).toBeTruthy()
    // Removed presentation blocks must stay gone; side navigation owns shortcuts.
    expect(screen.queryByRole('region', { name: '当前工作身份' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '优先处理' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '经营事实' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '快捷前往' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '经营概况' })).toBeNull()
    expect(screen.queryByText('来自真实业务接口，按当前账户权限统计')).toBeNull()
    expect(screen.queryByText('当前数据 · 非模拟')).toBeNull()

    expect(vi.mocked(listActivities)).toHaveBeenCalledWith(
      { page: 1, pageSize: 1, status: 'published' }, expect.any(AbortSignal),
    )
    expect(vi.mocked(listAdminLocalOrders)).toHaveBeenCalledWith(
      { page: 1, pageSize: 1, status: 'pending_review' }, expect.any(AbortSignal),
    )
    expect(vi.mocked(getLedgerOverview)).toHaveBeenCalledWith({}, expect.any(AbortSignal))
  })

  it('keeps an unavailable service unknown and retries without inventing a zero', async () => {
    vi.mocked(listAdminLocalOrders).mockRejectedValue(new Error('503'))
    renderAdmin('/')

    await waitFor(() => expect(screen.getByRole('button', { name: '待人工核验订单，查看详情' }).textContent).toContain('数据暂不可用'))
    const order = screen.getByRole('button', { name: '待人工核验订单，查看详情' })
    expect(order.textContent).toContain('—')
    expect(order.textContent).not.toContain('0')

    vi.mocked(listAdminLocalOrders).mockResolvedValue({ items: [], total: 2, page: 1, pageSize: 1 })
    fireEvent.click(screen.getByRole('button', { name: /刷新数据/ }))
    await waitFor(() => expect(order.textContent).toContain('2'))
    expect(vi.mocked(listAdminLocalOrders)).toHaveBeenCalledTimes(2)
  })
})
