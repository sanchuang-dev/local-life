import { useCallback, useEffect, useRef, useState } from 'react'

export type AsyncResourceState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T }

/**
 * Small read-state helper for authenticated detail pages. `key` controls reloads;
 * the loader always receives an AbortSignal so navigation and filter changes
 * cannot commit a stale response.
 *
 * A manual reload keeps the last ready data on screen, so a successful follow-up
 * or status change is not destroyed by a loading placeholder that unmounts the
 * page's own confirmation message. Switching to a different resource does show
 * the loading state instead of stale data.
 */
export function useAsyncResource<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
): { state: AsyncResourceState<T>; reload: () => void } {
  const [state, setState] = useState<AsyncResourceState<T>>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const loaderRef = useRef(loader)
  const keyRef = useRef(key)

  // Keep the latest loader without touching a ref during render. The data effect
  // below reads it only when the resource key or reload token actually changes.
  useEffect(() => {
    loaderRef.current = loader
  })

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const keyChanged = keyRef.current !== key
    keyRef.current = key
    setState((previous) =>
      keyChanged || previous.status !== 'ready' ? { status: 'loading' } : previous,
    )

    loaderRef
      .current(controller.signal)
      .then((data) => {
        if (active) setState({ status: 'ready', data })
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法获取数据',
        })
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [key, reloadToken])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  return { state, reload }
}
