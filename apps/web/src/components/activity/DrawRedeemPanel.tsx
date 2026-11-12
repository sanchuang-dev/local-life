import { useEffect, useState } from 'react'
import { BadgeCheck, TicketCheck } from 'lucide-react'
import type { DrawStaffCredential, PublicActivitySummary } from '@sanchuang-dev/local-life-contracts'
import { useStaffSession } from '../../hooks/useStaffSession'
import { verifyStaffDrawCode, redeemStaffDrawCode } from '../../services/draw'
import { describeLocalError } from '../../services/localApi'

/** Distinct from the team's 10-character redeem code: draw codes start DL-. */
export function DrawRedeemPanel({
  activities,
  activityId,
  onSelectActivity,
}: {
  activities: PublicActivitySummary[]
  activityId: string | null
  onSelectActivity: (activityId: string) => void
}) {
  const { session } = useStaffSession()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [verified, setVerified] = useState<DrawStaffCredential | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const normalised = code.trim().toUpperCase()
  const shaped = /^DL-[0-9A-F]{24}$/.test(normalised)

  useEffect(() => {
    setVerified(null)
    setMessage(null)
    setError(null)
  }, [activityId])

  const verify = async () => {
    if (!activityId || !session?.csrfToken || !shaped || busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    setVerified(null)
    try {
      const data = await verifyStaffDrawCode(activityId, session.csrfToken, normalised)
      setVerified(data)
      if (data.status !== 'active') setMessage('该凭据已失效或核销，不能再次发奖。')
    } catch (cause) {
      setError(describeLocalError(cause, '抽奖凭据查验失败'))
    } finally { setBusy(false) }
  }

  const redeem = async () => {
    if (!activityId || !session?.csrfToken || !shaped || !verified || verified.status !== 'active' || busy) return
    setBusy(true)
    setError(null)
    try {
      const data = await redeemStaffDrawCode(activityId, session.csrfToken, normalised)
      setVerified(data)
      setMessage('奖品核销成功，已记录本次交付。')
      setCode('')
    } catch (cause) {
      setError(describeLocalError(cause, '核销失败，奖品尚未确认交付'))
    } finally { setBusy(false) }
  }

  return (
    <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm"
      aria-labelledby="draw-redeem-heading">
      <h2 id="draw-redeem-heading" className="flex items-center gap-2 text-[15px] font-semibold text-slate-800">
        <TicketCheck size={19} className="text-teal-700" />今日抽奖 · 奖品核销
      </h2>
      <p className="mt-2 text-[12px] leading-5 text-slate-500">
        请选择居民参与的活动，再输入以 DL- 开头的 27 位抽奖码。
        先查验奖品，再现场确认交付并核销；同一中奖只能核销一次。
      </p>
      <label htmlFor="draw-verify-activity" className="mt-3 block text-[12px] font-bold text-slate-700">活动</label>
      <select id="draw-verify-activity" value={activityId ?? ''} onChange={(event) => onSelectActivity(event.target.value)}
        className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-200 bg-white px-3 text-[13px]"
        disabled={activities.length === 0 || busy}>
        {activities.length === 0 ? <option value="">当前没有可选择的活动</option> : null}
        {activities.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <label htmlFor="draw-redeem-code" className="mt-3 block text-[12px] font-bold text-slate-700">抽奖核销码</label>
      <input id="draw-redeem-code" name="drawCode" type="text" maxLength={27}
        value={code}
        onChange={(event) => {
          setCode(event.target.value.toUpperCase())
          setVerified(null)
          setMessage(null)
          setError(null)
        }}
        autoComplete="off" autoCapitalize="characters" spellCheck={false}
        placeholder="DL- 后跟 24 位十六进制字符"
        className="mt-1 min-h-[44px] w-full min-w-0 rounded-xl border border-slate-200 px-3 font-mono text-[12px] uppercase tracking-wider" />
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void verify()}
          disabled={!shaped || !activityId || busy}
          className="min-h-[44px] rounded-xl bg-[#e9f6ef] px-4 text-[13px] font-semibold text-teal-700 disabled:opacity-50">
          {busy ? '处理中…' : '查验凭据'}
        </button>
        <button type="button" onClick={() => void redeem()}
          disabled={!shaped || !verified || verified.status !== 'active' || busy}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-teal-700 px-4 text-[13px] font-bold text-white disabled:bg-slate-300">
          <BadgeCheck size={16} />确认交付并核销
        </button>
      </div>
      {verified ? (
        <dl className="mt-3 rounded-xl bg-[#f2f8f4] p-3 text-[12px] leading-6 text-slate-700">
          <div className="flex justify-between gap-2"><dt>奖品</dt><dd className="break-words text-right font-bold">{verified.prizeName}</dd></div>
          <div className="flex justify-between gap-2"><dt>状态</dt><dd>{verified.status === 'active' ? '待核销' : verified.status === 'redeemed' ? '已核销' : '已作废'}</dd></div>
          <div className="flex justify-between gap-2"><dt>凭据尾号</dt><dd className="font-mono">{verified.codeSuffix}</dd></div>
        </dl>
      ) : null}
      {message ? <p className="mt-3 rounded-xl bg-[#edf8f0] p-3 text-[12px] text-teal-800" role="status">{message}</p> : null}
      {error ? <p className="mt-3 rounded-xl bg-[#fff4eb] p-3 text-[12px] text-[#875231]" role="alert">{error}</p> : null}
    </section>
  )
}
