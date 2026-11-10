import { publicCommunityListSchema, type PublicCommunityList, type PublicCommunityQuery } from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import { communities } from '../db/schema.js'

const NEARBY_RADIUS_METERS = 20_000
const MAX_COMMUNITIES = 200

/** All coordinates are GCJ-02 here. Distance is to each community service point, NOT its administrative boundary. */
export function haversineDistanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = Math.PI / 180
  const dLat = (bLat - aLat) * toRad
  const dLng = (bLng - aLng) * toRad
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(x))))
}

/**
 * Public, explicitly bounded directory. We read only service-point metadata; no
 * assignments, resident identities or map provider keys are exposed. For the
 * MVP's small community directory a narrow SQLite read is simpler than GIS.
 */
export function listPublicCommunities(
  db: AppDatabase,
  query: PublicCommunityQuery,
): PublicCommunityList {
  const keyword = query.q?.toLocaleLowerCase('zh-CN') ?? ''
  const rows = db.select({
    id: communities.id,
    name: communities.name,
    address: communities.address,
    latitude: communities.latitudeGcj02,
    longitude: communities.longitudeGcj02,
  }).from(communities).all()

  const items = rows
    .filter((row) => !keyword ||
      row.name.toLocaleLowerCase('zh-CN').includes(keyword) ||
      (row.address ?? '').toLocaleLowerCase('zh-CN').includes(keyword))
    .map((row) => {
      const distanceMeters =
        query.latitude !== undefined && query.longitude !== undefined &&
        row.latitude !== null && row.longitude !== null
          ? haversineDistanceMeters(query.latitude, query.longitude, row.latitude, row.longitude)
          : null
      return {
        id: row.id,
        name: row.name,
        address: row.address,
        distanceMeters,
        nearby: distanceMeters !== null && distanceMeters <= NEARBY_RADIUS_METERS,
      }
    })
    .sort((a, b) =>
      (a.distanceMeters ?? Number.POSITIVE_INFINITY) - (b.distanceMeters ?? Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name, 'zh-CN') ||
      a.id.localeCompare(b.id))
    .slice(0, MAX_COMMUNITIES)

  return publicCommunityListSchema.parse({ items })
}
