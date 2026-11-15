// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { LedgerAnomaly, LedgerEntry } from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { LedgerPage } from './LedgerPage'

/**
 * 经营流水 is the query/detail surface of the ledger. It must keep server-side
 * paging and every supported filter, report failures honestly, and never call
 * the aggregate endpoint owned by 业绩总览.
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

function renderPage(session: AuthenticatedSession, initialEntry = '/performance/ledger') {
  const router = createMemoryRouter([{ path: '/performance/ledger', element: <LedgerPage /> }], {
    initialEntries: [initialEntry],
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

function urls(calls: FetchCall[]): string[] {
  return calls.map((call) => call.url)
}

function entryUrls(calls: FetchCall[]): string[] {
  return urls(calls).filter((url) => url.startsWith('/api/admin/ledger/entries?'))
}

async function waitForList() {
  expect(await screen.findByText('ORD-20261101-0001')).toBeTruthy()
}

/** The advanced-filter modal is force-rendered, so each label appears twice. */
function firstLabel(text: string): HTMLElement {
  const elements = screen.getAllByLabelText(text)
  expect(elements.length).toBeGreaterThan(0)
  return elements[0] as HTMLElement
}

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

function stubBaseline(
  entries: LedgerEntry[] = [entry(), paymentEntry()],
): ReadonlyArray<readonly [string, Handler]> {
  return [
    ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
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

function expectNoOverviewRequest(calls: FetchCall[]) {
  expect(urls(calls).some((url) => url.includes('/admin/ledger/overview'))).toBe(false)
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

describe('LedgerPage permission boundary', () => {
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

    expect(await screen.findByText('网格员没有后台经营流水权限')).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('shows the real 403 instead of an empty successful list', async () => {
    const forbidden = () =>
      json({ error: { code: 'forbidden', message: '网格员无权访问经营流水管理接口' } }, 403)
    stubApi([
      ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
      ['/api/admin/ledger/entries?', forbidden],
      ['/api/admin/ledger/anomalies', forbidden],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('没有经营流水查看权限')).toBeTruthy()
    expect(screen.getByText('网格员无权访问经营流水管理接口')).toBeTruthy()
    expect(screen.queryByText('当前筛选条件下没有经营流水。')).toBeNull()
  })

  it('names an expired session and a server fault instead of an empty list', async () => {
    const expired = () =>
      json({ error: { code: 'unauthorized', message: '请先登录管理后台' } }, 401)
    stubApi([
      ['/api/admin/crm/filter-options', expired],
      ['/api/admin/ledger/entries?', expired],
      ['/api/admin/ledger/anomalies', expired],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('登录状态已失效')).toBeTruthy()
    expect(screen.queryByText('当前筛选条件下没有经营流水。')).toBeNull()
  })

  it('shows a server fault as a fault rather than an empty ledger', async () => {
    const broken = () =>
      json({ error: { code: 'internal_error', message: '数据库暂时不可用' } }, 500)
    stubApi([
      ['/api/admin/crm/filter-options', broken],
      ['/api/admin/ledger/entries?', broken],
      ['/api/admin/ledger/anomalies', broken],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('经营流水明细加载失败')).toBeTruthy()
    expect(screen.getAllByText(/数据库暂时不可用/).length).toBeGreaterThan(0)
    expect(screen.queryByText('当前筛选条件下没有经营流水。')).toBeNull()
  })
})

describe('LedgerPage list and detail', () => {
  it('pages on the server and sends only page/pageSize for an unfiltered view', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await waitForList()

    const url = entryUrls(calls)[0]!
    expect(url).toContain('page=1')
    expect(url).toContain('pageSize=20')
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
    expectNoOverviewRequest(calls)
  })

  it('sends each supported filter as its own query parameter', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await waitForList()

    await chooseOption(firstLabel('社区'), '幸福社区')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => {
      expect(entryUrls(calls).at(-1)).toContain(`communityId=${COMMUNITY_A.id}`)
    })

    await chooseOption(firstLabel('业绩归属网格员'), '网格员甲（网格员）')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => expect(entryUrls(calls).at(-1)).toContain(`staffId=${GRID_ID}`))

    await chooseOption(firstLabel('事实类型'), '人工实收')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => {
      expect(entryUrls(calls).at(-1)).toContain('factKind=payment_received')
    })

    await chooseOption(firstLabel('来源系统'), '人工登记')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => expect(entryUrls(calls).at(-1)).toContain('sourceSystem=manual'))

    fireEvent.change(firstLabel('来源单号'), { target: { value: 'RCPT-0001' } })
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => expect(entryUrls(calls).at(-1)).toContain('keyword=RCPT-0001'))

    await chooseOption(firstLabel('未解决异常'), '仅看有未解决异常的流水')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => expect(entryUrls(calls).at(-1)).toContain('anomalyOnly=true'))

    // Every earlier narrowing survives the later ones.
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
    await waitForList()

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
  })

  it('starts from the overview scope when the overview links here', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(
      ADMIN_SESSION,
      `/performance/ledger?anomalyOnly=true&communityId=${COMMUNITY_A.id}` +
        `&staffId=${GRID_ID}&from=2026-11-01&to=2026-11-07`,
    )
    await waitForList()

    await waitFor(() => {
      const url = entryUrls(calls)[0]!
      expect(url).toContain('anomalyOnly=true')
      expect(url).toContain(`communityId=${COMMUNITY_A.id}`)
      expect(url).toContain(`staffId=${GRID_ID}`)
      expect(url).toContain('from=2026-11-01')
      expect(url).toContain('to=2026-11-07')
    })
    expect(firstLabel('未解决异常')).toBeTruthy()
  })

  it('does not let a crafted deep link widen an operator community scope', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(
      OPERATOR_SESSION,
      `/performance/ledger?communityId=${COMMUNITY_B.id}&staffId=${GRID_ID}` +
        '&from=invalid&to=2026-11-07',
    )
    await waitForList()

    await waitFor(() => {
      const url = entryUrls(calls)[0]!
      expect(url).toContain(`communityId=${COMMUNITY_A.id}`)
      expect(url).not.toContain(COMMUNITY_B.id)
      expect(url).toContain(`staffId=${GRID_ID}`)
      expect(url).toContain('to=2026-11-07')
      expect(url).not.toContain('from=')
    })
  })

  it('shortens a UUID source id in the list while preserving the full copyable value', async () => {
    const fullId = '123e4567-e89b-42d3-a456-4266141740f7'
    stubApi(
      stubBaseline([
        entry({
          factKind: 'order_verified',
          sourceSystem: 'crm_service_order',
          sourceId: 'crm-order-1',
          sourceDisplayNo: fullId,
          verifiedAt: '2026-11-01T03:00:00.000Z',
        }),
      ]),
    )

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText(`${fullId.slice(0, 8)}…`)).toBeTruthy()
    expect(screen.getByTitle(fullId)).toBeTruthy()
    expect(screen.queryByText(fullId)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '详情' }))
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText(fullId)).toBeTruthy()
    expect(drawer.querySelectorAll('.ant-typography-copy').length).toBeGreaterThan(0)
  })

  it('renders the entry drawer from the list row and its unresolved anomalies', async () => {
    stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await waitForList()

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]!)

    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('流水详情 · 登记金额')).toBeTruthy()
    // Flat drawer: no nested card sections and no bordered Descriptions.
    expect(drawer.querySelector('.local-section')).toBeNull()
    expect(drawer.querySelector('.ant-descriptions-bordered')).toBeNull()
    expect(drawer.querySelector('.ledger-detail-summary')).toBeTruthy()
    expect(drawer.querySelector('.ledger-detail-amount')?.textContent).toContain('¥39.80')
    expect(within(drawer).getByText('ORD-20261101-0001')).toBeTruthy()
    expect(
      within(drawer).getByText(/账面登记毛额 · 待核定（本 MVP 无结算规则，不据此计算应付）/),
    ).toBeTruthy()
    expect(within(drawer).getByText('依据：来源显式归属')).toBeTruthy()
    expect(within(drawer).getByText('金额不一致')).toBeTruthy()
    expect(within(drawer).getByText('登记金额与收据金额不一致，待人工核对')).toBeTruthy()
  })

  it('shows the evidence and handling-staff rule of a manual receipt', async () => {
    stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await waitForList()

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[1]!)

    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('流水详情 · 人工实收')).toBeTruthy()
    expect(within(drawer).getByText('转账凭据')).toBeTruthy()
    expect(within(drawer).getByText('转账流水尾号 4821')).toBeTruthy()
    expect(within(drawer).getByText('无未解决异常')).toBeTruthy()
  })

  it('keeps explicit source syncing with CSRF and refreshes the list', async () => {
    let syncCall: FetchCall | undefined
    const calls = stubApi([
      ...stubBaseline(),
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
    await waitForList()
    const before = entryUrls(calls).length

    fireEvent.click(screen.getByRole('button', { name: '同步来源事实' }))

    await waitFor(() => expect(syncCall).toBeTruthy())
    const sent = syncCall!
    expect(sent.init?.method).toBe('POST')
    expect((sent.init!.headers as Record<string, string>)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(await screen.findByText(/同步完成：新增 2 条/)).toBeTruthy()
    await waitFor(() => expect(entryUrls(calls).length).toBeGreaterThan(before))
  })

  it('renders an honest empty state without inventing rows', async () => {
    stubApi([
      ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
      [
        '/api/admin/ledger/entries?',
        () => json({ items: [], total: 0, page: 1, pageSize: 20, asOf: '2026-11-07T04:00:00.000Z' }),
      ],
      ['/api/admin/ledger/anomalies', () => json({ items: [], asOf: '2026-11-07T04:00:00.000Z' })],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('当前筛选条件下没有经营流水。')).toBeTruthy()
  })
})
