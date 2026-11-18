import { useRef, useState } from 'react'
import {
  CheckCircle2,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Ticket,
} from 'lucide-react'
import type { LocalOrderDetail, MockPaymentAction } from '@sanchuang-dev/local-life-contracts'
import { usePaymentCapabilities } from '../../hooks/usePaymentCapabilities'
import { useResidentAuth } from '../../hooks/useResidentAuth'
import {
  completeMyZeroAmountOrder,
  createMyPaymentIntent,
  executeMyMockPayment,
} from '../../services/localPayments'
import { describeLocalError, isLocalApiError, newIdempotencyKey } from '../../services/localApi'
import { reportResidentSessionExpired } from '../../services/residentSessionEvents'
import {
  isWechatBrowser,
  localOrderPaymentDisplay,
  paymentActionLabel,
} from './localOrderPayment'
import { formatLocalPriceCents } from './localOrderLabels'

/**
 * Resident payment panel. It is intentionally a *state reader and action
 * launcher*: every displayed terminal state comes from the latest order/payment
 * facts returned by the API. A channel action only asks the server to confirm;
 * it never writes `paid` in React state.
 */
export function LocalOrderPaymentPanel({
  order,
  onRefresh,
}: {
  order: LocalOrderDetail
  onRefresh: () => Promise<LocalOrderDetail | null>
}) {
  const auth = useResidentAuth()
  const capabilities = usePaymentCapabilities()
  const [busy, setBusy] = useState<MockPaymentAction | 'zero' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const attemptKey = useRef(newIdempotencyKey())
  const display = localOrderPaymentDisplay(order)
  const inWechat = isWechatBrowser()
  const orderPayable = ['registered', 'processing', 'pending_review'].includes(order.status)

  if (display.kind === 'manual') return null

  const refresh = async () => {
    setError(null)
    try {
      await onRefresh()
    } catch (cause) {
      if (isLocalApiError(cause) && cause.status === 401) {
        reportResidentSessionExpired()
      }
      setError(describeLocalError(cause, '暂时无法刷新支付状态，请稍后重试。'))
    }
  }

  const ensureIntent = async (): Promise<string | null> => {
    const existing = order.payment
    if (existing?.status === 'pending') return existing.intentId
    if (existing && (existing.status === 'confirming' || existing.status === 'paid')) {
      await refresh()
      return null
    }
    if (capabilities.state.status !== 'ready' || !capabilities.state.capabilities.mockAvailable) {
      setError('当前没有可用的模拟支付渠道。')
      return null
    }
    if (!auth.session) {
      setError('登录状态已失效，请重新登录后再支付。')
      reportResidentSessionExpired()
      return null
    }
    // A new key is only for a genuinely new intent. If the initial request lost
    // its response, the same ref key makes the retry idempotent.
    if (existing && (existing.status === 'failed' || existing.status === 'closed')) {
      attemptKey.current = newIdempotencyKey()
    }
    const created = await createMyPaymentIntent(auth.session.csrfToken, {
      localOrderId: order.id,
      channel: 'mock',
      idempotencyKey: attemptKey.current,
    })
    return created.intent.id
  }

  const runMockAction = async (action: MockPaymentAction) => {
    if (busy) return
    setBusy(action)
    setError(null)
    try {
      if (!auth.session) {
        reportResidentSessionExpired()
        throw new Error('登录状态已失效，请重新登录后再支付。')
      }
      const intentId = await ensureIntent()
      if (!intentId) return
      await executeMyMockPayment(auth.session.csrfToken, intentId, action)
      if (action !== 'pending') attemptKey.current = newIdempotencyKey()
      await refresh()
    } catch (cause) {
      setError(describeLocalError(cause, '模拟支付操作失败，请刷新状态后重试。'))
      await refresh().catch(() => undefined)
    } finally {
      setBusy(null)
    }
  }

  const completeZero = async () => {
    if (busy || !auth.session) return
    setBusy('zero')
    setError(null)
    try {
      await completeMyZeroAmountOrder(auth.session.csrfToken, order.id)
      await refresh()
    } catch (cause) {
      setError(describeLocalError(cause, '消费券兑换失败，请刷新后重试。'))
    } finally {
      setBusy(null)
    }
  }

  const cap = capabilities.state.status === 'ready' ? capabilities.state.capabilities : null
  const action = cap
    ? paymentActionLabel(cap, order.snapshot.netPayableCents, inWechat)
    : { label: '支付能力读取中', disabledReason: null }
  const mockEnabled = cap?.mockAvailable === true
  const wechatUnavailable = cap !== null && !cap.mockAvailable && !cap.wechatJsapiAvailable
  const wechatBridgeMissing = cap !== null && cap.wechatJsapiAvailable && !mockEnabled

  return (
    <section
      className="mt-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"
      aria-labelledby="local-payment-heading"
      aria-busy={busy !== null}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="local-payment-heading" className="text-[15px] font-semibold text-slate-800">
            支付 / 交易状态
          </h2>
          <p className="mt-1 text-[11px] leading-5 text-slate-400">
            支付结果以服务端确认和订单状态为准，不以页面回调或本地状态宣布成功。
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
          {display.label}
        </span>
      </div>

      {display.kind === 'completed' ? (
        <div className="mt-3 rounded-xl border border-teal-200 bg-[#eef7f2] px-3.5 py-3">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#225c4c]">
            <CheckCircle2 size={15} className="shrink-0" aria-hidden="true" />
            交易已完成
          </p>
          <p className="mt-1 break-words text-[11px] leading-5 text-[#52786c]">
            {display.description}
          </p>
          <p className="mt-1 text-[10px] leading-4 text-[#52786c]">
            交易完成不等于企业银行已结算到账。
          </p>
        </div>
      ) : null}

      {display.kind === 'zero' ? (
        <div className="mt-3">
          <div className="rounded-xl bg-[#f4f8f6] px-3.5 py-3 text-[12px] leading-5 text-slate-600">
            <p className="flex items-center gap-1.5 font-semibold text-slate-700">
              <Ticket size={14} className="shrink-0 text-teal-700" aria-hidden="true" />
              {order.snapshot.couponDiscountCents > 0 ? '全额消费券抵扣' : '零元订单'}
            </p>
            <p className="mt-1">
              商品金额 {formatLocalPriceCents(order.snapshot.totalCents)} · 券抵扣{' '}
              {order.snapshot.couponDiscountCents > 0
                ? `-${formatLocalPriceCents(order.snapshot.couponDiscountCents)}`
                : '未使用'}{' '}
              · 实际支付 {formatLocalPriceCents(0)}
            </p>
            <p className="mt-1 text-[10px] leading-4 text-slate-400">
              不调用微信或 Mock 渠道，不产生渠道交易号或现金实收。
            </p>
          </div>
          <button
            type="button"
            disabled={busy !== null || !auth.session}
            onClick={() => void completeZero()}
            className="mt-3 flex min-h-[48px] w-full items-center justify-center gap-1.5 rounded-xl bg-teal-700 text-[14px] font-semibold text-white disabled:opacity-60"
          >
            {busy === 'zero' ? (
              <>
                <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                正在完成兑换…
              </>
            ) : (
              order.snapshot.couponDiscountCents > 0 ? '使用消费券完成兑换' : '确认完成零元订单'
            )}
          </button>
        </div>
      ) : null}

      {display.kind === 'confirming' ? (
        <div className="mt-3 rounded-xl bg-[#fff7ec] px-3.5 py-3">
          <p className="text-[12px] font-semibold text-[#8a6132]">支付结果确认中</p>
          <p className="mt-1 break-words text-[11px] leading-5 text-[#8a6132]/90">
            {display.description}
          </p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void refresh()}
            className="mt-2 inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-[#d9b98e] bg-white px-3 text-[11px] font-semibold text-[#8a6132] disabled:opacity-60"
          >
            <RefreshCw size={12} aria-hidden="true" />
            重新查询支付状态
          </button>
        </div>
      ) : null}

      {display.kind === 'pending' || display.kind === 'failed' || display.kind === 'closed' ? (
        <div className="mt-3">
          <div className="rounded-xl bg-[#f4f8f6] px-3.5 py-3">
            <p className="text-[12px] font-semibold text-slate-700">
              实际应付 {formatLocalPriceCents(order.snapshot.netPayableCents)}
            </p>
            <p className="mt-1 break-words text-[11px] leading-5 text-slate-500">
              {display.description}
            </p>
            {display.payment?.failureMessage ? (
              <p className="mt-1 break-words text-[10px] leading-4 text-[#a96b2f]">
                服务端失败信息：{display.payment.failureMessage}
              </p>
            ) : null}
          </div>

          {capabilities.state.status === 'loading' ? (
            <p role="status" className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
              <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
              正在确认支付能力…
            </p>
          ) : capabilities.state.status === 'error' ? (
            <div className="mt-2 rounded-xl bg-[#fff7ec] px-3 py-2.5" role="alert">
              <p className="text-[11px] leading-5 text-[#8a6132]">{capabilities.state.message}</p>
              <button
                type="button"
                onClick={capabilities.reload}
                className="mt-1 inline-flex min-h-[36px] items-center gap-1 rounded-full border border-[#d9b98e] px-3 text-[11px] font-semibold text-[#8a6132]"
              >
                <RefreshCw size={12} aria-hidden="true" />
                重新读取支付能力
              </button>
            </div>
          ) : wechatUnavailable ? (
            <p className="mt-2 rounded-xl border border-[#f2dcc0] bg-[#fff7ec] px-3 py-2.5 text-[11px] leading-5 text-[#8a6132]">
              {action.disabledReason ?? '支付服务暂未配置，当前仅能登记订单。'}
            </p>
          ) : wechatBridgeMissing ? (
            <p className="mt-2 rounded-xl border border-[#f2dcc0] bg-[#fff7ec] px-3 py-2.5 text-[11px] leading-5 text-[#8a6132]">
              服务端已配置微信支付，但当前页面尚未接入微信收银台，不能发起真实扣款。
            </p>
          ) : !orderPayable ? (
            <p className="mt-2 text-[11px] leading-5 text-slate-500">
              该订单当前状态不可发起支付；支付记录仅用于历史核对。
            </p>
          ) : (
            <>
              {display.kind === 'failed' || display.kind === 'closed' ? (
                <p className="mt-2 text-[10px] leading-4 text-slate-400">
                  重新支付会创建新的支付单；旧支付记录保留，不会修改历史事实。
                </p>
              ) : null}
              <button
                type="button"
                disabled={
                  busy !== null ||
                  !auth.session ||
                  action.disabledReason !== null ||
                  !mockEnabled
                }
                onClick={() => void runMockAction('succeed')}
                className="mt-3 flex min-h-[48px] w-full items-center justify-center gap-1.5 rounded-xl bg-teal-700 text-[14px] font-semibold text-white disabled:opacity-60"
              >
                {busy === 'succeed' ? (
                  <>
                    <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                    正在确认支付结果…
                  </>
                ) : (
                  action.label
                )}
              </button>
              {action.disabledReason ? (
                <p className="mt-1.5 text-[10px] leading-4 text-[#a96b2f]">
                  {action.disabledReason}
                </p>
              ) : null}
              {mockEnabled && display.kind === 'pending' && display.payment?.status === 'pending' ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void runMockAction('cancel')}
                  className="mt-2 inline-flex min-h-[40px] w-full items-center justify-center rounded-xl border border-slate-200 text-[12px] font-semibold text-slate-600 disabled:opacity-60"
                >
                  取消本次模拟支付
                </button>
              ) : null}
            </>
          )}

          {mockEnabled && orderPayable && (display.kind === 'pending' || display.kind === 'failed' || display.kind === 'closed') ? (
            <details className="mt-3 rounded-xl border border-dashed border-slate-300 px-3 py-2">
              <summary className="cursor-pointer text-[11px] font-semibold text-slate-500">
                测试环境模拟支付结果
              </summary>
              <p className="mt-1 text-[10px] leading-4 text-slate-400">
                仅用于隔离 Mock 环境，所有动作仍由服务端 PAY-03 确认。
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(['pending', 'fail', 'cancel', 'timeout'] as const).map((item) => {
                  const expired = display.payment?.expiresAt
                    ? Date.parse(display.payment.expiresAt) <= Date.now()
                    : false
                  return (
                    <button
                      key={item}
                      type="button"
                      disabled={busy !== null || (item === 'timeout' && !expired)}
                      onClick={() => void runMockAction(item)}
                      className="inline-flex min-h-[36px] items-center rounded-full border border-slate-200 bg-white px-2.5 text-[10px] font-semibold text-slate-600 disabled:opacity-40"
                    >
                      {item === 'pending'
                        ? '模拟待确认'
                        : item === 'fail'
                          ? '模拟失败'
                          : item === 'cancel'
                            ? '模拟取消'
                            : '模拟超时'}
                    </button>
                  )
                })}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 break-words rounded-xl bg-rose-50 px-3 py-2.5 text-[12px] leading-5 text-rose-700">
          {error}
        </p>
      ) : null}

      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-4 text-slate-400">
        <LockKeyhole size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
        你只能操作自己的订单；支付金额、商户和渠道交易号均由服务端派生。
      </p>
    </section>
  )
}
