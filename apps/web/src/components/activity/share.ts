import { participationInviteCodeSchema } from '@sanchuang-dev/local-life-contracts'
// Explicit `.ts` keeps this pure helper importable by the Node test runner.
import { ACTIVITY_DETAIL_PATH } from '../../lib/communityHomeRoute.ts'

/** Route of the resident-facing silver-neighborhood campaign page. */
export const SILVER_NEIGHBORHOOD_ACTIVITY_PATH = ACTIVITY_DETAIL_PATH

export type ActivityShareUrlOptions = {
  /** Defaults to the running site origin; tests pass an explicit origin. */
  origin?: string
  /** Defaults to the Vite base; tests pass `/` or `/local-life/`. */
  baseUrl?: string
}

/**
 * One share URL for the QR code, the native share sheet and "copy link".
 *
 * The URL must keep the real `activityId` (and, for a member inviting friends,
 * the team's `inviteCode`). A static GitHub Pages URL would drop both, so the
 * origin and the Vite base are read from the running site instead. `BASE_URL`
 * keeps the `/local-life/` Pages preview working; the online MVP uses clean
 * history paths so invitation URLs can be opened and refreshed directly.
 *
 * The optional arguments exist only so the URL construction can be unit-tested
 * outside a browser; production callers keep passing just the activity/invite.
 */
export function buildActivityShareUrl(
  activityId: string,
  inviteCode: string | null,
  options: ActivityShareUrlOptions = {},
): string {
  const params = new URLSearchParams({ activityId })
  if (inviteCode) params.set('invite', inviteCode)
  const origin =
    options.origin ?? (typeof window === 'undefined' ? '' : window.location.origin)
  const base = options.baseUrl ?? import.meta.env.BASE_URL
  const route = `${SILVER_NEIGHBORHOOD_ACTIVITY_PATH}?${params.toString()}`
  return base === '/' ? `${origin}${route}` : `${origin}${base}#${route}`
}

export type ParsedInviteParam = {
  /** Valid invite code, or `null` when the link carries no invite at all. */
  code: string | null
  /** True when an invite parameter exists but is not a well-formed code. */
  invalid: boolean
}

/**
 * Parse the `invite` deep-link parameter with the shared contract schema. An
 * invalid value is reported instead of being forwarded to the API, so the page
 * can tell the resident that no invitation attribution will be recorded.
 */
export function parseInviteParam(raw: string | null): ParsedInviteParam {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return { code: null, invalid: false }
  const parsed = participationInviteCodeSchema.safeParse(trimmed)
  return parsed.success
    ? { code: parsed.data, invalid: false }
    : { code: null, invalid: true }
}
