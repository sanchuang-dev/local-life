// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { LedgerOverview } from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { PerformancePage } from './PerformancePage'

/**
 * 业绩总览 is the aggregate surface only. These tests pin the accounting rules
 * (six fact kinds never collapsed, no payable figure) and the page boundary:
 * the overview issues no entry/anomaly request and never grows an order form.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const GRID_ID = '123e4567-e89b-42d3-a456-426614174002'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740b2', name: '阳光社区' }

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_ID, displayName: '测试管理员' },
  staff: { id: STAFF_ID, username: 'testadmin', role: 'admin', communities: [] },
  csrfToken: 'csrf-token-for-overview-tests',
}

const OPERATOR_SESSION: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: {
    id: STAFF_ID,
    username: 'operator.a',
    role: 'operator',
    communities: [COMMUNITY_A],
  },
}

const GRID_SESSION: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: {
    id: STAFF_ID,
    username: 'grid.a',
    role: 'grid_worker',
    communities: [COMMUNITY_A],
  },
}

const FILTER_OPTIONS = {
  communities: [COMMUNITY_A, COMMUNITY_B],
  staff: [
    { id: GRID_ID, displayName: '网格员甲', role: 'grid_worker', communities: [COMMUNITY_A] },
  ],
  leadStatuses: [],
  leadSourceTypes: [],
  businessTypes: [],
  orderStatuses: [],
}

/** Six buckets whose sum (¥174.20) is deliberately never rendered. */
function overview(overrides: Partial<LedgerOverview> = {}): LedgerOverview {
  return {
    asOf: '2026-11-07T04:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    amountStatus: 'pending_rule',
    buckets: [
      { factKind: 'order_registered', entryCount: 2, grossAmountCents: 7960 },
      { factKind: 'order_verified', entryCount: 1, grossAmountCents: 3980 },
      { factKind: 'payment_received', entryCount: 1, grossAmountCents: 3980 },
      { factKind: 'payment_reversed', entryCount: 0, grossAmountCents: 0 },
      { factKind: 'reward_cost', entryCount: 1, grossAmountCents: 1500 },
      { factKind: 'reward_reversed', entryCount: 0, grossAmountCents: 0 },
    ],
    totals: { entryCount: 5, grossAmountCents: 17420 },
    attributed: { entryCount: 4, amountCents: 15920 },
    pendingAttribution: { entryCount: 1, amountCents: 1500 },
    openAnomalies: { count: 1 },
    payment: { receivedCents: 3980, reversedCents: 0 },
    reward: { costCents: 1500, reversedCents: 0 },
    ...overrides,
  }
}

function emptyOverview(): LedgerOverview {
  return overview({
    buckets: [
      { factKind: 'order_registered', entryCount: 0, grossAmountCents: 0 },
      { factKind: 'order_verified', entryCount: 0, grossAmountCents: 0 },
      { factKind: 'payment_received', entryCount: 0, grossAmountCents: 0 },
      { factKind: 'payment_reversed', entryCount: 0, grossAmountCents: 0 },
      { factKind: 'reward_cost', entryCount: 0, grossAmountCents: 0 },
      { factKind: 'reward_reversed', entryCount: 0, grossAmountCents: 0 },
    ],
    totals: { entryCount: 0, grossAmountCents: 0 },
    attributed: { entryCount: 0, amountCents: 0 },
    pendingAttribution: { entryCount: 0, amountCents: 0 },
    openAnomalies: { count: 0 },
    payment: { receivedCents: 0, reversedCents: 0 },
    reward: { costCents: 0, reversedCents: 0 },
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface FetchCall {
  url: string
  init?: RequestInit
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

function stubApi(routes: ReadonlyArray<readonly [string, Handler]>): FetchCall[] {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const match = routes.find(([prefix]) => url.startsWith(prefix))
    if (!match) throw new Error(`unexpected fetch: ${url}`)
    return match[1](url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

function renderPage(session: AuthenticatedSession, initialEntry = '/performance') {
  const router = createMemoryRouter(
    [
      { path: '/performance', element: <PerformancePage /> },
      { path: '/performance/ledger', element: <div>经营流水页</div> },
    ],
    { initialEntries: [initialEntry] },
  )
  const result = render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider
          value={{ session, busy: false, error: null, onLogout: async () => undefined }}
        >
          <RouterProvider router={router} />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
  return { ...result, router }
}

function overviewUrls(calls: FetchCall[]): string[] {
  return calls.map((call) => call.url).filter((url) => url.startsWith('/api/admin/ledger/overview'))
}

function expectNoLedgerListRequests(calls: FetchCall[]) {
  for (const url of calls.map((call) => call.url)) {
    expect(url).not.toContain('/admin/ledger/entries')
    expect(url).not.toContain('/admin/ledger/anomalies')
  }
}

/** Opens an antd Select and clicks the wanted option. */
async function chooseOption(combobox: Element, optionLabel: string) {
  fireEvent.mouseDown(combobox)
  const option = (await screen.findAllByText(optionLabel)).find((element) =>
    element.closest('.ant-select-item-option'),
  )
  expect(option, `option ${optionLabel} must be offered by the select`).toBeTruthy()
  fireEvent.click(option as Element)
}

async function pickDateRange(start: string, end: string) {
  const startInput = screen.getAllByPlaceholderText('开始日期')[0] as HTMLInputElement
  fireEvent.mouseDown(startInput)
  fireEvent.focus(startInput)
  fireEvent.change(startInput, { target: { value: start } })
  fireEvent.keyDown(startInput, { key: 'Enter', code: 'Enter', keyCode: 13 })
  const endInput = screen.getAllByPlaceholderText('结束日期')[0] as HTMLInputElement
  fireEvent.focus(endInput)
  fireEvent.change(endInput, { target: { value: end } })
  fireEvent.keyDown(endInput, { key: 'Enter', code: 'Enter', keyCode: 13 })
}

function stubBaseline(): ReadonlyArray<readonly [string, Handler]> {
  return [
    ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
    ['/api/admin/ledger/overview', () => json(overview())],
  ]
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 1280,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PerformancePage permission boundary', () => {
  it('renders the grid-worker lockout and issues zero ledger requests', async () => {
    const calls = stubApi([
      [
        '/api/',
        (url) => {
          throw new Error(`grid worker must not call the ledger API: ${url}`)
        },
      ],
    ])

    renderPage(GRID_SESSION)

    expect(await screen.findByText(/网格员没有后台业绩总览权限/)).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('shows the real 403 instead of an empty successful report', async () => {
    stubApi([
      ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
      [
        '/api/admin/ledger/overview',
        () => json({ error: { code: 'forbidden', message: '网格员无权访问经营流水管理接口' } }, 403),
      ],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('没有经营流水查看权限')).toBeTruthy()
    expect(screen.getByText('网格员无权访问经营流水管理接口')).toBeTruthy()
    expect(screen.queryByText('暂无经营总览数据')).toBeNull()
  })

  it('names an expired session instead of blaming the filter', async () => {
    stubApi([
      ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
      [
        '/api/admin/ledger/overview',
        () => json({ error: { code: 'unauthorized', message: '请先登录管理后台' } }, 401),
      ],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('登录状态已失效')).toBeTruthy()
    expect(screen.queryByText('没有经营流水查看权限')).toBeNull()
    expect(screen.queryByText('暂无经营总览数据')).toBeNull()
  })

  it('shows a server fault as a fault rather than as an empty report', async () => {
    stubApi([
      ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
      [
        '/api/admin/ledger/overview',
        () => json({ error: { code: 'internal_error', message: '数据库暂时不可用' } }, 500),
      ],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('经营总览加载失败')).toBeTruthy()
    expect(screen.getByText('数据库暂时不可用')).toBeTruthy()
    expect(screen.queryByText('暂无经营总览数据')).toBeNull()
  })
})

describe('PerformancePage report', () => {
  it('keeps the six fact kinds separate and never renders a cross-kind total', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('登记金额')).toBeTruthy()
    for (const kind of ['order_registered', 'order_verified', 'payment_received', 'reward_cost']) {
      expect(document.querySelector(`.ledger-kpi[data-fact-kind="${kind}"]`)).toBeTruthy()
    }
    expect(screen.getAllByText('已核验业绩').length).toBeGreaterThan(0)
    expect(screen.getAllByText('人工实收').length).toBeGreaterThan(0)
    expect(screen.getByText('奖励成本')).toBeTruthy()
    // Reversals are their own line, never a negative sign on the receipt.
    expect(screen.getByText(/收款冲正 ¥0\.00/)).toBeTruthy()
    expect(screen.getByText(/单独成行，不抵扣实收/)).toBeTruthy()
    expect(screen.getByText(/奖励冲正 ¥0\.00/)).toBeTruthy()
    // Pending attribution is reported, never counted as performance.
    expect(screen.getByTestId('ledger-attribution').textContent).toContain('待归属 1 笔')
    expect(screen.getByTestId('ledger-attribution').textContent).toContain('¥15.00')
    expect(screen.getByTestId('ledger-anomalies').textContent).toContain('未解决异常')
    expect(screen.getByTestId('ledger-anomalies').textContent).toContain('共 5 笔流水')

    // No settlement rule ⇒ 待核定, and no payable/commission wording anywhere.
    expect(screen.getAllByText(/待核定/).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/支付成功|已成交|已开通|已结算|佣金应付/)
    expect(document.body.textContent).not.toContain('174.20')
    expect(screen.queryByText('合计金额')).toBeNull()

    // The summary never turns into a list or an order/receipt form.
    expect(screen.queryByText('经营流水明细')).toBeNull()
    expect(screen.queryByText('订单实收凭据与业绩归属')).toBeNull()
    expectNoLedgerListRequests(calls)
    expect(overviewUrls(calls).length).toBe(1)
  })

  it('states the report instant, its time zone and that the server aggregated it', async () => {
    stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)

    expect(
      await screen.findByText(/数据截至 2026-11-07 12:00（Asia\/Shanghai）/),
    ).toBeTruthy()
  })

  it('tells the operator the server trims the scope and sends the assigned community', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(OPERATOR_SESSION)

    expect(await screen.findByText(/总览仅统计管理员分配的社区/)).toBeTruthy()
    await waitFor(() => {
      expect(overviewUrls(calls)[0]).toContain(`communityId=${COMMUNITY_A.id}`)
    })
  })

  it('renders zero metrics without inventing a total or a list', async () => {
    stubApi([
      ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
      ['/api/admin/ledger/overview', () => json(emptyOverview())],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('登记金额')).toBeTruthy()
    expect(screen.getByTestId('ledger-anomalies').textContent).toContain('未解决异常')
    expect(screen.getByTestId('ledger-anomalies').textContent).toContain('共 0 笔流水')
    expect(screen.getByText(/当前范围暂无经营流水/)).toBeTruthy()
    expect(screen.queryByText('当前筛选条件下没有经营流水。')).toBeNull()
  })

  it('does not claim an empty report while the first overview request is pending', async () => {
    let settleOverview!: (value: Response) => void
    const pendingOverview = new Promise<Response>((resolve) => {
      settleOverview = resolve
    })
    stubApi([
      ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
      ['/api/admin/ledger/overview', () => pendingOverview],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('正在读取经营总览…')).toBeTruthy()
    expect(screen.queryByText('暂无经营总览数据')).toBeNull()

    settleOverview(json(overview()))
    expect(await screen.findByText('登记金额')).toBeTruthy()
  })
})

describe('PerformancePage source sync', () => {
  it('syncs source facts and re-reads the overview so newly verified data appears', async () => {
    let syncCall: FetchCall | undefined
    let overviewReads = 0
    stubApi([
      ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
      [
        '/api/admin/ledger/overview',
        () => {
          overviewReads += 1
          return json(overviewReads === 1 ? emptyOverview() : overview())
        },
      ],
      [
        '/api/admin/ledger/sync',
        (url, init) => {
          syncCall = { url, init }
          return json({
            scanned: 4,
            created: 2,
            skipped: 2,
            sources: {
              localOrder: { scanned: 2, created: 1, skipped: 1 },
              crmServiceOrder: { scanned: 1, created: 1, skipped: 0 },
              activityRewardGrant: { scanned: 1, created: 0, skipped: 1 },
            },
          })
        },
      ],
    ])

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText(/当前范围暂无经营流水/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '同步来源事实' }))

    await waitFor(() => expect(syncCall).toBeTruthy())
    const sent = syncCall!
    expect(sent.url).toBe('/api/admin/ledger/sync')
    expect(sent.init?.method).toBe('POST')
    expect((sent.init!.headers as Record<string, string>)['x-csrf-token']).toBe(
      ADMIN_SESSION.csrfToken,
    )
    expect(await screen.findByText(/同步完成：新增 2 条/)).toBeTruthy()
    await waitFor(() => expect(overviewReads).toBeGreaterThan(1))
    await waitFor(() => {
      const registered = document.querySelector('[data-fact-kind="order_registered"]')
      expect(registered?.textContent).toContain('79.60')
    })
    expect(screen.queryByText(/当前范围暂无经营流水/)).toBeNull()
  })
})

describe('PerformancePage filters', () => {
  it('sends only the filters the overview contract supports', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await screen.findByText('登记金额')

    // The unfiltered first request carries no optional parameter at all.
    const initial = overviewUrls(calls)[0]!
    for (const param of ['from', 'to', 'communityId', 'staffId', 'factKind', 'keyword']) {
      expect(initial).not.toContain(`${param}=`)
    }

    await chooseOption(screen.getByLabelText('社区'), '幸福社区')
    await waitFor(() => {
      expect(overviewUrls(calls).at(-1)).toContain(`communityId=${COMMUNITY_A.id}`)
    })

    await chooseOption(screen.getByLabelText('业绩归属'), '网格员甲（网格员）')
    await waitFor(() => {
      expect(overviewUrls(calls).at(-1)).toContain(`staffId=${GRID_ID}`)
    })

    await pickDateRange('2026-11-01', '2026-11-07')
    await waitFor(
      () => {
        const url = overviewUrls(calls).at(-1)!
        expect(url).toContain('from=2026-11-01')
        expect(url).toContain('to=2026-11-07')
      },
      { timeout: 5000 },
    )

    const finalUrl = overviewUrls(calls).at(-1)!
    expect(finalUrl).toContain(`communityId=${COMMUNITY_A.id}`)
    expect(finalUrl).toContain(`staffId=${GRID_ID}`)
    expect(finalUrl).not.toContain('factKind=')
    expect(finalUrl).not.toContain('anomalyOnly=')
    expectNoLedgerListRequests(calls)
  })

  it('resets scope to the operator default without widening it', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(OPERATOR_SESSION)
    await screen.findByText('登记金额')
    await chooseOption(screen.getByLabelText('业绩归属'), '网格员甲（网格员）')
    await waitFor(() => expect(overviewUrls(calls).at(-1)).toContain(`staffId=${GRID_ID}`))

    fireEvent.click(await screen.findByRole('button', { name: '重置筛选' }))
    await waitFor(() => {
      const url = overviewUrls(calls).at(-1)!
      expect(url).toContain(`communityId=${COMMUNITY_A.id}`)
      expect(url).not.toContain('staffId=')
    })
  })

  it('jumps to the anomaly-only ledger list', async () => {
    stubApi(stubBaseline())

    const { router } = renderPage(ADMIN_SESSION)
    await screen.findByText('登记金额')

    fireEvent.click(screen.getByRole('button', { name: '查看异常流水' }))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/performance/ledger')
      expect(router.state.location.search).toContain('anomalyOnly=true')
    })
  })

  it('carries the current community, date and staff scope into the anomaly list', async () => {
    const calls = stubApi(stubBaseline())

    const { router } = renderPage(ADMIN_SESSION)
    await screen.findByText('登记金额')

    await chooseOption(screen.getByLabelText('社区'), '幸福社区')
    await chooseOption(screen.getByLabelText('业绩归属'), '网格员甲（网格员）')
    await pickDateRange('2026-11-01', '2026-11-07')
    await waitFor(
      () => {
        const url = overviewUrls(calls).at(-1)!
        expect(url).toContain('from=2026-11-01')
        expect(url).toContain('to=2026-11-07')
      },
      { timeout: 5000 },
    )

    fireEvent.click(screen.getByRole('button', { name: '查看异常流水' }))

    await waitFor(() => {
      const params = new URL(router.state.location.search, 'http://test.local').searchParams
      expect(params.get('anomalyOnly')).toBe('true')
      expect(params.get('communityId')).toBe(COMMUNITY_A.id)
      expect(params.get('staffId')).toBe(GRID_ID)
      expect(params.get('from')).toBe('2026-11-01')
      expect(params.get('to')).toBe('2026-11-07')
    })
  })
})
