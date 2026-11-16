// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfigProvider } from 'antd'
import { MemoryRouter } from 'react-router'
import App from './App'
import { adminTheme } from './app/theme'
import { resetWorkTabs } from './shared/lib/work-tabs'

const STAFF_SESSION = {
  authenticated: true,
  user: { id: '123e4567-e89b-42d3-a456-426614174000', displayName: '已授权管理员' },
  staff: {
    id: '123e4567-e89b-42d3-a456-426614174001',
    username: 'integration-admin',
    role: 'admin',
    communities: [],
  },
  csrfToken: 'csrf-from-api-acceptance-tests-long',
}

afterEach(() => {
  cleanup()
  resetWorkTabs()
  vi.unstubAllGlobals()
})

function mount(path: string) {
  return render(
    <ConfigProvider theme={adminTheme}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ConfigProvider>,
  )
}

it('never renders protected shell on an unauthenticated deep link', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  mount('/communities')

  expect(await screen.findByRole('heading', { name: '本地生活运营后台' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: '社区管理' })).toBeNull()
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { credentials: 'include' })
})

it('authenticates from a deep link and logs out through the real API contract', async () => {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    paths.push(url)
    if (url === '/api/auth/session') return new Response(JSON.stringify({ authenticated: false }))
    if (url === '/api/auth/csrf') return new Response(JSON.stringify({ csrfToken: 'csrf-from-api-acceptance-tests-long' }))
    if (url === '/api/auth/login') {
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string> | undefined)?.['x-csrf-token']).toBe('csrf-from-api-acceptance-tests-long')
      return new Response(JSON.stringify(STAFF_SESSION))
    }
    if (url === '/api/admin/communities') return new Response(JSON.stringify({ items: [] }))
    if (url === '/api/admin/staff') return new Response(JSON.stringify({ items: [] }))
    if (url === '/api/auth/logout') {
      expect(init?.method).toBe('POST')
      expect((init?.headers as Record<string, string> | undefined)?.['x-csrf-token']).toBe('csrf-from-api-acceptance-tests-long')
      return new Response(null, { status: 204 })
    }
    throw new Error('Unexpected test API: ' + url)
  }))
  mount('/communities')

  fireEvent.change(await screen.findByPlaceholderText('管理员 / 网格员账号'), {
    target: { value: 'integration-admin' },
  })
  fireEvent.change(screen.getByPlaceholderText('请输入密码'), {
    target: { value: 'valid-test-only-password-2026' },
  })
  fireEvent.click(screen.getByRole('button', { name: /登\s*录/ }))
  expect(await screen.findByRole('menuitem', { name: '社区管理' })).toBeTruthy()
  await waitFor(() => expect(screen.getAllByText('已授权管理员').length).toBeGreaterThan(0))
  await waitFor(() => expect(paths).toContain('/api/admin/communities'))

  fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
  expect(await screen.findByRole('heading', { name: '本地生活运营后台' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: '社区管理' })).toBeNull()
  expect(paths).toContain('/api/auth/logout')
})
