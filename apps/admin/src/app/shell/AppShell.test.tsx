// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { mockHealthFetch, renderAdmin, setViewportWidth } from '../../test/render-admin'
import { resetWorkTabs } from '../../shared/lib/work-tabs'

function tabNames(): string[] {
  return screen.getAllByRole('tab').map((tab) => tab.textContent?.trim() ?? '')
}

/** Ant Design keeps the remove control next to (not inside) the tab button. */
function clickTabRemove(name: string) {
  const tab = screen.getByRole('tab', { name })
  const remove = tab.closest('.ant-tabs-tab')?.querySelector('.ant-tabs-tab-remove')
  if (!remove) throw new Error(`tab ${name} has no close control`)
  fireEvent.click(remove)
}

beforeEach(() => {
  setViewportWidth(1024)
  mockHealthFetch()
})

afterEach(() => {
  resetWorkTabs()
  vi.unstubAllGlobals()
  setViewportWidth(1024)
})

describe('admin AppShell', () => {
  it('renders the grouped navigation, current page header and route-synced tab', async () => {
    renderAdmin('/')

    expect(await screen.findByRole('heading', { name: '经营工作台' })).toBeTruthy()
    expect(document.querySelector('.app-brand-name')?.textContent).toBe('本地生活')
    expect(screen.getByRole('menuitem', { name: '经营工作台' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '活动管理' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '系统信息' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '经营工作台' })).toBeTruthy()
    expect(screen.getByText('API 健康检查')).toBeTruthy()
  })

  it('narrows the menu by search and shows an honest empty state', async () => {
    renderAdmin('/')

    const search = await screen.findByRole('textbox', { name: '搜索菜单' })
    fireEvent.change(search, { target: { value: '订单' } })

    expect(screen.getByRole('menuitem', { name: '订单管理' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: '活动管理' })).toBeNull()

    fireEvent.change(search, { target: { value: '不存在的菜单' } })
    expect(screen.getByText('未找到匹配的菜单')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '经营工作台' })).toBeTruthy()
  })

  it('opens, switches and closes route-synced work tabs', async () => {
    const { router } = renderAdmin('/')

    fireEvent.click(await screen.findByRole('menuitem', { name: '活动管理' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/activities'))
    expect(await screen.findByRole('heading', { name: '活动管理' })).toBeTruthy()
    expect(tabNames()).toEqual(['经营工作台', '活动管理'])

    fireEvent.click(screen.getByRole('menuitem', { name: '居民与客户' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/customers'))
    expect(tabNames()).toEqual(['经营工作台', '活动管理', '居民与客户'])

    // Closing a non-current tab keeps the current page and strip ordering.
    clickTabRemove('活动管理')
    expect(tabNames()).toEqual(['经营工作台', '居民与客户'])
    expect(router.state.location.pathname).toBe('/customers')

    // Closing the current tab moves to the remaining neighbour.
    clickTabRemove('居民与客户')
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(tabNames()).toEqual(['经营工作台'])
  })

  it('closes other tabs from the tab actions menu and keeps the current one', async () => {
    const { router } = renderAdmin('/orders')

    fireEvent.click(await screen.findByRole('menuitem', { name: '活动管理' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/activities'))
    expect(tabNames()).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: '页签操作' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '关闭其他页签' }))

    await waitFor(() => expect(tabNames()).toEqual(['经营工作台', '活动管理']))
    expect(router.state.location.pathname).toBe('/activities')
  })

  it('keeps tabs consistent with browser back and forward navigation', async () => {
    const { router } = renderAdmin('/')

    fireEvent.click(await screen.findByRole('menuitem', { name: '居民与客户' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/customers'))
    fireEvent.click(screen.getByRole('menuitem', { name: '订单管理' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders'))
    await waitFor(() => expect(tabNames()).toEqual(['经营工作台', '居民与客户', '订单管理']))

    await router.navigate(-1)
    await waitFor(() => expect(screen.getByRole('heading', { name: '居民与客户' })).toBeTruthy())
    expect(screen.getByRole('tab', { name: '居民与客户' }).getAttribute('aria-selected')).toBe(
      'true',
    )

    await router.navigate(1)
    await waitFor(() => expect(screen.getByRole('heading', { name: '订单管理' })).toBeTruthy())
    expect(screen.getByRole('tab', { name: '订单管理' }).getAttribute('aria-selected')).toBe('true')
  })

  it('persists the open tab strip across a reload of the same session', async () => {
    const { router } = renderAdmin('/')
    await router.navigate('/system/runtime')
    await waitFor(() =>
      expect(JSON.parse(window.sessionStorage.getItem('ll:work-tabs') ?? '{}')).toEqual({
        version: 1,
        tabs: ['/', '/system/runtime'],
      }),
    )
  })

  it('collapses and expands the desktop sidebar without losing the work tabs', async () => {
    renderAdmin('/')

    fireEvent.click(await screen.findByRole('button', { name: '收起侧边栏' }))
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '搜索菜单' })).toBeNull()
    expect(screen.getByRole('tab', { name: '经营工作台' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '展开侧边栏' }))
    expect(screen.getByRole('button', { name: '收起侧边栏' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '搜索菜单' })).toBeTruthy()
  })

  it('uses a searchable drawer on narrow screens and restores focus after navigation', async () => {
    setViewportWidth(767)
    const { router } = renderAdmin('/')

    const trigger = await screen.findByRole('button', { name: '打开导航菜单' })
    expect(document.querySelector('.app-sider')).toBeNull()

    fireEvent.click(trigger)
    const drawer = await screen.findByRole('dialog', { name: '导航菜单' })
    expect(within(drawer).getByRole('textbox', { name: '搜索菜单' })).toBeTruthy()

    fireEvent.click(within(drawer).getByRole('menuitem', { name: '订单管理' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders'))
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'), {
      timeout: 3000,
    })
    await waitFor(() => expect(document.activeElement).toBe(trigger), { timeout: 3000 })
    expect(screen.getByRole('tab', { name: '订单管理' })).toBeTruthy()
  })

  it('switches from the drawer to the desktop sidebar at the 768px boundary', async () => {
    setViewportWidth(767)
    renderAdmin('/')

    expect(await screen.findByRole('button', { name: '打开导航菜单' })).toBeTruthy()

    setViewportWidth(768)
    fireEvent.resize(window)

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '打开导航菜单' })).toBeNull(),
    )
    expect(document.querySelector('.app-sider')).not.toBeNull()
  })

  it('shows the explicit not-found page without a phantom module tab', async () => {
    renderAdmin('/removed-route')

    expect(await screen.findByRole('heading', { name: '页面不存在' })).toBeTruthy()
    expect(tabNames()).toEqual(['经营工作台'])
  })
})
