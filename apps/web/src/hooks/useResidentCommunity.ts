import { useCallback, useEffect, useState } from 'react'
import type { ResidentCommunityStatusResponse } from '@sanchuang-dev/local-life-contracts'
import { getResidentCommunityStatus } from '../services/residentCommunity'
import { isLocalApiError } from '../services/localApi'
import { reportResidentSessionExpired } from '../services/residentSessionEvents'

export type ResidentCommunityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ResidentCommunityStatusResponse }

/**
 * Read the resident's permanent community (#171 LL-IDENTITY-001).
 *
 * This is the only source of residency truth for the H5; the browsing community
 * stays in `localStorage` and never feeds this state. The read is scoped to one
 * resident session: logging out, switching accounts or a 401 drops the previous
 * answer instead of showing another resident's community.
 *
 * `idle` is a real state, not a synonym for 未绑定: before the first successful
 * read the UI must not claim the resident is unbound.
 */
export function useResidentCommunity({
  sessionKey,
  authLoading,
}: {
  sessionKey: string | null
  authLoading: boolean
}) {
  const [state, setState] = useState<ResidentCommunityState>({ status: 'idle' })
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    if (authLoading) {
      setState({ status: 'loading' })
      return
    }
    if (!sessionKey) {
      setState({ status: 'unauthenticated' })
      return
    }

    let active = true
    const controller = new AbortController()
    setState({ status: 'loading' })

    getResidentCommunityStatus(controller.signal)
      .then((data) => {
        if (active) setState({ status: 'ready', data })
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        if (isLocalApiError(cause) && cause.status === 401) {
          reportResidentSessionExpired()
          setState({ status: 'unauthenticated' })
          return
        }
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法读取常驻社区状态',
        })
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [sessionKey, authLoading, reloadToken])

  return { state, reload }
}
