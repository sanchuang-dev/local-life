// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type {
  LedgerEntry,
  LedgerOrderEvidence,
  LocalOrderDetail,
  LocalOrderEvent,
  LocalOrderSummary,
} from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { OrdersPage } from './OrdersPage'

/**
 * These tests drive the real 订单管理 page with an explicitly stubbed `fetch`.
 *
 * The order domain has no payment or activation field at all, so several tests
 * assert the rendered copy directly: 「人工核验通过」 is the only success wording
 * and the banned payment/activation phrases must never appear.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const REVIEWER_ID = '123e4567-e89b-42d3-a456-426614174002'
const RESIDENT_ID = '123e4567-e89b-42d3-a456-426614174003'
const GRID_ID = '123e4567-e89b-42d3-a456-426614174009'
const RECEIPT_ENTRY_ID = '123e4567-e89b-42d3-a456-4266141740aa'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740b2', name: '阳光社区' }
const PRODUCT_ID = '123e4567-e89b-42d3-a456-4266141740c3'
const ORDER_ID = '123e4567-e89b-42d3-a456-4266141740d4'
const EVENT_ID = '123e4567-e89b-42d3-a456-4266141740e5'
const CSRF_TOKEN = 'csrf-token-for-order-page-tests'

const REVIEWER = { id: REVIEWER_ID, displayName: '运营核验员' }
const RESIDENT = { id: RESIDENT_ID, displayName: '居民张三' }

function orderEvent(overrides: Partial<LocalOrderEvent> = {}): LocalOrderEvent {
  return {
    id: EVENT_ID,
    orderId: ORDER_ID,
    event: 'order.registered',
    fromStatus: null,
    toStatus: 'registered',
    actor: RESIDENT,
    actorStaff: null,
    note: null,
    sourceType: 'local_order',
    sourceId: ORDER_ID,
    createdAt: '2026-11-04T02:00:00.000Z',
    ...overrides,
  }
}

function summary(overrides: Partial<LocalOrderSummary> = {}): LocalOrderSummary {
  return {
    id: ORDER_ID,
    community: COMMUNITY_A,
    resident: RESIDENT,
    snapshot: {
      productId: PRODUCT_ID,
      productName: '社区助农蔬菜包',
      unitPriceCents: 1990,
      quantity: 2,
      totalCents: 3980,
      couponId: null,
      couponDiscountCents: 0,
      netPayableCents: 3980,
    },
    status: 'registered',
    recordSource: 'resident',
    createdByStaff: null,
    attributedStaff: null,
    sourceActivity: null,
    sourceTeam: null,
    note: '希望周末自提',
    createdAt: '2026-11-04T02:00:00.000Z',
    updatedAt: '2026-11-04T02:00:00.000Z',
    ...overrides,
  }
}

function detail(overrides: Partial<LocalOrderDetail> = {}): LocalOrderDetail {
  return {
    ...summary(),
    verification: null,
    statusNote: null,
    events: [orderEvent()],
    ...overrides,
  }
}

/** A pending-review order carrying the reviewer's note the verify action records. */
function verifiedDetail(): LocalOrderDetail {
  return detail({
    status: 'verified',
    updatedAt: '2026-11-05T04:00:00.000Z',
    verification: {
      verifiedBy: REVIEWER,
      verifiedAt: '2026-11-05T04:00:00.000Z',
      note: '已电话与居民核对',
    },
    statusNote: '已电话与居民核对',
    events: [
      orderEvent(),
      orderEvent({
        id: '123e4567-e89b-42d3-a456-4266141740f6',
        event: 'order.verified',
        fromStatus: 'pending_review',
        toStatus: 'verified',
        actor: REVIEWER,
        actorStaff: REVIEWER,
        note: '已电话与居民核对',
        createdAt: '2026-11-05T04:00:00.000Z',
      }),
    ],
  })
}

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

const FILTER_OPTIONS = {
  communities: [COMMUNITY_A, COMMUNITY_B],
  staff: [
    { id: STAFF_ID, displayName: '运营员甲', role: 'operator', communities: [COMMUNITY_A] },
    { id: GRID_ID, displayName: '网格员甲', role: 'grid_worker', communities: [COMMUNITY_A] },
  ],
  leadStatuses: [],
  leadSourceTypes: [],
  businessTypes: [],
  orderStatuses: [],
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

/** The receipt section always reads the ledger view of the order it is showing. */
function receiptEvidence(overrides: Partial<LedgerOrderEvidence> = {}): LedgerOrderEvidence {
  return {
    orderId: ORDER_ID,
    orderDisplayNo: ORDER_ID.slice(0, 8).toUpperCase(),
    communityId: COMMUNITY_A.id,
    productName: '社区助农蔬菜包',
    orderStatus: 'registered',
    registeredAmountCents: 3980,
    couponDiscountCents: 0,
    netPayableCents: 3980,
    canRecord: false,
    status: 'pending_order_review',
    blockingReasons: ['订单尚未完成业务核验，不能登记收款关联'],
    payment: null,
    ...overrides,
  }
}

function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    entryId: RECEIPT_ENTRY_ID,
    factKind: 'payment_received',
    sourceSystem: 'manual',
    sourceId: 'manual-receipt-0001',
    sourceDisplayNo: 'RCPT-0001',
    communityId: COMMUNITY_A.id,
    productId: null,
    occurredAt: '2026-11-05T04:00:00.000Z',
    verifiedAt: null,
    amountCents: 3980,
    settlementAmountStatus: 'pending_rule',
    attribution: {
      state: 'pending',
      staffId: null,
      communityId: COMMUNITY_A.id,
      basis: 'no_explicit_attribution',
    },
    evidence: { kind: 'bank_transfer', ref: 'BANK-4821' },
    counterEntryId: null,
    batchId: null,
    reconciliationState: 'unreconciled',
    recordedByUserId: null,
    recordedByStaffId: STAFF_ID,
    createdAt: '2026-11-05T04:00:00.000Z',
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

/** Shared reads every order console performs, plus a default receipt view. */
function stubOrderApi(routes: ReadonlyArray<readonly [string, Handler]>): FetchCall[] {
  return stubApi([
    ...routes,
    ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)],
    ['/api/admin/ledger/orders/', () => json(receiptEvidence())],
  ])
}

function communitiesRoute(
  items: ReadonlyArray<{ id: string; name: string }> = [COMMUNITY_A, COMMUNITY_B],
): readonly [string, Handler] {
  return ['/api/admin/communities', () => json({ items })]
}

function ordersRoute(items: LocalOrderSummary[] = [summary()]): readonly [string, Handler] {
  return ['/api/admin/local-orders?', () => json({ items, total: items.length, page: 1, pageSize: 20 })]
}

function renderPage(session: AuthenticatedSession) {
  const router = createMemoryRouter([{ path: '/orders', element: <OrdersPage /> }], {
    initialEntries: ['/orders'],
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

describe('OrdersPage permission boundary', () => {
  it('renders the grid-worker lockout page and issues zero admin order requests', async () => {
    const calls = stubOrderApi([
      [
        '/api/',
        (url) => {
          throw new Error(`grid worker must not call the admin API: ${url}`)
        },
      ],
    ])

    renderPage(GRID_SESSION)

    expect(await screen.findByText('网格员没有后台订单核验权限')).toBeTruthy()
    expect(screen.getByText(/服务端同样返回 403/)).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('shows the real 403 instead of an empty success list', async () => {
    stubOrderApi([
      communitiesRoute(),
      [
        '/api/admin/local-orders?',
        () => json({ error: { code: 'forbidden', message: '网格员无权执行订单核验' } }, 403),
      ],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('没有订单管理权限')).toBeTruthy()
    expect(screen.getByText('网格员无权执行订单核验')).toBeTruthy()
  })
})

describe('OrdersPage list', () => {
  it('renders the frozen snapshot from the server, not a recomputed price', async () => {
    stubOrderApi([communitiesRoute(), ordersRoute()])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('社区助农蔬菜包')).toBeTruthy()
    expect(screen.getByText('2 件 × ¥19.90')).toBeTruthy()
    expect(screen.getByText('合计 ¥39.80')).toBeTruthy()
    expect(screen.getByText('居民张三')).toBeTruthy()
    expect(screen.getByText('幸福社区')).toBeTruthy()
    expect(screen.getAllByText('已登记').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/支付成功|已成交|已开通/)
  })

  it('scopes the operator to assigned communities and says so', async () => {
    const calls = stubOrderApi([communitiesRoute([COMMUNITY_A]), ordersRoute()])

    renderPage(OPERATOR_SESSION)

    expect(await screen.findByText(/仅能查看与处理管理员分配的社区/)).toBeTruthy()
    await waitFor(() => {
      const listUrl = calledUrls(calls).find((url) => url.startsWith('/api/admin/local-orders?'))
      expect(listUrl).toContain(`communityId=${COMMUNITY_A.id}`)
    })
  })

  it('reports the real detail error when the order cannot be read', async () => {
    stubOrderApi([
      communitiesRoute(),
      ordersRoute(),
      [
        `/api/admin/local-orders/${ORDER_ID}`,
        () => json({ error: { code: 'not_found', message: '订单不存在' } }, 404),
      ],
    ])

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: '详情' }))

    expect(await screen.findByText('订单详情加载失败')).toBeTruthy()
    expect(screen.getByText(/数据不存在或已下线：订单不存在/)).toBeTruthy()
  })
})

describe('OrdersPage handling', () => {
  it('moves a registered order to processing through the PATCH status route', async () => {
    let statusCall: FetchCall | undefined
    stubOrderApi([
      communitiesRoute(),
      ordersRoute(),
      [
        `/api/admin/local-orders/${ORDER_ID}/status`,
        (url, init) => {
          statusCall = { url, init }
          return json(detail({ status: 'processing', updatedAt: '2026-11-05T03:00:00.000Z' }))
        },
      ],
      [`/api/admin/local-orders/${ORDER_ID}`, () => json(detail())],
    ])

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: '详情' }))
    expect(await screen.findByText('订单时间线')).toBeTruthy()
    expect(screen.getByText(/本订单只登记办理意向/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '开始处理' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认提交' }))

    await waitFor(() => expect(statusCall).toBeTruthy())
    expect(statusCall?.init?.method).toBe('PATCH')
    const headers = (statusCall?.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(statusCall?.init?.body))).toEqual({
      expectedUpdatedAt: '2026-11-04T02:00:00.000Z',
      status: 'processing',
    })
    expect(await screen.findByText(/订单状态已更新为「处理中」/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/支付成功|已开通/)
  })

  it('requires a reason before marking an order not passed, then posts it', async () => {
    let statusCall: FetchCall | undefined
    stubOrderApi([
      communitiesRoute(),
      ordersRoute(),
      [
        `/api/admin/local-orders/${ORDER_ID}/status`,
        (url, init) => {
          statusCall = { url, init }
          return json(
            detail({
              status: 'rejected',
              statusNote: '居民取消办理',
              updatedAt: '2026-11-05T03:00:00.000Z',
            }),
          )
        },
      ],
      [`/api/admin/local-orders/${ORDER_ID}`, () => json(detail())],
    ])

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: '详情' }))
    expect(await screen.findByText('订单时间线')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '标记未通过' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认标记未通过' }))

    expect(await screen.findByText('标记未通过必须填写原因。')).toBeTruthy()
    expect(statusCall).toBeUndefined()

    fireEvent.change(screen.getByLabelText('未通过原因'), {
      target: { value: '居民取消办理' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认标记未通过' }))

    await waitFor(() => expect(statusCall).toBeTruthy())
    expect(JSON.parse(String(statusCall?.init?.body))).toEqual({
      expectedUpdatedAt: '2026-11-04T02:00:00.000Z',
      status: 'rejected',
      note: '居民取消办理',
    })
  })

  it('verifies a pending order and renders the human-verification wording only', async () => {
    let verifyCall: FetchCall | undefined
    const pending = detail({
      status: 'pending_review',
      updatedAt: '2026-11-05T02:00:00.000Z',
    })
    stubOrderApi([
      communitiesRoute(),
      ordersRoute([{ ...pending }]),
      [
        `/api/admin/local-orders/${ORDER_ID}/verify`,
        (url, init) => {
          verifyCall = { url, init }
          return json(verifiedDetail())
        },
      ],
      [`/api/admin/local-orders/${ORDER_ID}`, () => json(pending)],
    ])

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: '人工核验' }))
    expect(await screen.findByText('运营人工核验')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '确认人工核验通过' }))
    expect(
      await screen.findByText('核验备注必填（至少 2 个字符）；驳回时必须写明原因。'),
    ).toBeTruthy()
    expect(verifyCall).toBeUndefined()

    fireEvent.change(screen.getByLabelText('核验备注'), {
      target: { value: '已电话与居民核对' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认人工核验通过' }))

    await waitFor(() => expect(verifyCall).toBeTruthy())
    expect(verifyCall?.url).toBe(`/api/admin/local-orders/${ORDER_ID}/verify`)
    expect(verifyCall?.init?.method).toBe('POST')
    const headers = (verifyCall?.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(verifyCall?.init?.body))).toEqual({
      expectedUpdatedAt: '2026-11-05T02:00:00.000Z',
      decision: 'verify',
      note: '已电话与居民核对',
    })

    expect(await screen.findByText('人工核验结果')).toBeTruthy()
    expect(screen.getAllByText('人工核验通过').length).toBeGreaterThan(0)
    expect(screen.getByText(/不代表收款、成交或业务办理已完成/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/支付成功|已开通|已成交/)
  })

  it('shows the real 409 when the order was already verified elsewhere', async () => {
    const pending = detail({
      status: 'pending_review',
      updatedAt: '2026-11-05T02:00:00.000Z',
    })
    stubOrderApi([
      communitiesRoute(),
      ordersRoute([{ ...pending }]),
      [
        `/api/admin/local-orders/${ORDER_ID}/verify`,
        () =>
          json(
            { error: { code: 'order_already_verified', message: '该订单已人工核验' } },
            409,
          ),
      ],
      [`/api/admin/local-orders/${ORDER_ID}`, () => json(pending)],
    ])

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: '人工核验' }))
    fireEvent.change(await screen.findByLabelText('核验备注'), {
      target: { value: '已电话与居民核对' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认人工核验通过' }))

    expect(await screen.findByText('核验未提交')).toBeTruthy()
    expect(screen.getByText(/数据已被更新：该订单已人工核验/)).toBeTruthy()
    // The operator's note survives the conflict.
    expect((screen.getByLabelText('核验备注') as HTMLTextAreaElement).value).toBe(
      '已电话与居民核对',
    )
  })

  it('never offers a direct "verified" status button', async () => {
    const draft = detail({ status: 'pending_review' })
    stubOrderApi([
      communitiesRoute(),
      ordersRoute([summary({ status: 'pending_review' })]),
      [`/api/admin/local-orders/${ORDER_ID}`, () => json(draft)],
    ])

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: '人工核验' }))
    expect(await screen.findByText('运营人工核验')).toBeTruthy()
    // Only the review box may produce `verified`; the status buttons stop at
    // 提交核验, and no button says 通过/完成 without 人工核验 in its label.
    expect(screen.queryByRole('button', { name: '确认通过' })).toBeNull()
    expect(screen.queryByRole('button', { name: '核验通过' })).toBeNull()
    expect(screen.getByRole('button', { name: '确认人工核验通过' })).toBeTruthy()
  })
})

describe('OrdersPage receipt evidence', () => {
  it('shows the receipt section for the selected order and offers no second order search', async () => {
    stubOrderApi([
      communitiesRoute(),
      ordersRoute([summary({ status: 'verified' })]),
      [`/api/admin/local-orders/${ORDER_ID}`, () => json(verifiedDetail())],
      [
        '/api/admin/ledger/orders/',
        () =>
          json(
            receiptEvidence({
              orderStatus: 'verified',
              canRecord: true,
              status: 'no_evidence',
              blockingReasons: ['尚无实收证明，请登记真实收款凭据'],
            }),
          ),
      ],
    ])

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: '详情' }))

    expect(await screen.findByText('收款凭据与业绩归属')).toBeTruthy()
    expect(screen.getByRole('button', { name: '记录凭据（不代表结算）' })).toBeTruthy()
    // The order is already selected: the old 搜索订单 → 再次选择订单 flow is gone.
    expect(screen.queryByPlaceholderText(/按商品名称/)).toBeNull()
    expect(screen.queryByRole('button', { name: '查找订单' })).toBeNull()
    expect(screen.queryByText('检索订单 / 登记凭据')).toBeNull()
  })

  it('records a receipt through the ledger API with CSRF and reloads its evidence', async () => {
    let recordCall: FetchCall | undefined
    let evidenceReads = 0
    stubOrderApi([
      communitiesRoute(),
      ordersRoute([summary({ status: 'verified' })]),
      [`/api/admin/local-orders/${ORDER_ID}`, () => json(verifiedDetail())],
      [
        '/api/admin/ledger/orders/',
        () =>
          json(
            evidenceReads++ === 0
              ? receiptEvidence({
                  orderStatus: 'verified',
                  canRecord: true,
                  status: 'no_evidence',
                  blockingReasons: ['尚无实收证明，请登记真实收款凭据'],
                })
              : receiptEvidence({
                  orderStatus: 'verified',
                  status: 'pending_attribution',
                  blockingReasons: ['业绩归属尚未确认，不能作为结算依据'],
                  payment: {
                    entryId: RECEIPT_ENTRY_ID,
                    amountCents: 3980,
                    receivedAt: '2026-11-05T04:00:00.000Z',
                    evidenceKind: 'bank_transfer',
                    evidenceRef: 'BANK-4821',
                    recordedByStaffId: STAFF_ID,
                    attribution: {
                      state: 'pending',
                      staffId: null,
                      communityId: COMMUNITY_A.id,
                      basis: 'no_explicit_attribution',
                    },
                    reversedEntryId: null,
                    confirmation: null,
                  },
                }),
          ),
      ],
      [
        '/api/admin/ledger/payments',
        (url, init) => {
          recordCall = { url, init }
          return json(ledgerEntry(), 201)
        },
      ],
    ])

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: '详情' }))
    await screen.findByText('收款凭据与业绩归属')

    fireEvent.change(screen.getByLabelText('凭据编号'), { target: { value: 'BANK-4821' } })
    fireEvent.click(screen.getByRole('button', { name: '记录凭据（不代表结算）' }))

    await waitFor(() => expect(recordCall).toBeTruthy())
    const sent = recordCall!
    expect(sent.url).toBe('/api/admin/ledger/payments')
    expect(sent.init?.method).toBe('POST')
    expect((sent.init!.headers as Record<string, string>)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(sent.init!.body))).toMatchObject({
      communityId: COMMUNITY_A.id,
      orderId: ORDER_ID,
      amountCents: 3980,
      evidenceKind: 'bank_transfer',
      evidenceRef: 'BANK-4821',
      staffId: STAFF_ID,
    })
    expect(
      await screen.findByText('凭据已登记，仍需核对金额和业绩归属；不代表完成对账或付款。'),
    ).toBeTruthy()
    await waitFor(() => expect(screen.getByText('BANK-4821')).toBeTruthy())
  })

  it('confirms pending attribution as an append-only audit record', async () => {
    let attributionCall: FetchCall | undefined
    stubOrderApi([
      communitiesRoute(),
      ordersRoute([summary({ status: 'verified' })]),
      [`/api/admin/local-orders/${ORDER_ID}`, () => json(verifiedDetail())],
      [
        '/api/admin/ledger/orders/',
        () =>
          json(
            receiptEvidence({
              orderStatus: 'verified',
              status: 'pending_attribution',
              blockingReasons: ['业绩归属尚未确认，不能作为结算依据'],
              payment: {
                entryId: RECEIPT_ENTRY_ID,
                amountCents: 3980,
                receivedAt: '2026-11-05T04:00:00.000Z',
                evidenceKind: 'bank_transfer',
                evidenceRef: 'BANK-4821',
                recordedByStaffId: STAFF_ID,
                attribution: {
                  state: 'pending',
                  staffId: null,
                  communityId: COMMUNITY_A.id,
                  basis: 'no_explicit_attribution',
                },
                reversedEntryId: null,
                confirmation: null,
              },
            }),
          ),
      ],
      [
        '/api/admin/ledger/attributions',
        (url, init) => {
          attributionCall = { url, init }
          return json(
            ledgerEntry({
              attribution: {
                state: 'attributed',
                staffId: GRID_ID,
                communityId: COMMUNITY_A.id,
                basis: 'confirmed_fact',
              },
            }),
            201,
          )
        },
      ],
    ])

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: '详情' }))
    expect(await screen.findByText('确认业绩归属')).toBeTruthy()

    fireEvent.mouseDown(screen.getByLabelText('实际推广贡献网格员'))
    const option = (await screen.findAllByText('网格员甲（网格员）')).find((element) =>
      element.closest('.ant-select-item-option'),
    )
    expect(option).toBeTruthy()
    fireEvent.click(option as Element)

    fireEvent.change(screen.getByLabelText('归属核验依据'), {
      target: { value: '居民出示网格员推广登记记录' },
    })
    fireEvent.click(screen.getByRole('button', { name: '追加确认记录' }))

    await waitFor(() => expect(attributionCall).toBeTruthy())
    const sent = attributionCall!
    expect(sent.url).toBe('/api/admin/ledger/attributions')
    expect((sent.init!.headers as Record<string, string>)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(sent.init!.body))).toEqual({
      entryId: RECEIPT_ENTRY_ID,
      staffId: GRID_ID,
      note: '居民出示网格员推广登记记录',
    })
    expect(await screen.findByText('业绩归属已追加确认记录，不改变原始流水。')).toBeTruthy()
  })
})
