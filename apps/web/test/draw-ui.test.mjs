import assert from 'node:assert/strict'
import test from 'node:test'
import {
  drawUnavailableText,
  drawCredentialStatusText,
  distinctDrawWins,
} from '../src/lib/drawUi.ts'

test('draw messages never promise success when the service is unavailable', () => {
  assert.match(drawUnavailableText('draw_service_not_configured'), /无法开奖/)
  assert.match(drawUnavailableText('daily_limit_reached'), /次数已用完/)
  assert.match(drawUnavailableText('draw_pool_disabled'), /尚未开放/)
  assert.match(drawUnavailableText('no_prize_available'), /没有可以领取/)
  assert.match(drawUnavailableText('not_authenticated'), /登录/)
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
