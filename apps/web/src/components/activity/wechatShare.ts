import type { PublicActivityDetail } from '@sanchuang-dev/local-life-contracts'

/** Minimum WeChat JS-SDK surface required by the real activity share flow. */
export interface WechatShareData {
  title: string
  desc: string
  link: string
  imgUrl: string
}

export interface WechatSdk {
  config(config: {
    debug: false
    appId: string
    timestamp: number
    nonceStr: string
    signature: string
    jsApiList: string[]
  }): void
  ready(callback: () => void): void
  error(callback: (error: unknown) => void): void
  updateAppMessageShareData(data: WechatShareData & { fail?: () => void }): void
  updateTimelineShareData(data: Omit<WechatShareData, 'desc'> & { fail?: () => void }): void
}

export function isWechatBrowser(userAgent: string): boolean {
  return /MicroMessenger/i.test(userAgent)
}

/**
 * Build the WeChat payload from the same real URL used by QR and copy.
 * The caller owns invite eligibility; this utility NEVER generates invite codes.
 * With no eligible invite, use the existing activity-only URL.
 */
export function createWechatActivityShareData(
  activity: Pick<PublicActivityDetail, 'title' | 'summary'>,
  link: string,
  origin: string,
  baseUrl: string,
): WechatShareData {
  return {
    title: activity.title,
    desc: activity.summary?.trim() || '来社区一起参加活动，认识更多街坊。',
    link,
    imgUrl: new URL(`${baseUrl}images/silver-neighborhood-hero.webp`, origin).href,
  }
}

const WECHAT_SDK_SCRIPT = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js'
let loadingScript: Promise<WechatSdk> | null = null

declare global {
  interface Window {
    wx?: WechatSdk
  }
}

/** One official script per page session; failed loads may be retried. */
export function loadWechatSdk(): Promise<WechatSdk> {
  if (window.wx) return Promise.resolve(window.wx)
  if (loadingScript) return loadingScript

  loadingScript = new Promise<WechatSdk>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = WECHAT_SDK_SCRIPT
    script.async = true
    let finished = false
    const finish = (sdk?: WechatSdk) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (sdk) resolve(sdk)
      else {
        script.remove()
        reject(new Error('WeChat JS-SDK failed to load'))
      }
    }
    const timer = window.setTimeout(() => finish(), 10_000)
    script.onload = () => finish(window.wx)
    script.onerror = () => finish()
    document.head.appendChild(script)
  }).catch((error: unknown) => {
    loadingScript = null
    throw error
  })
  return loadingScript
}

export interface JsSdkSignature {
  appId: string
  timestamp: number
  nonceStr: string
  signature: string
}

/**
 * Config and share-menu registration are performed only after wx.ready.
 * wx.error and share API fail callbacks report actual failure to the hook;
 * neither method attempts to launch an unsupported native sharing dialog.
 */
export function configureWechatActivityShare(
  sdk: WechatSdk,
  signature: JsSdkSignature,
  data: WechatShareData,
  isCurrent: () => boolean,
  onError: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (isCurrent()) reject(new Error('WeChat JS-SDK ready timeout'))
      else resolve()
    }, 10_000)
    const fail = () => {
      if (!isCurrent()) return
      clearTimeout(timer)
      onError()
      reject(new Error('WeChat JS-SDK config or share registration failed'))
    }

    sdk.error(fail)
    sdk.ready(() => {
      if (!isCurrent()) {
        clearTimeout(timer)
        resolve()
        return
      }
      try {
        // Timeline supports title/link/imgUrl; the friend card also has desc.
        sdk.updateAppMessageShareData({ ...data, fail })
        sdk.updateTimelineShareData({
          title: data.title,
          link: data.link,
          imgUrl: data.imgUrl,
          fail,
        })
        clearTimeout(timer)
        resolve()
      } catch {
        fail()
      }
    })
    try {
      sdk.config({
        debug: false,
        ...signature,
        jsApiList: ['updateAppMessageShareData', 'updateTimelineShareData'],
      })
    } catch {
      fail()
    }
  })
}
