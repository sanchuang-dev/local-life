import { RefreshCw, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

type ShopStateTone = 'info' | 'warn' | 'error'

const toneStyles: Record<
  ShopStateTone,
  { box: string; iconBox: string; title: string; body: string }
> = {
  info: {
    box: 'border-slate-200 bg-white',
    iconBox: 'bg-[#e8f6f0] text-[#388b77]',
    title: 'text-slate-800',
    body: 'text-slate-500',
  },
  warn: {
    box: 'border-[#f2dcc0] bg-[#fffdf8]',
    iconBox: 'bg-[#fff3e6] text-[#c6925c]',
    title: 'text-[#8a6132]',
    body: 'text-[#8a6132]/80',
  },
  error: {
    box: 'border-rose-200 bg-rose-50/60',
    iconBox: 'bg-rose-100 text-rose-600',
    title: 'text-rose-700',
    body: 'text-rose-600',
  },
}

/**
 * Shared explainable state card for the real shop. Used for loading failures,
 * missing configuration, empty catalogues and invalid product ids. It never
 * renders demo products as a substitute.
 */
export function ShopStateCard({
  icon: Icon,
  title,
  description,
  tone = 'info',
  code,
  onRetry,
  retryLabel = '重新读取',
  children,
}: {
  icon: LucideIcon
  title: string
  description: string
  tone?: ShopStateTone
  code?: string
  onRetry?: () => void
  retryLabel?: string
  children?: ReactNode
}) {
  const styles = toneStyles[tone]

  return (
    <section
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-2xl border px-5 py-8 text-center shadow-sm ${styles.box}`}
    >
      <span
        className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl ${styles.iconBox}`}
        aria-hidden="true"
      >
        <Icon size={26} strokeWidth={1.6} />
      </span>
      <h2 className={`mt-3 break-words text-[16px] font-semibold ${styles.title}`}>{title}</h2>
      <p
        className={`mx-auto mt-2 max-w-[300px] break-words text-[12px] leading-6 ${styles.body}`}
      >
        {description}
      </p>
      {code ? (
        <p className="mt-2 break-all font-mono text-[10px] text-slate-400">错误代码：{code}</p>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-teal-700 px-5 text-[13px] font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <RefreshCw size={15} aria-hidden="true" />
          {retryLabel}
        </button>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  )
}
