/** Pure decision shared by the route guard and regression tests.
 * Only a positively confirmed session can render private UI. */
export type ResidentSessionStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error'
export type ResidentGateDecision = 'loading' | 'allow' | 'login' | 'error'

export function decideResidentGate(
  status: ResidentSessionStatus,
  hasSession: boolean,
): ResidentGateDecision {
  if (status === 'loading') return 'loading'
  if (status === 'error') return 'error'
  if (status === 'unauthenticated') return 'login'
  return hasSession ? 'allow' : 'login'
}
