// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type {
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
    const calls = stubApi([
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
    stubApi([
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
    stubApi([communitiesRoute(), ordersRoute()])

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
    const calls = stubApi([communitiesRoute([COMMUNITY_A]), ordersRoute()])

    renderPage(OPERATOR_SESSION)

    expect(await screen.findByText(/仅能查看与处理管理员分配的社区/)).toBeTruthy()
    await waitFor(() => {
      const listUrl = calledUrls(calls).find((url) => url.startsWith('/api/admin/local-orders?'))
      expect(listUrl).toContain(`communityId=${COMMUNITY_A.id}`)
    })
  })

  it('reports the real detail error when the order cannot be read', async () => {
    stubApi([
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
    stubApi([
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
    stubApi([
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
    stubApi([
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
    stubApi([
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
    stubApi([
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
