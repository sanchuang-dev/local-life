import {
  isActivityId,
  participationInviteCodeSchema,
} from '@sanchuang-dev/local-life-contracts'
import {
  buildWechatLoginRequest,
  sanitizeReturnTo,
  type AppLocationSnapshot,
} from '../activity/loginReturn'

export interface ResidentLoginContext {
  activityId: string | null
  inviteCode: string | null
  inviteInvalid: boolean
}

/** The shared API allowlist is authoritative; invalid and /login targets fall back to /me. */
export function resolveResidentLoginTarget(raw: string | null | undefined): string {
  return sanitizeReturnTo(raw) ?? '/me'
}

function normalizeActivityId(raw: unknown): string | null {
  return isActivityId(raw) ? raw : null
}

function normalizeInvite(raw: unknown): string | null {
  const parsed = participationInviteCodeSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Build a same-origin entry link without allowing a login page to return to itself. */
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
  if (context.inviteInvalid || (context.inviteCode && !inviteCode)) {
    params.set('inviteInvalid', '1')
  }
  if (authErrorCode) params.set('auth_error', authErrorCode)
  return '/login?' + params.toString()
}

/** Build the OAuth request from the validated original route, never from /login itself. */
export function buildResidentWechatLoginRequest(options: {
  returnTo: string | null | undefined
  context: ResidentLoginContext
  baseUrl: string
  currentPathname: string
  now?: number
}): { url: string; context: ReturnType<typeof buildWechatLoginRequest>['context'] } {
  const returnTo = resolveResidentLoginTarget(options.returnTo)
  const target = new URL(returnTo, 'https://local-life.invalid')
  // Only explicit activity context is sent. A display default is never inferred.
  const activityId = normalizeActivityId(options.context.activityId || target.searchParams.get('activityId'))
  const rawInvite = options.context.inviteCode || target.searchParams.get('invite')
  const inviteCode = normalizeInvite(rawInvite)
  const inviteInvalid =
    options.context.inviteInvalid ||
    target.searchParams.get('inviteInvalid') === '1' ||
    Boolean(rawInvite && !inviteCode)

  const snapshot: AppLocationSnapshot =
    options.baseUrl === '/'
      ? {
          baseUrl: options.baseUrl,
          pathname: target.pathname,
          search: target.search,
          hash: target.hash,
        }
      : {
          baseUrl: options.baseUrl,
          pathname: options.currentPathname,
          search: '',
          hash: '#' + target.pathname + target.search + target.hash,
        }

  const request = buildWechatLoginRequest(
    snapshot,
    { activityId, inviteCode, inviteInvalid },
    options.now,
  )
  return { url: request.url, context: request.context }
}
