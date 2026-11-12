// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type {
  AdminCrmFilterOptionsResponse,
  CrmFollowUp,
  CrmLeadDetail,
  CrmLeadEvent,
  CrmLeadSummary,
  CrmOrderDetail,
  CrmOrderEvent,
  CrmOrderSummary,
} from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { listAdminCrmLeads, listAdminCrmOrders, reviewAdminCrmOrder } from '../services/crm'
import { CrmPage } from './CrmPage'

/**
 * These tests drive the real CRM page with an explicitly stubbed `fetch`.
 *
 * Each test declares exactly which HTTP URLs it answers; an unexpected URL
 * throws, so a page that silently fell back to fake data would fail loudly.
 * Payloads follow the shared contracts, and error tests assert the real server
 * error instead of a success-looking placeholder.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const OWNER_ID = '123e4567-e89b-42d3-a456-426614174002'
const PROMOTION_ID = '123e4567-e89b-42d3-a456-426614174003'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740b2', name: '阳光社区' }
const ACTIVITY_ID = '123e4567-e89b-42d3-a456-4266141740c3'
const LEAD_ID = '123e4567-e89b-42d3-a456-4266141740d4'
const ORDER_ID = '123e4567-e89b-42d3-a456-4266141740e5'
const FOLLOW_UP_ID = '123e4567-e89b-42d3-a456-4266141740f6'
const LEAD_EVENT_ID = '123e4567-e89b-42d3-a456-426614174107'
const ORDER_EVENT_ID = '123e4567-e89b-42d3-a456-426614174108'
const CSRF_TOKEN = 'csrf-token-for-crm-page-tests'

const OWNER = { id: OWNER_ID, displayName: '网格员甲' }
const PROMOTION = { id: PROMOTION_ID, displayName: '网格员乙' }
const REVIEWER = { id: USER_ID, displayName: '运营审核员' }

function leadSummary(overrides: Partial<CrmLeadSummary> = {}): CrmLeadSummary {
  return {
    id: LEAD_ID,
    community: COMMUNITY_A,
    ownerStaff: OWNER,
    contactName: '张三',
    contactPhoneMasked: '138****1234',
    sourceType: 'activity',
    sourceActivity: { id: ACTIVITY_ID, title: '秋季社区欢乐季' },
    promotionStaff: null,
    status: 'contacting',
    followUpCount: 1,
    nextContactAt: '2026-11-06T02:00:00.000Z',
    lastContactedAt: '2026-11-04T02:00:00.000Z',
    createdAt: '2026-11-03T02:00:00.000Z',
    updatedAt: '2026-11-04T02:00:00.000Z',
    ...overrides,
  }
}

function leadDetail(overrides: Partial<CrmLeadDetail> = {}): CrmLeadDetail {
  return {
    ...leadSummary(),
    contactPhone: '13800001234',
    residentUserId: null,
    createdByStaff: OWNER,
    ...overrides,
  }
}

const FOLLOW_UP: CrmFollowUp = {
  id: FOLLOW_UP_ID,
  leadId: LEAD_ID,
  staff: OWNER,
  content: '已电话联系，确认办理意向',
  nextContactAt: '2026-11-06T02:00:00.000Z',
  createdAt: '2026-11-04T02:00:00.000Z',
}

function leadEvent(overrides: Partial<CrmLeadEvent> = {}): CrmLeadEvent {
  return {
    id: LEAD_EVENT_ID,
    leadId: LEAD_ID,
    event: 'lead.follow_up_added',
    fromStatus: 'new',
    toStatus: 'contacting',
    fromOwnerStaff: null,
    toOwnerStaff: OWNER,
    actor: REVIEWER,
    note: '已电话联系，确认办理意向',
    createdAt: '2026-11-04T02:00:00.000Z',
    ...overrides,
  }
}

function orderSummary(overrides: Partial<CrmOrderSummary> = {}): CrmOrderSummary {
  return {
    id: ORDER_ID,
    community: COMMUNITY_A,
    leadId: LEAD_ID,
    orderNo: 'GD20261104001',
    businessType: 'gd_mobile',
    status: 'pending_verification',
    customerName: '张三',
    contactPhoneMasked: '138****1234',
    attributedStaff: OWNER,
    sourceActivity: { id: ACTIVITY_ID, title: '秋季社区欢乐季' },
    promotionStaff: null,
    confirmedBy: null,
    confirmedAt: null,
    createdAt: '2026-11-04T02:00:00.000Z',
    updatedAt: '2026-11-04T03:00:00.000Z',
    ...overrides,
  }
}

function orderEvent(overrides: Partial<CrmOrderEvent> = {}): CrmOrderEvent {
  return {
    id: ORDER_EVENT_ID,
    orderId: ORDER_ID,
    event: 'order.status_changed',
    fromStatus: 'processing',
    toStatus: 'pending_verification',
    actor: OWNER,
    note: '已提交运营商受理截图',
    createdAt: '2026-11-04T03:00:00.000Z',
    ...overrides,
  }
}

function orderDetail(overrides: Partial<CrmOrderDetail> = {}): CrmOrderDetail {
  return {
    ...orderSummary(),
    contactPhone: '13800001234',
    evidenceRef: '受理截图 2026-11-04 #3',
    notes: '客户要求晚场安装',
    createdByStaff: OWNER,
    confirmation: null,
    failureReason: null,
    activationSource: null,
    events: [orderEvent()],
    ...overrides,
  }
}

function confirmedOrderDetail(overrides: Partial<CrmOrderDetail> = {}): CrmOrderDetail {
  return orderDetail({
    status: 'confirmed',
    confirmedBy: REVIEWER,
    confirmedAt: '2026-11-04T04:00:00.000Z',
    updatedAt: '2026-11-04T04:00:00.000Z',
    confirmation: {
      confirmedBy: REVIEWER,
      confirmedAt: '2026-11-04T04:00:00.000Z',
      note: '已电话核验',
    },
    activationSource: 'manual_verification',
    events: [
      orderEvent(),
      orderEvent({
        id: '123e4567-e89b-42d3-a456-426614174109',
        event: 'order.reviewed',
        fromStatus: 'pending_verification',
        toStatus: 'confirmed',
        actor: REVIEWER,
        note: '已电话核验',
        createdAt: '2026-11-04T04:00:00.000Z',
      }),
    ],
    ...overrides,
  })
}

const FILTER_OPTIONS: AdminCrmFilterOptionsResponse = {
  communities: [COMMUNITY_A, COMMUNITY_B],
  staff: [
    { id: OWNER_ID, displayName: '网格员甲', role: 'grid_worker', communities: [COMMUNITY_A] },
    {
      id: PROMOTION_ID,
      displayName: '网格员乙',
      role: 'grid_worker',
      communities: [COMMUNITY_A, COMMUNITY_B],
    },
  ],
  leadStatuses: ['new', 'contacting', 'converted', 'invalid'],
  leadSourceTypes: ['activity', 'grid_promotion', 'walk_in', 'resident_referral'],
  businessTypes: ['gd_mobile', 'gd_tv'],
  orderStatuses: ['submitted', 'processing', 'pending_verification', 'confirmed', 'failed', 'cancelled'],
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

const GRID_SESSION: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: {
    id: STAFF_ID,
    username: 'grid.a',
    role: 'grid_worker',
    communities: [COMMUNITY_A],
  },
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

/** Stubs `fetch` with an ordered prefix table; unknown URLs throw immediately. */
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

/**
 * Renders the CRM page at its real `/customers` route so the `view` query
 * param behaves exactly like in the browser shell (deep links, back/forward).
 */
function renderPage(session: AuthenticatedSession, initialPath = '/customers') {
  const router = createMemoryRouter([{ path: '/customers', element: <CrmPage /> }], {
    initialEntries: [initialPath],
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

/** The advanced-filter modal is force-rendered, so every field label appears twice. */
function firstLabel(text: string): HTMLElement {
  const elements = screen.getAllByLabelText(text)
  expect(elements.length).toBeGreaterThan(0)
  return elements[0] as HTMLElement
}

function calledUrls(calls: FetchCall[]): string[] {
  return calls.map((call) => call.url)
}

function stubListOptions(): readonly [string, Handler] {
  return ['/api/admin/crm/filter-options', () => json(FILTER_OPTIONS)]
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 1024,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CrmPage permission boundary', () => {
  it('renders the grid-worker lockout page and issues zero CRM requests', async () => {
    const calls = stubApi([
      [
        '/api/',
        (url) => {
          throw new Error(`grid worker must not call the API: ${url}`)
        },
      ],
    ])

    renderPage(GRID_SESSION)

    expect(await screen.findByText('网格员没有后台 CRM 审核权限')).toBeTruthy()
    expect(
      screen.getByText(/即使直接访问该地址，服务端同样会拒绝网格员的后台 CRM 请求/),
    ).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('shows the real 403 error for the lead list instead of an empty success', async () => {
    stubApi([
      stubListOptions(),
      [
        '/api/admin/crm/leads?',
        () => json({ error: { code: 'forbidden', message: '网格员无权查看后台 CRM' } }, 403),
      ],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('没有客户线索权限')).toBeTruthy()
    expect(screen.getByText('网格员无权查看后台 CRM')).toBeTruthy()
    expect(screen.queryByText('张三')).toBeNull()
  })

  it('shows the real 403 error for the order list', async () => {
    stubApi([
      stubListOptions(),
      ['/api/admin/crm/leads?', () => json({ items: [], total: 0, page: 1, pageSize: 20 })],
      [
        '/api/admin/crm/orders?',
        () => json({ error: { code: 'forbidden', message: '没有业务单查询权限' } }, 403),
      ],
    ])

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('tab', { name: '业务受理单' }))

    expect(await screen.findByText('没有业务受理单权限')).toBeTruthy()
    expect(screen.getByText('没有业务单查询权限')).toBeTruthy()
  })
})

describe('CrmPage view deep link', () => {
  function leadsRoute(items: CrmLeadSummary[] = [leadSummary()]): readonly [string, Handler] {
    return ['/api/admin/crm/leads?', () => json({ items, total: items.length, page: 1, pageSize: 20 })]
  }

  function ordersRoute(items: CrmOrderSummary[] = [orderSummary()]): readonly [string, Handler] {
    return [
      '/api/admin/crm/orders?',
      () => json({ items, total: items.length, page: 1, pageSize: 20 }),
    ]
  }

  /** The CRM second-level tab bar must live inside the white sticky page header. */
  function headerTabs(): HTMLElement {
    const bar = document.querySelector('.page-header .page-header-subnav .ant-tabs')
    expect(bar).toBeTruthy()
    return bar as HTMLElement
  }

  function activeHeaderTab(): string | null {
    return headerTabs().querySelector('.ant-tabs-tab-active')?.textContent ?? null
  }

  /** Both keep-alive subviews stay in the DOM once mounted, so scope queries. */
  function subview(view: 'leads' | 'orders'): HTMLElement {
    const element = document.querySelector(`.crm-subview[data-view="${view}"]`)
    expect(element).toBeTruthy()
    return element as HTMLElement
  }

  it('defaults to the leads view without a param and never rewrites the URL', async () => {
    const calls = stubApi([stubListOptions(), leadsRoute(), ordersRoute()])
    const { router } = renderPage(ADMIN_SESSION)

    expect(await screen.findByText('张三')).toBeTruthy()
    expect(activeHeaderTab()).toBe('客户线索')
    expect(router.state.location.search).toBe('')
    // The orders panel stays unmounted until its first activation.
    expect(calledUrls(calls).some((url) => url.startsWith('/api/admin/crm/orders?'))).toBe(false)
  })

  it('opens the orders view directly from ?view=orders without fetching leads', async () => {
    const calls = stubApi([stubListOptions(), leadsRoute(), ordersRoute()])
    renderPage(ADMIN_SESSION, '/customers?view=orders')

    expect(await screen.findByText('GD20261104001')).toBeTruthy()
    expect(activeHeaderTab()).toBe('业务受理单')
    expect(calledUrls(calls).some((url) => url.startsWith('/api/admin/crm/orders?'))).toBe(true)
    expect(calledUrls(calls).some((url) => url.startsWith('/api/admin/crm/leads?'))).toBe(false)
  })

  it('falls back to the leads view for an unrecognized view param', async () => {
    stubApi([stubListOptions(), leadsRoute(), ordersRoute()])
    const { router } = renderPage(ADMIN_SESSION, '/customers?view=whatever')

    expect(await screen.findByText('张三')).toBeTruthy()
    expect(activeHeaderTab()).toBe('客户线索')
    expect(router.state.location.search).toBe('?view=whatever')
  })

  it('pushes one history entry per tab switch and replays views on back/forward', async () => {
    stubApi([stubListOptions(), leadsRoute(), ordersRoute()])
    const { router } = renderPage(ADMIN_SESSION)

    expect(await screen.findByText('张三')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '业务受理单' }))
    await waitFor(() => expect(router.state.location.search).toBe('?view=orders'))
    expect(await screen.findByText('GD20261104001')).toBeTruthy()
    expect(activeHeaderTab()).toBe('业务受理单')

    fireEvent.click(screen.getByRole('tab', { name: '客户线索' }))
    await waitFor(() => expect(router.state.location.search).toBe('?view=leads'))
    expect(activeHeaderTab()).toBe('客户线索')
    expect(await within(subview('leads')).findByText('张三')).toBeTruthy()

    await act(() => router.navigate(-1))
    expect(router.state.location.search).toBe('?view=orders')
    expect(activeHeaderTab()).toBe('业务受理单')
    expect(await within(subview('orders')).findByText('GD20261104001')).toBeTruthy()

    await act(() => router.navigate(-1))
    expect(router.state.location.search).toBe('')
    expect(activeHeaderTab()).toBe('客户线索')

    await act(() => router.navigate(1))
    expect(router.state.location.search).toBe('?view=orders')
    expect(activeHeaderTab()).toBe('业务受理单')
  })

  it('keeps an unsubmitted lead keyword while switching views and back', async () => {
    stubApi([stubListOptions(), leadsRoute(), ordersRoute()])
    const { router } = renderPage(ADMIN_SESSION)

    expect(await screen.findByText('张三')).toBeTruthy()
    const keywordInput = () =>
      within(subview('leads')).getAllByLabelText('关键词')[0] as HTMLInputElement
    fireEvent.change(keywordInput(), { target: { value: '张' } })
    // No 查询 click: the draft has not been submitted to the server yet.

    fireEvent.click(screen.getByRole('tab', { name: '业务受理单' }))
    await waitFor(() => expect(router.state.location.search).toBe('?view=orders'))
    expect(await within(subview('orders')).findByText('GD20261104001')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '客户线索' }))
    await waitFor(() => expect(router.state.location.search).toBe('?view=leads'))
    expect(keywordInput().value).toBe('张')
  })
})

describe('CrmPage lead list', () => {
  it('renders real lead rows and applies keyword/status filters through the server query', async () => {
    let listUrl = ''
    const calls = stubApi([
      stubListOptions(),
      [
        '/api/admin/crm/leads?',
        (url) => {
          listUrl = url
          return json({ items: [leadSummary()], total: 1, page: 1, pageSize: 20 })
        },
      ],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('张三')).toBeTruthy()
    expect(screen.getByText('幸福社区')).toBeTruthy()
    expect(screen.getByText('网格员甲')).toBeTruthy()
    expect(screen.getByText('活动 · 秋季社区欢乐季')).toBeTruthy()
    expect(screen.getByText('跟进中')).toBeTruthy()
    expect(screen.getByText('2026-11-06 10:00')).toBeTruthy()

    await waitFor(() => {
      const initialUrl = calledUrls(calls).find((url) => url.startsWith('/api/admin/crm/leads?'))
      expect(initialUrl).toContain('page=1')
      expect(initialUrl).toContain('pageSize=20')
    })

    fireEvent.change(firstLabel('关键词'), { target: { value: '张' } })
    fireEvent.mouseDown(firstLabel('线索状态'))
    const statusOption = (await screen.findAllByText('跟进中')).find((element) =>
      element.closest('.ant-select-item-option'),
    )
    expect(statusOption).toBeTruthy()
    fireEvent.click(statusOption as Element)
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))

    await waitFor(() => {
      expect(listUrl).toContain('keyword=%E5%BC%A0')
      expect(listUrl).toContain('status=contacting')
      expect(listUrl).toContain('page=1')
    })
  })

  it('keeps the operator scoped and renders grid-promotion attribution', async () => {
    stubApi([
      stubListOptions(),
      [
        '/api/admin/crm/leads?',
        () =>
          json({
            items: [
              leadSummary({
                sourceType: 'grid_promotion',
                sourceActivity: null,
                promotionStaff: PROMOTION,
                ownerStaff: PROMOTION,
              }),
            ],
            total: 1,
            page: 1,
            pageSize: 20,
          }),
      ],
    ])

    renderPage(OPERATOR_SESSION)

    expect(await screen.findByText(/仅能查看与审核管理员分配的社区/)).toBeTruthy()
    expect(await screen.findByText('网格推广 · 网格员乙')).toBeTruthy()
  })

  it('renders the follow-up and audit timelines from the real endpoints', async () => {
    stubApi([
      stubListOptions(),
      [
        '/api/admin/crm/leads?',
        () => json({ items: [leadSummary()], total: 1, page: 1, pageSize: 20 }),
      ],
      [`/api/crm/leads/${LEAD_ID}/follow-ups`, () => json({ items: [FOLLOW_UP] })],
      [`/api/admin/crm/leads/${LEAD_ID}/audit`, () => json({ items: [leadEvent()] })],
      [`/api/admin/crm/leads/${LEAD_ID}`, () => json(leadDetail())],
    ])

    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('张三')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '详情' }))

    expect(await screen.findByText('13800001234')).toBeTruthy()
    expect((await screen.findAllByText('已电话联系，确认办理意向')).length).toBeGreaterThan(0)
    expect(screen.getByText('活动「秋季社区欢乐季」')).toBeTruthy()
    expect(screen.getByText('新增跟进')).toBeTruthy()
  })
})

describe('CrmPage order list and manual review', () => {
  function orderRoutes(
    reviewHandler: Handler,
    detailResponses: Array<() => Response> = [() => json(orderDetail())],
  ): ReadonlyArray<readonly [string, Handler]> {
    let detailIndex = 0
    return [
      stubListOptions(),
      ['/api/admin/crm/leads?', () => json({ items: [], total: 0, page: 1, pageSize: 20 })],
      [
        '/api/admin/crm/orders?',
        () =>
          json({
            items: [
              orderSummary(),
              orderSummary({
                id: '123e4567-e89b-42d3-a456-426614174110',
                orderNo: 'GD20261104002',
                status: 'submitted',
                createdAt: '2026-11-05T02:00:00.000Z',
                updatedAt: '2026-11-05T02:00:00.000Z',
              }),
            ],
            total: 2,
            page: 1,
            pageSize: 20,
          }),
      ],
      [
        `/api/admin/crm/orders/${ORDER_ID}/review`,
        (url, init) => reviewHandler(url, init),
      ],
      [
        `/api/admin/crm/orders/${ORDER_ID}`,
        () => {
          const response = detailResponses[Math.min(detailIndex, detailResponses.length - 1)]()
          detailIndex += 1
          return response
        },
      ],
    ]
  }

  async function openPendingOrder() {
    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('tab', { name: '业务受理单' }))
    expect(await screen.findByText('GD20261104001')).toBeTruthy()
    // "已提交受理" and "待核验" stay visibly different from the verified deal.
    expect(screen.getAllByText('已提交受理').length).toBeGreaterThan(0)
    expect(screen.getAllByText('待核验').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '审核' }))
    expect(await screen.findByText('成交归属快照')).toBeTruthy()
    expect(screen.getByText('受理截图 2026-11-04 #3')).toBeTruthy()
    expect(screen.getByText('已提交运营商受理截图')).toBeTruthy()
  }

  it('confirms a verified deal only after the confirm dialog and the real CSRF token', async () => {
    let reviewCall: FetchCall | undefined
    const calls = stubApi(
      orderRoutes((url, init) => {
        reviewCall = { url, init }
        return json(confirmedOrderDetail())
      }),
    )

    await openPendingOrder()

    fireEvent.change(firstLabel('核验备注'), {
      target: { value: '已电话核验' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认有效成交' }))

    expect(
      await screen.findByText(
        '确认后状态将变为「有效成交（人工核验）」；这是人工核验结论，不代表运营商业务已办理完成。',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认提交核验' }))

    await waitFor(() => {
      expect(reviewCall?.url).toBe(`/api/admin/crm/orders/${ORDER_ID}/review`)
    })
    expect(reviewCall?.init?.method).toBe('POST')
    const headers = (reviewCall?.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(reviewCall?.init?.body))).toEqual({
      expectedUpdatedAt: '2026-11-04T03:00:00.000Z',
      decision: 'confirm',
      note: '已电话核验',
    })

    expect(await screen.findByText('人工核验信息')).toBeTruthy()
    expect(screen.getAllByText('运营审核员').length).toBeGreaterThan(0)
    expect(screen.getByText('人工核验（manual_verification）')).toBeTruthy()
    // The list is re-read from the server after the review.
    await waitFor(() => {
      expect(
        calledUrls(calls).filter((url) => url.startsWith('/api/admin/crm/orders?')).length,
      ).toBeGreaterThanOrEqual(2)
    })
    expect(document.body.textContent).not.toMatch(/已开通|已激活/)
  })

  it('requires a reason before rejecting and posts the reject decision', async () => {
    let reviewCall: FetchCall | undefined
    const failed = orderDetail({
      status: 'failed',
      failureReason: '客户资质不符',
      updatedAt: '2026-11-04T04:00:00.000Z',
    })
    stubApi(
      orderRoutes((url, init) => {
        reviewCall = { url, init }
        return json(failed)
      }),
    )

    await openPendingOrder()

    fireEvent.click(screen.getByRole('button', { name: /驳\s*回/ }))
    expect(
      await screen.findByText('核验备注必填（至少 2 个字符）；驳回时必须写明原因。'),
    ).toBeTruthy()
    expect(reviewCall).toBeUndefined()

    fireEvent.change(firstLabel('核验备注'), {
      target: { value: '客户资质不符' },
    })
    fireEvent.click(screen.getByRole('button', { name: /驳\s*回/ }))
    expect(
      await screen.findByText('驳回后状态将变为「未通过」，核验备注会作为失败原因保留。'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认提交核验' }))

    await waitFor(() => expect(reviewCall).toBeTruthy())
    expect(JSON.parse(String(reviewCall?.init?.body))).toEqual({
      expectedUpdatedAt: '2026-11-04T03:00:00.000Z',
      decision: 'reject',
      note: '客户资质不符',
    })
    expect(await screen.findByText('失败原因')).toBeTruthy()
    expect(screen.getByText('客户资质不符')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/已开通|已激活/)
  })

  it('shows the real 409 conflict, keeps the note and reloads the server state', async () => {
    const calls = stubApi(
      orderRoutes(
        () => json({ error: { code: 'conflict', message: '该受理单已被其他运营审核' } }, 409),
        [() => json(orderDetail()), () => json(orderDetail())],
      ),
    )

    await openPendingOrder()

    fireEvent.change(firstLabel('核验备注'), {
      target: { value: '已电话核验' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认有效成交' }))
    await screen.findByText(
      '确认后状态将变为「有效成交（人工核验）」；这是人工核验结论，不代表运营商业务已办理完成。',
    )
    fireEvent.click(screen.getByRole('button', { name: '确认提交核验' }))

    expect(await screen.findByText(/数据已被更新，请刷新后重试/)).toBeTruthy()
    expect(screen.getByText(/该受理单已被其他运营审核/)).toBeTruthy()
    // The operator's note survives the failed attempt.
    expect((firstLabel('核验备注') as HTMLTextAreaElement).value).toBe('已电话核验')
    await waitFor(() => {
      expect(
        calledUrls(calls).filter(
          (url) => url === `/api/admin/crm/orders/${ORDER_ID}`,
        ).length,
      ).toBeGreaterThanOrEqual(2)
    })
  })
})

describe('CRM transport request contracts', () => {
  it('sends every supported lead filter and server paging parameter', async () => {
    const calls = stubApi([
      [
        '/api/admin/crm/leads?',
        () => json({ items: [], total: 0, page: 2, pageSize: 50 }),
      ],
    ])

    await listAdminCrmLeads({
      page: 2,
      pageSize: 50,
      communityId: COMMUNITY_A.id,
      staffId: OWNER_ID,
      status: 'contacting',
      sourceType: 'grid_promotion',
      keyword: ' 张 ',
    })

    const url = String(calls[0]?.url)
    expect(url.startsWith('/api/admin/crm/leads?')).toBe(true)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('page')).toBe('2')
    expect(params.get('pageSize')).toBe('50')
    expect(params.get('communityId')).toBe(COMMUNITY_A.id)
    expect(params.get('staffId')).toBe(OWNER_ID)
    expect(params.get('status')).toBe('contacting')
    expect(params.get('sourceType')).toBe('grid_promotion')
    expect(params.get('keyword')).toBe('张')
  })

  it('sends every supported order filter and server paging parameter', async () => {
    const calls = stubApi([
      [
        '/api/admin/crm/orders?',
        () => json({ items: [], total: 0, page: 1, pageSize: 10 }),
      ],
    ])

    await listAdminCrmOrders({
      page: 1,
      pageSize: 10,
      communityId: COMMUNITY_B.id,
      staffId: PROMOTION_ID,
      businessType: 'gd_tv',
      status: 'pending_verification',
      keyword: 'GD2026',
    })

    const url = String(calls[0]?.url)
    expect(url.startsWith('/api/admin/crm/orders?')).toBe(true)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('businessType')).toBe('gd_tv')
    expect(params.get('status')).toBe('pending_verification')
    expect(params.get('communityId')).toBe(COMMUNITY_B.id)
    expect(params.get('staffId')).toBe(PROMOTION_ID)
    expect(params.get('keyword')).toBe('GD2026')
  })

  it('posts the review with CSRF and expectedUpdatedAt and validates the response', async () => {
    const calls = stubApi([
      [`/api/admin/crm/orders/${ORDER_ID}/review`, () => json(confirmedOrderDetail())],
    ])

    const result = await reviewAdminCrmOrder(CSRF_TOKEN, ORDER_ID, {
      expectedUpdatedAt: '2026-11-04T03:00:00.000Z',
      decision: 'confirm',
      note: '已电话核验',
    })

    expect(result.status).toBe('confirmed')
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedUpdatedAt: '2026-11-04T03:00:00.000Z',
      decision: 'confirm',
      note: '已电话核验',
    })
  })
})
