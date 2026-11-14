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
        description: '真实签到核验、团队奖励资格、奖品库存与预算、一次性核销凭据与争议审计。',
        status: 'ready',
        planned: [],
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
        label: '客户与业务单',
        description:
          '按授权社区与网格员查询客户线索、跟进与广电业务受理单，并对人工核验的成交做审核。',
        status: 'ready',
        planned: [],
        roles: ['admin', 'operator'],
      },
      {
        key: '/users',
        label: '用户管理',
        description:
          '平台全部用户目录：按权限范围检索、筛选并查看只读详情；未关联社区的账号也在这里。',
        status: 'ready',
        planned: [],
      },
      {
        key: '/communities',
        label: '社区管理',
        description: '创建社区、维护服务点位置，并关联系统中已有的运营员和网格员。',
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
        description: '本社区本地商品的创建、编辑与上下架；居民 H5「惠生活」读取同一份上架目录。',
        status: 'ready',
        planned: [],
        roles: ['admin', 'operator'],
      },
      {
        key: '/external-offers',
        label: '精选优惠',
        description: '第三方活动链接维护与启停，不承担发券、支付或核销。',
        status: 'ready',
        planned: [],
        roles: ['admin', 'operator'],
      },
      {
        key: '/orders',
        label: '订单管理',
        description: '居民登记订单的查询、状态处理与运营人工核验；按授权社区过滤，核验只是人工事实确认。',
        status: 'ready',
        planned: [],
        roles: ['admin', 'operator'],
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
        description:
          '统一经营流水总览：登记金额、已核验业绩、人工实收与冲正、奖励成本与冲正分列展示账面毛额，附服务端聚合的明细筛选。',
        status: 'ready',
        planned: [],
        roles: ['admin', 'operator'],
      },
      {
        key: '/reconciliation',
        label: '经营对账',
        description: '按业务日期间创建并锁定对账批次、核对差异与锁后补录，导出带审计的账面明细 CSV。',
        status: 'ready',
        planned: [],
        roles: ['admin', 'operator'],
      },
      {
        key: '/settlements',
        label: '分成结算',
        description: '候选看板、主体目录、商户映射、合同规则、服务端试算与结算单。',
        status: 'ready',
        planned: [],
        roles: ['admin', 'operator'],
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
        description: '管理后台账号、角色与社区授权。新建账户在这里，已有账号可在社区管理中关联。',
        status: 'ready',
        planned: [],
        roles: ['admin'],
      },
      {
        key: '/system/runtime',
        label: '系统信息',
        description: '当前 API 健康检查与连接状态。',
        status: 'ready',
        planned: [],
      },
      {
        key: '/system/integrations',
        label: '第三方配置',
        description: '统一管理微信公众号与腾讯地图的配置、连接状态和服务凭证。',
        status: 'ready',
        planned: [],
        roles: ['admin'],
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
