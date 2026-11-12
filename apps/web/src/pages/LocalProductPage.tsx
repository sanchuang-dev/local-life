import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import type {
  LocalOrderDetail,
  LocalOrderTeamOption,
} from '@sanchuang-dev/local-life-contracts'
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  LockKeyhole,
  Minus,
  Plus,
  RefreshCw,
  ShoppingBasket,
  Store,
  UsersRound,
} from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { useBackTarget } from '../hooks/useBackTarget'
import { useLocalProduct } from '../hooks/useLocalCatalog'
import { useLocalOrderTeamOptions } from '../hooks/useLocalOrders'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { buildResidentLoginHref } from '../components/auth/residentLogin'
import {
  normalizeActivityId,
  normalizeInvite,
} from '../components/auth/residentLoginUrl'
import { reportResidentSessionExpired } from '../services/residentSessionEvents'
import {
  formatLocalDateTime,
  formatLocalPriceCents,
} from '../components/life/localOrderLabels'
import {
  buildLocalOrderRegistration,
  chooseTeamOption,
  describeOrderAttribution,
  resolveOrderAttribution,
  resolveSubmissionAttempt,
  shortTeamId,
  teamSelectionMode,
  type LocalOrderSubmissionAttempt,
} from '../components/life/localOrderAttribution'
import { registerLocalOrder } from '../services/localOrders'
import { describeLocalError, isLocalApiError, newIdempotencyKey } from '../services/localApi'

const MAX_QUANTITY = 99

function teamStatusLabel(status: LocalOrderTeamOption['team']['status']): string {
  return status === 'locked' ? '已成团' : '召集中'
}

function TeamOptionChoice({
  option,
  checked,
  disabled,
  onChange,
}: {
  option: LocalOrderTeamOption
  checked: boolean
  disabled: boolean
  onChange: () => void
}) {
  return (
    <label
      className={`flex items-start gap-2.5 rounded-[12px] border px-3 py-2.5 transition-colors ${
        checked
          ? 'border-teal-300 bg-[#eef7f2]'
          : 'border-slate-200 bg-white hover:border-teal-200'
      } ${disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
    >
      <input
        type="radio"
        name="local-order-team"
        value={option.team.id}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-0.5 h-4 w-4 shrink-0 accent-teal-700"
      />
      <span className="min-w-0">
        <span className="block break-words text-[12px] font-semibold leading-5 text-slate-700">
          {option.activity.title}
        </span>
        <span className="mt-0.5 block text-[10px] leading-4 text-slate-400">
          团号 {shortTeamId(option.team.id)} · {teamStatusLabel(option.team.status)} · 加入于{' '}
          {formatLocalDateTime(option.joinedAt)}
        </span>
      </span>
    </label>
  )
}

/**
 * `/life/local-products/:productId` — one real local product and its
 * registration action.
 *
 * The CTA is 「登记订单 / 提交办理意向」, never a payment verb: the contract has no
 * payment, cart or price input, and the server freezes the snapshot itself. A
 * signed-out visitor still sees the product (browsing is public) but the CTA is
 * replaced with the explicit login condition instead of a button that can only
 * fail.
 */
export function LocalProductPage() {
  const { productId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const productReturnTo = location.pathname + location.search
  const rawInvite = searchParams.get('invite')
  const inviteCode = normalizeInvite(rawInvite)
  // Preserve an explicit activity/invite entry context on the login round-trip.
  // Attribution itself is still decided by the API from the selected team; this
  // context only keeps the resident's original source visible after login.
  const loginContext = {
    activityId: normalizeActivityId(searchParams.get('activityId')),
    inviteCode,
    inviteInvalid:
      searchParams.get('inviteInvalid') === '1' || Boolean(rawInvite && !inviteCode),
  }
  const { backTo, backLabel } = useBackTarget('/life', '返回惠生活')
  const { state, reload } = useLocalProduct(productId ?? null)
  const auth = useResidentAuth()

  const [quantity, setQuantity] = useState(1)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [registeredOrder, setRegisteredOrder] = useState<LocalOrderDetail | null>(null)
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)
  // One attempt = one idempotency key + one frozen consumption-team attribution.
  // A network retry replays both, so it can neither duplicate nor switch teams.
  const [attempt, setAttempt] = useState<LocalOrderSubmissionAttempt | null>(null)

  const product = state.status === 'ready' ? state.product : null
  const totalCents = product ? product.priceCents * quantity : 0
  const session = auth.session
  const teamOptions = useLocalOrderTeamOptions({
    productId: product?.id ?? null,
    sessionKey: session?.user.id ?? null,
    authLoading: auth.loading,
  })

  const teamItems = teamOptions.state.status === 'ready' ? teamOptions.state.items : []
  const teamMode = teamOptions.state.status === 'ready' ? teamSelectionMode(teamItems) : null
  const selectedTeam = attempt
    ? chooseTeamOption(teamItems, attempt.attribution.sourceTeamId ?? null)
    : chooseTeamOption(teamItems, selectedTeamId)
  const teamChoiceMissing = teamMode === 'choice' && !attempt && !selectedTeam
  const inputsLocked = submitting || registeredOrder !== null || attempt !== null
  const teamReady = teamOptions.state.status === 'ready'
  const canRegister =
    Boolean(session) &&
    state.status === 'ready' &&
    product?.status === 'on_shelf' &&
    teamReady &&
    !teamChoiceMissing &&
    registeredOrder === null

  const unavailableAction = useMemo(() => {
    if (!session) return '登录后登记订单'
    if (product && product.status !== 'on_shelf') return '该商品已下架'
    return null
  }, [session, product])

  const submit = async () => {
    if (!product || !session || submitting) return
    if (!teamReady) {
      setSubmitError('消费团归属还未读取完成，请稍后重试。')
      return
    }

    const resolution = attempt
      ? { ok: true as const, attribution: attempt.attribution }
      : resolveOrderAttribution(teamItems, selectedTeamId)
    if (!resolution.ok) {
      setSubmitError(resolution.message)
      return
    }

    const nextAttempt = resolveSubmissionAttempt(
      attempt,
      resolution.attribution,
      newIdempotencyKey,
    )
    setAttempt(nextAttempt)
    setSubmitting(true)
    setSubmitError(null)
    try {
      const order = await registerLocalOrder(
        session.csrfToken,
        buildLocalOrderRegistration({
          productId: product.id,
          quantity,
          note,
          attribution: nextAttempt.attribution,
          idempotencyKey: nextAttempt.idempotencyKey,
        }),
      )
      setRegisteredOrder(order)
      setAttempt(null)
    } catch (cause) {
      setSubmitError(describeLocalError(cause, '登记订单失败，请稍后重试'))
      if (isLocalApiError(cause) && (cause.status === 401 || cause.status === 409)) {
        // The snapshot or the shelf state changed, or the session expired: re-read
        // the product so the resident sees the real current state, not a stale one.
        if (cause.status === 409) reload()
        if (cause.status === 401) {
          // No order was written for an unauthenticated request; do not keep a
          // frozen attempt from blocking the form after the resident logs in.
          setAttempt(null)
          reportResidentSessionExpired()
          navigate(buildResidentLoginHref(productReturnTo, loginContext), { replace: true })
        }
      }
    } finally {
      setSubmitting(false)
    }
  }

  const editRegistration = () => {
    // Explicitly discard the frozen attempt; the next submit gets a new key and
    // may choose another team. A silent re-selection alone never reaches here.
    setAttempt(null)
    setSubmitError(null)
  }

  return (
    <div className="px-4 pb-7 pt-3">
      <PageHeader
        backTo={backTo}
        backLabel={backLabel}
        icon={ShoppingBasket}
        title={product ? product.name : '本地商品'}
        subtitle={product ? `${product.category ?? '本地商品'} · ${product.community.name}` : '本地商品详情'}
      />

      {state.status === 'loading' ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-6 flex items-center justify-center gap-2 text-[12px] font-medium text-slate-500"
        >
          <LoaderCircle size={16} className="animate-spin text-teal-600" aria-hidden="true" />
          正在读取商品详情…
        </p>
      ) : null}

      {state.status === 'error' ? (
        <section
          role="alert"
          className="mt-4 rounded-[20px] border border-rose-100 bg-white px-5 py-8 text-center shadow-sm"
        >
          <span
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-[18px] bg-rose-50 text-rose-500"
            aria-hidden="true"
          >
            <AlertTriangle size={26} strokeWidth={1.6} />
          </span>
          <p className="mt-3 text-[16px] font-semibold text-slate-800">
            {state.notFound ? '该商品不存在或已下架' : '商品详情读取失败'}
          </p>
          <p className="mx-auto mt-2 max-w-[300px] break-words text-[12px] leading-6 text-slate-500">
            {state.message}
          </p>
          {state.code ? (
            <p className="mt-2 break-all font-mono text-[10px] text-slate-400">
              错误代码：{state.code}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {state.notFound ? null : (
              <button
                type="button"
                onClick={reload}
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white"
              >
                重新读取
              </button>
            )}
            <Link
              to="/life"
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 px-4 text-[13px] font-semibold text-slate-600"
            >
              返回惠生活
            </Link>
          </div>
        </section>
      ) : null}

      {product ? (
        <>
          <article className="mt-4 overflow-hidden rounded-[20px] border border-slate-100 bg-white shadow-sm">
            {product.imageUrl ? (
              <img
                src={product.imageUrl}
                alt={product.name}
                className="aspect-[4/3] w-full object-cover"
              />
            ) : (
              <div
                className="flex aspect-[4/3] items-center justify-center bg-[#eef7f2] text-[#388b77]"
                aria-hidden="true"
              >
                <Store size={54} strokeWidth={1.3} />
              </div>
            )}

            <div className="p-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                  {product.category ?? '本地商品'}
                </span>
                <span className="rounded-full bg-[#eef7f2] px-2 py-0.5 text-[10px] font-medium text-[#388b77]">
                  {product.community.name}
                </span>
                <span className="rounded-full bg-[#fff3e6] px-2 py-0.5 text-[10px] font-medium text-[#a96b2f]">
                  登记办理意向
                </span>
              </div>

              <p className="mt-2.5 break-words text-[15px] font-semibold leading-6 text-slate-800">
                {product.name}
              </p>
              {product.summary ? (
                <p className="mt-1 break-words text-[12px] leading-5 text-slate-500">
                  {product.summary}
                </p>
              ) : null}

              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-[28px] font-semibold leading-none tracking-tight text-[#8a6132]">
                  {formatLocalPriceCents(product.priceCents)}
                </span>
                <span className="text-[12px] text-slate-400">/ 件 · 参考单价</span>
              </div>
            </div>
          </article>

          {product.description ? (
            <section className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm">
              <h2 className="text-[15px] font-semibold text-slate-800">商品说明</h2>
              <p className="mt-2 whitespace-pre-line break-words text-[12px] leading-6 text-slate-500">
                {product.description}
              </p>
            </section>
          ) : null}

          <section
            className="mt-4 rounded-[18px] border border-slate-100 bg-white p-4 shadow-sm"
            aria-labelledby="local-register-heading"
          >
            <h2 id="local-register-heading" className="text-[15px] font-semibold text-slate-800">
              登记订单 / 提交办理意向
            </h2>
            <p className="mt-1.5 text-[12px] leading-5 text-slate-500">
              只登记办理意向，平台不收款、不代下单；工作人员会按登记信息联系你。
            </p>

            <div className="mt-3 flex items-center justify-between gap-3 rounded-[14px] bg-[#f4f8f6] px-3.5 py-2.5">
              <span className="text-[12px] font-medium text-slate-600">数量</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="减少数量"
                  disabled={quantity <= 1 || inputsLocked}
                  onClick={() => setQuantity((value) => Math.max(1, value - 1))}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 disabled:opacity-40"
                >
                  <Minus size={15} aria-hidden="true" />
                </button>
                <span
                  aria-live="polite"
                  className="min-w-[2.5rem] text-center text-[15px] font-semibold text-slate-800"
                >
                  {quantity}
                </span>
                <button
                  type="button"
                  aria-label="增加数量"
                  disabled={quantity >= MAX_QUANTITY || inputsLocked}
                  onClick={() => setQuantity((value) => Math.min(MAX_QUANTITY, value + 1))}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 disabled:opacity-40"
                >
                  <Plus size={15} aria-hidden="true" />
                </button>
              </div>
            </div>

            <p className="mt-2 text-right text-[12px] text-slate-500">
              参考合计 <span className="font-semibold text-[#8a6132]">{formatLocalPriceCents(totalCents)}</span>
              （以登记确认时的价格为准）
            </p>

            <div className="mt-3 rounded-[14px] border border-slate-200 bg-[#f8faf9] px-3.5 py-3">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700">
                <UsersRound size={14} className="shrink-0 text-teal-700" aria-hidden="true" />
                消费团归属
              </p>

              {registeredOrder ? (
                <>
                  <p className="mt-1.5 break-words text-[12px] font-medium leading-5 text-slate-700">
                    {describeOrderAttribution(registeredOrder)}
                  </p>
                  <p className="mt-1 flex items-start gap-1.5 text-[10px] leading-4 text-slate-400">
                    <LockKeyhole size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                    归属在登记时锁定，提交后不能转团或修改。
                  </p>
                </>
              ) : !session ? (
                <p className="mt-1.5 text-[11px] leading-5 text-slate-500">
                  登录后可读取你可参与的消费团，并确认本单归属。
                </p>
              ) : teamOptions.state.status === 'loading' ? (
                <p
                  role="status"
                  aria-live="polite"
                  className="mt-1.5 flex items-center gap-1.5 text-[11px] leading-5 text-slate-500"
                >
                  <LoaderCircle size={13} className="shrink-0 animate-spin text-teal-600" aria-hidden="true" />
                  正在读取可参与的消费团…
                </p>
              ) : teamOptions.state.status === 'error' ? (
                <div className="mt-1.5" role="alert">
                  <p className="break-words text-[11px] leading-5 text-[#8a6132]">
                    {teamOptions.state.message}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-4 text-slate-400">
                    未读取到归属前不能登记，避免把订单错误地计入或排除消费团。
                  </p>
                  <button
                    type="button"
                    onClick={teamOptions.reload}
                    className="mt-1.5 inline-flex min-h-[36px] items-center gap-1 rounded-full border border-slate-300 bg-white px-3 text-[11px] font-semibold text-slate-600"
                  >
                    <RefreshCw size={12} aria-hidden="true" />
                    重新读取消费团
                  </button>
                </div>
              ) : teamOptions.state.status === 'ready' ? (
                <>
                  {teamMode === 'none' ? (
                    <>
                      <p className="mt-1.5 text-[12px] font-semibold text-slate-700">不参与消费团</p>
                      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
                        你当前没有符合条件的消费团，本单登记不会计入任何团。
                      </p>
                    </>
                  ) : null}

                  {teamMode === 'auto' && teamItems[0] ? (
                    <>
                      <p className="mt-1.5 text-[11px] leading-5 text-slate-500">
                        你当前只有一个符合条件的消费团，已自动选中；本单将计入该团，提交后不能转团。
                      </p>
                      <div className="mt-2 flex items-start gap-2 rounded-[12px] border border-teal-200 bg-[#eef7f2] px-3 py-2.5">
                        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[#388b77]" aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="break-words text-[12px] font-semibold leading-5 text-[#225c4c]">
                            {teamItems[0].activity.title}
                          </p>
                          <p className="mt-0.5 text-[10px] leading-4 text-[#52786c]">
                            团号 {shortTeamId(teamItems[0].team.id)} ·{' '}
                            {teamStatusLabel(teamItems[0].team.status)}
                          </p>
                        </div>
                      </div>
                    </>
                  ) : null}

                  {teamMode === 'choice' ? (
                    <>
                      <p className="mt-1.5 text-[11px] leading-5 text-slate-500">
                        你有多个符合条件的消费团，请主动选择一个；提交后归属不能更改。
                      </p>
                      <fieldset className="mt-2 space-y-2">
                        <legend className="sr-only">选择本单的消费团归属</legend>
                        {teamItems.map((option) => (
                          <TeamOptionChoice
                            key={option.team.id}
                            option={option}
                            checked={
                              (attempt?.attribution.sourceTeamId ?? selectedTeamId) ===
                              option.team.id
                            }
                            disabled={inputsLocked}
                            onChange={() => setSelectedTeamId(option.team.id)}
                          />
                        ))}
                      </fieldset>
                    </>
                  ) : null}

                  {attempt ? (
                    <div className="mt-2 rounded-[10px] border border-slate-200 bg-white px-2.5 py-2">
                      <p className="flex items-start gap-1.5 text-[10px] leading-4 text-slate-500">
                        <LockKeyhole size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                        本次重试会沿用原消费团归属与幂等键，不会切换归属。
                      </p>
                      <button
                        type="button"
                        onClick={editRegistration}
                        disabled={submitting}
                        className="mt-1.5 inline-flex min-h-[36px] items-center rounded-full border border-slate-300 px-3 text-[11px] font-semibold text-slate-600 disabled:opacity-60"
                      >
                        修改登记信息
                      </button>
                    </div>
                  ) : teamChoiceMissing ? (
                    <p className="mt-1.5 text-[10px] leading-4 text-[#a96b2f]">
                      请选择一个消费团后再提交登记。
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>

            <label className="mt-3 block text-[12px] font-medium text-slate-600" htmlFor="local-order-note">
              备注（选填，会随登记一并保存）
            </label>
            <textarea
              id="local-order-note"
              value={note}
              maxLength={200}
              rows={3}
              disabled={!session || inputsLocked}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如：希望周末到社区服务点自提"
              className="mt-1.5 w-full rounded-[14px] border border-slate-200 px-3 py-2.5 text-[13px] leading-5 text-slate-700 outline-none focus-visible:border-teal-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:bg-slate-50"
            />

            {registeredOrder ? (
              <div
                role="status"
                className="mt-3 rounded-[14px] border border-teal-200 bg-[#eef7f2] px-3.5 py-3"
              >
                <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#225c4c]">
                  <CheckCircle2 size={15} className="shrink-0" aria-hidden="true" />
                  办理意向已登记
                </p>
                <p className="mt-1 break-words text-[11px] leading-5 text-[#52786c]">
                  订单已提交，工作人员会按登记信息联系你。平台不收款，这也不代表业务已开通。
                </p>
                <p className="mt-1 break-words text-[11px] font-medium leading-5 text-[#225c4c]">
                  消费团归属：{describeOrderAttribution(registeredOrder)}
                </p>
                <p className="mt-0.5 flex items-start gap-1.5 text-[10px] leading-4 text-[#52786c]">
                  <LockKeyhole size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                  该归属在登记时锁定，提交后不能修改或转团。
                </p>
                <Link
                  to={`/me/orders/${registeredOrder.id}`}
                  state={{ from: `/life/local-products/${product.id}` }}
                  className="mt-2 inline-flex min-h-[44px] items-center rounded-xl bg-teal-700 px-4 text-[13px] font-semibold text-white"
                >
                  查看我的订单详情
                </Link>
              </div>
            ) : null}

            {submitError ? (
              <p role="alert" className="mt-3 break-words rounded-[12px] bg-rose-50 px-3 py-2.5 text-[12px] leading-5 text-rose-700">
                {submitError}
              </p>
            ) : null}

            {canRegister ? (
              <button
                type="button"
                disabled={submitting || registeredOrder !== null}
                onClick={() => void submit()}
                className="mt-3 flex min-h-[48px] w-full items-center justify-center gap-1.5 rounded-xl bg-teal-700 text-[14px] font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                {submitting ? (
                  <>
                    <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                    正在提交…
                  </>
                ) : registeredOrder ? (
                  '已登记'
                ) : attempt ? (
                  '重试登记（沿用原归属）'
                ) : (
                  '登记订单 / 提交办理意向'
                )}
              </button>
            ) : null}

            {unavailableAction ? (
              <div className="mt-3 rounded-[14px] border border-[#f2dcc0] bg-[#fff7ec] px-3.5 py-3">
                <p className="text-[12px] font-semibold text-[#8a6132]">{unavailableAction}</p>
                <p className="mt-1 text-[11px] leading-5 text-[#8a6132]/90">
                  登记订单会写入你的居民账户，因此需要先登录；浏览商品不需要登录。
                </p>
                {!session ? (
                  <Link
                    to={buildResidentLoginHref(productReturnTo, loginContext)}
                    className="mt-2 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-[#138b79] px-4 text-[13px] font-semibold text-white"
                  >
                    去登录 / 查看登录方式
                  </Link>
                ) : null}
              </div>
            ) : null}

            {auth.error ? (
              <p role="alert" className="mt-2 break-words text-[11px] leading-5 text-rose-600">
                {auth.error}
              </p>
            ) : null}
          </section>

          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              to="/me/orders"
              state={{ from: `/life/local-products/${product.id}` }}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-slate-200 px-4 text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700"
            >
              我的订单
            </Link>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-slate-200 px-4 text-[13px] font-semibold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700"
            >
              返回上一页
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
