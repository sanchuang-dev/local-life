// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import { resetPanelPreferences } from '../shared/lib/data-panel-prefs'
import type { AuthenticatedSession } from '../services/auth'
import { ExternalOffersPage } from './ExternalOffersPage'

const admin: AuthenticatedSession = {
  authenticated: true,
  user: { id: '123e4567-e89b-42d3-a456-426614174000', displayName: '运营管理员' },
  staff: { id: '123e4567-e89b-42d3-a456-426614174001', username: 'admin',
    role: 'admin', communities: [] },
  csrfToken: 'csrf-token-for-offers-panel-test',
}
const fixture = [
  {
    id: '123e4567-e89b-42d3-a456-426614174010',
    kind: 'external_promotion', title: '美团外卖活动',
    platform: '美团', category: '餐饮', description: '外卖活动',
    url: 'https://example.com/a', sortOrder: 1, enabled: true,
    expiresAt: null,
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
  },
  {
    id: '123e4567-e89b-42d3-a456-426614174011',
    kind: 'external_promotion', title: '淘宝闪购活动',
    platform: '淘宝', category: '闪购', description: null,
    url: 'https://example.com/b', sortOrder: 2, enabled: false,
    expiresAt: null,
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
  },
]

function renderPage(session: AuthenticatedSession = admin) {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider value={{
          session, busy: false, error: null, onLogout: async () => undefined,
        }}>
          <ExternalOffersPage />
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

function stubList() {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    calls.push(path)
    if (path !== '/api/admin/external-offers') {
      throw new Error('Unexpected API request: ' + path)
    }
    return new Response(JSON.stringify({ items: fixture }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))
  return calls
}

afterEach(() => {
  cleanup()
  resetPanelPreferences()
  vi.unstubAllGlobals()
})

describe('External offers DataPanel integration', () => {
  it('renders its standard surface, controls, toolbar buttons and row actions', async () => {
    const calls = stubList()
    renderPage()
    const panel = await screen.findByRole('region', { name: '精选优惠列表' })
    await within(panel).findByText('美团外卖活动')

    expect(panel.className).toContain('data-panel')
    expect(within(panel).getByRole('button', { name: '下载Excel模板' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Excel批量导入' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: /刷\s*新/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新增优惠活动' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: '列设置' })).toBeTruthy()
    expect(within(panel).getAllByRole('button', { name: '编辑' })).toHaveLength(2)
    expect(calls).toEqual(['/api/admin/external-offers'])

    fireEvent.change(within(panel).getByRole('textbox', { name: '活动检索' }),
      { target: { value: '淘宝' } })
    fireEvent.click(within(panel).getByRole('button', { name: /查\s*询/ }))
    await waitFor(() => {
      expect(within(panel).queryByText('美团外卖活动')).toBeNull()
      expect(within(panel).getByText('淘宝闪购活动')).toBeTruthy()
    })
    // The list is filtered in the page, without inventing a server-side search endpoint.
    expect(calls).toEqual(['/api/admin/external-offers'])
  })

  it('opens the import dialog through the injected toolbar action', async () => {
    stubList()
    renderPage()
    const panel = await screen.findByRole('region', { name: '精选优惠列表' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Excel批量导入' }))
    const fileInput = await screen.findByLabelText('选择Excel文件', {}, { timeout: 5000 })
    expect(fileInput).toBeTruthy()
    expect(screen.getByRole('button', { name: '导入有效项（默认下架）' })
      .hasAttribute('disabled')).toBe(true)
  })

  it('still blocks a grid worker without requesting the offer list', () => {
    const calls = stubList()
    renderPage({ ...admin, staff: { ...admin.staff, role: 'grid_worker' } })
    expect(screen.getByText('无权管理精选优惠')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '精选优惠列表' })).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
