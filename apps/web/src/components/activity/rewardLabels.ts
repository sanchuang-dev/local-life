import type {
  ActivityRewardCredential,
  ActivityRewardGrant,
  RewardCredentialStatus,
  RewardGrantStatus,
  TeamRewardState,
} from '@sanchuang-dev/local-life-contracts'

/**
 * Presentation helpers for the real reward data.
 *
 * Everything here maps a *server* value to Chinese copy. No helper invents a
 * state: an unknown reason or status falls back to a neutral explanation instead
 * of a positive claim, so a contract change can never make the page look like a
 * successful award.
 */

const SHANGHAI = 'Asia/Shanghai'

/** Formats an ISO-8601 UTC timestamp as Shanghai wall-clock time. */
export function formatRewardDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return '—'
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(timestamp))
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

/** `¥12.00` from integer cents. */
export function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`
}

/* ------------------------------- Check-in -------------------------------- */

const CHECKIN_REASON_TEXT: Record<string, string> = {
  reward_plan_not_configured: '本活动尚未配置正式奖励计划，签到入口暂未开放。',
  activity_not_published: '活动尚未发布，暂不可签到。',
  activity_ended: '活动已结束，签到入口已关闭。',
  checkin_window_not_open: '签到尚未开始，请在签到窗口内到场签到。',
  checkin_window_closed: '签到窗口已关闭。',
  not_a_team_member: '你还没有加入三人团，加入团队后才能签到。',
  already_checked_in: '本场活动你已签到。',
}

/** Why the self check-in is closed right now, in resident-facing copy. */
export function checkinReasonText(reason: string | null | undefined): string {
  if (!reason) return '现在可以签到。'
  return CHECKIN_REASON_TEXT[reason] ?? '当前暂不可签到。'
}

/* ----------------------------- Team reward ------------------------------- */

const REWARD_REASON_TEXT: Record<string, string> = {
  reward_plan_not_configured: '本活动尚未配置正式奖励计划，奖励入口暂未开放。',
  activity_not_published: '活动尚未发布，奖励暂不可领取。',
  activity_ended: '活动已结束，奖励暂不可领取。',
  team_missing: '你还没有组建或加入三人团，暂不满足奖励条件。',
  team_incomplete: '团队还未坐满 3 人，暂不满足奖励条件。',
  checkin_incomplete: '团队有效签到不足 3 条，暂不满足奖励条件。',
  checkin_not_verified: '签到尚未现场核验，核验通过后才计入团队进度。',
  stock_exhausted: '奖品库存已发放完，暂不可领取。',
  budget_exhausted: '活动奖励预算已用完，暂不可领取。',
}

/** Why the team prize is not claimable, in resident-facing copy. */
export function rewardReasonText(reason: string | null | undefined): string {
  if (!reason) return '团队已满足全部奖励条件。'
  return REWARD_REASON_TEXT[reason] ?? '当前暂不满足奖励条件。'
}

export const claimRecipientLabels = {
  leader: '队长领取',
  any_member: '任一团员领取',
} as const

export const grantStatusLabels: Record<RewardGrantStatus, string> = {
  granted: '待领取',
  redeemed: '已核销',
  revoked: '已撤销',
  expired: '已过期',
  disputed: '争议中',
  reversed: '已冲正',
}

export const credentialStatusLabels: Record<RewardCredentialStatus, string> = {
  active: '待核销',
  redeemed: '已核销',
  superseded: '已换新码',
  expired: '已过期',
  revoked: '已作废',
}

/* -------------------------------- Wallet --------------------------------- */

/**
 * The five buckets the resident wallet groups rewards into. They are derived
 * from the grant + credential the server returned, never guessed from a local
 * counter.
 */
export type RewardBucket = 'pending' | 'claimable' | 'redeemed' | 'void' | 'disputed'

export const rewardBucketLabels: Record<RewardBucket, string> = {
  pending: '待达成',
  claimable: '待领取',
  redeemed: '已核销',
  void: '已失效',
  disputed: '争议',
}

/** Tone classes reused by the wallet cards and the campaign summary. */
export const rewardBucketClasses: Record<RewardBucket, string> = {
  pending: 'bg-slate-100 text-slate-500',
  claimable: 'bg-[#fff3e6] text-[#a96b2f]',
  redeemed: 'bg-[#e8f6f0] text-teal-700',
  void: 'bg-slate-100 text-slate-400',
  disputed: 'bg-rose-50 text-rose-600',
}

/**
 * One server-consistent bucket for a team reward state.
 *
 * Order matters: an open dispute overrides the redeemed/void reading, and an
 * issued credential is "待领取" until it is actually redeemed on site.
 */
export function rewardBucketOf(
  reward: Pick<TeamRewardState, 'eligible' | 'claimableByMe' | 'grant' | 'credential'>,
): RewardBucket {
  const { grant, credential } = reward
  if (grant) {
    if (grant.status === 'disputed' || grant.openDisputeId !== null) return 'disputed'
    if (grant.status === 'reversed') return 'void'
    if (grant.status === 'revoked' || grant.status === 'expired') return 'void'
    if (grant.status === 'redeemed') return 'redeemed'
  }
  if (credential) {
    if (credential.status === 'redeemed') return 'redeemed'
    if (credential.status === 'expired' || credential.status === 'revoked') return 'void'
  }
  // `granted` or an active credential both mean "claimed, not yet handed over".
  if (grant?.status === 'granted' || credential?.status === 'active') return 'claimable'
  return reward.eligible ? 'claimable' : 'pending'
}

/** Why a bucket entry is in that bucket, using only server facts. */
export function rewardBucketDetail(
  reward: Pick<TeamRewardState, 'eligible' | 'claimableByMe' | 'grant' | 'credential' | 'unavailableReason' | 'requirement'>,
): string {
  const bucket = rewardBucketOf(reward)
  const grant = reward.grant
  const credential = reward.credential

  if (bucket === 'disputed') {
    return '该笔奖励存在争议，已暂停核销，请到活动现场联系工作人员。'
  }
  if (bucket === 'void') {
    if (grant?.status === 'revoked') return '该笔奖励已被工作人员撤销。'
    if (grant?.status === 'expired') return '该笔奖励已超过有效期。'
    if (grant?.status === 'reversed') return '该笔奖励已被冲正，不再可用。'
    if (credential?.status === 'expired') {
      return `核销凭据已于 ${formatRewardDateTime(credential.expiresAt)} 过期。`
    }
    return '核销凭据已作废，不再可用。'
  }
  if (bucket === 'redeemed') {
    const at = grant?.redeemedAt ?? credential?.redeemedAt ?? null
    return at ? `已于 ${formatRewardDateTime(at)} 在活动现场核销。` : '已在活动现场核销。'
  }
  if (bucket === 'claimable') {
    if (grant?.status === 'granted' || credential?.status === 'active') {
      const expiresAt = credential?.expiresAt ?? grant?.credentialExpiresAt ?? null
      return expiresAt
        ? `凭据待现场核销，有效期至 ${formatRewardDateTime(expiresAt)}。`
        : '凭据待现场核销。'
    }
    if (reward.claimableByMe) return '团队已达标，可以立即领取奖励凭据。'
    return '团队已达标，但按规则只有队长可以领取。'
  }
  // pending: explain with the requirement counts, which are real numbers.
  const requirement = reward.requirement
  if (requirement && !requirement.seatsSatisfied) {
    return `团队已加入 ${requirement.seatsFilled}/3 人，坐满 3 人后才计入奖励资格。`
  }
  if (requirement && !requirement.checkinsSatisfied) {
    return `团队有效签到 ${requirement.checkinsValid}/3 条，现场核验通过后才计入。`
  }
  return rewardReasonText(reward.unavailableReason)
}

/** Short label for a credential's remaining life, used on the code card. */
export function credentialExpiryText(credential: ActivityRewardCredential): string {
  if (credential.status === 'redeemed') {
    return `已于 ${formatRewardDateTime(credential.redeemedAt)} 核销`
  }
  if (credential.status === 'expired') {
    return `已于 ${formatRewardDateTime(credential.expiresAt)} 过期`
  }
  return `有效期至 ${formatRewardDateTime(credential.expiresAt)}`
}

/** Recipient line of a grant: leader grants always name the person. */
export function grantRecipientText(grant: ActivityRewardGrant): string {
  if (grant.recipientRole === 'leader' && grant.recipientDisplayName) {
    return `队长 ${grant.recipientDisplayName}`
  }
  return '团队成员共享'
}

/** Normalises a code typed by staff: uppercase, no spaces, no ambiguous chars. */
export function normaliseCredentialCode(input: string): string {
  return input.replace(/\s+/gu, '').toUpperCase()
}

/** Client-side shape check that mirrors `credentialCodeSchema` (server still validates). */
export const CREDENTIAL_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/u

export function isCredentialCodeShaped(value: string): boolean {
  return CREDENTIAL_CODE_PATTERN.test(value)
}
