// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type {
  SettlementQuoteResponse,
  SettlementRuleVersion,
} from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { SettlementQuotePanel } from './SettlementQuotePanel'
import { SettlementsPage } from './SettlementsPage'

/**
 * Drives the real 服务端试算 panel (#222) against a stubbed `fetch`.
 *
 * What these tests protect:
 *
 * - the panel renders only what the server returned: `calculated` shows the exact
 *   integer cents through `formatCents`, `pending_rule`/`blocked` show no amount
 *   at all (never a fake ¥0), and missing source fields say「服务端未返回」;
 * - the request is exactly `POST /api/admin/settlement/quotes` with
 *   `x-csrf-token` and body `{ orderId }` — empty input and a double click never
 *   produce extra requests;
 * - real 403/network failures are surfaced with `describeLocalError`, never as an
 *   empty success card or a number;
 * - nothing on the page asserts a payable / paid / settled fact: the quote is
 *   explicitly 「试算 ≠ 实际应付 ≠ 结算单锁定 ≠ 付款」.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_ID = '123e4567-e89b-42d3-a456-4266141740a1'
const PRODUCT_ID = '123e4567-e89b-42d3-a456-426614174201'
const SELLER_ID = '123e4567-e89b-42d3-a456-426614174501'
const SANCHUANG_ID = '123e4567-e89b-42d3-a456-426614174502'
const GUANGDIAN_ID = '123e4567-e89b-42d3-a456-426614174503'
const MAPPING_ID = '123e4567-e89b-42d3-a456-426614174601'
const RULE_ID = '123e4567-e89b-42d3-a456-426614174801'
const ORDER_ID = '123e4567-e89b-42d3-a456-426614174701'
const RECEIPT_ID = '123e4567-e89b-42d3-a456-426614174301'
const CSRF_TOKEN = 'csrf-token-for-settlement-quote-tests'

const QUOTES_ROUTE = '/api/admin/settlement/quotes'
const BATCH_ROUTE = '/api/admin/reconciliation/batches'
const CANDIDATES_ROUTE = '/api/admin/settlement/candidates'

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_ID, displayName: '测试管理员' },
  staff: { id: STAFF_ID, username: 'testadmin', role: 'admin', communities: [] },
  csrfToken: CSRF_TOKEN,
}

function ruleVersion(overrides: Partial<SettlementRuleVersion> = {}): SettlementRuleVersion {
  return {
    id: RULE_ID,
    mappingId: MAPPING_ID,
    version: 3,
    communityId: COMMUNITY_ID,
    productId: PRODUCT_ID,
    sellerPartyId: SELLER_ID,
    sanchuangPartyId: SANCHUANG_ID,
    guangdianPartyId: GUANGDIAN_ID,
    agreementRef: 'AG-2026-001',
    approvalEvidenceRef: '董事会决议 2026-11-01',
    approvalOn: '2026-11-01',
    effectiveFrom: '2026-11-05',
    effectiveTo: '2026-12-31',
    feeBase: 'actual_received',
    processorFeeBps: 100,
    processorFeeOwner: 'seller',
    ratesBps: { seller: 9000, sanchuang: 500, guangdian: 500 },
    roundingRecipient: 'sanchuang',
    roundingPolicy: 'floor_then_named_remainder',
    processorFeeRounding: 'floor',
    reversalPolicy: 'full_reversal_blocks',
    partialRefundPolicy: 'unsupported_blocks',
    approvalStatus: 'admin_attested',
    approvedByUserId: USER_ID,
    approvedAt: '2026-11-02T02:00:00.000Z',
    ...overrides,
  }
}

/**
 * Gross 12345 = processor fee 123 + seller 11000 + sanchuang 611 + guangdian 611.
 * Every number is the server's; the page must not recompute any of them.
 */
function calculatedQuote(overrides: Partial<SettlementQuoteResponse> = {}): SettlementQuoteResponse {
  return {
    orderId: ORDER_ID,
    quoteOnly: true,
    status: 'calculated',
    rule: ruleVersion(),
    allocation: {
      grossReceivedCents: 12345,
      processorFeeCents: 123,
      sellerNetCents: 11000,
      sanchuangNetCents: 611,
      guangdianNetCents: 611,
      totalNetCents: 12222,
      conservedTotalCents: 12345,
      roundingResidualCents: 1,
    },
    payableAmountCents: null,
    blockingReasons: [],
    receiptEntryId: RECEIPT_ID,
    sellerPartyId: SELLER_ID,
    sanchuangPartyId: SANCHUANG_ID,
    guangdianPartyId: null,
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

function callsTo(calls: FetchCall[], route: string): FetchCall[] {
  return calls.filter((call) => call.url.startsWith(route))
}

function urlOf(call: FetchCall): URL {
  return new URL(call.url, 'http://localhost')
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>
}

function renderPanel(session: AuthenticatedSession = ADMIN_SESSION) {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider
          value={{ session, busy: false, error: null, onLogout: async () => undefined }}
        >
          <SettlementQuotePanel />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

function renderPage() {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider
          value={{ session: ADMIN_SESSION, busy: false, error: null, onLogout: async () => undefined }}
        >
          <SettlementsPage />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

function emptyCandidateResponse() {
  return {
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    asOf: '2026-11-11T08:00:00.000Z',
    summaryScope: 'page' as const,
    periodPolicy: 'linked_receipt_else_order_registration' as const,
    summary: {
      recordedReceiptGrossCents: 0,
      reversedReceiptCents: 0,
      blockedItems: 0,
      visibleItems: 0,
    },
    payableAmountCents: null,
    settlementAmountStatus: 'pending_rule' as const,
  }
}

function quoteButton(): HTMLElement {
  return screen.getByRole('button', { name: /试\s*算/ })
}

async function submitQuote(orderId: string = ORDER_ID) {
  fireEvent.change(screen.getByLabelText('订单 ID'), { target: { value: orderId } })
  fireEvent.click(quoteButton())
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

describe('SettlementQuotePanel · calculated', () => {
  it('renders every server-returned integer cent through formatCents and the 试算 boundary', async () => {
    stubApi([[QUOTES_ROUTE, () => json(calculatedQuote())]])
    renderPanel()

    // The permanent boundary is stated before any request is made.
    expect(screen.getAllByText(/试算 ≠ 实际应付 ≠ 结算单锁定 ≠ 付款/).length).toBeGreaterThan(0)
    expect(screen.getByText(/试算由服务端按已核准规则计算，前端只展示返回结果，不按费率乘金额/)).toBeTruthy()
    expect(screen.getByText(/quoteOnly \/ payableAmountCents 恒为空，说明这不是应付金额/)).toBeTruthy()

    await submitQuote()

    expect(await screen.findByText(/服务端已完成试算/)).toBeTruthy()
    // Every displayed amount equals the server's cents value, one-to-one.
    expect(screen.getAllByText('¥123.45').length).toBe(2) // gross + conserved total
    expect(screen.getByText('¥1.23')).toBeTruthy() // processor fee
    expect(screen.getByText('¥110.00')).toBeTruthy() // seller net
    expect(screen.getAllByText('¥6.11').length).toBe(2) // sanchuang + guangdian net
    expect(screen.getByText('¥122.22')).toBeTruthy() // total net
    expect(screen.getByText('¥0.01')).toBeTruthy() // rounding residual

    // Source tracking comes from the response, never from defaults.
    expect(screen.getByText(ORDER_ID)).toBeTruthy()
    expect(screen.getByText(RECEIPT_ID)).toBeTruthy()
    expect(screen.getByText(RULE_ID)).toBeTruthy()
    expect(screen.getByText('v3')).toBeTruthy()
    expect(screen.getAllByText(SELLER_ID).length).toBeGreaterThan(0)
    expect(screen.getByText(SANCHUANG_ID)).toBeTruthy()
    expect(screen.getByText('服务端未返回')).toBeTruthy() // guangdianPartyId is null

    // The page never turns the quote into a payable/paid fact.
    expect(screen.queryAllByText('应付')).toHaveLength(0)
    expect(screen.queryAllByText('已付款')).toHaveLength(0)
    expect(screen.queryAllByText('已结算')).toHaveLength(0)
  })
})

describe('SettlementQuotePanel · pending_rule / blocked', () => {
  it('states 待核定 with the server reasons and no ¥0 at all', async () => {
    stubApi([
      [
        QUOTES_ROUTE,
        () =>
          json(
            calculatedQuote({
              status: 'pending_rule',
              rule: null,
              allocation: null,
              blockingReasons: ['尚无适用于该订单的已核准规则版本', '订单业务事实尚未核验'],
              receiptEntryId: null,
              sellerPartyId: null,
              sanchuangPartyId: null,
              guangdianPartyId: null,
            }),
          ),
      ],
    ])
    renderPanel()

    await submitQuote()

    expect(await screen.findByText(/尚无适用于该订单的已核准规则／待核定/)).toBeTruthy()
    expect(screen.getAllByText('待核定').length).toBeGreaterThan(0)
    expect(screen.getByText('尚无适用于该订单的已核准规则版本')).toBeTruthy()
    expect(screen.getByText('订单业务事实尚未核验')).toBeTruthy()
    // No amount is rendered for a pending quote — especially no fake ¥0.
    expect(document.body.textContent).not.toContain('¥')
    expect(document.body.textContent).not.toContain('¥0')
    expect(screen.queryByText('试算金额（服务端返回的整数分，仅试算）')).toBeNull()
    // Missing tracking fields are stated, not filled with defaults.
    expect(screen.getAllByText('服务端未返回').length).toBeGreaterThan(0)
  })

  it('shows the blocked reasons and no amount', async () => {
    stubApi([
      [
        QUOTES_ROUTE,
        () =>
          json(
            calculatedQuote({
              status: 'blocked',
              rule: null,
              allocation: null,
              blockingReasons: ['订单业务事实未核验', '收款凭据未进入锁定对账'],
              receiptEntryId: null,
              sellerPartyId: null,
              sanchuangPartyId: null,
              guangdianPartyId: null,
            }),
          ),
      ],
    ])
    renderPanel()

    await submitQuote()

    expect(await screen.findByText(/该订单当前不可试算/)).toBeTruthy()
    expect(screen.getByText('订单业务事实未核验')).toBeTruthy()
    expect(screen.getByText('收款凭据未进入锁定对账')).toBeTruthy()
    expect(screen.getByText('已阻塞')).toBeTruthy()
    expect(document.body.textContent).not.toContain('¥')
    expect(screen.queryByText('试算金额（服务端返回的整数分，仅试算）')).toBeNull()
  })
})

describe('SettlementQuotePanel · 请求契约', () => {
  it('POSTs only { orderId } with the CSRF token to the contracted endpoint', async () => {
    const calls = stubApi([[QUOTES_ROUTE, () => json(calculatedQuote())]])
    renderPanel()

    await submitQuote()

    await waitFor(() => expect(callsTo(calls, QUOTES_ROUTE)).toHaveLength(1))
    const post = callsTo(calls, QUOTES_ROUTE)[0]!
    expect(urlOf(post).pathname).toBe(QUOTES_ROUTE)
    expect(post.init?.method).toBe('POST')
    expect(headersOf(post)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init?.body))).toEqual({ orderId: ORDER_ID })
  })

  it('sends nothing for an empty input and only one request while the button is disabled', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const calls = stubApi([[QUOTES_ROUTE, () => pending]])
    renderPanel()

    fireEvent.click(quoteButton())
    expect(await screen.findByText('请先填写订单 UUID，再发起服务端试算。')).toBeTruthy()
    expect(callsTo(calls, QUOTES_ROUTE)).toHaveLength(0)

    fireEvent.change(screen.getByLabelText('订单 ID'), { target: { value: ORDER_ID } })
    fireEvent.click(quoteButton())
    await waitFor(() => expect(quoteButton().hasAttribute('disabled')).toBe(true))
    fireEvent.click(quoteButton())

    resolveFetch?.(json(calculatedQuote()))
    expect(await screen.findByText(/服务端已完成试算/)).toBeTruthy()
    expect(callsTo(calls, QUOTES_ROUTE)).toHaveLength(1)
  })
})

describe('SettlementQuotePanel · 真实错误态', () => {
  it('shows a real 403 without any success or amount', async () => {
    stubApi([
      [QUOTES_ROUTE, () => json({ error: { code: 'forbidden', message: '没有试算权限' } }, 403)],
    ])
    renderPanel()

    await submitQuote()

    expect((await screen.findAllByText(/没有权限/)).length).toBeGreaterThan(0)
    expect(screen.getByText('没有试算权限')).toBeTruthy()
    expect(screen.queryByText(/服务端已完成试算/)).toBeNull()
    expect(screen.queryByText('试算金额（服务端返回的整数分，仅试算）')).toBeNull()
    expect(document.body.textContent).not.toContain('¥')
  })

  it('shows a network failure without any success or amount', async () => {
    stubApi([
      [
        QUOTES_ROUTE,
        () => {
          throw new Error('network down')
        },
      ],
    ])
    renderPanel()

    await submitQuote()

    expect(await screen.findByText(/无法连接管理后台 API/)).toBeTruthy()
    expect(screen.queryByText(/服务端已完成试算/)).toBeNull()
    expect(document.body.textContent).not.toContain('¥')
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy()
  })
})

describe('SettlementQuotePanel · 口径与挂载', () => {
  it('never states 应付/已付款/已结算 as a fact', async () => {
    stubApi([[QUOTES_ROUTE, () => json(calculatedQuote())]])
    renderPanel()

    await submitQuote()
    await screen.findByText(/服务端已完成试算/)

    expect(screen.queryAllByText('应付')).toHaveLength(0)
    expect(screen.queryAllByText('已付款')).toHaveLength(0)
    expect(screen.queryAllByText('已结算')).toHaveLength(0)
    expect(document.body.textContent).not.toMatch(/已付款|已结算/)
    expect(document.body.textContent).not.toMatch(/应付金额[:：]\s*¥?\d/)
    // The negation copy is present instead.
    expect(screen.getByText(/quoteOnly \/ payableAmountCents 恒为空，说明这不是应付金额/)).toBeTruthy()
  })

  it('mounts the 服务端试算 view lazily as the fifth sub-tab of 分成结算单', async () => {
    const calls = stubApi([
      [BATCH_ROUTE, () => json({ items: [], asOf: '2026-11-11T08:00:00.000Z' })],
      [CANDIDATES_ROUTE, () => json(emptyCandidateResponse())],
      [QUOTES_ROUTE, () => json(calculatedQuote())],
    ])
    renderPage()

    expect(await screen.findByRole('tab', { name: '候选看板' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '经营对账' })).toBeNull()
    expect(await screen.findByRole('tab', { name: '服务端试算' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '候选看板' })).toBeTruthy()
    expect(callsTo(calls, QUOTES_ROUTE)).toHaveLength(0)

    fireEvent.click(screen.getByRole('tab', { name: '服务端试算' }))
    expect(await screen.findByText('服务端试算（只读）')).toBeTruthy()
    // Mounting the view never quotes by itself.
    expect(callsTo(calls, QUOTES_ROUTE)).toHaveLength(0)
    expect(document.querySelector('[role="tabpanel"][aria-label="分成结算单"]')).toBeTruthy()
  })
})
