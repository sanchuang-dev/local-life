import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  parseActivityLoginResult, saveActivityLoginContext,
  wechatUnavailableMessage,
} from '../components/activity/loginReturn'
import { parseInviteParam } from '../components/activity/share'
import { isWeChatBrowser } from '../components/auth/wechatEnvironment'
import { PhoneVerificationForm } from '../components/auth/PhoneVerificationForm'
import { UnifiedLoginView } from '../components/auth/UnifiedLoginView'
import { OpenInWeChatPage } from './OpenInWeChatPage'
import {
  buildResidentWechatLoginRequest, resolveResidentLoginTarget,
} from '../components/auth/residentLogin'
import { useResidentAuth } from '../hooks/useResidentAuth'

/**
 * One real resident login entry for every guarded H5 route.
 * Design from Open Design; business state/WeChat state-machine/OTP remain the
 * repository's existing authority, not recreated in the presentation component.
 */
export function ResidentLoginPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const auth = useResidentAuth()
  const returnTo = resolveResidentLoginTarget(params.get('next'))
  const target = new URL(returnTo, window.location.origin)
  const activityId = params.get('activityId') || target.searchParams.get('activityId')
  const invite = parseInviteParam(params.get('invite') ?? target.searchParams.get('invite'))
  const inviteInvalid =
    params.get('inviteInvalid') === '1' ||
    target.searchParams.get('inviteInvalid') === '1' ||
    invite.invalid
  const authError = params.get('auth_error')
  const result = authError
    ? parseActivityLoginResult(new URLSearchParams({ auth_error: authError }).toString())
    : null
  const wechatBrowser = isWeChatBrowser(navigator.userAgent)
  const phoneAvailable = auth.phoneStatus?.configured === true

  useEffect(() => {
    if (auth.sessionStatus === 'authenticated' && auth.session && !auth.session.staff) {
      navigate(returnTo, { replace: true })
    }
  }, [auth.sessionStatus, auth.session, navigate, returnTo])

  function startWechatLogin() {
    if (!wechatBrowser || !auth.methods?.wechat || auth.busy) return
    const request = buildResidentWechatLoginRequest({
      returnTo,
      context: { activityId, inviteCode: invite.code, inviteInvalid },
      baseUrl: import.meta.env.BASE_URL,
      currentPathname: window.location.pathname,
    })
    saveActivityLoginContext(request.context)
    window.location.assign(request.url)
  }

  const state =
    auth.sessionStatus === 'error' || Boolean(auth.session?.staff) ? 'error' as const :
    auth.sessionStatus === 'authenticated' && auth.session && !auth.session.staff ? 'redirecting' as const :
    auth.sessionStatus === 'loading' || auth.methodsLoading ? 'loading' as const :
    'idle' as const

  const reason =
    auth.session?.staff ? '当前登录的是工作人员账户，请退出工作台会话后使用居民身份登录。' :
    result?.status === 'error' ? result.message :
    auth.error ? auth.error :
    auth.methods && !auth.methods.wechat && !phoneAvailable
      ? wechatUnavailableMessage(auth.methods.wechatUnavailableReason)
      : !auth.methods && !auth.methodsLoading ? '登录方式暂时无法读取，请刷新重试。' :
      null

  // Browser-only entry uses the new standalone visual; the existing WeChat
  // OAuth and phone flows remain unchanged inside WeChat.
  if (!wechatBrowser) {
    return (
      <OpenInWeChatPage
        developmentLogin={import.meta.env.DEV && auth.methods?.developmentResidentLogin ? {
          onLogin: () => void auth.developmentLogin(),
          busy: auth.busy,
          error: auth.error,
        } : undefined}
      />
    )
  }

  return (
    <UnifiedLoginView
      environment={wechatBrowser ? 'wechat' : 'browser'}
      state={state}
      wechatEnabled={auth.methods?.wechat === true}
      contextLabel={activityId ? '活动信息' : '原页面'}
      copyUrl={window.location.href}
      error={reason}
      onWechatLogin={startWechatLogin}
      onBack={window.history.length > 1 ? () => navigate(-1) : undefined}
      onRetry={() => window.location.reload()}
      onContinue={() => navigate(returnTo, { replace: true })}
      phoneForm={phoneAvailable ? (
        <PhoneVerificationForm
          purpose="login"
          configured={true}
          title="手机号验证码登录"
          description="使用本人手机号完成验证；登录后返回原页面。"
          submitLabel="手机号登录"
          onRequestCode={(phone) => auth.requestPhoneCode(phone, 'login')}
          onSubmit={(phone, code) => auth.loginWithPhone(phone, code)}
        />
      ) : undefined}
      extraActions={auth.methods?.developmentResidentLogin ? (
        <button
          type="button"
          onClick={() => void auth.developmentLogin()}
          disabled={auth.busy}
          className="mt-4 min-h-11 w-full rounded-xl border border-[#C9D8D2] bg-white px-4 text-[14px] text-[#116D63] disabled:opacity-60"
        >
          {auth.busy ? '登录中…' : '开发环境测试登录'}
        </button>
      ) : undefined}
    />
  )
}
