// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type {
  LocalProductSummary,
  SettlementMapping,
  SettlementOrderPartySnapshot,
  SettlementParty,
} from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import type { SettlementOrderPartyResponse } from '../services/settlement'
import { SettlementMappingPanel } from './SettlementMappingPanel'
import { SettlementsPage } from './SettlementsPage'

/**
 * Drives the real 商户映射 + 订单主体确认 panel (#220) against a stubbed `fetch`.
 *
 * What these tests protect:
 *
 * - the mapping list is a versioned history read from
 *   `GET /api/admin/settlement/mappings`; creating a version is admin-only,
 *   carries `x-csrf-token`, and re-reads the list instead of inserting a row;
 * - a server 409 keeps its real message, leaves the drawer open and never looks
 *   like a success;
 * - an operator has no write/confirm entry and always sends its own community;
 * - the three server order states (missing_seller / incomplete_parties /
 *   verified) are rendered as returned, with snapshot fields read-only;
 * - 确认主体 goes through the second confirmation dialog, posts to
 *   `/api/admin/settlement/orders/<uuid>/party`, then re-reads the authoritative
 *   order state; a 409/403 is never reported as success;
 * - nothing on the page claims a party confirmation is a payment or a settled
 *   amount.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740a2', name: '和悦社区' }
const PRODUCT_ID = '123e4567-e89b-42d3-a456-426614174201'
const SELLER_ID = '123e4567-e89b-42d3-a456-426614174501'
const SANCHUANG_ID = '123e4567-e89b-42d3-a456-426614174502'
const GUANGDIAN_ID = '123e4567-e89b-42d3-a456-426614174503'
const MAPPING_ID = '123e4567-e89b-42d3-a456-426614174601'
const MAPPING_2_ID = '123e4567-e89b-42d3-a456-426614174602'
const ORDER_ID = '123e4567-e89b-42d3-a456-426614174701'
const CSRF_TOKEN = 'csrf-token-for-settlement-mapping-tests'

const MAPPINGS_ROUTE = '/api/admin/settlement/mappings'
const PARTIES_ROUTE = '/api/admin/settlement/parties'
const PRODUCTS_ROUTE = '/api/admin/catalog/products'
const BATCH_ROUTE = '/api/admin/reconciliation/batches'
const CANDIDATES_ROUTE = '/api/admin/settlement/candidates'
const orderRoute = (orderId: string) => `/api/admin/settlement/orders/${orderId}/party`

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_ID, displayName: '测试管理员' },
  staff: { id: STAFF_ID, username: 'testadmin', role: 'admin', communities: [] },
  csrfToken: CSRF_TOKEN,
}

/** Mapping creation needs a real community, so the drawer admin has assignments. */
const ADMIN_WITH_COMMUNITIES: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: {
    ...ADMIN_SESSION.staff,
    communities: [COMMUNITY_A, COMMUNITY_B],
  },
}

const OPERATOR_SESSION: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: {
    ...ADMIN_SESSION.staff,
    username: 'operator.a',
    role: 'operator',
    communities: [COMMUNITY_A, COMMUNITY_B],
  },
}

function party(overrides: Partial<SettlementParty> = {}): SettlementParty {
  return {
    id: SELLER_ID,
    role: 'seller',
    legalName: '杭州三创生活服务有限公司',
    registryRef: '91330100MA2XXXXXXX',
    verificationRef: '合同 HT-2026-01',
    verifiedAt: '2026-11-01T02:00:00.000Z',
    createdByUserId: USER_ID,
    createdAt: '2026-10-31T02:00:00.000Z',
    ...overrides,
  }
}

function product(overrides: Partial<LocalProductSummary> = {}): LocalProductSummary {
  return {
    id: PRODUCT_ID,
    community: COMMUNITY_A,
    name: '社区宽带体验套餐',
    summary: null,
    category: null,
    priceCents: 3980,
    imageUrl: null,
    status: 'on_shelf',
    createdAt: '2026-10-01T02:00:00.000Z',
    updatedAt: '2026-10-01T02:00:00.000Z',
    ...overrides,
  }
}

function mapping(overrides: Partial<SettlementMapping> = {}): SettlementMapping {
  return {
    id: MAPPING_ID,
    communityId: COMMUNITY_A.id,
    productId: PRODUCT_ID,
    sellerPartyId: SELLER_ID,
    sanchuangPartyId: SANCHUANG_ID,
    guangdianPartyId: null,
    agreementRef: 'AG-2026-001',
    effectiveFrom: '2026-11-01',
    effectiveTo: '2026-12-31',
    createdByUserId: USER_ID,
    createdAt: '2026-11-01T03:00:00.000Z',
    ...overrides,
  }
}

function snapshot(overrides: Partial<SettlementOrderPartySnapshot> = {}): SettlementOrderPartySnapshot {
  return {
    orderId: ORDER_ID,
    mappingId: MAPPING_ID,
    sellerPartyId: SELLER_ID,
    sanchuangPartyId: SANCHUANG_ID,
    guangdianPartyId: null,
    agreementRef: 'AG-2026-001',
    confirmationRef: 'CONF-2026-001',
    confirmedByUserId: USER_ID,
    confirmedAt: '2026-11-11T02:00:00.000Z',
    ...overrides,
  }
}

function orderParty(
  sellerStatus: SettlementOrderPartyResponse['sellerStatus'],
  value: SettlementOrderPartySnapshot | null,
): SettlementOrderPartyResponse {
  return { orderId: ORDER_ID, sellerStatus, snapshot: value }
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

function readsOf(calls: FetchCall[], route: string): FetchCall[] {
  return callsTo(calls, route).filter((call) => call.init?.method !== 'POST')
}

function writesOf(calls: FetchCall[], routePrefix: string): FetchCall[] {
  return callsTo(calls, routePrefix).filter((call) => call.init?.method === 'POST')
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
          <SettlementMappingPanel />
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

/** Opens an antd Select (mouseDown opens it) and clicks the wanted option. */
async function chooseOption(combobox: Element, optionLabel: string) {
  fireEvent.mouseDown(combobox)
  // Wait for the *dropdown option* specifically: the same label may already be
  // visible in the table, and clicking that text would be a no-op.
  const option = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('.ant-select-item-option')).find(
      (element) => element.textContent === optionLabel,
    )
    expect(found, `option ${optionLabel} must be offered by the select`).toBeTruthy()
    return found as Element
  })
  fireEvent.click(option)
}

async function openConfirmModal() {
  fireEvent.click(within(confirmFormElement()).getByRole('button', { name: '确认主体' }))
  await waitFor(() => {
    expect(document.querySelector('.ant-modal-title')?.textContent).toBe('确认订单主体快照？')
  })
}

/** The page's only antd Form is the inline confirm form. */
function confirmFormElement(): HTMLElement {
  const form = document.querySelector('.ant-form')
  expect(form, 'the confirm form must be rendered').toBeTruthy()
  return form as HTMLElement
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

function baseRoutes(
  overrides: ReadonlyArray<readonly [string, Handler]> = [],
): ReadonlyArray<readonly [string, Handler]> {
  return [
    ...overrides,
    [MAPPINGS_ROUTE, () => json({ items: [mapping()] })],
    [PARTIES_ROUTE, () => json({ items: [party()] })],
    [PRODUCTS_ROUTE, () => json({ items: [product()], total: 1, page: 1, pageSize: 100 })],
  ]
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

describe('SettlementMappingPanel · 映射列表', () => {
  it('lists versioned mappings with resolved names and an admin-only 新增映射 entry', async () => {
    const calls = stubApi(
      baseRoutes([
        [
          MAPPINGS_ROUTE,
          () =>
            json({
              items: [mapping(), mapping({ id: MAPPING_2_ID, agreementRef: 'AG-2026-002', guangdianPartyId: GUANGDIAN_ID })],
            }),
        ],
        [
          PARTIES_ROUTE,
          () =>
            json({
              items: [
                party(),
                party({ id: SANCHUANG_ID, role: 'sanchuang', legalName: '杭州三创数字科技有限公司' }),
                party({ id: GUANGDIAN_ID, role: 'guangdian', legalName: '杭州广电传媒有限公司' }),
              ],
            }),
        ],
      ]),
    )
    renderPanel(ADMIN_SESSION)

    // Product and party names come from the server, never from invented labels.
    expect((await screen.findAllByText('社区宽带体验套餐')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('杭州三创生活服务有限公司').length).toBeGreaterThan(0)
    expect(screen.getAllByText('AG-2026-001').length).toBeGreaterThan(0)
    expect(screen.getAllByText('2026-11-01 ~ 2026-12-31').length).toBeGreaterThan(0)
    // A mapping without a carrier party says so instead of inventing one.
    expect(screen.getByText('未指定')).toBeTruthy()
    expect(screen.getAllByText('杭州三创数字科技有限公司').length).toBeGreaterThan(0)
    expect(screen.getByText('杭州广电传媒有限公司')).toBeTruthy()
    expect(screen.getByRole('button', { name: '新增映射' })).toBeTruthy()

    expect(readsOf(calls, MAPPINGS_ROUTE)).toHaveLength(1)
    expect(urlOf(readsOf(calls, MAPPINGS_ROUTE)[0]!).pathname).toBe(MAPPINGS_ROUTE)
    // 管理员默认「全部社区」：不带 communityId 才是服务端的全部范围查询。
    expect(urlOf(readsOf(calls, MAPPINGS_ROUTE)[0]!).searchParams.has('communityId')).toBe(false)

    // The page must not invent a 当前生效/已过期 business state the DTO lacks.
    expect(document.body.textContent).not.toMatch(/当前生效|已过期/)
    expect(document.body.textContent).not.toContain('¥')
  })

  it('shows a real error with retry instead of an empty mapping list', async () => {
    stubApi([
      [MAPPINGS_ROUTE, () => json({ error: { code: 'forbidden', message: '网格员没有结算映射权限' } }, 403)],
      [PARTIES_ROUTE, () => json({ items: [] })],
      [PRODUCTS_ROUTE, () => json({ items: [], total: 0, page: 1, pageSize: 100 })],
    ])
    renderPanel(OPERATOR_SESSION)

    expect((await screen.findAllByText(/没有权限/)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/尚未建立商户映射/)).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('SettlementMappingPanel · 新增映射', () => {
  async function fillCreateForm() {
    await chooseOption(screen.getByLabelText('社区'), '幸福社区')
    await chooseOption(screen.getByLabelText('商品'), '社区宽带体验套餐')
    await chooseOption(screen.getByLabelText(/销售商户/), '杭州三创生活服务有限公司')
    fireEvent.change(screen.getByLabelText('协议引用'), { target: { value: 'AG-2026-002' } })
    fireEvent.change(screen.getByLabelText('生效起日'), { target: { value: '2026-12-01' } })
    fireEvent.change(screen.getByLabelText('生效止日'), { target: { value: '2026-12-31' } })
  }

  it('POSTs a new version with CSRF and re-reads the list instead of inserting a row', async () => {
    const created = mapping({
      id: MAPPING_2_ID,
      agreementRef: 'AG-2026-002',
      sanchuangPartyId: null,
      effectiveFrom: '2026-12-01',
      effectiveTo: '2026-12-31',
    })
    let mappingReads = 0
    const calls = stubApi([
      [
        MAPPINGS_ROUTE,
        (_url, init) => {
          if (init?.method === 'POST') return json(created, 201)
          mappingReads += 1
          return json({ items: mappingReads === 1 ? [] : [created] })
        },
      ],
      [PARTIES_ROUTE, () => json({ items: [party()] })],
      [PRODUCTS_ROUTE, () => json({ items: [product()], total: 1, page: 1, pageSize: 100 })],
    ])
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('尚未建立商户映射')
    fireEvent.click(screen.getByRole('button', { name: '新增映射' }))
    await screen.findByText('新增商户映射')
    await fillCreateForm()

    fireEvent.click(screen.getByRole('button', { name: '保存映射' }))

    await waitFor(() => expect(writesOf(calls, MAPPINGS_ROUTE)).toHaveLength(1))
    const post = writesOf(calls, MAPPINGS_ROUTE)[0]!
    expect(post.init?.method).toBe('POST')
    expect(headersOf(post)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init?.body))).toEqual({
      communityId: COMMUNITY_A.id,
      productId: PRODUCT_ID,
      sellerPartyId: SELLER_ID,
      sanchuangPartyId: null,
      guangdianPartyId: null,
      agreementRef: 'AG-2026-002',
      effectiveFrom: '2026-12-01',
      effectiveTo: '2026-12-31',
    })

    expect(await screen.findByText(/已新增商户映射版本/)).toBeTruthy()
    await waitFor(() => expect(mappingReads).toBe(2))
    expect(await screen.findByText('AG-2026-002')).toBeTruthy()
  })

  it('keeps the drawer open with the server 409 overlap message and never claims success', async () => {
    const calls = stubApi([
      [
        MAPPINGS_ROUTE,
        (_url, init) => {
          if (init?.method === 'POST') {
            return json(
              {
                error: {
                  code: 'settlement_mapping_overlap',
                  message: '该商品的映射区间与现有版本重叠',
                },
              },
              409,
            )
          }
          return json({ items: [mapping()] })
        },
      ],
      [PARTIES_ROUTE, () => json({ items: [party()] })],
      [PRODUCTS_ROUTE, () => json({ items: [product()], total: 1, page: 1, pageSize: 100 })],
    ])
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('社区宽带体验套餐')
    fireEvent.click(screen.getByRole('button', { name: '新增映射' }))
    await screen.findByText('新增商户映射')
    await fillCreateForm()

    fireEvent.click(screen.getByRole('button', { name: '保存映射' }))

    expect(
      await screen.findByText(/数据已被更新：该商品的映射区间与现有版本重叠/),
    ).toBeTruthy()
    // Drawer stays open, no success banner, no automatic list refresh.
    expect(screen.getByLabelText('社区')).toBeTruthy()
    expect(screen.queryByText(/已新增商户映射版本/)).toBeNull()
    expect(readsOf(calls, MAPPINGS_ROUTE)).toHaveLength(1)
  })
})

describe('SettlementMappingPanel · 运营员只读', () => {
  it('hides every write/confirm entry and always reads with an authorized communityId', async () => {
    const calls = stubApi(baseRoutes())
    renderPanel(OPERATOR_SESSION)

    expect(await screen.findByText('社区宽带体验套餐')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新增映射' })).toBeNull()
    expect(screen.queryByRole('button', { name: '确认主体' })).toBeNull()
    expect(screen.queryByText(/显式确认这张订单的主体/)).toBeNull()
    expect(screen.getByRole('button', { name: /读\s*取/ })).toBeTruthy()

    expect(readsOf(calls, MAPPINGS_ROUTE)).toHaveLength(1)
    expect(urlOf(readsOf(calls, MAPPINGS_ROUTE)[0]!).searchParams.get('communityId')).toBe(
      COMMUNITY_A.id,
    )
  })

  it('does not invent a community scope and issues no request when nobody is assigned', async () => {
    const calls = stubApi(baseRoutes())
    renderPanel({
      ...ADMIN_SESSION,
      staff: { ...ADMIN_SESSION.staff, role: 'operator', communities: [] },
    })

    expect(await screen.findByText('当前账号没有可用的社区范围')).toBeTruthy()
    expect(callsTo(calls, MAPPINGS_ROUTE)).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '新增映射' })).toBeNull()
  })
})

describe('SettlementMappingPanel · 订单主体三态', () => {
  it('renders missing_seller as 尚未确认销售商户 and explains the mapping prerequisite', async () => {
    stubApi(baseRoutes([[orderRoute(ORDER_ID), () => json(orderParty('missing_seller', null))]]))
    renderPanel(ADMIN_SESSION)

    fireEvent.change(screen.getByLabelText('订单 ID'), { target: { value: ORDER_ID } })
    fireEvent.click(screen.getByRole('button', { name: /读\s*取/ }))

    expect(await screen.findByText('尚未确认销售商户')).toBeTruthy()
    expect(screen.getByText(/需要先在商户映射中建立覆盖该订单商品与社区的生效映射/)).toBeTruthy()
    expect(screen.queryByText('订单主体快照（只读）')).toBeNull()
  })

  it('renders incomplete_parties with the snapshot the server actually returned', async () => {
    stubApi(
      baseRoutes([
        [
          orderRoute(ORDER_ID),
          () =>
            json(orderParty('incomplete_parties', snapshot({ sanchuangPartyId: null }))),
        ],
      ]),
    )
    renderPanel(ADMIN_SESSION)

    fireEvent.change(screen.getByLabelText('订单 ID'), { target: { value: ORDER_ID } })
    fireEvent.click(screen.getByRole('button', { name: /读\s*取/ }))

    expect(await screen.findByText('三方主体不完整')).toBeTruthy()
    expect(screen.getByText('订单主体快照（只读）')).toBeTruthy()
    expect(screen.getByText(MAPPING_ID)).toBeTruthy()
    expect(screen.getAllByText('AG-2026-001').length).toBeGreaterThan(0)
    expect(screen.getByText('CONF-2026-001')).toBeTruthy()
    expect(screen.getAllByText(USER_ID).length).toBeGreaterThan(0)
  })

  it('renders verified with every contracted snapshot field', async () => {
    stubApi(
      baseRoutes([[orderRoute(ORDER_ID), () => json(orderParty('verified', snapshot()))]]),
    )
    renderPanel(ADMIN_SESSION)

    fireEvent.change(screen.getByLabelText('订单 ID'), { target: { value: ORDER_ID } })
    fireEvent.click(screen.getByRole('button', { name: /读\s*取/ }))

    expect(await screen.findByText('已确认销售商户')).toBeTruthy()
    expect(screen.getByText('订单主体快照（只读）')).toBeTruthy()
    expect(screen.getByText(MAPPING_ID)).toBeTruthy()
    expect(screen.getByText(SELLER_ID)).toBeTruthy()
    expect(screen.getAllByText('AG-2026-001').length).toBeGreaterThan(0)
    expect(screen.getByText('CONF-2026-001')).toBeTruthy()
    expect(screen.getByText('确认时间')).toBeTruthy()
    expect(screen.getByText('确认人')).toBeTruthy()
    expect(screen.getAllByText(USER_ID).length).toBeGreaterThan(0)
    // Confirmation is not a payment and not a settlement.
    expect(screen.getByText(/确认主体不等于已付款，也不等于可结算/)).toBeTruthy()
  })
})

describe('SettlementMappingPanel · 显式确认主体', () => {
  async function readOrderAndFillConfirm() {
    fireEvent.change(screen.getByLabelText('订单 ID'), { target: { value: ORDER_ID } })
    fireEvent.click(screen.getByRole('button', { name: /读\s*取/ }))
    await screen.findByText('尚未确认销售商户')

    await chooseOption(
      within(confirmFormElement()).getAllByRole('combobox')[0]!,
      '社区宽带体验套餐 · 2026-11-01 ~ 2026-12-31',
    )
    fireEvent.change(within(confirmFormElement()).getByLabelText('确认依据'), {
      target: { value: 'CONF-2026-001' },
    })
  }

  it('asks for a second confirmation, POSTs with CSRF, then re-reads the order state', async () => {
    let orderReads = 0
    const calls = stubApi([
      [
        orderRoute(ORDER_ID),
        (_url, init) => {
          if (init?.method === 'POST') return json(snapshot(), 201)
          orderReads += 1
          return json(
            orderReads === 1 ? orderParty('missing_seller', null) : orderParty('verified', snapshot()),
          )
        },
      ],
      [MAPPINGS_ROUTE, () => json({ items: [mapping()] })],
      [PARTIES_ROUTE, () => json({ items: [party()] })],
      [PRODUCTS_ROUTE, () => json({ items: [product()], total: 1, page: 1, pageSize: 100 })],
    ])
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('社区宽带体验套餐')
    await readOrderAndFillConfirm()
    await openConfirmModal()

    // A second, explicit confirmation is required before anything is posted.
    expect(screen.getAllByText(/只影响这一张订单/).length).toBeGreaterThan(0)
    expect(writesOf(calls, '/api/admin/settlement/orders/')).toHaveLength(0)

    const modalElement = document.querySelector('.ant-modal')
    expect(modalElement).toBeTruthy()
    fireEvent.click(within(modalElement as HTMLElement).getByRole('button', { name: '确认主体' }))

    await waitFor(() => expect(writesOf(calls, '/api/admin/settlement/orders/')).toHaveLength(1))
    const post = writesOf(calls, '/api/admin/settlement/orders/')[0]!
    expect(urlOf(post).pathname).toBe(orderRoute(ORDER_ID))
    expect(post.init?.method).toBe('POST')
    expect(headersOf(post)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init?.body))).toEqual({
      mappingId: MAPPING_ID,
      confirmationRef: 'CONF-2026-001',
    })

    expect(await screen.findByText(/订单主体已确认/)).toBeTruthy()
    await waitFor(() => expect(orderReads).toBe(2))
    expect(await screen.findByText('已确认销售商户')).toBeTruthy()
    // Success wording never turns the confirmation into money: nothing on the
    // page is a standalone 已付款 / 已结算 claim.
    expect(screen.queryAllByText('已付款')).toHaveLength(0)
    expect(screen.queryAllByText('已结算')).toHaveLength(0)
  })

  it('shows the server 409 and no success state when the order cannot be confirmed', async () => {
    const calls = stubApi([
      [
        orderRoute(ORDER_ID),
        (_url, init) => {
          if (init?.method === 'POST') {
            return json(
              { error: { code: 'conflict', message: '订单尚未核验业务事实，不能确认主体' } },
              409,
            )
          }
          return json(orderParty('missing_seller', null))
        },
      ],
      [MAPPINGS_ROUTE, () => json({ items: [mapping()] })],
      [PARTIES_ROUTE, () => json({ items: [party()] })],
      [PRODUCTS_ROUTE, () => json({ items: [product()], total: 1, page: 1, pageSize: 100 })],
    ])
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('社区宽带体验套餐')
    await readOrderAndFillConfirm()
    await openConfirmModal()
    const modalElement = document.querySelector('.ant-modal') as HTMLElement
    fireEvent.click(within(modalElement).getByRole('button', { name: '确认主体' }))

    expect(
      await screen.findByText(/数据已被更新：订单尚未核验业务事实，不能确认主体/),
    ).toBeTruthy()
    expect(screen.queryByText(/订单主体已确认/)).toBeNull()
    expect(readsOf(calls, orderRoute(ORDER_ID))).toHaveLength(1)
  })

  it('shows a real 403 and no success state', async () => {
    stubApi([
      [
        orderRoute(ORDER_ID),
        (_url, init) => {
          if (init?.method === 'POST') {
            return json({ error: { code: 'forbidden', message: '没有权限' } }, 403)
          }
          return json(orderParty('missing_seller', null))
        },
      ],
      [MAPPINGS_ROUTE, () => json({ items: [mapping()] })],
      [PARTIES_ROUTE, () => json({ items: [party()] })],
      [PRODUCTS_ROUTE, () => json({ items: [product()], total: 1, page: 1, pageSize: 100 })],
    ])
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('社区宽带体验套餐')
    await readOrderAndFillConfirm()
    await openConfirmModal()
    fireEvent.click(
      within(document.querySelector('.ant-modal') as HTMLElement).getByRole('button', {
        name: '确认主体',
      }),
    )

    expect(await screen.findByText(/没有权限：没有权限/)).toBeTruthy()
    expect(screen.queryByText(/订单主体已确认/)).toBeNull()
  })

  it('does not POST when the contracted confirmationRef is blank', async () => {
    const calls = stubApi([
      [orderRoute(ORDER_ID), () => json(orderParty('verified', snapshot()))],
      [MAPPINGS_ROUTE, () => json({ items: [mapping()] })],
      [PARTIES_ROUTE, () => json({ items: [party()] })],
      [PRODUCTS_ROUTE, () => json({ items: [product()], total: 1, page: 1, pageSize: 100 })],
    ])
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('社区宽带体验套餐')
    fireEvent.change(screen.getByLabelText('订单 ID'), { target: { value: ORDER_ID } })
    fireEvent.click(screen.getByRole('button', { name: /读\s*取/ }))
    await screen.findByText('已确认销售商户')

    await chooseOption(
      within(confirmFormElement()).getAllByRole('combobox')[0]!,
      '社区宽带体验套餐 · 2026-11-01 ~ 2026-12-31',
    )
    fireEvent.click(within(confirmFormElement()).getByRole('button', { name: '确认主体' }))

    expect(await screen.findByText('请填写确认依据')).toBeTruthy()
    expect(writesOf(calls, '/api/admin/settlement/orders/')).toHaveLength(0)
    expect(screen.queryByText('确认订单主体快照？')).toBeNull()
  })
})

describe('SettlementMappingPanel · 页面口径', () => {
  it('states that saving a mapping never confirms orders and that confirmation is not payment', async () => {
    stubApi(baseRoutes())
    renderPanel(ADMIN_SESSION)

    expect(
      await screen.findByText(/保存商户映射不会自动确认任何历史订单；每张订单必须显式确认/),
    ).toBeTruthy()
    expect(screen.getByText(/确认主体 ≠ 已付款 ≠ 可结算/)).toBeTruthy()
    // No element claims the confirmation already is a payment/settlement.
    expect(screen.queryAllByText('已付款')).toHaveLength(0)
    expect(screen.queryAllByText('已结算')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('¥')
  })

  it('mounts the 商户映射 view lazily as the third sub-tab of 分成结算单', async () => {
    const calls = stubApi([
      [BATCH_ROUTE, () => json({ items: [], asOf: '2026-11-11T08:00:00.000Z' })],
      [CANDIDATES_ROUTE, () => json(emptyCandidateResponse())],
      ...baseRoutes(),
    ])
    renderPage()

    // The default view is 经营对账 and nothing mapping-related is requested yet.
    expect(await screen.findByRole('tab', { name: '候选看板' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '经营对账' })).toBeNull()

    expect(await screen.findByRole('tab', { name: '商户映射' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '候选看板' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '主体目录' })).toBeTruthy()
    expect(callsTo(calls, MAPPINGS_ROUTE)).toHaveLength(0)

    fireEvent.click(screen.getByRole('tab', { name: '商户映射' }))
    expect(await screen.findByText('商户映射（版本化记录）')).toBeTruthy()
    await waitFor(() => expect(readsOf(calls, MAPPINGS_ROUTE)).toHaveLength(1))
    // The outer panel keeps its documented aria-label.
    expect(document.querySelector('[role="tabpanel"][aria-label="分成结算单"]')).toBeTruthy()
  })
})
