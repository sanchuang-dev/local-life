import {
  API_ROUTES,
  buildWechatStartQuery,
  isActivityId,
  participationInviteCodeSchema,
  stripLoginResultParams,
  validateReturnTo,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Helpers for the resident WeChat login return path (#92).
 *
 * The pure route/context functions are free of React and of the DOM so the API
 * tests can exercise the same rules (the return-target allowlist lives in the
 * contracts package, shared with the API). Responsibilities:
 *
 * - read the current in-app route in both router modes (online clean-path
 *   `BrowserRouter` and the GitHub Pages `HashRouter` preview);
 * - normalise an old `/#/community/activity/...?invite=...` share link into the
 *   equivalent clean route before the app boots, without losing its query;
 * - remember the pre-login activity context — `activityId`, the `invite` code
 *   (the activity's only invitation/promotion source token) and the validated
 *   same-origin return target — in `sessionStorage`, as *UX context only*.
 *   Attribution is never derived from it: the API resolves the resident from the
 *   session cookie and validates the invite code it receives on the explicit
 *   participation confirm, so a rewritten storage entry cannot claim a referral;
 * - parse the `auth` / `auth_error` markers the OAuth callback appends to the
 *   returned URL.
 */

export const ACTIVITY_LOGIN_CONTEXT_KEY = 'll.activity-login-context.v1'

/** The H5 talks to the API through the same-origin `/api` prefix. */
export const API_PREFIX = '/api'

/** A pending context older than this is stale and must not be replayed. */
export const ACTIVITY_LOGIN_CONTEXT_TTL_MS = 30 * 60 * 1000

export interface AppLocationSnapshot {
  /** `import.meta.env.BASE_URL`: `/` for the online MVP, `/local-life/` for Pages. */
  baseUrl: string
  pathname: string
  search: string
  hash: string
}

export interface CleanRoute {
  pathname: string
  search: string
  hash: string
}

export interface ActivityLoginContext {
  activityId: string | null
  inviteCode: string | null
  inviteInvalid: boolean
  /** Validated same-origin return target, or `null` when the page is not one. */
  returnTo: string | null
  savedAt: number
}

export type ActivityLoginResult =
  | { status: 'success' }
  | { status: 'error'; code: string; message: string }
  | null

/**
 * Resident-readable text for the pre-login `/auth/methods` availability reason.
 *
 * `wechatUnavailableReason` is a machine reason, not user copy: rendering it
 * directly would show `wechat_config_unavailable` to the resident. Known reasons
 * get an actionable message; anything else (a future/unknown code) falls back to
 * a generic sentence and never echoes the raw value, a secret, a token or an
 * internal stack.
 */
export function wechatUnavailableMessage(reason: string | null | undefined): string {
  switch (reason) {
    case 'not_configured':
      return '微信网页授权暂不可用：未配置公众号 AppID / AppSecret 或授权回调地址，请联系运营人员完成配置后重试。'
    case 'wechat_config_unavailable':
      return '微信登录配置当前不可用（主密钥未配置、配置无法解密或已停用），请联系管理员在后台「系统管理 → 微信公众号」重新保存并启用。'
    default:
      return '微信登录暂不可用，请稍后重试。'
  }
}

/** Resident-readable reasons, keyed by the API's `auth_error` marker. */
export const ACTIVITY_LOGIN_ERROR_MESSAGES: Record<string, string> = {
  wechat_not_configured: '微信网页授权尚未配置，当前无法登录。请联系运营人员。',
  wechat_config_unavailable:
    '微信登录配置当前不可用（凭证无法解密或主密钥缺失），请联系运营人员检查「系统管理 → 微信公众号」。',
  wechat_authorization_failed: '微信授权未完成（你取消或超时）。可以重新发起登录。',
  wechat_state_invalid: '本次登录已过期或无效，请重新发起登录。',
  wechat_state_replayed: '本次登录已经使用过，请重新发起登录。',
  wechat_provider_unavailable: '微信服务暂时不可用，请稍后重试。',
  wechat_identity_unavailable: '未能获取微信身份，请重新登录或联系运营人员。',
}

function basePathOf(baseUrl: string): string {
  if (!baseUrl || baseUrl === '/') return ''
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

function isHashMode(location: AppLocationSnapshot): boolean {
  return Boolean(basePathOf(location.baseUrl)) || (location.hash ?? '').startsWith('#/')
}

/** Route part of a `/path?query` string, always starting with `?` or empty. */
export function routeQuery(route: string): string {
  const index = route.indexOf('?')
  return index === -1 ? '' : route.slice(index)
}

/**
 * Current in-app route as `/path?query`, in both router modes. HashRouter builds
 * keep the route in the hash, so `pathname` is only the Pages base path.
 */
export function appRouteFromLocation(location: AppLocationSnapshot): string {
  const hash = location.hash ?? ''
  if (hash.startsWith('#/')) {
    const route = hash.slice(1)
    // `#//host/...` would resolve as a protocol-relative URL; never treat it as
    // an in-app route.
    return route.startsWith('//') ? '/' : route
  }

  let pathname = location.pathname || '/'
  const basePath = basePathOf(location.baseUrl)
  if (basePath && pathname.startsWith(`${basePath}/`)) {
    pathname = pathname.slice(basePath.length)
  } else if (basePath && pathname === basePath) {
    pathname = '/'
  }
  return `${pathname}${location.search ?? ''}`
}

/**
 * Normalise a legacy `/#/community/activity/...?activityId=..&invite=..` share
 * link into the equivalent clean-path location.
 *
 * Returns `null` when nothing should change: the Pages preview keeps its hash
 * routes, the app is already on a clean route, or the hash is not a safe
 * same-origin route (a `#//host` value must never be promoted to a pathname).
 */
export function legacyHashRouteToClean(location: AppLocationSnapshot): CleanRoute | null {
  // The Pages preview is built with `--base /local-life/` and must keep using
  // HashRouter, so its hash route is the canonical route, not a legacy one.
  if (basePathOf(location.baseUrl)) return null
  if ((location.pathname || '/') !== '/') return null

  const rawHash = location.hash ?? ''
  if (!rawHash.startsWith('#/')) return null
  const rawRoute = rawHash.slice(1)
  if (!rawRoute.startsWith('/')) return null

  let parsed: URL
  try {
    parsed = new URL(rawRoute, 'http://legacy-route.invalid')
  } catch {
    return null
  }
  // `//host` (or an absolute URL) changes the origin: refuse to normalise it.
  if (parsed.origin !== 'http://legacy-route.invalid') return null

  // Query parameters that were appended before the hash survive too.
  const merged = new URLSearchParams(location.search ?? '')
  for (const [key, value] of parsed.searchParams) merged.set(key, value)
  const search = merged.toString()

  if (parsed.pathname === '/' && !search && !parsed.hash) return null
  return {
    pathname: parsed.pathname,
    search: search ? `?${search}` : '',
    hash: parsed.hash,
  }
}

/** URL to hand to `history.replaceState` for a clean route in the current mode. */
export function routeToLocation(location: AppLocationSnapshot, route: string): string {
  const normalized = route.startsWith('/') ? route : `/${route}`
  if (isHashMode(location)) return `${location.pathname}#${normalized}`
  return normalized
}

/** Current browser location in the shape the helpers below expect. */
export function browserLocation(): AppLocationSnapshot {
  return {
    baseUrl: import.meta.env.BASE_URL,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  }
}

/**
 * Build the API start URL plus the context to remember, for the current page.
 *
 * The return target is derived from the *current* route (never from a client
 * supplied parameter), validated against the shared allowlist, and the one-off
 * OAuth markers are stripped so a retry cannot nest a previous result.
 *
 * The loaded activity is sent as `activityId` only (#123). The API loads that
 * row and derives its community; the H5 must never name a community itself, so
 * the query is built by the shared contract helper instead of string
 * concatenation — a malformed activity id throws here rather than silently
 * producing a login that attributes nothing.
 */
export function buildWechatLoginRequest(
  location: AppLocationSnapshot,
  activity: { activityId: string | null; inviteCode: string | null; inviteInvalid: boolean },
  now: number = Date.now(),
): { url: string; context: ActivityLoginContext } {
  const route = stripLoginResultParams(appRouteFromLocation(location))
  const returnTo = sanitizeReturnTo(route)
  const query = buildWechatStartQuery({ activityId: activity.activityId, returnTo })
  return {
    url: `${API_PREFIX}${API_ROUTES.authWechatStart}${query}`,
    context: {
      activityId: activity.activityId,
      inviteCode: activity.inviteCode,
      inviteInvalid: activity.inviteInvalid,
      returnTo,
      savedAt: now,
    },
  }
}

/** Validate the target the H5 wants to return to. This is a convenience mirror of
 * the API rule, not the authority: the API re-validates whatever it is sent.
 */
export function sanitizeReturnTo(route: string | null | undefined): string | null {
  const validation = validateReturnTo(route ?? null)
  return validation.ok ? validation.returnTo : null
}

export function parseActivityLoginResult(query: string): ActivityLoginResult {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)
  const errorCode = params.get('auth_error')?.trim()
  if (errorCode) {
    return {
      status: 'error',
      code: errorCode,
      message: ACTIVITY_LOGIN_ERROR_MESSAGES[errorCode] ?? '微信登录未完成，请重新发起登录。',
    }
  }
  if (params.get('auth') === 'success') return { status: 'success' }
  return null
}

/**
 * Read the one-off login markers from the current URL. Callers snapshot this
 * once (lazy state) and then strip the markers, so a refresh cannot replay a
 * stale result banner.
 */
export function readActivityLoginResult(): ActivityLoginResult {
  return parseActivityLoginResult(routeQuery(appRouteFromLocation(browserLocation())))
}

/** Marker kind only, for the shared presentation rule. */
export function activityLoginMarker(result: ActivityLoginResult): 'success' | 'error' | null {
  return result?.status ?? null
}

function normalizeInvite(value: unknown): { code: string | null; invalid: boolean } {
  if (typeof value !== 'string' || value.length === 0) return { code: null, invalid: false }
  const parsed = participationInviteCodeSchema.safeParse(value)
  return parsed.success ? { code: parsed.data, invalid: false } : { code: null, invalid: true }
}

/** Validate one stored context; anything unexpected is discarded, never coerced. */
export function parseActivityLoginContext(
  raw: string | null | undefined,
  now: number = Date.now(),
): ActivityLoginContext | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const record = parsed as Partial<Record<keyof ActivityLoginContext, unknown>>
  const savedAt = record.savedAt
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null
  const age = now - savedAt
  if (age < 0 || age > ACTIVITY_LOGIN_CONTEXT_TTL_MS) return null

  let activityId: string | null = null
  if (record.activityId !== null && record.activityId !== undefined) {
    if (!isActivityId(record.activityId)) return null
    activityId = record.activityId
  }

  const invite = normalizeInvite(record.inviteCode ?? null)
  if (record.inviteInvalid !== undefined && typeof record.inviteInvalid !== 'boolean') return null

  let returnTo: string | null = null
  if (record.returnTo !== null && record.returnTo !== undefined) {
    if (typeof record.returnTo !== 'string') return null
    const validation = validateReturnTo(record.returnTo)
    if (!validation.ok || validation.returnTo !== record.returnTo) return null
    returnTo = record.returnTo
  }

  return {
    activityId,
    inviteCode: invite.code,
    // An invite value that failed validation stays reported as invalid, even if
    // the stored flag was not set.
    inviteInvalid: record.inviteInvalid === true || invite.invalid,
    returnTo,
    savedAt,
  }
}

type ContextStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storageOrNull(): ContextStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    // Safari private mode and blocked storage throw on access.
    return null
  }
}

export function loadActivityLoginContext(
  now: number = Date.now(),
  storage: ContextStorage | null = storageOrNull(),
): ActivityLoginContext | null {
  if (!storage) return null
  try {
    return parseActivityLoginContext(storage.getItem(ACTIVITY_LOGIN_CONTEXT_KEY), now)
  } catch {
    return null
  }
}

export function saveActivityLoginContext(
  context: ActivityLoginContext,
  storage: ContextStorage | null = storageOrNull(),
): void {
  if (!storage) return
  try {
    storage.setItem(ACTIVITY_LOGIN_CONTEXT_KEY, JSON.stringify(context))
  } catch {
    // A full or blocked sessionStorage must never block the login itself.
  }
}

export function clearActivityLoginContext(
  storage: ContextStorage | null = storageOrNull(),
): void {
  if (!storage) return
  try {
    storage.removeItem(ACTIVITY_LOGIN_CONTEXT_KEY)
  } catch {
    // ignore
  }
}
