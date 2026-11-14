import { Gift, Ticket, CheckCircle2, Ban } from 'lucide-react'
import { Link } from 'react-router'
import { drawCredentialStatusText } from '../../lib/drawUi'
import type { DrawWalletEntry } from '../../hooks/useRewardWallet'

/** Draw awards remain separate from team grants and are never inferred from a random animation. */
export function DrawWalletSection({ entries }: { entries: DrawWalletEntry[] }) {
  if (entries.length === 0) return null
  return (
    <section className="mt-5" aria-labelledby="draw-wallet-heading">
      <div className="mb-3">
        <p className="text-[11px] font-bold tracking-[0.14em] text-teal-700">DAILY DRAW</p>
        <h2 id="draw-wallet-heading" className="mt-1 text-[18px] font-bold text-slate-900">
          今日抽奖 · 我的中奖
        </h2>
      </div>
      <ul className="grid gap-3">
        {entries.map(({ activityId, activityTitle, communityName, attempt }) => {
          const credential = attempt.credential
          const status = credential?.status
          return (
            <li key={attempt.id} className="rounded-2xl border border-teal-100 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 break-words text-[13px] font-semibold text-slate-800">{activityTitle}</p>
                <span className="shrink-0 rounded-full bg-[#e8f6f0] px-2.5 py-1 text-[11px] font-bold text-teal-700">
                  {drawCredentialStatusText(status)}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">{communityName} · 抽奖奖励</p>
              <div className="mt-3 flex items-center gap-3">
                {attempt.prize?.imageUrl ? (
                  <img src={attempt.prize.imageUrl} alt={attempt.prize.name}
                    className="h-14 w-14 shrink-0 rounded-xl bg-slate-50 object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[#f1f8f3] text-teal-700">
                    <Gift size={24} aria-hidden="true" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="break-words text-[15px] font-bold text-[#225b44]">{attempt.prize?.name ?? '抽奖奖品'}</p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {new Date(attempt.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 获得
                  </p>
                </div>
              </div>
              {credential?.code && status === 'active' ? (
                <div className="mt-3 rounded-xl bg-[#eef8f1] px-3 py-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-medium text-teal-700"><Ticket size={14} />核销凭据</p>
                  <p className="mt-1 break-all font-mono text-[16px] font-bold tracking-wider text-[#145333]">{credential.code}</p>
                  <p className="mt-1 text-[11px] text-slate-600">到现场出示此码，由工作人员核验并核销。勿公开分享。</p>
                </div>
              ) : credential ? (
                <p className="mt-3 flex items-center gap-1.5 text-[12px] text-slate-500">
                  {status === 'redeemed' ? <CheckCircle2 size={15} /> : <Ban size={15} />}
                  {drawCredentialStatusText(status)} · 凭据尾号 {credential.codeSuffix}
                </p>
              ) : null}
              <Link
                to={'/community/activity/silver-neighborhood?activityId=' + encodeURIComponent(activityId)}
                state={{ from: '/me/rewards' }}
                className="mt-3 flex min-h-[44px] items-center justify-center rounded-xl bg-[#f2f7f4] px-3 text-[13px] font-semibold text-teal-700"
              >
                查看活动与抽奖记录
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
