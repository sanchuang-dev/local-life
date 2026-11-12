import { reportResidentSessionExpired } from '../services/residentSessionEvents'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LocalOrderDetail,
  LocalOrderStatus,
  LocalOrderSummary,
  LocalOrderTeamOption,
} from '@sanchuang-dev/local-life-contracts'
import {
  getMyLocalOrder,
  listMyLocalOrderTeamOptions,
  listMyLocalOrders,
} from '../services/localOrders'
import { describeLocalError, isLocalApiError } from '../services/localApi'

const PAGE_SIZE = 20

export type LocalOrderTeamOptionsState =
  /** Signed out, or no product to read options for. */
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: LocalOrderTeamOption[] }

export interface LocalOrderTeamOptions {
  state: LocalOrderTeamOptionsState
  reload: () => void
}

/**
 * Reads the signed-in resident's eligible consumption teams for this product.
 *
 * A 401 invalidates the shared resident session; it never degrades into an empty
 * option list, because "no team" and "could not read teams" are different facts
 * and only the former may produce an order without attribution.
 */
export function useLocalOrderTeamOptions({
  productId,
  sessionKey,
  authLoading,
}: {
  productId: string | null
  sessionKey: string | null
  authLoading: boolean
}): LocalOrderTeamOptions {
  const [state, setState] = useState<LocalOrderTeamOptionsState>({ status: 'idle' })
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    if (authLoading) {
      setState({ status: 'loading' })
      return
    }
    if (!sessionKey || !productId) {
      setState({ status: 'idle' })
      return
    }

    const controller = new AbortController()
    setState({ status: 'loading' })

    listMyLocalOrderTeamOptions(productId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        setState({ status: 'ready', items: response.items })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        if (isLocalApiError(cause) && cause.status === 401) {
          reportResidentSessionExpired()
          setState({ status: 'idle' })
          return
        }
        setState({
          status: 'error',
          message: describeLocalError(cause, '暂时无法读取可参与的消费团'),
        })
      })

    return () => controller.abort()
  }, [productId, sessionKey, authLoading, reloadToken])

  return { state, reload }
}

export type MyOrdersState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'ready'; items: LocalOrderSummary[]; total: number; hasMore: boolean }

export interface MyLocalOrders {
  state: MyOrdersState
  reload: () => void
  /** Append the next page; a failure keeps the rows already on screen. */
  loadMore: () => void
  loadingMore: boolean
  loadMoreError: string | null
}

/**
 * Reads the signed-in resident's own orders (GET /local-orders).
 *
 * The endpoint is scoped to the session server-side, so this hook never sends a
 * resident id and cannot accidentally read someone else's orders. A 401 is a
 * first-class state (the page shows the login requirement) instead of an error
 * banner or an empty list.
 */
export function useMyLocalOrders({
  sessionKey,
  authLoading,
  status,
}: {
  sessionKey: string | null
  authLoading: boolean
  status?: LocalOrderStatus
}): MyLocalOrders {
  const [state, setState] = useState<MyOrdersState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const requestVersion = useRef(0)

  const reload = useCallback(() => {
    setLoadMoreError(null)
    setReloadToken((token) => token + 1)
  }, [])

  useEffect(() => {
    if (authLoading) {
      setState({ status: 'loading' })
      return
    }
    if (!sessionKey) {
      setState({ status: 'unauthenticated' })
      return
    }

    const version = requestVersion.current + 1
    requestVersion.current = version
    const controller = new AbortController()
    setState({ status: 'loading' })

    listMyLocalOrders({ page: 1, pageSize: PAGE_SIZE, status }, controller.signal)
      .then((response) => {
        if (version !== requestVersion.current) return
        setState(
          response.items.length === 0
            ? { status: 'empty' }
            : {
                status: 'ready',
                items: response.items,
                total: response.total,
                hasMore: response.items.length < response.total,
              },
        )
      })
      .catch((cause: unknown) => {
        if (version !== requestVersion.current || controller.signal.aborted) return
        if (isLocalApiError(cause) && cause.status === 401) {
          reportResidentSessionExpired()
          setState({ status: 'unauthenticated' })
          return
        }
        setState({ status: 'error', message: describeLocalError(cause, '暂时无法读取我的订单') })
      })

    return () => controller.abort()
  }, [sessionKey, authLoading, status, reloadToken])

  /**
   * Append the next page. Kept separate from the list effect so a failed extra
   * page never replaces the rows the resident is already looking at.
   */
  const loadMore = useCallback(() => {
    if (loadingMore || state.status !== 'ready' || !state.hasMore) return
    const page = Math.floor(state.items.length / PAGE_SIZE) + 1
    setLoadingMore(true)
    setLoadMoreError(null)
    listMyLocalOrders({ page, pageSize: PAGE_SIZE, status })
      .then((response) => {
        setState((current) => {
          if (current.status !== 'ready') return current
          const items = [...current.items, ...response.items]
          return {
            status: 'ready',
            items,
            total: response.total,
            hasMore: items.length < response.total,
          }
        })
      })
      .catch((cause: unknown) => {
        setLoadMoreError(describeLocalError(cause, '加载更多订单失败'))
      })
      .finally(() => setLoadingMore(false))
  }, [loadingMore, state, status])

  return { state, reload, loadMore, loadingMore, loadMoreError }
}

export type MyOrderDetailState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'ready'; order: LocalOrderDetail }

/** Reads one of the resident's own orders; another resident's order is a 404. */
export function useMyLocalOrder({
  orderId,
  sessionKey,
  authLoading,
}: {
  orderId: string | null
  sessionKey: string | null
  authLoading: boolean
}) {
  const [state, setState] = useState<MyOrderDetailState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (authLoading) {
      setState({ status: 'loading' })
      return
    }
    if (!sessionKey) {
      setState({ status: 'unauthenticated' })
      return
    }
    if (!orderId) {
      setState({ status: 'error', message: '订单链接缺少订单编号。', notFound: true })
      return
    }

    const controller = new AbortController()
    setState({ status: 'loading' })

    getMyLocalOrder(orderId, controller.signal)
      .then((order) => setState({ status: 'ready', order }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        if (isLocalApiError(cause) && cause.status === 401) {
          reportResidentSessionExpired()
          setState({ status: 'unauthenticated' })
          return
        }
        setState({
          status: 'error',
          message: describeLocalError(cause, '暂时无法读取订单详情'),
          notFound: isLocalApiError(cause) && cause.status === 404,
        })
      })

    return () => controller.abort()
  }, [orderId, sessionKey, authLoading, reloadToken])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  return { state, reload }
}
