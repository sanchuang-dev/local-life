import { useEffect, useRef, useState } from 'react'
import { Gift, RefreshCw, Ticket, Sparkles } from 'lucide-react'
import { Link } from 'react-router'
import type {
  PublicActivityDrawPool,
  ResidentDrawAttempt,
  ResidentDrawState,
} from '@sanchuang-dev/local-life-contracts'
import { buildResidentLoginHref } from '../auth/residentLogin'
import { drawUnavailableText, drawCredentialStatusText } from '../../lib/drawUi'
import { newIdempotencyKey, describeLocalError } from '../../services/localApi'
import {
  enterResidentDraw,
  getPublicDrawPool,
  getResidentDrawHistory,
  getResidentDrawState,
} from '../../services/draw'

type History = Awaited<ReturnType<typeof getResidentDrawHistory>>
type ReadyData = {
  pool: PublicActivityDrawPool
  status: ResidentDrawState
  history: History | null
}
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: ReadyData }

/**
 * The animation is decoration only. The server owns each result, availability,
 * per-resident quota and inventory. A pending idempotency key survives a network
 * error/reload in sessionStorage, scoped to this activity and this resident.
 */
export function DailyDrawCard({
  activityId,
  userId,
  csrfToken,
  authLoading,
  inviteCode,
  inviteInvalid,
}: {
  activityId: string
  userId: string | null
  csrfToken: string | null
  authLoading: boolean
  inviteCode: string | null
  inviteInvalid: boolean
}) {
  const [view, setView] = useState<LoadState>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<ResidentDrawAttempt | null>(null)
  const [copied, setCopied] = useState(false)
  const storageKey = userId ? 'll-draw-pending:' + userId + ':' + activityId : null

  useEffect(() => {
    setView({ kind: 'loading' })
    setLastResult(null)
    setError(null)
  }, [activityId, userId])

  useEffect(() => {
    if (authLoading) {
      setView({ kind: 'loading' })
      return
    }
    let active = true
    const controller = new AbortController()
    setView({ kind: 'loading' })
    const load = async () => {
      try {
        const [pool, status, history] = await Promise.all([
          getPublicDrawPool(activityId, controller.signal),
          getResidentDrawState(activityId, controller.signal),
          userId ? getResidentDrawHistory(activityId, controller.signal) : Promise.resolve(null),
        ])
        if (active) setView({ kind: 'ready', data: { pool, status, history } })
      } catch (cause) {
        if (!active || controller.signal.aborted) return
        setView({ kind: 'error', message: describeLocalError(cause, '抽奖服务暂时不可用') })
      }
    }
    void load()
    return () => { active = false; controller.abort() }
  }, [activityId, userId, authLoading, reload])

  const runDraw = async () => {
    if (busyRef.current || !storageKey || !csrfToken || view.kind !== 'ready' || !view.data.status.available) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    setCopied(false)
    // Reuse an unresolved key on network failure instead of creating a second draw.
    const key = window.sessionStorage.getItem(storageKey) || newIdempotencyKey()
    try {
      window.sessionStorage.setItem(storageKey, key)
      const outcome = await enterResidentDraw(activityId, csrfToken, key)
      window.sessionStorage.removeItem(storageKey)
      setLastResult(outcome)
      setReload((value) => value + 1)
    } catch (cause) {
      setError(describeLocalError(cause, '抽奖请求未确认，可使用原请求重试。'))
      // 4xx errors may reflect the actual server state; refresh before allowing another attempt.
      setReload((value) => value + 1)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const data = view.kind === 'ready' ? view.data : null
  const state = data?.status
  const latestToday = data?.history?.attempts.find((attempt) => attempt.day === state?.day) ?? null
  const displayed = lastResult && lastResult.day === state?.day ? lastResult : latestToday
  const activeAwards = data?.history?.activeAwards ?? []
  const loginTarget = '/community/activity/silver-neighborhood?activityId='
    + encodeURIComponent(activityId)
    + (inviteCode ? '&invite=' + encodeURIComponent(inviteCode) : '')
  const loginHref = buildResidentLoginHref(loginTarget, {
    activityId, inviteCode, inviteInvalid,
  })
  const disabled = busy || !state?.available
  const activeCode = displayed?.credential?.status === 'active' ? displayed.credential.code : null

  const copyCode = async () => {
    if (!activeCode) return
    try {
      await navigator.clipboard.writeText(activeCode)
      setCopied(true)
    } catch {
      setError('复制失败，请手动记录核销码。')
    }
  }

  return (
    <section className="mx-4 mt-5 rounded-[20px] border border-[#cfe7d6] bg-white p-4 shadow-sm"
      aria-labelledby="daily-draw-heading">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold tracking-[0.14em] text-[#22835a]">DAILY DRAW</p>
          <h2 id="daily-draw-heading" className="mt-1 text-[19px] font-bold text-[#22543d]">今日抽奖</h2>
        </div>
        <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-[#edf8f0] text-teal-700">
          <Gift size={23} aria-hidden="true" />
        </span>
      </div>

      {view.kind === 'loading' ? (
        <p className="mt-4 text-[12px] text-slate-600" role="status">正在读取今日奖品与抽奖资格…</p>
      ) : null}
      {view.kind === 'error' ? (
        <div className="mt-3 rounded-xl bg-[#fff4e8] p-3" role="alert">
          <p className="text-[12px] text-[#8a552a]">{view.message}</p>
          <button type="button" className="mt-2 min-h-[44px] rounded-lg px-3 text-[12px] font-semibold text-[#805026]"
            onClick={() => setReload((value) => value + 1)}>
            <RefreshCw size={14} className="mr-1 inline" />重新读取
          </button>
        </div>
      ) : null}

      {data ? (
        <>
          {data.pool.available && data.pool.prizes.length > 0 ? (
            <ul className="mt-4 grid grid-cols-2 gap-2" aria-label="今日可抽奖品">
              {data.pool.prizes.map((prize) => (
                <li key={prize.id} className="min-w-0 overflow-hidden rounded-[14px] border border-[#e1ede3] bg-[#fbfdfb]">
                  {prize.imageUrl ? (
                    <img src={prize.imageUrl} alt={prize.name} loading="lazy"
                      className="aspect-[4/3] w-full bg-slate-50 object-cover" />
                  ) : (
                    <div className="flex aspect-[4/3] items-center justify-center bg-[#edf8f0] text-teal-700">
                      <Gift size={26} aria-hidden="true" />
                    </div>
                  )}
                  <div className="p-2.5">
                    <p className="break-words text-[12px] font-bold text-slate-800">{prize.name}</p>
                    <p className="mt-1 text-[11px] text-slate-500">剩余 {prize.remainingQuantity} 份</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {state ? (
            <div className="mt-3 rounded-[12px] bg-[#f2f8f4] px-3 py-3 text-[12px] text-[#456a53]">
              {state.available ? (
                <p>今天还可抽 <strong className="text-[#17663a]">{state.remainingToday}</strong> 次
                  <span className="ml-1 text-[11px] text-slate-500">（北京时间）</span>
                </p>
              ) : (
                <p role="status">{drawUnavailableText(state.unavailableReason)}</p>
              )}
            </div>
          ) : null}

          {!userId && !authLoading ? (
            <Link to={loginHref} className="mt-3 flex min-h-[48px] items-center justify-center rounded-[13px] bg-teal-700 px-4 text-[14px] font-bold text-white">
              登录后参与抽奖
            </Link>
          ) : (
            <button type="button" onClick={() => void runDraw()} disabled={disabled}
              className="mt-3 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[13px] bg-teal-700 px-4 text-[14px] font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600">
              <Sparkles size={18} aria-hidden="true" />
              {busy ? '正在开奖…' : state?.available ? '抽一次' : '暂不能抽奖'}
            </button>
          )}
          <p className="mt-2 text-[11px] leading-5 text-slate-500">
            中奖由系统实际开奖，未中奖也会计入当天抽奖次数。奖品以页面显示的真实奖品池为准。
          </p>

          {displayed ? (
            <div className="mt-4 rounded-[14px] border border-[#d5e9d9] bg-[#f5faf6] p-3" role="status" aria-live="polite">
              <p className="text-[13px] font-bold text-[#22543d]">
                {displayed.outcome === 'won' ? '恭喜中奖！' : '这次没有中奖'}
              </p>
              <p className="mt-1 text-[12px] leading-5 text-slate-600">
                {displayed.outcome === 'won' ? displayed.prize?.name : '结果已记录在今天的抽奖历史中。'}
              </p>
              {displayed.credential ? (
                <div className="mt-2">
                  <p className="text-[11px] text-slate-600">
                    核销状态：{drawCredentialStatusText(displayed.credential.status)}
                  </p>
                  {activeCode ? (
                    <>
                      <p className="mt-1 break-all font-mono text-[15px] font-bold tracking-wider text-[#17663a]">
                        <Ticket size={14} className="mr-1 inline" />{activeCode}
                      </p>
                      <button type="button" className="mt-2 min-h-[44px] rounded-xl bg-white px-4 text-[12px] font-semibold text-teal-700"
                        onClick={() => void copyCode()}>
                        {copied ? '已复制' : '复制核销码'}
                      </button>
                    </>
                  ) : (
                    <p className="mt-1 text-[11px] text-slate-500">凭据尾号 {displayed.credential.codeSuffix}</p>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {activeAwards.length > 0 ? (
            <p className="mt-3 text-[12px] text-slate-600">
              你还有 <strong>{activeAwards.length}</strong> 份待核销奖品，可到「我的奖励」查看。
            </p>
          ) : null}
          {error ? (
            <div className="mt-3 rounded-[12px] border border-[#e9d0b9] bg-[#fff7f0] p-3" role="alert">
              <p className="text-[12px] text-[#885432]">{error}</p>
              <p className="mt-1 text-[11px] text-[#885432]">
                网络中断后再次点击会沿用同一个请求编号，不会重新随机发奖。
              </p>
            </div>
          ) : null}
          <Link to="/me/rewards" state={{ from: loginTarget }}
            className="mt-3 flex min-h-[44px] items-center justify-center text-[13px] font-semibold text-teal-700">
            我的奖励与中奖记录
          </Link>
        </>
      ) : null}
    </section>
  )
}
