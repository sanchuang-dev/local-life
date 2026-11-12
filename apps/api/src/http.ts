import type { Context } from 'hono'
import type { StaffRole } from '@sanchuang-dev/local-life-contracts'

/** Resolved server-side staff session. Never trust a client-supplied role. */
export interface AuthSession {
  sessionId: string
  userId: string
  displayName: string | null
  csrfHash: string
  expiresAt: Date
  staff: {
    id: string
    username: string
    role: StaffRole
    status: 'active' | 'disabled'
  } | null
}

export type AppBindings = {
  Variables: {
    requestId: string
    authSession: AuthSession | null
  }
}

export type AppContext = Context<AppBindings>

export type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503
