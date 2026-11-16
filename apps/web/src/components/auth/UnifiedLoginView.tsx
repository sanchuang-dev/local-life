import { useId, useState, type ReactNode } from 'react'
import {
  AlertCircle, Check, ChevronLeft, Copy, LoaderCircle,
  RefreshCw, ShieldCheck,
} from 'lucide-react'

/**
 * Resident login presentation. The authentication flow and callback semantics
 * are owned by ResidentLoginPage / ResidentAuthProvider, not this view.
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

const button = 'flex min-h-[50px] w-full items-center justify-center gap-2 rounded-xl bg-[#116D63] px-4 text-[16px] font-semibold text-white shadow-[0_10px_22px_rgba(17,109,99,.18)] transition-colors hover:bg-[#0D544C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#138B79] disabled:opacity-60'
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

function Card({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  return (
    <section className="mt-7 rounded-2xl border border-[#DDE7E3] bg-white p-5 shadow-[0_16px_38px_rgba(20,60,52,.07)] min-[360px]:p-6">
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
  const sceneUrl = `${import.meta.env.BASE_URL}images/wechat-gate-neighborhood.webp`

  return (
    <main className="relative isolate min-h-dvh overflow-hidden bg-[#FBFAF6] font-sans text-[#183D31]">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[390px] overflow-hidden" aria-hidden="true">
        <img
          src={sceneUrl}
          alt=""
          className="h-full w-full object-cover object-top opacity-70"
          style={{
            maskImage: 'linear-gradient(to bottom, black 0%, black 34%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 34%, transparent 100%)',
          }}
        />
      </div>

      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-[430px] flex-col px-5 pb-[calc(20px+env(safe-area-inset-bottom,0px))] pt-[calc(10px+env(safe-area-inset-top,0px))]">
        <header className="flex min-h-11 items-center">
          {onBack && (
            <button type="button" onClick={onBack} className={linkButton + ' -ml-3 gap-1 text-[#245F50]'}>
              <ChevronLeft size={20} aria-hidden="true" />返回
            </button>
          )}
        </header>

        {state !== 'idle' ? (
          <div className="flex flex-1 flex-col items-center justify-center py-10 text-center" role={state === 'error' ? 'alert' : 'status'}>
            <span className={'grid h-[68px] w-[68px] place-items-center rounded-3xl ' +
              (state === 'error' ? 'bg-[#FFF1EC] text-[#A6402A]' : 'bg-[#E8F6F0] text-[#116D63]')}>
              {state === 'error' ? <AlertCircle size={30}/> : state === 'redirecting' ? <Check size={30}/> : <LoaderCircle size={30} className="animate-spin"/>}
            </span>
            <h1 className="mt-5 text-[24px] font-semibold text-[#182420]">
              {state === 'error' ? '暂时无法登录' : state === 'redirecting' ? '正在进入本地生活' : '正在确认身份'}
            </h1>
            <p className="mt-3 max-w-[292px] text-[14px] leading-6 text-[#52625C]">
              {state === 'error' ? error || '请检查网络后重试，刚才的操作没有产生报名或订单。' :
                state === 'redirecting' ? '正在返回刚才浏览的页面，' + contextLabel + '已保留。' :
                '正在检查身份，请不要关闭当前页面。'}
            </p>
            {state === 'error' && <button type="button" className={button + ' mt-7'} onClick={onRetry}><RefreshCw size={18}/>重试</button>}
            {state === 'redirecting' && <button type="button" className={linkButton + ' mt-7'} onClick={onContinue}>如果没有自动跳转，点此继续</button>}
          </div>
        ) : (
          <>
            <section className="mt-[clamp(145px,23dvh,225px)] text-center">
              <p className="text-[12px] font-semibold tracking-[.16em] text-[#26856B]">家门口的好生活</p>
              <h1 className="mt-3 text-[clamp(26px,7.6vw,33px)] font-bold leading-[1.25] tracking-[-.035em] text-[#203E31]">
                欢迎来到<span className="text-[#167763]">本地生活</span>
              </h1>
              <p className="mt-4 text-[14px] leading-7 text-[#52675C]">
                社区活动 · 本地好物 · 居民福利
              </p>
            </section>

            {error && <div role="alert" className="mt-5 rounded-xl border border-[#F0D5BD] bg-[#FFF7F0] p-3 text-[13px] leading-5 text-[#7A4A2C]">{error}</div>}

            {phoneMode ? (
              <Card eyebrow="其他登录方式" title="手机号验证码登录">
                {phoneForm}
                {environment === 'wechat' && (
                  <button type="button" className={linkButton + ' mt-3 w-full'} onClick={() => setUsePhone(false)}>返回微信登录</button>
                )}
              </Card>
            ) : copyMode ? <CopyCard copyUrl={copyUrl}/> : (
              <section className="mt-7 rounded-2xl border border-white/90 bg-white/90 px-4 py-5 shadow-[0_12px_32px_rgba(47,86,65,.08)]">
                <button
                  type="button"
                  className={button}
                  disabled={!wechatEnabled}
                  onClick={onWechatLogin}
                >
                  进入本地生活
                </button>
                {!wechatEnabled && (
                  <p className="mt-3 text-[13px] leading-6 text-[#9A563B]" role="status">
                    微信授权暂不可用，请联系社区服务人员。
                  </p>
                )}
                <p className="mt-3 flex items-start justify-center gap-2 text-[12px] leading-5 text-[#66776F]">
                  <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[#16806C]" aria-hidden="true"/>
                  <span>通过微信确认身份，完成后返回原页面；不会自动报名或下单。</span>
                </p>
                {phoneForm && (
                  <button type="button" className={linkButton + ' mt-3 w-full'} onClick={() => setUsePhone(true)}>使用手机号登录</button>
                )}
              </section>
            )}
            {extraActions}
          </>
        )}

        <footer className="mt-auto pb-1 pt-7 text-center text-[12px] leading-5 text-[#75877D]">
          本地生活 · 发现身边的美好
        </footer>
      </div>
    </main>
  )
}
