import { useState } from 'react'
import { Check, ClipboardPaste, Copy, Link2, MessagesSquare } from 'lucide-react'
import './OpenInWeChatPage.css'

type CopyState = 'idle' | 'copied' | 'manual'

type DevelopmentLogin = {
  onLogin: () => void
  busy: boolean
  error: string | null
}

/** Standalone external-browser entrance; no fake "open WeChat" deep link. */
export function OpenInWeChatPage({ developmentLogin }: { developmentLogin?: DevelopmentLogin }) {
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const currentUrl = window.location.href

  async function copyCurrentUrl() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(currentUrl)
      setCopyState('copied')
      return
    } catch {
      // Clipboard API can fail on non-secure origins and older mobile browsers.
      const textarea = document.createElement('textarea')
      textarea.value = currentUrl
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        if (!document.execCommand('copy')) throw new Error('Copy not available')
        setCopyState('copied')
      } catch {
        setCopyState('manual')
      } finally {
        textarea.remove()
      }
    }
  }

  return (
    <main className="wechat-open" aria-labelledby="wechat-open-title">
      <div className="wechat-open__scenery" aria-hidden="true">
        <img src={`${import.meta.env.BASE_URL}images/wechat-gate-neighborhood.webp`} alt="" />
      </div>
      <div className="wechat-open__body">
        <img
          className="wechat-open__envelope"
          src={`${import.meta.env.BASE_URL}images/wechat-gate-envelope.webp`}
          alt=""
          aria-hidden="true"
        />
        <div className="wechat-open__heading">
          <span className="wechat-open__eyebrow">在微信里，发现附近的美好</span>
          <h1 id="wechat-open-title">请在微信内打开</h1>
          <p>为了顺利登录和使用本地生活服务，<br className="wechat-open__desktop-break" />请复制链接，在微信中继续访问。</p>
        </div>

        <button
          className="wechat-open__copy-button"
          type="button"
          onClick={() => void copyCurrentUrl()}
        >
          {copyState === 'copied' ? <Check size={22} strokeWidth={2.6} aria-hidden="true" /> : <Copy size={22} strokeWidth={2.4} aria-hidden="true" />}
          {copyState === 'copied' ? '已复制当前地址' : '复制当前地址'}
        </button>
        <div className="wechat-open__feedback" role="status" aria-live="polite">
          {copyState === 'copied' ? '复制成功，打开微信粘贴链接就好啦' : copyState === 'manual' ? '复制未成功，请长按下方地址手动复制' : ' '}
        </div>
        {copyState === 'manual' && (
          <input
            className="wechat-open__manual-url"
            type="text"
            readOnly
            aria-label="当前页面地址，长按复制"
            value={currentUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}

        <section className="wechat-open__help" aria-labelledby="wechat-open-help-title">
          <h2 id="wechat-open-help-title">如何在微信中打开？</h2>
          <ol className="wechat-open__steps">
            <li>
              <div className="wechat-open__step-icon"><Link2 size={27} strokeWidth={2} aria-hidden="true" /></div>
              <span>复制链接</span>
            </li>
            <li>
              <div className="wechat-open__step-icon"><MessagesSquare size={27} strokeWidth={2} aria-hidden="true" /></div>
              <span>打开微信</span>
            </li>
            <li>
              <div className="wechat-open__step-icon"><ClipboardPaste size={27} strokeWidth={2} aria-hidden="true" /></div>
              <span>粘贴并打开</span>
            </li>
          </ol>
        </section>
        <p className="wechat-open__footnote">复制后可发送给自己，再在微信聊天中点开。</p>
        {developmentLogin && (
          <div className="wechat-open__dev-entry">
            <button type="button" onClick={developmentLogin.onLogin} disabled={developmentLogin.busy}>
              {developmentLogin.busy ? '测试登录中…' : '开发环境测试登录'}
            </button>
            {developmentLogin.error && <p role="alert">{developmentLogin.error}</p>}
          </div>
        )}
      </div>
    </main>
  )
}
