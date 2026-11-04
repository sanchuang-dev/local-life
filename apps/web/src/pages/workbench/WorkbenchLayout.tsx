import { Outlet } from 'react-router'
import { useStaffSessionController } from '../../hooks/useStaffSession'
import { StaffSessionProvider } from '../../components/crm/StaffSessionProvider'

/**
 * Shared staff-session context for every `/workbench` page. The provider reads
 * `/auth/session` once so nested pages do not each invent their own identity.
 */
export function WorkbenchLayout() {
  const session = useStaffSessionController()
  return (
    <StaffSessionProvider value={session}>
      <Outlet />
    </StaffSessionProvider>
  )
}
