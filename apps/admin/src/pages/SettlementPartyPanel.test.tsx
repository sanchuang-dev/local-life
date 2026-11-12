// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type { SettlementParty } from '@sanchuang-dev/local-life-contracts'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { SettlementPartyPanel } from './SettlementPartyPanel'

/**
 * Drives the real 主体目录 panel (#219) against an explicitly stubbed `fetch`.
 *
 * What these tests protect:
 *
 * - the only writes are admin-only and always go through the contracted service
 *   (`POST /api/admin/settlement/parties` with `x-csrf-token`), then the list is
 *   re-read instead of inserting a client-side row;
 * - a `null` `verifiedAt` / `verificationRef` is shown as 未核验 / 未提供 — the
 *   panel never upgrades a party to 已核验 from an evidence reference;
 * - an operator has no write entry and always sends its own `communityId`;
 * - real 401/403/network/409/400 answers are rendered, and none of them turns
 *   into an empty list or a success message;
 * - the required-length rules stop a malformed POST before it leaves the page.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740a2', name: '和悦社区' }
const PARTY_ID = '123e4567-e89b-42d3-a456-426614174501'
const CSRF_TOKEN = 'csrf-token-for-settlement-party-tests'

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_ID, displayName: '测试管理员' },
  staff: { id: STAFF_ID, username: 'testadmin', role: 'admin', communities: [] },
  csrfToken: CSRF_TOKEN,
}

/** An operator must name one of their own communities on every read. */
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
    id: PARTY_ID,
    role: 'seller',
    legalName: '杭州三创生活服务有限公司',
    registryRef: '91330100MA2XXXXXXX',
    verificationRef: null,
    verifiedAt: null,
    createdByUserId: USER_ID,
    createdAt: '2026-11-12T02:00:00.000Z',
    ...overrides,
  }
}

const EMPTY_LIST = { items: [] as SettlementParty[] }

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

function stubApi(route: Handler): FetchCall[] {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return route(String(input), init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

const PARTY_ROUTE = '/api/admin/settlement/parties'

function partyCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.url.startsWith(PARTY_ROUTE))
}

function reads(calls: FetchCall[]): FetchCall[] {
  return partyCalls(calls).filter((call) => call.init?.method !== 'POST')
}

function writes(calls: FetchCall[]): FetchCall[] {
  return partyCalls(calls).filter((call) => call.init?.method === 'POST')
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
          <SettlementPartyPanel />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

/** Opens an antd Select (mouseDown opens it) and clicks the wanted option. */
async function chooseOption(combobox: Element, optionLabel: string) {
  fireEvent.mouseDown(combobox)
  const option = (await screen.findAllByText(optionLabel)).find((element) =>
    element.closest('.ant-select-item-option'),
  )
  expect(option, `option ${optionLabel} must be offered by the select`).toBeTruthy()
  fireEvent.click(option as Element)
}

async function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: '登记主体' }))
  await screen.findByText('登记结算主体')
}

function fillPartyForm(values: { legalName?: string; registryRef?: string }) {
  if (values.legalName !== undefined) {
    fireEvent.change(screen.getByLabelText('法定名称'), { target: { value: values.legalName } })
  }
  if (values.registryRef !== undefined) {
    fireEvent.change(screen.getByLabelText('登记号'), { target: { value: values.registryRef } })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SettlementPartyPanel · 待补齐空态与读取', () => {
  it('shows the 待补齐 empty state, the admin write entry, and reads the contracted endpoint', async () => {
    const calls = stubApi(() => json(EMPTY_LIST))
    renderPanel(ADMIN_SESSION)

    expect(await screen.findByText('尚未登记任何结算主体')).toBeTruthy()
    expect(screen.getByText(/待补齐/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '登记主体' })).toBeTruthy()
    // antd puts a thin space between two-character Chinese button labels.
    expect(screen.getByRole('button', { name: /刷\s*新/ })).toBeTruthy()

    expect(reads(calls)).toHaveLength(1)
    expect(urlOf(reads(calls)[0]!).pathname).toBe(PARTY_ROUTE)
    // 管理员默认「全部社区」：不带 communityId 才是服务端的全部范围查询。
    expect(urlOf(reads(calls)[0]!).searchParams.has('communityId')).toBe(false)

    // No fabricated money or verification claim on the empty screen.
    expect(document.body.textContent).not.toContain('¥')
    expect(screen.queryByText('已核验')).toBeNull()
  })
})

describe('SettlementPartyPanel · 登记', () => {
  it('POSTs with the csrf token and re-reads the list instead of inserting a row', async () => {
    let listReads = 0
    const created = party({ legalName: '杭州三创生活服务有限公司' })
    const calls = stubApi((_url, init) => {
      if (init?.method === 'POST') {
        return json(created, 201)
      }
      listReads += 1
      return json({ items: listReads === 1 ? [] : [created] })
    })
    renderPanel(ADMIN_SESSION)

    await screen.findByText('尚未登记任何结算主体')
    await openDrawer()
    await chooseOption(screen.getByLabelText('主体角色'), '商品销售商户')
    fillPartyForm({ legalName: created.legalName, registryRef: created.registryRef })

    fireEvent.click(screen.getByRole('button', { name: '提交登记' }))

    await waitFor(() => expect(writes(calls)).toHaveLength(1))
    const post = writes(calls)[0]!
    expect(post.init?.method).toBe('POST')
    expect(headersOf(post)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init?.body))).toEqual({
      role: 'seller',
      legalName: created.legalName,
      registryRef: created.registryRef,
      // A blank evidence reference must be submitted as null, not "".
      verificationRef: null,
    })

    expect(await screen.findByText(/已登记结算主体：/)).toBeTruthy()
    await waitFor(() => expect(listReads).toBe(2))
    expect(await screen.findByText(created.legalName)).toBeTruthy()
    expect(urlOf(reads(calls)[1]!).pathname).toBe(PARTY_ROUTE)
  })

  it('keeps the drawer open with the server message on 409 and never claims success', async () => {
    const calls = stubApi((_url, init) => {
      if (init?.method === 'POST') {
        return json(
          { error: { code: 'settlement_party_exists', message: '该主体已登记' } },
          409,
        )
      }
      return json({ items: [party()] })
    })
    renderPanel(ADMIN_SESSION)

    await screen.findByText('杭州三创生活服务有限公司')
    await openDrawer()
    await chooseOption(screen.getByLabelText('主体角色'), '三创主体')
    fillPartyForm({ legalName: '杭州三创生活服务有限公司', registryRef: '91330100MA2YYYYYYY' })

    fireEvent.click(screen.getByRole('button', { name: '提交登记' }))

    expect(await screen.findByText(/数据已被更新：该主体已登记/)).toBeTruthy()
    expect(screen.getByLabelText('法定名称')).toBeTruthy()
    expect(screen.queryByText(/已登记结算主体：/)).toBeNull()
    // Failure is not retried automatically: only the original read happened.
    expect(reads(calls)).toHaveLength(1)
  })

  it('shows the real 400 message without a success state', async () => {
    const calls = stubApi((_url, init) => {
      if (init?.method === 'POST') {
        return json(
          { error: { code: 'invalid_request', message: '法定名称与登记号不匹配' } },
          400,
        )
      }
      return json(EMPTY_LIST)
    })
    renderPanel(ADMIN_SESSION)

    await screen.findByText('尚未登记任何结算主体')
    await openDrawer()
    await chooseOption(screen.getByLabelText('主体角色'), '广电主体')
    fillPartyForm({ legalName: '浙江广电有限公司', registryRef: '91330100MA2ZZZZZZZ' })

    fireEvent.click(screen.getByRole('button', { name: '提交登记' }))

    expect(await screen.findByText(/请求不合法：法定名称与登记号不匹配/)).toBeTruthy()
    expect(screen.queryByText(/已登记结算主体：/)).toBeNull()
    expect(writes(calls)).toHaveLength(1)
  })

  it('does not POST when the contracted required fields are blank', async () => {
    const calls = stubApi(() => json(EMPTY_LIST))
    renderPanel(ADMIN_SESSION)

    await screen.findByText('尚未登记任何结算主体')
    await openDrawer()
    await chooseOption(screen.getByLabelText('主体角色'), '商品销售商户')

    fireEvent.click(screen.getByRole('button', { name: '提交登记' }))

    expect(await screen.findByText('请填写法定名称')).toBeTruthy()
    expect(await screen.findByText('请填写登记号')).toBeTruthy()
    expect(writes(calls)).toHaveLength(0)

    // Filling only one field still keeps the malformed body at home.
    fillPartyForm({ legalName: '杭州三创生活服务有限公司' })
    fireEvent.click(screen.getByRole('button', { name: '提交登记' }))
    expect(await screen.findByText('请填写登记号')).toBeTruthy()
    expect(writes(calls)).toHaveLength(0)
  })
})

describe('SettlementPartyPanel · 服务端值原样展示', () => {
  it('renders 未核验 / 未提供 for null values and never 已核验', async () => {
    stubApi(() => json({ items: [party()] }))
    renderPanel(ADMIN_SESSION)

    expect(await screen.findByText('杭州三创生活服务有限公司')).toBeTruthy()
    expect(screen.getByText('未核验')).toBeTruthy()
    expect(screen.getByText('未提供')).toBeTruthy()
    expect(screen.queryByText('已核验')).toBeNull()
    expect(document.body.textContent).not.toContain('¥')
  })

  it('renders 已核验 only when the server returned verifiedAt', async () => {
    stubApi(() =>
      json({
        items: [
          party({
            verificationRef: '合同 HT-2026-01',
            verifiedAt: '2026-11-12T03:00:00.000Z',
          }),
        ],
      }),
    )
    renderPanel(ADMIN_SESSION)

    expect(await screen.findByText('已核验')).toBeTruthy()
    expect(screen.getByText('合同 HT-2026-01')).toBeTruthy()
    expect(screen.queryByText('未核验')).toBeNull()
  })
})

describe('SettlementPartyPanel · 运营员范围', () => {
  it('has no write entry and always sends an authorized communityId', async () => {
    const calls = stubApi(() => json({ items: [party()] }))
    renderPanel(OPERATOR_SESSION)

    expect(await screen.findByText('杭州三创生活服务有限公司')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登记主体' })).toBeNull()
    expect(screen.queryByText('登记结算主体')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    expect(reads(calls)).toHaveLength(1)
    expect(urlOf(reads(calls)[0]!).searchParams.get('communityId')).toBe(COMMUNITY_A.id)
  })
})

describe('SettlementPartyPanel · 真实错误态', () => {
  it('renders a 403 sentence instead of an empty list', async () => {
    stubApi(() =>
      json({ error: { code: 'forbidden', message: '当前账号无权查看结算主体' } }, 403),
    )
    renderPanel(OPERATOR_SESSION)

    expect((await screen.findAllByText(/没有权限/)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/尚未登记任何结算主体/)).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('renders the 401 login-expired sentence instead of an empty list', async () => {
    stubApi(() =>
      json({ error: { code: 'unauthorized', message: '会话已过期，请重新登录' } }, 401),
    )
    renderPanel(ADMIN_SESSION)

    expect((await screen.findAllByText(/登录状态已失效/)).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '刷新并重新登录' })).toBeTruthy()
    expect(screen.queryByText(/尚未登记任何结算主体/)).toBeNull()
  })

  it('surfaces a network failure with a real retry, never an empty list', async () => {
    stubApi(() => {
      throw new Error('network down')
    })
    renderPanel(ADMIN_SESSION)

    expect(await screen.findByText(/无法连接管理后台 API/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy()
    expect(screen.queryByText(/尚未登记任何结算主体/)).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
