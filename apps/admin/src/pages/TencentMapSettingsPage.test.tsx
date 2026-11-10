// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { TencentMapSettingsPage } from './TencentMapSettingsPage'

const CSRF_TOKEN = 'csrf-token-admin-test'
const ADMIN_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: '123e4567-e89b-42d3-a456-426614174000', displayName: '测试管理员' },
  staff: {
    id: '123e4567-e89b-42d3-a456-426614174001',
    username: 'admin', role: 'admin', communities: [],
  },
  csrfToken: CSRF_TOKEN,
}
const OPERATOR_SESSION: AuthenticatedSession = {
  ...ADMIN_SESSION,
  staff: { ...ADMIN_SESSION.staff, role: 'operator' },
}

const PATH = '/api/admin/tencent-map/config'
const SECRETISH_KEY = 'MAPKEY123456789ABCD'
const EMPTY = { configured: false, enabled: false, keyHint: null, appName: null, updatedAt: null }
const SAVED = {
  configured: true, enabled: true, keyHint: '••••ABCD',
  appName: '默认应用', updatedAt: '2026-11-10T03:00:00.000Z',
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function renderPage(session: AuthenticatedSession) {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider value={{
          session, busy: false, error: null, onLogout: async () => undefined,
        }}>
          <TencentMapSettingsPage />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 })
})
afterEach(() => vi.unstubAllGlobals())

describe('Tencent map admin settings', () => {
  it('prevents all non-admin requests, including when the route is opened directly', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    renderPage(OPERATOR_SESSION)
    expect(screen.getByText('没有配置权限')).toBeTruthy()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('persists the Key and application name from a real form, with CSRF, and never echoes the full Key', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let configured = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url === PATH && !init?.method) return json(configured ? SAVED : EMPTY)
      if (url === PATH && init?.method === 'PUT') {
        configured = true
        return json(SAVED)
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: '配置 Key' }))
    const key = screen.getByLabelText('腾讯位置服务 Key') as HTMLInputElement
    expect(key.type).toBe('password')
    fireEvent.change(key, { target: { value: SECRETISH_KEY } })
    const app = screen.getByLabelText('腾讯地图应用名称') as HTMLInputElement
    expect(app.value).toBe('默认应用')
    fireEvent.click(screen.getByRole('button', { name: '保存并启用' }))
    await waitFor(() => expect(calls.some((x) => x.init?.method === 'PUT')).toBe(true))
    const put = calls.find((x) => x.init?.method === 'PUT')!
    expect(put.url).toBe(PATH)
    expect((put.init?.headers as Record<string, string>)['x-csrf-token']).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(put.init?.body))).toEqual({ key: SECRETISH_KEY, appName: '默认应用' })
    expect(await screen.findByText('••••ABCD')).toBeTruthy()
    await waitFor(() => expect(screen.queryByLabelText('腾讯位置服务 Key')).toBeNull())
    expect(document.body.textContent).not.toContain(SECRETISH_KEY)
  })

  it('shows server failure instead of claiming that configuration was saved', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === PATH && !init?.method) return json(EMPTY)
      if (url === PATH && init?.method === 'PUT') {
        return json({ error: { code: 'invalid_request', message: '地图 Key 格式不正确' } }, 400)
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
    renderPage(ADMIN_SESSION)
    fireEvent.click(await screen.findByRole('button', { name: '配置 Key' }))
    const key = screen.getByLabelText('腾讯位置服务 Key') as HTMLInputElement
    fireEvent.change(key, { target: { value: 'bad key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并启用' }))
    expect(await screen.findByText('地图 Key 格式不正确')).toBeTruthy()
    expect(key.value).toBe('bad key')
    expect(screen.queryByText('••••ABCD')).toBeNull()
  })
})
