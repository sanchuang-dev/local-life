import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { RequireResidentAuth } from './RequireResidentAuth'

/** Staff have a separate session and login; resident /login must remain reachable. */
export function isResidentGateExempt(pathname: string): boolean {
  return pathname === '/login' || pathname === '/workbench' || pathname.startsWith('/workbench/')
}

/** All resident routes require a session; never intercept the login route itself. */
export function ResidentSiteGate({ children }: { children: ReactNode }) {
  const location = useLocation()
  if (isResidentGateExempt(location.pathname)) return <>{children}</>
  return <RequireResidentAuth>{children}</RequireResidentAuth>
}
