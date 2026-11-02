import { ArrowLeft, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router'

type PageHeaderProps = {
  backTo?: string
  backLabel?: string
  icon: LucideIcon
  title: string
  subtitle: string
}

/**
 * Shared header for business pages: an optional back link for sub-pages, plus
 * the page icon, title and subtitle. Top-level tabs omit the back link because
 * they are peers of the other tabs, not children of home.
 */
export function PageHeader({
  backTo,
  backLabel,
  icon: Icon,
  title,
  subtitle,
}: PageHeaderProps) {
  return (
    <>
      {backTo && backLabel ? (
        <Link
          to={backTo}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg text-[13px] font-medium text-slate-500 transition-colors hover:text-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {backLabel}
        </Link>
      ) : null}

      <div className={`flex items-center gap-3 ${backTo && backLabel ? 'mt-1' : ''}`}>
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] bg-[#e8f6f0] text-[#388b77]"
          aria-hidden="true"
        >
          <Icon size={24} strokeWidth={1.7} />
        </span>
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">{title}</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">{subtitle}</p>
        </div>
      </div>
    </>
  )
}
