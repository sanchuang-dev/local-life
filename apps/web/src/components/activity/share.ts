import { participationInviteCodeSchema } from '@sanchuang-dev/local-life-contracts'

/** Route of the resident-facing silver-neighborhood campaign page. */
export const SILVER_NEIGHBORHOOD_ACTIVITY_PATH = '/community/activity/silver-neighborhood'

/**
 * One share URL for the QR code, the native share sheet and "copy link".
 *
 * The URL must keep the real `activityId` (and, for a member inviting friends,
 * the team's `inviteCode`). A static GitHub Pages URL would drop both, so the
 * origin and the Vite base are read from the running site instead. `BASE_URL`
 * keeps the `/local-life/` Pages preview working; the online MVP uses clean
 * history paths so invitation URLs can be opened and refreshed directly.
 */
export function buildActivityShareUrl(
  activityId: string,
  inviteCode: string | null,
): string {
  const params = new URLSearchParams({ activityId })
  if (inviteCode) params.set('invite', inviteCode)
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const base = import.meta.env.BASE_URL
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
