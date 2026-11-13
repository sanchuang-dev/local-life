import { useEffect, useRef, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { presentLoginMarker, stripLoginResultParams } from '@sanchuang-dev/local-life-contracts'
import {
  activityLoginMarker,
  appRouteFromLocation,
  browserLocation,
  clearActivityLoginContext,
  parseActivityLoginResult,
  readActivityLoginResult,
  routeQuery,
  routeToLocation,
  type ActivityLoginResult,
} from './loginReturn'

type CleanupProps = {
  /** Server-confirmed session (`GET /auth/session`), never the URL marker. */
  authenticated: boolean
  loading: boolean
}

/**
 * Page-level owner of the one-off `auth` / `auth_error` markers (#92).
 *
 * Mounted once by the activity page, outside every auth branch, because the
 * markers used to be cleaned up by the unauthenticated login card: after a
 * successful login that card unmounts, so the address bar kept `?auth=success`
 * and copying the URL to another browser showed "微信登录成功" without a session.
 *
 * Two invariants:
 * - the markers are removed after the first read, so a refresh or a shared link
 *   cannot replay a stale result banner;
 * - the stored pre-login context is only dropped once the server confirms the
 *   session, so a session-less `?auth=success` never counts as a login.
 */
export function ActivityLoginMarkerCleanup({ authenticated, loading }: CleanupProps) {
  const [marker] = useState(() => activityLoginMarker(readActivityLoginResult()))
  const strippedRef = useRef(false)

  useEffect(() => {
    if (strippedRef.current) return
    strippedRef.current = true
    const location = browserLocation()
    const route = appRouteFromLocation(location)
    if (!parseActivityLoginResult(routeQuery(route))) return
    window.history.replaceState(
      window.history.state,
      '',
      routeToLocation(location, stripLoginResultParams(route)),
    )
  }, [])

  useEffect(() => {
    if (marker !== 'success' || loading || !authenticated) return
    clearActivityLoginContext()
  }, [marker, loading, authenticated])

  return null
}

/**
 * Success notice for a completed WeChat login.
 *
 * Rendered from the authenticated branch, and gated again by the shared rule in
 * `presentLoginMarker`: `?auth=success` is client-visible input, so without a
 * server-confirmed session no success text is shown anywhere.
 */
export function ActivityLoginSuccessNotice({
  result,
  authenticated,
}: {
  /** Marker snapshot captured by the page before the cleanup strips the URL. */
  result: ActivityLoginResult
  authenticated: boolean
}) {
  if (presentLoginMarker(activityLoginMarker(result), authenticated, false) !== 'success') {
    return null
  }

  return (
    <p
      role="status"
      className="mt-3 flex items-start gap-2 rounded-xl bg-[#eef7f2] px-3 py-2.5 text-[12px] leading-5 text-[#1f6b51]"
    >
      <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">微信登录成功。页面不会自动报名，参与仍需你在下方主动确认。</span>
    </p>
  )
}
