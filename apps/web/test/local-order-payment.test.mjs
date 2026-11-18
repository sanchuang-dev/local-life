import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isWechatBrowser,
  localOrderPaymentDisplay,
  paymentActionLabel,
} from '../src/components/life/localOrderPayment.ts'

const summary = (overrides = {}) => ({
  status: 'registered',
  snapshot: { netPayableCents: 2980 },
  payment: null,
  ...overrides,
})

test('a server-confirmed paid intent is never displayed as order completion', () => {
  const display = localOrderPaymentDisplay(
    summary({
      status: 'registered',
      payment: { status: 'paid', intentId: 'intent-1', expiresAt: '2026-11-18T00:15:00.000Z' },
    }),
  )
  assert.equal(display.kind, 'confirming')
  assert.equal(display.label, '支付确认中')
  assert.notEqual(display.label, '交易完成')
})

test('only online_completed may display the terminal trade label', () => {
  const display = localOrderPaymentDisplay(
    summary({ status: 'online_completed', payment: { status: 'paid' } }),
  )
  assert.equal(display.kind, 'completed')
  assert.equal(display.label, '交易完成')
})

test('pending, failed and closed payments keep distinct labels', () => {
  assert.equal(localOrderPaymentDisplay(summary()).label, '待支付')
  assert.equal(
    localOrderPaymentDisplay(summary({ payment: { status: 'failed', failureMessage: '渠道拒绝' } }))
      .label,
    '支付失败',
  )
  assert.equal(
    localOrderPaymentDisplay(summary({ payment: { status: 'closed' } })).label,
    '支付已关闭',
  )
})

test('an unpaid zero-amount order asks for coupon redemption, not a channel payment', () => {
  const display = localOrderPaymentDisplay(
    summary({ status: 'processing', snapshot: { netPayableCents: 0, couponDiscountCents: 2980 } }),
  )
  assert.equal(display.kind, 'zero')
  assert.equal(display.label, '待兑换')
})

test('a free zero-price order without a coupon is manual, not a zero-payment action', () => {
  const display = localOrderPaymentDisplay(
    summary({ status: 'registered', snapshot: { netPayableCents: 0, couponDiscountCents: 0 } }),
  )
  assert.equal(display.kind, 'manual')
  assert.equal(display.label, '待处理')
})

test('capability labels are driven by server availability, not user agent alone', () => {
  const mock = {
    mockAvailable: true,
    wechatJsapiAvailable: false,
    wechatUnavailableReason: 'not_configured',
  }
  assert.match(paymentActionLabel(mock, 2980, false).label, /模拟支付/)
  const none = {
    mockAvailable: false,
    wechatJsapiAvailable: false,
    wechatUnavailableReason: 'not_configured',
  }
  const action = paymentActionLabel(none, 2980, false)
  assert.equal(action.disabledReason, '支付服务暂未配置，当前仅能登记订单。')
})

test('WeChat detection is presentation only', () => {
  assert.equal(isWechatBrowser('Mozilla/5.0 MicroMessenger/8.0'), true)
  assert.equal(isWechatBrowser('Mozilla/5.0 Safari/605.1'), false)
})
