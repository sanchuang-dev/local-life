import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { KeyRound, LogIn, UserRound, Wifi } from 'lucide-react'
import { useStaffSession } from '../../hooks/useStaffSession'
import {
  ErrorBlock,
  Field,
  LoadingBlock,
  StatusNotice,
  inputClassName,
  primaryButtonClassName,
} from '../../components/crm/WorkbenchUi'

function resolveDestination(from: unknown): string {
  if (typeof from === 'string' && from.startsWith('/workbench') && from !== '/workbench') {
    return from
  }
  return '/workbench/leads'
}

/**
 * Real staff login. It reuses the same `POST /api/auth/login` + CSRF double-submit
 * flow as the admin console; there is no local "demo staff" shortcut and a
 * resident session is never treated as a workbench identity.
 */
export function WorkbenchLoginPage() {
  const { session, residentOnly, loading, error, login, refresh } = useStaffSession()
  const location = useLocation()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const destination = resolveDestination((location.state as { from?: unknown } | null)?.from)

  if (loading) return <LoadingBlock label="正在确认登录状态…" />

  if (session) return <Navigate to={destination} replace />

  if (error) {
    return (
      <div className="px-4 pb-8 pt-4">
        <ErrorBlock title="无法读取登录状态" message={error} onRetry={() => void refresh()} />
      </div>
    )
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setFormError(null)
    try {
      await login(username.trim(), password)
      navigate(destination, { replace: true })
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '登录失败，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 pb-8 pt-4">
      <section className="rounded-3xl border border-slate-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#e8f6f0] text-[#388b77]"
            aria-hidden="true"
          >
            <Wifi size={24} strokeWidth={1.7} />
          </span>
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-tight text-slate-900">
              网格员工作台
            </h1>
            <p className="mt-0.5 text-[12px] text-slate-500">线索跟进 · 广电业务受理</p>
          </div>
        </div>

        <p className="mt-4 text-[12px] leading-5 text-slate-500">
          使用街道/社区分配的网格员、运营员或管理员账号登录。登录后查看你负责的社区线索与受理单。
        </p>

        {residentOnly ? (
          <div className="mt-3">
            <StatusNotice tone="info">
              当前浏览器登录的是居民账户，没有网格员工作台权限。请使用后台分配的网格员账号登录，登录会切换到该账号。
            </StatusNotice>
          </div>
        ) : null}

        <form className="mt-4" onSubmit={(event) => void submit(event)}>
          <Field label="登录账号" htmlFor="workbench-username" required>
            <div className="relative">
              <UserRound
                size={16}
                className="pointer-events-none absolute left-3 top-[25px] text-slate-300"
                aria-hidden="true"
              />
              <input
                id="workbench-username"
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                required
                minLength={3}
                maxLength={32}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className={`${inputClassName} pl-9`}
                placeholder="网格员账号"
              />
            </div>
          </Field>

          <Field label="密码" htmlFor="workbench-password" required>
            <div className="relative">
              <KeyRound
                size={16}
                className="pointer-events-none absolute left-3 top-[25px] text-slate-300"
                aria-hidden="true"
              />
              <input
                id="workbench-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={`${inputClassName} pl-9`}
                placeholder="登录密码"
              />
            </div>
          </Field>

          {formError ? (
            <div className="mt-3">
              <StatusNotice tone="error">{formError}</StatusNotice>
            </div>
          ) : null}

          <button type="submit" disabled={busy} className={`${primaryButtonClassName} mt-4`}>
            <LogIn size={16} aria-hidden="true" />
            {busy ? '登录中…' : '登录工作台'}
          </button>
        </form>
      </section>

      <div className="mt-4 rounded-2xl border border-[#f2dcc0] bg-[#fff7ec] px-3.5 py-3 text-[11px] leading-5 text-[#8a6132]">
        没有账号或忘记密码，请联系社区运营负责人。工作台不会收集居民通讯录，也不导入未经告知的居民名单。
      </div>
    </div>
  )
}
