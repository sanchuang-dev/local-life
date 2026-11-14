// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { CommunitiesPage } from './CommunitiesPage'

/**
 * LL-USER-002: /communities is community management only. These tests drive the
 * real page with an explicitly stubbed fetch, and every URL must be declared;
 * an unexpected request throws so a silently reintroduced resident table or a
 * fake local dataset would fail loudly.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740b2', name: '阳光社区' }
const CSRF_TOKEN = 'csrf-token-for-communities-page-tests'

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
        <CommunitiesPage session={session} />
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

function methodCalls(calls: FetchCall[], path: string, method: string): FetchCall[] {
  return calls.filter((call) => call.url === path && call.init?.method === method)
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
}) {
  const communities = options?.communities ?? [COMMUNITY_A]
  return stubApi((url) => {
    if (url === '/api/admin/communities') return json({ items: communities })
    if (url === '/api/admin/staff') return json({ items: options?.staffItems ?? [] })
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

describe('CommunitiesPage management surface', () => {
  it('is community management only: no duplicate resident table and no resident search', async () => {
    stubBaseline()
    renderPage(ADMIN_SESSION)

    expect(await screen.findByRole('heading', { name: '社区管理' })).toBeTruthy()
    expect(await screen.findByRole('button', { name: /新建社区/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /新增账户/ })).toBeNull()
    expect(await screen.findByRole('region', { name: '社区列表' })).toBeTruthy()
    // The old page's second resident roster and its search box are gone.
    expect(screen.queryByText('社区居民')).toBeNull()
    expect(screen.queryByRole('searchbox', { name: '搜索居民' })).toBeNull()
    // Forms live inside drawers: nothing of them occupies the page before opening.
    expect(screen.queryByPlaceholderText('例如：幸福社区')).toBeNull()
    expect(screen.queryByPlaceholderText('工作人员姓名')).toBeNull()
    expect(openDrawers()).toBe(0)
  })

  it('re-fetches the authorized staff directory when a session switches from operator to admin', async () => {
    const calls = stubBaseline()
    const view = renderPage(OPERATOR_SESSION)
    await screen.findByRole('region', { name: '社区列表' })
    expect(getCalls(calls, '/api/admin/staff')).toEqual([])

    view.rerender(
      <ConfigProvider locale={zhCN} theme={adminTheme}>
        <AntdApp><CommunitiesPage session={ADMIN_SESSION} /></AntdApp>
      </ConfigProvider>,
    )
    await waitFor(() => expect(getCalls(calls, '/api/admin/staff')).toHaveLength(1))
    expect(await screen.findByRole('button', { name: /新建社区/ })).toBeTruthy()
  })

  it('ignores a late admin-scoped response after changing to an operator session', async () => {
    let resolveAdmin!: (response: Response) => void
    const delayedAdminDirectory = new Promise<Response>((resolve) => { resolveAdmin = resolve })
    let communityReads = 0
    const calls = stubApi((url) => {
      if (url === '/api/admin/communities') {
        communityReads += 1
        return json({ items: communityReads === 1 ? [COMMUNITY_A] : [COMMUNITY_B] })
      }
      if (url === '/api/admin/staff') return delayedAdminDirectory
      throw new Error('unexpected fetch: ' + url)
    })

    const view = renderPage(ADMIN_SESSION)
    await waitFor(() => expect(getCalls(calls, '/api/admin/staff')).toHaveLength(1))
    view.rerender(
      <ConfigProvider locale={zhCN} theme={adminTheme}>
        <AntdApp><CommunitiesPage session={OPERATOR_SESSION} /></AntdApp>
      </ConfigProvider>,
    )
    expect(await screen.findByText('阳光社区')).toBeTruthy()
    expect(screen.queryByText('幸福社区')).toBeNull()

    await act(async () => { resolveAdmin(json({ items: [] })) })
    expect(screen.getByText('阳光社区')).toBeTruthy()
    expect(screen.queryByText('幸福社区')).toBeNull()
    expect(getCalls(calls, '/api/admin/staff')).toHaveLength(1)
  })

  it('lists real staff accounts with their community authorizations', async () => {
    stubBaseline({
      staffItems: [
        {
          id: '123e4567-e89b-42d3-a456-4266141740c3',
          username: 'grid.b',
          displayName: '王小网',
          role: 'grid_worker',
          status: 'active',
          communities: [COMMUNITY_A, COMMUNITY_B],
        },
      ],
    })
    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('王小网')).toBeTruthy()
    expect(screen.getAllByText('经营网格员').length).toBeGreaterThan(0)
    expect(screen.getAllByText('运营员授权').length).toBeGreaterThan(0)
    expect(screen.queryByText('后台账户')).toBeNull()
  })

  it('never shows create entries or write surfaces to a non-admin operator', async () => {
    const calls = stubBaseline()
    renderPage(OPERATOR_SESSION)

    expect(await screen.findByRole('heading', { name: '社区管理' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /新建社区/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '经营负责人' })).toBeNull()
    expect(screen.queryByRole('button', { name: '运营员授权' })).toBeNull()
    // No admin-only surface is even mounted, so no admin write request can happen.
    expect(document.querySelector('.ant-drawer')).toBeNull()
    expect(screen.queryByPlaceholderText('例如：幸福社区')).toBeNull()
    expect(screen.queryByPlaceholderText('工作人员姓名')).toBeNull()
    expect(getCalls(calls, '/api/admin/staff')).toEqual([])
    expect(postCalls(calls, '/api/admin/communities')).toEqual([])
    expect(postCalls(calls, '/api/admin/staff')).toEqual([])
  })
})

describe('CommunitiesPage create-community drawer', () => {
  it('creates a community through the real API and refreshes only the community list', async () => {
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
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    const trigger = await screen.findByRole('button', { name: /新建社区/ })
    fireEvent.click(trigger)

    const input = await screen.findByPlaceholderText('例如：幸福社区')
    fireEvent.change(input, { target: { value: '阳光社区' } })
    fireEvent.submit(document.getElementById('ll-create-community-form')!)

    await waitFor(() => expect(postCalls(calls, '/api/admin/communities')).toHaveLength(1))
    const call = postCalls(calls, '/api/admin/communities')[0]
    expect(call.init).toBeTruthy()
    expect((call.init!.headers as Record<string, string>)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(call.init?.body))).toEqual({ name: '阳光社区' })

    // Drawer closes and only the community list is genuinely re-read.
    await waitFor(() => expect(openDrawers()).toBe(0))
    await waitFor(() => expect(getCalls(calls, '/api/admin/communities')).toHaveLength(2))
    expect(getCalls(calls, '/api/admin/staff')).toHaveLength(2)
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
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    const input = (await screen.findByPlaceholderText('例如：幸福社区')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '幸福社区' } })
    fireEvent.submit(document.getElementById('ll-create-community-form')!)

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
    fireEvent.submit(document.getElementById('ll-create-community-form')!)

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
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /新建社区/ })),
    )

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


describe('Community association with an existing account', () => {
  it('links an already-created operator without creating a second account', async () => {
    let linked = false
    const row = {
      id: '123e4567-e89b-42d3-a456-4266141740c3',
      username: 'operator.a', displayName: '王运营', role: 'operator',
      status: 'active', communities: [COMMUNITY_A],
    }
    const calls = stubApi((url, init) => {
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A, COMMUNITY_B] })
      if (url === '/api/admin/staff') return json({ items: [
        { ...row, communities: linked ? [COMMUNITY_A, COMMUNITY_B] : [COMMUNITY_A] },
      ] })
      if (url === '/api/admin/communities/' + COMMUNITY_B.id + '/staff' && init?.method === 'POST') {
        linked = true
        return json({ communityId: COMMUNITY_B.id, staffAccountId: row.id }, 201)
      }
      throw new Error('unexpected fetch: ' + url)
    })
    renderPage(ADMIN_SESSION)
    const community = (await screen.findByText('阳光社区')).closest('tr')!
    fireEvent.click(within(community).getByRole('button', { name: '运营员授权' }))
    const drawer = document.querySelector('.ant-drawer-open') as HTMLElement
    expect(drawer).toBeTruthy()
    await chooseOption(within(drawer).getByRole('combobox'), '王运营 · operator.a')
    fireEvent.click(within(drawer).getByRole('button', { name: /添加授权/ }))
    await waitFor(() => expect(calls.filter((item) => item.init?.method === 'POST')).toHaveLength(1))
    const post = calls.find((item) => item.init?.method === 'POST')!
    expect(post.url).toBe('/api/admin/communities/' + COMMUNITY_B.id + '/staff')
    expect((post.init!.headers as Record<string, string>)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init!.body))).toEqual({ staffAccountId: row.id })
    expect(calls.some((item) => item.url === '/api/admin/staff' && item.init?.method === 'POST')).toBe(false)
    await waitFor(() => expect(within(community).getByText('王运营')).toBeTruthy())
  })
})

describe('Community grid territory management', () => {
  const GRID_1 = {
    id: '123e4567-e89b-42d3-a456-4266141740c3',
    username: 'grid.a',
    displayName: '王网格',
    role: 'grid_worker',
    status: 'active',
    communities: [] as { id: string; name: string }[],
  }
  const GRID_2 = {
    id: '123e4567-e89b-42d3-a456-4266141740c4',
    username: 'grid.b',
    displayName: '李网格',
    role: 'grid_worker',
    status: 'active',
    communities: [] as { id: string; name: string }[],
  }

  it('assigns then replaces the grid owner with the optimistic previous owner', async () => {
    let staffItems = [GRID_1, GRID_2]
    const calls = stubApi((url, init) => {
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A] })
      if (url === '/api/admin/staff') return json({ items: staffItems })
      if (
        url === `/api/admin/communities/${COMMUNITY_A.id}/grid-worker` &&
        init?.method === 'PUT'
      ) {
        const body = JSON.parse(String(init.body)) as {
          staffAccountId: string
          expectedStaffAccountId: string | null
        }
        staffItems = staffItems.map((person) => ({
          ...person,
          communities: person.id === body.staffAccountId ? [COMMUNITY_A] : [],
        }))
        return json({ staffAccountId: body.staffAccountId, communityId: COMMUNITY_A.id })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    const community = (await screen.findByText('幸福社区')).closest('tr')!
    fireEvent.click(within(community).getByRole('button', { name: '经营负责人' }))

    let drawer = document.querySelector('.ant-drawer-open') as HTMLElement
    expect(within(drawer).getByText('暂无经营网格员')).toBeTruthy()
    await chooseOption(within(drawer).getByLabelText('经营网格员'), '王网格 · grid.a · 可分配')
    fireEvent.click(within(drawer).getByRole('button', { name: '保存负责人' }))

    await waitFor(() => expect(methodCalls(
      calls,
      `/api/admin/communities/${COMMUNITY_A.id}/grid-worker`,
      'PUT',
    )).toHaveLength(1))
    const first = methodCalls(
      calls,
      `/api/admin/communities/${COMMUNITY_A.id}/grid-worker`,
      'PUT',
    )[0]!
    expect((first.init!.headers as Record<string, string>)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(first.init!.body))).toEqual({
      staffAccountId: GRID_1.id,
      expectedStaffAccountId: null,
    })
    await waitFor(() => expect(openDrawers()).toBe(0))
    expect(await screen.findByText('经营负责人已更新')).toBeTruthy()

    fireEvent.click(within(community).getByRole('button', { name: '经营负责人' }))
    drawer = document.querySelector('.ant-drawer-open') as HTMLElement
    expect(within(drawer).getByText('王网格（grid.a）')).toBeTruthy()
    await chooseOption(within(drawer).getByLabelText('经营网格员'), '李网格 · grid.b · 可分配')
    fireEvent.click(within(drawer).getByRole('button', { name: '保存负责人' }))

    const modal = await waitFor(() => {
      const element = document.querySelector('.ant-modal-confirm')
      expect(element).toBeTruthy()
      return element as HTMLElement
    })
    expect(within(modal).getByText(/旧负责人将立即失去本片区访问权限/)).toBeTruthy()
    fireEvent.click(within(modal).getByRole('button', { name: '确认更换' }))

    await waitFor(() => expect(methodCalls(
      calls,
      `/api/admin/communities/${COMMUNITY_A.id}/grid-worker`,
      'PUT',
    )).toHaveLength(2))
    const second = methodCalls(
      calls,
      `/api/admin/communities/${COMMUNITY_A.id}/grid-worker`,
      'PUT',
    )[1]!
    expect(JSON.parse(String(second.init!.body))).toEqual({
      staffAccountId: GRID_2.id,
      expectedStaffAccountId: GRID_1.id,
    })
  })

  it('unassigns a grid owner through the audited DELETE route', async () => {
    let staffItems = [{ ...GRID_1, communities: [COMMUNITY_A] }]
    const calls = stubApi((url, init) => {
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A] })
      if (url === '/api/admin/staff') return json({ items: staffItems })
      if (
        url === `/api/admin/communities/${COMMUNITY_A.id}/staff/${GRID_1.id}` &&
        init?.method === 'DELETE'
      ) {
        staffItems = [{ ...GRID_1, communities: [] }]
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    const community = (await screen.findByText('幸福社区')).closest('tr')!
    fireEvent.click(within(community).getByRole('button', { name: '经营负责人' }))
    const drawer = document.querySelector('.ant-drawer-open') as HTMLElement
    expect(within(drawer).getByText('王网格（grid.a）')).toBeTruthy()

    fireEvent.click(within(drawer).getByRole('button', { name: '解除负责人' }))
    const modal = await waitFor(() => {
      const element = document.querySelector('.ant-modal-confirm')
      expect(element).toBeTruthy()
      return element as HTMLElement
    })
    fireEvent.click(within(modal).getByRole('button', { name: '解除负责人' }))

    await waitFor(() => expect(methodCalls(
      calls,
      `/api/admin/communities/${COMMUNITY_A.id}/staff/${GRID_1.id}`,
      'DELETE',
    )).toHaveLength(1))
    const call = methodCalls(
      calls,
      `/api/admin/communities/${COMMUNITY_A.id}/staff/${GRID_1.id}`,
      'DELETE',
    )[0]!
    expect((call.init!.headers as Record<string, string>)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(await screen.findByText('经营负责人已解除')).toBeTruthy()
    await waitFor(() => expect(within(drawer).getByText('暂无经营网格员')).toBeTruthy())
  })

  it('removes one operator authorization without touching other communities', async () => {
    const operator = {
      id: '123e4567-e89b-42d3-a456-4266141740c5',
      username: 'operator.a',
      displayName: '王运营',
      role: 'operator',
      status: 'active',
      communities: [COMMUNITY_A, COMMUNITY_B],
    }
    let staffItems = [operator]
    const calls = stubApi((url, init) => {
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A] })
      if (url === '/api/admin/staff') return json({ items: staffItems })
      if (
        url === `/api/admin/communities/${COMMUNITY_A.id}/staff/${operator.id}` &&
        init?.method === 'DELETE'
      ) {
        staffItems = [{ ...operator, communities: [COMMUNITY_B] }]
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    const community = (await screen.findByText('幸福社区')).closest('tr')!
    fireEvent.click(within(community).getByRole('button', { name: '运营员授权' }))
    const drawer = document.querySelector('.ant-drawer-open') as HTMLElement
    expect(within(drawer).getByText('王运营')).toBeTruthy()

    fireEvent.click(within(drawer).getByRole('button', { name: '解除' }))
    const modal = await waitFor(() => {
      const element = document.querySelector('.ant-modal-confirm')
      expect(element).toBeTruthy()
      return element as HTMLElement
    })
    fireEvent.click(within(modal).getByRole('button', { name: '解除授权' }))

    await waitFor(() => expect(methodCalls(
      calls,
      `/api/admin/communities/${COMMUNITY_A.id}/staff/${operator.id}`,
      'DELETE',
    )).toHaveLength(1))
    expect(await screen.findByText('运营员授权已解除')).toBeTruthy()
    await waitFor(() => expect(within(drawer).getByText('暂无运营员授权')).toBeTruthy())
  })
})
