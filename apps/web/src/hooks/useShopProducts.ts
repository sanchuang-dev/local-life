import { useCallback, useEffect, useState } from 'react'
import {
  ACTIVITY_ROUTES,
  CRMEB_ROUTES,
  apiErrorSchema,
  crmebAdapterStatusSchema,
  crmebProductDetailSchema,
  crmebProductListResponseSchema,
  publicActivityDetailSchema,
  type CrmebAdapterStatus,
  type CrmebProductDetail,
  type CrmebProductListResponse,
  type PublicActivityDetail,
} from '@sanchuang-dev/local-life-contracts'

/** The browser always talks to the same-origin `/api` prefix (Vite proxy or reverse proxy). */
const API_PREFIX = '/api'
const PAGE_SIZE = 100

/**
 * A zod-compatible UUID check. The adapter's public activity routes reject
 * anything else, so an invalid deep-link value is reported before a request is
 * made instead of being forwarded as a fake source.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface ShopFailure {
  code: string
  message: string
}

async function readFailure(response: Response): Promise<ShopFailure> {
  const payload: unknown = await response.json().catch(() => null)
  const parsed = apiErrorSchema.safeParse(payload)
  if (parsed.success) return parsed.data.error
  return {
    code: 'unknown',
    message: `请求失败（HTTP ${response.status}）`,
  }
}

type StatusResult =
  | { kind: 'ready'; status: CrmebAdapterStatus }
  | { kind: 'not_configured'; message: string }
  | { kind: 'error'; message: string; code?: string }

/**
 * Read `/integrations/crmeb/status` before any product call.
 *
 * This is deliberate: when the adapter is not configured the H5 must show the
 * configuration blockage and must not request (or render) any catalogue data.
 * The status payload never contains the base URL, appid or appsecret.
 */
async function readStatus(signal: AbortSignal): Promise<StatusResult> {
  try {
    const response = await fetch(`${API_PREFIX}${CRMEB_ROUTES.status}`, {
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!response.ok) {
      const failure = await readFailure(response)
      return {
        kind: 'error',
        message: `无法读取商城接入状态：${failure.message}`,
        code: failure.code,
      }
    }
    const parsed = crmebAdapterStatusSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      return {
        kind: 'error',
        message: '商城接入状态数据格式异常，无法安全判断是否已配置。',
        code: 'crmeb_contract_mismatch',
      }
    }
    if (!parsed.data.configured || parsed.data.status !== 'ready') {
      return {
        kind: 'not_configured',
        message:
          parsed.data.detail ??
          '服务端未配置 CRMEB 商城凭证，因此不会展示模拟商品，也不提供模拟购买。',
      }
    }
    return { kind: 'ready', status: parsed.data }
  } catch (cause) {
    if (signal.aborted) throw cause
    return {
      kind: 'error',
      message: cause instanceof Error ? cause.message : '无法连接商城服务',
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Product list                                                               */
/* -------------------------------------------------------------------------- */

export type ShopProductsState =
  | { status: 'loading' }
  | { status: 'not_configured'; message: string }
  | { status: 'empty' }
  | { status: 'error'; message: string; code?: string }
  | { status: 'ready'; data: CrmebProductListResponse }

/**
 * Real CRMEB products for the resident "优惠购" section. The state machine has
 * five explicit outcomes; there is no mock fallback in any branch.
 */
export function useShopProducts() {
  const [state, setState] = useState<ShopProductsState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const retry = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    let active = true

    const load = async () => {
      setState({ status: 'loading' })

      try {
        const status = await readStatus(controller.signal)
        if (!active) return
        if (status.kind === 'not_configured') {
          setState({ status: 'not_configured', message: status.message })
          return
        }
        if (status.kind === 'error') {
          setState({
            status: 'error',
            message: status.message,
            ...(status.code ? { code: status.code } : {}),
          })
          return
        }

        const query = new URLSearchParams({ page: '1', limit: String(PAGE_SIZE) })
        const response = await fetch(`${API_PREFIX}${CRMEB_ROUTES.products}?${query.toString()}`, {
          signal: controller.signal,
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!active) return
        if (!response.ok) {
          const failure = await readFailure(response)
          if (!active) return
          if (failure.code === 'not_configured') {
            setState({ status: 'not_configured', message: failure.message })
            return
          }
          setState({ status: 'error', message: failure.message, code: failure.code })
          return
        }

        const parsed = crmebProductListResponseSchema.safeParse(
          await response.json().catch(() => null),
        )
        if (!active) return
        if (!parsed.success) {
          setState({
            status: 'error',
            message: '商品列表数据格式与契约不一致，无法安全展示。',
            code: 'crmeb_contract_mismatch',
          })
          return
        }
        setState(
          parsed.data.items.length === 0
            ? { status: 'empty' }
            : { status: 'ready', data: parsed.data },
        )
      } catch (cause) {
        if (!active || controller.signal.aborted) return
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法获取商城商品',
        })
      }
    }

    void load()
    return () => {
      active = false
      controller.abort()
    }
  }, [reloadToken])

  return { state, retry }
}

/* -------------------------------------------------------------------------- */
/* Product detail                                                             */
/* -------------------------------------------------------------------------- */

export type ShopProductState =
  | { status: 'loading' }
  | { status: 'not_configured'; message: string }
  | { status: 'error'; message: string; code?: string }
  | { status: 'ready'; product: CrmebProductDetail }

/**
 * Load one real product by its CRMEB numeric id. `null` means the route param
 * was not a valid id; that is reported as an explicit error instead of a
 * silently empty page.
 */
export function useShopProduct(crmebProductId: number | null) {
  const [state, setState] = useState<ShopProductState>(
    crmebProductId === null
      ? { status: 'error', message: '商品 id 无效，链接可能不完整。', code: 'invalid_request' }
      : { status: 'loading' },
  )
  const [reloadToken, setReloadToken] = useState(0)
  const retry = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    const productId = crmebProductId
    const controller = new AbortController()
    let active = true

    const load = async () => {
      if (productId === null) {
        if (active) {
          setState({
            status: 'error',
            message: '商品 id 无效，链接可能不完整。',
            code: 'invalid_request',
          })
        }
        return
      }

      setState({ status: 'loading' })

      try {
        const status = await readStatus(controller.signal)
        if (!active) return
        if (status.kind === 'not_configured') {
          setState({ status: 'not_configured', message: status.message })
          return
        }
        if (status.kind === 'error') {
          setState({
            status: 'error',
            message: status.message,
            ...(status.code ? { code: status.code } : {}),
          })
          return
        }

        const path = CRMEB_ROUTES.productDetail.replace(
          ':crmebProductId',
          encodeURIComponent(String(productId)),
        )
        const response = await fetch(`${API_PREFIX}${path}`, {
          signal: controller.signal,
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!active) return
        if (!response.ok) {
          const failure = await readFailure(response)
          if (!active) return
          if (failure.code === 'not_configured') {
            setState({ status: 'not_configured', message: failure.message })
            return
          }
          setState({ status: 'error', message: failure.message, code: failure.code })
          return
        }

        const parsed = crmebProductDetailSchema.safeParse(await response.json().catch(() => null))
        if (!active) return
        if (!parsed.success) {
          setState({
            status: 'error',
            message: '商品详情数据格式与契约不一致，无法安全展示。',
            code: 'crmeb_contract_mismatch',
          })
          return
        }
        setState({ status: 'ready', product: parsed.data })
      } catch (cause) {
        if (!active || controller.signal.aborted) return
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法获取商品详情',
        })
      }
    }

    void load()
    return () => {
      active = false
      controller.abort()
    }
  }, [crmebProductId, reloadToken])

  return { state, retry }
}

/* -------------------------------------------------------------------------- */
/* Activity source (trusted deep link only)                                   */
/* -------------------------------------------------------------------------- */

export type ShopActivitySourceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; activity: PublicActivityDetail }

/**
 * Read the activity carried by a deep link (`?activityId=<uuid>`), so the page
 * can show where the click came from. This only *displays* the source: the
 * purchase endpoint independently verifies that the activity is published and
 * belongs to the resident's community, and the browser never decides ownership.
 */
export function useActivitySource(activityId: string | null) {
  const [state, setState] = useState<ShopActivitySourceState>(
    activityId === null ? { status: 'idle' } : { status: 'loading' },
  )
  const [reloadToken, setReloadToken] = useState(0)
  const retry = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    const requestedActivityId = activityId
    const controller = new AbortController()
    let active = true

    const load = async () => {
      if (requestedActivityId === null) {
        if (active) setState({ status: 'idle' })
        return
      }
      if (!UUID_PATTERN.test(requestedActivityId)) {
        if (active) {
          setState({ status: 'invalid', message: '活动来源参数不是合法的活动 ID。' })
        }
        return
      }

      setState({ status: 'loading' })
      try {
        const path = ACTIVITY_ROUTES.publicDetail.replace(
          ':activityId',
          encodeURIComponent(requestedActivityId),
        )
        const response = await fetch(`${API_PREFIX}${path}`, {
          signal: controller.signal,
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!active) return
        if (!response.ok) {
          const failure = await readFailure(response)
          if (!active) return
          setState({ status: 'error', message: failure.message })
          return
        }
        const parsed = publicActivityDetailSchema.safeParse(
          await response.json().catch(() => null),
        )
        if (!active) return
        if (!parsed.success) {
          setState({ status: 'error', message: '活动来源数据格式异常，无法安全展示。' })
          return
        }
        setState({ status: 'ready', activity: parsed.data })
      } catch (cause) {
        if (!active || controller.signal.aborted) return
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法获取活动来源',
        })
      }
    }

    void load()
    return () => {
      active = false
      controller.abort()
    }
  }, [activityId, reloadToken])

  return { state, retry }
}
