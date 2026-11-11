import { reportResidentSessionExpired } from '../services/residentSessionEvents'
import { useCallback, useEffect, useState } from 'react'
import {
  ACTIVITY_ROUTES,
  apiErrorSchema,
  publicActivityListResponseSchema,
  type PublicActivitySummary,
  type TeamRewardState,
  type ResidentDrawAttempt,
} from '@sanchuang-dev/local-life-contracts'
import { getTeamRewardState, isRewardApiError } from '../services/rewards'
import { getResidentDrawHistory } from '../services/draw'
import { distinctDrawWins } from '../lib/drawUi'
import { isLocalApiError } from '../services/localApi'
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

export type DrawWalletEntry = {
  activityId: string
  activityTitle: string
  communityName: string
  attempt: ResidentDrawAttempt
}

export type RewardWalletState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: RewardWalletEntry[]; drawEntries: DrawWalletEntry[] }

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
            // Team reward and draw awards are separate ledgers. A resident who
            // never joined a team can still have won an actual draw prize.
            const [reward, drawHistory] = await Promise.all([
              getTeamRewardState(activity.id, controller.signal).catch((cause: unknown) => {
                if (isRewardApiError(cause) && cause.status === 409) return null
                throw cause
              }),
              getResidentDrawHistory(activity.id, controller.signal),
            ])
            return { activity, reward, drawHistory }
          }),
        )

        if (!active) return
        const entries: RewardWalletEntry[] = []
        const drawEntries: DrawWalletEntry[] = []
        for (const { activity, reward, drawHistory } of settled) {
          if (reward) {
            entries.push({
              activityId: activity.id,
              activityTitle: activity.title,
              activityStatus: activity.status,
              communityName: activity.community.name,
              reward,
              bucket: rewardBucketOf(reward),
            })
          }
          for (const attempt of distinctDrawWins(drawHistory.attempts, drawHistory.activeAwards)) {
            drawEntries.push({
              activityId: activity.id,
              activityTitle: activity.title,
              communityName: activity.community.name,
              attempt,
            })
          }
        }
        drawEntries.sort((a, b) => b.attempt.createdAt.localeCompare(a.attempt.createdAt))
        setState({ status: 'ready', entries, drawEntries })
      } catch (cause) {
        if (!active || controller.signal.aborted) return
        if ((isRewardApiError(cause) || isLocalApiError(cause)) && cause.status === 401) {
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
