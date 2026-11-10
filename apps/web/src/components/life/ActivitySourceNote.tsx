import { AlertTriangle, CalendarDays, RefreshCw } from 'lucide-react'
import type { ShopActivitySourceState } from '../../hooks/useShopProducts'
import { activityStatusLabel } from './shop'

/**
 * Shows the activity carried by a trusted deep link and its public status.
 *
 * The H5 only *displays* this source. Attribution itself is decided by the API,
 * which independently checks that the activity is published and belongs to the
 * resident's community; the browser never submits a staff id or a confirmed flag.
 */
export function ActivitySourceNote({
  activityId,
  state,
  onRetry,
}: {
  activityId: string | null
  state: ShopActivitySourceState
  onRetry: () => void
}) {
  if (!activityId) return null

  if (state.status === 'loading') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-3 flex items-center gap-2 rounded-[14px] border border-teal-200/70 bg-[#eef7f2] px-3.5 py-2.5 text-[11px] leading-5 text-[#52786c]"
      >
        <span
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-teal-600/25 border-t-teal-600"
          aria-hidden="true"
        />
        正在核验深链携带的活动来源…
      </div>
    )
  }

  if (state.status === 'invalid' || state.status === 'error') {
    return (
      <div
        role="alert"
        className="mt-3 rounded-[14px] border border-[#f2dcc0] bg-[#fff7ec] px-3.5 py-3 text-[11px] leading-5 text-[#8a6132]"
      >
        <p className="flex items-center gap-1.5 font-semibold">
          <AlertTriangle size={14} aria-hidden="true" />
          活动来源不可用
        </p>
        <p className="mt-1 break-words">{state.message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex min-h-[36px] items-center gap-1 rounded-full border border-[#d9b98f] bg-white px-3 text-[11px] font-semibold text-[#8a6132] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <RefreshCw size={13} aria-hidden="true" />
          重新核验来源
        </button>
      </div>
    )
  }

  if (state.status === 'idle') return null

  const { activity } = state
  const published = activity.status === 'published'

  return (
    <div
      className={`mt-3 rounded-[14px] border px-3.5 py-3 text-[11px] leading-5 ${
        published
          ? 'border-teal-200/70 bg-[#eef7f2] text-[#52786c]'
          : 'border-[#f2dcc0] bg-[#fff7ec] text-[#8a6132]'
      }`}
    >
      <p className="flex items-start gap-1.5 font-semibold">
        <CalendarDays size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">
          来源活动：{activity.title}
        </span>
      </p>
      <p className="mt-1 break-words">
        {activity.community.name} · {activityStatusLabel(activity.status)}
      </p>
      <p className="mt-1 break-words">
        {published
          ? '已关联到当前活动。'
          : `该活动当前${activityStatusLabel(activity.status)}，暂不可用于购买。`}
      </p>
    </div>
  )
}
