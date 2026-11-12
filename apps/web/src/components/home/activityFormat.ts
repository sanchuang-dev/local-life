import type { PublicActivityDetail } from '@sanchuang-dev/local-life-contracts'

/**
 * Presentation helpers for the resident activity home.
 *
 * Everything here is derived from the published activity payload the API
 * returned; nothing is read from a fixture. The helpers live under
 * `components/home/` so the root activity page stays a thin composition of
 * real read state instead of re-implementing date/phase rules inline.
 */

export type ResidentActivityPhase = 'upcoming' | 'active' | 'paused' | 'ended'

/**
 * Resident-facing phase. The API status is authoritative for pause/end; a
 * published activity whose end time has passed is also shown as ended instead
 * of pretending it is still running.
 */
export function residentActivityPhase(activity: PublicActivityDetail, now: number): ResidentActivityPhase {
  if (activity.status === 'paused') return 'paused'
  if (activity.status === 'ended') return 'ended'
  if (now >= Date.parse(activity.endsAt)) return 'ended'
  if (now < Date.parse(activity.startsAt)) return 'upcoming'
  return 'active'
}

export const residentActivityPhaseLabels: Record<ResidentActivityPhase, string> = {
  upcoming: '活动即将开始',
  active: '活动进行中',
  paused: '活动已暂停',
  ended: '活动已结束',
}

export const residentActivityPhaseTones: Record<ResidentActivityPhase, string> = {
  upcoming: 'bg-[#fff3e6] text-[#a96b2f]',
  active: 'bg-[#e8f6f0] text-teal-700',
  paused: 'bg-[#fff7ec] text-[#8a6132]',
  ended: 'bg-slate-100 text-slate-500',
}

/** Activity timestamps are UTC; every rendered value uses Asia/Shanghai. */
export function formatShanghaiDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''

  return `${part('year')}.${part('month')}.${part('day')} ${part('hour')}:${part('minute')}`
}
