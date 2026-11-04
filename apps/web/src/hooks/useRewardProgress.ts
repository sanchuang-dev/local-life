import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActivityCheckinState,
  ActivityRewardClaimResponse,
  TeamRewardState,
} from '@sanchuang-dev/local-life-contracts'
import {
  claimTeamReward,
  getCheckinState,
  getTeamRewardState,
  isRewardApiError,
  recordCheckin,
} from '../services/rewards'

/**
 * Why the team reward is not available as a *state of the data* rather than an
 * error: "还没参与三人团" and "未配置奖励计划" are legitimate answers that the
 * page must render as information, not as a failed request.
 */
export type RewardGate =
  | { kind: 'no_team' }
  | { kind: 'plan_missing' }

export type RewardProgressData = {
  /** The resident's own check-in state, already parsed by the shared contract. */
  checkin: ActivityCheckinState
  /** `null` when the resident is not in a team yet (the API answers 409). */
  reward: TeamRewardState | null
  /** Extracted `reward_unavailable` reason for the no-team case. */
  gate: RewardGate | null
}

export type RewardProgressState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: RewardProgressData }

export type RewardActionOutcome =
  | { ok: true }
  | { ok: false; message: string; code: string | null; status: number | null }

type UseRewardProgressOptions = {
  /** Real activity id, or null while the activity itself is still loading. */
  activityId: string | null
  /** Session CSRF token; a write without it must not be attempted. */
  csrfToken: string | null
  /** Session identity key. A changed key (login/logout) re-reads the state. */
  sessionKey: string | null
  /** True while the account session is still being read. */
  authLoading: boolean
}

const UNAVAILABLE_MESSAGES: Record<string, string> = {
  reward_plan_not_configured: '本活动暂未配置正式奖励计划，奖励入口未开放。',
  activity_not_published: '活动尚未发布，奖励暂不可领取。',
  activity_ended: '活动已结束，奖励暂不可领取。',
  team_incomplete: '团队还未满 3 人，暂不满足奖励条件。',
  checkin_incomplete: '团队有效签到不足 3 条，暂不满足奖励条件。',
  stock_exhausted: '奖品库存已发放完，暂不可领取。',
  budget_exhausted: '活动奖励预算已用完，暂不可领取。',
}

/** Human-readable explanation for a structured reason from the reward contract. */
export function rewardUnavailableText(reason: string | null | undefined): string {
  if (!reason) return '当前暂不满足奖励条件。'
  return UNAVAILABLE_MESSAGES[reason] ?? '当前暂不满足奖励条件。'
}

function notAuthenticated(cause: unknown): boolean {
  return isRewardApiError(cause) && cause.status === 401
}

/**
 * Real check-in and team-reward progress for one activity.
 *
 * The two reads are independent server truths: `checkinState` always answers 200
 * with an explicit `available`/`unavailableReason` pair, while `teamReward`
 * answers 409 `reward_unavailable` for a resident who has not joined a team yet.
 * That 409 is a normal state ("还没组队"), not an error, so it is folded into
 * `gate` instead of blanking the whole section.
 */
export function useRewardProgress({
  activityId,
  csrfToken,
  sessionKey,
  authLoading,
}: UseRewardProgressOptions) {
  const [state, setState] = useState<RewardProgressState>({ status: 'idle' })
  const [reloadToken, setReloadToken] = useState(0)
  const [busy, setBusy] = useState<'checkin' | 'claim' | null>(null)
  const inFlight = useRef(false)

  const refresh = useCallback(() => setReloadToken((token) => token + 1), [])

  useEffect(() => {
    if (!activityId || authLoading) {
      setState({ status: 'idle' })
      return
    }
    // Without a session the API answers 401; a visitor who only opened a shared
    // link must not be shown an invented progress or an empty reward list.
    if (!sessionKey) {
      setState({ status: 'unauthenticated' })
      return
    }

    let active = true
    const controller = new AbortController()

    const load = async () => {
      setState({ status: 'loading' })
      try {
        const [checkin, reward] = await Promise.all([
          getCheckinState(activityId, controller.signal),
          getTeamRewardState(activityId, controller.signal).catch((cause: unknown) => {
            if (notAuthenticated(cause)) throw cause
            if (isRewardApiError(cause) && cause.status === 409) return null
            throw cause
          }),
        ])
        if (!active) return
        setState({
          status: 'ready',
          data: {
            checkin,
            reward,
            gate: reward
              ? reward.planConfigured
                ? null
                : { kind: 'plan_missing' }
              : { kind: 'no_team' },
          },
        })
      } catch (cause) {
        if (!active || controller.signal.aborted) return
        if (notAuthenticated(cause)) {
          setState({ status: 'unauthenticated' })
          return
        }
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : '暂时无法读取签到与奖励状态',
        })
      }
    }

    void load()

    return () => {
      active = false
      controller.abort()
    }
  }, [activityId, sessionKey, authLoading, reloadToken])

  /** Applies a fresh check-in state returned by the write endpoint. */
  const applyCheckin = useCallback((checkin: ActivityCheckinState) => {
    setState((previous) =>
      previous.status === 'ready'
        ? {
            status: 'ready',
            data: {
              ...previous.data,
              checkin,
            },
          }
        : previous,
    )
  }, [])

  const checkIn = useCallback(async (): Promise<RewardActionOutcome> => {
    if (!activityId || !csrfToken) {
      return { ok: false, message: '请先登录居民账户后再签到。', code: 'unauthorized', status: 401 }
    }
    if (inFlight.current) {
      return { ok: false, message: '正在提交，请勿重复点击。', code: null, status: null }
    }
    inFlight.current = true
    setBusy('checkin')
    try {
      const next = await recordCheckin(csrfToken, activityId)
      applyCheckin(next)
      return { ok: true }
    } catch (cause) {
      if (isRewardApiError(cause)) {
        if (cause.status === 401) setState({ status: 'unauthenticated' })
        return { ok: false, message: cause.message, code: cause.code, status: cause.status }
      }
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : '签到请求未完成，请稍后重试。',
        code: null,
        status: null,
      }
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }, [activityId, csrfToken, applyCheckin])

  /**
   * Claims the team prize. The plaintext code appears exactly once, in this
   * response, so it is returned to the caller for a one-time display and never
   * stored anywhere else.
   */
  const claim = useCallback(async (): Promise<
    { ok: true; result: ActivityRewardClaimResponse } | { ok: false; message: string }
  > => {
    if (!activityId || !csrfToken) {
      return { ok: false, message: '请先登录居民账户后再领取。' }
    }
    if (inFlight.current) return { ok: false, message: '正在提交，请勿重复点击。' }
    inFlight.current = true
    setBusy('claim')
    try {
      const result = await claimTeamReward(csrfToken, activityId)
      // The claim response is the new server truth for the credential; re-read
      // the qualification so the button state and stock copy cannot drift.
      setReloadToken((token) => token + 1)
      return { ok: true, result }
    } catch (cause) {
      if (isRewardApiError(cause)) return { ok: false, message: cause.message }
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : '领取请求未完成，请稍后重试。',
      }
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }, [activityId, csrfToken])

  return { state, refresh, checkIn, claim, busy }
}
