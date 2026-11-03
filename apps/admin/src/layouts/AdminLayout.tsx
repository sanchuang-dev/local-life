import { AppShell } from '../app/shell/AppShell'

/**
 * Route-table layout entry. Session resolution and the authenticated route
 * guard belong to #58; this branch deliberately does not invent a login state.
 */
export function AdminLayout() {
  return <AppShell />
}
