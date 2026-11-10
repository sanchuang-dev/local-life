/** A shared path retains every distributed legacy activity/invite link. */
export function isLegacyActivityHome(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has('activityId') || params.has('invite')
}

export function activityDetailHref(id: string): string {
  return `/?activityId=${encodeURIComponent(id)}`
}

export const SELECTED_COMMUNITY_KEY = 'll.communityDiscovery.selectedCommunity'
