import type { ReactNode } from 'react'

type EmptyStateProps = {
  title: string
  description?: string
  illustration?: ReactNode
  action?: ReactNode
  className?: string
  layout?: 'inline' | 'centered'
}

/** Presentation-only empty state: copy, illustration and optional action belong to callers. */
export function EmptyState({ title, description, illustration, action, className = '', layout = 'inline' }: EmptyStateProps) {
  const centered = layout === 'centered'
  return (
    <div className={`${centered
      ? 'flex flex-col items-center gap-2 px-4 py-7 text-center'
      : 'flex min-h-[116px] items-center gap-3 px-3 py-4'} ${className}`} role="status">
      {illustration}
      <div className={centered ? 'min-w-0 w-full' : 'min-w-0 flex-1'}>
        <h3 className="text-[15px] font-semibold leading-6 text-[#213e31]">{title}</h3>
        {description ? <p className="mt-1 text-[12px] leading-5 text-[#77877f]">{description}</p> : null}
        {action ? <div className="mt-2 text-[12px] font-semibold text-[#14836c]">{action}</div> : null}
      </div>
    </div>
  )
}
