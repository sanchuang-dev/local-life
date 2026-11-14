import { ChevronRight, LogOut, ShieldCheck, Smartphone } from 'lucide-react'
import { Link } from 'react-router'
import { staffRoleLabels } from '../crm/crmLabels'
import type { useResidentAuth } from '../../hooks/useResidentAuth'

/** Keeps account summaries and logout controls independent from the Me page layout. */
export function MeAccountPanel({
  auth,
  onEditProfile,
}: {
  auth: ReturnType<typeof useResidentAuth>
  onEditProfile: () => void
}) {
  const phoneDescription = auth.phoneStatus?.maskedPhone
    ? '已绑定 ' + auth.phoneStatus.maskedPhone
    : !auth.phoneStatus ? '手机号状态暂不可读取'
      : !auth.phoneStatus.configured ? '短信服务未启用'
        : '尚未绑定手机号'

  return (
    <section className="me-redesign__panel me-redesign__account" aria-labelledby="me-account">
      <h2 id="me-account" className="me-redesign__section-title">账户与服务</h2>
      {auth.session && !auth.session.staff && (
        <div className="me-redesign__account-row">
          <span className="me-redesign__account-icon"><Smartphone size={20} aria-hidden="true" /></span>
          <div className="me-redesign__account-copy">
            <strong>手机号</strong>
            <small>{phoneDescription}</small>
          </div>
          <button type="button" onClick={onEditProfile} className="me-redesign__mini-action">管理</button>
        </div>
      )}
      {auth.error && <p role="alert" className="me-redesign__error">{auth.error}</p>}
      {auth.loading && <p role="status" className="me-redesign__loading">正在读取账户状态…</p>}

      <Link className="me-redesign__account-row me-redesign__account-link" to="/workbench" state={{ from: '/me' }}>
        <span className="me-redesign__account-icon"><ShieldCheck size={20} aria-hidden="true" /></span>
        <span className="me-redesign__account-copy">
          <strong>{auth.session?.staff ? '工作人员工作台' : '工作人员入口'}</strong>
          <small>{auth.session?.staff
            ? staffRoleLabels[auth.session.staff.role] + ' · ' +
              (auth.session.staff.communities.map((item) => item.name).join('、') || '未分配社区')
            : '需使用独立工作人员身份登录'}</small>
        </span>
        <ChevronRight className="me-redesign__chevron" size={18} aria-hidden="true" />
      </Link>
      {auth.session && (
        <>
          <button className="me-redesign__account-row me-redesign__account-link me-redesign__logout"
            type="button" disabled={auth.busy} onClick={() => void auth.logout()}>
            <span className="me-redesign__account-icon"><LogOut size={20} aria-hidden="true" /></span>
            <span className="me-redesign__account-copy"><strong>退出登录</strong><small>退出当前账户</small></span>
            <ChevronRight className="me-redesign__chevron" size={18} aria-hidden="true" />
          </button>
          <p className="me-redesign__account-id">平台居民 ID：{auth.session.user.id.slice(0, 8)}…</p>
        </>
      )}
    </section>
  )
}
