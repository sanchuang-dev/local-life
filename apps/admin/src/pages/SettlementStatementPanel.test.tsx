// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type {
  SettlementPaymentOverview,
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
const PAYMENT_RECORD_ID = '123e4567-e89b-42d3-a456-426614174f01'
const PAYMENT_EVENT_ID = '123e4567-e89b-42d3-a456-426614174f02'
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

/** Real recipients + one already-registered offline proof, all server values. */
function paymentOverview(
  overrides: Partial<SettlementPaymentOverview> = {},
): SettlementPaymentOverview {
  return {
    statementId: STATEMENT_ID,
    communityId: COMMUNITY_A.id,
    state: 'pending_review',
    payableCents: 12345,
    recordedCents: 500,
    verifiedCents: 0,
    beneficiaries: [
      {
        partyId: SELLER_ID,
        role: 'seller',
        legalName: '杭州三创生活服务有限公司',
        registryRef: '91330100MA2XXXXXXX',
        verificationRef: null,
        payableCents: 10000,
        recordedCents: 500,
        verifiedCents: 0,
        state: 'partial',
      },
      {
        partyId: SANCHUANG_ID,
        role: 'sanchuang',
        legalName: '杭州三创数字科技有限公司',
        registryRef: '91330100MA2YYYYYYY',
        verificationRef: '合同 HT-2026-01',
        payableCents: 2345,
        recordedCents: 0,
        verifiedCents: 0,
        state: 'awaiting_payment',
      },
    ],
    records: [
      {
        id: PAYMENT_RECORD_ID,
        statementId: STATEMENT_ID,
        communityId: COMMUNITY_A.id,
        beneficiaryPartyId: SELLER_ID,
        beneficiaryRole: 'seller',
        beneficiaryLegalName: '杭州三创生活服务有限公司',
        beneficiaryRegistryRef: '91330100MA2XXXXXXX',
        beneficiaryVerificationRef: null,
        payableCentsSnapshot: 10000,
        amountCents: 500,
        paidAt: '2026-11-09T06:00:00.000Z',
        proofRefMasked: 'BANK-20261109-001',
        recorderUserId: USER_ID,
        recordedAt: '2026-11-09T06:30:00.000Z',
        state: 'pending_review',
      },
    ],
    events: [
      {
        id: PAYMENT_EVENT_ID,
        paymentRecordId: PAYMENT_RECORD_ID,
        statementId: STATEMENT_ID,
        kind: 'recorded',
        sequence: 1,
        actorUserId: USER_ID,
        evidenceRef: '网点回单',
        state: 'pending_review',
        createdAt: '2026-11-09T06:30:00.000Z',
      },
    ],
    ...overrides,
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
    // A real zero fee/receipt in a server summary is valid; only fake payable is not.
    expect(document.body.textContent).not.toMatch(/应付金额[：:\s]*¥0\.00/u)

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
    expect(screen.getByText(/管理员可按服务器权限和状态执行复核、锁定及线下付款凭据登记/)).toBeTruthy()
    expect(screen.queryAllByText('应付')).toHaveLength(0)
    expect(screen.queryAllByText('已付款')).toHaveLength(0)
    expect(screen.queryAllByText('已结清')).toHaveLength(0)
    // A real zero fee/receipt in a server summary is valid; only fake payable is not.
    expect(document.body.textContent).not.toMatch(/应付金额[：:\s]*¥0\.00/u)
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

describe('SettlementStatementPanel · 付款凭据（#225）', () => {
  type PaymentPostHandler = (url: string, init?: RequestInit) => Response | Promise<Response>

  function paymentRoutes(options: {
    statement?: SettlementStatement
    overview?: () => SettlementPaymentOverview
    post?: PaymentPostHandler
  } = {}): readonly [string, Handler] {
    const current = options.statement ?? statement()
    return [
      STATEMENTS_ROUTE,
      (url, init) => {
        const path = new URL(url, 'http://localhost').pathname
        if (path === STATEMENTS_ROUTE) {
          return json({ items: [current], total: 1, page: 1, pageSize: 20 })
        }
        if (path.endsWith('/payments')) {
          if (init?.method === 'POST') {
            return options.post
              ? options.post(url, init)
              : json(options.overview ? options.overview() : paymentOverview(), 201)
          }
          return json(options.overview ? options.overview() : paymentOverview())
        }
        return json({ ...detail(), statement: current })
      },
    ]
  }

  async function openPaymentTab() {
    fireEvent.click(await screen.findByRole('tab', { name: /付款凭据/ }))
  }

  function paymentFormElement(): HTMLElement {
    const form = document.querySelector('.ant-form')
    expect(form, 'the payment form must be rendered').toBeTruthy()
    return form as HTMLElement
  }

  function displayedKey(): string {
    return screen.getByTestId('payment-idempotency-key').textContent ?? ''
  }

  async function fillPayment(values: {
    amountCents?: string
    paidAt?: string
    proof?: string
  } = {}) {
    const form = paymentFormElement()
    await chooseOption(
      within(form).getByLabelText('受款人'),
      '杭州三创生活服务有限公司 · 商品销售商户',
    )
    fireEvent.change(within(form).getByLabelText('付款金额（整数分）'), {
      target: { value: values.amountCents ?? '500' },
    })
    fireEvent.change(within(form).getByLabelText('付款时间'), {
      target: { value: values.paidAt ?? '2026-11-09T14:30' },
    })
    fireEvent.change(within(form).getByLabelText('脱敏付款凭据引用'), {
      target: { value: values.proof ?? 'BANK-20261109-002' },
    })
  }

  async function openLockedPayment() {
    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    await openPaymentTab()
    await screen.findByText('登记线下付款凭据（仅管理员）')
  }

  it('shows the server overview, recipients, records and events without arithmetic', async () => {
    stubApi([paymentRoutes()])
    renderPanel(ADMIN_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    await openPaymentTab()

    expect(await screen.findByText('受款人（真实登记主体）')).toBeTruthy()
    // Overview KPI are exactly the server's cents values.
    expect(screen.getAllByText('¥123.45').length).toBeGreaterThan(0)
    expect(screen.getAllByText('¥5.00').length).toBeGreaterThan(0)
    expect(screen.getAllByText('¥0.00').length).toBeGreaterThan(0)
    expect(screen.getByText('已登记待复核')).toBeTruthy()

    // Recipients come straight from the server, missing evidence is stated.
    expect(screen.getAllByText('杭州三创生活服务有限公司').length).toBeGreaterThan(0)
    expect(screen.getByText('杭州三创数字科技有限公司')).toBeTruthy()
    expect(screen.getByText('91330100MA2XXXXXXX')).toBeTruthy()
    expect(screen.getByText('未提供')).toBeTruthy()
    expect(screen.getByText('部分支付')).toBeTruthy()
    expect(screen.getByText('待付款')).toBeTruthy()

    // Records: masked proof only, pending review, never verified locally.
    expect(screen.getByText('BANK-20261109-001')).toBeTruthy()
    expect(screen.getByText('待复核')).toBeTruthy()
    expect(screen.getAllByText(USER_ID).length).toBeGreaterThan(0)

    // Events are read-only and ordered by the server sequence.
    expect(screen.getByText('登记')).toBeTruthy()
    expect(screen.getByText('sequence 1')).toBeTruthy()
    expect(screen.getAllByText(/网点回单/).length).toBeGreaterThan(0)

    // No client-side sums of the server's numbers (payable+recorded, payable+net).
    expect(document.body.textContent).not.toContain('¥128.45')
    expect(document.body.textContent).not.toContain('¥105.00')
  })

  it('refuses to render the registration form unless the statement is locked', async () => {
    stubApi([paymentRoutes({ statement: statement() })])
    const draftRender = renderPanel(ADMIN_SESSION)
    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    await openPaymentTab()
    expect(await screen.findByText('只有已锁定的结算单才能登记线下付款凭据')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登记付款凭据' })).toBeNull()
    draftRender.unmount()
    vi.unstubAllGlobals()

    stubApi([
      paymentRoutes({
        statement: statement({
          status: 'reviewed',
          revision: 2,
          reviewedByUserId: USER_ID,
          reviewEvidenceRef: '复核单 2026-11-08',
          reviewedAt: '2026-11-08T03:00:00.000Z',
        }),
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    await openPaymentTab()
    expect(await screen.findByText('只有已锁定的结算单才能登记线下付款凭据')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登记付款凭据' })).toBeNull()
  })

  it('records a locked-statement proof with CSRF and refreshes from the server overview', async () => {
    const posts: FetchCall[] = []
    const newRecord = {
      ...paymentOverview().records[0]!,
      id: '123e4567-e89b-42d3-a456-426614174f03',
      amountCents: 500,
      proofRefMasked: 'BANK-20261109-002',
      paidAt: '2026-11-09T06:30:00.000Z',
      recordedAt: '2026-11-09T07:00:00.000Z',
    }
    const updated = paymentOverview({
      recordedCents: 1000,
      records: [paymentOverview().records[0]!, newRecord],
    })
    stubApi([
      paymentRoutes({
        statement: statement({ status: 'locked', lockedByUserId: USER_ID, lockedAt: '2026-11-09T01:00:00.000Z' }),
        post: (url, init) => {
          posts.push({ url, init })
          return json(updated, 201)
        },
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openLockedPayment()

    const keyBefore = displayedKey()
    expect(keyBefore).toMatch(/^[0-9a-f-]{36}$/)
    await fillPayment()
    fireEvent.click(screen.getByRole('button', { name: '登记付款凭据' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    const post = posts[0]!
    expect(urlOf(post).pathname).toBe(`${STATEMENTS_ROUTE}/${STATEMENT_ID}/payments`)
    expect(post.init?.method).toBe('POST')
    expect(headersOf(post)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init?.body))).toEqual({
      beneficiaryPartyId: SELLER_ID,
      amountCents: 500,
      paidAt: new Date('2026-11-09T14:30').toISOString(),
      proofRefMasked: 'BANK-20261109-002',
      idempotencyKey: keyBefore,
    })

    expect(await screen.findByText(/已登记，待复核/)).toBeTruthy()
    // The area is refreshed from the returned overview (new record visible).
    expect(await screen.findByText('BANK-20261109-002')).toBeTruthy()
    // Registration is NOT verification.
    expect(screen.queryAllByText('已核销')).toHaveLength(0)
    // A new intent only after success.
    expect(displayedKey()).not.toBe(keyBefore)
  })

  it('reuses the same idempotency key after an uncertain failure and only rotates on success', async () => {
    const posts: FetchCall[] = []
    let attempt = 0
    stubApi([
      paymentRoutes({
        statement: statement({ status: 'locked', lockedByUserId: USER_ID, lockedAt: '2026-11-09T01:00:00.000Z' }),
        post: (url, init) => {
          posts.push({ url, init })
          attempt += 1
          if (attempt === 1) throw new Error('network down')
          return json(paymentOverview({ recordedCents: 1000 }), 201)
        },
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openLockedPayment()

    const keyBefore = displayedKey()
    await fillPayment()
    fireEvent.click(screen.getByRole('button', { name: '登记付款凭据' }))
    expect(await screen.findByText(/无法连接管理后台 API/)).toBeTruthy()
    expect(posts).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '登记付款凭据' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    const first = JSON.parse(String(posts[0]!.init?.body)) as { idempotencyKey: string }
    const second = JSON.parse(String(posts[1]!.init?.body)) as { idempotencyKey: string }
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(second.idempotencyKey).toBe(keyBefore)

    expect(await screen.findByText(/已登记，待复核/)).toBeTruthy()
    expect(displayedKey()).not.toBe(keyBefore)
  })

  it('blocks a proof reference containing 12+ consecutive digits before any request', async () => {
    const posts: FetchCall[] = []
    stubApi([
      paymentRoutes({
        statement: statement({ status: 'locked', lockedByUserId: USER_ID, lockedAt: '2026-11-09T01:00:00.000Z' }),
        post: (url, init) => {
          posts.push({ url, init })
          return json(paymentOverview(), 201)
        },
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openLockedPayment()

    await fillPayment({ proof: '6222021234567890' })
    fireEvent.click(screen.getByRole('button', { name: '登记付款凭据' }))

    expect(
      await screen.findByText('不得填写完整银行卡号、账号或其他长数字凭据'),
    ).toBeTruthy()
    expect(posts).toHaveLength(0)
  })

  it('keeps the form and key when the server rejects the registration (409)', async () => {
    const posts: FetchCall[] = []
    stubApi([
      paymentRoutes({
        statement: statement({ status: 'locked', lockedByUserId: USER_ID, lockedAt: '2026-11-09T01:00:00.000Z' }),
        post: (url, init) => {
          posts.push({ url, init })
          return json(
            {
              error: {
                code: 'settlement_payment_overpay',
                message: '付款登记金额超过该受款人的应付金额',
              },
            },
            409,
          )
        },
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openLockedPayment()

    const keyBefore = displayedKey()
    await fillPayment()
    fireEvent.click(screen.getByRole('button', { name: '登记付款凭据' }))

    expect(
      await screen.findByText(/数据已被更新：付款登记金额超过该受款人的应付金额/),
    ).toBeTruthy()
    expect(screen.queryByText(/已登记，待复核/)).toBeNull()
    expect(posts).toHaveLength(1)
    // Same key and the entered values survive the rejection.
    expect(displayedKey()).toBe(keyBefore)
    const input = within(paymentFormElement()).getByLabelText('脱敏付款凭据引用')
    expect((input as HTMLInputElement).value).toBe('BANK-20261109-002')
    // The record list still shows only the server's previous record.
    expect(screen.queryByText('BANK-20261109-002')).toBeNull()
  })

  it('shows the server 403 to an operator, with no form and no verify/dispute entry', async () => {
    stubApi([
      [
        STATEMENTS_ROUTE,
        (url) => {
          const path = new URL(url, 'http://localhost').pathname
          if (path === STATEMENTS_ROUTE) {
            return json({
              items: [statement({ status: 'locked', lockedByUserId: USER_ID, lockedAt: '2026-11-09T01:00:00.000Z' })],
              total: 1,
              page: 1,
              pageSize: 20,
            })
          }
          if (path.endsWith('/payments')) {
            return json(
              { error: { code: 'forbidden', message: '只有管理员可登记或复核线下付款凭据' } },
              403,
            )
          }
          return json(detail())
        },
      ],
    ])
    renderPanel(OPERATOR_SESSION)

    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    await openPaymentTab()

    expect(
      (await screen.findAllByText(/只有管理员可登记或复核线下付款凭据/)).length,
    ).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '登记付款凭据' })).toBeNull()
    expect(screen.queryByRole('button', { name: /核验/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /标记争议/ })).toBeNull()
    // A 403 must not masquerade as "no payment records": no KPI/list is rendered.
    expect(screen.queryByText('受款人（真实登记主体）')).toBeNull()
    expect(screen.queryByText('已登记付款凭据')).toBeNull()
    // The statement summary can legitimately contain zero-valued amounts;
    // a payment 403 must hide PAYMENT amounts, not unrelated statement data.
    const paymentPanel = screen.getByRole('tabpanel', { name: /付款凭据/ })
    expect(within(paymentPanel).queryAllByText('¥0.00')).toHaveLength(0)
    expect(within(paymentPanel).queryByText(/暂无付款事件|尚未登记付款凭据/)).toBeNull()
  })

  it('never claims payment/verification and offers no transfer entry', async () => {
    stubApi([
      paymentRoutes({
        statement: statement({ status: 'locked', lockedByUserId: USER_ID, lockedAt: '2026-11-09T01:00:00.000Z' }),
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openLockedPayment()

    expect(screen.getByText('登记付款凭据 ≠ 复核核销')).toBeTruthy()
    expect(screen.getByText(/不触发任何转账/)).toBeTruthy()
    expect(screen.queryAllByText('已付款')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /发起付款/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /转账/ })).toBeNull()
  })
})

describe('SettlementStatementPanel · 付款核验与争议（#226）', () => {
  function lockedStatement(): SettlementStatement {
    return statement({
      status: 'locked',
      revision: 3,
      reviewedByUserId: USER_ID,
      reviewEvidenceRef: '复核单 2026-11-08',
      reviewedAt: '2026-11-08T03:00:00.000Z',
      lockedByUserId: USER_ID,
      lockEvidenceRef: '锁单依据 2026-11-09',
      lockedAt: '2026-11-09T01:00:00.000Z',
    })
  }

  function verifiedOverview(): SettlementPaymentOverview {
    const base = paymentOverview()
    return {
      ...base,
      state: 'verified',
      verifiedCents: 500,
      records: [{ ...base.records[0]!, state: 'verified' }],
      events: [
        ...base.events,
        {
          id: '123e4567-e89b-42d3-a456-426614174f04',
          paymentRecordId: PAYMENT_RECORD_ID,
          statementId: STATEMENT_ID,
          kind: 'verified',
          sequence: 2,
          actorUserId: USER_ID,
          evidenceRef: '银行回单核对 2026-11-10',
          state: 'verified',
          createdAt: '2026-11-10T02:00:00.000Z',
        },
      ],
    }
  }

  function disputedOverview(): SettlementPaymentOverview {
    const base = paymentOverview()
    return {
      ...base,
      state: 'disputed',
      records: [{ ...base.records[0]!, state: 'disputed' }],
      events: [
        ...base.events,
        {
          id: '123e4567-e89b-42d3-a456-426614174f05',
          paymentRecordId: PAYMENT_RECORD_ID,
          statementId: STATEMENT_ID,
          kind: 'disputed',
          sequence: 2,
          actorUserId: USER_ID,
          evidenceRef: '金额与回单不符',
          state: 'disputed',
          createdAt: '2026-11-10T02:00:00.000Z',
        },
      ],
    }
  }

  type ActionPost = (url: string, init?: RequestInit) => Response | Promise<Response>

  function actionRoutes(options: {
    overview?: () => SettlementPaymentOverview
    post?: ActionPost
  } = {}): readonly [string, Handler] {
    return [
      STATEMENTS_ROUTE,
      (url, init) => {
        const path = new URL(url, 'http://localhost').pathname
        if (path === STATEMENTS_ROUTE) {
          return json({ items: [lockedStatement()], total: 1, page: 1, pageSize: 20 })
        }
        if (/\/payments\/[^/]+\/(verify|dispute)$/u.test(path)) {
          if (init?.method === 'POST' && options.post) return options.post(url, init)
          return json({ error: { code: 'not_found', message: '付款凭据不存在' } }, 404)
        }
        if (path.endsWith('/payments')) {
          return json(options.overview ? options.overview() : paymentOverview())
        }
        return json({ ...detail(), statement: lockedStatement() })
      },
    ]
  }

  async function openPaymentArea() {
    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    fireEvent.click(await screen.findByRole('tab', { name: /付款凭据/ }))
    await screen.findByText('BANK-20261109-001')
  }

  async function openVerifyModal(button: HTMLElement) {
    fireEvent.click(button)
    await screen.findByText('核验付款凭据（人工核验）')
    expect(screen.getByText(/核验会改变这条凭据的付款状态并计入核销统计/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('核验依据'), {
      target: { value: '银行回单核对 2026-11-10' },
    })
  }

  function actionKey(): string {
    return screen.getByTestId('payment-action-idempotency-key').textContent ?? ''
  }

  it('verifies a pending proof and re-renders the whole section from the server overview', async () => {
    const posts: FetchCall[] = []
    stubApi([
      actionRoutes({
        post: (url, init) => {
          posts.push({ url, init })
          return json(verifiedOverview())
        },
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openPaymentArea()

    expect(screen.getByText('待复核')).toBeTruthy()
    await openVerifyModal(screen.getByRole('button', { name: /核\s*验/ }))
    const displayedKey = actionKey()

    fireEvent.click(within(modalElement()).getByRole('button', { name: '确认核验' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    const post = posts[0]!
    expect(urlOf(post).pathname).toBe(
      `${STATEMENTS_ROUTE}/${STATEMENT_ID}/payments/${PAYMENT_RECORD_ID}/verify`,
    )
    expect(post.init?.method).toBe('POST')
    expect(headersOf(post)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init?.body))).toEqual({
      eventIdempotencyKey: displayedKey,
      evidenceRef: '银行回单核对 2026-11-10',
    })

    expect(await screen.findByText(/付款凭据已核验/)).toBeTruthy()
    // Server truth only: the record and the overview now say verified/已核销.
    expect((await screen.findAllByText('已核销')).length).toBeGreaterThan(0)
    // Verification is not a payment.
    expect(screen.queryAllByText('已付款')).toHaveLength(0)
  })

  it('shows the server self-review 403 verbatim without implying verification', async () => {
    stubApi([
      actionRoutes({
        post: () =>
          json(
            { error: { code: 'forbidden', message: '付款登记人不能复核自己的付款凭据' } },
            403,
          ),
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openPaymentArea()
    await openVerifyModal(screen.getByRole('button', { name: /核\s*验/ }))
    fireEvent.click(within(modalElement()).getByRole('button', { name: '确认核验' }))

    expect(
      await screen.findByText(/没有权限：付款登记人不能复核自己的付款凭据/),
    ).toBeTruthy()
    // The dialog stays open, no success message, and nothing claims 已核验/已核销.
    expect(screen.getByLabelText('核验依据')).toBeTruthy()
    expect(screen.queryByText(/付款凭据已核验/)).toBeNull()
    expect(screen.queryAllByText('已核销')).toHaveLength(0)
  })

  it('marks a pending proof as disputed and refreshes from the server overview', async () => {
    const posts: FetchCall[] = []
    stubApi([
      actionRoutes({
        post: (url, init) => {
          posts.push({ url, init })
          return json(disputedOverview())
        },
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openPaymentArea()

    fireEvent.click(screen.getByRole('button', { name: '标记争议' }))
    expect(await screen.findByText('标记付款争议')).toBeTruthy()
    expect(screen.getByText(/标记争议会改变该凭据状态并影响总览/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('争议依据'), {
      target: { value: '金额与回单不符' },
    })
    const disputeKey = actionKey()
    fireEvent.click(within(modalElement()).getByRole('button', { name: '确认标记争议' }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(urlOf(posts[0]!).pathname).toBe(
      `${STATEMENTS_ROUTE}/${STATEMENT_ID}/payments/${PAYMENT_RECORD_ID}/dispute`,
    )
    expect(JSON.parse(String(posts[0]!.init?.body))).toEqual({
      eventIdempotencyKey: disputeKey,
      evidenceRef: '金额与回单不符',
    })
    expect(await screen.findByText(/付款凭据已标记争议/)).toBeTruthy()
    expect((await screen.findAllByText('争议')).length).toBeGreaterThan(0)
  })

  it('sends only one request while the confirmation is submitting', async () => {
    let resolvePost: ((response: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => {
      resolvePost = resolve
    })
    const posts: FetchCall[] = []
    stubApi([
      actionRoutes({
        post: (url, init) => {
          posts.push({ url, init })
          return pending
        },
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openPaymentArea()
    await openVerifyModal(screen.getByRole('button', { name: /核\s*验/ }))

    const ok = within(modalElement()).getByRole('button', { name: '确认核验' })
    fireEvent.click(ok)
    await waitFor(() => expect(posts).toHaveLength(1))
    // A second click while the confirmation is still submitting is ignored.
    fireEvent.click(ok)
    expect(posts).toHaveLength(1)

    resolvePost?.(json(verifiedOverview()))
    expect(await screen.findByText(/付款凭据已核验/)).toBeTruthy()
    expect(posts).toHaveLength(1)
  })

  it('refreshes from the server truth after a 409 instead of guessing a rollback', async () => {
    let overviewReads = 0
    const posts: FetchCall[] = []
    stubApi([
      actionRoutes({
        overview: () => {
          overviewReads += 1
          return overviewReads === 1 ? paymentOverview() : verifiedOverview()
        },
        post: (url, init) => {
          posts.push({ url, init })
          return json(
            {
              error: {
                code: 'settlement_payment_already_reviewed',
                message: '该付款凭据已经完成复核，不能重复或改写结论',
              },
            },
            409,
          )
        },
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openPaymentArea()
    await openVerifyModal(screen.getByRole('button', { name: /核\s*验/ }))
    fireEvent.click(within(modalElement()).getByRole('button', { name: '确认核验' }))

    expect(
      await screen.findByText(/数据已被更新：该付款凭据已经完成复核/),
    ).toBeTruthy()
    // The area is re-read from the server; its truth (已核销) replaces the guess.
    await waitFor(() => expect(overviewReads).toBeGreaterThanOrEqual(2))
    expect((await screen.findAllByText('已核销')).length).toBeGreaterThan(0)
    expect(screen.queryByText(/付款凭据已核验/)).toBeNull()
    expect(posts).toHaveLength(1)
  })

  it('reuses the event idempotency key after an uncertain failure and rotates it for a new action', async () => {
    const twoRecords = paymentOverview()
    const secondRecord = {
      ...twoRecords.records[0]!,
      id: '123e4567-e89b-42d3-a456-426614174f06',
      proofRefMasked: 'BANK-20261109-003',
      amountCents: 200,
    }
    const withTwo = paymentOverview({ records: [twoRecords.records[0]!, secondRecord] })
    const afterVerify = {
      ...withTwo,
      records: [{ ...withTwo.records[0]!, state: 'verified' as const }, secondRecord],
    }
    let attempt = 0
    const posts: FetchCall[] = []
    stubApi([
      actionRoutes({
        overview: () => withTwo,
        post: (url, init) => {
          posts.push({ url, init })
          attempt += 1
          if (attempt === 1) throw new Error('network down')
          return json(afterVerify)
        },
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openPaymentArea()

    await openVerifyModal(screen.getAllByRole('button', { name: /核\s*验/ })[0]!)
    const firstKey = actionKey()
    fireEvent.click(within(modalElement()).getByRole('button', { name: '确认核验' }))
    expect(await screen.findByText(/无法连接管理后台 API/)).toBeTruthy()
    expect(posts).toHaveLength(1)

    fireEvent.click(within(modalElement()).getByRole('button', { name: '确认核验' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    const bodies = posts.map((post) => JSON.parse(String(post.init?.body)) as {
      eventIdempotencyKey: string
      evidenceRef: string
    })
    expect(bodies[1]!.eventIdempotencyKey).toBe(bodies[0]!.eventIdempotencyKey)
    expect(bodies[0]!.eventIdempotencyKey).toBe(firstKey)
    expect(await screen.findByText(/付款凭据已核验/)).toBeTruthy()

    // A new logical action starts a new key.
    fireEvent.click(screen.getByRole('button', { name: '标记争议' }))
    expect(await screen.findByText('标记付款争议')).toBeTruthy()
    expect(actionKey()).not.toBe(firstKey)
  })

  it('shows an operator no verify/dispute entry at all', async () => {
    stubApi([
      [
        STATEMENTS_ROUTE,
        (url) => {
          const path = new URL(url, 'http://localhost').pathname
          if (path === STATEMENTS_ROUTE) {
            return json({ items: [lockedStatement()], total: 1, page: 1, pageSize: 20 })
          }
          if (path.endsWith('/payments')) {
            return json(
              { error: { code: 'forbidden', message: '只有管理员可登记或复核线下付款凭据' } },
              403,
            )
          }
          return json({ ...detail(), statement: lockedStatement() })
        },
      ],
    ])
    renderPanel(OPERATOR_SESSION)
    await screen.findByText('STL-20261101-0001')
    await openDetailDrawer()
    fireEvent.click(await screen.findByRole('tab', { name: /付款凭据/ }))

    expect(
      (await screen.findAllByText(/只有管理员可登记或复核线下付款凭据/)).length,
    ).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /核\s*验/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /标记争议/ })).toBeNull()
  })

  it('keeps the audit events read-only with who/when/what visible', async () => {
    stubApi([
      actionRoutes({
        overview: () => verifiedOverview(),
      }),
    ])
    renderPanel(ADMIN_SESSION)
    await openPaymentArea()

    // Both recorded and verified events are visible with the server fields.
    expect(screen.getByText('sequence 1')).toBeTruthy()
    expect(screen.getByText('sequence 2')).toBeTruthy()
    expect(screen.getAllByText(USER_ID).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/银行回单核对 2026-11-10/).length).toBeGreaterThan(0)
    expect(
      screen.getByText(/历史事件只读：记录谁在什么时候做了什么/),
    ).toBeTruthy()
    // No edit/delete control anywhere in the payment tab.
    expect(screen.queryByRole('button', { name: /编辑/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull()
  })

  it('never describes verification as a payment or opens a transfer entry', async () => {
    stubApi([actionRoutes({ overview: () => verifiedOverview() })])
    renderPanel(ADMIN_SESSION)
    await openPaymentArea()

    expect(screen.getAllByText(/锁定 ≠ 已付/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/凭据登记 ≠ 已核销/).length).toBeGreaterThan(0)
    expect(screen.queryAllByText('已付款')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /发起付款/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /转账/ })).toBeNull()
  })
})
