// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AdminAuthProvider } from '../app/auth-context'
import { adminTheme } from '../app/theme'
import type { AuthenticatedSession } from '../services/auth'
import { DashboardPage } from './DashboardPage'

const STAFF_SESSION: AuthenticatedSession = {
  authenticated: true,
  user: { id: '123e4567-e89b-42d3-a456-426614174000', displayName: '测试管理员' },
  staff: {
    id: '123e4567-e89b-42d3-a456-426614174001',
    username: 'testadmin',
    role: 'admin',
    communities: [],
  },
  csrfToken: 'test-only-csrf',
}

/**
 * Renders the page itself rather than the whole AppShell: this test is about
 * the summary row's layout contract, and the shell has its own coverage.
 */
function renderDashboard() {
  return render(
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <AdminAuthProvider
          value={{ session: STAFF_SESSION, busy: false, error: null, onLogout: async () => {} }}
        >
          <MemoryRouter initialEntries={['/']}>
            <DashboardPage />
          </MemoryRouter>
        </AdminAuthProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

function card(title: string) {
  const cardElement = screen.getByText(title).closest('.ant-card')
  expect(cardElement).not.toBeNull()
  return cardElement as HTMLElement
}

describe('DashboardPage card layout', () => {
  it('keeps both summary cards on one stretched row with full-height cards', () => {
    renderDashboard()

    const identityCard = card('当前工作身份')
    const startCard = card('开始工作')

    // Row align="stretch" gives the Cols one shared height; a 100%-height Card
    // then reaches both top and bottom edges, so the two bottom borders align.
    const row = identityCard.closest('.ant-row')
    expect(row).not.toBeNull()
    expect(row).toBe(startCard.closest('.ant-row'))
    expect((row as HTMLElement).classList.contains('ant-row-stretch')).toBe(true)
    expect(identityCard.style.height).toBe('100%')
    expect(startCard.style.height).toBe('100%')
  })

  it('stacks naturally on narrow screens instead of forcing a fixed height', () => {
    renderDashboard()

    for (const title of ['当前工作身份', '开始工作']) {
      const column = card(title).closest('.ant-col') as HTMLElement
      expect(column.classList.contains('ant-col-xs-24')).toBe(true)
      expect(column.classList.contains('ant-col-md-12')).toBe(true)
      // The only inline height is the Card filling its Col; no hard-coded px.
      expect(card(title).style.height).toBe('100%')
    }
  })
})
