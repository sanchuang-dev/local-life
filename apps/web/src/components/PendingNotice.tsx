import { Info, X } from 'lucide-react'

type PendingNoticeProps = {
  message: string | null
  onDismiss: () => void
}

/**
 * Sticky, in-view notice for actions whose page is not migrated yet.
 */
export function PendingNotice({ message, onDismiss }: PendingNoticeProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky bottom-3 z-20 mx-4 mt-3 empty:hidden"
    >
      {message && (
        <div className="flex items-start gap-2.5 rounded-[16px] border border-teal-200/80 bg-white/95 px-3.5 py-3 shadow-[0_10px_28px_rgba(15,52,44,0.16)] backdrop-blur-sm">
          <Info size={16} className="mt-0.5 shrink-0 text-teal-600" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-[12px] leading-5 text-slate-600">{message}</p>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="关闭提示"
            className="-m-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}
