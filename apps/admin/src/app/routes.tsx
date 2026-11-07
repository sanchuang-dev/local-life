import { Navigate, type RouteObject } from 'react-router'
import { useAdminAuth } from './auth-context'
import { AdminLayout } from '../layouts/AdminLayout'
import { ActivitiesPage } from '../pages/ActivitiesPage'
import { ActivityCheckinPage } from '../pages/ActivityCheckinPage'
import { ComponentPreviewPage } from '../pages/ComponentPreviewPage'
import { CrmPage } from '../pages/CrmPage'
import { DashboardPage } from '../pages/DashboardPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { OrdersPage } from '../pages/OrdersPage'
import { PerformancePage } from '../pages/PerformancePage'
import { PlaceholderPage } from '../pages/PlaceholderPage'
import { ProductsPage } from '../pages/ProductsPage'
import { SettlementsPage } from '../pages/SettlementsPage'
import { UsersPage } from '../pages/UsersPage'
import { SystemInfoPage } from '../pages/SystemInfoPage'
import { WechatSettingsPage } from '../pages/WechatSettingsPage'
import { NAV_PAGES } from './shell/navigation'

const PLANNED_PAGES = NAV_PAGES.filter((page) => page.status === 'planned')

function CommunityAccountsRoute() {
  const { session } = useAdminAuth()
  return <UsersPage session={session} />
}

/**
 * Route table and navigation model describe the same destinations; planned
 * pages render the shared 待建设 state instead of invented business UI.
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AdminLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'activities', element: <ActivitiesPage /> },
      { path: 'activities/checkin', element: <ActivityCheckinPage /> },
      { path: 'customers', element: <CrmPage /> },
      { path: 'products', element: <ProductsPage /> },
      { path: 'orders', element: <OrdersPage /> },
      { path: 'performance', element: <PerformancePage /> },
      { path: 'settlements', element: <SettlementsPage /> },
      { path: 'communities', element: <CommunityAccountsRoute /> },
      { path: 'system/runtime', element: <SystemInfoPage /> },
      { path: 'system/wechat', element: <WechatSettingsPage /> },
      { path: 'users', element: <Navigate to='/communities' replace /> },
      { path: 'system/components', element: <ComponentPreviewPage /> },
      ...PLANNED_PAGES.map((page) => ({
        path: page.key.replace(/^\//, ''),
        element: (
          <PlaceholderPage
            title={page.label}
            description={page.description}
            planned={page.planned}
          />
        ),
      })),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]
