import { useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { LogOut, ShieldCheck } from 'lucide-react'
import { useStaffSession } from '../../hooks/useStaffSession'
import { staffRoleLabels } from './crmLabels'
import { ErrorBlock, LoadingBlock, StatusNotice } from './WorkbenchUi'

/** Gate every workbench sub-page behind a real staff session from `/auth/session`. */
export function StaffGate({ children }: { children: ReactNode }) {
  const { session, loading, error, refresh } = useStaffSession()
  const location = useLocation()

  if (loading) return <LoadingBlock label="正在确认网格员身份…" />

  if (error) {
    return <ErrorBlock title="无法确认登录状态" message={error} onRetry={() => void refresh()} />
  }

  if (!session) {
    const from = `${location.pathname}${location.search}`
    return <Navigate to="/workbench" state={{ from }} replace />
  }

  return <>{children}</>
}

/** Real staff identity panel: role and community scope come from the server session. */
export function StaffIdentityCard() {
  const { session, logout } = useStaffSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!session) return null

  const signOut = async () => {
    setBusy(true)
    setError(null)
    try {
      await logout()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '退出登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[18px] border border-slate-100 bg-white px-4 py-3.5 shadow-sm">
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#e8f6f0] text-[#388b77]"
          aria-hidden="true"
        >
          <ShieldCheck size={20} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-slate-800">
            {session.user.displayName || session.staff.username}
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-slate-400">
            {staffRoleLabels[session.staff.role]} · {session.staff.username}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-slate-400">
            授权社区：{session.staff.communities.map((item) => item.name).join('、') || '无'}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void signOut()}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full px-3 text-[11px] font-medium text-slate-500 hover:bg-slate-50 disabled:opacity-50"
        >
          <LogOut size={13} aria-hidden="true" />
          {busy ? '退出中…' : '退出'}
        </button>
      </div>
      {error ? (
        <div className="mt-2.5">
          <StatusNotice tone="error">{error}</StatusNotice>
        </div>
      ) : null}
    </div>
  )
}
