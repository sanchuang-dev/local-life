import { useState } from 'react'
import {
  Award,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  ImageDown,
  Clock3,
  Crown,
  Gift,
  MapPin,
  Medal,
  PartyPopper,
  Share2,
  Sparkles,
  Store,
  Ticket,
  Trophy,
  Tv2,
} from 'lucide-react'
import { Link } from 'react-router'
import { QRCodeSVG } from 'qrcode.react'
import { CampaignSheet } from '../components/CampaignSheet'

type TaskMode = 'checkin' | 'purchase'
type SheetKind =
  | 'rules'
  | 'share'
  | 'checkin-reward'
  | 'purchase-reward'
  | 'my-rewards'
  | 'grand-prize'
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

const drawPrizes = [
  { level: '一等奖', prize: '惊喜硬件礼包' },
  { level: '二等奖', prize: '本地体验券' },
  { level: '三等奖', prize: '生活纸品' },
  { level: '四等奖', prize: '鸡蛋兑换券' },
  { level: '五等奖', prize: '社区小礼物' },
]

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
  const [drawResult, setDrawResult] = useState<(typeof drawPrizes)[number] | null>(null)
  const [showFullRanking, setShowFullRanking] = useState(false)

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

  const handleDraw = () => {
    if (drawResult) return
    setDrawResult(drawPrizes[2])
  }

  return (
    <div className="pb-7">
      <section className="relative overflow-hidden bg-[#eaf5e9]">
        <img
          src={import.meta.env.BASE_URL + 'images/silver-neighborhood-hero.webp'}
          alt="银发社区欢乐季，三人成团·天天有礼。三位长者在欢乐的社区活动中相聚。"
          className="block aspect-[4/3] w-full object-cover"
          fetchPriority="high"
        />
        <div className="relative -mt-px bg-gradient-to-b from-[#edf8e9] via-[#e8f5ec] to-[#d8eee5] px-4 pb-16 pt-3">
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
              <button
                type="button"
                onClick={() => openSheet('checkin-reward')}
                className="mt-3 flex min-h-[68px] w-full items-center gap-3 rounded-[15px] bg-[#f7faf9] p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                <Gift size={22} className="shrink-0 text-orange-500" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-bold text-slate-700">团队生活礼</span>
                  <span className="mt-0.5 block text-[12px] leading-5 text-slate-500">
                    鸡蛋 / 纸巾等活动小礼 · 查看解锁与领取说明
                  </span>
                </span>
                <ChevronRight size={17} className="text-slate-300" aria-hidden="true" />
              </button>
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
              <button
                type="button"
                onClick={() => openSheet('purchase-reward')}
                className="mt-3 flex min-h-[68px] w-full items-center gap-3 rounded-[15px] bg-[#faf8ff] p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                <Award size={22} className="shrink-0 text-[#765caf]" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-bold text-slate-700">团队惊喜权益</span>
                  <span className="mt-0.5 block text-[12px] leading-5 text-slate-500">
                    参考价值约 ¥100 · 查看达标与团队分配说明
                  </span>
                </span>
                <ChevronRight size={17} className="text-slate-300" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="mx-4 mt-6 rounded-[20px] border border-orange-100 bg-gradient-to-br from-[#fffaf1] to-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-[0.14em] text-orange-600">COMMUNITY GOAL</p>
            <h2 className="mt-1 text-[18px] font-bold text-slate-900">社区一起解锁更多礼</h2>
          </div>
          <PartyPopper size={26} className="text-orange-500" aria-hidden="true" />
        </div>
        <p className="mt-2 text-[12px] leading-5 text-slate-500">
          每个团仍然只有 3 人；这里统计整个社区成功团数，不把大家拼成九人、十八人大团。
        </p>

        <div className="mt-4 grid grid-cols-3 gap-2">
          {[
            ['20团', '鸡蛋加码', true],
            ['50团', '体验券加码', false],
            ['100团', '惊喜礼加码', false],
          ].map(([target, reward, reached]) => (
            <div
              key={target as string}
              className={`rounded-[15px] border p-2.5 text-center ${
                reached ? 'border-orange-200 bg-[#fff3dc]' : 'border-slate-100 bg-white'
              }`}
            >
              <p className={`text-[15px] font-bold ${reached ? 'text-orange-700' : 'text-slate-700'}`}>
                {target}
              </p>
              <p className="mt-1 text-[11px] leading-4 text-slate-500">{reward}</p>
              <p className={`mt-1 text-[11px] font-semibold ${reached ? 'text-orange-600' : 'text-slate-400'}`}>
                {reached ? '已解锁' : '待解锁'}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 text-[12px] text-slate-500">
          <span>幸福里社区已成功 36 团</span>
          <span className="text-right font-semibold text-orange-600">距离 50 团还差 14 团</span>
        </div>
      </section>

      <section className="mx-4 mt-6">
        <div className="mb-3 flex min-h-[44px] items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-teal-700">DAILY LUCK</p>
            <h2 className="mt-1 text-[19px] font-bold text-slate-900">今日抽奖</h2>
          </div>
          <button
            type="button"
            onClick={() => openSheet('my-rewards')}
            className="min-h-[44px] rounded-full bg-[#e8f6f0] px-3 text-[12px] font-bold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            我的奖励
          </button>
        </div>

        <div className="overflow-hidden rounded-[22px] bg-[#173e38] p-4 text-white shadow-[0_12px_28px_rgba(14,59,51,0.12)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[16px] font-bold">五档惊喜奖池</p>
              <p className="mt-1 text-[12px] leading-5 text-white/70">
                当前页面提供一次可重复验收的演示抽奖，不代表真实中奖概率或发奖。
              </p>
            </div>
            <Ticket size={26} className="text-[#ffd991]" aria-hidden="true" />
          </div>

          <div className="mt-4 grid grid-cols-5 gap-1.5">
            {drawPrizes.map((item, index) => (
              <div
                key={item.level}
                className={`rounded-[12px] border px-1 py-2 text-center ${
                  index === 2 && drawResult
                    ? 'border-[#ffd88b] bg-[#ffd88b] text-[#65430d]'
                    : 'border-white/12 bg-white/8'
                }`}
              >
                <p className="text-[11px] font-bold">{item.level}</p>
                <p className="mt-1 text-[11px] leading-4 opacity-85">{item.prize}</p>
              </div>
            ))}
          </div>

          <div aria-live="polite">
            {drawResult ? (
              <div className="mt-3 flex items-center gap-2 rounded-[14px] bg-white/10 p-3 text-[13px]">
                <Check size={18} className="shrink-0 text-[#ffd991]" aria-hidden="true" />
                <span>
                  本次演示结果：<strong>{drawResult.level} · {drawResult.prize}</strong>
                </span>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={handleDraw}
            disabled={Boolean(drawResult)}
            className={`mt-3 flex min-h-[46px] w-full items-center justify-center gap-2 rounded-[14px] px-4 text-[14px] font-bold ${
              drawResult
                ? 'cursor-default bg-white/15 text-white/70'
                : 'bg-[#ffd991] text-[#5b3d0c]'
            }`}
          >
            <Sparkles size={17} aria-hidden="true" />
            {drawResult ? '今日演示已抽' : '试试今日手气'}
          </button>
        </div>
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

      <section className="mx-4 mt-6 overflow-hidden rounded-[22px] border border-[#eadbb7] bg-gradient-to-br from-[#fff8e8] via-white to-[#f4fbf8] p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] bg-[#2c554c] text-[#ffe09d]">
            <Crown size={25} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-bold tracking-[0.15em] text-[#9b711f]">FINAL PRIZE</p>
            <h2 className="mt-1 text-[19px] font-bold text-slate-900">活动压轴大奖</h2>
            <p className="mt-1 text-[12px] leading-5 text-slate-500">
              活动结束时，社区榜前 20 名参与者获得大奖抽取资格。不是“前 20 名必得大奖”。
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <div className="rounded-[15px] bg-white p-3 shadow-sm">
            <Trophy size={20} className="text-[#b17b18]" aria-hidden="true" />
            <p className="mt-2 text-[13px] font-bold text-slate-800">大奖示例</p>
            <p className="mt-1 text-[12px] leading-5 text-slate-500">广电硬件 / 魔镜体验设备</p>
          </div>
          <div className="rounded-[15px] bg-white p-3 shadow-sm">
            <Clock3 size={20} className="text-teal-700" aria-hidden="true" />
            <p className="mt-2 text-[13px] font-bold text-slate-800">剩余 4 天</p>
            <p className="mt-1 text-[12px] leading-5 text-slate-500">10月31日 20:00 结束 · 示例</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => openSheet('grand-prize')}
          className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-[13px] border border-[#dfc98e] bg-white text-[13px] font-bold text-[#8d681f]"
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
                ? `本次演示中奖：${drawResult.level} · ${drawResult.prize}。`
                : '今天还有 1 次演示抽奖机会。'}
            </p>
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-5 text-slate-400">
          “待领取”仅用于验证奖励状态设计，不生成真实券码或兑奖凭证。
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
