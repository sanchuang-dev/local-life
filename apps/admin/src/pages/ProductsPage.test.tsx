// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type {
  LocalProductDetail,
  LocalProductSummary,
} from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { productPriceHelpers, ProductsPage } from './ProductsPage'

/**
 * These tests drive the real 商品管理 page with an explicitly stubbed `fetch`.
 *
 * Every test declares exactly which URLs it answers; an unexpected URL throws, so
 * a page that silently fell back to a demo catalogue would fail loudly. Payloads
 * follow the shared contracts and price assertions are in integer cents, which is
 * the only money representation the API accepts.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740b2', name: '阳光社区' }
const PRODUCT_ID = '123e4567-e89b-42d3-a456-4266141740c3'
const CSRF_TOKEN = 'csrf-token-for-product-page-tests'

function summary(overrides: Partial<LocalProductSummary> = {}): LocalProductSummary {
  return {
    id: PRODUCT_ID,
    community: COMMUNITY_A,
    name: '社区助农蔬菜包',
    summary: '当日采摘，社区自提',
    category: '蔬菜',
    priceCents: 1990,
    imageUrl: null,
    status: 'on_shelf',
    createdAt: '2026-11-01T02:00:00.000Z',
    updatedAt: '2026-11-02T02:00:00.000Z',
    ...overrides,
  }
}

function detail(overrides: Partial<LocalProductDetail> = {}): LocalProductDetail {
  return {
    ...summary(),
    description: '包含 5 种时令蔬菜',
    ...overrides,
  }
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

function communitiesRoute(
  items: ReadonlyArray<{ id: string; name: string }> = [COMMUNITY_A, COMMUNITY_B],
): readonly [string, Handler] {
  return ['/api/admin/communities', () => json({ items })]
}

function productsRoute(
  items: LocalProductSummary[] = [summary()],
): readonly [string, Handler] {
  return [
    '/api/admin/catalog/products?',
    () => json({ items, total: items.length, page: 1, pageSize: 20 }),
  ]
}

function renderPage(session: AuthenticatedSession) {
  const router = createMemoryRouter([{ path: '/products', element: <ProductsPage /> }], {
    initialEntries: ['/products'],
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

describe('ProductsPage permission boundary', () => {
  it('renders the grid-worker lockout page and issues zero catalogue requests', async () => {
    const calls = stubApi([
      [
        '/api/',
        (url) => {
          throw new Error(`grid worker must not call the API: ${url}`)
        },
      ],
    ])

    renderPage(GRID_SESSION)

    expect(await screen.findByText('网格员没有商品管理权限')).toBeTruthy()
    expect(screen.getByText(/服务端同样会拒绝网格员的商品目录请求/)).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('shows the real 403 instead of an empty success list', async () => {
    stubApi([
      communitiesRoute(),
      [
        '/api/admin/catalog/products?',
        () => json({ error: { code: 'forbidden', message: '网格员无权管理本地商品目录' } }, 403),
      ],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('没有商品管理权限')).toBeTruthy()
    expect(screen.getByText('网格员无权管理本地商品目录')).toBeTruthy()
    expect(screen.queryByText('社区助农蔬菜包')).toBeNull()
  })
})

describe('ProductsPage catalogue', () => {
  it('renders the real catalogue with an integer-cent price and no invented rows', async () => {
    const calls = stubApi([communitiesRoute(), productsRoute()])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('社区助农蔬菜包')).toBeTruthy()
    expect(screen.getByText('¥19.90')).toBeTruthy()
    expect(screen.getByText('幸福社区')).toBeTruthy()
    expect(screen.getAllByText('已上架').length).toBeGreaterThan(0)

    const listUrl = calledUrls(calls).find((url) => url.startsWith('/api/admin/catalog/products?'))
    expect(listUrl).toContain('page=1')
    expect(listUrl).toContain('pageSize=20')
  })

  it('states the operator community scope and defaults the filter to it', async () => {
    const calls = stubApi([communitiesRoute([COMMUNITY_A]), productsRoute()])

    renderPage(OPERATOR_SESSION)

    expect(await screen.findByText(/仅能查看与操作管理员分配的社区/)).toBeTruthy()
    await waitFor(() => {
      const listUrl = calledUrls(calls).find((url) =>
        url.startsWith('/api/admin/catalog/products?'),
      )
      expect(listUrl).toContain(`communityId=${COMMUNITY_A.id}`)
    })
    expect(screen.queryByText('阳光社区')).toBeNull()
  })
})

describe('ProductsPage editing', () => {
  it('creates a product and sends the price as integer cents with the real CSRF token', async () => {
    let createCall: FetchCall | undefined
    stubApi([
      communitiesRoute(),
      productsRoute([]),
      [
        '/api/admin/catalog/products',
        (url, init) => {
          createCall = { url, init }
          return json(detail(), 201)
        },
      ],
    ])

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: /新建商品/ }))

    fireEvent.change(await screen.findByLabelText('商品名称'), {
      target: { value: '新到柑橘' },
    })
    fireEvent.change(screen.getByLabelText('单价（元）'), { target: { value: '12.30' } })
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '水果' } })
    fireEvent.click(screen.getByRole('button', { name: /创建商品/ }))

    await waitFor(() => expect(createCall).toBeTruthy())
    expect(createCall?.url).toBe('/api/admin/catalog/products')
    expect(createCall?.init?.method).toBe('POST')
    const headers = (createCall?.init?.headers ?? {}) as Record<string, string>
    expect(headers['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({
      communityId: COMMUNITY_A.id,
      name: '新到柑橘',
      priceCents: 1230,
      category: '水果',
    })
    expect(await screen.findByText(/已创建商品「社区助农蔬菜包」/)).toBeTruthy()
  })

  it('loads the product detail into the editor and saves with expectedUpdatedAt', async () => {
    let updateCall: FetchCall | undefined
    const calls = stubApi([
      communitiesRoute(),
      productsRoute(),
      [
        `/api/admin/catalog/products/${PRODUCT_ID}`,
        (url, init) => {
          if (init?.method === 'PATCH') {
            updateCall = { url, init }
            return json(detail({ name: '社区助农蔬菜包（大份）', priceCents: 2590 }))
          }
          return json(detail())
        },
      ],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('社区助农蔬菜包')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))

    const nameInput = await screen.findByLabelText('商品名称')
    await waitFor(() => expect((nameInput as HTMLInputElement).value).toBe('社区助农蔬菜包'))
    expect((screen.getByLabelText('单价（元）') as HTMLInputElement).value).toBe('19.90')

    fireEvent.change(nameInput, { target: { value: '社区助农蔬菜包（大份）' } })
    fireEvent.change(screen.getByLabelText('单价（元）'), { target: { value: '25.90' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))

    await waitFor(() => expect(updateCall).toBeTruthy())
    expect(updateCall?.init?.method).toBe('PATCH')
    const body = JSON.parse(String(updateCall?.init?.body)) as Record<string, unknown>
    expect(body.expectedUpdatedAt).toBe('2026-11-02T02:00:00.000Z')
    expect(body.priceCents).toBe(2590)
    expect(body.name).toBe('社区助农蔬菜包（大份）')
    expect(calledUrls(calls).some((url) => url.startsWith('/api/admin/catalog'))).toBe(true)
  })

  it('takes a product off the shelf only after the confirm dialog', async () => {
    let shelfCall: FetchCall | undefined
    stubApi([
      communitiesRoute(),
      productsRoute(),
      [
        `/api/admin/catalog/products/${PRODUCT_ID}/shelf`,
        (url, init) => {
          shelfCall = { url, init }
          return json(detail({ status: 'off_shelf' }))
        },
      ],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('社区助农蔬菜包')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '下架' }))

    expect((await screen.findAllByText('下架该商品？')).length).toBeGreaterThan(0)
    expect(screen.getByText(/已登记订单的价格快照不受影响/)).toBeTruthy()
    expect(shelfCall).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: '确认下架' }))

    await waitFor(() => expect(shelfCall).toBeTruthy())
    expect(shelfCall?.init?.method).toBe('POST')
    expect(JSON.parse(String(shelfCall?.init?.body))).toEqual({
      expectedUpdatedAt: '2026-11-02T02:00:00.000Z',
      status: 'off_shelf',
    })
    expect(await screen.findByText('已下架该商品。')).toBeTruthy()
  })

  it('surfaces a stale-token 409 instead of pretending the shelf change worked', async () => {
    stubApi([
      communitiesRoute(),
      productsRoute(),
      [
        `/api/admin/catalog/products/${PRODUCT_ID}/shelf`,
        () => json({ error: { code: 'conflict', message: '商品已被其他人修改' } }, 409),
      ],
    ])

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: '更多操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '下架' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认下架' }))

    expect(await screen.findByText('操作未成功')).toBeTruthy()
    expect(screen.getByText(/数据已被更新：商品已被其他人修改/)).toBeTruthy()
  })
})

describe('ProductsPage price conversion', () => {
  it('round-trips cents without losing a fen', () => {
    expect(productPriceHelpers.yuanToCents(12.3)).toBe(1230)
    expect(productPriceHelpers.yuanToCents(0.07)).toBe(7)
    expect(productPriceHelpers.centsToYuan(1990)).toBe(19.9)
    expect(productPriceHelpers.centsToYuan(0)).toBe(0)
  })
})
