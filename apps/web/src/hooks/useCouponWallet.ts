import { useCallback, useEffect, useState } from 'react'
import type { CouponWalletItem } from '@sanchuang-dev/local-life-contracts'
import { getMyCoupons } from '../services/purchaseReward'
import { isLocalApiError } from '../services/localApi'

export type CouponWalletState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: CouponWalletItem[]; asOf: string }

/**
 * The resident's whole coupon wallet (`GET /purchase-reward/coupons`).
 *
 * Reading the global wallet is intentional: a consumption coupon must remain
 * visible even when its activity is absent from a shortened activity list. The
 * endpoint is server-scoped to the session, so no resident id is ever sent.
 */
export function useCouponWallet({
  sessionKey,
  authLoading,
  refreshKey = '',
}: {
  sessionKey: string | null
  authLoading: boolean
  refreshKey?: string
}) {
  const [state, setState] = useState<CouponWalletState>({ status: 'idle' })
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    if (authLoading) {
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
    getMyCoupons(controller.signal)
      .then((data) => {
        if (active) setState({ status: 'ready', items: data.items, asOf: data.asOf })
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        if (isLocalApiError(cause) && cause.status === 401) {
          setState({ status: 'unauthenticated' })
          return
        }
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法读取消费券包',
        })
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [sessionKey, authLoading, refreshKey, reloadToken])

  return { state, reload }
}
