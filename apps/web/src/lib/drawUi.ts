import type { ResidentDrawAttempt } from '@sanchuang-dev/local-life-contracts'

const UNAVAILABLE: Record<string, string> = {
  not_authenticated: '登录后即可查看今日剩余抽奖次数。',
  // #171 LL-IDENTITY-001: the API now derives this reason from the confirmed
  // permanent community, not from the retired #123 automatic assignment.
  not_assigned: '请先在「我的」中确认常驻社区，再参与今日抽奖。',
  activity_unavailable: '活动尚未开放或已结束，暂不能抽奖。',
  draw_pool_not_configured: '今日抽奖尚未配置奖品。',
  draw_pool_disabled: '今日抽奖尚未开放，请留意社区通知。',
  no_prize_available: '当前没有可以领取的奖品，抽奖暂时关闭。',
  draw_service_not_configured: '抽奖服务正在准备中，暂时无法开奖。',
  daily_limit_reached: '今天的抽奖次数已用完，明天再来。',
  activity_not_published: '活动尚未开放，暂不能抽奖。',
  activity_ended: '活动已经结束，暂不能抽奖。',
}
export function drawUnavailableText(reason: string | null | undefined): string {
  return reason ? UNAVAILABLE[reason] ?? '当前暂时不能抽奖，请稍后再试。' : '可以参与今日抽奖。'
}
export function drawCredentialStatusText(status: string | null | undefined): string {
  if (status === 'active') return '待核销'
  if (status === 'redeemed') return '已核销'
  if (status === 'revoked') return '已作废'
  return '未发放'
}
/** The bounded history and the unbounded active-award list may overlap. */
export function distinctDrawWins(
  attempts: readonly ResidentDrawAttempt[],
  activeAwards: readonly ResidentDrawAttempt[],
): ResidentDrawAttempt[] {
  const seen = new Set<string>()
  const wins: ResidentDrawAttempt[] = []
  for (const attempt of [...activeAwards, ...attempts]) {
    if (attempt.outcome !== 'won' || seen.has(attempt.id)) continue
    seen.add(attempt.id)
    wins.push(attempt)
  }
  return wins.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
