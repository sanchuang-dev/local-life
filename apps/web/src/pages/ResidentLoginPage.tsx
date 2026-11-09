import { useEffect } from 'react'
import { ArrowLeft, MessageCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { PhoneVerificationForm } from '../components/auth/PhoneVerificationForm'
import { isWeChatBrowser } from '../components/auth/wechatEnvironment'
import {
  parseActivityLoginResult,
  saveActivityLoginContext,
  wechatUnavailableMessage,
} from '../components/activity/loginReturn'
import { parseInviteParam } from '../components/activity/share'
import {
  buildResidentWechatLoginRequest,
  resolveResidentLoginTarget,
} from '../components/auth/residentLogin'
import { useResidentAuth } from '../hooks/useResidentAuth'

export function ResidentLoginPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const auth = useResidentAuth()
  const returnTo = resolveResidentLoginTarget(searchParams.get('next'))
  const target = new URL(returnTo, window.location.origin)
  const activityId = searchParams.get('activityId') || target.searchParams.get('activityId')
  const invite = parseInviteParam(searchParams.get('invite') ?? target.searchParams.get('invite'))
  const inviteInvalid =
    searchParams.get('inviteInvalid') === '1' ||
    target.searchParams.get('inviteInvalid') === '1' ||
    invite.invalid
  const authError = searchParams.get('auth_error')
  const loginResult = authError
    ? parseActivityLoginResult(new URLSearchParams({ auth_error: authError }).toString())
    : null
  const wechatBrowser =
    typeof navigator !== 'undefined' && isWeChatBrowser(navigator.userAgent)

  useEffect(() => {
    if (!auth.loading && auth.session) {
      navigate(returnTo, { replace: true })
    }
  }, [auth.loading, auth.session, navigate, returnTo])

  const startWechatLogin = () => {
    if (!wechatBrowser || !auth.methods?.wechat) return
    const request = buildResidentWechatLoginRequest({
      returnTo,
      context: {
        activityId,
        inviteCode: invite.code,
        inviteInvalid,
      },
      baseUrl: import.meta.env.BASE_URL,
      currentPathname: window.location.pathname,
    })
    saveActivityLoginContext(request.context)
    window.location.assign(request.url)
  }

  return (
    <div className="flex min-h-[calc(100dvh-env(safe-area-inset-top,0px))] items-center justify-center px-4 py-8">
      <div className="w-full max-w-[400px]">
        <Link
          to={returnTo}
          className="mb-5 inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-2 text-[12px] font-medium text-slate-500 transition-colors hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <ArrowLeft size={15} aria-hidden="true" />
          返回原页面
        </Link>

        <header className="mb-5 flex items-center gap-3 px-1">
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] bg-[#e8f6f0] text-[#247963]"
            aria-hidden="true"
          >
            <ShieldCheck size={25} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className="text-[19px] font-bold tracking-tight text-slate-900">本地生活</p>
            <p className="mt-0.5 text-[11px] leading-4 text-slate-500">社区服务 · 邻里互助</p>
          </div>
        </header>

        <section className="rounded-[22px] border border-slate-100 bg-white p-5 shadow-sm">
          <h1 className="text-[21px] font-bold tracking-tight text-slate-900">欢迎登录</h1>
          <p className="mt-1 text-[12px] leading-5 text-slate-500">
            登录后查看你的活动、三人团与社区服务。
          </p>

          {loginResult?.status === 'error' ? (
            <div
              role="alert"
              className="mt-4 rounded-[14px] bg-[#fff1ee] px-3.5 py-3 text-[12px] leading-5 text-rose-700"
            >
              {loginResult.message}
            </div>
          ) : null}

          {auth.loading ? (
            <p className="mt-4 flex items-center gap-2 text-[12px] text-slate-500" role="status">
              <span
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-teal-700/25 border-t-teal-700"
                aria-hidden="true"
              />
              正在读取账户状态…
            </p>
          ) : auth.session ? (
            <p className="mt-4 rounded-[12px] bg-[#eef7f2] px-3 py-2.5 text-[12px] text-[#1f6b51]" role="status">
              已登录，正在返回原页面…
            </p>
          ) : (
            <>
              {auth.methods?.wechat && wechatBrowser ? (
                <button
                  type="button"
                  onClick={startWechatLogin}
                  className="mt-4 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[14px] bg-[#138b79] px-4 text-[14px] font-bold text-white transition-colors hover:bg-[#116d63] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                >
                  <MessageCircle size={17} aria-hidden="true" />
                  微信授权登录
                </button>
              ) : null}

              {auth.methods?.wechat && !wechatBrowser ? (
                <p className="mt-4 rounded-[12px] bg-[#f4f8f6] px-3.5 py-3 text-[12px] leading-5 text-[#52786c]" role="status">
                  微信授权需要在微信内置浏览器中完成。
                  {auth.phoneStatusLoading
                    ? '正在检查手机号登录能力。'
                    : auth.phoneStatus?.configured
                      ? '也可以使用下方手机号方式登录。'
                      : auth.phoneStatus
                        ? '手机号短信服务尚未启用。'
                        : '手机号登录状态暂不可读取。'}
                </p>
              ) : null}

              {auth.methods && !auth.methods.wechat ? (
                <p className="mt-4 rounded-[12px] bg-slate-50 px-3.5 py-3 text-[12px] leading-5 text-slate-500">
                  {wechatUnavailableMessage(auth.methods.wechatUnavailableReason)}
                </p>
              ) : null}

              {!auth.methods && !auth.loading ? (
                <div role="alert" className="mt-4 rounded-[12px] bg-[#fff7f0] px-3.5 py-3 text-[12px] leading-5 text-[#7a4a2c]">
                  <p>{auth.error || '暂时无法读取登录方式，请稍后重试。'}</p>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-[#7a4a2c] px-3.5 text-[11px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    重新读取
                  </button>
                </div>
              ) : null}

              <div className="mt-4 border-t border-slate-100 pt-4">
                {auth.phoneStatusLoading ? (
                  <p className="text-[12px] leading-5 text-slate-400" role="status">
                    正在读取手机号验证码登录状态…
                  </p>
                ) : auth.phoneStatus ? (
                  <PhoneVerificationForm
                    purpose="login"
                    configured={auth.phoneStatus.configured}
                    title="手机号验证码登录"
                    description="使用本人手机号完成验证；登录后仍使用同一个居民账户。"
                    submitLabel="手机号登录"
                    onRequestCode={(phone) => auth.requestPhoneCode(phone, 'login')}
                    onSubmit={(phone, code) => auth.loginWithPhone(phone, code)}
                  />
                ) : (
                  <div className="rounded-[12px] bg-slate-50 px-3 py-2.5 text-[11px] leading-5 text-slate-500">
                    <p className="font-semibold text-slate-600">手机号验证码登录</p>
                    <p className="mt-1">暂时无法读取手机号登录状态。</p>
                    <button
                      type="button"
                      onClick={() => void auth.refreshPhoneStatus()}
                      className="mt-1 inline-flex min-h-[44px] items-center gap-1 rounded-full px-2 font-semibold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                    >
                      <RefreshCw size={12} aria-hidden="true" />
                      重试
                    </button>
                  </div>
                )}
              </div>

              {auth.methods?.developmentResidentLogin ? (
                <button
                  type="button"
                  disabled={auth.busy}
                  onClick={() => void auth.developmentLogin()}
                  className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-[12px] border border-teal-200 bg-white px-4 text-[12px] font-semibold text-teal-700 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
                >
                  {auth.busy ? '登录中…' : '开发测试登录'}
                </button>
              ) : null}

              {auth.error && auth.methods ? (
                <p role="alert" className="mt-3 break-words text-[11px] leading-5 text-rose-600">
                  {auth.error}
                </p>
              ) : null}
            </>
          )}

          <p className="mt-4 flex items-start gap-1.5 text-[10px] leading-4 text-slate-400">
            <ShieldCheck size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              登录只建立居民身份。活动报名、接受邀请和订单提交仍需你主动确认。
            </span>
          </p>
        </section>

      </div>
    </div>
  )
}
