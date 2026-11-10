import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { RequireResidentAuth } from './RequireResidentAuth'
import { isResidentGateExempt } from './residentGlobalGate'

/** All resident routes require a session; never intercept the login route itself. */
export function ResidentSiteGate({ children }: { children: ReactNode }) {
  const location = useLocation()
  if (isResidentGateExempt(location.pathname)) return <>{children}</>
  return <RequireResidentAuth>{children}</RequireResidentAuth>
}
