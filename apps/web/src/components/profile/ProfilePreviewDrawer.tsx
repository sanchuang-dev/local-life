import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, MapPin, Phone, UserRound, X } from 'lucide-react'
import { PhoneVerificationForm } from '../auth/PhoneVerificationForm'
import type { useResidentAuth } from '../../hooks/useResidentAuth'
import { residentProfileViewState } from './profileViewModel'
import './ProfilePreviewDrawer.css'

type ResidentProfileDrawerProps = {
  auth: ReturnType<typeof useResidentAuth>
  onClose: () => void
}

/** Resident-owned profile editor backed only by real account/profile APIs. */
export function ResidentProfileDrawer({ auth, onClose }: ResidentProfileDrawerProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [address, setAddress] = useState(auth.residentProfile?.contactAddress ?? '')
  const [phoneEditing, setPhoneEditing] = useState(false)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const addressId = useId()
  const profile = auth.residentProfile
  const maskedPhone = profile?.phone.maskedPhone ?? auth.phoneStatus?.maskedPhone ?? null
  const phoneConfigured = auth.phoneStatus?.configured === true
  const view = residentProfileViewState({
    loading: auth.residentProfileLoading,
    saving: auth.residentProfileSaving,
    error: auth.residentProfileError,
    hasProfile: profile !== null,
    phoneStatusKnown: auth.phoneStatus !== null,
    phoneConfigured,
    maskedPhone,
    changingPhone: phoneEditing,
  })

  useEffect(() => {
    void auth.refreshResidentProfile()
  }, [auth.refreshResidentProfile])

  useEffect(() => {
    if (profile) setAddress(profile.contactAddress ?? '')
  }, [profile])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus({ preventScroll: true })
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
      ))
      if (!controls.length) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', handleKeydown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeydown)
      previousFocus?.focus({ preventScroll: true })
    }
  }, [onClose])

  const userId = profile?.userId ?? auth.session?.user.id ?? null
  const copyUserId = async () => {
    if (!userId) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(userId)
      setCopyState('copied')
    } catch {
      const field = document.createElement('textarea')
      field.value = userId
      field.setAttribute('readonly', '')
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.appendChild(field)
      field.select()
      try {
        if (!document.execCommand('copy')) throw new Error('Copy failed')
        setCopyState('copied')
      } catch {
        setCopyState('failed')
      } finally {
        field.remove()
      }
    }
  }

  const saveAddress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSavedNotice(null)
    try {
      const saved = await auth.saveContactAddress(address)
      setAddress(saved.contactAddress ?? '')
      setSavedNotice('联系地址已保存。')
    } catch {
      // The auth controller owns the API error so retrying never hides it.
    }
  }

  const wechatName = profile?.wechat?.nickname ?? null
  const displayName = profile?.displayName ?? auth.session?.user.displayName ?? '居民账户'

  return createPortal(
    <div className="me-profile-drawer__overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true"
        aria-labelledby={titleId} className="me-profile-drawer">
        <div className="me-profile-drawer__handle" aria-hidden="true" />
        <div className="me-profile-drawer__header">
          <span className="me-profile-drawer__heading-icon" aria-hidden="true"><UserRound size={23} /></span>
          <div className="me-profile-drawer__heading">
            <div className="me-profile-drawer__title-row">
              <h2 id={titleId}>我的资料</h2>
              {userId && (
                <button type="button" className="me-profile-drawer__copy-id"
                  onClick={() => void copyUserId()}
                  aria-label={copyState === 'copied' ? '用户 ID 已复制' : '复制完整用户 ID'}>
                  {copyState === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                  <span>{copyState === 'copied' ? '已复制' : '复制ID'}</span>
                </button>
              )}
            </div>
            {copyState === 'failed' && <span className="me-profile-drawer__copy-error" role="status">复制失败，请重试</span>}
          </div>
          <button type="button" className="me-profile-drawer__close" onClick={onClose} aria-label="关闭我的资料">
            <X size={21} aria-hidden="true" />
          </button>
        </div>

        {view.status === 'loading' && (
          <div className="me-profile-drawer__state" role="status">正在读取个人资料…</div>
        )}
        {view.status === 'error' && (
          <div className="me-profile-drawer__state me-profile-drawer__state--error" role="alert">
            <p>{auth.residentProfileError}</p>
            <button type="button" onClick={() => void auth.refreshResidentProfile()}>重新读取</button>
          </div>
        )}

        {view.status === 'ready' && (
          <form id="resident-profile-form" onSubmit={(event) => void saveAddress(event)} className="me-profile-drawer__form">
            <div className="me-profile-drawer__identity-card">
              <div className="me-profile-drawer__avatar">
                {profile?.wechat?.avatarUrl
                  ? <img src={profile.wechat.avatarUrl} alt="" referrerPolicy="no-referrer" />
                  : <UserRound size={24} aria-hidden="true" />}
              </div>
              <div>
                <strong>{displayName}</strong>
                {wechatName && wechatName !== displayName && <small>微信昵称：{wechatName}</small>}
                <small>平台居民 ID：{userId ? userId.slice(0, 8) + '…' : '—'}</small>
              </div>
            </div>

            <section className="me-profile-drawer__phone">
              <div className="me-profile-drawer__phone-heading">
                <span><Phone size={17} aria-hidden="true" />联系电话</span>
                {view.phoneMode === 'bound' && (
                  <button type="button" disabled={!phoneConfigured} onClick={() => setPhoneEditing(true)}>
                    {phoneConfigured ? '更换' : '短信未启用'}
                  </button>
                )}
              </div>
              {view.phoneMode === 'bound' && (
                <p className="me-profile-drawer__phone-current">已验证 {maskedPhone}</p>
              )}
              {view.phoneMode === 'unknown' && (
                <div className="me-profile-drawer__phone-unavailable">
                  <p>暂时无法读取手机号服务状态；联系地址仍可正常保存。</p>
                  <button type="button" onClick={() => void auth.refreshPhoneStatus()}>重新读取手机号状态</button>
                </div>
              )}
              {view.phoneMode === 'unavailable' && (
                <p className="me-profile-drawer__phone-unavailable">
                  短信服务未配置，暂不能绑定或更换手机号；联系地址仍可正常保存。
                </p>
              )}
              {(view.phoneMode === 'bind' || view.phoneMode === 'change') && (
                <>
                  <PhoneVerificationForm
                    purpose="bind"
                    configured={true}
                    title={view.phoneMode === 'change' ? '验证新的手机号' : '绑定手机号'}
                    description={view.phoneMode === 'change'
                      ? '新号码验证成功后会替换当前手机号，居民账号、活动和奖励记录保持不变。'
                      : '通过短信验证码确认本人手机号，不自动合并其他居民账户。'}
                    submitLabel={view.phoneMode === 'change' ? '确认更换' : '确认绑定'}
                    onRequestCode={(phone) => auth.requestPhoneCode(phone, 'bind')}
                    onSubmit={(phone, code) => auth.bindPhone(phone, code).then(() => undefined)}
                    onSuccess={() => {
                      setPhoneEditing(false)
                      setSavedNotice(maskedPhone ? '手机号已更换。' : '手机号已绑定。')
                    }}
                  />
                  {view.phoneMode === 'change' && (
                    <button type="button" className="me-profile-drawer__phone-cancel"
                      onClick={() => setPhoneEditing(false)}>取消更换</button>
                  )}
                </>
              )}
            </section>

            <div className="me-profile-drawer__field">
              <label htmlFor={addressId}><MapPin size={17} aria-hidden="true" />联系地址</label>
              <textarea id={addressId} autoComplete="street-address" rows={3} maxLength={200}
                placeholder="请输入街道、门牌号等详细地址"
                value={address}
                onChange={(event) => {
                  setAddress(event.target.value)
                  setSavedNotice(null)
                }} />
              <small className="me-profile-drawer__counter">{address.length}/200</small>
            </div>
            {auth.residentProfileError && <p className="me-profile-drawer__error" role="alert">{auth.residentProfileError}</p>}
            {savedNotice && <p className="me-profile-drawer__success" role="status">{savedNotice}</p>}
          </form>
        )}

        <div className="me-profile-drawer__footer">
          <button type="button" className="me-profile-drawer__cancel" onClick={onClose}>关闭</button>
          <button type="submit" form="resident-profile-form" className="me-profile-drawer__save"
            disabled={view.saveDisabled}>
            {auth.residentProfileSaving ? '保存中…' : '保存地址'}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  )
}
