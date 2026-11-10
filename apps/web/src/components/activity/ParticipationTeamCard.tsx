import { type ReactNode, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Gift,
  LockKeyhole,
  RefreshCw,
  Share2,
} from 'lucide-react'
import type { PublicActivityDetail } from '@sanchuang-dev/local-life-contracts'
import type { useActivityParticipation } from '../../hooks/useActivityParticipation'
import type { useResidentAuth } from '../../hooks/useResidentAuth'
import { ActivityLoginCard } from './ActivityLoginCard'
import { ActivityLoginSuccessNotice } from './ActivityLoginResult'
import type { ActivityLoginResult } from './loginReturn'

type ResidentAuth = ReturnType<typeof useResidentAuth>
type Participation = ReturnType<typeof useActivityParticipation>

type Feedback = {
  tone: 'success' | 'error'
  text: string
}

type ParticipationTeamCardProps = {
  activity: PublicActivityDetail | null
  /** Activity context explicitly present in the entry URL; display defaults are not attribution. */
  loginActivityId: string | null
  activityError: string | null
  onRetryActivity: () => void
  auth: ResidentAuth
  participation: Participation
  /** Validated invite code from the deep link, never invented. */
  inviteCode: string | null
  /** The deep link had an `invite` value that failed contract validation. */
  inviteInvalid: boolean
  /**
   * One-off login-marker snapshot captured by the page before the URL cleanup
   * (#92). Only the authenticated branch may present it as a success.
   */
  loginResult?: ActivityLoginResult
  onShare: () => void
}

const cardClassName =
  'relative z-[2] mx-4 -mt-14 scroll-mt-4 rounded-[22px] border border-slate-100 bg-white p-4 shadow-[0_16px_40px_rgba(15,52,44,0.12)]'

function LoadingLine({ text }: { text: string }) {
  return (
    <p className="mt-3 flex items-center gap-2 text-[12px] font-medium text-slate-500" role="status" aria-live="polite">
      <span
        className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-teal-700/25 border-t-teal-700"
        aria-hidden="true"
      />
      {text}
    </p>
  )
}

function unavailableText(state: {
  unavailableReason: 'activity_not_published' | 'activity_ended' | null
  activityStatus: 'published' | 'paused' | 'ended'
}): string {
  // A paused/ended activity wins over the generic reason: the API currently
  // reports paused as `activity_not_published`, which would otherwise show
  // "活动尚未发布" and contradict the page header "活动已暂停".
  if (state.activityStatus === 'paused') return '活动已暂停，暂不可参与。'
  if (state.activityStatus === 'ended') return '活动已结束，暂不可参与。'
  if (state.unavailableReason === 'activity_not_published') return '活动尚未发布，暂不可参与。'
  if (state.unavailableReason === 'activity_ended') return '活动已结束，暂不可参与。'
  return '当前暂不可参与；若你来自邀请链接，该团可能已满员或名额已锁定。'
}

/**
 * Real participation / three-person-team card.
 *
 * Every value shown here comes from the participation API: seat count, member
 * names, leader flag, open/locked status and the team invite code. The card
 * never falls back to the old demonstration roster, and a locked (3/3) team
 * exposes no invite action at all.
 */
export function ParticipationTeamCard({
  activity,
  loginActivityId,
  activityError,
  onRetryActivity,
  auth,
  participation,
  inviteCode,
  inviteInvalid,
  loginResult = null,
  onShare,
}: ParticipationTeamCardProps) {
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const loadState = participation.state

  const handleConfirm = async () => {
    setFeedback(null)
    const outcome = await participation.confirm(inviteCode)
    setFeedback(
      outcome.ok
        ? {
            tone: 'success',
            text: outcome.created
              ? '参与成功，已加入三人团。'
              : '你已参与本活动，参与状态已刷新。',
          }
        : { tone: 'error', text: outcome.message },
    )
  }

  let heading = '我的三人团'
  let description = '查看你的三人团进度'
  let statusChip: { text: string; tone: 'teal' | 'orange' | 'slate' } | null = null
  let seatsChip: string | null = null
  let body: ReactNode = null

  if (!activity) {
    heading = activityError ? '参与状态暂不可读取' : '正在读取活动信息…'
    description = activityError
      ? '活动信息加载失败，参与状态需要先确认活动。'
      : '请稍候…'
    body = activityError ? (
      <div className="mt-3 rounded-[14px] bg-[#fff7f0] p-3 text-[#7a4a2c]">
        <p className="break-words text-[12px] leading-5">{activityError}</p>
        <button
          type="button"
          onClick={onRetryActivity}
          className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-[#7a4a2c] px-4 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
        >
          <RefreshCw size={14} aria-hidden="true" />
          重试活动信息
        </button>
      </div>
    ) : (
      <LoadingLine text="正在读取活动信息…" />
    )
  } else if (loadState.status === 'idle' || loadState.status === 'loading') {
    heading = '正在读取参与状态…'
    description = '请稍候…'
    statusChip = { text: '读取中', tone: 'slate' }
    body = <LoadingLine text={auth.loading ? '正在读取登录状态…' : '正在读取你的参与状态…'} />
  } else if (loadState.status === 'unauthenticated') {
    heading = '登录后报名三人团'
    description =
      '登录后可以报名或查看三人团进度。'
    statusChip = { text: '未登录', tone: 'orange' }
    body = (
      <>
        {inviteCode ? (
          <p className="mt-3 rounded-[12px] bg-[#fff7ec] px-3 py-2.5 text-[12px] leading-5 text-[#8a6132]">
            你打开了邀请链接。登录后还需要你主动确认，才会加入三人团并记录邀请归属。
          </p>
        ) : null}
        {/* All resident login methods and retry states live on the shared /login page. */}
        <ActivityLoginCard
          activityId={loginActivityId}
          inviteCode={inviteCode}
          inviteInvalid={inviteInvalid}
          loginResult={loginResult}
        />
        <p className="mt-3 text-[11px] leading-4 text-slate-400">
          登录成功后会自动重新读取本活动状态，活动与邀请参数保留在当前链接中；登录不会自动报名。
        </p>
      </>
    )
  } else if (loadState.status === 'error') {
    heading = '参与状态读取失败'
    description = '请稍后重试。'
    statusChip = { text: '读取失败', tone: 'orange' }
    body = (
      <div className="mt-3 rounded-[14px] bg-[#fff7f0] p-3 text-[#7a4a2c]">
        <p className="break-words text-[12px] leading-5">{loadState.message}</p>
        <button
          type="button"
          onClick={participation.refresh}
          className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-[#7a4a2c] px-4 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
        >
          <RefreshCw size={14} aria-hidden="true" />
          重新读取
        </button>
      </div>
    )
  } else {
    const { data } = loadState
    const member = data.participation
    const team = data.team
    seatsChip = team ? `${team.seatsFilled} / ${team.seatsTotal}` : null

    if (!member) {
      const remainingSeats = team ? Math.max(0, team.seatsTotal - team.seatsFilled) : 3
      heading = inviteCode ? '接受邀请，加入三人团' : '参与本活动，组成三人团'
      description =
        '每团 3 人，确认参与后占用一个席位。'
      statusChip = {
        text: data.joinable ? '可参与' : '暂不可参与',
        tone: data.joinable ? 'teal' : 'slate',
      }
      body = (
        <>
          {inviteCode ? (
            <p className="mt-3 rounded-[12px] bg-[#fff7ec] px-3 py-2.5 text-[12px] leading-5 text-[#8a6132]">
              你通过邀请链接进入。确认参与后，本场活动的邀请归属会记录为这次邀请，之后打开其他链接不会改变归属。
            </p>
          ) : null}
          {inviteInvalid ? (
            <p className="mt-3 rounded-[12px] bg-[#fff7f0] px-3 py-2.5 text-[12px] leading-5 text-[#7a4a2c]">
              邀请链接中的邀请参数无效，本次不会记录邀请归属；你仍可以自行参与。
            </p>
          ) : null}
          <button
            type="button"
            disabled={!data.joinable || participation.confirming}
            onClick={() => void handleConfirm()}
            className={`mt-3 flex min-h-[48px] w-full items-center justify-center rounded-[14px] px-4 text-[14px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${
              data.joinable
                ? 'bg-teal-700 text-white hover:bg-teal-800 disabled:cursor-wait disabled:opacity-70'
                : 'cursor-not-allowed bg-slate-100 text-slate-500'
            }`}
          >
            {participation.confirming
              ? '正在提交…'
              : inviteCode
                ? '确认接受邀请并参与'
                : '确认参与本活动'}
          </button>
          {!data.joinable ? (
            <p className="mt-2 text-[12px] leading-5 text-[#8a6132]" role="status">
              {unavailableText(data)}
            </p>
          ) : (
            <p className="mt-2 text-[11px] leading-4 text-slate-400">
              {inviteCode
                ? '本团当前还有 ' + remainingSeats + ' 个空席；确认后你将成为其中一员。'
                : '确认后你将成为本场三人团的发起人，并占用一席。'}
            </p>
          )}
        </>
      )
    } else if (!team) {
      heading = '参与记录已读取，团队信息暂不可用'
      description = '团队信息暂不可用，请刷新重试。'
      statusChip = { text: '数据异常', tone: 'orange' }
      body = (
        <button
          type="button"
          onClick={participation.refresh}
          className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-[#7a4a2c] px-4 text-[12px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
        >
          <RefreshCw size={14} aria-hidden="true" />
          重新读取
        </button>
      )
    } else {
      const locked = team.status === 'locked'
      const remaining = Math.max(0, team.seatsTotal - team.seatsFilled)
      const canInvite =
        !locked && team.seatsFilled < team.seatsTotal && team.inviteCode !== null
      const attribution =
        member.role === 'leader'
          ? '你是本团团长'
          : member.inviteSource === 'invite' && member.inviterDisplayName
            ? `你是本团成员 · 由 ${member.inviterDisplayName} 邀请加入`
            : '你是本团成员'

      heading = locked ? '已成团' : `还差 ${remaining} 位街坊`
      description = attribution
      statusChip = locked
        ? { text: '已成团', tone: 'teal' }
        : { text: '进行中', tone: 'orange' }

      body = (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2" aria-label="三人团席位">
            {[1, 2, 3].map((seatNo) => {
              const seatMember = team.members.find((item) => item.seatNo === seatNo)
              if (seatMember) {
                const name = seatMember.isSelf ? '我' : seatMember.displayName
                return (
                  <div
                    key={seatNo}
                    className="min-w-0 rounded-[16px] border border-teal-100 bg-[#f4fbf8] p-2 text-center"
                  >
                    <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-teal-700 text-[13px] font-bold text-white">
                      {(seatMember.isSelf ? '我' : seatMember.displayName.trim().slice(0, 1)) || '居'}
                    </div>
                    <p className="mt-1.5 truncate text-[12px] font-semibold text-slate-700" title={name}>
                      {name}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] leading-4 text-teal-700">
                      {seatMember.role === 'leader' ? '团长' : '成员'}
                      {seatMember.isSelf ? ' · 本人' : ''}
                    </p>
                  </div>
                )
              }

              return (
                <button
                  key={seatNo}
                  type="button"
                  disabled={!canInvite}
                  onClick={canInvite ? onShare : undefined}
                  aria-label={canInvite ? `邀请街坊加入第 ${seatNo} 席` : `第 ${seatNo} 席待加入`}
                  className={`min-h-[92px] min-w-0 rounded-[16px] border border-dashed p-2 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${
                    canInvite
                      ? 'border-orange-200 bg-[#fffaf3]'
                      : 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
                  }`}
                >
                  <span
                    className={`mx-auto flex h-10 w-10 items-center justify-center rounded-full text-[20px] font-light ${
                      canInvite ? 'bg-[#fff0d7] text-orange-600' : 'bg-slate-100 text-slate-400'
                    }`}
                  >
                    +
                  </span>
                  <p className={`mt-1.5 text-[12px] font-semibold ${canInvite ? 'text-slate-700' : 'text-slate-400'}`}>
                    {canInvite ? '邀请街坊' : '待加入'}
                  </p>
                  <p className={`mt-0.5 text-[11px] leading-4 ${canInvite ? 'text-orange-600' : 'text-slate-400'}`}>
                    {canInvite ? `还差 ${remaining} 人` : locked ? '已满员' : '暂不可邀请'}
                  </p>
                </button>
              )
            })}
          </div>

          {canInvite ? (
            <button
              type="button"
              onClick={onShare}
              className="mt-3 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[14px] bg-teal-700 px-4 text-[14px] font-bold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <Share2 size={17} aria-hidden="true" />
              邀请 {remaining} 位街坊加入三人团
            </button>
          ) : (
            <p className="mt-3 rounded-[12px] bg-[#eef7f2] px-3 py-2.5 text-[12px] leading-5 text-[#315f4d]">
              {locked
                ? '已成团，本场不再接受新成员；邀请入口已关闭。'
                : '团队邀请码暂不可用，暂时无法邀请街坊。'}
            </p>
          )}
        </>
      )
    }
  }

  return (
    <section id="my-team" className={cardClassName} aria-labelledby="my-team-heading">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[#e8f6f0] px-2.5 py-1 text-[12px] font-bold text-teal-700">
              我的三人团
            </span>
            {statusChip ? (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  statusChip.tone === 'teal'
                    ? 'bg-[#e8f6f0] text-teal-700'
                    : statusChip.tone === 'orange'
                      ? 'bg-[#fff3e6] text-[#a96b2f]'
                      : 'bg-slate-100 text-slate-500'
                }`}
              >
                {statusChip.text}
              </span>
            ) : null}
            {seatsChip ? (
              <span className="text-[12px] font-semibold tabular-nums text-orange-600">{seatsChip}</span>
            ) : null}
          </div>
          <h2 id="my-team-heading" className="mt-2 break-words text-[20px] font-bold tracking-tight text-slate-900">
            {heading}
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-slate-500">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {loadState.status === 'ready' ? (
            <button
              type="button"
              onClick={participation.refresh}
              aria-label="刷新参与状态"
              title="刷新参与状态"
              className="flex h-11 w-11 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <RefreshCw size={17} aria-hidden="true" />
            </button>
          ) : null}
          <div className="rounded-[16px] bg-[#fff3e6] p-2.5 text-[#b97836]" aria-hidden="true">
            {loadState.status === 'ready' && loadState.data.team?.status === 'locked' ? (
              <LockKeyhole size={24} />
            ) : (
              <Gift size={24} />
            )}
          </div>
        </div>
      </div>

      {feedback ? (
        <p
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          className={`mt-3 flex items-start gap-2 rounded-[12px] px-3 py-2.5 text-[12px] leading-5 ${
            feedback.tone === 'error'
              ? 'bg-[#fff1ee] text-rose-700'
              : 'bg-[#eef7f2] text-[#1f6b51]'
          }`}
        >
          {feedback.tone === 'error' ? (
            <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 break-words">{feedback.text}</span>
        </p>
      ) : null}

      {/* A successful WeChat login is presented here, in the authenticated
          branch, and only because `auth.session` comes from the server. The
          unauthenticated branch never shows success, even when the URL says so. */}
      {auth.session ? (
        <ActivityLoginSuccessNotice result={loginResult} authenticated />
      ) : null}

      {body}
    </section>
  )
}
