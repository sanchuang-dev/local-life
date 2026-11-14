import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, CircleAlert, Clock3, MapPin, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router'
import {
  PERMANENT_BINDING_NOTICE,
  browseBindingNotice,
  confirmBlockedMessage,
  formatResidentCommunityDate,
  legacyAssignmentLines,
  residentCommunitySummary,
} from '../../lib/residentCommunity'
import type { ResidentCommunityState } from '../../hooks/useResidentCommunity'

type ResidentCommunityCardProps = {
  state: ResidentCommunityState
  onReload: () => void
  /** The community the resident is currently *browsing* (never a binding claim). */
  browsingCommunity?: { id: string; name: string } | null
  /** Explicit first-confirmation target for the browsing community, when offered. */
  confirmHref?: string | null
  /** Unified-login entry that preserves the current return context. */
  loginHref?: string | null
  /** `full` adds the read-only legacy history and the blocked reason. */
  variant?: 'compact' | 'full'
  /** Where the resident can go to pick a browsing community. */
  chooseCommunityHref?: string
  className?: string
}

const badgeTone: Record<string, string> = {
  unbound: 'bg-[#fff3e6] text-[#a96b2f]',
  confirmed: 'bg-[#e8f6f0] text-[#116d63]',
  pending_review: 'bg-[#fdf0e4] text-[#a96b2f]',
  conflict: 'bg-[#fff1ee] text-[#b23c2e]',
}

const primaryButton =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#138b79] px-4 text-[15px] font-semibold text-white transition-colors hover:bg-[#116d63] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#116d63]'
const secondaryButton =
  'inline-flex min-h-11 items-center justify-center rounded-xl border border-[#cfe8de] bg-white px-4 text-[14px] font-semibold text-[#116d63] transition-colors hover:bg-[#e8f6f0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#116d63]'

/**
 * Read-only permanent-community card (#171 LL-IDENTITY-001).
 *
 * Four honest states and no self-service change affordance:
 * - 未绑定 can lead to the explicit first confirmation (an active action plus a
 *   second confirmation on that page);
 * - 已确认 shows the community and the confirmation date, and nothing that could
 *   read as switch / unbind / rebind;
 * - 历史归属待核查 explains that a human must decide, and offers no picker;
 * - 冲突 shows the existing binding and the refused candidate, never rewording the
 *   refusal as if the binding might have moved.
 *
 * A browse choice is passed in as `browsingCommunity` and only ever produces the
 * browse-vs-binding sentence: switching what you read is allowed, changing your
 * permanent community is not.
 */
export function ResidentCommunityCard({
  state,
  onReload,
  browsingCommunity = null,
  confirmHref = null,
  loginHref = null,
  variant = 'compact',
  chooseCommunityHref = '/',
  className = '',
}: ResidentCommunityCardProps) {
  const heading = (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[15px] font-semibold text-[#0b4a42]">我的常驻社区</h2>
      {state.status === 'ready' && (
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${badgeTone[state.data.status] ?? badgeTone.unbound}`}>
          {residentCommunitySummary(state.data).badge}
        </span>
      )}
    </div>
  )

  const shell = (children: ReactNode) => (
    <section className={`rounded-2xl border border-[#dce6e2] bg-white p-4 ${className}`} aria-labelledby="resident-community-heading">
      <div id="resident-community-heading">{heading}</div>
      {children}
    </section>
  )

  if (state.status === 'idle' || state.status === 'loading') {
    return shell(
      <p className="mt-2 text-[13px] leading-6 text-[#5b6c67]" role="status">正在读取常驻社区状态…</p>,
    )
  }

  if (state.status === 'unauthenticated') {
    return shell(
      <>
        <p className="mt-2 text-[13px] leading-6 text-[#5b6c67]">
          确认常驻社区需要你的居民账户登录。登录后会回到当前页面并保留你进入时的活动与邀请信息，再由你本人完成确认。
        </p>
        {loginHref ? (
          <Link to={loginHref} className={`${primaryButton} mt-3`}>
            登录后绑定为常驻社区
          </Link>
        ) : null}
      </>,
    )
  }

  if (state.status === 'error') {
    return shell(
      <div className="mt-2 rounded-xl border border-[#f0d5bd] bg-[#fff7f0] p-3" role="alert">
        <p className="text-[13px] leading-6 text-[#7a4a2c]">{state.message}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" onClick={onReload} className="min-h-11 text-[13px] font-semibold text-[#116d63] underline">
            重新读取
          </button>
          <Link to={chooseCommunityHref} className="min-h-11 text-[13px] font-semibold text-[#116d63]">
            返回浏览社区
          </Link>
        </div>
      </div>,
    )
  }

  const data = state.data
  const summary = residentCommunitySummary(data)
  const browseNotice = browseBindingNotice({
    browsingCommunityId: browsingCommunity?.id ?? null,
    browsingCommunityName: browsingCommunity?.name ?? null,
    bindingCommunityId: data.binding?.community.id ?? null,
    bindingCommunityName: data.binding?.community.name ?? null,
  })
  const candidateDiffersFromBrowsing =
    data.candidate !== null &&
    browsingCommunity !== null &&
    data.candidate.community.id !== browsingCommunity.id
  const historyLines = legacyAssignmentLines(data)

  return shell(
    <>
      <div className="mt-2 flex items-start gap-2">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#e8f6f0] text-[#116d63]">
          {data.status === 'confirmed' ? <CheckCircle2 size={19} /> :
            data.status === 'conflict' ? <ShieldAlert size={19} /> :
            data.status === 'pending_review' ? <Clock3 size={19} /> :
            <MapPin size={19} />}
        </span>
        <div className="min-w-0">
          <p className="text-[15px] font-semibold leading-6 text-[#172d28]">{summary.title}</p>
          {data.binding ? (
            <p className="mt-0.5 text-[13px] leading-5 text-[#5b6c67]">
              {data.binding.community.serviceAddress || '社区服务点地址暂未录入'}
            </p>
          ) : null}
        </div>
      </div>

      <p className="mt-2 text-[13px] leading-6 text-[#3b4f49]">{summary.detail}</p>

      {data.confirmBlockedReason ? (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-5 text-[#934a35]" role="status">
          <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{confirmBlockedMessage(data.confirmBlockedReason)}</span>
        </p>
      ) : null}

      {variant === 'full' && historyLines.length > 0 ? (
        <div className="mt-3 rounded-xl bg-[#f5f7f7] p-3">
          <p className="text-[12px] font-semibold text-[#52786c]">历史社区归属（只读，不作为常驻社区）</p>
          <ul className="mt-1 grid gap-1">
            {historyLines.map((line) => (
              <li key={line} className="text-[12px] leading-5 text-[#5b6c67]">{line}</li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] leading-5 text-[#5b6c67]">
            这些是历史关系记录，不能证明本人确认过常驻社区，也不会被自动转为常驻社区。
          </p>
        </div>
      ) : null}

      {browseNotice ? (
        <p className="mt-2 text-[12px] leading-5 text-[#52786c]">{browseNotice}</p>
      ) : null}

      {candidateDiffersFromBrowsing && data.candidate ? (
        <p className="mt-2 text-[12px] leading-5 text-[#52786c]">
          系统根据历史活动建议的候选社区是「{data.candidate.community.name}」，是否确认由你本人决定。
        </p>
      ) : null}

      {data.status === 'confirmed' && data.binding ? (
        <div className="mt-3 rounded-xl border border-[#cfe8de] bg-[#f0f8f4] p-3">
          <p className="text-[12px] font-semibold text-[#116d63]">
            确认日期：{formatResidentCommunityDate(data.binding.confirmedAt)}
          </p>
          <p className="mt-1 text-[11px] leading-5 text-[#52786c]">{PERMANENT_BINDING_NOTICE}</p>
        </div>
      ) : null}

      {data.status === 'conflict' && data.binding ? (
        <p className="mt-2 text-[12px] leading-5 text-[#934a35]">
          原常驻社区「{data.binding.community.name}」保持不变；如需纠正，请联系社区工作人员登记核查。
        </p>
      ) : null}

      {data.status === 'pending_review' ? (
        <p className="mt-2 text-[12px] leading-5 text-[#934a35]">
          核查完成前不会产生常驻社区，也不会随机选中其中一条历史记录。
        </p>
      ) : null}

      {data.status === 'unbound' && confirmHref && data.canConfirm ? (
        <>
          <Link to={confirmHref} state={{ from: '/me/community' }} className={`${primaryButton} mt-3`}>
            绑定为常驻社区
          </Link>
          <p className="mt-2 text-[11px] leading-5 text-[#5b6c67]">
            点击后还需要在确认页再次确认；{PERMANENT_BINDING_NOTICE}
          </p>
        </>
      ) : null}

      {data.status === 'unbound' && !confirmHref && data.canConfirm ? (
        <p className="mt-2 text-[12px] leading-5 text-[#52786c]">
          先到你要浏览的社区页面，再在那里由你本人确认常驻社区。
        </p>
      ) : null}

      {data.status === 'unbound' && loginHref ? (
        <Link to={loginHref} className={`${secondaryButton} mt-2`}>登录后绑定为常驻社区</Link>
      ) : null}
    </>,
  )
}

/** A one-line read-only permanent-community strip for the 我的/社区 headers. */
export function ResidentCommunityStrip({
  state,
  onReload,
}: {
  state: ResidentCommunityState
  onReload: () => void
}) {
  if (state.status === 'idle' || state.status === 'loading') {
    return <p className="text-[12px] leading-5 text-[#5b6c67]" role="status">正在读取常驻社区…</p>
  }
  if (state.status === 'unauthenticated') {
    return <p className="text-[12px] leading-5 text-[#5b6c67]">登录后可查看常驻社区。</p>
  }
  if (state.status === 'error') {
    return (
      <span className="text-[12px] leading-5 text-[#934a35]">
        常驻社区读取失败。
        <button type="button" onClick={onReload} className="ml-1 underline">重试</button>
      </span>
    )
  }
  const data = state.data
  if (data.status === 'confirmed' && data.binding) {
    return (
      <span className="text-[12px] leading-5 text-[#52786c]">
        常驻社区：{data.binding.community.name} · 确认于 {formatResidentCommunityDate(data.binding.confirmedAt)}
      </span>
    )
  }
  if (data.status === 'conflict') {
    return (
      <span className="inline-flex items-start gap-1 text-[12px] leading-5 text-[#934a35]">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
        常驻社区为「{data.binding?.community.name ?? '已确认社区'}」，与当前浏览社区不同；浏览不改变常驻社区。
      </span>
    )
  }
  if (data.status === 'pending_review') {
    return <span className="text-[12px] leading-5 text-[#934a35]">历史社区归属待核查，暂不能确认常驻社区。</span>
  }
  return <span className="text-[12px] leading-5 text-[#52786c]">尚未确认常驻社区。</span>
}
