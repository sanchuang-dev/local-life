import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { buildResidentLoginHref } from './residentLogin'
import { decideResidentGate } from './residentGate'
import { useResidentAuth } from '../../hooks/useResidentAuth'

/** Navigation guard only: the API still owns authorization to personal data. */
export function RequireResidentAuth({ children }: { children?: ReactNode }) {
  const auth = useResidentAuth()
  const location = useLocation()
  const decision = decideResidentGate(auth.sessionStatus, Boolean(auth.session))

  if (decision === 'loading') {
    return <p className="px-4 py-10 text-center text-[13px] text-slate-500" role="status">正在验证居民身份…</p>
  }

  if (decision === 'error') {
    return (
      <section className="mx-4 mt-6 rounded-[18px] border border-[#f0d5bd] bg-[#fff7f0] p-4" role="alert">
        <p className="text-[14px] font-semibold text-[#7a4a2c]">暂时无法确认登录状态</p>
        <p className="mt-2 text-[12px] leading-5 text-[#7a4a2c]">
          {auth.error || '账户服务暂不可用。'} 为保护个人信息，页面暂不展示。
        </p>
        <button type="button" onClick={() => void auth.refreshSession()}
          className="mt-3 min-h-[44px] rounded-[12px] bg-teal-700 px-4 text-[13px] font-semibold text-white">
          重新验证
        </button>
      </section>
    )
  }

  if (decision === 'login') {
    const loginHref = buildResidentLoginHref(location.pathname + location.search, {
      activityId: null, inviteCode: null, inviteInvalid: false,
    })
    return <Navigate to={loginHref} replace />
  }

  return children ?? <Outlet />
}
