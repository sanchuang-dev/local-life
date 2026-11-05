// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { UsersPage } from './UsersPage'

/**
 * These tests drive the real /communities page with an explicitly stubbed
 * `fetch`. Every answered URL is declared per test; an unexpected URL throws,
 * so a page that silently used fake data would fail loudly. Error cases assert
 * the server's actual message instead of a success-looking placeholder.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const NEW_STAFF_ID = '123e4567-e89b-42d3-a456-426614174002'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
const COMMUNITY_B = { id: '123e4567-e89b-42d3-a456-4266141740b2', name: '阳光社区' }
const COMMUNITY_C = { id: '123e4567-e89b-42d3-a456-4266141740c3', name: '新城社区' }
const RESIDENT_ID = '123e4567-e89b-42d3-a456-4266141740d4'
const CSRF_TOKEN = 'csrf-token-for-users-page-tests'

interface Community {
  id: string
  name: string
}

interface StaffAccount {
  id: string
  username: string
  displayName: string | null
  role: 'admin' | 'operator' | 'grid_worker'
  status: 'active' | 'disabled'
  communities: Community[]
}

const EXISTING_STAFF: StaffAccount = {
  id: STAFF_ID,
  username: 'operator.a',
  displayName: '运营员甲',
  role: 'operator',
  status: 'active',
  communities: [COMMUNITY_A],
}

const NEW_STAFF: StaffAccount = {
  id: NEW_STAFF_ID,
  username: 'grid.b',
  displayName: '网格员乙',
  role: 'grid_worker',
  status: 'active',
  communities: [COMMUNITY_A],
}

const RESIDENT = {
  id: RESIDENT_ID,
  displayName: '张三',
  createdAt: '2026-11-03T02:00:00.000Z',
}

const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: USER_ID, displayName: '测试管理员' },
  staff: { id: STAFF_ID, username: 'testadmin', role: 'admin', communities: [COMMUNITY_A] },
  csrfToken: CSRF_TOKEN,
}

const OPERATOR_SESSION: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: { id: STAFF_ID, username: 'operator.a', role: 'operator', communities: [COMMUNITY_A] },
}

interface FetchCall {
  url: string
  init?: RequestInit
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

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

interface AdminRoutesOptions {
  communities?: () => Community[]
  staff?: () => StaffAccount[]
  residents?: () => Array<typeof RESIDENT>
  createCommunity?: Handler
  createStaff?: Handler
}

function adminRoutes(options: AdminRoutesOptions = {}): ReadonlyArray<readonly [string, Handler]> {
  return [
    [
      '/api/admin/communities',
      (url, init) => {
        if (init?.method === 'POST') {
          return options.createCommunity?.(url, init) ?? json(COMMUNITY_C, 201)
        }
        return json({ items: options.communities?.() ?? [COMMUNITY_A, COMMUNITY_B] })
      },
    ],
    [
      '/api/admin/staff',
      (url, init) => {
        if (init?.method === 'POST') {
          return options.createStaff?.(url, init) ?? json(NEW_STAFF, 201)
        }
        return json({ items: options.staff?.() ?? [EXISTING_STAFF] })
      },
    ],
    ['/api/crm/residents?', () => json({ items: options.residents?.() ?? [RESIDENT] })],
  ]
}

function renderPage(session: AuthenticatedSession) {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider
          value={{ session, busy: false, error: null, onLogout: async () => undefined }}
        >
          <UsersPage session={session} />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

function postCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.init?.method === 'POST')
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

describe('UsersPage list-first layout', () => {
  it('shows existing communities, staff and residents before any form', async () => {
    const calls = stubApi(adminRoutes())

    renderPage(ADMIN_SESSION)

    expect(await screen.findByText('张三')).toBeTruthy()
    expect(await screen.findByText('operator.a')).toBeTruthy()
    expect(screen.getByText('共 2 个社区')).toBeTruthy()
    expect(screen.getByRole('button', { name: /新建社区/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /新增账户/ })).toBeTruthy()
    // The creation forms live in closed Drawers, not in the main work area.
    expect(screen.queryByLabelText('社区名称')).toBeNull()
    expect(screen.queryByLabelText('登录账号')).toBeNull()
    expect(calls.some((call) => call.url.startsWith('/api/crm/residents?'))).toBe(true)
  })

  it('keeps non-admin staff read-only and issues no staff-management requests', async () => {
    const calls = stubApi([
      ['/api/admin/communities', () => json({ items: [COMMUNITY_A] })],
      ['/api/crm/residents?', () => json({ items: [RESIDENT] })],
    ])

    renderPage(OPERATOR_SESSION)

    expect(await screen.findByText('张三')).toBeTruthy()
    expect(screen.getByText('运营员')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /新建社区/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /新增账户/ })).toBeNull()
    expect(screen.queryByText('后台账户')).toBeNull()
    expect(calls.every((call) => !call.url.startsWith('/api/admin/staff'))).toBe(true)
  })
})

describe('UsersPage create-community Drawer', () => {
  it('validates the name, posts once with CSRF, then refreshes without losing the current community', async () => {
    let created = false
    const calls = stubApi(
      adminRoutes({
        communities: () =>
          created ? [COMMUNITY_A, COMMUNITY_B, COMMUNITY_C] : [COMMUNITY_A, COMMUNITY_B],
        createCommunity: () => {
          created = true
          return json(COMMUNITY_C, 201)
        },
      }),
    )

    renderPage(ADMIN_SESSION)

    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    const nameInput = (await screen.findByLabelText('社区名称')) as HTMLInputElement

    fireEvent.click(screen.getByRole('button', { name: '创建社区' }))
    expect(await screen.findByText('请填写社区名称')).toBeTruthy()
    expect(postCalls(calls)).toHaveLength(0)

    fireEvent.change(nameInput, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: '创建社区' }))
    expect(await screen.findByText('社区名称需为 2-60 个字符')).toBeTruthy()
    expect(postCalls(calls)).toHaveLength(0)

    fireEvent.change(nameInput, { target: { value: '新城社区' } })
    fireEvent.click(screen.getByRole('button', { name: '创建社区' }))

    await waitFor(() => expect(postCalls(calls)).toHaveLength(1))
    const post = postCalls(calls)[0]
    expect(post.url).toBe('/api/admin/communities')
    expect((post.init?.headers as Record<string, string> | undefined)?.['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(post.init?.body))).toEqual({ name: '新城社区' })

    // The real list is re-read and the previously selected community survives.
    await waitFor(() => expect(screen.getByText('共 3 个社区')).toBeTruthy())
    expect(screen.queryByLabelText('社区名称')).toBeNull()
    expect(document.querySelector('.ant-select-content')?.getAttribute('title')).toBe('幸福社区')
    expect(
      calls.filter(
        (call) => call.url === '/api/admin/communities' && call.init?.method !== 'POST',
      ),
    ).toHaveLength(2)
  })

  it('keeps the drawer and its input open when the server rejects the create', async () => {
    stubApi(
      adminRoutes({
        createCommunity: () =>
          json({ error: { code: 'conflict', message: '社区名称已存在' } }, 409),
      }),
    )

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    const nameInput = (await screen.findByLabelText('社区名称')) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '幸福社区' } })
    fireEvent.click(screen.getByRole('button', { name: '创建社区' }))

    expect(await screen.findByText('社区名称已存在')).toBeTruthy()
    expect((screen.getByLabelText('社区名称') as HTMLInputElement).value).toBe('幸福社区')
    expect(screen.getByText('共 2 个社区')).toBeTruthy()
  })

  it('keeps the input and shows the real 401 message when the session is rejected', async () => {
    stubApi(
      adminRoutes({
        createCommunity: () =>
          json({ error: { code: 'unauthorized', message: '请先登录管理后台' } }, 401),
      }),
    )

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    fireEvent.change(await screen.findByLabelText('社区名称'), { target: { value: '未登录社区' } })
    fireEvent.click(screen.getByRole('button', { name: '创建社区' }))

    expect(await screen.findByText('请先登录管理后台')).toBeTruthy()
    expect((screen.getByLabelText('社区名称') as HTMLInputElement).value).toBe('未登录社区')
  })

  it('rejects a name that falls below the server minimum after trimming', async () => {
    const calls = stubApi(adminRoutes())

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    const nameInput = (await screen.findByLabelText('社区名称')) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '  A  ' } })
    fireEvent.click(screen.getByRole('button', { name: '创建社区' }))

    expect(await screen.findByText('社区名称需为 2-60 个字符')).toBeTruthy()
    expect(postCalls(calls)).toHaveLength(0)
  })

  it('protects an edited form from accidental close, then abandons it explicitly', async () => {
    const calls = stubApi(adminRoutes())

    renderPage(ADMIN_SESSION)
    const trigger = await screen.findByRole('button', { name: /新建社区/ })
    // A real mouse click focuses the trigger; jsdom's synthetic click does not.
    trigger.focus()
    fireEvent.click(trigger)
    const nameInput = (await screen.findByLabelText('社区名称')) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '未保存社区' } })

    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }))
    expect((await screen.findAllByText('放弃未保存的内容？')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    await waitFor(() => expect(screen.queryAllByText('放弃未保存的内容？')).toHaveLength(0))
    expect((screen.getByLabelText('社区名称') as HTMLInputElement).value).toBe('未保存社区')

    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }))
    fireEvent.click(await screen.findByRole('button', { name: '放弃并关闭' }))
    await waitFor(() => expect(screen.queryByLabelText('社区名称')).toBeNull())
    // Abandoning a form never turns into a create request.
    expect(postCalls(calls)).toHaveLength(0)
    // Focus returns to the button that opened the Drawer.
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('closes an untouched form without a confirmation', async () => {
    stubApi(adminRoutes())

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    expect(await screen.findByLabelText('社区名称')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }))

    await waitFor(() => expect(screen.queryByLabelText('社区名称')).toBeNull())
    expect(screen.queryAllByText('放弃未保存的内容？')).toHaveLength(0)
  })

  it('sends only one create request when the save button is clicked repeatedly', async () => {
    let resolvePost: (response: Response) => void = () => undefined
    const pendingPost = new Promise<Response>((resolve) => {
      resolvePost = resolve
    })
    let created = false
    const calls = stubApi(
      adminRoutes({
        communities: () => (created ? [COMMUNITY_A, COMMUNITY_C] : [COMMUNITY_A]),
        createCommunity: () => pendingPost,
      }),
    )

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新建社区/ }))
    fireEvent.change(await screen.findByLabelText('社区名称'), { target: { value: '并发社区' } })

    const submit = screen.getByRole('button', { name: '创建社区' })
    fireEvent.click(submit)
    fireEvent.click(submit)

    await waitFor(() => expect(postCalls(calls)).toHaveLength(1))
    created = true
    resolvePost(json(COMMUNITY_C, 201))
    await waitFor(() => expect(screen.queryByLabelText('社区名称')).toBeNull())
    expect(postCalls(calls)).toHaveLength(1)
  })
})

describe('UsersPage create-staff Drawer', () => {
  it('creates a staff account with role and community assignment from the wide Drawer', async () => {
    let created = false
    let staffPost: FetchCall | undefined
    const calls = stubApi([
      ['/api/admin/communities', () => json({ items: [COMMUNITY_A, COMMUNITY_B] })],
      [
        '/api/admin/staff',
        (url, init) => {
          if (init?.method === 'POST') {
            staffPost = { url, init }
            created = true
            return json(NEW_STAFF, 201)
          }
          return json({ items: created ? [EXISTING_STAFF, NEW_STAFF] : [EXISTING_STAFF] })
        },
      ],
      ['/api/crm/residents?', () => json({ items: [RESIDENT] })],
    ])

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新增账户/ }))

    fireEvent.change(await screen.findByLabelText('登录账号'), { target: { value: 'grid.b' } })
    fireEvent.change(screen.getByLabelText(/姓名/), { target: { value: '网格员乙' } })
    fireEvent.change(screen.getByLabelText('初始密码'), {
      target: { value: 'a-very-long-password' },
    })

    fireEvent.mouseDown(screen.getByLabelText('角色'))
    const roleOption = (await screen.findAllByText('网格员')).find((element) =>
      element.closest('.ant-select-item-option'),
    )
    expect(roleOption).toBeTruthy()
    fireEvent.click(roleOption as Element)

    fireEvent.mouseDown(screen.getByLabelText('负责社区'))
    const communityOption = (await screen.findAllByText('幸福社区')).find((element) =>
      element.closest('.ant-select-item-option'),
    )
    expect(communityOption).toBeTruthy()
    fireEvent.click(communityOption as Element)

    fireEvent.click(screen.getByRole('button', { name: '创建账户' }))
    // The second click must be absorbed by the in-flight guard.
    fireEvent.click(screen.getByRole('button', { name: '创建账户' }))

    await waitFor(() => expect(staffPost).toBeTruthy())
    expect(calls.filter((call) => call.url === '/api/admin/staff' && call.init?.method === 'POST')).toHaveLength(1)
    expect(staffPost?.url).toBe('/api/admin/staff')
    expect((staffPost?.init?.headers as Record<string, string> | undefined)?.['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(staffPost?.init?.body))).toEqual({
      username: 'grid.b',
      displayName: '网格员乙',
      password: 'a-very-long-password',
      role: 'grid_worker',
      communityIds: [COMMUNITY_A.id],
    })

    await waitFor(() => expect(screen.queryByLabelText('登录账号')).toBeNull())
    expect(await screen.findByText('grid.b')).toBeTruthy()
    expect(
      calls.filter((call) => call.url === '/api/admin/staff' && call.init?.method !== 'POST'),
    ).toHaveLength(2)
  })

  it('keeps the staff form open with its values when the account already exists', async () => {
    stubApi(
      adminRoutes({
        createStaff: () => json({ error: { code: 'conflict', message: '登录账号已存在' } }, 409),
      }),
    )

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新增账户/ }))
    fireEvent.change(await screen.findByLabelText('登录账号'), { target: { value: 'operator.a' } })
    fireEvent.change(screen.getByLabelText(/姓名/), { target: { value: '重复账号' } })
    fireEvent.change(screen.getByLabelText('初始密码'), {
      target: { value: 'a-very-long-password' },
    })
    fireEvent.mouseDown(screen.getByLabelText('角色'))
    const roleOption = (await screen.findAllByText('运营员')).find((element) =>
      element.closest('.ant-select-item-option'),
    )
    fireEvent.click(roleOption as Element)
    fireEvent.mouseDown(screen.getByLabelText('负责社区'))
    const communityOption = (await screen.findAllByText('幸福社区')).find((element) =>
      element.closest('.ant-select-item-option'),
    )
    fireEvent.click(communityOption as Element)
    fireEvent.click(screen.getByRole('button', { name: '创建账户' }))

    expect(await screen.findByText('登录账号已存在')).toBeTruthy()
    expect((screen.getByLabelText('登录账号') as HTMLInputElement).value).toBe('operator.a')
    expect(screen.getByText('共 2 个社区')).toBeTruthy()
  })

  it('shows the real 403 reason and lets an edited staff form be abandoned deliberately', async () => {
    const calls = stubApi(
      adminRoutes({
        createStaff: () =>
          json({ error: { code: 'forbidden', message: '只有管理员可以创建后台账户' } }, 403),
      }),
    )

    renderPage(ADMIN_SESSION)
    const trigger = await screen.findByRole('button', { name: /新增账户/ })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.change(await screen.findByLabelText('登录账号'), { target: { value: 'grid.c' } })
    fireEvent.change(screen.getByLabelText(/姓名/), { target: { value: '网格员丙' } })
    fireEvent.change(screen.getByLabelText('初始密码'), {
      target: { value: 'a-very-long-password' },
    })
    fireEvent.mouseDown(screen.getByLabelText('角色'))
    const roleOption = (await screen.findAllByText('网格员')).find((element) =>
      element.closest('.ant-select-item-option'),
    )
    fireEvent.click(roleOption as Element)
    fireEvent.mouseDown(screen.getByLabelText('负责社区'))
    const communityOption = (await screen.findAllByText('幸福社区')).find((element) =>
      element.closest('.ant-select-item-option'),
    )
    fireEvent.click(communityOption as Element)
    fireEvent.click(screen.getByRole('button', { name: '创建账户' }))

    expect(await screen.findByText('只有管理员可以创建后台账户')).toBeTruthy()
    expect((screen.getByLabelText('登录账号') as HTMLInputElement).value).toBe('grid.c')

    // A touched staff form is protected on close just like the community one.
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }))
    expect((await screen.findAllByText('放弃未保存的内容？')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    await waitFor(() => expect(screen.queryAllByText('放弃未保存的内容？')).toHaveLength(0))
    expect((screen.getByLabelText('登录账号') as HTMLInputElement).value).toBe('grid.c')

    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }))
    fireEvent.click(await screen.findByRole('button', { name: '放弃并关闭' }))
    await waitFor(() => expect(screen.queryByLabelText('登录账号')).toBeNull())
    // Only the rejected create was sent; abandoning adds no write request.
    expect(calls.filter((call) => call.url === '/api/admin/staff' && call.init?.method === 'POST')).toHaveLength(1)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
