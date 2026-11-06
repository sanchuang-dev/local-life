import { type ReactNode, useCallback, useEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { BottomTabBar } from './BottomTabBar'
import { useKeyboardVisible } from './useKeyboardVisible'

/**
 * Resident H5 app shell.
 *
 * It is deliberately thin: no simulated device frame, no fake status bar, no
 * mini-program capsule and no prototype copy. It owns three things only —
 * the document-level scroll container, the safe areas, and the three-entry
 * bottom navigation. Pages own their own headers and back affordances, so the
 * shell never renders a second title bar.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const navigationType = useNavigationType()
  const keyboardVisible = useKeyboardVisible()

  // A new page starts at the top; history traversal keeps the browser's own
  // scroll restoration so back/forward return to the same reading position.
  useEffect(() => {
    if (navigationType === 'POP') return
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [pathname, navigationType])

  // A hash link would be swallowed by HashRouter, so the skip link moves focus
  // programmatically instead of navigating.
  const focusMain = useCallback(() => {
    document.getElementById('main-content')?.focus()
  }, [])

  return (
    <div className="app-shell" data-keyboard={keyboardVisible ? 'open' : 'closed'}>
      <button
        type="button"
        onClick={focusMain}
        className="app-shell__skip"
      >
        跳到主要内容
      </button>

      <div className="app-shell__column">
        <main id="main-content" tabIndex={-1} className="app-shell__main">
          {children}
        </main>
      </div>

      <BottomTabBar pathname={pathname} />
    </div>
  )
}
