/**
 * Entries into the real local-goods catalogue from an activity.
 *
 * The old activity product page is a concept display; a consumption task must
 * send residents to the deployment's actual on-shelf catalogue and order
 * attribution flow instead. Keeping the activity id on both links preserves the
 * source context through the login round-trip without inventing any product data.
 */
export function localCatalogHref(activityId: string | null): string {
  if (!activityId) return '/life'
  return `/life?${new URLSearchParams({ activityId }).toString()}`
}

export function localProductHref(productId: string, activityId: string | null): string {
  const path = `/life/local-products/${encodeURIComponent(productId)}`
  if (!activityId) return path
  return `${path}?${new URLSearchParams({ activityId }).toString()}`
}
