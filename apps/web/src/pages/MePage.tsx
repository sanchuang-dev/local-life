import { useEffect, useState } from 'react'
import { ChevronRight, ClipboardList, Gift, LogOut, ShieldCheck, ShoppingBasket, Smartphone, UserRound } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { PhoneVerificationForm } from '../components/auth/PhoneVerificationForm'
import { isWeChatBrowser } from '../components/auth/wechatEnvironment'
import { buildResidentLoginHref } from '../components/auth/residentLogin'
import { parseInviteParam } from '../components/activity/share'
import { parseActivityLoginResult } from '../components/activity/loginReturn'
import { staffRoleLabels } from '../components/crm/crmLabels'
import { useActivityParticipation } from '../hooks/useActivityParticipation'
import { usePublicActivity } from '../hooks/usePublicActivity'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { useRewardWallet } from '../hooks/useRewardWallet'

const WECHAT_PROFILE_RESULT_MESSAGES: Record<string, string> = {
  success: '微信头像和昵称已同步。平台昵称不会被覆盖。',
  cancelled: '你已取消微信资料授权，当前登录状态不受影响。',
  authorization_failed: '微信资料授权未完成，当前登录状态不受影响。',
  state_invalid: '本次资料授权已过期或无效，请重新发起。',
  state_replayed: '本次资料授权已使用，请重新发起。',
  session_mismatch: '授权期间登录账户发生变化，未修改任何资料。请在当前账户重新发起。',
  identity_mismatch: '返回的微信身份与当前账户不匹配，未修改资料，也未绑定其他账户。',
  configuration_unavailable: '公众号配置当前不可用，请联系运营人员。',
  provider_unavailable: '微信资料服务暂时不可用，请稍后重试。',
}

const statTones = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  peach: 'bg-[#fff3e6] text-[#c6925c]',
} as const

/**
 * 我的 — the resident account page.
 *
 * Everything rendered here is real account state: the session identity (or an
 * explicit logged-out state), this activity's participation/team from the
 * participation API and the wallet entries from the team-reward API. The old
 * mock profile ("张阿姨"), demo stats (2680 points / 3 activities / 2 coupons),
 * example services and settings rows are no longer rendered; the resident
 * account, rewards and staff access remain.
 */
export function MePage() {
  const auth = useResidentAuth()
  const wechatBrowser = typeof navigator !== 'undefined' && isWeChatBrowser(navigator.userAgent)
  const [showBindForm, setShowBindForm] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const [profileNotice] = useState(() => {
    const result = searchParams.get('wechat_profile')
    return result ? WECHAT_PROFILE_RESULT_MESSAGES[result] ?? '微信资料授权流程已结束。' : null
  })
  useEffect(() => {
    if (!searchParams.has('wechat_profile')) return
    const next = new URLSearchParams(searchParams)
    next.delete('wechat_profile')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])
  // `?activityId=` lets a link open the account page already scoped to the
  // activity the resident came from; otherwise the currently published activity
  // of the public list is used. There is no cross-activity registration endpoint,
  // so the page never invents a list of "my activities".
  const requestedActivityId = searchParams.get('activityId')?.trim() || null
  const { state: activityState } = usePublicActivity(requestedActivityId)
  const activity = activityState.status === 'ready' ? activityState.activity : null
  const participation = useActivityParticipation({
    activityId: activity?.id ?? null,
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })
  const wallet = useRewardWallet({
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })

  const profileNickname =
    auth.wechatProfile?.available === true && auth.wechatProfile.authorized
      ? auth.wechatProfile.nickname
      : null
  const profileAvatarUrl =
    auth.wechatProfile?.available === true && auth.wechatProfile.authorized
      ? auth.wechatProfile.avatarUrl
      : null

  const participationData = participation.state.status === 'ready' ? participation.state.data : null
  const joined = participationData?.participation ?? null
  const team = participationData?.team ?? null
  const rewardCount = wallet.state.status === 'ready' ? wallet.state.entries.length : null
  const activityHref = activity ? `/?activityId=${encodeURIComponent(activity.id)}` : '/'
  const meReturnTo = '/me' + (searchParams.toString() ? '?' + searchParams.toString() : '')
  const inviteContext = parseInviteParam(searchParams.get('invite'))
  const loginResult = parseActivityLoginResult(searchParams.toString())
  const loginHref = buildResidentLoginHref(
    meReturnTo,
    {
      activityId: activity && requestedActivityId ? activity.id : null,
      inviteCode: inviteContext.code,
      inviteInvalid: inviteContext.invalid,
    },
    loginResult?.status === 'error' ? loginResult.code : null,
  )

  const stats = [
    {
      id: 'join',
      label: '当前活动报名',
      value:
        participation.state.status === 'error'
          ? '读取失败'
          : participation.state.status === 'unauthenticated'
            ? '登录失效'
            : participation.state.status === 'loading' || participation.state.status === 'idle'
              ? '读取中'
              : joined
              ? '已报名'
              : '未报名',
      hint: activity ? activity.title : '暂无已发布活动',
      to: activityHref,
      tone: 'mint' as const,
    },
    {
      id: 'team',
      label: '三人团',
      value:
        participation.state.status === 'error'
          ? '读取失败'
          : participation.state.status === 'unauthenticated'
            ? '登录失效'
            : participation.state.status === 'loading' || participation.state.status === 'idle'
              ? '读取中'
              : team
              ? `${team.seatsFilled}/${team.seatsTotal}`
              : '未成团',
      hint: team?.status === 'locked' ? '已成团' : '可在活动页邀请街坊',
      to: activityHref,
      tone: 'peach' as const,
    },
    {
      id: 'rewards',
      label: '我的奖励',
      value:
        wallet.state.status === 'error'
          ? '读取失败'
          : wallet.state.status === 'unauthenticated'
            ? '登录失效'
            : rewardCount === null
              ? '—'
              : String(rewardCount),
      hint:
        wallet.state.status === 'error'
          ? wallet.state.message
          : wallet.state.status === 'unauthenticated'
            ? '请重新登录'
            : rewardCount === null
              ? '读取中'
              : '奖励记录',
      to: '/me/rewards',
      tone: 'mint' as const,
    },
  ]

  return (
    <div className="px-4 pb-7 pt-4">
      <article className="rounded-[22px] border border-slate-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3.5">
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#e8f6f0] text-[#388b77]"
            aria-hidden="true"
          >
            {profileAvatarUrl ? (
              <img src={profileAvatarUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
            ) : (
              <UserRound size={28} strokeWidth={1.6} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-[19px] font-semibold tracking-tight text-slate-900">
              {auth.session?.user.displayName || '未登录'}
            </h1>
            {profileNickname && (
              <p className="mt-0.5 text-[11px] leading-4 text-slate-500">微信昵称：{profileNickname}</p>
            )}
            <p className="mt-0.5 text-[11px] leading-4 text-slate-400">
              {auth.session
                ? auth.session.staff
                  ? `${staffRoleLabels[auth.session.staff.role]} · 已登录`
                  : '居民账户 · 已登录'
                : '登录后查看你的活动、三人团与奖励'}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-[#fff3e6] px-2 py-1 text-[10px] font-medium text-[#a96b2f]">
            {auth.session ? '已登录' : '未登录'}
          </span>
        </div>

        {profileNotice && (
          <p role="status" className="mt-3 rounded-[12px] bg-[#f0f8f4] px-3 py-2 text-[12px] leading-5 text-[#327563]">
            {profileNotice}
          </p>
        )}

        {auth.session && !auth.session.staff && (
          <section className="mt-3 rounded-[16px] border border-slate-100 bg-white p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-slate-700">微信头像与昵称</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">
                  {auth.wechatProfile?.available === true
                    ? auth.wechatProfile.authorized
                      ? '已获得你的授权，可在这里更新微信资料。'
                      : '尚未授权。是否同步由你决定，不影响登录和其他账户功能。'
                    : auth.wechatProfile?.reason === 'identity_not_bound'
                      ? '当前账户未绑定此公众号微信身份，不能在这里自动绑定其他账户。'
                      : auth.wechatProfile?.reason === 'not_configured'
                        ? '公众号网页授权尚未配置，暂时无法同步资料。'
                        : auth.wechatProfile?.reason === 'configuration_unavailable'
                          ? '公众号配置暂不可用，请联系运营人员。'
                          : '正在读取微信资料授权状态…'}
                </p>
              </div>
              {auth.wechatProfile?.available === true && wechatBrowser && (
                <button
                  type="button"
                  disabled={auth.busy}
                  onClick={() => void auth.startWechatProfileAuthorization()}
                  className="min-h-9 shrink-0 rounded-full bg-[#138b79] px-3.5 text-[11px] font-semibold text-white transition-colors hover:bg-[#116d63] disabled:opacity-50"
                >
                  {auth.busy ? '正在发起…' : auth.wechatProfile.authorized ? '更新资料' : '授权同步'}
                </button>
              )}
            </div>
            {auth.wechatProfile?.available === true && !wechatBrowser && (
              <p className="mt-2 text-[11px] text-slate-400">请在微信内打开页面，再点击授权同步。</p>
            )}
            {auth.wechatProfileError && (
              <p role="alert" className="mt-2 text-[11px] leading-5 text-rose-600">{auth.wechatProfileError}</p>
            )}
          </section>
        )}

        {!auth.session && (
          <div className="mt-4 rounded-[16px] bg-[#f4f8f6] p-3.5">
            <p className="text-[13px] font-semibold text-slate-700">登录本地生活</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">
              登录后可查看与你的居民账户关联的活动、社区服务与奖励。
            </p>
            {loginResult?.status === 'error' ? (
              <p role="alert" className="mt-2 rounded-[12px] bg-[#fff1ee] px-3 py-2 text-[11px] leading-5 text-rose-700">
                {loginResult.message}
              </p>
            ) : null}
            <Link
              to={loginHref}
              className="mt-3 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[14px] bg-[#138b79] px-4 text-[13px] font-semibold text-white transition-colors hover:bg-[#116d63] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <ShieldCheck size={16} aria-hidden="true" />
              前往统一登录
            </Link>
            <p className="mt-2 text-[10px] leading-4 text-slate-400">
              支持微信授权；手机号验证码登录按服务配置开放。
            </p>
          </div>
        )}

        {auth.session && (
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[11px] text-slate-400">平台居民 ID：{auth.session.user.id.slice(0, 8)}…</span>
            <button
              type="button"
              disabled={auth.busy}
              onClick={() => void auth.logout()}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-slate-500 hover:bg-slate-50 disabled:opacity-50"
            >
              <LogOut size={14} />
              退出登录
            </button>
          </div>
        )}

        {auth.session && (
          <div className="mt-3 rounded-[14px] border border-slate-100 bg-white p-3.5">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-600">
              <Smartphone size={14} className="text-[#388b77]" aria-hidden="true" />
              手机号
            </p>
            {auth.phoneStatus?.maskedPhone ? (
              <p className="mt-1 text-[11px] leading-5 text-slate-500">
                已绑定 {auth.phoneStatus.maskedPhone}，用于登录同一个居民账户。
              </p>
            ) : !auth.phoneStatus ? (
              <p className="mt-1 text-[11px] leading-5 text-slate-500">手机号状态暂不可读取。</p>
            ) : !auth.phoneStatus.configured ? (
              <p className="mt-1 text-[11px] leading-5 text-slate-500">短信服务未启用，当前不可绑定。</p>
            ) : showBindForm ? (
              <PhoneVerificationForm
                purpose="bind"
                configured={true}
                title="绑定手机号"
                description="通过验证码确认本人手机号，不会自动合并或转移其他账户的记录。"
                submitLabel="确认绑定"
                onRequestCode={(phone) => auth.requestPhoneCode(phone, 'bind')}
                onSubmit={(phone, code) => auth.bindPhone(phone, code).then(() => undefined)}
                onSuccess={() => setShowBindForm(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setShowBindForm(true)}
                className="mt-2 min-h-10 rounded-full border border-teal-200 bg-white px-3 text-[12px] font-semibold text-teal-700"
              >
                绑定手机号
              </button>
            )}
          </div>
        )}

        {auth.error && (
          <p role="alert" className="mt-3 text-[11px] leading-5 text-rose-600">
            {auth.error}
          </p>
        )}

        {auth.loading && (
          <p className="mt-3 text-[11px] text-slate-400">正在读取账户状态…</p>
        )}

        {auth.session ? (
          <>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {stats.map((stat) => (
                <Link
                  key={stat.id}
                  to={stat.to}
                  state={{ from: '/me' }}
                  className={`flex min-h-[76px] min-w-0 flex-col items-center justify-center rounded-[16px] px-1 py-2 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${statTones[stat.tone]}`}
                >
                  <span className="text-[17px] font-semibold leading-none tracking-tight">
                    {stat.value}
                  </span>
                  <span className="mt-1.5 text-[11px] font-medium">{stat.label}</span>
                  <span className="mt-0.5 line-clamp-1 text-[9px] leading-3 opacity-70">
                    {stat.hint}
                  </span>
                </Link>
              ))}
            </div>
          </>
        ) : null}
      </article>

      <Link
        to="/me/rewards"
        state={{ from: '/me' }}
        className="mt-4 flex items-center gap-3 rounded-[18px] border border-slate-100 bg-white px-4 py-3.5 shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
      >
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#e8f6f0] text-[#388b77]"
          aria-hidden="true"
        >
          <Gift size={20} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-slate-800">我的奖励</span>
          <span className="mt-0.5 block truncate text-[11px] leading-4 text-slate-400">
            奖励记录 · 领取与核销状态
          </span>
        </span>
        <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
      </Link>

      <Link
        to="/me/orders"
        state={{ from: '/me' }}
        className="mt-4 flex items-center gap-3 rounded-[18px] border border-slate-100 bg-white px-4 py-3.5 shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
      >
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#fff3e6] text-[#c6925c]"
          aria-hidden="true"
        >
          <ShoppingBasket size={20} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-slate-800">我的订单</span>
          <span className="mt-0.5 block truncate text-[11px] leading-4 text-slate-400">
            本地商品登记记录 · 处理进度 · 运营人工核验结果
          </span>
        </span>
        <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
      </Link>

      {auth.session?.staff ? (
        <Link
          to="/workbench"
          state={{ from: '/me' }}
          className="mt-4 flex items-center gap-3 rounded-[18px] border border-teal-200/70 bg-[#eef7f2] px-4 py-3.5 transition-colors hover:bg-[#e5f3ec] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-white text-[#388b77]"
            aria-hidden="true"
          >
            <ClipboardList size={20} strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold text-slate-800">网格员工作台</span>
            <span className="mt-0.5 block truncate text-[11px] leading-4 text-[#52786c]">
              {staffRoleLabels[auth.session.staff.role]} ·{' '}
              {auth.session.staff.communities.map((item) => item.name).join('、') || '未分配社区'}
            </span>
          </span>
          <ChevronRight size={17} className="shrink-0 text-[#52786c]" aria-hidden="true" />
        </Link>
      ) : (
        <Link
          to="/workbench"
          state={{ from: '/me' }}
          className="mt-4 flex items-center gap-3 rounded-[18px] border border-slate-100 bg-white px-4 py-3.5 shadow-sm transition-colors hover:border-teal-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#f4f8f6] text-[#52786c]"
            aria-hidden="true"
          >
            <ShieldCheck size={20} strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold text-slate-800">工作人员入口</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">
              网格员使用工作台账号登录，居民账户不会自动获得工作人员权限
            </span>
          </span>
          <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
        </Link>
      )}

    </div>
  )
}
