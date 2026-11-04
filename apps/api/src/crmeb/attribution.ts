import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  CRMEB_PURCHASE_WARNINGS,
  crmebPurchaseLinkResponseSchema,
  type CrmebAttributionSubmitState,
  type CrmebPurchaseLinkRequest,
  type CrmebPurchaseLinkResponse,
} from '@sanchuang-dev/local-life-contracts'
import type { AppDatabase } from '../db/client.js'
import {
  activities,
  crmebClickAttributions,
  residentCommunityAssignments,
  staffAccounts,
  staffCommunityAssignments,
} from '../db/schema.js'
import { hashToken } from '../auth/security.js'
import { CrmebDomainError } from './errors.js'

const CRMEB_PRODUCT_DETAIL_PATH = '/pages/goods_details/index'

/**
 * Builds the CRMEB H5 deep link for a resident click.
 *
 * Attribution rules (evidence §7.3, §8.5, §10#4):
 * - CRMEB has no source/channel field and `spread` is a distribution-agent uid,
 *   so it is never appended here.
 * - The activity is optional: a natural purchase records `activityId = null`.
 *   When supplied, the activity must be published and belong to a community the
 *   resident is in, otherwise 404/403.
 * - A referral code is an opaque *staff* referral code resolved server-side and
 *   only within an activity's community. Without an activity it is merely hashed
 *   (`unconfirmed`, no staff) and never upgrades attribution.
 * - This path can never write `confirmed`.
 */
export function createCrmebPurchaseLink(
  db: AppDatabase,
  userId: string,
  input: CrmebPurchaseLinkRequest,
  h5BaseUrl: string,
): CrmebPurchaseLinkResponse {
  let activity: {
    id: string
    communityId: string
    status: string
  } | null = null

  if (input.activityId) {
    activity =
      db
        .select({
          id: activities.id,
          communityId: activities.communityId,
          status: activities.status,
        })
        .from(activities)
        .where(eq(activities.id, input.activityId))
        .get() ?? null

    if (!activity || activity.status !== 'published') {
      throw new CrmebDomainError(404, API_ERROR_CODES.notFound, '活动不存在或尚未发布')
    }

    const membership = db
      .select({ communityId: residentCommunityAssignments.communityId })
      .from(residentCommunityAssignments)
      .where(
        and(
          eq(residentCommunityAssignments.userId, userId),
          eq(residentCommunityAssignments.communityId, activity.communityId),
        ),
      )
      .get()
    if (!membership) {
      throw new CrmebDomainError(
        403,
        API_ERROR_CODES.forbidden,
        '该活动不属于你所在的社区，无法参与',
      )
    }
  }

  let claimedStaffId: string | null = null
  let referralCodeHash: string | null = null
  let claimState: CrmebAttributionSubmitState = 'unconfirmed'

  if (input.referralCode) {
    referralCodeHash = hashToken(`crmeb-referral:${input.referralCode}`)
    // Without an activity there is no trusted community to scope the staff to,
    // so the code is audited as a hash only and cannot upgrade the claim.
    if (activity) {
      const staff = db
        .select({
          id: staffAccounts.id,
          role: staffAccounts.role,
          status: staffAccounts.status,
        })
        .from(staffAccounts)
        .where(eq(staffAccounts.id, input.referralCode))
        .get()

      if (
        staff &&
        staff.status === 'active' &&
        staff.role === 'grid_worker'
      ) {
        const assignment = db
          .select({ communityId: staffCommunityAssignments.communityId })
          .from(staffCommunityAssignments)
          .where(
            and(
              eq(staffCommunityAssignments.staffAccountId, staff.id),
              eq(staffCommunityAssignments.communityId, activity.communityId),
            ),
          )
          .get()
        if (assignment) {
          // Only a fully validated in-community staff may be echoed/stored as
          // the claimed staff id; out-of-scope attempts keep the hash only.
          claimedStaffId = staff.id
          claimState = 'claimed'
        }
      }
    }
  }

  const now = new Date()
  const claimId = randomUUID()
  const clickId = randomUUID()
  db.insert(crmebClickAttributions)
    .values({
      id: claimId,
      clickId,
      userId,
      activityId: activity?.id ?? null,
      crmebProductId: input.crmebProductId,
      claimedStaffId,
      claimState,
      referralCodeHash,
      createdAt: now,
    })
    .run()

  const url = new URL(`${h5BaseUrl.replace(/\/+$/, '')}${CRMEB_PRODUCT_DETAIL_PATH}`)
  url.searchParams.set('id', String(input.crmebProductId))

  return crmebPurchaseLinkResponseSchema.parse({
    url: url.toString(),
    claim: {
      id: claimId,
      clickId,
      activityId: activity?.id ?? null,
      crmebProductId: input.crmebProductId,
      claimState,
      claimedStaffId,
      createdAt: now.toISOString(),
    },
    warnings: [...CRMEB_PURCHASE_WARNINGS],
  })
}
