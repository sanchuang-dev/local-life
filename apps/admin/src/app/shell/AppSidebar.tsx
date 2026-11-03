import { MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined } from '@ant-design/icons'
import { Empty, Input, Layout, Menu } from 'antd'
import type { MenuProps } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import {
  filterNavigation,
  HOME_ICON,
  HOME_PAGE,
  NAV_GROUPS,
  type NavGroup,
} from './navigation'
import './sidebar.css'

const { Sider } = Layout

type MenuItems = NonNullable<MenuProps['items']>

interface AppSidebarProps {
  /** Menu key of the current route, resolved by `activeMenuKey()`. */
  activeKey?: string
  onNavigate: (key: string) => void
  variant?: 'sider' | 'drawer'
}

function isPlanned(pageKey: string) {
  return NAV_GROUPS.some((group) =>
    group.pages.some((page) => page.key === pageKey && page.status === 'planned'),
  )
}

function pendingMarker(pageKey: string) {
  return isPlanned(pageKey) ? <span className="app-nav-pending" aria-hidden="true" /> : null
}

function pageLabel(label: string, pageKey: string) {
  return (
    <span className="app-nav-label">
      {label}
      {pendingMarker(pageKey)}
    </span>
  )
}

function buildMenuItems(groups: readonly NavGroup[]): MenuItems {
  return groups.map((group) => ({
    key: group.key,
    icon: group.icon,
    label: group.label,
    children: group.pages.map((page) => ({
      key: page.key,
      label: pageLabel(page.label, page.key),
      title: isPlanned(page.key) ? `${page.label}（待建设）` : page.label,
    })),
  }))
}

/**
 * Sidebar shell: brand, menu search and the Ant Design Menu. Search only
 * narrows what is visible; routes, work tabs and page data stay untouched.
 */
export function AppSidebar({ activeKey, onNavigate, variant = 'sider' }: AppSidebarProps) {
  const [query, setQuery] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<string[]>(() =>
    NAV_GROUPS.map((group) => group.key),
  )
  const [collapsed, setCollapsed] = useState(false)
  const isDrawer = variant === 'drawer'
  const isCollapsed = !isDrawer && collapsed

  const trimmedQuery = query.trim()
  const searching = trimmedQuery.length > 0
  const { showHome, groups: visibleGroups } = useMemo(
    () => filterNavigation(trimmedQuery),
    [trimmedQuery],
  )

  const items = useMemo<MenuItems>(() => {
    const homeItem = {
      key: HOME_PAGE.key,
      icon: HOME_ICON,
      label: HOME_PAGE.label,
    }
    return showHome
      ? [homeItem, ...buildMenuItems(visibleGroups)]
      : [...buildMenuItems(visibleGroups)]
  }, [showHome, visibleGroups])

  // Deep links and browser history must reveal the selected group even if the
  // operator had collapsed it earlier.
  useEffect(() => {
    if (!activeKey) return
    const parent = NAV_GROUPS.find((group) => group.pages.some((page) => page.key === activeKey))
    if (!parent) return
    setExpandedGroups((current) =>
      current.includes(parent.key) ? current : [...current, parent.key],
    )
  }, [activeKey])

  // While searching, every group that still has a hit is expanded; clearing the
  // query restores the operator's own expansion state.
  const openKeys = searching
    ? visibleGroups.map((group) => group.key)
    : isCollapsed
      ? undefined
      : expandedGroups

  const navigation = (
    <>
      <div className={`app-brand${isCollapsed ? ' app-brand-collapsed' : ''}`}>
        <span className="app-brand-mark" aria-hidden="true">
          生
        </span>
        <span className="app-brand-text">
          <span className="app-brand-name">本地生活</span>
          <span className="app-brand-sub">管理台</span>
        </span>
        {isDrawer ? null : (
          <button
            type="button"
            className="app-sidebar-toggle"
            aria-label={isCollapsed ? '展开侧边栏' : '收起侧边栏'}
            aria-expanded={!isCollapsed}
            onClick={() => {
              setCollapsed((value) => !value)
              setQuery('')
            }}
          >
            {isCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
        )}
      </div>

      {isCollapsed ? null : (
        <div className="app-sidebar-search">
          <Input
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索菜单"
            aria-label="搜索菜单"
            autoComplete="off"
            prefix={<SearchOutlined />}
          />
        </div>
      )}

      <nav aria-label="主导航">
        {items.length === 0 ? (
          <Empty
            className="app-sidebar-empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="未找到匹配的菜单"
          />
        ) : (
          <Menu
            className="app-nav"
            mode="inline"
            theme="light"
            selectedKeys={activeKey ? [activeKey] : []}
            items={items}
            openKeys={openKeys}
            onOpenChange={(keys) => {
              if (!searching) setExpandedGroups(keys)
            }}
            inlineCollapsed={isCollapsed}
            onClick={({ key }) => onNavigate(key)}
          />
        )}
      </nav>
    </>
  )

  if (isDrawer) return <div className="app-sidebar-drawer">{navigation}</div>

  return (
    <Sider
      className="app-sider"
      theme="light"
      width={248}
      collapsedWidth={68}
      collapsed={collapsed}
      trigger={null}
      breakpoint="lg"
      onBreakpoint={setCollapsed}
    >
      {navigation}
    </Sider>
  )
}
