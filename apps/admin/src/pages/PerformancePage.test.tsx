// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { LedgerAnomaly, LedgerEntry, LedgerOverview } from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { PerformancePage } from './PerformancePage'

/**
 * Drives the real 业绩看板 against an explicitly stubbed `fetch`.
 *
 * The assertions are about *accounting* correctness, not pixels:
 *
 * - the six fact kinds stay separate (no cross-kind total is rendered anywhere);
 * - every rendered amount is a 账面登记毛额 with a 待核定 settlement status;
 * - every filter goes into the query string the server actually implements, one
 *   parameter at a time (a filter the API would `400` must not be sent);
 * - a grid worker never issues a single `/admin/ledger/*` request.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const GRID_ID = '123e4567-e89b-42d3-a456-426614174002'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740b2', name: '阳光社区' }
const PRODUCT_ID = '123e4567-e89b-42d3-a456-4266141740c3'
const ENTRY_REGISTERED = '123e4567-e89b-42d3-a456-4266141740d4'
const ENTRY_PAYMENT = '123e4567-e89b-42d3-a456-4266141740e5'
const ANOMALY_ID = '123e4567-e89b-42d3-a456-4266141740f6'
const CSRF_TOKEN = 'csrf-token-for-ledger-page-tests'

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_ID, displayName: '测试管理员' },
  staff: { id: STAFF_ID, username: 'testadmin', role: 'admin', communities: [] },
  csrfToken: CSRF_TOKEN,
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

/**
 * A real `ledgerEntrySchema` row: `order_registered` from a local order, with an
 * explicit attribution so 「已归属」 is a fact rather than an assumption.
 */
function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    entryId: ENTRY_REGISTERED,
    factKind: 'order_registered',
    sourceSystem: 'local_order',
    sourceId: 'local-order-0001',
    sourceDisplayNo: 'ORD-20261101-0001',
    communityId: COMMUNITY_A.id,
    productId: PRODUCT_ID,
    occurredAt: '2026-11-01T02:00:00.000Z',
    verifiedAt: null,
    amountCents: 3980,
    settlementAmountStatus: 'pending_rule',
    attribution: {
      state: 'attributed',
      staffId: GRID_ID,
      communityId: COMMUNITY_A.id,
      basis: 'explicit_attribution',
    },
    evidence: { kind: 'none', ref: null },
    counterEntryId: null,
    batchId: null,
    reconciliationState: 'unreconciled',
    recordedByUserId: null,
    recordedByStaffId: null,
    createdAt: '2026-11-01T02:05:00.000Z',
    ...overrides,
  }
}

/** A manual receipt: evidence + handling staff are contract requirements. */
function paymentEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return entry({
    entryId: ENTRY_PAYMENT,
    factKind: 'payment_received',
    sourceSystem: 'manual',
    sourceId: 'manual-receipt-0001',
    sourceDisplayNo: 'RCPT-0001',
    productId: null,
    amountCents: 3980,
    attribution: {
      state: 'pending',
      staffId: null,
      communityId: COMMUNITY_A.id,
      basis: 'no_explicit_attribution',
    },
    evidence: { kind: 'bank_transfer', ref: '转账流水尾号 4821' },
    recordedByStaffId: STAFF_ID,
    ...overrides,
  })
}

/**
 * Six buckets, each internally consistent with `ledgerOverviewSchema`:
 * bucket sums == totals, attributed + pending == totals, payment/reward mirror
 * their buckets. `totals.grossAmountCents` deliberately matches no single card,
 * so the page cannot pass this test by printing the total.
 */
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

function anomaly(overrides: Partial<LedgerAnomaly> = {}): LedgerAnomaly {
  return {
    anomalyId: ANOMALY_ID,
    entryId: ENTRY_REGISTERED,
    kind: 'amount_mismatch',
    severity: 'high',
    note: '登记金额与收据金额不一致，待人工核对',
    flaggedByUserId: USER_ID,
    resolvedAt: null,
    createdAt: '2026-11-02T03:00:00.000Z',
    ...overrides,
  }
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

/** Ordered prefix stub; an unlisted URL throws so a stray request cannot pass. */
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

function renderPage(session: AuthenticatedSession) {
  const router = createMemoryRouter([{ path: '/performance', element: <PerformancePage /> }], {
    initialEntries: ['/performance'],
  })
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

function calledUrls(calls: FetchCall[]): string[] {
  return calls.map((call) => call.url)
}

function entryUrls(calls: FetchCall[]): string[] {
  return calledUrls(calls).filter((url) => url.startsWith('/api/admin/ledger/entries?'))
}

function overviewUrls(calls: FetchCall[]): string[] {
  return calledUrls(calls).filter((url) => url.startsWith('/api/admin/ledger/overview'))
}

/** The advanced-filter modal is force-rendered, so each label appears twice. */
function firstLabel(text: string): HTMLElement {
  const elements = screen.getAllByLabelText(text)
  expect(elements.length).toBeGreaterThan(0)
  return elements[0] as HTMLElement
}

/**
 * `登记金额` appears both as a KPI title and as the fact-kind tag of a list row.
 * Waiting for *both* is the only honest readiness signal: the report and the list
 * are independent requests and either one can land first.
 */
async function waitForReportAndList() {
  expect((await screen.findAllByText('登记金额')).length).toBeGreaterThan(0)
  await waitFor(() => expect(screen.getAllByText('登记金额').length).toBeGreaterThan(1))
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

/**
 * Types a business-date range and commits it. antd's RangePicker emits a value
 * only once the typed text is committed (Enter), which is what a keyboard user
 * does; clicking a calendar cell would make the test depend on "today".
 */
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

function stubBaseline(
  entries: LedgerEntry[] = [entry(), paymentEntry()],
): ReadonlyArray<readonly [string, Handler]> {
  return [
    ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
    ['/api/admin/ledger/overview', () => json(overview())],
    [
      '/api/admin/ledger/entries?',
      () =>
        json({
          items: entries,
          total: entries.length,
          page: 1,
          pageSize: 20,
          asOf: '2026-11-07T04:00:00.000Z',
        }),
    ],
    [
      '/api/admin/ledger/anomalies',
      () => json({ items: [anomaly()], asOf: '2026-11-07T04:00:00.000Z' }),
    ],
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

    expect(await screen.findByText('网格员没有后台业绩看板权限')).toBeTruthy()
    expect(screen.getByText(/服务端同样返回 403/)).toBeTruthy()
    // The refusal is enforced by the API; the page must not even try.
    expect(calls).toEqual([])
  })

  it('shows the real 403 instead of an empty successful report', async () => {
    const forbidden = () =>
      json({ error: { code: 'forbidden', message: '网格员无权访问经营流水管理接口' } }, 403)
    stubApi([
      ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
      ['/api/admin/ledger/overview', forbidden],
      ['/api/admin/ledger/entries?', forbidden],
      ['/api/admin/ledger/anomalies', forbidden],
    ])

    renderPage(ADMIN_SESSION)

    // Both the KPI block and the detail table report the refusal by name; neither
    // degrades into an empty (and therefore believable) zero.
    await waitFor(() =>
      expect(screen.getAllByText('没有经营流水查看权限').length).toBeGreaterThanOrEqual(2),
    )
    // The API's own message is surfaced as well, so an operator can tell the admin
    // exactly which endpoint refused them.
    expect(screen.getAllByText(/网格员无权访问经营流水管理接口/).length).toBeGreaterThan(0)
    expect(screen.queryByText('经营总览')).toBeNull()
    expect(screen.queryByText('当前筛选条件下没有经营流水。')).toBeNull()
  })

  it('names an expired session instead of blaming the filter', async () => {
    const expired = () =>
      json({ error: { code: 'unauthorized', message: '请先登录管理后台' } }, 401)
    stubApi([
      ['/api/admin/crm/filter-options', expired],
      ['/api/admin/ledger/overview', expired],
      ['/api/admin/ledger/entries?', expired],
      ['/api/admin/ledger/anomalies', expired],
    ])

    renderPage(ADMIN_SESSION)

    // A 401 is not an empty report and not a "no permission" dead end: the only
    // useful next step is logging in again, so the page says exactly that.
    await waitFor(() =>
      expect(screen.getAllByText('登录状态已失效').length).toBeGreaterThanOrEqual(2),
    )
    expect(screen.queryByText('没有经营流水查看权限')).toBeNull()
    expect(screen.queryByText('暂无经营总览数据')).toBeNull()
  })

  it('shows a server fault as a fault rather than as an empty ledger', async () => {
    const broken = () =>
      json({ error: { code: 'internal_error', message: '数据库暂时不可用' } }, 500)
    stubApi([
      ['/api/admin/crm/filter-options', broken],
      ['/api/admin/ledger/overview', broken],
      ['/api/admin/ledger/entries?', broken],
      ['/api/admin/ledger/anomalies', broken],
    ])

    renderPage(ADMIN_SESSION)

    // A 500 must never be rendered as a successful empty state: 「暂无」 would tell
    // the operator the ledger is empty when in fact nobody could read it.
    expect(await screen.findByText('经营总览加载失败')).toBeTruthy()
    await waitFor(() =>
      expect(screen.getAllByText('经营流水明细加载失败').length).toBeGreaterThan(0),
    )
    expect(screen.getAllByText(/数据库暂时不可用/).length).toBeGreaterThan(0)
    expect(screen.queryByText('当前筛选条件下没有经营流水。')).toBeNull()
    expect(screen.queryByText('暂无经营总览数据')).toBeNull()
  })
})

describe('PerformancePage report', () => {
  it('keeps the six fact kinds separate and never renders a cross-kind total', async () => {
    stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('经营总览')).toBeTruthy()
    // Each money kind has its own card and its own 口径 sentence.
    for (const kind of ['order_registered', 'order_verified', 'payment_received', 'reward_cost']) {
      expect(document.querySelector(`.ledger-kpi[data-fact-kind="${kind}"]`)).toBeTruthy()
    }
    expect(screen.getAllByText('登记金额').length).toBeGreaterThan(0)
    expect(screen.getAllByText('已核验业绩').length).toBeGreaterThan(0)
    expect(screen.getAllByText('人工实收').length).toBeGreaterThan(0)
    expect(screen.getAllByText('奖励成本').length).toBeGreaterThan(0)
    // Reversals are their own line, never a negative sign on the receipt.
    expect(screen.getByText(/收款冲正 ¥0\.00（0 笔，单独成行，不抵扣实收）/)).toBeTruthy()
    expect(screen.getByText(/奖励冲正 ¥0\.00（0 笔，单独成行）/)).toBeTruthy()
    // 待归属 is reported as a fact, and the KPI never claims it as performance.
    expect(screen.getByText(/待归属 1 笔 · ¥15\.00/)).toBeTruthy()

    // No settlement rule ⇒ 待核定, and no payable/commission wording anywhere.
    expect(screen.getAllByText('待核定').length).toBeGreaterThan(0)
    expect(screen.queryByText('应付佣金')).toBeNull()
    expect(document.body.textContent).not.toMatch(/支付成功|已成交|已开通|已结算|佣金应付/)

    // The aggregate of the six buckets (¥174.20) must never be printed: adding
    // 登记金额 and 已核验业绩 would describe the same order twice.
    expect(document.body.textContent).not.toContain('174.20')
    expect(screen.queryByText('合计金额')).toBeNull()
  })

  it('states the report instant, its time zone and that the server aggregated it', async () => {
    stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)

    expect(
      await screen.findByText(/数据截至 2026-11-07 12:00（Asia\/Shanghai）· 服务端聚合/),
    ).toBeTruthy()
    // 11-07 04:00Z is 12:00 in Shanghai, so a browser-zone rendering would fail.
  })

  it('tells the operator the server trims the scope and cannot be widened by the UI', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(OPERATOR_SESSION)

    expect(await screen.findByText(/仅能查看管理员分配的社区/)).toBeTruthy()
    expect(screen.getByText(/前端筛选无法扩大可见范围/)).toBeTruthy()
    await waitFor(() => {
      const url = overviewUrls(calls)[0]
      expect(url).toContain(`communityId=${COMMUNITY_A.id}`)
    })
  })

  it('renders the empty state without inventing a zero total', async () => {
    stubApi([
      ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
      [
        '/api/admin/ledger/overview',
        () =>
          json(
            overview({
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
            }),
          ),
      ],
      [
        '/api/admin/ledger/entries?',
        () => json({ items: [], total: 0, page: 1, pageSize: 20, asOf: '2026-11-07T04:00:00.000Z' }),
      ],
      ['/api/admin/ledger/anomalies', () => json({ items: [], asOf: '2026-11-07T04:00:00.000Z' })],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('当前筛选条件下没有经营流水。')).toBeTruthy()
    expect(screen.getByText(/未解决异常 0 条/)).toBeTruthy()
  })

  it('does not claim an empty report while the first overview request is pending', async () => {
    let settleOverview: ((value: Response) => void) | undefined
    let settleEntries: ((value: Response) => void) | undefined
    stubApi([
      ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
      [
        '/api/admin/ledger/overview',
        () =>
          new Promise<Response>((resolve) => {
            settleOverview = resolve
          }),
      ],
      [
        '/api/admin/ledger/entries?',
        () =>
          new Promise<Response>((resolve) => {
            settleEntries = resolve
          }),
      ],
      ['/api/admin/ledger/anomalies', () => json({ items: [], asOf: '2026-11-07T04:00:00.000Z' })],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('正在读取经营总览…')).toBeTruthy()
    expect(screen.queryByText('暂无经营总览数据')).toBeNull()
    expect(screen.queryByText('当前筛选条件下没有经营流水。')).toBeNull()

    settleOverview?.(json(overview()))
    settleEntries?.(
      json({ items: [entry()], total: 1, page: 1, pageSize: 20, asOf: '2026-11-07T04:00:00.000Z' }),
    )
    expect((await screen.findAllByText('登记金额')).length).toBeGreaterThan(0)
  })
})

describe('PerformancePage filters', () => {
  it('pages on the server and sends only page/pageSize for an unfiltered view', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)

    await waitFor(() => expect(entryUrls(calls).length).toBe(1))
    const url = entryUrls(calls)[0]!
    expect(url).toContain('page=1')
    expect(url).toContain('pageSize=20')
    // No filter has been applied, so none of the optional parameters may leak in.
    for (const param of [
      'from',
      'to',
      'communityId',
      'staffId',
      'factKind',
      'sourceSystem',
      'anomalyOnly',
      'keyword',
    ]) {
      expect(url).not.toContain(`${param}=`)
    }
  })

  it('sends each supported filter as its own query parameter', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await waitForReportAndList()

    // 社区
    await chooseOption(firstLabel('社区'), '幸福社区')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => {
      expect(entryUrls(calls).at(-1)).toContain(`communityId=${COMMUNITY_A.id}`)
    })

    // 业绩归属网格员 (attribution, not the recorder)
    await chooseOption(firstLabel('业绩归属网格员'), '网格员甲（网格员）')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => {
      const url = entryUrls(calls).at(-1)!
      expect(url).toContain(`staffId=${GRID_ID}`)
      expect(url).toContain(`communityId=${COMMUNITY_A.id}`)
    })

    // 事实类型
    await chooseOption(firstLabel('事实类型'), '人工实收')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => {
      expect(entryUrls(calls).at(-1)).toContain('factKind=payment_received')
    })

    // 来源系统
    await chooseOption(firstLabel('来源系统'), '人工登记')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => {
      expect(entryUrls(calls).at(-1)).toContain('sourceSystem=manual')
    })

    // 来源单号 keyword
    fireEvent.change(firstLabel('来源单号'), { target: { value: 'RCPT-0001' } })
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => {
      expect(entryUrls(calls).at(-1)).toContain('keyword=RCPT-0001')
    })

    // 未解决异常
    await chooseOption(firstLabel('未解决异常'), '仅看有未解决异常的流水')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => {
      expect(entryUrls(calls).at(-1)).toContain('anomalyOnly=true')
    })

    // Every earlier parameter is still carried: the panel merges filters instead
    // of replacing them, so a later search cannot silently drop a narrowing.
    const finalUrl = entryUrls(calls).at(-1)!
    expect(finalUrl).toContain(`communityId=${COMMUNITY_A.id}`)
    expect(finalUrl).toContain(`staffId=${GRID_ID}`)
    expect(finalUrl).toContain('factKind=payment_received')
    expect(finalUrl).toContain('sourceSystem=manual')
    expect(finalUrl).toContain('keyword=RCPT-0001')
    expect(finalUrl).toContain('anomalyOnly=true')
  })

  it('sends the business-date range as inclusive from/to business dates', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await waitForReportAndList()

    await pickDateRange('2026-11-01', '2026-11-07')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))

    await waitFor(
      () => {
        const url = entryUrls(calls).at(-1)!
        expect(url).toContain('from=2026-11-01')
        expect(url).toContain('to=2026-11-07')
      },
      { timeout: 5000 },
    )
    // The overview accepts the same time narrowing, so KPI and list agree.
    await waitFor(() => {
      const overviewUrl = overviewUrls(calls).at(-1)!
      expect(overviewUrl).toContain('from=2026-11-01')
      expect(overviewUrl).toContain('to=2026-11-07')
    })
  })

  it('does not keep fact-kind / source / keyword on the report request', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await waitForReportAndList()

    await chooseOption(firstLabel('事实类型'), '人工实收')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => expect(entryUrls(calls).at(-1)).toContain('factKind=payment_received'))

    // The overview query is a strictObject without `factKind`; sending it would be
    // a 400, and silently ignoring it would make the KPI contradict the list.
    const overviewUrl = overviewUrls(calls).at(-1)!
    expect(overviewUrl).not.toContain('factKind=')
    expect(overviewUrl).not.toContain('sourceSystem=')
    expect(overviewUrl).not.toContain('keyword=')
    expect(overviewUrl).not.toContain('anomalyOnly=')
  })

  it('jumps from the anomaly KPI to the anomaly-only list', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await waitForReportAndList()

    fireEvent.click(screen.getByRole('button', { name: '只看异常明细' }))

    await waitFor(() => {
      const url = entryUrls(calls).at(-1)!
      expect(url).toContain('anomalyOnly=true')
      expect(url).toContain('page=1')
    })
  })
})

describe('PerformancePage detail', () => {
  it('renders the entry drawer from the list row and its unresolved anomalies', async () => {
    stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await waitForReportAndList()

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]!)

    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('流水详情 · 登记金额')).toBeTruthy()
    expect(within(drawer).getByText('ORD-20261101-0001')).toBeTruthy()
    expect(
      within(drawer).getByText(/账面登记毛额 · 待核定（本 MVP 无结算规则，不据此计算应付）/),
    ).toBeTruthy()
    expect(within(drawer).getByText('依据：来源显式归属')).toBeTruthy()
    // The anomaly belongs to this entry and is a review hint, not a verdict.
    expect(within(drawer).getByText('金额不一致')).toBeTruthy()
    expect(within(drawer).getByText('登记金额与收据金额不一致，待人工核对')).toBeTruthy()
  })

  it('shows the evidence and handling-staff rule of a manual receipt', async () => {
    stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await waitForReportAndList()

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[1]!)

    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('流水详情 · 人工实收')).toBeTruthy()
    expect(within(drawer).getByText('转账凭据')).toBeTruthy()
    expect(within(drawer).getByText('转账流水尾号 4821')).toBeTruthy()
    expect(
      within(drawer).getByText('该笔流水没有未解决异常。异常是复核提示，不会修改流水本身。'),
    ).toBeTruthy()
  })
})
