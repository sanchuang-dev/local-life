import { useState } from 'react'
import { ChevronRight, ClipboardList, Gift, LogOut, Smartphone, UserRound } from 'lucide-react'
import { Link } from 'react-router'
import { DemoNote } from '../components/DemoNote'
import { PendingNotice } from '../components/PendingNotice'
import { PhoneVerificationForm } from '../components/auth/PhoneVerificationForm'
import { SectionHeading } from '../components/home/SectionHeading'
import { staffRoleLabels } from '../components/crm/crmLabels'
import { usePendingNotice } from '../hooks/usePendingNotice'
import { useResidentAuth } from '../hooks/useResidentAuth'
import {
  meDemoNote,
  meProfile,
  meServices,
  meSettings,
  meStats,
  type MeServiceItem,
} from '../mocks/me'

const toneStyles = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  peach: 'bg-[#fff3e6] text-[#c6925c]',
} as const

function ServiceRow({
  item,
  onPending,
}: {
  item: MeServiceItem
  onPending: (notice: string) => void
}) {
  const Icon = item.icon
  const content = (
    <>
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${toneStyles[item.tone]}`}
        aria-hidden="true"
      >
        <Icon size={18} strokeWidth={1.7} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-slate-700">{item.label}</span>
        {item.meta ? (
          <span className="mt-0.5 block text-[11px] leading-4 text-slate-400">{item.meta}</span>
        ) : null}
      </span>
      {item.to ? (
        <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden="true" />
      ) : (
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-400">
          演示
        </span>
      )}
    </>
  )

  if (item.to) {
    return (
      <Link
        to={item.to}
        state={{ from: '/me' }}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600"
      >
        {content}
      </Link>
    )
  }

  return (
    <button
      type="button"
      onClick={() => item.pendingNotice && onPending(item.pendingNotice)}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600"
    >
      {content}
    </button>
  )
}

export function MePage() {
  const { message, show, dismiss } = usePendingNotice()
  const auth = useResidentAuth()
  const [showBindForm, setShowBindForm] = useState(false)

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
            <h1 className="text-[19px] font-semibold tracking-tight text-slate-900">
              {auth.session?.user.displayName || meProfile.name}
            </h1>
            <p className="mt-0.5 text-[11px] leading-4 text-slate-400">
              {auth.session ? '居民账户 · 已登录' : meProfile.community}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-[#fff3e6] px-2 py-1 text-[10px] font-medium text-[#a96b2f]">
            {auth.session ? '已登录' : meProfile.tag}
          </span>
        </div>

        {!auth.session && (
          <div className="mt-4 rounded-[16px] bg-[#f4f8f6] p-3.5">
            <p className="text-[13px] font-semibold text-slate-700">登录本地生活</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">
              登录后可使用与你的居民账户关联的活动和社区服务。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {auth.methods?.wechat && (
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
            </div>

            {auth.phoneStatus ? (
              <PhoneVerificationForm
                purpose="login"
                configured={auth.phoneStatus.configured}
                title="手机号验证码登录"
                description="用本人手机号接收一次性验证码登录。同一手机号始终对应同一个居民账户，活动报名与奖励归属不会因登录方式改变而丢失。"
                submitLabel="手机号登录"
                onRequestCode={(phone) => auth.requestPhoneCode(phone, 'login')}
                onSubmit={(phone, code) => auth.loginWithPhone(phone, code)}
              />
            ) : null}

            {auth.methods &&
              !auth.methods.wechat &&
              !auth.methods.developmentResidentLogin &&
              !auth.phoneStatus?.configured && (
                <span className="mt-2 block text-[11px] text-slate-500">
                  当前没有可用的登录方式，请联系社区运营人员。
                </span>
              )}
            {!auth.methods && !auth.loading && (
              <span className="mt-2 block text-[11px] text-slate-500">
                账户服务暂不可用，请稍后重试。
              </span>
            )}
          </div>
        )}

        {auth.session && (
          <>
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

            <div className="mt-3 rounded-[14px] border border-slate-100 bg-white p-3.5">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-600">
                <Smartphone size={14} className="text-[#388b77]" aria-hidden="true" />
                手机号
              </p>
              {auth.phoneStatus?.maskedPhone ? (
                <p className="mt-1 text-[11px] leading-5 text-slate-500">
                  已绑定 {auth.phoneStatus.maskedPhone}。手机号只用于身份核验，不会公开展示。
                </p>
              ) : auth.phoneStatus ? (
                showBindForm ? (
                  <PhoneVerificationForm
                    purpose="bind"
                    configured={auth.phoneStatus.configured}
                    title="绑定手机号"
                    description="验证本人手机号后，可用手机号登录同一个居民账户；既有报名与奖励归属保持不变。"
                    submitLabel="绑定手机号"
                    onRequestCode={(phone) => auth.requestPhoneCode(phone, 'bind')}
                    onSubmit={(phone, code) => auth.bindPhone(phone, code).then(() => undefined)}
                    onSuccess={() => setShowBindForm(false)}
                  />
                ) : auth.phoneStatus.configured ? (
                  <div className="mt-1.5">
                    <p className="text-[11px] leading-5 text-slate-500">
                      当前账户尚未绑定手机号。
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowBindForm(true)}
                      className="mt-2 min-h-9 rounded-full border border-teal-200 bg-white px-3 text-[12px] font-semibold text-teal-700"
                    >
                      绑定手机号
                    </button>
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] leading-5 text-slate-500">
                    短信服务未配置，暂不支持手机号绑定。
                  </p>
                )
              ) : (
                <p className="mt-1 text-[11px] leading-5 text-slate-500">手机号状态暂不可用。</p>
              )}
            </div>
          </>
        )}

        {auth.error && (
          <p role="alert" className="mt-3 text-[11px] leading-5 text-rose-600">
            {auth.error}
          </p>
        )}

        {auth.loading && (
          <p className="mt-3 text-[11px] text-slate-400">正在读取账户状态…</p>
        )}

        <div className="mt-4 grid grid-cols-3 gap-2">
          {meStats.map((stat) => {
            const className = `flex min-h-[72px] min-w-0 flex-col items-center justify-center rounded-[16px] px-1 py-2 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 ${toneStyles[stat.tone]}`
            const content = (
              <>
                <span className="text-[22px] font-semibold leading-none tracking-tight">
                  {stat.value}
                </span>
                <span className="mt-1.5 text-[11px] font-medium">{stat.label}</span>
              </>
            )

            return stat.to ? (
              <Link key={stat.id} to={stat.to} state={{ from: '/me' }} className={className}>
                {content}
              </Link>
            ) : (
              <button
                key={stat.id}
                type="button"
                onClick={() => stat.pendingNotice && show(stat.pendingNotice)}
                className={className}
              >
                {content}
              </button>
            )
          })}
        </div>
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
      ) : null}

      <DemoNote>{meDemoNote}</DemoNote>

      <section className="mt-6">
        <SectionHeading title="我的服务" note="示例数据" />
        <div className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {meServices.map((item, index) => (
            <div key={item.id} className={index > 0 ? 'border-t border-slate-100' : ''}>
              <ServiceRow item={item} onPending={show} />
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <SectionHeading title="设置与帮助" note="部分待接入" />
        <div className="overflow-hidden rounded-[18px] border border-slate-100 bg-white shadow-sm">
          {meSettings.map((item, index) => (
            <div key={item.id} className={index > 0 ? 'border-t border-slate-100' : ''}>
              <ServiceRow item={item} onPending={show} />
            </div>
          ))}
        </div>
      </section>

      <div className="mt-6">
        <DemoNote tone="warn">
          当前仅居民身份接入真实账户系统；积分、活动、优惠券、订单、收藏与客服仍是演示占位，不产生真实交易或履约记录。
        </DemoNote>
      </div>

      <PendingNotice message={message} onDismiss={dismiss} />
    </div>
  )
}
