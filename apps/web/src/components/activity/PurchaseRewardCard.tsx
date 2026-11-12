import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ShoppingBasket,
  Ticket,
  Users,
  Wallet,
} from 'lucide-react'
import { Link } from 'react-router'
import type { PublicActivityDetail } from '@sanchuang-dev/local-life-contracts'
import type { useResidentAuth } from '../../hooks/useResidentAuth'
import type { usePurchaseRewardProgress } from '../../hooks/usePurchaseRewardProgress'
import type { useCouponWallet } from '../../hooks/useCouponWallet'
import { buildResidentLoginHref } from '../auth/residentLogin'
import { SILVER_NEIGHBORHOOD_ACTIVITY_PATH } from './share'
import { formatCents } from './rewardLabels'
import {
  buildPurchaseRewardSummary,
  couponStatusView,
  findLatestTeamCoupon,
  purchaseActivityPhase,
  purchasePhaseNotice,
  purchaseRewardGrantText,
  PURCHASE_REWARD_TEAM_SIZE,
} from './purchaseRewardUi'
import { localCatalogHref } from '../life/catalogLinks'

type ResidentAuth = ReturnType<typeof useResidentAuth>
type Progress = ReturnType<typeof usePurchaseRewardProgress>
type Coupons = ReturnType<typeof useCouponWallet>

const toneClasses = {
  slate: 'bg-slate-100 text-slate-600',
  orange: 'bg-[#fff3e6] text-[#a96b2f]',
  teal: 'bg-[#e8f6f0] text-teal-700',
  rose: 'bg-rose-50 text-rose-600',
} as const

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

function RetryLine({
  title,
  message,
  onRetry,
}: {
  title: string
  message: string
  onRetry: () => void
}) {
  return (
    <div role="alert" className="mt-3 rounded-[14px] border border-[#efd0b8] bg-[#fff7f0] px-3 py-2.5 text-[#7a4a2c]">
      <p className="flex items-center gap-1.5 text-[12px] font-bold">
        <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
        {title}
      </p>
      <p className="mt-1 break-words text-[11px] leading-5">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1.5 inline-flex min-h-[36px] items-center gap-1 rounded-full border border-[#d9b99a] bg-white px-3 text-[11px] font-semibold text-[#7a4a2c]"
      >
        <RefreshCw size={12} aria-hidden="true" />
        重新读取
      </button>
    </div>
  )
}

/**
 * Independent consumption-team task (#214).
 *
 * This card only exists when the published activity really carries a purchase
 * reward plan. It renders #210 progress and the caller's own #211 coupon; it
 * never calculates money, issues a coupon, writes an order or reuses the old
 * demonstration products. The check-in task remains a separate card.
 */
export function PurchaseRewardCard({
  activity,
  auth,
  progress,
  coupons,
  inviteCode,
  inviteInvalid,
}: {
  activity: PublicActivityDetail
  auth: ResidentAuth
  progress: Progress
  coupons: Coupons
  inviteCode: string | null
  inviteInvalid: boolean
}) {
  const ready = progress.state.status === 'ready' ? progress.state.data : null
  const effectivePlan = ready?.plan ?? activity.purchaseReward
  const summary = buildPurchaseRewardSummary(effectivePlan, ready?.progress ?? null)
  const phase = purchaseActivityPhase(activity, Date.now())
  const notice = purchasePhaseNotice[phase]
  const couponItems = coupons.state.status === 'ready' ? coupons.state.items : []
  const teamCoupon =
    ready?.progress && ready.progress.teamId
      ? findLatestTeamCoupon(couponItems, activity.id, ready.progress.teamId)
      : null
  const grantText = ready
    ? purchaseRewardGrantText(effectivePlan, ready.progress, teamCoupon)
    : null
  const couponView = teamCoupon ? couponStatusView(teamCoupon) : null
  const grantIsWarning =
    teamCoupon === null ||
    teamCoupon.status === 'void' ||
    teamCoupon.status === 'expired' ||
    (effectivePlan !== null && teamCoupon.faceValueCents !== effectivePlan.couponFaceValueCents)

  return (
    <section className="mx-4 mt-5" aria-labelledby="purchase-reward-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold tracking-[0.16em] text-[#b45f1c]">PURCHASE REWARD</p>
          <h2
            id="purchase-reward-heading"
            className="mt-1 text-[19px] font-bold tracking-tight text-slate-900"
          >
            消费组团奖励
          </h2>
        </div>
        <Link
          to="/me/rewards"
          state={{ from: '/community/activity/silver-neighborhood' }}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-full bg-[#e8f6f0] px-3 text-[12px] font-bold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <Wallet size={14} aria-hidden="true" />
          我的奖励
        </Link>
      </div>

      <div className="rounded-[20px] border border-slate-100 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-[#fff7ec] px-2.5 py-1 text-[11px] font-bold text-[#8a6132]">
            独立消费任务
          </span>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
            门槛 {formatCents(effectivePlan?.thresholdCents ?? 0)}
          </span>
          <span className="rounded-full bg-[#eef7f2] px-2.5 py-1 text-[11px] font-semibold text-[#388b77]">
            每人券 {formatCents(effectivePlan?.couponFaceValueCents ?? 0)}
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-5 text-slate-500">
          与签到任务相互独立：三人团累计有效实付达到门槛后，三位团员各获一张同面额消费券。
        </p>

        {notice ? (
          <p className="mt-2 rounded-[12px] bg-[#fff7ec] px-3 py-2 text-[11px] leading-5 text-[#8a6132]">
            {notice}
          </p>
        ) : null}

        {auth.loading || progress.state.status === 'idle' || progress.state.status === 'loading' ? (
          <LoadingLine text={auth.loading ? '正在读取登录状态…' : '正在读取消费团进度…'} />
        ) : progress.state.status === 'unauthenticated' ? (
          <div className="mt-3 rounded-[14px] border border-teal-200 bg-[#f4faf6] px-3 py-3">
            <p className="text-[12px] font-semibold text-[#225c4c]">
              登录后查看你的消费团进度与本人消费券。
            </p>
            <p className="mt-1 text-[11px] leading-5 text-[#52786c]">
              未登录时不会展示任何团队或券记录，登录也不会自动报名。
            </p>
            <Link
              to={buildResidentLoginHref(
                `${SILVER_NEIGHBORHOOD_ACTIVITY_PATH}?activityId=${activity.id}`,
                { activityId: activity.id, inviteCode, inviteInvalid },
              )}
              className="mt-2 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              去登录 / 查看登录方式
            </Link>
          </div>
        ) : progress.state.status === 'error' ? (
          <RetryLine
            title="消费团进度读取失败"
            message={progress.state.message}
            onRetry={progress.reload}
          />
        ) : summary === null ? (
          <p className="mt-3 rounded-[14px] bg-slate-50 px-3 py-3 text-[12px] leading-5 text-slate-500">
            本活动未配置消费奖励计划，不会生成消费券或消费团奖励。
          </p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${toneClasses[summary.tone]}`}
              >
                {summary.label}
              </span>
              <span className="text-[11px] font-semibold text-slate-500">
                {summary.seatsFilled}/{PURCHASE_REWARD_TEAM_SIZE} 人 · 累计 {formatCents(summary.totalCents)}
              </span>
            </div>
            <p className="mt-1.5 break-words text-[12px] leading-5 text-slate-600">
              {summary.detail}
            </p>

            <div className="mt-2">
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
                role="progressbar"
                aria-valuenow={summary.totalCents}
                aria-valuemin={0}
                aria-valuemax={summary.thresholdCents}
                aria-label="消费团有效实付进度"
              >
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ${
                    summary.eligible ? 'bg-teal-600' : 'bg-[#d59a57]'
                  }`}
                  style={{ width: `${summary.progressPercent}%` }}
                />
              </div>
              <p className="mt-1 text-right text-[10px] leading-4 text-slate-400">
                {summary.eligible
                  ? '已越过门槛'
                  : `门槛 ${formatCents(summary.thresholdCents)} · 还差 ${summary.remainingText}`}
              </p>
            </div>

            <div className="mt-3 rounded-[14px] border border-slate-100 bg-[#f8faf9] p-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600">
                <Users size={13} aria-hidden="true" />
                成员有效实付
              </p>
              <ul className="mt-1.5 divide-y divide-slate-100">
                {[1, 2, 3].map((seatNo) => {
                  const member = summary.members.find((item) => item.seatNo === seatNo)
                  return (
                    <li key={seatNo} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="min-w-0 break-words text-[11px] leading-4 text-slate-600">
                        {member ? (
                          <>
                            {member.displayName}
                            <span className="ml-1 text-[10px] text-slate-400">
                              {member.role === 'leader' ? '团长' : '团员'}
                            </span>
                            {member.isSelf ? (
                              <span className="ml-1 rounded-full bg-teal-50 px-1.5 py-0.5 text-[9px] font-bold text-teal-700">
                                我
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-slate-400">第 {seatNo} 位待加入</span>
                        )}
                      </span>
                      <span
                        className={`shrink-0 text-[11px] font-semibold ${
                          member && member.contributionCents > 0
                            ? 'text-[#225c4c]'
                            : 'text-slate-400'
                        }`}
                      >
                        {member ? member.contributionText : '—'}
                      </span>
                    </li>
                  )
                })}
              </ul>
              <p className="mt-1 text-[10px] leading-4 text-slate-400">
                只有入团后、已核验且关联收款凭据的本地订单金额才计入。
              </p>
            </div>

            {coupons.state.status === 'loading' ? (
              <LoadingLine text="正在读取消费券包…" />
            ) : coupons.state.status === 'error' ? (
              <RetryLine
                title="消费券包读取失败"
                message={coupons.state.message}
                onRetry={coupons.reload}
              />
            ) : coupons.state.status === 'ready' ? (
              <>
                {grantText ? (
                  <p
                    className={`mt-3 flex items-start gap-1.5 rounded-[12px] px-3 py-2.5 text-[11px] leading-5 ${
                      grantIsWarning
                        ? 'bg-[#fff7ec] text-[#8a6132]'
                        : 'bg-[#eef7f2] text-[#225c4c]'
                    }`}
                  >
                    {grantIsWarning ? (
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                    )}
                    <span className="min-w-0 break-words">{grantText}</span>
                  </p>
                ) : null}
                {teamCoupon && couponView ? (
                  <div className="mt-2 rounded-[14px] border border-[#dcebe2] bg-[#f4faf6] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[12px] font-bold text-[#225c4c]">
                        <Ticket size={14} aria-hidden="true" />
                        我的消费券
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${toneClasses[couponView.tone]}`}
                      >
                        {couponView.label}
                      </span>
                    </div>
                    <p className="mt-1 text-[20px] font-bold leading-none text-[#a96b2f]">
                      {formatCents(teamCoupon.faceValueCents)}
                    </p>
                    <p className="mt-1 text-[11px] leading-5 text-slate-600">{couponView.detail}</p>
                    <p className="mt-0.5 text-[10px] leading-4 text-slate-400">
                      {couponView.expiresText}
                    </p>
                  </div>
                ) : null}
              </>
            ) : null}

            <Link
              to={localCatalogHref(activity.id)}
              className="mt-3 flex min-h-[48px] items-center justify-center gap-1.5 rounded-[14px] bg-teal-700 px-4 text-[13px] font-bold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <ShoppingBasket size={16} aria-hidden="true" />
              去本地好物登记订单
            </Link>
            <p className="mt-1.5 text-center text-[10px] leading-4 text-slate-400">
              登记不代表已付款；入团后、核验并关联收款凭据的有效实付才计入团队进度。
            </p>
          </>
        )}
      </div>
    </section>
  )
}
