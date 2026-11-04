import { Navigate, type RouteObject } from 'react-router'
import { useAdminAuth } from './auth-context'
import { AdminLayout } from '../layouts/AdminLayout'
import { ActivitiesPage } from '../pages/ActivitiesPage'
import { ComponentPreviewPage } from '../pages/ComponentPreviewPage'
import { CrmPage } from '../pages/CrmPage'
import { DashboardPage } from '../pages/DashboardPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { PlaceholderPage } from '../pages/PlaceholderPage'
import { UsersPage } from '../pages/UsersPage'
import { SystemInfoPage } from '../pages/SystemInfoPage'
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
      { path: 'customers', element: <CrmPage /> },
      { path: 'communities', element: <CommunityAccountsRoute /> },
      { path: 'system/runtime', element: <SystemInfoPage /> },
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
