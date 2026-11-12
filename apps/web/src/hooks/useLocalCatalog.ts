import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LocalProductDetail,
  LocalProductSummary,
} from '@sanchuang-dev/local-life-contracts'
import { getLocalProduct, listLocalProducts } from '../services/localCatalog'
import { describeLocalError, isLocalApiError } from '../services/localApi'

const PAGE_SIZE = 20

export type LocalCatalogState =
  | { status: 'loading' }
  | { status: 'error'; message: string; code: string | null }
  | { status: 'empty' }
  | { status: 'ready'; items: LocalProductSummary[]; total: number; hasMore: boolean }

export interface LocalCatalog {
  state: LocalCatalogState
  reload: () => void
}

/**
 * Reads the real local catalogue (GET /catalog/products).
 *
 * Only on-shelf products ever come back from this endpoint, so an empty answer is
 * a true "this community has nothing on sale" and is shown as such — the section
 * never falls back to CRMEB products, demo goods or placeholder rows.
 */
export function useLocalCatalog(communityId?: string): LocalCatalog {
  const [state, setState] = useState<LocalCatalogState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const requestVersion = useRef(0)

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    const version = requestVersion.current + 1
    requestVersion.current = version
    const controller = new AbortController()
    setState({ status: 'loading' })

    listLocalProducts(
      { page: 1, pageSize: PAGE_SIZE, communityId },
      controller.signal,
    )
      .then((response) => {
        if (version !== requestVersion.current) return
        if (response.items.length === 0) {
          setState({ status: 'empty' })
          return
        }
        setState({
          status: 'ready',
          items: response.items,
          total: response.total,
          hasMore: response.items.length < response.total,
        })
      })
      .catch((cause: unknown) => {
        if (version !== requestVersion.current || controller.signal.aborted) return
        setState({
          status: 'error',
          message: describeLocalError(cause, '暂时无法读取本地商品'),
          code: isLocalApiError(cause) ? cause.code : null,
        })
      })

    return () => controller.abort()
  }, [communityId, reloadToken])

  return { state, reload }
}

export type LocalProductState =
  | { status: 'loading' }
  | { status: 'error'; message: string; code: string | null; notFound: boolean }
  | { status: 'ready'; product: LocalProductDetail }

/** Reads one on-shelf product. A 404 is reported as 已下架/不存在, never as a retry. */
export function useLocalProduct(productId: string | null): {
  state: LocalProductState
  reload: () => void
} {
  const [state, setState] = useState<LocalProductState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!productId) {
      setState({
        status: 'error',
        message: '商品链接缺少商品编号，无法读取详情。',
        code: 'invalid_product_id',
        notFound: true,
      })
      return
    }
    const controller = new AbortController()
    setState({ status: 'loading' })

    getLocalProduct(productId, controller.signal)
      .then((product) => setState({ status: 'ready', product }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setState({
          status: 'error',
          message: describeLocalError(cause, '暂时无法读取商品详情'),
          code: isLocalApiError(cause) ? cause.code : null,
          notFound: isLocalApiError(cause) && cause.status === 404,
        })
      })

    return () => controller.abort()
  }, [productId, reloadToken])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  return { state, reload }
}

/**
 * The communities present in the currently read catalogue.
 *
 * Used for the resident community filter: the H5 has no resident→community
 * mapping endpoint, so the filter is built from real products rather than from a
 * guessed list of communities.
 */
export function useCatalogCommunities(items: readonly LocalProductSummary[]) {
  return useMemo(() => {
    const seen = new Map<string, string>()
    for (const item of items) {
      if (!seen.has(item.community.id)) seen.set(item.community.id, item.community.name)
    }
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [items])
}
