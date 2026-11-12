import { useId, useState, type ReactNode } from 'react'
import {
  AlertCircle, Check, ChevronLeft, Copy, LoaderCircle,
  RefreshCw, ShieldCheck,
} from 'lucide-react'

/**
 * Production adaptation of react-LoginPage(1).zip (Open Design).
 * Keep its hierarchy, color, dimensions and copy, while leaving credentials,
 * login methods and callback semantics to the existing ResidentAuthProvider.
 */
export interface UnifiedLoginViewProps {
  environment: 'wechat' | 'browser'
  state: 'idle' | 'loading' | 'redirecting' | 'error'
  wechatEnabled: boolean
  phoneForm?: ReactNode
  contextLabel: string
  error?: string | null
  extraActions?: ReactNode
  onWechatLogin: () => void
  onBack?: () => void
  onRetry: () => void
  onContinue: () => void
  copyUrl: string
}

const button = 'flex min-h-[50px] w-full items-center justify-center gap-2 rounded-[14px] bg-[#116D63] px-4 text-[16px] font-semibold text-white shadow-[0_10px_22px_rgba(17,109,99,.18)] transition-colors hover:bg-[#0D544C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#138B79] disabled:opacity-60'
const linkButton = 'inline-flex min-h-11 items-center justify-center rounded-xl px-3 text-[14px] font-semibold text-[#116D63] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#138B79]'

function WechatIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.6 4.4C6.7 4.4 3.5 6.9 3.5 10.2c0 1.9 1 3.5 2.6 4.6l-.6 2.1 2.4-1.2c.7.2 1.4.3 2.2.3"/>
      <path d="M20.5 13.5c0-2.6-2.4-4.7-5.4-4.7s-5.4 2.1-5.4 4.7 2.4 4.7 5.4 4.7c.7 0 1.4-.1 2-.3l2.1 1-.5-1.8c1.1-.9 1.8-2.2 1.8-3.6Z"/>
    </svg>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-[13px] bg-[#116D63] text-white shadow-[0_6px_14px_rgba(17,109,99,.14)]">
        <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4.5 11.2 12 5l7.5 6.2M6.8 10.4V19h10.4v-8.6M10.2 19v-4.1a1.8 1.8 0 0 1 3.6 0V19"/>
        </svg>
      </span>
      <div>
        <p className="text-[18px] font-semibold leading-6 text-[#182420]">本地生活</p>
        <p className="text-[12px] leading-5 text-[#5D6C66]">社区生活服务入口</p>
      </div>
    </div>
  )
}

function Card({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  return (
    <section className="mt-7 rounded-[20px] border border-[#DDE7E3] bg-white p-5 shadow-[0_16px_38px_rgba(20,60,52,.07)] min-[360px]:p-6">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#E8F6F0] text-[#116D63]">
          <WechatIcon/>
        </span>
        <div>
          <p className="text-[11px] font-semibold tracking-[.09em] text-[#5D6C66]">{eyebrow}</p>
          <h2 className="mt-1 text-[18px] font-semibold leading-6 text-[#182420]">{title}</h2>
        </div>
      </div>
      {children}
    </section>
  )
}

async function copyText(value: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(value); return true } catch { /* fallback */ }
  }
  const input = document.createElement('textarea')
  input.value = value
  input.readOnly = true
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  let success = false
  try { success = document.execCommand('copy') } catch { /* manual fallback */ }
  input.remove()
  return success
}

function CopyCard({ copyUrl }: { copyUrl: string }) {
  const [copyStatus, setCopyStatus] = useState<'idle'|'copied'|'error'>('idle')
  const inputId = useId()
  return (
    <Card eyebrow="当前环境" title="复制链接，在微信中打开">
      <ol className="mt-4 space-y-3 text-[14px] leading-6 text-[#3B4C46]">
        <li><span className="mr-2 inline-grid h-[22px] w-[22px] place-items-center rounded-full bg-[#E8F6F0] text-[11px] text-[#116D63]">1</span>点击下方按钮复制本页链接</li>
        <li><span className="mr-2 inline-grid h-[22px] w-[22px] place-items-center rounded-full bg-[#E8F6F0] text-[11px] text-[#116D63]">2</span>打开微信，把链接粘贴到聊天窗口</li>
      </ol>
      <button type="button" className={button + ' mt-5'} onClick={() => {
        void copyText(copyUrl).then((ok) => setCopyStatus(ok ? 'copied' : 'error'))
      }}><Copy size={19}/>复制本页链接</button>
      {copyStatus === 'copied' && <p className="mt-3 flex gap-1.5 text-[13px] text-[#116D63]" role="status"><Check size={16}/>链接已复制，请打开微信粘贴访问。</p>}
      {copyStatus === 'error' && (
        <div className="mt-3 rounded-xl bg-[#F5F7F7] p-3">
          <label htmlFor={inputId} className="text-[12px] text-[#52625C]">无法自动复制，请长按选中链接</label>
          <input id={inputId} readOnly value={copyUrl} onFocus={(e) => e.currentTarget.select()}
            className="mt-2 min-h-11 w-full rounded-lg border border-[#C9D8D2] bg-white p-2 text-[12px]" />
        </div>
      )}
      <p className="mt-4 flex gap-1.5 text-[13px] leading-5 text-[#5D6C66]"><ShieldCheck size={16} className="shrink-0 text-[#138B79]"/>微信内打开后可继续登录，原页面地址会保留。</p>
    </Card>
  )
}

export function UnifiedLoginView({
  environment, state, wechatEnabled, phoneForm, contextLabel, error,
  onWechatLogin, onBack, onRetry, onContinue, copyUrl, extraActions,
}: UnifiedLoginViewProps) {
  const [usePhone, setUsePhone] = useState(false)
  const phoneMode = Boolean(phoneForm) && (environment === 'browser' || usePhone)
  const copyMode = environment === 'browser' && !phoneMode
  const title = phoneMode ? <>使用手机号<span className="text-[#116D63]">登录</span></>
    : copyMode ? <>在微信里<span className="text-[#116D63]">继续</span></>
    : <>欢迎回到<span className="text-[#116D63]">本地生活</span></>
  return (
    <div className="relative isolate min-h-[calc(100dvh-env(safe-area-inset-top,0px))] w-full bg-[#F5F7F7] font-sans text-[#182420]">
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
        <span className="absolute right-[-78px] top-[-102px] h-[238px] w-[238px] rounded-full border border-[rgba(19,139,121,.14)]"/>
        <span className="absolute right-[-48px] top-[-72px] h-[178px] w-[178px] rounded-full border border-[rgba(19,139,121,.08)]"/>
      </div>
      <div className="relative z-10 mx-auto flex min-h-[calc(100dvh-env(safe-area-inset-top,0px))] max-w-[375px] flex-col px-5 pb-[calc(16px+env(safe-area-inset-bottom,0px))] min-[360px]:px-6">
        <header className="flex min-h-16 items-center py-2.5">
          {onBack && <button type="button" onClick={onBack} className={linkButton + ' -ml-3 text-[#3B4C46]'}>
            <ChevronLeft size={20}/>返回
          </button>}
        </header>
        <Brand />
        {state !== 'idle' ? (
          <div className="flex flex-1 flex-col items-center justify-center py-10 text-center" role={state === 'error' ? 'alert' : 'status'}>
            <span className={'grid h-[68px] w-[68px] place-items-center rounded-[22px] ' +
              (state === 'error' ? 'bg-[#FFF1EC] text-[#A6402A]' : 'bg-[#E8F6F0] text-[#116D63]')}>
              {state === 'error' ? <AlertCircle size={30}/> : state === 'redirecting' ? <Check size={30}/> : <LoaderCircle size={30} className="animate-spin"/>}
            </span>
            <p className="mt-6 text-[12px] font-semibold tracking-[.12em] text-[#116D63]">{state === 'error' ? '登录未完成' : state === 'redirecting' ? '身份已确认' : '安全登录'}</p>
            <h1 className="mt-2 text-[24px] font-semibold text-[#182420]">{state === 'error' ? '服务暂时不可用' : state === 'redirecting' ? '已登录，正在返回' : '正在验证登录'}</h1>
            <p className="mt-3 max-w-[292px] text-[15px] leading-7 text-[#52625C]">
              {state === 'error' ? error || '请检查网络后重试，刚才的操作没有产生报名或订单。' :
                state === 'redirecting' ? '正在回到你刚才浏览的页面，' + contextLabel + '已保留。' :
                '正在检查身份，请不要关闭当前页面。'}
            </p>
            {state === 'error' && <button type="button" className={button + ' mt-7'} onClick={onRetry}><RefreshCw size={18}/>重试</button>}
            {state === 'redirecting' && <button type="button" className={linkButton + ' mt-7'} onClick={onContinue}>如果没有自动跳转，点此继续</button>}
          </div>
        ) : (
          <>
            <section className="mt-7 min-[360px]:mt-9">
              <p className="flex items-center gap-2 text-[12px] font-semibold tracking-[.14em] text-[#116D63]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#138B79]"/>{phoneMode ? '手机号登录' : copyMode ? '普通手机浏览器' : '欢迎回来'}
              </p>
              <h1 className="mt-2 text-[28px] font-semibold leading-[1.28] tracking-[-.035em] text-[#182420] min-[360px]:text-[32px]">{title}</h1>
              <p className="mt-2.5 text-[16px] leading-[1.7] text-[#52625C]">
                {phoneMode ? '验证码会发送到你的手机，仅用于本次身份确认。' :
                  copyMode ? '复制本页链接，在微信中打开，就能使用快捷登录。' :
                  '登录后可参与社区活动、查看订单和福利。'}
              </p>
              {!phoneMode && <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[14px] text-[#3B4C46]">
                {['社区活动','我的订单','居民福利'].map(x=><li key={x} className="before:mr-2 before:inline-block before:h-1.5 before:w-1.5 before:rounded-full before:bg-[#138B79]">{x}</li>)}
              </ul>}
            </section>
            {error && <div role="alert" className="mt-4 rounded-xl border border-[#F0D5BD] bg-[#FFF7F0] p-3 text-[13px] leading-5 text-[#7A4A2C]">{error}</div>}
            {phoneMode ? (
              <Card eyebrow="当前可用方式" title="手机号验证码登录">
                {phoneForm}
                {environment === 'wechat' && <button type="button" className={linkButton + ' mt-3 w-full'} onClick={()=>setUsePhone(false)}>使用微信快捷登录</button>}
              </Card>
            ) : copyMode ? <CopyCard copyUrl={copyUrl}/> : (
              <Card eyebrow="推荐登录方式" title="微信快捷登录">
                <p className="mt-3 text-[14px] leading-6 text-[#52625C]">无需输入密码，授权完成后自动回到当前页面。</p>
                <button type="button" className={button + ' mt-5'} disabled={!wechatEnabled} onClick={onWechatLogin}><WechatIcon/>微信快捷登录</button>
                {!wechatEnabled && <p className="mt-3 text-[13px] leading-6 text-[#9A563B]">微信登录暂不可用，请联系管理员检查公众号配置。</p>}
                <p className="mt-4 flex items-center gap-2 text-[13px] text-[#5D6C66]"><ShieldCheck size={16} className="text-[#138B79]"/>仅用于身份确认，不会自动报名或下单。</p>
                {phoneForm && <div className="mt-4 border-t border-[#DDE7E3] pt-3">
                  <button type="button" className={linkButton + ' w-full'} onClick={()=>setUsePhone(true)}>手机号验证码登录 →</button>
                </div>}
              </Card>
            )}
            {extraActions}
          </>
        )}
        <footer className="mt-auto pb-2 pt-6 text-center text-[12px] leading-5 text-[#5D6C66]">
          <ShieldCheck size={14} className="mr-1 inline text-[#138B79]" aria-hidden="true"/>
          社区服务中心 · 安全连接
        </footer>
      </div>
    </div>
  )
}

