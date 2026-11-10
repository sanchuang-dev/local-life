import { useEffect, useMemo, useState } from 'react'
import {
  API_ROUTES,
  wechatJsSdkSignatureResponseSchema,
  type PublicActivityDetail,
} from '@sanchuang-dev/local-life-contracts'
import { buildActivityShareUrl } from '../components/activity/share'
import {
  configureWechatActivityShare,
  createWechatActivityShareData,
  isWechatBrowser,
  loadWechatSdk,
} from '../components/activity/wechatShare'

export type WechatShareStatus = 'outside' | 'idle' | 'loading' | 'ready' | 'error'

/**
 * Both real H5 activity entry points use this hook. It initializes WeChat's
 * native share menu from the page's actual URL, not the invite destination URL.
 * Team eligibility remains in each page's existing shareUrl calculation.
 */
export function useWechatActivityShare(
  activity: PublicActivityDetail | null,
  inviteShareUrl: string | null,
): { isWechat: boolean; status: WechatShareStatus } {
  const isWechat = typeof navigator !== 'undefined' && isWechatBrowser(navigator.userAgent)
  const [status, setStatus] = useState<WechatShareStatus>(isWechat ? 'idle' : 'outside')

  const activityId = activity?.id ?? null
  const activityTitle = activity?.title ?? ''
  const activitySummary = activity?.summary ?? null

  // No open team / full / ineligible: share the public activity without an
  // invite parameter. Never carry an old invite code into a new team state.
  const activityOnlyUrl = activityId ? buildActivityShareUrl(activityId, null) : null
  const targetUrl = inviteShareUrl ?? activityOnlyUrl

  const payload = useMemo(() => {
    if (!activityId || !targetUrl) return null
    return createWechatActivityShareData(
      { title: activityTitle, summary: activitySummary },
      targetUrl,
      window.location.origin,
      import.meta.env.BASE_URL,
    )
  }, [activityId, activityTitle, activitySummary, targetUrl])

  useEffect(() => {
    if (!isWechat) {
      setStatus('outside')
      return
    }
    if (!payload) {
      setStatus('idle')
      return
    }

    let current = true
    let failed = false
    setStatus('loading')

    const initialize = async () => {
      try {
        // #122 strictly checks Origin and page URL. The share destination may
        // contain activityId/invite and must NEVER replace the signing URL.
        const response = await fetch(`/api${API_ROUTES.wechatJsSdkSignature}`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: window.location.href.split('#')[0] }),
        })
        if (!response.ok) throw new Error('WeChat signing unavailable')
        const parsed = wechatJsSdkSignatureResponseSchema.safeParse(await response.json())
        if (!parsed.success) throw new Error('Invalid WeChat signing response')

        const sdk = await loadWechatSdk()
        if (!current) return
        await configureWechatActivityShare(
          sdk,
          parsed.data,
          payload,
          () => current,
          () => {
            failed = true
            if (current) setStatus('error')
          },
        )
        if (current && !failed) setStatus('ready')
      } catch {
        if (current) setStatus('error')
      }
    }

    void initialize()
    return () => { current = false }
  }, [isWechat, payload])

  return { isWechat, status }
}
