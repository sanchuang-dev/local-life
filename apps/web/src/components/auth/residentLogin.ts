import { buildWechatLoginRequest, type AppLocationSnapshot } from '../activity/loginReturn'
import {
  normalizeActivityId,
  normalizeInvite,
  resolveResidentLoginTarget,
  type ResidentLoginContext,
} from './residentLoginUrl'

export { resolveResidentLoginTarget, buildResidentLoginHref } from './residentLoginUrl'
export type { ResidentLoginContext } from './residentLoginUrl'

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
