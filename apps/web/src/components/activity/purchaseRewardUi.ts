import type {
  CouponEffectiveStatus,
  CouponWalletItem,
  PublicPurchaseReward,
  PurchaseRewardTeamProgress,
} from '@sanchuang-dev/local-life-contracts'
import { formatCents, formatRewardDateTime } from './rewardLabels.ts'

/**
 * Presentation helpers for the consumption-team task (#214).
 *
 * The rule is the same as the check-in wallet: the helpers only translate server
 * values into Chinese copy. They never promote a partial team, an absent coupon
 * or an expired coupon into a reward. In particular, "已达标" is only returned
 * when #210 says `eligible`, and "已发券" is only stated when the resident's own
 * coupon really exists in the #211 wallet.
 */

export const PURCHASE_REWARD_TEAM_SIZE = 3

export type PurchaseRewardSummaryKind =
  | 'no_team'
  | 'incomplete_team'
  | 'awaiting_payment'
  | 'in_progress'
  | 'qualified'

export type PurchaseRewardTone = 'slate' | 'orange' | 'teal'

export interface PurchaseRewardMemberView {
  seatNo: number
  displayName: string
  role: 'leader' | 'member'
  isSelf: boolean
  contributionCents: number
  contributionText: string
}

export interface PurchaseRewardSummary {
  kind: PurchaseRewardSummaryKind
  label: string
  detail: string
  tone: PurchaseRewardTone
  seatsFilled: number
  seatsTotal: number
  totalCents: number
  thresholdCents: number
  remainingCents: number
  remainingText: string
  progressPercent: number
  eligible: boolean
  members: PurchaseRewardMemberView[]
}

/**
 * One honest statement of the current team state.
 *
 * `plan === null` returns `null` because the page must not render a consumption
 * reward task at all for an activity without a real plan. `progress === null`
 * means the resident has not joined a team; it never becomes a fabricated 0/3
 * contribution row.
 */
export function buildPurchaseRewardSummary(
  plan: PublicPurchaseReward | null,
  progress: PurchaseRewardTeamProgress | null,
): PurchaseRewardSummary | null {
  if (plan === null) return null

  const thresholdCents = progress?.thresholdCents ?? plan.thresholdCents
  const faceValueCents = plan.couponFaceValueCents
  const totalCents = progress?.totalEffectivePaidCents ?? 0
  const remainingCents = progress?.remainingCents ?? Math.max(0, thresholdCents - totalCents)
  const seatsFilled = progress?.seatsFilled ?? 0
  const eligible = progress?.eligible === true
  const progressPercent =
    thresholdCents > 0 ? Math.min(100, Math.round((totalCents / thresholdCents) * 100)) : 0
  const members: PurchaseRewardMemberView[] =
    progress?.membersContributionCents.map((member) => ({
      seatNo: member.seatNo,
      displayName: member.displayName,
      role: member.role,
      isSelf: member.isSelf,
      contributionCents: member.contributionCents,
      contributionText: formatCents(member.contributionCents),
    })) ?? []

  const shared = {
    seatsFilled,
    seatsTotal: PURCHASE_REWARD_TEAM_SIZE,
    totalCents,
    thresholdCents,
    remainingCents,
    remainingText: formatCents(remainingCents),
    progressPercent,
    eligible,
    members,
  }

  if (!progress) {
    return {
      ...shared,
      kind: 'no_team',
      label: '还未加入三人团',
      detail: `入团后的有效实付才会累计。门槛 ${formatCents(thresholdCents)}，达标后三位团员各获一张 ${formatCents(faceValueCents)} 消费券。`,
      tone: 'slate',
    }
  }

  if (!progress.teamFull) {
    const reached = totalCents >= thresholdCents
    return {
      ...shared,
      kind: 'incomplete_team',
      label: `团队未满员 · ${seatsFilled}/${PURCHASE_REWARD_TEAM_SIZE} 人`,
      detail: reached
        ? `团队有效实付已达 ${formatCents(totalCents)}，但需坐满 3 人后才能获得消费券。`
        : `累计有效实付 ${formatCents(totalCents)}，还差 ${formatCents(remainingCents)} 达标；满 3 人且达标后才发券。`,
      tone: 'orange',
    }
  }

  if (eligible) {
    return {
      ...shared,
      kind: 'qualified',
      label: '团队已达标',
      detail: `团队有效实付 ${formatCents(totalCents)} 已达门槛 ${formatCents(thresholdCents)}，是否成功发券请以下方本人券包记录为准。`,
      tone: 'teal',
    }
  }

  if (totalCents === 0) {
    return {
      ...shared,
      kind: 'awaiting_payment',
      label: '待有效实付',
      detail: `团队已坐满 3 人，但还没有计入的有效实付。只有已核验并关联收款凭据的本地订单才计入；待审核、未付款或未关联凭据的订单不计入。`,
      tone: 'orange',
    }
  }

  return {
    ...shared,
    kind: 'in_progress',
    label: `还差 ${formatCents(remainingCents)}`,
    detail: `团队有效实付 ${formatCents(totalCents)}，达到 ${formatCents(thresholdCents)} 后三位团员各获一张 ${formatCents(faceValueCents)} 消费券。`,
    tone: 'orange',
  }
}

/**
 * The team-grant explanation, based only on the resident's own wallet plus the
 * public plan.
 *
 * A coupon in the wallet is direct evidence that the atomic three-member grant
 * happened (#211). Without one, the helper never claims the team was rewarded;
 * an eligible team may have hit the activity budget cap instead.
 */
export function purchaseRewardGrantText(
  plan: PublicPurchaseReward | null,
  progress: PurchaseRewardTeamProgress | null,
  coupon: CouponWalletItem | null,
): string | null {
  if (plan === null) return null

  if (coupon) {
    if (coupon.faceValueCents !== plan.couponFaceValueCents) {
      return `券面额 ${formatCents(coupon.faceValueCents)} 与活动规则 ${formatCents(plan.couponFaceValueCents)} 不一致，请以券包记录并联系工作人员核实。`
    }
    const verb = progress?.eligible ? '已为三位团员各发放' : '曾为三位团员各发放'
    return `${verb} ${formatCents(coupon.faceValueCents)} 消费券，三位团员面额相同；你的券状态见下方。`
  }

  if (progress?.eligible) {
    return '本团已达标，但你的券包暂未收到消费券；若奖励名额已用尽，平台会停止发放且不补发，请以券包记录为准。'
  }

  return null
}

export interface CouponStatusView {
  label: string
  tone: PurchaseRewardTone | 'rose'
  detail: string
  expiresText: string
}

const COUPON_STATUS_COPY: Record<
  CouponEffectiveStatus,
  { label: string; tone: PurchaseRewardTone | 'rose'; detail: string }
> = {
  available: {
    label: '可用',
    tone: 'teal',
    detail: '消费券当前可用；当前 H5 订单登记页尚未开放选券入口，请按工作人员指引使用。',
  },
  reserved: {
    label: '已占用',
    tone: 'orange',
    detail: '消费券已随一笔登记订单占用，订单处理完成或取消前不能再次使用。',
  },
  redeemed: {
    label: '已使用',
    tone: 'slate',
    detail: '消费券已完成使用。',
  },
  void: {
    label: '已作废',
    tone: 'rose',
    detail: '消费券已作废，不能再用；可能因订单退款撤销或团队资格失效，以平台记录为准。',
  },
  expired: {
    label: '已过期',
    tone: 'slate',
    detail: '消费券已超过有效期，不能再用。',
  },
}

/** Status labels shared by the campaign card and the full reward wallet. */
export const couponStatusLabels: Record<CouponEffectiveStatus, string> = {
  available: COUPON_STATUS_COPY.available.label,
  reserved: COUPON_STATUS_COPY.reserved.label,
  redeemed: COUPON_STATUS_COPY.redeemed.label,
  void: COUPON_STATUS_COPY.void.label,
  expired: COUPON_STATUS_COPY.expired.label,
}

export function couponStatusView(coupon: CouponWalletItem): CouponStatusView {
  const copy = COUPON_STATUS_COPY[coupon.status]
  return {
    ...copy,
    expiresText: `有效期至 ${formatRewardDateTime(coupon.expiresAt)}`,
  }
}

/** The newest coupon for one activity/team pair, or `null` when none was granted. */
export function findLatestTeamCoupon(
  coupons: readonly CouponWalletItem[],
  activityId: string,
  teamId: string,
): CouponWalletItem | null {
  let latest: CouponWalletItem | null = null
  for (const coupon of coupons) {
    if (coupon.activityId !== activityId || coupon.teamId !== teamId) continue
    if (latest === null || Date.parse(coupon.issuedAt) > Date.parse(latest.issuedAt)) {
      latest = coupon
    }
  }
  return latest
}

export type PurchaseActivityPhase = 'upcoming' | 'active' | 'paused' | 'ended'

/**
 * Resident-facing phase for the consumption task.
 *
 * A paused/ended API status always wins. A published activity whose end time has
 * passed is shown as ended rather than pretending its progress is still running.
 */
export function purchaseActivityPhase(
  activity: Pick<{ status: 'published' | 'paused' | 'ended'; startsAt: string; endsAt: string }, 'status' | 'startsAt' | 'endsAt'>,
  now: number,
): PurchaseActivityPhase {
  if (activity.status === 'paused') return 'paused'
  if (activity.status === 'ended') return 'ended'
  if (now >= Date.parse(activity.endsAt)) return 'ended'
  if (now < Date.parse(activity.startsAt)) return 'upcoming'
  return 'active'
}

export const purchasePhaseNotice: Record<PurchaseActivityPhase, string | null> = {
  upcoming: '活动尚未开始，消费进度会从活动开始后按有效实付累计。',
  active: null,
  paused: '活动已暂停，团队进度与消费券状态以最近一次服务端记录为准。',
  ended: '活动已结束，团队进度与消费券状态以最近一次服务端记录为准。',
}
