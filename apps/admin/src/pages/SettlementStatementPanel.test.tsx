// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type {
  SettlementStatement,
  SettlementStatementDetail,
  SettlementTrialAllocation,
} from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { SettlementStatementPanel } from './SettlementStatementPanel'
import { SettlementsPage } from './SettlementsPage'

/**
 * Drives the real 结算单 panel (#223) against a stubbed `fetch`.
 *
 * What these tests protect:
 *
 * - the list is server-paged and every amount is the server's; a `null`
 *   `eligibleDistributionCents` says「待核定」and never becomes ¥0;
 * - a draft is created with CSRF + communityId/periodFrom/periodTo and the list is
 *   re-read (no client-side row insert); a server 409/403 keeps its message;
 * - the detail drawer shows lines (blocked + blocking reasons + allocation), CRM
 *   performance (explicitly no money), events and post-lock disputes, and real
 *   404/network failures never look like an empty statement;
 * - this card exposes no 复核/锁单/导出 CSV/登记付款 entry, and nothing on the page
 *   claims a payment or a settled amount.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740a2', name: '和悦社区' }
const STATEMENT_ID = '123e4567-e89b-42d3-a456-426614174901'
const ORDER_ID = '123e4567-e89b-42d3-a456-426614174701'
const ORDER_2_ID = '123e4567-e89b-42d3-a456-426614174702'
const PRODUCT_ID = '123e4567-e89b-42d3-a456-426614174201'
const MAPPING_ID = '123e4567-e89b-42d3-a456-426614174601'
const SELLER_ID = '123e4567-e89b-42d3-a456-426614174501'
const SANCHUANG_ID = '123e4567-e89b-42d3-a456-426614174502'
const RULE_ID = '123e4567-e89b-42d3-a456-426614174801'
const RECEIPT_ENTRY_ID = '123e4567-e89b-42d3-a456-426614174301'
const PERFORMANCE_ID = '123e4567-e89b-42d3-a456-426614174a01'
const EVENT_ID = '123e4567-e89b-42d3-a456-426614174b01'
const EVENT_2_ID = '123e4567-e89b-42d3-a456-426614174b02'
const CSRF_TOKEN = 'csrf-token-for-settlement-statement-tests'

const STATEMENTS_ROUTE = '/api/admin/settlement/statements'
const BATCH_ROUTE = '/api/admin/reconciliation/batches'
const CANDIDATES_ROUTE = '/api/admin/settlement/candidates'

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_ID, displayName: '测试管理员' },
  staff: { id: STAFF_ID, username: 'testadmin', role: 'admin', communities: [] },
  csrfToken: CSRF_TOKEN,
}

const ADMIN_WITH_COMMUNITIES: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: { ...ADMIN_SESSION.staff, communities: [COMMUNITY_A, COMMUNITY_B] },
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

const DIGEST = 'a'.repeat(64)

function allocation(overrides: Partial<SettlementTrialAllocation> = {}): SettlementTrialAllocation {
  return {
    grossReceivedCents: 12345,
    processorFeeCents: 123,
    sellerNetCents: 11000,
    sanchuangNetCents: 611,
    guangdianNetCents: 611,
    totalNetCents: 12222,
    conservedTotalCents: 12345,
    roundingResidualCents: 1,
    ...overrides,
  }
}

function statement(overrides: Partial<SettlementStatement> = {}): SettlementStatement {
  return {
    id: STATEMENT_ID,
    communityId: COMMUNITY_A.id,
    statementNo: 'STL-20261101-0001',
    periodFrom: '2026-11-01',
    periodTo: '2026-11-07',
    generation: 1,
    revision: 1,
    status: 'draft',
    snapshotDigest: DIGEST,
    asOf: '2026-11-08T02:00:00.000Z',
    createdByUserId: USER_ID,
    createdAt: '2026-11-08T02:00:00.000Z',
    updatedAt: '2026-11-08T02:00:00.000Z',
    reviewedByUserId: null,
    reviewEvidenceRef: null,
    reviewedAt: null,
    lockedByUserId: null,
    lockEvidenceRef: null,
    lockedAt: null,
    summary: {
      lineCount: 2,
      calculatedCount: 1,
      blockedCount: 1,
      eligibleGrossCents: 12345,
      feeCents: 123,
      sellerNetCents: 11000,
      sanchuangNetCents: 611,
      guangdianNetCents: 611,
      eligibleDistributionCents: null,
    },
    paymentState: 'not_recorded',
    ...overrides,
  }
}

function calculatedLine() {
  return {
    id: '123e4567-e89b-42d3-a456-426614174c01',
    statementId: STATEMENT_ID,
    orderId: ORDER_ID,
    orderDisplayNo: 'ORD-20261101-0001',
    communityId: COMMUNITY_A.id,
    productId: PRODUCT_ID,
    productName: '社区宽带体验套餐',
    periodAt: '2026-11-01T02:00:00.000Z',
    registeredAmountCents: 3980,
    couponDiscountCents: 0,
    netPayableCents: 3980,
    receiptEntryId: RECEIPT_ENTRY_ID,
    receiptEvidenceRef: 'BANK-20261101-001',
    receiptReceivedAt: '2026-11-01T03:00:00.000Z',
    receiptAmountCents: 12345,
    operatingBatchId: null,
    gridStaffId: STAFF_ID,
    gridReviewerUserId: null,
    mappingId: MAPPING_ID,
    sellerPartyId: SELLER_ID,
    sanchuangPartyId: SANCHUANG_ID,
    guangdianPartyId: null,
    agreementRef: 'AG-2026-001',
    ruleId: RULE_ID,
    ruleVersion: 2,
    state: 'calculated' as const,
    blockingReasons: [],
    allocation: allocation(),
    sourceDigest: DIGEST,
  }
}

function blockedLine() {
  return {
    ...calculatedLine(),
    id: '123e4567-e89b-42d3-a456-426614174c02',
    orderId: ORDER_2_ID,
    orderDisplayNo: 'ORD-20261102-0002',
    productName: '社区家政体验券',
    receiptEntryId: null,
    receiptEvidenceRef: null,
    receiptReceivedAt: null,
    receiptAmountCents: null,
    gridStaffId: null,
    mappingId: null,
    sellerPartyId: null,
    sanchuangPartyId: null,
    ruleId: null,
    ruleVersion: null,
    state: 'blocked' as const,
    blockingReasons: ['订单业务事实未核验', '收款凭据未进入锁定对账'],
    allocation: null,
  }
}

function detail(): SettlementStatementDetail {
  return {
    statement: statement(),
    lines: [calculatedLine(), blockedLine()],
    performance: [
      {
        id: PERFORMANCE_ID,
        statementId: STATEMENT_ID,
        entryId: '123e4567-e89b-42d3-a456-426614174e01',
        sourceId: '123e4567-e89b-42d3-a456-426614174e02',
        sourceDisplayNo: 'CRM-20261101-0001',
        communityId: COMMUNITY_A.id,
        staffId: STAFF_ID,
        confirmedByUserId: USER_ID,
        confirmedAt: '2026-11-02T02:00:00.000Z',
        evidenceRef: 'CONF-2026-001',
        sourceDigest: DIGEST,
      },
    ],
    events: [
      {
        id: EVENT_ID,
        statementId: STATEMENT_ID,
        kind: 'created',
        revision: 1,
        actorUserId: USER_ID,
        evidenceRef: '创建草案',
        snapshotDigest: DIGEST,
        createdAt: '2026-11-08T02:00:00.000Z',
      },
      {
        id: EVENT_2_ID,
        statementId: STATEMENT_ID,
        kind: 'reviewed',
        revision: 2,
        actorUserId: USER_ID,
        evidenceRef: '复核单 2026-11-08',
        snapshotDigest: DIGEST,
        createdAt: '2026-11-08T03:00:00.000Z',
      },
    ],
    postLockDisputes: [{ orderId: ORDER_ID, reasons: ['锁后冲正', '锁后异常'] }],
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

function readsOf(calls: FetchCall[], route: string): FetchCall[] {
  return callsTo(calls, route).filter((call) => call.init?.method !== 'POST')
}

function writesOf(calls: FetchCall[], route: string): FetchCall[] {
  return callsTo(calls, route).filter((call) => call.init?.method === 'POST')
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
          <SettlementStatementPanel />
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

/** Renders a quote-free list handler plus a detail handler for the same prefix. */
function statementRoutes(
  handlers: {
    list?: Handler
    detail?: Handler
  } = {},
): readonly [string, Handler] {
  return [
    STATEMENTS_ROUTE,
    (url, init) => {
      const path = new URL(url, 'http://localhost').pathname
      if (path === STATEMENTS_ROUTE) {
        if (init?.method === 'POST') {
          return handlers.list ? handlers.list(url, init) : json(statement(), 201)
        }
        return handlers.list ? handlers.list(url, init) : json({ items: [statement()], total: 41, page: 1, pageSize: 20 })
      }
      return handlers.detail ? handlers.detail(url, init) : json(detail())
    },
  ]
}

/** Waits for an actual dropdown option, not just the same label in the table. */
async function chooseOption(combobox: Element, optionLabel: string) {
  fireEvent.mouseDown(combobox)
  const option = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('.ant-select-item-option')).find(
      (element) => element.textContent === optionLabel,
    )
    expect(found, `option ${optionLabel} must be offered by the select`).toBeTruthy()
    return found as Element
  })
  fireEvent.click(option)
}

function modalElement(): HTMLElement {
  const modal = document.querySelector('.ant-modal')
  expect(modal, 'the draft modal must be open').toBeTruthy()
  return modal as HTMLElement
}

async function openDraftModal() {
  fireEvent.click(screen.getByRole('button', { name: '新建草案' }))
  await screen.findByText('草案不是锁定，也不是付款')
}

async function fillDraft() {
  const modal = modalElement()
  await chooseOption(within(modal).getByLabelText('社区'), '幸福社区')
  fireEvent.change(within(modal).getByLabelText('业务期间开始（含）'), {
    target: { value: '2026-11-01' },
  })
  fireEvent.change(within(modal).getByLabelText('业务期间结束（含）'), {
    target: { value: '2026-11-07' },
  })
}

async function openDetailDrawer() {
  fireEvent.click(screen.getByRole('button', { name: '查看明细' }))
  await screen.findByText('结算单明细 · STL-20261101-0001')
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

describe('SettlementStatementPanel · 列表', () => {
  it('renders server paging info and every server field, with null distribution as 待核定', async () => {
    const calls = stubApi([
      statementRoutes(),
      [BATCH_ROUTE, () => json({ items: [], asOf: '2026-11-11T08:00:00.000Z' })],
      [CANDIDATES_ROUTE, () => json(emptyCandidateResponse())],
    ])
    renderPanel(ADMIN_SESSION)

    expect(await screen.findByText('STL-20261101-0001')).toBeTruthy()
    expect(screen.getByText('2026-11-01 ~ 2026-11-07')).toBeTruthy()
    expect(screen.getByText('第 1 次生成')).toBeTruthy()
    expect(screen.getByText('修订 1')).toBeTruthy()
    // Status label comes from the service map, not a page-local guess.
    expect(screen.getByText('草案未复核')).toBeTruthy()
    expect(screen.getByText('2 / 1 / 1')).toBeTruthy()
    expect(screen.getByText('¥123.45')).toBeTruthy() // eligible gross
    expect(screen.getByText('¥1.23')).toBeTruthy() // fee
    expect(screen.getByText('¥110.00')).toBeTruthy() // seller net
    expect(screen.getByText(/三创 ¥6\.11 · 广电 ¥6\.11/)).toBeTruthy()
    // Null distribution is 待核定, never ¥0.
    expect(screen.getAllByText('待核定').length).toBeGreaterThan(0)
    expect(screen.getByText('未登记付款')).toBeTruthy()
    expect(document.body.textContent).not.toContain('¥0')

    // Server-side paging: total is displayed and the request carries paging.
    expect(screen.getByText(/共 41 张结算单（服务端分页）/)).toBeTruthy()
    expect(readsOf(calls, STATEMENTS_ROUTE)).toHaveLength(1)
    const listCall = readsOf(calls, STATEMENTS_ROUTE)[0]!
    expect(urlOf(listCall).pathname).toBe(STATEMENTS_ROUTE)
    expect(urlOf(listCall).searchParams.get('page')).toBe('1')
    expect(urlOf(listCall).searchParams.get('pageSize')).toBe('20')
    expect(urlOf(listCall).searchParams.has('communityId')).toBe(false)
  })
})

describe('SettlementStatementPanel · 新建草案', () => {
  it('POSTs community/period with CSRF and re-reads the list instead of inserting a row', async () => {
    const created = statement({ statementNo: 'STL-20261101-0002' })
    let listReads = 0
    const calls = stubApi([
      [
        STATEMENTS_ROUTE,
        (url, init) => {
          const path = new URL(url, 'http://localhost').pathname
          if (path !== STATEMENTS_ROUTE) return json(detail())
          if (init?.method === 'POST') {
            // The real 201 body is a full detail; the service unwraps `.statement`.
            return json({ ...detail(), statement: created }, 201)
          }
          listReads += 1
          return json({
            items: listReads === 1 ? [] : [created],
            total: listReads === 1 ? 0 : 1,
            page: 1,
            pageSize: 20,
          })
        },
      ],
    ])
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('尚无结算单')
    await openDraftModal()
    await fillDraft()
    fireEvent.click(within(modalElement()).getByRole('button', { name: '生成草案' }))

    await waitFor(() => expect(writesOf(calls, STATEMENTS_ROUTE)).toHaveLength(1))
    const post = writesOf(calls, STATEMENTS_ROUTE)[0]!
    expect(urlOf(post).pathname).toBe(STATEMENTS_ROUTE)
    expect(post.init?.method).toBe('POST')
    expect(headersOf(post)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init?.body))).toEqual({
      communityId: COMMUNITY_A.id,
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
    })

    expect(await screen.findByText(/已生成结算单草案 STL-20261101-0002/)).toBeTruthy()
    await waitFor(() => expect(listReads).toBe(2))
    expect(await screen.findByText('STL-20261101-0002')).toBeTruthy()
  })

  it('keeps the modal open with the server 409 message and never claims success', async () => {
    const calls = stubApi([
      [
        STATEMENTS_ROUTE,
        (_url, init) => {
          if (init?.method === 'POST') {
            return json(
              {
                error: {
                  code: 'settlement_statement_conflict',
                  message: '该社区同期间已存在结算单草案',
                },
              },
              409,
            )
          }
          return json({ items: [], total: 0, page: 1, pageSize: 20 })
        },
      ],
    ])
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('尚无结算单')
    await openDraftModal()
    await fillDraft()
    fireEvent.click(within(modalElement()).getByRole('button', { name: '生成草案' }))

    expect(
      await screen.findByText(/数据已被更新：该社区同期间已存在结算单草案/),
    ).toBeTruthy()
    expect(within(modalElement()).getByLabelText('社区')).toBeTruthy()
    expect(screen.queryByText(/已生成结算单草案/)).toBeNull()
    expect(readsOf(calls, STATEMENTS_ROUTE)).toHaveLength(1)
  })

  it('shows the real 403 when the server refuses the draft', async () => {
    stubApi([
      [
        STATEMENTS_ROUTE,
        (_url, init) => {
          if (init?.method === 'POST') {
            return json({ error: { code: 'forbidden', message: '当前账号不能生成该社区结算单' } }, 403)
          }
          return json({ items: [], total: 0, page: 1, pageSize: 20 })
        },
      ],
    ])
    renderPanel(OPERATOR_SESSION)

    await screen.findByText('尚无结算单')
    await openDraftModal()
    await fillDraft()
    fireEvent.click(within(modalElement()).getByRole('button', { name: '生成草案' }))

    expect(await screen.findByText(/没有权限：当前账号不能生成该社区结算单/)).toBeTruthy()
    expect(screen.queryByText(/已生成结算单草案/)).toBeNull()
  })
})

describe('SettlementStatementPanel · 明细 Drawer', () => {
  it('calls the detail endpoint and renders lines, performance, events and post-lock disputes', async () => {
    const calls = stubApi([statementRoutes()])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()

    expect((await screen.findAllByText('ORD-20261101-0001')).length).toBeGreaterThan(0)
    // Calculated line: allocation amounts come straight from the server.
    expect(screen.getByText('凭据实收毛额 ¥123.45')).toBeTruthy()
    expect(screen.getByText('手续费 ¥1.23')).toBeTruthy()
    expect(screen.getByText('三方合计净额 ¥122.22')).toBeTruthy()
    expect(screen.getByText('舍入余数 ¥0.01')).toBeTruthy()
    expect(screen.getByText('BANK-20261101-001')).toBeTruthy()
    expect(screen.getByText('v2')).toBeTruthy()
    // Blocked line: reasons + no fabricated zero allocation.
    expect(screen.getAllByText('ORD-20261102-0002').length).toBeGreaterThan(0)
    expect(screen.getByText('订单业务事实未核验')).toBeTruthy()
    expect(screen.getByText('收款凭据未进入锁定对账')).toBeTruthy()
    expect(screen.getByText('未关联收款凭据')).toBeTruthy()
    expect(screen.getByText('无已核准规则')).toBeTruthy()
    expect(screen.getAllByText('待核定').length).toBeGreaterThan(0)

    // Performance: explicit "no money" statement.
    fireEvent.click(screen.getByRole('tab', { name: /业绩/ }))
    expect((await screen.findAllByText('CRM-20261101-0001')).length).toBeGreaterThan(0)
    expect(screen.getByText(/已确认业绩不含金额，不是应付给个人的佣金/)).toBeTruthy()
    expect(screen.getAllByText(STAFF_ID).length).toBeGreaterThan(0)
    expect(screen.getByText('CONF-2026-001')).toBeTruthy()

    // Events: kind/revision/actor/evidence/time.
    fireEvent.click(screen.getByRole('tab', { name: /事件/ }))
    expect(await screen.findByText('创建')).toBeTruthy()
    expect(screen.getByText('复核')).toBeTruthy()
    expect(screen.getAllByText(USER_ID).length).toBeGreaterThan(0)

    // Post-lock disputes.
    fireEvent.click(screen.getByRole('tab', { name: /锁后争议/ }))
    expect(await screen.findByText('锁后冲正')).toBeTruthy()
    expect(screen.getByText('锁后异常')).toBeTruthy()

    // One detail request for the clicked row, on the contracted path.
    const detailReads = readsOf(calls, STATEMENTS_ROUTE).filter(
      (call) => urlOf(call).pathname !== STATEMENTS_ROUTE,
    )
    expect(detailReads).toHaveLength(1)
    expect(urlOf(detailReads[0]!).pathname).toBe(`${STATEMENTS_ROUTE}/${STATEMENT_ID}`)
    expect(screen.queryAllByText('应付')).toHaveLength(0)
  })

  it('shows a real 404 instead of an empty detail', async () => {
    stubApi([
      statementRoutes({
        detail: () => json({ error: { code: 'not_found', message: '结算单不存在' } }, 404),
      }),
    ])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()

    expect(await screen.findByText('结算单不存在')).toBeTruthy()
    expect(screen.getByText(/数据不存在或已下线/)).toBeTruthy()
    expect(screen.queryByText(/明细行（/)).toBeNull()
    expect(screen.queryByText('该结算单没有明细行')).toBeNull()
  })

  it('shows a network failure instead of an empty detail', async () => {
    stubApi([
      statementRoutes({
        detail: () => {
          throw new Error('network down')
        },
      }),
    ])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()

    expect(await screen.findByText(/无法连接管理后台 API/)).toBeTruthy()
    expect(screen.queryByText('该结算单没有明细行')).toBeNull()
  })
})

describe('SettlementStatementPanel · 复核与锁单动作区', () => {
  function detailWith(overrides: Partial<SettlementStatement>): SettlementStatementDetail {
    return { ...detail(), statement: statement(overrides) }
  }

  function reviewedStatement(): SettlementStatement {
    return statement({
      status: 'reviewed',
      revision: 2,
      reviewedByUserId: USER_ID,
      reviewEvidenceRef: '复核单 2026-11-08',
      reviewedAt: '2026-11-08T03:00:00.000Z',
    })
  }

  function lockedStatement(): SettlementStatement {
    return statement({
      status: 'locked',
      revision: 3,
      reviewedByUserId: USER_ID,
      reviewEvidenceRef: '复核单 2026-11-08',
      reviewedAt: '2026-11-08T03:00:00.000Z',
      lockedByUserId: USER_ID,
      lockEvidenceRef: '锁单依据 2026-11-09',
      lockedAt: '2026-11-09T03:00:00.000Z',
    })
  }

  function stateRoutes(current: SettlementStatement): readonly [string, Handler] {
    return [
      STATEMENTS_ROUTE,
      (url, init) => {
        const path = new URL(url, 'http://localhost').pathname
        if (path === STATEMENTS_ROUTE) {
          return init?.method === 'POST'
            ? json(detailWith(current), 201)
            : json({ items: [current], total: 1, page: 1, pageSize: 20 })
        }
        return json(detailWith(current))
      },
    ]
  }

  it('shows 复核 only for draft, 锁单 only for reviewed, and neither once locked', async () => {
    const first = stubApi([stateRoutes(statement())])
    const draftRender = renderPanel(ADMIN_SESSION)
    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    expect(await screen.findByRole('button', { name: /复\s*核/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /锁\s*单/ })).toBeNull()
    draftRender.unmount()
    vi.unstubAllGlobals()
    expect(first.length).toBeGreaterThan(0)

    stubApi([stateRoutes(reviewedStatement())])
    const reviewedRender = renderPanel(ADMIN_SESSION)
    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    expect(await screen.findByRole('button', { name: /锁\s*单/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /复\s*核/ })).toBeNull()
    reviewedRender.unmount()
    vi.unstubAllGlobals()

    stubApi([stateRoutes(lockedStatement())])
    renderPanel(ADMIN_SESSION)
    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    expect(await screen.findByText('该状态没有可用的复核或锁单入口；锁定后的快照不能再被写回。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /复\s*核/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /锁\s*单/ })).toBeNull()
  })

  it('reviews with the current revision and re-renders from the server detail', async () => {
    const reviewCalls: FetchCall[] = []
    const calls = stubApi([
      [
        STATEMENTS_ROUTE,
        (url, init) => {
          const path = new URL(url, 'http://localhost').pathname
          if (path === STATEMENTS_ROUTE) {
            return json({ items: [statement()], total: 1, page: 1, pageSize: 20 })
          }
          if (path.endsWith('/review')) {
            reviewCalls.push({ url, init })
            return json(
              detailWith(
                statement({
                  status: 'reviewed',
                  revision: 2,
                  reviewedByUserId: USER_ID,
                  reviewEvidenceRef: '复核单 2026-11-09',
                  reviewedAt: '2026-11-09T02:00:00.000Z',
                }),
              ),
            )
          }
          return json(detail())
        },
      ],
    ])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    fireEvent.click(await screen.findByRole('button', { name: /复\s*核/ }))

    expect(await screen.findByText('复核结算单（人工确认快照）')).toBeTruthy()
    expect(screen.getByText('复核只是人工确认快照内容，不锁定、不代表已付款')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('复核依据'), {
      target: { value: '复核单 2026-11-09' },
    })
    fireEvent.click(within(modalElement()).getByRole('button', { name: '提交复核' }))

    await waitFor(() => expect(reviewCalls).toHaveLength(1))
    const post = reviewCalls[0]!
    expect(urlOf(post).pathname).toBe(`${STATEMENTS_ROUTE}/${STATEMENT_ID}/review`)
    expect(post.init?.method).toBe('POST')
    expect(headersOf(post)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init?.body))).toEqual({
      expectedRevision: 1,
      evidenceRef: '复核单 2026-11-09',
    })

    expect(await screen.findByText(/复核已提交/)).toBeTruthy()
    // The Drawer status comes from the server-returned detail, not a local flip.
    expect((await screen.findAllByText('已复核未锁定')).length).toBeGreaterThan(0)
    const detailReads = calls.filter(
      (call) => urlOf(call).pathname === `${STATEMENTS_ROUTE}/${STATEMENT_ID}`,
    )
    expect(detailReads).toHaveLength(1)
  })

  it('locks only after confirmation, and re-renders from the server detail', async () => {
    const lockCalls: FetchCall[] = []
    stubApi([
      [
        STATEMENTS_ROUTE,
        (url, init) => {
          const path = new URL(url, 'http://localhost').pathname
          if (path === STATEMENTS_ROUTE) {
            return json({ items: [reviewedStatement()], total: 1, page: 1, pageSize: 20 })
          }
          if (path.endsWith('/lock')) {
            lockCalls.push({ url, init })
            return json(detailWith(lockedStatement()))
          }
          return json(detailWith(reviewedStatement()))
        },
      ],
    ])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    fireEvent.click(await screen.findByRole('button', { name: /锁\s*单/ }))

    expect(await screen.findByText('锁单（不可逆）')).toBeTruthy()
    // The confirmation must say the lock is irreversible and not a payment.
    expect(screen.getByText('锁定不可逆')).toBeTruthy()
    expect(screen.getByText(/锁定 ≠ 已付款/)).toBeTruthy()
    expect(screen.getByText(/后续付款必须由线下凭据单独登记与复核/)).toBeTruthy()

    fireEvent.click(within(modalElement()).getByRole('button', { name: /取\s*消/ }))
    await waitFor(() => expect(screen.queryByText('锁单（不可逆）')).toBeNull())
    expect(lockCalls).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /锁\s*单/ }))
    expect(await screen.findByText('锁单（不可逆）')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('锁单依据'), {
      target: { value: '锁单依据 2026-11-09' },
    })
    fireEvent.click(within(modalElement()).getByRole('button', { name: '确认锁单' }))

    await waitFor(() => expect(lockCalls).toHaveLength(1))
    const post = lockCalls[0]!
    expect(urlOf(post).pathname).toBe(`${STATEMENTS_ROUTE}/${STATEMENT_ID}/lock`)
    expect(post.init?.method).toBe('POST')
    expect(headersOf(post)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init?.body))).toEqual({
      expectedRevision: 2,
      evidenceRef: '锁单依据 2026-11-09',
    })

    expect(await screen.findByText(/结算单已锁定/)).toBeTruthy()
    expect((await screen.findAllByText('已锁定')).length).toBeGreaterThan(0)
    // Locking is not payment: payment state stays whatever the server says.
    expect(screen.getAllByText('未登记付款').length).toBeGreaterThan(0)
  })

  it('keeps the modal open and the draft status on a stale-revision 409', async () => {
    stubApi([
      [
        STATEMENTS_ROUTE,
        (url) => {
          const path = new URL(url, 'http://localhost').pathname
          if (path === STATEMENTS_ROUTE) {
            return json({ items: [statement()], total: 1, page: 1, pageSize: 20 })
          }
          if (path.endsWith('/review')) {
            return json(
              {
                error: {
                  code: 'settlement_statement_conflict',
                  message: '结算单已被其他管理员复核，revision 已过期',
                },
              },
              409,
            )
          }
          return json(detail())
        },
      ],
    ])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    fireEvent.click(await screen.findByRole('button', { name: /复\s*核/ }))
    await screen.findByText('复核结算单（人工确认快照）')
    fireEvent.change(screen.getByLabelText('复核依据'), {
      target: { value: '复核单 2026-11-09' },
    })
    fireEvent.click(within(modalElement()).getByRole('button', { name: '提交复核' }))

    expect(
      await screen.findByText(/数据已被更新：结算单已被其他管理员复核，revision 已过期/),
    ).toBeTruthy()
    expect(screen.getByLabelText('复核依据')).toBeTruthy()
    expect(screen.queryByText(/复核已提交/)).toBeNull()
    // No local status rewrite: the drawer still shows the draft status.
    expect(screen.getAllByText('草案未复核').length).toBeGreaterThan(0)
  })

  it('does not send a review without the required evidence', async () => {
    const reviewCalls: FetchCall[] = []
    stubApi([
      [
        STATEMENTS_ROUTE,
        (url, init) => {
          const path = new URL(url, 'http://localhost').pathname
          if (path === STATEMENTS_ROUTE) {
            return json({ items: [statement()], total: 1, page: 1, pageSize: 20 })
          }
          if (path.endsWith('/review')) {
            reviewCalls.push({ url, init })
            return json(detail())
          }
          return json(detail())
        },
      ],
    ])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    fireEvent.click(await screen.findByRole('button', { name: /复\s*核/ }))
    await screen.findByText('复核结算单（人工确认快照）')

    fireEvent.click(within(modalElement()).getByRole('button', { name: '提交复核' }))

    expect(await screen.findByText('请填写复核依据')).toBeTruthy()
    expect(reviewCalls).toHaveLength(0)
  })
})

describe('SettlementStatementPanel · 双 CSV 导出', () => {
  function csvResponse(filename: string): Response {
    return new Response('a,b\r\n1,2\r\n', {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    })
  }

  function csvRoutes(handler: (path: string) => Response): readonly [string, Handler] {
    return [
      STATEMENTS_ROUTE,
      (url) => {
        const path = new URL(url, 'http://localhost').pathname
        if (path === STATEMENTS_ROUTE) {
          return json({ items: [statement()], total: 1, page: 1, pageSize: 20 })
        }
        if (path.endsWith('.csv')) return handler(path)
        return json(detail())
      },
    ]
  }

  it('downloads both entity and performance CSVs with their real filenames', async () => {
    const csvCalls: FetchCall[] = []
    stubApi([
      [
        STATEMENTS_ROUTE,
        (url, init) => {
          const path = new URL(url, 'http://localhost').pathname
          if (path === STATEMENTS_ROUTE) {
            return json({ items: [statement()], total: 1, page: 1, pageSize: 20 })
          }
          if (path.endsWith('/entity.csv')) {
            csvCalls.push({ url, init })
            return csvResponse('settlement-0001-entity.csv')
          }
          if (path.endsWith('/performance.csv')) {
            csvCalls.push({ url, init })
            return csvResponse('settlement-0001-grid-performance.csv')
          }
          return json(detail())
        },
      ],
    ])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()

    fireEvent.click(await screen.findByRole('button', { name: '导出机构结算明细（CSV）' }))
    expect(await screen.findByText(/已导出 settlement-0001-entity\.csv/)).toBeTruthy()
    expect(urlOf(csvCalls[0]!).pathname).toBe(
      `${STATEMENTS_ROUTE}/${STATEMENT_ID}/entity.csv`,
    )

    fireEvent.click(screen.getByRole('button', { name: '导出网格员业绩附表（CSV）' }))
    expect(
      await screen.findByText(/已导出 settlement-0001-grid-performance\.csv/),
    ).toBeTruthy()
    expect(urlOf(csvCalls[1]!).pathname).toBe(
      `${STATEMENTS_ROUTE}/${STATEMENT_ID}/performance.csv`,
    )
  })

  it('shows the real export failure without claiming a success', async () => {
    stubApi([
      csvRoutes(() => json({ error: { code: 'forbidden', message: '没有导出权限' } }, 403)),
    ])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    fireEvent.click(await screen.findByRole('button', { name: '导出机构结算明细（CSV）' }))

    expect((await screen.findAllByText(/没有权限/)).length).toBeGreaterThan(0)
    expect(screen.getByText('CSV 导出失败')).toBeTruthy()
    expect(screen.queryByText(/已导出/)).toBeNull()
  })

  it('states the draft-export warning and the performance appendix boundary', async () => {
    stubApi([csvRoutes(() => csvResponse('x.csv'))])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()

    expect(await screen.findByText('草案/未复核：导出仅供核对，不是已结清单据')).toBeTruthy()
    expect(
      screen.getByText(/业绩附表是广电网格员的工作量，不是应付给个人的佣金/),
    ).toBeTruthy()
  })

  it('lets an operator export both CSVs but hides review/lock', async () => {
    stubApi([csvRoutes(() => csvResponse('x.csv'))])
    renderPanel(OPERATOR_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()

    expect((await screen.findAllByText('ORD-20261101-0001')).length).toBeGreaterThan(0)
    // Review/lock stay admin-only; the server rejects any other role.
    expect(screen.queryByRole('button', { name: /复\s*核/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /锁\s*单/ })).toBeNull()
    // CSV export is allowed by the real API for admin AND operator.
    expect(screen.getByRole('button', { name: '导出机构结算明细（CSV）' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '导出网格员业绩附表（CSV）' })).toBeTruthy()
    expect(screen.getByText(/草案\/未复核：导出仅供核对，不是已结清单据/)).toBeTruthy()
  })
})

describe('SettlementStatementPanel · 运营员与口径', () => {
  it('passes communityId and exposes only the draft entry this card owns', async () => {
    const calls = stubApi([statementRoutes()])
    renderPanel(OPERATOR_SESSION)

    expect(await screen.findByText('STL-20261101-0001')).toBeTruthy()
    expect(urlOf(readsOf(calls, STATEMENTS_ROUTE)[0]!).searchParams.get('communityId')).toBe(
      COMMUNITY_A.id,
    )
    // Draft creation is allowed (a draft is not a payment)…
    expect(screen.getByRole('button', { name: '新建草案' })).toBeTruthy()
    // …but review/lock/export/payment belong to later cards and must not exist.
    expect(screen.queryByRole('button', { name: /复核/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /锁单/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /导出 CSV/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /登记付款/ })).toBeNull()
  })

  it('never states 已付款/已结清/应付 as a fact and keeps the snapshot boundaries', async () => {
    stubApi([statementRoutes()])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    expect(screen.getAllByText(/生成草案 ≠ 锁定 ≠ 付款/).length).toBeGreaterThan(0)
    expect(screen.getByText(/锁定由后续卡提供，本视图不提供锁单、复核、导出或登记付款按钮/)).toBeTruthy()
    expect(screen.queryAllByText('应付')).toHaveLength(0)
    expect(screen.queryAllByText('已付款')).toHaveLength(0)
    expect(screen.queryAllByText('已结清')).toHaveLength(0)
    expect(document.body.textContent).not.toMatch(/已付款|已结清/)
    expect(document.body.textContent).not.toContain('¥0')
  })

  it('mounts the 结算单 view lazily as the sixth sub-tab of 分成结算单', async () => {
    const calls = stubApi([
      [BATCH_ROUTE, () => json({ items: [], asOf: '2026-11-11T08:00:00.000Z' })],
      [CANDIDATES_ROUTE, () => json(emptyCandidateResponse())],
      statementRoutes(),
    ])
    renderPage()

    expect(await screen.findByRole('tab', { name: '经营对账' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '分成结算单' }))
    expect(await screen.findByRole('tab', { name: '结算单' })).toBeTruthy()
    expect(readsOf(calls, STATEMENTS_ROUTE)).toHaveLength(0)

    fireEvent.click(screen.getByRole('tab', { name: '结算单' }))
    expect(await screen.findByText('结算单（快照 · 只读）')).toBeTruthy()
    await waitFor(() => expect(readsOf(calls, STATEMENTS_ROUTE)).toHaveLength(1))
    expect(document.querySelector('[role="tabpanel"][aria-label="分成结算单"]')).toBeTruthy()
  })
})
