import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  CircleHelp,
  Copy,
  MapPin,
  RefreshCw,
  Share2,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import type { PublicActivityDetail } from '@sanchuang-dev/local-life-contracts'
import { CampaignSheet } from '../components/CampaignSheet'
import { ParticipationTeamCard } from '../components/activity/ParticipationTeamCard'
import { PurchaseRewardCard } from '../components/activity/PurchaseRewardCard'
import { RewardProgressCard } from '../components/activity/RewardProgressCard'
import { DailyDrawCard } from '../components/activity/DailyDrawCard'
import { ActivityLoginMarkerCleanup } from '../components/activity/ActivityLoginResult'
import { readActivityLoginResult, type ActivityLoginResult } from '../components/activity/loginReturn'
import {
  credentialExpiryText,
  formatRewardDateTime,
  grantStatusLabels,
  rewardBucketClasses,
  rewardBucketDetail,
  rewardBucketLabels,
  rewardBucketOf,
} from '../components/activity/rewardLabels'
import { buildActivityShareUrl, parseInviteParam } from '../components/activity/share'
import { useActivityParticipation } from '../hooks/useActivityParticipation'
import { useCouponWallet } from '../hooks/useCouponWallet'
import { usePublicActivity, type PublicActivityLoadState } from '../hooks/usePublicActivity'
import { usePurchaseRewardProgress } from '../hooks/usePurchaseRewardProgress'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { useRewardProgress } from '../hooks/useRewardProgress'
import { useWechatActivityShare } from '../hooks/useWechatActivityShare'

type SheetKind = 'rules' | 'share' | 'checkin-reward' | 'my-rewards' | null

type ShareStatus = 'idle' | 'shared' | 'copied' | 'cancelled' | 'error' | 'wechat-hint'

/**
 * Activity timestamps come from the API in UTC; every rendered value is
 * converted to Asia/Shanghai so the schedule reads the same for every resident
 * regardless of the device time zone.
 */
function shanghaiDateParts(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

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

  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
  }
}

function formatShanghaiDateTime(value: string): string {
  const parts = shanghaiDateParts(value)
  if (!parts) return value
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`
}

type CampaignPhase = 'upcoming' | 'active' | 'paused' | 'ended'

/**
 * Resident-facing phase. The API status is authoritative for pause/end; a
 * published activity whose end time has passed is also shown as ended instead
 * of pretending it is still running.
 */
function campaignPhase(activity: PublicActivityDetail, now: number): CampaignPhase {
  if (activity.status === 'paused') return 'paused'
  if (activity.status === 'ended') return 'ended'
  if (now >= Date.parse(activity.endsAt)) return 'ended'
  if (now < Date.parse(activity.startsAt)) return 'upcoming'
  return 'active'
}

const phaseLabels: Record<CampaignPhase, string> = {
  upcoming: '活动即将开始',
  active: '活动进行中',
  paused: '活动已暂停',
  ended: '活动已结束',
}

const phaseTones: Record<CampaignPhase, string> = {
  upcoming: 'font-bold text-[#b45f1c]',
  active: 'font-bold text-[#126c38]',
  paused: 'font-bold text-[#8a6132]',
  ended: 'font-semibold text-[#687c6c]',
}

function ActivityCountdown({ activity }: { activity: PublicActivityDetail }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const phase = campaignPhase(activity, now)
  const startsAt = Date.parse(activity.startsAt)
  const endsAt = Date.parse(activity.endsAt)
  const showCountdown = phase === 'upcoming' || phase === 'active'
  const target = phase === 'upcoming' ? startsAt : endsAt
  const remainder = Math.max(0, target - now)
  const totalSeconds = Math.ceil(remainder / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const twoDigits = (value: number) => String(value).padStart(2, '0')

  const numberBlock = (value: number, label: string) => (
    <span
      aria-label={label}
      className="inline-flex h-[27px] min-w-[28px] items-center justify-center rounded-[5px] bg-[#154f2c] px-1 text-[16px] font-bold leading-none text-white shadow-[0_2px_4px_rgba(12,67,34,0.18)] tabular-nums"
    >
      {twoDigits(value)}
    </span>
  )

  return (
    <div className="relative z-[1] mx-3 -mt-2" role="timer" aria-label={phaseLabels[phase]}>
      <div className="relative rounded-t-[12px] bg-gradient-to-b from-[#d8f0cc] via-[#e1f3d8]/85 to-transparent px-2.5 pb-5 pt-2.5 text-[#275942]">
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] leading-4">
          <span className={phaseTones[phase]}>{phaseLabels[phase]}</span>
          <span className="font-medium text-[#375e40]">
            {formatShanghaiDateTime(activity.startsAt)} - {formatShanghaiDateTime(activity.endsAt)}
          </span>
          <span className="text-[10px] font-medium text-[#52786c]">北京时间</span>
        </div>
        {showCountdown ? (
          <div className="mt-1.5 flex items-center justify-center gap-1 text-[12px] font-semibold text-[#285039]">
            <span className="mr-0.5">{phase === 'upcoming' ? '距开始' : '还剩'}</span>
            {numberBlock(days, '天数')}
            <span className="mx-0.5">天</span>
            {numberBlock(hours, '小时')}
            <span>:</span>
            {numberBlock(minutes, '分钟')}
            <span>:</span>
            {numberBlock(seconds, '秒')}
          </div>
        ) : (
          <p className="mt-2 text-center text-[13px] font-semibold leading-6">
            {phase === 'paused' ? '活动已暂停，等待恢复通知' : '本期活动已结束'}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Real loading / empty / error states for the activity header. None of them
 * substitutes demo data, and the error branch keeps the real message visible
 * with an explicit retry action.
 */
function ActivityLoadNotice({
  state,
  onRetry,
}: {
  state: Exclude<PublicActivityLoadState, { status: 'ready' }>
  onRetry: () => void
}) {
  const wrapper = 'relative z-[1] mx-3 -mt-2'

  if (state.status === 'loading') {
    return (
      <div className={wrapper} role="status" aria-live="polite">
        <div className="rounded-t-[12px] bg-gradient-to-b from-[#d8f0cc] via-[#e1f3d8]/85 to-transparent px-3 pb-5 pt-3 text-[#275942]">
          <div className="flex items-center justify-center gap-2 text-[12px] font-semibold">
            <span
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#126c38]/25 border-t-[#126c38]"
              aria-hidden="true"
            />
            正在加载活动信息…
          </div>
        </div>
      </div>
    )
  }

  if (state.status === 'empty') {
    return (
      <div className={wrapper} role="status">
        <div className="rounded-t-[12px] bg-gradient-to-b from-[#d8f0cc] via-[#e1f3d8]/85 to-transparent px-3 pb-5 pt-3 text-center text-[#275942]">
          <p className="text-[14px] font-bold">当前没有已发布活动</p>
          <p className="mt-1 text-[11px] leading-4 text-[#52786c]">
            有新活动发布后，可以在这里查看活动详情。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={wrapper} role="alert">
      <div className="rounded-t-[12px] border border-[#efd0b8] bg-[#fff7f0] px-3 pb-4 pt-3 text-[#7a4a2c]">
        <p className="flex items-center gap-1.5 text-[13px] font-bold">
          <AlertTriangle size={15} aria-hidden="true" />
          活动信息加载失败
        </p>
        <p className="mt-1 break-words text-[11px] leading-4">{state.message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-[#7a4a2c] px-4 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
        >
          <RefreshCw size={14} aria-hidden="true" />
          重试
        </button>
      </div>
    </div>
  )
}

const activityPath = '/community/activity/silver-neighborhood'

const fallbackCopy = (value: string) => {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  return copied
}

export function SilverNeighborhoodCampaignPage() {
  const [searchParams] = useSearchParams()
  // A deep link may target a specific published activity; everything else reads
  // the first item of the public activity list.
  const requestedActivityId = searchParams.get('activityId')?.trim() || null
  // The invite code is attribution from the URL, not a user id: the resident is
  // always identified by the session cookie on the server side.
  const inviteParam = parseInviteParam(searchParams.get('invite'))
  const { state: activityState, retry: retryActivity } = usePublicActivity(requestedActivityId)
  const activity = activityState.status === 'ready' ? activityState.activity : null
  // The resident root (`/`) is now the activity home; this page stays the full
  // playbook sub-page reachable from old deep links and QR codes. The back link
  // keeps the same real activity and invite parameters so both entries agree.
  const homeParams = new URLSearchParams()
  if (activity) homeParams.set('activityId', activity.id)
  if (inviteParam.code) homeParams.set('invite', inviteParam.code)
  const homeQuery = homeParams.toString()
  const homeUrl = homeQuery ? `/?${homeQuery}` : '/'
  const auth = useResidentAuth()
  // One-off `?auth=success` / `?auth_error=code` markers, read once before the
  // page-level cleanup strips them from the address bar (#92).
  const [loginResult] = useState<ActivityLoginResult>(() => readActivityLoginResult())
  const participation = useActivityParticipation({
    activityId: activity?.id ?? null,
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })
  // Real check-in progress and team reward qualification for this activity.
  // `csrfToken` comes from the authenticated session; a logged-out visitor can
  // still read the page but cannot write a check-in or a claim.
  const rewardProgress = useRewardProgress({
    activityId: activity?.id ?? null,
    csrfToken: auth.session?.csrfToken ?? null,
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })
  const rewardReady = rewardProgress.state.status === 'ready' ? rewardProgress.state.data : null

  const participationState =
    participation.state.status === 'ready' ? participation.state.data : null
  const team = participationState?.team ?? null
  const selfParticipation = participationState?.participation ?? null
  // Participation is the only page-local writer that can change consumption
  // eligibility. Re-reading on a seat change keeps both task cards consistent
  // after the third member joins from the card above.
  const purchaseRefreshKey = participationState
    ? `${participationState.team?.id ?? ''}:${participationState.team?.seatsFilled ?? 0}:${participationState.team?.status ?? ''}:${participationState.participation?.joinedAt ?? ''}`
    : ''
  // An activity without a real plan must not even trigger reward reads; the old
  // demonstration "消费组队" data is not a fallback source.
  const purchaseActivityId = activity?.purchaseReward ? activity.id : null
  const purchaseProgress = usePurchaseRewardProgress({
    activityId: purchaseActivityId,
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
    refreshKey: purchaseRefreshKey,
  })
  const couponWallet = useCouponWallet({
    sessionKey: purchaseActivityId ? (auth.session?.user.id ?? null) : null,
    authLoading: auth.loading,
    refreshKey: purchaseRefreshKey,
  })
  const remainingSeats = team ? Math.max(0, team.seatsTotal - team.seatsFilled) : 0
  // The single share URL used by QR, native share and copy-link. It only exists
  // when the resident is a member of an open team that still has a real invite
  // code; a locked 3/3 team gets no invite entry at all.
  const shareableActivity =
    activity && activity.status === 'published' && new Date(activity.endsAt).getTime() > Date.now()
      ? activity
      : null
  const shareUrl =
    shareableActivity &&
    team &&
    selfParticipation &&
    team.status === 'open' &&
    team.seatsFilled < team.seatsTotal &&
    team.inviteCode
      ? buildActivityShareUrl(shareableActivity.id, team.inviteCode)
      : null
  const wechatShare = useWechatActivityShare(shareableActivity, shareUrl)

  const [activeSheet, setActiveSheet] = useState<SheetKind>(null)
  const [shareStatus, setShareStatus] = useState<ShareStatus>('idle')

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const openSheet = (sheet: SheetKind) => {
    if (sheet === 'share') setShareStatus('idle')
    setActiveSheet(sheet)
  }

  const openShareSheet = () => {
    if (!shareUrl) return
    setShareStatus('idle')
    setActiveSheet('share')
  }

  const handleCopyLink = async () => {
    if (!shareUrl) {
      setShareStatus('error')
      return
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl)
      } else if (!fallbackCopy(shareUrl)) {
        throw new Error('copy failed')
      }
      setShareStatus('copied')
    } catch {
      setShareStatus('error')
    }
  }

  const handleSystemShare = async () => {
    if (!shareUrl) {
      setShareStatus('error')
      return
    }
    if (wechatShare.isWechat) {
      setShareStatus('wechat-hint')
      return
    }
    if (!canNativeShare) {
      await handleCopyLink()
      return
    }

    try {
      await navigator.share({
        title: activity?.title ?? '银发社区欢乐季',
        text: `还差 ${remainingSeats} 位街坊，来一起组成三人团。`,
        url: shareUrl,
      })
      setShareStatus('shared')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setShareStatus('cancelled')
      } else {
        setShareStatus('error')
      }
    }
  }

  return (
    <div className="pb-7">
      {/* Remove callback markers regardless of the current session branch. */}
      <ActivityLoginMarkerCleanup
        authenticated={auth.session !== null}
        loading={auth.loading}
      />
      <nav className="bg-[#eaf5e9] px-3 pt-2" aria-label="活动页导航">
        <Link
          to={homeUrl}
          state={{ from: activityPath }}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-1 text-[13px] font-medium text-[#27725b] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          返回活动首页
        </Link>
      </nav>
      <section className="relative overflow-hidden bg-[#eaf5e9]" aria-label="活动信息">
        <div className="relative">
          <img
            src={import.meta.env.BASE_URL + 'images/silver-neighborhood-hero.webp'}
            alt="银发社区欢乐季，三人成团·天天有礼。三位长者在欢乐的社区活动中相聚。"
            className="block aspect-[4/3] w-full object-cover"
            fetchPriority="high"
          />
        </div>
        {activityState.status === 'ready' ? (
          <ActivityCountdown activity={activityState.activity} />
        ) : (
          <ActivityLoadNotice state={activityState} onRetry={retryActivity} />
        )}
        <div className="relative -mt-px bg-gradient-to-b from-[#edf8e9] via-[#e8f5ec] to-[#d8eee5] px-4 pb-16 pt-0">
          {activity ? (
            <>
              <div className="pt-3">
                <h1 className="break-words text-[19px] font-bold leading-[1.35] tracking-tight text-[#1f4d3c]">
                  {activity.title}
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-5 text-[#4a6f61]">
                  <span className="break-words">{activity.community.name}</span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <MapPin size={14} className="shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-words">{activity.location}</span>
                  </span>
                </p>
              </div>
              <div className="mt-1 flex min-h-[48px] items-center justify-between gap-2">
                <p className="text-[11px] leading-4 text-[#52786c]">
                  {activity.ruleVersion === null
                    ? '已发布公开规则'
                    : `已发布 · 规则第 ${activity.ruleVersion} 版`}
                </p>
                <button
                  type="button"
                  onClick={() => openSheet('rules')}
                  className="inline-flex min-h-[44px] shrink-0 items-center gap-1 px-1 text-[13px] font-medium text-[#27725b] hover:underline focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
                >
                  <CircleHelp size={16} aria-hidden="true" />
                  活动规则
                </button>
              </div>
            </>
          ) : (
            <div className="min-h-[96px]" aria-hidden="true" />
          )}
        </div>
      </section>

      <ParticipationTeamCard
        activity={activity}
        loginActivityId={requestedActivityId && activity ? activity.id : null}
        activityError={
          activityState.status === 'empty'
            ? '当前没有已发布的活动，暂不能读取参与状态。'
            : activityState.status === 'error'
              ? activityState.message
              : null
        }
        onRetryActivity={retryActivity}
        auth={auth}
        participation={participation}
        inviteCode={inviteParam.code}
        inviteInvalid={inviteParam.invalid}
        loginResult={loginResult}
        onShare={openShareSheet}
      />

      {activity?.purchaseReward ? (
        <PurchaseRewardCard
          activity={activity}
          auth={auth}
          progress={purchaseProgress}
          coupons={couponWallet}
          inviteCode={inviteParam.code}
          inviteInvalid={inviteParam.invalid}
        />
      ) : null}

      {activity ? (
        <DailyDrawCard
          key={activity.id}
          activityId={activity.id}
          userId={auth.session?.user.id ?? null}
          csrfToken={auth.session?.csrfToken ?? null}
          authLoading={auth.loading}
          inviteCode={inviteParam.code}
          inviteInvalid={inviteParam.invalid}
        />
      ) : null}

      {activity ? (
        <section className="mx-4 mt-5" aria-labelledby="team-reward-heading">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-[11px] font-bold tracking-[0.16em] text-teal-700">TEAM REWARD</p>
              <h2 id="team-reward-heading" className="mt-1 text-[19px] font-bold tracking-tight text-slate-900">
                团队签到奖励
              </h2>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => openSheet('checkin-reward')}
                className="min-h-[44px] rounded-full px-3 text-[12px] font-bold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                奖励说明
              </button>
              <button
                type="button"
                onClick={() => openSheet('my-rewards')}
                className="min-h-[44px] rounded-full bg-[#e8f6f0] px-3 text-[12px] font-bold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                我的奖励
              </button>
            </div>
          </div>
          <div className="rounded-[20px] border border-slate-100 bg-white p-3 shadow-sm">
            <p className="text-[14px] font-bold text-slate-800">三人有效签到</p>
            <p className="mt-1 text-[12px] leading-5 text-slate-500">
              只有现场核验通过的签到计入进度。
            </p>
            <RewardProgressCard
              auth={auth}
              progress={rewardProgress}
              activityId={activity.id}
              inviteCode={inviteParam.code}
              inviteInvalid={inviteParam.invalid}
            />
          </div>
        </section>
      ) : null}

      <CampaignSheet
        open={activeSheet === 'rules'}
        title="活动规则"
        eyebrow={activity ? 'SILVER NEIGHBORHOOD · 已发布规则' : 'SILVER NEIGHBORHOOD'}
        onClose={() => setActiveSheet(null)}
      >
        {activity ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] bg-[#eef7f2] p-3">
              <p className="text-[13px] font-bold text-[#225b44]">已发布规则快照</p>
              <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-teal-700">
                {activity.ruleVersion === null ? '未记录版本号' : `第 ${activity.ruleVersion} 版`}
              </span>
            </div>
            <ol className="mt-3 grid gap-3">
              {[
                { label: '参与资格', text: activity.publicRules.eligibility },
                { label: '签到规则', text: activity.publicRules.checkin },
                { label: '消费规则', text: activity.publicRules.purchase },
                { label: '奖品领取', text: activity.publicRules.prizeClaim },
              ].map((rule, index) => (
                <li key={rule.label} className="flex gap-3 rounded-[14px] bg-slate-50 p-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-700 text-[12px] font-bold text-white">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-bold text-slate-700">{rule.label}</span>
                    <span className="mt-1 block break-words leading-6">{rule.text}</span>
                  </span>
                </li>
              ))}
            </ol>
            {activity.publicRules.notes ? (
              <div className="mt-3 rounded-[14px] bg-[#fff7ec] p-3 text-[12px] leading-6 text-[#8a6132]">
                <p className="font-bold">补充说明</p>
                <p className="mt-1 break-words">{activity.publicRules.notes}</p>
              </div>
            ) : null}
            <p className="mt-3 text-[12px] leading-5 text-slate-400">
              {`以上为活动发布时固化的公开规则快照${
                activity.publishedAt
                  ? `，发布时间 ${formatShanghaiDateTime(activity.publishedAt)}（北京时间）`
                  : ''
              }。`}
            </p>
          </>
        ) : (
          <p className="rounded-[14px] bg-slate-50 p-3 text-[13px] leading-6 text-slate-500">
            尚未读取到已发布活动，暂无可展示的活动规则。请等待活动发布后重新打开页面。
          </p>
        )}
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'share'}
        title="邀请街坊加入三人团"
        eyebrow={team ? `TEAM ${team.seatsFilled} / ${team.seatsTotal}` : 'TEAM'}
        variant="poster"
        onClose={() => setActiveSheet(null)}
        footer={
          shareUrl ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleSystemShare}
                  className="flex min-h-[48px] items-center justify-center gap-1.5 rounded-[13px] bg-teal-700 px-2 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                >
                  <Share2 size={17} aria-hidden="true" />
                  {wechatShare.isWechat ? '微信内分享' : '转发给好友'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopyLink()}
                  className="flex min-h-[48px] items-center justify-center gap-1.5 rounded-[13px] border border-teal-200 bg-white px-2 text-[13px] font-semibold text-teal-700 transition-colors hover:bg-[#f2faf6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                >
                  <Copy size={17} aria-hidden="true" />
                  复制链接
                </button>
              </div>
              <p className="mt-2 text-center text-[11px] leading-4 text-slate-400">
                {wechatShare.isWechat
                  ? '请通过微信右上角「···」菜单发送给朋友或分享到朋友圈；也可复制链接或扫码。'
                  : '二维码、转发与复制使用同一条链接；截图保存暂未开放。'}
              </p>
              <div className="text-center text-[12px] font-medium" aria-live="polite">
                {wechatShare.isWechat && wechatShare.status === 'loading'
                  ? <p className="mt-1 text-slate-500">正在准备微信分享；复制链接与二维码不受影响。</p>
                  : null}
                {wechatShare.isWechat && wechatShare.status === 'error'
                  ? <p className="mt-1 text-orange-700">微信分享初始化失败，可复制链接或扫码。</p>
                  : null}
                {shareStatus === 'wechat-hint'
                  ? <p className="mt-1 text-teal-700">点击右上角「···」，选择好友或朋友圈。</p>
                  : null}
                {shareStatus === 'shared' ? <p className="mt-1 text-teal-700">已调起系统分享，好友需登录并主动确认才会加入。</p> : null}
                {shareStatus === 'copied' ? <p className="mt-1 text-teal-700">邀请链接已复制，包含当前活动与邀请参数。</p> : null}
                {shareStatus === 'cancelled' ? <p className="mt-1 text-slate-500">已取消分享，可再次点击转发。</p> : null}
                {shareStatus === 'error' ? <p className="mt-1 text-orange-700">分享或复制未成功，请稍后重试。</p> : null}
              </div>
            </>
          ) : undefined
        }
      >
        {shareUrl ? (
          <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-[20px] border border-[#deebdf] bg-[#f4faf3] shadow-[0_9px_25px_rgba(26,88,62,0.08)]">
            <img
              src={import.meta.env.BASE_URL + 'images/silver-neighborhood-hero.webp'}
              alt="银发社区欢乐季活动海报"
              className="block aspect-[4/3] w-full object-cover"
            />
            <div className="px-3 pb-3 pt-3">
              <div className="text-center">
                <p className="text-[17px] font-bold leading-6 text-[#176149]">还差你，三人成团领好礼</p>
                <p className="mt-1 text-[12px] text-[#547c6c]">
                  {activity?.community.name ?? '本社区'} · 已有 {team?.seatsFilled ?? 0} / {team?.seatsTotal ?? 3} 位街坊
                </p>
              </div>
              <div className="mt-3 rounded-[14px] border border-[#deece1] bg-white px-3 py-3 text-center">
                <div className="relative mx-auto w-fit rounded-lg bg-white">
                  <QRCodeSVG
                    value={shareUrl}
                    size={148}
                    level="H"
                    marginSize={3}
                    fgColor="#195B4C"
                    bgColor="#FFFFFF"
                    title="银发社区欢乐季活动直达二维码"
                  />
                  {selfParticipation ? (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <span
                        aria-label="我的团席位"
                        className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-[#247D67] text-[13px] font-bold text-white shadow-sm"
                      >
                        我
                      </span>
                    </div>
                  ) : null}
                </div>
                <p className="mt-2 text-[12px] font-semibold text-[#2f765f]">
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
        ) : (
          <p className="rounded-[14px] bg-slate-50 p-3 text-[13px] leading-6 text-slate-500">
            当前没有可用的邀请码（团队可能已满员、已锁定或你尚未参与）。邀请入口已关闭，请刷新参与状态。
          </p>
        )}
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'checkin-reward'}
        title={rewardReady?.reward?.reward?.prizeName ?? '团队奖励说明'}
        eyebrow="签到任务 · 团队奖励"
        onClose={() => setActiveSheet(null)}
      >
        <div className="rounded-[16px] bg-[#f2faf6] p-4">
          <p className="text-[15px] font-bold text-slate-800">解锁条件</p>
          <p className="mt-1">
            三人团坐满 3 人，且三位团员各有一次经现场核验的有效签到后，团队解锁一份奖励。
          </p>
        </div>
        <dl className="mt-3 divide-y divide-slate-100 rounded-[16px] border border-slate-100 bg-white px-4">
          {rewardReady?.reward?.reward ? (
            <>
              <div className="flex justify-between gap-4 py-3">
                <dt>奖品</dt>
                <dd className="min-w-0 break-words text-right font-semibold text-slate-800">
                  {rewardReady.reward.reward.prizeName} · 每团{' '}
                  {rewardReady.reward.reward.prizeQuantityPerTeam} 份
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-3">
                <dt>签到窗口</dt>
                <dd className="min-w-0 text-right font-semibold text-slate-800">
                  {formatRewardDateTime(rewardReady.reward.reward.checkinWindow.opensAt)} 至{' '}
                  {formatRewardDateTime(rewardReady.reward.reward.checkinWindow.closesAt)}
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-3">
                <dt>团队人数</dt>
                <dd className="text-right font-semibold text-slate-800">
                  {rewardReady.reward.requirement.seatsFilled}/3
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-3">
                <dt>有效签到</dt>
                <dd className="text-right font-semibold text-slate-800">
                  {rewardReady.reward.requirement.checkinsValid}/3
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-3">
                <dt>领取人</dt>
                <dd className="text-right font-semibold text-slate-800">
                  {rewardReady.reward.reward.claimRecipient === 'leader' ? '队长' : '任一团员'}
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-3">
                <dt>凭据有效期</dt>
                <dd className="text-right font-semibold text-slate-800">
                  {rewardReady.reward.reward.redemptionValidHours} 小时
                </dd>
              </div>
            </>
          ) : (
            <div className="flex justify-between gap-4 py-3">
              <dt>当前进度</dt>
              <dd className="min-w-0 break-words text-right font-semibold text-slate-800">
                {rewardProgress.state.status === 'ready'
                  ? rewardProgress.state.data.gate?.kind === 'no_team'
                    ? '尚未加入三人团'
                    : '本活动未配置正式奖励计划'
                  : rewardProgress.state.status === 'unauthenticated'
                    ? '登录后查看进度'
                    : rewardProgress.state.status === 'error'
                      ? '进度读取失败'
                      : '正在读取…'}
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-4 py-3">
            <dt>领取方式</dt>
            <dd className="text-right font-semibold text-slate-800">达标后领取凭据码，现场核销一次</dd>
          </div>
        </dl>
        <p className="mt-3 text-[12px] leading-5 text-slate-400">
          凭据码仅在领取时显示一次，请妥善保存。
        </p>
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'my-rewards'}
        title="我的奖励"
        eyebrow="ACTIVITY WALLET"
        onClose={() => setActiveSheet(null)}
        footer={
          <Link
            to="/me/rewards"
            className="flex min-h-[48px] w-full items-center justify-center rounded-[14px] bg-teal-700 px-4 text-[14px] font-bold text-white"
          >
            查看全部活动奖励
          </Link>
        }
      >
        {rewardReady?.reward ? (
          <div className="grid gap-3">
            <div className="rounded-[16px] border border-slate-100 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 break-words font-bold text-slate-800">
                  {rewardReady.reward.reward?.prizeName ?? '本活动团队奖励'}
                </p>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                    rewardBucketClasses[rewardBucketOf(rewardReady.reward)]
                  }`}
                >
                  {rewardBucketLabels[rewardBucketOf(rewardReady.reward)]}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-5 text-slate-500">
                {rewardBucketDetail(rewardReady.reward)}
              </p>
              {rewardReady.reward.credential ? (
                <p className="mt-2 rounded-[12px] bg-[#f4f9f6] px-3 py-2 font-mono text-[13px] font-semibold text-[#225c4c]">
                  凭据 {rewardReady.reward.credential.maskedCode}
                </p>
              ) : null}
              {rewardReady.reward.credential ? (
                <p className="mt-1 text-[11px] leading-[18px] text-slate-400">
                  {credentialExpiryText(rewardReady.reward.credential)}
                </p>
              ) : null}
              {rewardReady.reward.grant ? (
                <p className="mt-1 text-[11px] leading-[18px] text-slate-400">
                  {grantStatusLabels[rewardReady.reward.grant.status]} · 发放于{' '}
                  {formatRewardDateTime(rewardReady.reward.grant.grantedAt)}
                </p>
              ) : null}
            </div>
            <div className="rounded-[16px] border border-slate-100 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="font-bold text-slate-800">团队进度</p>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-500">
                  {rewardReady.reward.requirement.seatsFilled}/3 人 ·{' '}
                  {rewardReady.reward.requirement.checkinsValid}/3 签到
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-5 text-slate-500">
                有效签到指经工作人员现场核验的签到；自行签到未核验前不计入。
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-[16px] border border-slate-100 bg-white p-4">
            <p className="font-bold text-slate-800">本活动暂无奖励记录</p>
            <p className="mt-1 text-[12px] leading-5 text-slate-500">
              {rewardProgress.state.status === 'ready'
                ? rewardProgress.state.data.gate?.kind === 'no_team'
                  ? '你还没有加入三人团，暂不满足奖励条件。'
                  : '本活动尚未配置正式奖励计划，未生成任何奖励或凭据。'
                : rewardProgress.state.status === 'unauthenticated'
                  ? '登录后查看奖励与核销凭据。'
                  : rewardProgress.state.status === 'error'
                    ? '奖励状态读取失败，请稍后重试。'
                    : '正在读取奖励状态…'}
            </p>
          </div>
        )}
      </CampaignSheet>
    </div>
  )
}
