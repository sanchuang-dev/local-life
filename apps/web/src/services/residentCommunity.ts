import {
  RESIDENT_COMMUNITY_ROUTES,
  confirmResidentCommunityResponseSchema,
  residentCommunityStatusResponseSchema,
  type ConfirmResidentCommunityResponse,
  type ResidentCommunityStatusResponse,
} from '@sanchuang-dev/local-life-contracts'
import { requestLocal } from './localApi'

/**
 * Transport for the resident permanent-community surface (#171 LL-IDENTITY-001).
 *
 * Both paths come from `RESIDENT_COMMUNITY_ROUTES` and both payloads are checked
 * against the canonical contracts, so the H5 cannot drift from the API. There is
 * deliberately no update/unbind/rebind call: the contracts define no such DTO and
 * the resident surface must not invent one.
 *
 * The resident identity always comes from the session cookie. The confirm body
 * carries a single `communityId` — the community the resident is looking at — and
 * never a user id, source or timestamp. `localStorage` browsing state is never
 * read here: a browse choice must never become an identity claim.
 */

const API_PREFIX = '/api'

export function getResidentCommunityStatus(
  signal?: AbortSignal,
): Promise<ResidentCommunityStatusResponse> {
  return requestLocal(
    `${API_PREFIX}${RESIDENT_COMMUNITY_ROUTES.status}`,
    residentCommunityStatusResponseSchema,
    '常驻社区状态',
    { signal },
  )
}

export function confirmResidentCommunity(
  communityId: string,
  csrfToken: string,
): Promise<ConfirmResidentCommunityResponse> {
  return requestLocal(
    `${API_PREFIX}${RESIDENT_COMMUNITY_ROUTES.confirm}`,
    confirmResidentCommunityResponseSchema,
    '常驻社区确认',
    { method: 'POST', csrfToken, body: { communityId } },
  )
}
