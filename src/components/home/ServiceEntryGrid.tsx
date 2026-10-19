import { Link } from 'react-router'
import type { ServiceEntry } from '../../mocks/home'

const toneClasses = {
  mint: 'bg-[#e8f6f0] text-[#388b77]',
  peach: 'bg-[#fff3e6] text-[#c6925c]',
} as const

type ServiceEntryGridProps = {
  entries: ServiceEntry[]
  onPending: (notice: string) => void
}

/**
 * Four-column entry grid reused by the home "常用服务" and "更多服务" blocks.
 * Entries without a route keep the tap honest by showing a pending notice.
 */
export function ServiceEntryGrid({ entries, onPending }: ServiceEntryGridProps) {
  return (
    <div className="grid grid-cols-4 gap-x-1 gap-y-4">
      {entries.map(({ id, label, icon: Icon, tone, to, pendingNotice }) => {
        const content = (
          <>
            <span
              className={`flex h-[52px] w-[52px] items-center justify-center rounded-[18px] ${toneClasses[tone]}`}
              aria-hidden="true"
            >
              <Icon size={23} strokeWidth={1.65} />
            </span>
            <span className="mt-2 text-[12px] font-medium leading-4 text-slate-600">{label}</span>
            {pendingNotice ? (
              <span className="mt-1 text-[10px] font-medium leading-none text-slate-400">待接入</span>
            ) : null}
          </>
        )

        const itemClass =
          'flex min-h-[88px] flex-col items-center rounded-xl py-1 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600'

        return to ? (
          <Link key={id} to={to} className={`${itemClass} hover:bg-slate-50`}>
            {content}
          </Link>
        ) : (
          <button
            key={id}
            type="button"
            onClick={() => pendingNotice && onPending(pendingNotice)}
            className={`${itemClass} hover:bg-slate-50`}
          >
            {content}
          </button>
        )
      })}
    </div>
  )
}
