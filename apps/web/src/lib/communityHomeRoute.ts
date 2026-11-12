/**
 * Route of the one resident-facing detail page for a published activity.
 *
 * The discovery home (`/`) lists activities, and every activity link (old or
 * new) resolves here. `share.ts` keeps its exported name for existing callers
 * but reads this constant so the path has a single source of truth.
 */
export const ACTIVITY_DETAIL_PATH = '/community/activity/silver-neighborhood'

/**
 * A legacy root URL carries the activity workflow in its query string:
 * `/?activityId=...&invite=...`, plus the one-off OAuth return markers. It must
 * never render a second copy of the activity page.
 */
export function isLegacyActivityHome(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has('activityId') || params.has('invite')
}

/**
 * True when the activity detail page's own "back home" link opened the root.
 * That link still targets the legacy activity-home URL, so forwarding it to the
 * same detail page would bounce the resident back where they came from.
 */
export function isActivityDetailReturn(state: unknown): boolean {
  return Boolean(
    state
      && typeof state === 'object'
      && (state as { from?: unknown }).from === ACTIVITY_DETAIL_PATH,
  )
}

/**
 * Forward the legacy query untouched: `activityId`, a valid `invite` and the
 * `auth` / `auth_error` OAuth markers must survive byte for byte so the detail
 * page keeps the same activity and invitation context after a refresh or a
 * login return.
 */
export function legacyActivityDetailHref(search: string): string {
  const normalized = !search || search.startsWith('?') ? search : `?${search}`
  return `${ACTIVITY_DETAIL_PATH}${normalized}`
}

/**
 * Resolve the root route without rendering an activity page twice.
 *
 * Returns `null` when the discovery home should render in place, otherwise the
 * URL to redirect to:
 * - a legacy activity/invite root link -> the single activity detail page;
 * - the detail page's legacy "back home" link -> the clean discovery root.
 */
export function communityRootRedirect(search: string, state: unknown): string | null {
  if (!isLegacyActivityHome(search)) return null
  if (isActivityDetailReturn(state)) return '/'
  return legacyActivityDetailHref(search)
}

/** Link used by the discovery activity list to open one published activity. */
export function activityDetailHref(id: string): string {
  return `${ACTIVITY_DETAIL_PATH}?activityId=${encodeURIComponent(id)}`
}

export const SELECTED_COMMUNITY_KEY = 'll.communityDiscovery.selectedCommunity'
