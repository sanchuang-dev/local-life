import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  Check,
  LockKeyhole,
  ChevronRight,
  CircleHelp,
  ImageDown,
  Gift,
  MapPin,
  Medal,
  Share2,
  Sparkles,
  Store,
  Tv2,
} from 'lucide-react'
import { Link } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import { CampaignSheet } from '../components/CampaignSheet'
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
  { rank: 2, name: '幸福里社区', teams: 36, score: '228人参与', current: true },
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

// The campaign's existing sample schedule is 10/26–10/31, with awards ending
// at 20:00 China Standard Time on 10/31 (see the rules on this page).
const activityStartsAt = Date.parse('2026-10-26T00:00:00+08:00')
const activityEndsAt = Date.parse('2026-10-31T20:00:00+08:00')

function ActivityCountdown() {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const beforeStart = now < activityStartsAt
  const finished = now >= activityEndsAt
  const remainder = Math.max(0, (beforeStart ? activityStartsAt : activityEndsAt) - now)
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
    <div className="relative z-[1] mx-3 -mt-2">
      <div
        className="relative rounded-t-[12px] bg-gradient-to-b from-[#d8f0cc] via-[#e1f3d8]/85 to-transparent px-2.5 pb-5 pt-2.5 text-[#275942]"
        role="timer"
        aria-label={finished ? '本期活动已结束' : '活动倒计时'}
      >
      <div className="flex items-center justify-center gap-2 text-[11px] leading-4">
        <span className={finished ? 'font-semibold text-[#687c6c]' : 'font-bold text-[#126c38]'}>
          {finished ? '活动已结束' : beforeStart ? '活动即将开始' : '活动进行中'}
        </span>
        <span className="font-medium text-[#375e40]">2026.10.26 - 10.31</span>
      </div>
      {finished ? (
        <p className="mt-2 text-center text-[13px] font-semibold leading-6">本期活动已结束</p>
      ) : (
        <div className="mt-1.5 flex items-center justify-center gap-1 text-[12px] font-semibold text-[#285039]">
          <span className="mr-0.5">还剩</span>
          {numberBlock(days, '天数')}
          <span className="mx-0.5">天</span>
          {numberBlock(hours, '小时')}
          <span>:</span>
          {numberBlock(minutes, '分钟')}
          <span>:</span>
          {numberBlock(seconds, '秒')}
        </div>
      )}
      </div>
    </div>
  )
}

const activityPath = '/community/activity/silver-neighborhood'

const publicActivityUrl = 'https://sanchuang-dev.github.io/local-life/#' + activityPath

const getActivityUrl = () => {
  // A QR code shown on localhost must not direct other phones to a loopback address.
  if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    return publicActivityUrl
  }
  return window.location.origin + window.location.pathname + '#' + activityPath
}

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

  const handleCopyLink = async () => {
    const value = getActivityUrl()

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else if (!fallbackCopy(value)) {
        throw new Error('copy failed')
      }
      setShareStatus('copied')
    } catch {
      setShareStatus('error')
    }
  }

  const handleSystemShare = async () => {
    if (!canNativeShare) {
      await handleCopyLink()
      return
    }

    try {
      await navigator.share({
        title: '银发社区欢乐季',
        text: '还差 1 位街坊，来一起组成三人团。',
        url: getActivityUrl(),
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
      <section className="relative overflow-hidden bg-[#eaf5e9]">
        <div className="relative">
          <img
            src={import.meta.env.BASE_URL + 'images/silver-neighborhood-hero.webp'}
            alt="银发社区欢乐季，三人成团·天天有礼。三位长者在欢乐的社区活动中相聚。"
            className="block aspect-[4/3] w-full object-cover"
            fetchPriority="high"
          />
        </div>
        <ActivityCountdown />
        <div className="relative -mt-px bg-gradient-to-b from-[#edf8e9] via-[#e8f5ec] to-[#d8eee5] px-4 pb-16 pt-0">
          <div className="flex min-h-[48px] items-center gap-2">
            <p
              className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-medium text-[#386857]"
              title="幸福里社区活动广场 · 示例场地"
            >
              <MapPin size={16} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">幸福里社区活动广场 · 示例场地</span>
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
        </div>
      </section>

      <section
        id="my-team"
        className="relative z-[2] mx-4 -mt-14 scroll-mt-4 rounded-[22px] border border-slate-100 bg-white p-4 shadow-[0_16px_40px_rgba(15,52,44,0.12)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-[#e8f6f0] px-2.5 py-1 text-[12px] font-bold text-teal-700">
                我的三人团
              </span>
              <span className="text-[12px] font-semibold text-orange-600">2 / 3</span>
            </div>
            <h2 className="mt-2 text-[20px] font-bold tracking-tight text-slate-900">还差 1 位街坊</h2>
            <p className="mt-1 text-[13px] leading-5 text-slate-500">
              三人完成签到后，解锁一份团队生活礼。
            </p>
          </div>
          <div className="rounded-[16px] bg-[#fff3e6] p-2.5 text-[#b97836]" aria-hidden="true">
            <Gift size={24} />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2.5">
          <div className="rounded-[16px] border border-teal-100 bg-[#f4fbf8] p-3 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-teal-700 text-[14px] font-bold text-white">
              我
            </div>
            <p className="mt-2 text-[12px] font-semibold text-slate-700">团长</p>
            <p className="mt-0.5 text-[11px] text-teal-700">已加入</p>
          </div>
          <div className="rounded-[16px] border border-teal-100 bg-[#f4fbf8] p-3 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-[#d8efe7] text-[14px] font-bold text-teal-800">
              王
            </div>
            <p className="mt-2 text-[12px] font-semibold text-slate-700">王阿姨</p>
            <p className="mt-0.5 text-[11px] text-teal-700">已加入</p>
          </div>
          <button
            type="button"
            onClick={() => openSheet('share')}
            className="min-h-[96px] rounded-[16px] border border-dashed border-orange-200 bg-[#fffaf3] p-3 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-[#fff0d7] text-[22px] font-light text-orange-600">
              +
            </div>
            <p className="mt-2 text-[12px] font-semibold text-slate-700">邀请街坊</p>
            <p className="mt-0.5 text-[11px] text-orange-600">还差 1 人</p>
          </button>
        </div>

        <button
          type="button"
          onClick={() => openSheet('share')}
          className="mt-3 flex min-h-[46px] w-full items-center justify-center gap-2 rounded-[14px] bg-teal-700 px-4 text-[14px] font-bold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <Share2 size={17} aria-hidden="true" />
          邀请 1 位街坊来成团
        </button>
      </section>

      <section className="mx-4 mt-4" aria-labelledby="team-gifts-heading">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 id="team-gifts-heading" className="text-[16px] font-bold text-[#225c4c]">
            成团好礼
          </h2>
          <span className="text-[11px] text-slate-400">示例奖品</span>
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
          <span className="text-[12px] text-slate-400">两条任务独立计算</span>
        </div>

        <div className="rounded-[20px] border border-slate-100 bg-white p-3 shadow-sm">
          <div className="grid grid-cols-2 rounded-[14px] bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setTaskMode('checkin')}
              aria-pressed={taskMode === 'checkin'}
              className={`min-h-[42px] rounded-[11px] px-3 text-[13px] font-bold transition ${
                taskMode === 'checkin' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'
              }`}
            >
              签到组队
            </button>
            <button
              type="button"
              onClick={() => setTaskMode('purchase')}
              aria-pressed={taskMode === 'purchase'}
              className={`min-h-[42px] rounded-[11px] px-3 text-[13px] font-bold transition ${
                taskMode === 'purchase' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'
              }`}
            >
              消费组队
            </button>
          </div>

          {taskMode === 'checkin' ? (
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[14px] font-bold text-slate-800">三人有效签到</p>
                  <p className="mt-1 text-[12px] text-slate-500">当前 2 / 3 人 · 还差 1 人完成签到</p>
                </div>
                <span className="rounded-full bg-[#fff3e6] px-2.5 py-1 text-[11px] font-bold text-orange-600">
                  小礼必得
                </span>
              </div>
              <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-teal-600 to-[#55b99b]" />
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[14px] font-bold text-slate-800">三人有效购买 + 团队达标</p>
                  <p className="mt-1 text-[12px] text-slate-500">2 / 3 人已购 · ¥228 / ¥300（示例）</p>
                </div>
                <span className="shrink-0 rounded-full bg-[#f1edff] px-2.5 py-1 text-[11px] font-bold text-[#725aa9]">
                  高价值礼
                </span>
              </div>
              <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full w-[76%] rounded-full bg-gradient-to-r from-[#6e5ab0] to-[#a68bd5]" />
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
          <p className="pb-0.5 text-[11px] font-semibold text-[#9d7849]">10月31日 20:00 截止</p>
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
            <p className="text-[13px] font-bold text-slate-700">当前是可交互原型，不是真实活动</p>
            <p className="mt-1 text-[12px] leading-[1.7] text-slate-500">
              人数、金额、社区、奖品和抽奖结果均为样例；分享和复制是真实浏览器操作，但不会写入邀请关系、
              签到、订单、库存或兑奖记录。
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
        eyebrow="SILVER NEIGHBORHOOD"
        onClose={() => setActiveSheet(null)}
      >
        <ol className="grid gap-3">
          {[
            '本原型按“团长占一席，再邀请两位街坊”展示三人团。',
            '签到任务与消费任务独立计算；同一成员的两个行为分别计入对应进度。',
            '社区榜当前按有效成团数展示；正式活动上线前需冻结统计与并列规则。',
            '活动大奖采用“前 20 名取得抽奖资格”的单一演示口径，并非前 20 名直接获得大奖。',
          ].map((rule, index) => (
            <li key={rule} className="flex gap-3 rounded-[14px] bg-slate-50 p-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-700 text-[12px] font-bold text-white">
                {index + 1}
              </span>
              <span>{rule}</span>
            </li>
          ))}
        </ol>
        <p className="mt-4 rounded-[14px] bg-[#fff7ec] p-3 text-[12px] leading-5 text-[#8a6132]">
          当前页面用于确认玩法和交互。真实活动的身份去重、签到核验、支付/成交、库存、中奖概率与兑奖规则仍需由正式业务系统承载。
        </p>
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'share'}
        title="邀请最后 1 位街坊"
        eyebrow="TEAM 2 / 3"
        variant="poster"
        onClose={() => setActiveSheet(null)}
        footer={
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
                disabled
                aria-describedby="screenshot-unavailable"
                className="flex min-h-[48px] cursor-not-allowed items-center justify-center gap-1.5 rounded-[13px] border border-slate-200 bg-slate-50 px-2 text-[13px] font-semibold text-slate-400"
              >
                <ImageDown size={17} aria-hidden="true" />
                截图保存
              </button>
            </div>
            <p id="screenshot-unavailable" className="mt-2 text-center text-[11px] leading-4 text-slate-400">
              截图保存暂未开放
            </p>
            <div className="text-center text-[12px] font-medium" aria-live="polite">
              {shareStatus === 'shared' ? <p className="mt-1 text-teal-700">已调起系统分享，是否加入还需好友确认。</p> : null}
              {shareStatus === 'copied' ? <p className="mt-1 text-teal-700">活动链接已复制，可粘贴发送给好友。</p> : null}
              {shareStatus === 'cancelled' ? <p className="mt-1 text-slate-500">已取消分享，可再次点击转发。</p> : null}
              {shareStatus === 'error' ? <p className="mt-1 text-orange-700">分享或复制未成功，请稍后重试。</p> : null}
            </div>
          </>
        }
      >
        <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-[20px] border border-[#deebdf] bg-[#f4faf3] shadow-[0_9px_25px_rgba(26,88,62,0.08)]">
          <img
            src={import.meta.env.BASE_URL + 'images/silver-neighborhood-hero.webp'}
            alt="银发社区欢乐季活动海报"
            className="block aspect-[4/3] w-full object-cover"
          />
          <div className="px-3 pb-3 pt-3">
            <div className="text-center">
              <p className="text-[17px] font-bold leading-6 text-[#176149]">还差你，三人成团领好礼</p>
              <p className="mt-1 text-[12px] text-[#547c6c]">幸福里社区 · 已有 2 / 3 位街坊</p>
            </div>
            <div className="mt-3 rounded-[14px] border border-[#deece1] bg-white px-3 py-3 text-center">
              <div className="relative mx-auto w-fit rounded-lg bg-white">
                <QRCodeSVG
                  value={getActivityUrl()}
                  size={148}
                  level="H"
                  marginSize={3}
                  fgColor="#195B4C"
                  bgColor="#FFFFFF"
                  title="银发社区欢乐季活动直达二维码"
                />
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span
                    aria-label="演示团长头像"
                    className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-[#247D67] text-[13px] font-bold text-white shadow-sm"
                  >
                    我
                  </span>
                </div>
              </div>
              <p className="mt-2 text-[12px] font-semibold text-[#2f765f]">
                扫码查看活动 · 邻里一起领好礼
              </p>
            </div>
            <p className="mt-2 text-center text-[11px] leading-4 text-slate-500">
              演示海报 · 扫码仅打开活动页，不自动加入队伍
            </p>
          </div>
        </div>
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'checkin-reward'}
        title="团队生活礼"
        eyebrow="签到任务 · 2 / 3"
        onClose={() => setActiveSheet(null)}
      >
        <div className="rounded-[16px] bg-[#f2faf6] p-4">
          <p className="text-[15px] font-bold text-slate-800">解锁条件</p>
          <p className="mt-1">三位团员都完成一次有效到场签到后，团队解锁一份生活礼。</p>
        </div>
        <dl className="mt-3 divide-y divide-slate-100 rounded-[16px] border border-slate-100 bg-white px-4">
          <div className="flex justify-between gap-4 py-3">
            <dt>当前进度</dt>
            <dd className="font-semibold text-slate-800">2 / 3 人</dd>
          </div>
          <div className="flex justify-between gap-4 py-3">
            <dt>奖励示例</dt>
            <dd className="text-right font-semibold text-slate-800">鸡蛋 / 纸巾</dd>
          </div>
          <div className="flex justify-between gap-4 py-3">
            <dt>领取方式</dt>
            <dd className="text-right font-semibold text-slate-800">活动现场核验领取</dd>
          </div>
        </dl>
        <p className="mt-3 text-[12px] leading-5 text-slate-400">
          当前只展示状态结构，不生成真实签到记录、领取码或库存占用。
        </p>
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'purchase-reward'}
        title="团队惊喜权益"
        eyebrow="消费任务 · 2 / 3"
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
            <dd className="font-semibold text-slate-800">2 / 3 人</dd>
          </div>
          <div className="flex justify-between gap-4 py-3">
            <dt>金额进度</dt>
            <dd className="font-semibold text-slate-800">¥228 / ¥300</dd>
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
      >
        <div className="grid gap-3">
          <div className="rounded-[16px] border border-slate-100 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="font-bold text-slate-800">团队生活礼</p>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-500">待达成</span>
            </div>
            <p className="mt-1 text-[12px] text-slate-500">签到 2 / 3 人，还差 1 位团员。</p>
          </div>
          <div className="rounded-[16px] border border-slate-100 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="font-bold text-slate-800">团队惊喜权益</p>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-500">待达成</span>
            </div>
            <p className="mt-1 text-[12px] text-slate-500">购买成员 2 / 3，金额 ¥228 / ¥300。</p>
          </div>
          <div className="rounded-[16px] border border-slate-100 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="font-bold text-slate-800">今日抽奖</p>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                drawResult ? 'bg-[#fff3e6] text-orange-700' : 'bg-[#e8f6f0] text-teal-700'
              }`}>
                {drawResult ? '待领取 · 演示' : '可抽取'}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-slate-500">
              {drawResult
                ? `本次演示中奖：${drawResult.level} · ${drawResult.name}。`
                : '今天还有 1 次演示抽奖机会。'}
            </p>
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-5 text-slate-400">
          “待领取”仅用于验证奖励状态设计，不生成真实券码或兑奖凭证。
        </p>
      </CampaignSheet>

      <CampaignSheet
        open={activeSheet === 'community-goal'}
        title="社区里程碑奖励"
        eyebrow="COMMUNITY GOAL"
        onClose={() => setActiveSheet(null)}
      >
        <p className="mb-3 text-[13px] leading-6 text-slate-600">
          每个小团仍为 3 人，里程碑按照整个幸福里社区的成功成团数累计计算，不是把不同团队合并为大团。
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
            <dd className="text-right font-semibold text-slate-800">10月31日 20:00</dd>
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
