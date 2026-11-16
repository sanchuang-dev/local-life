// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type {
  LedgerAnomaly,
  LedgerEntry,
  ReconciliationBatch,
  ReconciliationDiff,
} from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { ReconciliationPage } from './ReconciliationPage'

/**
 * Drives the real 对账结算 page against an explicitly stubbed `fetch`.
 *
 * What these tests are actually protecting:
 *
 * - the two diff columns (`未纳入` / `锁后补录`) are shown side by side and are
 *   **never added together** — a locked period must not look un-locked and the
 *   late facts must not vanish;
 * - locking is a two-step act with the optimistic-concurrency token, and both
 *   `409` flavours (`conflict` = stale, `ledger_batch_locked` = already frozen)
 *   are surfaced to the operator instead of silently retried;
 * - the CSV export goes through the dedicated download channel (raw `fetch`,
 *   `accept: text/csv`), never through `requestLocalJson`'s `.json()`;
 * - no wording claims a payment, a closed deal or a payable commission.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const BATCH_ID = '9f1c5d2e-0000-4a11-8b22-0000000000b1'
const BATCH_LOCKED_ID = '9f1c5d2e-0000-4a11-8b22-0000000000b2'
const ENTRY_ID = '7d2b9c10-0000-4e33-9a44-0000000000e1'
const ANOMALY_ID = '5a3e8f70-0000-4c55-8d66-0000000000a1'
const CSRF_TOKEN = 'csrf-token-for-settlement-page-tests'
const BATCH_NO = 'RCN-20261101-0001'
const LOCKED_BATCH_NO = 'RCN-20261108-0002'

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_ID, displayName: '测试管理员' },
  staff: { id: STAFF_ID, username: 'testadmin', role: 'admin', communities: [] },
  csrfToken: CSRF_TOKEN,
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

/** An `open` batch: no lock stamp at all (the contract rejects a half-locked row). */
function openBatch(overrides: Partial<ReconciliationBatch> = {}): ReconciliationBatch {
  return {
    batchId: BATCH_ID,
    batchNo: BATCH_NO,
    periodFrom: '2026-11-01',
    periodTo: '2026-11-07',
    status: 'open',
    entryCount: 2,
    totalCents: 7960,
    note: '十一月第一周对账',
    lockedAt: null,
    lockedByUserId: null,
    lockedByStaffId: null,
    createdAt: '2026-11-08T01:00:00.000Z',
    updatedAt: '2026-11-08T01:00:00.000Z',
    ...overrides,
  }
}

/** A `locked` batch: `lockedAt` + `lockedByUserId` are required by the schema. */
function lockedBatch(overrides: Partial<ReconciliationBatch> = {}): ReconciliationBatch {
  return {
    batchId: BATCH_LOCKED_ID,
    batchNo: LOCKED_BATCH_NO,
    periodFrom: '2026-10-25',
    periodTo: '2026-10-31',
    status: 'locked',
    entryCount: 4,
    totalCents: 15920,
    note: null,
    lockedAt: '2026-11-01T02:30:00.000Z',
    lockedByUserId: USER_ID,
    lockedByStaffId: STAFF_ID,
    createdAt: '2026-10-31T10:00:00.000Z',
    updatedAt: '2026-11-01T02:30:00.000Z',
    ...overrides,
  }
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    entryId: ENTRY_ID,
    factKind: 'order_registered',
    sourceSystem: 'local_order',
    sourceId: 'local-order-0001',
    sourceDisplayNo: 'ORD-20261101-0001',
    communityId: COMMUNITY_A.id,
    productId: null,
    occurredAt: '2026-11-01T02:00:00.000Z',
    verifiedAt: null,
    amountCents: 3980,
    settlementAmountStatus: 'pending_rule',
    attribution: {
      state: 'attributed',
      staffId: STAFF_ID,
      communityId: COMMUNITY_A.id,
      basis: 'explicit_attribution',
    },
    evidence: { kind: 'none', ref: null },
    counterEntryId: null,
    batchId: BATCH_ID,
    reconciliationState: 'batched',
    recordedByUserId: null,
    recordedByStaffId: null,
    createdAt: '2026-11-01T02:05:00.000Z',
    ...overrides,
  }
}

function anomaly(overrides: Partial<LedgerAnomaly> = {}): LedgerAnomaly {
  return {
    anomalyId: ANOMALY_ID,
    entryId: ENTRY_ID,
    kind: 'amount_mismatch',
    severity: 'high',
    note: '登记金额与收据金额不一致，待人工核对',
    flaggedByUserId: USER_ID,
    resolvedAt: null,
    createdAt: '2026-11-02T03:00:00.000Z',
    ...overrides,
  }
}

/**
 * A diff with the two columns deliberately unequal and non-zero:
 * `unbatched` 2 / ¥80.00, `lateRecorded` 1 / ¥39.80. Their sum (¥119.80 /
 * 3 笔) must never appear, because the two blocks are disjoint by construction.
 */
function diff(overrides: Partial<ReconciliationDiff> = {}): ReconciliationDiff {
  return {
    batchId: BATCH_ID,
    batchNo: BATCH_NO,
    status: 'open',
    periodFrom: '2026-11-01',
    periodTo: '2026-11-07',
    stored: { entryCount: 2, totalCents: 7960 },
    computed: { entryCount: 2, totalCents: 7960 },
    items: [
      {
        reason: 'pending_attribution',
        severity: 'high',
        entryId: ENTRY_ID,
        sourceDisplayNo: 'ORD-20261101-0001',
        detail: '该笔流水没有明确的业绩归属，不能计入任何人的业绩',
      },
      {
        reason: 'empty_period',
        severity: 'low',
        entryId: null,
        sourceDisplayNo: null,
        detail: '该期间没有任何流水，锁定前请确认不是漏记',
      },
    ],
    summary: { total: 2, low: 1, medium: 0, high: 1 },
    lateRecordedCount: 1,
    lateRecordedTotalCents: 3980,
    asOf: '2026-11-08T04:00:00.000Z',
    unbatchedCount: 2,
    unbatchedTotalCents: 8000,
    openAnomalies: [anomaly()],
    ...overrides,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The real CSV response: `text/csv` + the `X-Ledger-*` counters. */
function csv(body = '\uFEFFentry_id,fact_kind\r\nE1,order_registered\r\n'): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="ledger-${BATCH_NO}-202611081130.csv"`,
      'x-ledger-row-count': '2',
      'x-ledger-late-recorded-count': '1',
      'x-ledger-late-recorded-total-cents': '3980',
      'cache-control': 'no-store',
    },
  })
}

interface FetchCall {
  url: string
  init?: RequestInit
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

/** Ordered prefix stub; an unlisted URL throws so a stray request cannot pass. */
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

function renderPage(session: AuthenticatedSession) {
  const router = createMemoryRouter([{ path: '/reconciliation', element: <ReconciliationPage /> }], {
    initialEntries: ['/reconciliation'],
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

function callsTo(calls: FetchCall[], prefix: string): FetchCall[] {
  return calls.filter((call) => call.url.startsWith(prefix))
}

function headerOf(call: FetchCall | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>
}

/**
 * The default happy-path API: a batch list with one open and one locked batch,
 * a diff, one frozen member and a CSV export.
 */
function stubBaseline(
  overrides: {
    batches?: ReconciliationBatch[]
    diffBody?: ReconciliationDiff
  } = {},
): ReadonlyArray<readonly [string, Handler]> {
  const batches = overrides.batches ?? [openBatch(), lockedBatch()]
  return [
    [
      `/api/admin/reconciliation/batches/${BATCH_ID}/entries`,
      () => json({ batchId: BATCH_ID, items: [entry()], total: 1, page: 1, pageSize: 20, asOf: '2026-11-08T04:00:00.000Z' }),
    ],
    [
      `/api/admin/reconciliation/batches/${BATCH_ID}/lock`,
      () => json(lockedBatch({ batchId: BATCH_ID, batchNo: BATCH_NO })),
    ],
    [
      '/api/admin/reconciliation/diff?',
      () => json(overrides.diffBody ?? diff()),
    ],
    ['/api/admin/reconciliation/export.csv', () => csv()],
    [
      '/api/admin/reconciliation/batches',
      (_url, init) =>
        init?.method === 'POST'
          ? json(openBatch({ batchNo: 'RCN-20261101-0009' }), 201)
          : json({ items: batches, asOf: '2026-11-08T04:00:00.000Z' }),
    ],
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

describe('SettlementsPage permission boundary', () => {
  it('renders the grid-worker lockout and issues zero reconciliation requests', async () => {
    const calls = stubApi([
      [
        '/api/',
        (url) => {
          throw new Error(`grid worker must not call the reconciliation API: ${url}`)
        },
      ],
    ])

    renderPage(GRID_SESSION)

    expect(await screen.findByText('网格员没有经营对账权限')).toBeTruthy()
    expect(screen.getByText(/服务端同样返回 403/)).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('surfaces the real 403 instead of an empty batch list', async () => {
    stubApi([
      [
        '/api/admin/reconciliation/batches',
        () =>
          json({ error: { code: 'forbidden', message: '网格员无权访问对账管理接口' } }, 403),
      ],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('没有对账权限')).toBeTruthy()
    expect(screen.getByText(/网格员无权访问对账管理接口/)).toBeTruthy()
  })

  it('names an expired session instead of showing an empty batch list', async () => {
    stubApi([
      [
        '/api/admin/reconciliation/batches',
        () => json({ error: { code: 'unauthorized', message: '请先登录管理后台' } }, 401),
      ],
    ])

    renderPage(ADMIN_SESSION)

    // A 401 means "log in again", not "there are no batches" and not "no right".
    expect(await screen.findByText('登录状态已失效')).toBeTruthy()
    expect(screen.queryByText('还没有对账批次')).toBeNull()
    expect(screen.queryByText('没有对账权限')).toBeNull()
  })

  it('shows a server fault as a fault, never as an empty ledger', async () => {
    stubApi([
      [
        '/api/admin/reconciliation/batches',
        () => json({ error: { code: 'internal_error', message: '数据库暂时不可用' } }, 500),
      ],
    ])

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('对账批次加载失败')).toBeTruthy()
    expect(screen.getByText(/数据库暂时不可用/)).toBeTruthy()
    // 「还没有对账批次」 would be a lie: nobody could read the list at all.
    expect(screen.queryByText('还没有对账批次')).toBeNull()
  })
})

describe('SettlementsPage batch list', () => {
  it('lists the real batches with their period, frozen totals and lock state', async () => {
    stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText(BATCH_NO)).toBeTruthy()
    expect(screen.getByText(LOCKED_BATCH_NO)).toBeTruthy()
    expect(screen.getByText('开放中 · 可继续核对')).toBeTruthy()
    expect(screen.getByText('已锁定 · 金额与归属冻结')).toBeTruthy()
    expect(screen.getByText('2026-11-01 ~ 2026-11-07')).toBeTruthy()
    expect(screen.getByText('¥79.60 账面毛额')).toBeTruthy()
    // A locked batch shows when it was frozen and says it cannot be undone.
    expect(screen.getByText('已冻结，不可回退')).toBeTruthy()
    // Only the open batch offers the one-way action.
    expect(screen.getAllByRole('button', { name: '锁定' })).toHaveLength(1)
    // 「结算」 is never claimed: no rule exists, so no batch is 已结算.
    expect(document.body.textContent).not.toMatch(/支付成功|已成交|已开通|已结算|佣金应付/)
  })

  it('renders the empty state and explains what an unbatched period means', async () => {
    stubApi(stubBaseline({ batches: [] }))

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('还没有对账批次')).toBeTruthy()
    expect(screen.getByText(/期间内的流水\s*处于「未纳入」状态/)).toBeTruthy()
    // The empty state must not claim a zero statement.
    expect(screen.queryByText('¥0.00 账面毛额')).toBeNull()
  })

  it('states the reconciliation 口径 and never adds the two diff columns', async () => {
    stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)

    const note = screen.getByRole('note', { name: '对账口径说明' })
    expect(within(note).getByText(/含首尾\s*两天/)).toBeTruthy()
    expect(within(note).getByText(/绝不相加/)).toBeTruthy()
    expect(within(note).getByText(/UTF-8 BOM \+ CRLF/)).toBeTruthy()
  })
})

describe('SettlementsPage create batch', () => {
  it('posts the period with the CSRF token and reports the open batch', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)

    fireEvent.click(screen.getByRole('button', { name: '新建对账批次' }))
    fireEvent.change(await screen.findByLabelText('期间开始（含）'), {
      target: { value: '2026-11-01' },
    })
    fireEvent.change(screen.getByLabelText('期间结束（含）'), {
      target: { value: '2026-11-07' },
    })
    fireEvent.change(screen.getByLabelText('备注（可选）'), {
      target: { value: '十一月第一周对账' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建开放批次' }))

    await waitFor(() =>
      expect(
        calls.filter((call) => call.url.endsWith('/api/admin/reconciliation/batches') && call.init?.method === 'POST'),
      ).toHaveLength(1),
    )
    const create = calls.find(
      (call) => call.url.endsWith('/api/admin/reconciliation/batches') && call.init?.method === 'POST',
    )
    expect(headerOf(create)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(headerOf(create)['content-type']).toBe('application/json')
    // No total / entryCount / community: the server derives them, so a client
    // cannot pre-seed a statement.
    expect(JSON.parse(String(create?.init?.body))).toEqual({
      periodFrom: '2026-11-01',
      periodTo: '2026-11-07',
      note: '十一月第一周对账',
    })
    expect(await screen.findByText(/已创建开放批次/)).toBeTruthy()
    // The list is re-fetched so the new batch is visible, not just announced.
    expect(callsTo(calls, '/api/admin/reconciliation/batches').length).toBeGreaterThanOrEqual(2)
  })

  it('refuses an inverted period locally instead of asking the server', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)

    fireEvent.click(screen.getByRole('button', { name: '新建对账批次' }))
    fireEvent.change(await screen.findByLabelText('期间开始（含）'), {
      target: { value: '2026-11-07' },
    })
    fireEvent.change(screen.getByLabelText('期间结束（含）'), {
      target: { value: '2026-11-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建开放批次' }))

    expect(await screen.findByText('结束日期不能早于开始日期。')).toBeTruthy()
    // A locally detectable error must not become a server round trip.
    expect(
      calls.filter((call) => call.init?.method === 'POST'),
    ).toHaveLength(0)
  })

  it('shows a 409 as a conflict and refreshes the stale list', async () => {
    const calls = stubApi([
      [
        '/api/admin/reconciliation/batches',
        (_url, init) =>
          init?.method === 'POST'
            ? json({ error: { code: 'conflict', message: '该期间已存在开放批次' } }, 409)
            : json({ items: [openBatch()], asOf: '2026-11-08T04:00:00.000Z' }),
      ],
    ])

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)
    const listCallsBefore = callsTo(calls, '/api/admin/reconciliation/batches').filter(
      (call) => call.init?.method !== 'POST',
    ).length

    fireEvent.click(screen.getByRole('button', { name: '新建对账批次' }))
    fireEvent.change(await screen.findByLabelText('期间开始（含）'), {
      target: { value: '2026-11-01' },
    })
    fireEvent.change(screen.getByLabelText('期间结束（含）'), {
      target: { value: '2026-11-07' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建开放批次' }))

    expect(await screen.findByText(/该期间已存在开放批次/)).toBeTruthy()
    // The modal stays open with the error so the operator can change the period.
    expect(screen.getByRole('button', { name: '创建开放批次' })).toBeTruthy()
    await waitFor(() =>
      expect(
        callsTo(calls, '/api/admin/reconciliation/batches').filter(
          (call) => call.init?.method !== 'POST',
        ).length,
      ).toBeGreaterThan(listCallsBefore),
    )
  })
})

describe('SettlementsPage locking', () => {
  it('asks for confirmation, then locks with the displayed updatedAt as the token', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)

    fireEvent.click(screen.getByRole('button', { name: '锁定' }))
    // 二次确认: the destructive, irreversible step is never one click. The title
    // and the confirm body both render it, hence `findAllByText`.
    expect((await screen.findAllByText('锁定对账批次 RCN-20261101-0001？')).length).toBeGreaterThan(0)
    expect(screen.getByText(/锁定不可回退，也不产生任何应付金额/)).toBeTruthy()
    expect(callsTo(calls, '/api/admin/reconciliation/batches/').length).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: '确认锁定' }))

    await waitFor(() =>
      expect(callsTo(calls, `/api/admin/reconciliation/batches/${BATCH_ID}/lock`)).toHaveLength(1),
    )
    const lock = callsTo(calls, `/api/admin/reconciliation/batches/${BATCH_ID}/lock`)[0]
    expect(lock?.init?.method).toBe('POST')
    expect(headerOf(lock)['x-csrf-token']).toBe(CSRF_TOKEN)
    // The optimistic-concurrency token is what the operator actually saw.
    expect(JSON.parse(String(lock?.init?.body))).toEqual({
      expectedUpdatedAt: '2026-11-08T01:00:00.000Z',
    })
    // The success message repeats the server's lock stamp, so the operator knows
    // *when* the statement froze — not merely that a button worked.
    expect(
      await screen.findByText(/批次 RCN-20261101-0001 已锁定（2026-11-01 10:30）/),
    ).toBeTruthy()
    expect(screen.getByText(/该期间合计已冻结/)).toBeTruthy()
  })

  it('reports a stale token as 数据已被更新 and refreshes instead of retrying', async () => {
    const calls = stubApi([
      [
        `/api/admin/reconciliation/batches/${BATCH_ID}/lock`,
        () => json({ error: { code: 'conflict', message: '批次已被其他人更新' } }, 409),
      ],
      [
        '/api/admin/reconciliation/batches',
        () => json({ items: [openBatch()], asOf: '2026-11-08T04:00:00.000Z' }),
      ],
    ])

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)
    const listBefore = callsTo(calls, '/api/admin/reconciliation/batches').length

    fireEvent.click(screen.getByRole('button', { name: '锁定' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认锁定' }))

    expect(await screen.findByText(/数据已被更新，已刷新批次列表/)).toBeTruthy()
    await waitFor(() =>
      expect(callsTo(calls, '/api/admin/reconciliation/batches').length).toBeGreaterThan(
        listBefore,
      ),
    )
    // Exactly one lock attempt: a 409 is a refusal, not an invitation to retry.
    expect(callsTo(calls, `/api/admin/reconciliation/batches/${BATCH_ID}/lock`)).toHaveLength(1)
  })

  it('distinguishes an already-locked batch from a stale view', async () => {
    stubApi([
      [
        `/api/admin/reconciliation/batches/${BATCH_ID}/lock`,
        () => json({ error: { code: 'ledger_batch_locked', message: '该批次已锁定' } }, 409),
      ],
      [
        '/api/admin/reconciliation/batches',
        // The screen still shows the row as `open` — that is exactly the case the
        // two distinct 409 codes exist for: the refusal must name the real reason.
        () => json({ items: [openBatch()], asOf: '2026-11-08T04:00:00.000Z' }),
      ],
    ])

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)

    fireEvent.click(screen.getByRole('button', { name: '锁定' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认锁定' }))

    expect(await screen.findByText(/该批次或期间已锁定/)).toBeTruthy()
    expect(screen.queryByText(/数据已被更新，已刷新批次列表/)).toBeNull()
  })

  it('freezes the period without implying a payment, transfer or write-off', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)

    fireEvent.click(screen.getByRole('button', { name: '锁定' }))
    const dialog = await screen.findByRole('dialog')
    const copy = dialog.textContent ?? ''

    // 锁定 is a book-freeze, and the copy says exactly that…
    expect(copy).toMatch(/锁定不可回退，也不产生任何应付金额/)
    expect(copy).toMatch(/账面登记毛额/)
    expect(copy).toMatch(/冻结账目/)
    // …and never claims money moved, was paid out, or was written off.
    expect(copy).not.toMatch(/转账|已付款|已支付|付款成功|打款|已结清|已核销|结算完成|已结算/)
    // No currency other than the batch's own registered gross is invented here.
    expect(copy).not.toContain('¥0.00')
    expect(callsTo(calls, '/api/admin/reconciliation/batches/')).toHaveLength(0)
    // Cancel is a real, separate act; the irreversible POST has not happened.
    expect(screen.getByRole('button', { name: /取\s*消/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认锁定' })).toBeTruthy()
  })
})

describe('SettlementsPage diff', () => {
  it('shows 未纳入 and 锁后补录 side by side without adding them up', async () => {
    stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)

    fireEvent.click(screen.getAllByRole('button', { name: '查看差异' })[0]!)

    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('未纳入（待办）')).toBeTruthy()
    expect(within(drawer).getByText('锁后补录（既成事实）')).toBeTruthy()

    // The two server numbers, each in its own block.
    const unbatched = document.querySelector('.ledger-diff-block[data-tone="todo"]')!
    expect(within(unbatched as HTMLElement).getByText('2')).toBeTruthy()
    expect(within(unbatched as HTMLElement).getByText('¥80.00')).toBeTruthy()
    const late = document.querySelector('.ledger-diff-block[data-tone="fact"]')!
    expect(within(late as HTMLElement).getByText('1')).toBeTruthy()
    expect(within(late as HTMLElement).getByText('¥39.80')).toBeTruthy()

    // Their sum — 3 笔 / ¥119.80 — is meaningless and must not be rendered.
    expect(drawer.textContent).not.toContain('¥119.80')
    expect(within(drawer).getByText(/服务端聚合，非前端求和/)).toBeTruthy()
    expect(within(drawer).getByText(/两列/)).toBeTruthy()
  })

  it('lists the diff conclusions by severity and the unresolved anomalies', async () => {
    stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)
    fireEvent.click(screen.getAllByRole('button', { name: '查看差异' })[0]!)

    const drawer = await screen.findByRole('dialog')
    const findings = await within(drawer).findByLabelText('差异结论清单')
    expect(within(findings).getByText(/差异结论清单（2 条：高 1 · 中 0 · 低 1）/)).toBeTruthy()
    expect(within(findings).getByText('待归属')).toBeTruthy()
    expect(within(findings).getByText('空期间')).toBeTruthy()

    const anomalies = within(drawer).getByLabelText('未解决异常')
    expect(within(anomalies).getByText('未解决异常（1 条）')).toBeTruthy()
    expect(within(anomalies).getByText('金额不一致')).toBeTruthy()
    expect(within(anomalies).getByText('登记金额与收据金额不一致，待人工核对')).toBeTruthy()
  })

  it('reports stored vs computed totals so drift is visible, not implied', async () => {
    stubApi(
      stubBaseline({
        diffBody: diff({
          stored: { entryCount: 2, totalCents: 7960 },
          computed: { entryCount: 3, totalCents: 11940 },
        }),
      }),
    )

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)
    fireEvent.click(screen.getAllByRole('button', { name: '查看差异' })[0]!)

    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('批次行冻结')).toBeTruthy()
    expect(within(drawer).getByText('2 笔 / ¥79.60')).toBeTruthy()
    expect(within(drawer).getByText('3 笔 / ¥119.40')).toBeTruthy()
    expect(within(drawer).getByText('合计漂移')).toBeTruthy()
  })

  it('pages the frozen members on the server and says they are only the frozen ones', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)
    fireEvent.click(screen.getAllByRole('button', { name: '查看差异' })[0]!)

    await waitFor(() =>
      expect(callsTo(calls, `/api/admin/reconciliation/batches/${BATCH_ID}/entries`)).toHaveLength(1),
    )
    const entriesCall = callsTo(calls, `/api/admin/reconciliation/batches/${BATCH_ID}/entries`)[0]!
    expect(entriesCall.init?.method).toBe('GET')
    expect(entriesCall.url).toContain('page=1')
    expect(entriesCall.url).toContain('pageSize=20')
    // The diff is asked for by batch only — an ad-hoc period would be a different
    // question and the page must not muddle the two.
    const diffCall = callsTo(calls, '/api/admin/reconciliation/diff?')[0]!
    expect(diffCall.url).toBe(`/api/admin/reconciliation/diff?batchId=${BATCH_ID}`)

    const drawer = await screen.findByRole('dialog')
    expect(await within(drawer).findByText('批次冻结成员')).toBeTruthy()
    expect(within(drawer).getByText(/只含已冻结成员；锁后补录请看上方差异/)).toBeTruthy()
    // The source number also appears in the diff findings, so scope the assertion
    // to the members section — the frozen statement is the thing being checked.
    const members = within(drawer).getByLabelText('批次冻结成员')
    expect(await within(members).findByText('ORD-20261101-0001')).toBeTruthy()
    expect(within(members).getByText('¥39.80')).toBeTruthy()
  })
})

describe('SettlementsPage CSV export', () => {
  it('downloads one batch through the CSV channel, not the JSON helper', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)

    fireEvent.click(screen.getAllByRole('button', { name: '导出 CSV' })[0]!)

    await waitFor(() => expect(callsTo(calls, '/api/admin/reconciliation/export.csv')).toHaveLength(1))
    const exportCall = callsTo(calls, '/api/admin/reconciliation/export.csv')[0]!
    expect(exportCall.url).toBe(
      `/api/admin/reconciliation/export.csv?batchId=${BATCH_ID}`,
    )
    // `accept: text/csv` is what makes this the download channel rather than
    // `requestLocalJson`, whose `accept: application/json` would 406 or fail to parse.
    expect(headerOf(exportCall).accept).toBe('text/csv')
    expect(exportCall.init?.credentials).toBe('include')

    // The success message names the file and admits the late facts it cannot hold.
    expect(await screen.findByText(/已下载 ledger-RCN-20261101-0001-202611081130\.csv/)).toBeTruthy()
    expect(screen.getByText(/另有 1 笔锁后补录（¥39\.80）不在文件内/)).toBeTruthy()
  })

  it('confirms, then exports the whole ledger when no batch is selected', async () => {
    const calls = stubApi(stubBaseline())

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)

    fireEvent.click(screen.getByRole('button', { name: '导出全部 CSV' }))
    expect((await screen.findAllByText('导出全部对账流水？')).length).toBeGreaterThan(0)
    expect(screen.getByText(/不含任何应付、分账或打款金额/)).toBeTruthy()
    expect(callsTo(calls, '/api/admin/reconciliation/export.csv')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '确认导出' }))

    await waitFor(() => expect(callsTo(calls, '/api/admin/reconciliation/export.csv')).toHaveLength(1))
    // No parameters at all is the documented full export, not a silent no-op.
    expect(callsTo(calls, '/api/admin/reconciliation/export.csv')[0]!.url).toBe(
      '/api/admin/reconciliation/export.csv',
    )
  })

  it('turns a JSON error envelope into a real error instead of saving it as a file', async () => {
    stubApi([
      [
        '/api/admin/reconciliation/export.csv',
        () =>
          json(
            { error: { code: 'invalid_request', message: '导出记录超过 5000 行上限，请按批次导出' } },
            400,
          ),
      ],
      [
        '/api/admin/reconciliation/batches',
        () => json({ items: [openBatch()], asOf: '2026-11-08T04:00:00.000Z' }),
      ],
    ])

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)

    fireEvent.click(screen.getAllByRole('button', { name: '导出 CSV' })[0]!)

    expect(
      await screen.findByText(/请求不合法：导出记录超过 5000 行上限，请按批次导出/),
    ).toBeTruthy()
    expect(screen.queryByText(/已下载/)).toBeNull()
  })

  it('reports a rejected export with its HTTP status when the body is not our envelope', async () => {
    stubApi([
      [
        '/api/admin/reconciliation/export.csv',
        () => new Response('<html>Bad Gateway</html>', { status: 502 }),
      ],
      [
        '/api/admin/reconciliation/batches',
        () => json({ items: [openBatch()], asOf: '2026-11-08T04:00:00.000Z' }),
      ],
    ])

    renderPage(ADMIN_SESSION)
    await screen.findByText(BATCH_NO)

    fireEvent.click(screen.getAllByRole('button', { name: '导出 CSV' })[0]!)

    // An HTML error page must never be offered as `something.csv`.
    expect(await screen.findByText(/导出失败（HTTP 502）/)).toBeTruthy()
  })
})
