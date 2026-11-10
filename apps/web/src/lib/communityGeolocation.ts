import {
  API_ROUTES,
  wechatJsSdkSignatureResponseSchema,
} from '@sanchuang-dev/local-life-contracts'
import { isWechatBrowser, loadWechatSdk, type WechatSdk } from '../components/activity/wechatShare'

export interface Gcj02Point {
  latitude: number
  longitude: number
}

/** Mainland-China WGS84 -> GCJ02 conversion for browser GPS coordinates. */
const PI = Math.PI
function outOfChina(lat: number, lng: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}
function transformLat(x: number, y: number) {
  let r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x))
  r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI))*2/3
  r += (20*Math.sin(y*PI) + 40*Math.sin(y/3*PI))*2/3
  r += (160*Math.sin(y/12*PI) + 320*Math.sin(y*PI/30))*2/3
  return r
}
function transformLng(x: number, y: number) {
  let r = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x))
  r += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI))*2/3
  r += (20*Math.sin(x*PI) + 40*Math.sin(x/3*PI))*2/3
  r += (150*Math.sin(x/12*PI) + 300*Math.sin(x/30*PI))*2/3
  return r
}
export function wgs84ToGcj02(latitude: number, longitude: number): Gcj02Point {
  if (outOfChina(latitude, longitude)) return { latitude, longitude }
  const rad = latitude / 180 * PI
  const sin = Math.sin(rad)
  const magic = 1 - 0.00669342162296594323 * sin * sin
  const sqrt = Math.sqrt(magic)
  const dlat = transformLat(longitude - 105, latitude - 35) * 180 /
    ((6335552.717000426 / (magic * sqrt)) * PI)
  const dlng = transformLng(longitude - 105, latitude - 35) * 180 /
    ((6378245 / sqrt * Math.cos(rad)) * PI)
  return { latitude: latitude + dlat, longitude: longitude + dlng }
}

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
