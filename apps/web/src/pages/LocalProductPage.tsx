import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  Minus,
  Plus,
  ShoppingBasket,
  Store,
} from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { useBackTarget } from '../hooks/useBackTarget'
import { useLocalProduct } from '../hooks/useLocalCatalog'
import { useResidentAuth } from '../hooks/useResidentAuth'
import { formatLocalPriceCents } from '../components/life/localOrderLabels'
import { registerLocalOrder } from '../services/localOrders'
import { describeLocalError, isLocalApiError, newIdempotencyKey } from '../services/localApi'

const MAX_QUANTITY = 99

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
  const { backTo, backLabel } = useBackTarget('/life', '返回惠生活')
  const { state, reload } = useLocalProduct(productId ?? null)
  const auth = useResidentAuth()

  const [quantity, setQuantity] = useState(1)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [registeredId, setRegisteredId] = useState<string | null>(null)
  // One key per registration attempt: a retry after a network error replays the
  // same key, so the server returns the existing order instead of a duplicate.
  const idempotencyKeyRef = useRef<string>(newIdempotencyKey())

  const product = state.status === 'ready' ? state.product : null
  const totalCents = product ? product.priceCents * quantity : 0
  const session = auth.session
  const canRegister = Boolean(session) && state.status === 'ready' && product?.status === 'on_shelf'

  const unavailableAction = useMemo(() => {
    if (!session) return '登录后登记订单'
    if (product && product.status !== 'on_shelf') return '该商品已下架'
    return null
  }, [session, product])

  const submit = async () => {
    if (!product || !session) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const order = await registerLocalOrder(session.csrfToken, {
        productId: product.id,
        quantity,
        note: note.trim() ? note.trim() : undefined,
        idempotencyKey: idempotencyKeyRef.current,
      })
      setRegisteredId(order.id)
      // A fresh key for any later registration of another quantity.
      idempotencyKeyRef.current = newIdempotencyKey()
    } catch (cause) {
      setSubmitError(describeLocalError(cause, '登记订单失败，请稍后重试'))
      if (isLocalApiError(cause) && (cause.status === 401 || cause.status === 409)) {
        // The snapshot or the shelf state changed, or the session expired: re-read
        // the product so the resident sees the real current state, not a stale one.
        if (cause.status === 409) reload()
      }
    } finally {
      setSubmitting(false)
    }
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
              <p className="mt-1.5 text-[11px] leading-5 text-slate-400">
                本页价格由社区维护，登记订单时由服务端冻结商品名称与单价快照。
              </p>
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
                  disabled={quantity <= 1 || submitting}
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
                  disabled={quantity >= MAX_QUANTITY || submitting}
                  onClick={() => setQuantity((value) => Math.min(MAX_QUANTITY, value + 1))}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 disabled:opacity-40"
                >
                  <Plus size={15} aria-hidden="true" />
                </button>
              </div>
            </div>

            <p className="mt-2 text-right text-[12px] text-slate-500">
              参考合计 <span className="font-semibold text-[#8a6132]">{formatLocalPriceCents(totalCents)}</span>
              （以服务端快照为准）
            </p>

            <label className="mt-3 block text-[12px] font-medium text-slate-600" htmlFor="local-order-note">
              备注（选填，会随登记一并保存）
            </label>
            <textarea
              id="local-order-note"
              value={note}
              maxLength={200}
              rows={3}
              disabled={!session || submitting}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如：希望周末到社区服务点自提"
              className="mt-1.5 w-full rounded-[14px] border border-slate-200 px-3 py-2.5 text-[13px] leading-5 text-slate-700 outline-none focus-visible:border-teal-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:bg-slate-50"
            />

            {registeredId ? (
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
                <Link
                  to={`/me/orders/${registeredId}`}
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
                disabled={submitting || registeredId !== null}
                onClick={() => void submit()}
                className="mt-3 flex min-h-[48px] w-full items-center justify-center gap-1.5 rounded-xl bg-teal-700 text-[14px] font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                {submitting ? (
                  <>
                    <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                    正在提交…
                  </>
                ) : registeredId ? (
                  '已登记'
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
                    to="/me"
                    state={{ from: `/life/local-products/${product.id}` }}
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
