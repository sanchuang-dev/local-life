import { QRCodeSVG } from 'qrcode.react'
import type { PublicActivityDetail } from '@sanchuang-dev/local-life-contracts'
import { ActivityImage } from './ActivityImage'
import {
  ACTIVITY_THEME_TOKENS,
  resolveActivityPosterCopy,
  resolveActivityPosterImageCandidates,
  resolveActivityThemeKey,
} from './activityVisual'
import './activityTheme.css'

type ActivitySharePosterProps = {
  activity: PublicActivityDetail
  /** Real activity URL from `buildActivityShareUrl` (activityId + optional invite). */
  shareUrl: string
  seatsFilled: number | null
  seatsTotal: number | null
  selfParticipation: boolean
}

/**
 * One share poster for *this* activity: a single promotional image
 * (poster -> hero -> bundled fallback) plus the real activity QR code.
 *
 * The QR code lives in its own fixed white area below the artwork and copy, so
 * it never covers the poster's main content. It is rendered from `shareUrl`
 * (never from the poster image) and there is no poster/QR position editor.
 */
export function ActivitySharePoster({
  activity,
  shareUrl,
  seatsFilled,
  seatsTotal,
  selfParticipation,
}: ActivitySharePosterProps) {
  const candidates = resolveActivityPosterImageCandidates(
    activity.visualConfig,
    import.meta.env.BASE_URL,
  )
  const copy = resolveActivityPosterCopy(activity, seatsFilled, seatsTotal)
  const tokens = ACTIVITY_THEME_TOKENS[resolveActivityThemeKey(activity.visualConfig?.themeKey)]

  return (
    <div className="activity-poster mx-auto w-full max-w-[300px] min-w-0 overflow-hidden rounded-2xl border shadow-[0_9px_25px_rgba(26,88,62,0.08)]">
      <div className="aspect-[3/4] w-full overflow-hidden bg-[var(--activity-surface)]">
        <ActivityImage
          key={`poster:${activity.id}:${candidates.join('|')}`}
          candidates={candidates}
          alt={`${activity.title}活动宣传海报`}
          className="h-full w-full object-contain"
          loading="lazy"
        />
      </div>
      <div className="px-3 pb-3 pt-3">
        <div className="text-center">
          <p className="activity-poster__title break-words text-[17px] font-bold leading-6">
            {copy.title}
          </p>
          <p className="activity-poster__subtitle mt-1 break-words text-[12px] leading-5">
            {copy.subtitle}
          </p>
        </div>
        <div className="activity-poster__qr mt-3 max-w-full rounded-xl border px-3 py-3 text-center">
          <div className="relative mx-auto w-fit max-w-full rounded-lg bg-white">
            <QRCodeSVG
              value={shareUrl}
              size={148}
              level="H"
              marginSize={3}
              fgColor={tokens.primaryStrong}
              bgColor="#FFFFFF"
              title={`${activity.title}活动直达二维码`}
            />
            {selfParticipation ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span
                  aria-label="我的团席位"
                  className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-[var(--activity-primary)] text-[13px] font-bold text-[var(--activity-on-primary)] shadow-sm"
                >
                  我
                </span>
              </div>
            ) : null}
          </div>
          <p className="activity-poster__caption mt-2 break-words text-[12px] font-semibold">
            扫码打开本活动 · 邻里一起领好礼
          </p>
        </div>
        <p className="mt-2 text-center text-[11px] leading-4 text-slate-500">
          好友打开链接后，需主动确认加入三人团。
        </p>
        <p className="mt-1 text-center text-[11px] leading-4 text-slate-400">
          线上正式域名待配置；本地开发时该链接仅本机可访问。
        </p>
      </div>
    </div>
  )
}
