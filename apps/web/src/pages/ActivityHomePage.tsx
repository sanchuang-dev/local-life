import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CalendarClock,
  ChevronRight,
  CircleHelp,
  Gift,
  MapPin,
  RefreshCw,
  Share2,
  Sparkles,
  UserRound,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { CampaignSheet } from '../components/CampaignSheet'
import { ActivityShareSheet } from '../components/home/ActivityShareSheet'
import {
  formatShanghaiDateTime,
  residentActivityPhase,
  residentActivityPhaseLabels,
  residentActivityPhaseTones,
} from '../components/home/activityFormat'
import { ParticipationTeamCard } from '../components/activity/ParticipationTeamCard'
import { ActivityLoginMarkerCleanup } from '../components/activity/ActivityLoginResult'
import { readActivityLoginResult, type ActivityLoginResult } from '../components/activity/loginReturn'
import { RewardProgressCard } from '../components/activity/RewardProgressCard'
import {
  SILVER_NEIGHBORHOOD_ACTIVITY_PATH,
  buildActivityShareUrl,
  parseInviteParam,
} from '../components/activity/share'
import { useActivityParticipation } from '../hooks/useActivityParticipation'
import { usePublicActivity } from '../hooks/usePublicActivity'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { useRewardProgress } from '../hooks/useRewardProgress'

const quickEntries = [
  { id: 'rewards', label: '我的奖励', hint: '真实奖励与核销凭据', to: '/me/rewards', icon: Gift },
  { id: 'life', label: '惠生活', hint: '真实商城商品', to: '/life', icon: Sparkles },
  { id: 'me', label: '我的', hint: '账户 · 报名 · 三人团', to: '/me', icon: UserRound },
] as const

/**
 * Resident activity home at `/`.
 *
 * The page is a pure composition of the real public activity read state: the
 * published activity comes from the public list endpoint, a deep link may pick
 * one with `?activityId=`, and the three-seat team / participation card is the
 * same real server state used by the activity sub-page. When nothing is
 * published the page shows an explicit empty state instead of a hard-coded
 * campaign.
 *
 * No demo activity, roster, ranking or prize is rendered here: the retained
 * activity sub-page still owns those clearly-labelled demos.
 */
export function ActivityHomePage() {
  const [searchParams] = useSearchParams()
  // A deep link may target one published activity; otherwise the first published
  // activity of the public list is shown. Nothing is hard-coded to one campaign.
  const requestedActivityId = searchParams.get('activityId')?.trim() || null
  // Invite attribution is URL data, never an identity; it is passed through to
  // the participation call and kept in every link built from this page.
  const inviteParam = parseInviteParam(searchParams.get('invite'))
  const { state, retry } = usePublicActivity(requestedActivityId)
  const activity = state.status === 'ready' ? state.activity : null
  // The public list may supply a display default, but only an explicit deep-link ID is login attribution context.
  const loginActivityId = requestedActivityId && activity ? activity.id : null

  const auth = useResidentAuth()
  const [loginResult] = useState<ActivityLoginResult>(() => readActivityLoginResult())
  const participation = useActivityParticipation({
    activityId: activity?.id ?? null,
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })
  const rewardProgress = useRewardProgress({
    activityId: activity?.id ?? null,
    csrfToken: auth.session?.csrfToken ?? null,
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })

  const [sheet, setSheet] = useState<'rules' | 'share' | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // The phase label is derived from the published time window; refresh it
  // periodically so a page left open does not keep an expired label.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const participationData = participation.state.status === 'ready' ? participation.state.data : null
  const team = participationData?.team ?? null
  const selfParticipation = participationData?.participation ?? null
  // The single invite URL used by the QR code, native share and copy-link. It
  // only exists for a member of an open team that still has a real invite code.
  const shareUrl =
    activity &&
    team &&
    selfParticipation &&
    team.status === 'open' &&
    team.seatsFilled < team.seatsTotal &&
    team.inviteCode
      ? buildActivityShareUrl(activity.id, team.inviteCode)
      : null

  const activityPageParams = new URLSearchParams()
  if (activity) activityPageParams.set('activityId', activity.id)
  if (inviteParam.code) activityPageParams.set('invite', inviteParam.code)
  const activityPageUrl = `${SILVER_NEIGHBORHOOD_ACTIVITY_PATH}?${activityPageParams.toString()}`

  const phase = activity ? residentActivityPhase(activity, now) : null

  return (
    <div className="pb-7">
      <ActivityLoginMarkerCleanup authenticated={auth.session !== null} loading={auth.loading} />
      {activity && phase ? (
        <section
          className="relative overflow-hidden bg-gradient-to-br from-[#e9f6ee] via-[#e6f3ea] to-[#d6ece2] px-4 pb-16 pt-5"
          aria-label="当前已发布活动"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${residentActivityPhaseTones[phase]}`}
            >
              {residentActivityPhaseLabels[phase]}
            </span>
            <span className="rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-medium text-[#52786c]">
              已发布活动 · 数据来自服务端
            </span>
            {activity.ruleVersion !== null ? (
              <span className="rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-medium text-[#52786c]">
                规则第 {activity.ruleVersion} 版
              </span>
            ) : null}
          </div>

          <h1 className="mt-2 break-words text-[22px] font-bold leading-[1.32] tracking-tight text-[#1f4d3c]">
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
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] leading-5 text-[#375e40]">
            <CalendarClock size={14} className="shrink-0" aria-hidden="true" />
            <span>
              {formatShanghaiDateTime(activity.startsAt)} - {formatShanghaiDateTime(activity.endsAt)}
            </span>
            <span className="text-[10px] font-medium text-[#52786c]">北京时间</span>
          </p>
          {activity.summary ? (
            <p className="mt-2 break-words text-[12px] leading-5 text-[#4a6f61]">{activity.summary}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSheet('rules')}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-white/80 px-3.5 text-[12px] font-semibold text-[#27725b] transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
            >
              <CircleHelp size={15} aria-hidden="true" />
              活动规则
            </button>
            <Link
              to={activityPageUrl}
              state={{ from: '/' }}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-full bg-white/80 px-3.5 text-[12px] font-semibold text-[#27725b] transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
            >
              活动玩法页
              <ChevronRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </section>
      ) : null}

      {activity ? (
        <ParticipationTeamCard
          activity={activity}
          loginActivityId={loginActivityId}
          activityError={null}
          onRetryActivity={retry}
          auth={auth}
          participation={participation}
          inviteCode={inviteParam.code}
          inviteInvalid={inviteParam.invalid}
          loginResult={loginResult}
          onShare={() => setSheet('share')}
        />
      ) : (
        <ActivityHomeStatus state={state} requestedActivityId={requestedActivityId} onRetry={retry} />
      )}

      {activity ? (
        <section className="mx-4 mt-5" aria-labelledby="activity-progress-heading">
          <div className="mb-2 flex items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold tracking-[0.16em] text-teal-700">MY PROGRESS</p>
              <h2
                id="activity-progress-heading"
                className="mt-1 text-[19px] font-bold tracking-tight text-slate-900"
              >
                我的签到与团队奖励
              </h2>
            </div>
            <span className="shrink-0 text-[11px] text-slate-400">真实数据</span>
          </div>
          <div className="rounded-[20px] border border-slate-100 bg-white p-3.5 shadow-sm">
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

      {activity && shareUrl ? (
        <section className="mx-4 mt-4" aria-labelledby="activity-invite-heading">
          <div className="rounded-[18px] border border-teal-200/70 bg-[#eef7f2] px-4 py-3.5">
            <p
              id="activity-invite-heading"
              className="flex items-center gap-1.5 text-[13px] font-bold text-[#225c4c]"
            >
              <Share2 size={16} className="shrink-0" aria-hidden="true" />
              邀请街坊加入三人团
            </p>
            <p className="mt-1 text-[12px] leading-5 text-[#52786c]">
              你本场三人团还有 {Math.max(0, (team?.seatsTotal ?? 3) - (team?.seatsFilled ?? 0))} 个空席，
              邀请链接与二维码带真实活动与邀请码；好友需登录并主动确认才会加入。
            </p>
            <button
              type="button"
              onClick={() => setSheet('share')}
              className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-teal-700 px-4 text-[12px] font-bold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <Share2 size={15} aria-hidden="true" />
              打开邀请与二维码
            </button>
          </div>
        </section>
      ) : null}

      <section className="mx-4 mt-6" aria-labelledby="activity-home-more-heading">
        <h2 id="activity-home-more-heading" className="text-[16px] font-bold text-slate-800">
          活动之外
        </h2>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {quickEntries.map(({ id, label, hint, to, icon: Icon }) => (
            <Link
              key={id}
              to={to}
              state={{ from: '/' }}
              className="flex min-h-[76px] items-center gap-2.5 rounded-[16px] border border-slate-100 bg-white p-3 shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-[#e8f6f0] text-[#388b77]"
                aria-hidden="true"
              >
                <Icon size={18} strokeWidth={1.8} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-slate-800">{label}</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">{hint}</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <p className="mx-4 mt-5 text-[11px] leading-[1.7] text-slate-400">
        本页只呈现服务端已发布的活动：活动信息、参与、三人团、签到与团队奖励为真实业务。
        抽奖、社区榜单与压轴大奖等尚未落地的玩法只保留在活动玩法页，并明确标注为演示，不会产生真实记录或发放。
      </p>

      <CampaignSheet
        open={sheet === 'rules'}
        title="活动规则"
        eyebrow={activity ? '已发布规则快照' : '活动规则'}
        onClose={() => setSheet(null)}
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
              。
            </p>
          </>
        ) : (
          <p className="rounded-[14px] bg-slate-50 p-3 text-[13px] leading-6 text-slate-500">
            尚未读取到已发布活动，暂无可展示的活动规则。
          </p>
        )}
      </CampaignSheet>

      <ActivityShareSheet
        open={sheet === 'share'}
        activity={activity}
        shareUrl={shareUrl}
        seatsFilled={team?.seatsFilled ?? null}
        seatsTotal={team?.seatsTotal ?? null}
        onClose={() => setSheet(null)}
      />
    </div>
  )
}

/**
 * Real loading / empty / error states for the activity home. None of them
 * substitutes demo data, and the error branch keeps the server message visible
 * with an explicit retry.
 */
function ActivityHomeStatus({
  state,
  requestedActivityId,
  onRetry,
}: {
  state: ReturnType<typeof usePublicActivity>['state']
  requestedActivityId: string | null
  onRetry: () => void
}) {
  // `ready` is rendered by the parent; this component owns the three non-ready states.
  if (state.status === 'ready') return null

  if (state.status === 'loading') {
    return (
      <section
        className="mx-4 mt-5 rounded-[20px] border border-slate-100 bg-white p-5 shadow-sm"
        role="status"
        aria-live="polite"
      >
        <p className="flex items-center gap-2 text-[13px] font-semibold text-slate-600">
          <span
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-teal-700/25 border-t-teal-700"
            aria-hidden="true"
          />
          正在读取当前已发布活动…
        </p>
        <div className="mt-3 grid gap-2" aria-hidden="true">
          <div className="h-4 w-2/3 animate-pulse rounded-full bg-slate-100" />
          <div className="h-4 w-1/2 animate-pulse rounded-full bg-slate-100" />
          <div className="h-11 w-full animate-pulse rounded-[14px] bg-slate-100" />
        </div>
      </section>
    )
  }

  if (state.status === 'empty') {
    return (
      <section className="mx-4 mt-5 rounded-[20px] border border-dashed border-slate-200 bg-white px-4 py-8 text-center shadow-sm">
        <span
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#eef7f2] text-teal-700"
          aria-hidden="true"
        >
          <CalendarClock size={24} strokeWidth={1.7} />
        </span>
        <h1 className="mt-3 text-[17px] font-bold text-slate-800">当前没有已发布的活动</h1>
        <p className="mt-1.5 text-[12px] leading-5 text-slate-500">
          活动发布后，这里会显示真实的活动标题、社区、地点、时间与参与入口。
          本页不会用示例活动、虚构名额或演示奖品填充。
        </p>
        <div className="mt-3 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-teal-700 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            <RefreshCw size={15} aria-hidden="true" />
            重新读取活动
          </button>
          <Link
            to="/community"
            state={{ from: '/' }}
            className="inline-flex min-h-[44px] items-center px-2 text-[12px] font-medium text-teal-700 hover:underline"
          >
            先去看看社区内容
          </Link>
        </div>
      </section>
    )
  }

  return (
    <section className="mx-4 mt-5 rounded-[20px] border border-[#efd0b8] bg-[#fff7f0] px-4 py-4" role="alert">
      <p className="flex items-center gap-1.5 text-[14px] font-bold text-[#7a4a2c]">
        <AlertTriangle size={16} aria-hidden="true" />
        活动信息加载失败
      </p>
      <p className="mt-1 break-words text-[12px] leading-5 text-[#7a4a2c]">{state.message}</p>
      {requestedActivityId ? (
        <p className="mt-1 break-words text-[11px] leading-4 text-[#8a6132]">
          当前链接指定了活动 {requestedActivityId}，没有回退到其他活动或示例数据。
        </p>
      ) : null}
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-[#7a4a2c] px-4 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
      >
        <RefreshCw size={14} aria-hidden="true" />
        重试
      </button>
    </section>
  )
}
