// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type {
  ReconciliationBatch,
  SettlementCandidate,
  SettlementCandidateListResponse,
} from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { SettlementsPage } from './SettlementsPage'
import { SettlementCandidatePanel } from './SettlementCandidatePanel'

/**
 * Drives the real 分成结算单 candidate panel (#188) against a stubbed `fetch`.
 *
 * What these tests protect:
 *
 * - the tab is a page-local view: it adds no URL parameter, the default is
 *   经营对账, and the candidate endpoint is not called until 分成结算单 is opened;
 * - the panel only renders server DTO values: 待核定 is text (never ¥0/0%), a
 *   missing receipt is 「无收款凭据」 (never a zero amount), and no wording claims
 *   已付款/已结清/已核销;
 * - the page-scoped summary is labelled 「仅当前页」, with 实收 and 冲正 side by
 *   side and never netted;
 * - UUIDs stay in the drawer, where the copy affordance lives;
 * - loading, true-empty, filtered-empty, error, 401 and 403 are explicit states,
 *   and error offers a real retry.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_ID = '123e4567-e89b-42d3-a456-4266141740a1'
const ORDER_ID = '123e4567-e89b-42d3-a456-426614174101'
const ORDER_2_ID = '123e4567-e89b-42d3-a456-426614174102'
const ORDER_3_ID = '123e4567-e89b-42d3-a456-426614174103'
const PRODUCT_ID = '123e4567-e89b-42d3-a456-426614174201'
const PRODUCT_2_ID = '123e4567-e89b-42d3-a456-426614174202'
const RECEIPT_ENTRY_ID = '123e4567-e89b-42d3-a456-426614174301'
const RECEIPT_REVERSAL_ID = '123e4567-e89b-42d3-a456-426614174302'
const MAPPING_ID = '123e4567-e89b-42d3-a456-426614174401'
const SELLER_PARTY_ID = '123e4567-e89b-42d3-a456-426614174501'
const SANCHUANG_PARTY_ID = '123e4567-e89b-42d3-a456-426614174502'
const GUANGDIAN_PARTY_ID = '123e4567-e89b-42d3-a456-426614174503'
const CSRF_TOKEN = 'csrf-token-for-settlement-candidate-tests'
const BATCH_NO = 'RCN-20261101-0001'

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_ID, displayName: '测试管理员' },
  staff: { id: STAFF_ID, username: 'testadmin', role: 'admin', communities: [] },
  csrfToken: CSRF_TOKEN,
}

const COMMUNITY_A = { id: COMMUNITY_ID, name: '幸福社区' }
const COMMUNITY_B_ID = '123e4567-e89b-42d3-a456-4266141740a2'
const COMMUNITY_B = { id: COMMUNITY_B_ID, name: '和悦社区' }

/** Only a real authenticated session may offer community options. */
const COMMUNITY_SESSION: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: {
    ...ADMIN_SESSION.staff,
    role: 'operator',
    communities: [COMMUNITY_A, COMMUNITY_B],
  },
}

/**
 * A verified order with a receipt. `registeredAmountCents` (3980) and
 * `receipt.amountCents` (3500) deliberately differ so a test can prove the page
 * keeps 登记金额 and 凭据实收 in separate places instead of comparing them.
 */
function candidate(overrides: Partial<SettlementCandidate> = {}): SettlementCandidate {
  return {
    orderId: ORDER_ID,
    orderDisplayNo: 'ORD-20261102-0001',
    communityId: COMMUNITY_ID,
    productId: PRODUCT_ID,
    productName: '社区宽带体验套餐',
    orderStatus: 'verified',
    registeredAmountCents: 3980,
    couponDiscountCents: 0,
    netPayableCents: 3980,
    periodAt: '2026-11-02T03:04:05.000Z',
    periodSource: 'linked_receipt',
    sellerStatus: 'verified',
    orderParty: {
      orderId: ORDER_ID,
      mappingId: MAPPING_ID,
      sellerPartyId: SELLER_PARTY_ID,
      sanchuangPartyId: SANCHUANG_PARTY_ID,
      guangdianPartyId: GUANGDIAN_PARTY_ID,
      agreementRef: 'AG-2026-001',
      confirmationRef: 'CONF-2026-001',
      confirmedByUserId: USER_ID,
      confirmedAt: '2026-11-03T02:00:00.000Z',
    },
    receipt: {
      entryId: RECEIPT_ENTRY_ID,
      amountCents: 3500,
      receivedAt: '2026-11-02T03:04:05.000Z',
      evidenceKind: 'bank_transfer',
      evidenceRef: 'BANK-20261102-001',
      recordedByStaffId: STAFF_ID,
      attribution: {
        state: 'attributed',
        staffId: STAFF_ID,
        communityId: COMMUNITY_ID,
        basis: 'explicit_attribution',
      },
      reversedEntryId: null,
      confirmation: {
        reviewedByUserId: USER_ID,
        reviewedByName: null,
        staffId: STAFF_ID,
        note: '已核对银行流水',
        confirmedAt: '2026-11-03T02:30:00.000Z',
      },
    },
    receiptReconciliationState: 'reconciled',
    payableAmountCents: null,
    settlementAmountStatus: 'pending_rule',
    blockingReasons: ['amount_mismatch', 'missing_approved_rule'],
    blockingMessages: [
      '登记价与凭据实收不符；部分退款/合并收款未支持自动拆分',
      '未找到经核准的分成合同规则；应分金额待核定',
    ],
    ...overrides,
  }
}

/** A registered order with no receipt and no confirmed seller snapshot. */
function candidateWithoutReceipt(
  overrides: Partial<SettlementCandidate> = {},
): SettlementCandidate {
  return {
    orderId: ORDER_2_ID,
    orderDisplayNo: 'ORD-20261104-0002',
    communityId: COMMUNITY_ID,
    productId: PRODUCT_2_ID,
    productName: '社区家政体验券',
    orderStatus: 'registered',
    registeredAmountCents: 2990,
    couponDiscountCents: 0,
    netPayableCents: 2990,
    periodAt: '2026-11-04T06:00:00.000Z',
    periodSource: 'order_registration',
    sellerStatus: 'missing_seller',
    orderParty: null,
    receipt: null,
    receiptReconciliationState: null,
    payableAmountCents: null,
    settlementAmountStatus: 'pending_rule',
    blockingReasons: ['missing_receipt', 'missing_seller', 'missing_approved_rule'],
    blockingMessages: [
      '尚未建立订单与人工收款凭据的明确关联',
      '尚未明确登记实际销售商户及其订单确认凭据',
      '未找到经核准的分成合同规则；应分金额待核定',
    ],
    ...overrides,
  }
}

/** `summaryScope` is `page`: 3500 分 from the one receipt on this page. */
function candidateResponse(
  overrides: Partial<SettlementCandidateListResponse> = {},
): SettlementCandidateListResponse {
  return {
    items: [candidate(), candidateWithoutReceipt()],
    total: 45,
    page: 1,
    pageSize: 20,
    asOf: '2026-11-11T08:00:00.000Z',
    summaryScope: 'page',
    periodPolicy: 'linked_receipt_else_order_registration',
    summary: {
      recordedReceiptGrossCents: 3500,
      reversedReceiptCents: 0,
      blockedItems: 2,
      visibleItems: 2,
    },
    payableAmountCents: null,
    settlementAmountStatus: 'pending_rule',
    ...overrides,
  }
}

function emptyResponse(): SettlementCandidateListResponse {
  return candidateResponse({
    items: [],
    total: 0,
    summary: {
      recordedReceiptGrossCents: 0,
      reversedReceiptCents: 0,
      blockedItems: 0,
      visibleItems: 0,
    },
  })
}

function openBatch(): ReconciliationBatch {
  return {
    batchId: '9f1c5d2e-0000-4a11-8b22-0000000000b1',
    batchNo: BATCH_NO,
    periodFrom: '2026-11-01',
    periodTo: '2026-11-07',
    status: 'open',
    entryCount: 2,
    totalCents: 7960,
    note: null,
    lockedAt: null,
    lockedByUserId: null,
    lockedByStaffId: null,
    createdAt: '2026-11-08T01:00:00.000Z',
    updatedAt: '2026-11-08T01:00:00.000Z',
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

const CANDIDATE_ROUTE = '/api/admin/settlement/candidates'
const BATCH_ROUTE = '/api/admin/reconciliation/batches'

function candidateRoute(
  body: SettlementCandidateListResponse | (() => SettlementCandidateListResponse) = candidateResponse(),
): readonly [string, Handler] {
  return [CANDIDATE_ROUTE, () => json(typeof body === 'function' ? body() : body)]
}

function renderPanel(session: AuthenticatedSession = ADMIN_SESSION) {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider
          value={{ session, busy: false, error: null, onLogout: async () => undefined }}
        >
          <SettlementCandidatePanel />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/settlements', element: <SettlementsPage /> }], {
    initialEntries: ['/settlements'],
  })
  const result = render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider
          value={{ session: ADMIN_SESSION, busy: false, error: null, onLogout: async () => undefined }}
        >
          <RouterProvider router={router} />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
  return { ...result, router }
}

function candidateCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.url.startsWith(CANDIDATE_ROUTE))
}

function urlOf(call: FetchCall): URL {
  return new URL(call.url, 'http://localhost')
}

function pageOf(url: string): string | null {
  return new URL(url, 'http://localhost').searchParams.get('page')
}

function headerOf(call: FetchCall | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>
}

/** Opens an antd Select (mouseDown is what opens it) and clicks the wanted option. */
async function chooseOption(combobox: Element, optionLabel: string) {
  fireEvent.mouseDown(combobox)
  const option = (await screen.findAllByText(optionLabel)).find((element) =>
    element.closest('.ant-select-item-option'),
  )
  expect(option, `option ${optionLabel} must be offered by the select`).toBeTruthy()
  fireEvent.click(option as Element)
}

function tabpanel(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="tabpanel"][aria-label="${label}"]`)
}

function activeHeaderTab(): string | null {
  const bar = document.querySelector('.page-header .page-header-subnav .ant-tabs')
  expect(bar).toBeTruthy()
  return bar?.querySelector('.ant-tabs-tab-active')?.textContent ?? null
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 1440,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * A real zero coupon discount is valid; an invented zero payable, receipt or
 * verified payment is not. Keep assertions tied to the financial meaning,
 * rather than banning every ¥0.00 anywhere on the page.
 */
function expectNoInventedZeroFinancialAmount(text: string | null | undefined) {
  expect(text ?? '').not.toMatch(
    /(?:应分金额|实际应付|凭据实收|人工收款凭据金额|核销金额|付款金额)[：:\s]*¥0\.00/u,
  )
}

describe('SettlementsPage 双 Tab 宿主', () => {
  it('defaults to 经营对账, keeps the old page working, and only fetches candidates after switching', async () => {
    const calls = stubApi([
      [BATCH_ROUTE, () => json({ items: [openBatch()], asOf: '2026-11-08T04:00:00.000Z' })],
      candidateRoute(),
    ])

    const { router } = renderPage()

    // 默认经营对账：旧批次列表照常读，候选接口一次都不该被调用。
    expect(await screen.findByText(BATCH_NO)).toBeTruthy()
    expect(screen.getByRole('tab', { name: '经营对账' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '分成结算单' })).toBeTruthy()
    expect(activeHeaderTab()).toBe('经营对账')
    expect(candidateCalls(calls)).toHaveLength(0)
    expect(screen.getByRole('button', { name: '新建对账批次' })).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '分成结算单' }))

    await waitFor(() => expect(candidateCalls(calls)).toHaveLength(1))
    expect(candidateCalls(calls)[0]!.url).toContain(`${CANDIDATE_ROUTE}?`)
    expect(candidateCalls(calls)[0]!.url).toContain('page=1')
    expect(candidateCalls(calls)[0]!.url).toContain('pageSize=20')
    expect(activeHeaderTab()).toBe('分成结算单')
    // Tab state is local: it must not add a URL contract (back still leaves the page).
    expect(router.state.location.search).toBe('')

    expect(await screen.findByText('有凭据实收毛额（仅当前页）')).toBeTruthy()
    expect(screen.getAllByText('待核定').length).toBeGreaterThan(0)
    expect(screen.getAllByText('本看板未查询付款记录').length).toBeGreaterThan(0)
    expectNoInventedZeroFinancialAmount(document.body.textContent)
    expect(document.body.textContent).not.toMatch(/已付款|已结清|已核销/)

    // 切回经营对账：旧内容仍在且没有额外请求候选接口。
    fireEvent.click(screen.getByRole('tab', { name: '经营对账' }))
    expect(await screen.findByRole('button', { name: '新建对账批次' })).toBeTruthy()
    expect(screen.getByText(BATCH_NO)).toBeTruthy()
    expect(activeHeaderTab()).toBe('经营对账')
    expect(candidateCalls(calls)).toHaveLength(1)
  })

  it('mounts the candidate view lazily, keeps both panels alive, and never refetches on toggle', async () => {
    const calls = stubApi([
      [BATCH_ROUTE, () => json({ items: [openBatch()], asOf: '2026-11-08T04:00:00.000Z' })],
      candidateRoute(),
    ])

    renderPage()
    expect(await screen.findByText(BATCH_NO)).toBeTruthy()

    // Before the first activation the candidate view is not in the DOM at all, so
    // the default tab cannot have issued a candidate request (asserted above).
    expect(tabpanel('分成结算单')).toBeNull()
    expect(tabpanel('经营对账')).toBeTruthy()
    expect(tabpanel('经营对账')!.hasAttribute('hidden')).toBe(false)
    expect(candidateCalls(calls)).toHaveLength(0)
    const batchCallsBefore = calls.filter((call) => call.url.startsWith(BATCH_ROUTE)).length

    fireEvent.click(screen.getByRole('tab', { name: '分成结算单' }))
    await screen.findByText('有凭据实收毛额（仅当前页）')
    expect(tabpanel('分成结算单')).toBeTruthy()
    expect(tabpanel('分成结算单')!.hasAttribute('hidden')).toBe(false)
    expect(tabpanel('经营对账')!.hasAttribute('hidden')).toBe(true)
    expect(candidateCalls(calls)).toHaveLength(1)
    // Only the visible panel's table is exposed to assistive tech.
    expect(screen.getAllByRole('table')).toHaveLength(1)

    // Away and back: the reconciliation panel stays mounted (its rows are still
    // in the DOM) and neither side re-fetches, so a toggle cannot replay an old
    // response over newer state.
    fireEvent.click(screen.getByRole('tab', { name: '经营对账' }))
    expect(tabpanel('经营对账')!.hasAttribute('hidden')).toBe(false)
    expect(tabpanel('分成结算单')!.hasAttribute('hidden')).toBe(true)
    expect(screen.getByText(BATCH_NO)).toBeTruthy()
    expect(screen.getAllByRole('table')).toHaveLength(1)

    fireEvent.click(screen.getByRole('tab', { name: '分成结算单' }))
    expect(tabpanel('分成结算单')!.hasAttribute('hidden')).toBe(false)
    expect(await screen.findByText('ORD-20261102-0001')).toBeTruthy()
    expect(candidateCalls(calls)).toHaveLength(1)
    expect(calls.filter((call) => call.url.startsWith(BATCH_ROUTE))).toHaveLength(batchCallsBefore)
  })
})

describe('SettlementCandidatePanel list and KPI', () => {
  it('renders the page-scoped 待核定 KPIs without inventing any payable or paid amount', async () => {
    stubApi([candidateRoute()])
    renderPanel()

    expect(await screen.findByText('有凭据实收毛额（仅当前页）')).toBeTruthy()
    // 实收是服务端 summary 的毛额原值；冲正并列展示且本页无冲正时不显示 ¥0.00。
    expect(
      within(screen.getByTestId('candidate-kpi-receipt')).getByText('¥35.00'),
    ).toBeTruthy()
    expect(screen.getByTestId('candidate-kpi-receipt').textContent).toContain(
      '含已全额冲正的原始收款；冲正单独列出，不在此处抵扣',
    )
    expect(
      screen.getByText(/收款冲正（单独列出，不净额、不相加）：当前页无冲正/),
    ).toBeTruthy()
    expect(screen.getByText('不可结算单数（仅当前页）')).toBeTruthy()
    expect(within(screen.getByTestId('candidate-kpi-blocked')).getByText('2 单')).toBeTruthy()
    expect(screen.getByTestId('candidate-kpi-blocked').textContent).toContain(
      '候选接口尚未采用合同规则，服务端将本页候选标为不可结算',
    )
    expect(screen.getByTestId('candidate-kpi-blocked').textContent).toContain(
      '不代表部分可结、部分不可结',
    )
    expect(screen.getByText('应分金额')).toBeTruthy()
    expect(screen.getAllByText('待核定').length).toBeGreaterThan(0)
    expect(screen.getByText('已登记付款')).toBeTruthy()
    expect(screen.getAllByText('本看板未查询付款记录').length).toBeGreaterThan(0)
    expect(screen.getByTestId('candidate-kpi-payment').textContent).toContain(
      '本看板未查询付款记录或核销状态',
    )
    expect(screen.getByTestId('candidate-kpi-payment').textContent).toContain(
      '只有服务端核验通过的付款确认才算核销',
    )

    // No invented zero payable/receipt, percentage estimate, or paid/settled wording.
    expectNoInventedZeroFinancialAmount(document.body.textContent)
    expect(document.body.textContent).not.toMatch(/已付款|已结清|已核销/)
    expect(document.body.textContent).not.toMatch(/\d+(\.\d+)?%/)
  })

  it('separates 登记金额 from 凭据实收 and says 无收款凭据 when the receipt is null', async () => {
    stubApi([candidateRoute()])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')
    expect(screen.getByRole('columnheader', { name: '登记金额（非实收）' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '实收（凭据）' })).toBeTruthy()
    // 登记金额 39.80 and 凭据实收 35.00 are both rendered, side by side.
    expect(screen.getByText('¥39.80')).toBeTruthy()
    expect(screen.getAllByText('¥35.00').length).toBeGreaterThan(0)
    // The unpaid order must say so instead of showing ¥0.00 as 实收.
    expect(screen.getByText('无收款凭据')).toBeTruthy()
    // A real zero coupon is valid and MUST be shown; the receipt stays unknown.
    expect(screen.getAllByText('优惠券抵扣：¥0.00').length).toBeGreaterThan(0)

    const rows = document.querySelectorAll<HTMLElement>('.ant-table-tbody tr.ant-table-row')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.textContent).toContain('无收款凭据')
    expectNoInventedZeroFinancialAmount(rows[1]?.textContent)
    // An order without a confirmed seller says so instead of guessing a party.
    expect(rows[1]?.textContent).toContain('未指定实际销售商户')
    // A verified order still carries the "not a payment" qualifier.
    expect(rows[0]?.textContent).toContain('已人工核验（不代表收款）')
  })

  it('lists all required columns and keeps a horizontal table structure on a narrow viewport', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 375,
    })
    stubApi([candidateRoute()])
    const { container } = renderPanel()

    await screen.findByText('ORD-20261102-0001')
    for (const title of [
      '订单号 / 商品',
      '主体状态',
      '登记金额（非实收）',
      '实收（凭据）',
      '网格员归属',
      '规则状态',
      '阻塞原因',
    ]) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0)
    }
    // Structural assertion only (no browser/visual check): the table keeps its
    // scroll x='max-content' wrapper, so columns stay readable on a narrow screen.
    const table = container.querySelector('.ant-table')
    expect(table).toBeTruthy()
    expect(container.querySelector('.ant-table-content, .ant-table-body')).toBeTruthy()
    const content = container.querySelector<HTMLElement>('.ant-table-content')
    expect(content).toBeTruthy()
    expect(content!.style.overflowX).toBe('auto')
    expect(content!.style.overflowY).toBe('hidden')
    const inner = content!.querySelector('table')
    expect(inner?.style.width).toBe('max-content')
    expect(inner?.style.minWidth).toBe('100%')
    expect(container.querySelector('.ant-table-scroll-horizontal')).toBeTruthy()

    // Column semantics: one header per contracted column, including 操作.
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      '订单号 / 商品',
      '主体状态',
      '登记金额（非实收）',
      '实收（凭据）',
      '网格员归属',
      '规则状态',
      '阻塞原因',
      '操作',
    ])
    // UUIDs are not copyable from the list; that affordance belongs to the drawer.
    expect(container.querySelectorAll('.ant-typography-copy')).toHaveLength(0)
  })
})

describe('SettlementCandidatePanel drawer', () => {
  it('shows 登记金额 vs 凭据实收, blocking reasons with next steps, and UUIDs only in the drawer', async () => {
    stubApi([candidateRoute()])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')
    const tableText = document.querySelector('.ant-table')?.textContent ?? ''
    expect(tableText).not.toContain(ORDER_ID)
    expect(tableText).not.toContain(SELLER_PARTY_ID)
    expect(tableText).not.toContain('BANK-20261102-001')

    fireEvent.click(screen.getAllByRole('button', { name: '查看详情' })[0]!)

    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('登记金额 vs 凭据实收')).toBeTruthy()
    expect(within(drawer).getByText('登记金额（非实收）')).toBeTruthy()
    expect(within(drawer).getByText('凭据实收')).toBeTruthy()
    expect(within(drawer).getByText('¥39.80')).toBeTruthy()
    expect(within(drawer).getByText('¥35.00')).toBeTruthy()

    // Receipt provenance + attribution + the explicit "no name returned" fact.
    expect(within(drawer).getByText('转账凭据')).toBeTruthy()
    expect(within(drawer).getByText('BANK-20261102-001')).toBeTruthy()
    expect(within(drawer).getByText(/服务端未返回姓名/)).toBeTruthy()
    expect(within(drawer).getByText(/已核对银行流水/)).toBeTruthy()
    expect(within(drawer).getByText('已归属')).toBeTruthy()
    // 归属 is a performance attribution, never a payable/payee assertion.
    expect(
      within(drawer).getByText(
        '归属只表示推广业绩归属，不代表应付对象或打款对象；应付主体与金额以已核准规则为准（当前待核定）。',
      ),
    ).toBeTruthy()

    // Blocking reasons: server message + readable label + next step.
    const blocking = within(drawer).getByLabelText('为什么不能结算')
    expect(within(blocking).getByText('登记金额与实收不符')).toBeTruthy()
    expect(within(blocking).getByText('候选尚未采用分成规则')).toBeTruthy()
    expect(
      within(blocking).getByText('登记价与凭据实收不符；部分退款/合并收款未支持自动拆分'),
    ).toBeTruthy()
    expect(
      within(blocking).getByText(/下一步应补：人工核对收据与订单登记金额/),
    ).toBeTruthy()
    expect(
      within(blocking).getByText(/下一步应补：核对已核准合同规则/),
    ).toBeTruthy()

    // UUIDs are visible/copyable here, and only here.
    expect(within(drawer).getByText('订单内部 ID（服务端返回）')).toBeTruthy()
    expect(within(drawer).getByText(ORDER_ID)).toBeTruthy()
    expect(within(drawer).getByText(SELLER_PARTY_ID)).toBeTruthy()
    expect(within(drawer).getByText(SANCHUANG_PARTY_ID)).toBeTruthy()
    expect(within(drawer).getByText(GUANGDIAN_PARTY_ID)).toBeTruthy()
    expect(drawer.querySelectorAll('.ant-typography-copy').length).toBeGreaterThan(0)

    // The drawer distinguishes unknown rule/payment status from absent records.
    expect(within(drawer).getByText(/本候选接口不提供分成计算结果/)).toBeTruthy()
    expect(within(drawer).getByText(/本看板未查询付款记录或核销状态/)).toBeTruthy()
    expect(within(blocking).getByText(/候选接口尚未采用合同规则/)).toBeTruthy()
  })

  it('keeps a receipt-less candidate honest in the drawer', async () => {
    stubApi([candidateRoute()])
    renderPanel()

    await screen.findByText('ORD-20261104-0002')
    fireEvent.click(screen.getAllByRole('button', { name: '查看详情' })[1]!)

    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('无收款凭据')).toBeTruthy()
    expect(within(drawer).getByText('该候选没有收款凭据')).toBeTruthy()
    expect(within(drawer).getAllByText('未指定实际销售商户').length).toBeGreaterThan(0)
    expect(within(drawer).getByText(/服务端未返回主体快照/)).toBeTruthy()
    // 登记金额 is shown, but it is never promoted to 实收.
    expect(within(drawer).getByText('¥29.90')).toBeTruthy()
    expectNoInventedZeroFinancialAmount(drawer.textContent)
    expect(drawer.textContent).not.toMatch(/已付款|已结清|已核销/)
  })
})

describe('SettlementCandidatePanel filters and paging', () => {
  it('sends keyword/date/page parameters to the server and resets to page 1 on filter', async () => {
    const calls = stubApi([candidateRoute()])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')
    expect(calls).toHaveLength(1)

    // The server caps keyword at 80 characters; the input states the same bound.
    const keywordInput = screen.getByLabelText('订单号或商品关键字')
    expect(keywordInput.getAttribute('maxlength')).toBe('80')
    expect(keywordInput.getAttribute('placeholder')).toContain('80')

    // Pagination is server-side: page 2 is requested with the same filters.
    fireEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]!.url).toContain('page=2')
    expect(calls[1]!.url).toContain('pageSize=20')

    fireEvent.change(screen.getByLabelText('订单号或商品关键字'), {
      target: { value: 'ORD-2026' },
    })
    fireEvent.change(screen.getByLabelText('业务日期从（含）'), {
      target: { value: '2026-10-01' },
    })
    fireEvent.change(screen.getByLabelText('业务日期至（含）'), {
      target: { value: '2026-10-31' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))

    await waitFor(() => expect(calls).toHaveLength(3))
    const filtered = calls[2]!
    expect(filtered.url).toContain('keyword=ORD-2026')
    expect(filtered.url).toContain('from=2026-10-01')
    expect(filtered.url).toContain('to=2026-10-31')
    // A narrowed query starts from the first page, never the old page 2.
    expect(filtered.url).toContain('page=1')
  })

  it('refuses an inverted date range locally instead of asking the server', async () => {
    const calls = stubApi([candidateRoute()])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')
    fireEvent.change(screen.getByLabelText('业务日期从（含）'), {
      target: { value: '2026-11-30' },
    })
    fireEvent.change(screen.getByLabelText('业务日期至（含）'), {
      target: { value: '2026-11-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))

    expect(await screen.findByText('开始日期不能晚于结束日期。')).toBeTruthy()
    expect(calls).toHaveLength(1)
  })
})

describe('SettlementCandidatePanel community scope', () => {
  it('offers exactly the session communities, sends communityId, and drops it on clear', async () => {
    const calls = stubApi([candidateRoute()])
    const { container } = renderPanel(COMMUNITY_SESSION)

    await screen.findByText('ORD-20261102-0001')
    const field = screen.getByText('授权社区').closest('.ledger-filter-field')
    expect(field).toBeTruthy()
    const select = field!.querySelector('.ant-select')
    expect(select).toBeTruthy()

    // Options are the authenticated assignment list — never a mocked label.
    fireEvent.mouseDown(select!)
    const options = await waitFor(() => {
      const items = Array.from(document.querySelectorAll('.ant-select-item-option'))
      expect(items).toHaveLength(2)
      return items
    })
    expect(options.map((option) => option.textContent)).toEqual([
      COMMUNITY_A.name,
      COMMUNITY_B.name,
    ])
    fireEvent.click(options[0]!)

    await waitFor(() => expect(calls).toHaveLength(2))
    expect(urlOf(calls[1]!).searchParams.get('communityId')).toBe(COMMUNITY_ID)
    // Narrowing restarts at the first page.
    expect(urlOf(calls[1]!).searchParams.get('page')).toBe('1')

    // Clearing removes the parameter; it must not send communityId=''.
    const clear = container.querySelector('.ant-select-clear')
    expect(clear).toBeTruthy()
    fireEvent.click(clear!)
    await waitFor(() => expect(calls).toHaveLength(3))
    expect(urlOf(calls[2]!).searchParams.has('communityId')).toBe(false)
  })

  it('hides the community selector and sends no communityId without assignments', async () => {
    const calls = stubApi([candidateRoute()])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('ORD-20261102-0001')
    expect(screen.queryByText('授权社区')).toBeNull()
    expect(calls).toHaveLength(1)
    expect(urlOf(calls[0]!).searchParams.has('communityId')).toBe(false)
  })
})

describe('SettlementCandidatePanel states', () => {
  it('shows loading without an empty state, then a true-empty message', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    stubApi([[CANDIDATE_ROUTE, () => pending]])
    renderPanel()

    expect(screen.getByText('正在读取结算候选…')).toBeTruthy()
    expect(screen.queryByText('所选期间没有结算候选')).toBeNull()

    resolveFetch?.(json(emptyResponse()))
    expect(await screen.findByText('所选期间没有结算候选')).toBeTruthy()
    // Even the empty page uses the page-scoped summary without fake zeros.
    expect(screen.getByText('当前页无凭据实收')).toBeTruthy()
    expect(screen.getByText(/当前页无冲正/)).toBeTruthy()
    expectNoInventedZeroFinancialAmount(document.body.textContent)
  })

  it('explains an out-of-range page and offers a way back to page 1', async () => {
    const emptySecondPage = candidateResponse({
      items: [],
      page: 2,
      total: 45,
      summary: {
        recordedReceiptGrossCents: 0,
        reversedReceiptCents: 0,
        blockedItems: 0,
        visibleItems: 0,
      },
    })
    const calls = stubApi([
      [
        CANDIDATE_ROUTE,
        (url) =>
          json(pageOf(url) === '2' ? emptySecondPage : candidateResponse()),
      ],
    ])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')
    fireEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(urlOf(calls[1]!).searchParams.get('page')).toBe('2')

    // A page past the last row is not the same thing as "no candidates at all",
    // and it must never look like the filter returned nothing.
    expect(await screen.findByText('本页没有候选，页码可能已过期')).toBeTruthy()
    expect(screen.queryByText('所选期间没有结算候选')).toBeNull()
    expect(screen.queryByText('当前筛选条件下没有结算候选')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '回到第 1 页' }))
    await waitFor(() => expect(calls).toHaveLength(3))
    expect(urlOf(calls[2]!).searchParams.get('page')).toBe('1')
  })

  it('distinguishes a filtered empty result and lets the operator clear filters', async () => {
    const calls = stubApi([candidateRoute(emptyResponse())])
    renderPanel()

    await screen.findByText('所选期间没有结算候选')
    fireEvent.change(screen.getByLabelText('订单号或商品关键字'), {
      target: { value: 'NOT-FOUND' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))

    expect(await screen.findByText('当前筛选条件下没有结算候选')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))

    await waitFor(() => expect(calls).toHaveLength(3))
    expect(calls[2]!.url).not.toContain('keyword=')
    expect(await screen.findByText('所选期间没有结算候选')).toBeTruthy()
  })

  it('shows a server fault as an error with a real retry, never as an empty list', async () => {
    const calls = stubApi([
      [
        CANDIDATE_ROUTE,
        () =>
          json({ error: { code: 'internal_error', message: '数据库暂时不可用' } }, 500),
      ],
    ])
    renderPanel()

    expect(await screen.findByText('结算候选加载失败')).toBeTruthy()
    expect(screen.getByText(/数据库暂时不可用/)).toBeTruthy()
    expect(screen.queryByText('所选期间没有结算候选')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    await waitFor(() => expect(calls).toHaveLength(2))
  })

  it('names an expired session and renders no table for 401', async () => {
    stubApi([
      [
        CANDIDATE_ROUTE,
        () => json({ error: { code: 'unauthorized', message: '请先登录管理后台' } }, 401),
      ],
    ])
    renderPanel()

    expect(await screen.findByText('登录状态已失效')).toBeTruthy()
    expect(screen.getByText(/重新登录管理后台/)).toBeTruthy()
    expect(screen.getByText(/刷新页面会重新校验会话并显示登录页/)).toBeTruthy()
    expect(screen.getByText(/不会用空表冒充无数据/)).toBeTruthy()
    // A real next step exists; it is deliberately not clicked because jsdom's
    // reload is not a navigation implementation.
    expect(screen.getByRole('button', { name: '刷新并重新登录' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByTestId('candidate-kpi-receipt')).toBeNull()
    expect(screen.queryByTestId('candidate-kpi-payable')).toBeNull()
    expect(screen.queryByText('所选期间没有结算候选')).toBeNull()
    expect(screen.queryByText('没有分成结算候选权限')).toBeNull()
    expect(screen.queryByRole('button', { name: /重\s*试/ })).toBeNull()
  })

  it('states the role boundary for 403 and renders no table at all', async () => {
    stubApi([
      [
        CANDIDATE_ROUTE,
        () =>
          json(
            { error: { code: 'forbidden', message: '网格员没有全局机构结算核查权限' } },
            403,
          ),
      ],
    ])
    renderPanel()

    expect(await screen.findByText('没有分成结算候选权限')).toBeTruthy()
    expect(screen.getByText(/网格员没有全局机构结算核查权限/)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByTestId('candidate-kpi-receipt')).toBeNull()
    expect(screen.queryByTestId('candidate-kpi-payable')).toBeNull()
    expect(screen.queryByText('所选期间没有结算候选')).toBeNull()
    expect(screen.queryByText('登录状态已失效')).toBeNull()
    expect(screen.queryByRole('button', { name: /重\s*试/ })).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* Contract channel: the shared DTO is the only source of truth                */
/* -------------------------------------------------------------------------- */

describe('SettlementCandidatePanel contract channel', () => {
  it('reads only the contracted endpoint with contracted query parameters', async () => {
    const calls = stubApi([candidateRoute()])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')
    expect(calls).toHaveLength(1)

    const call = calls[0]!
    const url = urlOf(call)
    expect(url.pathname).toBe('/api/admin/settlement/candidates')
    // The server query is a `strictObject`: page/pageSize are the only parameters
    // this read sends by default. Omitted filters are absent, not empty strings.
    expect([...url.searchParams.keys()].sort()).toEqual(['page', 'pageSize'])
    expect(url.searchParams.get('page')).toBe('1')
    expect(url.searchParams.get('pageSize')).toBe('20')
    expect(call.init?.method).toBe('GET')
    // The shared `requestLocalJson` channel: same-origin cookie + JSON accept.
    // A read carries no CSRF token and no request body.
    expect(call.init?.credentials).toBe('include')
    expect(headerOf(call).accept).toBe('application/json')
    expect(headerOf(call)['x-csrf-token']).toBeUndefined()
    expect(call.init?.body).toBeUndefined()
    // This read-only board never touches a mutation endpoint.
    expect(calls.every((entry) => (entry.init?.method ?? 'GET') === 'GET')).toBe(true)
  })

  const BAD_PAYLOADS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['an invented payable amount', { payableAmountCents: 12345 }],
    ['a field outside the shared DTO', { inventedPayableCents: 12345 }],
    ['a summary that claims the period', { summaryScope: 'period' }],
    ['a payable status that is not pending_rule', { settlementAmountStatus: 'estimated' }],
  ]

  it.each(BAD_PAYLOADS)(
    'turns %s into a real error instead of rendering it',
    async (_label, override) => {
      const bad = {
        ...candidateResponse(),
        ...override,
      } as unknown as SettlementCandidateListResponse
      stubApi([candidateRoute(bad)])
      renderPanel()

      expect(await screen.findByText('结算候选加载失败')).toBeTruthy()
      expect(screen.queryByRole('table')).toBeNull()
      expect(screen.queryByText('ORD-20261102-0001')).toBeNull()
      // Nothing from the rejected payload is partially rendered: no invented
      // payable, no stray receipt amount, no KPI card that would look loaded.
      expect(document.body.textContent).not.toContain('¥123.45')
      expect(document.body.textContent).not.toContain('¥35.00')
      expect(screen.queryByTestId('candidate-kpi-receipt')).toBeNull()
      // A rejected contract is a fault with a real retry, never an empty list.
      expect(screen.queryByText('所选期间没有结算候选')).toBeNull()
      expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy()
    },
  )
})

/* -------------------------------------------------------------------------- */
/* Anti-misleading wording: pending is never a number, evidence is never paid  */
/* -------------------------------------------------------------------------- */

describe('SettlementCandidatePanel anti-misleading wording', () => {
  it('renders 应分金额 and 已登记付款 as states, never as currency or success', async () => {
    stubApi([candidateRoute()])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')

    const payable = screen.getByTestId('candidate-kpi-payable')
    expect(within(payable).getByText('待核定')).toBeTruthy()
    expect(payable.textContent).toMatch(/不计算应分金额/)
    // A pending rule must not look like a computed ¥0.00 / 0% / 本期应分.
    expect(payable.textContent).not.toMatch(/¥/)
    expect(payable.textContent).not.toMatch(/\d+(\.\d+)?\s*%/)
    expect(payable.textContent).not.toMatch(/本期|已结清|已核销|已付款/)

    const payment = screen.getByTestId('candidate-kpi-payment')
    expect(payment.textContent).toContain('本看板未查询付款记录')
    expect(payment.textContent).toMatch(/不能认为款项已经付出/)
    expect(payment.textContent).not.toMatch(/尚无登记或确认记录/)
    expect(document.body.textContent).not.toMatch(/尚无已核准的?合同规则|本 MVP 没有已核准的结算规则/)
    expect(payment.textContent).not.toMatch(/¥/)
    expect(payment.textContent).not.toMatch(/已付款|已支付|已转账|已结清|已核销|付款成功/)

    const body = document.body.textContent ?? ''
    for (const forbidden of [
      '本期应分',
      '应分金额：¥',
      '应分金额 ¥',
      '已结清',
      '已核销',
      '已付款',
      '已支付',
      '已转账',
      '付款成功',
      '结算完成',
      '已结算',
    ]) {
      expect(body, `misleading wording must be absent: ${forbidden}`).not.toContain(forbidden)
    }
    // No client-side estimate of any kind.
    expect(body).not.toMatch(/\d+(\.\d+)?\s*%/)
    // No silently computed difference (39.80 − 35.00) or sum (39.80 + 35.00).
    expect(body).not.toContain('¥4.80')
    expect(body).not.toContain('¥74.80')
  })

  it('labels the page-scoped summary as 仅当前页 instead of a period total', async () => {
    stubApi([candidateRoute()])
    renderPanel()

    await screen.findByText('有凭据实收毛额（仅当前页）')
    expect(screen.getByText('不可结算单数（仅当前页）')).toBeTruthy()
    expect(screen.getByText(/只统计当前返回页 2 单候选，不代表整个期间/)).toBeTruthy()
    expect(
      screen.getByText(/有凭据实收毛额、冲正与不可结算单数都只统计当前返回页，不代表整个期间/),
    ).toBeTruthy()
    // The KPI is the server's summary, not the sum of registered amounts.
    expect(within(screen.getByTestId('candidate-kpi-receipt')).getByText('¥35.00')).toBeTruthy()
    expect(document.body.textContent).not.toContain('¥74.80')
  })

  it('keeps 登记金额 and 凭据实收 separate in the drawer without any computed delta', async () => {
    stubApi([candidateRoute()])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')
    fireEvent.click(screen.getAllByRole('button', { name: '查看详情' })[0]!)
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('登记金额 vs 凭据实收')

    expect(within(drawer).getByText('¥39.80')).toBeTruthy()
    expect(within(drawer).getByText('¥35.00')).toBeTruthy()
    expect(within(drawer).getByText(/本页不做差额计算/)).toBeTruthy()
    expect(drawer.textContent).not.toContain('¥4.80')
    expect(drawer.textContent).not.toContain('¥74.80')
    expectNoInventedZeroFinancialAmount(drawer.textContent)
    expect(drawer.textContent).not.toMatch(/已付款|已结清|已核销|付款成功|已转账/)
    // Payment evidence is unknown in this candidate view, not absent or verified.
    expect(drawer.textContent).toContain('无法据此判断是否登记、复核或完成线下支付')
    // The registered amount is explicitly not money received.
    expect(within(drawer).getByText(/不是收款凭据，也不代表业务已办理或款项已经收到/)).toBeTruthy()
  })
})

/* -------------------------------------------------------------------------- */
/* Status semantics: pending stays pending, reversal stays gross + reversal    */
/* -------------------------------------------------------------------------- */

describe('SettlementCandidatePanel status semantics', () => {
  it('renders pending_review as 待核验, never as verified, paid or settled', async () => {
    stubApi([
      candidateRoute(
        candidateResponse({
          items: [candidate({ orderStatus: 'pending_review' })],
          total: 1,
        }),
      ),
    ])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')
    const rows = document.querySelectorAll<HTMLElement>('.ant-table-tbody tr.ant-table-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('订单状态：待核验')
    expect(rows[0]?.textContent).not.toContain('已人工核验')
    expect(document.body.textContent).not.toContain('已人工核验')
    expect(rows[0]?.textContent).not.toMatch(/已付款|已结清|已核销/)
  })

  it('shows a reversed receipt as gross plus a separate reversal, never netted', async () => {
    const reversed = candidate({
      receipt: { ...candidate().receipt!, reversedEntryId: RECEIPT_REVERSAL_ID },
    })
    stubApi([
      candidateRoute(
        candidateResponse({
          items: [reversed],
          total: 1,
          summary: {
            recordedReceiptGrossCents: 3500,
            reversedReceiptCents: 1200,
            blockedItems: 1,
            visibleItems: 1,
          },
        }),
      ),
    ])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')
    const receiptKpi = screen.getByTestId('candidate-kpi-receipt')
    expect(within(receiptKpi).getByText('¥35.00')).toBeTruthy()
    expect(receiptKpi.textContent).toContain('¥12.00')
    expect(receiptKpi.textContent).toMatch(/不净额、不相加/)
    // Gross 35.00 − reversal 12.00 = 23.00: a net the page must never show.
    expect(document.body.textContent).not.toContain('¥23.00')

    const rows = document.querySelectorAll<HTMLElement>('.ant-table-tbody tr.ant-table-row')
    expect(rows[0]?.textContent).toContain('¥35.00')
    expect(rows[0]?.textContent).toContain('原收款已冲正')
    expect(rows[0]?.textContent).not.toContain('¥12.00')

    fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
    const drawer = await screen.findByRole('dialog')
    expect(
      await within(drawer).findByText('原收款已全额冲正；冲正单独成行，不从实收静默抵扣。'),
    ).toBeTruthy()
    expect(within(drawer).getByText(RECEIPT_REVERSAL_ID)).toBeTruthy()
    expect(within(drawer).getByText('¥35.00')).toBeTruthy()
    expect(drawer.textContent).not.toContain('¥23.00')
  })

  it('labels the receipt KPI as gross and never fakes ¥0.00 for a fully reversed receipt', async () => {
    const fullyReversed = candidate({
      receipt: { ...candidate().receipt!, reversedEntryId: RECEIPT_REVERSAL_ID },
    })
    stubApi([
      candidateRoute(
        candidateResponse({
          items: [fullyReversed],
          total: 1,
          summary: {
            // Gross equals the reversal: a client-side net would be ¥0.00.
            recordedReceiptGrossCents: 3500,
            reversedReceiptCents: 3500,
            blockedItems: 1,
            visibleItems: 1,
          },
        }),
      ),
    ])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')
    const receiptKpi = screen.getByTestId('candidate-kpi-receipt')
    expect(within(receiptKpi).getByText('有凭据实收毛额（仅当前页）')).toBeTruthy()
    // Gross 35.00 and the separate reversal 35.00 are both visible…
    expect(receiptKpi.textContent?.match(/¥35\.00/g)).toHaveLength(2)
    expect(receiptKpi.textContent).toContain(
      '收款冲正（单独列出，不净额、不相加）：¥35.00',
    )
    expect(receiptKpi.textContent).toContain(
      '含已全额冲正的原始收款；冲正单独列出，不在此处抵扣',
    )
    // …and the netted zero is never rendered as if it were the receipt amount.
    expectNoInventedZeroFinancialAmount(document.body.textContent)
    expect(document.body.textContent).not.toMatch(/已付款|已结清|已核销/)
  })
})

/* -------------------------------------------------------------------------- */
/* Request lifecycle: a stale response never replaces the newest state         */
/* -------------------------------------------------------------------------- */

describe('SettlementCandidatePanel request lifecycle', () => {
  it('drops a slow response for a filter that was already replaced', async () => {
    const resolvers = new Map<string, (response: Response) => void>()
    stubApi([
      [
        CANDIDATE_ROUTE,
        (url) => {
          const keyword =
            new URL(url, 'http://localhost').searchParams.get('keyword') ?? 'initial'
          return new Promise<Response>((resolve) => {
            resolvers.set(keyword, resolve)
          })
        },
      ],
    ])
    renderPanel()

    await waitFor(() => expect(resolvers.has('initial')).toBe(true))
    resolvers.get('initial')!(json(candidateResponse()))
    await screen.findByText('ORD-20261102-0001')

    // First narrowed query stays in flight…
    fireEvent.change(screen.getByLabelText('订单号或商品关键字'), {
      target: { value: 'FIRST' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))
    await waitFor(() => expect(resolvers.has('FIRST')).toBe(true))
    // …and the previous page's rows are cleared, not left looking current.
    expect(screen.getByText('正在读取结算候选…')).toBeTruthy()
    expect(screen.queryByText('ORD-20261102-0001')).toBeNull()
    expect(screen.queryByText('所选期间没有结算候选')).toBeNull()

    // The operator immediately replaces that filter.
    fireEvent.change(screen.getByLabelText('订单号或商品关键字'), {
      target: { value: 'SECOND' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))
    await waitFor(() => expect(resolvers.has('SECOND')).toBe(true))

    resolvers.get('SECOND')!(
      json(
        candidateResponse({
          items: [candidate({ orderId: ORDER_3_ID, orderDisplayNo: 'ORD-SECOND-0001' })],
        }),
      ),
    )
    expect(await screen.findByText('ORD-SECOND-0001')).toBeTruthy()

    // The abandoned FIRST response lands last; the aborted effect must ignore it.
    resolvers.get('FIRST')!(
      json(
        candidateResponse({
          items: [candidate({ orderId: ORDER_2_ID, orderDisplayNo: 'ORD-FIRST-0001' })],
        }),
      ),
    )
    await waitFor(() => expect(screen.queryByText('ORD-FIRST-0001')).toBeNull())
    expect(screen.getByText('ORD-SECOND-0001')).toBeTruthy()
  })

  it('restarts at page 1 when the page size changes, and 刷新 re-reads the same query', async () => {
    const calls = stubApi([candidateRoute()])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')

    const sizeChanger = document.querySelector('.ant-pagination-options .ant-select')
    expect(sizeChanger).toBeTruthy()
    await chooseOption(sizeChanger as Element, '50 条/页')

    await waitFor(() => expect(calls).toHaveLength(2))
    const sized = urlOf(calls[1]!)
    expect(sized.searchParams.get('pageSize')).toBe('50')
    // A page-size change starts again at page 1, never page 2 of a new window.
    expect(sized.searchParams.get('page')).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: /刷\s*新/ }))
    await waitFor(() => expect(calls).toHaveLength(3))
    const refreshed = urlOf(calls[2]!)
    expect(refreshed.searchParams.get('page')).toBe('1')
    expect(refreshed.searchParams.get('pageSize')).toBe('50')
    expect([...refreshed.searchParams.keys()].sort()).toEqual(['page', 'pageSize'])
  })
})

/* -------------------------------------------------------------------------- */
/* Narrow viewport: structure only, no visual/browser verification             */
/* -------------------------------------------------------------------------- */

describe('SettlementCandidatePanel narrow viewport structure', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 375,
    })
  })

  it('keeps the drawer single-column and caps it with the drawer size, not a wide table', async () => {
    stubApi([candidateRoute()])
    renderPanel()

    await screen.findByText('ORD-20261102-0001')
    fireEvent.click(screen.getAllByRole('button', { name: '查看详情' })[0]!)
    const drawer = await screen.findByRole('dialog')
    await within(drawer).findByText('登记金额 vs 凭据实收')

    // antd caps `.ant-drawer-content-wrapper` at 100vw via its own stylesheet, so
    // the page only asks for its intended size and adds no hard-coded min-width.
    const wrapper = document.querySelector<HTMLElement>('.ant-drawer-content-wrapper')
    expect(wrapper).toBeTruthy()
    expect(wrapper!.style.width).toBe('720px')

    // Every Descriptions block is column={1}: one label/content pair per row, so
    // the evidence table cannot force a multi-column wide layout on a phone.
    const rows = Array.from(drawer.querySelectorAll('.ant-descriptions-row'))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.querySelectorAll('.ant-descriptions-item-label')).toHaveLength(1)
    }

    // 登记金额 vs 凭据实收 stays a wrapping two-block grid, not a fixed-width table.
    const grid = drawer.querySelector('.ledger-diff-grid')
    expect(grid).toBeTruthy()
    expect(grid!.querySelectorAll('.ledger-diff-block')).toHaveLength(2)
  })
})
