import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ShieldCheck, Smartphone } from 'lucide-react'
import {
  maskMainlandPhone,
  normalizeMainlandPhone,
  type PhoneOtpPurpose,
  type PhoneOtpRequestResponse,
} from '@sanchuang-dev/local-life-contracts'

const PHONE_HINT = '请输入有效的中国大陆手机号（11 位，1 开头）'

export interface PhoneVerificationFormProps {
  purpose: PhoneOtpPurpose
  /** False when the deployment has no SMS sender: the method is unavailable. */
  configured: boolean
  title: string
  description: string
  submitLabel: string
  onRequestCode: (phone: string) => Promise<PhoneOtpRequestResponse>
  onSubmit: (phone: string, code: string) => Promise<void>
  onSuccess?: () => void
}

/**
 * Real phone + SMS code form for resident login / phone binding.
 *
 * It never invents a code, never pre-fills one and never fakes success: every
 * error message comes from the API (cooldown, attempt cap, expiry, conflict,
 * not configured). The resend button is driven by the server-provided
 * `retryAfterSeconds`, so the UI cannot outrun the server-side cooldown.
 */
export function PhoneVerificationForm({
  purpose,
  configured,
  title,
  description,
  submitLabel,
  onRequestCode,
  onSubmit,
  onSuccess,
}: PhoneVerificationFormProps) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown])

  if (!configured) {
    return (
      <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50 p-3">
        <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-600">
          <Smartphone size={14} aria-hidden="true" />
          手机号验证码登录
        </p>
        <p className="mt-1 text-[11px] leading-5 text-slate-500">
          短信服务未配置，公网手机号登录未启用。请使用页面提供的其他可用登录方式，或联系社区运营人员。
        </p>
      </div>
    )
  }

  const normalized = normalizeMainlandPhone(phone)

  const sendCode = async () => {
    if (busy || countdown > 0) return
    if (!normalized) {
      setError(PHONE_HINT)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const issued = await onRequestCode(normalized)
      if (!mounted.current) return
      setSentTo(normalized)
      setCode('')
      setCountdown(issued.retryAfterSeconds)
      setNotice(
        `验证码已发送至 ${maskMainlandPhone(normalized)}，${Math.round(issued.expiresInSeconds / 60)} 分钟内有效。`,
      )
    } catch (cause) {
      if (!mounted.current) return
      setError(cause instanceof Error ? cause.message : '验证码发送失败，请稍后重试')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    if (!normalized) {
      setError(PHONE_HINT)
      return
    }
    if (!/^\d{6}$/.test(code)) {
      setError('请输入 6 位数字验证码')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await onSubmit(normalized, code)
      if (!mounted.current) return
      setNotice(purpose === 'login' ? '登录成功，正在刷新账户状态…' : '手机号绑定成功。')
      setCode('')
      onSuccess?.()
    } catch (cause) {
      if (!mounted.current) return
      setError(cause instanceof Error ? cause.message : '验证失败，请稍后重试')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section className="mt-3 rounded-2xl border border-slate-200 bg-white p-3.5">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-700">
        <Smartphone size={15} className="text-[#388b77]" aria-hidden="true" />
        {title}
      </p>
      <p className="mt-1 text-[11px] leading-5 text-slate-500">{description}</p>

      <form className="mt-3" onSubmit={(event) => void submit(event)}>
        <label htmlFor={`phone-${purpose}`} className="block text-[11px] font-medium text-slate-500">
          手机号
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id={`phone-${purpose}`}
            name="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            maxLength={20}
            value={phone}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value
              setPhone(next)
              const nextNormalized = normalizeMainlandPhone(next)
              if (sentTo && nextNormalized !== sentTo) {
                // Editing the number invalidates the pending code flow.
                setSentTo(null)
                setCode('')
                setCountdown(0)
              }
              setError(null)
            }}
            placeholder="例如 13800138000"
            className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-[13px] text-slate-800 outline-none focus:border-teal-400 focus:bg-white disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void sendCode()}
            disabled={busy || countdown > 0 || !normalized}
            className="min-h-[44px] shrink-0 rounded-xl border border-teal-200 bg-white px-3 text-[12px] font-semibold text-teal-700 disabled:opacity-50"
          >
            {countdown > 0 ? `${countdown} 秒后重试` : sentTo ? '重新获取' : '获取验证码'}
          </button>
        </div>

        {sentTo ? (
          <div className="mt-2.5">
            <label htmlFor={`code-${purpose}`} className="block text-[11px] font-medium text-slate-500">
              6 位验证码
            </label>
            <input
              id={`code-${purpose}`}
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              disabled={busy}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                setError(null)
              }}
              placeholder="000000"
              className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-[13px] tracking-[0.3em] text-slate-800 outline-none focus:border-teal-400 focus:bg-white disabled:opacity-60"
            />
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="mt-2 text-[11px] leading-5 text-rose-600">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p aria-live="polite" className="mt-2 text-[11px] leading-5 text-teal-700">
            {notice}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy || !normalized || !/^\d{6}$/.test(code)}
          className="mt-3 inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-full bg-[#138b79] px-4 text-[12px] font-semibold text-white transition-colors hover:bg-[#116d63] disabled:opacity-50"
        >
          <ShieldCheck size={15} aria-hidden="true" />
          {busy ? '处理中…' : submitLabel}
        </button>
        <p className="mt-2 text-[10px] leading-4 text-slate-400">
          验证码只发送到你的手机，平台不会以任何形式展示；短信未配置时本入口会明确显示不可用。
        </p>
      </form>
    </section>
  )
}
