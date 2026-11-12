import type { ReactNode } from 'react'
import { StaffSessionContext, type StaffSessionValue } from '../../hooks/useStaffSession'

/** Shares one real `/auth/session` read with every page under the workbench. */
export function StaffSessionProvider({
  value,
  children,
}: {
  value: StaffSessionValue
  children: ReactNode
}) {
  return <StaffSessionContext.Provider value={value}>{children}</StaffSessionContext.Provider>
}
