import type { StaffRole } from '@sanchuang-dev/local-life-contracts'

export interface NavPage {
  readonly key: string
  readonly label: string
  readonly description: string
  /** `planned` pages render an explicit 待建设 state instead of business UI. */
  readonly status: 'ready' | 'planned'
  readonly planned: readonly string[]
  /**
   * Staff roles allowed to see this destination. Omitted means every staff role.
   * Hiding a menu item is presentation only: the API still authorises every
   * request, so a grid worker receives a real 403 even from a direct URL.
   */
  readonly roles?: readonly StaffRole[]
}

export type NavIconKey = 'workbench' | 'campaign' | 'customer' | 'commerce' | 'performance' | 'system'

export interface NavGroup {
  readonly key: string
  readonly label: string
  readonly icon: NavIconKey
  readonly pages: readonly NavPage[]
}

export const HOME_PAGE: NavPage = {
  key: '/',
  label: '经营工作台',
  description: '本地生活管理后台的统一工作面：查看当前真实可用能力与待建设模块。',
  status: 'ready',
  planned: [],
}

/**
 * Local Life information architecture. Only pages backed by real code are
 * `ready`; every other destination opens the shared 待建设 state with the
 * follow-up Issue scope written down. Nothing here renders invented data.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'campaign',
    label: '活动运营',
    icon: 'campaign',
    pages: [
      {
        key: '/activities',
        label: '活动管理',
        description: '创建、配置、发布活动，并让居民 H5 读取真实活动数据。',
        status: 'ready',
        planned: [],
        roles: ['admin', 'operator'],
      },
      {
        key: '/activities/checkin',
        label: '报名与核销',
        description: '签到、福利核销凭据、库存与预算控制。',
        status: 'planned',
        planned: ['核销凭据与库存', '预算与重复兑现校验', '核销记录查询'],
        roles: ['admin', 'operator'],
      },
    ],
  },
  {
    key: 'customer',
    label: '客户与网格',
    icon: 'customer',
    pages: [
      {
        key: '/customers',
        label: '居民与客户',
        description: '社区居民与客户线索视图，按当前账号的辖区范围读取。',
        status: 'planned',
        planned: ['居民列表与筛选', '客户线索与归属', '跟进记录'],
      },
      {
        key: '/communities',
        label: '账户与社区',
        description: '真实社区、后台账户与当前账号可访问的居民列表。',
        status: 'ready',
        planned: [],
      },
    ],
  },
  {
    key: 'commerce',
    label: '商品与订单',
    icon: 'commerce',
    pages: [
      {
        key: '/products',
        label: '商品管理',
        description: '商城商品展示，以及商品与平台身份的关联。',
        status: 'planned',
        planned: ['商品同步与上下架', '身份关联', '订单来源回流'],
      },
      {
        key: '/orders',
        label: '订单管理',
        description: '订单查询、来源与售后状态。',
        status: 'planned',
        planned: ['订单列表与筛选', '来源与归属', '售后状态'],
      },
    ],
  },
  {
    key: 'performance',
    label: '业绩与对账',
    icon: 'performance',
    pages: [
      {
        key: '/performance',
        label: '业绩看板',
        description: '网格员业绩、奖励成本与运营指标。',
        status: 'planned',
        planned: ['网格员业绩', '奖励成本', '运营指标'],
      },
      {
        key: '/settlements',
        label: '对账结算',
        description: '结算单生成、导出与对账差异。',
        status: 'planned',
        planned: ['结算单导出', '对账差异', '操作留痕'],
      },
    ],
  },
  {
    key: 'system',
    label: '系统管理',
    icon: 'system',
    pages: [
      {
        key: '/system/access',
        label: '管理员与权限',
        description: '管理员、运营员、网格员账号及社区范围；依赖 #58 身份与权限能力。',
        status: 'planned',
        planned: ['账号管理', '角色与社区范围', '操作审计'],
      },
      {
        key: '/system/runtime',
        label: '系统信息',
        description: '当前 API 健康检查与连接状态。',
        status: 'ready',
        planned: [],
      },
      {
        key: '/system/components',
        label: '界面组件',
        description: 'DataPanel 数据面板的开发预览与组件验收场景。',
        status: 'ready',
        planned: [],
      },
    ],
  },
]

export const HOME_ICON: NavIconKey = 'workbench'

export const NAV_PAGES: readonly NavPage[] = [
  HOME_PAGE,
  ...NAV_GROUPS.flatMap((group) => group.pages),
]

export const NAV_KEYS: ReadonlySet<string> = new Set(NAV_PAGES.map((page) => page.key))

/** Finds the navigation entry that owns a pathname, longest prefix first. */
export function findNavPage(pathname: string): NavPage | undefined {
  if (pathname === '/') return HOME_PAGE
  const candidates = NAV_PAGES.filter(
    (page) => page.key !== '/' && (pathname === page.key || pathname.startsWith(`${page.key}/`)),
  )
  return candidates.sort((left, right) => right.key.length - left.key.length)[0]
}

/**
 * Resolves the selected menu key for a location. Unknown routes intentionally
 * return `undefined` so the shell does not pretend a retired URL belongs to a
 * real module.
 */
export function activeMenuKey(pathname: string): string | undefined {
  return findNavPage(pathname)?.key
}

export function groupForPage(pageKey: string): NavGroup | undefined {
  return NAV_GROUPS.find((group) => group.pages.some((page) => page.key === pageKey))
}

/** Lookup used by the work-tab strip; unknown persisted keys are dropped. */
export function pageForMenuKey(menuKey: string): NavPage | undefined {
  return NAV_PAGES.find((page) => page.key === menuKey)
}

export interface NavigationFilter {
  /** 经营工作台 is a top-level item rather than a group, matched separately. */
  readonly showHome: boolean
  readonly groups: readonly NavGroup[]
}

/**
 * Narrows the navigation to matching page labels. A group-label hit keeps all
 * of its pages; an empty query returns the untouched model. When a staff role is
 * supplied, destinations that role may not use are removed — the API still
 * enforces the same boundary.
 */
export function filterNavigation(query: string, role?: StaffRole): NavigationFilter {
  const normalized = query.trim().toLowerCase()
  if (!normalized && !role) return { showHome: true, groups: NAV_GROUPS }

  const visible = (page: NavPage) => isPageVisible(page, role)

  return {
    showHome: visible(HOME_PAGE) && (!normalized || HOME_PAGE.label.toLowerCase().includes(normalized)),
    groups: NAV_GROUPS.flatMap((group) => {
      const pages = group.pages.filter(visible)
      if (pages.length === 0) return []
      if (!normalized || group.label.toLowerCase().includes(normalized)) {
        return [{ ...group, pages }]
      }
      const matched = pages.filter((page) => page.label.toLowerCase().includes(normalized))
      return matched.length > 0 ? [{ ...group, pages: matched }] : []
    }),
  }
}

/** Role gate shared by the sidebar, the work-tab strip and route-level notices. */
export function isPageVisible(page: NavPage, role?: StaffRole): boolean {
  return !role || !page.roles || page.roles.includes(role)
}
