import assert from 'node:assert/strict'
import test from 'node:test'
import { couponWalletItemSchema } from '@sanchuang-dev/local-life-contracts'
import {
  buildLocalOrderCouponOptions,
  chooseUsableCoupon,
  couponUnavailableReason,
  hasUnresolvedCouponSelection,
  localOrderAmountLines,
  shortCouponId,
} from '../src/components/life/localOrderCoupon.ts'
import {
  buildLocalOrderRegistration,
  resolveSubmissionAttempt,
} from '../src/components/life/localOrderAttribution.ts'

/**
 * #215 LL-PUR-010 single-coupon selection for a local order.
 *
 * Fixtures are parsed through the real wallet contract first, so a server-side
 * field change breaks this test instead of producing a friendly but false form.
 * The cases mirror what the API can return: no coupon, one usable coupon, an
 * over-face coupon, an occupied/expired/voided coupon, a cross-community coupon,
 * and a network retry that must keep the original coupon and idempotency key.
 */

const COMMUNITY_ID = '123e4567-e89b-42d3-a456-4266141740a1'
const OTHER_COMMUNITY_ID = '123e4567-e89b-42d3-a456-4266141740a2'
const ACTIVITY_ID = '123e4567-e89b-42d3-a456-4266141740b1'
const TEAM_ID = '123e4567-e89b-42d3-a456-4266141740b2'
const COUPON_ID = '123e4567-e89b-42d3-a456-4266141740c1'
const OTHER_COUPON_ID = '123e4567-e89b-42d3-a456-4266141740c2'
const PRODUCT_ID = '123e4567-e89b-42d3-a456-4266141740d1'
const ISSUED_AT = '2026-11-11T05:06:07.000Z'
const EXPIRES_AT = '2026-12-11T05:06:07.000Z'

function coupon(overrides = {}) {
  return couponWalletItemSchema.parse({
    id: COUPON_ID,
    activityId: ACTIVITY_ID,
    teamId: TEAM_ID,
    communityId: COMMUNITY_ID,
    faceValueCents: 2_000,
    status: 'available',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    reservedOrderId: null,
    ...overrides,
  })
}

test('no coupon wallet leaves the order at gross with a real zero discount', () => {
  const options = buildLocalOrderCouponOptions([], {
    grossCents: 5_000,
    communityId: COMMUNITY_ID,
  })
  assert.deepEqual(options, [])
  assert.equal(chooseUsableCoupon(options, null), null)

  assert.deepEqual(
    localOrderAmountLines({
      totalCents: 5_000,
      couponDiscountCents: 0,
      netPayableCents: 5_000,
    }).map((line) => [line.label, line.text]),
    [
      ['商品总额', '¥50.00'],
      ['券抵扣', '未使用'],
      ['待实际支付', '¥50.00'],
    ],
  )
})

test('one available coupon is selectable and produces the three amount rows', () => {
  const options = buildLocalOrderCouponOptions([coupon()], {
    grossCents: 5_000,
    communityId: COMMUNITY_ID,
  })
  assert.equal(options.length, 1)
  assert.equal(options[0].usable, true)
  assert.equal(options[0].unavailableReason, null)

  const selected = chooseUsableCoupon(options, COUPON_ID)
  assert.equal(selected?.coupon.id, COUPON_ID)

  assert.deepEqual(
    localOrderAmountLines({
      totalCents: 5_000,
      couponDiscountCents: selected.coupon.faceValueCents,
      netPayableCents: 5_000 - selected.coupon.faceValueCents,
    }).map((line) => [line.label, line.text]),
    [
      ['商品总额', '¥50.00'],
      ['券抵扣', '-¥20.00'],
      ['待实际支付', '¥30.00'],
    ],
  )
})

test('a coupon whose face exceeds the goods total is refused without change', () => {
  const option = buildLocalOrderCouponOptions([coupon({ faceValueCents: 6_000 })], {
    grossCents: 5_000,
    communityId: COMMUNITY_ID,
  })[0]
  assert.equal(option.usable, false)
  assert.match(option.unavailableReason, /高于商品总额/)
  assert.match(option.unavailableReason, /不支持找零/)
  assert.equal(chooseUsableCoupon([option], COUPON_ID), null)

  // A whole coupon may equal the gross and produce a real zero-cash order.
  const exact = buildLocalOrderCouponOptions([coupon({ faceValueCents: 5_000 })], {
    grossCents: 5_000,
    communityId: COMMUNITY_ID,
  })[0]
  assert.equal(exact.usable, true)
  assert.equal(exact.unavailableReason, null)
})

test('occupied, used, void and expired coupons keep their exact server status reason', () => {
  const expected = {
    reserved: /占用/,
    redeemed: /已使用/,
    void: /已作废/,
    expired: /已过期/,
  }
  for (const [status, reason] of Object.entries(expected)) {
    const item = coupon({ status })
    assert.match(couponUnavailableReason(item, {
      grossCents: 5_000,
      communityId: COMMUNITY_ID,
    }), reason)
    const option = buildLocalOrderCouponOptions([item], {
      grossCents: 5_000,
      communityId: COMMUNITY_ID,
    })[0]
    assert.equal(option.usable, false)
    assert.equal(chooseUsableCoupon([option], COUPON_ID), null)
  }
})

test('a coupon from another community is not offered for this order', () => {
  const option = buildLocalOrderCouponOptions(
    [coupon({ communityId: OTHER_COMMUNITY_ID })],
    { grossCents: 5_000, communityId: COMMUNITY_ID },
  )[0]
  assert.equal(option.usable, false)
  assert.match(option.unavailableReason, /不属于本商品所在社区/)
  assert.equal(chooseUsableCoupon([option], COUPON_ID), null)
})

test('only one coupon can be selected even when several are usable', () => {
  const options = buildLocalOrderCouponOptions(
    [
      coupon(),
      coupon({
        id: OTHER_COUPON_ID,
        faceValueCents: 1_000,
        issuedAt: '2026-11-10T05:06:07.000Z',
      }),
    ],
    { grossCents: 5_000, communityId: COMMUNITY_ID },
  )
  assert.equal(options.filter((option) => option.usable).length, 2)
  assert.equal(chooseUsableCoupon(options, COUPON_ID)?.coupon.id, COUPON_ID)
  assert.equal(chooseUsableCoupon(options, OTHER_COUPON_ID)?.coupon.id, OTHER_COUPON_ID)
  assert.equal(
    chooseUsableCoupon(options, '123e4567-e89b-42d3-a456-4266141740ff'),
    null,
  )
})

test('a previously selected coupon cannot silently become a full-price order when wallet reload fails or becomes empty', () => {
  const selected = COUPON_ID
  const emptyWalletSelection = chooseUsableCoupon([], selected)
  assert.equal(emptyWalletSelection, null)
  assert.equal(hasUnresolvedCouponSelection(selected, emptyWalletSelection), true)
  assert.equal(hasUnresolvedCouponSelection(selected, null), true)
  assert.equal(hasUnresolvedCouponSelection(null, null), false)

  const usable = buildLocalOrderCouponOptions([coupon()], {
    grossCents: 5_000,
    communityId: COMMUNITY_ID,
  })
  assert.equal(hasUnresolvedCouponSelection(selected, chooseUsableCoupon(usable, selected)), false)
})

test('the submitted payload carries only the coupon id, never a client amount', () => {
  const payload = buildLocalOrderRegistration({
    productId: PRODUCT_ID,
    quantity: 2,
    note: '',
    attribution: {},
    couponId: COUPON_ID,
    idempotencyKey: '123e4567-e89b-42d3-a456-4266141740e1',
  })
  assert.equal(payload.couponId, COUPON_ID)
  assert.equal('totalCents' in payload, false)
  assert.equal('couponDiscountCents' in payload, false)
  assert.equal('netPayableCents' in payload, false)
  assert.equal('priceCents' in payload, false)
})

test('a network retry keeps the original coupon and key instead of switching', () => {
  let keyCalls = 0
  const createKey = () => {
    keyCalls += 1
    return `key-${keyCalls}`
  }
  const first = resolveSubmissionAttempt(
    null,
    {
      attribution: {},
      coupon: { id: COUPON_ID, faceValueCents: 2_000 },
    },
    createKey,
  )
  const retry = resolveSubmissionAttempt(
    first,
    {
      attribution: {},
      coupon: { id: OTHER_COUPON_ID, faceValueCents: 1_000 },
    },
    createKey,
  )
  assert.deepEqual(retry, first)
  assert.equal(retry.couponId, COUPON_ID)
  assert.equal(keyCalls, 1)
})

test('order amounts display the server snapshot net even if preview math would differ', () => {
  const lines = localOrderAmountLines({
    totalCents: 5_000,
    couponDiscountCents: 2_000,
    netPayableCents: 2_950,
  })
  assert.deepEqual(
    lines.map((line) => [line.label, line.text]),
    [
      ['商品总额', '¥50.00'],
      ['券抵扣', '-¥20.00'],
      ['待实际支付', '¥29.50'],
    ],
  )
  assert.equal(shortCouponId(COUPON_ID), '123e4567…')
})
