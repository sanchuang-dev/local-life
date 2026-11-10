import {
  API_ROUTES,
  wechatJsSdkSignatureResponseSchema,
} from '@sanchuang-dev/local-life-contracts'
import { isWechatBrowser, loadWechatSdk, type WechatSdk } from '../components/activity/wechatShare'
import { wgs84ToGcj02, type Gcj02Point } from './communityCoordinates'

interface LocationWechatSdk extends WechatSdk {
  getLocation(options: {
    type: 'gcj02'
    success: (result: { latitude: number; longitude: number }) => void
    fail: (error: unknown) => void
    cancel: () => void
  }): void
}

async function getWechatLocation(): Promise<Gcj02Point> {
  // #122 signs exactly the current H5 URL; no client-controlled community is involved.
  const response = await fetch(`/api${API_ROUTES.wechatJsSdkSignature}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify({ url: window.location.href.split('#')[0] }),
  })
  if (!response.ok) throw new Error('微信定位服务暂不可用，可手动选择社区')
  const signature = wechatJsSdkSignatureResponseSchema.safeParse(await response.json())
  if (!signature.success) throw new Error('微信定位签名异常，可手动选择社区')
  const sdk = await loadWechatSdk() as LocationWechatSdk
  return new Promise<Gcj02Point>((resolve, reject) => {
    let done = false
    const finish = (point?: Gcj02Point) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      if (point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)) resolve(point)
      else reject(new Error('未能获取位置，可手动选择社区'))
    }
    const timer = window.setTimeout(() => finish(), 12_000)
    sdk.error(() => finish())
    sdk.ready(() => {
      if (typeof sdk.getLocation !== 'function') return finish()
      try {
        sdk.getLocation({
          type: 'gcj02',
          success: (result) => finish({ latitude: result.latitude, longitude: result.longitude }),
          fail: () => finish(),
          cancel: () => finish(),
        })
      } catch { finish() }
    })
    try { sdk.config({ ...signature.data, debug: false, jsApiList: ['getLocation'] }) }
    catch { finish() }
  })
}

export async function requestCommunityLocation(): Promise<Gcj02Point> {
  if (isWechatBrowser(navigator.userAgent)) return getWechatLocation()
  if (!navigator.geolocation) throw new Error('当前浏览器不支持定位，请手动选择社区')
  return new Promise<Gcj02Point>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(wgs84ToGcj02(position.coords.latitude, position.coords.longitude)),
      () => reject(new Error('无法获取当前位置，请手动选择社区')),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 30_000 },
    )
  })
}
