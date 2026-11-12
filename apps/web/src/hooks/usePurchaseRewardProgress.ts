import { useCallback, useEffect, useState } from 'react'
import type { PurchaseRewardProgressResponse } from '@sanchuang-dev/local-life-contracts'
import { getMyPurchaseRewardProgress } from '../services/purchaseReward'
import { isLocalApiError } from '../services/localApi'

export type PurchaseRewardProgressState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: PurchaseRewardProgressResponse }

/**
 * The caller's own consumption-team progress for one activity (#210).
 *
 * A signed-out visitor is an explicit state instead of an empty team. The hook
 * also re-reads when `refreshKey` changes (for example, a third member joins from
 * the participation card on this page), so the two cards cannot disagree about
 * how many seats are filled.
 */
export function usePurchaseRewardProgress({
  activityId,
  sessionKey,
  authLoading,
  refreshKey = '',
}: {
  activityId: string | null
  sessionKey: string | null
  authLoading: boolean
  refreshKey?: string
}) {
  const [state, setState] = useState<PurchaseRewardProgressState>({ status: 'idle' })
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    if (!activityId || authLoading) {
      setState({ status: 'idle' })
      return
    }
    if (!sessionKey) {
      setState({ status: 'unauthenticated' })
      return
    }

    let active = true
    const controller = new AbortController()

    setState({ status: 'loading' })
    getMyPurchaseRewardProgress(activityId, controller.signal)
      .then((data) => {
        if (active) setState({ status: 'ready', data })
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        if (isLocalApiError(cause) && cause.status === 401) {
          setState({ status: 'unauthenticated' })
          return
        }
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法读取消费团进度',
        })
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [activityId, sessionKey, authLoading, refreshKey, reloadToken])

  return { state, reload }
}
