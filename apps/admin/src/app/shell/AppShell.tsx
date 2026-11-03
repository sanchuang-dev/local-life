import { LogoutOutlined, MoreOutlined } from '@ant-design/icons'
import { Alert, Button, Drawer, Dropdown, Layout, Tabs, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import {
  activeMenuKey,
  groupForPage,
  NAV_KEYS,
  pageForMenuKey,
} from './navigation'
import { useAdminAuth } from '../auth-context'
import { AppSidebar } from './AppSidebar'
import {
  addWorkTab,
  closeOtherWorkTabs,
  closeWorkTab,
  useWorkTabs,
} from '../../shared/lib/work-tabs'
import './shell.css'

const { Header, Content } = Layout

const COMPACT_NAV_MAX_WIDTH = 768

/**
 * Local Life AppShell.
 *
 * The URL is the only source of truth for the current page; the tab strip is a
 * projection of the router location plus sessionStorage-backed open tabs. There
 * is no parallel navigation state to drift out of sync with browser back/forward.
 */
export function AppShell() {
  const { session, busy, error, onLogout } = useAdminAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const activeKey = activeMenuKey(location.pathname)
  const activeGroup = activeKey ? groupForPage(activeKey) : undefined
  const activePage = activeKey ? pageForMenuKey(activeKey) : undefined
  const persistedTabs = useWorkTabs()
  const [compactNav, setCompactNav] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < COMPACT_NAV_MAX_WIDTH,
  )
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    const update = () => {
      const nextCompact = window.innerWidth < COMPACT_NAV_MAX_WIDTH
      setCompactNav(nextCompact)
      // Crossing back to the desktop layout must not leave a stale drawer open.
      if (!nextCompact) setNavOpen(false)
    }
    window.addEventListener('resize', update)
    update()
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => {
    if (activeKey && NAV_KEYS.has(activeKey)) addWorkTab(activeKey)
  }, [activeKey])

  // The strip always keeps 经营工作台, drops tabs for routes that no longer
  // exist and shows the current route even when the stored list was pruned.
  const knownTabs = persistedTabs.filter((key) => NAV_KEYS.has(key))
  const withHome = knownTabs.includes('/') ? knownTabs : ['/', ...knownTabs]
  const tabKeys =
    activeKey && NAV_KEYS.has(activeKey) && !withHome.includes(activeKey)
      ? [...withHome, activeKey]
      : withHome

  const tabItems = tabKeys.flatMap((key) => {
    const page = pageForMenuKey(key)
    return page ? [{ key, label: page.label, closable: key !== '/' }] : []
  })

  const closeTab = (key: string) => {
    if (key === '/') return
    const currentIndex = tabKeys.indexOf(key)
    closeWorkTab(key)
    if (key === activeKey) {
      const remaining = tabKeys.filter((tab) => tab !== key)
      const next = remaining[Math.min(Math.max(currentIndex, 0), remaining.length - 1)] ?? '/'
      navigate(next)
    }
  }

  const closeAllTabs = () => {
    closeOtherWorkTabs('/')
    if (activeKey !== '/') navigate('/')
  }

  const tabMenuItems = [
    {
      key: 'others',
      label: '关闭其他页签',
      disabled: tabKeys.length <= (activeKey === '/' ? 1 : 2),
    },
    {
      key: 'all',
      label: '关闭全部页签',
      disabled: tabKeys.length <= 1,
    },
  ]

  return (
    <Layout className="app-shell" hasSider={!compactNav}>
      {compactNav ? null : (
        <AppSidebar activeKey={activeKey} onNavigate={(key) => navigate(key)} />
      )}

      <Layout className="app-main">
        <Header className="app-header">
          {compactNav ? (
            <Button
              type="text"
              className="app-mobile-nav-trigger"
              aria-label="打开导航菜单"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <span className="app-mobile-nav-bars" aria-hidden="true" />
            </Button>
          ) : null}

          <div className="app-header-title">
            <Typography.Text type="secondary">{activeGroup?.label ?? '本地生活'}</Typography.Text>
            <span className="app-header-separator" aria-hidden="true">
              /
            </span>
            <Typography.Text strong>{activePage?.label ?? '页面不存在'}</Typography.Text>
          </div>

          <div className="app-header-actions">
            <Typography.Text className="app-identity-name" strong>
              {session.user.displayName || session.staff.username}
            </Typography.Text>
            <Tag color="green" className="app-identity-tag">
              {{ admin: '管理员', operator: '运营员', grid_worker: '网格员' }[session.staff.role]}
            </Tag>
            <Button
              type="text"
              size="small"
              icon={<LogoutOutlined />}
              aria-label="退出登录"
              loading={busy}
              onClick={() => void onLogout()}
            >
              退出登录
            </Button>
          </div>
        </Header>

        <nav className="app-tabs-bar" aria-label="已打开页面">
          <Tabs
            className="app-tabs"
            type="editable-card"
            size="small"
            hideAdd
            moreIcon={<MoreOutlined role="img" aria-label="更多页面" />}
            activeKey={activeKey}
            items={tabItems}
            onChange={(key) => navigate(key)}
            onEdit={(targetKey, action) => {
              if (action === 'remove' && typeof targetKey === 'string') closeTab(targetKey)
            }}
          />
          <Dropdown
            trigger={['click']}
            menu={{
              items: tabMenuItems,
              onClick: ({ key }) => {
                if (key === 'others') closeOtherWorkTabs(activeKey ?? '/')
                if (key === 'all') closeAllTabs()
              },
            }}
          >
            <Button
              className="app-tabs-menu"
              type="text"
              aria-label="页签操作"
              icon={<MoreOutlined />}
            />
          </Dropdown>
        </nav>

        <Content className="app-content">
          {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
          <Outlet />
        </Content>
      </Layout>

      {compactNav ? (
        <Drawer
          title="导航菜单"
          placement="left"
          size={280}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          styles={{ body: { padding: 0 } }}
          afterOpenChange={(open) => {
            if (!open) {
              document.querySelector<HTMLButtonElement>('.app-mobile-nav-trigger')?.focus()
            }
          }}
        >
          <AppSidebar
            variant="drawer"
            activeKey={activeKey}
            onNavigate={(key) => {
              navigate(key)
              setNavOpen(false)
            }}
          />
        </Drawer>
      ) : null}
    </Layout>
  )
}
