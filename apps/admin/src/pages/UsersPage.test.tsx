// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { UsersPage } from './UsersPage'

/**
 * LL-UI-007 drawer tests drive the real page with an explicitly stubbed fetch.
 * Every test declares exactly which HTTP URLs it answers; anything else throws,
 * so a page that silently fell back to fake data would fail loudly.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740b2', name: '阳光社区' }
const CSRF_TOKEN = 'csrf-token-for-users-page-tests'

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

function postCalls(calls: FetchCall[], path: string): FetchCall[] {
  return calls.filter((call) => call.url === path && call.init?.method === 'POST')
}

function getCalls(calls: FetchCall[], path: string): FetchCall[] {
  return calls.filter((call) => call.url === path && !call.init?.method)
}

function residentCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.url.startsWith('/api/crm/residents?') && !call.init?.method)
}

/** antd Drawer keeps children mounted after close; openness lives on the root class. */
function openDrawers(): number {
  return document.querySelectorAll('.ant-drawer-open').length
}

function visibleDropdowns(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.ant-select-dropdown:not(.ant-select-dropdown-hidden)'),
  )
}

/** Opens an antd Select by pressing its combobox and clicks the wanted option. */
async function chooseOption(combobox: Element, label: string) {
  fireEvent.mouseDown(combobox)
  await waitFor(() => expect(visibleDropdowns().length).toBeGreaterThan(0))
  const dropdowns = visibleDropdowns()
  const target = dropdowns[dropdowns.length - 1]
  fireEvent.click(within(target).getByText(label))
}

/** Baseline GETs every test page load issues against the real endpoints. */
function stubBaseline(options?: {
  communities?: { id: string; name: string }[]
  staffItems?: unknown[]
  residentItems?: unknown[]
}) {
  const communities = options?.communities ?? [COMMUNITY_A]
  return stubApi((url) => {
    if (url === '/api/admin/communities') return json({ items: communities })
    if (url === '/api/admin/staff') return json({ items: options?.staffItems ?? [] })
    if (url.startsWith('/api/crm/residents?')) return json({ items: options?.residentItems ?? [], total: options?.residentItems?.length ?? 0, page: 1, pageSize: 20 })
    throw new Error(`unexpected fetch: ${url}`)
  })
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

describe('UsersPage create entries', () => {
  it('shows data lists with clear create entries and keeps forms out of the main area', async () => {
    stubBaseline()
    renderPage(ADMIN_SESSION)

    expect(await screen.findByRole('button', { name: /新建社区/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /新增账户/ })).toBeTruthy()
    // The lists and the community selector stay in the main area.
    expect(screen.getByText('社区范围')).toBeTruthy()
    expect(screen.getByText('后台账户')).toBeTruthy()
    expect(screen.getByText('社区居民')).toBeTruthy()
    // Forms live inside drawers: nothing of them occupies the page before opening.
    expect(screen.queryByPlaceholderText('例如：幸福社区')).toBeNull()
    expect(screen.queryByPlaceholderText('工作人员姓名')).toBeNull()
    expect(openDrawers()).toBe(0)
  })

  it('never shows create entries or write surfaces to a non-admin operator', async () => {
    const calls = stubBaseline()
    renderPage(OPERATOR_SESSION)

    expect(await screen.findByText('社区居民')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /新建社区/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /新增账户/ })).toBeNull()
    // No admin-only surface is even mounted, so no admin write request can happen.
    expect(document.querySelector('.ant-drawer')).toBeNull()
    expect(screen.queryByPlaceholderText('例如：幸福社区')).toBeNull()
    expect(screen.queryByPlaceholderText('工作人员姓名')).toBeNull()
    expect(getCalls(calls, '/api/admin/staff')).toEqual([])
    expect(postCalls(calls, '/api/admin/communities')).toEqual([])
    expect(postCalls(calls, '/api/admin/staff')).toEqual([])
  })
})

describe('UsersPage create-community drawer', () => {
  it('creates a community through the real API, refreshes only the community list and closes the drawer', async () => {
    let created = false
    const calls = stubApi((url, init) => {
      if (url === '/api/admin/communities' && init?.method === 'POST') {
        created = true
        return json(COMMUNITY_B, 201)
      }
      if (url === '/api/admin/communities') {
        return json({ items: created ? [COMMUNITY_A, COMMUNITY_B] : [COMMUNITY_A] })
      }
      if (url === '/api/admin/staff') return json({ items: [] })
      if (url.startsWith('/api/crm/residents?')) return json({ items: [], total: 0, page: 1, pageSize: 20 })
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    const trigger = await screen.findByRole('button', { name: /新建社区/ })
    await waitFor(() => expect(residentCalls(calls)).toHaveLength(1))
    fireEvent.click(trigger)

    const input = await screen.findByPlaceholderText('例如：幸福社区')
    fireEvent.change(input, { target: { value: '阳光社区' } })
    fireEvent.submit(document.getElementById('ll-ui-007-create-community-form')!)

    await waitFor(() => expect(postCalls(calls, '/api/admin/communities')).toHaveLength(1))
    const call = postCalls(calls, '/api/admin/communities')[0]
    expect(call.init).toBeTruthy()
    expect((call.init!.headers as Record<string, string>)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(call.init?.body))).toEqual({ name: '阳光社区' })

    // Drawer closes and only the community list is genuinely re-read.
    await waitFor(() => expect(openDrawers()).toBe(0))
    await waitFor(() => expect(getCalls(calls, '/api/admin/communities')).toHaveLength(2))
    expect(getCalls(calls, '/api/admin/staff')).toHaveLength(1)
    // The previously selected community (and its resident context) is preserved.
    expect(residentCalls(calls)).toHaveLength(1)
    // Focus returns to the trigger button for keyboard operators.
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('keeps the drawer open with the input intact when the API rejects the create', async () => {
    stubApi((url, init) => {
      if (url === '/api/admin/communities' && init?.method === 'POST') {
        return json({ error: { code: 'conflict', message: '社区名称已存在' } }, 409)
      }
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A] })
      if (url === '/api/admin/staff') return json({ items: [] })
      if (url.startsWith('/api/crm/residents?')) return json({ items: [], total: 0, page: 1, pageSize: 20 })
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    const input = (await screen.findByPlaceholderText('例如：幸福社区')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '幸福社区' } })
    fireEvent.submit(document.getElementById('ll-ui-007-create-community-form')!)

    expect(await screen.findByText('社区名称已存在')).toBeTruthy()
    expect(screen.getByText('创建社区失败')).toBeTruthy()
    // Drawer stays open and the typed name survives the failure.
    expect(openDrawers()).toBe(1)
    expect(input.value).toBe('幸福社区')
  })

  it('blocks an invalid submit without issuing any POST', async () => {
    const calls = stubBaseline()
    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    const input = await screen.findByPlaceholderText('例如：幸福社区')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.submit(document.getElementById('ll-ui-007-create-community-form')!)

    expect(await screen.findByText('社区名称长度需为 2-60 个字符')).toBeTruthy()
    expect(postCalls(calls, '/api/admin/communities')).toEqual([])
    expect(openDrawers()).toBe(1)
  })

  it('submits only once even when the operator double-clicks the submit button', async () => {
    const calls = stubApi((url, init) => {
      if (url === '/api/admin/communities' && init?.method === 'POST') {
        return json(COMMUNITY_B, 201)
      }
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A] })
      if (url === '/api/admin/staff') return json({ items: [] })
      if (url.startsWith('/api/crm/residents?')) return json({ items: [], total: 0, page: 1, pageSize: 20 })
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    const input = await screen.findByPlaceholderText('例如：幸福社区')
    fireEvent.change(input, { target: { value: '阳光社区' } })
    const submit = () =>
      fireEvent.click(
        within(document.querySelector('.ant-drawer-footer') as HTMLElement).getByRole('button', {
          name: /创建社区/,
        }),
      )
    submit()
    submit()

    await waitFor(() => expect(postCalls(calls, '/api/admin/communities')).toHaveLength(1))
    // Give any accidental second submit a chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(postCalls(calls, '/api/admin/communities')).toHaveLength(1)
  })

  it('asks before discarding a dirty form and never creates anything on cancel', async () => {
    const calls = stubBaseline()
    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    const input = (await screen.findByPlaceholderText('例如：幸福社区')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '半填写的社区' } })

    fireEvent.click(screen.getByRole('button', { name: '取 消' }))
    await waitFor(() => expect(document.querySelector('.ant-modal-confirm')).toBeTruthy())
    expect(screen.getAllByText('放弃已填写的社区信息？').length).toBeGreaterThan(0)

    // Staying keeps both the drawer and the typed content.
    fireEvent.click(screen.getByRole('button', { name: '继续填写' }))
    await waitFor(() => expect(document.querySelector('.ant-modal-confirm')).toBeNull())
    expect(openDrawers()).toBe(1)
    expect(input.value).toBe('半填写的社区')

    // Discarding closes the drawer, clears the form and issues no create call.
    fireEvent.click(screen.getByRole('button', { name: '取 消' }))
    fireEvent.click(await screen.findByRole('button', { name: '放弃并关闭' }))
    await waitFor(() => expect(openDrawers()).toBe(0))
    expect(postCalls(calls, '/api/admin/communities')).toEqual([])
    // Focus returns to the trigger after the guarded close.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /新建社区/ })))

    // Reopening starts from a clean form, not from the discarded draft.
    fireEvent.click(screen.getByRole('button', { name: /新建社区/ }))
    const reopened = (await screen.findByPlaceholderText('例如：幸福社区')) as HTMLInputElement
    expect(reopened.value).toBe('')
  })

  it('closes a clean form immediately without a confirmation prompt', async () => {
    stubBaseline()
    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    await screen.findByPlaceholderText('例如：幸福社区')

    fireEvent.click(screen.getByRole('button', { name: '取 消' }))
    await waitFor(() => expect(openDrawers()).toBe(0))
    expect(screen.queryByText('放弃已填写的社区信息？')).toBeNull()
  })
})

describe('UsersPage create-staff drawer', () => {
  function stubStaffCreate(onCreated?: (body: Record<string, unknown>) => void) {
    let created = false
    const staffRow = {
      id: '123e4567-e89b-42d3-a456-4266141740c3',
      username: 'grid.b',
      displayName: '王小网',
      role: 'grid_worker',
      status: 'active',
      communities: [COMMUNITY_A],
    }
    const calls = stubApi((url, init) => {
      if (url === '/api/admin/staff' && init?.method === 'POST') {
        created = true
        onCreated?.(JSON.parse(String(init.body)) as Record<string, unknown>)
        return json(staffRow, 201)
      }
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A] })
      if (url === '/api/admin/staff') return json({ items: created ? [staffRow] : [] })
      if (url.startsWith('/api/crm/residents?')) return json({ items: [], total: 0, page: 1, pageSize: 20 })
      throw new Error(`unexpected fetch: ${url}`)
    })
    return calls
  }

  function drawerBody(): HTMLElement {
    const body = document.querySelector<HTMLElement>('.ant-drawer-body')
    if (!body) throw new Error('no open drawer body')
    return body
  }

  async function fillStaffForm(overrides?: { skipRoleAndCommunity?: boolean }) {
    const body = drawerBody()
    fireEvent.change(await within(body).findByPlaceholderText('3-32 位字母、数字、点、下划线或短横线'), {
      target: { value: 'grid.b' },
    })
    fireEvent.change(within(body).getByPlaceholderText('工作人员姓名'), {
      target: { value: '王小网' },
    })
    fireEvent.change(within(body).getByPlaceholderText('至少 12 位，创建后请安全告知本人'), {
      target: { value: 'a-very-long-initial-password' },
    })
    if (overrides?.skipRoleAndCommunity) return
    const comboboxes = within(body).getAllByRole('combobox')
    await chooseOption(comboboxes[0], '网格员')
    await chooseOption(within(drawerBody()).getAllByRole('combobox')[1], '幸福社区')
  }

  it('creates a grid worker with role and community assignment through the real API', async () => {
    let submitted: Record<string, unknown> | undefined
    const calls = stubStaffCreate((body) => {
      submitted = body
    })

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新增账户/ }))
    await fillStaffForm()

    fireEvent.submit(document.getElementById('ll-ui-007-create-staff-form')!)

    await waitFor(() => expect(postCalls(calls, '/api/admin/staff')).toHaveLength(1))
    const call = postCalls(calls, '/api/admin/staff')[0]
    expect(call.init).toBeTruthy()
    expect((call.init!.headers as Record<string, string>)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(submitted).toMatchObject({
      username: 'grid.b',
      displayName: '王小网',
      role: 'grid_worker',
      communityIds: [COMMUNITY_A.id],
    })

    // Only the account list is refreshed; the community list is not re-read.
    await waitFor(() => expect(openDrawers()).toBe(0))
    await waitFor(() => expect(getCalls(calls, '/api/admin/staff')).toHaveLength(2))
    expect(getCalls(calls, '/api/admin/communities')).toHaveLength(1)
  })

  it('keeps entered values when creating the account fails', async () => {
    stubApi((url, init) => {
      if (url === '/api/admin/staff' && init?.method === 'POST') {
        return json({ error: { code: 'conflict', message: '登录账号已被占用' } }, 409)
      }
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A] })
      if (url === '/api/admin/staff') return json({ items: [] })
      if (url.startsWith('/api/crm/residents?')) return json({ items: [], total: 0, page: 1, pageSize: 20 })
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新增账户/ }))
    await fillStaffForm()

    fireEvent.submit(document.getElementById('ll-ui-007-create-staff-form')!)

    expect(await screen.findByText('登录账号已被占用')).toBeTruthy()
    expect(screen.getByText('创建后台账户失败')).toBeTruthy()
    expect(openDrawers()).toBe(1)
    expect(
      (within(drawerBody()).getByPlaceholderText(
        '3-32 位字母、数字、点、下划线或短横线',
      ) as HTMLInputElement).value,
    ).toBe('grid.b')
  })

  it('requires role and community assignment before any POST happens', async () => {
    const calls = stubBaseline()
    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新增账户/ }))
    await fillStaffForm({ skipRoleAndCommunity: true })
    fireEvent.submit(document.getElementById('ll-ui-007-create-staff-form')!)

    expect(await screen.findByText('请选择角色')).toBeTruthy()
    expect(await screen.findByText('请选择至少一个负责社区')).toBeTruthy()
    expect(postCalls(calls, '/api/admin/staff')).toEqual([])
    expect(openDrawers()).toBe(1)
  })
})

// Resident directory (#125): the fetch stub only replaces transport; every
// pagination/search state change is driven through the real UsersPage controls.
const entry = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id,
  displayName: name,
  localDisplayName: name,
  wechatNickname: null,
  wechatAvatarUrl: null,
  profileAuthorizedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  joinedAt: '2026-10-05T00:00:00.000Z',
  ...overrides,
})

describe('UsersPage server-side resident directory', () => {
  it('uses server page/total; searches, clears, changes pages and resets context on community switch', async () => {
    const calls = stubApi((url) => {
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A, COMMUNITY_B] })
      if (url === '/api/admin/staff') return json({ items: [] })
      if (!url.startsWith('/api/crm/residents?')) throw new Error(`unexpected fetch: ${url}`)

      const params = new URL(url, 'http://test.local').searchParams
      const communityId = params.get('communityId')
      const page = Number(params.get('page'))
      const pageSize = Number(params.get('pageSize'))
      const keyword = params.get('keyword')
      const total = keyword === '花花' ? 1 : communityId === COMMUNITY_A.id ? 43 : 2
      const items = Array.from({ length: Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize)) },
        (_, index) => entry(`123e4567-e89b-42d3-a456-${String(6000 + (page - 1) * pageSize + index).padStart(12, '0')}`,
          keyword ? '微信花花' : `居民 ${index + (page - 1) * pageSize}`,
          keyword ? {
            localDisplayName: '本地花花',
            wechatNickname: '微信花花',
            wechatAvatarUrl: null,
            profileAuthorizedAt: '2026-10-06T00:00:00.000Z',
          } : {}),
      )
      return json({ items, total, page, pageSize })
    })
    renderPage(ADMIN_SESSION)
    await waitFor(() => expect(residentCalls(calls)).toHaveLength(1))
    await screen.findByText('43 位居民')

    const next = document.querySelector<HTMLButtonElement>('.ant-pagination-next button')
    expect(next).not.toBeNull()
    fireEvent.click(next!)
    await waitFor(() => expect(
      new URL(residentCalls(calls).at(-1)!.url, 'http://test.local').searchParams.get('page'),
    ).toBe('2'))

    const input = screen.getByRole('searchbox', { name: '搜索居民' })
    fireEvent.change(input, { target: { value: '花花' } })
    fireEvent.click(screen.getByRole('button', { name: /搜\s*索/ }))
    await waitFor(() => {
      const params = new URL(residentCalls(calls).at(-1)!.url, 'http://test.local').searchParams
      expect(params.get('keyword')).toBe('花花')
      expect(params.get('page')).toBe('1')
    })
    expect(await screen.findByText('微信花花')).toBeTruthy()
    expect(screen.getByText('本地：本地花花')).toBeTruthy()
    await screen.findByText('1 位居民')

    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => {
      const params = new URL(residentCalls(calls).at(-1)!.url, 'http://test.local').searchParams
      expect(params.has('keyword')).toBe(false)
      expect(params.get('page')).toBe('1')
    })
    await screen.findByText('43 位居民')

    // The first combobox belongs to the community selector (the other selects
    // are only mounted in closed admin drawers).
    const select = screen.getAllByRole('combobox')[0]
    expect(select).toBeTruthy()
    await chooseOption(select, '阳光社区')
    await waitFor(() => {
      const params = new URL(residentCalls(calls).at(-1)!.url, 'http://test.local').searchParams
      expect(params.get('communityId')).toBe(COMMUNITY_B.id)
      expect(params.get('page')).toBe('1')
      expect(params.has('keyword')).toBe(false)
    })
    await screen.findByText('2 位居民')
    // A page of 20 rows is fetched; never all 43 items to paginate in React.
    expect(residentCalls(calls).some((call) =>
      new URL(call.url, 'http://test.local').searchParams.get('pageSize') === '20')).toBe(true)
  })

  it('shows server failures and an explicit retry without hiding the rest of the management page', async () => {
    let fail = true
    const calls = stubApi((url) => {
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A] })
      if (url === '/api/admin/staff') return json({ items: [] })
      if (url.startsWith('/api/crm/residents?')) {
        if (fail) return json({ error: { code: 'server_error', message: '居民接口暂不可用' } }, 503)
        return json({
          items: [entry('123e4567-e89b-42d3-a456-426614174222', '微信用户', { localDisplayName: null })],
          total: 1, page: 1, pageSize: 20,
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    renderPage(ADMIN_SESSION)
    expect(await screen.findByText('居民接口暂不可用')).toBeTruthy()
    expect(screen.getByText('社区范围')).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    await waitFor(() => expect(residentCalls(calls)).toHaveLength(2))
    await screen.findByText('微信用户')
    expect(screen.queryByText('居民接口暂不可用')).toBeNull()
  })
})
