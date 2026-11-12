import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, MapPin, Phone, UserRound, X } from 'lucide-react'
import './ProfilePreviewDrawer.css'

export type ProfilePreviewData = { phone: string; address: string }

type ProfilePreviewDrawerProps = {
  value: ProfilePreviewData
  userId: string | null
  onClose: () => void
  onSave: (value: ProfilePreviewData) => void
}

/** Visual-only contact form; never writes to API, storage, or account bindings. */
export function ProfilePreviewDrawer({ value, userId, onClose, onSave }: ProfilePreviewDrawerProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [phone, setPhone] = useState(value.phone)
  const [address, setAddress] = useState(value.address)
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const phoneId = useId()
  const addressId = useId()

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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSave({ phone: phone.trim(), address: address.trim() })
  }

  const copyUserId = async () => {
    if (!userId) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(userId)
      setCopyState('copied')
    } catch {
      // Some WebViews and insecure browser contexts need the legacy copy path.
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

  return createPortal(
    <div className="me-profile-drawer__overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="me-profile-drawer"
      >
        <div className="me-profile-drawer__handle" aria-hidden="true" />
        <div className="me-profile-drawer__header">
          <span className="me-profile-drawer__heading-icon" aria-hidden="true"><UserRound size={23} /></span>
          <div className="me-profile-drawer__heading">
            <div className="me-profile-drawer__title-row">
              <h2 id={titleId}>我的资料</h2>
              {userId && (
                <button
                  type="button"
                  className="me-profile-drawer__copy-id"
                  onClick={() => void copyUserId()}
                  aria-label={copyState === 'copied' ? '用户 ID 已复制' : '复制完整用户 ID'}
                >
                  {copyState === 'copied'
                    ? <Check size={13} strokeWidth={2.2} aria-hidden="true" />
                    : <Copy size={13} strokeWidth={1.9} aria-hidden="true" />}
                  <span>{copyState === 'copied' ? '已复制' : '复制ID'}</span>
                </button>
              )}
            </div>
            {copyState === 'failed' && (
              <span className="me-profile-drawer__copy-error" role="status">复制失败，请重试</span>
            )}
          </div>
          <button type="button" className="me-profile-drawer__close" onClick={onClose} aria-label="关闭我的资料">
            <X size={21} aria-hidden="true" />
          </button>
        </div>

        <form id="me-preview-profile-form" onSubmit={handleSubmit} className="me-profile-drawer__form">
          <p className="me-profile-drawer__guidance">
            <span aria-hidden="true">✳</span>
            填写常用联系方式，方便日后使用社区服务
          </p>
          <div className="me-profile-drawer__field">
            <label htmlFor={phoneId}><Phone size={17} aria-hidden="true" />联系电话</label>
            <input
              id={phoneId}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              maxLength={30}
              placeholder="请输入常用联系电话"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </div>
          <div className="me-profile-drawer__field">
            <label htmlFor={addressId}><MapPin size={17} aria-hidden="true" />联系地址</label>
            <textarea
              id={addressId}
              autoComplete="off"
              rows={3}
              maxLength={200}
              placeholder="请输入街道、门牌号等详细地址"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </div>
          <p className="me-profile-drawer__disclaimer">保存后仅在当前页面临时保留，刷新页面即清空。</p>
        </form>

        <div className="me-profile-drawer__footer">
          <button type="button" className="me-profile-drawer__cancel" onClick={onClose}>取消</button>
          <button type="submit" form="me-preview-profile-form" className="me-profile-drawer__save">保存（演示）</button>
        </div>
      </section>
    </div>,
    document.body,
  )
}
