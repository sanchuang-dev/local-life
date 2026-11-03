import { describe, expect, it } from 'vitest'
import {
  activeMenuKey,
  filterNavigation,
  findNavPage,
  groupForPage,
  HOME_PAGE,
  isPageVisible,
  NAV_GROUPS,
} from './navigation'

describe('filterNavigation', () => {
  it('returns the untouched model for an empty or whitespace query', () => {
    expect(filterNavigation('')).toEqual({ showHome: true, groups: NAV_GROUPS })
    expect(filterNavigation('   ')).toEqual({ showHome: true, groups: NAV_GROUPS })
  })

  it('keeps only matching pages and their group', () => {
    const { showHome, groups } = filterNavigation('订单管')

    expect(showHome).toBe(false)
    expect(groups.map((group) => group.key)).toEqual(['commerce'])
    expect(groups[0]?.pages.map((page) => page.label)).toEqual(['订单管理'])
  })

  it('keeps a whole group when its own label matches', () => {
    const { groups } = filterNavigation('商品与订单')

    expect(groups.map((group) => group.key)).toEqual(['commerce'])
    expect(groups[0]?.pages.map((page) => page.label)).toEqual(['商品管理', '订单管理'])
  })

  it('keeps every page when the group label itself matches', () => {
    const { groups } = filterNavigation('系统管理')

    expect(groups.map((group) => group.key)).toEqual(['system'])
    expect(groups[0]?.pages.map((page) => page.label)).toEqual([
      '管理员与权限',
      '系统信息',
      '界面组件',
    ])
  })

  it('matches the top-level workbench item separately', () => {
    const { showHome, groups } = filterNavigation('经营')

    expect(showHome).toBe(true)
    expect(groups).toEqual([])
  })

  it('trims the query and matches a label fragment', () => {
    const { groups } = filterNavigation('  社区  ')

    expect(groups.map((group) => group.key)).toEqual(['customer'])
    expect(groups[0]?.pages.map((page) => page.label)).toEqual(['账户与社区'])
  })

  it('returns no items when nothing matches', () => {
    expect(filterNavigation('不存在的菜单')).toEqual({ showHome: false, groups: [] })
  })
})

describe('activity console navigation', () => {
  it('marks /activities as a ready page with no planned leftovers', () => {
    const page = findNavPage('/activities')
    expect(page?.status).toBe('ready')
    expect(page?.planned).toEqual([])
    expect(page?.roles).toEqual(['admin', 'operator'])
    // The registration/check-in page stays explicitly planned.
    expect(findNavPage('/activities/checkin')?.status).toBe('planned')
  })

  it('hides the activity console from grid workers but keeps it for staff who can operate', () => {
    const activities = findNavPage('/activities')
    expect(activities).toBeTruthy()
    expect(isPageVisible(activities!, 'grid_worker')).toBe(false)
    expect(isPageVisible(activities!, 'admin')).toBe(true)
    expect(isPageVisible(activities!, 'operator')).toBe(true)
    // No role means "not yet known"; the sidebar must not hide the entry early.
    expect(isPageVisible(activities!)).toBe(true)

    const gridNavigation = filterNavigation('', 'grid_worker')
    expect(
      gridNavigation.groups.flatMap((group) => group.pages.map((page) => page.key)),
    ).not.toContain('/activities')
    expect(gridNavigation.groups.map((group) => group.key)).not.toContain('campaign')

    const adminNavigation = filterNavigation('', 'admin')
    expect(
      adminNavigation.groups.flatMap((group) => group.pages.map((page) => page.key)),
    ).toContain('/activities')
  })
})

describe('activeMenuKey', () => {  it('resolves the workbench only for the root path', () => {
    expect(activeMenuKey('/')).toBe(HOME_PAGE.key)
    expect(activeMenuKey('/orders')).toBe('/orders')
  })

  it('prefers the longest matching nested route', () => {
    expect(activeMenuKey('/activities/checkin')).toBe('/activities/checkin')
    expect(activeMenuKey('/activities')).toBe('/activities')
    expect(activeMenuKey('/system/runtime')).toBe('/system/runtime')
  })

  it('keeps unknown routes out of the navigation model', () => {
    expect(activeMenuKey('/removed-route')).toBeUndefined()
    expect(findNavPage('/removed-route')).toBeUndefined()
  })

  it('resolves the owning group for a page', () => {
    expect(groupForPage('/customers')?.label).toBe('客户与网格')
    expect(groupForPage('/')).toBeUndefined()
  })
})
