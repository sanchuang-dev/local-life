import assert from 'node:assert/strict'
import test from 'node:test'
import { drawUnavailableText, drawCredentialStatusText, distinctDrawWins } from '../src/lib/drawUi.ts'
import { residentScopeRefusalText } from '../src/lib/residentCommunity.ts'

test('draw messages never promise success when the service is unavailable', () => {
  assert.match(drawUnavailableText('draw_service_not_configured'), /无法开奖/)
  assert.match(drawUnavailableText('daily_limit_reached'), /次数已用完/)
  assert.match(drawUnavailableText('draw_pool_disabled'), /尚未开放/)
  assert.match(drawUnavailableText('no_prize_available'), /没有可以领取/)
  assert.match(drawUnavailableText('not_authenticated'), /登录/)
})

test('not_assigned now means "no confirmed permanent community", not a #123 assignment', () => {
  // #171 LL-IDENTITY-001: the API derives this reason from the confirmed binding,
  // so the copy must point at the resident's own confirmation action.
  const text = drawUnavailableText('not_assigned')
  assert.match(text, /确认常驻社区/)
  assert.match(text, /我的/)
  assert.equal(text.includes('居民关联'), false, 'retired #123 wording must not return')
})

test('community-scope refusals are readable and never offer a rebind', () => {
  const notBound = residentScopeRefusalText('resident_community_not_bound')
  assert.match(notBound, /确认常驻社区/)
  // Browsing stays free even when a community-scoped write is refused.
  assert.match(notBound, /浏览其他社区不受影响/)

  const conflict = residentScopeRefusalText(
    'resident_community_conflict',
    '你的常驻社区是「梧桐里社区」，不能在该社区操作',
  )
  assert.match(conflict, /常驻社区不是这里/)
  assert.match(conflict, /梧桐里社区/)
  assert.match(conflict, /不能自行修改/)
  assert.match(conflict, /仍可以浏览/)
  for (const forbidden of ['切换', '解绑', '重绑', '改绑']) {
    assert.equal(conflict.includes(forbidden), false, forbidden)
  }

  // Any other code keeps the caller's own message.
  assert.equal(residentScopeRefusalText('forbidden'), null)
  assert.equal(residentScopeRefusalText(null), null)
})

test('only real winning draws are treated as rewards and active results are not duplicated', () => {
  const a = { id: 'a', outcome: 'won', createdAt: '2026-11-10T02:00:00.000Z' }
  const b = { id: 'b', outcome: 'missed', createdAt: '2026-11-11T02:00:00.000Z' }
  const c = { id: 'c', outcome: 'won', createdAt: '2026-11-11T03:00:00.000Z' }
  assert.deepEqual(distinctDrawWins([a, b, c], [a]).map(x => x.id), ['c', 'a'])
  assert.equal(drawCredentialStatusText('active'), '待核销')
  assert.equal(drawCredentialStatusText('redeemed'), '已核销')
  assert.equal(drawCredentialStatusText('revoked'), '已作废')
})
