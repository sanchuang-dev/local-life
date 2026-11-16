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
    expect(groups[0]?.pages.map((page) => page.label)).toEqual(['商品管理', '精选优惠', '订单管理'])
  })

  it('keeps every page when the group label itself matches', () => {
    const { groups } = filterNavigation('系统管理')

    expect(groups.map((group) => group.key)).toEqual(['system'])
    expect(groups[0]?.pages.map((page) => page.label)).toEqual([
      '管理员与权限',
      '系统信息',
      '第三方配置',
      '界面组件',
    ])
  })

  it('searches the workbench and the independently named reconciliation page', () => {
    const { showHome, groups } = filterNavigation('经营')

    expect(showHome).toBe(true)
    expect(groups.map((group) => group.key)).toEqual(['performance'])
    expect(groups[0]?.pages.map((page) => page.key)).toEqual(['/reconciliation'])
  })

  it('trims the query and matches a label fragment', () => {
    const { groups } = filterNavigation('  社区  ')

    expect(groups.map((group) => group.key)).toEqual(['customer'])
    expect(groups[0]?.pages.map((page) => page.label)).toEqual(['社区管理'])
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
    // LL-MVP-006 turned 报名与核销 into a real page: it must not stay planned.
    const checkin = findNavPage('/activities/checkin')
    expect(checkin?.status).toBe('ready')
    expect(checkin?.planned).toEqual([])
    expect(checkin?.roles).toEqual(['admin', 'operator'])
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

describe('customer CRM navigation', () => {
  it('marks /customers as a ready CRM page for admins and operators', () => {
    const customers = findNavPage('/customers')
    expect(customers?.status).toBe('ready')
    expect(customers?.planned).toEqual([])
    expect(customers?.roles).toEqual(['admin', 'operator'])
    expect(customers?.label).toContain('客户')
    expect(customers?.description).toContain('受理单')
    // The neighbouring community registry stays a separate real page.
    expect(findNavPage('/communities')?.status).toBe('ready')
  })

  it('hides the CRM console from grid workers while keeping it for staff who can audit', () => {
    const customers = findNavPage('/customers')
    expect(customers).toBeTruthy()
    expect(isPageVisible(customers!, 'grid_worker')).toBe(false)
    expect(isPageVisible(customers!, 'admin')).toBe(true)
    expect(isPageVisible(customers!, 'operator')).toBe(true)

    const gridNavigation = filterNavigation('', 'grid_worker')
    expect(
      gridNavigation.groups.flatMap((group) => group.pages.map((page) => page.key)),
    ).not.toContain('/customers')
    expect(
      filterNavigation('', 'operator')
        .groups.flatMap((group) => group.pages.map((page) => page.key)),
    ).toContain('/customers')
  })
})

describe('platform user directory navigation', () => {
  it('registers /users as an independent ready page for every staff role', () => {
    const users = findNavPage('/users')
    expect(users).toBeTruthy()
    expect(users?.status).toBe('ready')
    expect(users?.planned).toEqual([])
    expect(users?.label).toBe('用户管理')
    expect(users?.roles).toBeUndefined()
    expect(groupForPage('/users')?.label).toBe('客户与网格')
    expect(activeMenuKey('/users')).toBe('/users')
    for (const role of ['admin', 'operator', 'grid_worker'] as const) {
      expect(isPageVisible(users!, role)).toBe(true)
      expect(
        filterNavigation('', role).groups.flatMap((group) => group.pages.map((page) => page.key)),
      ).toContain('/users')
    }
  })

  it('renames /communities to community management and removes the duplicate roster wording', () => {
    const communities = findNavPage('/communities')
    expect(communities?.status).toBe('ready')
    expect(communities?.label).toBe('社区管理')
    expect(communities?.description).toContain('关联系统中已有')
    expect(communities?.description).not.toContain('居民列表')
    expect(activeMenuKey('/communities')).toBe('/communities')
    // The user directory is a sibling destination, not a tab inside 社区管理.
    expect(findNavPage('/users')?.label).not.toBe(communities?.label)
  })
})

describe('performance and reconciliation navigation', () => {
  it('marks both ledger pages as ready with no planned leftovers', () => {
    for (const key of ['/performance', '/reconciliation', '/settlements']) {
      const page = findNavPage(key)
      expect(page, `${key} must exist in the navigation model`).toBeTruthy()
      expect(page?.status).toBe('ready')
      expect(page?.planned).toEqual([])
      expect(page?.roles).toEqual(['admin', 'operator'])
    }
    expect(groupForPage('/performance')?.label).toBe('业绩与对账')
    expect(groupForPage('/settlements')?.label).toBe('业绩与对账')
    expect(groupForPage('/reconciliation')?.label).toBe('业绩与对账')
  })

  it('stops calling the ledger an unimplemented module', () => {
    const performance = findNavPage('/performance')
    const settlements = findNavPage('/settlements')
    // The old placeholder copy promised 「网格员业绩」「结算单导出」; shipping a real
    // page must not keep advertising a plan as if the page were still pending.
    expect(performance?.description).toContain('账面')
    expect(performance?.description).not.toContain('待建设')
    const reconciliation = findNavPage('/reconciliation')
    expect(reconciliation?.description).toContain('对账批次')
    expect(reconciliation?.description).toContain('CSV')
    expect(settlements?.label).toBe('分成结算')
    expect(settlements?.description).toContain('合同规则')
    // Nothing in this group may still render the shared 待建设 state.
    const plannedKeys = NAV_GROUPS.flatMap((group) => group.pages)
      .filter((page) => page.status === 'planned')
      .map((page) => page.key)
    expect(plannedKeys).not.toContain('/performance')
    expect(plannedKeys).not.toContain('/settlements')
    expect(plannedKeys).not.toContain('/reconciliation')
  })

  it('hides the ledger pages from grid workers but keeps them for staff who can operate', () => {
    for (const key of ['/performance', '/reconciliation', '/settlements']) {
      const page = findNavPage(key)
      expect(page).toBeTruthy()
      expect(isPageVisible(page!, 'grid_worker')).toBe(false)
      expect(isPageVisible(page!, 'admin')).toBe(true)
      expect(isPageVisible(page!, 'operator')).toBe(true)
      // No role means "not yet known"; the sidebar must not hide the entry early.
      expect(isPageVisible(page!)).toBe(true)
    }

    const gridNavigation = filterNavigation('', 'grid_worker')
    expect(
      gridNavigation.groups.flatMap((group) => group.pages.map((page) => page.key)),
    ).not.toContain('/performance')
    expect(gridNavigation.groups.map((group) => group.key)).not.toContain('performance')

    const operatorKeys = filterNavigation('', 'operator').groups.flatMap((group) =>
      group.pages.map((page) => page.key),
    )
    expect(operatorKeys).toContain('/performance')
    expect(operatorKeys).toContain('/settlements')
    expect(operatorKeys).toContain('/reconciliation')
  })
})

describe('unified third-party configuration navigation', () => {
  it('has one real administrator-only entry for WeChat and Tencent Map', () => {
    const page = findNavPage('/system/integrations')
    expect(page?.status).toBe('ready')
    expect(page?.label).toBe('第三方配置')
    expect(page?.planned).toEqual([])
    expect(page?.description).toContain('微信公众号')
    expect(page?.description).toContain('腾讯地图')
    expect(page?.roles).toEqual(['admin'])
    expect(groupForPage('/system/integrations')?.label).toBe('系统管理')
    expect(activeMenuKey('/system/integrations')).toBe('/system/integrations')
    const pages = NAV_GROUPS.flatMap((group) => group.pages)
    expect(pages.map((item) => item.key)).not.toContain('/system/wechat')
    expect(pages.map((item) => item.key)).not.toContain('/system/tencent-map')
    for (const role of ['operator', 'grid_worker'] as const) {
      expect(isPageVisible(page!, role)).toBe(false)
      expect(filterNavigation('', role).groups.flatMap((group) => group.pages.map((item) => item.key)))
        .not.toContain('/system/integrations')
    }
    expect(filterNavigation('', 'admin').groups.flatMap((group) => group.pages.map((item) => item.key)))
      .toContain('/system/integrations')
    expect(filterNavigation('第三方', 'admin').groups[0]?.pages.map((item) => item.key))
      .toContain('/system/integrations')
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
    expect(activeMenuKey('/performance')).toBe('/performance')
    expect(activeMenuKey('/settlements')).toBe('/settlements')
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

describe('system access boundary', () => {
  it('offers the real access page only to platform admins', () => {
    const page = findNavPage('/system/access')
    expect(page?.status).toBe('ready')
    expect(page?.roles).toEqual(['admin'])
    expect(page?.planned).toEqual([])
    expect(groupForPage('/system/access')?.label).toBe('系统管理')
    expect(activeMenuKey('/system/access')).toBe('/system/access')
    expect(filterNavigation('', 'admin').groups.flatMap((group) => group.pages.map((item) => item.key))).toContain('/system/access')
    expect(filterNavigation('', 'operator').groups.flatMap((group) => group.pages.map((item) => item.key))).not.toContain('/system/access')
  })
})
