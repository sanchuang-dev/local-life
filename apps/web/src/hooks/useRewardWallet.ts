import { reportResidentSessionExpired } from '../services/residentSessionEvents'
import { useCallback, useEffect, useState } from 'react'
import {
  ACTIVITY_ROUTES,
  apiErrorSchema,
  publicActivityListResponseSchema,
  type PublicActivitySummary,
  type TeamRewardState,
} from '@sanchuang-dev/local-life-contracts'
import { getTeamRewardState, isRewardApiError } from '../services/rewards'
import { rewardBucketOf, type RewardBucket } from '../components/activity/rewardLabels'

/**
 * One row of the resident reward wallet: the activity it belongs to plus the
 * real team-reward state the server returned for it.
 */
export type RewardWalletEntry = {
  activityId: string
  activityTitle: string
  activityStatus: PublicActivitySummary['status']
  communityName: string
  reward: TeamRewardState
  bucket: RewardBucket
}

export type RewardWalletState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: RewardWalletEntry[] }

/** Public activities read per wallet load; the MVP runs a handful of activities. */
const MAX_ACTIVITIES = 12

/**
 * Reads the resident wallet.
 *
 * There is deliberately no cross-activity wallet endpoint in the contracts, so
 * this composes existing ones: the public activity list, then the per-activity
 * team-reward state. An activity the resident did not join answers 409
 * `reward_unavailable` and is skipped — that is a normal answer, not an error.
 * Any other failure (401/403/5xx) aborts the whole load so the page can never
 * present a partial list as the complete truth.
 */
export function useRewardWallet({
  sessionKey,
  authLoading,
}: {
  sessionKey: string | null
  authLoading: boolean
}) {
  const [state, setState] = useState<RewardWalletState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    if (authLoading) {
      setState({ status: 'loading' })
      return
    }
    if (!sessionKey) {
      setState({ status: 'unauthenticated' })
      return
    }

    let active = true
    const controller = new AbortController()

    const load = async () => {
      setState({ status: 'loading' })
      try {
        const listResponse = await fetch(`/api${ACTIVITY_ROUTES.publicList}`, {
          signal: controller.signal,
          credentials: 'include',
          cache: 'no-store',
        })
        if (!listResponse.ok) {
          const payload: unknown = await listResponse.json().catch(() => null)
          const parsed = apiErrorSchema.safeParse(payload)
          throw new Error(
            parsed.success
              ? parsed.data.error.message
              : `活动列表请求失败（HTTP ${listResponse.status}）`,
          )
        }
        const parsedList = publicActivityListResponseSchema.safeParse(await listResponse.json())
        if (!parsedList.success) throw new Error('活动列表数据格式异常，无法安全展示')

        const activities = parsedList.data.items.slice(0, MAX_ACTIVITIES)

        const settled = await Promise.all(
          activities.map(async (activity) => {
            try {
              const reward = await getTeamRewardState(activity.id, controller.signal)
              return { activity, reward }
            } catch (cause) {
              // No team yet / no plan / not published: the resident simply has no
              // wallet entry here. Real authorization and server failures still throw.
              if (isRewardApiError(cause) && cause.status === 409) return null
              throw cause
            }
          }),
        )

        if (!active) return
        const entries: RewardWalletEntry[] = settled
          .filter((item): item is { activity: PublicActivitySummary; reward: TeamRewardState } =>
            item !== null,
          )
          .map(({ activity, reward }) => ({
            activityId: activity.id,
            activityTitle: activity.title,
            activityStatus: activity.status,
            communityName: activity.community.name,
            reward,
            bucket: rewardBucketOf(reward),
          }))

        setState({ status: 'ready', entries })
      } catch (cause) {
        if (!active || controller.signal.aborted) return
        if (isRewardApiError(cause) && cause.status === 401) {
          reportResidentSessionExpired()
          setState({ status: 'unauthenticated' })
          return
        }
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法读取我的奖励',
        })
      }
    }

    void load()

    return () => {
      active = false
      controller.abort()
    }
  }, [sessionKey, authLoading, reloadToken])

  return { state, reload }
}
