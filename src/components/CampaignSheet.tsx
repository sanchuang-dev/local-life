import { type ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'

type CampaignSheetProps = {
  open: boolean
  title: string
  eyebrow?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

export function CampaignSheet({
  open,
  title,
  eyebrow,
  onClose,
  children,
  footer,
}: CampaignSheetProps) {
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/35 px-0 md:items-center md:px-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[82dvh] w-full max-w-[390px] overflow-hidden rounded-t-[24px] bg-white shadow-[0_-16px_44px_rgba(15,23,42,0.18)] md:rounded-[24px]"
      >
        <div className="flex items-start gap-3 border-b border-slate-100 px-4 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            {eyebrow ? (
              <p className="text-[11px] font-bold tracking-[0.14em] text-teal-700">{eyebrow}</p>
            ) : null}
            <h2 className="mt-0.5 text-[20px] font-bold tracking-tight text-slate-900">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </div>

        <div className="max-h-[calc(82dvh-132px)] overflow-y-auto px-4 py-4 text-[14px] leading-6 text-slate-600">
          {children}
        </div>

        {footer ? (
          <div className="border-t border-slate-100 bg-white px-4 pb-[max(env(safe-area-inset-bottom),16px)] pt-3">
            {footer}
          </div>
        ) : null}
      </section>
    </div>
  )
}
