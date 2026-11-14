// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { StaffAccessPage } from './StaffAccessPage'

/**
 * System access account creation was moved out of /communities. These tests drive the
 * real page with an explicitly stubbed fetch, and every URL must be declared;
 * an unexpected request throws so a silently reintroduced resident table or a
 * fake local dataset would fail loudly.
 */

const USER_ID = '123e4567-e89b-42d3-a456-426614174000'
const STAFF_ID = '123e4567-e89b-42d3-a456-426614174001'
const COMMUNITY_A = { id: '123e4567-e89b-42d3-a456-4266141740a1', name: '幸福社区' }
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
        <StaffAccessPage session={session} />
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

describe('StaffAccessPage account creation in system settings', () => {
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
    fireEvent.change(
      await within(body).findByPlaceholderText('3-32 位字母、数字、点、下划线或短横线'),
      {
        target: { value: 'grid.b' },
      },
    )
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

    fireEvent.submit(document.getElementById('ll-create-backoffice-account-form')!)

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
    expect(getCalls(calls, '/api/admin/communities')).toHaveLength(2)
  })

  it('keeps entered values when creating the account fails', async () => {
    stubApi((url, init) => {
      if (url === '/api/admin/staff' && init?.method === 'POST') {
        return json({ error: { code: 'conflict', message: '登录账号已被占用' } }, 409)
      }
      if (url === '/api/admin/communities') return json({ items: [COMMUNITY_A] })
      if (url === '/api/admin/staff') return json({ items: [] })
      throw new Error(`unexpected fetch: ${url}`)
    })

    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新增账户/ }))
    await fillStaffForm()

    fireEvent.submit(document.getElementById('ll-create-backoffice-account-form')!)

    expect(await screen.findByText('登录账号已被占用')).toBeTruthy()
    expect(screen.getByText('创建账户失败')).toBeTruthy()
    expect(openDrawers()).toBe(1)
    expect(
      (
        within(drawerBody()).getByPlaceholderText(
          '3-32 位字母、数字、点、下划线或短横线',
        ) as HTMLInputElement
      ).value,
    ).toBe('grid.b')
  })

  it('requires role and community assignment before any POST happens', async () => {
    const calls = stubBaseline()
    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: /新增账户/ }))
    await fillStaffForm({ skipRoleAndCommunity: true })
    fireEvent.submit(document.getElementById('ll-create-backoffice-account-form')!)

    expect(await screen.findByText('请选择角色')).toBeTruthy()
    expect(await screen.findByText('请选择至少一个负责社区')).toBeTruthy()
    expect(postCalls(calls, '/api/admin/staff')).toEqual([])
    expect(openDrawers()).toBe(1)
  })
})

describe('Staff Access role boundary and shared DataPanel', () => {
  it('lists real backend accounts and communities in the shared panel', async () => {
    stubBaseline({ staffItems: [{
      id: 'test-id', username: 'operator.a', displayName: '王运营',
      role: 'operator', status: 'active', communities: [COMMUNITY_A],
    }] })
    renderPage(ADMIN_SESSION)
    const panel = await screen.findByRole('region', { name: '后台账号列表' })
    expect(panel.className).toContain('data-panel--fill')
    expect(within(panel).getByText('operator.a')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: /新增账户/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新建社区' })).toBeNull()
  })

  it('does not read or render accounts for non-admin roles', async () => {
    const calls = stubApi(() => { throw new Error('non-admin must not query accounts') })
    renderPage(OPERATOR_SESSION)
    expect(await screen.findByText('没有账号管理权限')).toBeTruthy()
    expect(calls).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '新增账户' })).toBeNull()
  })
})
