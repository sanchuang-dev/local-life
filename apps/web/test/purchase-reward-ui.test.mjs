import assert from 'node:assert/strict'
import test from 'node:test'
import {
  couponWalletResponseSchema,
  purchaseRewardProgressResponseSchema,
} from '@sanchuang-dev/local-life-contracts'
import {
  buildPurchaseRewardSummary,
  couponStatusLabels,
  couponStatusView,
  findLatestTeamCoupon,
  purchaseActivityPhase,
  purchasePhaseNotice,
  purchaseRewardGrantText,
} from '../src/components/activity/purchaseRewardUi.ts'
import {
  localCatalogHref,
  localProductHref,
} from '../src/components/life/catalogLinks.ts'

/**
 * #214 resident consumption-task UI.
 *
 * Fixtures are parsed through the real API contracts before they reach the view
 * helpers, so a schema change breaks this test instead of silently producing a
 * friendlier but false screen. The cases mirror the #210/#211 states the API can
 * return: no team, incomplete, no effective receipt, progress, qualification,
 * coupon lifecycle and refund-driven voiding.
 */

const ACTIVITY_ID = '123e4567-e89b-42d3-a456-4266141740a1'
const OTHER_ACTIVITY_ID = '123e4567-e89b-42d3-a456-4266141740a2'
const TEAM_ID = '123e4567-e89b-42d3-a456-4266141740b1'
const OTHER_TEAM_ID = '123e4567-e89b-42d3-a456-4266141740b2'
const PRODUCT_ID = '123e4567-e89b-42d3-a456-4266141740c1'
const JOINED_AT = '2026-11-11T03:04:05.678Z'
const ISSUED_AT = '2026-11-11T05:06:07.000Z'
const EXPIRES_AT = '2026-12-11T05:06:07.000Z'

const PLAN = { thresholdCents: 12_000, couponFaceValueCents: 2_000 }

function member(seatNo, displayName, contributionCents, isSelf = false) {
  return {
    seatNo,
    displayName,
    role: seatNo === 1 ? 'leader' : 'member',
    isSelf,
    joinedAt: JOINED_AT,
    contributionCents,
  }
}

function progressResponse(members, options = {}) {
  const plan = options.plan ?? PLAN
  const total = members.reduce((sum, item) => sum + item.contributionCents, 0)
  const teamFull = members.length === 3
  return purchaseRewardProgressResponseSchema.parse({
    activityId: ACTIVITY_ID,
    activityTitle: '银发消费团',
    plan,
    progress: {
      teamId: TEAM_ID,
      teamStatus: teamFull ? 'locked' : 'open',
      seatsFilled: members.length,
      teamFull,
      membersContributionCents: members,
      totalEffectivePaidCents: total,
      thresholdCents: plan.thresholdCents,
      remainingCents: Math.max(0, plan.thresholdCents - total),
      eligible: teamFull && total >= plan.thresholdCents,
    },
  })
}

function coupon(overrides = {}) {
  return {
    id: '123e4567-e89b-42d3-a456-4266141740d1',
    activityId: ACTIVITY_ID,
    teamId: TEAM_ID,
    faceValueCents: PLAN.couponFaceValueCents,
    status: 'available',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    reservedOrderId: null,
    ...overrides,
  }
}

test('no real plan produces no consumption task at all', () => {
  assert.equal(buildPurchaseRewardSummary(null, null), null)
})

test('a resident without a team is shown as unjoined, never as a fake 0/3 contribution', () => {
  const summary = buildPurchaseRewardSummary(PLAN, null)
  assert.equal(summary?.kind, 'no_team')
  assert.match(summary.label, /还未加入/)
  assert.equal(summary.seatsFilled, 0)
  assert.equal(summary.members.length, 0)
  assert.match(summary.detail, /入团后/)
})

test('an incomplete team lists each real contribution and never treats the threshold as enough', () => {
  const data = progressResponse([
    member(1, '居民甲', 4_500, true),
    member(2, '居民乙', 8_500),
  ])
  const summary = buildPurchaseRewardSummary(data.plan, data.progress)
  assert.equal(summary?.kind, 'incomplete_team')
  assert.match(summary.label, /2\/3/)
  assert.equal(summary.totalCents, 13_000)
  assert.equal(summary.eligible, false)
  assert.deepEqual(
    summary.members.map((item) => [item.seatNo, item.displayName, item.contributionText]),
    [
      [1, '居民甲', '¥45.00'],
      [2, '居民乙', '¥85.00'],
    ],
  )
  assert.match(summary.detail, /坐满 3 人/)
})

test('a full team without a linked receipt is awaiting effective payment', () => {
  const data = progressResponse([
    member(1, '居民甲', 0, true),
    member(2, '居民乙', 0),
    member(3, '居民丙', 0),
  ])
  const summary = buildPurchaseRewardSummary(data.plan, data.progress)
  assert.equal(summary?.kind, 'awaiting_payment')
  assert.equal(summary.eligible, false)
  assert.match(summary.detail, /收款凭据/)
  assert.match(summary.detail, /待审核/)
})

test('progress below the threshold reports the exact remaining amount', () => {
  const data = progressResponse([
    member(1, '居民甲', 4_500, true),
    member(2, '居民乙', 0),
    member(3, '居民丙', 0),
  ])
  const summary = buildPurchaseRewardSummary(data.plan, data.progress)
  assert.equal(summary?.kind, 'in_progress')
  assert.equal(summary.remainingCents, 7_500)
  assert.equal(summary.remainingText, '¥75.00')
  assert.match(summary.label, /还差 ¥75\.00/)
})

test('qualified teams and their equal three-member coupon are described from real wallet data', () => {
  const data = progressResponse([
    member(1, '居民甲', 12_000, true),
    member(2, '居民乙', 0),
    member(3, '居民丙', 0),
  ])
  const summary = buildPurchaseRewardSummary(data.plan, data.progress)
  assert.equal(summary?.kind, 'qualified')
  assert.equal(summary.eligible, true)

  const item = coupon()
  const wallet = couponWalletResponseSchema.parse({
    items: [item],
    asOf: '2026-11-12T00:00:00.000Z',
  })
  const text = purchaseRewardGrantText(data.plan, data.progress, wallet.items[0])
  assert.match(text, /三位团员/)
  assert.match(text, /¥20\.00/)
  assert.match(text, /面额相同/)
  assert.equal(couponStatusView(wallet.items[0]).label, '可用')
  assert.match(couponStatusView(wallet.items[0]).expiresText, /2026-12-11/)
})

test('an eligible team without a coupon is never claimed as rewarded', () => {
  const data = progressResponse([
    member(1, '居民甲', 12_000, true),
    member(2, '居民乙', 0),
    member(3, '居民丙', 0),
  ])
  const text = purchaseRewardGrantText(data.plan, data.progress, null)
  assert.match(text, /暂未收到/)
  assert.doesNotMatch(text, /已为三位团员各发放/)
})

test('a face-value mismatch is surfaced as an anomaly instead of a positive grant', () => {
  const data = progressResponse([
    member(1, '居民甲', 12_000, true),
    member(2, '居民乙', 0),
    member(3, '居民丙', 0),
  ])
  const text = purchaseRewardGrantText(data.plan, data.progress, coupon({ faceValueCents: 1_000 }))
  assert.match(text, /不一致/)
  assert.match(text, /核实/)
})

test('reserved, redeemed, void and expired coupons keep their distinct real states', () => {
  const expected = {
    available: '可用',
    reserved: '已占用',
    redeemed: '已使用',
    void: '已作废',
    expired: '已过期',
  }
  for (const [status, label] of Object.entries(expected)) {
    const view = couponStatusView(coupon({ status }))
    assert.equal(view.label, label)
    assert.equal(couponStatusLabels[status], label)
  }
  assert.match(couponStatusView(coupon({ status: 'reserved' })).detail, /占用/)
  assert.match(couponStatusView(coupon({ status: 'void' })).detail, /退款撤销|资格失效/)
  assert.match(couponStatusView(coupon({ status: 'expired' })).detail, /有效期/)
})

test('a refund-revoked team loses qualification while the void coupon remains visible', () => {
  const data = progressResponse([
    member(1, '居民甲', 0, true),
    member(2, '居民乙', 0),
    member(3, '居民丙', 0),
  ])
  const summary = buildPurchaseRewardSummary(data.plan, data.progress)
  assert.equal(summary?.kind, 'awaiting_payment')
  assert.equal(summary.eligible, false)

  const voided = coupon({ status: 'void' })
  const text = purchaseRewardGrantText(data.plan, data.progress, voided)
  assert.match(text, /曾为三位团员/)
  assert.equal(couponStatusView(voided).label, '已作废')
})

test('the newest coupon for the exact activity and team is selected', () => {
  const older = coupon({
    id: '123e4567-e89b-42d3-a456-4266141740d2',
    issuedAt: '2026-11-10T05:06:07.000Z',
  })
  const newer = coupon({
    id: '123e4567-e89b-42d3-a456-4266141740d3',
    issuedAt: '2026-11-11T05:06:07.000Z',
  })
  const otherTeam = coupon({
    id: '123e4567-e89b-42d3-a456-4266141740d4',
    teamId: OTHER_TEAM_ID,
  })
  const otherActivity = coupon({
    id: '123e4567-e89b-42d3-a456-4266141740d5',
    activityId: OTHER_ACTIVITY_ID,
  })
  assert.equal(
    findLatestTeamCoupon([older, newer, otherTeam, otherActivity], ACTIVITY_ID, TEAM_ID)?.id,
    newer.id,
  )
  assert.equal(findLatestTeamCoupon([otherActivity], ACTIVITY_ID, TEAM_ID), null)
})

test('upcoming, paused and ended activities are distinguished from a live task', () => {
  const now = Date.parse('2026-11-12T00:00:00.000Z')
  assert.equal(
    purchaseActivityPhase(
      { status: 'published', startsAt: '2026-11-13T00:00:00.000Z', endsAt: '2026-11-20T00:00:00.000Z' },
      now,
    ),
    'upcoming',
  )
  assert.equal(
    purchaseActivityPhase(
      { status: 'published', startsAt: '2026-11-10T00:00:00.000Z', endsAt: '2026-11-20T00:00:00.000Z' },
      now,
    ),
    'active',
  )
  assert.equal(
    purchaseActivityPhase(
      { status: 'paused', startsAt: '2026-11-10T00:00:00.000Z', endsAt: '2026-11-20T00:00:00.000Z' },
      now,
    ),
    'paused',
  )
  assert.equal(
    purchaseActivityPhase(
      { status: 'published', startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-11T00:00:00.000Z' },
      now,
    ),
    'ended',
  )
  assert.equal(purchasePhaseNotice.active, null)
  assert.match(purchasePhaseNotice.paused, /暂停/)
  assert.match(purchasePhaseNotice.ended, /结束/)
})

test('the activity entry goes to the real catalogue and keeps its activity context', () => {
  assert.equal(localCatalogHref(ACTIVITY_ID), `/life?activityId=${ACTIVITY_ID}`)
  assert.equal(
    localProductHref(PRODUCT_ID, ACTIVITY_ID),
    `/life/local-products/${PRODUCT_ID}?activityId=${ACTIVITY_ID}`,
  )
  assert.equal(localCatalogHref(null), '/life')
  assert.equal(localProductHref(PRODUCT_ID, null), `/life/local-products/${PRODUCT_ID}`)
  assert.doesNotMatch(localCatalogHref(ACTIVITY_ID), /silver-neighborhood\/products/)
})
