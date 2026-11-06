import { Link } from 'react-router'
import { activePrimaryTab, primaryTabs, type PrimaryTabKey } from './navigation'

/**
 * The only primary navigation in the resident H5. Three entries, bottom placed,
 * safe-area aware. Highlighting comes from the current route (see
 * `activePrimaryTab`), never from local click state.
 */
export function BottomTabBar({ pathname }: { pathname: string }) {
  const activeTab: PrimaryTabKey | undefined = activePrimaryTab(pathname)

  return (
    <nav aria-label="主导航" className="app-shell__nav">
      <ul className="app-shell__nav-row">
        {primaryTabs.map(({ key, path, label, icon: Icon }) => {
          const isActive = key === activeTab
          return (
            <li key={key} className="min-w-0">
              <Link
                to={path}
                aria-current={isActive ? 'page' : undefined}
                className={`flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-xl px-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-600 ${
                  isActive
                    ? 'text-teal-700'
                    : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                <Icon size={22} strokeWidth={isActive ? 2.4 : 1.9} aria-hidden="true" />
                <span
                  className={`text-[11px] leading-none tracking-tight ${
                    isActive ? 'font-semibold' : 'font-medium'
                  }`}
                >
                  {label}
                  {isActive ? <span className="sr-only">（当前页面）</span> : null}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
