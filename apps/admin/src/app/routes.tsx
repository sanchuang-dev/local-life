import type { RouteObject } from 'react-router'
import { useAdminAuth } from './auth-context'
import { AdminLayout } from '../layouts/AdminLayout'
import { ActivitiesPage } from '../pages/ActivitiesPage'
import { ActivityCheckinPage } from '../pages/ActivityCheckinPage'
import { CommunitiesPage } from '../pages/CommunitiesPage'
import { StaffAccessPage } from '../pages/StaffAccessPage'
import { ComponentPreviewPage } from '../pages/ComponentPreviewPage'
import { CrmPage } from '../pages/CrmPage'
import { DashboardPage } from '../pages/DashboardPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { LedgerPage } from '../pages/LedgerPage'
import { OrdersPage } from '../pages/OrdersPage'
import { PerformancePage } from '../pages/PerformancePage'
import { PlaceholderPage } from '../pages/PlaceholderPage'
import { ProductsPage } from '../pages/ProductsPage'
import { ExternalOffersPage } from '../pages/ExternalOffersPage'
import { SettlementsPage } from '../pages/SettlementsPage'
import { ReconciliationPage } from '../pages/ReconciliationPage'
import { UsersPage } from '../pages/UsersPage'
import { SystemInfoPage } from '../pages/SystemInfoPage'
import { WechatSettingsPage } from '../pages/WechatSettingsPage'
import { TencentMapSettingsPage } from '../pages/TencentMapSettingsPage'
import { ThirdPartySettingsPage } from '../pages/ThirdPartySettingsPage'
import { NAV_PAGES } from './shell/navigation'

const PLANNED_PAGES = NAV_PAGES.filter((page) => page.status === 'planned')

function CommunitiesRoute() {
  const { session } = useAdminAuth()
  return <CommunitiesPage session={session} />
}

function StaffAccessRoute() {
  const { session } = useAdminAuth()
  return <StaffAccessPage session={session} />
}

function UsersRoute() {
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
      { path: 'external-offers', element: <ExternalOffersPage /> },
      { path: 'orders', element: <OrdersPage /> },
      { path: 'performance', element: <PerformancePage /> },
      { path: 'performance/ledger', element: <LedgerPage /> },
      { path: 'reconciliation', element: <ReconciliationPage /> },
      { path: 'settlements', element: <SettlementsPage /> },
      { path: 'communities', element: <CommunitiesRoute /> },
      { path: 'system/access', element: <StaffAccessRoute /> },
      { path: 'system/runtime', element: <SystemInfoPage /> },
      { path: 'system/integrations', element: <ThirdPartySettingsPage /> },
      // Compatibility deep links remain valid; only the unified settings page
      // appears in navigation. Legacy pages still use the original secure flows.
      { path: 'system/wechat', element: <WechatSettingsPage /> },
      { path: 'system/tencent-map', element: <TencentMapSettingsPage /> },
      { path: 'users', element: <UsersRoute /> },
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
