import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Small sticky notice state used by home/GD entries whose destination does not
 * exist yet. It keeps the action visibly a demonstration instead of
 * navigating to a fake success screen.
 */
export function usePendingNotice() {
  const [message, setMessage] = useState<string | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  const dismiss = useCallback(() => {
    window.clearTimeout(timerRef.current)
    setMessage(null)
  }, [])

  const show = useCallback((notice: string) => {
    window.clearTimeout(timerRef.current)
    setMessage(notice)
    timerRef.current = window.setTimeout(() => setMessage(null), 4200)
  }, [])

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  return { message, show, dismiss }
}
