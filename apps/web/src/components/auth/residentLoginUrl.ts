import { isActivityId, participationInviteCodeSchema, validateReturnTo } from '@sanchuang-dev/local-life-contracts'

export interface ResidentLoginContext {
  activityId: string | null
  inviteCode: string | null
  inviteInvalid: boolean
}

/** Shared API return-target allowlist is authoritative for login redirects. */
export function resolveResidentLoginTarget(raw: string | null | undefined): string {
  const check = validateReturnTo(raw)
  return check.ok ? check.returnTo ?? '/me' : '/me'
}

export function normalizeActivityId(raw: unknown): string | null {
  return isActivityId(raw) ? raw : null
}

export function normalizeInvite(raw: unknown): string | null {
  const parsed = participationInviteCodeSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function buildResidentLoginHref(
  returnTo: string | null | undefined,
  context: ResidentLoginContext,
  authErrorCode: string | null = null,
): string {
  const params = new URLSearchParams({ next: resolveResidentLoginTarget(returnTo) })
  const activityId = normalizeActivityId(context.activityId)
  const inviteCode = normalizeInvite(context.inviteCode)
  if (activityId) params.set('activityId', activityId)
  if (inviteCode) params.set('invite', inviteCode)
  if (context.inviteInvalid || (context.inviteCode && !inviteCode)) params.set('inviteInvalid', '1')
  if (authErrorCode) params.set('auth_error', authErrorCode)
  return '/login?' + params.toString()
}
