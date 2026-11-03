import { useCallback, useEffect, useState } from 'react'
import {
  ACTIVITY_ROUTES,
  apiErrorSchema,
  publicActivityDetailSchema,
  publicActivityListResponseSchema,
  type PublicActivityDetail,
} from '@sanchuang-dev/local-life-contracts'

/** The public endpoints live under the same `/api` prefix the H5 already uses. */
const API_PREFIX = '/api'

/**
 * Resident-facing activity read state. Every state is explicit so the page can
 * render a real loading, empty, error or ready view without falling back to mock
 * data that would pretend the request succeeded.
 */
export type PublicActivityLoadState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error'; message: string }
  | { status: 'ready'; activity: PublicActivityDetail }

async function readErrorMessage(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null)
  const parsed = apiErrorSchema.safeParse(payload)
  if (parsed.success) return parsed.data.error.message
  return `活动数据请求失败（HTTP ${response.status}）`
}

function publicDetailPath(activityId: string): string {
  return ACTIVITY_ROUTES.publicDetail.replace(':activityId', encodeURIComponent(activityId))
}

/**
 * Read the published activity visible to residents.
 *
 * A deep link may carry `?activityId=<uuid>`; that activity is read directly.
 * Otherwise the first published activity from the public list is opened. The
 * response is parsed with the shared contract schema, so a drifted API payload
 * surfaces as a real error instead of being rendered half-broken.
 */
export function usePublicActivity(requestedActivityId: string | null) {
  const [state, setState] = useState<PublicActivityLoadState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  const retry = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    let active = true
    const controller = new AbortController()

    const load = async () => {
      setState({ status: 'loading' })

      try {
        let activityId = requestedActivityId

        if (!activityId) {
          const listResponse = await fetch(`${API_PREFIX}${ACTIVITY_ROUTES.publicList}`, {
            signal: controller.signal,
            credentials: 'same-origin',
            cache: 'no-store',
          })
          if (!listResponse.ok) throw new Error(await readErrorMessage(listResponse))

          const parsedList = publicActivityListResponseSchema.safeParse(await listResponse.json())
          if (!parsedList.success) throw new Error('活动列表数据格式异常，无法安全展示')

          if (parsedList.data.items.length === 0) {
            if (active) setState({ status: 'empty' })
            return
          }

          activityId = parsedList.data.items[0].id
        }

        const detailResponse = await fetch(`${API_PREFIX}${publicDetailPath(activityId)}`, {
          signal: controller.signal,
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!detailResponse.ok) throw new Error(await readErrorMessage(detailResponse))

        const parsedDetail = publicActivityDetailSchema.safeParse(await detailResponse.json())
        if (!parsedDetail.success) throw new Error('活动详情数据格式异常，无法安全展示')

        if (active) setState({ status: 'ready', activity: parsedDetail.data })
      } catch (cause) {
        if (!active || controller.signal.aborted) return
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法获取活动数据',
        })
      }
    }

    void load()

    return () => {
      active = false
      controller.abort()
    }
  }, [requestedActivityId, reloadToken])

  return { state, retry }
}
