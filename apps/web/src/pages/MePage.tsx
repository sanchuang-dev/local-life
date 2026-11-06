import { useState } from 'react'
import { ChevronRight, ClipboardList, Gift, LogOut, ShieldCheck, Smartphone, UserRound } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { DemoNote } from '../components/DemoNote'
import { PhoneVerificationForm } from '../components/auth/PhoneVerificationForm'
import { isWeChatBrowser } from '../components/auth/wechatEnvironment'
import { staffRoleLabels } from '../components/crm/crmLabels'
import { useActivityParticipation } from '../hooks/useActivityParticipation'
import { usePublicActivity } from '../hooks/usePublicActivity'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { useRewardWallet } from '../hooks/useRewardWallet'

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
  const [searchParams] = useSearchParams()
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

  const participationData = participation.state.status === 'ready' ? participation.state.data : null
  const joined = participationData?.participation ?? null
  const team = participationData?.team ?? null
  const rewardCount = wallet.state.status === 'ready' ? wallet.state.entries.length : null
  const activityHref = activity ? `/?activityId=${encodeURIComponent(activity.id)}` : '/'

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
              : '真实奖励条目',
      to: '/me/rewards',
      tone: 'mint' as const,
    },
  ]

  return (
    <div className="px-4 pb-7 pt-4">
      <article className="rounded-[22px] border border-slate-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3.5">
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#e8f6f0] text-[#388b77]"
            aria-hidden="true"
          >
            <UserRound size={28} strokeWidth={1.6} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-[19px] font-semibold tracking-tight text-slate-900">
              {auth.session?.user.displayName || '未登录'}
            </h1>
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

        {!auth.session && (
          <div className="mt-4 rounded-[16px] bg-[#f4f8f6] p-3.5">
            <p className="text-[13px] font-semibold text-slate-700">登录本地生活</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">
              登录后可使用与你的居民账户关联的活动和社区服务。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {auth.methods?.wechat && wechatBrowser && (
                <button
                  type="button"
                  onClick={auth.startWechatLogin}
                  className="min-h-10 rounded-full bg-[#138b79] px-4 text-[12px] font-semibold text-white transition-colors hover:bg-[#116d63]"
                >
                  微信授权登录
                </button>
              )}
              {auth.methods?.developmentResidentLogin && (
                <button
                  type="button"
                  disabled={auth.busy}
                  onClick={() => void auth.developmentLogin()}
                  className="min-h-10 rounded-full border border-teal-200 bg-white px-4 text-[12px] font-semibold text-teal-700 disabled:opacity-50"
                >
                  {auth.busy ? '登录中…' : '开发测试登录'}
                </button>
              )}
              {auth.methods && !auth.methods.wechat && !auth.methods.developmentResidentLogin && !auth.phoneStatus?.configured && (
                <span className="text-[11px] text-slate-500">微信网页授权尚未配置，当前无法登录。</span>
              )}
              {!auth.methods && !auth.loading && (
                <span className="text-[11px] text-slate-500">账户服务暂不可用，请稍后重试。</span>
              )}
            </div>
            {auth.phoneStatus ? (
              <PhoneVerificationForm
                purpose="login"
                configured={auth.phoneStatus.configured}
                title="手机号验证码登录"
                description="使用本人手机号验证登录。登录方式不改变已有活动与奖励归属。"
                submitLabel="手机号登录"
                onRequestCode={(phone) => auth.requestPhoneCode(phone, 'login')}
                onSubmit={(phone, code) => auth.loginWithPhone(phone, code)}
              />
            ) : null}
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
            <p className="mt-2 text-[11px] leading-4 text-slate-400">
              以上状态读取自真实服务，展示当前活动的报名与三人团
              {activity ? `（${activity.title}）` : ''}；其他活动的报名记录请在对应活动页查看。
              活动暂无发布时不会显示示例报名或虚构团队。
            </p>
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
            真实活动奖励 · 领取状态 · 核销凭据尾号
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

      <DemoNote tone="warn">
        本页只展示真实账户、当前活动的报名与三人团状态、以及我的奖励。积分、优惠券、订单、收藏、
        健康档案与地址管理等尚未接入真实服务的入口，已从本页移除示例资料与示例统计。
      </DemoNote>
    </div>
  )
}
