import { useState } from 'react'
import { AlertTriangle, ArrowRight, MessageCircle, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { buildResidentLoginHref } from '../auth/residentLogin'
import { appRouteFromLocation, browserLocation, type ActivityLoginResult } from './loginReturn'

type ActivityLoginCardProps = {
  activityId: string | null
  /** Valid invite code from the deep link, never invented. */
  inviteCode: string | null
  /** The deep link carried an invite value that failed contract validation. */
  inviteInvalid: boolean
  /** One-off login marker captured before the activity page cleans the URL. */
  loginResult: ActivityLoginResult
}

const primaryButtonClassName =
  'flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[14px] bg-teal-700 px-4 text-[14px] font-bold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600'

/**
 * Activity pages only provide a doorway to the single resident login screen.
 * Login method availability, OAuth initiation, phone verification and retry
 * states all live on /login; this component carries only the activity context.
 */
export function ActivityLoginCard({
  activityId,
  inviteCode,
  inviteInvalid,
  loginResult,
}: ActivityLoginCardProps) {
  const [dismissed, setDismissed] = useState(false)
  const errorMessage =
    !dismissed && loginResult?.status === 'error' ? loginResult.message : null
  const loginHref = buildResidentLoginHref(
    appRouteFromLocation(browserLocation()),
    { activityId, inviteCode, inviteInvalid },
    loginResult?.status === 'error' ? loginResult.code : null,
  )

  return (
    <div className="mt-3 grid gap-2" aria-label="居民登录入口">
      {errorMessage ? (
        <div
          role="alert"
          className="rounded-[12px] bg-[#fff1ee] px-3 py-2.5 text-[12px] leading-5 text-rose-700"
        >
          <p className="flex items-start gap-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{errorMessage}</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Link
              to={loginHref}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-rose-700 px-4 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700"
            >
              重新登录
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="inline-flex min-h-[44px] items-center rounded-full px-3 text-[12px] font-semibold text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
            >
              稍后再说
            </button>
          </div>
        </div>
      ) : null}

      <Link to={loginHref} className={primaryButtonClassName}>
        <MessageCircle size={17} aria-hidden="true" />
        微信 / 手机号登录
      </Link>
      <p className="flex items-start gap-1.5 text-[11px] leading-4 text-slate-400">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          登录后回到本活动；登录只建立居民身份，不会自动报名，参与仍需你主动确认。
        </span>
      </p>
    </div>
  )
}
