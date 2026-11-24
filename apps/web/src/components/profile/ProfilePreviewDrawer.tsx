import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, MapPin, Phone, UserRound, X } from 'lucide-react'
import type { useResidentAuth } from '../../hooks/useResidentAuth'
import { residentProfileViewState } from './profileViewModel'
import './ProfilePreviewDrawer.css'

type ResidentProfileDrawerProps = {
  auth: ReturnType<typeof useResidentAuth>
  onClose: () => void
  onSaved: () => void
}

/** Resident-owned profile editor backed only by real account/profile APIs. */
export function ResidentProfileDrawer({ auth, onClose, onSaved }: ResidentProfileDrawerProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [address, setAddress] = useState(auth.residentProfile?.contactAddress ?? '')
  const [phone, setPhone] = useState(auth.residentProfile?.contactPhone ?? '')
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const addressId = useId()
  const phoneId = useId()
  const profile = auth.residentProfile
  const view = residentProfileViewState({
    loading: auth.residentProfileLoading,
    saving: auth.residentProfileSaving,
    error: auth.residentProfileError,
    hasProfile: profile !== null,
  })

  useEffect(() => {
    void auth.refreshResidentProfile()
  }, [auth.refreshResidentProfile])

  useEffect(() => {
    if (profile) {
      setAddress(profile.contactAddress ?? '')
      setPhone(profile.contactPhone ?? '')
    }
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

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      await auth.saveContactProfile(address, phone)
      onSaved()
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
          <form id="resident-profile-form" onSubmit={(event) => void saveProfile(event)} className="me-profile-drawer__form">
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

            <div className="me-profile-drawer__field">
              <label htmlFor={phoneId}><Phone size={17} aria-hidden="true" />联系电话</label>
              <input id={phoneId} type="tel" inputMode="tel" autoComplete="tel" maxLength={11}
                pattern="1[0-9]{10}" placeholder="请输入联系电话" value={phone}
                onChange={(event) => setPhone(event.target.value)} />
            </div>

            <div className="me-profile-drawer__field">
              <label htmlFor={addressId}><MapPin size={17} aria-hidden="true" />联系地址</label>
              <textarea id={addressId} autoComplete="street-address" rows={3} maxLength={200}
                placeholder="请输入街道、门牌号等详细地址"
                value={address}
                onChange={(event) => setAddress(event.target.value)} />
              <small className="me-profile-drawer__counter">{address.length}/200</small>
            </div>
            {auth.residentProfileError && <p className="me-profile-drawer__error" role="alert">{auth.residentProfileError}</p>}
          </form>
        )}

        <div className="me-profile-drawer__footer">
          <button type="button" className="me-profile-drawer__cancel" onClick={onClose}>关闭</button>
          <button type="submit" form="resident-profile-form" className="me-profile-drawer__save"
            disabled={view.saveDisabled}>
            {auth.residentProfileSaving ? '保存中…' : '保存资料'}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  )
}
