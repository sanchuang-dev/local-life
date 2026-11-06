import { useState } from 'react'
import { AlertTriangle, MessageCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import { presentLoginMarker } from '@sanchuang-dev/local-life-contracts'
import { isWeChatBrowser } from '../auth/wechatEnvironment'
import { useActivityLoginReturn } from '../../hooks/useActivityLoginReturn'
import { activityLoginMarker, type ActivityLoginResult } from './loginReturn'

type ActivityLoginCardProps = {
  activityId: string | null
  /** Validated invite code from the deep link, never invented. */
  inviteCode: string | null
  /** The deep link carried an invite value that failed contract validation. */
  inviteInvalid: boolean
  /**
   * One-off login marker snapshot, captured by the page before the URL cleanup
   * (#92). Only the failure marker is presented here.
   */
  loginResult: ActivityLoginResult
}

const primaryButtonClassName =
  'flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[14px] bg-teal-700 px-4 text-[14px] font-bold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600'

/**
 * WeChat login call-to-action for the activity page (#92).
 *
 * Three states are rendered explicitly instead of pretending:
 * - WeChat is configured: the resident starts the authorization and comes back to
 *   this exact activity link (`activityId` / `invite` preserved by the API).
 * - WeChat is not configured: the entry says so, with the reason, and there is no
 *   button that could look like a successful login.
 * - The API cannot be reached: the entry says so and offers a real retry.
 *
 * A denied or failed authorization always offers "重新发起登录"; nothing here
 * joins the activity — participation still needs an explicit confirm below.
 *
 * This card only exists while the session is unauthenticated, so it never
 * presents a success: `?auth=success` on a browser without a session shows the
 * normal login entry. Success belongs to the authenticated branch
 * (`ActivityLoginSuccessNotice`), gated on the server-confirmed session.
 */
export function ActivityLoginCard({
  activityId,
  inviteCode,
  inviteInvalid,
  loginResult,
}: ActivityLoginCardProps) {
  const login = useActivityLoginReturn({ activityId, inviteCode, inviteInvalid })
  const { availability, pendingContext } = login
  const [dismissed, setDismissed] = useState(false)
  const wechatBrowser = typeof navigator !== 'undefined' && isWeChatBrowser(navigator.userAgent)
  // `false` is the session state this card mounts in: a success marker is never
  // presented here, only a failure the resident can retry.
  const marker = dismissed ? null : activityLoginMarker(loginResult)
  const errorMessage =
    presentLoginMarker(marker, false, false) === 'error' && loginResult?.status === 'error'
      ? loginResult.message
      : null

  return (
    <div className="mt-3 grid gap-2" aria-label="微信登录">
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
            <button
              type="button"
              onClick={login.startWechatLogin}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-rose-700 px-4 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700"
            >
              <RefreshCw size={14} aria-hidden="true" />
              重新发起微信登录
            </button>
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

      {availability.status === 'loading' ? (
        <p
          className="flex items-center gap-2 text-[12px] font-medium text-slate-500"
          role="status"
          aria-live="polite"
        >
          <span
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-teal-700/25 border-t-teal-700"
            aria-hidden="true"
          />
          正在读取微信登录方式…
        </p>
      ) : null}

      {availability.status === 'error' ? (
        <div role="alert" className="rounded-[12px] bg-[#fff7f0] px-3 py-2.5 text-[12px] leading-5 text-[#7a4a2c]">
          <p className="break-words">{availability.message}</p>
          <button
            type="button"
            onClick={login.retryAvailability}
            className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-[#7a4a2c] px-4 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          >
            <RefreshCw size={14} aria-hidden="true" />
            重试
          </button>
        </div>
      ) : null}

      {availability.status === 'ready' && availability.wechat && wechatBrowser ? (
        <>
          <button type="button" onClick={login.startWechatLogin} className={primaryButtonClassName}>
            <MessageCircle size={17} aria-hidden="true" />
            微信授权登录
          </button>
          <p className="flex items-start gap-1.5 text-[11px] leading-4 text-slate-400">
            <ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              登录后会回到本活动链接，活动与邀请参数保留；登录成功不会自动报名，仍需你主动确认参与。
            </span>
          </p>
        </>
      ) : null}

      {availability.status === 'ready' && availability.wechat && !wechatBrowser ? (
        <p className="rounded-[12px] bg-slate-50 px-3 py-2.5 text-[12px] leading-5 text-slate-500">
          当前不是微信内置浏览器，公众号授权不可从这里发起。可使用下方手机号入口登录。
        </p>
      ) : null}

      {availability.status === 'ready' && !availability.wechat ? (
        <p className="rounded-[12px] bg-slate-50 px-3 py-2.5 text-[12px] leading-5 text-slate-500">
          微信网页授权暂不可用
          {availability.unavailableReason === 'not_configured'
            ? '：未配置公众号 AppID / AppSecret 或授权回调地址，请联系运营人员完成配置后重试。'
            : `（${availability.unavailableReason ?? '原因未知'}）。`}
        </p>
      ) : null}

      {pendingContext ? (
        <p className="rounded-[12px] bg-[#f6faf7] px-3 py-2 text-[11px] leading-4 text-[#4a6f61]">
          已保存登录前的活动上下文
          {pendingContext.activityId ? `（活动 ${pendingContext.activityId.slice(0, 8)}…）` : ''}
          {pendingContext.inviteCode || pendingContext.inviteInvalid ? '与邀请参数' : ''}
          ：登录成功后会回到本活动。
        </p>
      ) : null}
    </div>
  )
}
