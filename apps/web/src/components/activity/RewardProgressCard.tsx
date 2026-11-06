import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  Gift,
  RefreshCw,
  ShieldCheck,
  Ticket,
  Users,
} from 'lucide-react'
import { Link } from 'react-router'
import type { useResidentAuth } from '../../hooks/useResidentAuth'
import type { useRewardProgress } from '../../hooks/useRewardProgress'
import { browserLocation, buildWechatLoginRequest, saveActivityLoginContext } from './loginReturn'
import { isWeChatBrowser } from '../auth/wechatEnvironment'
import { SILVER_NEIGHBORHOOD_ACTIVITY_PATH } from './share'
import {
  claimRecipientLabels,
  credentialExpiryText,
  formatRewardDateTime,
  grantStatusLabels,
  rewardBucketClasses,
  rewardBucketDetail,
  rewardBucketLabels,
  rewardBucketOf,
  rewardReasonText,
} from './rewardLabels'

type ResidentAuth = ReturnType<typeof useResidentAuth>
type Progress = ReturnType<typeof useRewardProgress>

type Feedback = { tone: 'success' | 'error'; text: string } | null

const primaryButton =
  'flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[14px] bg-teal-700 px-4 text-[14px] font-bold text-white transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600'
const secondaryButton =
  'flex min-h-[44px] items-center justify-center gap-1.5 rounded-full border border-teal-200 bg-white px-4 text-[12px] font-semibold text-teal-700 transition-colors hover:bg-[#f2f8f5] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600'

function ProgressBar({ value, total, label }: { value: number; total: number; label: string }) {
  const percent = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  return (
    <div className="mt-1.5">
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-teal-600 transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function LoadingLine({ text }: { text: string }) {
  return (
    <p
      className="mt-3 flex items-center gap-2 text-[12px] font-medium text-slate-500"
      role="status"
      aria-live="polite"
    >
      <span
        className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-teal-700/25 border-t-teal-700"
        aria-hidden="true"
      />
      {text}
    </p>
  )
}

/**
 * Real check-in progress, team reward qualification and the one-time credential.
 *
 * Everything rendered here is server truth from `GET/POST .../checkin` and
 * `GET/POST .../rewards`:
 *
 * - a self check-in lands unverified, so the copy is 「签到成功，待现场核验」 and it
 *   never claims the reward requirement is satisfied;
 * - the claim button is enabled only by `claimableByMe`, which the API derives
 *   from the frozen plan's recipient rule;
 * - the plaintext code appears exactly once, in the claim response, and is
 *   shown as a one-time card instead of being stored.
 *
 * The demo panels (抽奖 / 大奖 / 里程碑) are deliberately not part of this card.
 */
export function RewardProgressCard({
  auth,
  progress,
  activityId,
  inviteCode,
  inviteInvalid,
}: {
  auth: ResidentAuth
  progress: Progress
  /** Return-to context for the WeChat login CTA (#92); login must come back here. */
  activityId: string | null
  inviteCode: string | null
  inviteInvalid: boolean
}) {
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [issuedCode, setIssuedCode] = useState<{ code: string; prizeName: string } | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const state = progress.state

  const startWechatLogin = () => {
    // Same path as the participation card: save the pre-login activity context,
    // then let the API return the resident to this exact activity link.
    if (typeof navigator === 'undefined' || !isWeChatBrowser(navigator.userAgent)) return
    const request = buildWechatLoginRequest(browserLocation(), {
      activityId,
      inviteCode,
      inviteInvalid,
    })
    saveActivityLoginContext(request.context)
    window.location.assign(request.url)
  }

  const handleCheckIn = async () => {
    setFeedback(null)
    const outcome = await progress.checkIn()
    setFeedback(
      outcome.ok
        ? { tone: 'success', text: '签到成功，待现场核验。核验通过后才计入团队奖励进度。' }
        : { tone: 'error', text: outcome.message },
    )
  }

  const handleClaim = async () => {
    setFeedback(null)
    const outcome = await progress.claim()
    if (!outcome.ok) {
      setFeedback({ tone: 'error', text: outcome.message })
      return
    }
    setIssuedCode({ code: outcome.result.code, prizeName: outcome.result.grant.prizeName })
    setCopyState('idle')
    setFeedback(
      outcome.result.created
        ? { tone: 'success', text: '领取成功，凭据码仅在此处显示一次，请截图保存。' }
        : { tone: 'success', text: '你已领取过该奖励，已为你重新生成凭据码。' },
    )
  }

  const handleCopyCode = async () => {
    if (!issuedCode) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(issuedCode.code)
      } else {
        throw new Error('clipboard unavailable')
      }
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  return (
    <div className="mt-4">
      {state.status === 'idle' || state.status === 'loading' ? (
        <LoadingLine text={auth.loading ? '正在读取登录状态…' : '正在读取真实签到与奖励状态…'} />
      ) : null}

      {state.status === 'unauthenticated' ? (
        <div className="rounded-[14px] bg-[#f6f8f7] px-3 py-3">
          <p className="text-[12px] leading-5 text-slate-600">
            登录后可读取你在本活动的真实签到与团队奖励状态。签到需要先加入三人团。
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {auth.methods?.wechat && typeof navigator !== 'undefined' && isWeChatBrowser(navigator.userAgent) ? (
              <button
                type="button"
                onClick={startWechatLogin}
                className={secondaryButton}
              >
                微信授权登录
              </button>
            ) : null}
            {auth.methods?.developmentResidentLogin ? (
              <button
                type="button"
                disabled={auth.busy}
                onClick={() => void auth.developmentLogin()}
                className={secondaryButton}
              >
                {auth.busy ? '登录中…' : '开发测试登录'}
              </button>
            ) : null}
          </div>
          {auth.methods && !auth.methods.wechat && !auth.methods.developmentResidentLogin ? (
            <p className="mt-2 rounded-[12px] bg-slate-50 px-3 py-2.5 text-[11px] leading-5 text-slate-500">
              微信网页授权暂不可用：未配置公众号 AppID / AppSecret 或授权回调地址，请联系运营人员。
            </p>
          ) : null}
          {auth.error ? (
            <p role="alert" className="mt-2 break-words text-[11px] leading-5 text-rose-600">
              {auth.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="rounded-[14px] bg-[#fff7f0] p-3 text-[#7a4a2c]">
          <p className="break-words text-[12px] leading-5">{state.message}</p>
          <button type="button" onClick={progress.refresh} className={`${secondaryButton} mt-2`}>
            <RefreshCw size={14} aria-hidden="true" />
            重新读取
          </button>
        </div>
      ) : null}

      {state.status === 'ready' ? (
        <div className="grid gap-3">
          {/* ------------------------------ Check-in ------------------------------ */}
          <div className="rounded-[16px] border border-slate-100 bg-white p-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[14px] font-bold text-slate-800">
                  <Clock3 size={15} className="shrink-0 text-teal-700" aria-hidden="true" />
                  我的签到
                </p>
                <p className="mt-1 text-[11px] leading-[18px] text-slate-500">
                  {state.data.checkin.checkinWindow
                    ? `签到窗口 ${formatRewardDateTime(state.data.checkin.checkinWindow.opensAt)} 至 ${formatRewardDateTime(state.data.checkin.checkinWindow.closesAt)}`
                    : '本活动尚未配置正式签到窗口。'}
                </p>
              </div>
              {state.data.checkin.countsForReward ? (
                <span className="shrink-0 rounded-full bg-[#e8f6f0] px-2.5 py-1 text-[11px] font-bold text-teal-700">
                  已核验
                </span>
              ) : state.data.checkin.checkin ? (
                <span className="shrink-0 rounded-full bg-[#fff3e6] px-2.5 py-1 text-[11px] font-bold text-[#a96b2f]">
                  待核验
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-500">
                  未签到
                </span>
              )}
            </div>

            {state.data.checkin.checkin ? (
              <div className="mt-2.5 rounded-[12px] bg-[#f4f9f6] px-3 py-2.5">
                <p className="text-[12px] font-semibold leading-5 text-[#225c4c]">
                  {state.data.checkin.countsForReward
                    ? '签到已由工作人员现场核验，计入团队奖励进度。'
                    : '签到成功，待现场核验。核验通过后才计入团队奖励进度。'}
                </p>
                <p className="mt-1 text-[11px] leading-[18px] text-slate-500">
                  签到时间 {formatRewardDateTime(state.data.checkin.checkin.checkedInAt)}
                  {state.data.checkin.checkin.verifiedAt
                    ? ` · 核验时间 ${formatRewardDateTime(state.data.checkin.checkin.verifiedAt)}`
                    : ''}
                </p>
              </div>
            ) : (
              <p className="mt-2.5 text-[12px] leading-5 text-slate-600">
                {state.data.checkin.available
                  ? '在签到窗口内可以立即签到；到场后由工作人员核验。'
                  : rewardReasonText(state.data.checkin.unavailableReason)}
              </p>
            )}

            {!state.data.checkin.checkin ? (
              <button
                type="button"
                onClick={() => void handleCheckIn()}
                disabled={!state.data.checkin.available || progress.busy === 'checkin'}
                className={`${primaryButton} mt-3`}
              >
                <CheckCircle2 size={17} aria-hidden="true" />
                {progress.busy === 'checkin' ? '提交中…' : '我要签到'}
              </button>
            ) : null}

            {!state.data.checkin.checkin && !state.data.checkin.available ? (
              <Link
                to={SILVER_NEIGHBORHOOD_ACTIVITY_PATH}
                className={`${secondaryButton} mt-2 w-full`}
              >
                <Users size={14} aria-hidden="true" />
                查看三人团状态
              </Link>
            ) : null}
          </div>

          {/* ---------------------------- Team reward ---------------------------- */}
          <div className="rounded-[16px] border border-slate-100 bg-white p-3.5">
            <p className="flex items-center gap-1.5 text-[14px] font-bold text-slate-800">
              <Gift size={15} className="shrink-0 text-teal-700" aria-hidden="true" />
              团队奖励
            </p>

            {state.data.gate?.kind === 'no_team' ? (
              <p className="mt-2 rounded-[12px] bg-slate-50 px-3 py-2.5 text-[12px] leading-5 text-slate-600">
                你还没有加入三人团，暂不满足奖励条件。参与并坐满 3 人后，这里会显示真实的签到与奖励进度。
              </p>
            ) : null}

            {state.data.gate?.kind === 'plan_missing' ? (
              <p className="mt-2 rounded-[12px] bg-slate-50 px-3 py-2.5 text-[12px] leading-5 text-slate-600">
                本活动暂未配置正式奖励计划，奖励入口未开放。页面不会用演示奖品替代正式奖励。
              </p>
            ) : null}

            {state.data.reward && state.data.reward.planConfigured && state.data.reward.reward ? (
              <>
                <div className="mt-2.5 rounded-[12px] bg-[#f4f9f6] px-3 py-2.5">
                  <p className="text-[13px] font-bold text-[#225c4c]">
                    {state.data.reward.reward.prizeName} · 每团 {state.data.reward.reward.prizeQuantityPerTeam} 份
                  </p>
                  <p className="mt-1 text-[11px] leading-[18px] text-slate-500">
                    {claimRecipientLabels[state.data.reward.reward.claimRecipient]} · 凭据有效期{' '}
                    {state.data.reward.reward.redemptionValidHours} 小时
                  </p>
                </div>

                <dl className="mt-3 grid gap-2.5">
                  <div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-[12px] font-semibold text-slate-600">团队人数</dt>
                      <dd className="text-[12px] font-bold text-slate-800">
                        {state.data.reward.requirement.seatsFilled}/3
                        {state.data.reward.requirement.seatsSatisfied ? (
                          <CheckCircle2
                            size={13}
                            className="ml-1 inline text-teal-600"
                            aria-label="已满足"
                          />
                        ) : null}
                      </dd>
                    </div>
                    <ProgressBar
                      value={state.data.reward.requirement.seatsFilled}
                      total={3}
                      label="团队人数进度"
                    />
                  </div>
                  <div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-[12px] font-semibold text-slate-600">有效签到</dt>
                      <dd className="text-[12px] font-bold text-slate-800">
                        {state.data.reward.requirement.checkinsValid}/3
                        {state.data.reward.requirement.checkinsSatisfied ? (
                          <CheckCircle2
                            size={13}
                            className="ml-1 inline text-teal-600"
                            aria-label="已满足"
                          />
                        ) : null}
                      </dd>
                    </div>
                    <ProgressBar
                      value={state.data.reward.requirement.checkinsValid}
                      total={3}
                      label="团队有效签到进度"
                    />
                  </div>
                </dl>

                <p className="mt-2 text-[11px] leading-[18px] text-slate-500">
                  只有「现场核验通过」的签到计入进度；自行签到未核验前不计入。
                </p>

                {state.data.reward.grant || state.data.reward.credential ? (
                  <div className="mt-3 rounded-[12px] border border-slate-100 bg-[#fbfdfc] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[12px] font-bold text-slate-800">我的奖励凭据</p>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          rewardBucketClasses[rewardBucketOf(state.data.reward)]
                        }`}
                      >
                        {rewardBucketLabels[rewardBucketOf(state.data.reward)]}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-[18px] text-slate-500">
                      {rewardBucketDetail(state.data.reward)}
                    </p>
                    {state.data.reward.credential ? (
                      <p className="mt-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
                        <Ticket size={13} className="shrink-0 text-teal-700" aria-hidden="true" />
                        凭据尾号 {state.data.reward.credential.maskedCode}
                      </p>
                    ) : null}
                    {state.data.reward.credential ? (
                      <p className="mt-0.5 text-[11px] leading-[18px] text-slate-400">
                        {credentialExpiryText(state.data.reward.credential)}
                      </p>
                    ) : null}
                    {state.data.reward.grant ? (
                      <p className="mt-0.5 text-[11px] leading-[18px] text-slate-400">
                        {grantStatusLabels[state.data.reward.grant.status]} · 发放于{' '}
                        {formatRewardDateTime(state.data.reward.grant.grantedAt)}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {issuedCode ? (
                  <div className="mt-3 rounded-[12px] border border-teal-200 bg-[#eef8f3] px-3 py-3">
                    <p className="flex items-center gap-1.5 text-[12px] font-bold text-[#225c4c]">
                      <ShieldCheck size={14} aria-hidden="true" />
                      {issuedCode.prizeName} · 核销凭据码
                    </p>
                    <p className="mt-1.5 select-all break-all font-mono text-[20px] font-bold tracking-[0.18em] text-[#195B4C]">
                      {issuedCode.code}
                    </p>
                    <p className="mt-1 text-[11px] leading-[18px] text-[#52786c]">
                      仅在本次显示，请截图保存。到活动现场由工作人员核销，核销后不可重复使用。
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleCopyCode()}
                      className={`${secondaryButton} mt-2 w-full`}
                    >
                      <Copy size={14} aria-hidden="true" />
                      {copyState === 'copied' ? '已复制' : '复制凭据码'}
                    </button>
                    {copyState === 'error' ? (
                      <p className="mt-1 text-[11px] leading-5 text-rose-600">
                        复制失败，请长按上面的凭据码手动复制。
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {state.data.reward.eligible && !state.data.reward.grant ? (
                  <button
                    type="button"
                    onClick={() => void handleClaim()}
                    disabled={!state.data.reward.claimableByMe || progress.busy === 'claim'}
                    className={`${primaryButton} mt-3`}
                  >
                    <Gift size={17} aria-hidden="true" />
                    {progress.busy === 'claim' ? '领取中…' : '领取奖励凭据'}
                  </button>
                ) : null}

                {state.data.reward.eligible &&
                !state.data.reward.grant &&
                !state.data.reward.claimableByMe ? (
                  <p className="mt-2 rounded-[12px] bg-[#fff7ec] px-3 py-2 text-[11px] leading-[18px] text-[#8a6132]">
                    {state.data.reward.reward.claimRecipient === 'leader'
                      ? '按本活动规则，只有队长可以领取该团队奖励。'
                      : '当前账号不可以领取该团队奖励，请联系队长或现场工作人员。'}
                  </p>
                ) : null}

                {!state.data.reward.eligible ? (
                  <p className="mt-2 rounded-[12px] bg-slate-50 px-3 py-2 text-[11px] leading-[18px] text-slate-600">
                    {rewardReasonText(state.data.reward.unavailableReason)}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          {feedback ? (
            <p
              role={feedback.tone === 'error' ? 'alert' : 'status'}
              className={`flex items-start gap-1.5 rounded-[12px] px-3 py-2 text-[12px] leading-5 ${
                feedback.tone === 'error'
                  ? 'bg-rose-50 text-rose-700'
                  : 'bg-[#eef8f3] text-[#225c4c]'
              }`}
            >
              {feedback.tone === 'error' ? (
                <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              ) : (
                <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 break-words">{feedback.text}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
