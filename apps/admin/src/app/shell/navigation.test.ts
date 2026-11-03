import { describe, expect, it } from 'vitest'
import {
  activeMenuKey,
  filterNavigation,
  findNavPage,
  groupForPage,
  HOME_PAGE,
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
    expect(groups[0]?.pages.map((page) => page.label)).toEqual(['管理员与权限', '系统信息'])
  })

  it('matches the top-level workbench item separately', () => {
    const { showHome, groups } = filterNavigation('经营')

    expect(showHome).toBe(true)
    expect(groups).toEqual([])
  })

  it('trims the query and matches a label fragment', () => {
    const { groups } = filterNavigation('  社区  ')

    expect(groups.map((group) => group.key)).toEqual(['customer'])
    expect(groups[0]?.pages.map((page) => page.label)).toEqual(['网格与社区'])
  })

  it('returns no items when nothing matches', () => {
    expect(filterNavigation('不存在的菜单')).toEqual({ showHome: false, groups: [] })
  })
})

describe('activeMenuKey', () => {
  it('resolves the workbench only for the root path', () => {
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
