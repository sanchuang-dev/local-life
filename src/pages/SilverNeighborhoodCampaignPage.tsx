import { useState } from 'react'
import {
  Award,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
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
  UsersRound,
} from 'lucide-react'
import { Link } from 'react-router'
import { PendingNotice } from '../components/PendingNotice'
import { usePendingNotice } from '../hooks/usePendingNotice'

type TaskMode = 'checkin' | 'purchase'

const communityRanks = [
  { rank: 1, name: '悦和社区', teams: 52, score: '326人参与' },
  { rank: 2, name: '幸福里社区', teams: 36, score: '228人参与', current: true },
  { rank: 3, name: '榕树湾社区', teams: 31, score: '196人参与' },
]

const supplies = [
  {
    icon: Store,
    badge: '本地商户',
    title: '老手艺体验券',
    desc: '参考价值 ¥100 · 到店预约体验',
    tone: 'bg-[#fff3e6] text-[#ba7635]',
  },
  {
    icon: Tv2,
    badge: '广电精选',
    title: '智能家居体验礼包',
    desc: '活动价与服务内容待真实供给确认',
    tone: 'bg-[#e8f6f0] text-[#247963]',
  },
  {
    icon: Sparkles,
    badge: '魔镜体验',
    title: '银发焕新体验',
    desc: '现场体验 · 奖励资格以活动规则为准',
    tone: 'bg-[#f1edff] text-[#6d57a8]',
  },
]

const drawPrizes = [
  { level: '一等奖', prize: '惊喜硬件礼包' },
  { level: '二等奖', prize: '本地体验券' },
  { level: '三等奖', prize: '生活纸品' },
  { level: '四等奖', prize: '鸡蛋兑换券' },
  { level: '五等奖', prize: '社区小礼物' },
]

export function SilverNeighborhoodCampaignPage() {
  const [taskMode, setTaskMode] = useState<TaskMode>('checkin')
  const [showRules, setShowRules] = useState(false)
  const [drawResult, setDrawResult] = useState<string | null>(null)
  const { message, show, dismiss } = usePendingNotice()

  const scrollToTeam = () => {
    document.getElementById('my-team')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleDraw = () => {
    const result = '三等奖 · 生活纸品'
    setDrawResult(result)
    show('设计演示：本次展示结果为“三等奖 · 生活纸品”，不会产生真实中奖或奖品发放。')
  }

  return (
    <div className="pb-7">
      <section className="relative overflow-hidden bg-gradient-to-br from-[#0f665c] via-[#158370] to-[#48aa8f] px-4 pb-20 pt-4 text-white">
        <div
          className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-white/10"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-20 -left-14 h-40 w-40 rounded-full bg-[#ffe2a8]/15"
          aria-hidden="true"
        />

        <div className="relative">
          <Link
            to="/community"
            className="inline-flex min-h-[44px] items-center rounded-full bg-white/12 px-3 text-[13px] font-semibold text-white backdrop-blur-sm"
          >
            返回社区
          </Link>

          <div className="mt-5 flex flex-wrap gap-2">
            <span className="rounded-full bg-[#fff0c8] px-2.5 py-1 text-[11px] font-bold text-[#915f16]">
              银发社区欢乐季
            </span>
            <span className="rounded-full bg-white/12 px-2.5 py-1 text-[11px] font-medium text-white/90">
              二期高保真设计演示
            </span>
          </div>

          <h1 className="mt-3 text-[30px] font-bold leading-[1.18] tracking-tight">
            邻里三人成团
            <br />
            天天有礼
          </h1>
          <p className="mt-3 max-w-[310px] text-[14px] leading-6 text-white/88">
            找两位街坊一起参加。签到成团领生活礼，活动期间还能抽奖、冲社区榜、赢大奖。
          </p>

          <div className="mt-4 grid gap-2 text-[12px] text-white/90">
            <span className="flex items-center gap-2">
              <CalendarDays size={16} aria-hidden="true" />
              10月26日–31日 · 设计示例
            </span>
            <span className="flex items-center gap-2">
              <MapPin size={16} aria-hidden="true" />
              幸福里社区活动广场 · 设计示例
            </span>
          </div>

          <div className="mt-5 flex gap-2.5">
            <button
              type="button"
              onClick={scrollToTeam}
              className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-[14px] bg-[#fff2cf] px-4 text-[14px] font-bold text-[#6f4a12] shadow-[0_9px_24px_rgba(60,43,10,0.14)]"
            >
              <UsersRound size={18} aria-hidden="true" />
              看我的团
            </button>
            <button
              type="button"
              onClick={() => setShowRules((value) => !value)}
              className="min-h-[48px] rounded-[14px] border border-white/25 bg-white/10 px-4 text-[13px] font-semibold text-white backdrop-blur-sm"
              aria-expanded={showRules}
            >
              活动规则
            </button>
          </div>

          {showRules ? (
            <div className="mt-3 rounded-[16px] border border-white/20 bg-[#0c594f]/70 p-3.5 text-[12px] leading-5 text-white/90 backdrop-blur-sm">
              本页按“团长占一席 + 再邀请两位成员”做交互演示。真实活动的身份、签到、成交、抽奖概率、
              奖品库存和兑奖方式都必须在运营前另行确认。
            </div>
          ) : null}
        </div>
      </section>

      <section
        id="my-team"
        className="relative z-[2] mx-4 -mt-14 rounded-[22px] border border-slate-100 bg-white p-4 shadow-[0_16px_40px_rgba(15,52,44,0.12)] scroll-mt-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-[#e8f6f0] px-2.5 py-1 text-[11px] font-bold text-teal-700">
                我的三人团
              </span>
              <span className="text-[12px] font-semibold text-orange-600">2 / 3</span>
            </div>
            <h2 className="mt-2 text-[20px] font-bold tracking-tight text-slate-900">还差 1 位街坊</h2>
            <p className="mt-1 text-[12px] leading-5 text-slate-500">
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
            <p className="mt-0.5 text-[10px] text-teal-700">已加入</p>
          </div>
          <div className="rounded-[16px] border border-teal-100 bg-[#f4fbf8] p-3 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-[#d8efe7] text-[14px] font-bold text-teal-800">
              王
            </div>
            <p className="mt-2 text-[12px] font-semibold text-slate-700">王阿姨</p>
            <p className="mt-0.5 text-[10px] text-teal-700">已加入</p>
          </div>
          <button
            type="button"
            onClick={() => show('设计演示：这里会唤起真实活动分享卡或二维码；当前不会发送邀请。')}
            className="min-h-[96px] rounded-[16px] border border-dashed border-orange-200 bg-[#fffaf3] p-3 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-[#fff0d7] text-[22px] font-light text-orange-600">
              +
            </div>
            <p className="mt-2 text-[12px] font-semibold text-slate-700">邀请街坊</p>
            <p className="mt-0.5 text-[10px] text-orange-600">还差 1 人</p>
          </button>
        </div>

        <button
          type="button"
          onClick={() => show('设计演示：这里会打开分享卡、二维码或微信分享能力；本页不产生真实传播关系。')}
          className="mt-3 flex min-h-[46px] w-full items-center justify-center gap-2 rounded-[14px] bg-teal-700 px-4 text-[14px] font-bold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <Share2 size={17} aria-hidden="true" />
          邀请 1 位街坊来成团
        </button>
        <p className="mt-2 text-center text-[11px] leading-5 text-slate-400">
          设计假设：本活动团长占一席；真实规则待运营确认。
        </p>
      </section>

      <section className="mx-4 mt-5">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-teal-700">TEAM QUEST</p>
            <h2 className="mt-1 text-[19px] font-bold tracking-tight text-slate-900">成团任务</h2>
          </div>
          <span className="text-[11px] text-slate-400">两条任务独立计算</span>
        </div>

        <div className="rounded-[20px] border border-slate-100 bg-white p-3 shadow-sm">
          <div className="grid grid-cols-2 rounded-[14px] bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setTaskMode('checkin')}
              aria-pressed={taskMode === 'checkin'}
              className={`min-h-[42px] rounded-[11px] px-3 text-[13px] font-bold transition ${
                taskMode === 'checkin'
                  ? 'bg-white text-teal-700 shadow-sm'
                  : 'text-slate-500'
              }`}
            >
              签到组队
            </button>
            <button
              type="button"
              onClick={() => setTaskMode('purchase')}
              aria-pressed={taskMode === 'purchase'}
              className={`min-h-[42px] rounded-[11px] px-3 text-[13px] font-bold transition ${
                taskMode === 'purchase'
                  ? 'bg-white text-teal-700 shadow-sm'
                  : 'text-slate-500'
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
              <div className="mt-3 flex items-center gap-3 rounded-[15px] bg-[#f7faf9] p-3">
                <Gift size={22} className="shrink-0 text-orange-500" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-bold text-slate-700">团队生活礼</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-slate-500">
                    鸡蛋 / 纸巾等活动小礼 · 具体以现场奖池为准
                  </p>
                </div>
                <ChevronRight size={17} className="text-slate-300" aria-hidden="true" />
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[14px] font-bold text-slate-800">三人有效购买 + 团队达标</p>
                  <p className="mt-1 text-[12px] text-slate-500">2 / 3 人已购 · ¥228 / ¥300（设计样例）</p>
                </div>
                <span className="shrink-0 rounded-full bg-[#f1edff] px-2.5 py-1 text-[11px] font-bold text-[#725aa9]">
                  高价值礼
                </span>
              </div>
              <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full w-[76%] rounded-full bg-gradient-to-r from-[#6e5ab0] to-[#a68bd5]" />
              </div>
              <div className="mt-3 flex items-center gap-3 rounded-[15px] bg-[#faf8ff] p-3">
                <Award size={22} className="shrink-0 text-[#765caf]" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-bold text-slate-700">团队惊喜权益</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-slate-500">
                    参考价值约 ¥100 · 实物或本地体验权益，非现金返还
                  </p>
                </div>
                <ChevronRight size={17} className="text-slate-300" aria-hidden="true" />
              </div>
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
              <p className="mt-1 text-[10px] leading-4 text-slate-500">{reward}</p>
              <p className={`mt-1 text-[10px] font-semibold ${reached ? 'text-orange-600' : 'text-slate-400'}`}>
                {reached ? '已解锁' : '待解锁'}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
          <span>幸福里社区已成功 36 团</span>
          <span className="font-semibold text-orange-600">距离 50 团还差 14 团</span>
        </div>
      </section>

      <section className="mx-4 mt-6">
        <div className="mb-3 flex items-end justify-between">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-teal-700">DAILY LUCK</p>
            <h2 className="mt-1 text-[19px] font-bold text-slate-900">今日抽奖</h2>
          </div>
          <span className="rounded-full bg-[#e8f6f0] px-2.5 py-1 text-[11px] font-bold text-teal-700">
            今日 1 次
          </span>
        </div>

        <div className="overflow-hidden rounded-[22px] bg-[#173e38] p-4 text-white shadow-[0_12px_28px_rgba(14,59,51,0.12)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[16px] font-bold">五档惊喜奖池</p>
              <p className="mt-1 text-[11px] leading-5 text-white/65">
                有效参与者每天可获得机会；真实概率与库存上线前公示。
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
                <p className="text-[9px] font-bold">{item.level}</p>
                <p className="mt-1 text-[9px] leading-3 opacity-80">{item.prize}</p>
              </div>
            ))}
          </div>

          {drawResult ? (
            <div className="mt-3 flex items-center gap-2 rounded-[14px] bg-white/10 p-3 text-[12px]">
              <Sparkles size={18} className="shrink-0 text-[#ffd991]" aria-hidden="true" />
              <span>
                设计结果：<strong>{drawResult}</strong> · 不产生真实奖品
              </span>
            </div>
          ) : null}

          <button
            type="button"
            onClick={handleDraw}
            className="mt-3 flex min-h-[46px] w-full items-center justify-center gap-2 rounded-[14px] bg-[#ffd991] px-4 text-[14px] font-bold text-[#5b3d0c]"
          >
            <Sparkles size={17} aria-hidden="true" />
            试试今日手气 · 设计演示
          </button>
        </div>
      </section>

      <section className="mx-4 mt-6">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-teal-700">COMMUNITY RANK</p>
            <h2 className="mt-1 text-[19px] font-bold text-slate-900">社区热力榜</h2>
          </div>
          <span className="text-[11px] text-slate-400">按有效成团数 · 设计口径</span>
        </div>

        <div className="overflow-hidden rounded-[20px] border border-slate-100 bg-white shadow-sm">
          {communityRanks.map((item) => (
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
                      : 'bg-[#f7e8de] text-[#966044]'
                }`}
              >
                {item.rank}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[14px] font-bold text-slate-800">{item.name}</p>
                  {item.current ? (
                    <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[9px] font-bold text-teal-700">
                      我们社区
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[11px] text-slate-400">{item.score}</p>
              </div>
              <div className="text-right">
                <p className="text-[15px] font-bold text-teal-700">{item.teams}</p>
                <p className="text-[10px] text-slate-400">有效团</p>
              </div>
            </div>
          ))}
        </div>
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
            <p className="mt-1 text-[11px] leading-4 text-slate-500">广电硬件 / 魔镜体验设备</p>
          </div>
          <div className="rounded-[15px] bg-white p-3 shadow-sm">
            <Clock3 size={20} className="text-teal-700" aria-hidden="true" />
            <p className="mt-2 text-[13px] font-bold text-slate-800">剩余 4 天</p>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">10月31日 20:00 结束 · 示例</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() =>
            show('设计演示：大奖采用“前 20 名取得抽奖资格”的单一口径；真实奖品、名额与开奖方式仍需运营确认。')
          }
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
          {supplies.map(({ icon: Icon, badge, title, desc, tone }) => (
            <button
              key={title}
              type="button"
              onClick={() =>
                show(`设计演示：打开“${title}”的活动供给详情；当前不会创建订单、支付或预约。`)
              }
              className="flex min-h-[82px] w-full items-center gap-3 rounded-[18px] border border-slate-100 bg-white p-3.5 text-left shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-[15px] ${tone}`}>
                <Icon size={23} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-[10px] font-bold text-teal-700">{badge}</span>
                <span className="mt-0.5 block text-[14px] font-bold text-slate-800">{title}</span>
                <span className="mt-1 block text-[11px] leading-4 text-slate-500">{desc}</span>
              </span>
              <ChevronRight size={18} className="shrink-0 text-slate-300" aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      <section className="mx-4 mt-6 rounded-[18px] border border-dashed border-teal-300/70 bg-[#eef7f2] p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 size={19} className="mt-0.5 shrink-0 text-teal-700" aria-hidden="true" />
          <div>
            <p className="text-[13px] font-bold text-slate-700">这是高保真交互设计，不是真实活动</p>
            <p className="mt-1 text-[11px] leading-[1.7] text-slate-500">
              人数、金额、社区、奖品和开奖结果均为设计样例。后续真实试运营必须接入持久化、身份去重、
              现场核验、奖品库存、兑奖和运营审计。
            </p>
          </div>
        </div>
      </section>

      <div className="mx-4 mt-4 flex items-center justify-center gap-2 text-[10px] text-slate-400">
        <Medal size={14} aria-hidden="true" />
        三人成团 · 天天有奖 · 社区争榜 · 活动冲大奖
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
