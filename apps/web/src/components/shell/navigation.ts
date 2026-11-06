import { CalendarDays, Gift, UserRound, type LucideIcon } from 'lucide-react'

/**
 * Primary resident navigation for the H5 app shell.
 *
 * The product has exactly three entries: 活动, 惠生活, 我的. The current route is
 * the only source of truth for which entry is highlighted; nothing in the shell
 * keeps a parallel "own tab" state, so deep links, refreshes and history
 * traversal always highlight the entry that actually owns the URL.
 */
export type PrimaryTabKey = 'activity' | 'life' | 'me'

export type PrimaryTab = {
  key: PrimaryTabKey
  path: string
  label: string
  icon: LucideIcon
}

export const primaryTabs: PrimaryTab[] = [
  { key: 'activity', path: '/', label: '活动', icon: CalendarDays },
  { key: 'life', path: '/life', label: '惠生活', icon: Gift },
  { key: 'me', path: '/me', label: '我的', icon: UserRound },
]

const isSameOrNested = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`)

/**
 * Resolve a pathname to its primary entry.
 *
 * Legacy routes stay reachable even though they are not entries any more:
 * - `/community/activity/**` is the activity detail tree, so it belongs to 活动.
 * - Other `/community/**` pages carried the old 社区 tab and its activity
 *   content; they follow the activity entry instead of inventing a fourth one.
 * - `/points` belongs to 惠生活, matching the existing page back target.
 * - `/workbench/**` is the staff H5 workbench entered from 我的; residents never
 *   get an entry for it, and it must not disappear from the shell.
 * - `/health/**` and `/gd` are legacy demos that are not part of any of the
 *   three entries, so they highlight nothing rather than a wrong entry.
 */
export function activePrimaryTab(pathname: string): PrimaryTabKey | undefined {
  if (pathname === '/') return 'activity'
  if (isSameOrNested(pathname, '/community')) return 'activity'
  if (isSameOrNested(pathname, '/life') || pathname === '/points') return 'life'
  if (isSameOrNested(pathname, '/me') || isSameOrNested(pathname, '/workbench')) return 'me'
  return undefined
}
