// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { ThirdPartySettingsPage } from './ThirdPartySettingsPage'

const ADMIN: AuthenticatedSession = {
  authenticated: true,
  user: { id: '123e4567-e89b-42d3-a456-426614174000', displayName: '测试管理员' },
  staff: {
    id: '123e4567-e89b-42d3-a456-426614174001',
    username: 'admin', role: 'admin', communities: [],
  },
  csrfToken: 'third-party-test-csrf',
}
const OPERATOR: AuthenticatedSession = {
  ...ADMIN, staff: { ...ADMIN.staff, role: 'operator' },
}
const WECHAT = {
  state: 'unconfigured',
  active: null,
  candidate: null,
  recent: [],
  masterKeyAvailable: true,
  keyId: 'v1',
  redirectUri: 'http://localhost:5173/api/auth/wechat/callback',
}
const MAP = {
  configured: true,
  enabled: true,
  keyHint: '••••ABCD',
  appName: '社区选点',
  updatedAt: '2026-11-10T03:00:00.000Z',
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
function renderPage(session = ADMIN) {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider value={{
          session, busy: false, error: null, onLogout: async () => undefined,
        }}>
          <ThirdPartySettingsPage />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    value: 1024, configurable: true, writable: true,
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('ThirdPartySettingsPage cards', () => {
  it('shows two service cards with real status, no secret and separate management controls', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url === '/api/admin/wechat/config') return json(WECHAT)
      if (url === '/api/admin/tencent-map/config') return json(MAP)
      throw new Error('unexpected fetch ' + url)
    }))
    renderPage()
    expect(screen.getByRole('heading', { name: '第三方配置' })).toBeTruthy()
    const wechat = screen.getByTestId('third-party-wechat')
    const map = screen.getByTestId('third-party-map')
    expect(within(wechat).getByText('微信公众号')).toBeTruthy()
    expect(within(map).getByText('腾讯地图')).toBeTruthy()
    await waitFor(() => {
      expect(within(wechat).getByText('未配置')).toBeTruthy()
      expect(within(map).getByText('已启用')).toBeTruthy()
    })
    expect(within(wechat).getByText('尚未启用')).toBeTruthy()
    expect(within(map).getByText('••••ABCD')).toBeTruthy()
    expect(within(map).getByText('社区选点')).toBeTruthy()
    expect(within(wechat).getByRole('button', { name: /管理配置/ })).toBeTruthy()
    expect(within(map).getByRole('button', { name: /管理配置/ })).toBeTruthy()
    expect(calls.sort()).toEqual(['/api/admin/tencent-map/config', '/api/admin/wechat/config'])
    expect(document.body.textContent).not.toContain('AppSecret')
  })

  it('opens the existing Tencent Map editor without leaving the card page and refreshes after close', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url === '/api/admin/wechat/config') return json(WECHAT)
      if (url === '/api/admin/tencent-map/config') return json(MAP)
      throw new Error('unexpected fetch ' + url)
    }))
    renderPage()
    const card = screen.getByTestId('third-party-map')
    await within(card).findByText('已启用')
    fireEvent.click(within(card).getByRole('button', { name: /管理配置/ }))
    expect(await screen.findByText('社区地图选点')).toBeTruthy()
    const drawer = document.querySelector('.third-party-configuration-drawer') as HTMLElement
    expect(drawer).toBeTruthy()
    const dismiss = drawer.querySelector<HTMLButtonElement>('.ant-drawer-close')
    expect(dismiss).toBeTruthy()
    fireEvent.click(dismiss!)
    await waitFor(() => expect(calls.filter((url) => url === '/api/admin/tencent-map/config').length).toBeGreaterThanOrEqual(3))
    expect(screen.getByRole('heading', { name: '第三方配置' })).toBeTruthy()
  })

  it('opens the existing WeChat console without duplicating credential forms or issuing a write', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, method: init?.method })
      if (url === '/api/admin/wechat/config') return json(WECHAT)
      if (url === '/api/admin/tencent-map/config') return json(MAP)
      throw new Error('unexpected fetch ' + url)
    }))
    renderPage()
    const card = screen.getByTestId('third-party-wechat')
    await within(card).findByText('未配置')
    fireEvent.click(within(card).getByRole('button', { name: /管理配置/ }))
    expect(await screen.findByTestId('wechat-active-card')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '第三方配置' })).toBeTruthy()
    expect(calls.every((request) => request.method === 'GET' || request.method === undefined)).toBe(true)
  })

  it('keeps the map card functional when WeChat status fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/admin/wechat/config') return json({
        error: { code: 'not_configured', message: '微信公众号配置不可用' },
      }, 503)
      if (url === '/api/admin/tencent-map/config') return json(MAP)
      throw new Error('unexpected fetch ' + url)
    }))
    renderPage()
    expect(await within(screen.getByTestId('third-party-wechat')).findByText('状态读取失败')).toBeTruthy()
    expect(await within(screen.getByTestId('third-party-map')).findByText('已启用')).toBeTruthy()
  })

  it('clears stale successful status after a failed refresh while keeping the healthy provider visible', async () => {
    let wechatAvailable = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/admin/wechat/config') {
        return wechatAvailable
          ? json(WECHAT)
          : json({ error: { code: 'unavailable', message: '微信公众号不可用' } }, 503)
      }
      if (url === '/api/admin/tencent-map/config') return json(MAP)
      throw new Error('unexpected fetch ' + url)
    }))
    renderPage()
    const wechat = screen.getByTestId('third-party-wechat')
    const map = screen.getByTestId('third-party-map')
    await within(wechat).findByText('未配置')
    expect(within(map).getByText('已启用')).toBeTruthy()

    // The initial server read must finish before clicking Refresh. Under
    // GitHub Actions the AntD Button can still be in its loading state after
    // the data card has rendered, and intentionally ignores clicks then.
    const refresh = screen.getByRole('button', { name: '刷新状态' })
    await waitFor(() => expect(refresh.classList.contains('ant-btn-loading')).toBe(false))
    wechatAvailable = false
    fireEvent.click(refresh)
    expect(await within(wechat).findByText('状态读取失败')).toBeTruthy()
    expect(within(wechat).queryByText('未配置')).toBeNull()
    expect(within(wechat).queryByText('尚未启用')).toBeNull()
    expect(within(map).getByText('已启用')).toBeTruthy()
  })

  it('denies non-admins before either management read or editor mount', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    renderPage(OPERATOR)
    expect(screen.getByText('没有第三方配置权限')).toBeTruthy()
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.queryByTestId('third-party-wechat')).toBeNull()
    expect(screen.queryByTestId('third-party-map')).toBeNull()
  })
})
