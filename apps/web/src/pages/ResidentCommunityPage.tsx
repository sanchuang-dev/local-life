import { Home, MapPin, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router'
import { PageHeader } from '../components/PageHeader'
import { ResidentCommunityCard } from '../components/community/ResidentCommunityCard'
import { useBackTarget } from '../hooks/useBackTarget'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { useResidentCommunity } from '../hooks/useResidentCommunity'
import { BROWSE_ONLY_NOTICE, PERMANENT_BINDING_NOTICE, residentCommunityConfirmHref } from '../lib/residentCommunity'

/**
 * 我的常驻社区 — the read-only resident view (#171 LL-IDENTITY-001).
 *
 * This page answers exactly two questions: which community did I confirm, and on
 * which date. It deliberately offers no switch, unbind or rebind control; a
 * compliance correction is a separate audited back-office operation, not a
 * resident screen. Historical `resident_community_assignments` rows are listed as
 * read-only facts and are explicitly labelled as not being a confirmation.
 *
 * All of that content lives in the shared card (variant `full`) so the discovery
 * home, 我的 and this page can never drift into different promises.
 */
export function ResidentCommunityPage() {
  const { backTo, backLabel } = useBackTarget('/me', '返回我的')
  const auth = useResidentAuth()
  const residentCommunity = useResidentCommunity({
    sessionKey: auth.session?.user.id ?? null,
    authLoading: auth.loading,
  })

  // A server-derived candidate may be confirmed from here too — but only as an
  // explicit two-step action on the confirmation page, never as an automatic pick.
  const status = residentCommunity.state.status === 'ready' ? residentCommunity.state.data : null
  const confirmHref =
    status && status.status === 'unbound' && status.canConfirm && status.candidate
      ? residentCommunityConfirmHref(status.candidate.community.id)
      : null

  return (
    <div className="px-4 pb-8 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={Home}
        title="我的常驻社区"
        subtitle="本人确认 · 只读展示 · 不可自行修改"
      />

      <div className="mt-4">
        <ResidentCommunityCard
          state={residentCommunity.state}
          onReload={residentCommunity.reload}
          variant="full"
          chooseCommunityHref="/"
          confirmHref={confirmHref}
        />
      </div>

      <section className="mt-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
          <MapPin size={14} className="text-[#388b77]" aria-hidden="true" />
          浏览其他社区
        </p>
        <p className="mt-1.5 text-[12px] leading-5 text-slate-500">{BROWSE_ONLY_NOTICE}</p>
        <Link
          to="/"
          className="mt-3 inline-flex min-h-[44px] items-center justify-center rounded-xl border border-teal-200 bg-white px-4 text-[12px] font-semibold text-teal-700"
        >
          去社区首页浏览
        </Link>
      </section>

      <p className="mt-4 flex items-start gap-1.5 rounded-xl bg-white p-3.5 text-[11px] leading-5 text-slate-400 shadow-sm">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          {PERMANENT_BINDING_NOTICE} 如需纠正录入错误或处理身份纠纷，请联系社区工作人员登记核查。
        </span>
      </p>
    </div>
  )
}
