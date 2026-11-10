// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderAdmin, setViewportWidth } from '../test/render-admin'
import { resetWorkTabs } from '../shared/lib/work-tabs'

/**
 * LL-USER-002 route wiring: `/users` is a real directory page, not the old
 * redirect to `/communities`, and both destinations deep-link and refresh
 * independently.
 */

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Only the two real reads the two pages issue; anything else fails loudly. */
function stubDirectoryAndCommunities() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/admin/communities') return json({ items: [] })
    if (url === '/api/admin/staff') return json({ items: [] })
    if (url.startsWith('/api/admin/users?')) {
      const params = new URL(url, 'http://test.local').searchParams
      return json({
        items: [],
        total: 0,
        page: Number(params.get('page')),
        pageSize: Number(params.get('pageSize')),
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  setViewportWidth(1024)
})

afterEach(() => {
  resetWorkTabs()
  vi.unstubAllGlobals()
  setViewportWidth(1024)
})

describe('admin route table user directory split', () => {
  it('renders /users as an independent directory page with its own navigation entry', async () => {
    stubDirectoryAndCommunities()
    const { router } = renderAdmin('/users')

    expect(await screen.findByRole('heading', { name: '用户管理' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '用户管理' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '社区管理' })).toBeTruthy()
    // The URL is not redirected to /communities.
    await waitFor(() => expect(router.state.location.pathname).toBe('/users'))
    // The community-management page's write surfaces are absent here.
    expect(screen.queryByRole('button', { name: /新建社区/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /新增账户/ })).toBeNull()
    expect(screen.queryByText('社区居民')).toBeNull()
  })

  it('renders /communities as community management without the resident roster', async () => {
    stubDirectoryAndCommunities()
    const { router } = renderAdmin('/communities')

    expect(await screen.findByRole('heading', { name: '社区管理' })).toBeTruthy()
    expect(await screen.findByRole('button', { name: /新建社区/ })).toBeTruthy()
    expect(screen.queryByRole('searchbox', { name: '搜索居民' })).toBeNull()
    expect(screen.queryByText('社区居民')).toBeNull()
    await waitFor(() => expect(router.state.location.pathname).toBe('/communities'))
  })
})
