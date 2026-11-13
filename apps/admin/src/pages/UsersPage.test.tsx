// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type { UserDirectoryDetail, UserDirectoryEntry } from '@sanchuang-dev/local-life-contracts'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { UsersPage } from './UsersPage'

/**
 * LL-USER-002: the independent /users directory is driven entirely by the
 * shared #153 contract. Every test stubs fetch with an explicit URL table;
 * unexpected URLs throw, so local full-list filtering, fake accounts or a
 * client-side page cache would fail loudly.
 */

const USER_A = '123e4567-e89b-42d3-a456-426614174010'
const USER_B = '123e4567-e89b-42d3-a456-426614174011'
const LEGACY_USER = '123e4567-e89b-42d3-a456-426614174012'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740b2', name: '阳光社区' }
const CSRF_TOKEN = 'csrf-token-for-users-page-tests'

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_A, displayName: '测试管理员' },
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

/** Stubs `fetch` with an explicit URL table; unknown URLs throw immediately. */
function stubApi(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

function renderPage(session: AuthenticatedSession) {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <UsersPage session={session} />
      </AntdApp>
    </ConfigProvider>,
  )
}

function listCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.url.startsWith('/api/admin/users?'))
}

function paramsOf(call: FetchCall): URLSearchParams {
  return new URL(call.url, 'http://test.local').searchParams
}

function entry(overrides: Partial<UserDirectoryEntry> = {}): UserDirectoryEntry {
  return {
    id: USER_A,
    displayName: '微信花花',
    localDisplayName: '本地花花',
    wechatNickname: '微信花花',
    wechatAvatarUrl: null,
    wechatProfileAuthorizedAt: '2026-10-06T00:00:00.000Z',
    identityMethods: ['wechat'],
    staffRole: null,
    // #171: the default fixture is a resident who confirmed COMMUNITY_A themself.
    confirmedCommunity: {
      id: COMMUNITY_A.id,
      name: COMMUNITY_A.name,
      confirmedAt: '2026-10-08T00:00:00.000Z',
      source: 'resident_h5_confirmed',
    },
    communityRelationSource: 'confirmed_binding',
    residentCommunityState: 'confirmed',
    residentCommunities: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * #171: an account that only carries historical relations — the rows the retired
 * #123 login wrote automatically. It is NOT a confirmed permanent community and
 * the page must never present it as one.
 */
function historicalEntry(overrides: Partial<UserDirectoryEntry> = {}): UserDirectoryEntry {
  return entry({
    id: LEGACY_USER,
    displayName: '历史归属账号',
    localDisplayName: '历史归属账号',
    confirmedCommunity: null,
    communityRelationSource: 'historical_assignment',
    residentCommunityState: 'unbound',
    residentCommunities: [
      { id: COMMUNITY_A.id, name: COMMUNITY_A.name, joinedAt: '2026-10-05T00:00:00.000Z' },
    ],
    ...overrides,
  })
}

/** #171: an account with no binding and no historical relation at all. */
function unboundEntry(overrides: Partial<UserDirectoryEntry> = {}): UserDirectoryEntry {
  return entry({
    id: USER_B,
    displayName: '未命名用户',
    localDisplayName: null,
    wechatNickname: null,
    wechatAvatarUrl: 'https://example.test/avatar-b.jpg',
    wechatProfileAuthorizedAt: '2026-10-06T00:00:00.000Z',
    identityMethods: ['phone'],
    staffRole: null,
    confirmedCommunity: null,
    communityRelationSource: 'none',
    residentCommunityState: 'unbound',
    residentCommunities: [],
    ...overrides,
  })
}

function detail(overrides: Partial<UserDirectoryDetail> = {}): UserDirectoryDetail {
  return {
    ...entry({
      id: USER_B,
      displayName: '王小网',
      localDisplayName: '王小网',
      wechatNickname: '微信王小网',
      identityMethods: ['wechat', 'phone', 'staff'],
      staffRole: 'grid_worker',
      // #171: two historical relations, no confirmation — the exact shape the
      // back office must show as 历史归属 rather than 常驻社区.
      confirmedCommunity: null,
      communityRelationSource: 'historical_assignment',
      residentCommunityState: 'pending_review',
      residentCommunities: [
        { id: COMMUNITY_A.id, name: COMMUNITY_A.name, joinedAt: '2026-10-05T00:00:00.000Z' },
        { id: COMMUNITY_B.id, name: COMMUNITY_B.name, joinedAt: '2026-10-07T00:00:00.000Z' },
      ],
    }),
    wechatLinkedIdentityCount: 1,
    wechatLinkedUnionId: true,
    wechatProfile: {
      sex: 'female',
      country: '中国',
      province: '浙江省',
      city: '杭州市',
      updatedAt: '2026-10-09T08:30:00.000Z',
    },
    maskedPhone: '138****8000',
    contact: {
      visibility: 'full',
      phone: '13800138000',
      address: '杭州市西湖区文三路 100 号 3 幢 501 室',
    },
    staffAccount: {
      username: 'grid.b',
      status: 'active',
      communities: [{ id: COMMUNITY_A.id, name: COMMUNITY_A.name }],
    },
    ...overrides,
  }
}

/**
 * Legacy/dev-login account with no persistent identity row at all. The final
 * #153 contract (b6b507d) explicitly allows `identityMethods: []` for this case;
 * the page must list and open it instead of failing response validation.
 */
function legacyEntry(overrides: Partial<UserDirectoryEntry> = {}): UserDirectoryEntry {
  return entry({
    id: LEGACY_USER,
    displayName: '历史开发账号',
    localDisplayName: '历史开发账号',
    wechatNickname: null,
    wechatAvatarUrl: null,
    wechatProfileAuthorizedAt: null,
    identityMethods: [],
    staffRole: null,
    confirmedCommunity: null,
    communityRelationSource: 'none',
    residentCommunityState: 'unbound',
    residentCommunities: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  })
}

function legacyDetail(): UserDirectoryDetail {
  return {
    ...legacyEntry(),
    wechatLinkedIdentityCount: 0,
    wechatLinkedUnionId: false,
    wechatProfile: null,
    maskedPhone: null,
    contact: { visibility: 'full', phone: null, address: null },
    staffAccount: null,
  }
}

/** Answer for `/api/admin/communities`, shared by every scenario. */
function communityResponse() {
  return json({ items: [COMMUNITY_A, COMMUNITY_B] })
}

function visibleDropdowns(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.ant-select-dropdown:not(.ant-select-dropdown-hidden)'),
  )
}

async function chooseOption(combobox: HTMLElement, label: string) {
  fireEvent.mouseDown(combobox)
  await waitFor(() => expect(visibleDropdowns().length).toBeGreaterThan(0))
  const dropdowns = visibleDropdowns()
  const target = dropdowns[dropdowns.length - 1]
  fireEvent.click(within(target).getByText(label))
}

/**
 * DataPanel force-renders its advanced-filter modal, so each filter label and
 * placeholder appears twice. The quick row is always the first instance.
 */
function firstLabel(text: string): HTMLElement {
  const elements = screen.getAllByLabelText(text)
  expect(elements.length).toBeGreaterThan(0)
  return elements[0] as HTMLElement
}

function firstPlaceholder(text: string): HTMLElement {
  const elements = screen.getAllByPlaceholderText(text)
  expect(elements.length).toBeGreaterThan(0)
  return elements[0] as HTMLElement
}

function drawerBody(): HTMLElement {
  const body = document.querySelector<HTMLElement>('.ant-drawer-open .ant-drawer-body')
  if (!body) throw new Error('no open drawer body')
  return body
}

function openDrawers(): number {
  return document.querySelectorAll('.ant-drawer-open').length
}

function tableRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.ant-table-tbody tr.ant-table-row'))
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 1200,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UsersPage real directory read', () => {
  it('loads the default all-users page from the server with the real total, avatar fallback and unassigned state', async () => {
    const calls = stubApi((url) => {
      if (url === '/api/admin/communities') return communityResponse()
      if (url.startsWith('/api/admin/users?')) {
        const params = new URL(url, 'http://test.local').searchParams
        const page = Number(params.get('page'))
        const pageSize = Number(params.get('pageSize'))
        return json({
          items: [entry(), unboundEntry()],
          total: 43,
          page,
          pageSize,
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)

    expect(await screen.findByRole('heading', { name: '用户管理' })).toBeTruthy()
    expect(await screen.findByText('微信花花')).toBeTruthy()
    expect(screen.getByText('本地：本地花花')).toBeTruthy()
    expect(screen.getByText('未命名用户')).toBeTruthy()
    // The server page/total is displayed, never a locally paginated copy.
    expect(screen.getByText('共 43 条')).toBeTruthy()
    expect(listCalls(calls)).toHaveLength(1)
    expect(paramsOf(listCalls(calls)[0]!).get('page')).toBe('1')
    expect(paramsOf(listCalls(calls)[0]!).get('pageSize')).toBe('20')
    // Only an available WeChat avatar is rendered; the plain account falls back
    // to a letter avatar and the empty resident list is explicit.
    expect(screen.getByAltText('未命名用户')).toBeTruthy()
    expect(screen.getByText('未关联社区')).toBeTruthy()
    // The unique platform UUID is visible for identification/copy.
    expect(screen.getByText(USER_B)).toBeTruthy()
  })

  it('searches and filters only through the server contract and resets the page to 1', async () => {
    const calls = stubApi((url) => {
      if (url === '/api/admin/communities') return communityResponse()
      if (!url.startsWith('/api/admin/users?')) throw new Error(`unexpected fetch: ${url}`)
      const params = new URL(url, 'http://test.local').searchParams
      return json({
        items: [entry()],
        total: 43,
        page: Number(params.get('page')),
        pageSize: Number(params.get('pageSize')),
      })
    })

    renderPage(ADMIN_SESSION)
    await screen.findByText('微信花花')
    await waitFor(() => expect(listCalls(calls)).toHaveLength(1))

    // Server pagination: page 2 is requested, never derived from a full list.
    fireEvent.click(document.querySelector<HTMLButtonElement>('.ant-pagination-next button')!)
    await waitFor(() => expect(paramsOf(listCalls(calls).at(-1)!).get('page')).toBe('2'))

    // Keyword search resets to the first page.
    fireEvent.change(firstPlaceholder('微信昵称 / 本地名称 / 平台 UUID'), {
      target: { value: ' 花花 ' },
    })
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => {
      const params = paramsOf(listCalls(calls).at(-1)!)
      expect(params.get('keyword')).toBe('花花')
      expect(params.get('page')).toBe('1')
    })

    // Role filter is sent as the shared contract enum.
    await chooseOption(firstLabel('角色'), '管理员')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => expect(paramsOf(listCalls(calls).at(-1)!).get('role')).toBe('admin'))

    // Community and unassigned filters are server parameters, not local filters.
    await chooseOption(firstLabel('社区归属'), '阳光社区')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() =>
      expect(paramsOf(listCalls(calls).at(-1)!).get('community')).toBe(COMMUNITY_B.id),
    )

    await chooseOption(firstLabel('社区归属'), '未关联社区')
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() =>
      expect(paramsOf(listCalls(calls).at(-1)!).get('community')).toBe('unassigned'),
    )

    // Reset clears every filter and returns to page 1; nothing is filtered client-side.
    fireEvent.click(screen.getByRole('button', { name: /重\s*置/ }))
    await waitFor(() => {
      const params = paramsOf(listCalls(calls).at(-1)!)
      expect(params.has('keyword')).toBe(false)
      expect(params.has('role')).toBe(false)
      expect(params.has('community')).toBe(false)
      expect(params.get('page')).toBe('1')
    })
  })

  it('does not offer the admin-only unassigned filter to a community-scoped operator', async () => {
    stubApi((url) => {
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A] })
      if (!url.startsWith('/api/admin/users?')) throw new Error(`unexpected fetch: ${url}`)
      const params = new URL(url, 'http://test.local').searchParams
      return json({
        items: [entry()],
        total: 1,
        page: Number(params.get('page')),
        pageSize: Number(params.get('pageSize')),
      })
    })

    renderPage(OPERATOR_SESSION)
    await screen.findByText('微信花花')

    await chooseOption(firstLabel('社区归属'), '幸福社区')
    const dropdown = visibleDropdowns().at(-1)!
    expect(within(dropdown).queryByText('未关联社区')).toBeNull()
    expect(within(dropdown).getByText('幸福社区')).toBeTruthy()
    // The page still relies on the server-scoped list; no client-side redaction.
    expect(screen.getByText('仅权限范围内用户')).toBeTruthy()
  })

  it('shows an honest empty state for an empty page and for no matching filters', async () => {
    let filtered = false
    stubApi((url) => {
      if (url === '/api/admin/communities') return communityResponse()
      if (!url.startsWith('/api/admin/users?')) throw new Error(`unexpected fetch: ${url}`)
      const params = new URL(url, 'http://test.local').searchParams
      filtered = params.has('keyword')
      return json({
        items: [],
        total: 0,
        page: Number(params.get('page')),
        pageSize: Number(params.get('pageSize')),
      })
    })

    renderPage(ADMIN_SESSION)
    // antd's Empty SVG also carries a <title>, so match the description nodes.
    expect((await screen.findAllByText('暂无数据')).length).toBeGreaterThan(0)

    fireEvent.change(firstPlaceholder('微信昵称 / 本地名称 / 平台 UUID'), {
      target: { value: '不存在' },
    })
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => expect(filtered).toBe(true))
    expect(
      (await screen.findAllByText('没有符合筛选条件的记录')).length,
    ).toBeGreaterThan(0)
  })

  it('clears stale rows on a failed page request and retries the same query', async () => {
    let pageTwoFails = true
    const calls = stubApi((url) => {
      if (url === '/api/admin/communities') return communityResponse()
      if (!url.startsWith('/api/admin/users?')) throw new Error(`unexpected fetch: ${url}`)
      const params = new URL(url, 'http://test.local').searchParams
      if (params.get('page') === '2' && pageTwoFails) {
        return json({ error: { code: 'server_error', message: '用户目录接口暂不可用' } }, 503)
      }
      return json({
        items: [entry({ displayName: `第 ${params.get('page')} 页用户` })],
        total: 43,
        page: Number(params.get('page')),
        pageSize: Number(params.get('pageSize')),
      })
    })

    renderPage(ADMIN_SESSION)
    await screen.findByText('第 1 页用户')

    fireEvent.click(document.querySelector<HTMLButtonElement>('.ant-pagination-next button')!)
    expect(await screen.findByText('用户目录接口暂不可用')).toBeTruthy()
    expect(screen.getByText('用户目录加载失败')).toBeTruthy()
    // The previous page's row is not left behind under an error.
    expect(screen.queryByText('第 1 页用户')).toBeNull()

    pageTwoFails = false
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    expect(await screen.findByText('第 2 页用户')).toBeTruthy()
    expect(screen.queryByText('用户目录接口暂不可用')).toBeNull()
    expect(paramsOf(listCalls(calls).at(-1)!).get('page')).toBe('2')
  })
})

describe('UsersPage read-only detail drawer', () => {
  function stubDirectory(onDetail: (userId: string) => Response | Promise<Response>) {
    return stubApi((url) => {
      if (url === '/api/admin/communities') return communityResponse()
      if (url.startsWith('/api/admin/users?')) {
        const params = new URL(url, 'http://test.local').searchParams
        return json({
          items: [entry(), entry({ id: USER_B, displayName: '王小网' })],
          total: 2,
          page: Number(params.get('page')),
          pageSize: Number(params.get('pageSize')),
        })
      }
      if (url.startsWith('/api/admin/users/')) {
        return onDetail(decodeURIComponent(url.slice('/api/admin/users/'.length)))
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  it('loads the selected account detail and separates staff authorization from resident membership', async () => {
    stubDirectory(() => json(detail()))
    renderPage(ADMIN_SESSION)
    await screen.findByText('王小网')

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[1]!)

    expect(await screen.findByText('用户详情 · 王小网')).toBeTruthy()
    const body = drawerBody()
    // #258: an administrator sees the complete verified phone and the
    // resident-entered address, plus the #256 profile summary.
    expect(within(body).getByText('13800138000')).toBeTruthy()
    expect(within(body).getByText('杭州市西湖区文三路 100 号 3 幢 501 室')).toBeTruthy()
    expect(within(body).getByText('女')).toBeTruthy()
    expect(within(body).getByText('浙江省')).toBeTruthy()
    expect(within(body).getByText('已关联 UnionID')).toBeTruthy()
    expect(within(body).getByText('grid.b')).toBeTruthy()
    expect(within(body).getByText('正常')).toBeTruthy()
    expect(within(body).getByText('1 个（仅计数）')).toBeTruthy()
    // #171: two historical relations and no confirmation — the drawer must say so
    // and must never promote either historical row to a permanent community.
    expect(within(body).getByText(/幸福社区 · .*记录/)).toBeTruthy()
    expect(within(body).getByText(/阳光社区 · .*记录/)).toBeTruthy()
    expect(within(body).getByText('历史归属（未确认）')).toBeTruthy()
    expect(within(body).getByText('历史待核查')).toBeTruthy()
    expect(
      within(body).getByText(
        '尚未确认常驻社区；现有记录只是历史归属，不能当作常驻社区。',
      ),
    ).toBeTruthy()
    // Staff authorization is rendered under 后台账户, not as resident belonging.
    expect(within(body).getAllByText('后台账户').length).toBeGreaterThan(0)
    expect(within(body).getByText('居民常驻社区（#171 只读）')).toBeTruthy()
    // Read-only: the drawer has no editable form control and no rebind entry.
    expect(within(body).queryAllByRole('textbox')).toEqual([])
    expect(within(body).queryAllByRole('combobox')).toEqual([])
    expect(
      within(body).getByText(/本页只读，不提供编辑身份、社区归属或后台账户的操作/),
    ).toBeTruthy()
  })

  it('never renders a historical assignment as a confirmed permanent community', async () => {
    stubApi((url) => {
      if (url === '/api/admin/communities') return communityResponse()
      if (url.startsWith('/api/admin/users?')) {
        const params = new URL(url, 'http://test.local').searchParams
        return json({
          items: [historicalEntry()],
          total: 1,
          page: Number(params.get('page')),
          pageSize: Number(params.get('pageSize')),
        })
      }
      if (url === `/api/admin/users/${LEGACY_USER}`) return json(detail())
      throw new Error(`unexpected fetch: ${url}`)
    })
    renderPage(ADMIN_SESSION)
    await screen.findByText('历史归属账号')

    // The list cell keeps the two facts visually and textually apart.
    const row = tableRows()[0]!
    expect(within(row).getByText('历史归属（未确认）')).toBeTruthy()
    expect(within(row).getByText('历史归属：幸福社区')).toBeTruthy()
    expect(within(row).queryByText(/常驻：/)).toBeNull()
    expect(within(row).queryByText(/已确认常驻/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '详情' }))
    expect(await screen.findByText('用户详情 · 王小网')).toBeTruthy()
    const body = drawerBody()
    // Drawer: the confirmation row stays honest — no green 「常驻：<name>」 tag, no
    // confirmation badge, and the absence text names the history explicitly.
    expect(within(body).queryByText(/常驻：/)).toBeNull()
    expect(within(body).queryByText('已确认常驻')).toBeNull()
    expect(within(body).getAllByText('历史归属（未确认）').length).toBeGreaterThan(0)
    expect(within(body).getByText('历史待核查')).toBeTruthy()
    // No interactive control anywhere in the drawer carries a rebind word.
    const rebindWords = ['改绑', '解绑', '重新绑定', '重绑', '切换常驻社区', '转移常驻']
    const controls = Array.from(
      body.querySelectorAll<HTMLElement>('button, a, [role="button"], .ant-tag-close-icon'),
    )
    for (const word of rebindWords) {
      expect(controls.some((control) => control.textContent?.includes(word))).toBe(false)
    }
    expect(body.querySelectorAll('button[type="submit"], form').length).toBe(0)
  })

  it('keeps multiple historical assignments on one user row, all labelled as history', async () => {
    stubApi((url) => {
      if (url === '/api/admin/communities') return communityResponse()
      if (!url.startsWith('/api/admin/users?')) throw new Error(`unexpected fetch: ${url}`)
      const params = new URL(url, 'http://test.local').searchParams
      return json({
        items: [
          historicalEntry({
            residentCommunities: [
              {
                id: COMMUNITY_A.id,
                name: COMMUNITY_A.name,
                joinedAt: '2026-10-05T00:00:00.000Z',
              },
              {
                id: COMMUNITY_B.id,
                name: COMMUNITY_B.name,
                joinedAt: '2026-10-07T00:00:00.000Z',
              },
            ],
          }),
        ],
        total: 1,
        page: Number(params.get('page')),
        pageSize: Number(params.get('pageSize')),
      })
    })

    renderPage(ADMIN_SESSION)
    await screen.findByText('历史归属账号')
    expect(tableRows()).toHaveLength(1)
    const row = tableRows()[0]!
    expect(within(row).getByText('历史归属：幸福社区')).toBeTruthy()
    expect(within(row).getByText('历史归属：阳光社区')).toBeTruthy()
    expect(within(row).queryByText(/常驻：/)).toBeNull()
  })

  it('shows masked contact to a scoped operator without leaking the full number or address', async () => {
    stubDirectory(() =>
      json(detail({
        contact: { visibility: 'masked', phone: null, address: null },
      })),
    )
    renderPage(OPERATOR_SESSION)
    await screen.findByText('王小网')

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[1]!)

    expect(await screen.findByText('用户详情 · 王小网')).toBeTruthy()
    const body = drawerBody()
    expect(within(body).getByText('138****8000')).toBeTruthy()
    expect(within(body).getByText('当前角色仅可见脱敏号码')).toBeTruthy()
    expect(within(body).getByText('当前角色不可查看联系地址')).toBeTruthy()
    // The full smartcard-like values must not exist anywhere in the drawer.
    expect(within(body).queryByText('13800138000')).toBeNull()
    expect(within(body).queryByText('杭州市西湖区文三路 100 号 3 幢 501 室')).toBeNull()
  })

  it('shows explicit 待补充/未填写 states for historic and incomplete profiles', async () => {
    stubDirectory(() =>
      json(detail({
        identityMethods: ['wechat'],
        staffRole: null,
        staffAccount: null,
        wechatNickname: '微信王小网',
        wechatProfileAuthorizedAt: '2026-10-06T00:00:00.000Z',
        wechatProfile: {
          sex: null,
          country: null,
          province: null,
          city: null,
          updatedAt: null,
        },
        wechatLinkedUnionId: false,
        maskedPhone: null,
        contact: { visibility: 'full', phone: null, address: null },
      })),
    )
    renderPage(ADMIN_SESSION)
    await screen.findByText('王小网')

    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[1]!)

    expect(await screen.findByText('用户详情 · 王小网')).toBeTruthy()
    const body = drawerBody()
    // Historic pre-#256 profile: every extra field is explicitly 待补充/未提供.
    expect(within(body).getByText('待补充（历史资料）')).toBeTruthy()
    expect(within(body).getAllByText('未提供').length).toBe(4)
    expect(within(body).getByText('未关联 UnionID')).toBeTruthy()
    // No fabricated phone or address.
    expect(within(body).getByText('未绑定手机号')).toBeTruthy()
    expect(
      within(body).getByText('未填写（居民本人尚未填写联系地址）'),
    ).toBeTruthy()
  })

  it('discards one account before another detail request can show it', async () => {
    let resolveSecond: ((value: Response) => void) | undefined
    stubDirectory((userId) => {
      if (userId === USER_B) {
        return new Promise<Response>((resolve) => {
          resolveSecond = resolve
        })
      }
      return json(
        detail({
          id: USER_A,
          displayName: '第一用户',
          staffAccount: { username: 'first.staff', status: 'active', communities: [] },
        }),
      )
    })

    renderPage(ADMIN_SESSION)
    await screen.findByText('微信花花')
    const detailButtons = screen.getAllByRole('button', { name: '详情' })

    fireEvent.click(detailButtons[0]!)
    expect(await screen.findByText('用户详情 · 第一用户')).toBeTruthy()
    expect(within(drawerBody()).getByText('first.staff')).toBeTruthy()

    // Close and open the second account: the first account must disappear
    // immediately, before the new detail response arrives.
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(openDrawers()).toBe(0))
    fireEvent.click(detailButtons[1]!)
    await waitFor(() => expect(openDrawers()).toBe(1))
    expect(screen.getByText('用户详情')).toBeTruthy()
    expect(screen.queryByText('first.staff')).toBeNull()
    expect(screen.queryByText('第一用户')).toBeNull()

    await waitFor(() => expect(resolveSecond).toBeTruthy())
    resolveSecond?.(json(detail()))
    expect(await screen.findByText('用户详情 · 王小网')).toBeTruthy()
    expect(within(drawerBody()).getByText('grid.b')).toBeTruthy()
  })

  it.each([
    { status: 403, message: '无权查看该用户', expected: '无权查看该用户（HTTP 403）' },
    { status: 404, message: '用户不存在', expected: '用户不存在或已被移除（HTTP 404）' },
  ])(
    'clears every field when detail returns $status and keeps no other account data',
    async ({ status, message, expected }) => {
      stubDirectory(() =>
        json({ error: { code: status === 403 ? 'forbidden' : 'not_found', message } }, status),
      )
      renderPage(ADMIN_SESSION)
      await screen.findByText('王小网')

      fireEvent.click(screen.getAllByRole('button', { name: '详情' })[1]!)

      expect(await screen.findByText(expected, { exact: false })).toBeTruthy()
      expect(screen.getByText('用户详情加载失败')).toBeTruthy()
      // The list still exists behind the drawer, but no detail fields from any
      // account are rendered: the drawer has no stale phone, address or username.
      const body = drawerBody()
      expect(within(body).queryByText('13800138000')).toBeNull()
      expect(within(body).queryByText('138****8000')).toBeNull()
      expect(within(body).queryByText('杭州市西湖区文三路 100 号 3 幢 501 室')).toBeNull()
      expect(within(body).queryByText('grid.b')).toBeNull()
      expect(within(body).queryByText('王小网')).toBeNull()
    },
  )
})

describe('UsersPage legacy account without any persistent identity', () => {
  it('lists an empty identityMethods account through the final contract without failing the page', async () => {
    const calls = stubApi((url) => {
      if (url === '/api/admin/communities') return communityResponse()
      if (!url.startsWith('/api/admin/users?')) throw new Error(`unexpected fetch: ${url}`)
      const params = new URL(url, 'http://test.local').searchParams
      return json({
        items: [legacyEntry()],
        total: 1,
        page: Number(params.get('page')),
        pageSize: Number(params.get('pageSize')),
      })
    })

    renderPage(ADMIN_SESSION)

    // The row survives contract validation and shows an honest explicit state.
    expect(await screen.findByText('历史开发账号')).toBeTruthy()
    expect(screen.getByText('无持久身份')).toBeTruthy()
    expect(screen.getByText('居民')).toBeTruthy()
    expect(screen.getByText('未关联社区')).toBeTruthy()
    expect(screen.queryByText('用户目录加载失败')).toBeNull()
    expect(listCalls(calls)).toHaveLength(1)
  })

  it('opens the read-only detail of the empty identity account without inventing data', async () => {
    stubApi((url) => {
      if (url === '/api/admin/communities') return communityResponse()
      if (url.startsWith('/api/admin/users?')) {
        const params = new URL(url, 'http://test.local').searchParams
        return json({
          items: [legacyEntry()],
          total: 1,
          page: Number(params.get('page')),
          pageSize: Number(params.get('pageSize')),
        })
      }
      if (url === `/api/admin/users/${LEGACY_USER}`) return json(legacyDetail())
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    await screen.findByText('历史开发账号')
    fireEvent.click(screen.getByRole('button', { name: '详情' }))

    expect(await screen.findByText('用户详情 · 历史开发账号')).toBeTruthy()
    const body = drawerBody()
    expect(within(body).getByText('无持久身份')).toBeTruthy()
    expect(within(body).getByText('居民')).toBeTruthy()
    expect(within(body).getByText('未绑定手机号')).toBeTruthy()
    expect(within(body).getByText('未填写（居民本人尚未填写联系地址）')).toBeTruthy()
    expect(within(body).getByText('未关联 UnionID')).toBeTruthy()
    expect(within(body).getByText('0 个（仅计数）')).toBeTruthy()
    expect(within(body).getByText('未授权或未设置')).toBeTruthy()
    // No profile at all: the profile rows report 未授权 instead of a guess.
    expect(within(body).getAllByText('未授权').length).toBeGreaterThan(0)
    expect(within(body).getByText('未关联社区（账号真实存在，可正常登录）')).toBeTruthy()
    expect(
      within(body).getByText('无（该账号只有居民身份，不是后台工作人员）'),
    ).toBeTruthy()
    expect(screen.queryByText('用户详情加载失败')).toBeNull()
  })
})
