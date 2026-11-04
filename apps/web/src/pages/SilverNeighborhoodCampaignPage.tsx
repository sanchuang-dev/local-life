import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Check,
  LockKeyhole,
  ChevronRight,
  CircleHelp,
  Copy,
  Info,
  MapPin,
  Medal,
  RefreshCw,
  Share2,
  Sparkles,
  Store,
  Tv2,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import type { PublicActivityDetail } from '@sanchuang-dev/local-life-contracts'
import { CampaignSheet } from '../components/CampaignSheet'
import { ParticipationTeamCard } from '../components/activity/ParticipationTeamCard'
import { RewardProgressCard } from '../components/activity/RewardProgressCard'
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
import { usePublicActivity, type PublicActivityLoadState } from '../hooks/usePublicActivity'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { useRewardProgress } from '../hooks/useRewardProgress'
import { luckyPrizes, luckyGridSlots, type LuckyPrize } from '../mocks/silverLuckyPrizes'

type TaskMode = 'checkin' | 'purchase'
type SheetKind =
  | 'rules'
  | 'share'
  | 'checkin-reward'
  | 'purchase-reward'
  | 'my-rewards'
  | 'lucky-draw'
  | 'grand-prize'
  | 'community-goal'
  | 'merchant'
  | null

type ShareStatus = 'idle' | 'shared' | 'copied' | 'cancelled' | 'error'

const communityRanks = [
  { rank: 1, name: '悦和社区', teams: 52, score: '326人参与' },
  { rank: 2, name: '示例社区', teams: 36, score: '228人参与', current: true },
  { rank: 3, name: '榕树湾社区', teams: 31, score: '196人参与' },
  { rank: 4, name: '文艺社区', teams: 24, score: '158人参与' },
  { rank: 5, name: '滨江社区', teams: 20, score: '132人参与' },
  { rank: 6, name: '新城社区', teams: 18, score: '116人参与' },
  { rank: 7, name: '和平社区', teams: 16, score: '102人参与' },
]

const communityMilestones = [
  { target: 20, reward: '鸡蛋加码礼', prize: luckyPrizes[0] },
  { target: 50, reward: '体验券加码', prize: luckyPrizes[2] },
  { target: 100, reward: '惊喜礼加码', prize: luckyPrizes[4] },
] as const

// The rail has three evenly spaced milestone stops. Progress between stops
// is interpolated from actual completed-team counts, not guessed from a date.
function milestoneRailFill(teams: number): number {
  if (teams <= 20) return 0
  if (teams < 50) return ((teams - 20) / 30) * 50
  return 50 + (Math.min(teams, 100) - 50)
}

const supplies = [
  {
    icon: Store,
    badge: '本地商户',
    title: '老手艺体验券',
    desc: '参考价值 ¥100 · 到店预约体验',
    tone: 'bg-[#fff3e6] text-[#ba7635]',
    sheet: 'merchant' as const,
  },
  {
    icon: Tv2,
    badge: '广电精选',
    title: '智能家居体验礼包',
    desc: '查看现有广电服务与家庭场景展示',
    tone: 'bg-[#e8f6f0] text-[#247963]',
    to: '/gd',
  },
  {
    icon: Sparkles,
    badge: '魔镜体验',
    title: '银发焕新体验',
    desc: '查看现有魔镜终端能力展示',
    tone: 'bg-[#f1edff] text-[#6d57a8]',
    to: '/health/device',
  },
]

function LuckyPrizeImage({ prize, size = 60 }: { prize: LuckyPrize; size?: number }) {
  return (
    <span
      role="img"
      aria-label={prize.name}
      className="block shrink-0 bg-no-repeat"
      style={{
        width: size,
        height: size,
        backgroundImage: 'url("' + import.meta.env.BASE_URL + 'images/silver-draw-prizes.webp")',
        backgroundSize: '600% 100%',
        backgroundPosition: (prize.imageIndex * 20) + '% center',
      }}
    />
  )
}

const taskPrizePreviews = {
  checkin: [
    { name: '鸡蛋1盒', hint: '到场礼', position: '0%' },
    { name: '纸巾1提', hint: '到场礼', position: '50%' },
  ],
  purchase: [
    { name: '100元体验券', hint: '消费达标解锁', position: '100%' },
  ],
} as const

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
            活动发布后，这里会显示真实的活动标题、社区、地点与时间。
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
  const auth = useResidentAuth()
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
  const remainingSeats = team ? Math.max(0, team.seatsTotal - team.seatsFilled) : 0
  // The single share URL used by QR, native share and copy-link. It only exists
  // when the resident is a member of an open team that still has a real invite
  // code; a locked 3/3 team gets no invite entry at all.
  const shareUrl =
    activity &&
    team &&
    selfParticipation &&
    team.status === 'open' &&
    team.seatsFilled < team.seatsTotal &&
    team.inviteCode
      ? buildActivityShareUrl(activity.id, team.inviteCode)
      : null

  const [taskMode, setTaskMode] = useState<TaskMode>('checkin')
  const [activeSheet, setActiveSheet] = useState<SheetKind>(null)
  const [shareStatus, setShareStatus] = useState<ShareStatus>('idle')
  const [drawResult, setDrawResult] = useState<LuckyPrize | null>(null)
  const [drawPhase, setDrawPhase] = useState<'ready' | 'spinning' | 'result'>('ready')
  const [drawStep, setDrawStep] = useState(-1)
  const [showFullRanking, setShowFullRanking] = useState(false)

  // Fixed, inspectable front-end demonstration, not a real prize draw.
  useEffect(() => {
    if (activeSheet !== 'lucky-draw' || drawPhase !== 'spinning') return
    let step = 0
    const timer = window.setInterval(() => {
      step += 1
      setDrawStep(step - 1)
      if (step === 26) {
        window.clearInterval(timer)
        setDrawResult(luckyPrizes[1])
        setDrawPhase('result')
      }
    }, 90)
    return () => window.clearInterval(timer)
  }, [activeSheet, drawPhase])

  const communityCompletedTeams = communityRanks.find((rank) => rank.current)?.teams ?? 0
  const nextMilestone = communityMilestones.find((milestone) => communityCompletedTeams < milestone.target)
  const milestoneFill = milestoneRailFill(communityCompletedTeams)

  const visibleRanks = showFullRanking ? communityRanks : communityRanks.slice(0, 3)
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

  const openLuckyDraw = () => {
    setDrawStep(-1)
    setDrawPhase(drawResult ? 'result' : 'ready')
    setActiveSheet('lucky-draw')
  }

  const startLuckyDraw = () => {
    if (drawResult || drawPhase !== 'ready') return
    setDrawStep(-1)
    setDrawPhase('spinning')
  }

  const closeLuckyDraw = () => {
    setActiveSheet(null)
    if (!drawResult) {
      setDrawPhase('ready')
      setDrawStep(-1)
    }
  }

  return (
    <div className="pb-7">
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
        onShare={openShareSheet}
      />

      <section
        className="mx-4 mt-5 rounded-[18px] border border-dashed border-[#e7c9a3] bg-[#fffaf1] px-3.5 py-3"
        aria-label="演示内容说明"
      >
        <p className="flex items-center gap-1.5 text-[12px] font-bold text-[#8a6132]">
          <Info size={15} className="shrink-0" aria-hidden="true" />
          演示与真实内容说明
        </p>
        <p className="mt-1 text-[11px] leading-[1.7] text-[#8a6132]">
          参与、三人团、邀请、<span className="font-bold">真实签到</span>与
          <span className="font-bold">团队奖励领取/核销凭据</span>
          已接入真实业务，状态来自服务端。以下内容仍为前端演示、不产生真实记录：今日抽奖、活动压轴大奖、社区里程碑与热力榜、消费组队。
        </p>
      </section>

      <section className="mx-4 mt-4" aria-labelledby="team-gifts-heading">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 id="team-gifts-heading" className="text-[16px] font-bold text-[#225c4c]">
            成团好礼
          </h2>
          <span className="text-[11px] text-slate-400">示例奖品 · 非真实库存</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { name: '鸡蛋1盒', hint: '到场礼', position: '0%', tone: 'bg-[#fff8eb]' },
            { name: '纸巾1提', hint: '到场礼', position: '50%', tone: 'bg-[#eff9f6]' },
            { name: '100元体验券', hint: '成团购', position: '100%', tone: 'bg-[#fff3eb]' },
          ].map((prize) => (
            <div
              key={prize.name}
              className={`flex min-w-0 flex-col items-center rounded-[16px] border border-white/75 ${prize.tone} px-1.5 pb-2 pt-1.5 text-center shadow-[0_3px_10px_rgba(27,73,57,0.035)]`}
            >
              <span
                role="img"
                aria-label={prize.name}
                className="block h-14 w-14 shrink-0 bg-no-repeat"
                style={{
                  backgroundImage: `url("${import.meta.env.BASE_URL}images/silver-prize-sprite.png")`,
                  backgroundSize: '300% 100%',
                  backgroundPosition: prize.position + ' center',
                }}
              />
              <span className="mt-0.5 block text-[11px] font-bold leading-[17px] text-slate-800">
                {prize.name}
              </span>
              <span className="mt-0.5 block text-[10px] font-medium leading-[14px] text-[#aa7436]">
                {prize.hint}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-4 mt-5">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-teal-700">TEAM QUEST</p>
            <h2 className="mt-1 text-[19px] font-bold tracking-tight text-slate-900">成团任务</h2>
          </div>
          <span className="text-[12px] text-slate-400">签到为真实数据 · 消费仍为演示</span>
        </div>

        <div className="rounded-[20px] border border-slate-100 bg-white p-3 shadow-sm">
          <div className="grid grid-cols-2 rounded-[14px] bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setTaskMode('checkin')}
              aria-pressed={taskMode === 'checkin'}
              className={`min-h-[44px] rounded-[11px] px-3 text-[13px] font-bold transition ${
                taskMode === 'checkin' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'
              }`}
            >
              签到组队
            </button>
            <button
              type="button"
              onClick={() => setTaskMode('purchase')}
              aria-pressed={taskMode === 'purchase'}
              className={`min-h-[44px] rounded-[11px] px-3 text-[13px] font-bold transition ${
                taskMode === 'purchase' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'
              }`}
            >
              消费组队
            </button>
          </div>

          {taskMode === 'checkin' ? (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[14px] font-bold text-slate-800">三人有效签到</p>
                  <p className="mt-1 text-[12px] leading-5 text-slate-500">
                    签到与奖励资格为真实数据；只有现场核验通过的签到计入进度。
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-[#e8f6f0] px-2.5 py-1 text-[11px] font-bold text-teal-700">
                  真实接入
                </span>
              </div>
              <RewardProgressCard auth={auth} progress={rewardProgress} />
            </div>
          ) : (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[14px] font-bold text-slate-800">三人有效购买 + 团队达标</p>
                  <p className="mt-1 text-[12px] leading-5 text-slate-500">
                    消费模块仍为演示，尚未接入真实订单与金额。
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-[#f1edff] px-2.5 py-1 text-[11px] font-bold text-[#725aa9]">
                  演示玩法
                </span>
              </div>
              <div className="mt-3 rounded-[12px] border border-dashed border-slate-200 bg-slate-50 px-3 py-2.5 text-[12px] leading-5 text-slate-500">
                真实消费进度将在订单接入后显示，当前不虚构人数与金额。
              </div>
              <Link
                to="/community/activity/silver-neighborhood/products"
                className="mt-3 flex min-h-[44px] items-center justify-between rounded-[13px] bg-[#f2f7f4] px-3 text-[13px] font-semibold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                <span className="flex items-center gap-2">
                  <Store size={17} aria-hidden="true" />
                  查看参与活动商品
                </span>
                <ChevronRight size={17} aria-hidden="true" />
              </Link>
            </div>
          )}

          <div className="mt-2 flex items-start justify-center gap-7 py-2" aria-label="团队奖励预览">
            {taskPrizePreviews[taskMode].map((prize) => (
              <button
                key={prize.name}
                type="button"
                onClick={() => openSheet(taskMode === 'checkin' ? 'checkin-reward' : 'purchase-reward')}
                aria-label={`查看${prize.name}奖励说明`}
                className="group flex min-h-[116px] min-w-[92px] flex-col items-center justify-center rounded-xl px-2 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                <span
                  role="img"
                  aria-label={prize.name}
                  className="block h-[76px] w-[76px] bg-no-repeat transition-transform group-hover:scale-105"
                  style={{
                    backgroundImage: `url("${import.meta.env.BASE_URL}images/silver-prize-sprite.png")`,
                    backgroundSize: '300% 100%',
                    backgroundPosition: prize.position + ' center',
                  }}
                />
                <span className="mt-0.5 text-[12px] font-semibold leading-5 text-slate-800">
                  {prize.name}
                </span>
                <span className="text-[11px] leading-4 text-slate-500">{prize.hint}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-4 mt-6 rounded-[22px] bg-gradient-to-b from-[#fffaf0] via-[#fffdf5] to-[#f4faf5] px-3.5 pb-3.5 pt-4" aria-labelledby="community-goal-heading">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-[0.14em] text-orange-600">COMMUNITY GOAL</p>
            <h2 id="community-goal-heading" className="mt-1 text-[18px] font-bold text-slate-900">社区一起解锁更多礼</h2>
          </div>
          <img
            src={import.meta.env.BASE_URL + 'images/community-goal-deco.webp'}
            alt=""
            aria-hidden="true"
            width={64}
            height={64}
            loading="lazy"
            decoding="async"
            className="-mr-1.5 -mt-2 h-16 w-16 shrink-0 object-contain"
          />
        </div>
        <p className="mt-2 text-[12px] leading-5 text-slate-500">
          每团仍是 3 人；全社区累计成功团数，共同解锁里程碑奖励。
        </p>

        <div className="mt-4" aria-label="社区里程碑活动轴">
          <div className="grid grid-cols-3 text-center">
            {communityMilestones.map(({ target }) => {
              const unlocked = communityCompletedTeams >= target
              const active = nextMilestone?.target === target
              return (
                <span
                  key={target}
                  className={'mx-auto rounded-full px-2 py-1 text-[12px] font-bold leading-4 ' +
                    (unlocked ? 'bg-[#e4f5df] text-[#197753]' : active ? 'bg-[#fff0d8] text-[#dc6631]' : 'bg-[#eef1f2] text-slate-500')}
                >
                  {target}团
                </span>
              )
            })}
          </div>

          <div className="relative mt-1.5 h-9">
            <div className="absolute left-[16.6667%] right-[16.6667%] top-[14px] h-[7px] rounded-full bg-[#e1e5e4]" />
            <div className="absolute left-[16.6667%] top-[14px] h-[7px] rounded-full bg-gradient-to-r from-[#a7d97c] to-[#f7a95d] transition-[width] duration-300"
              style={{ width: (milestoneFill * 2 / 3) + '%' }}
            />
            <div className="relative z-[1] grid grid-cols-3">
              {communityMilestones.map(({ target }) => {
                const unlocked = communityCompletedTeams >= target
                const active = nextMilestone?.target === target
                return (
                  <span key={target} className="flex h-9 items-center justify-center" aria-label={target + '团' + (unlocked ? '已解锁' : active ? '下一目标' : '待解锁')}>
                    <span className={'flex h-[29px] w-[29px] items-center justify-center rounded-full border-[3px] border-white shadow-sm ' +
                      (unlocked ? 'bg-[#12966f] text-white' : active ? 'bg-[#f57137] text-white' : 'bg-[#e4e9e9] text-slate-500')}>
                      {unlocked ? <Check size={17} strokeWidth={3} aria-hidden="true" /> :
                        active ? <span className="h-2.5 w-2.5 rounded-full bg-white" /> :
                          <LockKeyhole size={15} aria-hidden="true" />}
                    </span>
                  </span>
                )
              })}
            </div>
          </div>

          <div className="mt-1 grid grid-cols-3 gap-1 text-center">
            {communityMilestones.map(({ target, reward, prize }) => {
              const unlocked = communityCompletedTeams >= target
              const active = nextMilestone?.target === target
              return (
                <div key={target} className="flex min-w-0 flex-col items-center">
                  <LuckyPrizeImage prize={prize} size={70} />
                  <p className="mt-0.5 text-[12px] font-bold leading-[18px] text-slate-800">{reward}</p>
                  <p className={'mt-0.5 text-[11px] font-semibold leading-4 ' +
                    (unlocked ? 'text-teal-700' : active ? 'text-orange-600' : 'text-slate-400')}>
                    {unlocked ? '已解锁' : active ? '冲刺中' : '待解锁'}
                  </p>
                </div>
              )
            })}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-[#eadfc9]/60 pt-3">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-slate-600">
              已成团 <strong className="text-[17px] font-bold tabular-nums text-[#e65f35]">{communityCompletedTeams}</strong> 团
            </p>
            <p className="text-[11px] text-slate-500">
              {nextMilestone ? <>距离 {nextMilestone.target} 团还差 <strong className="font-bold text-orange-600">{nextMilestone.target - communityCompletedTeams}</strong> 团</> : '全部里程碑已解锁'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => openSheet('community-goal')}
            className="flex min-h-[44px] shrink-0 items-center gap-0.5 rounded-full px-1 text-[12px] font-semibold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            奖励规则 <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="mx-4 mt-6" aria-labelledby="lucky-heading">
        <div className="mb-2 flex min-h-[44px] items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-teal-700">DAILY LUCK</p>
            <h2 id="lucky-heading" className="mt-1 text-[19px] font-bold text-slate-900">今日抽奖</h2>
          </div>
          <button
            type="button"
            onClick={() => openSheet('my-rewards')}
            className="min-h-[44px] rounded-full bg-[#e8f6f0] px-3 text-[12px] font-bold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            我的奖励
          </button>
        </div>
        <p className="mb-3 text-[12px] leading-5 text-slate-500">
          每日一次演示机会，看看今天有什么惊喜
        </p>
        <div className="grid grid-cols-3 gap-x-2 gap-y-3" aria-label="今日奖品六宫格">
          {luckyPrizes.map((prize) => (
            <div key={prize.id} className="flex min-w-0 flex-col items-center text-center">
              <span className="flex h-[80px] w-full max-w-[106px] items-center justify-center rounded-[14px] bg-[#fff5e7]/85">
                <LuckyPrizeImage prize={prize} size={68} />
              </span>
              <span className="mt-1 text-[11px] font-semibold leading-4 text-[#455a51]">{prize.name}</span>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={openLuckyDraw}
          className="mt-4 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-full bg-[#ff763e] px-3 text-[14px] font-bold text-white shadow-[0_3px_8px_rgba(253,117,62,0.15)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
        >
          <Sparkles size={17} aria-hidden="true" />
          {drawResult ? '查看今日抽奖结果' : '试试今日手气'}
        </button>
        <p className="mt-2 text-center text-[11px] leading-4 text-slate-400">
          奖品与抽取均为前端演示，不代表真实发放
        </p>
      </section>

      <section className="mx-4 mt-6">
        <div className="mb-3 flex min-h-[44px] items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-teal-700">COMMUNITY RANK</p>
            <h2 className="mt-1 text-[19px] font-bold text-slate-900">社区热力榜</h2>
          </div>
          <button
            type="button"
            onClick={() => setShowFullRanking((value) => !value)}
            className="min-h-[44px] rounded-full px-3 text-[12px] font-semibold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            aria-expanded={showFullRanking}
          >
            {showFullRanking ? '收起' : '查看全部'}
          </button>
        </div>

        <div className="overflow-hidden rounded-[20px] border border-slate-100 bg-white shadow-sm">
          {visibleRanks.map((item) => (
            <div
              key={item.name}
              className={`flex items-center gap-3 border-b border-slate-100 px-4 py-3.5 last:border-b-0 ${
                item.current ? 'bg-[#f2faf6]' : ''
              }`}
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${
                  item.rank === 1
                    ? 'bg-[#fff1c9] text-[#9b6714]'
                    : item.rank === 2
                      ? 'bg-[#edf1f3] text-slate-600'
                      : item.rank === 3
                        ? 'bg-[#f7e8de] text-[#966044]'
                        : 'bg-slate-100 text-slate-500'
                }`}
              >
                {item.rank}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[14px] font-bold text-slate-800">{item.name}</p>
                  {item.current ? (
                    <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[11px] font-bold text-teal-700">
                      我们社区
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[12px] text-slate-400">{item.score}</p>
              </div>
              <div className="text-right">
                <p className="text-[15px] font-bold text-teal-700">{item.teams}</p>
                <p className="text-[11px] text-slate-400">有效团</p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[12px] leading-5 text-slate-400">
          当前榜单按“有效成团数”展示示例数据；正式活动需在规则发布时冻结统计口径。
        </p>
      </section>

      <section className="mx-4 mt-7" aria-labelledby="grand-prize-heading">
        <div className="flex items-end justify-between gap-2">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-[#ab7b30]">FINAL PRIZE</p>
            <h2 id="grand-prize-heading" className="mt-1 text-[19px] font-bold text-slate-900">
              活动压轴大奖
            </h2>
          </div>
          <p className="pb-0.5 text-[11px] font-semibold text-[#9d7849]">示例：10月31日 20:00 截止</p>
        </div>

        <div className="relative mt-2 overflow-hidden rounded-[18px] bg-gradient-to-b from-[#fff8e9] via-[#fffbf5] to-transparent pt-1">
          <div className="relative mx-auto h-[224px] max-w-[312px]">
            <img
              src={import.meta.env.BASE_URL + 'images/silver-grand-screen.webp'}
              alt="大奖示例：金色奖杯旁的家庭智能屏，配有彩带与礼盒"
              className="absolute bottom-0 left-1/2 h-[224px] w-[250px] -translate-x-1/2 object-contain"
              loading="eager"
            />
            <img
              src={import.meta.env.BASE_URL + 'images/silver-grand-top20.webp'}
              alt="社区榜前20名享有大奖抽取资格"
              className="absolute right-1 top-0 h-[78px] w-[78px] object-contain"
              loading="eager"
            />
          </div>
          <p className="mt-0.5 text-center text-[15px] font-bold text-[#264d40]">
            广电智能硬件 · 魔镜体验设备
          </p>
          <p className="mt-1 text-center text-[11px] leading-5 text-slate-500">
            奖品仅作活动示例，实际型号与数量待确定
          </p>
        </div>

        <p className="mt-1 text-center text-[13px] font-semibold leading-6 text-[#315f4d]">
          社区榜前 20 名，获得一次大奖抽取资格
        </p>
        <p className="text-center text-[12px] leading-5 text-slate-500">
          获得资格不等于直接中奖
        </p>
        <button
          type="button"
          onClick={() => openSheet('grand-prize')}
          className="mx-auto mt-2 flex min-h-[44px] items-center justify-center gap-1.5 px-4 text-[13px] font-semibold text-[#8d681f] focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          查看大奖规则
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </section>

      <section className="mx-4 mt-6">
        <div className="mb-3">
          <p className="text-[11px] font-bold tracking-[0.16em] text-teal-700">LOCAL BENEFITS</p>
          <h2 className="mt-1 text-[19px] font-bold text-slate-900">活动里还能逛什么</h2>
          <p className="mt-1 text-[12px] leading-5 text-slate-500">
            本地商户、广电商品和魔镜都可以成为活动供给，但不要求在本页完成线上支付。
          </p>
        </div>

        <div className="grid gap-3">
          {supplies.map(({ icon: Icon, badge, title, desc, tone, to, sheet }) => {
            const content = (
              <>
                <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-[15px] ${tone}`}>
                  <Icon size={23} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-[11px] font-bold text-teal-700">{badge}</span>
                  <span className="mt-0.5 block text-[14px] font-bold text-slate-800">{title}</span>
                  <span className="mt-1 block text-[12px] leading-5 text-slate-500">{desc}</span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-slate-300" aria-hidden="true" />
              </>
            )

            const className =
              'flex min-h-[82px] w-full items-center gap-3 rounded-[18px] border border-slate-100 bg-white p-3.5 text-left shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600'

            return to ? (
              <Link key={title} to={to} state={{ from: activityPath }} className={className}>
                {content}
              </Link>
            ) : (
              <button
                key={title}
                type="button"
                onClick={() => openSheet(sheet ?? 'merchant')}
                className={className}
              >
                {content}
              </button>
            )
          })}
        </div>
      </section>

      <section className="mx-4 mt-6 rounded-[18px] border border-dashed border-teal-300/70 bg-[#eef7f2] p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 size={19} className="mt-0.5 shrink-0 text-teal-700" aria-hidden="true" />
          <div>
            <p className="text-[13px] font-bold text-slate-700">活动信息与参与状态来自真实服务，其余玩法仍是交互演示</p>
            <p className="mt-1 text-[12px] leading-[1.7] text-slate-500">
              标题、社区、地点、时间、活动规则与你的参与/三人团状态读取自真实服务；登录、确认参与与邀请分享会调用真实 API。
              签到、消费、抽奖、排行榜、大奖与社区统计仍为样例，不会写入签到、订单、库存或兑奖记录。
            </p>
          </div>
        </div>
      </section>

      <div className="mx-4 mt-4 flex items-center justify-center gap-2 text-[11px] text-slate-400">
        <Medal size={14} aria-hidden="true" />
        三人成团 · 天天有奖 · 社区争榜 · 活动冲大奖
      </div>

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
              以上为活动发布时固化的公开规则快照
              {activity.publishedAt
                ? `，发布时间 ${formatShanghaiDateTime(activity.publishedAt)}（北京时间）`
                : ''}
              。参与、三人团与邀请记录来自真实服务；抽奖、榜单与大奖玩法仍为演示，未接入真实业务。
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
                  转发给好友
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
                二维码、转发与复制使用同一条链接；截图保存暂未开放。
              </p>
              <div className="text-center text-[12px] font-medium" aria-live="polite">
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
                二维码、转发与复制使用同一条链接，包含真实活动与邀请参数；浏览不会自动加入，需登录后确认参与。
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
        title={rewardReady?.reward?.reward?.prizeName ?? '团队生活礼'}
        eyebrow="签到任务 · 真实奖励"
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
                    ? '登录后查看真实进度'
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
          以上奖品、窗口与进度均来自服务端冻结的奖励规则；凭据码仅在领取时显示一次，核销后不可重复使用。
        </p>
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'purchase-reward'}
        title="团队惊喜权益"
        eyebrow="消费任务 · 演示"
        onClose={() => setActiveSheet(null)}
      >
        <div className="rounded-[16px] bg-[#faf8ff] p-4">
          <p className="text-[15px] font-bold text-slate-800">当前示例条件</p>
          <p className="mt-1">
            三位团员分别有有效购买记录，团队净实付累计达到 ¥300 后，解锁一份参考价值约 ¥100 的团队权益。
          </p>
        </div>
        <dl className="mt-3 divide-y divide-slate-100 rounded-[16px] border border-slate-100 bg-white px-4">
          <div className="flex justify-between gap-4 py-3">
            <dt>成员完成</dt>
            <dd className="text-right font-semibold text-slate-800">消费数据未接入</dd>
          </div>
          <div className="flex justify-between gap-4 py-3">
            <dt>金额进度</dt>
            <dd className="text-right font-semibold text-slate-800">消费数据未接入</dd>
          </div>
          <div className="flex justify-between gap-4 py-3">
            <dt>奖励形式</dt>
            <dd className="text-right font-semibold text-slate-800">实物 / 本地体验权益</dd>
          </div>
        </dl>
        <p className="mt-3 text-[12px] leading-5 text-slate-400">
          团队奖励归属与团内抽取方式仍属于活动规则配置项；本原型不把它写死为真实业务。
        </p>
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'lucky-draw'}
        title={drawPhase === 'result' && drawResult ? '恭喜你！' : '今日抽奖'}
        eyebrow="DAILY LUCK · 演示抽奖"
        variant="poster"
        onClose={closeLuckyDraw}
      >
        {drawPhase === 'result' && drawResult ? (
          <div className="py-2 text-center" aria-live="polite">
            <p className="text-[14px] font-bold text-[#225b44]">
              获得 {drawResult.name}
            </p>
            <div className="mx-auto mt-3 flex h-[168px] w-[168px] items-center justify-center rounded-full bg-[radial-gradient(circle,#fff0b9_0%,#fff9ed_65%,transparent_72%)]">
              <LuckyPrizeImage prize={drawResult} size={132} />
            </div>
            <p className="mt-2 text-[16px] font-bold text-slate-900">{drawResult.name}</p>
            <p className="mt-1 text-[12px] leading-5 text-slate-500">
              {drawResult.level} · 前端演示结果，不生成真实领奖凭证
            </p>
            <button
              type="button"
              onClick={() => openSheet('my-rewards')}
              className="mt-5 flex min-h-[48px] w-full items-center justify-center rounded-full bg-[#ff763e] text-[14px] font-bold text-white"
            >
              查看我的奖励
            </button>
            <button
              type="button"
              onClick={closeLuckyDraw}
              className="mt-2 flex min-h-[44px] w-full items-center justify-center rounded-full bg-[#e9f6ed] text-[13px] font-semibold text-[#226b52]"
            >
              继续逛逛
            </button>
          </div>
        ) : (
          <div className="py-1">
            <p className="mb-3 text-center text-[12px] text-slate-500">
              {drawPhase === 'spinning' ? '好运正在靠近你…' : '今日剩余 1 次演示机会'}
            </p>
            <div className="grid grid-cols-3 gap-2 rounded-[17px] bg-gradient-to-b from-[#fff0c5] to-[#fff7e8] p-2" aria-label="九宫格抽奖盘">
              {luckyGridSlots.map((prizeIndex, cellIndex) => {
                if (prizeIndex === null) {
                  return (
                    <button
                      key="start"
                      type="button"
                      onClick={startLuckyDraw}
                      disabled={drawPhase === 'spinning'}
                      aria-label="开始抽奖"
                      className="flex min-h-[87px] flex-col items-center justify-center rounded-[13px] bg-[#ff753e] text-[17px] font-bold leading-6 text-white shadow-[0_3px_10px_rgba(255,117,62,0.2)] disabled:cursor-wait disabled:opacity-90"
                    >
                      {drawPhase === 'spinning' ? '抽奖中…' : <>开始<br />抽奖</>}
                    </button>
                  )
                }
                const prize = luckyPrizes[prizeIndex]
                const ringOrder = [0, 1, 2, 5, 8, 7, 6, 3]
                const selected = drawPhase === 'spinning' && ringOrder[drawStep % 8] === cellIndex
                return (
                  <div
                    key={prize.id + '-' + cellIndex}
                    className={'flex min-h-[87px] min-w-0 flex-col items-center justify-center rounded-[13px] border px-0.5 py-1 text-center transition-colors ' +
                      (selected ? 'border-[#ff904e] bg-[#ffe0a4] shadow-[0_0_0_2px_#ffb65a]' : 'border-white/75 bg-white/80')}
                  >
                    <LuckyPrizeImage prize={prize} size={57} />
                    <span className="mt-0.5 text-[10px] font-semibold leading-[14px] text-[#5a594b]">{prize.name}</span>
                  </div>
                )
              })}
            </div>
            <p className="mt-3 text-center text-[11px] leading-4 text-slate-400">
              前端演示 · 不代表真实中奖概率或奖品发放
            </p>
          </div>
        )}
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
            <p className="font-bold text-slate-800">本活动暂无真实奖励记录</p>
            <p className="mt-1 text-[12px] leading-5 text-slate-500">
              {rewardProgress.state.status === 'ready'
                ? rewardProgress.state.data.gate?.kind === 'no_team'
                  ? '你还没有加入三人团，暂不满足奖励条件。'
                  : '本活动尚未配置正式奖励计划，未生成任何奖励或凭据。'
                : rewardProgress.state.status === 'unauthenticated'
                  ? '登录后可查看本活动的真实奖励与核销凭据。'
                  : rewardProgress.state.status === 'error'
                    ? '奖励状态读取失败，请稍后重试。'
                    : '正在读取奖励状态…'}
            </p>
          </div>
        )}
        <div className="mt-3 rounded-[16px] border border-dashed border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="font-bold text-slate-700">今日抽奖</p>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
              drawResult ? 'bg-[#fff3e6] text-orange-700' : 'bg-slate-100 text-slate-500'
            }`}>
              {drawResult ? '演示中奖' : '演示玩法'}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-slate-500">
            {drawResult
              ? `本次演示中奖：${drawResult.level} · ${drawResult.name}。`
              : '抽奖为前端演示，不生成真实券码或兑奖凭证。'}
          </p>
        </div>
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'community-goal'}
        title="社区里程碑奖励"
        eyebrow="COMMUNITY GOAL"
        onClose={() => setActiveSheet(null)}
      >
        <p className="mb-3 text-[13px] leading-6 text-slate-600">
          每个小团仍为 3 人，里程碑按照整个演示社区的成功成团数累计计算，不是把不同团队合并为大团。
        </p>
        <div className="space-y-3">
          {communityMilestones.map(({ target, reward, prize }) => (
            <div key={target} className="flex items-center gap-3 border-b border-slate-100 pb-3 last:border-0">
              <LuckyPrizeImage prize={prize} size={62} />
              <div>
                <p className="text-[14px] font-bold text-slate-800">{target} 团 · {reward}</p>
                <p className="mt-1 text-[12px] leading-5 text-slate-500">
                  社区累计成功 {target} 团后解锁这一奖励档位，正式领取与分配方式待活动规则确认。
                </p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[12px] leading-5 text-slate-400">
          当前成团数、奖品及进度为演示数据，不产生真实奖励领取资格。
        </p>
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'grand-prize'}
        title="活动压轴大奖"
        eyebrow="FINAL PRIZE"
        onClose={() => setActiveSheet(null)}
      >
        <div className="rounded-[16px] bg-[#fff8e8] p-4">
          <p className="text-[15px] font-bold text-slate-800">当前设计口径</p>
          <p className="mt-1">
            活动结束时，社区榜前 20 名参与者获得一次大奖抽取资格；前 20 名不是直接获得大奖。
          </p>
        </div>
        <dl className="mt-3 divide-y divide-slate-100 rounded-[16px] border border-slate-100 bg-white px-4">
          <div className="flex justify-between gap-4 py-3">
            <dt>示例结束时间</dt>
            <dd className="text-right font-semibold text-slate-800">10月31日 20:00（演示）</dd>
          </div>
          <div className="flex justify-between gap-4 py-3">
            <dt>资格名额</dt>
            <dd className="font-semibold text-slate-800">前 20 名</dd>
          </div>
          <div className="flex justify-between gap-4 py-3">
            <dt>大奖示例</dt>
            <dd className="text-right font-semibold text-slate-800">广电硬件 / 魔镜设备</dd>
          </div>
        </dl>
        <p className="mt-3 text-[12px] leading-5 text-slate-400">
          正式活动需要在开始前公布奖品数量、抽取方式、结果公示与复核规则。
        </p>
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'merchant'}
        title="老手艺体验券"
        eyebrow="LOCAL MERCHANT"
        onClose={() => setActiveSheet(null)}
        footer={
          <Link
            to="/life"
            state={{ from: activityPath }}
            className="flex min-h-[48px] w-full items-center justify-center rounded-[14px] bg-teal-700 px-4 text-[14px] font-bold text-white"
          >
            去惠生活看看
          </Link>
        }
      >
        <div className="rounded-[16px] bg-[#fff7ec] p-4">
          <p className="text-[16px] font-bold text-slate-800">参考价值 ¥100 · 示例权益</p>
          <p className="mt-1 text-[13px] leading-6 text-slate-500">
            用一张可核销的本地体验券替代部分实物奖励，让活动把用户真正带到社区周边商户。
          </p>
        </div>
        <dl className="mt-3 divide-y divide-slate-100 rounded-[16px] border border-slate-100 bg-white px-4">
          <div className="flex justify-between gap-4 py-3">
            <dt>内容示例</dt>
            <dd className="text-right font-semibold text-slate-800">手作 / 老手艺体验一次</dd>
          </div>
          <div className="flex justify-between gap-4 py-3">
            <dt>使用方式</dt>
            <dd className="text-right font-semibold text-slate-800">到店预约后核销</dd>
          </div>
          <div className="flex justify-between gap-4 py-3">
            <dt>有效期</dt>
            <dd className="font-semibold text-slate-800">活动结束后 30 天</dd>
          </div>
        </dl>
        <p className="mt-3 text-[12px] leading-5 text-slate-400">
          商户名称、实际售价、采购价和可核销内容必须由真实合作确认后替换；此处只验证权益详情交互结构。
        </p>
      </CampaignSheet>
    </div>
  )
}
