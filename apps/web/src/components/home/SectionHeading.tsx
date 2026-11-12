import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'

type SectionHeadingProps = {
  title: string
  note?: string
  actionLabel?: string
  onAction?: () => void
  /** When set, the action becomes a real route link instead of a pending tap. */
  actionTo?: string
  /** Optional location state so shared pages can return to their entry module. */
  actionState?: { from?: string }
}

export function SectionHeading({
  title,
  note,
  actionLabel,
  onAction,
  actionTo,
  actionState,
}: SectionHeadingProps) {
  const actionClass =
    'inline-flex min-h-[44px] shrink-0 items-center gap-0.5 px-1 text-[12px] font-medium text-slate-400 transition-colors hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600'

  return (
    <div className="mb-3 flex min-h-[36px] items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="truncate text-[17px] font-semibold tracking-tight text-slate-900">{title}</h2>
        {note ? (
          <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-400">
            {note}
          </span>
        ) : null}
      </div>
      {actionLabel && actionTo ? (
        <Link to={actionTo} state={actionState} className={actionClass}>
          {actionLabel}
          <ChevronRight size={14} aria-hidden="true" />
        </Link>
      ) : actionLabel && onAction ? (
        <button type="button" onClick={onAction} className={actionClass}>
          {actionLabel}
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
