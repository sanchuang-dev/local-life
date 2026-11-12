import {
  WECHAT_OAUTH_CALLBACK_PATH,
  validateReturnTo,
} from '@sanchuang-dev/local-life-contracts'
import { constantTimeTextEqual } from './security.js'

/**
 * Return-to handling for the WeChat OAuth start/callback pair (#92).
 *
 * The resident H5 must land back on the activity (or `/#/` legacy equivalent)
 * it started from, with `activityId` / `invite` intact. Three invariants:
 *
 * 1. The only accepted target is a same-origin resident path from the shared
 *    allowlist in `@sanchuang-dev/local-life-contracts`. Invalid input fails the
 *    `start` request with 400 instead of being silently dropped, so a caller can
 *    never mistake "login worked, return ignored" for success.
 * 2. The accepted target is bound to exactly one OAuth attempt. It travels in a
 *    short-lived HttpOnly cookie whose value is prefixed with that attempt's
 *    one-time `state` token; the callback only honours the cookie when the
 *    prefix matches the presented, nonce-verified state. This keeps `state`
 *    itself inside WeChat's 128-byte limit (no payload smuggling in the query).
 * 3. Every callback failure path re-validates the target and falls back to the
 *    default `/me` landing page, so neither a tampered cookie nor a stale one can
 *    turn the callback into an open redirect.
 */

export const OAUTH_RETURN_COOKIE = 'll_oauth_return'

/** Must match the nonce cookie path: the browser calls `/api/auth/wechat/*`. */
export const OAUTH_RETURN_COOKIE_PATH = '/'

/** One authorization attempt lives at most ten minutes. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60

/**
 * The WeChat OAuth callback URL is derived, never configured (#113).
 *
 * The public-account admin page shows this exact value read-only, and the start
 * request must send the same one to WeChat. Deriving it from `WEB_BASE_URL`'s
 * origin keeps the API's own callback, the value registered in the WeChat
 * console and the value shown to the administrator in sync; the path half is
 * the shared `WECHAT_OAUTH_CALLBACK_PATH` constant. A legacy
 * `WECHAT_REDIRECT_URI` is ignored, so the two can never disagree.
 */
export function wechatCallbackUrl(webBaseUrl: string): string {
  return new URL(WECHAT_OAUTH_CALLBACK_PATH, new URL(webBaseUrl).origin).toString()
}

export type ResolvedReturnTo =
  | { ok: true; returnTo: string | null }
  | { ok: false }

/** Validate a query-string target against the API's own web origin. */
export function resolveReturnTo(raw: unknown, webBaseUrl: string): ResolvedReturnTo {
  const validation = validateReturnTo(raw)
  if (!validation.ok) return { ok: false }
  if (!validation.returnTo) return { ok: true, returnTo: null }

  // The shared rules are string-level; resolve once here (Node has `URL`) so
  // origin equality and a fragment-less, already-normalised value are the
  // authority before anything is stored in the attempt cookie.
  let origin: string
  let target: URL
  try {
    origin = new URL(webBaseUrl).origin
    target = new URL(validation.returnTo, origin)
  } catch {
    return { ok: false }
  }
  if (target.origin !== origin || target.hash) return { ok: false }
  return { ok: true, returnTo: `${target.pathname}${target.search}` }
}

/**
 * Cookie value binding one validated target to one state token. `state` is a
 * base64url random token, so it can never contain the `.` separator.
 */
export function bindReturnToCookie(state: string, returnTo: string | null): string | null {
  if (!returnTo) return null
  return `${state}.${Buffer.from(returnTo, 'utf8').toString('base64url')}`
}

/**
 * Read the bound target only when the cookie belongs to the presented state,
 * and only when it still passes the allowlist. Returns `null` otherwise, which
 * makes the caller fall back to its default destination.
 */
export function readBoundReturnTo(
  cookieValue: string | undefined,
  state: string | null,
  webBaseUrl: string,
): string | null {
  if (!cookieValue || !state) return null
  const separator = cookieValue.indexOf('.')
  if (separator <= 0) return null
  if (!constantTimeTextEqual(cookieValue.slice(0, separator), state)) return null

  let decoded: string
  try {
    decoded = Buffer.from(cookieValue.slice(separator + 1), 'base64url').toString('utf8')
  } catch {
    return null
  }
  const resolved = resolveReturnTo(decoded, webBaseUrl)
  return resolved.ok ? resolved.returnTo : null
}

/**
 * Final callback destination.
 *
 * With a validated target the resident returns to that route; the auth result is
 * merged into its existing query string so `activityId` / `invite` survive. The
 * online MVP build uses clean history paths (`BrowserRouter`), while the GitHub
 * Pages preview keeps the route in the hash (`HashRouter`) — the base path of
 * `WEB_BASE_URL` decides which shape is correct. Without a target we keep the
 * historical `/me` landing page byte-identical to the previous behaviour.
 *
 * A clean-path target ends with an explicit empty fragment (`#`). WeChat's
 * authorize endpoint appends `#wechat_redirect` to the URL it returns the
 * browser to, and a redirect whose `Location` has no fragment keeps the previous
 * fragment (RFC 9110 §10.2.2; the Fetch standard's redirect step copies it).
 * Without this the resident would keep `#wechat_redirect` in the address bar on
 * the clean-path build. An explicit, empty fragment replaces it. Hash-mode
 * targets already carry `#/…`, so they are unaffected.
 */
export function oauthResultDestination(
  webBaseUrl: string,
  result: string,
  returnTo: string | null,
): string {
  const base = new URL(webBaseUrl)
  const success = result === 'success'
  const paramName = success ? 'auth' : 'auth_error'
  const paramValue = success ? 'success' : result

  if (returnTo) {
    const target = new URL(returnTo, base.origin)
    target.searchParams.set(paramName, paramValue)
    const route = `${target.pathname}${target.search}`
    return base.pathname === '/'
      ? `${base.origin}${route}#`
      : `${base.origin}${base.pathname}#${route}`
  }

  // The default landing page must also respect the deployed router. A hash
  // fallback on BrowserRouter would silently land at '/' instead of '/me'.
  const fallback = new URL('/me', base.origin)
  fallback.searchParams.set(paramName, paramValue)
  return base.pathname === '/'
    ? `${fallback.toString()}#`
    : `${base.origin}${base.pathname}#${fallback.pathname}${fallback.search}`
}


/**
 * Profile authorization is a distinct user-consent result, not a login result.
 * It shares the same validated return target and router-mode handling.
 */
export function wechatProfileResultDestination(
  webBaseUrl: string,
  result: string,
  returnTo: string | null,
): string {
  const base = new URL(webBaseUrl)
  if (returnTo) {
    const target = new URL(returnTo, base.origin)
    target.searchParams.set('wechat_profile', result)
    const route = `${target.pathname}${target.search}`
    return base.pathname === '/'
      ? `${base.origin}${route}#`
      : `${base.origin}${base.pathname}#${route}`
  }

  const fallback = new URL('/me', base.origin)
  fallback.searchParams.set('wechat_profile', result)
  return base.pathname === '/'
    ? `${fallback.toString()}#`
    : `${base.origin}${base.pathname}#${fallback.pathname}${fallback.search}`
}
