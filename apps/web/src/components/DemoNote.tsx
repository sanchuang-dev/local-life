import { CircleHelp, Info } from 'lucide-react'
import type { ReactNode } from 'react'

type DemoNoteProps = {
  children: ReactNode
  /** `warn` is used for content that is explicitly still being prepared. */
  tone?: 'info' | 'warn'
}

const toneStyles = {
  info: {
    box: 'border-teal-300/70 bg-[#eef7f2] text-[#52786c]',
    icon: 'text-teal-600',
    Icon: CircleHelp,
  },
  warn: {
    box: 'border-[#f2dcc0] bg-[#fff7ec] text-[#8a6132]',
    icon: 'text-[#b97b3e]',
    Icon: Info,
  },
} as const

/**
 * Static "this is a demonstration" banner shared by migrated pages so the demo
 * semantics stay identical instead of being re-worded per page.
 */
export function DemoNote({ children, tone = 'info' }: DemoNoteProps) {
  const { box, icon, Icon } = toneStyles[tone]

  return (
    <div className={`mt-4 flex items-start gap-2.5 rounded-[16px] border px-3.5 py-3 text-[12px] leading-5 ${box}`}>
      <Icon size={16} className={`mt-0.5 shrink-0 ${icon}`} aria-hidden="true" />
      <p className="min-w-0 flex-1">{children}</p>
    </div>
  )
}
