import type { ReactNode } from 'react'
import { ChevronRight, CircleAlert, Info, LoaderCircle, RefreshCw } from 'lucide-react'
import { Link } from 'react-router'

type Tone = 'mint' | 'amber' | 'rose' | 'slate' | 'teal'

const toneStyles: Record<Tone, string> = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  amber: 'bg-[#fff3e6] text-[#a96b2f]',
  rose: 'bg-rose-50 text-rose-600',
  slate: 'bg-slate-100 text-slate-500',
  teal: 'bg-teal-50 text-teal-700',
}

/** Small status chip. The label must always come from server state, never a guess. */
export function CrmBadge({ tone = 'slate', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${toneStyles[tone]}`}
    >
      {children}
    </span>
  )
}

export function PageSection({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: ReactNode
}) {
  return (
    <section className="mt-5">
      <div className="mb-2.5 flex min-h-[28px] items-center gap-2">
        <h2 className="text-[16px] font-semibold tracking-tight text-slate-900">{title}</h2>
        {note ? (
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-400">
            {note}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

export function LoadingBlock({ label = '正在加载…' }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex min-h-[120px] flex-col items-center justify-center gap-2.5 rounded-2xl border border-slate-100 bg-white px-4 py-8 text-[13px] text-slate-500"
    >
      <LoaderCircle size={22} className="animate-spin text-teal-600" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

export function ErrorBlock({
  message,
  onRetry,
  title = '加载失败',
}: {
  message: string
  onRetry?: () => void
  title?: string
}) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-rose-100 bg-white px-4 py-4 shadow-sm"
    >
      <div className="flex items-start gap-2.5">
        <CircleAlert size={18} className="mt-0.5 shrink-0 text-rose-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-slate-800">{title}</p>
          <p className="mt-1 break-words text-[12px] leading-5 text-slate-500">{message}</p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-full border border-slate-200 px-3.5 text-[12px] font-semibold text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
            >
              <RefreshCw size={14} aria-hidden="true" />
              重新加载
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function EmptyBlock({
  title,
  description,
  actionLabel,
  actionTo,
  actionState,
  onAction,
}: {
  title: string
  description: string
  actionLabel?: string
  actionTo?: string
  actionState?: { from?: string }
  onAction?: () => void
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-8 text-center">
      <p className="text-[14px] font-semibold text-slate-700">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[260px] text-[12px] leading-5 text-slate-400">
        {description}
      </p>
      {actionLabel && actionTo ? (
        <Link
          to={actionTo}
          state={actionState}
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-full bg-[#138b79] px-5 text-[13px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          {actionLabel}
        </Link>
      ) : actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-full border border-teal-200 bg-white px-5 text-[13px] font-semibold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}

type NoticeTone = 'success' | 'error' | 'info'

const noticeStyles: Record<NoticeTone, string> = {
  success: 'border-teal-200 bg-[#eef7f2] text-[#2f6b5d]',
  error: 'border-rose-200 bg-rose-50 text-rose-700',
  info: 'border-[#f2dcc0] bg-[#fff7ec] text-[#8a6132]',
}

const noticeIcons = {
  success: Info,
  error: CircleAlert,
  info: Info,
} as const

/** Inline, non-modal feedback for real submit results and real API errors. */
export function StatusNotice({
  tone,
  children,
}: {
  tone: NoticeTone
  children: ReactNode
}) {
  const Icon = noticeIcons[tone]
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[12px] leading-5 ${noticeStyles[tone]}`}
    >
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  )
}

export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <dt className="shrink-0 text-[12px] text-slate-400">{label}</dt>
      <dd className="min-w-0 text-right text-[12px] font-medium text-slate-700">{value}</dd>
    </div>
  )
}

/** Bottom sheet style action bar for forms; stays above the tab bar while scrolling. */
export function BottomActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-5 border-t border-slate-100 bg-white/95 px-4 pb-3 pt-3 backdrop-blur">
      {children}
    </div>
  )
}

type FieldProps = {
  label: string
  htmlFor: string
  hint?: string
  required?: boolean
  children: ReactNode
}

export function Field({ label, htmlFor, hint, required, children }: FieldProps) {
  return (
    <div className="mt-3 first:mt-0">
      <label htmlFor={htmlFor} className="block text-[12px] font-semibold text-slate-600">
        {label}
        {required ? <span className="ml-0.5 text-rose-500">*</span> : null}
      </label>
      {children}
      {hint ? <p className="mt-1 text-[11px] leading-4 text-slate-400">{hint}</p> : null}
    </div>
  )
}

export const inputClassName =
  'mt-1.5 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-[14px] text-slate-800 placeholder:text-slate-300 focus-visible:border-teal-400 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-teal-600/40 disabled:bg-slate-50 disabled:text-slate-400'

export const primaryButtonClassName =
  'inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-[#138b79] px-4 text-[14px] font-semibold text-white transition-colors hover:bg-[#116d63] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:opacity-50'

export const secondaryButtonClassName =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:opacity-50'

export function TextLink({
  to,
  children,
}: {
  to: string
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      className="inline-flex min-h-11 items-center gap-0.5 text-[12px] font-semibold text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
    >
      {children}
      <ChevronRight size={14} aria-hidden="true" />
    </Link>
  )
}

export type TimelineEntry = {
  id: string
  title: string
  time: string
  description?: string
  tone?: Tone
}

/** Append-only event timeline; every row comes from the server response. */
export function EventTimeline({ entries, emptyText }: { entries: TimelineEntry[]; emptyText: string }) {
  if (entries.length === 0) {
    return <p className="rounded-xl bg-slate-50 px-3.5 py-3 text-[12px] text-slate-400">{emptyText}</p>
  }

  return (
    <ol className="relative ml-1.5 border-l border-slate-200">
      {entries.map((entry) => (
        <li key={entry.id} className="relative pb-4 pl-4 last:pb-0">
          <span
            className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-white ${
              entry.tone === 'rose'
                ? 'bg-rose-400'
                : entry.tone === 'amber'
                  ? 'bg-amber-400'
                  : entry.tone === 'mint'
                    ? 'bg-teal-500'
                    : 'bg-slate-300'
            }`}
            aria-hidden="true"
          />
          <p className="text-[13px] font-semibold text-slate-700">{entry.title}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">{entry.time}</p>
          {entry.description ? (
            <p className="mt-1 break-words text-[12px] leading-5 text-slate-500">
              {entry.description}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
