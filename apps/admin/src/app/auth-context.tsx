import { createContext, useContext, type ReactNode } from 'react'
import type { AuthenticatedSession } from '../services/auth'

export interface AdminAuthState {
  session: AuthenticatedSession
  busy: boolean
  error: string | null
  onLogout: () => Promise<void>
}

const AdminAuthContext = createContext<AdminAuthState | null>(null)

/** Real auth state lives above the route tree; the shell never invents it. */
export function AdminAuthProvider({
  value,
  children,
}: {
  value: AdminAuthState
  children: ReactNode
}) {
  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>
}

export function useAdminAuth(): AdminAuthState {
  const state = useContext(AdminAuthContext)
  if (!state) throw new Error('Admin routes require an authenticated staff session')
  return state
}
