import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LocalOrderDetail,
  LocalOrderStatus,
  LocalOrderSummary,
  LocalOrderTransitionStatus,
} from '@sanchuang-dev/local-life-contracts'
import {
  getStaffLocalOrder,
  listStaffLocalOrders,
  updateStaffLocalOrderStatus,
} from '../services/localOrders'
import { describeLocalError, isLocalApiError } from '../services/localApi'

const PAGE_SIZE = 20

export type StaffOrdersState =
  | { status: 'loading' }
  | { status: 'error'; message: string; forbidden: boolean }
  | { status: 'empty' }
  | { status: 'ready'; items: LocalOrderSummary[]; total: number; hasMore: boolean }

export interface StaffLocalOrders {
  state: StaffOrdersState
  reload: () => void
  loadMore: () => void
  loadingMore: boolean
  loadMoreError: string | null
}

/**
 * Reads `/staff/local-orders` for the 网格员工作台.
 *
 * The route accepts all three staff roles and is scoped by the session's assigned
 * communities server-side, so the hook sends only the usual filters — never a
 * community the worker picked. A 403 is a distinct state: the page must say the
 * worker has no access instead of showing an empty list that looks like "no orders
 * in your community".
 */
export function useStaffLocalOrders({
  enabled,
  communityId,
  status,
}: {
  enabled: boolean
  communityId?: string
  status?: LocalOrderStatus
}): StaffLocalOrders {
  const [state, setState] = useState<StaffOrdersState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const requestVersion = useRef(0)

  const reload = useCallback(() => {
    setLoadMoreError(null)
    setReloadToken((token) => token + 1)
  }, [])

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'loading' })
      return
    }
    const version = requestVersion.current + 1
    requestVersion.current = version
    const controller = new AbortController()
    setState({ status: 'loading' })

    listStaffLocalOrders({ page: 1, pageSize: PAGE_SIZE, communityId, status }, controller.signal)
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
        setState({
          status: 'error',
          message: describeLocalError(cause, '暂时无法读取社区订单'),
          forbidden: isLocalApiError(cause) && (cause.status === 403 || cause.status === 401),
        })
      })

    return () => controller.abort()
  }, [enabled, communityId, status, reloadToken])

  const loadMore = useCallback(() => {
    if (loadingMore || state.status !== 'ready' || !state.hasMore) return
    const page = Math.floor(state.items.length / PAGE_SIZE) + 1
    setLoadingMore(true)
    setLoadMoreError(null)
    listStaffLocalOrders({ page, pageSize: PAGE_SIZE, communityId, status })
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
  }, [loadingMore, state, communityId, status])

  return { state, reload, loadMore, loadingMore, loadMoreError }
}

export type StaffOrderDetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'ready'; order: LocalOrderDetail }

/** Reads one order in the worker's community scope; out of scope answers 404. */
export function useStaffLocalOrder({
  orderId,
  enabled,
}: {
  orderId: string | null
  enabled: boolean
}) {
  const [state, setState] = useState<StaffOrderDetailState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'loading' })
      return
    }
    if (!orderId) {
      setState({ status: 'error', message: '订单链接缺少订单编号。', notFound: true })
      return
    }
    const controller = new AbortController()
    setState({ status: 'loading' })

    getStaffLocalOrder(orderId, controller.signal)
      .then((order) => setState({ status: 'ready', order }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setState({
          status: 'error',
          message: describeLocalError(cause, '暂时无法读取订单详情'),
          notFound: isLocalApiError(cause) && cause.status === 404,
        })
      })

    return () => controller.abort()
  }, [orderId, enabled, reloadToken])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  return { state, reload }
}

/**
 * PATCH `/staff/local-orders/:id/status` from the workbench.
 *
 * Only the transitions a worker may set directly are accepted here; `verified` is
 * absent from `LocalOrderTransitionStatus` on purpose and can only be produced by
 * the back-office verification endpoint.
 */
export function useStaffOrderTransition(csrfToken: string | null) {
  const [busy, setBusy] = useState(false)

  const transition = useCallback(
    async (
      order: LocalOrderDetail,
      status: LocalOrderTransitionStatus,
      note?: string,
    ): Promise<LocalOrderDetail> => {
      if (!csrfToken) throw new Error('登录状态已失效，请重新登录')
      setBusy(true)
      try {
        return await updateStaffLocalOrderStatus(csrfToken, order.id, order.updatedAt, status, note)
      } finally {
        setBusy(false)
      }
    },
    [csrfToken],
  )

  return { busy, transition }
}
