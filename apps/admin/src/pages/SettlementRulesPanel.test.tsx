// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type {
  LocalProductSummary,
  SettlementMapping,
  SettlementParty,
  SettlementRuleVersion,
} from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import {
  SETTLEMENT_PARTY_ROLE_LABELS,
  SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS,
  SETTLEMENT_RULE_PARTY_KEY_LABELS,
} from '../services/settlement'
import { SettlementRulesPanel } from './SettlementRulesPanel'
import { SettlementsPage } from './SettlementsPage'

/**
 * Drives the real 合同规则版本 panel (#221) against a stubbed `fetch`.
 *
 * What these tests protect:
 *
 * - the approved-rule history is read-only: every version is listed, and there is
 *   no edit/delete/overwrite control anywhere;
 * - registration is admin-only, carries `x-csrf-token`, sends the complete fixed
 *   contract body (policy literals included), and re-reads the list instead of
 *   inserting a row;
 * - the client-side contract rules stop a bad submit before any fetch: rates must
 *   sum to exactly 10000 bp, approval date must not follow the effective start,
 *   and the processor-fee owner must match whether the fee is zero;
 * - a server 409 keeps its real message and never looks like a success;
 * - an operator has no registration entry and always reads with its own
 *   communityId;
 * - 待核定 is never rendered as ¥0 / 应付金额 / a client-side trial amount.
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
const RULE_ID = '123e4567-e89b-42d3-a456-426614174801'
const RULE_2_ID = '123e4567-e89b-42d3-a456-426614174802'
const RULE_3_ID = '123e4567-e89b-42d3-a456-426614174803'
const CSRF_TOKEN = 'csrf-token-for-settlement-rule-tests'

const RULES_ROUTE = '/api/admin/settlement/rules'
const MAPPINGS_ROUTE = '/api/admin/settlement/mappings'
const PARTIES_ROUTE = '/api/admin/settlement/parties'
const PRODUCTS_ROUTE = '/api/admin/catalog/products'
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
    guangdianPartyId: GUANGDIAN_ID,
    agreementRef: 'AG-2026-001',
    effectiveFrom: '2026-11-01',
    effectiveTo: '2026-12-31',
    createdByUserId: USER_ID,
    createdAt: '2026-11-01T03:00:00.000Z',
    ...overrides,
  }
}

function ruleVersion(overrides: Partial<SettlementRuleVersion> = {}): SettlementRuleVersion {
  return {
    id: RULE_ID,
    mappingId: MAPPING_ID,
    version: 1,
    communityId: COMMUNITY_A.id,
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
          <SettlementRulesPanel />
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

function baseRoutes(
  overrides: ReadonlyArray<readonly [string, Handler]> = [],
): ReadonlyArray<readonly [string, Handler]> {
  return [
    ...overrides,
    [RULES_ROUTE, () => json({ items: [ruleVersion()] })],
    [MAPPINGS_ROUTE, () => json({ items: [mapping()] })],
    [PARTIES_ROUTE, () => json({ items: [party()] })],
    [PRODUCTS_ROUTE, () => json({ items: [product()], total: 1, page: 1, pageSize: 100 })],
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

/** The drawer's only antd Form. */
function ruleFormElement(): HTMLElement {
  const form = document.querySelector('.ant-form')
  expect(form, 'the rule form must be rendered').toBeTruthy()
  return form as HTMLElement
}

async function openRuleDrawer() {
  fireEvent.click(screen.getByRole('button', { name: '登记规则版本' }))
  await screen.findByText('登记合同规则版本')
}

const MAPPING_OPTION_LABEL = '社区宽带体验套餐 · 2026-11-01 ~ 2026-12-31 · 123e4567'

interface RuleFormFill {
  approvalOn?: string
  effectiveFrom?: string
  effectiveTo?: string
  processorFeeBps?: string
  processorFeeOwner?: string
  sellerRate?: string
  sanchuangRate?: string
  guangdianRate?: string
  roundingRecipient?: string
}

async function fillRuleForm(values: RuleFormFill = {}) {
  const form = ruleFormElement()
  await chooseOption(within(form).getByLabelText('商户映射版本'), MAPPING_OPTION_LABEL)
  fireEvent.change(within(form).getByLabelText('协议引用'), { target: { value: 'AG-2026-001' } })
  fireEvent.change(within(form).getByLabelText('核准依据'), {
    target: { value: '董事会决议 2026-11-01' },
  })
  fireEvent.change(within(form).getByLabelText('核准日期'), {
    target: { value: values.approvalOn ?? '2026-11-01' },
  })
  fireEvent.change(within(form).getByLabelText('生效起日'), {
    target: { value: values.effectiveFrom ?? '2026-11-05' },
  })
  fireEvent.change(within(form).getByLabelText('生效止日'), {
    target: { value: values.effectiveTo ?? '2026-12-31' },
  })
  fireEvent.change(within(form).getByLabelText('手续费（基点）'), {
    target: { value: values.processorFeeBps ?? '100' },
  })
  await chooseOption(
    within(form).getByLabelText('手续费承担方'),
    values.processorFeeOwner ?? SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS.seller,
  )
  fireEvent.change(
    within(form).getByLabelText(`${SETTLEMENT_PARTY_ROLE_LABELS.seller}比例`),
    { target: { value: values.sellerRate ?? '9000' } },
  )
  fireEvent.change(
    within(form).getByLabelText(`${SETTLEMENT_PARTY_ROLE_LABELS.sanchuang}比例`),
    { target: { value: values.sanchuangRate ?? '500' } },
  )
  fireEvent.change(
    within(form).getByLabelText(`${SETTLEMENT_PARTY_ROLE_LABELS.guangdian}比例`),
    { target: { value: values.guangdianRate ?? '500' } },
  )
  await chooseOption(
    within(form).getByLabelText('舍入余额接收方'),
    values.roundingRecipient ?? SETTLEMENT_RULE_PARTY_KEY_LABELS.sanchuang,
  )
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

describe('SettlementRulesPanel · 只读历史', () => {
  it('shows the 待核定 empty state, the admin registration entry, and no fabricated amount', async () => {
    const calls = stubApi(baseRoutes([[RULES_ROUTE, () => json({ items: [] })]]))
    renderPanel(ADMIN_SESSION)

    expect(await screen.findByText('尚无已核准合同规则／待核定')).toBeTruthy()
    expect(screen.getByText(/系统不会产生确定的应收/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '登记规则版本' })).toBeTruthy()

    expect(readsOf(calls, RULES_ROUTE)).toHaveLength(1)
    expect(urlOf(readsOf(calls, RULES_ROUTE)[0]!).pathname).toBe(RULES_ROUTE)
    // 管理员默认「全部社区」：不带 communityId 才是服务端的全部范围查询。
    expect(urlOf(readsOf(calls, RULES_ROUTE)[0]!).searchParams.has('communityId')).toBe(false)

    // The 待核定 state is not a zero amount and not a client-side trial.
    expect(document.body.textContent).not.toContain('¥')
    expect(document.body.textContent).not.toContain('¥0')
    expect(screen.queryAllByText('应付金额')).toHaveLength(0)
  })

  it('lists every version in order with its bp rates and offers no edit/delete control', async () => {
    stubApi(
      baseRoutes([
        [
          RULES_ROUTE,
          () =>
            json({
              items: [
                ruleVersion(),
                ruleVersion({ id: RULE_2_ID, version: 2, approvalOn: '2026-12-01', effectiveFrom: '2027-01-01', effectiveTo: '2027-06-30' }),
                ruleVersion({ id: RULE_3_ID, version: 3, approvalOn: '2027-06-01', effectiveFrom: '2027-07-01', effectiveTo: '2027-12-31' }),
              ],
            }),
        ],
      ]),
    )
    renderPanel(ADMIN_SESSION)

    expect(await screen.findByText('v1')).toBeTruthy()
    expect(screen.getByText('v2')).toBeTruthy()
    expect(screen.getByText('v3')).toBeTruthy()
    expect(screen.getAllByText('seller 9000 / sanchuang 500 / guangdian 500 bp').length).toBe(3)
    expect(screen.getAllByText('1 bp = 0.01%；10000 bp = 100%').length).toBe(3)
    expect(screen.getAllByText('AG-2026-001').length).toBe(3)
    expect(screen.getAllByText('董事会决议 2026-11-01').length).toBe(3)
    expect(screen.getAllByText('2026-11-05 ~ 2026-12-31').length).toBe(1)
    expect(screen.getAllByText('100 bp').length).toBe(3)
    expect(screen.getAllByText(`承担方：${SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS.seller}`).length).toBe(3)
    expect(screen.getAllByText(SETTLEMENT_RULE_PARTY_KEY_LABELS.sanchuang).length).toBe(3)
    // History is append-only: no edit/delete/overwrite entry point at all.
    expect(screen.queryByRole('button', { name: /编辑|删除/ })).toBeNull()
    expect(screen.queryByText('编辑')).toBeNull()
    expect(screen.queryByText('删除')).toBeNull()
    expect(document.body.textContent).not.toContain('¥')
  })
})

describe('SettlementRulesPanel · 登记新版本', () => {
  it('POSTs the complete fixed contract body with CSRF and re-reads the history', async () => {
    const created = ruleVersion()
    let ruleReads = 0
    const calls = stubApi(
      baseRoutes([
        [
          RULES_ROUTE,
          (_url, init) => {
            if (init?.method === 'POST') return json(created, 201)
            ruleReads += 1
            return json({ items: ruleReads === 1 ? [] : [created] })
          },
        ],
      ]),
    )
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('尚无已核准合同规则／待核定')
    await openRuleDrawer()
    await fillRuleForm()

    fireEvent.click(within(ruleFormElement()).getByRole('button', { name: '提交登记' }))

    await waitFor(() => expect(writesOf(calls, RULES_ROUTE)).toHaveLength(1))
    const post = writesOf(calls, RULES_ROUTE)[0]!
    expect(post.init?.method).toBe('POST')
    expect(headersOf(post)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init?.body))).toEqual({
      mappingId: MAPPING_ID,
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
    })

    expect(await screen.findByText(/已登记合同规则版本/)).toBeTruthy()
    await waitFor(() => expect(ruleReads).toBe(2))
    expect(await screen.findByText('v1')).toBeTruthy()
  })

  it('does not POST when the three rates do not sum to exactly 10000 bp', async () => {
    const calls = stubApi(baseRoutes([[RULES_ROUTE, () => json({ items: [] })]]))
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('尚无已核准合同规则／待核定')
    await openRuleDrawer()
    await fillRuleForm({ sellerRate: '9000', sanchuangRate: '500', guangdianRate: '400' })

    // The live total must show the mismatch, not a client-side amount.
    expect(screen.getByText(/三方合计：9900 \/ 10000 bp/)).toBeTruthy()

    fireEvent.click(within(ruleFormElement()).getByRole('button', { name: '提交登记' }))

    expect(
      (await screen.findAllByText('三方合约分配比例必须精确合计 10000 基点')).length,
    ).toBeGreaterThan(0)
    expect(writesOf(calls, RULES_ROUTE)).toHaveLength(0)
  })

  it('does not POST when approvalOn is later than effectiveFrom', async () => {
    const calls = stubApi(baseRoutes([[RULES_ROUTE, () => json({ items: [] })]]))
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('尚无已核准合同规则／待核定')
    await openRuleDrawer()
    await fillRuleForm({ approvalOn: '2026-12-01', effectiveFrom: '2026-11-05', effectiveTo: '2026-12-31' })

    fireEvent.click(within(ruleFormElement()).getByRole('button', { name: '提交登记' }))

    expect(await screen.findByText('核准日期必须不晚于规则生效起始日')).toBeTruthy()
    expect(writesOf(calls, RULES_ROUTE)).toHaveLength(0)
  })

  it('does not POST when processorFeeBps and the fee owner disagree', async () => {
    const calls = stubApi(baseRoutes([[RULES_ROUTE, () => json({ items: [] })]]))
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('尚无已核准合同规则／待核定')
    await openRuleDrawer()
    // Zero fee but a concrete bearer.
    await fillRuleForm({ processorFeeBps: '0', processorFeeOwner: SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS.seller })

    fireEvent.click(within(ruleFormElement()).getByRole('button', { name: '提交登记' }))
    expect(
      await screen.findByText('手续费为 0 时必须选择「无手续费」；大于 0 时必须选择具体承担方'),
    ).toBeTruthy()
    expect(writesOf(calls, RULES_ROUTE)).toHaveLength(0)

    // Non-zero fee but "none".
    fireEvent.change(within(ruleFormElement()).getByLabelText('手续费（基点）'), {
      target: { value: '100' },
    })
    await chooseOption(
      within(ruleFormElement()).getByLabelText('手续费承担方'),
      SETTLEMENT_PROCESSOR_FEE_OWNER_LABELS.none,
    )
    fireEvent.click(within(ruleFormElement()).getByRole('button', { name: '提交登记' }))
    expect(
      (await screen.findAllByText('手续费为 0 时必须选择「无手续费」；大于 0 时必须选择具体承担方')).length,
    ).toBeGreaterThan(0)
    expect(writesOf(calls, RULES_ROUTE)).toHaveLength(0)
  })

  it('keeps the drawer open with the server 409 message and never claims success', async () => {
    const calls = stubApi(
      baseRoutes([
        [
          RULES_ROUTE,
          (_url, init) => {
            if (init?.method === 'POST') {
              return json(
                {
                  error: {
                    code: 'settlement_rule_conflict',
                    message: '该映射已存在覆盖同期间的规则版本',
                  },
                },
                409,
              )
            }
            return json({ items: [] })
          },
        ],
      ]),
    )
    renderPanel(ADMIN_WITH_COMMUNITIES)

    await screen.findByText('尚无已核准合同规则／待核定')
    await openRuleDrawer()
    await fillRuleForm()

    fireEvent.click(within(ruleFormElement()).getByRole('button', { name: '提交登记' }))

    expect(
      await screen.findByText(/数据已被更新：该映射已存在覆盖同期间的规则版本/),
    ).toBeTruthy()
    expect(within(ruleFormElement()).getByLabelText('协议引用')).toBeTruthy()
    expect(screen.queryByText(/已登记合同规则版本/)).toBeNull()
    expect(readsOf(calls, RULES_ROUTE)).toHaveLength(1)
  })
})

describe('SettlementRulesPanel · 运营员只读', () => {
  it('hides the registration entry and always reads with an authorized communityId', async () => {
    const calls = stubApi(baseRoutes())
    renderPanel(OPERATOR_SESSION)

    expect(await screen.findByText('v1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登记规则版本' })).toBeNull()
    expect(screen.queryByText('登记合同规则版本')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    expect(readsOf(calls, RULES_ROUTE)).toHaveLength(1)
    expect(urlOf(readsOf(calls, RULES_ROUTE)[0]!).searchParams.get('communityId')).toBe(
      COMMUNITY_A.id,
    )
  })

  it('does not invent a scope or issue any request without an assigned community', async () => {
    const calls = stubApi(baseRoutes())
    renderPanel({
      ...ADMIN_SESSION,
      staff: { ...ADMIN_SESSION.staff, role: 'operator', communities: [] },
    })

    expect(await screen.findByText('当前账号没有可用的社区范围')).toBeTruthy()
    expect(callsTo(calls, RULES_ROUTE)).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '登记规则版本' })).toBeNull()
  })
})

describe('SettlementRulesPanel · 页面口径与挂载', () => {
  it('states the immutable/versioning boundaries and never renders a client-side amount', async () => {
    stubApi(baseRoutes())
    renderPanel(ADMIN_SESSION)

    expect(await screen.findByText('v1')).toBeTruthy()
    expect(screen.getByText(/规则版本一经登记不可修改，调整必须登记新版本/)).toBeTruthy()
    expect(screen.getByText(/无已核准规则时不出金额/)).toBeTruthy()
    expect(screen.getByText(/规则登记 ≠ 结算单锁定 ≠ 付款/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('¥')
    expect(document.body.textContent).not.toMatch(/试算金额|应付金额[:：]\s*\d/)
    expect(screen.queryAllByText('应付金额')).toHaveLength(0)
  })

  it('mounts the 合同规则 view lazily as the fourth sub-tab of 分成结算单', async () => {
    const calls = stubApi([
      [BATCH_ROUTE, () => json({ items: [], asOf: '2026-11-11T08:00:00.000Z' })],
      [CANDIDATES_ROUTE, () => json(emptyCandidateResponse())],
      ...baseRoutes([[RULES_ROUTE, () => json({ items: [ruleVersion()] })]]),
    ])
    renderPage()

    expect(await screen.findByRole('tab', { name: '候选看板' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '经营对账' })).toBeNull()

    expect(await screen.findByRole('tab', { name: '合同规则' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '候选看板' })).toBeTruthy()
    expect(callsTo(calls, RULES_ROUTE)).toHaveLength(0)

    fireEvent.click(screen.getByRole('tab', { name: '合同规则' }))
    expect(await screen.findByText('已核准合同规则（只读历史）')).toBeTruthy()
    await waitFor(() => expect(readsOf(calls, RULES_ROUTE)).toHaveLength(1))
    expect(document.querySelector('[role="tabpanel"][aria-label="分成结算单"]')).toBeTruthy()
  })
})
