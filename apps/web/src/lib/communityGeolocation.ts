import {
  API_ROUTES,
  wechatJsSdkSignatureResponseSchema,
  type WechatJsSdkSignatureResponse,
} from '@sanchuang-dev/local-life-contracts'
import { isWechatBrowser, loadWechatSdk, type WechatSdk } from '../components/activity/wechatShare.ts'
import { wgs84ToGcj02, type Gcj02Point } from './communityCoordinates.ts'

/**
 * Every location failure is classified before it reaches the community sheet,
 * so the resident sees whether they refused permission, the WeChat JS-SDK is
 * misconfigured, the request timed out, or the device simply could not locate.
 * Technical details stay in development logs; only the readable reason is UI.
 */
export type CommunityLocationFailureReason =
  | 'cancelled'
  | 'unsupported'
  | 'permission_denied'
  | 'position_unavailable'
  | 'timeout'
  | 'signature_unavailable'
  | 'signature_invalid'
  | 'sdk_load_failed'
  | 'sdk_config_failed'
  | 'sdk_unsupported'
  | 'wechat_cancelled'
  | 'wechat_failed'

const failureMessages: Record<CommunityLocationFailureReason, string> = {
  cancelled: '定位已取消',
  unsupported: '当前浏览器不支持定位，请手动选择社区',
  permission_denied: '定位授权被拒绝，请在微信或浏览器设置中允许定位后重试，或手动选择社区',
  position_unavailable: '设备暂时无法确定位置，请确认定位服务已开启后重试，或手动选择社区',
  timeout: '定位超时，请检查网络与定位权限后重试，或手动选择社区',
  signature_unavailable: '微信定位服务暂不可用，请稍后重试或手动选择社区',
  signature_invalid: '微信定位服务返回异常，请稍后重试或手动选择社区',
  sdk_load_failed: '微信定位组件加载失败，请检查网络后重试，或手动选择社区',
  sdk_config_failed: '微信定位初始化失败，请稍后重试或手动选择社区',
  sdk_unsupported: '当前微信版本不支持定位，请手动选择社区',
  wechat_cancelled: '已取消微信定位，可重新定位或手动选择社区',
  wechat_failed: '微信未能获取当前位置，请确认手机定位已开启后重试，或手动选择社区',
}

export class CommunityLocationError extends Error {
  readonly reason: CommunityLocationFailureReason

  constructor(reason: CommunityLocationFailureReason) {
    super(failureMessages[reason])
    this.name = 'CommunityLocationError'
    this.reason = reason
  }
}

interface LocationWechatSdk extends WechatSdk {
  getLocation(options: {
    type: 'gcj02'
    success: (result: { latitude: number; longitude: number }) => void
    fail: (error: unknown) => void
    cancel: () => void
  }): void
}

export interface CommunityLocationOptions {
  signal?: AbortSignal
  pageUrl?: string
  userAgent?: string
}

export interface WechatLocationDeps {
  pageUrl: string
  fetcher: typeof fetch
  loadSdk: () => Promise<WechatSdk>
  signal?: AbortSignal
  timeoutMs?: number
  setTimer?: (callback: () => void, milliseconds: number) => number
  clearTimer?: (handle: number) => void
}

export interface BrowserLocationDeps {
  geolocation?: Geolocation | null
  signal?: AbortSignal
  timeoutMs?: number
  maximumAgeMs?: number
}

const defaultSetTimer = (callback: () => void, milliseconds: number): number =>
  globalThis.setTimeout(callback, milliseconds) as unknown as number
const defaultClearTimer = (handle: number): void => globalThis.clearTimeout(handle)

function logDetail(reason: unknown, detail?: unknown): void {
  // Vite replaces import.meta.env; plain Node tests see undefined and stay quiet.
  if (!import.meta.env?.DEV) return
  if (detail === undefined) console.debug('[community-location]', reason)
  else console.debug('[community-location]', reason, detail)
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CommunityLocationError('cancelled')
}

function browserFailureReason(code: number): CommunityLocationFailureReason {
  if (code === 1) return 'permission_denied'
  if (code === 3) return 'timeout'
  return 'position_unavailable'
}

function wechatFailureReason(error: unknown): CommunityLocationFailureReason {
  const message = typeof error === 'object' && error !== null && 'errMsg' in error
    ? String((error as { errMsg?: unknown }).errMsg ?? '').toLowerCase()
    : ''
  if (/cancel/.test(message)) return 'wechat_cancelled'
  if (/auth|authorize|permission|denied|privacy/.test(message)) return 'permission_denied'
  if (/timeout|time out/.test(message)) return 'timeout'
  return 'wechat_failed'
}

async function loadWechatSignature(deps: WechatLocationDeps): Promise<WechatJsSdkSignatureResponse> {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  deps.signal?.addEventListener('abort', onAbort, { once: true })
  if (deps.signal?.aborted) controller.abort()
  const clearTimer = deps.clearTimer ?? defaultClearTimer
  const timer = (deps.setTimer ?? defaultSetTimer)(() => {
    timedOut = true
    controller.abort()
  }, deps.timeoutMs ?? 12_000)

  let response: Response
  try {
    response = await deps.fetcher(`/api${API_ROUTES.wechatJsSdkSignature}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      body: JSON.stringify({ url: deps.pageUrl }),
    })
  } catch (cause) {
    if (deps.signal?.aborted) throw new CommunityLocationError('cancelled')
    if (timedOut) {
      logDetail('timeout', cause)
      throw new CommunityLocationError('timeout')
    }
    logDetail('signature_unavailable', cause)
    throw new CommunityLocationError('signature_unavailable')
  } finally {
    clearTimer(timer)
    deps.signal?.removeEventListener('abort', onAbort)
  }
  if (!response.ok) {
    logDetail('signature_unavailable', `HTTP ${response.status}`)
    throw new CommunityLocationError('signature_unavailable')
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    logDetail('signature_invalid', cause)
    throw new CommunityLocationError('signature_invalid')
  }
  const signature = wechatJsSdkSignatureResponseSchema.safeParse(payload)
  if (!signature.success) {
    logDetail('signature_invalid', signature.error)
    throw new CommunityLocationError('signature_invalid')
  }
  return signature.data
}

/**
 * WeChat JS-SDK flow used by #122: signature -> config -> ready -> getLocation.
 * `wx.error` is a JS-SDK configuration failure and is deliberately NOT reported
 * as a resident permission refusal.
 */
export async function requestWechatLocation(deps: WechatLocationDeps): Promise<Gcj02Point> {
  throwIfCancelled(deps.signal)
  const signature = await loadWechatSignature(deps)
  throwIfCancelled(deps.signal)

  let sdk: WechatSdk
  try {
    sdk = await deps.loadSdk()
  } catch (cause) {
    if (deps.signal?.aborted) throw new CommunityLocationError('cancelled')
    logDetail('sdk_load_failed', cause)
    throw new CommunityLocationError('sdk_load_failed')
  }
  throwIfCancelled(deps.signal)

  return new Promise<Gcj02Point>((resolve, reject) => {
    let settled = false
    let timer: number | null = null
    const clearTimer = deps.clearTimer ?? defaultClearTimer
    const settle = (outcome: Gcj02Point | CommunityLocationFailureReason) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimer(timer)
      deps.signal?.removeEventListener('abort', onAbort)
      if (typeof outcome === 'string') {
        if (outcome !== 'cancelled') logDetail(outcome)
        reject(new CommunityLocationError(outcome))
      } else {
        resolve(outcome)
      }
    }
    const onAbort = () => settle('cancelled')

    deps.signal?.addEventListener('abort', onAbort, { once: true })
    if (deps.signal?.aborted) {
      settle('cancelled')
      return
    }
    timer = (deps.setTimer ?? defaultSetTimer)(() => settle('timeout'), deps.timeoutMs ?? 12_000)

    const locationSdk = sdk as LocationWechatSdk
    try {
      sdk.error((error) => {
        logDetail('sdk_config_failed', error)
        settle('sdk_config_failed')
      })
      sdk.ready(() => {
        if (typeof locationSdk.getLocation !== 'function') {
          settle('sdk_unsupported')
          return
        }
        try {
          locationSdk.getLocation({
            type: 'gcj02',
            success: (result) => {
              if (Number.isFinite(result.latitude) && Number.isFinite(result.longitude)) {
                settle({ latitude: result.latitude, longitude: result.longitude })
              } else {
                settle('wechat_failed')
              }
            },
            fail: (error) => settle(wechatFailureReason(error)),
            cancel: () => settle('wechat_cancelled'),
          })
        } catch (cause) {
          logDetail('sdk_config_failed', cause)
          settle('sdk_config_failed')
        }
      })
      sdk.config({ ...signature, debug: false, jsApiList: ['getLocation'] })
    } catch (cause) {
      logDetail('sdk_config_failed', cause)
      settle('sdk_config_failed')
    }
  })
}

/** Standard browser geolocation branch, converted to GCJ-02 for community search. */
export function requestBrowserLocation(deps: BrowserLocationDeps): Promise<Gcj02Point> {
  if (!deps.geolocation) return Promise.reject(new CommunityLocationError('unsupported'))
  if (deps.signal?.aborted) return Promise.reject(new CommunityLocationError('cancelled'))

  return new Promise<Gcj02Point>((resolve, reject) => {
    let settled = false
    const settle = (outcome: Gcj02Point | CommunityLocationFailureReason) => {
      if (settled) return
      settled = true
      deps.signal?.removeEventListener('abort', onAbort)
      if (typeof outcome === 'string') {
        if (outcome !== 'cancelled') logDetail(outcome)
        reject(new CommunityLocationError(outcome))
      } else {
        resolve(outcome)
      }
    }
    const onAbort = () => settle('cancelled')
    deps.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      deps.geolocation?.getCurrentPosition(
        (position) => settle(wgs84ToGcj02(position.coords.latitude, position.coords.longitude)),
        (error) => settle(browserFailureReason(error.code)),
        {
          enableHighAccuracy: false,
          timeout: deps.timeoutMs ?? 10_000,
          maximumAge: deps.maximumAgeMs ?? 30_000,
        },
      )
    } catch (cause) {
      logDetail('position_unavailable', cause)
      settle('position_unavailable')
    }
  })
}

/**
 * Location is only requested after an explicit resident action. There is no
 * automatic collection, no fixed coordinate and no fallback success.
 */
export function requestCommunityLocation(options: CommunityLocationOptions = {}): Promise<Gcj02Point> {
  const userAgent = options.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  if (isWechatBrowser(userAgent)) {
    const pageUrl = options.pageUrl
      ?? (typeof window === 'undefined' ? '' : window.location.href.split('#')[0])
    return requestWechatLocation({
      signal: options.signal,
      pageUrl,
      fetcher: (input, init) => fetch(input, init),
      loadSdk: loadWechatSdk,
    })
  }
  const geolocation = typeof navigator === 'undefined' ? undefined : navigator.geolocation
  return requestBrowserLocation({ signal: options.signal, geolocation })
}

export interface CommunityLocationRequester {
  readonly pending: boolean
  request(): Promise<Gcj02Point>
  cancel(): void
}

/**
 * Single-flight wrapper for the community sheet: rapid double taps share one
 * request, and unmount/retry aborts the previous attempt instead of letting a
 * stale result overwrite newer state.
 */
export function createCommunityLocationRequester(
  locate: (signal: AbortSignal) => Promise<Gcj02Point> = (signal) => requestCommunityLocation({ signal }),
): CommunityLocationRequester {
  let controller: AbortController | null = null
  let flight: Promise<Gcj02Point> | null = null

  const clear = (promise: Promise<Gcj02Point>) => {
    if (flight !== promise) return
    flight = null
    controller = null
  }

  return {
    get pending() {
      return flight !== null
    },
    request() {
      if (flight) return flight
      const current = new AbortController()
      let promise: Promise<Gcj02Point>
      try {
        promise = locate(current.signal)
      } catch (cause) {
        promise = Promise.reject(cause)
      }
      controller = current
      flight = promise
      void promise.then(() => clear(promise), () => clear(promise))
      return promise
    },
    cancel() {
      const current = controller
      controller = null
      flight = null
      current?.abort()
    },
  }
}
